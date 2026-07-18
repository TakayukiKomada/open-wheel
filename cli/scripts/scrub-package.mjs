#!/usr/bin/env node
// npm pack の実 tarball を検査し、公開 repo に出すべきでない値を fail-closed で弾く。
// 依存は Node.js 標準機能のみ。公開前 CI と本人の手元確認の両方で使う。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { SCRUB_PATTERNS } from "../lib/export-hf.mjs";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 公開 package の本文に残ってはいけない private repo / 運用環境の参照。
// 公開 MCP の入口である gamefork.dev と、公開 provenance の gamefork.io は許可する。
export const PACKAGE_INTERNAL_PATTERNS = [
  { name: "private-repository", re: /github\.com[/:]TakayukiKomada\/gamefork(?:\.git)?/i },
  { name: "beta-host", re: /\bbeta\.gamefork\.dev\b/i },
  { name: "cloudflare-worker-host", re: /\b[a-z0-9-]+\.workers\.dev\b/i },
  { name: "supabase-host", re: /\b[a-z0-9-]+\.supabase\.co\b/i },
  { name: "bare-supabase-project-ref", re: /\brhentnpmdsfjnytzcbct\b/i },
  { name: "local-absolute-path", re: /(?:[A-Z]:[\\/]Users[\\/]|\/(?:Users|home|private)\/[a-z0-9_-]+\/)/i },
  { name: "internal-environment-id", re: /\b(?:gamefork-(?:dev|beta|production)|gamefork-dev-beta)\b/i },
];

export const PACKAGE_SCRUB_PATTERNS = [...SCRUB_PATTERNS, ...PACKAGE_INTERNAL_PATTERNS];

function parseArgs(argv) {
  const args = { packageDir: PACKAGE_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--package-dir") {
      const value = argv[++i];
      if (!value) throw new Error("--package-dir requires a path");
      args.packageDir = path.resolve(value);
    } else {
      throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return args;
}

function readOctal(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

/** gzip 圧縮された ustar の regular file を { path, content } として読む。 */
export function readTarball(buffer) {
  const tar = gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const entryPath = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (type === "0" || type === "") {
      entries.push({ path: entryPath.replace(/\\/g, "/"), content: tar.subarray(dataStart, dataEnd) });
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function scrubText(text, patterns = PACKAGE_SCRUB_PATTERNS) {
  return patterns.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
}

export function isAllowedPath(entryPath) {
  if (entryPath === "package.json" || entryPath === "README.md" || entryPath === "LICENSE" || entryPath === "SPEC.md") {
    return true;
  }
  return /^(?:bin|lib|skills)\/.+/.test(entryPath);
}

function normalizePackPath(value) {
  return String(value).replace(/^package\//, "").replace(/\\/g, "/");
}

function run(packageDir) {
  const staging = mkdtempSync(path.join(tmpdir(), "open-wheel-pack-"));
  try {
    const npmArgs = ["pack", "--json", "--cache", path.join(staging, "npm-cache"), "--pack-destination", staging];
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm.cmd ${npmArgs.map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg).join(" ")}`]
      : npmArgs;
    const result = JSON.parse(execFileSync(
      command,
      args,
      {
        cwd: packageDir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    ));
    const packed = result[0];
    if (!packed?.filename) throw new Error("npm pack returned no tarball filename");
    const tarballPath = path.isAbsolute(packed.filename)
      ? packed.filename
      : path.join(staging, path.basename(packed.filename));
    const entries = readTarball(readFileSync(tarballPath));
    const files = entries.map((entry) => normalizePackPath(entry.path));
    const unexpected = files.filter((file) => !isAllowedPath(file));
    const findings = [];
    for (const entry of entries) {
      const file = normalizePackPath(entry.path);
      const text = entry.content.toString("utf8");
      for (const reason of scrubText(text)) findings.push({ file, reason });
    }
    if (unexpected.length > 0 || findings.length > 0) {
      if (unexpected.length > 0) console.error(`unexpected package files: ${unexpected.join(", ")}`);
      for (const finding of findings) console.error(`scrub hit: ${finding.file} (${finding.reason})`);
      return 1;
    }
    console.log(`open-wheel package scrub OK: files=${files.length}, version=${packed.version ?? "unknown"}`);
    return 0;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)).packageDir);
  } catch (error) {
    console.error(`open-wheel package scrub FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
