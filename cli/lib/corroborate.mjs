// corroborate: 独立ソース間で同じ根本原因が繰り返されている事実を検出する
// (design-0016)。
//
// 動機: 「同じトラブルを複数の独立した組織が別々に踏んでいる」という事実
// そのものが、単発の教訓より強い信号を持つ (優先度の裏付け・早期異常検知・
// 外部への交渉材料)。一方で、意味的な類似判定 (embedding/LLM) は
// zero-dep 原則 (SPEC.md、npx で即動く) と衝突するため、ここでは
// **決定論的な signature 抽出** (ベンダーのエラーコード等、既に一致するはずの
// 機械可読な識別子) に限定する。意味は理解しない — 一致するテキスト断片を
// 拾うだけの、精度優先で再現率は狙わない設計。
//
// signature が 2 つ以上の「独立ソース」(自分の wheel + pull した各ソース) に
// 現れたら "corroborated" (独立に裏付けられた) として報告する。

// 各 matcher は false positive を避けるため意図的に狭い。広げたくなったら
// 新しい matcher を足す (既存を緩めない — ノイズはこの機能の信頼性を壊す)。
const SIGNATURE_MATCHERS = [
  {
    // ベンダー/プラットフォームの数値エラーコード。例: "[code: 10074]" (CF Workers API)
    name: "vendor-code",
    pattern: /\[code:\s*(\d+)\]/gi,
    render: (m) => `code:${m[1]}`,
  },
  {
    // HTTP ステータス + 短い理由句。例: "429 Too Many Requests"
    name: "http-status",
    pattern: /\b([1-5]\d{2})\s+((?:[A-Z][a-zA-Z]*\s?){1,4})\b/g,
    render: (m) => `http:${m[1]}-${m[2].trim().toLowerCase().replace(/\s+/g, "-")}`,
  },
];

/** エントリ本文 (title+summary+body) から signature 文字列の集合を抽出する。 */
export function extractSignatures(text) {
  const found = new Set();
  for (const { pattern, render } of SIGNATURE_MATCHERS) {
    pattern.lastIndex = 0; // stateful /g regex を使い回すため毎回リセット
    let m;
    while ((m = pattern.exec(text)) !== null) {
      found.add(render(m));
    }
  }
  return [...found];
}

function entryText(entry) {
  return `${entry.title}\n${entry.summary}\n${entry.body}`;
}

/**
 * 1 ソース分のエントリ群から (signature, source, entry, contentKey) 行を作る。
 * sourceName: 自分の wheel なら "self"、pull した wheel ならその --name。
 * contentKey は「同じ wheel を名前だけ変えて 2 回登録」を独立ソースと数えない
 * ための同一内容判定キー (2026-07-10 監査指摘)。
 */
export function collectSignatures(sourceName, entries) {
  const rows = [];
  for (const entry of entries) {
    const text = entryText(entry);
    for (const signature of extractSignatures(text)) {
      rows.push({ signature, source: sourceName, entry, contentKey: text });
    }
  }
  return rows;
}

/**
 * 複数ソースの signature 行を突き合わせ、2 つ以上の**独立ソース**に現れる
 * signature だけを抽出する。
 * - 同一ソース内の複数エントリでの一致は corroboration ではない
 * - 別ソースでもエントリ内容が同一なら同一元 (複製) とみなし、独立に数えない:
 *   ソースは「他ソースで未出の内容を 1 つ以上持つ」場合のみ独立ソースに数える。
 */
export function groupCorroborated(allRows) {
  const bySig = new Map();
  for (const row of allRows) {
    if (!bySig.has(row.signature)) bySig.set(row.signature, []);
    bySig.get(row.signature).push(row);
  }
  const groups = [];
  for (const [signature, rows] of bySig) {
    const keysBySource = new Map();
    for (const r of rows) {
      if (!keysBySource.has(r.source)) keysBySource.set(r.source, new Set());
      keysBySource.get(r.source).add(r.contentKey ?? `${r.entry.id}\n${r.entry.title}`);
    }
    const seenKeys = new Set();
    const independentSources = [];
    // Map の挿入順 = 行の出現順 (self が常に先頭) を保持する
    for (const [source, keys] of keysBySource) {
      const fresh = [...keys].some((k) => !seenKeys.has(k));
      if (fresh) independentSources.push(source);
      for (const k of keys) seenKeys.add(k);
    }
    if (independentSources.length < 2) continue;
    groups.push({
      signature,
      sourceCount: independentSources.length,
      sources: independentSources,
      entries: rows.map((r) => ({ source: r.source, id: r.entry.id, title: r.entry.title, file: r.entry.file })),
    });
  }
  groups.sort((a, b) => b.sourceCount - a.sourceCount || a.signature.localeCompare(b.signature));
  return groups;
}
