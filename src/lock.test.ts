import { expect, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { LOCK_FILE, releaseRefreshLock, tryAcquireRefreshLock, waitForRefreshLock } from "./lock.ts";

// Uses the real lock path, so don't run this while a refresh is in flight.
expect(existsSync(LOCK_FILE)).toBe(false);

const makeStale = () => {
  const t = new Date(Date.now() - 200_000);
  utimesSync(LOCK_FILE, t, t);
};

test("acquire excludes, release frees", () => {
  expect(tryAcquireRefreshLock()).toBe(true);
  expect(tryAcquireRefreshLock()).toBe(false);
  releaseRefreshLock();
  expect(existsSync(LOCK_FILE)).toBe(false);
});

test("a stale lock is stolen, a live one is not", async () => {
  tryAcquireRefreshLock();
  writeFileSync(LOCK_FILE, "999999"); // pretend another process holds it
  expect(tryAcquireRefreshLock()).toBe(false);
  makeStale();
  await waitForRefreshLock(); // must not block on an abandoned lock
  expect(tryAcquireRefreshLock()).toBe(true);
  releaseRefreshLock();
});

test("release leaves another owner's lock alone", () => {
  writeFileSync(LOCK_FILE, "999999");
  releaseRefreshLock();
  expect(existsSync(LOCK_FILE)).toBe(true);
  writeFileSync(LOCK_FILE, String(process.pid));
  releaseRefreshLock();
  expect(existsSync(LOCK_FILE)).toBe(false);
});
