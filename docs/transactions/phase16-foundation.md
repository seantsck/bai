# Phase 16: transaction foundation (migration 028 and the transaction importer)

Status: **implemented locally, not deployed.** Migration 028 is not applied to the hosted project (hosted is at 027), no transaction was imported, no score or ranking exists, and nothing here changes DISI, Diamond IQ, a release manifest or a historical audit. Design source: `docs/transactions/03` and `06`.

## 1. What 028 adds (all additive)
| Object | Purpose |
|---|---|
| `public.transaction_external_ids` | stable identities (`scheme` + `id`, unique across the database; one per scheme per transaction) |
| `public.transaction_sources` | several sources per transaction, each with a `role` and an **independence group** |
| `public.transaction_source_links` | package-level and asset-level provenance: which source supports which package or asset (same transaction enforced) |
| `trade_package_assets` + `amount_disclosure`, `conditional`, `condition_text` | cash is DISCLOSED / UNDISCLOSED / UNKNOWN (null never means zero); conditional assets carry their condition; a PTBNL is conditional by definition |
| `public.ptbnl_resolutions`, `analytics.trade_asset_players` | a PTBNL resolved to a player, cash or nothing by a dated, sourced row; the 023 return views and the 022 guard read players through the helper view, so a resolved PTBNL is counted exactly once, from the naming season |
| `public.season_calendar_events`, `analytics.transaction_deadline_context` | opening day, All-Star Game, trade deadline, season end; window membership is NULL (unknown), never false, without the calendar or a day-precise date |
| `public.transaction_conflicts` | disagreements found by the importer, kept; only a human resolves one |
| `research.transaction_verifications`, `research.transaction_fingerprint`, `research.transaction_gaps`, `analytics.transaction_completeness` | human verification and derived completeness (section 3) |
| `ingest.transaction_apply_ledger` | replay protection for the importer |

Preserved: no existing row is rewritten (existing assets keep `amount_disclosure` NULL, `conditional` false), no existing column changes meaning, and every existing value view returns identical rows (rehearsal below). `analytics.trade_returns` and `acquisition_disposition_guard` were recreated with the same columns and rules; only the source of "players in a package" moved to the helper view.

Internal by default: the new tables are registered in `public.internal_objects` (no public grant; RLS on); the existing public tables keep their grants. Exposing verified transactions publicly is a later, separate step (the transaction detail view).

### Differences from `03` (recorded in `06` section 6)
Completeness is **derived**, not a column; `independence_group` lives on the transaction-source row; cash disclosure is a three-state field; and `transaction_verifications` lives in the `research` schema with the other human-only records.

## 2. Importer
Version-2 `TRADE` records (`schema: 2`) go through the existing research pipeline unchanged in shape: stage, validate, dry-run, apply. Old-shaped trades still import (with a `LEGACY_TRADE_SHAPE` warning: same-day trades between the same clubs are merged). Local databases only in this phase; the hosted publication gate (`requirePublishable`) applies to every batch exactly as before.

```
npm run transactions -- prepare --in raw.json --out prepared.json     deterministic: same trade in any order, same bytes, same identity
npm run transactions -- preview --file prepared.json                   read-only: NEW / EXISTING / COLLISION / CONFLICT per record
npm run research:import -- --league --file prepared.json               stage (nothing canonical)
npm run research:validate -- --batch <key>                              shape, in-batch rules, identities
npm run research:apply -- --batch <key>                                 dry run; add --write for the atomic apply
```
Rules enforced:
- Identity: every record carries a source identifier (`MLB_TXN:...`) or a derived `BAI_TXN` fallback (hash of date, directions and assets). One identity = one transaction.
- **Collision**: a record with no shared identity that falls on the same day among the same clubs as an existing transaction is held (`COLLISION`) until it names that transaction in `distinct_from`. Two such records in one batch must name each other.
- **Conflict**: a value that disagrees with canonical data (date, direction of a player, cash amount, disclosure status, condition, PTBNL resolution, source role/group) holds the whole record, writes a `transaction_conflicts` row and changes nothing else. Additions (a new asset, source, link, a filled unknown) apply; silence (an omitted asset) is not a change.
- Every package and asset names the sources that support it; players need an MLBAM id; non-player assets need a description.
- Atomic: the batch applies in one transaction; a database refusal in any record rolls the whole batch back, including the ledger.
- Replay: re-applying a batch, or the same content in a new batch, reports no change and writes nothing (so it does not disturb a verification).

## 3. Completeness and human verification
`analytics.transaction_completeness` derives, per transaction: `VERIFIED_COMPLETE` only while an active verification carries the transaction's **current content fingerprint**; `PARTIAL` once any source is recorded; `UNVERIFIED` otherwise (every record from before 028). `gaps` lists what stands in the way: `NO_EXTERNAL_ID`, `NO_PACKAGES`, `ONE_SIDED_TRADE`, `EMPTY_PACKAGE`, `NO_SOURCES`, `FEWER_THAN_TWO_INDEPENDENT_SOURCES`, `NO_PRIMARY_ANNOUNCEMENT`, `PACKAGE_NOT_CORROBORATED`, `ASSET_NOT_CORROBORATED` (every package and asset needs two independence groups), `PENDING_PTBNL`, `CASH_AMOUNT_UNKNOWN`, `OPEN_CONFLICT`.

