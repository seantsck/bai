// The public display release (migration 032). Every row below is FICTIONAL (years 2030-2031, MLBAM 9880xx). A Retrosheet import stays invisible to public roles until a release
// names its exact batches, and a withdrawal, of the release or its grant, restores the public state in the same transaction, cached summaries included, with no refresh.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import { prepareAcquisitionDoc } from '../../scripts/research/lib/acquisitions.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-gate-'))
let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const RETRO = { source_key: 'hist:retrosheet-gate000001', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (tranDB.zip)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tranDB.zip', retrieved_date: '2026-10-22' }
const RETRO2 = { ...RETRO, source_key: 'hist:retrosheet-gate000002' }
const CHADWICK = { source_key: 'hist:chadwick-register-abc1234', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Chadwick register, fixture commit', publisher: 'Chadwick Baseball Bureau', url: 'https://github.com/chadwickbureau/register/tree/abc1234', retrieved_date: '2026-10-22' }

const rec = (src, n, date, player) => ({ type: 'ACQUISITION', schema: 1, ref: `g-${n}`, organization: 'LAD', acquisition_class: 'FREE_AGENT', transaction_type: 'FREE_AGENT_SIGNING', date, date_precision: 'DAY', source_key: src.source_key,
  sources: [{ source_key: src.source_key, role: 'REFERENCE', independence_group: 'retrosheet-archive', locator: `line ${n}` }], external_ids: [{ scheme: 'RETROSHEET_TXN', id: `g${n}@${date}`, source_key: src.source_key }],
  move: { player: { full_name: `Gate Player ${n}`, source_key: src.source_key, external_ids: { MLBAM: String(988000 + n), RETROSHEET: `gatep${String(n).padStart(3, '0')}` }, external_id_sources: { MLBAM: CHADWICK.source_key, RETROSHEET: CHADWICK.source_key }, birth_date: '1990-05-17', ...player }, to_organization: 'LAD', source_event_code: 'F', source_info: null } })
let nFile = 0
async function load (key, sources, records) {
  const f = path.join(dir, `b-${++nFile}.json`); fs.writeFileSync(f, JSON.stringify(prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: key, channel: 'ACQUISITIONS', sources, records })))
  const { batch } = await P.stageFile(db, f, {}); const v = await P.validateBatch(db, batch.id)
  assert.ok(v.ok, key + JSON.stringify((await h.rows(db, "select validation_errors from ingest.staged_records where batch_id = $1 and validation_status = 'INVALID'", [batch.id]))))
  const done = await P.applyBatch(db, batch.id, { write: true })
  return { sha: (await h.one(db, 'select file_sha256 s from ingest.import_batches where id = $1', [batch.id])).s, done }
}

// What a public role can read: every relation, row for row, ignoring only the bookkeeping of a refresh.
async function publicState (role) {
  const rels = await h.rows(db, `select n.nspname s, c.relname r from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'v', 'm', 'p') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast') and has_table_privilege($1, c.oid, 'SELECT') order by 1, 2`, [role])
  const out = {}
  await h.asRole(db, role, async () => { for (const x of rels) {
    const rows = await h.rows(db, `select (to_jsonb(q) - 'generation_id' - 'refreshed_at')::text j from "${x.s}"."${x.r}" q`)
    out[`${x.s}.${x.r}`] = { n: rows.length, h: crypto.createHash('md5').update(rows.map((r) => r.j).sort().join('\n')).digest('hex') }
  } })
  return out
}
const diffs = (a, b) => Object.keys(b).filter((k) => a[k]?.h !== b[k].h)
const refreshes = async () => { await db.query('select public.refresh_read_models()'); await db.query('select public.refresh_transaction_read_models()') }
const grant = () => db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture basis', 'fixture scope') on conflict do nothing")
const release = (sourceKey, shas) => db.query("insert into public.source_display_releases (source_id, attribution_category, approved_batch_sha256, basis_reference) select id, 'RETROSHEET', $2, 'fixture release' from sources where source_key = $1", [sourceKey, shas])
const refused = (p, re) => assert.rejects(p, re)
const pub = (sql) => h.asRole(db, 'anon', async () => h.rows(db, sql))

let baseAnon, baseAuth, shaA, chadwickIdsOnExisting

