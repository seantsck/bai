# G6D: migration 034 (player_aliases) and the release order

**Status: LOCAL IMPLEMENTATION AND DRAFT PR ONLY. NOT AUTHORIZED FOR HOSTED RELEASE.** This document supersedes the release sequence in `g6b-rest-boundary.md`.

## Migration 034 (exactly)
`public.player_aliases` only, the 033 model: `GRANT SELECT` to `bai_site`; `REVOKE ALL` from PUBLIC, `anon`, `authenticated`; policy `public_read` (anon, authenticated) replaced by `site_read` (bai_site); one row in `public.internal_objects` (so `apply_public_boundary()` cannot reopen it). No data, no function, no other relation is touched; the aliases and their provenance stay byte-identical (tested). It requires 033 and refuses to run without it.
* **Why:** an alias is a name for a player. Nothing on the website reads the table directly (`v_source_attribution` counts it, and has been the website role's since 033). No consumer was found: none in the repository, and in the 13 days of hosted statement statistics before G6C the only `anon` access to the table was two manual queries on 2026-10-24. The import pipeline writes aliases for any record that carries them, so a future Retrosheet-associated alias would otherwise be public on import (the six pinned batches carry none).
* **Inherited privileges:** the only non-superuser role holding `SELECT` is `bai_site`; `bai_web` can `SET ROLE bai_site` without inheriting; `anon`, `authenticated` and `authenticator` are not members of `bai_site` (tested for all eight relations).
* **Emergency withdrawal needs no change:** 033's `ingest.promotion_readers()` counts `bai_site` as a reader of a table when it holds the grant directly, so an alias that points at a promoted player is hidden (hide mode, a policy naming `anon, authenticated, bai_site`) or its table is closed (close-api, revoking from exactly the roles that held the privilege) and given back exactly (revert, finish). Tested with the whole emergency suite at the 032, 033 and 034 stages (`promotion-indirect.test.mjs`, `-033`, `-034`).
* **Recovery:** `docs/transactions/g6d-rollback-034.sql` restores exactly the post-033 state of the table (tested against a database that never had 034; also tested in sequence with `g6b-rollback-033.sql` against a database that never had either). It reopens the table to the Data API, so it needs the owner's authorization; the correction that follows is a new migration, never an edit of 034.

## Release order (each hosted step is separately authorized; none is performed here)
1. **Fresh verified production backup and hosted parity check** (G5-5D collector and `restore-export.mjs`; the snapshot id will have moved: re-run it).
2. **Migration 032** (locks on 94 relations; `lock_timeout` about 5 s; `statement_timeout` at least 2 minutes; one transaction).
3. **Verify `bai_web` can `SET ROLE bai_site` through the actual pooler connection** (the `bai_web.<ref>` login the website uses): connect that way, `set role bai_site`, `select current_user`, and read one `rm_transaction_*` table. Do this before touching the website configuration.
4. **Set `BAI_PUBLIC_ROLE=bai_site` and deploy the website.**
5. **Verify the baseline website:** every page route answers; `tests/support/page-queries.mjs` hashes equal those from before step 2.
6. **Migration 033** (seven relations, milliseconds).
7. **Migration 034** (one relation), in the same maintenance window as 033.
8. **Final website-parity and REST-security checks:** the website's 23 page queries as `bai_site` return the pre-033 results; the read-only security audit passes; over REST (publishable key, GET and HEAD only) the eight relations answer 401/403 in exact, planned and estimated modes and `sources`, `source_attribution_statements`, `organizations` still answer; `service_role` and default privileges unchanged (read-only recheck; `pg_graphql` still absent, realtime publication still empty, no `supabase_admin`-created table in `public`).
9. **Verify live Retrosheet attribution on Players and Sources** (the statement is unconditional there; the Transactions pages show it only once Retrosheet rows are published, so they cannot be verified earlier). This is the evidence the manifest needs.
10. **Separately authorize and perform the historical promotion** (the package built against a fresh baseline restore, verified against the hosted state immediately before).
11. **Refresh and verify every transaction page, count and the attribution.** If the statement is missing on any Transactions page after the refresh, withdraw at once (`withdraw_promotion`; emergency if blocked).

## The compatibility window between 032 and the role-switch deployment (steps 2 to 4)
From 032, `anon` and `authenticated` lose the transaction read models, and the website, which still runs as `anon` (`BAI_PUBLIC_ROLE` unset), cannot read them: the five transaction-page queries (`getTransactionOverview`, `getTransactionCoverage`, `getTransactionClubSeasons`, `getTransactionSeasonTotals` and the list/detail queries) error and the Transactions pages show the "unavailable" state. No transaction data is published yet (the read models are empty), and every other page is unaffected. `bai_site` cannot exist before 032, so the window cannot be removed, only shortened: prepare the environment change and have the deployment ready, and keep steps 2 to 4 within minutes. Do not apply 033 inside this window.

## Rollback conditions that were missing
* **After 033, never roll Vercel back to a deployment that uses the old `anon` role.** Vercel keeps each deployment's environment: an "instant rollback" to a build from before step 4 comes back with `BAI_PUBLIC_ROLE` unset, and after 033/034 the Players, Draft and Sources pages and several transaction queries fail (8 of the 23 page queries as measured). Safe paths: **roll forward** (a new deployment with `BAI_PUBLIC_ROLE=bai_site`; redeploy the last good commit with the variable set), or, if the database change itself must be undone, a **separately authorized database recovery**: `g6d-rollback-034.sql`, then `g6b-rollback-033.sql` (both one transaction, `lock_timeout` 5 s), after which the old `anon` deployment works again.
* Before step 6, a website rollback is harmless: `anon` still reads everything the site needs except the transaction read models (empty).
* 032 has no down-migration (documented in `g5-promotion.md`); a failure inside it rolls back as one transaction; after commit, roll forward.
* After any recovery: read-only security audit, page routes, REST matrix, and the page-query hashes.
* If 033 or 034 fails inside its transaction nothing is applied; do not retry blindly: read the error, keep the site on `bai_site`, and report.

## Remaining production prerequisites
The G6 authorization with real attribution evidence (still a placeholder); the fresh backup, parity check and Vercel environment confirmation (`BAI_PUBLIC_ROLE` is unset today: the database shows the website queries running as `anon`); unknown external REST clients accepted by the owner (hosted request logs are not available through the logs API for this project); hosted-scale timings; the owner decision on free-text names in `international_signings.notes` and `sources.title`.
