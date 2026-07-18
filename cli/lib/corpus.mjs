// corpus: 検証済み (verified 付き = 問題→修正→結果の 3 点が揃った) エントリだけを
// 学習コーパス候補の manifest に集める。
//
// 位置づけ (design-0010 / design-0017 の docs 層版):
//   - 学習コーパスに入れてよいのは「結果が実地検証された一次データ」のみ。
//     verified の無いエントリは候補にすらしない (fail-closed)。
//   - manifest は本文を持たず file pointer + content_hash のみ。hash は
//     content-hash dedup (design-0008) と provenance 照合の入口になる。
//   - 実際の学習 (蒸留・fine-tune 等) はこの manifest を読む側の別ステップ。
//     ここは回収境界の「何が入ってよいか」だけを決める。
import { createHash } from "node:crypto";

/** エントリ本文の content hash (sha256)。dedup / provenance 照合キー。 */
export function contentHash(body) {
  return `sha256:${createHash("sha256").update(body, "utf-8").digest("hex")}`;
}

/**
 * verified 付きエントリを学習コーパス候補 manifest にする。
 * 既定は status: active のみ (superseded は現在の真実ではないため既定で除外。
 * includeSuperseded で opt-in)。
 */
export function buildCorpusManifest(entries, opts = {}) {
  const candidates = entries.filter(
    (e) => e.verified && (opts.includeSuperseded ? true : e.status === "active"),
  );
  const skippedUnverified = entries.filter((e) => !e.verified).length;
  return {
    spec: "open-wheel-corpus/v1",
    // 生成時刻は呼び出し側が渡す (テスト決定論のため Date.now を内部で呼ばない)
    generated_at: opts.generatedAt ?? null,
    count: candidates.length,
    skipped_unverified: skippedUnverified,
    entries: candidates.map((e) => ({
      id: e.id,
      kind: e.kind,
      file: e.file,
      title: e.title,
      summary: e.summary,
      tags: e.tags,
      created: e.created,
      verified: e.verified,
      source: e.source,
      observed_by: e.observed_by ?? null,
      content_hash: contentHash(e.body),
    })),
  };
}
