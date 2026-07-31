import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { CACHE_DIR } from "./session.ts";

const REPO = "korotovsky/slack-mcp-server";

const OS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

// Straight from GitHub Releases: no npm/npx, so no Node on PATH to disagree with.
export async function resolveKorotovskyBinary(version?: string): Promise<string> {
  const os = OS[process.platform];
  const arch = ARCH[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  const name = `slack-mcp-server-${os}-${arch}${os === "windows" ? ".exe" : ""}`;

  const tag = version ? (version.startsWith("v") ? version : `v${version}`) : await latestTag();
  const dest = join(CACHE_DIR, "bin", tag, name);
  if (existsSync(dest)) return dest;

  const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
  log(`downloading slack-mcp-server ${tag} (${name})...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);

  mkdirSync(join(CACHE_DIR, "bin", tag), { recursive: true });
  await Bun.write(dest, res);
  chmodSync(dest, 0o755);
  return dest;
}

async function latestTag(): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (!res.ok) throw new Error(`GitHub release lookup failed: ${res.status} ${res.statusText}`);
  return ((await res.json()) as { tag_name: string }).tag_name;
}
