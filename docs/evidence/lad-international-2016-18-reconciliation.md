# LAD international 2016-17 and 2017-18: reconciliation and classification

Prepared 2026-10-20 (Phase 6). **Neither class is a census.** Both stay `PARTIAL_RECONSTRUCTION` with an unknown expected size, and nothing is certified. Replay: `research/runbooks/lad-2017-cohorts.mjs`, then `research/runbooks/lad-international-2016-18.mjs`.

## Populations compared

| Population | 2016-17 (2016-07-02 .. 2017-06-15) | 2017-18 (2017-07-02 .. 2018-06-15) |
|---|---|---|
| Candidate amateurs by rule, from the MLB transaction wire | 45 | 50 |
| Independent list consulted | Dodgers Digest's July 2016 report of the first signing (Albert Suarez, reported $300,000); no complete list found | the club's 2017-07-03 announcement of 26 signings (Dodgers Digest, 2017-07-04) |
| Matched | Suarez | **25 of 26** matched by hand to MLBAM ids (spellings differ: "George"/"Gorge" Heredia, "Tomjansen"/"Tomsjansen", "Jession"/"Jeisson" Cabrera) |
| On the list but not in the wire population | — | **Jonathan Alvarez** (RHP, DOM): no LAD signing entry and no MLBAM identity; **a Cuban OF Jaime Perez** reported 2017-07-02, distinct from MLBAM 676015 |
| In the wire population but not on the list | most of the 45 (no list to compare) | 25 (later signings in the period, e.g. Miguel Vargas, Andy Pages; the announcement covers the first days only) |
| Pool context (reported) | $2,118,900 pool, max $300,000 per player (penalty for 2015-16) | $4.75 million plus traded space (Jason Wheeler to BAL), max $300,000 per player |

