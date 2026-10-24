// The manifest-bound research release (scripts/history/lib/release.mjs): collision classification, all-or-nothing apply
// through the research pipeline, idempotent replay, scope and migration checks. FICTIONAL players and sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { loadCatalog } from '../../scripts/history/lib/permissions.mjs'
import { buildManifest, observationMax, observationLimit, HISTORICAL_OBSERVATION_ALLOWANCES, loadRelease, verifyReleaseContent, collisionReport, applyRelease, canonicalJson, manifestChecksum, fileSha256 } from '../../scripts/history/lib/release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = loadCatalog(root)
let db
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-release-test-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

const WIKI = 'hist:wikipedia-2020-fixture-r1'
const CW = 'hist:chadwick-register-abc1234'
const WD = 'hist:wikidata-2020-fixture'
const sources = (verified) => [
  { source_key: WIKI, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikipedia: fixture draft, revision 1', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=Fixture&oldid=1', retrieved_date: '2026-10-22' },
  ...(verified ? [{ source_key: CW, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Chadwick Baseball Bureau Register, fixture', publisher: 'Chadwick Baseball Bureau', url: 'https://github.com/chadwickbureau/register/tree/fixture', retrieved_date: '2026-10-22' },
    { source_key: WD, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikidata identity corroboration fixture', publisher: 'Wikimedia Foundation (Wikidata contributors)', url: 'https://www.wikidata.org/', retrieved_date: '2026-10-22' }] : [])
]
const record = (pick, org, name, { ids = null, birth = null, birthCountry = null, position = null, roundPick = null } = {}) => ({
  type: 'DRAFT_SELECTION', source_key: WIKI, draft_key: '2020-JUNE_AMATEUR', round_code: '1', overall_pick: pick, round_pick: roundPick, ...(position ? { position } : {}), organization: org, selection_type: 'STANDARD',
  player: { full_name: name, source_key: WIKI, ...(birth ? { birth_date: birth } : {}), ...(birthCountry ? { birth_country: birthCountry } : {}), ...(ids ? { external_ids: ids, external_id_sources: Object.fromEntries(Object.keys(ids).map((k) => [k, CW])) } : {}) },
  ...(ids ? { evidence: [{ subject: 'player', field: 'wikidata_item', value: 'Q1', source_key: WD }] } : {}),
  signing: { status: 'UNKNOWN' }, notes: 'fixture'
})
let tag = 0
const batch = (org, records, verified) => ({
  format: 'bai-research-import/1', batch_key: `hist-2020-june-amateur-${org.toLowerCase()}-fixture-${++tag}`, channel: 'DRAFT', description: `${org} fixture`,
  coverage_claims: [{ domain: 'DRAFT', scope_key: '2020-JUNE_AMATEUR', organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: WIKI, gap_notes: 'fixture: one list' }],
  sources: sources(verified), records
})
const writeRelease = (name, docs, { approvals = [], mutate = null, supplementOf = null, documentedSelections = null } = {}) => {
  const dir = path.join(tmp, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'batches'), { recursive: true })
  const batches = docs.map((doc, i) => { const file = `${String(i).padStart(2, '0')}-${doc.batch_key}.json`; fs.writeFileSync(path.join(dir, 'batches', file), JSON.stringify(doc, null, 1) + '\n'); return { file, sha256: fileSha256(path.join(dir, 'batches', file)), doc } })
  let manifest = buildManifest({ releaseKey: `fixture-${name}`, year: 2020, draftKey: '2020-JUNE_AMATEUR', batches, identity: { picks: [] }, article: { revision: 1, response_sha256: 'a'.repeat(64) }, chadwickCommit: 'f'.repeat(40),
    identityFileSha256: 'b'.repeat(64), brownVariant: 'HELD', heldPicks: [], humanApprovals: approvals, supplementOf, documentedSelections, catalog, maxSelections: docs.reduce((n, d) => n + d.records.length, 0), createdOn: '2026-10-22' })
  if (mutate) { manifest = mutate(manifest); manifest.manifest_sha256 = manifestChecksum(manifest) }
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  return dir
}
const count = async (sql, p) => Number((await h.one(db, sql, p)).n)
const selCount = () => count(`select count(*) n from draft_selections s join drafts d on d.id = s.draft_id where d.draft_key = '2020-JUNE_AMATEUR' and s.source_id in (select id from sources where source_key like 'hist:wikipedia-2020-fixture%')`)

test('the manifest is checksummed, batches are checksummed, and edits are refused', () => {
  const dir = writeRelease('integrity', [batch('KC', [record(1, 'KC', 'Fixture Release One')], false)])
  const rel = loadRelease(dir)
  assert.equal(rel.manifest.coverage.state, 'PARTIAL_RECONSTRUCTION')
  assert.equal(rel.manifest.expected_database_changes.signing_rows, 0)
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  // Key order does not change a checksum; content does.
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}')
  const file = path.join(dir, 'release-manifest.json')
  const m = JSON.parse(fs.readFileSync(file, 'utf8')); m.totals.selections = 99
  fs.writeFileSync(file, JSON.stringify(m))
  assert.throws(() => loadRelease(dir), /does not match its own checksum/)
  const dir2 = writeRelease('integrity2', [batch('KC', [record(1, 'KC', 'Fixture Release One')], false)])
  const bf = path.join(dir2, 'batches', fs.readdirSync(path.join(dir2, 'batches'))[0])
  fs.writeFileSync(bf, fs.readFileSync(bf, 'utf8').replace('Fixture Release One', 'Fixture Release Won'))
  assert.throws(() => loadRelease(dir2), /does not match the manifest checksum/)
  fs.writeFileSync(path.join(dir2, 'batches', 'extra.json'), '{}')
  fs.writeFileSync(bf, fs.readFileSync(bf, 'utf8').replace('Fixture Release Won', 'Fixture Release One'))
  assert.throws(() => loadRelease(dir2), /not in the manifest/)
})

test('a partial release states how many documented selections are represented and absent, and an inconsistent statement is refused', () => {
  const dir = writeRelease('represented', [batch('KC', [record(1, 'KC', 'Fixture Release One')], false)], { documentedSelections: 612 })
  const rel = loadRelease(dir)
  assert.deepEqual([rel.manifest.coverage.documented_selections, rel.manifest.coverage.represented_selections, rel.manifest.coverage.absent_selections], [612, 1, 611])
  assert.match(rel.manifest.coverage.interpretation, /not an unsigned player or a failed outcome/)
  assert.match(rel.manifest.coverage.representation, /not a representative sample/)
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  // Every tampered or invalid shape is refused, each for its own reason.
  const tamper = (name, change, pattern) => {
    const dir = writeRelease(`represented-${name}`, [batch('KC', [record(1, 'KC', 'Fixture Release One')], false)], { documentedSelections: 612, mutate: (m) => { change(m.coverage); return m } })
    assert.ok(verifyReleaseContent(loadRelease(dir), { root }).some((p) => pattern.test(p)), name)
  }
  tamper('absent', (c) => { c.absent_selections = 5 }, /absent selections/)
  tamper('represented', (c) => { c.represented_selections = 2; c.absent_selections = 610 }, /represented selections but the release has 1/)
  tamper('represented-high', (c) => { c.represented_selections = 700; c.absent_selections = -88 }, /whole numbers/)
  tamper('documented-below', (c) => { c.documented_selections = 0; c.absent_selections = -1 }, /whole numbers/)
  tamper('documented-below-ok', (c) => { c.documented_selections = 0; c.represented_selections = 1; c.absent_selections = 0 }, /represents 1 selections of a documented 0/)
  tamper('fractional', (c) => { c.documented_selections = 612.5 }, /whole numbers/)
  tamper('string', (c) => { c.represented_selections = '1' }, /whole numbers/)
  tamper('null', (c) => { c.absent_selections = null }, /whole numbers/)
  tamper('missing', (c) => { delete c.absent_selections }, /whole numbers/)
  tamper('nan', (c) => { c.documented_selections = NaN }, /whole numbers/)
})

test('scope and content: another draft, a complete-census claim, signing data, ids without provenance or corroboration are refused', () => {
  const bad = (docMutation, re) => {
    const doc = batch('KC', [record(1, 'KC', 'Fixture Scope One')], false); docMutation(doc)
    const problems = verifyReleaseContent(loadRelease(writeRelease(`scope-${Math.random().toString(36).slice(2)}`, [doc])), { root })
    assert.ok(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems)}`)
  }
  bad((d) => { d.records[0].draft_key = '2019-JUNE_AMATEUR'; d.coverage_claims[0].scope_key = '2019-JUNE_AMATEUR' }, /outside the authorised 2020-JUNE_AMATEUR/)
  bad((d) => { d.coverage_claims[0].coverage_state = 'COMPLETE_CENSUS' }, /PARTIAL_RECONSTRUCTION only/)
  bad((d) => { d.records[0].signing = { status: 'SIGNED', bonus_usd: 1000, source_key: WIKI } }, /carry a signing status, date or bonus/)
  bad((d) => { d.records[0].signing = { status: 'UNKNOWN', bonus_usd: 5 } }, /carry a signing status, date or bonus/)
  bad((d) => { d.records[0].player.external_ids = { MLBAM: '999001' } }, /ids with no provenance/)
  bad((d) => { d.records[0].player.external_ids = { MLBAM: '999001' }; d.records[0].player.external_id_sources = { MLBAM: WIKI } }, /without the recorded Wikidata corroboration/)
  bad((d) => { d.sources[0].url = 'https://statsapi.mlb.com/api/v1/draft/2020' }, /mlb-statsapi-draft|publish_site|claims to be/)
  bad((d) => { d.sources = [] }, /no declared sources/)
  const two = writeRelease('dup', [batch('KC', [record(1, 'KC', 'Fixture Dup A')], false), batch('LAD', [record(1, 'LAD', 'Fixture Dup B')], false)])
  assert.ok(verifyReleaseContent(loadRelease(two), { root }).some((p) => /more than one batch/.test(p)))
  const over = writeRelease('over', [batch('KC', [record(1, 'KC', 'Fixture Over A')], false)], { mutate: (m) => { m.authorization_scope.max_selections = 0; return m } })
  assert.ok(verifyReleaseContent(loadRelease(over), { root }).some((p) => /exceed the authorised maximum/.test(p)))
  const approvals = writeRelease('appr', [batch('KC', [record(1, 'KC', 'Fixture Appr A')], false)], { approvals: [{ pick: 1, code: 'X', approved_by: 'agent:bot', approved_on: '2026-10-22', note: 'n' }] })
  assert.ok(verifyReleaseContent(loadRelease(approvals), { root }).some((p) => /human approved_by/.test(p)))
})

test('collisions are classified read-only: same-name players, identifier overlap, existing selections, staged batches', async () => {
  await db.query(`insert into players (slug, full_name, display_name, birth_date) values ('fixture-existing-name', 'Fixture Collide Name', 'Fixture Collide Name', null), ('fixture-existing-id', 'Fixture Other Name', 'Fixture Other Name', null)`)
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-existing-id'), 'MLBAM', '900001')`)
  const dir = writeRelease('collide', [
    batch('KC', [record(10, 'KC', 'Fixture Collide Name'), record(11, 'KC', 'Fixture Fresh Name')], true),
    batch('LAD', [record(12, 'LAD', 'Fixture Id Holder', { ids: { MLBAM: '900001' } }), record(13, 'LAD', 'Fixture Id Conflict', { ids: { MLBAM: '900002' } })], true)
  ])
  const rel = loadRelease(dir)
  const before = await count('select count(*) n from players')
  const rep = await collisionReport(db, rel)
  assert.equal(await count('select count(*) n from players'), before, 'a preview writes nothing')
  const by = Object.fromEntries(rep.entries.map((e) => [e.pick, e]))
  assert.equal(by[10].classification, 'HUMAN_REVIEW')   // same name, no identifier: the importer would hold it
  assert.ok(by[10].checks.some((c) => c.code === 'SAME_NAME_PLAYER'))
  assert.equal(by[11].classification, 'SAFE')
  assert.equal(by[12].classification, 'HUMAN_REVIEW')   // an identifier belongs to an existing player
  assert.ok(by[12].checks.some((c) => c.code === 'WOULD_LINK_EXISTING_PLAYER'))
  assert.equal(by[13].classification, 'SAFE')
  assert.equal(rep.overall, 'HUMAN_REVIEW')
  await assert.rejects(applyRelease(db, rel, { operator: 'fixture operator' }), /collision report is HUMAN_REVIEW/)
  assert.equal(await selCount(), 0, 'nothing was written')
  // A human approval recorded in the manifest clears exactly that pick and code; it never clears a BLOCKED one.
  const approved = writeRelease('collide-approved', [batch('KC', [record(11, 'KC', 'Fixture Fresh Name')], true), batch('LAD', [record(12, 'LAD', 'Fixture Id Holder', { ids: { MLBAM: '900001' } })], true)],
    { approvals: [{ pick: 12, code: 'WOULD_LINK_EXISTING_PLAYER', approved_by: 'Fixture Owner', approved_on: '2026-10-22', note: 'fixture: same person' }] })
  assert.equal((await collisionReport(db, loadRelease(approved))).overall, 'SAFE')
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-existing-id'), 'BBREF', 'fixtuo01')`)
  const conflict = writeRelease('collide-conflict', [batch('LAD', [record(14, 'LAD', 'Fixture Id Holder', { ids: { MLBAM: '900001', BBREF: 'different01' } })], true)],
    { approvals: [{ pick: 14, code: 'WOULD_LINK_EXISTING_PLAYER', approved_by: 'Fixture Owner', approved_on: '2026-10-22', note: 'fixture' }] })
  const cr = await collisionReport(db, loadRelease(conflict))
  assert.equal(cr.overall, 'BLOCKED')
  assert.ok(cr.entries[0].checks.some((c) => c.code === 'IDENTIFIER_CONFLICT'))
})

test('a clean release applies in one transaction, writes its audit, adds no signings, and replays idempotently', async () => {
  const dir = writeRelease('clean', [batch('KC', [record(21, 'KC', 'Fixture Clean One'), record(22, 'KC', 'Fixture Clean Two', { ids: { MLBAM: '910001' } })], true), batch('LAD', [record(23, 'LAD', 'Fixture Clean Three')], true)])
  const rel = loadRelease(dir)
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const signingsBefore = await count('select count(*) n from draft_signings')
  const out = await applyRelease(db, rel, { operator: 'Fixture Owner' })
  assert.equal(out.already, false)
  assert.deepEqual(out.counts, { selections: 3, imported: 3, skipped: 0, held: 0, held_in_manifest: 0 })
  assert.equal(await selCount(), 3)
  assert.equal(await count('select count(*) n from draft_signings'), signingsBefore)
  const audit = await h.one(db, `select operator, counts, jsonb_array_length(entries) n from ingest.release_audits where release_key = 'fixture-clean'`)
  assert.equal(audit.operator, 'Fixture Owner'); assert.equal(Number(audit.n), 3)
  // Exact provenance: the identifier cites Chadwick; the corroboration is an observation citing the Wikidata source.
  const idsrc = await h.one(db, `select s.source_key from player_external_ids e join sources s on s.id = e.source_id where e.external_id = '910001'`)
  assert.equal(idsrc.source_key, CW)
  assert.equal(await count(`select count(*) n from source_observations o join sources s on s.id = o.source_id where s.source_key = $1 and o.field_name = 'wikidata_item'`, [WD]), 1)
  const players = await count('select count(*) n from players')
  const again = await applyRelease(db, rel, { operator: 'Fixture Owner' })
  assert.equal(again.already, true)
  assert.equal(await count('select count(*) n from players'), players)
  assert.equal(await selCount(), 3)
  // Replaying through the collision report is SAFE too, and a second manifest cannot take its picks.
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const clash = writeRelease('clean-clash', [batch('KC', [record(21, 'KC', 'Fixture Someone Else')], false)])
  assert.equal((await collisionReport(db, loadRelease(clash))).overall, 'BLOCKED')
})

test('a failure in a later batch rolls back every batch of the release', async () => {
  const good = batch('KC', [record(31, 'KC', 'Fixture Rollback One')], false)
  const bad = batch('LAD', [record(32, 'LAD', 'Fixture Rollback Two')], false)
  bad.records[0].round_code = 'not-a-round'   // validation fails inside the transaction, after the first batch applied
  const dir = writeRelease('rollback', [good, bad])
  const rel = loadRelease(dir)
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const players = await count('select count(*) n from players')
  const staged = await count('select count(*) n from ingest.import_batches')
  await assert.rejects(applyRelease(db, rel, { operator: 'Fixture Owner' }), /validation failed|invalid/)
  assert.equal(await count(`select count(*) n from draft_selections where overall_pick in (31, 32)`), 0)
  assert.equal(await count('select count(*) n from players'), players)
  assert.equal(await count('select count(*) n from ingest.import_batches'), staged, 'staging rolled back too')
  assert.equal(await count(`select count(*) n from ingest.release_audits where release_key = 'fixture-rollback'`), 0)
  // The connection is healthy afterwards: a fixed release applies.
  bad.records[0].round_code = '1'
  const fixed = writeRelease('rollback-fixed', [batch('KC', [record(31, 'KC', 'Fixture Rollback One')], false), batch('LAD', [record(32, 'LAD', 'Fixture Rollback Two')], false)])
  assert.equal((await applyRelease(db, loadRelease(fixed), { operator: 'Fixture Owner' })).counts.imported, 2)
})

test('the target must have exactly the committed migrations, and an agent cannot apply', async () => {
  const dir = writeRelease('migrations', [batch('KC', [record(41, 'KC', 'Fixture Migration One')], false)])
  const rel = loadRelease(dir)
  await assert.rejects(applyRelease(db, rel, { operator: 'agent:importer' }), /not agent/)
  const original = await h.one(db, `select checksum from bai_meta.schema_migrations where version = '026'`)
  await db.query(`update bai_meta.schema_migrations set checksum = repeat('0', 64) where version = '026'`)
  try {
    await assert.rejects(applyRelease(db, rel, { operator: 'Fixture Owner' }), /differs from the committed file/)
    assert.ok((await collisionReport(db, rel)).target.migrations[0].includes('differs'))
  } finally { await db.query('update bai_meta.schema_migrations set checksum = $1 where version = $2', [original.checksum, '026']) }
})

// A supplemental release (Phase 10.6): picks an earlier release held for a human decision, linked to EXISTING players only.
const PARENT = 'c'.repeat(64)
const approval = (pick) => ({ pick, code: 'WOULD_LINK_EXISTING_PLAYER', approved_by: 'Fixture Owner', approved_on: '2026-10-22', note: 'fixture: owner approved this link' })
const snapshot = async (table) => new Set((await db.query(`select to_jsonb(x)::text j from ${table} x`)).rows.map((r) => r.j))

test('a supplemental release links two approved picks to existing players: no new player, no signing, existing rows untouched, replay idempotent', async () => {
  await db.query(`insert into players (slug, full_name, display_name, birth_date) values ('fixture-supp-a', 'Fixture Supp Alpha', 'Fixture Supp Alpha', null), ('fixture-supp-b', 'Fixture Supp Beta', 'Fixture Supp Beta', null)`)
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-supp-a'), 'MLBAM', '930001'), ((select id from players where slug = 'fixture-supp-b'), 'MLBAM', '930002')`)
  const docs = () => [batch('KC', [record(61, 'KC', 'Fixture Supp Alpha', { ids: { MLBAM: '930001' } })], true), batch('LAD', [record(62, 'LAD', 'Fixture Supp Beta', { ids: { MLBAM: '930002' } })], true)]
  const supplementOf = { manifest_sha256: PARENT, note: 'fixture parent' }
  // Without the owner's approval the collision report holds both picks and apply refuses.
  const unapproved = loadRelease(writeRelease('supp-unapproved', docs(), { supplementOf }))
  assert.equal((await collisionReport(db, unapproved)).overall, 'HUMAN_REVIEW')
  await assert.rejects(applyRelease(db, unapproved, { operator: 'Fixture Owner' }), /collision report is HUMAN_REVIEW/)
  assert.equal(await count('select count(*) n from draft_selections where overall_pick in (61, 62)'), 0)
  const rel = loadRelease(writeRelease('supp', docs(), { approvals: [approval(61), approval(62)], supplementOf }))
  assert.equal(rel.manifest.supplement_of.manifest_sha256, PARENT)
  assert.equal(rel.manifest.expected_database_changes.players_created_max, 0)
  assert.equal(rel.manifest.expected_database_changes.draft_signings_inserted, 0)
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const players = await snapshot('players'); const sels = await snapshot('draft_selections'); const signings = await count('select count(*) n from draft_signings')
  const out = await applyRelease(db, rel, { operator: 'Fixture Owner' })
  assert.deepEqual(out.counts, { selections: 2, imported: 2, skipped: 0, held: 0, held_in_manifest: 0 })
  const linked = (await db.query(`select s.overall_pick, p.slug from draft_selections s join players p on p.id = s.player_id where s.overall_pick in (61, 62) order by 1`)).rows
  assert.deepEqual(linked.map((r) => r.slug), ['fixture-supp-a', 'fixture-supp-b'])
  const playersAfter = await snapshot('players'); const selsAfter = await snapshot('draft_selections')
  assert.equal(playersAfter.size, players.size, 'no player row was created')
  assert.ok([...players].every((j) => playersAfter.has(j)), 'no existing player row changed')
  assert.ok([...sels].every((j) => selsAfter.has(j)), 'no existing selection changed')
  assert.equal(selsAfter.size, sels.size + 2)
  assert.equal(await count('select count(*) n from draft_signings'), signings, 'no signing row')
  assert.equal(await count(`select count(*) n from players where slug like 'fixture-supp-%'`), 2, 'no duplicate player')
  // Replay is idempotent.
  const after = await count('select count(*) n from draft_selections')
  assert.equal((await applyRelease(db, rel, { operator: 'Fixture Owner' })).already, true)
  assert.equal(await count('select count(*) n from draft_selections'), after)
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
})

test('a supplemental release that would create a player is refused and rolls back completely', async () => {
  const supplementOf = { manifest_sha256: PARENT, note: 'fixture parent' }
  const rel = loadRelease(writeRelease('supp-new-player', [batch('KC', [record(71, 'KC', 'Fixture Supp Brand New')], false)], { supplementOf }))
  assert.equal(rel.manifest.expected_database_changes.players_created_max, 0)
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')   // nothing collides; only the zero-new-players promise is broken
  const players = await count('select count(*) n from players'); const staged = await count('select count(*) n from ingest.import_batches')
  await assert.rejects(applyRelease(db, rel, { operator: 'Fixture Owner' }), /player\(s\) created; the manifest allows 0/)
  assert.equal(await count('select count(*) n from players'), players)
  assert.equal(await count('select count(*) n from draft_selections where overall_pick = 71'), 0)
  assert.equal(await count('select count(*) n from ingest.import_batches'), staged, 'staging rolled back too')
  assert.equal(await count(`select count(*) n from ingest.release_audits where release_key = 'fixture-supp-new-player'`), 0)
})

// --- source-observation accounting and the transactional guards (Phase 11.4) ---------------------------------------------------
const obsCount = () => count('select count(*) n from source_observations')
const withSource = (b, key) => JSON.parse(JSON.stringify(b).replaceAll(WIKI, key))

test('the observation maximum is derived from the importer\'s fields: verified, name-only and mixed populations are exact, and every declared maximum holds', async () => {
  const verified = record(81, 'KC', 'Fixture Acct Verified', { ids: { MLBAM: '940001' }, birth: '1999-01-01', position: 'RHP', roundPick: 11 })
  const nameOnly = record(82, 'KC', 'Fixture Acct Name Only')
  // Verified: player name + birth date (2), selection round, club, round pick, position (4), one evidence entry (1). Name-only: name (1) + round, club (2).
  assert.equal(observationMax([verified]), 7)
  assert.equal(observationMax([nameOnly]), 3)
  assert.equal(observationMax([verified, nameOnly]), 10)
  // A record with both a birth date and a country is bounded by the larger of the new-player and linked-player paths (4 vs 3).
  assert.equal(observationMax([record(83, 'KC', 'Fixture Acct Both', { birth: '1999-01-01', birthCountry: 'USA' })]), 4 + 2)
  for (const [name, recs, exact] of [['verified', [verified], 7], ['name-only', [nameOnly], 3], ['mixed', [record(84, 'LAD', 'Fixture Acct Mixed One', { ids: { MLBAM: '940004' }, birth: '2000-02-02' }), record(85, 'LAD', 'Fixture Acct Mixed Two')], 5 + 3]]) {
    const dir = writeRelease(`acct-${name}`, [batch(recs[0].organization, recs, true)])
    const rel = loadRelease(dir)
    const e = rel.manifest.expected_database_changes
    const before = { obs: await obsCount(), ids: await count('select count(*) n from player_external_ids'), src: await count('select count(*) n from sources'), players: await count('select count(*) n from players') }
    await applyRelease(db, rel, { operator: 'Fixture Owner' })
    assert.equal(await obsCount() - before.obs, exact, `${name}: observations inserted`)
    assert.equal(e.source_observations_inserted_max, exact, `${name}: the manifest maximum is exact for new players`)
    assert.ok(await count('select count(*) n from player_external_ids') - before.ids <= e.external_ids_inserted_max)
    assert.ok(await count('select count(*) n from sources') - before.src <= e.sources_inserted_max)
    assert.ok(await count('select count(*) n from players') - before.players <= e.players_created_max)
  }
})

test('an existing-player supplement stays within the observation maximum and creates no player', async () => {
  await db.query(`insert into players (slug, full_name, display_name, birth_date, birth_date_precision) values ('fixture-acct-link-a', 'Fixture Acct Link Alpha', 'Fixture Acct Link Alpha', '1998-04-04', 'DAY'), ('fixture-acct-link-b', 'Fixture Acct Link Beta', 'Fixture Acct Link Beta', '1999-03-03', 'DAY')`)
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-acct-link-a'), 'MLBAM', '940101'), ((select id from players where slug = 'fixture-acct-link-b'), 'MLBAM', '940102')`)
  const docs = [batch('KC', [record(91, 'KC', 'Fixture Acct Link Alpha', { ids: { MLBAM: '940101' }, birth: '1998-04-04' })], true), batch('LAD', [record(92, 'LAD', 'Fixture Acct Link Beta', { ids: { MLBAM: '940102' }, birth: '1999-03-03' })], true)]
  const rel = loadRelease(writeRelease('acct-supp', docs, { approvals: [approval(91), approval(92)], supplementOf: { manifest_sha256: PARENT, note: 'fixture parent' } }))
  const max = rel.manifest.expected_database_changes.source_observations_inserted_max
  assert.equal(max, observationMax(rel.batches.flatMap((b) => b.doc.records)))
  const before = await obsCount(); const players = await count('select count(*) n from players')
  await applyRelease(db, rel, { operator: 'Fixture Owner' })
  const added = await obsCount() - before
  assert.ok(added > 0 && added <= max, `${added} observations within ${max}`)
  assert.equal(await count('select count(*) n from players'), players, 'no player created')
})

test('an understated maximum rolls the whole release back: observations, external ids and sources', async () => {
  const snap = async () => ({ obs: await obsCount(), ids: await count('select count(*) n from player_external_ids'), src: await count('select count(*) n from sources'), players: await count('select count(*) n from players'),
    sel: await count('select count(*) n from draft_selections'), staged: await count('select count(*) n from ingest.import_batches'), audits: await count('select count(*) n from ingest.release_audits') })
  let n = 0
  for (const [key, pattern] of [['source_observations_inserted_max', /source observation\(s\) inserted; the manifest allows/], ['external_ids_inserted_max', /external id\(s\) inserted; the manifest allows 0/], ['sources_inserted_max', /source\(s\) inserted; the manifest allows 0/]]) {
    n++
    const sourceKey = `hist:wikipedia-2020-cap${n}-r1`
    const rec = record(100 + n, 'KC', `Fixture Cap Case ${n}`, { ids: { MLBAM: `95000${n}` }, birth: '1999-05-05' })
    const dir = writeRelease(`cap-${n}`, [withSource(batch('KC', [rec], true), sourceKey)], { mutate: (m) => { m.expected_database_changes[key] = key === 'source_observations_inserted_max' ? m.expected_database_changes[key] - 1 : 0; return m } })
    const rel = loadRelease(dir)
    assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
    const before = await snap()
    await assert.rejects(applyRelease(db, rel, { operator: 'Fixture Owner' }), pattern, key)
    assert.deepEqual(await snap(), before, `${key}: nothing persisted`)
    assert.equal(await count('select count(*) n from draft_selections where overall_pick = $1', [100 + n]), 0)
    assert.equal(await count(`select count(*) n from ingest.release_audits where release_key = $1`, [`fixture-cap-${n}`]), 0)
  }
})

test('a committed release replays without inserting anything, even after its maxima were spent', async () => {
  const rel = loadRelease(writeRelease('replay-acct', [batch('KC', [record(121, 'KC', 'Fixture Replay Acct', { ids: { MLBAM: '960001' }, birth: '1999-06-06' })], true)]))
  await applyRelease(db, rel, { operator: 'Fixture Owner' })
  const before = { obs: await obsCount(), ids: await count('select count(*) n from player_external_ids'), src: await count('select count(*) n from sources'), audits: await count('select count(*) n from ingest.release_audits') }
  const again = await applyRelease(db, rel, { operator: 'Fixture Owner' })
  assert.equal(again.already, true)
  assert.deepEqual({ obs: await obsCount(), ids: await count('select count(*) n from player_external_ids'), src: await count('select count(*) n from sources'), audits: await count('select count(*) n from ingest.release_audits') }, before)
})

test('manifest instructions use the manifest\'s own draft year and key, not 2020', () => {
  const m = buildManifest({ releaseKey: 'fixture-year', year: 2021, draftKey: '2021-JUNE_AMATEUR', batches: [{ file: 'x.json', sha256: 'a'.repeat(64), doc: batch('KC', [{ ...record(1, 'KC', 'Fixture Year'), draft_key: '2021-JUNE_AMATEUR' }], false) }], identity: { picks: [] }, article: { revision: 1, response_sha256: 'a'.repeat(64) }, chadwickCommit: 'f'.repeat(40), identityFileSha256: 'b'.repeat(64), brownVariant: 'NOT_IN_THIS_RELEASE', heldPicks: [], humanApprovals: [], catalog, maxSelections: 1, createdOn: '2026-10-24' })
  const text = JSON.stringify([m.verification_plan, m.rollback_plan])
  assert.match(text, /2021 class as partial/)
  assert.match(text, /draft 2021-JUNE_AMATEUR/)
  assert.doesNotMatch(text, /2020/)
})

// --- historical compatibility, pinned by checksum (Phase 11.4A) ---------------------------------------------------------------------
// A fixture release whose declared observation maximum is understated by one, as the three historical manifests were.
const understated = (name, picks, { approvals = [], supplementOf = null } = {}) => {
  const docs = () => [batch('KC', picks, true)]
  const exactDir = writeRelease(`${name}-probe`, docs(), { approvals, supplementOf })
  const exact = loadRelease(exactDir).manifest.expected_database_changes.source_observations_inserted_max
  const dir = writeRelease(name, docs(), { approvals, supplementOf, mutate: (m) => { m.expected_database_changes.source_observations_inserted_max = exact - 1; return m } })
  return { rel: loadRelease(dir), declared: exact - 1, exact }
}
const state = async () => ({ obs: await obsCount(), ids: await count('select count(*) n from player_external_ids'), players: await count('select count(*) n from players'), sel: await count('select count(*) n from draft_selections'), audits: await count('select count(*) n from ingest.release_audits'), staged: await count('select count(*) n from ingest.import_batches') })

test('the historical allowances pin exactly the three applied manifests, by checksum and declared maximum', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(HISTORICAL_OBSERVATION_ALLOWANCES).map(([sha, p]) => [sha.slice(0, 8), [p.declared_max, p.allowed]])), { d3bdbdac: [692, 959], '7d9130bc': [12, 12], '4987ca6b': [963, 1342] })
  assert.ok(Object.isFrozen(HISTORICAL_OBSERVATION_ALLOWANCES) && Object.values(HISTORICAL_OBSERVATION_ALLOWANCES).every(Object.isFrozen))
})

