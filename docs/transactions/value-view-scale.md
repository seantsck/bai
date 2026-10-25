# Value-view scale: diagnosis, optimization (migration 029), parity and benchmarks

Status: **implemented locally, validated on disposable databases, not deployed.** Migration 029 changes three analytics views only (no table, no data, no grant). It is stacked on migration 028 (PR #38, draft) and is not applied to hosted. No hosted write occurred; hosted was only read, through read-only transactions, to build a fixed input snapshot. No competing committed migration exists: `origin/main` ends at 027, 028 exists only on the Phase 16 branch, and no remote branch contains a 029 or later file.

## 1. The measurements that started this
The Phase 17 rehearsal imported the 336 local Retrosheet trade candidates onto a disposable copy of hosted data (65 trades, then 401). With 6 times the trades:

| | 65 trades | 401 trades |
|---|---|---|
| `trade_returns` (all rows) | 0.4 s | 12.7 s |
| `acquisition_value`, a fixed 15-player sample | 11.8 s | 266 s |
| `acquisition_value`, whole view | minutes | did not finish in 45 minutes |

## 2. Root cause (from `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`; plans are kept in the local benchmark results)
Reproduced on the fixed snapshot (below): 0.4 s, 10.9 s and 12.7 s, 368 s (the 368 s run shared the machine with another job; 266 s is the quiet figure).

1. **`player_war_coverage` is evaluated once per `trade_returns` row, for every player.** `trade_returns` computed `return_war_known` and `return_coverage` with correlated subqueries that join `analytics.player_war_coverage`. That view is built per player (`players x provider`, with a LATERAL lookup of the career WAR as of the last season split) and the planner cannot push a filter into it, so each evaluation recomputes coverage for all 2,242 players. At 401 trades: **1,518 output rows x 2 subplans, about 3.47 million inner `Limit / Sort / Index Scan on war_observations` loops, 662,461 buffer hits, 12.7 s.** The cost grows with rows x players, i.e. superlinearly (166 rows: 0.4 s; 1,518 rows: 12.7 s).
2. **`acquisition_value` evaluates the whole of `trade_returns` for every acquisition row.** It joins `trade_returns` as `left join ... on e.disposition = 'TRADED' and ...`; the planner chose a nested loop with `trade_returns` as the inner side, so the whole view, select-list subplans included, ran once per outer row (28 outer rows x 166 trade-return rows = 4,648 loops of the coverage subplan at 65 trades). Total: outer rows x (cost of item 1). The 15-player sample went from 10.9 s to 266-368 s, with **18.7 million buffer hits**; a whole-view run is 3,176 outer rows x 1.5-13 s, i.e. hours.
3. **`class_value` evaluates `trade_returns` once per group.** Its two per-group scalar subqueries (`trade_return_war_known`, `trade_packages_shared`) read `trade_returns` (and `acquisition_value`, `acquisition_economics`), so cause 1 runs once per group. For LAD at 401 trades: 28 groups, the coverage subplan 6,073 times, 13.9 million inner lookups, 30 s of the 31 s; at 65 trades 2.8 s. (The whole `class_value` still completes in one statement at 401 trades, 21.8 s, because a club filter and the group keys push down; it is the same cause, smaller multiplier.)

| Query | Dataset | Execution (EXPLAIN ANALYZE) | Buffers hit / read | Temp blocks read / written | Most-repeated scans (loops) |
|---|---|---|---|---|---|
| `trade_returns_full` | old, 65 trades | 0.44 s | 45,777 / 46 | 0 / 0 | war_observations x175,865, outcome_audits x3,224 |
| `acquisition_value_sample15` | old, 65 trades | 10.85 s | 749,951 / 62 | 0 / 0 | war_observations x4,842,195, outcome_audits x5,164 |
| `class_value_lad` | old, 65 trades | 2.77 s | 553,201 / 7 | 0 / 0 | war_observations x672,464, outcome_audits x76,628 |
| `trade_returns_full` | old, 401 trades | 12.89 s | 662,461 / 66 | 0 / 0 | war_observations x5,714,707, outcome_audits x4,484 |
| `acquisition_value_sample15` | old, 401 trades | 368.29 s | 18,722,603 / 62 | 0 / 0 | war_observations x171,318,089, players x84,009 |
| `class_value_lad` | old, 401 trades | 31.36 s | 1,956,909 / 7 | 0 / 0 | war_observations x14,273,716, outcome_audits x79,148 |
| `trade_returns_full` | new, 65 trades | 0.05 s | 9,915 / 0 | 0 / 0 | war_observations x4,839, outcome_audits x1,612 |
| `acquisition_value_sample15` | new, 65 trades | 0.11 s | 23,733 / 0 | 0 / 0 | war_observations x9,862, outcome_audits x3,552 |
| `class_value_lad` | new, 65 trades | 1.02 s | 125,650 / 0 | 0 / 0 | war_observations x21,574, outcome_audits x18,824 |
| `trade_returns_full` | new, 401 trades | 0.05 s | 14,057 / 0 | 0 / 0 | war_observations x6,729, outcome_audits x2,242 |
| `acquisition_value_sample15` | new, 401 trades | 0.15 s | 32,154 / 0 | 0 / 0 | war_observations x13,644, outcome_audits x4,816 |
| `class_value_lad` | new, 401 trades | 1.87 s | 142,099 / 0 | 0 / 0 | war_observations x27,246, outcome_audits x20,718 |

Row-estimate errors (the planner estimated 1 row for subplans that return thousands) and no temporary-disk use were the pattern: this was repeated evaluation, not memory or disk pressure.

## 3. What migration 029 changes (same columns, types and meaning)
Set-based aggregation, each expensive input evaluated once. No stored data, no materialized table, no change to what is counted:
- **`trade_returns`**: the received players, their departure season (next time the club sent them away) and the WAR coverage of every received player are joined once and aggregated per (transaction, organization, provider); no correlated subquery remains in the select list. `received_player_ids`, `return_war_known` and `return_coverage` keep their exact definitions (known WAR is 0 only when every received player is accounted for and produced none; NULL when nothing was observed; COMPLETE / PARTIAL / NO_PLAYERS_RECEIVED).
- **`acquisition_value`**: the 023 definition, with `trade_returns` evaluated once (a `MATERIALIZED` CTE).
- **`class_value`**: `acquisition_value`, the trade-return columns and `acquisition_economics` are evaluated once; the two per-group subqueries become grouped joins over the distinct packages that ended each class's acquisitions (a package still counts once per class; sharing with another class is still flagged).
Preserved: every output column and its meaning; WAR-provider separation; complete / partial / not-observed coverage; no double counting across acquisitions or packages; original acquisition tenure boundaries (acquisition and exit seasons); later trades (the next-departure season) and PTBNL effective dates (a resolved PTBNL counts from its naming season); no other club's WAR attributed to the acquiring club.

Indexes were investigated and are not needed: the dominant cost was repeated evaluation, not scans (the war-observation lookups are already index scans on `war_observations_player_idx`); adding indexes would not have removed the repeated evaluation. A materialized read model was investigated and rejected: ordinary views scale once evaluation is single-pass, and a stored copy would break read-after-write for the existing importer and tests.

## 4. Exact output parity
Method: dump each view as canonical JSON text (one row per line, sorted by the row's own text, so NULLs, coverage states, array contents, package attribution and numerics all take part), compare line by line, and require identical column names and types. A timeout is reported as NOT COMPLETED and counts as a failure, never as verification. The old whole views cannot finish at 401 trades, so the old semantics are reproduced three ways: (a) **direct** old-view runs where they finish (everything at 65 trades; the bounded 15-player sample and the per-club `class_value` union at 401); (b) a **reference** (`scripts/db/bench/make-reference.mjs`): the old `acquisition_value` and `class_value` text verbatim, reading the old `trade_returns` output from a table computed once, which differs from the old views only by evaluating that input once (its agreement with the direct old runs is checked); (c) the **fixture test** `tests/db/value-view-parity.test.mjs`, two databases (migration 028 vs 029) fed identical fictional data: both providers, two-club, three-club and multi-player packages, a PTBNL named after the trade, a player traded away and returning, a cash-only trade, a NO_MLB return, unobserved, career-only and partial coverage.

| Comparison | View | Result | Rows old / new | Time old -> new |
|---|---|---|---|---|
| Full views, 401 trades, versus the reference | `trade_returns` | IDENTICAL | 1518 / 1518 | 0.037 s -> 0.083 s |
| Full views, 401 trades, versus the reference | `acquisition_value` | IDENTICAL | 3176 / 3176 | 1.086 s -> 1.108 s |
| Full views, 401 trades, versus the reference | `class_value` | IDENTICAL | 350 / 350 | 2.571 s -> 1.154 s |
| Whole `class_value`, 401 trades, old view run per club vs new | `class_value` | IDENTICAL | 350 / 350 | 42.185 s -> 1.212 s |
| OLD views run directly, 401 trades (full `trade_returns`; `acquisition_value` bounded to the 15-player sample) | `trade_returns` | IDENTICAL | 1518 / 1518 | 8.658 s -> 0.076 s |
| OLD views run directly, 401 trades (full `trade_returns`; `acquisition_value` bounded to the 15-player sample) | `acquisition_value` (bounded) | IDENTICAL | 30 / 30 | 247.797 s -> 0.13 s |
| Full `trade_returns` and `acquisition_value`, 65 trades, old view run directly | `trade_returns` | IDENTICAL | 166 / 166 | 0.321 s -> 0.068 s |
| Full `trade_returns` and `acquisition_value`, 65 trades, old view run directly | `acquisition_value` | IDENTICAL | 3176 / 3176 | 743.914 s -> 0.734 s |
| Whole `class_value`, 65 trades, old view run per club vs new | `class_value` | IDENTICAL | 350 / 350 | 6.37 s -> 0.745 s |

## 5. Performance
Hardware: AMD EPYC-Genoa Processor, 4 logical CPUs, 8.1 GB RAM, linux 7.0.0-38-generic, v22.22.1; PostgreSQL 17 (embedded), shared_buffers 512MB, work_mem 64MB. Fixed inputs: a 30,604-row read-only snapshot of hosted (92 tables, sha256 b7f8858c845232f86a63416890b354d0ab6c23094a59db8e1469b2ef215b17a1) and the local candidates batch (sha256 71cea0b73a367faceb861e1ffae6ea4b8b6f4ed3b489b47606d6c07bf04f0892). Databases (`scripts/db/bench/`): `bai_base` (65 trades), `bai_scale` (401 trades, the 336 candidates applied by the real importer), `bai_all_opt` (667 trades: all three period batches, a load test). Median of 3 plain executions (no EXPLAIN overhead).

| Query | Dataset | Old (028) | New (029) | Speed-up |
|---|---|---|---|---|
| `trade_returns_full` | 65 trades | 0.288 s | 0.031 s | 9x |
| `trade_returns_full` | 401 trades | 8.433 s | 0.061 s | 138x |
| `trade_returns_full` | 667 trades | - | 0.082 s | - |
| `acquisition_value_sample15` | 65 trades | 7.154 s | 0.087 s | 82x |
| `acquisition_value_sample15` | 401 trades | 251.536 s | 0.124 s | 2029x |
| `acquisition_value_sample15` | 667 trades | - | 0.14 s | - |
| `acquisition_value_full` | 65 trades | - | 0.703 s | - |
| `acquisition_value_full` | 401 trades | NOT COMPLETED > 600s | 1.126 s | old NOT COMPLETED > 600 s |
| `acquisition_value_full` | 667 trades | - | 1.454 s | - |
| `class_value_lad` | 65 trades | 1.884 s | 0.676 s | 3x |
| `class_value_lad` | 401 trades | 21.497 s | 1.118 s | 19x |
| `class_value_lad` | 667 trades | - | 1.681 s | - |
| `class_value_full` | 65 trades | 2.544 s | 0.69 s | 4x |
| `class_value_full` | 401 trades | 21.796 s | 1.179 s | 18x |
| `class_value_full` | 667 trades | - | 1.873 s | - |
| `draft_only_class_value_lad` | 65 trades | 1.842 s | 0.668 s | 3x |
| `draft_only_class_value_lad` | 401 trades | 21.671 s | 1.126 s | 19x |
| `draft_only_class_value_lad` | 667 trades | - | 1.658 s | - |
| `draft_explorer` | 65 trades | 0.006 s | 0.004 s | 2x |
| `draft_explorer` | 401 trades | 0.006 s | 0.004 s | 2x |
| `draft_explorer` | 667 trades | - | 0.004 s | - |

## 6. Gate result
| Target | Result |
|---|---|
| At least 10x faster than the measured 266 s bounded `acquisition_value` query | **Met: 0.12 s at 401 trades (about 2,000x; 251.5 s measured quiet in this run, 247.8 s in the direct parity run)**, 0.14 s at 667 trades |
| Full `acquisition_value` completes in a practical bounded time | **Met: 1.1 s at 401 trades, 1.5 s at 667.** The old view did not complete within 600 s (and not within 45 minutes in the earlier rehearsal); at 65 trades it took 744 s |
| Full `class_value` completes without exhausting disk or timing out | **Met: 1.2 s at 401 trades, 1.9 s at 667, no temporary files.** (The old view took 21.8 s at 401 trades) |
| No major regression in `trade_returns` or draft-only queries | **Met:** `trade_returns` 0.06 s (old 8.4 s); draft-only `class_value` for LAD 1.1 s (old 21.7 s); `v_draft_explorer` unchanged (0.004 s) |
| Exact output parity | **Met:** every comparison above is IDENTICAL, none NOT COMPLETED |
| Unchanged elsewhere | 100 tables (historical drafts, release audits, international records and the rest) and the public draft / international / read-model views are identical before and after 029 (`scripts/db/bench/verify-unchanged.mjs`) |

**The performance blocker is removed.** What still blocks a production import is not performance: see `retrosheet-integration.md` section 10 (the hosted publication gate, migrations 028 and 029 needing separate authorization, a primary announcement and second source group per transaction, contract data and WAR permission). Bulk-import *performance* readiness: not blocked.

## 7. Reproduce
```
node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs      # one read-only transaction; writes the snapshot and its checksums
node scripts/db/bench/serve.mjs &                                           # persistent disk cluster (never /tmp)
node scripts/db/bench/build-datasets.mjs                                    # bai_base, bai_scale from the snapshot and the candidates batch
node scripts/db/bench/apply-029.mjs bai_scale bai_scale_opt                 # clone and apply the committed migrations
node scripts/db/bench/explain.mjs --db bai_scale_old --tag before           # EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON), bounded queries
node scripts/db/bench/bench.mjs --dbs bai_base_opt,bai_scale_opt --tag after-opt
scripts/db/bench/run-parity-suite.sh                                        # about 40 minutes: the old views are slow
```
