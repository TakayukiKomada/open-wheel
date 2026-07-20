// promote: private 層 (チーム内 wheel) のエントリを global 層 (全世界共有 wheel) へ
// 昇格させる下書きを作る (SPEC.md §6)。
//
// CLI が担うのは機械的な部分のみ:
//   - global 側の namespace ディレクトリに次番号で下書きを配置
//   - origin (来歴の平文) / stack (どのスタックに効くか、TODO) を frontmatter に追加
//   - 自己完結性を壊す内部参照 (commit hash / migration 番号 / PR 番号 / 内部 URL /
//     [[id]] クロスリンク) を検出して TODO 一覧としてヘッダに残す
//   - 昇格元エントリの frontmatter に published: を記録
// 汎用化の文章の練り直しと最終判断は人間 (昇格ゲート — 攻撃面の非公開等は機械判定不能)。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ID_TAIL_SOURCE, KINDS } from "./entry.mjs";

// [[id]] クロスリンク検出 (KINDS + entry.mjs のパターンから導出 —
// 従来のハードコードは mechanic/prompt が抜けており日付形式も拾えなかった)
const CROSSLINK_RE = new RegExp(
  `\\[\\[(?:${KINDS.map((k) => k.kind).join("|")})-${ID_TAIL_SOURCE}\\]\\]`,
  "g",
);

// namespace は reverse-DNS 形 (例 io.gamefork)。パス区切りや .. を含む値を
// ディレクトリ名として join すると globalRoot の外へ書き出せてしまう
// (2026-07-10 監査指摘のパストラバーサル) ため、形式で先に弾く。
export const NAMESPACE_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

