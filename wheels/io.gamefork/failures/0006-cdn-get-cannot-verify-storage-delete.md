---
id: failure-0006
namespace: io.gamefork
title: You cannot verify object-storage deletion by GETting the public URL — CDN cache keeps serving 200 after a successful delete
status: active
tags: [supabase, storage, r2, cdn, cache, delete, verification]
created: 2026-07-02
origin: Production verification session on gamefork.io (2026-05-06): a deleted screenshot's URL kept returning 200, costing significant debugging time before the cache-vs-delete ambiguity was identified. Delete routes hardened afterwards.
stack: [supabase-storage, cloudflare-r2, cdn]
supersedes: null
superseded_by: null
---

## Context

After implementing a DELETE endpoint for user-uploaded files (Supabase Storage; the same
applies to R2 or anything behind a CDN), the obvious verification is: delete the file,
then GET its public URL and expect a 404.

## Failure

The GET returned **200 long after a successful delete**, because the CDN serves the cached
object until its TTL expires. Worse, the two failure modes are indistinguishable from the
outside:

- delete succeeded, CDN still caching (harmless, resolves at TTL), vs.
- delete **silently failed** server-side (real bug, file persists forever).

Our original route made this worse by catching the storage error, logging `console.warn`,
and returning 200 anyway — a silent fallback that made server-side failure invisible
exactly when we needed to distinguish it.

## Consequences

Verify deletion at the API layer, not through the CDN:

```ts
const { data, error } = await supabase.storage.from(BUCKET).remove([path]);
return NextResponse.json({
  removed: { ok: !error, path, count: data?.length ?? 0, error: error?.message },
});
```

Rules:

1. The DELETE route **embeds the storage API's return value in its response**
   (`removed.count === 1` proves the delete instruction succeeded). Clients and admins
   judge by that, never by GETting the public URL.
2. Never swallow the storage error into a log line while returning success. Surface it in
   the response and let the caller decide.
3. Also confirm the database reference (e.g. the row's `image_url`) is nulled — storage
   and DB can diverge.
4. If you must check the public URL, do it 5–10 minutes later as a cache-expiry
   observation, not as the correctness check.

General lesson: **any read that can be served from a cache is unusable as verification of
a write/delete.** Verify against the authoritative layer's own response.
