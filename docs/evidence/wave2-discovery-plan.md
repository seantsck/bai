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
2. Baseball-Reference franchise draft page through the Wayback Machine (`index.fcgi?query_type=franch_year&team_ID=<B-Ref code>&year_ID=2016&draft_type=junreg`): signed, bonus, school. **To check:** the archive rate-limited the capture lookups on 2026-10-20. B-Ref codes: ATL, BAL, HOU, NYY, SDP, TBR.
3. Baseball America "2016 Draft Selections" (capture 2026-04-29, already downloaded for LAD; one page covers all clubs): bonuses, through `ba-draft-bonuses-import.mjs --club-label <Braves|Orioles|Astros|Yankees|Padres|Rays>`.
4. MLB.com 2016 pick values and signing tracker (captures already used for LAD; one page covers all clubs): slots for rounds 1–10 and bonuses.
5. The MLB wire for the draft window: signing status and dates (`draft-signings-from-wire.mjs`).
6. Outcomes: the MLB Stats API (`fetch-mlb-player-outcomes.mjs`, at most 60 players per run). Season WAR comes from pre-season Baseball-Reference captures (`fetch-bref-player-pages.mjs`).

**International (2016-17):**
1. The MLB wire: the rule-classified candidate population (`intl-signings-from-wire.mjs`).
2. Independent lists, transcribed into `research/evidence/`: Baseball America's period lists, MLB.com (Jesse Sanchez) signing trackers, club announcements and team-blog July 2 reports.
3. Pool and penalty context per club and period, from the MLB.com pool articles.

**Order:** the priority engine (wave → category → class chronology → club → channel). The draft and international classes of the same year advance together.

## Blockers before Wave 2 can start importing

- A reviewer sets the waves and confirms the set.
- The Baseball-Reference capture check for the six 2016 draft pages; the archive was rate-limited today.
- LAD 2016/2017 certification first. The roadmap's gate: a wave does not open its next year until the previous year's draft classes are certified or explicitly parked.
