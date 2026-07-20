// open-wheel の単体 + CLI e2e (node:test、依存ゼロ)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWheelEntry, buildWheelIndex, validateWheel } from "../lib/entry.mjs";
import { buildExpectedRules, checkRules, writeRules } from "../lib/rules.mjs";
import { parseGitLog, detectCandidates, findLaterRefix, renderDraft } from "../lib/harvest.mjs";
import { extractSignatures, collectSignatures, groupCorroborated } from "../lib/corroborate.mjs";
import { buildCorpusManifest, contentHash } from "../lib/corpus.mjs";
import { extractCitedIds, touchesEntryFile, tallyCitations, suggestReverify } from "../lib/citations.mjs";
import {
  entryMatchesTarget,
  buildExpectedAgentsBlocks,
  checkAgentsBlocks,
  writeAgentsBlocks,
} from "../lib/agents.mjs";
import { buildHfRecords, renderDatasetCard } from "../lib/export-hf.mjs";
import { parseTranscriptEvents, detectStruggleArcs, arcKey, renderTranscriptDraft } from "../lib/transcript.mjs";
import { suggestVerified } from "../lib/citations.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "bin", "open-wheel.mjs");

const ENTRY = `---
id: failure-0001
title: sample failure
summary: what happened and how to prevent it.
status: active
tags: [deploy, ci]
paths: [infra/**]
created: 2026-07-06
source: commit abc1234
supersedes: null
superseded_by: null
---

## Context
c
## Failure
f
## Consequences
- outcome: fixed and verified.
`;

test("date-form id: parse / filename 突合 / 実在しない日付・不一致は throw", () => {
  const dateEntry = ENTRY.replace("id: failure-0001", "id: failure-20260718-sample");
  // 正常: id = prefix + ファイル名 (YYYYMMDD-slug.md)
  const e = parseWheelEntry(dateEntry, "failure", "20260718-sample.md");
  assert.equal(e.id, "failure-20260718-sample");
  // ファイル名と id の不一致は throw
  assert.throws(
    () => parseWheelEntry(dateEntry, "failure", "20260718-other.md"),
    /date-form id must equal prefix \+ filename/,
  );
  // date-form id なのに連番ファイル名は throw
  assert.throws(
    () => parseWheelEntry(dateEntry, "failure", "0001-sample.md"),
    /requires a YYYYMMDD-slug\.md filename/,
  );
  // 実在しない日付 (20269999) は throw
  assert.throws(
    () => parseWheelEntry(
      ENTRY.replace("id: failure-0001", "id: failure-20269999-sample"),
      "failure",
      "20269999-sample.md",
    ),
    /not a real YYYYMMDD date/,
  );
});

test("date-form id: citations 抽出・touchesEntryFile・クロスリンクの両形式対応", () => {
  // 引用抽出: 日付形式と連番形式が混在しても両方拾い、日付 id の先頭 4 桁を連番と誤認しない
  const ids = extractCitedIds({
    subject: "fix: follow failure-20260718-sample and design-0034",
    body: "also cites [[code-0005]]",
  });
  assert.deepEqual(ids.sort(), ["code-0005", "design-0034", "failure-20260718-sample"].sort());
  // touchesEntryFile: 日付形式はファイル完全一致、連番形式は NNNN- 前方一致
  const commit = { files: ["docs/wheel/failures/20260718-sample.md"] };
  assert.equal(touchesEntryFile(commit, "failure-20260718-sample"), true);
  assert.equal(touchesEntryFile(commit, "failure-2026"), false);
  const legacyCommit = { files: ["docs/wheel/failures/0015-old-slug.md"] };
  assert.equal(touchesEntryFile(legacyCommit, "failure-0015"), true);
});

test("parseWheelEntry: 契約どおり構造化し、必須欠落は throw", () => {
  const e = parseWheelEntry(ENTRY, "failure", "0001-sample.md");
  assert.equal(e.id, "failure-0001");
  assert.deepEqual(e.paths, ["infra/**"]);
  assert.equal(e.published, null);
  assert.equal(e.verified, null);
  assert.throws(
    () => parseWheelEntry(ENTRY.replace("summary: what happened and how to prevent it.\n", ""), "failure", "x.md"),
    /summary/,
  );
  assert.throws(() => parseWheelEntry(ENTRY, "design", "x.md"), /design-NNNN/);
});

test("parseWheelEntry: verified は YYYY-MM-DD のみ受理", () => {
  const withVerified = ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: 2026-07-07");
  assert.equal(parseWheelEntry(withVerified, "failure", "0001-sample.md").verified, "2026-07-07");
  const bad = ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: yes");
  assert.throws(() => parseWheelEntry(bad, "failure", "0001-sample.md"), /YYYY-MM-DD/);
});

test("buildCorpusManifest: verified 付きだけが入り、未検証はカウントのみ", () => {
  const verified = {
    ...parseWheelEntry(
      ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: 2026-07-07"),
      "failure",
      "0001-sample.md",
    ),
  };
  const unverified = parseWheelEntry(
    ENTRY.replace("failure-0001", "failure-0002"),
    "failure",
    "0002-other.md",
  );
  const superseded = {
    ...verified,
    id: "failure-0003",
    status: "superseded",
    superseded_by: "failure-0001",
  };

  const manifest = buildCorpusManifest([verified, unverified, superseded], { generatedAt: "2026-07-08T00:00:00Z" });
  assert.equal(manifest.spec, "open-wheel-corpus/v1");
  assert.equal(manifest.count, 1);
  assert.equal(manifest.skipped_unverified, 1);
  assert.deepEqual(manifest.entries.map((e) => e.id), ["failure-0001"]);
  // manifest は本文を持たず content_hash で指す (dedup / provenance 照合キー)
  assert.equal(manifest.entries[0].body, undefined);
  assert.equal(manifest.entries[0].content_hash, contentHash(verified.body));
  assert.match(manifest.entries[0].content_hash, /^sha256:[0-9a-f]{64}$/);

  // superseded は opt-in でのみ入る
  const withSuperseded = buildCorpusManifest([verified, superseded], { includeSuperseded: true });
  assert.equal(withSuperseded.count, 2);
});