**What this shows.** The wire-derived population is not complete: the club announced at least one signee the wire never records. Only one 2017-18 list exists, and it covers the first days of the period. So the class size remains unknown, and the coverage state must not move beyond `PARTIAL_RECONSTRUCTION` until a full published class list (for example Baseball America's period signing lists) is read.

## Classification

| Category | 2016-17 | 2017-18 | Treatment in BAI |
|---|---|---|---|
| **Amateur international signings** (born outside US/CA/PR, never drafted, age ≤ 22, no earlier affiliated season) | 45 rule-classified; Suarez corroborated by a report | 50 rule-classified; 25 corroborated by the club announcement | `INTERNATIONAL_AMATEUR`, flagged `PATHWAY_BY_RULE` |
| **Exempt professionals** | **José Miguel Fernández** (Cuba, 28, 2017-01-11): minor-league deal reported as outside the bonus pools; bonus "around $200,000" (MLB.com via Dodgers Digest) | none established | Fernández imported as `INTERNATIONAL_PROFESSIONAL`, flagged `PATHWAY_CLASSIFIED_BY_RESEARCHER`; bonus NULL (an approximation is not a figure) |
| **Previously affiliated professionals** (minor- or major-league free agents; not part of an international class) | Narciso Mesa (DSL/GCL Nationals from 2010), Wilmer Font (MLB 2012), Fabio Castillo (Rangers system from 2006), Kenley Jansen (MLB re-signing), Franklin Gutierrez, Jair Jurrjens, Daniel Corcino (MLB), Justin Masterson (drafted 2006) | Shawn Zarraga (drafted 2007), Jose Brizuela (drafted 2014), Manny Banuelos, C.C. Lee, Donovan Solano (MLB), Hamlet Marte (Rockies system from 2011) | Not imported into the international classes (MLB Stats API seasons; listed in the class's review job) |
| **Ambiguous** | **Yordan Alvarez** (Cuba, 19): the wire dates his contract 2016-07-15 (2016-17). MLB.com, Baseball America and Dodgers Digest report a $2,000,000 agreement on 2016-06-15, the last day of 2015-16, charged to the 2015-16 pool | **Darien Núñez** (Cuba, 25): Dodgers Digest infers pool exemption from his age, but exemption under the 2017–2021 agreement also needs six professional seasons, not established. **Guillo Zuñiga** (Colombia, 19): signed by the Braves in 2016 and freed by MLB's 2017-11-21 ruling on Atlanta's violations; a young international player with an earlier affiliated season. **Martin Santana**: announced 2017-07-03, but the wire dates the contract 2017-10-20. **Jonathan Alvarez** and **the July 2017 Jaime Perez**: unidentified | Researcher jobs in the class (`decide-yordan-alvarez-period`, `classify-darien-nunez`, `martin-santana-date`, `identify-jonathan-alvarez`, `identify-jaime-perez-2017`); Zuñiga stays in the "outside the rule" review job |
| **Not international** | — | **Aldrich De Jongh** (Curaçao, drafted 2018): a draft acquisition | belongs to the 2018 draft class |

Recommendation for Yordan Alvarez: record the signing in 2015-16 with the agreement date and the $2,000,000 bonus (a corrective batch, reviewed by a person), because pool accounting follows the agreement. The 2016-17 wire record would then be superseded.

## Bonuses

| Player | Period | Bonus | Source | Status |
|---|---|---|---|---|
| Albert Suarez | 2016-17 | $300,000 | Dodgers Digest 2016-07-02 ("signed for a reported $300,000"), repeated 2017-07-04 | imported (REPUTABLE_SECONDARY) |
| Gorge (George) Heredia | 2017-18 | $300,000 | Dodgers Digest 2017-07-04: "Baseball America has been able to confirm three bonuses" | imported |
| Amin Valdez | 2017-18 | $300,000 | same | imported |
| Eddys Leonard | 2017-18 | $200,000 | same | imported |
| Julio Enrique, Jaime Perez | 2017-18 | $300,000 / $200,000 | a report Dodgers Digest calls of doubtful reliability | **not imported** |
| José Miguel Fernández | 2016-17 | "around $200,000" | MLB.com (Sanchez) via Dodgers Digest | **not imported** (approximate) |
| Yordan Alvarez | 2015-16 | $2,000,000 | MLB.com, Baseball America, Dodgers Digest | pending the period decision |

Costs known: 2016-17 has 1 of 46 signings; 2017-18 has 3 of 50. Each period's $300,000 cap is an upper bound for every pool-subject amateur bonus. It is not stored as a value.

## Certification blockers (both classes)

- **STAGE:** the class is at `DISCOVERY`.
- **EXPECTED_UNIVERSE:** no complete published list has been read, so the size is unknown.
- **COST:** 45 and 47 unknown costs, not yet closed as unknown after research.
- **OPEN_JOBS:** cost jobs, the review job for signees outside the rule, and the ambiguity jobs above.
- **Outcome audits:** 0 of 46 and 0 of 50 (not a certification requirement).

## Next sources

1. Baseball America's period lists of Dodgers international signings: the most complete published lists, which may settle the universe and bonuses.
2. MLB.com's international signing trackers (Jesse Sanchez) for 2016-17 and 2017-18.
3. Dodgers press releases for later signing batches.

## Phase 7 follow-up (2026-10-20)

MLB's season rosters for every Dodgers rookie-level club (DSL 611/612, AZL 2690/5427; `teams/{id}/roster?season=…&rosterType=fullSeason`, 2017–2019) were checked against each open question.

| Question | Evidence | Status | Recommendation |
|---|---|---|---|
| **Jonathan Alvarez** (announced 2017-07-03) | No LAD signing entry on the wire, no MLBAM identity. Absent from all eight Dodgers rookie-level rosters in 2017–2019. The only "Jonathan Alvarez" found in reference data is a 2019 DSL Cubs pitcher (The Baseball Cube), not linked to LAD. | **Unresolved** | Keep him out of the class: an announcement alone is not a signing BAI can tie to a player. Record the job as unknown after research unless a club or MLB source identifies him. |
| **The July 2017 "second" Jaime Perez** | MLB data holds one Cuban OF Jaime Perez in the system (676015, signed 2017-05-29), on the DSL and AZL rosters 2017–2019. No second player appears. Dodgers Digest itself called the report doubtful. | **Unresolved; likely no second player** | Close as unknown after research. No player is created. |
| **Martin Santana** | The wire dates the contract 2017-10-20; the club announced him on 2017-07-03. He played for the DSL Dodgers in 2018 and 2019 (679756). Both dates fall in 2017-18. | **Resolved for classification** (2017-18 amateur) | Keep the wire's contract date as the signing date and the announcement as a note. The period is unaffected. |
| **Yordan Alvarez** | Agreed 2016-06-15 for $2,000,000 (MLB.com, Baseball America, Dodgers Digest), the last day of 2015-16; contract on the wire 2016-07-15; traded to HOU 2016-08-01. | **Documented, not corrected** | Belongs to 2015-16 by pool accounting. BAI has no mechanism yet to move a recorded signing to another period: the period comes from the date. A reviewer-approved corrective batch plus a "superseded signing" mechanism is needed, so his record stays in 2016-17 with the open job. |
| **Darien Núñez** | Age 25 at signing (2018-04-16). Serie Nacional 2011–2015 (Wikipedia; Baseball-Reference Bullpen: debut 2011-12 with Las Tunas), about four seasons. Under the 2017–2021 agreement, an exempt professional is 25 or older **and** has six professional seasons. | **Recommended: pool-subject, not exempt** (contrary to Dodgers Digest's age-only inference) | Classify as an international amateur (pool-subject) outside BAI's age-22 discovery rule, once a reviewer accepts that the season count is established. Not imported. |
| **Guillo Zuñiga** | Signed by Atlanta 2016-07-02; GCL Braves 2017; freed by MLB's 2017-11-21 ruling on Atlanta's violations; signed by LAD 2017-12-06; AZL Dodgers 2018. | **Documented: a distinct category** | Neither a fresh amateur nor an ordinary minor-league free agent. Add a pathway note ("freed by MLB ruling") rather than force him into either class. Not imported. |

Coverage stays `PARTIAL_RECONSTRUCTION` for both periods. No bonus was added in Phase 7; every figure above is either already on record or not a figure BAI can verify.
