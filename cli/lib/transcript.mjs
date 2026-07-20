// transcript: エージェントのセッションログ (JSONL) から「失敗→挑戦→成功」の
// 苦闘 arc を検出し、failure エントリの下書きを生成する (design-0024)。
//
// 位置づけ:
//   - git の fix commit 収穫 (harvest.mjs) が拾えるのは「成功した最終形」だけ。
//     何を試して何が失敗したかという過程はセッション transcript にしか残らない —
//     他のエージェントが同じ袋小路に入るのを防ぐのはこの過程の方。
//   - 出力は常に下書き (drafts only, never adopts)。採用は検証ゲートの先 (SPEC §4)。
//   - 解析は機械的ヒューリスティックのみ (LLM 蒸留は別ステップ)。誤検出は下書き段階の
//     検証で捨てられるので、取りこぼしより過剰検出に倒す。
//
// 対応フォーマット: 1 行 1 JSON の transcript (Claude Code の
// ~/.claude/projects/**/*.jsonl 形式が第一対象)。tool_use / tool_result の対応は
// tool_use_id で取り、is_error フラグを失敗シグナルとして使う。壊れた行・未知の行は
// 黙って読み飛ばす (フォーマット差異に寛容であることを優先)。

/** content 配列/文字列を素朴にテキスト化する。 */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "string" ? c : c?.text ?? ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * transcript JSONL → イベント列。
 * イベント: { kind: "tool_use"|"tool_result", tool, command, isError, text, ts }
 * (tool_result には対応する tool_use の tool / command を引き継がせる)
 */
export function parseTranscriptEvents(jsonlText) {
  const events = [];
  const useById = new Map(); // tool_use_id → { tool, command }
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 壊れた行は無視
    }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = rec.timestamp ?? null;
    for (const item of content) {
      if (item?.type === "tool_use") {
        const command = typeof item.input?.command === "string" ? item.input.command : null;
        const use = { tool: item.name ?? "unknown", command };
        if (item.id) useById.set(item.id, use);
        events.push({ kind: "tool_use", ...use, isError: false, text: "", ts });
      } else if (item?.type === "tool_result") {
        const use = useById.get(item.tool_use_id) ?? { tool: "unknown", command: null };
        events.push({
          kind: "tool_result",
          tool: use.tool,
          command: use.command,
          isError: item.is_error === true,
          text: flattenContent(item.content).slice(0, 2000),
          ts,
        });
      }
    }
  }
  return events;
}

/**
 * エラーのクラスタリング署名。同じ「試み」の再挑戦を束ねるためのキー:
 * コマンドがあれば正規化した先頭 2 トークン (パス・引数の揺れを吸収)、無ければ tool 名。
 */
export function eventSignature(event) {
  if (event.command) {
    const tokens = event.command.trim().split(/\s+/);
    const head = tokens.slice(0, 2).map((t) => t.split("/").pop());
    return `cmd:${head.join(" ")}`;
  }
  return `tool:${event.tool}`;
}

/**
 * 苦闘 arc の検出: 同一署名の失敗が minFailures 回以上続いた後に同一署名の成功が来たら
 * 1 arc とする。成功で署名のバッファはリセット (1 セッション複数 arc 可)。
 * 戻り値: [{ signature, attempts: [{command, error}], resolution: {command}, }]
 */
export function detectStruggleArcs(events, opts = {}) {
  const minFailures = opts.minFailures ?? 2;
  const failures = new Map(); // signature → attempts[]
  const ordinals = new Map(); // signature → 検出済み arc 数 (同一署名の n 個目の識別)
  const arcs = [];
  for (const e of events) {
    if (e.kind !== "tool_result") continue;
    const sig = eventSignature(e);
    if (e.isError) {
      const list = failures.get(sig) ?? [];
      list.push({ command: e.command ?? e.tool, error: e.text.split("\n").slice(0, 6).join("\n") });
      failures.set(sig, list);
    } else {
      const attempts = failures.get(sig) ?? [];
      if (attempts.length >= minFailures) {
        const ordinal = (ordinals.get(sig) ?? 0) + 1;
        ordinals.set(sig, ordinal);
        arcs.push({ signature: sig, ordinal, attempts, resolution: { command: e.command ?? e.tool } });
      }
      failures.delete(sig); // 成功したらその署名の失敗履歴はリセット
    }
  }
  return arcs;
}

/**
 * arc の state 冪等キー。ordinal (同一セッション内の同じ署名の何個目か) を含めないと、
 * 「同じ署名・同じ失敗回数」の後続 arc が既収穫扱いで落ちる (2026-07-10 監査指摘)。
 */
export function arcKey(sessionFile, arc) {
  return `${sessionFile}::${arc.signature}::${arc.attempts.length}::${arc.ordinal ?? 1}`;
}

/** 1 arc → failure 下書き markdown (harvest.mjs の下書きと同じ採用手順を踏ませる)。 */
export function renderTranscriptDraft(arc, meta = {}) {
  const date = meta.date ?? "TODO";
  const session = meta.sessionFile ?? "(unknown session)";
  const attempts = arc.attempts
    .map((a, i) => `### 試行 ${i + 1} (失敗)\n\n\`${a.command}\`\n\n\`\`\`\n${a.error}\n\`\`\``)
    .join("\n\n");
  return `<!-- WHEEL DRAFT (auto-harvested from session transcript — NOT adoptable as-is)
  source session: ${session}
  detected: ${arc.attempts.length} failed attempt(s) with signature "${arc.signature}" followed by success
  adoption steps:
    1. Rewrite as problem → fix → outcome; drop machine noise; a record without an outcome is not a lesson (SPEC.md §3)
    2. Assign the id: failure-YYYYMMDD-<slug> (YYYYMMDD = adoption date — no sequence lookup needed;
       set aliases to the same value — it resolves [[id]] links in Obsidian-style vaults)
    3. Move to <wheel>/failures/YYYYMMDD-<slug>.md and add one line to the wheel README index
    4. Re-run: open-wheel validate && open-wheel rules
-->
---
id: failure-YYYYMMDD-slug
aliases: [failure-YYYYMMDD-slug]
title: TODO: 何に何度も失敗し、最終的に何で解決したか (1 行)
summary: TODO: 1-2 sentences — the dead end and the way out, self-contained with the title
status: active
tags: [transcript-harvest]
created: ${date}
source: session transcript ${session}
supersedes: null
superseded_by: null
verified: null
---

## Context

TODO: このセッションで何をしようとしていたか。

## Trigger

TODO: 何が問題を発火させたか (どの操作・入力・変更が引き金になったか)。

## Detection

TODO: どの症状・エラー文・ログで判別できるか (次に検索する AI が持っているのは
原因ではなく症状 — 実際のエラー文をそのまま残す)。

## Failure

同じ試み (署名 \`${arc.signature}\`) が ${arc.attempts.length} 回失敗した:

${attempts}

## Consequences

最終的に成功した形: \`${arc.resolution.command}\`

TODO: なぜ最初の試行が失敗し、何を変えたら通ったのかを 1-3 行で。
結果 (実際に解決したか) を確認してから verified: を付ける。
`;
}