test("citations: 引用抽出・自己編集除外・clean/refixed の成否分類", () => {
  const mk = (sha, date, subject, files, body = "") => ({ sha, date, subject, body, files });

  // 引用抽出: subject + body から全種別、重複なし
  assert.deepEqual(
    extractCitedIds(mk("a".repeat(40), "d", "fix: failure-0003 に従い REVOKE を先行", [], "design-0002 も参照。failure-0003 再掲")),
    ["failure-0003", "design-0002"],
  );

  // 自己編集除外: エントリ正本を触る commit は「選択」に数えない
  const adopt = mk("b".repeat(40), "2026-07-01T00:00:00+00:00", "docs(wheel): failure-0009 を追加", [
    "docs/wheel/failures/0009-x.md",
  ]);
  assert.equal(touchesEntryFile(adopt, "failure-0009"), true);
  assert.equal(touchesEntryFile(adopt, "failure-0003"), false);

  // 成否分類: 引用 commit のファイルが後続 fix で再修正されたら refixed
  const goodChoice = mk("c".repeat(40), "2026-07-02T00:00:00+00:00", "feat: failure-0001 に従い実装", ["src/a.ts"]);
  const badChoice = mk("d".repeat(40), "2026-07-02T00:00:00+00:00", "feat: failure-0002 に従い実装", ["src/b.ts"]);
  const refixOfBad = mk("e".repeat(40), "2026-07-04T00:00:00+00:00", "fix: b.ts をやり直し", ["src/b.ts"]);
  const tally = tallyCitations([adopt, goodChoice, badChoice, refixOfBad]);

  assert.equal(tally.has("failure-0009"), false); // 自己編集は不算入
  assert.deepEqual(
    { c: tally.get("failure-0001").clean, r: tally.get("failure-0001").refixed },
    { c: 1, r: 0 },
  );
  assert.deepEqual(
    { c: tally.get("failure-0002").clean, r: tally.get("failure-0002").refixed },
    { c: 0, r: 1 },
  );
  assert.equal(tally.get("failure-0002").cites[0].refix_sha, refixOfBad.sha);

  // 共有ホットスポット除外: 引用 commit と後続 fix が docs/wheel/README.md でしか
  // 重ならない場合は refixed にしない (偽 refixed の主因)
  const citeWithDocs = mk("f".repeat(40), "2026-07-02T00:00:00+00:00", "feat: failure-0004 に従い実装", [
    "src/c.ts",
    "docs/wheel/README.md",
    "AGENTS.md",
  ]);
  const fixDocsOnly = mk("1".repeat(40), "2026-07-04T00:00:00+00:00", "fix(wheel): README 修正", [
    "docs/wheel/README.md",
    "AGENTS.md",
  ]);
  const tally2 = tallyCitations([citeWithDocs, fixDocsOnly]);
  assert.deepEqual(
    { c: tally2.get("failure-0004").clean, r: tally2.get("failure-0004").refixed },
    { c: 1, r: 0 },
  );
  // 実装ファイル (src/c.ts) が再修正されたら refixed のまま
  const fixCode = mk("2".repeat(40), "2026-07-05T00:00:00+00:00", "fix: c.ts をやり直し", ["src/c.ts"]);
  const tally3 = tallyCitations([citeWithDocs, fixCode]);
  assert.equal(tally3.get("failure-0004").refixed, 1);
});

test("findLaterRefix: 後続の同ファイル fix を検出し、無関係 commit は無視", () => {
  const mk = (sha, date, subject, files) => ({ sha, date, subject, body: "", files });
  const base = { commit: mk("a".repeat(40), "2026-07-01T00:00:00+00:00", "fix: first", ["src/a.ts"]), reason: "t" };
  const refix = mk("b".repeat(40), "2026-07-03T00:00:00+00:00", "fix: again", ["src/a.ts"]);
  const unrelated = mk("c".repeat(40), "2026-07-03T00:00:00+00:00", "fix: other", ["src/z.ts"]);
  const feat = mk("d".repeat(40), "2026-07-03T00:00:00+00:00", "feat: same file", ["src/a.ts"]);
  assert.deepEqual(findLaterRefix(base, [refix, base.commit]), { sha: refix.sha, subject: "fix: again" });
  assert.equal(findLaterRefix(base, [unrelated, feat, base.commit]), null);
});

test("validateWheel: クロスリンク切れ / supersede 不整合を検出", () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-"));
  mkdirSync(join(root, "failures"), { recursive: true });
  writeFileSync(join(root, "failures", "0001-a.md"), ENTRY);
  writeFileSync(
    join(root, "failures", "0002-b.md"),
    ENTRY.replace("failure-0001", "failure-0002").replace("## Context\nc", "## Context\nsee [[failure-0009]]"),
  );
  const { problems } = validateWheel(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /broken cross-link \[\[failure-0009\]\]/);
});

test("validateWheel: aliases が id を含まない場合を検出 (aliases 無しは許容)", () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-"));
  mkdirSync(join(root, "failures"), { recursive: true });
  // aliases 無し = 問題なし (SPEC §2 では任意フィールド)
  writeFileSync(join(root, "failures", "0001-a.md"), ENTRY);
  assert.equal(validateWheel(root).problems.length, 0);
  // aliases があるのに id を含まない = [[id]] リンクが解決しない
  writeFileSync(
    join(root, "failures", "0001-a.md"),
    ENTRY.replace("id: failure-0001", "id: failure-0001\naliases: [failure-0999]"),
  );
  const { problems } = validateWheel(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /aliases must include the entry id failure-0001/);
});

test("rules: 生成 → check OK、正本改変で stale 検出", () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-"));
  mkdirSync(join(root, "failures"), { recursive: true });
  writeFileSync(join(root, "failures", "0001-a.md"), ENTRY);
  const rulesDir = join(root, "rules");
  const entries = buildWheelIndex(root);
  const expected = buildExpectedRules(entries, "docs/wheel");
  writeRules(expected, rulesDir);
  assert.deepEqual(checkRules(expected, rulesDir), []);
  const changed = buildExpectedRules(
    entries.map((e) => ({ ...e, summary: "changed" })),
    "docs/wheel",
  );
  assert.match(checkRules(changed, rulesDir)[0], /stale/);
});

