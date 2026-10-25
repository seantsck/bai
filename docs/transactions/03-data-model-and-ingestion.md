# Proposed additive data model, identity and ingestion design

Proposal only: no migration is written or run. Numbers continue from 027 (028 onward). Everything is additive: no existing column is dropped or retyped, no published row is rewritten, and the 010/022/023 value views keep their meaning. Conventions carried over: unknown is NULL never zero; every fact has a `source_id` (and enters `provenance_fact_tables` so conflicts are kept as observations); RLS and `apply_public_boundary()` on every new table; humans only for verification and certification (`!~ '^agent:'`).

## 1. Changes to existing tables
| Change | Detail |
|---|---|
| `transaction_type` enum | add FREE_AGENT_SIGNING, CONTRACT_EXTENSION, OPTION_EXERCISED, OPTION_DECLINED, NON_TENDER, DESIGNATED_FOR_ASSIGNMENT, OUTRIGHT, SELECTED_FROM_MINORS, CLAIM_REJECTED. (Enum values only.) |
| `transactions` | add `announced_date date` (the existing `transaction_date` stays the effective date), `completeness transaction_completeness not null default 'UNVERIFIED'` (enum UNVERIFIED, PARTIAL, VERIFIED_COMPLETE), `completeness_note text`. Existing 65 rows become UNVERIFIED by default; none is claimed complete. |
| `trade_package_assets` | add `source_id` (per-asset evidence), `identity_state` (RESOLVED, UNRESOLVED_NAME_ONLY), `draft_selection_id` and `pick_descriptor jsonb` (year, round or CB code, protection text) to resolve DRAFT_PICK, `amount_status` (DISCLOSED, UNDISCLOSED), `condition_text`. A PLAYER asset still requires a player; an UNRESOLVED asset carries a name in `description` and cannot be silently dropped. |
| `acquisition_dispositions` | widen the "exactly one" check from (draft selection, international signing) to (draft selection, international signing, `trade_package_asset_id`, `contract_id`) so a trade or free-agent acquisition can have a tenure and an exit. The 022 guard is extended for these two channels; its existing rules are untouched. |
| `analytics.player_acquisitions` | add TRADE and FREE_AGENT rows (a `channel` value each), so 023's value views can include them; credited only when the acquisition and its tenure are established. |
| `ranking_lists.domain` | allow a TRADE-time prospect list (enum value), reusing 005's dated lists and its rule that only evidence published before an event may be linked to it. |
| `coverage_domain` | TRANSACTIONS already exists; add a `research.channels` row for it. |
| `ingest.batch_channel` / `staged_records` | add channel TRANSACTIONS and record type TRANSACTION (023 added TRADES / TRADE; the old pair stays valid). |

## 2. New tables
```
transaction_external_ids (transaction_id, source_id, id_system text, external_id text,
                          unique (id_system, external_id))       -- stable key per source; no date heuristics
transaction_verifications (id, transaction_id, verified_by text check (!~ '^agent:'), verified_at,
                          basis jsonb,                            -- parties, asset list, sources compared
                          package_fingerprint text,               -- hash of packages + assets + participants
                          revoked_at, revoked_by, revoke_reason)  -- one active per transaction (partial unique)
transaction_participants (id, transaction_id, organization_id, player_id null, role, from_org, to_org,
                          source_id)                              -- non-trade events only (check type <> 'TRADE')
ptbnl_resolutions (trade_package_asset_id unique, named_player_id, named_on date, source_id)
contracts (id, player_id, organization_id, kind, signing_transaction_id, signed_on, status, source_id)
contract_terms (id, contract_id, term_kind, season null, amount_usd null, years int null, detail text,
                as_of_date, source_id)          -- term_kind: BASE_SALARY, SIGNING_BONUS, DEFERRAL, INCENTIVE_MAX,
                                                -- CLUB_OPTION, PLAYER_OPTION, MUTUAL_OPTION, BUYOUT, OPT_OUT, NO_TRADE, ...
people (id, full_name, slug) ; person_external_ids (person_id, id_system, external_id)
organization_roles (id, person_id, organization_id, role, start_date, end_date, precision, source_id,
                    exclude using gist (organization_id with =, role with =, daterange with &&) where (sole_holder))
decision_attributions (id, transaction_id, person_id null, organization_id, attribution_kind, source_id, locator)
season_calendar_events (id, season, event_kind, event_date, source_id)   -- trade deadline, opening day, ...
club_standing_snapshots (id, organization_id, as_of_date, wins, losses, source_id)   -- optional, from a cleared source
evaluation_runs (id, spec_version, kind, transaction_id, organization_id, information_cutoff_date, as_of_date,
                 inputs_fingerprint, status, created_by)
evaluation_components (id, run_id, component_key, state, value numeric null, unit, assumption_ref, note)
```
Rules enforced in the database, not by convention:
- **VERIFIED_COMPLETE requires an active verification** whose `package_fingerprint` equals the current fingerprint; any later change to a package, asset or participant downgrades the transaction to PARTIAL by trigger, as `research.on_evidence_change` already does for certifications.
- **No score column.** `evaluation_components` stores observed, not-observed, not-applicable or assumption-bound components, each with its source or assumption; there is no field for a composite score or rank in this phase.
- **Decision-time runs cannot see the future**: a deferred trigger rejects a decision-time component whose cited observation has `observed_on` or `published_date` later than the run's `information_cutoff_date` (the same shape as 007's rule for expectations).
- **`decision_attributions` never derives from `organization_roles`.** A row needs a source that states who made, approved or negotiated the decision; a job title yields only attribution_kind `ORGANIZATIONAL`. Role tenure is context, never proof (see `04`).
- Contract money: NULL means unknown or undisclosed (never zero), `amount_status`-style flags where a source says "undisclosed", deferred and incentive amounts kept as separate terms, never netted into one figure.

