// citations: 「どのエントリを選んだか」と「選んで正解だったか」の機械集計。
//
// 引用ルール (SPEC.md §4: エントリに従ったら commit message で id を引用する) を
// git 履歴から集計し、選択の成否を後続再修正の有無で近似する:
//   - clean   = 引用 commit のファイルがその後 fix 系 commit で再修正されていない
//               → 選んで正解だった可能性が高い
//   - refixed = 再修正された → エントリの導きが外れた可能性 (要精査)
//
// 矛盾する 2 エントリの判定 (README §判定フロー) で「選ばれて clean が多い方」を
// 優先根拠にできる。ただしこれは相関シグナルであって証明ではない — refix は引用と
// 無関係な理由でも起きる。N が小さいうちは verified / 根拠の強さを優先する。
import { findLaterRefix } from "./harvest.mjs";
import { ID_TAIL_SOURCE, KINDS } from "./entry.mjs";

/** commit message 中の Wheel id (全種別・日付/連番の両形式)。パターンは entry.mjs が正本。 */
export const WHEEL_ID_RE = new RegExp(
  `\\b(?:${KINDS.map((k) => k.kind).join("|")})-${ID_TAIL_SOURCE}\\b`,
  "g",
);

// id の kind → 正本ディレクトリ名
const KIND_DIRS = {
  design: "design",
  failure: "failures",
  code: "code",
  mechanic: "mechanics",
  prompt: "prompts",
};

/** commit (subject + body) から引用された id を重複なしで抽出する。 */
export function extractCitedIds(commit) {
  const text = `${commit.subject}\n${commit.body}`;
  return [...new Set(text.match(WHEEL_ID_RE) ?? [])];
}

/**
 * その commit が id の正本ファイル自体を触っているか。
 * エントリの新規作成・編集 commit は「エントリを選んだ」実績ではないので集計から除く
 * (採用 commit が自動的に自分へ 1 票入れるのを防ぐ)。
 */
export function touchesEntryFile(commit, id) {
  // prefix は前方一致で分解する (lastIndexOf("-") は日付形式 failure-20260718-slug の
  // slug 側の区切りを拾って破綻する)
  const m = id.match(/^([a-z]+)-(.+)$/);
  const dir = m ? KIND_DIRS[m[1]] : undefined;
  if (!dir) return false;
  const tail = m[2];
  // 連番形式: ファイル名は NNNN-slug.md なので `NNNN-` 前方一致。
  // 日付形式: id = prefix + basename なので `YYYYMMDD-slug.md` 完全一致
  const needle = /^\d{4}$/.test(tail) ? `${dir}/${tail}-` : `${dir}/${tail}.md`;
  return commit.files.some((f) => f.includes(`/${needle}`) || f.startsWith(needle));
}

/**
 * 成否判定から除外する「共有ホットスポット」ファイルの既定判定。
 * 引用ルール (引用 commit は wheel エントリ/README を同梱する) のせいで、wheel 基盤
 * ファイルはほぼ全ての wheel 系 commit で重なり、後続 fix との交差が「導きが外れた」
 * 証拠にならない (偽 refixed の主因)。判定は実装/コードファイルの重なりだけで行う。
 */
export function defaultNoiseFilter(wheelDir = "docs/wheel") {
  const wd = wheelDir.replace(/\/$/, "");
  return (f) =>
    f.startsWith(`${wd}/`) ||
    f.includes("wheel-index.generated") ||
    f.startsWith(".claude/rules/") ||
    /(^|\/)(AGENTS|CLAUDE|README)\.md$/.test(f);
}

/**
 * verified 自動スタンプの「提案」(design-0024): 未 verified の active エントリのうち、
 * 引用実績が全て clean で、最新の引用 commit から minAgeDays 以上再修正が無いものを
 * verified 候補として提示する。付与は常に人間 — これは機械的証拠からのナッジであって、
 * 「本番挙動の観測」(SPEC.md §3) の代替ではない。
 * opts.nowMs は必須 (テスト決定論のため内部で Date.now を呼ばない)。
 */
export function suggestVerified(tally, entries, opts = {}) {
  const minAgeDays = opts.minAgeDays ?? 14;
  const nowMs = opts.nowMs;
  if (typeof nowMs !== "number") throw new Error("suggestVerified: opts.nowMs is required");
  const suggestions = [];
  for (const e of entries) {
    if (e.verified || e.status !== "active") continue;
    const t = tally.get(e.id);
    if (!t || t.citations === 0 || t.refixed > 0) continue;
    const latest = t.cites.reduce((best, c) => (c.date > best.date ? c : best), t.cites[0]);
    const ageDays = Math.floor((nowMs - Date.parse(latest.date)) / 86_400_000);
    if (ageDays < minAgeDays) continue;
    suggestions.push({ id: e.id, citations: t.citations, ageDays, latestCite: { sha: latest.sha, date: latest.date } });
  }
  return suggestions;
}

/**
 * verified 済みなのに、引用後の後続再修正が発生したエントリを
 * 再検証候補として提示する (design-0024)。
 *
 * refix は引用と無関係な理由でも起きうる相関シグナルなので、verified の
 * 自動解除や status の変更は行わない。候補提示だけを担う。
 */
export function suggestReverify(tally, entries) {
  const suggestions = [];
  for (const e of entries) {
    if (!e.verified || e.status !== "active") continue;
    const t = tally.get(e.id);
    if (!t || t.refixed === 0) continue;
    const refixes = t.cites
      .filter((c) => c.refix_sha)
      .map((c) => ({ citeSha: c.sha, citeDate: c.date, refixSha: c.refix_sha }));
    if (refixes.length === 0) continue;
    suggestions.push({
      id: e.id,
      verified: e.verified,
      citations: t.citations,
      refixed: t.refixed,
      refixes,
    });
  }
  return suggestions;
}

/**
 * 引用実績を id ごとに集計する。
 * 返り値: Map<id, {citations, clean, refixed, cites: [{sha, date, clean, refix_sha?}]}>
 * opts.isNoise: 成否判定の重なり比較から外すファイル判定 (既定 = defaultNoiseFilter())。
 */
export function tallyCitations(commits, opts = {}) {
  const isNoise = opts.isNoise ?? defaultNoiseFilter();
  const tally = new Map();
  for (const commit of commits) {
    const ids = extractCitedIds(commit);
    if (ids.length === 0) continue;
    // 成否判定は commit 単位で 1 回 (同一 commit 内の全引用が同じ結果を共有する)。
    // noise ファイルを引用側から除くと、交差判定からも自動的に消える。
    const substantive = { ...commit, files: commit.files.filter((f) => !isNoise(f)) };
    const refix = findLaterRefix({ commit: substantive }, commits);
    for (const id of ids) {
      if (touchesEntryFile(commit, id)) continue;
      let t = tally.get(id);
      if (!t) tally.set(id, (t = { citations: 0, clean: 0, refixed: 0, cites: [] }));
      t.citations += 1;
      if (refix) t.refixed += 1;
      else t.clean += 1;
      t.cites.push({
        sha: commit.sha,
        date: commit.date,
        clean: !refix,
        ...(refix ? { refix_sha: refix.sha } : {}),
      });
    }
  }
  return tally;
}
