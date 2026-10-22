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
import { buildManifest, loadRelease, verifyReleaseContent, collisionReport, applyRelease, canonicalJson, manifestChecksum, fileSha256 } from '../../scripts/history/lib/release.mjs'

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
const record = (pick, org, name, { ids = null } = {}) => ({
  type: 'DRAFT_SELECTION', source_key: WIKI, draft_key: '2020-JUNE_AMATEUR', round_code: '1', overall_pick: pick, round_pick: null, organization: org, selection_type: 'STANDARD',
  player: { full_name: name, source_key: WIKI, ...(ids ? { external_ids: ids, external_id_sources: Object.fromEntries(Object.keys(ids).map((k) => [k, CW])) } : {}) },
  ...(ids ? { evidence: [{ subject: 'player', field: 'wikidata_item', value: 'Q1', source_key: WD }] } : {}),
  signing: { status: 'UNKNOWN' }, notes: 'fixture'
})
let tag = 0
const batch = (org, records, verified) => ({
  format: 'bai-research-import/1', batch_key: `hist-2020-june-amateur-${org.toLowerCase()}-fixture-${++tag}`, channel: 'DRAFT', description: `${org} fixture`,
  coverage_claims: [{ domain: 'DRAFT', scope_key: '2020-JUNE_AMATEUR', organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: WIKI, gap_notes: 'fixture: one list' }],
  sources: sources(verified), records
})
const writeRelease = (name, docs, { approvals = [], mutate = null } = {}) => {
  const dir = path.join(tmp, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'batches'), { recursive: true })
  const batches = docs.map((doc, i) => { const file = `${String(i).padStart(2, '0')}-${doc.batch_key}.json`; fs.writeFileSync(path.join(dir, 'batches', file), JSON.stringify(doc, null, 1) + '\n'); return { file, sha256: fileSha256(path.join(dir, 'batches', file)), doc } })
  let manifest = buildManifest({ releaseKey: `fixture-${name}`, year: 2020, draftKey: '2020-JUNE_AMATEUR', batches, identity: { picks: [] }, article: { revision: 1, response_sha256: 'a'.repeat(64) }, chadwickCommit: 'f'.repeat(40),
    identityFileSha256: 'b'.repeat(64), brownVariant: 'HELD', heldPicks: [], humanApprovals: approvals, catalog, maxSelections: docs.reduce((n, d) => n + d.records.length, 0), createdOn: '2026-10-22' })
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
