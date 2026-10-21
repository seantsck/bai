# Wave 2: readiness review and source discovery plan

Prepared 2026-10-20 (Phase 7). The proposed Wave 2 clubs are **ATL, BAL, SD, TB, HOU, NYY** ([league-wide roadmap](../proposals/league-wide-cohort-roadmap.md)). Nothing is imported or certified, and no program wave is set: setting one is a human decision (`research:wave`).

## Review of the proposed set

| Club | Why it was proposed | Assessment |
|---|---|---|
| ATL | 2016-17 / 2017-18 international sanctions; MLB freed its prospects (one, Guillo Zuñiga, is already a LAD 2017-18 signee) | **Keep.** The sanction case tests whether the classification handles voided and freed signings. |
| BAL | Received LAD 2016 and 2017 picks in the 2018 Machado trade | **Keep.** It tests attribution from the receiving side: Kremer's WAR is BAL's own production there. |
| SD | Heavy 2016-17 international spending | **Keep.** The contrast case for LAD's $300,000 cap years. |
| TB | Draft-and-develop reputation; trade partner (Witt 2019, Raley 2022) | Keep. |
| HOU | Analytics-driven drafting; traded for Scrubb (2019) | Keep. |
| NYY | Large international pools; MLB.com coverage is plentiful | Keep. It is the easiest club for sources, which makes it a useful calibration case. |

No change is recommended. A reviewer sets the waves with:

```bash
for c in ATL BAL SD TB HOU NYY; do npm run research:wave -- --org $c --wave 2 --rationale "<criterion>" --operator "<reviewer>"; done
```

## No organization-specific code

- **Search:** I searched `scripts/research/` and migrations 019–023 for club literals and team ids. The only hits are:
  - the complete 30-club Baseball-Reference team-code map (`sources/lib/bref-player.mjs`);
  - the default club label in `mlbcom-draft-money-import.mjs`, which now handles multi-word nicknames (Red Sox, White Sox, Blue Jays).
- **Builders:** every builder takes the club as `--org` / `--team-id` / `--club-label`.
- **Attribution views:** the 022/023 views key on `organization_id` only.
- **Tests:** the value tests use LAD- and BAL-shaped fixtures, and the decision tests use KC; neither needs club-specific code.

## Prepared (local, `research/runbooks/wave2-2016-slice.mjs`)

For each club, the 2016 draft class and the 2016-17 international class are created and planned, with verified leads:

| Club | MLB team id | 2016 draft picks (MLB official) | 2016-17 signing entries on the wire (before classification) |
|---|---|---|---|
| ATL | 144 | 42 | 76 |
| BAL | 110 | 41 | 61 |
| HOU | 117 | 40 | 53 |
| NYY | 147 | 40 | 69 |
| SD | 135 | 43 | 91 |
| TB | 139 | 41 | 69 |

## Source discovery plan per class (same for every club)

**Draft (2016):**
1. MLB Stats API draft (`teamId`): the universe. **Verified for all six.**
2. Baseball-Reference franchise draft page through the Wayback Machine (`index.fcgi?query_type=franch_year&team_ID=<B-Ref code>&year_ID=2016&draft_type=junreg`): signed, bonus, school. **Checked in Phase 8:** every club has captures (2024-08 to 2026-08). B-Ref franchise codes: ATL, BAL, HOU, NYY, SDP, and **TBD** for Tampa Bay (not TBR).
3. Baseball America "2016 Draft Selections" (capture 2026-04-29, already downloaded for LAD; one page covers all clubs): bonuses, through `ba-draft-bonuses-import.mjs --club-label <Braves|Orioles|Astros|Yankees|Padres|Rays>`.
4. MLB.com 2016 pick values and signing tracker (captures already used for LAD; one page covers all clubs): slots for rounds 1–10 and bonuses.
5. The MLB wire for the draft window: signing status and dates (`draft-signings-from-wire.mjs`).
6. Outcomes: the MLB Stats API (`fetch-mlb-player-outcomes.mjs`, at most 60 players per run). Season WAR comes from pre-season Baseball-Reference captures (`fetch-bref-player-pages.mjs`).

