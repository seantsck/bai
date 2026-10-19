# Research methodology

BAI is a research database first and an app second. These rules are enforced in the schema wherever possible and tested in `tests/db`.

## 1. Public data only
- Every researched fact cites a registered source.
- `sources.publicly_accessible` is constrained to `true`.
- BAI stores no private or credentialed data and no paywalled prose.

## 2. Provenance for researched facts
- Each researched-fact table has a NOT NULL `source_id`. The tables are registered in `provenance_fact_tables`, and a test enforces the rule.
- Field-level claims go to `source_observations`. When sources disagree, both observations stay and the conflict is surfaced for review. Nothing is silently overwritten.
- Superseded or retracted observations keep their history.
- **Source authority** (OFFICIAL, PRIMARY_PUBLIC, REPUTABLE_SECONDARY, AGGREGATOR, ARCHIVE, OTHER) is metadata for reconciliation. It is never a truth value. See [source-policy.md](source-policy.md).
- **No last-write-wins.** A later batch never replaces an existing canonical value; it adds an observation and opens a conflict.
- **Traceable resolution.** A resolved conflict records the chosen observation, every observation considered, the rule or operator, and the rationale (`fact_resolutions`).
- **Staged ingestion.** All research data enters through staged batches with a dry run first. See [research-ingestion.md](research-ingestion.md) and [identity-resolution.md](identity-resolution.md).

## 3. Missing is not zero
- Unknown money is `NULL`.
- A known zero is `0`, recorded only when a source establishes it (or the rule makes a component inapplicable *and* that is documented).
- `known_total_cost_usd` sums known components only, and `cost_completeness` says whether that total is the full cost.
- Missing WAR is no row. `war_value` cannot be NULL, and no view coalesces WAR to zero.
- The UI renders unknowns as "Unknown" or "Not observed", never `$0` or `0.0`.

## 4. Unaudited is not failed
- Outcome states are explicit: NOT_AUDITED, AUDITED_REACHED_MLB, AUDITED_NO_MLB, ACTIVE_TOO_RECENT, OUT_OF_SCOPE and UNKNOWN.
- Only `AUDITED_*` states enter reach-rate denominators. Too-recent, out-of-scope, unknown and unaudited players are reported separately.
- Audit state must agree with debut evidence (deferred constraint triggers).
- Each audit records `observation_through_season`, so "no MLB" always means "none observed through season N".

## 5. Tracked is not the complete population
- Coverage is recorded per domain, scope and organization, in one of six states:

  | State | Meaning |
  |---|---|
  | COMPLETE_CENSUS | the defined population has a known size and every member is tracked; requires a source |
  | SUBSTANTIALLY_COMPLETE | known size, nearly all tracked, gaps written down; requires a source |
  | PARTIAL_RECONSTRUCTION | a reconstructed subset; the size may be unknown |
  | RANKED_SAMPLE | membership comes from appearing on a published list; requires the sample basis |
  | INDIVIDUALLY_VERIFIED | ad hoc verified records |
  | UNKNOWN | not assessed |

  A RANKED_SAMPLE is selected on expectation, so it is biased toward success.
- Population rates (reach rates, conversion rates) are computed only for scopes where `coverage_supports_population_rate(state)` is true, which means COMPLETE_CENSUS or SUBSTANTIALLY_COMPLETE.
- Without coverage rows, every count reads as incomplete.

## 6. Acquisition-time expectations cannot use hindsight
- An expectation is structured evidence published **before** the acquisition: a rank, a board position, an FV or tool grade when the source published one explicitly, and the evaluation date and source.
- The acquisition cutoff is the exact signing or selection date. If an international signing's exact date is unknown, the period start is used, which is conservative.
- Evidence must be published strictly before the cutoff. Same-day lists are excluded because publication time is not tracked.
- Links must match the player and the channel (an international list cannot set a draft expectation).
- No copyrighted scouting prose is stored. `summary_note` is a short BAI paraphrase.

## 7. Separate what is easy to conflate
- **Expectation vs realized outcome**: different tables, joined only for comparison.
- **Career value vs organization-realized value**: separate WAR observation scopes (CAREER vs ORGANIZATION_TENURE).
- **Cost components**: bonus, posting fee, transfer fee and other cost are separate columns.
- **Organizational value**: six classes. One WAR observation is credited to an organization at most once. Value that left an organization is reported, never added to its realized value.
- **Draft selection vs signing**: a selection is a fact whether or not the player signed. An unresearched signing is UNKNOWN, not "did not sign".
- **Pathways**: amateur, posting, other international professional and other are never collapsed.

## 8. No unsupported causal or predictive claims
- BAI currently publishes descriptive, coverage-qualified facts only. There are no probabilities or predictions.
- Associations (e.g. trainer ↔ outcome) are not presented as effects.
- Any future model must clear explicit sample-size and validation gates (DISI 041 is the reference) and must be presented with its limitations.

## 9. Dates and precision
- Dates carry a `date_precision` (DAY, MONTH, SEASON, YEAR, UNKNOWN). A season-precision date is never treated as an exact day; for example, period-boundary checks apply only to DAY precision.
- Signing periods are explicit date ranges. The calendar has shifted over time, so it is never derived from a year.

## 10. Serving discipline
Heavy analytics are refreshed deliberately into bounded read models. A public request never triggers the analytical graph (see [architecture](architecture.md)).

## 11. Calendars are sourced data
- **Drafts:** the 2015–2026 Rule 4 drafts carry their dates, round counts and rules era, each backed by `source_observations`. Highlights:
  - 40 rounds through 2019;
  - 5 rounds in June 2020, held remotely;
  - 20 rounds and a July date from 2021;
  - a two-day format from 2025.
- **International periods:** 2014-15 through 2026 are stored as date ranges, never calendar years:
  - July 2 – June 15 until the pandemic;
  - 2019-20 extended to Oct 15, 2020;
  - 2020-21 moved to Jan 15 – Dec 15, 2021;
  - Jan 15 – Dec 15 since.

  There is no period between Oct 16, 2020 and Jan 14, 2021.
- **Open future dates:** the 2026 period's Dec 15 close is the scheduled date. It had not been reached on the research date, and the CBA expires Dec 1, 2026.
- **Disagreements:** where sources disagreed, the alternative claim is kept and the choice is recorded with a rationale (see [source-policy.md](source-policy.md)).

## 12. Coverage claims are conservative
- **Default:** an import's coverage claim applies only to its declared scope. Every other cell it touches becomes INDIVIDUALLY_VERIFIED.
- **Pilot cohorts:** stay PARTIAL_RECONSTRUCTION unless documentary evidence establishes a complete population. Even then, a cell is promoted only after a review that writes down the gaps.
- **The 2015 Dodgers draft class is the worked example:** 42 of 42 picks are tracked, yet the class is held at PARTIAL_RECONSTRUCTION because half the bonuses are missing and no outcomes are audited.

## Fixtures
- `database/fixtures/foundation.sql` is fictional. It is cited to a `TEST_FIXTURE` source and exists only to prove the schema handles each required shape.
- It must never be loaded into a research or production database. Both tools enforce this: `research:import` refuses a database that holds the fixtures, and `db:fixtures` refuses a database that holds research batches.
