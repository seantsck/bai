# League-Wide Backfill Methodology

BAI reconstructs draft and international acquisition history for **all 30 MLB organizations**. The backfill framework (migration 019, `scripts/research/lib/backfill.mjs`, the `research:*` CLI) turns that goal into deterministic, resumable, auditable work. The Los Angeles Dodgers go first because the 2015 pilot already exists and DISI's Dodgers research is a known cross-check. Nothing in the framework knows about the Dodgers: the only place `LAD` appears is one row of program-order data.

## Research classes

The unit of research is a **class**: one organization, one acquisition channel, one scope.

| Channel | Scope | Class key | Example |
|---|---|---|---|
| `DRAFT` | a Rule 4 draft | `ORG/DRAFT/<draft key>` | `LAD/DRAFT/2016-JUNE_AMATEUR` |
| `INTERNATIONAL` | a signing period | `ORG/INTERNATIONAL/<period key>` | `LAD/INTERNATIONAL/2016-17` |

- Channels are rows in `research.channels`. `RULE_5` and `UNDRAFTED_FREE_AGENT` are reserved rows (`implemented = false`); a new channel is a new row plus planner rules, not a redesign.
- A class identity is immutable. One class exists per organization, channel and scope.
- Organizations come from `public.organizations` (30 franchises, MLB team ids). Historical names (Florida Marlins, Tampa Bay Devil Rays, Montreal Expos, Cleveland Indians, Oakland Athletics, Los Angeles Angels of Anaheim) are rows in `organization_names` with the seasons they were used. `resolve_organization(name, season)` maps a source's wording to one franchise and refuses ambiguous or out-of-season wording. A rename never creates a second franchise. Imports may carry the source wording as `organization_as_named`; it must resolve, for that season, to the record's franchise, and the wording is kept on the observation.

## Stages

Every class moves through an explicit stage machine:

1. `DISCOVERY`: how big is the class, and what is the evidence?
2. `ROSTER_RECONSTRUCTION`: every member tracked.
3. `IDENTITY_RECONCILIATION`: every member linked to a stable identity.
4. `SIGNING_STATUS`: signed or not; transaction dates.
5. `FINANCIALS`: bonuses, fees, slot values.
6. `SOURCE_RECONCILIATION`: conflicts resolved by rule or rationale; low-quality evidence replaced.
7. `OUTCOME_AUDIT`: outcomes as of a date.
8. `COVERAGE_REVIEW`: coverage justified; ready for certification.
9. `CERTIFIED`.

Rules (enforced by a trigger on `research.classes`, not by convention):
- **One step at a time.** A skip is refused.
- **Unresolved items may stay behind.** Moving on records how many jobs per stage were still open (`research.stage_events.open_jobs`).
- **Moving back needs a rationale.**
- **Certification:** `CERTIFIED` is reachable only through `research:certify`, which writes the certification row first. A class leaves `CERTIFIED` only after its certification is revoked.

## Workflow status vs coverage state

These are different questions and are never merged:

| | Workflow status (`research.v_class_status`) | Coverage state (`public.coverage_assessments`) |
|---|---|---|
| Asks | Where is the research work? | How much of the population does BAI hold, and how do we know? |
| Values | `NOT_STARTED`, `IN_PROGRESS`, `BLOCKED`, `PARTIAL`, `READY_FOR_REVIEW`, `CERTIFIED` | `COMPLETE_CENSUS`, `SUBSTANTIALLY_COMPLETE`, `PARTIAL_RECONSTRUCTION`, `RANKED_SAMPLE`, `INDIVIDUALLY_VERIFIED`, `UNKNOWN` |
| Set by | derived from jobs, batches and certification (never typed in) | ingestion coverage claims with sources (never by the workflow) |

Workflow status is derived in this order of precedence:
1. `CERTIFIED`: an active certification exists.
2. `READY_FOR_REVIEW`: the class is at `COVERAGE_REVIEW` and no blocking work is open. Open outcome audits, excerpt-only replacements and the certification job itself do not block.
3. `BLOCKED`: something is blocked and nothing is actionable.
4. `IN_PROGRESS`: a research batch is active.
5. `PARTIAL`: work has happened, open work remains, and no batch is active.
6. `NOT_STARTED`.

A class can be `READY_FOR_REVIEW`, or even `CERTIFIED`, while its coverage stays `PARTIAL_RECONSTRUCTION`. That is the normal outcome for international classes: eight individually verified signings with no authoritative complete list remain a partial reconstruction.

## Jobs