test('setup: a public baseline, then a Retrosheet import into the HELD default, with the grant already present', async () => {
  await db.query(`insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`, [CHADWICK.source_key, CHADWICK.source_type, CHADWICK.authority_level, CHADWICK.title, CHADWICK.publisher, CHADWICK.url, CHADWICK.retrieved_date])
  await db.query("insert into sources (source_key, source_type, authority_level, title, reference) values ('gate:base', 'REFERENCE_DATABASE', 'OTHER', 'Fixture base', 'fixture') on conflict do nothing")
  await db.query("insert into players (slug, full_name, display_name) values ('gate-existing', 'Gate Existing', 'Gate Existing')")
  await h.nameObservation(db, 'gate-existing', 'gate:base')
  await db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) select id, 'MLBAM', '988100', (select id from sources where source_key = 'gate:base') from players where slug = 'gate-existing'")
  await grant()
  await refreshes()
  baseAnon = await publicState('anon'); baseAuth = await publicState('authenticated')
  const r = await load('gate-a', [RETRO, CHADWICK], [rec(RETRO, 1, '2030-01-10'), rec(RETRO, 2, '2030-01-11'),
    rec(RETRO, 3, '2030-01-12', { full_name: 'Gate Existing', external_ids: { MLBAM: '988100', RETROSHEET: 'gatex001' }, external_id_sources: { MLBAM: CHADWICK.source_key, RETROSHEET: CHADWICK.source_key }, birth_date: undefined })])
  shaA = r.sha
  assert.deepEqual(r.done.report.actions, { INSERT: 3 })
  chadwickIdsOnExisting = (await h.one(db, "select count(*)::int n from player_external_ids e join players p on p.id = e.player_id join sources s on s.id = e.source_id where p.slug = 'gate-existing' and s.source_key = $1", [CHADWICK.source_key])).n
  assert.equal(chadwickIdsOnExisting, 1)
})

const HELD_VISIBLE = ['public.player_external_ids', 'public.v_source_attribution'] // the Chadwick-sourced id added to an existing player, and Chadwick's own count

test('HELD: neither public role sees the import, directly or through a view, and only the Chadwick id on an existing player is new', async () => {
  for (const [role, base] of [['anon', baseAnon], ['authenticated', baseAuth]]) assert.deepEqual(diffs(base, await publicState(role)), HELD_VISIBLE, role)
  assert.deepEqual(await pub("select slug from players where slug like 'gate-player%'"), [])
  assert.deepEqual(await pub("select id from sources where publisher = 'Retrosheet'"), [])
  assert.deepEqual(await pub("select id from source_observations where locator like 'batch gate-a%'"), [])
  assert.deepEqual(await pub("select id from coverage_assessments where domain::text = 'TRANSACTIONS'"), [])
  assert.deepEqual(await pub("select * from v_source_attribution where attribution_category = 'RETROSHEET'"), [])
  const ids = await pub("select e.id_system, s.attribution_category from player_external_ids e join players p on p.id = e.player_id join sources s on s.id = e.source_id where p.slug = 'gate-existing' order by 1")
  assert.deepEqual(ids.map((x) => x.id_system), ['MLBAM', 'RETROSHEET'])
  assert.equal(ids[1].attribution_category, 'CHADWICK_REGISTER')
})

test('HELD: both refreshes publish nothing of it, while the grant exists', async () => {
  await refreshes()
  assert.deepEqual(diffs(baseAnon, await publicState('anon')), HELD_VISIBLE)
  assert.equal((await pub('select count(*)::int n from rm_transactions'))[0].n, 0)
  assert.equal((await h.one(db, 'select count(*)::int n from transactions')).n, 3)
  const o = (await pub('select display_authorized_categories c from rm_transaction_overview'))[0]
  assert.ok(!o.c.includes('RETROSHEET'), 'a category is not listed as displayable while held')
})

test('a release needs the grant, its own category and exactly the applied batches', async () => {
  await refused(release(RETRO.source_key, ['0'.repeat(64)]), /approved lineage/)
  await refused(release(RETRO.source_key, [shaA, '0'.repeat(64)]), /approved lineage/)
  await refused(release(RETRO.source_key, []), /approved lineage/)
  await refused(release(CHADWICK.source_key, [shaA]), /not in category/)
  await db.query("delete from ingest.source_publication_grants")
  await refused(release(RETRO.source_key, [shaA]), /foreign key/)
  await grant()
  assert.equal((await pub('select count(*)::int n from source_display_releases'))[0].n, 0, 'the default is HELD')
})

