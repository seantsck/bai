# Certification evidence: LAD / DRAFT / 2016-JUNE_AMATEUR

Prepared 2026-10-20 by automated research (operator `bai-backfill-research`); updated in Phase 6 with a third bonus source (Baseball America) and an independent re-verification. The reviewer's checklist, with a recommendation per decision, is [lad-2016-review-checklist.md](lad-2016-review-checklist.md). **This class is not certified.** Certification is a human reviewer's decision. The framework refuses `agent:*` actors, and this package exists so a person can check the evidence independently and run the command themselves.

## State at preparation

| Check | Value |
|---|---|
| Stage / workflow | `COVERAGE_REVIEW`; locally blocked only by the reopened Smeltzer conflict (left for the reviewer); hosted (PR #5 state) `READY_FOR_REVIEW` |
| Coverage | `COMPLETE_CENSUS`: 42 expected (MLB official draft data), 42 tracked |
| Signing status | 33 signed, 9 did not sign, 0 unknown |
| Bonuses | 27 of 33 signed known (Jenco from Baseball America); 6 explicitly unknown (`UNRESOLVED` jobs with rationale; values NULL) |
| Slot values | 12 of 12 picks in rounds 1–10 |
| Schools | 42 of 42 |
| Identity | 42 of 42 with an MLBAM id (plus Baseball-Reference ids where well formed) |
| Provenance | 42 of 42 selections and signings cite a source |
| Conflicts | 3 recorded: 2 resolved (Sheffield), 1 reopened by Baseball America and left open for the reviewer (Smeltzer) |
| Outcome audits | 42 of 42 (18 reached MLB, 24 no MLB through 2026); not a certification requirement |
| `research:certify` check | no blockers (deterministic check run read-only through `research:class`) |

## Sources

| Key | Authority | What it supplies | Location | Read |
|---|---|---|---|---|
| `lad2016:mlb-statsapi-draft-2016-lad` | OFFICIAL | universe (42 picks), round, overall and round pick, MLBAM id, name, birth date | https://statsapi.mlb.com/api/v1/draft/2016?teamId=119 | 2026-10-19 |
| `lad2016:bref-lad-2016` | AGGREGATOR | signing status, bonus, draft-listed position, school, B-Ref ids, career bWAR | https://www.baseball-reference.com/draft/?team_ID=LAD&year_ID=2016&draft_type=junreg&query_type=franch_year (archive capture 2026-08-03: http://web.archive.org/web/20260803214548/https://www.baseball-reference.com/draft/index.fcgi?query_type=franch_year&team_ID=LAD&year_ID=2016&draft_type=junreg) | 2026-10-19 |
| `lad2016:mlb-callis-pick-values-2016` | OFFICIAL | slot values, rounds 1–10 | https://www.mlb.com/news/2016-draft-bonus-pools-pick-values-c170470526 (capture 2021-12-09), published 2016-04-05 | 2026-10-20 |
| `lad2016:mlb-signing-tracker-2016` | OFFICIAL | bonuses, rounds 1–10 | https://www.mlb.com/news/2016-draft-signing-and-bonus-tracker/c-183906680 (capture 2019-09-22) | 2026-10-20 |
| `lad2016:ba-draft-selections-2016` | REPUTABLE_SECONDARY | bonuses (25 corroborate, Jenco new, Smeltzer $497,500); "—" rows skipped | https://www.baseballamerica.com/stories/2016-draft-selections/ (capture 2026-04-29) | 2026-10-20 |
| `lad2016:mlb-statsapi-outcomes-2026-10-20` | OFFICIAL | debuts, MLB/minor-league seasons, current team, transactions | statsapi.mlb.com people, stats (milb_all) and transactions endpoints; 137 requests, all HTTP 200 | 2026-10-20 |

**Slot mapping evidence.** The 2016 pick-values article lists values in draft order without pick numbers. The Dodgers entries sit at overall positions 20, 32, 36, 65, 101, 131, 161, 191, 221, 251, 281 and 311, exactly the picks in MLB's official data. They sum to $9,336,500, the Dodgers pool the same article states. The signing tracker's "pick value" fields agree (for example #36 $1,791,000 and #161 $331,100).

## Picks

| # | Rd | Player (MLBAM) | Signed | Bonus | Slot | School | Outcome (as of 2026-10-20) | Disposition | bWAR |
|---|---|---|---|---|---|---|---|---|---|
| 20 | 1 | Gavin Lux (666158) | Yes | $2,314,500 | $2,316,300 | Indian Trail HS | MLB 2019-09-02 (LAD, age 21); 552 G, 1993 PA | TRADED | 7.2 |
| 32 | 1 | Will Smith (669257) | Yes | $1,772,500 | $1,940,700 | University of Louisville | MLB 2019-05-28 (LAD, age 24); 795 G, 3222 PA | RETAINED | 23.8 |
| 36 | CB-A | Jordan Sheffield (642068) | Yes | $1,847,500 | $1,791,000 | Vanderbilt University | MLB 2021-04-02 (COL, age 25); 32 G, 0 PA, 31.1 IP | LOST_WAIVERS | 0.7 |
| 65 | 2 | Mitch White (669952) | Yes | $588,300 | $993,800 | Santa Clara University | MLB 2020-08-28 (LAD, age 25); 71 G, 16 PA, 185.0 IP | TRADED | -2.0 |
| 101 | 3 | Dustin May (669160) | Yes | $997,500 | $590,800 | Northwest HS | MLB 2019-08-02 (LAD, age 21); 102 G, 15 PA, 469.2 IP | TRADED | 3.1 |
| 131 | 4 | DJ Peters (656847) | Yes | $247,500 | $442,400 | Western Nevada College | MLB 2021-04-23 (LAD, age 25); 70 G, 240 PA | LOST_WAIVERS | 0.0 |
| 161 | 5 | Devin Smeltzer (656970) | Yes | $500,000 | $331,100 | San Jacinto College, North Campus | MLB 2019-05-28 (MIN, age 23); 43 G, 162.1 IP | TRADED | 1.4 |
| 191 | 6 | Errol Robinson (642021) | Yes | $247,500 | $247,900 | University of Mississippi | No MLB; affiliated from 2016 | LOST_WAIVERS |  |
| 221 | 7 | Luke Raley (670042) | Yes | $147,500 | $187,400 | Lake Erie College | MLB 2021-04-09 (LAD, age 26); 478 G, 1511 PA, 2.2 IP | TRADED | 5.0 |
| 251 | 8 | Andre Scrubb (668687) | Yes | $122,500 | $175,100 | High Point University | MLB 2020-07-28 (HOU, age 25); 38 G, 43.1 IP | TRADED | 0.9 |
| 281 | 9 | Tony Gonsolin (664062) | Yes | $2,500 | $163,400 | Saint Mary's College of California | MLB 2019-06-26 (LAD, age 25); 87 G, 33 PA, 414.1 IP | LEFT_AS_FREE_AGENT | 7.8 |
| 311 | 10 | Kevin Lachance (669730) | Yes | $2,500 | $156,600 | University of Maryland, Baltimore County | No MLB; affiliated from 2017 | RELEASED |  |
| 341 | 11 | A.J. Alexy (669935) | Yes | $597,500 | — | Twin Valley HS | MLB 2021-08-30 (TEX, age 23); 9 G, 30.0 IP | TRADED | -0.3 |
| 371 | 12 | Graham Ashcraft (668933) | No | — | — | Huntsville HS | MLB 2022-05-22 (CIN, age 24); 157 G, 428.2 IP | UNSIGNED | 4.5 |
| 401 | 13 | Cody Thomas (642137) | Yes | $297,500 | — | University of Oklahoma | MLB 2022-09-01 (ATH, age 27); 29 G, 78 PA | TRADED | -0.4 |
| 431 | 14 | Dean Kremer (665152) | Yes | $147,500 | — | University of Nevada, Las Vegas | MLB 2020-09-06 (BAL, age 24); 143 G, 762.0 IP | TRADED | 6.1 |
| 461 | 15 | Brayan Morales (657243) | Yes | $122,500 | — | Hillsborough Community College | No MLB; affiliated from 2016 | RELEASED |  |
| 491 | 16 | Darien Tubbs (670083) | Yes | $100,000 | — | University of Memphis | No MLB; affiliated from 2016 | RELEASED |  |
| 521 | 17 | Dillon Persinger (665047) | No | — | — | Golden West College | No MLB; affiliated from 2017 | UNSIGNED |  |
| 551 | 18 | Cole Freeman (670106) | No | — | — | Louisiana State University | No MLB; affiliated from 2018 | UNSIGNED |  |
| 581 | 19 | Chris Mathewson (656693) | Yes | $202,000 | — | California State University, Long Beach | No MLB; affiliated from 2016 | RELEASED |  |
| 611 | 20 | Brock Carpenter (643246) | Yes | $75,000 | — | Seattle University | No MLB; affiliated from 2016 | RELEASED |  |
| 641 | 21 | James Carter (641445) | Yes | $100,000 | — | University of California, Santa Barbara | No MLB; affiliated from 2016 | RELEASED |  |
| 671 | 22 | Jeff Paschke (667704) | Yes | $100,000 | — | University of Southern California | No MLB; affiliated from 2016 | RELEASED |  |
| 701 | 23 | Bailey Ober (641927) | No | — | — | College of Charleston | MLB 2021-05-18 (MIN, age 25); 140 G, 2 PA, 748.2 IP | UNSIGNED | 10.2 |
| 731 | 24 | Saige Jenco (663396) | Yes | $75,000 (BA) | — | Virginia Polytechnic Institute and State University | No MLB; affiliated from 2016 | RELEASED |  |
| 761 | 25 | Chandler Eden (641549) | Yes | **unknown** | — | Texas Tech University | No MLB; affiliated play not established | UNKNOWN |  |
| 791 | 26 | Brandon Montgomery (670417) | Yes | $60,000 | — | San Jacinto College, North Campus | No MLB; affiliated from 2016 | RELEASED |  |
| 821 | 27 | Austin French (670451) | Yes | **unknown** | — | Brown University | No MLB; affiliated from 2016 | RELEASED |  |
| 851 | 28 | Jake Perkins (664084) | Yes | **unknown** | — | Ferrum College | No MLB; affiliated from 2016 | RETIRED |  |
| 881 | 29 | Will Kincanon (670267) | No | — | — | Triton College | No MLB; affiliated from 2017 | UNSIGNED |  |
| 911 | 30 | Ramón Rodríguez (670232) | Yes | $100,000 | — | Puerto Rico Baseball Academy | No MLB; affiliated from 2016 | RELEASED |  |
| 941 | 31 | Stevie Berman (670281) | Yes | **unknown** | — | Santa Clara University | No MLB; affiliated from 2016 | TRADED |  |
| 971 | 32 | Conor Costello (607184) | Yes | **unknown** | — | Oklahoma State University | No MLB; affiliated from 2016 | RELEASED |  |
| 1001 | 33 | Zach McKinstry (656716) | Yes | $100,000 | — | Central Michigan University | MLB 2020-09-16 (LAD, age 25); 660 G, 2141 PA, 5.1 IP | TRADED | 5.0 |
| 1031 | 34 | Joel Toribio (670272) | Yes | **unknown** | — | Western Oklahoma State College | No MLB; affiliated from 2017 | RELEASED |  |
| 1061 | 35 | Nick Yarnall (670302) | Yes | $75,000 | — | University of Pittsburgh | No MLB; affiliated from 2016 | RELEASED |  |
| 1091 | 36 | Cal Stevenson (670276) | No | — | — | Chabot College | MLB 2022-08-10 (ATH, age 25); 52 G, 118 PA | UNSIGNED | -0.5 |
| 1121 | 37 | Enrique Zamora (670307) | No | — | — | Calumet College of St. Joseph | No MLB; affiliated play not established | UNSIGNED |  |
| 1151 | 38 | Kevin Malisheski (670220) | Yes | $248,500 | — | Wauconda HS | No MLB; affiliated from 2016 | RELEASED |  |
| 1181 | 39 | Ryan Watson (670245) | No | — | — | Auburn HS | MLB 2026-03-28 (BOS, age 28); 53 G, 72.0 IP | UNSIGNED | 0.0 |
| 1211 | 40 | Zach Taglieri (670239) | No | — | — | Port St. Lucie HS | No MLB; affiliated play not established | UNSIGNED |  |

**Notes on the table**
- **Bonus:** "unknown" means no source states the bonus. It is stored as NULL, never zero.
- **Outcomes:** these are as of 2026-10-20 from the MLB Stats API. IP uses baseball notation (31.1 = 31⅓).
- **bWAR:** this is Baseball-Reference career WAR from the 2026-08-03 capture. FanGraphs WAR was not observed: the site refuses automated requests and has no archive copy.

## Conflicts and how they were resolved

| Subject | Claims | Resolution |
|---|---|---|
| Jordan Sheffield #36, `round_code` | MLB `CB-A`; Baseball-Reference `1` | Researcher rationale (`bai-backfill-review`). MLB's official structure is kept: the pick is a Competitive Balance Round A pick, pick 2 of that round, and both sources agree on overall pick 36. B-Ref's label stays on record. |
| Jordan Sheffield #36, `round_pick` | MLB `2`; Baseball-Reference `36` | Same decision and rationale. |
| Devin Smeltzer #161, signing bonus | MLB.com tracker $500,000 (OFFICIAL); Baseball-Reference $497,500 (AGGREGATOR); Baseball America $497,500 (REPUTABLE_SECONDARY) | Hosted (PR #5 state): the declared rule `PREFER_HIGHER_AUTHORITY` chose $500,000. Locally, Baseball America reopened the conflict and it is **open for the reviewer**; $497,500 is recommended (net-of-deduction convention, checklist item 1). |

## The seven bonuses that were unknown

All seven signed with the Dodgers per MLB's official transaction wire, independently re-checked on 2026-10-20. In Phase 6, Baseball America supplied Jenco's ($75,000); the other six stay unknown (Baseball America prints "—"; Dodgers Digest lists all seven among picks not counted against the pool, which bounds each at $100,000 or less).

| Pick | Player | Official signing transaction | Bonus sources checked |
|---|---|---|---|
| 731 | Saige Jenco | 2016-06-17 "Los Angeles Dodgers signed CF Saige Jenco." | **$75,000, Baseball America** (B-Ref blank); job `SUPERSEDED` |
| 761 | Chandler Eden | 2016-06-17 "Los Angeles Dodgers signed RHP Chandler Eden." | same |
| 821 | Austin French | 2016-06-17 "Los Angeles Dodgers signed LHP Austin French." | same |
| 851 | Jake Perkins | 2016-06-17 "Los Angeles Dodgers signed RHP Jake Perkins." | same |
| 941 | Stevie Berman | 2016-06-17 "Los Angeles Dodgers signed C Stevie Berman." | same |
| 971 | Conor Costello | 2016-07-03 "Los Angeles Dodgers signed RHP Conor Costello." | same |
| 1031 | Joel Toribio | 2016-07-06 "Los Angeles Dodgers signed RHP Joel Toribio." | same |

## Independent checks made for this package

- **Conflict sources re-read.** Sheffield and Smeltzer were re-extracted from the stored copies of all three sources, and the values match the recorded observations exactly.
- **Signing status cross-checked.** It was checked against MLB's transaction wire for the seven unknown-bonus picks. A fan retrospective (DodgersNation) lists Chandler Eden as "did not sign". The official wire records his signing on 2016-06-17 and his assignment to the AZL Dodgers on 2016-06-20, so that claim was **not** imported. It is noted here for the reviewer.
- **Slot values cross-checked.** The tracker's "pick value" fields were compared with the April pick-values article for the overlapping picks: all agree.

## Items that need human judgment

1. **Smeltzer bonus.** Open for the reviewer locally (three sources). Recommended: $497,500. A recorded resolution cannot be re-decided with `research:resolve` (an earlier version of this package said it could; it cannot), which is why this one was left open.
2. **Census claim.** Coverage is `COMPLETE_CENSUS` because MLB's official draft data lists 42 picks and Baseball-Reference lists the same 42. A reviewer should confirm the official list is the population definition they accept.
3. **Six unknown bonuses** (seven before Baseball America). Accept them as unknown after research, or reopen them (a new researcher job) with additional sources, for example Baseball America's signing database.
4. **Dispositions of Jordan Sheffield and Errol Robinson.** MLB codes both departures as waiver claims on 2020-12-10. MLB.com's same-day report (archived) names both as Rule 5 selections: Sheffield 7th in the Major League phase to Colorado, and Robinson to Cincinnati in the Minor League phase. Recommended: recode to `LOST_RULE_5` with a corrective outcomes batch (`research/evidence/rule5-2020-lad.json`).
5. **Chandler Eden.** He signed, but no affiliated game appears in MLB's data, and no exit transaction is recorded. His disposition is `UNKNOWN` and affiliated play is "not established".
6. **WAR.** Only Baseball-Reference career WAR (as of 2026-08-03) is recorded. FanGraphs WAR and WAR by organization tenure are not, so organization value attribution cannot be computed yet.

## How to certify (human reviewer)

The class currently lives in the local research database. To review and certify there:

```bash
npm run db:server                                         # local PostgreSQL 17
npm run research:class   -- --org LAD --channel draft --year 2016     # state, counts, blockers (expect: no blockers)
npm run research:conflicts                                 # expect: 0 open
npm run research:certify -- --org LAD --channel draft --year 2016 --operator "<your name>"
npm run refresh:read-models                                # the ✓ appears on /research
```

To certify on the hosted database instead, after the PR carrying migration 020 is merged and 020 is pushed:

```bash
npm run hosted:supabase -- db push --dry-run && npm run hosted:supabase -- db push
npm run hosted:migrate -- --confirm-hosted <ref>
node --env-file=.env.hosted.local research/runbooks/lad-2016-draft.mjs --confirm-hosted <ref>   # replays the recorded research
npm run hosted:research -- class --org LAD --channel draft --year 2016
npm run hosted:research -- certify --org LAD --channel draft --year 2016 --operator "<your name>" --confirm-hosted <ref>
npm run hosted:refresh -- --confirm-hosted <ref>
```

Notes:
- `certify` re-runs every check and refuses on any blocker. There is no force option.
- To undo a certification: `research:revoke -- --org LAD --channel draft --year 2016 --reason "..."`. It is human-only, the revocation stays on record, and the class returns to `COVERAGE_REVIEW`.
- After certification, `analytics.class_economics` may compute `mlb_reach_rate` for this class: census coverage, certified, and 42 of 42 audited. `cost_per_mlb_player` stays null because 6 costs are unknown.
- Migration 020 is deployed to hosted (2026-10-20), and the PR #5 runbook has been replayed there, so the hosted steps above that push 020 are already done.
