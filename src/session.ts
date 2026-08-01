import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.ts";

export interface SlackSession {
  workspace: string;
  teamId: string;
  xoxc: string;
  xoxd: string;
}

export const CACHE_DIR = join(homedir(), ".cache", "slack-desktop-mcp");
const CACHE_FILE = join(CACHE_DIR, "session.json");

export function readCachedSession(): SlackSession | null {
  try {
    const s = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (s.xoxc && s.xoxd && s.workspace && s.teamId) return s as SlackSession;
  } catch {
    // missing or corrupt
  }
  return null;
}

export function writeCachedSession(session: SlackSession): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(session), { mode: 0o600 });
  chmodSync(CACHE_FILE, 0o600); // in case the file already existed
}

export function clearCachedSession(): void {
  try {
    unlinkSync(CACHE_FILE);
  } catch {
    // nothing cached
  }
}

// The `d` cookie and xoxc token are only valid together, so auth.test needs both.
// null = couldn't ask (offline, unreachable). That is not a rejected session:
// relaunching Slack can't fix an unreachable slack.com, and the server we exec
// may well authenticate anyway.
export async function isSessionValid(session: SlackSession): Promise<boolean | null> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { Cookie: `d=${session.xoxd}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: session.xoxc }).toString(),
    });
    return ((await res.json()) as { ok?: boolean }).ok === true;
  } catch (e) {
    log(`could not verify session: ${(e as Error).message}`);
    return null;
  }
}
