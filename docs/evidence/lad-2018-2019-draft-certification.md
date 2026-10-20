# Certification evidence: LAD / DRAFT / 2018 and 2019

Prepared 2026-10-20 by automated research (Phase 7). **Neither class is certified.** Certification is a registered human reviewer's decision (`research:reviewer`, then `research:certify`; see [../decision-history.md](../decision-history.md)). Local only. Replay: `research/runbooks/lad-2018-2019-drafts.mjs`.

## State

| Check | 2018 | 2019 |
|---|---|---|
| Stage / workflow | `COVERAGE_REVIEW` / `READY_FOR_REVIEW`, no blockers | `COVERAGE_REVIEW` / `READY_FOR_REVIEW`, no blockers |
| Coverage | `COMPLETE_CENSUS`: 40 (MLB official) = 40 (Baseball-Reference) | `COMPLETE_CENSUS`: 41 = 41 |
| Signed / did not sign | 32 / 8; the MLB wire agrees on all 40 | 31 / 10; the MLB wire agrees on all 41 (Breyln Jones signed as an `SFA` entry) |
| Signing dates | 32 of 32 day-dated (wire) | 31 of 31 |
| Bonuses | **32 of 32** (Baseball-Reference) | **31 of 31** (Baseball-Reference 30; Hoese from Dodgers Digest, as MLB.com reported) |
| Slots | 10 of 10, sum ,288,200 = the stated pool | 11 of 11, sum ,069,100 = the stated pool |
| Conflicts | 0 | Jimmy Lewis #78 numbering (MLB C-2/1 vs B-Ref 2/37), resolved by an operator decision (`bai-backfill-review`) |
| Outcomes | 40 of 40: 9 reached MLB, 31 no MLB | 41 of 41: 7 reached MLB, 34 no MLB |

## Sources

- **MLB Stats API:** draft (`teamId=119`), transactions (draft windows 2018-06-04..08-31 and 2019-06-03..08-31), people, stats (`milb_all`).
- **Baseball-Reference franchise draft pages:** 2018 capture 2025-10-01 (career bWAR through 2025); 2019 capture 2025-02-16 (through 2024).
- **MLB.com pick values:** "2018 Draft bonus pools, pick values" (capture 2025-07-17) and "Here are the 2019 Draft pools and bonus values" (capture 2026-02-07).
- **Dodgers Digest, 2019-07-12:** the final 2019 signing table (`research/evidence/lad-2019-draft-bonus-reports.json`). Only Hoese's bonus is imported from it.

## 2018

