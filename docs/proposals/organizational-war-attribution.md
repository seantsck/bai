# Proposal: organizational WAR attribution

Status: **proposal** (Phase 6, 2026-10-20). Not implemented and not part of the 020 release. It builds on tables that already exist (`war_observations`, `transactions`, `trade_packages`, `trade_package_assets`, `organization_value_attributions` from 008/010) and adds what they lack.

## Problem

BAI records career WAR per player (Baseball-Reference, as of a capture). Career WAR answers "how good did this acquisition become?". It does not answer "what did the acquiring organization get?":

- **Departed value.** Dean Kremer (LAD 2016, 14th round) produced his WAR for Baltimore after a trade. That value belongs to LAD only as trade return, through what LAD received for him.
- **Unsigned picks.** Bailey Ober and Graham Ashcraft (LAD 2016, unsigned) produced WAR for clubs that drafted them later. LAD gets nothing.
- **Split careers.** A player like Gavin Lux produced value for LAD, then elsewhere after a trade.

Summing career WAR by acquiring club conflates all three. The design below keeps them apart and never sums across them.

## Quantities

For an acquisition *A* (one draft selection or international signing) by organization *O*:

| Quantity | Definition | Stored as |
|---|---|---|
| **Career WAR** | All MLB WAR the player produced, per provider, through a season | `war_observations` scope `CAREER` (exists) |
| **WAR with the signing organization** | WAR in seasons, or season splits, while under contract to *O* from the acquisition, before the first exit | sum of `SEASON` observations per team split, inside *O*'s tenure intervals |
| **WAR with later organizations** | Career WAR minus WAR with *O*, split per organization | `SEASON` splits outside *O*'s first tenure |
| **Trade-return value** | WAR the players received in a trade of *A* produced **for O**, recursively through further trades, with a depth limit | `organization_value_attributions` class `TRADE_RETURN` / `PLAYER_ATTRIBUTABLE_DOWNSTREAM` / `PACKAGE_ATTRIBUTABLE` (exists) |
| **Organizational retention** | Whether and how long *A* stayed with *O*: tenure intervals, seasons of control, exit type (traded, released, Rule 5, free agency) | `player_organization_tenures` (new) plus `outcome_audit_details.disposition` (exists) |
| **Departed value** | WAR produced after the player left *O*, other than through a trade return | class `VALUE_LEFT_ORGANIZATION` (exists); reported next to realized value, never added to it |

**Realized value to O** = WAR with *O* + trade-return value. Departed value is shown beside it as an opportunity measure.

## Design

### 1. Season splits per provider (data)

- Use the existing `war_observations`, scope `SEASON`, with `organization_id` set (one row per player, provider, season and team), plus `through_season` and `observed_on`.
- **Baseball-Reference and FanGraphs stay separate rows** (`war_system`). They are never averaged, never mixed in one sum, and never used to fill each other's gaps. Every rollup is grouped by `war_system`.
- Teams in a season split map to organizations by the season's MLB club. Minor-league time has no WAR.
- **Sources:** Baseball-Reference player pages (archive captures; the live site refuses automated requests). FanGraphs only when it is observable; it currently refuses requests and has no archive copy, so FanGraphs values stay **not observed**, never estimated.
- **Import:** extend the OUTCOMES channel with `war[]` entries of scope `SEASON` and `organization`. This already validates (020 accepts `SEASON` and `ORGANIZATION_TENURE` scopes). A rival value from another capture becomes a conflict, never an overwrite.

### 2. Tenure intervals (new table, migration 021 if accepted)

```
player_organization_tenures (
  id, player_id, organization_id,
  start_date, start_precision, start_transaction_id null,   -- signing, trade-in, claim, Rule 5 selection
  end_date null, end_precision null, end_transaction_id null, -- null end = still with the organization as of as_of_date
  end_type  (TRADED | RELEASED | LOST_WAIVERS | LOST_RULE_5 | FREE_AGENCY | RETIRED | RETURNED | UNKNOWN),
  as_of_date, source_id, notes
)
exclusion constraint: no overlapping intervals per player (btree_gist, already installed)
```

