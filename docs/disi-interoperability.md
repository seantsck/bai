# DISI interoperability

DISI (Dodgers International Signings Research Database, `~/projects/DISI`, v1.0.0) was studied read-only as a reference. BAI:

- does not modify DISI;
- does not connect to DISI's Supabase project or any DISI database;
- has migrated no DISI data.

This document classifies DISI concepts so that a later, deliberate migration can be planned.

## Classification

| Class | Meaning |
|---|---|
| **DIRECT** | Same concept, maps onto a BAI table/enum with little or no change |
| **GENERALIZE** | The concept carries over, but DISI hard-codes one organization, one channel or a narrower vocabulary |
| **DISI_SPECIFIC** | Meaningful only for the Dodgers-only study; BAI would re-derive it league-wide, if at all |
| **DO_NOT_MIGRATE** | Superseded, legacy, or conflicts with BAI rules |

## Identity and organizations

| DISI concept (migration) | Class | BAI target / note |
|---|---|---|
| `players` bio fields (001), slug (017) | DIRECT | `players`. DISI's nullable unique `mlb_id`/`bref_id`/`fangraphs_id` columns become `player_external_ids` rows |
| `player_aliases` (001) | DIRECT | `player_aliases` (alias_type vocabulary expanded) |
| `player_identity_resolutions` (020): RESOLVED / AMBIGUOUS / NEEDS_REVIEW / CONFLICT / NOT_FOUND … | GENERALIZE | Resolved rows → `player_external_ids`. The unresolved workflow should become a BAI identity-review table plus `research_tasks` (roadmap) |
| `research_source_conflicts` (018/020) | GENERALIZE | `source_observations` + `v_source_conflicts` (field-level); conflict types become `quality_flags.flag_code` |
| `organizations.franchise_key` (016) | GENERALIZE | `organizations.franchise_key` (DISI used `'DODGERS'`; BAI uses a frozen 2–4 letter code such as `LAD`) |
| `disi_ascii_fold`, `disi_slugify` | DIRECT | `normalize_name` (same fold idea) |

## Sources, evidence, provenance

| DISI concept | Class | BAI target / note |
|---|---|---|
| `sources` (001) | DIRECT | `sources` (adds `source_key`, `publicly_accessible`, `TEST_FIXTURE` type) |
| `evidence` (001) generic entity/field/source | GENERALIZE | `source_observations` (typed status, supersession, registered subject tables) |
| `source_tiers` (017) with authoritative_for | GENERALIZE | Not yet in BAI; planned as source precedence for conflict resolution |
| `outcome_evidence` (019) supports_fields | GENERALIZE | `source_observations` on `outcome_audits` / `mlb_debuts` fields |
| ACTIVE/RETRACTED + supersedes + guard triggers (029–034) | GENERALIZE | `observation_status` ACTIVE/SUPERSEDED/RETRACTED; extend to other append-only facts when ingestion starts |
| `confidence_level` VERIFIED…UNVERIFIED | GENERALIZE | `relationship_verification` VERIFIED/REPORTED; per-observation confidence to be added if needed |

## Coverage and populations

| DISI concept | Class | BAI target / note |
|---|---|---|
| `signing_census_coverage` (012): COMPLETE_CENSUS, PARTIAL_CENSUS, TOP_PROSPECT_SAMPLE, HISTORICAL_VERIFIED | GENERALIZE | `coverage_assessments` with six states. Mapping: PARTIAL_CENSUS → PARTIAL_RECONSTRUCTION or SUBSTANTIALLY_COMPLETE (decided per scope), TOP_PROSPECT_SAMPLE → RANKED_SAMPLE, HISTORICAL_VERIFIED → INDIVIDUALLY_VERIFIED |
| `signing_populations` (018), `rate_analysis_suitable` only for FULL_SIGNING_PERIOD | GENERALIZE | `coverage_supports_population_rate()` (same rule: only full populations are rate denominators) |
| `signing_population_members` + member sources (018) | GENERALIZE | Planned population-membership tables when backfill begins (roadmap) |
| `signing_period_candidates` (018) | GENERALIZE | `research_tasks` (task_type such as `CLASSIFY_CANDIDATE`) |

## International

| DISI concept | Class | BAI target / note |
|---|---|---|
| Dodgers signings (`signings`) | GENERALIZE | `international_signings` for all 30 organizations |
| `acquisition_pathway` (LATAM_AMATEUR, CUBAN_PRO, POSTED_PLAYER, …) | GENERALIZE | `international_pathway` (4 values) + `market_id`/`birth_country`. DISI's market-specific pathways decompose into pathway × market |
| `signing_regime` (STANDARD_POOL, PENALTY_RESTRICTED, …) | GENERALIZE | `organization_signing_period_context.restriction_status` + pool fields |
| `international_signing_eras` (039) starts_on/ends_on | GENERALIZE | `international_signing_periods` (period-level, not era-level); eras can be a later grouping |
| Financial reports (030/031): component, amount_basis, evidence_basis, resolutions | GENERALIZE | BAI's four cost columns are the resolved values; multi-source amounts belong in `source_observations`. `amount_basis` (EXACT/ROUNDED/APPROXIMATE) should be added before backfill |
| `acquisition_cost_component_rules` applicability | GENERALIZE | Will document when a 0 is "known zero by rule" |
| `market_groups` (039) | GENERALIZE | `markets.region` |
| Network entities / relationships (029, 038) | GENERALIZE | `trainers`, `academies` and relationship tables. DISI's richer entity graph (agency, showcase league, OPERATES/MERGED_INTO) is a later extension |

