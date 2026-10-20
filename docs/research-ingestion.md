# Research ingestion

How researched facts get into BAI. Raw files never write canonical tables directly; every write goes through the same staged pipeline:

```
RAW SOURCE (research/imports/*.json)
  → staged rows        ingest.import_batches, ingest.staged_sources, ingest.staged_records
  → validation         shape, calendar, period, provenance, organization
  → identity           ingest.resolve_identity() per record
  → conflict detection field-by-field against canonical rows and their observations
  → canonical write    one transaction per batch, only on `--write`
```

Staging lives in the `ingest` schema, which the public roles cannot read.

## Import file

Format `bai-research-import/1`. Examples: `research/imports/2015-draft-lad.json`, `research/imports/2015-international-lad.json`, `research/imports/2016-draft-lad.json` (built by `scripts/research/sources/draft-class-import.mjs` from downloaded MLB and Baseball-Reference files). Other builders in `scripts/research/sources/`: `mlbcom-draft-money-import.mjs` (slot values and tracker bonuses), `fetch-mlb-player-outcomes.mjs` + `outcome-audits-import.mjs` (outcome audits), `intl-signings-from-wire.mjs` (international discovery), `ba-draft-bonuses-import.mjs` (Baseball America draft tables), `draft-signings-from-wire.mjs` (draft signings and dates from the MLB wire), `intl-list-corroboration.mjs` (independent international lists transcribed into `research/evidence/`), `draft-bonus-report-import.mjs` (transcribed bonus reports), `fetch-bref-player-pages.mjs` + `bref-season-war-import.mjs` (Baseball-Reference season-by-team WAR from pre-season archive captures), and `trades-from-wire.mjs` (both sides of a class's trades). Builders never write to a database, and the only fetcher is capped and rate-limited.

```jsonc
{
  "format": "bai-research-import/1",
  "batch_key": "pilot-2015-draft-lad",      // unique and immutable; a changed file needs a new key
  "channel": "DRAFT",                        // or INTERNATIONAL
  "description": "...",
  "coverage_claims": [{ "scope_key": "2015-JUNE_AMATEUR", "organization": "LAD", "coverage_state": "PARTIAL_RECONSTRUCTION",
                        "expected_count": 42, "source_key": "...", "gap_notes": "..." }],
  "sources": [{ "source_key": "...", "source_type": "OFFICIAL_LEAGUE", "authority_level": "OFFICIAL", "title": "...",
                "publisher": "...", "url": "https://...", "archived_url": null, "published_date": null,
                "retrieved_date": "2026-10-19", "notes": "how it was read" }],
  "records": [ /* DRAFT_SELECTION or INTERNATIONAL_SIGNING */ ]
}
```

**DRAFT_SELECTION**
- **Pick:** `draft_key`, `round_code` (`1..N`, `C-n`, `CB-A`, `CB-B`), `overall_pick`, `round_pick`, `organization`, `selection_type`, `position`.
- **Club wording (optional):** `organization_as_named` keeps the source's own name for the club (e.g. "Florida Marlins"); it must resolve to `organization` for that season (`resolve_organization`), and is kept on the organization observation.
- **Other club (optional):** `cross_organization: "<reason>"` allows a record for a club other than the import's `--org` (e.g. a re-draft).
- **Player:** `{ full_name, birth_date, birth_country, external_ids: { MLBAM, BBREF, BBREF_MINORS, FANGRAPHS }, aliases, source_key }`.
- **School:** `{ name, school_type, city, region, country }`.
- **Signing:** `{ status: SIGNED | DID_NOT_SIGN | UNKNOWN, bonus_usd, date, date_precision, source_key }`.
- **Slot value:** `slot_value { usd, source_key }`.
- **Attribution:** `field_sources` cites specific fields to a different source than the record's.
- **Evidence:** `evidence[]` holds extra claims from other sources: `{ subject, field, value, source_key, locator }`.
- **Flags:** `flags[]` holds quality flags.

**OUTCOME_AUDIT** (channel `OUTCOMES`, migration 020)
- **Player:** an existing player, identified by an external id; outcome records never create players.
- **Audit:** `audit_state` (`AUDITED_REACHED_MLB`, `AUDITED_NO_MLB`, `ACTIVE_TOO_RECENT`, `OUT_OF_SCOPE`, `UNKNOWN`; never `NOT_AUDITED`), `observation_through_season` and `audited_on`.
- **Debut:** `debut { date, organization }`, required for `AUDITED_REACHED_MLB` and forbidden for `AUDITED_NO_MLB`.
- **Details:** `details { as_of_date, reached_affiliated, first_affiliated_season, mlb_games, mlb_plate_appearances, mlb_innings_pitched, current_status, disposition, disposition_transaction_ref }`. Unknown values are null.
- **WAR and trades:** `war[] { system: BREF | FANGRAPHS | OTHER, scope, through_season, value, observed_on }` and `transactions[] { ref, type: TRADE, date, from_organization, to_organization }`.
- **Organization:** `organization` is the acquiring club whose acquisition is audited (the import's `--org`).

**TRADE** (channel `TRADES`, migration 022)
- **Trade:** `ref`, `date`, `description`, and `organization` (the importing club, which must be a party).
- **Packages:** `packages[] { from, to, players[] { player (MLBAM id required), war[] }, other_assets[] { asset_type: CASH | PLAYER_TO_BE_NAMED | DRAFT_PICK | INTERNATIONAL_POOL_SPACE | OTHER, amount_usd (null = undisclosed), description } }`.
- **Identity:** a traded player links by strong id or is created by that id; any weaker identity is invalid until a researcher decides it.
- **WAR:** entries as in outcome audits. A `SEASON` entry names the organization it was produced for (one entry per team in a split season).

**INTERNATIONAL_SIGNING**
- **Signing:** `organization`, `signing_date` and `signing_date_precision`, an optional `period_key`, `pathway`, `market { key, name }` and `position`.
- **Costs:** `costs { signing_bonus_usd, posting_fee_usd, transfer_fee_usd, other_cost_usd }`. `null` means unknown and `0` means known zero. Costs are cited to `cost_source_key`.
- **Player, evidence and flags:** same shape as in draft records.

## Commands

All commands read `BAI_DATABASE_URL` from `.env.local` and refuse non-local hosts. They never print connection strings.

| Command | What it does | Writes |
|---|---|---|
| `npm run research:import -- --file research/imports/x.json --org LAD [--class LAD/DRAFT/2016-JUNE_AMATEUR]` | Stages the file. `--org` (or an explicit `--league`) is required: every record and coverage claim must belong to that club unless the record carries `cross_organization: "<reason>"`. `--class` links the batch to a research class. `--agent <name>` stages as `agent:<name>`. Identical bytes are a no-op, and a reused `batch_key` is refused. | `ingest.*` only |
| `npm run research:validate -- --batch <id\|key>` | Validates each record and resolves identity. Exits with code 2 if any record is invalid. | `ingest.*` only |
| `npm run research:apply -- --batch <id\|key>` | **Dry run (the default).** Runs the full apply in a transaction, reports inserts, updates, conflicts, held records and coverage, then rolls back. | `ingest.*` only (the proposed action is recorded) |
| `npm run research:apply -- --batch <id\|key> --write` | Applies. Only VALID records are applied, and a batch that failed validation is refused unless `--allow-partial` is given. A batch staged by an agent is refused until `research:review` records a human review. | canonical tables |
| `npm run research:conflicts` | Lists open conflicts with every observation's value, source, authority and locator, and what the declared rule would decide. | — |
| `npm run research:resolve -- --table t --id n --field f --observation o --operator me --rationale "..."` | Records an operator decision. Without `--write` it is a dry run. | `fact_resolutions` (and the canonical column) |
| `npm run research:resolve -- --table t --id n --field f --rule [--write]` | Applies the field's declared rule. The rule refuses if it cannot decide. | same |
| `npm run research:identity -- --record n (--player slug \| --new-player \| --reject) --operator me --note "..."` | Records a researcher's identity decision for a held record. It takes effect on the next `apply --write`. | `ingest.*` |
| `npm run research:queue [-- --queue KEY]` | Shows queue sizes, or the items in one queue. | — |
| `npm run research:coverage [-- --domain DRAFT]` | Shows coverage cells with tracked, expected, audited, known-cost and last-research values. Computes no rates. | — |
| `npm run research:batches` | Lists batches and their status. | — |

After applying, run `npm run refresh:read-models` so the `/research` dashboard reflects the new data.

Class-level work (classes, jobs, the queue, research batches, certification) sits on top of these commands: see [backfill-methodology.md](backfill-methodology.md#cli).

## Modes

**Dry run**
- Executes exactly the code `--write` would, inside a savepoint that is rolled back. The report is therefore exact.
- Canonical row counts before and after are identical, and a test asserts this.

**Apply**
- Only validated rows are written, and every one cites a registered source.
- **Deterministic:** records are processed in file order and slugs are derived from names.
- **Idempotent:** re-applying a batch reports `NO_CHANGE` and adds no rows. A test asserts this, and the pilot showed it (45 NO_CHANGE, plus the 1 known conflict re-reported).
- **Fills unknowns only:** an existing non-null value is never replaced.

**Reconcile**
- A differing value is stored as a new `source_observation`, and the canonical value is left alone.
- The difference shows in `v_open_fact_conflicts` and in the `SOURCE_CONFLICT` queue.
- Resolution is a separate step: either the field's declared rule or an operator decision. It writes a `fact_resolutions` row naming the chosen observation, every observation considered, who decided, and why.
- The losing evidence stays on record.

## Conflict rules

Rules are declared per field in `conflict_rules`. A field with no row requires an operator. **No rule is "last write wins."**

| Situation | Rule | Behaviour |
|---|---|---|
| Same player, different birth date | `REQUIRE_OPERATOR` | Identity-critical. When an external id matched, the player is linked and the date disagreement becomes a field conflict. |
| Same signing, different bonus | `PREFER_HIGHER_AUTHORITY` | Chooses the strictly stronger source. Equal authority falls back to the operator. |
| Same draft pick, different signing status | `REQUIRE_OPERATOR` | It decides cohort membership. `UNKNOWN` is never evidence and never overwrites. |
| Same player, conflicting position | `REQUIRE_OPERATOR` | Sources describe different moments in a career. |
| Same acquisition, multiple rankings | not a conflict | Each `ranking_entry` is its own fact, and several rankings are simply more evidence. |
| Same signing date from different sources | `PREFER_MORE_PRECISE_DATE` | A day beats a month or a season. Two different exact days go to an operator. A transaction date and a report date are different fields (`agreement_reported_date`), not a conflict. |
| Same draft pick, different round label | `REQUIRE_OPERATOR` | Example: Josh Sborz in the pilot (MLB `CB-B`, B-Ref `2`). |
| Same source changes its value | refused | Recorded as a conflict. Sources are immutable, so a revised source gets a new key. |

## Coverage update on apply

- Every touched (draft or period, organization) cell gets its tracked count recounted from canonical rows.
- A `coverage_claims` entry sets the state only for its own scope. Every other touched cell becomes `INDIVIDUALLY_VERIFIED`. In the pilot, the four re-drafted players' other teams got this.
- A `COMPLETE_CENSUS` claim without an expected count and a source is rejected by the table's CHECK.

## Pilot (applied 2026-10-19 locally, then to the hosted BAI Supabase project)

The same two committed batches were later imported into the hosted database through the guarded `hosted:research` workflow (dry run, write, idempotent re-apply, the same Sborz operator resolution) and reconciled with `research/baselines/pilot-2015-lad.local.json` with zero differences. See [supabase.md](supabase.md#research-on-hosted).

The pilot proves the workflow. It is **not** league-wide coverage, and neither cell supports rates.

### Draft: Los Angeles Dodgers, 2015 Rule 4 draft (`pilot-2015-draft-lad`, 46 records)

**Picks**
- 42 Dodgers selections: rounds 1–40, plus #35 (round 1) and #74 (CB-B).
- **Signed vs not:** 36 SIGNED and 6 DID_NOT_SIGN (Funkhouser #35, Zech, Goldstein, Genord, Boushelle, Bilous). There are no UNKNOWN statuses.
- **Bonuses:** published for 18 of the 36 signed picks. The other 18 stay unknown, not zero.
- **Slot values:** 12 recorded, covering every pick in rounds 1–10. They sum to the published $7,781,700 pool. The pool itself is not imported.

**Schools**
- 40 schools were created by exact name: 29 college, 9 high school, 2 junior college.
- No school was left unresolved.

**Repeated identity**
- Four of the unsigned 2015 picks were drafted again: Funkhouser (DET 2016 #115), Goldstein (SEA 2016 #267), Genord (NYM 2019 #268, $10,000 bonus and $154,600 slot) and Bilous (CWS 2018 #378).
- Each re-draft resolved to the same player by MLBAM id (`EXACT_EXTERNAL_ID`), giving one player with two selections and two statuses.

**Provenance**
- **Pick facts:** cited to the MLB Stats API (OFFICIAL), which also supplied birth dates and MLBAM ids.
- **Baseball-Reference** (AGGREGATOR, read through a Wayback copy because the live page returned 403) supplied:
  - each player's position at the draft, school, signing status and bonus;
  - Baseball-Reference ids.
- **Slots:** cited to a Dodgers Digest table (OTHER; a fan analysis site, read through Wayback).
- **Re-draft signing status:** three of the re-drafts have no signing announcement. Their status rests on affiliated pro stat rows and is flagged `SIGNING_STATUS_FROM_PRO_APPEARANCES`.

**One conflict, resolved**
- For Josh Sborz (#74), MLB says `CB-B`, pick 4; Baseball-Reference says round `2`, pick 32.
- Both claims are kept. An operator resolution chose MLB's structure and recorded a rationale.

**Timing note, not a conflict**
- A pre-deadline 2015-07-17 table listed Buehler and Ríos as unsigned. The final record shows both signed.
- This is noted on the records and was not imported as a status claim.

**Coverage**
- `2015-JUNE_AMATEUR` × LAD is **PARTIAL_RECONSTRUCTION**, with expected 42 and tracked 42.
- Every member of the class is tracked, but the cell is held below census pending review: half the bonuses are missing, no outcomes are audited, and the Baseball-Reference data was read from an archive.

### International: Los Angeles Dodgers, calendar-2015 sample (`pilot-2015-international-lad`, 9 records)

**2015-16 period (opened 2015-07-02)**
- Eight `INTERNATIONAL_AMATEUR` signings:
  - Álvarez (CUB, $16.0M), Heredia ($2.6M), Brito ($2.0M), Cruz ($950K), Arias ($500K) and Rincon (bonus unknown), all on 2015-07-02;
  - Díaz (CUB, $15.5M) and Estévez (CUB, $6.0M) on 2015-11-21.
- **Dates:** every date is the MLB transaction date (OFFICIAL, day precision), and the period was derived from the date.
- **Cuban signings:** the 2015-11-22 report dates for Díaz and Estévez are kept as `agreement_reported_date` evidence, not as a rival signing date.

**2014-15 period**
- Pablo Millán Fernández, signed 2015-05-19, recorded as `INTERNATIONAL_PROFESSIONAL`. He was exempt from the pool by age and experience.
- The reported "$8 million value" is not decomposed into components, so no cost is recorded.

**Excluded**
- Héctor Olivera, a veteran on a major-league contract, is outside the amateur pilot.

**Costs**
- Only signing bonuses are recorded. Posting, transfer and other costs are unknown (null), so every cost is PARTIAL or UNKNOWN. No overage tax is computed.
- Where fetched articles corroborated a bonus, that is kept as an additional observation.
- Heredia, Brito and Arias's bonuses were seen only in search-result excerpts because the pages blocked fetching. They are flagged `EVIDENCE_EXCERPT_ONLY` (WARNING).
- Rincon's only figure came from a search-tool summary, so his bonus is left unknown.

**Markets:** DOM and CUB.

**Coverage**
- 2015-16 × LAD is **PARTIAL_RECONSTRUCTION**, with expected size unknown. The full class is larger and has not been established.
- 2014-15 × LAD is INDIVIDUALLY_VERIFIED.
- The pool, penalty and tax context is not imported: three different pool figures were seen and no per-player tax is published.

### Known pilot limitations
- Many official MLB.com pages refused automated fetches. Those figures rest on search excerpts and are labelled in the source notes and flags.
- The Baseball-Reference ids were cross-walked through the Chadwick register (AGGREGATOR). Díaz's minors id (`efrain000yun`) looks irregular and needs verification.
- No outcomes, expectations or development were researched. The `OUTCOME_NOT_AUDITED` and `MISSING_EXPECTATION` queues hold every pilot player.
- The pilot lives only in the local development database. Nothing was deployed.
