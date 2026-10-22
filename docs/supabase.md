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
| `BAI_PUBLIC_DATABASE_URL` | Vercel project `bai` | **secret** (sensitive), server-only | the same role through the IPv4 transaction pooler as `bai_web.<ref>`; set by `npm run deploy:web-env` (see [vercel.md](vercel.md)) |
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
- **`hosted:verify` and census claims:** with research classes on hosted, the original assertion "no coverage cell claims a census" no longer holds (LAD 2016 and 2017 legitimately claim `COMPLETE_CENSUS`). It is replaced by five shared invariants in `scripts/research/lib/integrity.mjs`: census claims are sourced and track their whole universe; no rate for an uncertified or non-census class; the public read model never shows a partial cell as complete or rate-capable. `tests/db/integrity.test.mjs` injects each violation in a rolled-back transaction and proves it is detected.
- **Phase 6 research on hosted (2026-10-20, after PR #6 merged at `ae73225`):** `lad-2017-completion.mjs`, `lad-2016-ba-corroboration.mjs` and `lad-international-2016-18.mjs` were replayed with `--confirm-hosted`.
  - Hosted class totals equal the local replay.
  - 375 import records checked field by field: 0 unexplained differences.
  - Parity 0 differences; security passed; pilot reconciliation passed.
  - The Smeltzer conflict is open on hosted for the reviewer, as intended.
  - `hosted:verify` on `main`'s code reported 10/11: its pipeline test counted every open bonus conflict in the database, including that real one. Phase 7 scopes the assertion to the test's own fixture (11/11 against hosted with only that change).
- **021 (decision history and certification boundary), 022 (acquisition dispositions) and 023 (organizational value) are deployed** (2026-10-20, after PR #7 merged at `034b71e`).
  - **Rehearsals:** the first one caught a migration bug in 022 (pending trigger events blocked an `ALTER TABLE` after the backfill). It was fixed in 022 before the merge; the second rehearsal passed.
  - **Push and record:** dry run, push, then `hosted:migrate` recorded all three.
  - **022 backfill:** moved 77 legacy dispositions onto their acquisitions (21 trades dated). The deferred consistency guard checked them inside the migration.
  - **Roles:** 021 created the NOLOGIN groups `bai_reviewer` and `bai_automation`. On Supabase, `postgres` (CREATEROLE) automatically holds ADMIN membership in both (PostgreSQL 16+; no INHERIT, no SET). It still can't act as a reviewer, because CREATEROLE is refused, but it can administer the group. This is why the certification gate stays closed ([decision-history.md](decision-history.md#what-remains-before-certification)).
- **Phase 7/8 research on hosted (2026-10-20):** replayed with `--confirm-hosted`, all exit 0:
  - `lad-international-phase7.mjs`, `lad-2016-smeltzer-proposal.mjs`, `lad-value-2016-2017.mjs`;
  - `lad-2018-2019-drafts.mjs`, `lad-dispositions-phase8.mjs`, `wave2-2016-slice.mjs`.
- **After the replay:**
  - Parity: 0 BAI differences over 2,428 objects; migration history 23/23.
  - Security passed: 52 functions. The 18 SECURITY DEFINER ones are the 7 reviewer functions (executable only by `bai_reviewer`) and 11 trigger guards. 0 are executable by public roles; 60 of 62 behavioural attempts were denied or invisible, plus the 2 public-read controls.
  - `hosted:verify` 11/11; pilot reconciliation OK.
  - A LAD-scoped record-by-record comparison with a fresh local rebuild found 0 differences: 205 picks, 105 international signings, 310 acquisition tenures, 166 audits, 354 WAR observations, 83 trade packages, class value, 11 resolutions, 4 proposals.
  - The certification gate is closed. No reviewer is enrolled, no class is certified, and no rate is published.
- **Wave 2 on hosted (2026-10-21, after PR #8 merged at `79aadae`):** `wave2-2016-drafts.mjs` and
  `wave2-2016-17-international.mjs` replayed with `--confirm-hosted`.
  - **Interruption.** The drafts runbook was stopped after HOU by a wrapper timeout. The batch apply is one transaction,
    so HOU was complete (40 selections, APPLIED). The rest resumed from a clean checkout of `main`.
  - **Results:** parity OK, security OK, `hosted:verify` 11/11, pilot reconciliation OK, integrity 0 violations.
  - **Comparison with a clean local replay:** 0 differences in 247 selections, 192 international signings, coverage,
    classes, proposals, conflicts and observations. LAD's own records are unchanged.
  - **Lesson:** hosted replays run from a clean `main` worktree, never from a working tree with other changes.
- **024 (historical drafts) is deployed** (2026-10-21, after PR #12 merged at `c29564f`, from a clean `main`).
  - **Rehearsals:**
    - `hosted:rehearse` passed (+13 relations, rolled back).
    - A deeper in-transaction rehearsal passed all 32 checks, then rolled back:
      - organization identities unchanged;
      - every franchise dated;
      - 15 historical name resolutions (for example TEX 1965 Washington Senators, MIL 1969 Seattle Pilots);
      - no overlapping names;
      - league alignment;
      - every existing selection by a club that existed;
      - coverage cells unchanged (720);
      - read-model refresh;
      - anon reads and refusals;
      - RLS and read-only policies on the new tables.
  - **Push and record:** dry run (024 only), push, then `hosted:migrate` recorded it.
  - **After:** `hosted:refresh`, parity 0 differences, security OK (54 functions), `hosted:verify` 11/11, pilot
    reconciliation OK, integrity 0 violations, and Supabase advisors report no issues.
  - **Comparison with a pre-release snapshot:**
    - organizations unchanged;
    - 21 existing name rows gained their first season, and 9 historical names were added;
    - aliases 47 → 59;
    - the new tables `organization_league_seasons` (66 rows) and `rm_draft_year_coverage` (12 phases);
    - drafts, selections, players, signings, coverage assessments and coverage cells unchanged.
  - **Production:** the live Vercel site (the earlier app) keeps working on the new schema. No historical records were
    imported.
- **025 (attribution, historical lock, publication guard, exception review) is deployed** (2026-10-21, after PR #13
  merged at `43320d5`, from a clean `main`).
  - **Rehearsals:** `hosted:rehearse` OK, plus a 15-check rehearsal:
    - attribution groups for all 166 sources;
    - public views readable as anon;
    - existing research records unchanged;
    - the guard refuses new MLB and Baseball-Reference records and repointed sources;
    - existing records stay editable;
    - the release register rejects years after 2014;
    - private tables are unreadable by anon;
    - exception evidence is refused.
  - **Push and record:** dry run (025 only), push, then `hosted:migrate` recorded it.
  - **After:**
    - `hosted:refresh`;
    - parity 0 differences over 2,751 objects (migrations 25/25);
    - security OK (64 functions, 19 SECURITY DEFINER; none executable by public roles);
    - pilot reconciliation OK;
    - integrity 0 violations;
    - Supabase advisors report no issues.
  - **Preserved:** organizations, names, sources (apart from the generated column), selections, signings, bonuses,
    WAR, observations and international signings are unchanged.
  - **Historical lock** refuses a 1999 selection; no exception evidence, release or grant rows exist; certification
    remains closed.
  - **`hosted:verify` 10/11.** Its calendar-idempotence check re-runs 015's seed upsert. 025's guard fired BEFORE INSERT,
    which PostgreSQL runs even for a conflicting (no-op) upsert row, so the re-seed was refused as a new publication.
    026 fixed this (below).
- **026 (publication guard ignores no-op upserts) is deployed** (2026-10-21, after PR #14 merged at `a151e6c`, from a
  clean `main`).
  - **Rehearsals:** `hosted:rehearse` OK, plus a rolled-back rehearsal:
    - the 015 re-seed is refused without 026 and succeeds with it;
    - new MLB-sourced records and repointed sources are still refused;
    - 32 insert and 32 update guards replace 025's triggers.
  - **Push and record:** dry run (026 only), push, then `hosted:migrate` recorded it.
  - **After:**
    - `hosted:refresh`;
    - migration history 26/26;
    - parity 0 differences over 2,784 objects;
    - security OK (64 functions; none executable by public roles);
    - **`hosted:verify` 11/11**;
    - pilot reconciliation OK;
    - integrity 0 violations;
    - Supabase advisors report no issues.
  - **Preserved:** compared with the snapshots taken before 025 and before 026, these are unchanged:
    - players (779), selections (456), draft signings (456), international signings (297);
    - WAR observations (354), source observations (7,429), external ids (1,372);
    - organizations, names, drafts, coverage and sources.

    Only the read models' refresh generation changed. There are no historical drafts or selections, no exception
    evidence, no release or publication-grant rows, and certification remains closed.
- **Production release (2026-10-21):** `main` at `a151e6c` was deployed manually to Vercel Production as
  `dpl_4MkRhWprvwbL6vL2Yby8aWNNUzwb`, aliased to `bai-iota.vercel.app`.
  - **Build:** from a `git archive` of the commit (57 KB, 39 files); functions in `yul1`; the read-only `bai_web`
    connection unchanged. The Git-triggered production build was skipped by `ignoreCommand`, as designed.
  - **Smoke test, unauthenticated:** every public page returned 200, and unknown routes, `/api` and `/admin` returned
    404. Source counts and labels, the independence footer and the partial-coverage notices were all shown.
  - **Runtime logs:** no errors, warnings or 5xx responses.
  - **Rollback:** the previous production deployment, `bai-9alfbilek`, is available.
- `hosted:verify-pilot` compares only the pilot's own rows, so it keeps working as hosted gains other classes.

### Hosted-only migrations

Three migrations exist because of what a hosted Supabase database adds; on plain PostgreSQL they are inert or harmless:

- **016 `bai_web`**: a NOINHERIT login role whose only membership is `anon`. The app connects as `bai_web` and runs every page query as `set local role anon` in a read-only transaction, so it never holds the owner credential and cannot see anything anon cannot.
- **017 platform default privileges**: this project was created with Supabase's older defaults, which grant anon/authenticated/service_role full access to every new table, sequence and function `postgres` creates in `public`. BAI's boundary already revoked tables, views and functions from the public roles, but identity sequences stayed usable by anon and service_role held grants it has nowhere else. 017 removes the defaults (the same revoke Supabase applies to every project on 2026-10-30) and the grants they produced.
- **018 btree_gist → `extensions`**: 001 created btree_gist in `public`, where Supabase's advisor flags it and its platform-owned support functions stayed executable by PUBLIC. 018 moves the extension; existing exclusion constraints reference its operator classes by OID and keep working.

- **027 (Wikidata attribution, strict source identity) is deployed** (2026-10-22, after PR #19 merged at `b0803b9`): rehearsed on a disposable PostgreSQL 17 built from 001-026 with the hosted data copied through a read-only transaction (19,163 rows in 92 tables, equal table by table), then `hosted:rehearse` (rolled back), dry run (027 only), push, and `hosted:migrate` recorded it. It keeps all 166 existing source categories (2 legacy BAI compilations that cite mlb.com pages differ from the strict rule and are no longer permission for new records), adds the WIKIDATA category, a strict classifier that judges restricted hosts first and gives Chadwick, Wikipedia, Wikidata and BAI research only to sources with their full identity, a fixed classification per source, and the private append-only `ingest.release_audits`. After the push: parity 0 BAI differences (history 27/27), security OK, `hosted:verify` 11/11, advisors clean, pilot reconciliation OK; every one of the 92 existing tables was byte-identical before and after (only the migration record and the new empty audit table appeared).
- **First 2020 research release (2026-10-22):** manifest `d3bdbdac548e8a88811f2c28587a79aa21b0c5abcc77a4a70ab88d9e9a19c9c9` (158 selections, 30 clubs, all PARTIAL_RECONSTRUCTION; Tyler Brown #101 imported name-only and flagged unresolved; J. T. Ginn #52 and Nick Frasso #106 held for an owner decision; zero signing rows and bonuses). Applied with `scripts/history/release.mjs` in one transaction after an all-SAFE read-only preview, with the target confirmed as the BAI project and no drift from the post-027 state; release audit 1 records 158 INSERT outcomes. Hosted afterwards: players 779 to 937, selections 456 to 614, signings unchanged at 456, external ids 1,372 to 1,737, sources 166 to 169. Existing rows were unchanged (checked table by table by checksum). The release is an identity-confidence release, not a certification: no reviewer was created, certification stays closed, and no club is a complete census. The existing production deployment reads the new data without a code release (pages are dynamic); only the `/sources` credit for Wikidata awaits the next ordinary production release.

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
