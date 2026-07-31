import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PipeCDP } from "./cdp.ts";
import { log } from "./log.ts";
import type { SlackSession } from "./session.ts";

const TARGET_ORIGIN = "app.slack.com";
const BOOT_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function findSlack(): string | undefined {
  const home = homedir();
  if (process.platform === "darwin") {
    return ["/Applications", join(home, "Applications")]
      .map((d) => join(d, "Slack.app/Contents/MacOS/Slack"))
      .find(existsSync);
  }
  if (process.platform === "win32") {
    const base = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "slack");
    // Squirrel installs into versioned app-* directories alongside the stub.
    const versioned = existsSync(base) ? readdirSync(base).filter((d) => d.startsWith("app-")) : [];
    return [base, ...versioned.map((d) => join(base, d))].map((d) => join(d, "slack.exe")).find(existsSync);
  }
  return ["/usr/bin/slack", "/usr/lib/slack/slack", "/opt/slack/slack", "/snap/bin/slack"].find(existsSync);
}

function pickWorkspace(config: any, match: string): SlackSession {
  const teams: Record<string, any> = config.teams;
  const entries = Object.entries(teams);
  const found =
    entries.find(([id, t]: [string, any]) =>
      `${id} ${t.name ?? ""} ${t.url ?? ""} ${t.domain ?? ""}`.toLowerCase().includes(match),
    ) ??
    entries.find(([id]) => id === config.lastActiveTeam) ??
    entries[0];
  const [teamId, team] = found as [string, any];
  if (!team.token) throw new Error(`workspace '${team.name ?? teamId}' has no token`);
  return { workspace: team.name ?? teamId, teamId, xoxc: team.token, xoxd: "" };
}

// Launches Slack with a debug pipe, reads the session it already holds, then
// quits it. A Slack that is already running owns the single-instance lock, so
// our launch dies instantly rather than disturbing the user's own window.
export async function refreshSessionViaSlackDesktop(workspaceMatch: string): Promise<SlackSession> {
  const bin = findSlack();
  if (!bin) throw new Error("Slack executable not found for this OS");
  log(`launching Slack via debugging pipe: ${bin}`);

  const child = spawn(bin, ["--remote-debugging-pipe"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    detached: true,
  });
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const [, , , toBrowser, fromBrowser] = child.stdio;
  if (!toBrowser || !fromBrowser) throw new Error("failed to open CDP pipe fds 3/4");
  const cdp = new PipeCDP(toBrowser as any, fromBrowser as any);
  const deadline = Date.now() + BOOT_TIMEOUT_MS;

  try {
    let targetId: string | undefined;
    while (!targetId && !exited && Date.now() < deadline) {
      targetId = await pageTarget(cdp);
      if (!targetId) await sleep(750);
    }
    if (exited) {
      throw new Error(
        "Slack exited immediately, likely because it's already running elsewhere " +
          "(single-instance lock). Quit Slack fully and try again.",
      );
    }
    if (!targetId) throw new Error(`no ${TARGET_ORIGIN} page appeared within timeout`);

    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Network.enable", {}, sessionId);

    // The page target exists before the client has hydrated and written its
    // session, so poll rather than read once.
    let session: SlackSession | undefined;
    while (!session && !exited && Date.now() < deadline) {
      session = await extract(cdp, sessionId, workspaceMatch);
      if (!session) await sleep(750);
    }
    if (!session) throw new Error("timed out waiting for a signed-in Slack session. Is Slack signed in?");

    log(`extracted session for workspace '${session.workspace}' (${session.teamId}); closing Slack`);
    return session;
  } finally {
    await closeSlack(cdp, child); // also on failure: we opened it, we close it
  }
}

async function pageTarget(cdp: PipeCDP): Promise<string | undefined> {
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    return targetInfos.find((t: any) => t.type === "page" && t.url.includes(TARGET_ORIGIN))?.targetId;
  } catch {
    return undefined; // browser not up yet
  }
}

// undefined = not ready yet, so the caller keeps polling.
async function extract(cdp: PipeCDP, sessionId: string, match: string): Promise<SlackSession | undefined> {
  try {
    const { cookies } = await cdp.send("Network.getAllCookies", {}, sessionId);
    const d = cookies.find((c: any) => c.name === "d" && c.domain.includes("slack.com"));
    if (!d) return undefined;

    const res = await cdp.send(
      "Runtime.evaluate",
      { expression: "localStorage.getItem('localConfig_v2')", returnByValue: true },
      sessionId,
    );
    if (!res?.result?.value) return undefined;

    const config = JSON.parse(res.result.value);
    if (!Object.keys(config.teams ?? {}).length) return undefined; // still signing in
    return { ...pickWorkspace(config, match), xoxd: d.value };
  } catch {
    return undefined; // page mid-navigation
  }
}

async function closeSlack(cdp: PipeCDP, child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  cdp.send("Browser.close").catch(() => {}); // Electron never replies; watch the process instead
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, CLOSE_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
