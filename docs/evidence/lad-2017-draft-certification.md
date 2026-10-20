# Certification evidence: LAD / DRAFT / 2017-JUNE_AMATEUR

Prepared 2026-10-20 by automated research (operator `bai-backfill-research`). **This class is not certified.** Certification is a human reviewer's decision, made on their own database login (`research:certify -- --check <id>`; see [decision-history.md](../decision-history.md)). Certification is currently disabled. The class lives in the local research database. The hosted database holds only its PR #5 state (picks, slots and tracker, with the batch paused).

Replay: `research/runbooks/lad-2017-cohorts.mjs` then `research/runbooks/lad-2017-completion.mjs`.

## State at preparation

| Check | Value |
|---|---|
| Stage / workflow | `COVERAGE_REVIEW` / `READY_FOR_REVIEW`; certification check (Phase 7): no blockers. Phase 8: `DECISIONS` (Witt and Casey, operator decisions awaiting ratification; see [phase8-reviewer-packages.md](phase8-reviewer-packages.md)) |
| Coverage | `COMPLETE_CENSUS`: 40 expected (MLB official draft data), 40 tracked |
| Signing status | **33 signed, 7 did not sign**, 0 unknown (was 31/9; corrected, see below) |
| Signing dates | 33 of 33 signed picks dated to the day (MLB transaction wire) |
| Bonuses | 13 of 33 known; 20 explicitly unknown (`UNRESOLVED` with rationale; values NULL) |
| Slot values | 10 of 10 picks in rounds 1–10 (sum $5,794,200, the stated pool) |
| Schools / identity / provenance | 40 / 40 / 40 |
| Conflicts | 2 recorded (Witt and Casey signing status), 2 resolved by an operator decision, 0 open |
| Outcome audits | 40 of 40: 9 reached MLB, 31 no MLB through 2026 (as of 2026-10-20) |

## Sources

| Key | Authority | Supplies | Location |
|---|---|---|---|
| `lad2017:mlb-statsapi-draft-2017-lad` | OFFICIAL | universe, rounds, picks, MLBAM ids, birth dates | https://statsapi.mlb.com/api/v1/draft/2017?teamId=119 |
| `lad2017:bref-lad-2017` | AGGREGATOR | signing status, bonus, school; career bWAR through 2025 | Baseball-Reference draft page, capture 2026-01-05 |
| `lad2017:mlb-pick-values-2017` | OFFICIAL | slot values, rounds 1–10 | https://www.mlb.com/news/2017-mlb-draft-bonus-pools-pick-values/c-223686792 |
| `lad2017:mlb-signing-tracker-2017` | OFFICIAL | 7 bonuses, rounds 1–10 | https://www.mlb.com/news/2017-draft-signing-and-bonus-tracker-c237042574 (capture) |
| `lad2017:mlb-transactions-draft-2017` | OFFICIAL | 33 signings with dates | statsapi.mlb.com/api/v1/transactions?teamId=119&startDate=2017-06-12&endDate=2017-08-31 |
| `lad2017:ba-draft-selections-2017` | REPUTABLE_SECONDARY | 13 bonuses (all corroborating); "—" for rounds 14–40 | https://www.baseballamerica.com/stories/2017-draft-selections/ (capture 2026-09-11) |
| `lad2017:mlb-statsapi-outcomes-2026-10-20` | OFFICIAL | debuts, seasons, status, transactions; 130 requests, all HTTP 200 | statsapi.mlb.com people / stats (milb_all) / transactions |
| `lad:mlbcom-rule5-2020-lad` | OFFICIAL | Rule 5 losses (de Geus, Chiu, Roller) | https://www.mlb.com/news/dodgers-2020-rule-5-draft-results (capture 2026-01-01) |

Every bonus that is known has at least two agreeing sources, B-Ref and Baseball America. Seven of them also agree with MLB.com's tracker.

## Correction: Nathan Witt (#520) and Donovan Casey (#610) signed

