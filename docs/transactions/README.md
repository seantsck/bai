# Phase 15: transaction forensics foundation (planning)

Status: **planning and specification only**, written 2026-10-25. No migration, hosted write, import, deploy, manifest change, or change to DISI or Diamond IQ was made. The pending 2025 draft release and the historical round corrections are untouched and independent of this plan; no new migration here is needed by them.

| Document | Content |
|---|---|
| [01 Architecture gap analysis](01-architecture-gap-analysis.md) | what 001-027 already supports, per capability, and the concrete gaps |
| [02 Source-rights and feasibility](02-source-rights-feasibility.md) | Retrosheet, Lahman, Chadwick, MLB, Sports Reference and others, with terms read and not read |
| [03 Data model and ingestion](03-data-model-and-ingestion.md) | additive tables, identity design, ingestion flow, tests |
| [04 Evaluation specification](04-evaluation-specification.md) | decision-time and realized assessments, assumptions, ranking eligibility |
| [05 Pilot and public surface](05-pilot-and-public-surface.md) | 2023/2024 deadline pilot, transaction detail view, report |

## Principles carried through every document
1. Reuse 010/022/023, 005, 019 and the release machinery; add only what a named gap requires.
2. Unknown is NULL, never zero; absence is never an outcome.
3. A record is `UNVERIFIED`, `PARTIAL` or `VERIFIED_COMPLETE`, and only a human can make it complete.
4. Decision-time evaluation cannot see the future (database-enforced); a job title is not proof of a decision.
5. No composite score or ranking until a validated, owner-approved spec exists and every eligibility rule holds.
6. Rights first: no source is fetched, processed or published beyond its recorded per-use grant.

## Headline findings
- The value-attribution core is reusable; the weak point is the transaction record (no identity, no completeness state, one source).
- **No free, cleared source covers 2023-2024 transactions** (Retrosheet's file stops at 2020; Lahman has no transactions) and **none covers contracts**. Rights decisions, not schema, gate the work.
- Hosted holds 65 pilot trades, 354 WAR rows and no contracts or executives: nothing can be ranked today.

## Roadmap (each phase ends with review and its own authorization; none starts a hosted write on its own)
| Phase | Work | Needs | Exit |
|---|---|---|---|
| 15E | owner rights decisions: MLBAM written authorization request, vendor quote, Retrosheet attribution category, Lahman license check | owner | recorded decisions; revised feasibility |
| 16 | migration 028 (transaction completeness, external ids, asset sources, calendar events, PTBNL) and TRANSACTIONS importer, **disposable database only** | 15E not required | tests green, rehearsal clean, 010/022/023 suites unchanged |
| 17 | pilot discovery, sourcing, build, preview, rehearsal for the 2023/2024 windows | sources per `02`; per-release authorization | verified-complete and deliberately incomplete records both demonstrated |
| 18 | public `/transactions` pages, coverage page and the forensic report generator | 17 applied | smoke checks, no scores anywhere |
| 19 | historical trades (<= 2020) from Retrosheet; back-test harness for decision-time inputs | attribution category approved | calibration report, no ranking |
| 20 | non-trade roster decisions (waivers, releases, non-tenders, options, DFA) via participants | 16 | importer and dispositions tests |
| 21 | contracts and terms | a licensed or cleared contract source | complete-terms flag, cost components |
| 22 | people and leadership tenures; decision attribution evidence | cleared tenure sources | attribution rules tested; titles never attribute |
| 23 | evaluation runs and components for both assessments | 16-22 as available | future-information trigger tested; components only |
| 24 | transaction coverage classes, eligibility functions, internal-only comparison | human-certified classes | eligibility output stored; owner decides on any public ranking |

## Decisions requested from the owner
1. Approve the Phase 15E rights outreach (and which vendors to quote).
2. Approve the pilot rule (deadline windows, LAD plus five seeded clubs, all trades in the window).
3. Choose whether Phase 16 proceeds before rights answers arrive (schema work does not depend on them).
4. Set, later and before any ranking, the minimum-sample thresholds in E5.

## Risks
- Rights may never allow modern transactions or contracts at BAI's scale; the plan then limits itself to history and individually cited facts.
- A WAR-only view can mislead on contract-heavy trades: hence the cost component is gated on complete terms and labelled.
- Executive attribution is the most contestable claim; the design makes the safe default organizational.
- Era views risk being read as individual judgments; they carry fixed wording.
