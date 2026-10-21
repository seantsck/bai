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

**Current decisions (reviewed 2026-10-21, due 2027-01-21).** These are proposals prepared in the audit, for the
maintainer to confirm.

| Source | fetch_targeted | fetch_bulk | process_local | publish_repository | publish_site |
|---|---|---|---|---|---|
| MLB Stats API (draft feed, people, transactions) | PENDING | PENDING | LIMITED: 1965, 1985, 2005 (already cached) | PROHIBITED | LIMITED: 2015 on (status quo of the research program, under review); historical years refused |
| Chadwick register (ODC-BY) | CLEARED | CLEARED | CLEARED | CLEARED (attribution) | CLEARED (attribution) |
| Wikipedia (CC BY-SA, facts) | CLEARED | LIMITED: 70 per run | CLEARED | CLEARED | CLEARED |
| Baseball-Reference (live or via Internet Archive) | PENDING | PROHIBITED | LIMITED: 1965, 1985, 2005 (already cached) | PROHIBITED | LIMITED: 2015 on (status quo, under review); historical years refused |

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
- **`tests/app/search.test.mjs` and `public-queries.test.mjs`:** filter whitelisting, parameterization, pagination, and
  explorer and coverage queries as anon. The name normalizer is checked against the database.