Baseball-Reference's capture marks both unsigned. MLB's transaction wire records "Los Angeles Dodgers signed RHP Nathan Witt" and "signed OF Donovan Casey" on 2017-07-06. Dodgers Digest (2017-07-07), quoting MLB.com's Ken Gurnick, says "Dodgers also signed 11th-rounder SS Jacob Amaya, 17th-rounder RHP Nathan Witt, 20th-rounder OF Donovan Casey. 33 of 40 total picks signed". LA Dodger Talk (2017-07-08) also counts 33 signed.

The wire batch made each a conflict. `signing_status` requires an operator, and the research operator `bai-backfill-review` chose SIGNED with that rationale. B-Ref's claim stays on record. **Reviewer: confirm.** A recorded resolution cannot currently be re-decided; see the 2016 checklist.

## Picks

| # | Rd | Player (MLBAM) | Signed | Bonus (sources) | Slot | School | Outcome (as of 2026-10-20) | Disposition | bWAR |
|---|---|---|---|---|---|---|---|---|---|
| 23 | 1 | Jeren Kendall (656607) | Yes 2017-07-07 | $2,897,500 (2) | $2,702,700 | Vanderbilt University | No MLB; affiliated from 2017 | RETIRED |  |
| 62 | 2 | Morgan Cooper (668729) | Yes 2017-07-07 | $867,500 (2) | $1,018,200 | University of Texas at Austin | No MLB; affiliated from 2021 | RELEASED |  |
| 100 | 3 | Connor Wong (657136) | Yes 2017-07-07 | $547,500 (2) | $537,100 | University of Houston | MLB 2021-06-22 (BOS, age 25); 425 G, 1386 PA | TRADED | 3.3 |
| 130 | 4 | James Marinan (675653) | Yes 2017-06-18 | $822,500 (3) | $401,000 | Park Vista Community HS | No MLB; affiliated from 2017 | TRADED |  |
| 160 | 5 | Riley Ottesen (675962) | Yes 2017-07-02 | $197,500 (3) | $299,300 | University of Utah | No MLB; affiliated from 2017 | RELEASED |  |
| 190 | 6 | Wills Montgomerie (676377) | Yes 2017-07-02 | $197,500 (3) | $231,900 | University of Connecticut | No MLB; affiliated from 2017 | RELEASED |  |
| 220 | 7 | Zach Pop (647315) | Yes 2017-06-19 | $147,500 (3) | $182,200 | University of Kentucky | MLB 2021-04-03 (MIA, age 24); 170 G, 2 PA, 169.2 IP | TRADED | -1.5 |
| 250 | 8 | Rylan Bannon (676625) | Yes 2017-06-19 | $122,500 (3) | $151,400 | Xavier University | MLB 2022-05-12 (BAL, age 26); 7 G, 21 PA | TRADED | -0.3 |
| 280 | 9 | Connor Strain (676150) | Yes 2017-06-20 | $1,500 (3) | $138,800 | University of Evansville | No MLB; affiliated from 2018 | RELEASED |  |
| 310 | 10 | Zach Reks (676646) | Yes 2017-06-15 | $1,500 (3) | $131,600 | University of Kentucky | MLB 2021-06-21 (LAD, age 27); 22 G, 44 PA | TRADED | -0.6 |
| 340 | 11 | Jacob Amaya (676070) | Yes 2017-07-06 | $247,500 (2) | — | South Hills HS | MLB 2023-06-18 (MIA, age 24); 65 G, 154 PA, 1.0 IP | TRADED | -1.1 |
| 370 | 12 | Andre Jackson (656578) | Yes 2017-07-02 | $247,500 (2) | — | University of Utah | MLB 2021-08-16 (LAD, age 25); 26 G, 4 PA, 82.2 IP | TRADED | 1.0 |
| 400 | 13 | Marshall Kasowski (667445) | Yes 2017-06-19 | $125,000 (2) | — | West Texas A&M University | No MLB; affiliated from 2017 | RELEASED |  |
| 430 | 14 | Josh McLain (656717) | No | — | — | North Carolina State University | No MLB; affiliated from 2018 | UNSIGNED |  |
| 460 | 15 | Marcus Chiu (676722) | Yes 2017-06-24 | **unknown** | — | College of Marin | No MLB; affiliated from 2017 | LOST_RULE_5 |  |
| 490 | 16 | Evy Ruibal (656918) | Yes 2017-06-30 | **unknown** | — | University of Notre Dame | No MLB; affiliated from 2017 | RELEASED |  |
| 520 | 17 | Nathan Witt (676739) | Yes 2017-07-06 | **unknown** | — | Michigan State University | No MLB; affiliated from 2017 | TRADED |  |
| 550 | 18 | Max Gamboa (676451) | Yes 2017-06-24 | **unknown** | — | Pepperdine University | No MLB; affiliated from 2017 | RETIRED |  |
| 580 | 19 | Zach Willeman (657116) | Yes 2017-06-24 | **unknown** | — | Kent State University | No MLB; affiliated from 2018 | TRADED |  |
| 610 | 20 | Donovan Casey (661541) | Yes 2017-07-06 | **unknown** | — | Boston College | No MLB; affiliated from 2017 | TRADED |  |
| 640 | 21 | Joshua Rivera (676448) | No | — | — | Carlos Beltran Baseball Academy | No MLB; affiliated from 2019 | UNSIGNED |  |
| 670 | 22 | Justin Hoyt (676795) | Yes 2017-06-30 | **unknown** | — | Jacksonville State University | No MLB; affiliated from 2017 | RELEASED |  |
| 700 | 23 | Connor Heady (624506) | Yes 2017-06-15 | **unknown** | — | University of Kentucky | No MLB; affiliated from 2017 | RELEASED |  |
| 730 | 24 | Preston Grand Pre (676375) | Yes 2017-06-24 | **unknown** | — | University of California, Berkeley | No MLB; affiliated from 2017 | RELEASED |  |
| 760 | 25 | Mark Washington (675976) | Yes 2017-07-06 | **unknown** | — | Lehigh University | No MLB; affiliated from 2017 | LEFT_AS_FREE_AGENT |  |
| 790 | 26 | Devin Hemmerich (676820) | Yes 2017-06-30 | **unknown** | — | Norfolk State University | No MLB; affiliated from 2017 | UNKNOWN |  |
| 820 | 27 | Jeremy Arocho (671080) | Yes 2017-06-24 | **unknown** | — | Old Mill HS | No MLB; affiliated from 2017 | RELEASED |  |
| 850 | 28 | Justin Lewis (676915) | Yes 2017-06-30 | **unknown** | — | Cornell University | No MLB; affiliated from 2017 | RELEASED |  |
| 880 | 29 | Deacon Liput (663937) | No | — | — | University of Florida | No MLB; affiliated from 2018 | UNSIGNED |  |
| 910 | 30 | Chris Roller (676896) | Yes 2017-06-24 | **unknown** | — | McLennan Community College | MLB 2024-05-15 (MIL, age 27); 1 G, 1 PA | LOST_RULE_5 | 0.0 |
| 940 | 31 | Hunter Mercado-Hood (643453) | No | — | — | University of San Diego | No MLB; affiliated play not established | UNSIGNED |  |
| 970 | 32 | Tyler Adkison (676956) | Yes 2017-06-19 | **unknown** | — | San Diego State University | No MLB; affiliated from 2017 | UNKNOWN |  |
| 1000 | 33 | Brett de Geus (676969) | Yes 2017-06-19 | **unknown** | — | Cabrillo College | MLB 2021-04-01 (TEX, age 23); 61 G, 0 PA, 63.1 IP | LOST_RULE_5 | -1.8 |
| 1030 | 34 | Dan Jagiello (668966) | Yes 2017-06-30 | **unknown** | — | Long Island University, C W Post Campus | No MLB; affiliated from 2017 | RETIRED |  |
| 1060 | 35 | Colby Nealy (676999) | Yes 2017-06-30 | **unknown** | — | Washington State University | No MLB; affiliated from 2017 | RELEASED |  |
| 1090 | 36 | Riley Richert (667458) | Yes 2017-07-06 | **unknown** | — | Howard College | No MLB; affiliated from 2017 | UNKNOWN |  |
| 1120 | 37 | Corey Merrill (641865) | Yes 2017-06-19 | **unknown** | — | Tulane University | No MLB; affiliated from 2019 | UNKNOWN |  |
| 1150 | 38 | Preston White (677039) | No | — | — | Birmingham-Southern College | No MLB; affiliated from 2018 | UNSIGNED |  |
| 1180 | 39 | Logan White (676253) | No | — | — | Mountain Pointe HS | No MLB; affiliated play not established | UNSIGNED |  |
| 1210 | 40 | Clayton Andrews (677076) | No | — | — | Cabrillo College | MLB 2023-07-01 (MIL, age 26); 5 G, 3.2 IP | UNSIGNED | -0.9 |

