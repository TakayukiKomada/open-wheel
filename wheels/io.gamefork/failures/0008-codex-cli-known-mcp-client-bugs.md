---
id: failure-0008
aliases: [failure-0008]
namespace: io.gamefork
title: Three known Codex CLI MCP client bugs that masquerade as server-side auth failures
summary: When a Codex CLI MCP connection looks "authenticated but broken", suspect the client before the server. Three known bugs — (1) expired OAuth access tokens are not auto-refreshed even when a refresh_token is held, (2) tools/list is snapshotted at first connection and never updated, (3) codex exec (non-interactive) auto-cancels every MCP tool call. Remove → re-add → login rebuilds both the token and the tool list; tool calls need an interactive session.
status: active
tags: [codex, mcp, oauth, cli, client-bug, tool-discovery, non-interactive, exec]
created: 2026-07-09
source: io.gamefork (promoted from a private wheel)
origin: Confirmed 2026-07-08 against public Codex issue reports (openai/codex issues 17265, 27165, 20605, 20771, 24135, 16685) after several server-side hypotheses failed to explain the symptoms; re-registration against gamefork's remote MCP server restored the full gated tool list the same day, and the exec auto-cancel signature was reproduced exactly.
stack: [codex-cli, mcp, oauth]
supersedes: null
superseded_by: null
observed_by: codex-cli
verified: 2026-07-08
---

## Context

While debugging why Codex CLI could not see or call gated tools on a remote MCP
server (a connection that had previously authenticated fine), we burned time on
server-side hypotheses in sequence — token refresh rejected with `invalid_grant`,
protected-resource-metadata audience mismatch, token-validation logic — and none of
them explained the symptoms. Web research showed all of it was already reported as
Codex CLI client behavior. Recorded here so the next person skips the server-side
rabbit hole.

## Failure

Three independent client-side limitations, each of which looks exactly like a broken
server if you only see the symptom:

1. **OAuth access tokens are not auto-refreshed** (openai/codex issues 17265,
   27165). Even with a `refresh_token` stored, an expired access token is not
   renewed. Old registrations gradually degrade into "authenticated but nothing
   comes back".
2. **tools/list is snapshotted at first connection and never refreshed**
   (openai/codex issues 20605, 20771). Tools added on the server after registration
   never appear to an existing Codex registration — it keeps serving the tool list
   captured at first connect.
3. **`codex exec` (non-interactive mode) auto-cancels every MCP tool call**
   (openai/codex issues 24135, 16685). Resource reads go through, but any tool
   call — even a harmless `echo` — dies with `user cancelled MCP tool call`,
   because the approval prompt hits a closed stdin and EOFs. No config setting
   (`approval_policy=never` etc.) suppresses it.

## Consequences

- **Workaround for (1) and (2)**: rebuild the connection completely —
  `codex mcp remove <name>` → `codex mcp add <name> --url <url>` →
  `codex mcp login <name>`. This refreshes both the stored token and the frozen
  tools/list snapshot. In our case re-registration immediately exposed the full
  tool list, including everything added since the original registration.
- **Workaround for (3)**: not fixable via config. Run the tool call from an
  interactive `codex` TUI session and approve it manually, or (with eyes open)
  `codex exec --dangerously-bypass-approvals-and-sandbox` executed by the human —
  automation harnesses generally should not, and some refuse to, launch that flag.
- **Verification that separated client from server**: calling the same gated tool
  through a different MCP client returned a correct authenticated response while
  `codex exec` produced `{"status":"failed","error":{"message":"user cancelled MCP
  tool call"}}` — the exec auto-cancel signature, confirming the server was fine.
- **Lesson**: when a Codex MCP connection looks "authenticated but incomplete",
  check these three known bugs first. Remove → re-add → login plus one manual
  interactive check is far cheaper than auditing server-side token validation.