test('a checksum-pinned historical manifest may spend its pinned observation count; a new manifest with the same understatement is refused', async () => {
  const pinned = understated('hist-pinned', [record(131, 'KC', 'Fixture Hist One', { ids: { MLBAM: '970001' }, birth: '1999-07-07' })])
  const allowances = { [pinned.rel.manifest.manifest_sha256]: { declared_max: pinned.declared, allowed: pinned.exact, release: 'fixture historical release' } }
  assert.deepEqual(observationLimit(pinned.rel.manifest, allowances), { limit: pinned.exact, basis: 'historical allowance for the fixture historical release' })
  assert.equal(observationLimit(pinned.rel.manifest).limit, pinned.declared, 'the real table does not know this manifest')
  // Without the pin the same understated manifest rolls back, writing nothing.
  const before = await state()
  await assert.rejects(applyRelease(db, pinned.rel, { operator: 'Fixture Owner' }), /source observation\(s\) inserted; the manifest allows/)
  assert.deepEqual(await state(), before)
  // With the pin it commits, spends exactly the pinned count, and replays idempotently.
  const obs0 = await obsCount()
  const out = await applyRelease(db, pinned.rel, { operator: 'Fixture Owner', historicalAllowances: allowances })
  assert.equal(out.already, false)
  assert.equal(await obsCount() - obs0, pinned.exact)
  assert.match(out.observation_limit.basis, /historical allowance/)
  const after = await state()
  assert.equal((await applyRelease(db, pinned.rel, { operator: 'Fixture Owner', historicalAllowances: allowances })).already, true)
  assert.deepEqual(await state(), after)
})