Notes:
- Bonus "(n)" is the number of sources that agree on the figure. "unknown" means no source states it; it is NULL, never zero.
- First affiliated season for an unsigned pick refers to a later signing (for example, Josh McLain re-drafted and signed by LAD in 2018).
- bWAR is Baseball-Reference career WAR from the 2026-01-05 capture, so through 2025. FanGraphs was not observed.

## Outcomes summary

- **Reached MLB (9):** debut ages 23–27, including Connor Wong, Zach Pop, Jacob Amaya, Brett de Geus and Clayton Andrews (unsigned; MIL).
- **Dispositions:** 12 released, 10 traded, 7 unsigned, 4 unknown (Hemmerich, Adkison, Richert, Merrill: no exit transaction recorded), 3 lost in the Rule 5 draft, 3 retired, 1 left as a free agent.
- **Trades:** 16 trades involving this class.
- **Rule 5:** MLB's wire codes de Geus (Major League phase, Texas), Chiu (Miami) and Roller (Cleveland) as waiver claims on 2020-12-10. MLB.com's same-day report names them as Rule 5 selections. The audits record `LOST_RULE_5` and note the wire's coding (`outcome-audits-import.mjs --rule5`).

## The 20 unknown bonuses

Picks 460, 490, 520, 550, 580, 610, 670, 700, 730, 760, 790, 820, 850, 910, 970, 1000, 1030, 1060, 1090 and 1120 (rounds 15–37). All signed per MLB's wire. Sources searched on 2026-10-20:
- Baseball-Reference shows a blank bonus;
- MLB.com's tracker covers rounds 1–10;
- Baseball America prints "—";
- Dodgers Digest (2017-07-05, 2017-07-07) says late-round bonuses "weren't announced";
- web searches turned up no figure.