test("harvest: fix 検出・failures 同梱除外・下書きは採番しない", () => {
  const raw =
    "\x1e" + "a".repeat(40) + "\x1f2026-07-06T00:00:00+00:00\x1ffix(x): broke prod\x1fdetail\x1f\ninfra/deploy.sh\n" +
    "\x1e" + "b".repeat(40) + "\x1f2026-07-06T00:00:00+00:00\x1ffix: with entry\x1f\x1f\ndocs/wheel/failures/0009-x.md\n" +
    "\x1e" + "c".repeat(40) + "\x1f2026-07-06T00:00:00+00:00\x1ffeat: new stuff\x1f\x1f\nsrc/a.ts\n";
  const commits = parseGitLog(raw);
  const candidates = detectCandidates(commits, new Set(), "docs/wheel");
  assert.equal(candidates.length, 1);
  const draft = renderDraft(candidates[0], { onMain: true });
  assert.match(draft, /id: failure-YYYYMMDD-slug/);
  assert.match(draft, /aliases: \[failure-YYYYMMDD-slug\]/);
  assert.match(draft, /## Trigger/);
  assert.match(draft, /## Detection/);
  assert.match(draft, /## Consequences/);
  assert.doesNotMatch(draft, /id: failure-\d{4}/);
});

test("rules --pointer: 正本 pointer を絶対パス/URL に差し替えられる (user-level 配信)", () => {
  const root = mkdtempSync(join(tmpdir(), "wheel-"));
  mkdirSync(join(root, "failures"), { recursive: true });
  writeFileSync(join(root, "failures", "0001-a.md"), ENTRY);
  const entries = buildWheelIndex(root);
  const expected = buildExpectedRules(entries, "https://github.com/x/y/blob/main/docs/wheel");
  const rule = expected.get("failure-0001.md");
  assert.match(rule, /https:\/\/github\.com\/x\/y\/blob\/main\/docs\/wheel\/failures\/0001-a\.md/);
});

test("CLI e2e: pull <local-path> がリモート wheel の rules + index を生成する", () => {
  // "リモート" 側: docs/wheel 配下に paths 付きエントリを持つ疑似リポジトリ
  const remote = mkdtempSync(join(tmpdir(), "wheel-remote-"));
  mkdirSync(join(remote, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(join(remote, "docs", "wheel", "failures", "0001-a.md"), ENTRY);

  // "購読" 側リポジトリで pull
  const consumer = mkdtempSync(join(tmpdir(), "wheel-consumer-"));
  const out = execFileSync("node", [CLI, "pull", remote, "--name", "upstream"], {
    cwd: consumer,
    encoding: "utf-8",
  });
  assert.match(out, /1 entries from/);

  const rule = readFileSync(join(consumer, ".claude", "rules", "wheel-pull", "upstream", "failure-0001.md"), "utf-8");
  assert.match(rule, /- "infra\/\*\*"/);
  assert.match(rule, /docs\/wheel\/failures\/0001-a\.md/); // pointer が購読元を指す
  const index = JSON.parse(readFileSync(join(consumer, ".claude", "wheel-pull", "upstream.index.json"), "utf-8"));
  assert.equal(index.length, 1);
  assert.equal(index[0].id, "failure-0001");
});

test("CLI e2e: promote が global 側に採番配置し、private 側へ published: を記録する", () => {
  // private 側リポジトリ
  const priv = mkdtempSync(join(tmpdir(), "wheel-priv-"));
  mkdirSync(join(priv, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(priv, "docs", "wheel", "failures", "0001-sample.md"),
    ENTRY.replace("## Context\nc", "## Context\ncommit deadbeef12345 と #123 を参照 (see [[design-0001]])"),
  );
  // global 側 checkout (既に 0001 が存在 → 次番号は 0002)
  const glob = mkdtempSync(join(tmpdir(), "wheel-glob-"));
  mkdirSync(join(glob, "io.test", "failures"), { recursive: true });
  writeFileSync(join(glob, "io.test", "failures", "0001-existing.md"), "x");

  const out = execFileSync(
    "node",
    [CLI, "promote", "failure-0001", "--to", glob, "--ns", "io.test"],
    { cwd: priv, encoding: "utf-8" },
  );
  assert.match(out, /published: io\.test\/failure-0002 recorded/);

  const draft = readFileSync(join(glob, "io.test", "failures", "0002-sample.md"), "utf-8");
  assert.match(draft, /id: failure-0002/);
  assert.match(draft, /namespace: io\.test/); // global 層 verifier の必須キー
  assert.match(draft, /origin: TODO/);
  assert.match(draft, /commit っぽい hash: deadbeef12345/); // 内部参照が TODO として列挙される
  assert.match(draft, /private クロスリンク: \[\[design-0001\]\]/);
  assert.match(draft, /verified: null/); // 昇格元が未検証なら null のまま (export-hf 対象外、SPEC.md §3)

  const original = readFileSync(join(priv, "docs", "wheel", "failures", "0001-sample.md"), "utf-8");
  assert.match(original, /published: io\.test\/failure-0002/);

  // 再実行 (冪等): published 済みは global 側に何も書かず、次番号も増殖しない
  const out2 = execFileSync(
    "node",
    [CLI, "promote", "failure-0001", "--to", glob, "--ns", "io.test"],
    { cwd: priv, encoding: "utf-8" },
  );
  assert.match(out2, /already published as io\.test\/failure-0002 — nothing written/);
  assert.equal(existsSync(join(glob, "io.test", "failures", "0003-sample.md")), false);
});

test("promote: published: null は未公開として実値へ置換し、traversal な ns は拒否する", () => {
  // published: null プレースホルダ持ちの private エントリ (旧実装は「公開済み」と誤判定)
  const priv = mkdtempSync(join(tmpdir(), "wheel-priv-"));
  mkdirSync(join(priv, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(priv, "docs", "wheel", "failures", "0001-sample.md"),
    ENTRY.replace("superseded_by: null", "superseded_by: null\npublished: null"),
  );
  const glob = mkdtempSync(join(tmpdir(), "wheel-glob-"));

  const out = execFileSync("node", [CLI, "promote", "failure-0001", "--to", glob, "--ns", "io.test"], {
    cwd: priv,
    encoding: "utf-8",
  });
  assert.match(out, /published: io\.test\/failure-0001 recorded/);
  const original = readFileSync(join(priv, "docs", "wheel", "failures", "0001-sample.md"), "utf-8");
  assert.match(original, /^published: io\.test\/failure-0001$/m);
  assert.doesNotMatch(original, /published: null/);

  // namespace のパストラバーサル (../..) は形式検証で拒否され、global 外に書かれない
  const priv2 = mkdtempSync(join(tmpdir(), "wheel-priv-"));
  mkdirSync(join(priv2, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(join(priv2, "docs", "wheel", "failures", "0001-sample.md"), ENTRY);
  assert.throws(
    () => execFileSync("node", [CLI, "promote", "failure-0001", "--to", glob, "--ns", "../../outside"], {
      cwd: priv2,
      encoding: "utf-8",
      stdio: "pipe",
    }),
    /reverse-DNS/,
  );
});

test("promote: mechanic/prompt は複数形ディレクトリ (mechanics/prompts) に配置される", () => {
  const priv = mkdtempSync(join(tmpdir(), "wheel-priv-"));
  mkdirSync(join(priv, "docs", "wheel", "mechanics"), { recursive: true });
  writeFileSync(
    join(priv, "docs", "wheel", "mechanics", "0001-sample.md"),
    ENTRY.replace("id: failure-0001", "id: mechanic-0001"),
  );
  const glob = mkdtempSync(join(tmpdir(), "wheel-glob-"));

  const out = execFileSync("node", [CLI, "promote", "mechanic-0001", "--to", glob, "--ns", "io.test"], {
    cwd: priv,
    encoding: "utf-8",
  });
  assert.match(out, /published: io\.test\/mechanic-0001 recorded/);
  assert.ok(existsSync(join(glob, "io.test", "mechanics", "0001-sample.md"))); // 単数形 "mechanic" ではない
});

test("promote: verified/observed_by は昇格元の値をそのまま下書きに引き継ぐ", () => {
  const priv = mkdtempSync(join(tmpdir(), "wheel-priv-"));
  mkdirSync(join(priv, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(priv, "docs", "wheel", "failures", "0001-sample.md"),
    ENTRY.replace("superseded_by: null", "superseded_by: null\nobserved_by: codex-cli\nverified: 2026-07-08"),
  );
  const glob = mkdtempSync(join(tmpdir(), "wheel-glob-"));

  execFileSync("node", [CLI, "promote", "failure-0001", "--to", glob, "--ns", "io.test"], {
    cwd: priv,
    encoding: "utf-8",
  });

  const draft = readFileSync(join(glob, "io.test", "failures", "0001-sample.md"), "utf-8");
  assert.match(draft, /verified: 2026-07-08/);
  assert.match(draft, /observed_by: codex-cli/);
});

test("CLI e2e: init → validate → rules → rules --check が素の node で通る", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-repo-"));
  const run = (args) => execFileSync("node", [CLI, ...args], { cwd: repo, encoding: "utf-8" });

  const initOut = run(["init"]);
  assert.match(initOut, /wheel scaffolded/);
  assert.ok(existsSync(join(repo, "docs", "wheel", "design", "0001-adopt-wheel.md")));

  assert.match(run(["validate"]), /validate OK \(1 entries\)/);

  // paths 付きエントリを足して rules を生成
  writeFileSync(join(repo, "docs", "wheel", "failures", "0001-sample.md"), ENTRY);
  assert.match(run(["rules"]), /1 rules/);
  const rule = readFileSync(join(repo, ".claude", "rules", "wheel", "failure-0001.md"), "utf-8");
  assert.match(rule, /- "infra\/\*\*"/);
  assert.match(rule, /docs\/wheel\/failures\/0001-sample\.md/);
  assert.match(run(["rules", "--check"]), /in sync/);

  // index が stdout に JSON を出す
  const index = JSON.parse(run(["index"]));
  assert.equal(index.length, 2);
});

function fakeEntry(overrides) {
  return {
    id: "failure-0001",
    kind: "failure",
    file: "failures/0001-x.md",
    title: "x",
    summary: "y",
    status: "active",
    tags: [],
    paths: [],
    created: "2026-07-06",
    source: "test",
    supersedes: null,
    superseded_by: null,
    published: null,
    body: "z",
    ...overrides,
  };
}

test("extractSignatures: ベンダーコードと HTTP ステータスを抽出する", () => {
  const text = "deploy failed: [code: 10074] Cannot apply migration. Also saw 429 Too Many Requests once.";
  const sigs = extractSignatures(text);
  assert.ok(sigs.includes("code:10074"));
  assert.ok(sigs.includes("http:429-too-many-requests"));
});

test("extractSignatures: 一致が無ければ空配列", () => {
  assert.deepEqual(extractSignatures("nothing interesting here"), []);
});

test("collectSignatures / groupCorroborated: 2 独立ソースで一致した signature のみ corroborated", () => {
  const a = fakeEntry({ id: "failure-0001", source: "self", body: "hit [code: 10074] during deploy" });
  const b = fakeEntry({ id: "failure-0099", source: "peer", body: "same [code: 10074] error here too" });
  const c = fakeEntry({ id: "failure-0002", source: "self", body: "unrelated [code: 99999] once" });

  const rows = [...collectSignatures("self", [a, c]), ...collectSignatures("peer", [b])];
  const groups = groupCorroborated(rows);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].signature, "code:10074");
  assert.equal(groups[0].sourceCount, 2);
  assert.deepEqual(groups[0].sources.sort(), ["peer", "self"]);
});

test("groupCorroborated: 同一ソース内の複数エントリが同じ signature でも corroboration にならない", () => {
  const a = fakeEntry({ id: "failure-0001", body: "[code: 12345]" });
  const b = fakeEntry({ id: "failure-0002", body: "also [code: 12345]" });
  const rows = collectSignatures("self", [a, b]);
  assert.equal(groupCorroborated(rows).length, 0);
});

test("CLI e2e: corroborate は自分の wheel + pull した索引を横断して報告する", () => {
  // 自分の wheel: [code: 10074] を含む failure エントリ
  const repo = mkdtempSync(join(tmpdir(), "wheel-repo-"));
  mkdirSync(join(repo, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wheel", "failures", "0001-x.md"),
    ENTRY.replace("## Failure\nf", "## Failure\nhit [code: 10074] during deploy"),
  );

  // pull 済みの外部ソースを模した索引ファイルを直接配置
  const pullDir = join(repo, ".claude", "wheel-pull");
  mkdirSync(pullDir, { recursive: true });
  writeFileSync(
    join(pullDir, "peer-team.index.json"),
    JSON.stringify([
      fakeEntry({ id: "failure-0099", file: "failures/0099-y.md", body: "same [code: 10074] error, different repo" }),
    ]),
  );

  const out = execFileSync("node", [CLI, "corroborate"], { cwd: repo, encoding: "utf-8" });
  assert.match(out, /1 signature\(s\) independently corroborated/);
  assert.match(out, /\[code:10074\] seen in 2 independent sources: self, peer-team/);

  // corroboration が無い場合は分かりやすいメッセージを出す
  const empty = mkdtempSync(join(tmpdir(), "wheel-empty-"));
  execFileSync("node", [CLI, "init"], { cwd: empty });
  const emptyOut = execFileSync("node", [CLI, "corroborate"], { cwd: empty, encoding: "utf-8" });
  assert.match(emptyOut, /no signature corroborated/);
});

test("parseWheelEntry: enforced_by は list として構造化される", () => {
  const withEnforced = ENTRY.replace(
    "superseded_by: null",
    "superseded_by: null\nenforced_by: [scripts/lint-migrations.mjs]",
  );
  assert.deepEqual(
    parseWheelEntry(withEnforced, "failure", "0001-sample.md").enforced_by,
    ["scripts/lint-migrations.mjs"],
  );
  assert.deepEqual(parseWheelEntry(ENTRY, "failure", "0001-sample.md").enforced_by, []);
});

test("agents: target 判定 — 接頭辞 / 普遍 glob の実在チェック", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-agents-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  mkdirSync(join(repo, "apps", "runner"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "wrangler.jsonc"), "{}");

  const prefixed = { status: "active", paths: ["apps/web/.env*"] };
  assert.equal(entryMatchesTarget(prefixed, "apps/web", repo), true);
  assert.equal(entryMatchesTarget(prefixed, "apps/runner", repo), false);

  const universal = { status: "active", paths: ["**/wrangler.jsonc"] };
  assert.equal(entryMatchesTarget(universal, "apps/web", repo), true);
  assert.equal(entryMatchesTarget(universal, "apps/runner", repo), false);

  // ワイルドカードが残る普遍 glob は過小配信を避けて全 target に配信
  const wildcard = { status: "active", paths: ["**/*.sql"] };
  assert.equal(entryMatchesTarget(wildcard, "apps/runner", repo), true);
});

test("agents: 生成 → check OK、手書き部分は温存、stale / orphan を検出", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-agents-rt-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  mkdirSync(join(repo, "supabase"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "AGENTS.md"), "# handwritten rules\n\nkeep me.\n");

  const entries = [
    {
      id: "failure-0001", title: "t1", summary: "s1", status: "active",
      paths: ["apps/web/.env*"], file: "failures/0001-x.md",
    },
    {
      id: "failure-0002", title: "t2", summary: "s2", status: "superseded",
      paths: ["apps/web/**"], file: "failures/0002-y.md",
    },
  ];
  const expected = buildExpectedAgentsBlocks(entries, ["apps/web", "supabase"], "docs/wheel", repo);
  assert.equal(expected.get("supabase"), null); // 該当なし → ブロック不要
  assert.match(expected.get("apps/web"), /failure-0001/);
  assert.doesNotMatch(expected.get("apps/web"), /failure-0002/); // superseded は配信しない

  writeAgentsBlocks(expected, repo);
  const written = readFileSync(join(repo, "apps", "web", "AGENTS.md"), "utf-8");
  assert.match(written, /handwritten rules/); // marker 外は温存
  assert.match(written, /BEGIN:wheel-rules/);
  assert.deepEqual(checkAgentsBlocks(expected, repo), []);

  // 再生成は冪等 (upsert が既存ブロックを置換する)
  writeAgentsBlocks(expected, repo);
  assert.equal(readFileSync(join(repo, "apps", "web", "AGENTS.md"), "utf-8"), written);

  // 正本改変 → stale 検出
  const tampered = buildExpectedAgentsBlocks(
    [{ ...entries[0], summary: "changed" }], ["apps/web"], "docs/wheel", repo,
  );
  assert.match(checkAgentsBlocks(tampered, repo)[0], /stale: apps\/web\/AGENTS\.md/);

  // エントリが消えた後にブロックが残っていれば orphan
  const none = buildExpectedAgentsBlocks([], ["apps/web"], "docs/wheel", repo);
  assert.match(checkAgentsBlocks(none, repo)[0], /orphan block/);
  writeAgentsBlocks(none, repo);
  const cleaned = readFileSync(join(repo, "apps", "web", "AGENTS.md"), "utf-8");
  assert.doesNotMatch(cleaned, /BEGIN:wheel-rules/);
  assert.match(cleaned, /handwritten rules/);

  // AGENTS.md が無い target はブロックのみで新規作成
  const fresh = buildExpectedAgentsBlocks(entries, ["supabase"], "docs/wheel", repo);
  assert.equal(fresh.get("supabase"), null);
  writeAgentsBlocks(fresh, repo);
  assert.equal(existsSync(join(repo, "supabase", "AGENTS.md")), false);
});

test("export-hf: verified+active のみ、scrub 除外、sections 分割、ns 前置", () => {
  const ok = fakeEntry({
    id: "failure-0001",
    verified: "2026-07-08",
    body: "## Context\nc\n## Failure\nf\n## Consequences\nfixed and held.",
  });
  const unverified = fakeEntry({ id: "failure-0002" }); // verified 無し
  const superseded = fakeEntry({ id: "failure-0003", verified: "2026-07-01", status: "superseded" });
  const leaky = fakeEntry({
    id: "failure-0004",
    verified: "2026-07-08",
    body: "token was ghp_abcdefghijklmnop and mail admin@example.com",
  });

  const { records, excluded, skipped_unverified } = buildHfRecords(
    [ok, unverified, superseded, leaky],
    { ns: "io.gamefork" },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "io.gamefork/failure-0001");
  assert.equal(records[0].sections.failure, "f");
  assert.equal(records[0].sections.consequences, "fixed and held.");
  assert.match(records[0].content_hash, /^sha256:/);
  assert.equal(skipped_unverified, 2);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, "failure-0004");
  assert.ok(excluded[0].reasons.includes("api-key-like"));
  assert.ok(excluded[0].reasons.includes("email"));
});

test("export-hf: scrub 強化 — forward-slash Windows パス / 新種 secret prefix / JWT を除外", () => {
  // 2026-07-10 audit-sweep で見つかった穴: 旧 local-abs-path は backslash 前提で
  // Git Bash / Node 出力の C:/Users/... を見逃していた
  const cases = [
    { id: "failure-0010", body: "log at C:/Users/someone/work/app.log", reason: "local-abs-path" },
    { id: "failure-0011", body: "token sbp_0102030405060708090a", reason: "api-key-like" },
    { id: "failure-0012", body: "github_pat_11ABCDEFG0123456789abcdef", reason: "api-key-like" },
    { id: "failure-0013", body: "auth npm_abcdefghijklmnop", reason: "api-key-like" },
    { id: "failure-0014", body: "key sb_secret_abcdefghijklmnop", reason: "api-key-like" },
    { id: "failure-0015", body: "bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi", reason: "jwt-like" },
  ];
  const entries = cases.map((c) => fakeEntry({ id: c.id, verified: "2026-07-08", body: c.body }));

  const { records, excluded } = buildHfRecords(entries);
  assert.equal(records.length, 0);
  assert.equal(excluded.length, cases.length);
  const reasonsById = new Map(excluded.map((x) => [x.id, x.reasons]));
  for (const c of cases) {
    assert.ok(reasonsById.get(c.id)?.includes(c.reason), `${c.id} should hit ${c.reason}`);
  }

  // backslash 形式も引き続き当たる (両対応の確認)
  const back = buildHfRecords([
    fakeEntry({ id: "failure-0016", verified: "2026-07-08", body: "at C:\\Users\\someone\\app.log" }),
  ]);
  assert.equal(back.excluded.length, 1);
  assert.ok(back.excluded[0].reasons.includes("local-abs-path"));
});

test("export-hf: dataset card にライセンス・再投入禁止則・件数が入る", () => {
  const { records } = buildHfRecords([
    fakeEntry({ id: "failure-0001", verified: "2026-07-08" }),
  ]);
  const card = renderDatasetCard(records, { license: "mit", name: "open-wheel-corpus" });
  assert.match(card, /^---\nlicense: mit\n/);
  assert.match(card, /Records: 1/);
  assert.match(card, /must not re-enter this corpus/);
  assert.match(card, /as-is, without warranty/);
});

test("CLI e2e: export-hf が JSONL + dataset card を書き、scrub 除外で exit 1", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-hf-"));
  mkdirSync(join(repo, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wheel", "failures", "0001-x.md"),
    ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: 2026-07-08"),
  );
  const out = execFileSync("node", [CLI, "export-hf", "--ns", "io.test"], { cwd: repo, encoding: "utf-8" });
  assert.match(out, /1 record\(s\)/);
  const jsonl = readFileSync(join(repo, ".tmp", "wheel-hf-export", "data", "corpus.jsonl"), "utf-8").trim();
  assert.equal(JSON.parse(jsonl).id, "io.test/failure-0001");
  assert.ok(existsSync(join(repo, ".tmp", "wheel-hf-export", "README.md")));

  // 秘密情報らしき本文を含むエントリは除外され、exit 1 で人間に差し戻す
  writeFileSync(
    join(repo, "docs", "wheel", "failures", "0002-leak.md"),
    ENTRY.replace("id: failure-0001", "id: failure-0002")
      .replace("superseded_by: null", "superseded_by: null\nverified: 2026-07-08")
      .replace("## Failure\nf", "## Failure\nleaked key AKIAABCDEFGHIJKLMNOP"),
  );
  assert.throws(
    () => execFileSync("node", [CLI, "export-hf"], { cwd: repo, encoding: "utf-8" }),
    /status 1|Command failed/,
  );
});

function transcriptLine(items, ts = "2026-07-09T00:00:00Z") {
  return JSON.stringify({ type: "assistant", message: { content: items }, timestamp: ts });
}
function toolUse(id, command) {
  return { type: "tool_use", id, name: "Bash", input: { command } };
}
function toolResult(id, isError, text) {
  return { type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] };
}

test("transcript: イベント抽出 — tool_use と tool_result を id で対応付ける", () => {
  const jsonl = [
    transcriptLine([toolUse("t1", "pnpm test")]),
    transcriptLine([toolResult("t1", true, "FAIL src/x.test.ts")]),
    "not-json-garbage",
    transcriptLine([{ type: "text", text: "thinking..." }]),
  ].join("\n");
  const events = parseTranscriptEvents(jsonl);
  assert.equal(events.length, 2);
  assert.equal(events[1].kind, "tool_result");
  assert.equal(events[1].command, "pnpm test");
  assert.equal(events[1].isError, true);
});

test("transcript: 苦闘 arc — 同一署名の失敗 2+ 回 → 成功で 1 arc、成功でリセット", () => {
  const jsonl = [
    transcriptLine([toolUse("t1", "pnpm test"), toolResult("t1", true, "FAIL a")]),
    transcriptLine([toolUse("t2", "pnpm test src/x.test.ts"), toolResult("t2", true, "FAIL b")]),
    transcriptLine([toolUse("t3", "node scripts/other.mjs"), toolResult("t3", false, "ok")]), // 無関係な成功
    transcriptLine([toolUse("t4", "pnpm test"), toolResult("t4", false, "all pass")]),
    transcriptLine([toolUse("t5", "pnpm test"), toolResult("t5", true, "FAIL c")]), // リセット後の単発失敗
    transcriptLine([toolUse("t6", "pnpm test"), toolResult("t6", false, "pass")]),
  ].join("\n");
  const arcs = detectStruggleArcs(parseTranscriptEvents(jsonl));
  assert.equal(arcs.length, 1); // 2 回目の成功は失敗 1 回のみなので arc にならない
  assert.equal(arcs[0].attempts.length, 2);
  assert.equal(arcs[0].signature, "cmd:pnpm test");
  assert.equal(arcs[0].resolution.command, "pnpm test");
});

test("transcript: 下書きは採用手順・署名・試行ログを含み id を採番しない", () => {
  const arc = {
    signature: "cmd:pnpm test",
    attempts: [{ command: "pnpm test", error: "FAIL a" }, { command: "pnpm test", error: "FAIL b" }],
    resolution: { command: "pnpm test" },
  };
  const draft = renderTranscriptDraft(arc, { sessionFile: "s1.jsonl", date: "2026-07-09" });
  assert.match(draft, /id: failure-YYYYMMDD-slug/);
  assert.match(draft, /aliases: \[failure-YYYYMMDD-slug\]/);
  assert.match(draft, /## Trigger/);
  assert.match(draft, /## Detection/);
  assert.match(draft, /NOT adoptable as-is/);
  assert.match(draft, /2 回失敗/);
  assert.match(draft, /FAIL b/);
});

test("suggestVerified: 全 clean + 経過日数で提案、refixed / verified 済みは除外", () => {
  const tally = new Map([
    ["failure-0001", { citations: 2, clean: 2, refixed: 0, cites: [
      { sha: "aaa", date: "2026-06-01T00:00:00Z", clean: true },
      { sha: "bbb", date: "2026-06-10T00:00:00Z", clean: true },
    ] }],
    ["failure-0002", { citations: 1, clean: 0, refixed: 1, cites: [{ sha: "ccc", date: "2026-06-01T00:00:00Z", clean: false }] }],
    ["failure-0003", { citations: 1, clean: 1, refixed: 0, cites: [{ sha: "ddd", date: "2026-07-08T00:00:00Z", clean: true }] }],
  ]);
  const entries = [
    fakeEntry({ id: "failure-0001" }),
    fakeEntry({ id: "failure-0002" }),
    fakeEntry({ id: "failure-0003" }), // 引用が新しすぎる
    fakeEntry({ id: "failure-0004", verified: "2026-07-01" }), // verified 済み
  ];
  const now = Date.parse("2026-07-09T00:00:00Z");
  const out = suggestVerified(tally, entries, { nowMs: now, minAgeDays: 14 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "failure-0001");
  assert.equal(out[0].latestCite.sha, "bbb");
  assert.ok(out[0].ageDays >= 14);
});

test("suggestReverify: verified 済み active の refixed だけを再検証候補にする", () => {
  const tally = new Map([
    ["failure-0001", {
      citations: 2,
      clean: 1,
      refixed: 1,
      cites: [
        { sha: "aaa", date: "2026-06-01T00:00:00Z", clean: true },
        { sha: "bbb", date: "2026-06-10T00:00:00Z", clean: false, refix_sha: "ccc" },
      ],
    }],
    ["failure-0002", { citations: 1, clean: 0, refixed: 1, cites: [
      { sha: "ddd", date: "2026-06-01T00:00:00Z", clean: false, refix_sha: "eee" },
    ] }],
    ["failure-0003", { citations: 1, clean: 1, refixed: 0, cites: [
      { sha: "fff", date: "2026-06-01T00:00:00Z", clean: true },
    ] }],
  ]);
  const entries = [
    fakeEntry({ id: "failure-0001", verified: "2026-07-01" }),
    fakeEntry({ id: "failure-0002", verified: null }), // 未 verified
    fakeEntry({ id: "failure-0003", verified: "2026-07-01" }), // refix なし
    fakeEntry({ id: "failure-0004", verified: "2026-07-01", status: "superseded" }), // 現役でない
  ];
  const out = suggestReverify(tally, entries);
  assert.deepEqual(out, [{
    id: "failure-0001",
    verified: "2026-07-01",
    citations: 2,
    refixed: 1,
    refixes: [{ citeSha: "bbb", citeDate: "2026-06-10T00:00:00Z", refixSha: "ccc" }],
  }]);
});

test("CLI e2e: citations --suggest-reverify は verified 後の refix を JSON で提示する", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-citations-reverify-"));
  const runGit = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  const commit = (message, date) => {
    runGit("add", ".");
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--date", date, "-m", message],
      { cwd: repo, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } },
    );
  };
  mkdirSync(join(repo, "docs", "wheel", "failures"), { recursive: true });
  writeFileSync(
    join(repo, "docs", "wheel", "failures", "0001-sample.md"),
    ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: 2026-07-01"),
  );
  runGit("init", "--quiet");
  commit("docs: add verified wheel entry", "2026-07-01T00:00:00Z");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "export const value = 1;\n");
  commit("feat: failure-0001 に従って実装", "2026-07-02T00:00:00Z");
  writeFileSync(join(repo, "src", "a.js"), "export const value = 2;\n");
  commit("fix: 実装を再修正", "2026-07-03T00:00:00Z");

  const raw = execFileSync(
    "node",
    [CLI, "citations", "--ref", "HEAD", "--suggest-reverify", "--json"],
    { cwd: repo, encoding: "utf-8" },
  );
  const result = JSON.parse(raw);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].id, "failure-0001");
  assert.equal(result.suggestions[0].refixes[0].refixSha.length, 40);
});

test("CLI e2e: harvest-transcripts が下書きを出し、再実行は state 冪等で 0 件", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-tr-"));
  const trDir = join(repo, "sessions");
  mkdirSync(trDir, { recursive: true });
  writeFileSync(join(trDir, "s1.jsonl"), [
    transcriptLine([toolUse("t1", "pnpm build"), toolResult("t1", true, "TS2345 error")]),
    transcriptLine([toolUse("t2", "pnpm build"), toolResult("t2", true, "TS2345 error again")]),
    transcriptLine([toolUse("t3", "pnpm build"), toolResult("t3", false, "built")]),
  ].join("\n"));

  const out1 = execFileSync("node", [CLI, "harvest-transcripts", "--transcripts", trDir], { cwd: repo, encoding: "utf-8" });
  assert.match(out1, /1 draft\(s\) from 1 transcript\(s\)/);
  const out2 = execFileSync("node", [CLI, "harvest-transcripts", "--transcripts", trDir], { cwd: repo, encoding: "utf-8" });
  assert.match(out2, /0 draft\(s\)/);
});

