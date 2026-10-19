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

## Fixtures
- `database/fixtures/foundation.sql` is fictional. It is cited to a `TEST_FIXTURE` source and exists only to prove the schema handles each required shape.
- It must never be loaded into a research or production database.
