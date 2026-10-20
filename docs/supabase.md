# Hosted Supabase

BAI has one hosted database: the Supabase project **BAI** (ref `dbnmktidheefoxaztivm`, region ca-central-1, PostgreSQL 17.11). It was created for BAI alone. DISI's project is a different project and is never linked, referenced or connected to from this repository; every hosted script refuses any project ref other than BAI's.

Local PostgreSQL 17 (`npm run db:server`) stays the first-class environment for research and tests. The hosted database receives only migrations and deliberate, verified research batches.

## Environments

| | Local | Hosted |
|---|---|---|
| Database | embedded PostgreSQL 17.9 on 127.0.0.1:54329 | Supabase project BAI, PostgreSQL 17.11 |
| Env file | `.env.local` | `.env.hosted.local` (chmod 600) |
| Migrations applied by | BAI runner (`npm run db:migrate`) | `supabase db push` (via `npm run hosted:supabase`) |
| Migration history | `bai_meta.schema_migrations` | `supabase_migrations.schema_migrations` **and** `bai_meta.schema_migrations` (verified copy) |
| Research CLI | `npm run research:<cmd>` | `npm run hosted:research -- <cmd> ... --confirm-hosted <ref>` |
| App | `npm run dev` / `npm start` | `npm run hosted:start` (127.0.0.1 only) |
| Fixtures | allowed in a separate database | refused (`db:fixtures` is local-only) |

Both env files are gitignored (`.env*.local`). Neither is ever committed.

## Secrets and variables

| Variable | Where | Class | Purpose |
|---|---|---|---|
| `BAI_DATABASE_URL` | `.env.local` | server-only | local owner connection |
| `BAI_SUPABASE_PROJECT_REF` | `.env.hosted.local` | server-only (not secret) | the only project hosted scripts accept |
| `BAI_SUPABASE_DB_PASSWORD` | `.env.hosted.local` | **secret**, server-only | owner (`postgres`) password; the URL is built in code, so it is never hand-encoded or passed on a command line |
| `SUPABASE_ACCESS_TOKEN` | `.env.hosted.local` | **secret**, server-only | Supabase CLI / Management API (link, history, advisors). Account-wide: revoke it when not needed |
| `BAI_ALLOW_REMOTE_DB=1` | `.env.hosted.local` | flag | deliberate opt-in to a non-local database |
| `BAI_PUBLIC_DATABASE_URL` | `.env.hosted.local` | **secret**, server-only | web read pool as `bai_web`; written by `npm run hosted:web-role` |
| `BAI_SUPABASE_URL`, `BAI_SUPABASE_PUBLISHABLE_KEY` | `.env.hosted.local` | client-safe | only for the live Data API probe in `hosted:security` |

