// 収穫: git 履歴の fix 系 commit → failure 下書き (SPEC.md §4: 収穫は自動・採用は検証ゲートの先)。
// gamefork の apps/wheel-runner/src/lib/harvest.ts から可搬化した正本。
// 下書きは id を採番せず (failure-XXXX)、wheel ディレクトリには書かない。

export const GIT_LOG_FORMAT = "%x1e%H%x1f%ad%x1f%s%x1f%b%x1f";

/** git log (GIT_LOG_FORMAT + --name-only) の生出力を構造化する。 */
export function parseGitLog(raw) {
  const commits = [];
  for (const record of raw.split("\x1e")) {
    if (!record.trim()) continue;
    const parts = record.split("\x1f");
    if (parts.length < 5) continue;
    const [sha, date, subject, body, filesBlock] = parts;
    commits.push({
      sha: (sha ?? "").trim(),
      date: (date ?? "").trim(),
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
      files: (filesBlock ?? "")
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0),
    });
  }
  return commits;
}

const FIX_PATTERN = /\b(fix|bugfix|hotfix|revert|regression)\b|修正|復旧|事故|障害|不具合|再発/i;

/**
 * fix 系 commit を収穫候補として検出する。
 * 除外: 収穫済み sha (idempotency) / wheel の failures を自ら touch する commit
 * (エントリ同梱済み = 記録済み)。
 */
export function detectCandidates(commits, harvested, wheelDir = "docs/wheel") {
  // git のパスは常に / 区切りだが、wheelDir は Windows で path.join 由来の \ が
  // 来うる。区切りを正規化しないと除外が一致せず既記録 commit を再収穫する
  // (2026-07-10 監査指摘)。
  const normalizedWheelDir = wheelDir.replace(/\\/g, "/").replace(/\/$/, "");
  const failuresPrefix = `${normalizedWheelDir}/failures/`;
  const out = [];
  for (const commit of commits) {
    if (harvested.has(commit.sha)) continue;
    if (commit.files.some((f) => f.replace(/\\/g, "/").startsWith(failuresPrefix))) continue;
    const m = commit.subject.match(FIX_PATTERN);
    if (!m) continue;
    out.push({ commit, reason: `subject matches fix pattern: "${m[0]}"` });
  }
  return out;
}

export function stripConventionalPrefix(subject) {
  return subject.replace(/^[a-z]+(\([^)]*\))?[!]?:\s*/i, "").trim();
}

/**
 * 候補 commit より後の fix 系 commit が同じファイルに触れていないかを探す
 * (「問題→修正→結果」の 3 点目の機械ヒント)。
 *   - 見つかった → 最初の修正は効いていない可能性 (再修正が要った)
 *   - 見つからない → 収穫窓内では再修正なし = verified 候補
 * あくまでヒューリスティック — verified: を付ける判断は人間 (SPEC.md §3)。
 */
/** ISO 日時を epoch ms にする。parse 不能なら NaN。 */
function toEpoch(isoDate) {
  return Date.parse(isoDate);
}

export function findLaterRefix(candidate, commits) {
  const base = candidate.commit;
  const baseAt = toEpoch(base.date);
  for (const c of commits) {
    if (c.sha === base.sha) continue;
    // 文字列比較は UTC オフセットが異なる commit 間で時系列にならない
    // (2026-07-10 監査指摘) ため epoch で比較。parse 不能時は従来の文字列比較に退避。
    const cAt = toEpoch(c.date);
    const isLater = Number.isNaN(baseAt) || Number.isNaN(cAt) ? c.date > base.date : cAt > baseAt;
    if (!isLater) continue;
    if (!FIX_PATTERN.test(c.subject)) continue;
    if (!c.files.some((f) => base.files.includes(f))) continue;
    return { sha: c.sha, subject: c.subject };
  }
  return null;
}

export function suggestTags(files) {
  const tags = new Set();
  for (const f of files) {
    const segs = f.split("/");
    if (segs.length >= 2) tags.add(`${segs[0]}/${segs[1]}`);
    else if (segs[0]) tags.add(segs[0]);
    if (tags.size >= 4) break;
  }
  return [...tags];
}

/** failure 下書き Markdown (問題→修正→結果の骨組み + 抽出事実 + TODO)。 */
export function renderDraft(candidate, opts) {
  const { commit } = candidate;
  const title = stripConventionalPrefix(commit.subject);
  const tags = suggestTags(commit.files);
  const files = commit.files.map((f) => `- ${f}`).join("\n") || "- (no file info)";
  // 3 点目 (結果) の機械ヒント: 後続再修正の有無で verified 候補かを示す
  const result = opts.refix
    ? `POSSIBLY UNRESOLVED — a later fix commit touched the same files `
      + `(${opts.refix.sha.slice(0, 7)} "${opts.refix.subject}"). Investigate before setting verified:.`
    : opts.onMain
      ? "Merged to main (passed PR CI), no later re-fix in the harvest window — VERIFIED CANDIDATE. "
        + "Confirm the real-world outcome, then set verified: YYYY-MM-DD in the frontmatter."
      : "UNVERIFIED — confirm the fix actually worked, then record the outcome.";
  const body = commit.body ? `\nOriginal commit body:\n\n> ${commit.body.split("\n").join("\n> ")}\n` : "";

  return `<!-- WHEEL DRAFT (auto-harvested — NOT adoptable as-is)
  source commit: ${commit.sha}
  detected: ${candidate.reason}
  adoption steps:
    1. Verify the content and fill every TODO (a record without an outcome is not a lesson — SPEC.md §3)
    2. Assign the id: failure-YYYYMMDD-<slug> (YYYYMMDD = adoption date — no sequence lookup needed;
       set aliases to the same value — it resolves [[id]] links in Obsidian-style vaults)
    3. Move to <wheel>/failures/YYYYMMDD-<slug>.md and add one line to the wheel README index
    4. Re-run: open-wheel validate && open-wheel rules
-->
---
id: failure-YYYYMMDD-slug
aliases: [failure-YYYYMMDD-slug]
title: ${title}
summary: TODO: 1-2 sentences — what happened and how to prevent it (self-contained with the title)
status: active
tags: [${tags.join(", ")}]
created: ${commit.date.slice(0, 10)}
source: commit ${commit.sha.slice(0, 7)}
supersedes: null
superseded_by: null
verified: null
---

## Context

TODO: why this situation arose.
${body}
## Trigger

TODO: what set the problem off (the change, input, or event that fired it).

## Detection

TODO: the symptom as observed — error message, log line, or behavior an AI would
search for next time (searchers hold the symptom, not the cause).

## Failure

${title}

Files touched by the fix:

${files}

TODO: one paragraph on what exactly was broken (check the commit diff).

## Consequences

- Outcome: ${result}
- TODO: the lesson — what to check next time to avoid the same hole.
`;
}
