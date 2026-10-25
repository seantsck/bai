# Retrosheet historical expansion: 2021 and 2010-2014 (research only)

> The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".

Same cached archive (SHA-256 `c5cd539f89991afa9a74fdc67b0f71e29413383792404013a2c69fdd450fd932`, no new download), same pinned Chadwick Register, same parser, grouping and adapter as the validated 2015-2020 set (`docs/transactions/retrosheet-integration.md`). **Each period is a separate run with its own outputs, its own candidate manifest and its own disposable database**, so a failure in one cannot contaminate another or the validated 2015-2020 set. Nothing was applied to hosted or to production. Source dates and transaction ids are preserved exactly; no missing asset or identity was inferred.

```
node scripts/research/retrosheet-transactions.mjs run --from 2021 --to 2021 --out .local/retrosheet/out-2021 --bai-snapshot ... --register-dir <pinned Chadwick shards>
node scripts/research/retrosheet-transactions.mjs run --from 2010 --to 2014 --out .local/retrosheet/out-2010-2014 ...
node scripts/db/bench/apply-period.mjs bai_tpl_029 bai_2021 .local/retrosheet/out-2021/candidates-batch.json ...        # its own clone
```

## Inventory (groups are separate from raw rows; the archive is not a census)
| Measure | 2010-2014 | 2015-2020 (validated) | 2021 |
|---|---|---|---|
| Raw Retrosheet records | 11,740 | 13,253 | 2,213 |
| Unique source transaction ids | 10,782 | 11,836 | 1,989 |
| Groups | 10,791 | 11,849 | 1,984 |
| Trade groups / two or more directions / three clubs | 515 / 472 / 11 | 716 / 712 / 9 | 113 / 112 / 2 |
| Free-agent signings | 3,621 | 4,049 | 719 |
| Waiver / purchase / Rule 5 | 457 / 194 / 68 | 638 / 280 / 109 | 155 / 68 / 0 |
| Amateur free agent / draft selections | 282 / 913 | 94 / 463 | 0 / 0 |
| Not acquisitions (departures, releases, returns, voids) | 4,741 | 5,500 | 929 |
| Rows naming a player with no id (minor leaguers) | 220 | 428 | 139 |
| Approximate dates / month-only / preseason-only | 0 / 0 / 6 | 11 / 3 / 0 | 24 / 0 / 0 |
| Trade groups with later-dated members | 75 | 88 | 11 |

Groups by season: 2010 to 2014 hold about 2,100 each (2010: 2,134 records, 2011: 2,071, 2012: 2,216, 2013: 2,177, 2014: 2,193); 2021 is one season. Full season, club and category counts are in each period's local `coverage-season-club-category.csv`.

The 2021 file is visibly thinner for free-agent paperwork than earlier years (no amateur free-agent or draft rows at all), another reminder that the archive's coverage, not the league's activity, is what is counted.

## Identities (Retrosheet id -> pinned Chadwick Register -> MLBAM; never by name)
| Outcome | 2010-2014 | 2015-2020 | 2021 |
|---|---|---|---|
| STRONG | 3,515 | 3,064 | 1,038 |
| ID_NAME_PATTERN_MISMATCH (held; name changes) | 10 | 10 | 2 |
| Name only (held) | 209 | 401 | 136 |
| Not in register / no MLBAM / ambiguous / BAI conflict | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

## Local candidates, holds and existing-BAI collisions
| | 2010-2014 | 2015-2020 | 2021 |
|---|---|---|---|
| Staged trade candidates | 244 | 338 | 22 |
| Held trade groups | 271 | 378 | 91 |
| Main hold reasons | name-only 193, later member without one placeholder 39, conditional (condition unstated) 43, one direction 43, free text 5, identity 6 | name-only 345, later member 27, free text 7, identity 4, one direction 4, conditional 2 | name-only 90, conditional 1, one direction 1 |
| BAI trades in the period | 0 | 14 | 8 |
| Existing confirmed / possible match | 0 / 0 | 9 / 5 | 3 / 0 |
| BAI trades in the period with no Retrosheet counterpart | 0 | 0 | 5 (BAI ids 73, 78, 104, 114, 130) |
| Source disagreement / identity conflict | 0 / 0 | 0 / 0 | 0 / 0 |
| Candidate manifest SHA-256 | `8682c0da…8b9ae9` | `71cea0b7…f0892` | `68851373…8e72d` |

Rehearsal on each period's own clone (migration 029 applied; see `value-view-scale.md`):
| | 2010-2014 | 2021 |
|---|---|---|
| Dry run wrote nothing | yes | yes |
| Write | 244 inserted, 0 held | 22 inserted, 0 held |
| Collisions with existing BAI trades / conflicts | 0 / 0 | 0 / 0 |
| Replay | 244 no change | 22 no change |
| Integrity violations / duplicate player in a transaction | 0 / 0 | 0 / 0 |
| Completeness | all PARTIAL | all PARTIAL |

The three period batches also apply together without collision (667 trades with BAI's 65, used only as a load test), so the periods are independent. The 2015-2020 manifest checksum is unchanged from the one rehearsed in Phase 17 (`71cea0b7…`).

## What this does and does not establish
- It establishes that the parser, grouping, identity and adapter behave the same way on 2010-2014 and 2021 as on 2015-2020, with no new failure mode, and that none of these sets collides with BAI's existing trades beyond what reconciliation already classifies.
- It does not establish completeness: 2010-2014 shows 193 name-only holds of 271, 2021 shows 90 of 91. Most held trades involve a minor leaguer Retrosheet names without an id; resolving them needs a corroborated crosswalk, not a name match.
- All candidates remain PARTIAL: one source lineage, no primary announcement, no human verification. No manifest was applied anywhere outside a disposable database.