- BAI uses **no** secret (`sb_secret_…`) or legacy `service_role` key, and no `NEXT_PUBLIC_*` variable at all. The app reads data on the server with `pg`; the browser receives rendered HTML only. `hosted:start` refuses to start if a `NEXT_PUBLIC_*` variable looks like a credential.
- TLS: hosted connections use `sslmode=verify-full` against the Supabase root CA committed at `supabase/prod-ca-2021.crt` (SHA-256 `80:70:25:AD:…:CA:FA`, checked against Supabase's published download and the chain the server presents).
- The database password reaches the Supabase CLI only through the `SUPABASE_DB_PASSWORD` environment variable (`scripts/db/supabase-hosted.mjs`), never as a flag.
- `bai_web`'s password is generated locally and sent to the server only as a SCRAM-SHA-256 verifier.

## Linking (once per checkout)

```
# 1. Fill .env.hosted.local yourself (editor, not a chat or a shell history):
#    BAI_SUPABASE_PROJECT_REF, BAI_SUPABASE_DB_PASSWORD, SUPABASE_ACCESS_TOKEN, BAI_ALLOW_REMOTE_DB=1
chmod 600 .env.hosted.local
# 2. Link. The wrapper refuses any ref other than BAI_SUPABASE_PROJECT_REF.
npm run hosted:supabase -- link --project-ref <ref>
```

Linking writes only non-secret metadata to `supabase/.temp/` (gitignored). Every later `hosted:supabase` call checks that `supabase/.temp/project-ref` equals the BAI ref before running.

## Migration workflow

The canonical migrations stay in `database/migrations/NNN_name.sql`. `supabase/migrations` is a symlink to that directory, so the Supabase CLI pushes exactly the committed files; the three-digit numbers are the Supabase versions (`001` … `018`). Migrations are frozen once applied anywhere.

1. Write `database/migrations/NNN_name.sql`; run `npm run check` locally (fresh replays on PostgreSQL 17).
2. `npm run hosted:rehearse`: runs every pending file on the hosted database inside one transaction, reports what each one creates, and **rolls back**.
3. `npm run hosted:supabase -- db push --dry-run`: lists what the CLI would apply. Only BAI files may appear.
4. `npm run hosted:supabase -- db push`: applies.
5. `npm run hosted:migrate -- --confirm-hosted <ref>`: verifies each pushed migration statement-for-statement against its committed file and records its checksum in `bai_meta`. On a Supabase database the BAI runner never applies SQL itself.
6. `npm run hosted:parity`, `npm run hosted:security`, `npm run hosted:verify`, `npm run hosted:supabase -- db advisors --type all`.

Never create or alter tables through the Dashboard. A hosted database must always be reproducible from the committed migrations.

### Hosted state and pending migrations

- **019 (research backfill) is deployed** (2026-10-20, after PR #4 merged). Hosted parity found 0 differences over 2,021 objects; security, the verification suite (11/11) and pilot reconciliation all pass. The live Data API refuses the `research` schema (406).
- **020 (outcome import channel) is deployed** (2026-10-20, after PR #5 merged at `1672f39`): rehearsed and rolled back, then dry run, push and `hosted:migrate` record. Parity found 0 BAI differences over 2,022 objects (history 20/20); security passed (24 functions, 62 behavioural attempts, 60 denied or invisible, plus the 2 public-read positive controls); pilot reconciliation passed.
- **Research data on hosted (2026-10-20):** the 2015 pilot, plus PR #5's runbooks replayed with `--confirm-hosted`:
  - `lad-2016-draft.mjs`: LAD 2016 with 42 outcome audits, `READY_FOR_REVIEW`, not certified;
  - `lad-2017-cohorts.mjs`: LAD 2017 picks, slots and tracker, and both international candidate classes, batches paused.
  The aggregates match the local replay exactly, and 260 import records checked field by field show no unexplained difference. Later research (Phase 6 runbooks: `lad-2017-completion.mjs`, `lad-2016-ba-corroboration.mjs`, `lad-international-2016-18.mjs`) is local until its PR merges. No class is certified and no rate is published on hosted.
- **`hosted:verify` and census claims:** with research classes on hosted, the original assertion "no coverage cell claims a census" no longer holds; LAD 2016 and 2017 legitimately claim `COMPLETE_CENSUS`. The Phase 6 branch replaces it with the intended invariant: a census claim names its expected size and source, and no rate exists for an uncertified class. With the committed test, `hosted:verify` reports 10/11 until that branch merges.
- `hosted:verify-pilot` compares only the pilot's own rows, so it keeps working as hosted gains other classes.

### Hosted-only migrations

Three migrations exist because of what a hosted Supabase database adds; on plain PostgreSQL they are inert or harmless:

- **016 `bai_web`**: a NOINHERIT login role whose only membership is `anon`. The app connects as `bai_web` and runs every page query as `set local role anon` in a read-only transaction, so it never holds the owner credential and cannot see anything anon cannot.
- **017 platform default privileges**: this project was created with Supabase's older defaults, which grant anon/authenticated/service_role full access to every new table, sequence and function `postgres` creates in `public`. BAI's boundary already revoked tables, views and functions from the public roles, but identity sequences stayed usable by anon and service_role held grants it has nowhere else. 017 removes the defaults (the same revoke Supabase applies to every project on 2026-10-30) and the grants they produced.
- **018 btree_gist → `extensions`**: 001 created btree_gist in `public`, where Supabase's advisor flags it and its platform-owned support functions stayed executable by PUBLIC. 018 moves the extension; existing exclusion constraints reference its operator classes by OID and keep working.

## Parity: local vs hosted

`npm run hosted:parity` builds a reference database from the migrations on a throwaway local PostgreSQL 17 with the BAI runner (no Supabase tooling involved) and compares it with the hosted database:

- **BAI-owned objects** (schemas `public`, `analytics`, `ingest`, `bai_meta`): schemas, relations, RLS flags, effective grants, columns (type, nullability, default, identity, generation), constraints (PK, FK, unique, check, exclusion), indexes, views, functions (signature, security, volatility, `search_path`, body hash, EXECUTE grants), triggers, enums, domains, policies, the `bai_web` role, and migration history. Extension members and platform event-trigger functions are excluded.
- **Seed data**: row count and content hash of every table the migrations seed (timestamps excluded; sorted with `COLLATE "C"` because glibc collation versions differ between hosts). Compared only until research data is imported.
- **Platform-managed** (reported, never confused with BAI): Supabase schemas (`auth`, `storage`, `realtime`, `vault`, `extensions`, `graphql`, `graphql_public`, `pgbouncer`, `supabase_migrations`), extensions, grants to platform roles, default privileges, and Supabase's `public.rls_auto_enable()` event-trigger function.

Explained differences:

| Difference | Why |
|---|---|
| Schema `public` grants `USAGE` to `postgres` on hosted | Granted by Supabase at project creation. `postgres` owns the database, so it already acts as `pg_database_owner`, which owns `public`; nothing new is granted. |
| `organization_names` / `organization_aliases` surrogate ids | 002 inserts them with `INSERT … SELECT` from a join without `ORDER BY`, so the numbering depends on the query plan. Nothing references these ids; they are compared by content. |

## Security model on hosted

- **Data API** exposes `public` and `graphql_public` only (`pg_graphql` is not installed). `ingest`, `analytics`, `research` (019) and `bai_meta` are not exposed.
- **anon/authenticated** may `SELECT` only public tables and views that are not registered in `internal_objects`. They have no write privilege, no sequence privilege, no EXECUTE on any BAI function and no USAGE on the private schemas. Every public table has RLS on, with one `SELECT` policy (`public_read`) on non-internal tables; internal tables have RLS and no policy (deny all; the advisor reports these as INFO by design).
- **Views** are all `security_invoker`, so the reader's privileges and RLS apply.
- **Functions**: 15 BAI functions, all SECURITY INVOKER with a pinned `search_path`; none is executable by PUBLIC, anon, authenticated or service_role.
- `npm run hosted:security` proves this behaviourally: as anon and as authenticated it attempts to list, read, insert, update and delete staged imports, invoke the ingestion and refresh functions, read internal views and write public tables (all rolled back), and probes the live Data API with the publishable key.

## Research on hosted

Normal research happens locally. A batch goes to hosted only after it has been validated, applied and reviewed locally. Hosted writes are deliberate:

- every writing command (import, validate, apply, `resolve --write`, identity, refresh) requires `--confirm-hosted <ref>`;
- `apply` is still a dry run unless `--write` is given;
- the CLI refuses any database whose host does not belong to `BAI_SUPABASE_PROJECT_REF`.

```
npm run hosted:research -- import   --file research/imports/<batch>.json --org <club> --operator <you> --confirm-hosted <ref>
npm run hosted:research -- validate --batch <key> --confirm-hosted <ref>
npm run hosted:research -- apply    --batch <key> --confirm-hosted <ref>            # dry run: compare with the local report
npm run hosted:research -- apply    --batch <key> --write --confirm-hosted <ref>
npm run hosted:research -- conflicts                                                # then resolve with the same operator/rationale as locally
npm run hosted:refresh -- --confirm-hosted <ref>
npm run hosted:verify-pilot                                                         # reconcile with research/baselines/
```

### Hosted pilot scope (2026-10-19)

Only the validated 2015 Dodgers pilot is on hosted: `pilot-2015-draft-lad` (46 records) and `pilot-2015-international-lad` (9 records), plus the Sborz #74 operator resolution. `research/baselines/pilot-2015-lad.local.json` is the id-independent snapshot of the known-good local pilot; `hosted:verify-pilot` asserts the pilot facts and diffs the hosted database against it. No other year, organization or class has been imported.

## Verification without persistence

`npm run hosted:verify` runs `tests/db/hosted-readonly.test.mjs` against hosted. Each test runs inside one transaction that is always rolled back; the pipeline's own transactions become savepoints inside it, so the real staged-ingestion code runs end to end and writes nothing. The suite asserts that every BAI table has the same row count afterwards. Identity sequences can advance (PostgreSQL never rolls back `nextval`), which only leaves gaps in surrogate ids.

## A clean local database

```
npm run db:server                 # PostgreSQL 17 on 127.0.0.1:54329, data in .pgdata/
npm run db:migrate                # 001..NNN with frozen checksums
npm run refresh:read-models
npm run research:import -- --file research/imports/2015-draft-lad.json   # optional: replay the pilot locally
```

To start over, stop the server and delete `.pgdata/`. `npm run db:parity` and `npm run db:security` run the same checks against the local database.
