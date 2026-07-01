---
id: failure-0001
namespace: io.gamefork
title: SECURITY DEFINER functions silently bypass Row Level Security
status: active
tags: [postgres, supabase, rls, security-definer, security]
created: 2026-07-02
origin: Production vulnerability on gamefork.io, found by static audit 2026-05-06; fixed and verified in production the same day. Window of exposure was about one month.
stack: [postgresql, supabase, postgrest]
supersedes: null
superseded_by: null
---

## Context

In PostgreSQL, a function declared `SECURITY DEFINER` runs with the *creator's* privileges,
not the caller's — which means **it does not see Row Level Security policies at all**.
On Supabase, RPC functions are commonly created as SECURITY DEFINER and granted to the
`anon` role so unauthenticated clients can call them.

We had RLS policies restricting unreviewed and rejected content to its owner and admins.
The policies were correct. The tables were locked down.

## Failure

Two RPC functions (`get_*_for_play`-style content loaders), created months earlier as
SECURITY DEFINER and granted to `anon`, returned rows **without checking the review status**.
Anyone who knew or guessed a UUID could load content that RLS was supposed to hide —
including content rejected by moderation. The RLS policies were never consulted, because
the DEFINER function bypasses them by design.

The dangerous part: the vulnerability was introduced by *adding the RLS policies later*.
The functions were fine when written; the moderation-status column and its policies arrived
afterwards, and nobody re-audited existing DEFINER functions against the new visibility rules.

## Consequences

Fix: re-implement the visibility check *inside* the function body:

```sql
IF v_row.review_status IS DISTINCT FROM 'approved' THEN
  RETURN;  -- behave exactly like RLS would
END IF;
```

Rules we now enforce:

1. Any SECURITY DEFINER function granted to `anon` (or `authenticated`) must re-implement
   the same visibility conditions as the RLS policies on the tables it reads.
2. **Every time an RLS policy is added or changed**, inventory existing DEFINER functions:
   `grep -lE 'SECURITY DEFINER|GRANT EXECUTE.*anon' migrations/*.sql`
3. Also pin `search_path` on every DEFINER function (`SET search_path = public, pg_temp`)
   to prevent search-path hijacking — same audit, same checklist.
4. Migration tests should assert "calling the function with a row RLS would hide returns
   zero rows".

The general lesson: **RLS is not a security boundary for anything that runs as
service-role or SECURITY DEFINER.** Treat every such function as its own authorization
surface that must be audited whenever visibility rules change.
