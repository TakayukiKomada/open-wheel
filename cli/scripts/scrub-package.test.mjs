import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { isAllowedPath, readTarball, scrubText } from "./scrub-package.mjs";

function tarHeader({ name, size = 0, type = "0", prefix = "" }) {
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0").copy(header, 124);
  header[156] = type.charCodeAt(0);
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from(prefix).copy(header, 345);
  return header;
}

function makeTarball(entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? "");
    blocks.push(tarHeader({ ...entry, size: content.length }), content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

test("readTarball は ustar の regular file と prefix を決定論的に読む", () => {
  const tarball = makeTarball([
    { name: "lib", type: "5" },
    { name: "citations.mjs", prefix: "package/lib", content: "export const ok = true;\n" },
  ]);

  const entries = readTarball(tarball);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "package/lib/citations.mjs");
  assert.equal(entries[0].content.toString("utf8"), "export const ok = true;\n");
});

test("scrubText は共通 secret と package 固有の内部参照を検出する", () => {
  const findings = scrubText([
    "token=ghp_1234567890abcdef",
    "https://github.com/TakayukiKomada/gamefork",
    "https://beta.gamefork.dev",
    "project_ref=rhentnpmdsfjnytzcbct",
  ].join("\n"));

  assert.deepEqual(findings, [
    "api-key-like",
    "private-repository",
    "beta-host",
    "bare-supabase-project-ref",
  ]);
  assert.deepEqual(scrubText("https://gamefork.dev/api/mcp-auth"), []);
});

test("isAllowedPath は publish allowlist 以外を拒否する", () => {
  for (const allowed of [
    "package.json",
    "README.md",
    "LICENSE",
    "SPEC.md",
    "bin/open-wheel.mjs",
    "lib/citations.mjs",
    "skills/wheel-check/SKILL.md",
  ]) {
    assert.equal(isAllowedPath(allowed), true, allowed);
  }

  for (const rejected of [
    "scripts/scrub-package.mjs",
    "test/open-wheel.test.mjs",
    ".env",
    "docs/internal.md",
  ]) {
    assert.equal(isAllowedPath(rejected), false, rejected);
  }
});