// ── 2026-07-10 監査指摘の回帰テスト ─────────────────────────────────────

test("CLI e2e: pull --name のパストラバーサルは拒否される", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-pull-trav-"));
  assert.throws(
    () => execFileSync(
      "node",
      [CLI, "pull", "https://example.invalid/x.git", "--name", "../../victim"],
      { cwd: repo, encoding: "utf-8", stdio: "pipe" },
    ),
    /--name must be a plain label/,
  );
});

test("writeRules: 手書きファイルは消さず、自分の生成物 (AUTO-GENERATED) だけ掃除する", () => {
  const dir = mkdtempSync(join(tmpdir(), "wheel-rules-keep-"));
  // 手書きルール (マーカー無し) + 古い生成物 (マーカー有り・もう対応エントリなし)
  writeFileSync(join(dir, "keep.md"), "hand-written rule, do not delete\n");
  writeFileSync(join(dir, "failure-9999.md"), "<!-- AUTO-GENERATED from old by open-wheel -->\nstale\n");

  const entry = parseWheelEntry(ENTRY, "failure", "0001-sample.md");
  writeRules(buildExpectedRules([entry], "docs/wheel"), dir);

  assert.ok(existsSync(join(dir, "keep.md"))); // 手書きは温存
  assert.equal(existsSync(join(dir, "failure-9999.md")), false); // 生成物 orphan は掃除
  assert.ok(existsSync(join(dir, "failure-0001.md")));
  // check も手書きファイルを orphan 扱いしない
  assert.deepEqual(checkRules(buildExpectedRules([entry], "docs/wheel"), dir), []);
});

