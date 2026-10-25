# Phase 15D: bounded pilot (2023 and 2024 trade deadlines), public view and report

Proposal only. Nothing is built, imported or applied. The pilot is deliberately small and **defined by rule, not by fame**, so a result cannot be an artifact of picking memorable trades.

## 1. Population rule
- **Windows:** the trade-deadline window of 2023 and of 2024. Dates (deadline day, All-Star Game, window start) are recorded in `season_calendar_events` from a cited source before anything else is built. Proposed window: the day after the All-Star Game through deadline day.
- **Clubs:** the Los Angeles Dodgers plus five clubs chosen **deterministically in advance**: sort the 29 other franchise keys by SHA-256 of `"phase15|" + key` and take the first five. The seed string and result are written to the pilot plan before sourcing starts (no later swaps).
- **Transactions:** **every** trade involving one of the six clubs inside either window (not just the famous ones). Every counterparty and every asset in each of those trades is recorded, including counterparties outside the six clubs; the counterparty's other trades are out of scope. Non-trade transactions and contracts are out of scope for the pilot.
- **Expected size:** a few dozen transactions. The pilot reports the actual count after discovery; it does not choose the sample to fit a number.
- **Illustration only:** well-known deadline trades such as the 2023 Verlander and Scherzer trades or the 2024 Jack Flaherty trade (recalled, **unverified**) may or may not fall into the drawn clubs; they are included only if the rule selects them.

## 2. Sourcing and completeness
Each transaction needs, before it can be marked `VERIFIED_COMPLETE`:
1. **Two independent sources** that agree on the set of parties, every asset, cash status, the PTBNL/conditions text and the date: one primary announcement (a club or league release, used individually and non-bulk, cited by URL) and one independent publication or reference. Sources without a publication grant stay local and are never committed (the repository is public).
2. **Every player asset resolved by a strong id** (MLBAM from the Chadwick register, corroborated by Wikidata where present). A minor leaguer with no strong id is recorded as `UNRESOLVED_NAME_ONLY`; the transaction stays `PARTIAL`.
3. **Cash** stated as DISCLOSED (amount) or UNDISCLOSED; never zero by default.
4. **PTBNL and conditional pieces** resolved, or the transaction stays `PARTIAL` with the open item listed.
5. A **human verifier** (not an agent) records the verification; the system never sets completeness on import.

**Club-window completeness** (is this every trade the club made?) is a separate claim. Without a cleared source that enumerates the population, the club-window coverage class stays `PARTIAL_RECONSTRUCTION` and the report says so. Resolving it is rights decision (a) in `02`.

## 3. Schema subset for the pilot (from `03`)
`transactions.completeness` (+ note), `transaction_external_ids`, `transaction_verifications`, `trade_package_assets` additions (`source_id`, `identity_state`, `draft_selection_id` / `pick_descriptor`, `amount_status`, `condition_text`), `ptbnl_resolutions`, `season_calendar_events`, the enum additions needed for these records, and the TRANSACTIONS importer channel. Contracts, people/executives, evaluation tables, standings snapshots and non-trade types are **not** part of the pilot. Realized components (B1, B3, B6) come from the existing 023 views; the pilot adds a read-only report generator, not a scoring system. Decision-time (A) is limited to descriptive context (date, horizon class where evidenced, published prospect rankings if cleared); no projection-based component is attempted.

## 4. Ingestion procedure
1. Verify and record calendar dates and the club draw (plan file, committed).
2. **Discovery list** per club-window from cited sources (local, gitignored).
3. **Sourcing sheets** in a staging CSV (same pattern as `csv-draft.mjs`: identity VERIFIED only with a strong id plus corroboration; duplicates hold every row; a source is the supplier's claim; signing or contract facts, if supplied, stay proposals).
4. `release.mjs build` for TRANSACTIONS: immutable manifest, SHA-256, holds with reasons.
5. `verify`, then read-only hosted `preview` (external-id collisions, same-day same-pair trades, strong-id collisions, unresolved assets, permissions), then disposable-database **rehearsal** (deltas, replay idempotence, integrity 0, 022/023 guards, audits and international data unchanged, security).
6. Owner authorization naming checksum, target and operator; atomic apply; read-model refresh; hosted verification; smoke checks.
7. Human completeness verification as its own recorded step.
8. Generate the report.

## 5. Tests
- Schema: each constraint in `03` section 2 (completeness downgrade on change, verification must be human, no composite column, future-information trigger, title-is-not-attribution).
- Importer: multi-team trade, same-day same-pair collision, PTBNL pending/named, unresolved asset, cash undisclosed vs zero, draft-pick asset, duplicate external id, permission gate per source category.
- **Incomplete versus verified-complete** (the pilot's key requirement): a transaction with one unresolved asset, a missing second source, a pending PTBNL, or an edit after verification must read PARTIAL; only a fully sourced, resolved, human-verified package reads VERIFIED_COMPLETE; rollups and views exclude non-complete rows and report their count.
- Value views: 023 behaviour unchanged (golden fixtures); no double counting; unknown never zero; provider separation.
- Public pages: render each completeness state, never print an unlabeled "complete", never show a score or rank; security tests for anon denial on new tables.

## 6. Public transaction detail view (`/transactions/[id]`)
- Header: date and type, parties, **completeness badge**: `Verified complete` (verifier and date, sources count) / `Incomplete record` (lists exactly what is missing: unresolved assets, pending PTBNL, one source only) / `Unverified`.
- One panel per package ("what X sent to Y"): players with links to BAI player pages, picks (resolved or descriptor), cash as amount or "undisclosed", PTBNL status, conditions in BAI's own words.
- **What happened next** (realized, per WAR provider, side by side, with coverage state and as-of date): value received while with the club, value the outgoing players produced elsewhere shown beside it (never netted), later trades of acquired players (depth 2), open/closed status of the evaluation window.
- A "What we do not know" list generated from the NOT_OBSERVED components and holds.
- Sources with attribution lines and permission-aware wording; no source text reproduced.
- **No score, grade, winner or ranking.** A fixed note explains that absence is not a failed outcome.
- Index `/transactions`: filter by season, club, type, completeness, horizon; a coverage banner built the same way as `/draft/years` (documented vs represented, held, not listed) that appears only once rows exist; `/transactions/coverage` explains populations and gates.

## 7. Initial forensic report (generated, deterministic, reproducible from the database)
1. Scope: windows, draw seed and clubs, population rule, counts discovered / imported / held / verified complete.
2. Source log: every source, authority, retrieval date, permission state per use.
3. Ledger: one row per transaction with parties, assets, completeness.
4. Transaction cards: sections 6's panels, per provider.
5. Realized components table with coverage labels; open vs closed.
6. Unknowns, conflicts and holds.
7. Method: spec version, provider, as-of date, inputs fingerprint, assumptions listed.
8. Standing statement: no rankings, no composite scores, partial populations are partial.
It is committed as a template and generator only; the generated output for non-cleared sources stays local.

## 8. Pilot exit criteria
At least one multi-package trade verified complete and at least one deliberately incomplete record shown as incomplete; zero integrity violations; replay idempotent; existing audits, draft data and international data unchanged; every displayed source covered by a grant; owner reviews the report before any further phase.
