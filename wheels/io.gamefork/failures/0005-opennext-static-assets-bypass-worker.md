---
id: failure-0005
aliases: [failure-0005]
namespace: io.gamefork
title: On OpenNext + Cloudflare Workers, static assets are served before your Worker — headers() and _headers are silently ignored
summary: On OpenNext + Cloudflare Workers, static assets are served by the ASSETS binding before your Worker runs, so Next.js headers(), public/_headers, and Worker shims are silently ignored for those paths. Only assets.run_worker_first globs in wrangler config route matching requests through the Worker.
status: active
tags: [cloudflare-workers, opennext, nextjs, static-assets, cors, headers]
created: 2026-07-02
source: io.gamefork (promoted from a private wheel)
origin: Four consecutive failed production fixes on gamefork.games (2026-05-06) before root cause; the fifth attempt (run_worker_first) resolved it and was verified in production with curl.
stack: [cloudflare-workers, opennext, nextjs, wrangler]
supersedes: null
superseded_by: null
verified: 2026-05-06
---

## Context

We needed CORS headers on `.wasm` files served as static assets (a WebAssembly runtime
fetched from a sandboxed, null-origin iframe). On a normal Next.js host you add a
`headers()` entry in `next.config` and move on.

## Failure

On Cloudflare Workers with Static Assets, the `ASSETS` binding serves matching files
**before your Worker code runs**. Anything that relies on the Worker (or on Next.js)
seeing the request never executes for those paths. We burned four production deploys
learning this, each attempt plausible and each silently ignored:

| attempt | approach | result |
| --- | --- | --- |
| 1 | `headers()` in `next.config` | never consulted for static assets |
| 2 | `public/_headers` file | bundled by OpenNext, ignored by ASSETS |
| 3 | custom `worker.js` shim intercepting the path | asset served before Worker runs |
| 4 | shim variation | same |
| 5 | `assets.run_worker_first` glob in wrangler config | **worked** |

The cruelest property: **everything works in `next dev`**, where Next.js itself serves the
files and `headers()` applies. Dev success proves nothing about this failure mode.

## Consequences

The fix is a two-part contract — both parts required:

```jsonc
// wrangler.jsonc — route ONLY the paths that need headers through the Worker
"assets": {
  "directory": ".open-next/assets",
  "binding": "ASSETS",
  "run_worker_first": ["/runtime/*.wasm"]
}
```

```javascript
// worker.js — wrap ASSETS.fetch for those paths and attach headers
if (url.pathname.startsWith('/runtime/') && url.pathname.endsWith('.wasm')) {
  const response = await env.ASSETS.fetch(request);
  return withCors(response); // rebuild Response with the extra headers
}
```

Rules:

1. List only the globs that need Worker processing — routing *all* assets through the
   Worker forfeits Cloudflare's fast static serving.
2. Named environments need the `assets` block re-declared per env ([[failure-0004]]).
3. Verify on production, not dev: `curl -sI https://your-site/runtime/x.wasm` and check
   the header is present. **Dev success ≠ production success** for anything involving
   the static-asset pipeline.
