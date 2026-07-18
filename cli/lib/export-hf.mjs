// export-hf: verified 付きエントリを Hugging Face dataset 形式 (JSONL + dataset card)
// にエクスポートする — 二段階学習・配布 (design-0023) の一段階目の出口。
//
// 位置づけと fail-closed 規則 (design-0010 / 0015 / 0017 の機械化):
//   - 想定入力は **global 層の wheel checkout** (自己完結化・汎用化済みエントリ)。
//     private 層に直接使う場合も、下の scrub が秘密情報らしきものを含むエントリを
//     除外する (fail-closed: 疑わしきは出さない)。
//   - 対象は verified かつ active のみ (結果の無い記録は学習データではない、design-0010)。
//   - 実際の HF アップロードはこのツールの外 — 公開判断は常に人間 (SPEC §4 でも
//     採用ゲートは委譲可だが、公開ゲートは委譲しない)。
//   - 二段階目 (選別学習の生成物) をこのコーパスに戻してはならない (design-0010、
//     dataset card にも明記する)。
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "./corpus.mjs";

// 秘密情報・内部参照らしきパターン。1 つでも当たったエントリは除外して報告する。
// (過剰一致で誤除外しても「出さない」側に倒れるだけなので許容する)
export const SCRUB_PATTERNS = [
  { name: "api-key-like", re: /\b(?:sk|ghp|gho|ghs|glpat|xoxb|xoxp|gnk|sbp|github_pat|npm|sb_secret)[-_][A-Za-z0-9_-]{8,}/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // JWT (base64url 3 セグメント)。Supabase の anon/service key もこの形で当たる
  { name: "jwt-like", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "email", re: /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/ },
  // Windows パスは backslash / forward-slash (Git Bash・Node 出力) 両対応
  { name: "local-abs-path", re: /(?:[A-Z]:[\\/]Users[\\/]|\/home\/[a-z0-9_-]+\/|\/Users\/[a-z0-9_-]+\/)/i },
];

/** 本文を ## 見出しで分割して { context, failure, consequences, ... } にする。 */
export function splitSections(body) {
  const sections = {};
  const parts = body.split(/^## +/m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    const text = (nl === -1 ? "" : part.slice(nl + 1)).trim();
    if (heading) sections[heading] = text;
  }
  return sections;
}

/**
 * verified+active エントリを HF dataset 用レコード列にする。
 * 戻り値: { records, excluded, skipped_unverified }
 *   - records: JSONL 1 行分のオブジェクト配列
 *   - excluded: scrub に当たって除外したエントリ ({ id, reasons })
 */
export function buildHfRecords(entries, opts = {}) {
  const ns = opts.ns ?? null;
  const records = [];
  const excluded = [];
  let skippedUnverified = 0;
  for (const e of entries) {
    if (!e.verified || e.status !== "active") {
      skippedUnverified += 1;
      continue;
    }
    const scanText = `${e.title}\n${e.summary}\n${e.source}\n${e.body}`;
    const reasons = SCRUB_PATTERNS.filter((p) => p.re.test(scanText)).map((p) => p.name);
    if (reasons.length > 0) {
      excluded.push({ id: e.id, reasons });
      continue;
    }
    records.push({
      id: ns ? `${ns}/${e.id}` : e.id,
      kind: e.kind,
      title: e.title,
      summary: e.summary,
      tags: e.tags,
      created: e.created,
      verified: e.verified,
      origin: e.source,
      observed_by: e.observed_by ?? null,
      content_hash: contentHash(e.body),
      sections: splitSections(e.body),
      body: e.body,
    });
  }
  return { records, excluded, skipped_unverified: skippedUnverified };
}

/** HF dataset card (README.md)。YAML ヘッダ + スキーマ説明 + 免責 + 再投入禁止則。 */
export function renderDatasetCard(records, opts = {}) {
  const license = opts.license ?? "mit";
  const name = opts.name ?? "open-wheel-corpus";
  const kinds = [...new Set(records.map((r) => r.kind))].sort().join(", ") || "none";
  return `---
license: ${license}
pretty_name: ${name}
tags:
  - open-wheel
  - ai-agents
  - failure-learning
  - grounded-records
size_categories:
  - n<1K
---

# ${name}

Verified problem→fix→outcome records harvested from real engineering work,
in the [open-wheel](https://github.com/TakayukiKomada/open-wheel) format.
Every record required its outcome to be verified in the field before entering
this corpus (a record without an outcome is not a lesson).

- Records: ${records.length} (kinds: ${kinds})
- Format: JSONL, one record per line (\`data/corpus.jsonl\`)

## Schema

| field | meaning |
| --- | --- |
| id | namespaced entry id (immutable) |
| kind | design / failure / code / mechanic / prompt |
| title, summary | human-written one-liner + 1-2 sentence summary |
| sections | body split by markdown headings (context / failure / consequences, ...) |
| body | full markdown body |
| origin | provenance in plain words (no private links) |
| verified | date the outcome was confirmed in the field (YYYY-MM-DD) |
| observed_by | which AI agent/model hit the issue, when known |
| content_hash | sha256 of body — dedup / provenance key |

## Rules for consumers

1. **Derived artifacts must not re-enter this corpus.** Train/distill from it,
   but never feed the outputs back as records — only primary, field-verified
   experience enters (this is how the loop avoids model collapse).
2. Records are provided **as-is, without warranty**. They describe what worked
   in one context; validate in yours.
3. Poisoned or wrong records are removed by re-releasing a new revision —
   pin a revision if you need reproducibility.

## Collection boundary

Records pass a fail-closed gate before export: outcome verified in the field,
active (not superseded), and an automatic scrub that excludes anything that
looks like secrets, emails, or machine-local paths.
`;
}

/** --out ディレクトリへ data/corpus.jsonl + README.md (dataset card) を書き出す。 */
export function writeHfExport(outDir, records, card) {
  mkdirSync(join(outDir, "data"), { recursive: true });
  const jsonl = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(join(outDir, "data", "corpus.jsonl"), records.length ? `${jsonl}\n` : "", "utf-8");
  writeFileSync(join(outDir, "README.md"), card, "utf-8");
}

// contentHash を再 export (呼び出し側が corpus.mjs を別 import しなくて済むように)
export { contentHash };