test("validate fail-closed: 実在しない日付・桁数違い id・接地節欠落・不正ファイル名・ディレクトリ不在", () => {
  // 桁数違い id は parse 段階で throw
  assert.throws(
    () => parseWheelEntry(ENTRY.replace("id: failure-0001", "id: failure-not-four-digits"), "failure", "0001-sample.md"),
    /id must be failure-YYYYMMDD-slug \(date form\) or failure-NNNN \(legacy 4 digits\)/,
  );
  // 実在しない日付 (形式は YYYY-MM-DD に一致) は created / verified とも throw
  assert.throws(
    () => parseWheelEntry(ENTRY.replace("created: 2026-07-06", "created: 2026-99-99"), "failure", "0001-sample.md"),
    /created must be a real/,
  );
  assert.throws(
    () => parseWheelEntry(ENTRY.replace("superseded_by: null", "superseded_by: null\nverified: 2026-99-99"), "failure", "0001-sample.md"),
    /verified must be a real/,
  );

  // wheel ディレクトリ自体が無い → OK (0 entries) ではなく問題として報告
  const missing = validateWheel(join(tmpdir(), "no-such-wheel-dir-xyz"));
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0], /wheel directory not found/);

  // 接地 3 節の欠落 (failure) と不正ファイル名を報告
  const root = mkdtempSync(join(tmpdir(), "wheel-vfc-"));
  mkdirSync(join(root, "failures"), { recursive: true });
  writeFileSync(
    join(root, "failures", "0001-a.md"),
    ENTRY.replace("## Context\nc\n## Failure\nf\n## Consequences\n- outcome: fixed and verified.", "no sections at all"),
  );
  writeFileSync(join(root, "failures", "not-numbered.md"), "junk");
  const { problems } = validateWheel(root);
  assert.ok(problems.some((p) => /missing "## Context"/.test(p)));
  assert.ok(problems.some((p) => /missing "## Failure"/.test(p)));
  assert.ok(problems.some((p) => /missing "## Consequences"/.test(p)));
  assert.ok(problems.some((p) => /not-numbered\.md: filename must be NNNN-slug\.md/.test(p)));

  // エントリ 0 件も問題として報告
  const empty = mkdtempSync(join(tmpdir(), "wheel-empty2-"));
  mkdirSync(join(empty, "failures"), { recursive: true });
  const zero = validateWheel(empty);
  assert.ok(zero.problems.some((p) => /no entries found/.test(p)));
});

