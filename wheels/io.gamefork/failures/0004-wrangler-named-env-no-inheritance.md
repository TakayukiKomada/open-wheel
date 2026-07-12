---
id: failure-0004
aliases: [failure-0004]
namespace: io.gamefork
title: Wrangler named environments inherit almost nothing, and `wrangler deploy` without --env updates a different worker than you think
summary: Wrangler named environments ([env.X]) do not inherit vars/bindings/migrations from the top level, and `wrangler deploy` without --env updates only the top-level worker while the env-routed worker keeps serving stale code. Redeclare everything per env and always deploy with an explicit --env.
status: active
tags: [cloudflare-workers, wrangler, deploy, env, bindings]
created: 2026-07-02
source: io.gamefork (promoted from a private wheel)
origin: Production incident on gamefork.io (2026-05-02): a deploy believed to be live was not; a stale worker handled real traffic and wrote unintended rows to the production DB. Root-caused and fixed; deploy scripts hardened.
stack: [cloudflare-workers, wrangler]
supersedes: null
superseded_by: null
verified: 2026-05-02
---

## Context

Wrangler supports named environments (`[env.beta]`, `[env.production]`) in
`wrangler.jsonc`/`wrangler.toml`. It is natural to assume an environment inherits the
top-level configuration and overrides selectively. It does not.

## Failure

Two distinct traps, hit in the same incident:

1. **No inheritance of bindings.** `vars`, `kv_namespaces`, `r2_buckets`, `d1_databases`,
   `durable_objects`, `services`, `queues` and friends are **not inherited** by named
   environments. Only a handful of keys (`main`, `compatibility_date`, `name` with
   auto-suffix, …) carry over. An env that "looks configured" can be missing every binding.

2. **`wrangler deploy` without `--env` deploys the *top-level* worker only.** Our routed
   domain was served by the `[env.beta]` worker (`myapp-beta`). Running plain
   `pnpm wrangler deploy` updated the top-level worker — which serves nothing — and
   reported success. The routed worker kept running the previous day's code. We believed
   the deploy was live; an external client then exercised the stale code path and created
   garbage rows in the production database.

Bonus trap: `wrangler kv namespace create` sometimes auto-inserts the new namespace into
the **top-level** `kv_namespaces` array even when you intended it for an env — always diff
your config file after running it.

## Consequences

1. When adding a named env, **re-declare every binding and var** the worker needs inside
   that env block. Assume zero inheritance for anything binding-like.
2. Fix the deploy command in `package.json` so `--env` cannot be forgotten:
   `"deploy": "wrangler deploy --env beta"` — never rely on humans (or AI agents)
   remembering the flag.
3. Verify before trusting: `wrangler deploy --env X --dry-run` to check binding resolution,
   and after deploy compare `wrangler versions list --env X` timestamps against your latest
   commit.
4. "The command exited 0" is not "the code is live on the domain you care about."
   Smoke-test the actual routed hostname after every deploy.
