---
id: failure-0007
namespace: io.gamefork
title: A query string on a Codex CLI MCP server URL silently breaks OAuth discovery (and sandbox-injected configs add a second stale layer)
summary: Registering a remote MCP server in Codex CLI with a query string in the URL (e.g. ?auth=required) breaks OAuth discovery — `codex mcp list` shows Auth Unsupported, login fails with "No authorization support detected", and gated tools never appear while public read tools still work. Re-register with the clean URL and log in again; sessions running inside a sandbox that injected the stale config additionally need a fresh start to pick up the fix.
status: active
tags: [codex, mcp, oauth, auth, sandbox, tooling]
created: 2026-07-09
source: io.gamefork (promoted from a private wheel)
origin: Diagnosed 2026-07-07 while connecting Codex CLI to gamefork's remote MCP server. Server health was proven from a second client with curl (.well-known OAuth metadata + 401 WWW-Authenticate challenge both correct), pinning the fault on the client; the fix (clean-URL re-registration + login) was verified working the same day.
stack: [codex-cli, mcp, oauth]
supersedes: null
superseded_by: null
observed_by: codex-cli
verified: 2026-07-07
---

## Context

Codex CLI can connect to remote MCP servers over Streamable HTTP with OAuth
(discovery via `.well-known/oauth-protected-resource`, dynamic client registration,
PKCE). A server typically exposes some public tools to anonymous clients and gates
the rest behind a bearer token. We registered our server's URL with a non-canonical
query string appended (`https://<host>/api/mcp?auth=required`) — intended as a hint
for a different client — and authentication never came up.

## Failure

Two independent layers of failure stacked on top of each other.

**(1) The query string breaks OAuth discovery.** With the query-string URL
registered, `codex mcp list` showed `Auth: Unsupported` with an empty bearer token,
`codex mcp login` failed with `Error: No authorization support detected`, and a
direct POST returned `{"error":"invalid_token"}`. `tools/list` contained only the
server's public (anonymous) tools, so the connection *looked* alive while every
owner-gated tool was silently missing.

**(2) Sandbox-injected config holds the stale entry.** Fixing the real user config
(clean URL + successful `codex mcp login`) did not help sessions already running
inside a sandbox that had injected the old config at startup: `codex mcp get <name>`
said the server did not exist, while `codex mcp list` still showed the old
query-string entry as `Unsupported`. In-session `remove`/`add`/`login` could not
repair it — the MCP config is loaded at process start, and the sandbox re-injects
its own layer on the next run.

**The server was healthy the whole time** (this is the expensive misdiagnosis to
avoid). Measured from a second, unaffected client: both
`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
returned 200 with a complete configuration (dynamic client registration endpoint,
PKCE S256, authorization_code + refresh_token), and an unauthenticated POST with the
correct `Accept: application/json, text/event-stream` header returned
`401 + WWW-Authenticate: Bearer realm="OAuth", resource_metadata=...` as required.
Appending `?auth=required` produced the same correct challenge. The fault was 100%
client-side.

## Consequences

- **Fix (query-string URL)**: re-register with the canonical, query-free URL and log
  in again: `codex mcp remove <old>` → `codex mcp add <name> --url https://<host>/api/mcp`
  → `codex mcp login <name> --scopes <scopes>`. On codex-cli 0.130.0 this
  auto-detects OAuth, opens the browser flow, and `codex mcp get` then reports
  `Auth: OAuth`. Confirmed working against the real config.
- **Fix (sandbox layer)**: not repairable from inside a running session. Start a
  fresh session that reads the corrected config, and check `codex mcp list` shows
  `OAuth` for the server *before* calling any gated tool. If the stale entry still
  appears, the injection source (the harness's own MCP config) is what needs fixing.
- **Reusable triage pattern**: on `Auth: Unsupported` + empty token + `invalid_token`,
  first curl the server's `.well-known` OAuth metadata and the 401 challenge from an
  unaffected client. If those are healthy, stop debugging the server — the fault is
  in the client's URL, registration, or config layering.
- **Lesson**: keep MCP registration URLs canonical — no query strings. And note that
  public read tools succeeding proves nothing about auth: only a gated tool call
  exercises the bearer token.