## Outcomes, development, value

| DISI concept | Class | BAI target / note |
|---|---|---|
| `outcome_audits.outcome_state` (019): REACHED_MLB, NO_MLB_CAREER_ENDED, NO_MLB_ACTIVE_IN_MINORS, NO_MLB_STATUS_UNKNOWN; UNAUDITED in views | GENERALIZE | `outcome_audit_state`. Mapping: REACHED_MLB → AUDITED_REACHED_MLB, NO_MLB_CAREER_ENDED → AUDITED_NO_MLB, NO_MLB_ACTIVE_IN_MINORS → ACTIVE_TOO_RECENT (or AUDITED_NO_MLB with through-season), NO_MLB_STATUS_UNKNOWN → UNKNOWN |
| `player_professional_progress` (019) | GENERALIZE | Derivable from `player_assignments` / `development_events` |
| `player_metric_observations` CAREER_BWAR/FWAR (017) | DIRECT | `war_observations` scope CAREER |
| `player_mlb_team_season_war` (032) | GENERALIZE | `war_observations` scope SEASON / ORGANIZATION_TENURE |
| `bref_team_code_map` (032) | GENERALIZE | Organization aliases / external codes |
| `player_season_stints` (021), `development_levels`, era map | GENERALIZE | `player_assignments`, `development_level`, `affiliate_seasons` |
| `development_progression_decisions` (024) | GENERALIZE | Later: curated progression decisions on top of chronology |
| Pathway classifications (037: FAST_TRACK, STALLED, …) | GENERALIZE | Analytics-layer views later; must not infer reasons |
| `transaction_events` / assets / resolutions (009, 033) | GENERALIZE | `transactions`, `trade_packages`, `trade_package_assets` |
| Lineage views (034), `v_player_organizational_realization` | GENERALIZE | `organization_value_attributions` + analytics views |
| `attributable_value_basis` (DIRECT_ONLY, …SOLE_OUTGOING_RETURN, SHARED_PACKAGE_RETURN_EXCLUDED) | GENERALIZE | `value_class` (PLAYER_ATTRIBUTABLE_DOWNSTREAM vs PACKAGE_ATTRIBUTABLE vs OBSERVABLE_NOT_ATTRIBUTABLE) |
| `dodgers_control_observations`, FIRST/LAST_DODGERS_APPEARANCE (033/034) | DISI_SPECIFIC | Re-derive league-wide as control intervals per organization |
| DIRECT_DODGERS_MLB_VALUE / DIRECT_DODGERS_BWAR (042) | DISI_SPECIFIC | `value_class = DIRECT_ACQUIRING_ORGANIZATION` for any org |

## Expectations, models, product

| DISI concept | Class | BAI target / note |
|---|---|---|
| `scouting_publications`, `player_evaluations`, grades, rankings (026) | GENERALIZE | `ranking_lists`, `ranking_entries`, `evaluations`, `evaluation_grades` (with domain) |
| `scouting_expectation_bands`, comparison states (036) | GENERALIZE | Later analytics. BAI's hindsight guard (`acquisition_expectation_links`) is the prerequisite |
| Archetypes / comparables (040) | DISI_SPECIFIC | Revisit only after league-wide census coverage exists |
| Outcome probability models (041), `outcome_targets` DODGERS_ONLY | DO_NOT_MIGRATE | Explicitly out of scope (no predictive probabilities). The *gates* (min N, leave-one-year-out validation) are kept as methodology |
| Expected value / portfolio scenarios (042–044) | DO_NOT_MIGRATE | Depend on 041 |
| Product snapshots + refresh + drift check (045a) | GENERALIZE | `rm_*` read models + `refresh_read_models()`; a drift check is on the roadmap |
| `disi_product_contract` (045) | GENERALIZE | Later: route ↔ relation contract for the public surface |
| Public view grant hardening (025), RLS on every table, security_invoker views | DIRECT | Applied from 011; tests assert RLS on every table, security_invoker on every view, SELECT-only grants |
| PG17 release validators (`database/release/pg17`) | GENERALIZE | `tests/db` already replays on PG17; bundle/rollback validators come with the first production release |

## Legacy / do not migrate

| DISI concept | Class | Reason |
|---|---|---|
| `002_dodgers_seed_cohort.sql` and other Dodgers seed rows (013, 019, 021, 022, 026, 030) | DO_NOT_MIGRATE (today) | No data migration in the foundation. A later import must go through BAI ingestion with fresh provenance and coverage rows, not a table copy |
| `outcomes` (001, legacy flat outcome table) | DO_NOT_MIGRATE | Superseded by audits + debuts + WAR observations |
| `signing_environments` (001, legacy) | DO_NOT_MIGRATE | Superseded by period context + financial reports |
| legacy `trainers` / `player_trainers` (001) | DO_NOT_MIGRATE | Superseded in DISI by network entities (029) |
| All `v_dodgers_*` views | DISI_SPECIFIC | Single-organization presentations |

## Future migration approach (not started)

1. Export DISI facts with their sources as files, using read-only access on a **local restore**, never production.
2. Map identities through external ids (MLBAM first). Name-only matches become research tasks.
3. Import as BAI observations with `source_key`s that preserve DISI provenance, and add coverage rows that match what DISI actually established.
4. Re-run BAI's checks. Nothing from DISI bypasses BAI constraints.