**International (2016-17):**
1. The MLB wire: the rule-classified candidate population (`intl-signings-from-wire.mjs`).
2. Independent lists, transcribed into `research/evidence/`: Baseball America's period lists, MLB.com (Jesse Sanchez) signing trackers, club announcements and team-blog July 2 reports.
3. Pool and penalty context per club and period, from the MLB.com pool articles.

**Order:** the priority engine (wave → category → class chronology → club → channel). The draft and international classes of the same year advance together.

## Phase 8: 2016 drafts imported (local; hosted after replay)

`research/runbooks/wave2-2016-drafts.mjs` imports the six 2016 draft classes, universe and identity first:

| Club | Picks (MLB census) | Signed / did not sign (B-Ref) | Bonus known | B-Ref capture | Numbering disputes (proposals) |
|---|---|---|---|---|---|
| ATL | 42 | 34 / 8 | 28 of 34 | 2025-08-23 | #40 Joey Wentz, #76 Brett Cumberland |
| BAL | 41 | 34 / 7 | 25 of 34 | 2026-02-09 | none |
| HOU | 40 | 31 / 9 | 18 of 31 | 2025-10-21 | none |
| NYY | 40 | 28 / 12 | 20 of 28 | 2025-08-22 | none |
| SD | 43 | 32 / 11 | 26 of 32 | 2026-08-03 | #71 Reggie Lawson |
| TB | 41 | 30 / 11 | 18 of 30 | 2025-08-23 | #77 Jake Fraley |

- **Identity:** MLBAM from MLB; Baseball-Reference ids from the draft page. Four spellings were confirmed by hand (same pick, club and school): NYY #728 Joseph/Joe Burton; SD #594 Dominic/Dom DiSabatino, #954 Ariel Burgos Garcia/Ariel Burgos, #1134 William/Will Solomon.
- **Signing status and bonuses** come from one AGGREGATOR source (B-Ref). Unknown bonuses stay unknown.
- **Numbering disputes:** each is an open conflict with a proposal to keep MLB's competitive-balance structure. Nothing is decided.
- **Next stages per class:**
  - slots and tracker bonuses (MLB.com 2016 pages, already captured for LAD; they cover every club);
  - Baseball America 2016 corroboration;
  - signing dates from the wire;
  - outcomes.

## Phase 8: 2016-17 international candidates (local; hosted after replay)

`research/runbooks/wave2-2016-17-international.mjs` imports each club's candidate amateur signings from MLB's transaction wire by the documented rule (born outside the draft-eligible areas, never drafted, 22 or younger, no earlier affiliated season):

| Club | Unique signees on the wire | Foreign-born, undrafted | Imported candidates | Outside the rule (unresolved) |
|---|---|---|---|---|
| ATL | 76 | 43 | 31 | 12 |
| BAL | 58 | 18 | 5 | 15 |
| HOU | 53 | 43 | 37 | 6 |
| NYY | 67 | 43 | 37 | 7 |
| SD | 90 | 59 | 46 | 13 |
| TB | 68 | 39 | 36 | 3 |

- **Every class stays `PARTIAL_RECONSTRUCTION`** with an unknown size. Every record carries `PATHWAY_BY_RULE`, and no bonus is known (the wire gives none).
- **The 56 signees outside the rule are not imported.** They are listed in [`research/evidence/wave2-2016-17-international-unclassified.md`](../../research/evidence/wave2-2016-17-international-unclassified.md): veterans, players with earlier affiliated seasons, and older Cuban or Mexican signees whose pathway (exempt professional, or pool-subject) needs a source. They stay unresolved, not guessed.
- **ATL 2016-17** includes contracts MLB later voided (the November 2017 sanctions). Which candidates they were is not established yet, so none is marked voided.
- **Next stages per class:**
  - an independent list (Baseball America period lists, MLB.com trackers, club announcements) to corroborate the candidates and add bonuses;
  - pool context per club.

## Blockers (Phase 7 view, updated)

Phase 8 was directed to begin Wave 2 research. The capture check is done. The waves are still unset (a human decision), and LAD 2016/2017 are still uncertified, so the roadmap gate still holds for **2017** Wave 2 classes. The Phase 7 list:

- A reviewer sets the waves and confirms the set.
- The Baseball-Reference capture check for the six 2016 draft pages; the archive was rate-limited today.
- LAD 2016/2017 certification first. The roadmap's gate: a wave does not open its next year until the previous year's draft classes are certified or explicitly parked.
