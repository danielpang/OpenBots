# Review instructions for the server

## Always check

- A migration under `drizzle/` that has shipped is never edited. A change to
  one is Important: it needs a new migration
- A new column is nullable or has a default, and a migration that changes
  existing data handles rows that are already there
- A new table that holds an organization's data has `workspace_id` and a
  row-level security policy, and is covered in `src/db/rls.test.ts`
- A webhook route verifies the signature on the raw body before parsing it,
  and the rate limits in `src/hooks/` still apply on any new path
- A new stored secret is encrypted with the master key and covered by
  `rotate-key`
- `lower()`, `upper()` and `ILIKE` are not used to compare text that can be
  non-ASCII. PGlite folds case for ASCII only, so its tests cannot show what
  the server does
- A change to a coding session works for all three agents: Claude Code, Codex
  and pi each have their own adapter under `src/services/coder-adapters/`
