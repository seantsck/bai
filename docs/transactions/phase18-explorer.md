# Phase 18 — Historical Acquisition Explorer

Local only. Nothing here touches hosted: no migration, no import, no grant, no deploy. Migration 030 exists only in the repository and in disposable databases.

## What was built

| Piece | Where |
| --- | --- |
| Public ledger, filters (season, club, type, reconstruction status, player/club search), 50-row pages | `app/transactions/page.tsx`, `lib/transactions.ts` |
| Trade forensics / transaction detail | `app/transactions/[id]/page.tsx` |
| Coverage and limitations | `app/transactions/coverage/page.tsx` |
| Retrosheet attribution (verbatim notice, on every transactions page and `/sources`) | `components/TransactionBits.tsx`, `public.source_attribution_statements` |
| Public read model (`rm_*` tables, owner-run refresh) | `database/migrations/030_transaction_public_read_model.sql` |
| Non-trade acquisition importer (ACQUISITIONS channel) | `scripts/research/lib/acquisitions.mjs`, `retrosheet-acquisitions.mjs`; `retrosheet-transactions.mjs acquisitions` |
| Benchmarks and smoke test | `scripts/db/bench/explorer.mjs`, `build-p18-all.mjs`, `smoke-explorer.mjs` |

## Three separate states (never merged)

1. **Source licensed for display.** `ingest.source_publication_grants` per attribution category. The RETROSHEET category exists but **no grant is recorded anywhere**; the read model withholds every Retrosheet-derived transaction until a grant exists. Transactions mixing an authorized and an unauthorized source are withheld.
2. **Transaction VERIFIED_COMPLETE.** Only `analytics.transaction_completeness` with an active human verification matching the current fingerprint. Imported records are PARTIAL at best. The page claims "verified complete" only when the database says so, carries the verification date, and lists no gap. Revocation withdraws it (tested).
3. **Club-season COMPLETE_CENSUS.** `coverage_assessments`; shown on the coverage page and never inferred from a transaction count ("tracked is not complete").

No winner, grade, score or ranking exists in the schema, queries or pages. Organizational performance (WAR returns) is shown only where the WAR source's permission allows; otherwise `WITHHELD_PERMISSION`. Internal notes, reviewer identities and restricted sources are not in any `rm_*` table.

## Non-trade importer

Classes: FREE_AGENT (F, Fo), AMATEUR_FREE_AGENT (Fa, Fb), WAIVER (W, Wf), PURCHASE (P), RULE_5 (D). Counted but never staged: departures, voids, returns, roster status, draft selections (the draft tables hold those), Fc compensation picks. Held (not staged): name-only players, weak identity, approximate or month-only dates, wrong club shape, signings the source itself voids. No salary, contract or service time is inferred; the row's own note is kept verbatim.

| Period | Staged | Held | Hold reasons |
| --- | ---: | ---: | --- |
| 2015 pilot | 1,015 | 5 | identity / date / name-only |
| 2010–2014 | 4,591 | 31 | |
| 2015–2020 | 5,150 | 20 | |
| 2021 | 914 | 28 | 16 approximate date, 6 name-only, 6 id/name mismatch |

(2015 is inside the 2015–2020 batch; the load test applies 2010–2014, 2015–2020 and 2021.) Each period rehearsed clean in a disposable PG17 database: replay is idempotent, conflicts are surfaced, coverage is recorded per club-season as non-census.

## Performance (disposable PG17, 11,257 transactions: 602 trades + 10,655 acquisitions; hosted snapshot b7f8858c…17a1 + all local batches)

Explorer page queries run as `anon` in a read-only transaction, 20 runs, gate < 100 ms median:

| Query | Median |
| --- | ---: |
| first page | 2.0 ms |
| page 100 / page 200 (max) | 14.5 / 28.9 ms |
| season, club, type, status filters | 1.8–2.9 ms |
| player prefix / two-token / club-name search | 1.9–3.5 ms |
| detail page (5 queries) | 1.1–2.0 ms each |
| coverage page (5 queries, total) | 12.7 ms |

Read-model refresh: ~20 s (owner-run, convergent). No count(*) in pagination; one extra row detects a next page; `page` is capped at 200. Value-view parity: `trade_returns`, `acquisition_value`, `class_value` and the draft/international views are byte-identical (canonical JSON dumps) between 029 and 030 at the 401-trade scale; 030 adds only tables and new functions. Repeat: `node scripts/db/bench/build-p18-all.mjs` then `node --import ./tests/support/register-ts.mjs scripts/db/bench/explorer.mjs --db bai_p18_all`.

