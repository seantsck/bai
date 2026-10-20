# Roadmap

## Done: foundation (`feature/foundation`)

- **Schema:** migrations 001–011 replay cleanly on PostgreSQL 17, with 30 franchises and their name history seeded.
- **Data model:** shared identity, provenance, coverage, expectations, international, draft, outcomes, development, transactions and value.
- **Public surface:** RLS on every public table and SELECT-only public grants, plus bounded read models with a controlled refresh.
- **App:** Next.js scaffold with every planned route rendering.
- **Tests:** DB and app suites.

## Done: research ingestion (`feature/research-ingestion`)

- **Calendars (015):**
  - all twelve Rule 4 drafts, 2015–2026, with dates, rounds and rules eras;
  - all twelve international periods, 2014-15 through 2026, with the pandemic shift.

  Every row cites sources with authority levels and field observations, and the recorded disagreements are resolved with rationales.
- **Provenance (012):**
  - source authority and richer source metadata;
  - per-field conflict rules;
  - `fact_resolutions` with no last-write-wins.
- **Ingestion (013):**
  - staged batches with validation, identity resolution, dry run, idempotent apply and reconciliation;
  - the research CLI (`research:*`).
- **Queues and dashboard (014):** ten research queues with fixed priorities, and the coverage dashboard read models behind `/research`.
- **Pilot:**
  - Dodgers 2015 draft class: 42 picks, plus 4 re-drafts;
  - Dodgers 2015 international sample: 9 signings.

  Both were applied to the local database only and are documented in [research-ingestion.md](research-ingestion.md).

## Done: Supabase bootstrap (`feature/supabase-bootstrap`, Phase 3A)

- **Hosted project:** BAI's own Supabase project (ref `dbnmktidheefoxaztivm`, PostgreSQL 17.11), linked through a wrapper that refuses any other ref.
- **Migrations 001–018 pushed** with `supabase db push` from the committed files; Supabase and BAI histories agree and are verified statement by statement. 016–018 are additive: the `bai_web` web role, removal of Supabase's old default privileges, btree_gist out of public.
- **Parity:** 1,567 BAI-owned catalog objects and all seeded data identical to a local reference replay; the two platform differences are documented in [supabase.md](supabase.md).
- **Security:** RLS, grants, functions, views, private `ingest` and the live Data API verified; advisors leave INFO findings only.
- **Pilot only:** the validated 2015 Dodgers draft and 2015-16 international batches, reconciled with the local baseline. No backfill.

## Done: league-wide backfill framework (`feature/research-backfill-framework`, Phase 3B)

- **Classes for all 30 organizations** (organization x channel x draft/period), a nine-stage machine that cannot skip, durable jobs with history, a deterministic priority queue, resumable research batches, source leads, agent review, and deterministic certification without a force option (migration 019; [backfill-methodology.md](backfill-methodology.md)).
- **Franchise history:** Florida/Miami Marlins, Tampa Bay Devil Rays/Rays and Montreal Expos/Washington Nationals added to the name history; one resolver for source wording.
- **Outcome audit details and economics views,** with rates gated on census-level, certified, fully audited cohorts.
- **First non-pilot class, LAD 2016 draft (local):** 42 of 42 picks, census coverage, conflicts resolved, 7 bonuses explicitly unknown; READY_FOR_REVIEW, awaiting human certification.

## In progress: Wave 1 (`feature/lad-2016-outcomes-and-cohorts`)

- **Framework release:** PR #4 merged; migration 019 deployed to hosted, with parity, security and verification passing.
- **LAD 2016 draft:** outcome audits for 42 of 42 picks (migration 020 outcomes channel). Evidence package ready; awaiting human certification.
- **LAD 2017 draft:** 40 of 40 picks, census coverage, 10 of 10 slots, 13 of 31 bonuses. 18 bonus jobs and 40 outcome audits open; batch paused.
- **LAD international 2016-17 and 2017-18:** 45 and 50 candidate amateur signings, discovered on the MLB transaction wire by a documented rule. PARTIAL_RECONSTRUCTION; universe, bonuses and the classification still to verify.

## Next

### Phase 2b: hardening before scale (small)
- **Pool context import:** add pools and penalty context per organization and period (`organization_signing_period_context`, `organization_draft_pools`), with conflicting figures kept as observations.
- **Verify the excerpt-only figures:** re-read the excerpt-flagged bonuses from the full pages (Heredia, Brito, Arias), and verify Díaz's Baseball-Reference minors id.
- **More record types:** batch imports for outcome audits, debuts and WAR observations, so the pilot players can leave `OUTCOME_NOT_AUDITED`.
- **Census review:** a promotion workflow (PARTIAL_RECONSTRUCTION → COMPLETE_CENSUS) with a recorded reviewer and gap list.
- **Rate-limited fetching:** a fetch policy and per-source cache before any multi-team backfill.

### Phase 3: backfill 2015–2026 (both channels, in parallel; Wave 1 started with LAD 2016)
- Draft:
  - every selection, then signing status, bonus and school;
  - coverage per draft and organization.
- International:
  - publicly reported signings per period;
  - coverage per period and organization. Expect PARTIAL_RECONSTRUCTION or RANKED_SAMPLE for many cells, and say so.
- Acquisition-time rankings, limited to published lists dated before acquisition.

### Phase 4: outcomes and development
- Outcome audits with observation-through seasons, plus debuts and WAR observations.
- Assignments, promotion/demotion chronology and affiliate seasons.

### Phase 5: transactions and organizational value
- Trades involving tracked players, packages and asset lineage.
- Value attributions by class, with no double counting, plus control intervals per organization.

### Phase 6: analytics and serving
- More read models: per period, per draft and organization comparisons, gated by coverage.
- A drift check between `analytics.*` and `rm_*`.
- A route ↔ relation public contract (generalizing DISI 045).
- Search, pagination and filters on the fact lists.

### Phase 7: production
- The hosted Supabase project exists (Phase 3A); still to come: a public app deployment and its hosting decision.
- Release validators: bundle replay, convergence and rollback on PG17 (generalizing DISI's `database/release/pg17`).
- A deployment checklist.

### Later / explicitly gated
- Expanding earlier than 2015. The schema already supports it: no year constraints narrow the window, and organization history accepts earlier seasons.
- DISI data import, through BAI ingestion with fresh provenance (see `disi-interoperability.md`).
- Any predictive modelling. Not planned, and it would require explicit sample-size and validation gates.

## Non-goals for now
- Predictive probabilities, causal claims, deployment, and connecting to DISI.