| # | Rd | Player (MLBAM) | Signed | Bonus (sources) | Slot | School | Outcome (as of 2026-10-20) | Disposition | bWAR |
|---|---|---|---|---|---|---|---|---|---|
| 30 | 1 | J.T. Ginn (669372) | No | — | $2,275,800 | Brandon HS | MLB 2024-08-21 (ATH, age 25); 58 G, 0 PA, 262.2 IP | UNSIGNED | 1.0 |
| 68 | 2 | Michael Grove (675627) | Yes 2018-07-05 | $1,229,500 (1) | $917,000 | West Virginia University | MLB 2022-05-15 (LAD, age 25); 67 G, 156.1 IP | LEFT_AS_FREE_AGENT | -2.0 |
| 104 | 3 | John Rooney (680701) | Yes 2018-07-03 | $563,240 (1) | $538,800 | Hofstra University | MLB 2025-08-24 (HOU, age 28); 1 G, 1.1 IP | LEFT_AS_FREE_AGENT | 0.0 |
| 134 | 4 | Braydon Fisher (680755) | Yes 2018-06-27 | $497,500 (1) | $402,300 | Clear Falls HS | MLB 2025-05-11 (TOR, age 24); 127 G, 125.2 IP | TRADED | 1.4 |
| 164 | 5 | Devin Mann (669471) | Yes 2018-06-17 | $272,500 (1) | $300,600 | University of Louisville | No MLB; affiliated from 2018 | TRADED |  |
| 194 | 6 | Bryan Warzek (679338) | Yes 2018-06-18 | $202,500 (1) | $233,800 | University of New Orleans | No MLB; affiliated from 2018 | RELEASED |  |
| 224 | 7 | James Outman (681546) | Yes 2018-06-19 | $157,500 (1) | $184,200 | California State University, Sacramento | MLB 2022-07-31 (LAD, age 25); 361 G, 1057 PA | TRADED | 2.5 |
| 254 | 8 | Luke Heyer (679691) | Yes 2018-06-19 | $47,500 (1) | $155,300 | University of Kentucky | No MLB; affiliated from 2018 | RELEASED |  |
| 284 | 9 | Josh McLain (656717) | Yes 2018-06-18 | $7,500 (1) | $143,600 | North Carolina State University | No MLB; affiliated from 2018 | RETIRED 2019-11-07 |  |
| 314 | 10 | Deacon Liput (663937) | Yes 2018-07-03 | $134,300 (1) | $136,800 | University of Florida | No MLB; affiliated from 2018 | UNKNOWN |  |
| 344 | 11 | Stephen Kolek (663568) | Yes 2018-06-14 | $125,000 (1) | — | Texas A&M University | MLB 2024-03-21 (SD, age 26); 71 G, 213.1 IP | TRADED | 1.8 |
| 374 | 12 | Hunter Feduccia (676439) | Yes 2018-06-14 | $125,000 (1) | — | Louisiana State University | MLB 2024-07-31 (LAD, age 27); 136 G, 370 PA | TRADED | -0.3 |
| 404 | 13 | Dillon Paulson (663516) | Yes 2018-06-19 | $125,000 (1) | — | University of Southern California | No MLB; affiliated from 2018 | TRADED |  |
| 434 | 14 | Brandon White (681449) | No | — | — | W. F. West HS | No MLB; affiliated from 2023 | UNSIGNED |  |
| 464 | 15 | Julian Smith (681886) | Yes 2018-07-03 | $152,500 (1) | — | Catawba Valley Community College | No MLB; affiliated from 2019 | RELEASED |  |
| 494 | 16 | Trey Dillard (669366) | No | — | — | San Jacinto College, North Campus | No MLB; affiliated from 2023 | UNSIGNED |  |
| 524 | 17 | Aldrich De Jongh (680884) | Yes 2018-06-12 | $147,500 (1) | — | Hillsborough Community College | No MLB; affiliated from 2018 | RELEASED |  |
| 554 | 18 | Niko Hulsizer (680881) | Yes 2018-06-19 | $125,000 (1) | — | Morehead State University | No MLB; affiliated from 2018 | TRADED |  |
| 584 | 19 | Sam McWilliams (681955) | Yes 2018-06-17 | $125,000 (1) | — | Meridian Community College | No MLB; affiliated from 2018 | RETAINED |  |
| 614 | 20 | Caleb Sampen (680789) | Yes 2018-06-12 | $125,000 (1) | — | Wright State University | No MLB; affiliated from 2018 | TRADED |  |
| 644 | 21 | Tre Todd (681990) | Yes 2018-06-12 | $125,000 (1) | — | Liberty University | No MLB; affiliated from 2018 | RELEASED |  |
| 674 | 22 | Meaux Landry (682009) | Yes 2018-07-06 | $125,000 (1) | — | Pearl River Community College | No MLB; affiliated from 2018 | RELEASED |  |
| 704 | 23 | Justin Hagenman (663795) | Yes 2018-06-12 | $75,000 (1) | — | Pennsylvania State University | MLB 2025-04-16 (NYM, age 28); 12 G, 31.2 IP | TRADED | 0.0 |
| 734 | 24 | Jacen Roberson (682039) | No | — | — | Garces Memorial HS | No MLB; affiliated from 2021 | UNSIGNED |  |
| 764 | 25 | Hunter Speer (682050) | Yes 2018-06-12 | $12,500 (1) | — | William Carey University | No MLB; affiliated from 2018 | RELEASED |  |
| 794 | 26 | Aaron Ackerman (679299) | Yes 2018-06-20 | $125,000 (1) | — | University of Illinois at Chicago | No MLB; affiliated from 2018 | RELEASED |  |
| 824 | 27 | Connor Mitchell (682097) | Yes 2018-06-12 | $50,000 (1) | — | Butler University | No MLB; affiliated from 2018 | RETIRED |  |
| 854 | 28 | Reza Aleaziz (641300) | Yes 2018-06-12 | $50,000 (1) | — | Oklahoma State University | No MLB; affiliated from 2018 | RELEASED |  |
| 884 | 29 | Dan Robinson (674974) | Yes 2018-06-19 | $75,000 (1) | — | Central Michigan University | No MLB; affiliated from 2018 | RELEASED |  |
| 914 | 30 | Matt Cogen (682134) | Yes 2018-06-19 | $50,000 (1) | — | Belmont University | No MLB; affiliated from 2018 | RETIRED |  |
| 944 | 31 | Andrew Shaps (656952) | Yes 2018-06-12 | $5,000 (1) | — | Jessup University | No MLB; affiliated from 2018 | TRADED |  |
| 974 | 32 | Jacob Gilliland (681365) | Yes 2018-06-13 | $125,000 (1) | — | Next Level Academy | No MLB; affiliated from 2018 | TRADED |  |
| 1004 | 33 | Drew Avans (682183) | Yes 2018-06-18 | $5,000 (1) | — | Southeastern Louisiana University | MLB 2025-05-27 (ATH, age 28); 8 G, 18 PA | LEFT_AS_FREE_AGENT | -0.4 |
| 1034 | 34 | Austin Drury (682200) | Yes 2018-06-13 | $100,000 (1) | — | University of North Florida | No MLB; affiliated from 2018 | RELEASED |  |
| 1064 | 35 | Tyler Reichenborn (682218) | No | — | — | Iowa Western Community College | No MLB; affiliated from 2019 | UNSIGNED |  |
| 1094 | 36 | Jeremiah Vison (682228) | Yes 2018-06-18 | $50,000 (1) | — | Golden West College | No MLB; affiliated from 2018 | RELEASED |  |
| 1124 | 37 | Jon Littell (657662) | Yes 2018-06-20 | $5,000 (1) | — | Oklahoma State University | No MLB; affiliated from 2018 | RELEASED |  |
| 1154 | 38 | Connery Peters (681553) | No | — | — | Joshua HS | No MLB; affiliated from 2023 | UNSIGNED |  |
| 1184 | 39 | Jordan Myrow (663919) | No | — | — | San Jacinto College, North Campus | No MLB; affiliated play not established | UNSIGNED |  |
| 1214 | 40 | Ben Specht (681567) | No | — | — | Evangelical Christian School | No MLB; affiliated play not established | UNSIGNED |  |

