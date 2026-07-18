# Wheel Specification v0.1

*A git-native, tool-agnostic memory layer for AI agents.* (日本語は後半)

AI agents forget everything between sessions. Every day, agents worldwide
rediscover the same pitfalls their predecessors already solved. Wheel fixes
this with the simplest possible mechanism: **one decision = one Markdown
record**, kept in your repository, searchable and auto-surfaced.

## 1. Directory layout

```
docs/wheel/
  README.md          index of entries (human-maintained)
  design/NNNN-slug.md    design decisions (ADR-style: why we chose X)
  failures/NNNN-slug.md  failure records (what broke, how it was fixed)
  code/NNNN-slug.md      reusable code parts (paste/reference-ready)
```

IDs come in two forms. **New entries use the date form**: filename
`YYYYMMDD-slug.md`, id = prefix + basename (`failure-20260718-codex-cli-outdated`).
The date is the adoption date; date+slug never collides across concurrent
branches, so no sequence lookup is needed. The **legacy form** — per-directory
4-digit sequences (`design-0001`, filename `NNNN-slug.md`) — stays valid
forever: existing ids are permanent citation keys. Never renumber or rename;
supersede instead (§4). Parsers and citation scanners accept both forms.

## 2. Entry format

```markdown
---
id: failure-0001
aliases: [failure-0001]   # optional but recommended — same value as id; resolves [[id]] links in Obsidian-style vaults where filenames (NNNN-slug.md) differ from ids
title: Short statement of the decision / failure
summary: 1-2 sentences. Search layers read ONLY title + summary — make them self-contained.
status: active            # active | superseded | deprecated
tags: [rls, deploy]
paths: [supabase/migrations/**]   # optional — where this lesson auto-surfaces (§5)
created: 2026-07-01
source: commit abc1234 / PR #42 / path/to/file   # evidence; unverifiable entries erode trust
supersedes: null
superseded_by: null
published: null           # optional — global-layer id if promoted (§6)
observed_by: null         # optional — which AI agent/model this was observed from (e.g. codex-cli, claude-sonnet-5). Only fill in when the body has evidence; never guess.
verified: null            # optional — YYYY-MM-DD the fix's OUTCOME was confirmed for real (not just merged). Gates corpus entry (§3).
---

## Context
Why this situation arose.

## Decision (design) / Failure (failures) / Purpose (code)
What was decided / what broke.

## Consequences
What happened as a result; how to avoid or reuse it next time.
```

Body budget: a few hundred to ~1,500 tokens (hard cap: 6,000 characters —
`open-wheel validate` enforces it). If it grows, split it.

## 3. The grounding rule (the spine of the system)

**A failure record must contain all three: problem → fix → outcome.**
A record without a verified outcome ("did the fix actually work?") is not a
lesson — it must not enter any training or distillation corpus. This single
rule is what keeps a wheel from decaying into a pile of unverified notes,
and what prevents model-collapse when wheels feed learning loops
(only reality-grounded primary data goes in; distilled output never cycles back).

The `verified:` frontmatter date makes the third point machine-readable: set
it only when the outcome was confirmed for real (production behavior observed,
recurrence checked) — merge/CI-green alone does not count. `open-wheel corpus`
collects verified entries into a training-corpus candidate manifest (file
pointers + content hashes, no bodies); unverified entries never enter it.
The manifest is the collection boundary — whatever learns from the wheel
(distillation, fine-tuning, curation) reads the manifest, never the raw
directory, so the fail-closed gate has a single enforcement point.

## 4. Lifecycle

- Entries are never deleted. Obsolete entries get `status: superseded` and a
  `superseded_by` link (timestamps + replacement chains are how you notice rot).
- Cite entries in PR bodies / commit messages when they guided a decision
  (`following failure-0003, table-level REVOKE first`). Citation count is the
  proxy metric for whether the wheel is alive.