`research:plan` turns the data state of a class into jobs. Each job has:
- a deterministic key (`<class>/<category>/<natural label>`, e.g. `LAD/DRAFT/2016-JUNE_AMATEUR/ACQUISITION_COST_MISSING/pick-731`), so the same work has the same key in every database;
- a category, stage, state and source requirements;
- an optional assignee, notes, blocking reason, dependency and completion rationale;
- an origin (`PLANNER`, `RESEARCHER`, `AGENT`).

Every state change is logged in `research.job_events` with its actor.

| Category | Stage | Rank | Created when |
|---|---|---|---|
| `CLASS_NOT_RECONSTRUCTED` | ROSTER_RECONSTRUCTION | 1 | nothing tracked, or fewer tracked than expected |
| `EXPECTED_UNIVERSE_UNKNOWN` | DISCOVERY | 2 | no sourced expected count |
| `IDENTITY_UNRESOLVED` | IDENTITY_RECONCILIATION | 3 | a member has no external id, or a staged record awaits an identity decision |
| `SIGNING_STATUS_UNKNOWN` | SIGNING_STATUS | 4 | a pick has no signing row |
| `TRANSACTION_DATE_MISSING` | SIGNING_STATUS | 5 | an international signing lacks a day-precision date |
| `ACQUISITION_COST_MISSING` | FINANCIALS | 6 | a signed pick has no bonus; an international signing's cost is unknown |
| `SLOT_VALUE_MISSING` | FINANCIALS | 6 | a pick in rounds 1-10 has no slot value |
| `SCHOOL_MISSING` | ROSTER_RECONSTRUCTION | 6 | a pick has no school |
| `SOURCE_CONFLICT` | SOURCE_RECONCILIATION | 7 | an open fact conflict touches the class |
| `OUTCOME_NOT_AUDITED` | OUTCOME_AUDIT | 8 | a member's outcome is `NOT_AUDITED` |
| `LOW_QUALITY_SOURCE` | SOURCE_RECONCILIATION | 9 | an open `EVIDENCE_EXCERPT_ONLY` flag touches the class |
| `COVERAGE_CERTIFICATION` | COVERAGE_REVIEW | 10 | always (one per class; closed only by certification) |

Job states and how the planner treats them:
- **States:** `OPEN`, `IN_PROGRESS`, `BLOCKED` (needs a reason), `DONE`, `UNRESOLVED`, `CANCELLED`, `SUPERSEDED`. Terminal states need a rationale and never move again by hand.
- **`UNRESOLVED`** is how research says "unknown after looking": it is the only way an unknown bonus, slot or school satisfies certification, and the value stays NULL, never zero.
- **Planning is idempotent.** It creates missing jobs and closes `PLANNER` jobs whose condition the data no longer shows (`DONE`, "resolved in data"). It reopens a `DONE` planner job whose condition returns. It never touches `UNRESOLVED`, `CANCELLED` or `SUPERSEDED` jobs, or jobs a researcher or agent created.
- **Dependencies:** a job cannot start or finish before the job it depends on is finished (trigger), and it does not appear in the queue until then. Outcome audits automatically wait for an open identity job of the same player.

## Priority engine

`research:next` reads `research.v_next_jobs`. A job is actionable when:
- it is `OPEN` or `IN_PROGRESS`;
- its dependency is finished;
- its class is not certified;
- for the certification job only, the class is at `COVERAGE_REVIEW`.

Actionable jobs are ordered by exactly these keys:

1. **Program wave** (`research.program_waves`; organizations without a row are wave 3). Data, not schema: the benchmark set changes with an insert.
2. **Category priority rank** (table above; fixed and documented).
3. **Class chronology** (draft or period start date).
4. **Franchise key**, then **channel**, then **job key** (total order, so ties never depend on insertion order or collation).

The same database state always yields the same queue. No score is computed by a model.

## Resumable research batches

A research batch (`research.batches`) is a working session on one class. Lifecycle commands:
- **`research:start`** takes the next N actionable jobs of the class into the batch and marks them `IN_PROGRESS` for the operator. One active batch per class.
- **`research:pause`** keeps the batch's jobs assigned.
- **`research:resume`** reopens a paused batch and prints exactly what is done and what remains. Progress lives in the database, never in a chat transcript.
- **`research:complete`** requires every job finished. `--release` instead returns unfinished jobs to the queue.
- **`research:fail --reason`** returns unfinished jobs to the queue.
- **`research:supersede --new`** hands unfinished jobs to a new batch; the old one keeps its history and points at its successor.

Every transition is logged in `research.batch_events`.

## Certification

