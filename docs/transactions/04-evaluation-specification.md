# Phase 15C: transparent evaluation specification and ranking eligibility

Specification only. **No score, grade or ranking is produced, stored or shown in this phase**, and the model in `03` has no column for one. Version 1 reports components side by side with their evidence and assumptions. A composite is only considered after the validation step at the end, and only with an explicit owner decision.

## Two independent assessments
They share transaction identity and nothing else. Neither may read the other's outputs, and they are never combined, averaged or netted in v1.

### A. Decision-time assessment (information available before the transaction)
Each run records `information_cutoff_date` (the day before the transaction's announced date). **Every input must carry a published or observed date on or before the cutoff**, enforced by a deferred database trigger (`03`). Anything dated later is rejected, including season-end WAR, later injuries and later trades.

| Component | Allowed inputs | Not allowed |
|---|---|---|
| A1 Incoming assets' expected production | a **dated, published projection** from a source cleared for the use (archived copy dated on or before the cutoff); statistics through the cutoff observed before it | any outcome after the cutoff; any projection reconstructed now |
| A2 Control horizon | contract terms and service-time evidence available at the time (years, options, arbitration/FA status) | later extensions, later option decisions |
| A3 Outgoing assets | dated published prospect rankings and evaluations (005), published draft-slot values (007) for picks, statistics through the cutoff | later rankings, whether the prospect developed |
| A4 Cost | known salary and obligations as of the cutoff (`contract_terms.as_of_date <= cutoff`), cash in the trade | amounts learned later |
| A5 Context | standing and games back at the date, payroll and tax thresholds published before it, roster state | postseason result, final standings |
| A6 Horizon class | RENTAL (control ends within the current season or next free agency), SHORT (2-3 seasons), LONG (4+), UNKNOWN when control cannot be established | guessing from age or reputation |

A run ends in one state: `ASSESSABLE` (all required inputs present), `PARTIAL` (some components NOT_OBSERVED, listed), or `NOT_ASSESSABLE`. Missing is never filled with a league average.

### B. Realized-outcome assessment (observed organizational value, costs, retained assets)
Computed only from observed facts, as of a stated date, per WAR provider, reusing 010/022/023.

| Component | Definition | Source in BAI |
|---|---|---|
| B1 Value received | WAR the incoming players produced **for the receiving club** from the trade season until the club next traded them away (the 023 rule), per provider, never split across the players sent | `analytics.trade_returns` |
| B2 Downstream value | value from assets later re-traded (depth limit 2, then `OBSERVABLE_NOT_ATTRIBUTABLE`) and from acquired draft picks that signed (credited once, to the acquisition that signed) | `organization_value_attributions`, `acquisition_value` |
| B3 Value given up | WAR the outgoing players produced elsewhere afterwards, reported **beside** B1, never netted into it | `VALUE_LEFT_ORGANIZATION` |
| B4 Cost | salary actually owed from the trade date (prorated by days, an assumption flagged on the run), cash exchanged, buyouts if exercised, incentives only when earned | `contract_terms`, assets |
| B5 Retained assets | players still held, with remaining control (not valued in v1, listed) | dispositions |
| B6 Open or closed | the evaluation window is **closed** when every incoming asset's control has ended or a declared horizon cap is reached; otherwise **open** and excluded from any comparison | derived |

Postseason performance and championships are shown as context only; they are not valued.

## Cross-cutting rules
- **WAR-provider consistency.** Baseball-Reference and FanGraphs values are separate runs. Never mixed in one sum, never used to fill each other's gaps (existing policy). A club comparison uses one provider at a time, and a provider with any NOT_OBSERVED key asset is not comparable for that transaction. Disagreement between providers is shown as two outcomes, not resolved.
- **Salary and contract cost.** Use cash owed per season, not AAV; deferrals are separate terms; signing bonus timing is kept; luxury-tax effects are not computed unless a cleared source publishes them; arbitration salaries are not estimated. A contract with any undisclosed or unsourced term makes B4/A4 `INCOMPLETE`: show the known guaranteed minimum as a bound, produce no net figure.
- **Rental vs long-term.** Horizon class (A6) is displayed on every transaction and comparisons are only drawn within a class; a rental is never compared to a six-year control on raw totals.
- **Prospect value and downstream trades.** Prospects are valued in A3 only by dated published evidence. In B, a prospect's value is what he produced while with the club or what his later trade returned (depth limit 2); unproven prospects are `OPEN`, not zero.
- **Financial present value.** If dollars are converted at all, the discount rate and any dollars-per-WAR figure are **declared assumptions with a source or a stated rationale, versioned, and shown as a sensitivity set** (for example three rates), never a single hidden number. Without a cleared market-context source for a season, v1 reports WAR and dollars separately and does not convert.
- **Budget and market context.** Payroll, thresholds and market prices are context fields from cleared sources, not adjusters of the result.
- **Injuries and small samples.** Known injured-list time during the control window is listed (cleared source needed); partial seasons below a declared plate-appearance or innings floor are flagged `SMALL_SAMPLE`; no regression, no extrapolation in B. A projection of an injured player is only allowed if dated before the cutoff.
- **Missing data ladder.** Every component is one of `OBSERVED`, `NOT_OBSERVED`, `NOT_APPLICABLE`, `ASSUMPTION_BOUND`; unknown is NULL, never zero (a player audited with no MLB time has zero MLB WAR as a fact, as in 023).
- **Executive attribution.** Order of evidence, strongest first: `CONFIRMED_DECISION_MAKER` (a source says who made or approved it), `REPORTED_NEGOTIATOR`, `ORGANIZATIONAL` (default), `TITLE_ONLY` (context, never an attribution). Tenure dates place a person in the building, not at the decision. Joint decisions list every confirmed person. A person-level result requires confirmed attributions covering a declared minimum share of that person's transactions; otherwise only organization-level and era-level views exist, and the era view is labelled as the club's results under a leadership era, not the executive's.

## Front-office ranking eligibility
A club, era or person may appear in any comparison only when **all** hold; each is checked by a function whose output is stored and shown, and a failed rule produces "not rankable: <rule>", never a quiet exclusion.

| # | Rule |
|---|---|
| E1 | The unit's transaction population is a **human-certified coverage class** (club x TRANSACTIONS x season, `research.classes` with `season`) at COMPLETE_CENSUS for the in-scope types, with a source stating or independently reproducing the population |
| E2 | Every included transaction is `VERIFIED_COMPLETE` with an active, unrevoked verification |
| E3 | Every included evaluation is **closed** (B6); open ones are listed separately |
| E4 | WAR coverage is COMPLETE (023 definition) for all key assets for the provider being compared |
| E5 | A declared minimum number of closed transactions over a declared minimum number of seasons (thresholds proposed for owner decision before any ranking, not set here) |
| E6 | No unresolved source conflict and no unresolved player identity among the included records |
| E7 | For any net-of-cost view: contract terms COMPLETE and sourced for every included transaction; otherwise only a WAR-only view, labelled |
| E8 | For era or person views: tenure and attribution rules above, with sources |
| E9 | Publication permission cleared for every source behind displayed data (hosted guard and `sources.json`) |
| E10 | The spec version is human-approved, and results state its version, provider, as-of date and inputs fingerprint |

Rankings, when permitted, show counts, coverage and the spread of outcomes next to any ordering, never an ordering alone.

## Validation before any composite
1. Back-test the decision-time components against realized outcomes on **pre-2021 transactions** where cleared sources exist (Retrosheet era), checking calibration of the method, not tuning it to outcomes.
2. Report where the two assessments disagree and why, without hiding either.
3. Independent human review of a sample of verified transactions and evaluations.
4. Only then may the owner approve a composite, as a new spec version with its own tests and public explanation.