test('a forged, altered or unrelated manifest cannot use a historical allowance, and a pin relaxes nothing but observations', async () => {
  const base = understated('hist-forge-base', [record(141, 'KC', 'Fixture Forge One', { ids: { MLBAM: '970101' }, birth: '1999-08-08' })])
  const allowances = { [base.rel.manifest.manifest_sha256]: { declared_max: base.declared, allowed: base.exact, release: 'fixture historical release' } }
  // 1. Same understatement, different content (a different pick): another checksum, so no pin applies.
  const other = understated('hist-forge-other', [record(142, 'KC', 'Fixture Forge Other', { ids: { MLBAM: '970102' }, birth: '1999-08-08' })])
  assert.notEqual(other.rel.manifest.manifest_sha256, base.rel.manifest.manifest_sha256)
  assert.equal(observationLimit(other.rel.manifest, allowances).limit, other.declared)
  // 2. A manifest that copies the pinned checksum but changes content: its own checksum no longer matches, so the pin is ignored.
  const forged = structuredClone(base.rel); forged.manifest.totals.selections += 1
  assert.equal(observationLimit(forged.manifest, allowances).limit, base.declared)
  // 3. Self-declared compatibility fields are inert.
  const claims = structuredClone(base.rel.manifest); Object.assign(claims, { legacy: true, version: 'historical', release_class: 'HISTORICAL', operator: 'Sean T. Cannon' }); claims.expected_database_changes.legacy_allowance = 99999
  const claimsPinned = { [claims.manifest_sha256]: { declared_max: base.declared, allowed: base.exact, release: 'x' } }
  assert.equal(observationLimit(claims, claimsPinned).limit, base.declared)
  // 4. A pinned checksum with a different declared maximum is ignored.
  const wrongDeclared = { [base.rel.manifest.manifest_sha256]: { declared_max: base.declared + 5, allowed: base.exact, release: 'x' } }
  assert.equal(observationLimit(base.rel.manifest, wrongDeclared).limit, base.declared)
  // 5. A loaded manifest edited on disk is refused outright; an in-memory forgery and an unrelated understated manifest fail without writes.
  const before = await state()
  await assert.rejects(applyRelease(db, forged, { operator: 'Fixture Owner', historicalAllowances: allowances }), /source observation\(s\) inserted; the manifest allows/)
  await assert.rejects(applyRelease(db, other.rel, { operator: 'Fixture Owner', historicalAllowances: allowances }), /source observation\(s\) inserted; the manifest allows/)
  assert.deepEqual(await state(), before)
  assert.equal(await count('select count(*) n from draft_selections where overall_pick in (141, 142)'), 0)
  // 6. The pin covers observations only: the same pinned manifest with an understated PLAYER maximum still rolls back.
  const players = understated('hist-pin-players', [record(143, 'KC', 'Fixture Pin Players', { ids: { MLBAM: '970103' }, birth: '1999-08-08' })])
  const tampered = loadRelease(writeRelease('hist-pin-players-t', [batch('KC', [record(143, 'KC', 'Fixture Pin Players', { ids: { MLBAM: '970103' }, birth: '1999-08-08' })], true)], { mutate: (m) => { m.expected_database_changes.source_observations_inserted_max = players.declared; m.expected_database_changes.players_created_max = 0; return m } }))
  const pins = { [tampered.manifest.manifest_sha256]: { declared_max: players.declared, allowed: players.exact, release: 'fixture' } }
  await assert.rejects(applyRelease(db, tampered, { operator: 'Fixture Owner', historicalAllowances: pins }), /player\(s\) created; the manifest allows 0/)
  assert.deepEqual(await state(), before)
})

