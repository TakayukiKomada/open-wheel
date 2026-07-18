# open-wheel

**Your AI agents forget everything between sessions. Wheel is the cure** —
a git-native, tool-agnostic memory layer: design decisions, failure records,
and reusable code parts, one Markdown record per decision, searchable and
auto-surfaced the moment an agent touches a related file.

Zero dependencies. Works solo from day one — no network effect required.

```bash
npx open-wheel init        # scaffold docs/wheel/ (+ your first entry)
npx open-wheel validate    # format contract + cross-links (wire into CI)
npx open-wheel rules       # paths: globs -> .claude/rules/wheel/ (push delivery)
npx open-wheel harvest     # draft failure entries from your fix commits
npx open-wheel citations --suggest-reverify  # nudge re-verification after a later refix
npx open-wheel index       # JSON index for search layers
npx open-wheel pull <src>  # subscribe to someone else's wheel (rules + index)
npx open-wheel promote <id> --to <global-checkout> --ns <your.namespace>
                           # lift a team lesson into the world-shared layer
npx open-wheel corroborate # find signatures 2+ independent sources both hit
```

Your lessons don't have to stay in one repo: emit machine-wide rules with
`rules --out ~/.claude/rules/wheel --pointer <URL>`, or `pull` any published
wheel into any project.

## Why this works

1. **Grounding rule**: a failure record must contain problem → fix → outcome.
   No verified outcome, no entry. This is what keeps a wheel from decaying
   into a pile of notes (and what keeps learning loops collapse-free).
2. **Push, not just pull**: you don't search for what you don't know.
   Entries with `paths:` globs are compiled into path-scoped agent rules, so
   the lesson from last month's deploy incident appears automatically when
   anyone (human or AI) opens the deploy config again.
3. **Harvest is automated, adoption is gated**: `harvest` drafts entries from
   fix commits (with the incident story pulled from the commit body), but the
   verification gate — a human by default, or a trusted AI session where the
   team explicitly delegates it — verifies, numbers, and commits. Bad drafts
   cost nothing.
4. **Corroboration**: the same trouble recurring across independent teams is
   itself a signal worth surfacing — `corroborate` finds vendor error codes
   and similar deterministic signatures shared by 2+ independent sources
   (your wheel + anything you've `pull`-ed), without needing embeddings.

Full format and rules: [SPEC.md](./SPEC.md).

## Peer exchange is unvetted — read this before you `pull`

`pull` accepts any git URL or local path, not just the official global wheel.
That is deliberate (see SPEC.md §6 and §8) — but it means content you pull
from a peer, a stranger, or any non-official source is **not scanned, vetted,
or endorsed by this project**. `pull`/`promote` never execute code — they
only read/write Markdown and JSON — but the text they surface still becomes
"advice" an AI agent reads and may act on (prompt injection risk). Evaluate
your sources. See [LICENSE](./LICENSE) for the full disclaimer.

## Claude Code skill

Copy [skills/wheel-harvest.md](./skills/wheel-harvest.md) into your repo's
`.claude/commands/` to get `/wheel-harvest` — one command that harvests drafts
from your fix commits, reviews them against the grounding rule, and walks the
adoption (with the human gate intact).

## Provenance

Extracted from the production Wheel of [GameFork](https://gamefork.io)
(27+ entries, MCP search tool, CI-verified sync, physical-AI design track).
This package is the portable reference implementation of that convention.

日本語: 仕様は [SPEC.md](./SPEC.md) 後半に日本語版があります。