Each pick's job is `UNRESOLVED` with that rationale. Under the 2017–2021 agreement, a post-10th-round bonus over $125,000 counts against the pool and is usually reported, but a missing report proves nothing, so no bound is stored.

## Items that need human judgment

1. **Witt and Casey status** (above): recommended to confirm SIGNED.
2. **Census claim:** recommended to accept. MLB's list, Baseball-Reference and Baseball America agree on 40.
3. **20 unknown bonuses:** recommended to accept as unknown after research.
4. **Four `UNKNOWN` dispositions:** recommended to accept. The wire shows no exit; the players are inactive.
5. **The $2,500 accounting deduction:** the Dodgers took it on each signed pick, so Dodgers Digest's gross figures (Kendall $2,900,000) differ from the net figures every other source records ($2,897,500). BAI records net. Recommended: accept and keep the convention.

## How to certify (human reviewer)

```bash
npm run research:class   -- --org LAD --channel draft --year 2017     # expect: no blockers
npm run research:check -- --org LAD --channel draft --year 2017          # anyone: records the check
npm run research:certify -- --check <id>                                 # you, on your own reviewer login (BAI_REVIEWER_DATABASE_URL), once the gate is open
npm run refresh:read-models
```

On hosted, after this branch merges: replay `research/runbooks/lad-2017-completion.mjs --confirm-hosted <ref>` (with `--env-file=.env.hosted.local`), then run `hosted:research -- certify … --confirm-hosted <ref>`.
