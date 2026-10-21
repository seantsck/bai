# Historical drafts, 1965 onward

BAI's goal is every identifiable MLB amateur draft selection since the first draft in 1965. That includes picks who
never signed or never reached the majors. Each selection is an acquisition event, alongside international signings.

This page covers three parts:
- the data model (migration 024);
- the bulk importer (`scripts/history/`);
- the public explorer.

The pilot's results are in [pilot-results.md](pilot-results.md), the full plan is in [backfill-plan.md](backfill-plan.md), and
the sources behind the records already on hosted are in [hosted-provenance.md](hosted-provenance.md).

## Data model (024, additive)

- **Draft phases.** Each phase is its own `drafts` row (`draft_kind`), so pick numbers never collide across phases. A
  player picked in two phases of one year has two acquisitions; a second pick of the same person in one phase is refused
  (`unique (draft_id, player_id)`).

  | `draft_kind` | MLB code | When |
  |---|---|---|
  | `JUNE_AMATEUR` | JR | 1965 onward (the Rule 4 draft) |
  | `JANUARY_REGULAR` | NR | 1966–1986 |
  | `JANUARY_SECONDARY` | NS | 1966–1986 |
  | `JUNE_SECONDARY` | JS | 1966–1986 |
  | `JUNE_SECONDARY_DELAYED` | JD | late 1960s |
  | `AUGUST_LEGION` | AL | 1965 |

- **Dates.** `drafts.start_date_precision` is `DAY` or `MONTH`. A month-only date is the first of the month and is never
  shown as a day.
  - A day is recorded only when a source states one.
  - Otherwise the month comes from MLB's phase name ("January Amateur Draft"), as listed in `research/history/calendar.json`.
- **Franchises across seasons.** Every draft-era club is an ancestor of one of today's 30; none has folded since 1965.
  - `organizations.first_season`: a selection or research class for a club before it existed is refused, by a trigger
    and by `research:class`.
  - `organization_names` gives every name used since 1965 with its seasons: Milwaukee Braves, Kansas City Athletics,
    Houston Colt .45s, the Los Angeles, California and Anaheim Angels, the expansion Washington Senators, Seattle Pilots,
    Montreal Expos, Florida Marlins and Tampa Bay Devil Rays. A source's wording resolves to the franchise *for that
    season*: "Washington Senators" is TEX in 1965 and MIN in 1955.
  - `organization_league_seasons` gives league and division by season, from 1965. Divisions are null before 1969.
- **Coverage cells.** One cell per draft phase and club *that existed that year*. `refresh_read_models()` validates the
  count by the same rule.
- **Explorer support.**
  - `v_draft_explorer`: one row per selection, with the club's name and league in that year.
  - Prefix indexes on normalized player and school names.
  - `rm_draft_year_coverage`: counts per phase, refreshed offline. The aggregate view `v_draft_year_coverage` is internal.
  - Public views call no functions, because `anon` can execute none.

## Sources and permission gates

`research/history/sources.json` (format `bai-history-sources/2`) holds the permission decisions, and
`scripts/history/lib/permissions.mjs` enforces them. **A hostname on the allowlist is not a permission.**

**Uses.** Each source has a separate grant for each use:

| Use | What it covers |
|---|---|
| `fetch_targeted` | a bounded request for one class or page |
| `fetch_bulk` | automated league-wide or multi-year collection (every history importer download) |
| `process_local` | reading cached copies to build batches, reports, plans, the exception register or a local database |
| `publish_repository` | committing source-derived records, extracts or counts to the public Git repository |
| `publish_site` | writing source-derived records to the hosted database, which the public site reads |

**States.**
- `CLEARED`: the license permits it.
- `LIMITED`: only inside its scope (years, requests per run).
- `AUTHORIZED`: only with a documented authorization on file. The record needs a reference, the grantor, a grant date,
  an expiry or none, the uses and scope it covers, and the document itself with its SHA-256; an expired, mismatched or
  missing document refuses.
- `PENDING`: a person must decide; refused.
- `PROHIBITED`: refused.

A source whose `review_due` date has passed is refused until it is reviewed again. Permission to download never implies
permission to publish.

**Current decisions (reviewed 2026-10-21, due 2027-01-21).** Tightened in Phase 9.3 at the maintainer's direction:
"under review" is not permission for new publication.