// The real, immutable manifests are local-only (gitignored); this replay runs where they exist and is skipped elsewhere.
const HIST = path.join(root, '.local/history')
const REAL = [['2020/release/final-brown-name-only', 959], ['2020/release/supplement-52-106', 12], ['2021/release/partial-205', 1342]].map(([d, n]) => [path.join(HIST, d), n])
test('the three immutable historical manifests replay in order on a clean database, spend their verified observation counts, and replay idempotently', { skip: REAL.some(([d]) => !fs.existsSync(path.join(d, 'release-manifest.json'))) && 'the local historical release directories are not present' }, async () => {
  const clean = await h.freshDatabase()
  const q = async (s, p) => Number((await h.one(clean, s, p)).n)
  const rels = REAL.map(([d]) => loadRelease(d))
  assert.deepEqual(rels.map((r) => r.manifest.manifest_sha256), Object.keys(HISTORICAL_OBSERVATION_ALLOWANCES))
  // Baseline: the supplement links two players that existed before the 2020 draft. They are rebuilt from the supplement's own records
  // (identifiers and birth dates), so nothing per-player is stored in the repository.
  const supp = rels[1].batches.flatMap((b) => b.doc.records)
  for (const [i, r] of supp.entries()) {
    const p = r.player
    const { rows: [pl] } = await clean.query(`insert into players (slug, full_name, display_name, birth_date, birth_date_precision) values ($1, $2, $2, $3, 'DAY') returning id`, [`baseline-${i}`, p.full_name, p.birth_date])
    for (const [system, value] of Object.entries(p.external_ids ?? {})) await clean.query('insert into player_external_ids (player_id, id_system, external_id) values ($1, $2, $3)', [pl.id, system, value])
  }
  const deltas = []
  for (const [i, rel] of rels.entries()) {
    const before = await q('select count(*) n from source_observations')
    const out = await applyRelease(clean, rel, { operator: 'Fixture Owner' })
    assert.equal(out.already, false, rel.manifest.release_key)
    deltas.push(await q('select count(*) n from source_observations') - before)
    assert.match(out.observation_limit.basis, /historical allowance/)
    assert.ok(deltas[i] <= observationLimit(rel.manifest).limit)
  }
  assert.deepEqual(deltas, REAL.map(([, n]) => n))
  assert.equal(await q('select count(*) n from ingest.release_audits'), 3)
  assert.equal(await q('select count(*) n from draft_signings'), 0)
  // Already applied: replays write nothing.
  const snap = [await q('select count(*) n from source_observations'), await q('select count(*) n from draft_selections'), await q('select count(*) n from ingest.release_audits')]
  for (const rel of rels) assert.equal((await applyRelease(clean, rel, { operator: 'Fixture Owner' })).already, true)
  assert.deepEqual([await q('select count(*) n from source_observations'), await q('select count(*) n from draft_selections'), await q('select count(*) n from ingest.release_audits')], snap)
  // The original manifests are untouched on disk.
  assert.deepEqual(REAL.map(([d]) => fs.readFileSync(path.join(d, 'release-manifest.sha256'), 'utf8').split(/\s+/)[0]), Object.keys(HISTORICAL_OBSERVATION_ALLOWANCES))
})

