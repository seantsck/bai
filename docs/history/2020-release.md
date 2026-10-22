# A manifest-bound research release (prepared in Phase 10.4; first candidate: the 2020 June draft)

This describes the mechanism. Preparing it is not authorization to run it: a hosted run needs a separate, explicit approval that names a manifest checksum.

## Pieces
| Piece | What it is |
|---|---|
| Migration `027_wikidata_attribution` | `WIKIDATA` attribution category recognised by URL, publisher, type and key together (`public.source_attribution_category`); restricted groups decided before label-based ones; the hosted publication guard passes WIKIDATA (CC0) and nothing else new; a source's category is fixed once it exists (`sources_category_fixed`); `ingest.release_audits` (append-only, private). Existing rows keep their categories (the migration fails if any would change). |
| Catalog | `wikidata` is CLEARED for `publish_site` on its CC0 basis and declares an `identity` (hosts, publisher, type, key pattern). A source that claims the key without the identity is refused locally and on hosted, as is a Wikidata URL under another key. |
| `scripts/history/release.mjs` | `build` (immutable manifest + batches), `verify` (files, scope, source permissions; no database), `preview` (read-only collision report), `apply`. |
| `scripts/history/lib/release.mjs` | Manifest, checksums, scope checks, collision classification, `applyRelease`. |
| `scripts/research/lib/txn.mjs` | Nesting transactions: the pipeline's stage, validate and apply steps become savepoints inside one outer transaction, so a release commits all-or-nothing. |
| `scripts/history/rehearse-release.mjs` | Builds a disposable PostgreSQL 17 from migrations 001–026, copies the hosted data in through a read-only transaction (row counts compared table by table), applies 027, then applies each release to clones and checks the result. |

## The manifest
`release-manifest.json` is checksummed (`manifest_sha256`, over canonical JSON) and names every batch file's SHA-256. It records the authorization scope (one draft year, one draft key, a maximum selection count), the article revision and its response checksum, the Chadwick commit, the identity file's checksum, included and held picks, per-club counts, source keys with their catalog rights, per-pick identity confidence, the coverage class (PARTIAL_RECONSTRUCTION), expected database changes (signing rows: zero), the verification plan and the rollback plan. It cannot be edited or rebuilt over: `build` refuses to overwrite a manifest with different content, and `loadRelease` refuses any file that no longer matches.

## Collision classes (read-only against the target)
- **SAFE:** can be applied as built. A replay of an already-applied batch is SAFE.
- **HUMAN_REVIEW:** a person must decide first, and the pick is left out of the manifest until a human approval for exactly that pick and code is recorded in it: a same-name existing player (the importer would hold the record, never link by name), or an identifier that already belongs to an existing player (the importer would link by that identifier).
- **BLOCKED:** never cleared by approval: an existing selection at the pick, an identifier conflict with an existing player, split identifiers, a missing draft or organization, an inconsistent franchise, a source with the same key but other details, a staged batch with the same key and other content, migrations that are not exactly the committed 001–027.

## Apply (what it checks, in order)
`--manifest-sha256` must equal the manifest's checksum; the operator must be a person (not `agent:*`); every batch must pass the content and source-permission checks; a hosted target needs `--confirm-hosted <project ref>`; the migration history must be exactly the committed files through 027 with matching checksums; an existing release audit for this manifest means "already applied" (no writes); the collision report must be SAFE. Then, in one transaction: for every batch, stage, class, validate, dry run (any held record or conflict aborts), write; then verify against the manifest (each selection at its club, identifiers held by the right player and no name-only link, no signing rows added, the draft gained exactly the imported count); then write the release audit. Any failure rolls everything back.

## Commands for a separately approved hosted release (nothing here has been run)
```
# 0. migration 027 (a person approves and pushes it; the disposable rehearsal comes first)
npm run hosted:rehearse
supabase db push                        # as in docs/supabase.md
# 1. verify and preview (read-only)
npm run hosted:release -- verify  --release-dir <release dir>
npm run hosted:release -- preview --release-dir <release dir>
# 2. apply (hosted writes)
npm run hosted:release -- apply --release-dir <release dir> --manifest-sha256 <checksum> --operator "<approver's name>" --confirm-hosted <project ref>
# 3. after the commit
npm run hosted:refresh
npm run hosted:verify && npm run hosted:parity && npm run hosted:security
```
The rollback plan is in the manifest. Production Vercel needs no release for the data; the `/sources` credit for Wikidata ships with the next ordinary production release.
