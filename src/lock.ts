import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "./session.ts";

export const LOCK_FILE = join(CACHE_DIR, "refresh.lock");

// Longer than a worst-case refresh (60s boot timeout + close), so a live holder
// is never mistaken for a dead one.
const STALE_MS = 120_000;
const POLL_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ageMs = () => Date.now() - statSync(LOCK_FILE).mtimeMs;

function create(): boolean {
  try {
    writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" }); // O_EXCL: atomic
    return true;
  } catch {
    return false;
  }
}

// Serializes Slack launches: only one process may drive the desktop app's
// single instance at a time.
export function tryAcquireRefreshLock(): boolean {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (create()) return true;
  try {
    if (ageMs() <= STALE_MS) return false;
    unlinkSync(LOCK_FILE); // holder died without releasing
  } catch {
    // vanished under us
  }
  return create();
}

export function releaseRefreshLock(): void {
  try {
    // Only our own: if ours was reaped as stale, the file is someone else's now.
    if (readFileSync(LOCK_FILE, "utf8") === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch {
    // already gone
  }
}

// Returns once the lock is released or looks abandoned. Terminates either way:
// the holder never refreshes the mtime, so its age always reaches STALE_MS.
export async function waitForRefreshLock(): Promise<void> {
  for (;;) {
    try {
      if (ageMs() > STALE_MS) return;
    } catch {
      return; // released
    }
    await sleep(POLL_MS);
  }
}