A load test found a real defect: a three-team trade yields several return rows for one club and provider. The first fix (adding the counterparty to the key) only hid it; see "Hardening" below for the real correction.

## Rendered smoke test

`next build` + `next start` against the load-test database: ledger, filters, search, deep page, detail, coverage, `/sources`, 404s for bad ids and for a withheld (unauthorized-source) transaction, verbatim attribution on each, no `badge-complete` anywhere, no page over 2 s (`smoke-explorer.mjs`).

## Security and publication-permission checks

`npm run db:security` against the load-test database with 030 applied: SECURITY OK (62 behavioural attempts as anon/authenticated). New public tables are RLS-protected read models; `transaction_player_moves` is internal; the refresh function is owner-run and not executable by public roles; the public app builds its tsquery itself and never calls BAI functions.

## Later-added-player proposal

Decision: **not implemented.** Nothing in Phase 18 requires it; PTBNL resolution stays separate. The proposal is reserved as migration 031 (`docs/transactions/later-added/proposed-031-later-added-assets.sql`) so 030 does not collide. Original transaction facts are never modified.

## Production release-readiness: explicit blockers

1. **Publication grant.** Retrosheet `publish_site` is PENDING in `research/history/sources.json`; no `source_publication_grants` row for RETROSHEET exists on hosted. Without it the explorer shows nothing from Retrosheet. A person must record the basis; this phase did not.
2. **Migrations 028, 029, 030** are unapplied on hosted (hosted is at 027) and each needs separate authorization, in order.
3. **Import.** No real data has been imported anywhere hosted. All imported records are PARTIAL; none can be VERIFIED_COMPLETE without a primary announcement or second independent source and a human verification.
4. **Contracts, salary, service time** are absent from the source and not shown.
5. **WAR returns** appear only where the WAR source permits display.
6. **Held records** (name-only, id/name mismatch, approximate dates) stay out until identity or dates are resolved by a person.
7. **Refresh** must be run by the database owner after any import, grant or verification; the read model is stale until then.
8. **Legacy raw tables** are closed by 030 (see Hardening). On hosted they are publicly readable today; applying 030 closes them, which is a visible behaviour change to anyone using the Data API directly. Nothing in this application reads them.
9. PRs #37–#41 remain drafts; none merged.


## Hardening (second pass, before any merge review)

Migration 030 was amended in place (it is applied nowhere hosted; 001–029 are untouched). Every change:

**1. Club-level returns, not per-counterparty.** `analytics.trade_returns` (029, deliberately unchanged) computes the received players' WAR once per transaction and club, then repeats it on every package row that club *sent*. In a three-club trade a club that sends two packages therefore carries the same figure twice; on the load-test data 12 club rows were affected, all with identical figures (so nothing was ever summed, but the first fix of adding the counterparty to the key would have displayed one club total as two counterparty figures).
- `rm_transaction_returns` is now (transaction, club, provider): one figure per club and provider, labelled on the page as the club's total across the whole trade, `players_sent` summed over the club's packages, `players_received` a club count.
- New `rm_transaction_packages` keeps the package level (who sent how many players and other assets to whom); it carries no WAR figure.
- The refresh raises an exception if the repeated club figures ever disagree rather than choosing one.
- Providers are never combined; a provider whose sources are not licensed for display is `WITHHELD_PERMISSION` while another provider's figure shows; no evidence is `NOT_OBSERVED`, never zero.

**2. Fail-closed withdrawal (stale authorization and stale verification).** Before: a revoked grant or verification kept its rows in the public tables until the owner next ran the refresh. After, in the *same transaction* as the change, rows are removed from the public tables:
| Event | Effect |
| --- | --- |
| a publication grant deleted, updated or truncated | every transaction citing that category is withdrawn; all performance figures and the overview are removed |
| a verification revoked (by a person, or automatically by 028 when evidence changes) | that transaction is withdrawn |
| any insert, update or delete on a transaction's record, packages, assets, sources, links, external ids, conflicts, PTBNL resolutions or moves, or an update/delete of a cited `sources` row | that transaction is withdrawn |
Aggregates (overview, coverage matrix, club-season states) cannot be corrected piecemeal and are emptied; the pages say the totals await a refresh instead of showing old counts. A withdrawal also removes other transactions' "later movement" rows that point at the withdrawn one. A new grant or verification publishes nothing until the owner refreshes. The refresh now locks the tables it reads (SHARE) so a revocation cannot interleave with it. Importing new transactions withdraws nothing (they are unpublished) and import timings are unchanged (59/84/17 s against 60/85/16 s for the three acquisition batches). Withdrawals are logged in the internal `rm_transaction_withdrawals`. `sources` rows are in the fingerprint of 028 but not covered by 028's revocation triggers; the new trigger covers them (a changed source URL withdraws the claim even though the verification row stays ACTIVE and mismatched).

