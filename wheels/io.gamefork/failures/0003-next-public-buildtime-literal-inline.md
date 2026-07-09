---
id: failure-0003
namespace: io.gamefork
title: NEXT_PUBLIC_* env vars can be baked into the server bundle as literals — runtime config cannot override them
summary: Next.js (15+, SWC) can compile process.env.NEXT_PUBLIC_* into the server bundle as a string literal, so runtime vars and dashboard settings cannot override it. Set the values in the build environment and verify the deployed output, not the config.
status: active
tags: [nextjs, swc, env, cloudflare-workers, opennext, deploy]
created: 2026-07-02
source: io.gamefork (promoted from a private wheel)
origin: Pre-launch production incident on gamefork.io (2026-05-05): play links on production pointed at http://localhost:3001. Root-caused, fixed, and verified in production before launch.
stack: [nextjs-15, swc, opennext, cloudflare-workers]
supersedes: null
superseded_by: null
verified: 2026-05-05
---

## Context

Next.js promises that `NEXT_PUBLIC_*` variables are inlined into *client* bundles at build
time. What is less known: with Next.js 15 + SWC, expressions like

```ts
const PLAY_URL = process.env.NEXT_PUBLIC_PLAY_URL ?? 'http://localhost:3001';
```

can be inlined as **string literals into the *server* bundle too**, depending on how the
module uses them. Once inlined, no runtime configuration — `wrangler.jsonc` vars,
Cloudflare dashboard variables, any server env — can override the value.

## Failure

We built the production bundle without `.env.local`. The fallback literal
`http://localhost:3001` was compiled into the server bundle. Every "play" link on the
production site pointed at localhost; games were unlaunchable. Setting the variable in
`wrangler.jsonc` and the Cloudflare dashboard did nothing, because there was no runtime
lookup left to override.

The nastiest part: **the same syntactic pattern behaved differently in two files.**
One variable (`SITE_URL`) survived as a runtime `process.env` lookup and *could* be rescued
via wrangler vars; another (`PLAY_URL`), written the same way, was statically inlined.
Whether SWC inlines depends on module-level optimization details you cannot see in the
source. You cannot reason your way to safety by code inspection alone.

## Consequences

1. **Provide all `NEXT_PUBLIC_*` values at build time**, every build, via `.env.local` or
   shell env on the build command. Treat runtime overrides as unavailable for these.
2. Do not trust "it worked for variable X" as evidence variable Y behaves the same —
   inlining is case-by-case. Verify each one.
3. Add a post-deploy smoke check that greps the deployed HTML for leftovers:
   `curl -s https://your-site/<page> | grep -c localhost` should be `0`.
4. Setting the same keys in runtime config is harmless as a belt-and-suspenders for the
   variables that *did* stay runtime-lookups — but never rely on it.

General lesson: **build-time inlining silently converts configuration into code.** Any
deploy pipeline where the build environment differs from the runtime environment needs an
explicit check for which values got frozen at build time.