## 2019

| # | Rd | Player (MLBAM) | Signed | Bonus (sources) | Slot | School | Outcome (as of 2026-10-20) | Disposition | bWAR |
|---|---|---|---|---|---|---|---|---|---|
| 25 | 1 | Kody Hoese (682210) | Yes 2019-06-11 | $2,740,300 (1) | $2,740,300 | Tulane University | No MLB; affiliated from 2019 | LEFT_AS_FREE_AGENT |  |
| 31 | 1 | Michael Busch (683737) | Yes 2019-07-04 | $2,312,000 (1) | $2,312,000 | University of North Carolina at Chapel Hill | MLB 2023-04-25 (LAD, age 25); 494 G, 1950 PA | TRADED | 2.4 |
| 78 | C-2 | Jimmy Lewis (683167) | Yes 2019-07-09 | $1,097,500 (1) | $793,000 | Lake Travis HS | No MLB; affiliated from 2021 | RELEASED |  |
| 102 | 3 | Ryan Pepiot (686752) | Yes 2019-06-11 | $547,500 (1) | $571,400 | Butler University | MLB 2022-05-11 (LAD, age 24); 74 G, 376.0 IP | TRADED | 3.8 |
| 131 | 4 | Brandon Lewis (686781) | Yes 2019-06-17 | $327,500 (1) | $430,800 | University of California, Irvine | No MLB; affiliated from 2019 | RELEASED |  |
| 161 | 5 | Jack Little (669193) | Yes 2019-06-19 | $318,600 (1) | $321,100 | Stanford University | MLB 2025-06-19 (LAD, age 27); 2 G, 3.0 IP | LOST_WAIVERS |  |
| 191 | 6 | Aaron Ochsenbein (684604) | Yes 2019-07-01 | $72,500 (1) | $249,000 | Eastern Kentucky University | No MLB; affiliated from 2019 | RETIRED |  |
| 221 | 7 | Nick Robertson (687798) | Yes 2019-06-11 | $177,500 (1) | $195,700 | James Madison University | MLB 2023-06-07 (LAD, age 24); 27 G, 35.2 IP | TRADED | -0.4 |
| 251 | 8 | Ryan Ward (669899) | Yes 2019-06-11 | $160,900 (1) | $163,400 | Bryant University | MLB 2026-04-19 (LAD, age 28); 20 G, 60 PA | RELEASED |  |
| 281 | 9 | Alec Gamboa (687941) | Yes 2019-06-11 | $17,500 (1) | $150,100 | Fresno City College | MLB 2026-05-05 (BOS, age 29); 21 G, 33.0 IP | RELEASED |  |
| 311 | 10 | Zac Ching (687852) | Yes 2019-06-11 | $2,500 (1) | $142,300 | Virginia Commonwealth University | No MLB; affiliated from 2019 | RELEASED |  |
| 341 | 11 | Logan Boyer (669188) | Yes 2019-06-11 | $297,500 (1) | — | San Diego State University | No MLB; affiliated from 2021 | LEFT_AS_FREE_AGENT |  |
| 371 | 12 | Mitchell Tyranski (680454) | Yes 2019-06-11 | $125,000 (1) | — | Michigan State University | No MLB; affiliated from 2019 | RELEASED |  |
| 401 | 13 | Jake Cantleberry (681147) | Yes 2019-06-11 | $125,000 (1) | — | University of Missouri | No MLB; affiliated from 2019 | RELEASED |  |
| 431 | 14 | Sean Mellen (673920) | Yes 2019-06-11 | $125,000 (1) | — | Northeastern University | No MLB; affiliated from 2019 | UNKNOWN |  |
| 461 | 15 | Joe Vranesh (687992) | Yes 2019-06-11 | $125,000 (1) | — | Saint Mary's College of California | No MLB; affiliated from 2019 | RELEASED |  |
| 491 | 16 | Andrew Baker (687900) | No | — | — | Chipola College | No MLB; affiliated from 2021 | UNSIGNED |  |
| 521 | 17 | Brandon Wulff (687034) | Yes 2019-06-19 | $75,000 (1) | — | Stanford University | No MLB; affiliated from 2019 | RELEASED |  |
| 551 | 18 | Jeff Belge (666122) | Yes 2019-06-11 | $125,000 (1) | — | St. John's University | No MLB; affiliated from 2019 | TRADED |  |
| 581 | 19 | Braidyn Fink (686253) | Yes 2019-07-12 | $222,500 (1) | — | University of Oklahoma | No MLB; affiliated from 2021 | UNKNOWN |  |
| 611 | 20 | Zack Plunkett (667407) | Yes 2019-06-28 | $25,000 (1) | — | University of Arkansas | No MLB; affiliated from 2019 | RELEASED |  |
| 641 | 21 | Trey LaFleur (687026) | No | — | — | J. M. Tate HS | No MLB; affiliated play not established | UNSIGNED |  |
| 671 | 22 | Jimmy Titus (687042) | Yes 2019-06-11 | $125,000 (1) | — | Bryant University | No MLB; affiliated from 2019 | TRADED |  |
| 701 | 23 | Cyrillo Watson (687041) | Yes 2019-06-11 | $125,000 (1) | — | University of Illinois at Urbana-Champaign | No MLB; affiliated from 2019 | RELEASED |  |
| 731 | 24 | Chet Allison (690822) | Yes 2019-07-12 | $222,500 (1) | — | Fresno City College | No MLB; affiliated from 2019 | RELEASED |  |
| 761 | 25 | Jonny DeLuca (676356) | Yes 2019-07-12 | $300,000 (1) | — | University of Oregon | MLB 2023-06-07 (LAD, age 24); 263 G, 836 PA | TRADED | 0.9 |
| 791 | 26 | Mark Mixon (687438) | Yes 2019-06-13 | $125,000 (1) | — | University of Miami | No MLB; affiliated from 2019 | UNKNOWN |  |
| 821 | 27 | Parker Brahms (687648) | No | — | — | California State University, Sacramento | No MLB; affiliated from 2021 | UNSIGNED |  |
| 851 | 28 | Brennan Milone (686810) | No | — | — | Woodstock HS | No MLB; affiliated from 2022 | UNSIGNED |  |
| 881 | 29 | Breyln Jones (690202) | Yes 2019-06-24 | $125,000 (1) | — | Rutherford HS | No MLB; affiliated from 2022 | RELEASED |  |
| 911 | 30 | Josh Ibarra (687996) | No | — | — | Golden West College | No MLB; affiliated play not established | UNSIGNED |  |
| 941 | 31 | Kayler Yates (687787) | No | — | — | Dixie HS | No MLB; affiliated play not established | UNSIGNED |  |
| 971 | 32 | Danny Sinatro (670235) | Yes 2019-06-11 | $100,000 (1) | — | Washington State University | No MLB; affiliated from 2019 | RELEASED |  |
| 1001 | 33 | Julio Carrion (676425) | Yes 2019-06-11 | $125,000 (1) | — | Chipola College | No MLB; affiliated from 2019 | RELEASED |  |
| 1031 | 34 | Francisco Martinez (687923) | Yes 2019-07-12 | $172,500 (1) | — | Puerto Rico Baseball Academy | No MLB; affiliated from 2019 | RELEASED |  |
| 1061 | 35 | Justin Washington (689656) | Yes 2019-06-11 | $50,000 (1) | — | Savannah State University | No MLB; affiliated from 2019 | RELEASED |  |
| 1091 | 36 | Matthew Kanfer (688694) | No | — | — | Pepperdine University | No MLB; affiliated play not established | UNSIGNED |  |
| 1121 | 37 | Tres Gonzalez (687206) | No | — | — | Mount Vernon Presbyterian School | No MLB; affiliated from 2022 | UNSIGNED |  |
| 1151 | 38 | Tyler Ryan (690710) | Yes 2019-06-11 | $5,000 (1) | — | University of the Pacific | No MLB; affiliated from 2019 | RELEASED |  |
| 1181 | 39 | Caden MacDonald (689721) | No | — | — | Pantego Christian Academy | No MLB; affiliated play not established | UNSIGNED |  |
| 1211 | 40 | Ty Haselman (674116) | No | — | — | University of California, Los Angeles | No MLB; affiliated play not established | UNSIGNED |  |