- Harvest is automated; **adoption goes through a verification gate.**
  Machines (deterministic heuristics) only draft (from fix commits, incident
  logs); the gate — a human by default, or a trusted AI session where the
  team explicitly delegates it — verifies the problem→fix→outcome triple,
  numbers, and commits. Drafts never claim IDs (`failure-XXXX` placeholder) —
  derive the next number from the canonical branch at adoption time.

## 5. Delivery: pull, browse, and push

- **Pull**: grep tags/keywords, or any search index built from the frontmatter.
- **Browse**: title + summary catalog (cheap enough to read whole at small scale).
- **Push** (the important one — you don't search for what you don't know):
  entries with `paths:` globs are compiled into path-scoped agent rules
  (e.g. `.claude/rules/wheel/<id>.md` for Claude Code) so the lesson
  auto-surfaces the moment an agent touches a matching file.
  Rules are generated, never hand-edited; the wheel entry is the single source.

## 6. Two layers: private and global

- **Private layer** (your repo): internal incidents, real commit hashes,
  stack-specific detail. Write freely.
- **Global layer** (a shared public repo, e.g. open-wheel): self-contained,
  generalized entries under a namespace (`io.yourteam/failure-0001`).
  Promotion checklist: fix deployed; no live attack surface exposed;
  internal references removed; `published:` recorded on the private original.
  Never split public/private by a frontmatter flag — physical repo separation
  prevents accidental disclosure. Global entries must not link to private ones.

## 7. Third layer: direct peer exchange (unvetted, at your own risk)

`pull <src>` accepts any git URL or local path — not only the official
global wheel. Two parties can exchange wheels directly (a private repo, a
personal collection, anything) without ever registering a namespace or
running through the global layer's promotion checklist (§6).

This is intentional, not an oversight: it is the low-friction "just trade
wheels with someone you trust" path. It carries **no vetting, no
self-containment check, no poisoning-removal guarantee** — those all belong
to the promote → global path (§6). If you `pull` from a peer, you are
trusting that peer directly, the same way you'd trust code someone hands
you outside any package registry. See [LICENSE](./LICENSE) for the full
disclaimer this project publishes about unvetted peer content.

## 8. Corroboration: the same trouble recurring is itself a signal

