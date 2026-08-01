#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { resolveKorotovskyBinary } from "./korotovsky.ts";
import { releaseRefreshLock, tryAcquireRefreshLock, waitForRefreshLock } from "./lock.ts";
import { log } from "./log.ts";
import {
  clearCachedSession,
  isSessionValid,
  readCachedSession,
  type SlackSession,
  writeCachedSession,
} from "./session.ts";
import { refreshSessionViaSlackDesktop } from "./slack.ts";

// Relaunch once: neither setting can be applied in-process. --use-system-ca is
// flag-only (no env var, and shebang args aren't portable); WEBKIT_... must be
// inherited before webview-bun loads -- hence the lazy ./error-dialog.ts import.
if (!process.env.SLACK_DESKTOP_MCP_RELAUNCHED) {
  const child = Bun.spawn([process.execPath, "--use-system-ca", ...Bun.argv.slice(1)], {
    env: { ...process.env, SLACK_DESKTOP_MCP_RELAUNCHED: "1", WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS: "1" },
    stdio: ["inherit", "inherit", "inherit"], // transparent: the child is the MCP server
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  process.exit(await child.exited);
}

const HELP = `slack-desktop-mcp [options]

Runs korotovsky/slack-mcp-server against the session your Slack desktop app is
already signed into. Slack is launched only when no valid session is cached.

Options:
  --korotovsky-version <version>  Pin the slack-mcp-server release (e.g. v1.3.0).
                                   Default: latest GitHub release.
  --workspace-match <substring>   Pick the workspace whose id/name/url/domain
                                   contains this (default: $SLACK_WORKSPACE_MATCH).
  --force-refresh                 Re-extract the session, ignoring the cache.
  --no-ui                         Report failures on stderr instead of a dialog.
  -h, --help                      Show this help.
`;

// Thrown by instances that waited on the lock and got nothing. The holder's
// dialog already explains why, so these report on stderr only -- otherwise N
// blocked clients stack up N dialogs for one root cause.
class NoSessionFromHolder extends Error {}

let holdingLock = false;

function releaseLock(): void {
  if (!holdingLock) return;
  holdingLock = false;
  releaseRefreshLock();
}

process.on("exit", releaseLock); // don't leave the lock behind on a signal

// MCP clients don't surface a stdio server's stderr, so failures need a dialog
// to be seen at all. The refresh lock is deliberately still held while it is up:
// we haven't finished failing until the user has read it.
async function fail(message: string, noUi: boolean, quiet = false): Promise<never> {
  log(message);
  if (!noUi && !quiet) (await import("./error-dialog.ts")).showErrorDialog(message);
  releaseLock();
  process.exit(1);
}

async function cachedSession(): Promise<SlackSession | null> {
  const cached = readCachedSession();
  if (!cached) {
    log("no cached session found");
    return null;
  }
  const valid = await isSessionValid(cached);
  if (valid === false) {
    log(`cached session for '${cached.workspace}' is stale`);
    return null;
  }
  if (valid === null) log("using the cached session unverified");
  return cached;
}

async function getSession(workspaceMatch: string, forceRefresh: boolean): Promise<SlackSession> {
  if (!forceRefresh) {
    const cached = await cachedSession();
    if (cached) {
      log(`using cached session for '${cached.workspace}'`);
      return cached;
    }
  }

  // Only launching is serialized; a cache hit never touches the lock.
  if (!tryAcquireRefreshLock()) {
    log("another instance is refreshing the session; waiting");
    await waitForRefreshLock();
    // Cache-only from here: launching Slack ourselves could only lose the
    // single-instance race against the holder.
    const cached = await cachedSession();
    if (cached) {
      log(`using session refreshed by the other instance ('${cached.workspace}')`);
      return cached;
    }
    throw new NoSessionFromHolder("the mutex-holder produced no session");
  }

  holdingLock = true;
  clearCachedSession(); // so the cache only ever holds a completed refresh
  const session = await refreshSessionViaSlackDesktop(workspaceMatch);
  writeCachedSession(session);
  releaseLock(); // promptly, so waiters can use it
  return session;
}

const { values } = parseArgs({
  options: {
    "korotovsky-version": { type: "string" },
    "workspace-match": { type: "string" },
    "force-refresh": { type: "boolean", default: false },
    "no-ui": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const noUi = values["no-ui"]!;

try {
  const match = (values["workspace-match"] ?? process.env.SLACK_WORKSPACE_MATCH ?? "").toLowerCase();
  const session = await getSession(match, values["force-refresh"]!);
  const bin = await resolveKorotovskyBinary(values["korotovsky-version"]);

  log(`starting ${bin}`);
  const server = spawn(bin, ["--transport", "stdio"], {
    stdio: "inherit", // it becomes the MCP server on our stdio
    env: { ...process.env, SLACK_MCP_XOXC_TOKEN: session.xoxc, SLACK_MCP_XOXD_TOKEN: session.xoxd },
  });
  server.on("exit", (code) => process.exit(code ?? 0));
  server.on("error", (e) => fail(`failed to start slack-mcp-server: ${e.message}`, noUi));
} catch (e) {
  const quiet = e instanceof NoSessionFromHolder;
  await fail(quiet ? (e as Error).message : `slack-desktop-mcp failed: ${(e as Error).message}`, noUi, quiet);
}