Verification (`npm run transactions -- verify`) is human-only on the reviewer's own authenticated login (migration 021's identity, `session_user`), refused while the certification gate is closed (it is closed on every database today), refused while any gap remains, and never callable by import, automation or the owner session. A verification is immutable except for its revocation. Any change to the transaction, packages, assets, sources, links, identities, resolutions or conflicts revokes it in the same database transaction (actor `system:evidence-changed`); even with those triggers switched off, the fingerprint exposes the edit (`verification_stale`).

Limits worth knowing: verification certifies one transaction, not that a club's list of trades is complete; the database cannot judge whether two groups are truly independent, so the verifier records why (`independence_note`) and is accountable; class certification (021) is not revoked by a PTBNL-resolution edit (resolutions are dated facts like trades and are not class evidence).

## 4. Tests and results
`npm run check` passes (38 app, 75 history, 213 database tests, 1 skipped (a hosted-only test); build, credential scan and publication check clean). New files: `tests/db/transactions-migration.test.mjs` (028 against a database built through 027 with legacy trades: identical views and rows; boundary), `tests/db/transactions-import.test.mjs` (importer, verification, revocation), `tests/history/transactions-format.test.mjs` (deterministic staging, shape rules). All fixtures are fictional (2031-2032 dates, MLBAM ids 988xxxx, `TEST_FIXTURE` sources).

## 5. Rehearsal of 028 on a disposable copy of hosted data
Run 2026-10-25 with `npm run hosted:rehearse-028` (`scripts/db/rehearse-028.mjs`). Hosted was **only read**, through a read-only transaction; nothing was written to it and no migration was run on it (it stays at 027). A throwaway PostgreSQL 17 was built from migrations 001-027, the hosted data was copied in, 028 was applied, and then:

| Check | Result |
|---|---|
| Hosted at migration 027; same 93 tables as the disposable build | ok |
| Data copied, equal table by table | 30,604 rows in 92 tables |
| 028 applied | 28 migrations |
| Every existing table byte-identical by its pre-028 columns | ok (the two registries, `internal_objects` and `provenance_fact_tables`, only gain the 6 and 2 rows 028 registers) |
| Every existing value view returns identical rows | `trade_returns` 166, `acquisition_value` 3,176, `player_war_coverage` 3,224, `organization_value_by_class` 0, `organization_realized_value` 0, `player_acquisitions` 1,588 |
| The eight new tables exist and are empty | ok |
| No existing asset was given a disclosure or a condition | 111 assets untouched |
| Every existing transaction reads UNVERIFIED | 65 of 65 (none claimed partial or complete) |
| Acquisition-disposition guard still rejects a contradiction | ok (163 dispositions) |
| `anon` and `authenticated` cannot read any new table or view | ok |
| Repository security audit (RLS, grants, SECURITY DEFINER allowlist, reviewer boundary) on the migrated copy | SECURITY OK |

Two things the first, failed run taught: the security audit's allowlist had to name the three new reviewer functions (fixed in `scripts/db/security.mjs`, and a test now runs the audit with 028 applied), and `analytics.class_value` (derived from `acquisition_value`, which is compared) takes tens of minutes at hosted size, so the rehearsal compares the directly affected views instead. `npm run hosted:parity` will report one pending migration (27 of 28) until 028 is separately authorized for hosted, as it did for 027 before its deployment.

Release tooling: `migrationProblems` in `scripts/history/lib/release.mjs` accepted only 001-027; it now also accepts a later **committed** migration whose checksum matches (so the pending 2025 draft release is not blocked once 028 is applied), still refuses a changed checksum or a migration the repository lacks, and `rehearse-release.mjs` builds its copy through whatever the target has. Manifests, `REQUIRED_MIGRATION`, and release audits are untouched.

## 6. Remaining rights blockers (unchanged by this phase)
Nothing built here ingests, or may ingest, a restricted source. Before any real transaction is imported:
1. **MLBAM**: written authorization for non-individual, non-bulk use of its transaction data is not held; `ingest.source_publication_grants` is empty, so MLB's transaction wire and Baseball-Reference stay `publish_site PENDING` for hosted writes. Outreach draft prepared, **unsent**.
2. **No cleared source for 2023-24 transactions or any contracts at BAI's scale**: Retrosheet's file ends at 2020 (credit line required); Lahman has no transactions or executives and its license text was not read; a licensed vendor needs a quote and publication terms (draft **unsent**).
3. **Independent corroboration needs two groups with rights**: until at least two independent sources per trade are cleared for the intended use, no trade can be verified for publication.
4. **Unread terms**: Sports Reference, Spotrac, Pro Sports Transactions, FanGraphs, MLB Trade Rumors; treated as restricted.
5. **Public repository**: restricted-source-derived data stays local; only citations and counts may be committed.
6. WAR for the realized side is Baseball-Reference only and carries the same pending permission; no grade, score or ranking is produced.

## 7. Recommendation for the next phase
Owner decisions first: review and merge PR #37 (planning) and this PR; send, edit or drop the three outreach drafts.

Then **Phase 17 (pilot readiness, still no real transactions)**: (a) a separately authorized hosted application of 028, using the rehearsal above and the established manifest-style rehearsal and read-only baseline; (b) record the 2023 and 2024 All-Star Game and deadline dates in `season_calendar_events` from a permitted, cited source (a handful of rows), and confirm the pilot windows; (c) build the internal read model and the `/transactions/[id]` page for **verified-complete trades only** with the completeness badge and gap list, tested on fictional data; (d) prepare the sourcing sheet template and discovery list for the six drawn clubs (LAD, LAA, NYY, SD, HOU, CIN) using only sources cleared for local processing. Real sourcing and import wait for rights answers (blockers 1-3). Contracts, executives and evaluation tables remain later phases.
