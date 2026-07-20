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
- [0007](failures/0007-codex-mcp-url-query-breaks-oauth.md) A query string on a Codex CLI MCP server URL silently breaks OAuth discovery
- [0008](failures/0008-codex-cli-known-mcp-client-bugs.md) Three known Codex CLI MCP client bugs that masquerade as server-side auth failures
- [0009](failures/0009-chatgpt-pro-model-apps-unavailable.md) ChatGPT Pro models do not support Apps, which can masquerade as an MCP server failure

## Design / Code

Not yet published — the private wheel has more entries queued for promotion.
