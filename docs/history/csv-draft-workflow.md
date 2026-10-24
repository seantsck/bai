# Staging CSV workflow for draft selections

For any table of draft selections that a person can supply with provenance (a licensed dataset, a table from a source whose terms allow reuse, a hand-checked list). It is deterministic: no network except an optional cached Wikidata lookup, and no AI. It never writes to a database. Its output is a release directory, so the ordinary release tools (verify, hosted collision preview, disposable rehearsal, authorized apply) are the only way rows can reach hosted BAI.

## Columns (all required in the header; any cell may be blank except where stated)
| Column | Rule |
|---|---|
| `draft_year` | must equal `--year` |
| `overall_pick` | positive whole number, required, once per file |
| `round_code` | required: a number, `C-n`, `S-n`, `CB-A`, `CB-B` or `PPI` (the prospect promotion incentive pick) |
| `round_pick` | blank or a positive number |
| `team` | franchise key (`LAD`) or the club's name; required |
| `player_name` | required |
| `player_mlbam_id` | blank or 4-9 digits |
| `position`, `school` | free text; blank is unknown |
| `signing_status` | blank, `UNKNOWN`, `SIGNED` or `DID_NOT_SIGN`; blank means unknown, never "did not sign" |
| `signing_bonus` | blank or an amount; a bonus needs `SIGNED`; blank means unknown, never zero |
| `source_url` | required, https |
| `source_revision` | required: the pinned revision, edition or retrieval of the source |
| `source_permission` | required: the source-catalog id that governs the URL (`research/history/sources.json`) |

## What the importer checks
- **Rights, per row:** the URL's host must be governed by a catalog source, the `source_permission` must name that same source, and the source must permit site publication for the year. A copied MLB Stats API or Baseball-Reference table is held whoever typed it; so is a host the catalog does not know. Manual entry never bypasses the gate; the release's own verification repeats it.
- **Identity, never by name alone:** a supplied MLBAM id must exist in the pinned Chadwick register under the same name, must have a Wikidata item tied to the same id (the Wikidata map, below) and an agreeing birth date; otherwise the row is held. A row without an id is imported name-only only when the register has no same-name person in the plausible birth window; otherwise it is held for an MLBAM id.
- **Duplicates:** a pick number or an MLBAM id twice in the file holds the repeats. Repeat selections of one player across years are fine: the collision preview links them by identifier and asks for a person's approval.
- **Signing facts:** a release carries none. Rows that state a status or bonus are kept in `signing-proposals.json` for a separate reviewed path, and every selection is built with signing unknown.
- **Coverage:** every club is PARTIAL_RECONSTRUCTION; a supplied file is not proof of the population.

## Commands
```
node scripts/history/csv-draft.mjs template --out rows.csv
node scripts/history/csv-draft.mjs check --csv rows.csv --year 2024
node scripts/history/csv-draft.mjs wikidata-map --csv rows.csv --year 2024 --out map.json     # cached, polite, CC0
node scripts/history/csv-draft.mjs build --csv rows.csv --year 2024 --release-dir .local/history/2024/release/csv --retrieved 2026-10-24 --documented 614 --wikidata-map map.json
node scripts/history/release.mjs verify --release-dir .local/history/2024/release/csv
node --env-file=.env.hosted.local scripts/history/release.mjs preview --release-dir .local/history/2024/release/csv   # read-only
node --env-file=.env.hosted.local scripts/history/rehearse-release.mjs --release-dir .local/history/2024/release/csv   # disposable copy
```
Output is immutable: building changed content into an existing release directory is refused. Per-row artifacts stay in the gitignored `.local/` workspace.

## Cheapest route to broader draft coverage
1. **Reuse what is cached** (Wikipedia revisions for 2017-2023, the Chadwick register, Wikidata queries): no new requests.
2. **Cleared sources only, deterministic code:** the Wikipedia draft articles reach about 29% of the picks in a 20-round draft (the opening picks plus an editors' sample) and under 10% in the 40-round years; 2024 and 2025 follow the 2023 layout (two article requests plus a few Wikidata queries each); 2017-2019 need a parser variant for their article layout.
3. **The one large unlock is MLB's written authorization** for the Stats API draft endpoint: about one request per year gives the complete pick lists, fetched directly (not through Diamond IQ, which only passes the same data through), then handled by this same CSV or the release builder.
4. **Other full-list sources** need a license (a licensed dataset, whose outreach drafts exist) or a lawful press transcription plan; their tables enter through this CSV workflow with `source_permission` recorded.
