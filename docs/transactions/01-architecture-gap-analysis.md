# Phase 15A: architecture gap analysis

Planning only. Read-only audit of migrations 001-027, the importer and the hosted database on 2026-10-25. Nothing was changed, migrated, imported or deployed.

## What exists today (hosted, read-only counts)
| Structure | Migration | Hosted rows | Notes |
|---|---|---:|---|
| `transactions` (type enum: TRADE, RELEASE, WAIVER_CLAIM, RULE_5, PURCHASE, FREE_AGENT_DEPARTURE, OTHER) | 010 | 65, all TRADE | one date, one `source_id`, free-text description |
| `trade_packages` (one per direction: from club -> to club) | 010 | 83 | unique per (transaction, from, to) |
| `trade_package_assets` (PLAYER, PLAYER_TO_BE_NAMED, CASH, DRAFT_PICK, INTERNATIONAL_POOL_SPACE, OTHER) | 010 | 111 | cash amount only; draft picks are free text |
| `war_observations` (BREF / FANGRAPHS / OTHER; CAREER, SEASON, ORGANIZATION_TENURE) | 008 | 354 (all BREF) | per provider, never mixed; unknown is NULL |
| `organization_value_attributions` (value classes, no double counting) | 010 | 0 | defined, unused |
| `acquisition_dispositions` (how one acquisition ended, guarded against contradicting the trade) | 022 | 163 | draft and international acquisitions only |
| `analytics.trade_returns`, `acquisition_value`, `class_value`, `player_war_coverage`, `acquisition_tenures` | 022-023 | views | coverage-gated, never rates |
| `ranking_lists`, `ranking_entries`, `evaluations`, `evaluation_grades` (dated, structured) | 005 | - | the decision-time evidence model; domain limited to INTERNATIONAL / DRAFT |
| `player_assignments`, `development_events`, `affiliate_seasons` | 009 | - | level and season assignments, not contracts |
| `coverage_assessments`, `coverage_domain` already includes TRANSACTIONS | 004 | none for TRANSACTIONS | coverage states: COMPLETE_CENSUS ... |
| `research.classes` / `certifications` (class = club x channel x draft, signing period **or season**) | 019 | 0 certified | human-only certification, fingerprint, revocation |
| `ingest` batches, `TRADES` channel, `TRADE` record type, source-publication guard | 013, 023, 025 | - | validated import; guard refuses new MLB / B-Ref / other-publication records without a grant |
| `source_observations` + `fact_resolutions` (conflicts kept) | 003, 012 | many | the provenance backbone |
| `players`, `player_external_ids` (MLBAM 1,432; BBREF 504; FANGRAPHS 269; id system list already has RETROSHEET) | 001 | 1,612 after 2024 | identity tiers, never merged by name |

Not present: any contract, salary, option, extension, payroll, executive or leadership-tenure table; any external transaction id; any completeness state for a transaction.

