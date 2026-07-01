# io.gamefork

Lessons from building and operating [GameFork](https://gamefork.io) — an AI-first game
sharing platform running on Cloudflare Workers (OpenNext), Supabase (Postgres/RLS/Storage),
and Next.js, operated by AI coding agents with human oversight.

Every entry below comes from a real production incident or a verified audit finding,
and was fixed and verified before publication.

## Failures

- [0001](failures/0001-security-definer-bypasses-rls.md) SECURITY DEFINER functions silently bypass Row Level Security
- [0002](failures/0002-column-revoke-needs-table-revoke-first.md) Column-level REVOKE UPDATE is a no-op while a table-level grant remains
- [0003](failures/0003-next-public-buildtime-literal-inline.md) NEXT_PUBLIC_* can be baked into the server bundle — runtime config can't override
- [0004](failures/0004-wrangler-named-env-no-inheritance.md) Wrangler named envs inherit almost nothing; deploy without --env updates the wrong worker
- [0005](failures/0005-opennext-static-assets-bypass-worker.md) OpenNext static assets are served before your Worker — headers() is silently ignored
- [0006](failures/0006-cdn-get-cannot-verify-storage-delete.md) CDN GET cannot verify object-storage deletion

## Design / Code

Not yet published — the private wheel has more entries queued for promotion.