Multiple independent parties hitting the identical underlying problem is
information beyond any single lesson: it's evidence for **prioritization**
(a pitfall two teams tripped over deserves more urgency than one only you
hit), **early regression detection** (a signature suddenly appearing across
unrelated sources likely means an upstream tool just broke something), and
**leverage** ("N independent teams hit this" is a far stronger vendor bug
report than one team's isolated complaint).

Capturing this without breaking the zero-dependency principle rules out
semantic/embedding matching in the CLI itself. Instead, `corroborate` uses
**deterministic signature extraction** — narrow, high-precision regex
matchers (vendor error codes like `[code: 10074]`, HTTP status + reason)
pulled from entry text — and reports when the same signature appears across
2+ **independent sources** (your own wheel plus each `pull`-ed source).
This does not understand meaning; it only catches identical machine-readable
fragments, by design (false positives would make the report untrustworthy).
Multiple entries sharing a signature within the *same* source do not count —
only cross-source recurrence does.

## 9. CLI

```
npx open-wheel init                # scaffold docs/wheel/ in this repo
npx open-wheel validate            # enforce format contract + cross-links
npx open-wheel index               # emit wheel-index.json (for search layers)
npx open-wheel rules [--check]     # compile paths: → .claude/rules/wheel/
npx open-wheel harvest             # draft failure entries from fix commits
npx open-wheel pull <src>          # subscribe to a remote wheel (rules + index)
npx open-wheel promote <id> --to <global-checkout> --ns <namespace>
                                   # draft a private entry into the global layer
npx open-wheel corroborate         # find signatures 2+ independent sources share
npx open-wheel harvest-transcripts --transcripts <dir>
                                   # draft failure entries from session logs:
                                   # detects "struggle arcs" (same attempt failing
                                   # 2+ times, then succeeding). Dead ends live in
                                   # transcripts, not git. Drafts only, never adopts
npx open-wheel citations --suggest-verified [--min-age-days 14]
                                   # nudge: entries cited, never re-fixed, and aged
                                   # are verified candidates. Setting verified: requires
                                   # field observation — mechanical evidence alone is not enough
npx open-wheel citations --suggest-reverify
                                   # nudge: verified entries whose cited files were
                                   # later re-fixed. Never auto-demotes verified status.
npx open-wheel export-hf [--ns <namespace>] [--license <spdx>] [--out <dir>]
                                   # verified corpus -> Hugging Face dataset layout
                                   # (data/corpus.jsonl + dataset card). Run it
                                   # against a GLOBAL-layer checkout; a fail-closed
                                   # scrub excludes secret/email/local-path lookalikes.
                                   # Uploading to the Hub stays a human decision.
```

Cross-repo delivery:

- **Machine-wide push**: emit user-level rules so lessons surface in every
  repository on your machine —
  `open-wheel rules --out ~/.claude/rules/wheel --pointer <abs-path-or-URL>`
  (`--pointer` keeps the "full entry" link resolvable outside the source repo).
- **Subscribe**: `open-wheel pull <git-url-or-path>` fetches another wheel
  (yours or a global one) and compiles its `paths:` entries into local rules
  plus a searchable index (`.claude/wheel-pull/<name>.index.json`). This turns
  wheels into a distribution network: any repo can consume any published namespace.
- **Promote**: `open-wheel promote <id> --to <checkout> --ns <namespace>`
  mechanizes the private → global promotion (§6): places a numbered draft in
  your namespace, detects self-containment TODOs (commit hashes, internal
  cross-links, PR refs, URLs), and records `published:` on the private
  original. Generalizing the prose and the publish decision stay human —
  whether a live attack surface is exposed cannot be machine-judged.

---

# Wheel 仕様 v0.1 (日本語)

AI エージェントはセッションを跨ぐと全てを忘れ、世界中で同じ落とし穴を
再発見し続けている。Wheel はこれを最小の仕組みで直す:
**1 決定 = 1 Markdown レコード**をリポジトリに置き、検索可能・自動出現可能にする。

- **形式**: §2 の frontmatter + 本文。summary は必須 (検索層は title+summary
  しか読まない)。本文は数百〜千数百トークン、6,000 文字でハード上限。
- **接地の原則 (背骨)**: 失敗記録は「問題→修正→結果」の 3 点必須。
  結果 (実際に直ったか) の無い記録は学習コーパスに入れない。蒸留物は
  コーパスに戻さない (model collapse の構造的回避)。
- **ライフサイクル**: 削除せず supersede。従った/救われたら PR で id を引用
  (引用回数が生存の代理指標)。**収穫は自動・採用は検証ゲートの先** (既定は人間、
  チームの明示委譲で信頼済み AI セッションも可、§4) — 下書きは採番しない。
- **配信 3 経路**: pull (検索) / browse (カタログ) / push (`paths:` glob →
  path-scoped rules 自動生成。知らないことは検索しないため push が本命)。
- **2 層モデル**: private 層 (自リポジトリ、生々しく書く) と global 層
  (公開リポジトリ、namespace 付き汎用エントリ)。分離は物理リポジトリで行い、
  frontmatter フラグでは行わない (事故公開の温床)。
- **corroboration (裏付け検出)**: 複数の独立ソースが同じトラブルを別々に
  報告している事実そのものが信号になる (優先度の裏付け・早期異常検知・
  外部への交渉材料)。zero-dep 原則を守るため意味理解はせず、ベンダーの
  エラーコード等の決定論的 signature が 2 つ以上の独立ソースに現れた場合のみ
  報告する (`open-wheel corroborate`)。