## Items for the reviewer

1. **Re-drafted players: fixed in Phase 8 (migration 022).** Josh McLain and Deacon Liput were drafted and unsigned in 2017, then drafted again in 2018 and signed.
   - In Phase 7 their dispositions lived on the player's outcome audit, so the 2018 class showed the 2017 UNSIGNED.
   - Dispositions now belong to each acquisition: 2017 UNSIGNED; 2018 RETIRED 2019-11-07 (McLain) and UNKNOWN (Liput: no exit on the wire). The database refuses UNSIGNED on a signed acquisition.
   - Nothing to decide; see [phase8-reviewer-packages.md](phase8-reviewer-packages.md#5-josh-mclain-and-deacon-liput-two-acquisitions-each-data-correction-no-decision-needed).
2. **Jimmy Lewis #78:** confirm MLB's structure (C-2, pick 1), the same decision as Sheffield 2016. The decision was taken by an operator label, so it blocks certification until you ratify it (`research:ratify`) or re-decide it (`research:reconsider`).
3. **Kody Hoese #25, $2,740,300:** this equals the slot. In 2019 both Baseball-Reference and Dodgers Digest record Busch (#31) at exactly slot as well, so for these first-rounders the figure is the reported one. The Dodgers' $2,500 per-pick deduction (see Smeltzer 2016) means a net figure could be $2,500 lower; no source gives one.
4. **Bonus discrepancies kept as evidence, not imported:**
   - Jimmy Lewis: Dodgers Digest $1,100,000 vs Baseball-Reference $1,097,500 (gross vs net);
   - Brandon Lewis: Dodgers Digest $372,500 vs Baseball-Reference $327,500 (transposed digits in one source).
   - The canonical values are Baseball-Reference's. Recommendation: accept, or import the Dodgers Digest table to open both as conflicts.
5. **Rule 5 recoding:** no December waiver claim appears for either class, so no recoding is needed. Ryan Ward and Alec Gamboa (2019) debuted in 2026, so the 2025-02 capture has no bWAR for them.
6. **Single-source bonuses (2018):** all 32 come from Baseball-Reference alone (no 2018 Baseball America capture was reachable). They are consistent with the slot pool and the wire. Corroboration is recommended before certifying, though it is not required.