## 3. Identity design
- **Players**: unchanged. Strong ids (MLBAM, then BBREF/FanGraphs/RETROSHEET with corroboration) only; no merging by name; held when ambiguous (the existing tiers VERIFIED, SINGLE_SOURCE, AMBIGUOUS). A trade may introduce a player only by strong id (existing rule). A minor leaguer with no strong id stays an `UNRESOLVED_NAME_ONLY` asset: the package is recorded, flagged, and cannot become VERIFIED_COMPLETE until resolved or explicitly acknowledged as unresolvable by the verifier.
- **Transactions**: identity is `(source, external id)` when a source provides one; otherwise a BAI key `type:date:sorted-clubs:sorted-asset-ids` assigned at import. Two same-day, same-club-pair trades are never merged automatically; the collision preview lists them for a human (as the draft preview does for players).
- **Assets**: draft picks resolve to a `draft_selection` once the pick is made; before that they are `pick_descriptor`. A PTBNL resolves through `ptbnl_resolutions`; an unresolved PTBNL keeps the package PARTIAL.
- **Organizations**: franchise keys already in `organizations` (30 current clubs); historical names via `organization_names`. Relocations and defunct franchises are out of scope for the pilot.
- **People** (executives): separate identity space with its own ids; the link to a transaction is evidence-based (`decision_attributions`), never inferred from a date range.

## 4. Ingestion procedure (reuses the manifest-bound release flow from the draft work)
1. **Source gate**: each source and use must have a grant (`sources.json`), or the record stays local. Hosted publication of MLB, Baseball-Reference and other-publication categories stays blocked by the hosted guard until a grant row exists.
2. **Stage** transaction records (new record type) from files a human or a reviewed script prepared; validate shape, strong ids, party/asset arithmetic, dates and `source_key`s (extension of `import-format.mjs`).
3. **Build a release** (`release.mjs build`): immutable manifest with SHA-256, per-club or per-season batches, holds with reasons, no signing/contract data unless its own source and grant exist.
4. **Verify and preview read-only against hosted**: external-id collisions, same-day same-pair trades, player strong-id collisions, unresolved assets, permission state; require SAFE, hold the rest.
5. **Rehearse** on a disposable PostgreSQL 17 copy: deltas, replay idempotence, integrity violations 0, 022/023 guard behavior, no change to existing audits or to international data, security checks.
6. **Apply** only with an explicit owner authorization naming the checksum, the target and the operator (as now); atomic; one `ingest.release_audits` row; read-model refresh; hosted verification; public smoke checks.
7. **Completeness verification** is a separate human step, after import, recorded in `transaction_verifications`; import never sets VERIFIED_COMPLETE.

## 5. Example record (illustrative shape only, fictitious values)
```json
{ "type": "TRANSACTION", "transaction_type": "TRADE", "date": "2024-07-30",
  "external_ids": [{"id_system": "SOURCE_A", "external_id": "..."}],
  "packages": [
    { "from": "AAA", "to": "BBB", "players": [{"player": {"external_ids": {"MLBAM": "..."}}}],
      "other_assets": [{"asset_type": "CASH", "amount_status": "UNDISCLOSED"}] },
    { "from": "BBB", "to": "AAA", "players": [{"player": {"external_ids": {"MLBAM": "..."}}}],
      "other_assets": [{"asset_type": "PLAYER_TO_BE_NAMED", "condition_text": "..."}] } ],
  "sources": ["..."], "completeness_claim": "NONE" }
```
`completeness_claim` can only be NONE at import.

## 6. Tests the implementation phases must add
Constraint tests (one per rule in section 2, including the future-information trigger and the title-is-not-attribution rule); importer tests for multi-team, same-day collisions, PTBNL, unresolved assets and cash undisclosed vs zero; migration tests on a disposable database with replay; the existing 010/022/023 test suites unchanged; a cross-class double-count test for traded assets; permission-gate tests for each new source category; security tests (anon/authenticated denied on all new tables); and deterministic fixtures for the evaluation components.