**3. Raw transaction tables.** Before: `public.transactions`, `trade_packages`, `trade_package_assets` were readable by anon and authenticated (RLS `using (true)`), exposing every imported record, including those whose source is not licensed (the 65 BAI trades; any Retrosheet row). `transaction_player_moves`, `transaction_sources`, `transaction_external_ids`, `transaction_source_links`, `ptbnl_resolutions`, `transaction_conflicts`, `research.*`, `analytics.*` and `ingest.*` were already closed. After: the three tables are internal (grants revoked, `public_read` policies dropped, registered in `internal_objects`). Consumers audited: the application reads none of them; research tooling and tests use the owner role; the only public dependent was `public.v_source_attribution` (the Sources page), whose TRANSACTION rows now count the transactions the read model publishes. Draft, international and organization reads are unchanged (all other tables and views byte-identical, below).

**Verified** (`tests/db/transaction-read-model-hardening.test.mjs`, direct SQL as `anon` and `authenticated`): two-club and three-club trades, one club with two packages, two WAR providers, NULL and partial coverage; grant withdrawn, re-granted, truncated; verification revoked; each of an asset edit, a link edit, a source-row edit, a link removal and an added asset on a verified record; convergence of the refresh after a withdrawal; no withdrawal on import; every raw table and every BAI function refused to both roles.

## Reconciled load-test population (`node scripts/db/bench/reconcile.mjs --db bai_p18_all`)

The earlier 602 was not a loss: 602 trades is the Retrosheet imports, and the read model withholds the 65 existing BAI trades because their source (MLB) is not licensed for display on that database. Canonical and published populations reconcile exactly.

| | Count |
| --- | ---: |
| Existing BAI trades (source MLB) | 65 |
| Imported trades 2010–2014 / 2015–2020 / 2021 | 244 / 336 / 22 (= 602) |
| **Total trades (canonical)** | **667** |
| Non-trade acquisitions (FA 8,333; amateur FA 371; waiver 1,241; purchase 533; Rule 5 177) | 10,655 |
| **Total transactions (canonical)** | **11,322** |
| Published by the read model | 11,257 (602 trades + 10,655) |
| Withheld by permission (65 BAI trades, MLB-sourced) | 65 |

Held or excluded before import (local staging summaries, nothing forced): trade groups held 271 / 378 / 91 (name-only players, one direction only, unstated conditions, free-text assets, later-dated members without a placeholder, id/name mismatch; 2015–2020 also leaves 2 groups HELD at apply and 14 groups that match an existing BAI trade, 9 confirmed + 5 possible, which are not re-imported), acquisitions held 31 / 20 / 28, and not acquisitions at all: departures 4,450 / 5,418 / 921, draft selections 1,169 / 500 / 0, voids 8 / 2 / 0, returns 19 / 32 / 3, roster status 1 / 0 / 0.

## Hardened benchmark (disposable PG17, 11,257 published of 11,322)

Every page query under 30 ms median (first page 1.7 ms, page 200 28 ms, filters 1–3 ms, search 1–2 ms, detail queries under 1 ms, coverage queries 10.6 ms in total); refresh 20.8 s. `explorer-hardened.json`. At benchmark scale the three value views are IDENTICAL between a 029-only and a 029+030 database (trade_returns 1518 rows, acquisition_value 3176, class_value 350), and all 100 tables and the draft / international views are identical except the intended `internal_objects` rows and the Sources-page TRANSACTION rows (`verify-unchanged.mjs`).

## Readiness for merge review

Phase 18 is ready for *merge review*, not for production. Remaining production requirements are the blockers listed above, plus: apply 028, 029 and 030 to hosted in order under separate authorization; record the Retrosheet publication basis (a person); import under separate authorization; run the refresh as owner. Reviewing the effect of closing the three raw tables on any Data API consumer before applying 030 to hosted.
