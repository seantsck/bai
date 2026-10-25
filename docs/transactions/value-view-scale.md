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
3. **`class_value` re-evaluates `acquisition_value` and `acquisition_economics` per group.** Its two per-group scalar subqueries (`trade_return_war_known`, `trade_packages_shared`) reference `acquisition_value` and, for each sent player of each package, `analytics.acquisition_economics` again (29,050 evaluations of that view on a database the size of BAI's, 9.7 s by itself). Filtering by club pushes down into the old definition (30 per-club runs sum to 6.4 s at 65 trades, 42 s at 401), but the whole view in one statement does not finish.

PLAN_TABLE

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

PARITY_TABLE

## 5. Performance
Hardware: HARDWARE. Fixed inputs: a 30,604-row read-only snapshot of hosted (92 tables, sha256 SNAPSHOT_SHA) and the local candidates batch (sha256 BATCH_SHA). Databases (`scripts/db/bench/`): `bai_base` (65 trades), `bai_scale` (401 trades, the 336 candidates applied by the real importer), `bai_all_opt` (667 trades: all three period batches, a load test). Median of 3 plain executions (no EXPLAIN overhead).

BENCH_TABLE

## 6. Gate result
GATE_RESULT

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