/** 自己完結性を壊しうる内部参照を列挙する (誤検出は許容 — 人間が消し込む TODO)。 */
export function findInternalReferences(body) {
  const found = new Set();
  for (const m of body.matchAll(/\b[0-9a-f]{7,40}\b/g)) found.add(`commit っぽい hash: ${m[0]}`);
  for (const m of body.matchAll(/migrations?\/?\s*\d{3}/gi)) found.add(`migration 番号参照: ${m[0].trim()}`);
  for (const m of body.matchAll(/#\d{2,5}\b/g)) found.add(`PR/issue 参照: ${m[0]}`);
  for (const m of body.matchAll(CROSSLINK_RE)) found.add(`private クロスリンク: ${m[0]}`);
  for (const m of body.matchAll(/https?:\/\/[^\s)]+/g)) found.add(`URL (公開到達可能か確認): ${m[0]}`);
  return [...found];
}

/** global 側 namespace ディレクトリの既存最大番号 +1 を導出する。 */
export function nextGlobalNumber(nsDir) {
  let max = 0;
  if (existsSync(nsDir)) {
    for (const f of readdirSync(nsDir)) {
      const m = f.match(/^(\d{4})-/);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(4, "0");
}

/** 昇格下書きの Markdown を生成する。 */
export function renderPromotionDraft(entry, opts) {
  const { namespace, globalId, today } = opts;
  const internal = findInternalReferences(entry.body);
  const todoList = internal.length
    ? internal.map((r) => `    - ${r}`).join("\n")
    : "    - (自動検出なし — それでも内部文脈が残っていないか通読すること)";

  return `<!-- PROMOTION DRAFT (private → global、このままでは公開不可)
  昇格元: ${entry.file} (${entry.id})
  公開前チェックリスト (SPEC.md §6):
    1. 修正が本番反映済みで、現役の攻撃面を公開しないことを確認する
    2. 下記の内部参照を除去し、自己完結に書き直す:
${todoList}
    3. stack: を埋める (どのスタック/環境でこの教訓が効くか)
    4. 昇格元エントリに published: ${namespace}/${globalId} が記録済みであることを確認する
       (このツールが自動追記済み — 昇格元リポジトリ側の commit を忘れない)
    5. verified: は昇格元の日付をそのまま引き継いだだけ (下は書き直していない)。
       汎用化した本文でもその日付の確認内容が成立しているか読み直すこと。
       null のままなら export-hf の対象に入らない (SPEC.md §3、意図的)
-->
---
id: ${globalId}
namespace: ${namespace}
title: ${entry.title}
summary: ${entry.summary}
status: active
tags: [${entry.tags.join(", ")}]
created: ${today}
source: ${namespace} (promoted from a private wheel)
origin: TODO: 来歴を平文で書く (例: "Production incident, fixed and verified")
stack: TODO: このエントリが効くスタック (例: "Cloudflare Workers + wrangler")
supersedes: null
superseded_by: null
observed_by: ${entry.observed_by ?? "null"}
verified: ${entry.verified ?? "null"}
---

${entry.body}
`;
}

/**
 * 昇格元エントリの frontmatter に published: を追記した本文を返す。
 * - published 行が無い → superseded_by の直後に追記
 * - published: null (未公開のプレースホルダ) → 実値へ置換 (null を「公開済み」と
 *   誤判定して global 側だけ増殖する監査指摘バグの修正)
 * - published: に実値あり → null (既公開、変更しない)
 */
export function markPublished(markdown, publishedId) {
  const m = markdown.match(/^published:\s*(.*)$/m);
  if (m) {
    const value = m[1].split(" #")[0].trim();
    if (value && value !== "null") return null; // 実値あり = 既公開
    return markdown.replace(/^published:\s*.*$/m, `published: ${publishedId}`);
  }
  return markdown.replace(/\nsuperseded_by:([^\n]*)\n/, `\nsuperseded_by:$1\npublished: ${publishedId}\n`);
}

/**
 * promote 本体。global 側に下書きを書き、private 側に published: を追記する。
 * 冪等: 昇格元に published: の実値が既にあれば global 側には何も書かない
 * (再実行のたびに同内容の次番号が増殖する監査指摘バグの修正)。
 * 戻り値: { draftPath, publishedId, internalRefCount, alreadyPublished }
 */
export function promoteEntry(entry, privateEntryPath, opts) {
  const { globalRoot, namespace, today } = opts;
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(`promote: namespace must be reverse-DNS shaped (e.g. io.example): ${namespace}`);
  }
  if (entry.published) {
    return {
      draftPath: null,
      publishedId: entry.published,
      internalRefCount: findInternalReferences(entry.body).length,
      alreadyPublished: true,
    };
  }
  // KINDS が正本 (mechanic → mechanics / prompt → prompts。単数形ディレクトリに
  // 出力してしまう監査指摘バグの修正)
  const kindDir = KINDS.find((k) => k.kind === entry.kind)?.dir ?? entry.kind;
  const nsDir = join(globalRoot, namespace, kindDir);
  // 念のため解決後パスの封じ込めも確認 (パターン検証の防御二重化)
  if (!resolve(nsDir).startsWith(resolve(globalRoot) + sep)) {
    throw new Error(`promote: refusing to write outside global root: ${nsDir}`);
  }
  // 日付形式のエントリは id (日付+slug) をそのまま global id / ファイル名に引き継ぐ
  // (日付+slug は namespace 内で衝突しないため global 側の採番が不要)。
  // 連番形式は従来通り global 側の独立採番 (private と global の連番は無関係)。
  const dateFile = entry.file.match(/\/(\d{8}-[a-z0-9-]+)\.md$/);
  let globalId;
  let fileBase;
  if (dateFile) {
    globalId = entry.id;
    fileBase = dateFile[1];
  } else {
    const num = nextGlobalNumber(nsDir);
    globalId = `${entry.kind}-${num}`;
    const slug = entry.file.replace(/^.*\/\d{4}-/, "").replace(/\.md$/, "");
    fileBase = `${num}-${slug}`;
  }

  mkdirSync(nsDir, { recursive: true });
  const draftPath = join(nsDir, `${fileBase}.md`);
  if (existsSync(draftPath)) throw new Error(`promote: already exists: ${draftPath}`);
  writeFileSync(draftPath, renderPromotionDraft(entry, { namespace, globalId, today }), "utf-8");

  const original = readFileSync(privateEntryPath, "utf-8");
  const marked = markPublished(original, `${namespace}/${globalId}`);
  if (marked) writeFileSync(privateEntryPath, marked, "utf-8");

  return {
    draftPath,
    publishedId: `${namespace}/${globalId}`,
    internalRefCount: findInternalReferences(entry.body).length,
    alreadyPublished: false,
  };
}