test('RELEASED: the records become public; the summaries follow only at the next refresh', async () => {
  await release(RETRO.source_key, [shaA])
  assert.equal((await pub("select count(*)::int n from players where slug like 'gate-player%'"))[0].n, 2)
  assert.equal((await pub("select count(*)::int n from coverage_assessments where domain::text = 'TRANSACTIONS'"))[0].n, 1)
  const before = (await pub('select players from rm_overview'))[0].players
  await refreshes()
  assert.equal((await pub('select players from rm_overview'))[0].players, before + 2)
  assert.equal((await pub('select count(*)::int n from rm_transactions'))[0].n, 3)
})

test('a record cannot reach canonical tables from outside the approved lineage while a release is active', async () => {
  const stageOnly = async (key, sources, records) => { const f = path.join(dir, `b-${++nFile}.json`); fs.writeFileSync(f, JSON.stringify(prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: key, channel: 'ACQUISITIONS', sources, records }))); const { batch } = await P.stageFile(db, f, {}); await P.validateBatch(db, batch.id); return batch.id }
  const n = (await h.one(db, 'select count(*)::int n from transactions')).n
  await refused(P.applyBatch(db, await stageOnly('gate-same-source', [RETRO, CHADWICK], [rec(RETRO, 4, '2030-02-01')]), { write: true }), /only an approved batch may write it/)
  await refused(P.applyBatch(db, await stageOnly('gate-new-file', [RETRO2, CHADWICK], [rec(RETRO2, 5, '2030-02-02')]), { write: true }), /outside an active display release|only an approved batch may write it/)   // either guard refuses it
  assert.equal((await h.one(db, 'select count(*)::int n from transactions')).n, n, 'the refused batches rolled back')
})

const stageOnly2 = async (key, sources, records) => { const f = path.join(dir, `b-${++nFile}.json`); fs.writeFileSync(f, JSON.stringify(prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: key, channel: 'ACQUISITIONS', sources, records }))); const { batch } = await P.stageFile(db, f, {}); await P.validateBatch(db, batch.id); return batch.id }
test('direct owner SQL cannot add or change a record that cites a released source; only an apply of an approved batch can', async () => {
  const before = await publicState('anon')
  const retro = (await h.one(db, 'select id from sources where source_key = $1', [RETRO.source_key])).id
  const refusedWrite = (sql, params) => refused(db.query(sql, params), /only an approved batch may write it/)
  await db.query("insert into players (slug, full_name, display_name) values ('gate-direct', 'Gate Direct', 'Gate Direct')")   // a player alone cites no source, and is invisible without an observation
  const pid = (await h.one(db, "select id from players where slug = 'gate-direct'")).id
  await refusedWrite("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator) values ($1, 'players', $2, 'full_name', to_jsonb('Gate Direct'::text), 'owner sql')", [retro, pid])
  await refusedWrite("insert into player_external_ids (player_id, id_system, external_id, source_id) values ($1, 'RETROSHEET', 'gatedirect01', $2)", [pid, retro])
  await refusedWrite("update source_observations set observed_value = to_jsonb('Gate Player 1 (edited)'::text) where source_id = $1 and field_name = 'full_name' and observed_value = to_jsonb('Gate Player 1'::text)", [retro])
  // (the ids of the fixture players cite Chadwick, so seed one citing the released source from inside an approved apply, then try to edit it from outside)
  const approved0 = (await h.one(db, 'select id from ingest.import_batches where file_sha256 = $1 order by id limit 1', [shaA])).id
  await db.query('begin'); await db.query("select set_config('bai.import_batch_id', $1, true)", [String(approved0)])
  await db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) values ($1, 'RETROSHEET', 'gateseed01', $2)", [pid, retro]); await db.query('commit')
  await refusedWrite("update player_external_ids set external_id = 'edited' where external_id = 'gateseed01'")
  await db.query("delete from player_external_ids where external_id = 'gateseed01'")
  const cov = await h.one(db, 'select id from coverage_assessments where source_id = $1 limit 1', [retro])
  if (cov) await refusedWrite("update coverage_assessments set gap_notes = coalesce(gap_notes, '') || ' edited' where id = $1", [cov.id])
  // re-pointing an existing public record at the released source is a write too
  const other = await h.one(db, "select o.id from source_observations o join sources s on s.id = o.source_id where s.source_key = 'gate:base' limit 1")
  await refusedWrite('update source_observations set source_id = $1 where id = $2', [retro, other.id])
  // a batch that is staged but not on the release does not open the door, and neither does a bare setting of the wrong kind
  const staged = await stageOnly2('gate-staged-only', [RETRO, CHADWICK], [rec(RETRO, 6, '2030-02-03')])
  await db.query('begin'); await db.query("select set_config('bai.import_batch_id', $1, true)", [String(staged)])
  await refused(db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) values ($1, 'RETROSHEET', 'gatedirect02', $2)", [pid, retro]), /only an approved batch may write it/); await db.query('rollback')
  await db.query('begin'); await db.query("select set_config('bai.import_batch_id', 'not-a-number', true)")
  await refused(db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) values ($1, 'RETROSHEET', 'gatedirect03', $2)", [pid, retro]), /only an approved batch may write it/); await db.query('rollback')
  assert.deepEqual(diffs(before, await publicState('anon')), [], 'no public relation changed by any of it')
  assert.deepEqual(await pub("select slug from players where slug = 'gate-direct'"), [])
  // what is NOT refused: edits that change nothing public, a source with no release, and the importer's own replay of an approved batch
  await db.query("update source_observations set notes = 'reviewed' where source_id = $1", [retro])
  await db.query("insert into sources (source_key, source_type, authority_level, title, reference) values ('gate:unreleased', 'REFERENCE_DATABASE', 'OTHER', 'Not released', 'fixture')")
  await db.query("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator) select id, 'players', $1, 'full_name', to_jsonb('Gate Direct'::text), 'unreleased source' from sources where source_key = 'gate:unreleased'", [pid])
  await db.query("delete from source_observations where locator = 'unreleased source'"); await db.query("delete from sources where source_key = 'gate:unreleased'"); await db.query("update source_observations set notes = null where source_id = $1", [retro]); await db.query("delete from players where slug = 'gate-direct'")
  // the deliberate door: an apply of an approved batch writes (the importer sets this for its whole transaction)
  const approved = (await h.one(db, 'select id from ingest.import_batches where file_sha256 = $1 order by id limit 1', [shaA])).id
  await db.query('begin'); await db.query("select set_config('bai.import_batch_id', $1, true)", [String(approved)])
  await db.query("update source_observations set notes = 'approved context' where source_id = $1", [retro]); await db.query('rollback')
})

