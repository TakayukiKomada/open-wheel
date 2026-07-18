// push 配信: `paths:` 付きエントリ → path-scoped agent rules の生成 (SPEC.md §5)。
// gamefork の scripts/gen-wheel-rules.mjs から可搬化した正本。
// 生成先の既定は Claude Code の project rules (.claude/rules/wheel/) だが、
// 出力は「frontmatter paths + summary + 正本 pointer」の素朴な Markdown なので
// 他ツールのトリガ層にも流用できる。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

// 生成物の識別マーカー。writeRules/checkRules はこのマーカーを持つファイルだけを
// 「自分の生成物」として扱う (手書きファイルの削除・orphan 誤検知の防止)。
export const GENERATED_MARKER = "AUTO-GENERATED";

/** 表示用パスの区切りを / に統一する (Windows の path.join 由来の \ 混在を防ぐ)。 */
function toPosix(p) {
  return String(p).replace(/\\/g, "/");
}

/** 1 エントリ分の rule ファイル (title + summary + 正本 pointer のみ、全文複製なし)。 */
export function renderRule(entry, wheelDir) {
  const paths = entry.paths.map((p) => `  - "${p}"`).join("\n");
  const pointer = `${toPosix(wheelDir)}/${toPosix(entry.file)}`;
  return `---
paths:
${paths}
---

<!-- ${GENERATED_MARKER} from ${pointer} by open-wheel — do not edit.
     Edit the wheel entry instead, then re-run: open-wheel rules -->

**[${entry.id}] ${entry.title}**

${entry.summary}

Full entry (read it): ${pointer}
`;
}

/** 期待される生成物 (ファイル名 → 内容)。active かつ paths 付きのみ。 */
export function buildExpectedRules(entries, wheelDir) {
  const expected = new Map();
  for (const entry of entries) {
    if (entry.status !== "active" || entry.paths.length === 0) continue;
    expected.set(`${entry.id}.md`, renderRule(entry, wheelDir));
  }
  return expected;
}

/** rulesDir 内の .md のうち「自分の生成物」(マーカー持ち) だけを列挙する。 */
function listGeneratedFiles(rulesDir) {
  if (!existsSync(rulesDir)) return [];
  return readdirSync(rulesDir).filter((f) => {
    if (!f.endsWith(".md")) return false;
    try {
      return readFileSync(join(rulesDir, f), "utf-8").includes(GENERATED_MARKER);
    } catch {
      return false;
    }
  });
}

/** --check: 生成結果と disk の差分一覧を返す (空 = 同期済み)。手書きファイルは対象外。 */
export function checkRules(expected, rulesDir) {
  const problems = [];
  for (const [name, content] of expected) {
    const p = join(rulesDir, name);
    if (!existsSync(p)) problems.push(`missing: ${name}`);
    else if (readFileSync(p, "utf-8") !== content) problems.push(`stale: ${name}`);
  }
  for (const f of listGeneratedFiles(rulesDir)) {
    if (!expected.has(f)) problems.push(`orphan: ${f} (no active entry with paths)`);
  }
  return problems;
}

/**
 * 生成: 生成物マーカーを持つ既存ファイルだけを掃除してから書き直す。
 * ディレクトリ全体の再帰削除はしない — `--out .claude/rules` のような指定で
 * 手書きルールまで消える事故を防ぐ (2026-07-10 監査指摘)。
 */
export function writeRules(expected, rulesDir) {
  for (const f of listGeneratedFiles(rulesDir)) {
    rmSync(join(rulesDir, f), { force: true });
  }
  mkdirSync(rulesDir, { recursive: true });
  for (const [name, content] of expected) {
    writeFileSync(join(rulesDir, name), content, "utf-8");
  }
}