| Source | fetch_targeted | fetch_bulk | process_local | publish_repository | publish_site |
|---|---|---|---|---|---|
| MLB (Stats API, transaction wire, MLB.com, MiLB.com) | PENDING | PENDING | LIMITED: 1965, 1985, 2005 (already cached) | PROHIBITED | PENDING: no new publication in any year; existing hosted records preserved for review |
| Chadwick register (ODC-BY) | CLEARED | CLEARED | CLEARED | CLEARED (attribution) | CLEARED (attribution) |
| Wikipedia (CC BY-SA, facts) | CLEARED | LIMITED: 70 per run | CLEARED | CLEARED | CLEARED |
| BAI reference (BAI's own compilations; `bai-reference:` keys, type BAI_REFERENCE) | — (not downloadable) | — | CLEARED | CLEARED | CLEARED (any URL it cites must also be permitted) |
| Verification fixtures (`verify:` keys, type TEST_FIXTURE) | — | — | CLEARED | CLEARED | CLEARED for rolled-back `hosted:verify` only; the database guard refuses them otherwise |
| Anything else (news, Baseball America, FanGraphs, clubs) | not catalogued: **refused on hosted** until a person catalogues it with a permission basis | | | | |
| Baseball-Reference (live or via Internet Archive) | PENDING | PROHIBITED | LIMITED: 1965, 1985, 2005 (already cached) | PROHIBITED | PENDING: no new publication; existing hosted observations, bonuses and WAR preserved for review |

**Where each gate is enforced**
- **Fetcher.** Every call names its source and use, and the URL must match that source's hosts and URL prefixes. A
  network request needs the fetch grant; a cached read needs `process_local` for the year. Refusals happen before any
  request.
- **History CLI.** `build` and `calendar` check `process_local` for the year. `import` checks every source a batch cites
  (MLB, Chadwick, and the archived page that corroborated a census claim), and a non-local target would also need
  `publish_site`. Refusals exit with code 4.
- **Research pipeline (hosted).** `stageFile` and `applyBatch --write` call `requireHostedPublication` on any
  non-local database, so every path is covered: both CLIs, runbooks and scripts. An unknown host counts as hosted. A
  batch is refused before anything is written if:
  - a governed source (matched by key, case-insensitively, **or by URL**, so an alias key pointing at
    `statsapi.mlb.com` or an archived `baseball-reference.com` page is still governed) lacks `publish_site` for any
    year the batch touches;
  - it cites an unknown `hist:` key;
  - it touches a **historical year** (before `historical_before`, 2015) and cites any uncatalogued source;
  - its years cannot be determined (treated as historical).

  Years come from coverage claims and from every record: draft and period keys, signing dates, referenced
  acquisitions, and for outcome audits and trades the date or season observed. The research CLI applies the same check
  early, for a clear message.
- **Research downloaders.** `scripts/research/sources/fetch-mlb-player-outcomes.mjs` and `fetch-bref-player-pages.mjs`
  need `fetch_targeted` for their source and exit with code 4 before any request (currently refused).
- **Publication check.** `npm run history:publication-check`, part of `npm run check`, fails if a tracked file:
  - lies under a restricted path (`.restricted/`, `.cache/`, `research/history/batches/`);
  - cites a governed source key without `publish_repository`;
  - cites an unknown `hist:` key;
  - is a file under `research/history/` that is not on the reviewed list (`REVIEWED_HISTORY_FILES`).

  It also lists, as notices, older research files that cite MLB or Baseball-Reference outside the catalog (see
  [hosted-provenance.md](hosted-provenance.md)).

**Restricted outputs.** The following are written to `.restricted/history/`, which is gitignored and in
`.vercelignore`:
- batches, build reports, import timings and the full plan;
- calendar rows sourced only from MLB's phase names;
- the exception register.

Override the location with `BAI_HISTORY_OUT`. Back it up outside the repository: the pilot's copy is in
`~/bai-restricted-research/`, with a SHA-256 file. Only the download manifest (URL, size, SHA-256 and time per file:
metadata, no content), the catalog and the openly sourced calendar rows are committed.

### What can proceed without new permissions

- **Code, schema and tests:** migration 024, the explorer, the importer and its gates, synthetic benchmarks and
  fixtures.
- **Review of the 24 preserved exceptions:** human decisions recorded through the pipeline.
- **Attribution:** for Chadwick ids on public pages.
- **Authorization request:** preparing it for MLBAM, with the scope this plan needs.

## Importer (`scripts/history/cli.mjs`, `npm run history -- <command>`)

The importer reuses the research pipeline in-process. Every record goes through the same staging, validation, identity
resolution, observations and coverage update as a researcher's batch. It makes no AI calls.

```bash
npm run history -- fetch-draft --years 1985 [--phases JR,NR,NS,JS,JD,AL] [--max-requests 50]
npm run history -- fetch-crosswalk
npm run history -- fetch-evidence --year 1985 [--teams LAD,WSH] [--interval-ms 3000]
npm run history -- calendar --years 1985
npm run history -- build --year 1985 [--orgs LAD,WSH] [--offline]
npm run history -- import --year 1985 [--orgs LAD,WSH] [--write] [--no-plan]
npm run history -- status [--from 1965 --to 2026]
npm run history:plan                       # per-year plan (public table; full plan in .restricted/)
node scripts/history/exceptions.mjs        # exception register (restricted)
npm run history:publication-check          # part of npm run check
npm run history:benchmark
```

**Fetching**
- **Cache and checksums.** Downloads land in `.cache/history/` (gitignored). Each is recorded in
  `research/history/manifest.json` (committed) with its URL, byte count, SHA-256 and retrieval time.
- **Tamper detection.** A cached file that no longer matches its checksum is an error. `--offline` replays from the cache
  only.
- **Request limits.**
  - At most `--max-requests` network requests per run.
  - One request per host every `--interval-ms`.
  - Backoff on 429/5xx that honours `Retry-After`.
  - A spent budget exits with code 3, and the next run resumes from the cache.
  - Every request needs its source's fetch grant (above); an allowlisted host alone is refused.

**Building**
- **Deterministic.** The same cache gives byte-identical batch files: records in pick order, keys in a fixed order.
- **Evidence is cited.** When an independent list shaped a coverage claim, its page is a source of the batch, so the
  gates apply to it too.
- **What is claimed.**
  - Picks, rounds, franchise, MLBAM identity, name, birth date and country, and MLB's school label.
  - Crosswalk ids are attributed to Chadwick (`external_id_sources`).
  - Signing status is always `UNKNOWN`: it is not in these sources, and unknown is not unsigned.
  - A school type is taken only from explicit words in the label (HS, JC, University…); otherwise the school is untyped.
- **Duplicates.** One person at two picks of one phase is reported, and the later pick is held out of the batch. The
  held pick is listed in the coverage gap notes and the build report, never dropped silently.

**Census claims**
- A club's phase is a `COMPLETE_CENSUS` only when an independent list (an archived Baseball-Reference franchise-year page)
  has the same count **and** every name on it matches one of MLB's picks.
- Matching is by full name, then by surname at the same pick or in the same round. Overall pick numbers are *not* used
  for identity, because older drafts are numbered differently by different compilers.
- Anything else is a `PARTIAL_RECONSTRUCTION` with the reason. One feed's row count is never treated as the population.

**Importing**
- **Checkpoints.** An applied batch with the same file checksum is skipped, so a stopped run resumes where it stopped.
- **Stops.** Any invalid record, held identity or conflict stops the run before writing.
- **Local only.** Hosted databases are refused until `publish_site` is granted for the batch's sources and a reviewed
  batch plan exists.
- **Job planning.** `--no-plan` skips research-job planning (about 2.5 jobs per pick) for bulk work.

## Public explorer (`/draft/explorer`, `/draft/years`)

- **Filters:** player-name prefix, franchise, a year or a range, phase, round, school prefix, school type and signing
  status.
- **Query construction (`lib/search.ts`).**
  - Every filter is whitelisted or parsed.
  - The SQL is fixed and fully parameterized.
  - Names are normalized in JavaScript exactly as `public.normalize_name` does it (tested against the database).
- **Pages.** 50 rows per page, capped at page 200. The query fetches one extra row instead of counting.
- **Coverage page.** `/draft/years` shows, per phase: clubs with a census out of clubs that existed, expected (blank
  until every club has a census), imported, identities, signing known, bonus known and outcomes audited. It publishes no
  rates.
- **Security.** It runs on the same read-only path as every page: `bai_web` → `anon`, a read-only transaction and a
  3-second statement timeout.

## Attribution and methodology (025)

- **`/sources` (public)** carries:
  - the independence statement (BAI is not affiliated with or endorsed by MLB, MLB Advanced Media, any club or any
    source);
  - the sourcing rules;
  - each source group, with what BAI takes from it, its credit line, and the records and observations citing it
    (`v_source_attribution`);
  - a rights note: crediting a source is not a license to redistribute it.
- **Every page footer** repeats the independence statement.
- **The explorer** shows each row's source group, for the selection and its signing (`v_selection_attribution`). Before
  025 is deployed the column shows a dash, and the explorer itself is unaffected.
- **Groups** (`sources.attribution_category`, generated): MLB, Baseball-Reference, Chadwick Register, Wikipedia, BAI
  research (independent researcher observations and compilations), and other publications.

## Publication guard for new records (025, hosted only)

On a Supabase (hosted) database, a trigger on every table that cites a source refuses a **new** record that cites a
source outside the openly licensed groups (Chadwick Register, Wikipedia, BAI research). That covers an insert, or a
change of `source_id`. It applies to MLB, Baseball-Reference, other publications and test fixtures alike. A group opens
only when a person records a row in `ingest.source_publication_grants`.

- **Existing records are unaffected.** They stay readable on the public site and editable without changing their
  source. Nothing is deleted or hidden while the rights review runs.
- **A grant is not verified.** A grant row (like a historical release row) records what a person asserted; the database
  cannot verify that a license exists.
- **Local research databases** are not guarded.
- **Two layers.** Together with the pipeline's fail-closed gate, which requires every cited source to be catalogued and
  every matching entry by key or URL to grant `publish_site`, neither a script, a runbook, an alias key nor ad hoc SQL
  can publish new restricted records by accident.

## Historical lock (025)

A selection in a draft year before 2015 is refused by the database unless that year has a row in
`ingest.historical_releases` (`authorization_reference`, `scope_note`, `released_by`). This is defense in depth under the
permission gates: no script, runbook or ad hoc SQL can put historical selections on a database where the year was not
deliberately released.

- **Locally,** `history import --write` records its use as `local-research`.
- **On hosted,** a release row is a decision a person makes after `publish_site` is granted, citing the authorization.
  The row records that assertion; it does not mean a license has been independently verified.

## Exception review (private, 025)

The importer's disagreements are reviewed in a local research database, never in Git or on hosted.

```bash
node scripts/history/exceptions.mjs                       # rebuild the restricted register from the build reports
npm run history:review -- load --propose-rules            # load into the local database (refuses non-local)
npm run history:review -- list [--status OPEN] [--kind ALTERNATE_NAME]
npm run history:review -- show --key EX-2005-JR-PHI-LIST  # claims, evidence (cache key + SHA-256), proposals, decisions, events
npm run history:review -- conclusions --kind MISSING_SELECTION
npm run history:review -- propose --key <EX-...> --conclusion <C> --rationale "<why>" --by <name>   # or --agent <name>
npm run history:review -- decide --key <EX-...> --decision ACCEPT_PROPOSAL --proposal <id> --rationale "<why>"   # reviewer login
```

**Kinds:**
- conflicting identities;
- missing selections;
- different players at the same pick;
- one person selected more than once;
- alternate names;
- numbering disagreements;
- unmatched crosswalk ids;
- census-total disagreements.

Each kind has its own list of allowed conclusions.

**Who does what**
- **Anyone, including an agent, may propose.** `--agent` records `agent:<name>`, and rule-based proposals are
  `agent:history-review-rules`.
- **Only an enrolled human reviewer, on their own login** (`BAI_REVIEWER_DATABASE_URL`), decides:
  - accept or reject a proposal;
  - decide directly;
  - ask for more evidence;
  - reopen a decided exception.
- **Owner and automation sessions are refused** by the database.

**History is append-only:** claims, proposals, decisions and events.

**A decision is a judgment, not a correction.** A fix it calls for goes through the research pipeline as a sourced
batch. Decisions have nothing to do with certification, which stays behind its own gate.

**Status on 2026-10-21:**
- all 24 pilot exception groups are loaded locally, each with its source claims, evidence locators and a proposed
  conclusion (agent rules, deliberately cautious: `UNDETERMINED` where the evidence in hand cannot settle a case);
- none is decided.

## Preflight

`npm run history -- preflight --years 2006-2010 [--target local|hosted]` lists every grant a batch needs, year by year,
without any request or write. It exits with code 4 while any is refused. The first expansion batch is planned in
[batch-h1a-2006-2010.md](batch-h1a-2006-2010.md).

## Tests

- **`tests/db/historical-drafts.test.mjs`:**
  - names, relocations and leagues by season;
  - clubs that didn't exist yet;
  - phases as separate acquisitions, and duplicate refusal;
  - unsigned vs unknown;
  - month precision;
  - coverage cells;
  - anon access;
  - importer normalization, school typing and duplicate detection;
  - census rules and determinism;
  - crosswalk provenance;
  - fetcher cache, checksums, offline mode, budget and source hosts.
- **`tests/history/permissions.test.mjs`** (no database, no network):
  - every state and scope rule;
  - authorization documents (missing, expired, wrong checksum or scope);
  - review dates;
  - fetcher refusals before any request;
  - restricted batches refused for `publish_site`;
  - the publication check on fixtures and on the real repository;
  - the CLI exiting with code 4 on restricted downloads.
- **`tests/db/historical-review.test.mjs`** (025, fictional data):
  - attribution groups, and the public summary and per-selection views as anon;
  - the historical lock;
  - immutable claims, proposals by anyone, decisions only in a reviewer session (owner, automation and direct inserts
    refused);
  - conclusions per kind, status transitions, append-only history and withdrawal;
  - privacy from anon, refusal on a Supabase database;
  - no canonical change, and certification untouched.
- **`tests/app/search.test.mjs` and `public-queries.test.mjs`:** filter whitelisting, parameterization, pagination, and
  explorer and coverage queries as anon. The name normalizer is checked against the database.