// withdrawing the release is the one way to write: the rows then enter HELD, and the next release must name the batches again
test('with the release withdrawn the same writes are allowed, stay HELD, and the next release still covers only applied batches', async () => {
  await grant(); await db.query('delete from public.source_display_releases')
  const retro = (await h.one(db, 'select id from sources where source_key = $1', [RETRO.source_key])).id
  const pid = (await h.one(db, "insert into players (slug, full_name, display_name) values ('gate-direct2', 'Gate Direct2', 'Gate Direct2') returning id")).id
  await db.query("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator) values ($1, 'players', $2, 'full_name', to_jsonb('Gate Direct2'::text), 'owner sql, withdrawn')", [retro, pid])
  assert.deepEqual(await pub("select slug from players where slug = 'gate-direct2'"), [], 'HELD')
  await db.query("delete from source_observations where locator = 'owner sql, withdrawn'"); await db.query('delete from players where id = $1', [pid])
  await release(RETRO.source_key, [shaA]); await refreshes()
})

for (const [name, withdraw] of [
  ['deleting the release', () => db.query('delete from public.source_display_releases')],
  ['deleting its grant', () => db.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")],
  ['truncating the release', () => db.query('truncate public.source_display_releases')],
  ['truncating the grants', () => db.query('truncate ingest.source_publication_grants cascade')]
]) {
  test(`WITHDRAWN by ${name}: every live row and cached summary is back to HELD at the commit, with no refresh`, async () => {
    await grant(); await db.query('delete from public.source_display_releases'); await release(RETRO.source_key, [shaA]); await refreshes()
    assert.ok((await pub('select count(*)::int n from rm_transactions'))[0].n > 0)
    await db.query('begin'); await withdraw()
    const other = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${db.port}/${db.database}` }); await other.connect()
    try { assert.equal((await other.query("select count(*)::int n from public.rm_transactions")).rows[0].n > 0, true, 'the old state until the commit: atomic') } finally { await other.end() }
    await db.query('commit')
    const left = diffs(baseAnon, await publicState('anon')).filter((k) => !HELD_VISIBLE.includes(k))
    // rm_transaction_* hold no row at all after a withdrawal, the same fail-closed state 030 gives a withdrawn grant; the baseline had a zero-transaction overview row
    assert.deepEqual(left.filter((k) => !/rm_transaction_(overview|coverage|club_seasons)$/.test(k)), [], name)
    assert.equal((await pub('select count(*)::int n from rm_transactions'))[0].n, 0)
    assert.deepEqual(await pub("select slug from players where slug like 'gate-player%'"), [])
    await grant()
    await refreshes(); assert.deepEqual(diffs(baseAnon, await publicState('anon')), HELD_VISIBLE, `refresh after ${name} converges on HELD`)
  })
}

test('a refresh running when the withdrawal arrives cannot republish past it', async () => {
  await release(RETRO.source_key, [shaA]); await refreshes()
  const url = `postgresql://postgres:postgres@127.0.0.1:${db.port}/${db.database}`
  const R = new pg.Client({ connectionString: url }); const W = new pg.Client({ connectionString: url }); await R.connect(); await W.connect()
  try {
    await R.query('begin'); await R.query('select public.refresh_read_models()')
    const w = W.query('delete from public.source_display_releases')
    await new Promise((r) => setTimeout(r, 500))
    assert.equal((await h.one(db, "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid = $1", [W.processID])).n, 1, 'the withdrawal waits for the refresh')
    await R.query('commit'); await w
    assert.deepEqual(diffs(baseAnon, await publicState('anon')).filter((k) => !HELD_VISIBLE.includes(k) && !/rm_transaction_/.test(k)), [])
    await W.query('begin'); await W.query('delete from public.source_display_releases')
    await assert.rejects(R.query('select public.refresh_transaction_read_models()'), (e) => e.code === '55P03')
    await W.query('rollback')
  } finally { await R.end(); await W.end() }
})

test('a later batch from a new file stays HELD after it is imported, and a new release must name it', async () => {
  const b = await load('gate-file2', [RETRO2, CHADWICK], [rec(RETRO2, 6, '2031-01-01')])
  assert.deepEqual(await pub("select slug from players where slug = 'gate-player-6'"), [])
  await release(RETRO.source_key, [shaA])
  assert.deepEqual(await pub("select slug from players where slug = 'gate-player-6'"), [], 'a release of the first file does not publish the second')
  assert.equal((await pub("select count(*)::int n from sources where source_key = 'hist:retrosheet-gate000002'"))[0].n, 0)
  await refused(release(RETRO2.source_key, ['1'.repeat(64)]), /approved lineage/)
  await release(RETRO2.source_key, [b.sha])
  assert.equal((await pub("select count(*)::int n from players where slug = 'gate-player-6'"))[0].n, 1)
  await db.query('delete from public.source_display_releases')
})

test('the boundary: public roles only read the release; it is immutable; no gate function is callable; a later boundary call does not reopen the gate', async () => {
  await db.query('select public.apply_public_boundary()')
  assert.deepEqual(await pub("select slug from players where slug like 'gate-player%'"), [], 'apply_public_boundary kept the gated policies')
  for (const role of ['anon', 'authenticated']) {
    await h.asRole(db, role, async () => {
      for (const sql of [`insert into source_display_releases (source_id, attribution_category, approved_batch_sha256, basis_reference) values (1, 'RETROSHEET', '{x}', 'x')`, 'delete from source_display_releases', 'truncate source_display_releases',
        "update source_display_releases set basis_reference = 'x'", 'select public.display_held_source_ids()', 'select public.rm_apply_display_gate()', 'select public.refresh_read_models()', 'select public.refresh_transaction_read_models()']) {
        await db.query('savepoint s'); await refused(db.query(sql), /permission denied/); await db.query('rollback to savepoint s')
      }
    })
  }
  await release(RETRO.source_key, [shaA]).catch(() => null)
  await refused(db.query("update public.source_display_releases set basis_reference = 'changed'"), /immutable/)
  await db.query('delete from public.source_display_releases')
})

test('migration guard: every player must be public under the new rule, so no existing record can disappear', async () => {
  const sql = fs.readFileSync(new URL('../../database/migrations/032_source_display_release.sql', import.meta.url), 'utf8')
  assert.match(sql, /a player has no full_name observation and would stop being public/)
  await db.query("insert into players (slug, full_name, display_name) values ('gate-no-observation', 'Gate None', 'Gate None')")
  assert.deepEqual(await pub("select slug from players where slug = 'gate-no-observation'"), [], 'a player with no evidence fails closed')
  await db.query("delete from players where slug = 'gate-no-observation'")
})