`research:certify` runs a deterministic check and certifies only when it finds no blocker. There is no force option, and an agent (`agent:*`) cannot certify.

**Draft class**
- class at `COVERAGE_REVIEW`;
- expected pick count established with a source, and every expected pick tracked;
- round and pick numbers known for every pick;
- every member has an external id; no staged record awaits an identity decision;
- signing status known for every pick (signed and did-not-sign are kept apart);
- every signed pick has a bonus, or an `UNRESOLVED` cost job explaining why it is unknown;
- every pick in rounds 1-10 has a slot value, or an `UNRESOLVED` slot job;
- every pick has a school, or an `UNRESOLVED` school job;
- every record cites a source; no open source conflict; no open or blocked job before outcome audit;
- coverage justified: when every expected pick is tracked, coverage must be a sourced `COMPLETE_CENSUS` or `SUBSTANTIALLY_COMPLETE` claim (made through an import batch, never by hand).

**International class.** The system never infers completeness from what it happened to find.
- the class universe is either established with a source, or recorded as unknown after research (`EXPECTED_UNIVERSE_UNKNOWN` closed `UNRESOLVED` with a rationale);
- with an unknown universe, coverage must be `PARTIAL_RECONSTRUCTION`, and no census-level state is accepted;
- with a known universe, every member must be tracked;
- every signing has a day-precision date, or an `UNRESOLVED` date job;
- every signing has a known cost, or an `UNRESOLVED` cost job;
- external ids, sources and conflicts are checked as for drafts. Pathway (amateur vs professional, exempt status) is a required column, so it is always recorded.

**What certification does**
- It records the certification, the coverage state at that moment and the metrics.
- It closes the certification job and moves the class to `CERTIFIED`.
- It never changes coverage.

Outcomes do not block certification: `NOT_AUDITED` is not failure, and outcomes are audited on their own clock.

## Outcomes

The audit state lives in `outcome_audits` (008):
- `NOT_AUDITED` and `AUDITED_NO_MLB` are distinct values;
- debuts are in `mlb_debuts`;
- WAR is in `war_observations`, per provider (`BREF`, `FANGRAPHS`, `OTHER`), career, season or organization tenure;
- trades and trade-return value are in `transactions` and `organization_value_attributions` (010).

Migration 019 adds `outcome_audit_details`, one row per audit and true as of a stated date: reached affiliated baseball, first affiliated season, MLB games, plate appearances and innings, current status, disposition (retained, traded with the transaction, released, Rule 5, waivers, free agency), and the source. `analytics.player_outcome_profile` adds debut age (from a day-precision birth date) and keeps WAR per provider side by side, never one "true" WAR.

## Acquisition economics

`analytics.acquisition_economics` holds one row per acquisition, with these dimensions and measures:
- organization, channel, class, round, overall pick;
- bonus, slot, bonus minus slot, bonus band;
- school type, birth country, position, rules era;
- audit state, `reached_mlb` (only when audited), WAR per provider.

`analytics.class_economics` sums known values only, per class. Its rates (`mlb_reach_rate`, `cost_per_mlb_player`) stay null unless the class has census-level coverage, is certified, and has every outcome audited (and, for cost rates, every cost known). Both views are private. Dimensions the evidence does not yet support (signing scout, front-office era) are deliberately absent.

## Sources, leads and automation

- **Authority.** The authority hierarchy and conflict rules are unchanged (see [source-policy.md](source-policy.md)). Authority ranks claims only under a declared rule; conflicting claims all stay.
- **Leads** (`research:lead`) record what a researcher or agent found while working a job:
  - URL or reference, source type, authority, and access (`ACCESSIBLE`, `EXCERPT_ONLY`, `ARCHIVE_ONLY`, `BLOCKED`, `PAYWALLED`, `NOT_FOUND`);
  - retrieval date, archive URL, evidence note, and the fields the source supports.

  A URL alone is refused. Leads are not provenance: facts become canonical only through an import batch that cites a registered source.
- **Agents** may discover (leads, jobs with origin `AGENT`), stage (`research:import --agent <name>`, recorded as `agent:<name>`) and propose (validate, dry run). An agent-staged batch cannot be applied with `--write` until a human records `research:review`, and an agent can never certify.

## Multi-team safety

- **Single-organization commands need `--org`.** That covers `class`, `plan`, `start`, `stage` and `certify`. `research:next` needs `--org` or an explicit `--league`, and `research:progress` is league-wide unless `--org` is given.
- **Imports name their club.** `research:import` needs `--org <club>`, which checks every record and coverage claim against it, or an explicit `--league`. A record for another club passes only with `cross_organization: "<reason>"` (for example, a re-draft).
- **Hosted writes:** every writing command needs `--confirm-hosted <ref>` on the hosted database. Development happens locally.