- Derived by a builder from the MLB transaction wire, the same evidence the outcome audits use. Rule 5 coding comes from researcher-verified lists, because MLB's wire records some Rule 5 selections as waiver claims.
- A **returned Rule 5 player** gets `end_type = RETURNED`, and a new interval for *O* follows.
- Intervals are facts with provenance, so a disagreeing source is a conflict.

### 3. Attribution (derived, reproducible)

- A deterministic function, `analytics.attribute_value(org, acquisition, war_system, through_season)`, writes `organization_value_attributions` rows:
  - Each `SEASON` observation is credited once per organization: the existing `unique (organization_id, war_observation_id)` constraint prevents double counting.
  - **DIRECT_ACQUIRING_ORGANIZATION:** a season split whose team maps to *O* and whose season falls inside one of *O*'s intervals for this acquisition.
  - **TRADE_RETURN:** a season split of a player received in a trade package that sent *A* away, while that player was with *O*.
  - **PACKAGE_ATTRIBUTABLE:** *A* left as one of several assets in a package. The return is credited to the package, not split among its players (no invented weights).
  - **VALUE_LEFT_ORGANIZATION:** *A*'s splits after its first exit, credited to *O* only in this class.
  - **Recursion:** follow trade chains to depth 2 by default, recorded in `basis_note`. Deeper value is `OBSERVABLE_NOT_ATTRIBUTABLE`.
- Attribution rows cite the WAR observation's source, plus a `bai-derivation:` source naming the function version.
- Re-running with the same inputs produces the same rows (tested like the pilot reconciliation).

### 4. Missing values and confidence

- **Unknown is never zero.** A season with no observed split gives NULL WAR for that season, never 0.0. A player with no MLB time is reported as "no MLB WAR" (audited), which is distinct from "WAR not observed".
- Coverage per acquisition and provider:
  - `COMPLETE`: every MLB season has a split observation;
  - `PARTIAL`: some seasons are missing;
  - `CAREER_ONLY`: only a career total, so it cannot be split;
  - `NOT_OBSERVED`.
- **Confidence flags,** stored and shown, never folded into the number:
  - `MIDSEASON_TRADE_SPLIT_FROM_TEAM_TOTALS`: the split was computed, not published;
  - `TENURE_DATE_MONTH_PRECISION`;
  - `RULE5_FROM_SECONDARY_SOURCE`;
  - `PACKAGE_RETURN_NOT_SPLIT`.
- Rollups (class, organization, era) report sums **and** the count of acquisitions in each coverage state. A class rollup is shown only when every member's coverage is at least `PARTIAL` for that provider, and it is labelled with the share of seasons observed.
- **As-of discipline:** every number carries `war_system`, `through_season` and `observed_on`. Rollups never mix captures from different dates without saying so.

### 5. Rates and comparisons

Organization-level comparisons (WAR per $ of bonus, realized value per class) inherit the existing gates: census coverage, a certified class, all outcomes audited, plus WAR coverage `COMPLETE` for the chosen provider. Until then, the read models show counts and coverage, not rates.

## Worked example (LAD 2016, illustrative of the rules, not computed)

- **Will Smith (RETAINED):** all of his career WAR is DIRECT (as of the capture).
- **Dean Kremer (TRADED 2018 to BAL in the Manny Machado trade):** his WAR is VALUE_LEFT_ORGANIZATION. LAD's realized value is the TRADE_RETURN: Machado's 2018 LAD season splits, credited to the package because Kremer left with four other players.
- **Bailey Ober (UNSIGNED):** LAD gets nothing, and his career WAR appears only as "unsigned pick, later value elsewhere" in class reports.

## Phasing

1. Import Baseball-Reference season splits for the LAD 2016 and 2017 classes (data only; 020 suffices).
2. Migration 021: `player_organization_tenures` plus the tenure builder, after review.
3. The attribution function and read models, tested on the LAD 2016 class against a hand-worked fixture.
4. FanGraphs only if it becomes observable.

## Open questions for review

- **Recursion depth:** 2 is proposed.
- **Package returns:** keep them unsplit (proposed), or split by a published method?
- **Waiver claims back by the original club:** a new interval for *O* (proposed).