test("groupCorroborated: 名前だけ違う同一内容のソースは独立ソースに数えない", () => {
  const entry = parseWheelEntry(
    ENTRY.replace("## Failure\nf", "## Failure\nhit [code: 10074] during deploy"),
    "failure",
    "0001-sample.md",
  );
  // 同一 wheel を別名で 2 回登録 (監査の再現手順そのまま)
  const rows = [
    ...collectSignatures("same-repo-a", [entry]),
    ...collectSignatures("same-repo-b", [entry]),
  ];
  assert.deepEqual(groupCorroborated(rows), []); // 複製は corroboration ではない

  // 内容が異なる 2 ソースは従来どおり corroborated
  const other = parseWheelEntry(
    ENTRY
      .replace("id: failure-0001", "id: failure-0002")
      .replace("title: sample failure", "title: different team, same error")
      .replace("## Failure\nf", "## Failure\nalso hit [code: 10074] in CI"),
    "failure",
    "0002-other.md",
  );
  const realRows = [
    ...collectSignatures("team-a", [entry]),
    ...collectSignatures("team-b", [other]),
  ];
  const groups = groupCorroborated(realRows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sourceCount, 2);
});

test("findLaterRefix: UTC オフセットが異なる commit 間でも時系列で比較する", () => {
  // 文字列比較だと "2026-07-09T23:00:00+09:00" < "2026-07-09T15:00:00Z" にならず誤判定する。
  // epoch 比較なら +09:00 の 23:00 (= UTC 14:00) の後に UTC 15:00 の refix が来たと分かる。
  const base = { commit: { sha: "aaa", date: "2026-07-09T23:00:00+09:00", subject: "fix: first", files: ["a.ts"] } };
  const later = { sha: "bbb", date: "2026-07-09T15:00:00Z", subject: "fix: again", files: ["a.ts"] };
  const refix = findLaterRefix(base, [base.commit, later]);
  assert.ok(refix);
  assert.equal(refix.sha, "bbb");
});