// --- existing players with an unknown birth date (issue #25) ----------------------------------------------------------------------
test('a supplemental release links an existing player with an unknown birth date: date and precision set together, no duplicate, limits kept, replay idempotent', async () => {
  await db.query(`insert into players (slug, full_name, display_name) values ('fixture-nobirth-a', 'Fixture Nobirth Alpha', 'Fixture Nobirth Alpha')`)
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-nobirth-a'), 'MLBAM', '980001')`)
  const rel = loadRelease(writeRelease('nobirth-supp', [batch('KC', [record(151, 'KC', 'Fixture Nobirth Alpha', { ids: { MLBAM: '980001' }, birth: '1999-09-09' })], true)],
    { approvals: [approval(151)], supplementOf: { manifest_sha256: PARENT, note: 'fixture parent' } }))
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const players = await count('select count(*) n from players'); const obs0 = await obsCount()
  const out = await applyRelease(db, rel, { operator: 'Fixture Owner' })
  assert.equal(out.counts.imported, 1)
  assert.deepEqual(await h.one(db, `select birth_date::text d, birth_date_precision p from players where slug = 'fixture-nobirth-a'`), { d: '1999-09-09', p: 'DAY' })
  assert.equal(await count('select count(*) n from players'), players, 'no duplicate player')
  assert.equal(await count(`select count(*) n from draft_selections s join players p on p.id = s.player_id where s.overall_pick = 151 and p.slug = 'fixture-nobirth-a'`), 1)
  const added = await obsCount() - obs0
  assert.ok(added > 0 && added <= rel.manifest.expected_database_changes.source_observations_inserted_max, `${added} observations within the declared maximum`)
  const after = await state()
  assert.equal((await applyRelease(db, rel, { operator: 'Fixture Owner' })).already, true)
  assert.deepEqual(await state(), after)
})