## Capability by capability
| # | Capability | Verdict | What can be reused | Concrete gaps |
|---|---|---|---|---|
| 1 | Complete two-team and multi-team trade reconstruction | **Partly supported** | `transactions` + one `trade_packages` row per direction handles any number of clubs; asset types; strong-id players; per-package returns in `trade_returns` | (a) no stable external id: the importer matches an existing transaction by date and type (`pipeline.mjs` ~line 691), which cannot separate two same-day trades of one club pair; (b) no per-package or per-asset source (one `source_id` per transaction); (c) no completeness state, so a partial record looks like a whole trade; (d) PLAYER_TO_BE_NAMED is never linked to the player later named; (e) DRAFT_PICK is text, not a link to a pick or draft class; (f) cash has no currency, direction note or "undisclosed vs zero" distinction beyond NULL; (g) the importer takes one importing club and requires it to be a party, so a trade is entered once per club unless de-duplicated; (h) conditional deals, options and later adjustments have nowhere to live |
| 2 | Trade-deadline acquisition evaluation | **Foundation only** | transaction date, `trade_returns`, season WAR splits with the organization, `player_war_coverage` | no deadline date per season, no standings or playoff-odds context at the date, no roster-status or contract fields at the date, WAR is only observed after the fact (fine for outcome, forbidden for decision-time), no rental/long-term horizon fields; calendars (015) cover drafts and international periods only |
| 3 | Free-agent signing and contract accounting | **Missing** | `transactions` could hold the event; `source_observations` for each figure; `organizations`; money conventions (null, never zero) | no contract entity, no years/AAV/total/deferrals/opt-outs/buyouts/incentives, no salary-by-season, no luxury-tax or arbitration status, no present-value fields; transaction type enum lacks FREE_AGENT_SIGNING, EXTENSION, OPTION_EXERCISED/DECLINED, NON_TENDER, DFA, OUTRIGHT, SELECTED_FROM_MINORS |
| 4 | Extensions, options, remaining team control | **Missing** | `acquisition_tenures` shows a tenure end known/unknown | needs a contract-term table with dated terms and a derived "team control through" with its evidence; service-time is not recorded |
| 5 | Waivers, releases, non-tenders, other roster decisions | **Enum only** | types RELEASE, WAIVER_CLAIM, RULE_5, PURCHASE exist; dispositions already name LOST_WAIVERS, LOST_RULE_5, RELEASED, LEFT_AS_FREE_AGENT | the importer links only TRADE transactions to players (`import-format.mjs` ~188: "only TRADE transactions can be linked to a player"); no participant table for non-trade events; the 022 guard is trade-aware only |
| 6 | Executive and organizational leadership tenures | **Missing** | `organizations`, dated-interval and no-overlap patterns (btree_gist is installed), `sources` | no person entity for non-players, no role/title, tenure, reporting line or decision-authority evidence; attribution of a decision to a person is a separate evidence class |
| 7 | Transaction-by-transaction outcome evaluation | **Partly supported** | `trade_returns` (package-level, per provider, coverage-labelled), `acquisition_value`, `class_value`, `organization_value_attributions` with no-double-count constraint, `value_class` including VALUE_LEFT_ORGANIZATION | outcomes exist only for packages that end an acquisition we hold; no evaluation of what the club **gave up** as a whole package; chains deeper than one trade not computed (the attribution proposal says depth 2); no cost side (salary), so no net-of-cost value |
| 8 | Coverage-gated front-office rankings | **Mechanism exists, nothing to rank** | `coverage_state`, `coverage_supports_population_rate`, `research.classes` with `season`, human certification, class fingerprints, "no public rates from partial data" already enforced for drafts | no transaction coverage assessments; no rule for what a transaction population is; no executive entity; nothing may be ranked until all three exist |

## Findings that shape the design
1. **The value-attribution core is sound and reusable.** 010/023 already separate value classes, forbid double counting, never sum across providers, never treat unknown as zero, and give package-level returns. The proposal extends data; it does not replace these views.
2. **The weakest part is the transaction record itself**: no identity, no completeness, one source. Everything downstream (returns, evaluations, rankings) inherits that weakness, so Phase 15D is built around verifying a package as complete.
3. **Do not add a parallel scoring system.** Decision-time inputs already have a home (`ranking_lists`/`evaluations`, dated and structured, with a database rule that only evidence published before an acquisition can be linked); only their `domain` enum needs a value for trade-time prospect lists. Realized outcomes stay in `war_observations` and the 023 views.
4. **`research.classes` can already carry a season-scoped class** (`season` column), so a transaction coverage class (club x TRANSACTIONS x season) needs no new certification machinery, only a channel row and an eligibility function.
5. **Rights are the binding constraint, not the schema.** MLB's transaction wire and Baseball-Reference are `publish_site PENDING` (hosted `ingest.source_publication_grants` is empty, so the hosted guard refuses new records from those categories). See `02-source-rights-feasibility.md`.
6. **Hosted data is tiny for this purpose**: 65 trades from an earlier pilot, 354 WAR rows, no contracts. Nothing here can support a ranking today.

## Reuse decisions (and the concrete need behind each addition)
| Proposed addition (detail in `03`) | Why existing structures cannot do it |
|---|---|
| `transaction_external_ids` | a transaction needs a stable key from each source to be matched without date heuristics |
| `transactions.completeness` + `transaction_verifications` | no way today to tell a verified-complete package from a partial entry |
| `transaction_participants` (club, player or asset, role, from/to) | roster decisions that are not two-club trades have no packages |
| `ptbnl_resolutions` | a player to be named later must link to the player eventually named |
| `contracts`, `contract_terms` | no contract entity exists |
| `people`, `organization_roles` | no non-player person entity |
| `decision_attributions` | job title is not evidence of who decided |
| `evaluation_runs` / `evaluation_components` | to store the two assessments with their inputs, version and as-of date |
| enum additions (`transaction_type`, `ranking_list` domain, `coverage` channel) | enum values only, no new table |
