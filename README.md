# Open Wheel

**Don't reinvent the wheel — and don't re-step on the same landmine.**

Open Wheel is a shared, structured registry of engineering **failures**, **design decisions**,
and **reusable parts**, written for both humans and AI coding agents. One record = one lesson,
with provenance, lifecycle metadata, and machine-friendly structure.

Every entry here was verified against a real codebase or a real production incident before
being published. That is the bar: **no entry without provenance.**

## Why this exists

Teams (and AI agents) keep paying for knowledge they already bought:

- The same production pitfall gets hit by the next engineer, the next AI session, the next team.
- Design decisions get re-litigated because nobody wrote down *why* the rejected option was rejected.
- Utility code gets re-implemented because nobody knew it already existed.

Existing tools don't quite cover this. `AGENTS.md` / `CLAUDE.md` / Cursor rules pass *procedures
and context* to agents. ADR tools record decisions but rarely failures, and rarely in a form
agents actually retrieve. Blog posts have the stories but no structure, lifecycle, or
machine-readability. Open Wheel is the missing layer: **durable, structured, citable
"why"-knowledge, shared across repos, teams, and agents.**

## Structure

```
wheels/
  <namespace>/            reverse-DNS namespace, one per team/project (e.g. io.gamefork)
    failures/             things that actually went wrong, and how to avoid them
      0001-slug.md
    design/               decisions and the reasoning behind them (ADR-style)
    code/                 reusable parts, with canonical-source pointers
scripts/
  verify-wheel.mjs        CI check: frontmatter, numbering, index and link integrity
```

A full entry id is `<namespace>/<type>-<NNNN>`, e.g. `io.gamefork/failure-0003`.
Cite it in commit messages and PRs when an entry saved you: citations are how we measure
whether this registry actually works.

## Entry format

```markdown
---
id: failure-0001            # <type>-<NNNN>, 4-digit, sequential per directory
namespace: io.gamefork      # must match the directory
title: One-line statement of the lesson
status: active              # active | superseded | deprecated
tags: [postgres, rls]       # lowercase, for grep/search
created: 2026-07-02
origin: Production incident on gamefork.io (May 2026); fix verified in production.
stack: [postgresql, supabase]   # what this applies to
supersedes: null            # id this entry replaced, if any
superseded_by: null         # id that replaced this entry, if any
---

## Context
Why this situation existed.

## Failure           (for failures/)  — or  ## Decision  (for design/)
What actually happened, with enough detail to recognize it in your own project.

## Consequences
The fix, the correct pattern, and how to avoid it next time.
```

Entries must be **self-contained**: no links to private repositories, no internal ticket ids,
no company-internal context required to understand the lesson. `origin` states provenance in
plain words instead.

Stale entries are never deleted: set `status: superseded` and link the replacement via
`superseded_by`. A registry that silently rots loses trust; one that shows its lifecycle keeps it.

## Using it with AI agents

Point your agent instructions (`AGENTS.md`, `CLAUDE.md`, system prompt) at this repo and add
one norm: *"Before touching migrations / deploy config / <your risk area>, grep the relevant
`wheels/<ns>/failures/` tags. When an entry guides a change, cite its id in the commit."*
Recall is everything — an unreferenced registry is a graveyard.

## Contributing your namespace

Teams contribute lessons under their own reverse-DNS namespace via PR — see
[CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Create `wheels/<your-reverse-dns>/failures/0001-your-lesson.md` following the format above.
2. Self-containment and provenance are hard requirements. Failures must be **fixed and
   verified** before publishing (don't publish your live attack surface).
3. Run `node scripts/verify-wheel.mjs` — CI enforces it.

## Current wheels

- **[io.gamefork](wheels/io.gamefork/)** — lessons from operating an AI-first game-sharing
  platform on Cloudflare Workers + Supabase + Next.js (6 failures published, more incoming).

## 日本語概要

Open Wheel は、エンジニアリングの**失敗**・**設計判断**・**再利用部品**を、人間と AI
エージェントの両方が検索・引用できる構造化レコード (1 レコード = 1 教訓) として蓄積する
共有レジストリです。すべてのエントリは実際のコードベース・本番インシデントによる裏取りを
公開の条件とし、チームごとに逆 DNS 名前空間 (`io.gamefork` 等) を持って PR で追加できます。
陳腐化したエントリは削除せず `superseded_by` で置換先にリンクします。詳しい参加方法は
[CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## License

Content: [CC BY 4.0](LICENSE.md). Code snippets inside entries and `scripts/`: MIT.
