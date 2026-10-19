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

## Next

### Phase 2b: hardening before scale (small)
- **Pool context import:** add pools and penalty context per organization and period (`organization_signing_period_context`, `organization_draft_pools`), with conflicting figures kept as observations.
- **Verify the excerpt-only figures:** re-read the excerpt-flagged bonuses from the full pages (Heredia, Brito, Arias), and verify Díaz's Baseball-Reference minors id.
- **More record types:** batch imports for outcome audits, debuts and WAR observations, so the pilot players can leave `OUTCOME_NOT_AUDITED`.
- **Census review:** a promotion workflow (PARTIAL_RECONSTRUCTION → COMPLETE_CENSUS) with a recorded reviewer and gap list.
- **Rate-limited fetching:** a fetch policy and per-source cache before any multi-team backfill.

### Phase 3: backfill 2015–2026 (both channels, in parallel; not started)
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
- A separate Supabase project, which will never be DISI's.
- Release validators: bundle replay, convergence and rollback on PG17 (generalizing DISI's `database/release/pg17`).
- A deployment checklist.

### Later / explicitly gated
- Expanding earlier than 2015. The schema already supports it: no year constraints narrow the window, and organization history accepts earlier seasons.
- DISI data import, through BAI ingestion with fresh provenance (see `disi-interoperability.md`).
- Any predictive modelling. Not planned, and it would require explicit sample-size and validation gates.

## Non-goals for now
- Predictive probabilities, causal claims, deployment, and connecting to DISI.
