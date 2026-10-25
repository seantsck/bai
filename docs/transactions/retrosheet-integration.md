# Retrosheet historical acquisition integration (Phase 17)

> The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".

Status: **local research pipeline, validated on disposable databases. Nothing is deployed, migrated on hosted, imported to production, or published.** Hosted was only *read* (a read-only snapshot of BAI's own trades and ids, and a read-only copy of its data into a throwaway database). This branch is stacked on the Phase 16 draft PR (#38); neither PR #37 nor #38 is merged.

## 1. The source archive
- URL: `https://www.retrosheet.org/transactions/tranDB.zip`; format `readme.txt` at `.../transactions/readme.txt`; notice `https://www.retrosheet.org/notice.txt`.
- **Download:** none in this phase. The archive was downloaded **once**, in an earlier phase, through the bounded request recorded in `research/history/manifest.json` (retrieved 2026-10-22). The source catalog (`research/history/sources.json`, `retrosheet-transactions`) forbids re-downloading while the cache is valid, so this phase used that original, byte for byte, and verified it against the recorded checksum (`node scripts/research/retrosheet-transactions.mjs archive`).
- Archive SHA-256 `c5cd539f89991afa9a74fdc67b0f71e29413383792404013a2c69fdd450fd932`, 1,203,773 bytes. Inventory: `tran.txt` (6,252,868 bytes, sha256 `8b117abe4505dd427893c7fbc5af94f89d83cb58d93b96c99136bab1d7d31c06`, zip entry dated 2022-05-09) and `readme.txt` (6,953 bytes, identical to the separately cached readme). The archive and its extraction live in the gitignored `.local/retrosheet/`; `archive-manifest.json` there records every checksum.
- **Coverage:** 101,594 records, 1873 to 2022-02-27 (61 records in 2022, none later). The file says it will not be updated. *Correction to the Phase 15 notes:* they gave 2021-11-26 as the last upload and "ends 2020"; the archive itself runs to February 2022 (2021 has 2,213 records), so 2021 is present but is not part of this phase's window.
- **Format:** 16 quoted, comma-separated fields: primary date, time, approximate flag, secondary date, secondary approximate flag, transaction id, player, type, from team, from league, to team, to league, draft type, round, pick, info.
- **Dates:** `yyyymmdd`; day `00` = day unknown; month and day `00` = sometime before the season (possibly the previous year); `@` = a guess (not merely partial). The time field orders same-day rows (empty before games, 1 between, 2 after, also used off-season to order rows). The secondary date is used by draft rows (signing date).
- **Types:** 65 documented codes (trade `T`/`Tp`/`Tn`/`Tr`/`Tv`, conditional `C`/`Cr`, free agent `F`/`Fa`/`Fb`/`Fc`/`Fg`/`Fo`/`Fv`, waiver `W*`, release `R`, purchase `P*`, Rule 5 `D`, amateur draft `Da`/`Df`/`Dm`/`Dn`/`Dr`/`Ds`/`Dv`, expansion `X*`, roster status `H*`, `J`, `L`, `M`, `V`, `Z`, assignment `A`, unknown `U`). Every code maps to an explicit normalized category and flow in `TYPE_CODES`; the original code (with its trailing space) stays on every record. `Fg` (free agent granted) is a **departure**, not an acquisition.
- **Teams and leagues:** a three-letter MLB code with a two-letter league, or an independent club name with its league in parentheses (`Long Island (Atlantic)`). Codes map to BAI franchises through the existing table; a code not in it is reported, never guessed (two 2015-2020 rows use `WS9`).
- **Players:** an eight-character Retrosheet id (four letters of the surname padded with `-`, first initial, three digits), or `First Last` for players who never reached the majors, or empty (the row carries cash, a pick, a PTBNL or slot money in `info`).
- **Missing data:** an empty field means not applicable or not known; there is no null token. Source anomalies are kept and flagged, not corrected: one blank type, one `FG`, one undocumented time code `3`.
- **Attribution (mandatory wherever Retrosheet-derived records are shown):** the statement at the top of this file, verbatim. It travels in the generated source declaration, the report and every output file. The notice permits any use, including commercial, with that statement shown prominently. Hosted publication stays gated: `publish_site` is **PENDING** in the source catalog until a person grants it, and a hosted Retrosheet attribution category does not exist yet. No gate or grant was changed.

## 2. What one row is
- **One row is not one transaction.** A trade is a *group* of rows sharing a transaction id: every player and cash/PTBNL row of every direction. 88 of the 716 trade groups in 2015-2020 also carry rows dated **later** (a player added or named afterwards); they are kept and flagged, never merged silently.
- **Ids are not unique for other types.** A free-agent or release id can recur years apart for unrelated rows (15 ids in the window map to several groups). Every non-trade row is its own group, identified by id, date and a hash of its raw line.
- Identity of a group: `RETROSHEET_TXN` = `<id>@<earliest date>` (trade) or `<id>@<date>#<line hash>`. Raw line numbers are kept as locators.
- Unknown dates never become exact dates (MONTH and PRESEASON have no ISO date). Approximate dates are flagged. Free text in `info` is kept verbatim; only a closed vocabulary becomes an asset (`$` = money sent, amount **not** stated; PTBNL; international slot money; a stated draft pick). No amount, bonus or contract value is ever read.

## 3. Transaction-category mapping
See `TYPE_CODES` and `ACQUISITION_CLASS` in `scripts/research/lib/retrosheet-transactions.mjs`. Acquisition classes: TRADE (T, Tp, Tn, C), FREE_AGENT (F, Fo, Fc), AMATEUR_FREE_AGENT (Fa, Fb), WAIVER (W, Wf), PURCHASE (P), RULE_5 (D), DRAFT (Da, Df, Dm, Ds, X*). Everything else (departures, returns, voids, roster-status rows, unknown) is classified but is not an acquisition.

## 4. The 2015-2020 inventory (all 30 franchises)
Raw records, unique ids and groups are separate counts. The archive is **not** a certified census; these are what it records.

| Measure | Count |
|---|---|
| Raw Retrosheet records | 13,253 |
| Unique source transaction ids | 11,836 |
| Groups (transactions as grouped) | 11,849 |
| Trade groups / with two or more directions / three clubs | 716 / 712 / 9 |
| Free-agent signings (`F`, `Fo`) | 4,049 |
| Other acquisitions: waiver 638, purchase 280, Rule 5 109, amateur free agent 94, draft selections 463 | 1,584 |
| Not acquisitions (free agent granted 3,535, releases 1,883, returns, voids, unknown) | 5,500 |
| Rows with an unknown or blank type code | 2 |
| Month-only dates / approximate dates / same-day order codes | 3 / 11 / 68 |
| Rows naming a player without an id (minor leaguers) / with no player | 428 / 309 |

Full counts by season, club and category: [`retrosheet-2015-2020-coverage.csv`](retrosheet-2015-2020-coverage.csv) (1,464 rows). Records touching each club (a trade counts for both clubs):

| Club | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | Total |
|---|---|---|---|---|---|---|---|
| ARI | 103 | 86 | 105 | 114 | 93 | 77 | 578 |
| ATH | 112 | 74 | 80 | 89 | 83 | 54 | 492 |
| ATL | 184 | 157 | 104 | 94 | 68 | 55 | 662 |
| BAL | 115 | 101 | 134 | 96 | 93 | 69 | 608 |
| BOS | 111 | 83 | 60 | 66 | 67 | 79 | 466 |
| CHC | 122 | 122 | 106 | 87 | 100 | 105 | 642 |
| CIN | 105 | 78 | 96 | 104 | 96 | 85 | 564 |
| CLE | 77 | 76 | 84 | 117 | 89 | 43 | 486 |
| COL | 73 | 60 | 69 | 56 | 47 | 53 | 358 |
| CWS | 92 | 94 | 100 | 105 | 85 | 62 | 538 |
| DET | 98 | 89 | 93 | 77 | 70 | 43 | 470 |
| HOU | 82 | 61 | 57 | 40 | 47 | 30 | 317 |
| KC | 87 | 87 | 74 | 104 | 65 | 44 | 461 |
| LAA | 104 | 126 | 96 | 101 | 83 | 62 | 572 |
| LAD | 169 | 134 | 117 | 130 | 81 | 65 | 696 |
| MIA | 103 | 107 | 111 | 73 | 74 | 82 | 550 |
| MIL | 112 | 100 | 78 | 114 | 101 | 44 | 549 |
| MIN | 71 | 72 | 107 | 109 | 119 | 67 | 545 |
| NYM | 90 | 55 | 71 | 99 | 103 | 94 | 512 |
| NYY | 93 | 107 | 86 | 101 | 106 | 59 | 552 |
| PHI | 119 | 87 | 87 | 86 | 92 | 71 | 542 |
| PIT | 108 | 87 | 60 | 85 | 65 | 62 | 467 |
| SD | 119 | 144 | 89 | 70 | 79 | 85 | 586 |
| SEA | 129 | 127 | 153 | 141 | 129 | 90 | 769 |
| SF | 100 | 85 | 84 | 82 | 151 | 82 | 584 |
| STL | 60 | 54 | 55 | 70 | 36 | 37 | 312 |
| TB | 96 | 86 | 129 | 113 | 87 | 78 | 589 |
| TEX | 146 | 121 | 128 | 148 | 129 | 104 | 776 |
| TOR | 147 | 127 | 102 | 109 | 111 | 61 | 657 |
| WSH | 91 | 91 | 97 | 94 | 92 | 70 | 535 |

## 5. Identities
Reused: the pinned Chadwick Register (ODC-BY, commit `781c175`) as the Retrosheet-id crosswalk and BAI's own player ids as the second witness. A name never links a player.

| Retrosheet id outcome | Players |
|---|---|
| STRONG (one register person, MLBAM present, id fits the name) | 3,064 |
| ID_NAME_PATTERN_MISMATCH (held) | 10 |
| Name only, no id (held; never matched) | 401 |
| Not in register / register without MLBAM / ambiguous / conflicting with BAI | 0 / 0 / 0 / 0 |

The 10 held ids are real people whose names changed (for example a player now registered under a different legal name); the pattern check holds them for a person to approve, which is the conservative reading. 2,868 players are acquired in the window; 1,769 more than once and 1,666 by more than one club. Evidence (register rows, MLBAM, BAI player id, witnesses) is kept per id in the local `identity.json`; holds in `identity-holds.json`. No MLBAM id is invented.

## 6. Reconciliation with the 65 BAI trades (read-only)
`reconciliation.json` (local, with both Retrosheet line numbers and BAI transaction ids). Nothing of BAI is overwritten or renumbered. Sharing a player counts only when the dates are close, because a player is traded many times in a career.

| Classification | Retrosheet trade groups |
|---|---|
| Existing confirmed match (same day, same direction, shared identified players) | 9 |
| Existing possible match (same clubs, within a week, no shared identified player) | 5 |
| New transaction (stageable) | 336 |
| Source disagreement (date or direction) | 0 |
| Identity conflict | 0 |
| Incomplete transaction (held) | 366 |

BAI holds 65 trades, 51 outside 2015-2020; all 14 inside the window have a Retrosheet counterpart (9 confirmed, 5 possible). The 9 confirmed matches agree on parties, direction and date; only 2 agree on every asset (BAI's records list a subset or different minor leaguers), which is stated per match.

## 7. Integration with Phase 16 and the local import candidates
Migration 028 and its importer are **genuinely required** (a stable source identity, a source lineage with an independence group, package- and asset-level provenance, PTBNL and cash disclosure, collision and replay handling, derived completeness). So this branch is a stacked draft on `feat/phase16-transaction-foundation`; PR #38 is not merged and its history is not rewritten.

The adapter (`scripts/research/lib/retrosheet-adapter.mjs`) turns a trade group into a version-2 record only when the source states it completely enough that nothing is guessed:
- **One Retrosheet archive is one source lineage** (independence group `retrosheet-archive`, role `REFERENCE`) however many rows it supplies. It cannot corroborate itself, and no transaction can be `VERIFIED_COMPLETE` from it: there is no primary announcement, only one independent group, and a human verification is required. Every imported record reads `PARTIAL` with those gaps listed.
- Cash is `UNKNOWN`, never zero and never an amount; slot money likewise.
- A later-dated player becomes a PTBNL resolution only when exactly one placeholder exists in the same direction; otherwise the group is held. (Only 1 of 88 trade groups with later rows has a placeholder: Retrosheet usually records the later player with none, so these are held until the schema can say "player added later".)
- Same-day trades between the same clubs carry different Retrosheet ids, so each names the other in `distinct_from`.

| Local import candidates | Groups |
|---|---|
| Staged trade candidates (338 records: 748 players, 196 other assets) | 338 |
| Held trade groups | 378 |

Hold reasons (a group can have several): name-only player 345, later-dated member without a single PTBNL placeholder 27, free-text asset 7, identity held 4, one direction only 4, conditional trade (condition not stated) 2, undocumented time code 1. Other acquisition classes (free agent, waiver, purchase, Rule 5, draft) are inventoried but **not staged**: the 028 model carries trade packages, and contract terms are not in the archive. Local outputs: `candidates-batch.json` (immutable, checksummed by staging) and `candidate-holds.json`.

## 8. Disposable PostgreSQL 17 rehearsal
Run 2026-10-25 with `npm run retrosheet:rehearse` (`scripts/research/retrosheet-rehearsal.mjs`). Hosted was **only read** (one read-only transaction to copy its data); no migration was run on it and nothing was written to it. A throwaway PostgreSQL 17 was built from migrations 001-027, hosted's 30,604 rows in 92 tables were copied in, 028 was applied, and the real local candidates batch (338 records) was staged, validated, dry-run, applied and replayed there.

| Step | Result |
|---|---|
| Staged and validated | 338 of 338 valid, 0 invalid |
| Dry run | 336 insert, 2 held; **nothing written** |
| Write | 336 trades inserted (938 assets, 630 new players created by a Chadwick-corroborated id), **2 held for a collision** with existing BAI trades (same day and clubs, no shared identity; not overwritten), 0 conflicts |
| Replay (same content, new batch) | 336 no change, 2 held; nothing inserted or updated |
| Pre-existing BAI rows (65 trades, packages, assets, players, WAR, dispositions) | byte-identical |
| `trade_returns` for every pre-existing trade (166 rows) and `acquisition_value` for a bounded sample (28 rows) | identical before and after |
| Duplicate asset attribution within a transaction | 0 |
| Integrity checks | zero violations |
| Completeness of the 336 imported trades | all PARTIAL, none VERIFIED_COMPLETE. Gaps on every one: FEWER_THAN_TWO_INDEPENDENT_SOURCES, NO_PRIMARY_ANNOUNCEMENT, PACKAGE_NOT_CORROBORATED, ASSET_NOT_CORROBORATED; also CASH_AMOUNT_UNKNOWN on 100 and PENDING_PTBNL on 85 |
| PTBNL resolutions created | 0 (Retrosheet records the later player with no placeholder; see section 7) |

**A scalability finding that blocks a production import.** The existing 023 view `analytics.acquisition_value` re-evaluates `analytics.trade_returns` for every traded acquisition. Measured in this rehearsal: `trade_returns` went from 0.4 s (65 trades) to 1.5 s (401 trades), and `acquisition_value` for a fixed 15-player sample went from **11.8 s to 266 s** (22 times slower for 6 times the trades). The full `acquisition_value` took minutes before the import and did not finish within 45 minutes after it, so the comparison above is bounded (and `class_value` was not compared). Nothing here is wrong, but those views, and the integrity checks and hosted verification that read them, must be made to scale (index or materialize the per-package return) **before** hundreds of trades are written to production. Migration 028 does not change them. **Follow-up (Phase 17B):** the root cause was repeated evaluation of `player_war_coverage` and `trade_returns`; migration 029 (draft, local) reimplements the three views with identical output and brings the same measurements to well under a second (`docs/transactions/value-view-scale.md`).

## 9. Tests
`tests/history/retrosheet-transactions.test.mjs` (dates, rows, every documented code, players, teams, the info vocabulary, grouping, malformed rows, flags, inventory; and the real archive when cached), `tests/history/retrosheet-adapter.test.mjs` (identity states, holds, PTBNL, multi-team, same-day, determinism, reconciliation, report), `tests/db/retrosheet-import.test.mjs` (fictional trades through the Phase 16 importer on a disposable database: collision with existing BAI trades, replay, no duplicate asset attribution, integrity, completeness limits, permission gate, unchanged acquisition-value and trade-return semantics). All fixtures are fictional.

## 10. Publication blockers (what is required before any of this is public)
1. A person grants `publish_site` for the Retrosheet source and a hosted Retrosheet attribution category exists (a migration), with the attribution statement shown prominently on every page that shows Retrosheet-derived records. Currently refused by the gate for any hosted write.
2. Migration 028 (PR #38) must be reviewed, merged and separately authorized for hosted.
3. A second independent source group, and a primary announcement, per transaction, plus a human verification, before any transaction is called complete. Retrosheet alone never is.
4. Contract, salary and cost data have no cleared source; free-agent and waiver values cannot be computed.
5. Baseball-Reference WAR remains `publish_site PENDING`; no organizational WAR is stated.
6. Name-only players (minor leaguers) and the 10 name-change ids need a human identity decision or a corroborated crosswalk.
7. The 023 value views must scale to hundreds of trades (section 8) before a production import; the full `acquisition_value` and `class_value` comparisons did not finish after a 336-trade import.

## 11. Next expansion
**Extend the window to 2021 (already in the archive) and 2010-2014** with the same pipeline (no new source): the parser, grouping and reconciliation are period-independent. Then add the two things the data shows are missing: a schema notion of a "player added later" for the 88-group class, and non-trade acquisition records (free agent, waiver, purchase) once a cleared source for terms exists. Keep realized outcomes (023 views) strictly separate from acquisition-time expectations; no front-office score or ranking is produced.
