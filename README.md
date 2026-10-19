# BAI — Baseball Acquisition Intelligence

A league-wide research platform on MLB amateur talent acquisition across two equal channels, **international acquisition** and the **MLB amateur draft**.

> How effectively does each MLB organization acquire, develop, retain, trade and convert amateur talent into organizational value?

BAI is independent of DISI and Diamond IQ. It shares DISI's research discipline but not its database, data or deployment.

**Status:** Supabase bootstrap (branch `feature/supabase-bootstrap`). The foundation and research ingestion are merged to `main`. This phase links the repository to BAI's own hosted Supabase project, pushes migrations 001–018 there, proves local/hosted parity and the security boundary, and imports only the validated 2015 Dodgers pilot. The app runs against the hosted database on 127.0.0.1 for validation; nothing is publicly deployed and no large-scale backfill has run. See [docs/supabase.md](docs/supabase.md).

## Principles

- Public data only.
- Missing is not zero, unaudited is not failed, and tracked is not the complete population.
- Every researched fact has provenance, and coverage is stated explicitly.
- Acquisition-time expectations use only evidence published before the acquisition.
- Expectation, realized outcome, career value and organization-realized value are kept separate, and so are cost components.
- No unsupported causal or predictive claims.
- Expensive analytics are never rebuilt on a public request.

See [docs/research-methodology.md](docs/research-methodology.md).

## Stack

- Next.js 16 App Router (TypeScript) and PostgreSQL 17.
- For local development and replay, an embedded PostgreSQL 17 runs on the VPS (`embedded-postgres`, bound to localhost, no Docker).
- Hosted: BAI's own Supabase project (`BAI`, ref `dbnmktidheefoxaztivm`). It is never DISI's, and every hosted script refuses any other project.

## Quick start

```bash
npm install
npm run db:server            # PostgreSQL 17 on 127.0.0.1:54329, data in .pgdata/ (keep running)
cp .env.example .env.local
npm run db:migrate           # applies database/migrations/001..018 (includes the sourced calendars)
npm run refresh:read-models  # controlled refresh of the rm_* read models
npm run dev                  # http://127.0.0.1:3000 (localhost only)
```

Fictional fixtures (`npm run db:fixtures`) and research data never share a database, and both tools refuse to mix them. Use a separate database for fixtures.

Browse from your own machine through an SSH tunnel; no port is exposed publicly:

```bash
ssh -N -L 3000:127.0.0.1:3000 <user>@<vps-host>   # then open http://localhost:3000
```

## Research workflow

```bash
npm run research:import   -- --file research/imports/2015-draft-lad.json
npm run research:validate -- --batch pilot-2015-draft-lad          # exit 2 on validation failure
npm run research:apply    -- --batch pilot-2015-draft-lad          # dry run (default)
npm run research:apply    -- --batch pilot-2015-draft-lad --write  # apply
npm run research:conflicts                                          # open conflicts with their evidence
npm run research:queue                                              # research queues
npm run research:coverage                                           # coverage cells (no rates)
npm run refresh:read-models                                         # update the /research dashboard
```

See [docs/research-ingestion.md](docs/research-ingestion.md).

## Hosted (Supabase)

Hosted work is deliberate and goes through `npm run hosted:*` scripts that read `.env.hosted.local` (gitignored, chmod 600). Every hosted write needs `--confirm-hosted <ref>`.

```bash
npm run hosted:supabase -- db push --dry-run     # Supabase CLI, linked to BAI only; password via environment
npm run hosted:rehearse                          # run pending migrations on hosted and roll back
npm run hosted:parity                            # local reference vs hosted: BAI-owned objects and seed data
npm run hosted:security                          # grants, RLS, functions, private ingest, live Data API probe
npm run hosted:verify                            # DB verification suite on hosted, fully rolled back
npm run hosted:verify-pilot                      # pilot facts + reconciliation with research/baselines/
npm run hosted:start                             # app on 127.0.0.1:3000 reading hosted as bai_web -> anon
```

Procedure, secret handling and platform differences: [docs/supabase.md](docs/supabase.md).

## Checks

```bash
npm run lint
npm run typecheck
npm run test:app          # formatting/route tests + every page query against real PG17 as anon
npm run test:db           # replay + schema rule tests (incl. the hosted verification suite in local mode), each file on a disposable PG17
npm run build
git diff --check
npm run scan:credentials
npm run check             # all of the above
```

## Layout

```
app/                    Next.js routes (Overview, International, Draft, Organizations, Players, Compare, Research)
components/             UI primitives
lib/                    db access (anon, read-only), page queries, formatting, navigation
database/migrations/    001_core_identity … 018_btree_gist_extensions_schema (frozen once applied)
supabase/               Supabase CLI config, migrations symlink, Supabase root CA (no secrets)
database/fixtures/      fictional TEST_FIXTURE data for tests and local dev only
scripts/db/             migrate, fixtures, read-model refresh, local PG17 server, parity/security verifiers, hosted wrappers
scripts/app/            route smoke test
scripts/research/       research CLI, ingestion pipeline, calendar seed generator
research/calendars/     sourced calendar research (input to migration 015)
research/imports/       research import batches (the 2015 Dodgers pilot)
research/baselines/     id-independent snapshot of the validated local pilot (hosted reconciliation)
scripts/ci/             credential scan
tests/db/               schema/rule tests on PostgreSQL 17
tests/app/              app tests
docs/                   architecture, data model (ERD), methodology, DISI interoperability, roadmap
```

## Documentation

- [Architecture](docs/architecture.md)
- [Data model and ERD](docs/data-model.md)
- [Research methodology](docs/research-methodology.md)
- [Hosted Supabase](docs/supabase.md)
- [DISI interoperability](docs/disi-interoperability.md)
- [Research ingestion](docs/research-ingestion.md), [Source policy](docs/source-policy.md), [Identity resolution](docs/identity-resolution.md)
- [Roadmap](docs/roadmap.md)
