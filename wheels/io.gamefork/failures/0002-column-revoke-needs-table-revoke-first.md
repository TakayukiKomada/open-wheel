---
id: failure-0002
namespace: io.gamefork
title: Column-level REVOKE UPDATE is a no-op while a table-level UPDATE grant remains
summary: Column-level REVOKE UPDATE (col) has no effect while the role still holds a table-level UPDATE grant. Revoke table-level UPDATE first, then GRANT back only the columns that should be writable.
status: active
tags: [postgres, supabase, grant, revoke, rls, hardening]
created: 2026-07-02
source: io.gamefork (promoted from a private wheel)
origin: Production migration failure on gamefork.io (2026-06); the built-in verification ASSERT caught it during production apply. Fixed with a follow-up commit, verified in production.
stack: [postgresql, supabase, postgrest]
supersedes: null
superseded_by: null
verified: 2026-06-19
---

## Context

We wanted to stop clients from updating columns they should never touch (author id,
counters, `created_at`) on a table that legitimately allows updating other columns
(title, body, status). PostgreSQL supports column-level privileges, so the obvious move is:

```sql
REVOKE UPDATE (author_id, vote_count, created_at) ON my_table FROM anon, authenticated;
```

## Failure

That statement is **silently ineffective** if the role still holds a *table-level*
UPDATE grant — which it almost always does on Supabase, where default privileges grant
broad table access to `anon` and `authenticated`. `has_column_privilege(role, table,
col, 'UPDATE')` returns `true` for every column as long as the table-level grant exists.
The revoke runs without error and changes nothing.

Extra trap: our migration's verification `ASSERT` passed in CI (a slim Postgres without
the production grants) and only failed during the **production** apply. Until the apply
completes on the real database, you cannot claim the lockdown worked.

## Consequences

The correct order — revoke broad, re-grant narrow:

```sql
-- 1) Remove the table-level grant first (without this, column REVOKEs do nothing)
REVOKE UPDATE ON my_table FROM anon, authenticated, PUBLIC;

-- 2) Re-grant only the legitimately updatable columns
GRANT UPDATE (title, body, updated_at) ON my_table TO authenticated;

-- 3) Verify both directions: sensitive columns revoked AND legitimate paths intact
DO $verify$
BEGIN
  ASSERT NOT has_column_privilege('authenticated', 'my_table', 'vote_count', 'UPDATE'),
    'vote_count still updatable';
  ASSERT has_column_privilege('authenticated', 'my_table', 'title', 'UPDATE'),
    'title lost UPDATE — legitimate route would break';
END $verify$;
```

Two adjacent lessons:

- If a trigger maintains counter columns, the trigger function must be SECURITY DEFINER
  (with an in-function guard, see [[failure-0001]]) or it breaks after step 1.
- Deploy the application code that stops writing revoked columns **before** applying the
  grant-narrowing migration, or old code fails against the new grants.