test("detectStruggleArcs/arcKey: 同一署名の複数 arc は ordinal で区別される", () => {
  const events = [];
  // 同じコマンドが 2 回失敗 → 成功、を 2 セット (旧 arcKey では 2 個目が衝突)
  for (const round of [1, 2]) {
    events.push({ kind: "tool_result", isError: true, command: "pnpm build", tool: "Bash", text: `err ${round}-1` });
    events.push({ kind: "tool_result", isError: true, command: "pnpm build", tool: "Bash", text: `err ${round}-2` });
    events.push({ kind: "tool_result", isError: false, command: "pnpm build", tool: "Bash", text: "ok" });
  }
  const arcs = detectStruggleArcs(events);
  assert.equal(arcs.length, 2);
  assert.notEqual(arcKey("s.jsonl", arcs[0]), arcKey("s.jsonl", arcs[1]));
});

test("detectCandidates: wheelDir が Windows 区切り (\) でも failures 同梱 commit を除外する", () => {
  const commits = [
    { sha: "aaa", date: "2026-07-09T00:00:00Z", subject: "fix: bug", body: "", files: ["docs/wheel/failures/0001-x.md", "src/a.ts"] },
    { sha: "bbb", date: "2026-07-09T01:00:00Z", subject: "fix: other bug", body: "", files: ["src/b.ts"] },
  ];
  const out = detectCandidates(commits, new Set(), String.raw`docs\wheel`);
  assert.equal(out.length, 1); // aaa は failures 同梱なので除外され、bbb だけ
  assert.equal(out[0].commit.sha, "bbb");
});

