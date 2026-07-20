// init: リポジトリに wheel ディレクトリと最初のエントリを作る (SPEC.md §1)。
// 最初の design エントリは「Wheel を採用した」という記録そのもの —
// 採用の瞬間から 1 決定 = 1 レコードの実例が存在する状態で始める。
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const WHEEL_README = `# Wheel — grounded memory for this repository's AI agents

One decision = one Markdown record. Format and rules: see the Wheel spec
(https://github.com/TakayukiKomada/open-wheel — SPEC.md).

- \`design/\` — design decisions (why we chose X)
- \`failures/\` — failure records (problem → fix → outcome, all three required)
- \`code/\` — reusable code parts

Workflow:

1. Add \`NNNN-slug.md\` (max existing number + 1). \`summary\` is mandatory.
2. Cite entry ids in PRs/commits when they guide a decision.
3. Entries with \`paths:\` auto-surface via \`open-wheel rules\`.
4. Verify with \`open-wheel validate\` (wire it into CI).
5. Draft new failure entries from fix commits with \`open-wheel harvest\`
   (drafts land outside the wheel; a human verifies, numbers, and commits).

## Entries

**Design**
- [0001](design/0001-adopt-wheel.md) adopt Wheel as the agent memory layer

**Failures**

(none yet)

**Code**

(none yet)
`;

function firstEntry(date) {
  return `---
id: design-0001
aliases: [design-0001]
title: Adopt Wheel as the agent memory layer for this repository
summary: Design decisions, failure records, and reusable code parts are kept as one-record-per-decision Markdown under this directory, searchable and auto-surfaced to AI agents.
status: active
tags: [wheel, meta]
created: ${date}
source: open-wheel init
supersedes: null
superseded_by: null
---

## Context

AI agents working on this repository forget everything between sessions and
re-discover the same pitfalls. We need a memory layer that is reviewable,
greppable, and versioned with the code.

## Decision

Adopt the Wheel convention (see SPEC.md in the open-wheel repository):
one decision = one Markdown record, failure records must contain
problem → fix → outcome, harvest is automated and adoption goes through
a verification gate (human or a trusted AI session — each team picks).

## Consequences

- New lessons land here first; path-scoped agent rules are generated from
  \`paths:\` frontmatter, so lessons auto-surface when matching files are touched.
- \`open-wheel validate\` runs in CI to keep the format contract honest.
`;
}

/** wheel ディレクトリを scaffold する。既存ファイルは上書きしない。 */
export function scaffoldWheel(wheelRootDir, date) {
  const created = [];
  for (const dir of ["design", "failures", "code"]) {
    mkdirSync(join(wheelRootDir, dir), { recursive: true });
  }
  const readmePath = join(wheelRootDir, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, WHEEL_README, "utf-8");
    created.push(readmePath);
  }
  const entryPath = join(wheelRootDir, "design", "0001-adopt-wheel.md");
  if (!existsSync(entryPath)) {
    writeFileSync(entryPath, firstEntry(date), "utf-8");
    created.push(entryPath);
  }
  return created;
}
