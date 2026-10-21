# Historical drafts, 1965 onward

BAI's goal is every identifiable MLB amateur draft selection since the first draft in 1965. That includes picks who
never signed or never reached the majors. Each selection is an acquisition event, alongside international signings.

This page covers three parts:
- the data model (migration 024);
- the bulk importer (`scripts/history/`);
- the public explorer.

The pilot's results are in [pilot-results.md](pilot-results.md) and the full plan is in [backfill-plan.md](backfill-plan.md).

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
  | `AUGUST_LEGION` | AL | MLB's feed shows 13 picks in 1965 |

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

## Sources and permissions (`research/history/sources.json`)

| Source | Use | Terms | Bulk status |
|---|---|---|---|
| MLB Stats API draft endpoint | Selection universe for every phase, picks, rounds, franchise-stable team id, MLBAM person, school label | "Only individual, non-commercial, non-bulk use … without prior written authorization from MLBAM" | **NEEDS_DECISION** |
| Chadwick Bureau Register, pinned commit `781c175` | MLBAM → Baseball-Reference, BR minors, FanGraphs, Retrosheet ids | ODC-BY 1.0 (attribution) | CLEARED |
| Wikipedia draft articles (revision ids) | Dates; stated totals | CC BY-SA; facts only | CLEARED |
| Baseball-Reference via Internet Archive captures | Per-club count and name corroboration | Sports Reference restricts automated collection; archive captures only, a few pages per draft | PILOT_ONLY |

MLB's terms are the main open question. Before any league-wide backfill, a person should decide whether to request
written authorization from MLBAM, or to limit BAI's use. The importer records the terms with every batch, and imports
only into local databases.

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
  - Only hosts in the catalog may be fetched.

**Building**
- **Deterministic.** The same cache gives byte-identical batch files: records in pick order, keys in a fixed order.
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
- **Local only.** Hosted databases are refused until the permissions decision and a reviewed batch plan exist.
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
  - fetcher cache, checksums, offline mode, budget and host allowlist.
- **`tests/app/search.test.mjs` and `public-queries.test.mjs`:** filter whitelisting, parameterization, pagination, and
  explorer and coverage queries as anon. The name normalizer is checked against the database.