## Public and private

- **Private:** the `research` schema (classes, jobs, batches, leads, reviews, certifications) is not exposed through the Data API and is not granted to any platform role. It also has RLS with no policies, as defense in depth. The analytics views are private too.
- **Public:** `rm_research_certification`, one certification flag (and date, and coverage at certification) per class, refreshed with the read models. `/research` shows it as ✓ on the coverage grid and as a column in the detail table. Notes, blockers, jobs and leads never reach the public site.

## CLI

| Command | Purpose |
|---|---|
| `research:orgs` | the 30 organizations, their former names and program waves |
| `research:class -- --org X --channel draft --year Y [--create]` (international: `--period P`) | create (and plan) or show a class: workflow, coverage, counts, jobs by stage, blockers |
| `research:plan -- --org X --channel … ` | bring jobs in line with the data (idempotent) |
| `research:next -- --org X [--channel --year --period --stage --limit] \| --league` | the deterministic queue |
| `research:progress [-- --org X]` | organization or league-wide (all 30) progress; no hit rates |
| `research:start -- --org X --channel … --batch key [--take N --goal …]` | open a research batch |
| `research:pause` / `resume` / `complete [--release]` / `fail --reason` / `supersede --new key` (all `-- --batch key`) | batch lifecycle |
| `research:job -- --job key --state … --rationale …` / `--add --category … --label … --title …` | move or add a job |
| `research:block -- --job key --reason …` / `research:unblock -- --job key` | record or lift a blocker |
| `research:lead -- --job key --url … --source-type … --authority … --access … --retrieved … --fields a,b --note …` | record a source lead |
| `research:stage -- --org X --channel … [--to STAGE --rationale …]` | one stage forward (or back with a rationale) |
| `research:certify -- --org X --channel …` | deterministic certification; exits 3 with blockers |
| `research:review -- --batch key --reviewer name --note …` | human review of an agent-staged import |

## Rollout

| Wave | Scope | Notes |
|---|---|---|
| 1 | LAD 2015–2026, draft and international | 2015 is the pilot. 2016 draft is the first non-pilot class (below). 2017 starts only after 2016 and the framework pass review. |
| 2 | Selected benchmark organizations | Chosen for research value (for example, clubs with distinctive international or draft strategies and good public records), not alphabetically. Set with `research.program_waves` rows: no migration. |
| 3 | All 30 organizations | Same classes, planner, queue and certification. No schema change. |
| 4 | Outcome completion and comparative analytics | Outcome audits league-wide; rates appear only for census-level, certified, fully audited cohorts. |

## First validation class: LAD 2016 draft

The class was researched on 2026-10-20 and can be replayed with `research/runbooks/lad-2016-draft.mjs`.

**Universe:** MLB's official draft data lists 42 selections, and the archived Baseball-Reference page lists the same 42 by overall pick and name. Coverage is a sourced `COMPLETE_CENSUS` claim (42 of 42).

**Imports**
- **`2016-draft-lad`:** picks, MLBAM ids and birth dates from MLB; signing status, bonus, position and school from Baseball-Reference. 33 signed and 9 did not sign; 25 bonuses.
- **`2016-draft-lad-slots`:** the 12 slot values for rounds 1–10, from MLB.com's April 2016 pick values. The Dodgers entries sit exactly at the official overall picks and total the stated $9,336,500 pool.
- **`2016-draft-lad-tracker`:** MLB.com's signing tracker for rounds 1–10. It corroborated 10 bonuses, filled Luke Raley's ($147,500), and disagreed on Devin Smeltzer ($500,000 vs $497,500).

**Conflicts**
- **Jordan Sheffield #36** (MLB CB-A pick 2; B-Ref round 1 pick 36): resolved by researcher rationale.
- **Smeltzer bonus:** resolved by the declared `PREFER_HIGHER_AUTHORITY` rule, choosing MLB. Both claims stay on record.

**Explicit unknowns:** 7 late-round signed picks have no published bonus anywhere searched. Their cost jobs are `UNRESOLVED` with that rationale, and the values are NULL.

**State:** stage `COVERAGE_REVIEW`, workflow `READY_FOR_REVIEW`, no certification blockers. The class is deliberately not certified: certification is a human reviewer's step.

**Remaining:** 42 outcome audits (rank 8, non-blocking) and certification. LAD 2017 has not started.
