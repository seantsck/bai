# Roadmap

## Done: foundation (`feature/foundation`)

- **Schema:** migrations 001–011 replay cleanly on PostgreSQL 17, with 30 franchises and their name history seeded.
- **Data model:** shared identity, provenance, coverage, expectations, international, draft, outcomes, development, transactions and value.
- **Public surface:** RLS on every public table and SELECT-only public grants, plus bounded read models with a controlled refresh.
- **App:** Next.js scaffold with every planned route rendering.
- **Tests:** DB and app suites.

## Next

### Phase 1: reference calendars and structures (sourced)
- Signing periods 2015-16 → 2026, with exact start and end dates and sources. This includes the shifted post-2020 calendar.
- Draft events 2015–2026 with rounds, phases and pick structure per year, plus slot values and organization pools where public.
- Markets reference list.

### Phase 2: ingestion tooling
- MLBAM-first identity resolution with an identity-review workflow (generalizing DISI 020). Name-only matches go to `research_tasks`.
- Source-observation ingestion with precedence rules (generalizing DISI `source_tiers`) and an `amount_basis` for money.
- Population-membership tables and candidate classification (generalizing DISI 018).
- An idempotent upsert path for each fact table, keyed on natural keys.

### Phase 3: backfill 2015–2026 (both channels, in parallel)
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
