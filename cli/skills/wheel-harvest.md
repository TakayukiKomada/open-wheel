---
description: Harvest failure-record drafts from fix commits, review them, and adopt the good ones into the wheel — one full cycle. Harvesting is automated; the adopt/discard decision goes through the verification gate (a human by default, or a trusted AI session where the team explicitly delegates adoption). Use at the end of a session or after merging a fix PR.
---

<!-- Portable /wheel-harvest skill for repositories using the Wheel convention
     (https://github.com/TakayukiKomada/open-wheel — see SPEC.md).
     Install: copy this file into your repo's .claude/commands/wheel-harvest.md
     and adjust the commands below if your wheel lives somewhere other than docs/wheel. -->

# /wheel-harvest — one harvest → review → adopt cycle

The wheel's rule: **harvest is automated, adoption is gated** (a human by
default; a team may explicitly delegate the gate to a trusted AI session).
This skill standardizes the adoption side so the loop actually runs.

## Steps

### 1. Baseline and harvest

```bash
git fetch origin main -q
npx open-wheel harvest
```

Drafts land in `.tmp/wheel-runs/<runId>/failure-draft-*.md`. Zero candidates →
report and stop. Already-harvested commits never reappear (state.jsonl).

### 2. Review each draft (assistant does the legwork)

For every draft:

1. Read `git show <sha> --stat` (and the diff if needed). Decide whether all
   three points can be filled honestly: **problem → fix → outcome**.
2. Grep the wheel for duplicates. If one exists, propose appending to its
   Consequences instead of creating a new entry.
3. Classify: **adopt / append / discard** (one-line reason for discards).

### 3. The adoption gate

Present the classification. By default, ask the user to confirm; if your team
has explicitly delegated adoption to the AI session, verify the gate conditions
(all three points grounded, no duplicate, secrets scrubbed) and proceed.
**Never write into the wheel before the gate passes.** All-discard → report
and stop.

### 4. Adoption work (drafts that passed the gate only)

1. Derive the next id from the canonical branch (never from memory or docs):
   ```bash
   git ls-tree origin/main --name-only docs/wheel/failures/ | tail -3
   ```
2. Fill every TODO. Add `paths:` globs if the lesson has a clear file trigger
   (push delivery).
3. Place as `docs/wheel/failures/NNNN-<slug>.md`, add one line to the wheel
   README index.
4. Regenerate and verify (do not commit until green):
   ```bash
   npx open-wheel validate
   npx open-wheel rules && npx open-wheel rules --check
   ```
5. Cite the source commit sha in the commit message.

## Rules of thumb

- Never guess the outcome field. No evidence → write "merged to main,
  real-world recurrence unverified" honestly.
- Don't force-adopt everything. Discarding a doubtful draft costs nothing —
  the harvest is designed that way.