test('a later failure rolls back the birth-date update, selections, observations, staging and audit of an earlier batch', async () => {
  await db.query(`insert into players (slug, full_name, display_name) values ('fixture-nobirth-b', 'Fixture Nobirth Beta', 'Fixture Nobirth Beta')`)
  await db.query(`insert into player_external_ids (player_id, id_system, external_id) values ((select id from players where slug = 'fixture-nobirth-b'), 'MLBAM', '980002')`)
  const good = batch('KC', [record(161, 'KC', 'Fixture Nobirth Beta', { ids: { MLBAM: '980002' }, birth: '1999-10-10' })], true)
  const bad = batch('LAD', [record(162, 'LAD', 'Fixture Nobirth Bad')], false)
  bad.records[0].round_code = 'not-a-round'
  const rel = loadRelease(writeRelease('nobirth-rollback', [good, bad], { approvals: [approval(161)] }))
  assert.equal((await collisionReport(db, rel)).overall, 'SAFE')
  const before = await state()
  const player = await h.one(db, `select birth_date::text d, birth_date_precision p from players where slug = 'fixture-nobirth-b'`)
  await assert.rejects(applyRelease(db, rel, { operator: 'Fixture Owner' }), /validation failed|invalid/)
  assert.deepEqual(await state(), before, 'selections, players, observations, external ids, staging and audits are all unchanged')
  assert.deepEqual(await h.one(db, `select birth_date::text d, birth_date_precision p from players where slug = 'fixture-nobirth-b'`), player)
  assert.equal(await count('select count(*) n from draft_selections where overall_pick in (161, 162)'), 0)
})
