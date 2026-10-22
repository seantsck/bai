# A manifest-bound research release (prepared in Phase 10.4; first candidate: the 2020 June draft)

This describes the mechanism. Preparing it is not authorization to run it: a hosted run needs a separate, explicit approval that names a manifest checksum.

## Pieces
| Piece | What it is |
|---|---|
| Migration `027_wikidata_attribution` | One strict classifier, `public.source_attribution_category`: restricted groups (Baseball-Reference, MLB) are judged first by URL, publisher, key, title and type, whatever a source calls itself; WIKIDATA, CHADWICK_REGISTER, WIKIPEDIA and BAI_RESEARCH are assigned only with their full identity (URL host and path, publisher, type, and for Wikidata and BAI the key); a label alone selects nothing. `attribution_category` becomes a plain column: every existing value is kept, new sources get the strict value from a trigger, and nothing can write it later. The hosted publication guard recomputes the strict category from the source itself, so a legacy citation (the two BAI compilations citing mlb.com pages) is not permission for new records. A source's classification is fixed once it exists. `ingest.release_audits` (append-only, private). Additive; the migration fails if any existing category would change. |
| Catalog | `wikidata` is CLEARED for `publish_site` on its CC0 basis; `wikidata`, `chadwick-register` and `wikipedia-draft-articles` declare an `identity` (hosts or URL prefixes, publisher, type, key pattern). The pipeline refuses a source that claims a key without the identity, as it refuses an identity under another key; the database refuses the same forgeries independently. |
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

## Supplemental releases (picks a parent release held for a human decision)
A parent release can hold picks (for example a pick whose identifier already belongs to an existing player). Once a person has decided, the picks go out in a SEPARATE, immutable manifest; the parent manifest and its audit are never edited.
```
npm run history:release -- build --year 2020 --release-dir <new dir> --only-picks 52,106 --suffix supp1 \
  --parent-manifest-sha256 <parent checksum> --approvals <approvals.json>
```
- `--only-picks` builds exactly those picks; `--suffix` gives their batches new keys (an applied batch is immutable); `--parent-manifest-sha256` is recorded as `supplement_of`.
- The approvals file holds one entry per pick and code (`WOULD_LINK_EXISTING_PLAYER`), each with a human `approved_by`, `approved_on` and `note`. Nothing is approved on a person's behalf; without the entry the collision report holds the pick and apply refuses.
- A supplement promises **zero new players** (`players_created_max: 0`). `apply` counts players inside the transaction and rolls everything back if one was created, so a link cannot silently turn into a duplicate.
- `node --env-file=.env.hosted.local scripts/history/rehearse-release.mjs --release-dir <dir>` (embedded PostgreSQL 17, hosted copied read-only) also checks, for a supplement: the picks are exactly the approved ones; each links to its intended player; no player or signing row is added; no existing row is deleted or changed (modified rows, such as the club's coverage tally, are listed); added identifiers belong only to the linked players; the replay is idempotent. Applying to hosted still needs a separate approval naming the checksum.