test("CLI e2e: harvest-transcripts は scrub ヒットの draft に警告コメントを差し込む (除外はしない)", () => {
  const repo = mkdtempSync(join(tmpdir(), "wheel-tr-scrub-"));
  const trDir = join(repo, "sessions");
  mkdirSync(trDir, { recursive: true });
  // エラー文に machine-local パス (forward-slash Windows 形式) が混ざった苦闘 arc
  writeFileSync(join(trDir, "s1.jsonl"), [
    transcriptLine([toolUse("t1", "pnpm build"), toolResult("t1", true, "TS2345 at C:/Users/someone/proj/x.ts")]),
    transcriptLine([toolUse("t2", "pnpm build"), toolResult("t2", true, "TS2345 at C:/Users/someone/proj/x.ts")]),
    transcriptLine([toolUse("t3", "pnpm build"), toolResult("t3", false, "built")]),
  ].join("\n"));

  execFileSync("node", [CLI, "harvest-transcripts", "--transcripts", trDir], { cwd: repo, encoding: "utf-8" });
  const outDir = join(repo, ".tmp", "wheel-runs");
  const draftFile = readdirSync(outDir).find((f) => f.startsWith("transcript-") && f.endsWith(".md"));
  assert.ok(draftFile, "draft should be written");
  const draft = readFileSync(join(outDir, draftFile), "utf-8");
  assert.match(draft, /^<!-- SCRUB WARNING: 秘密情報らしき一致 \(.*local-abs-path.*\)/);
  assert.match(draft, /WHEEL DRAFT/); // 本文は温存 (除外しない)
});
