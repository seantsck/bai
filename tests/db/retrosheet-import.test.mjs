// Retrosheet candidates through the Phase 16 importer on a disposable PostgreSQL 17 (migration 028 applied): staging, validation,
// collision with BAI's existing trades, replay, no double counting, integrity, completeness limits, permissions, and unchanged
// acquisition-value and trade-return semantics. Every row below is FICTIONAL (years 2030, MLBAM 9900xx, TEST register).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import * as R from '../../scripts/research/lib/retrosheet-transactions.mjs'
import { indexRegisterByRetro, resolveAll } from '../../scripts/research/lib/retrosheet-identity.mjs'
import { buildCandidates, sourceDeclarations, sourceKeys } from '../../scripts/research/lib/retrosheet-adapter.mjs'
import { integrityViolations } from '../../scripts/research/lib/integrity.mjs'
import { PermissionDenied } from '../../scripts/history/lib/permissions.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-retro-'))
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const q = (c) => c.map((v) => `"${v}"`).join(',')
const row = (o) => q([o.date, o.time ?? '', o.approx ?? '', '', '', o.id, o.player ?? '', o.type ?? 'T ', o.from ?? '', o.fromLg ?? '', o.to ?? '', o.toLg ?? '', '', '', '', o.info ?? ''])
const lg = { LAN: 'NL', SEA: 'AL', NYA: 'AL', BOS: 'AL', SDN: 'NL', TEX: 'AL', HOU: 'AL', TBA: 'AL' }
const t = (id, date, player, from, to, o = {}) => row({ id, date, player, from, fromLg: lg[from], to, toLg: lg[to], ...o })
const HEAD = 'key_person,key_uuid,key_mlbam,key_retro,key_bbref,key_bbref_minors,key_fangraphs,key_npb,key_sr_nfl,key_sr_nba,key_sr_nhl,key_wikidata,name_last,name_first,name_given,name_suffix,name_matrilineal,name_nick,birth_year,birth_month,birth_day,death_year,death_month,death_day,pro_played_first,pro_played_last,mlb_played_first,mlb_played_last'
const PERSON = (n, retro, last, first) => `k${n},u${n},${990000 + n},${retro},,,,,,,,,${last},${first},,,,,1990,5,17,,,,2010,2020,2012,2020`
const people = [[1, 'smitj001', 'Smith', 'John'], [2, 'jonea001', 'Jones', 'Al'], [3, 'nix-j001', 'Nix', 'Jay'], [4, 'bairj001', 'Baird', 'Jim'], [5, 'cruzc001', 'Cruz', 'Carl'], [6, 'dunnd001', 'Dunn', 'Dan'],
  [7, 'evane001', 'Evans', 'Ed'], [8, 'fordf001', 'Ford', 'Fred'], [9, 'gomeg001', 'Gomez', 'Gil'], [10, 'hallh001', 'Hall', 'Hal'], [11, 'ivesi001', 'Ives', 'Ian'], [12, 'jackj001', 'Jackson', 'Jo']]
const regDir = fs.mkdtempSync(path.join(dir, 'reg-'))
for (const s of '0123456789abcdef') fs.writeFileSync(path.join(regDir, `people-${s}.csv`), HEAD + '\n' + (s === '0' ? people.map((p) => PERSON(...p)).join('\n') + '\n' : ''))

const ARCH = 'c'.repeat(64)
const KEYS = sourceKeys(ARCH, '781c175')
const DECL = sourceDeclarations({ archiveSha256: ARCH, retrievedOn: '2026-10-22', registerCommit: '781c175', registerCommitFull: '781c175e748b89e5730fd3f5de0086b9355b2f92', registerRetrievedOn: '2026-10-21' })
const ROWS = [
  // two-club trade with unknown cash (new)
  t('100', '20300601', 'smitj001', 'LAN', 'SEA'), t('100', '20300601', 'jonea001', 'SEA', 'LAN'), t('100', '20300601', '', 'LAN', 'SEA', { info: '$' }),
  // multi-team trade
  t('101', '20300611', 'nix-j001', 'NYA', 'BOS'), t('101', '20300611', 'bairj001', 'BOS', 'SDN'), t('101', '20300611', 'cruzc001', 'SDN', 'NYA'),
  // two same-day trades between the same clubs, different source ids
  t('102', '20300620', 'dunnd001', 'TEX', 'HOU'), t('102', '20300620', 'evane001', 'HOU', 'TEX'), t('103', '20300620', 'fordf001', 'TEX', 'HOU'), t('103', '20300620', 'gomeg001', 'HOU', 'TEX'),
  // PTBNL named later
  t('104', '20300701', 'hallh001', 'TBA', 'SEA'), t('104', '20300701', 'ivesi001', 'SEA', 'TBA'), t('104', '20300701', '', 'SEA', 'TBA', { info: 'player to be named or cash' }), t('104', '20300915', 'jackj001', 'SEA', 'TBA'),
  // a trade on the same day between the same clubs as an EXISTING BAI trade (no shared identity): must be held
  t('105', '20300501', 'smitj001', 'LAN', 'BOS'), t('105', '20300501', 'jonea001', 'BOS', 'LAN'),
  // held: name-only, approximate date, month-only
  t('106', '20300801', 'Some Prospect', 'LAN', 'NYA'), t('106', '20300801', 'smitj001', 'NYA', 'LAN'),
  row({ id: '107', date: '20300802', approx: '@', player: 'smitj001', from: 'LAN', fromLg: 'NL', to: 'NYA', toLg: 'AL' }), t('107', '20300802', 'jonea001', 'NYA', 'LAN'),
  t('108', '20300800', 'smitj001', 'LAN', 'NYA'), t('108', '20300800', 'jonea001', 'NYA', 'LAN'),
  // not trades: free agents, waiver, release (inventory only)
  row({ id: '200', date: '20300301', player: 'smitj001', type: 'F ', to: 'LAN', toLg: 'NL' }), row({ id: '201', date: '20300302', player: 'jonea001', type: 'W ', from: 'SEA', fromLg: 'AL', to: 'LAN', toLg: 'NL' }),
  row({ id: '202', date: '20300303', player: 'nix-j001', type: 'R ', from: 'LAN', fromLg: 'NL' })
].join('\n') + '\n'
const rows = R.parseTran(ROWS)
const groups = R.groupRows(rows)
const resolved = resolveAll(rows, indexRegisterByRetro(regDir, new Set(rows.filter((r) => r.player.kind === 'RETROSHEET_ID').map((r) => r.player.retro_id))), { byMlbam: new Map(), byRetro: new Map() })
const cand = buildCandidates(groups, resolved, { from: 2030, to: 2030, declarations: DECL, keys: KEYS, batchKey: 'retrosheet-test-batch' })

const src = (key) => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: 'OFFICIAL', title: `Existing BAI trade source ${key}` })
let n = 0
async function stageDoc (doc) {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {})
  return { batch, validation: await P.validateBatch(db, batch.id) }
}
const counts = () => h.one(db, `select (select count(*) from transactions)::int tx, (select count(*) from trade_packages)::int pk, (select count(*) from trade_package_assets)::int assets, (select count(*) from players)::int players,
  (select count(*) from player_external_ids)::int ids, (select count(*) from transaction_external_ids)::int xids, (select count(*) from ptbnl_resolutions)::int res, (select count(*) from ingest.transaction_apply_ledger)::int ledger`)
const semantics = async () => ({
  returns: await h.rows(db, "select to_jsonb(t) j from analytics.trade_returns t where transaction_id in (select id from transactions where description like 'existing:%') order by package_id, war_system"),
  value: await h.rows(db, 'select to_jsonb(v) j from analytics.acquisition_value v order by player_id, war_system, channel')
})
let baseline
const status = async (ext) => h.one(db, `select c.completeness, c.gaps, c.independent_source_groups g from analytics.transaction_completeness c join transaction_external_ids x on x.transaction_id = c.transaction_id where x.external_id = $1`, [ext])

test('setup: BAI already holds trades (the legacy shape), one of them on the same day between the same clubs as a Retrosheet group', async () => {
  const f = path.join(dir, 'legacy.json')
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', batch_key: 'legacy-existing', channel: 'TRADES', sources: [src('x:legacy')], records: [
    { type: 'TRADE', source_key: 'x:legacy', organization: 'LAD', ref: 'existing-1', date: '2030-05-01', description: 'existing: LAD-BOS', packages: [
      { from: 'LAD', to: 'BOS', players: [{ player: { full_name: 'Existing One', external_ids: { MLBAM: '990901' } } }] }, { from: 'BOS', to: 'LAD', players: [{ player: { full_name: 'Existing Two', external_ids: { MLBAM: '990902' } } }] }] },
    { type: 'TRADE', source_key: 'x:legacy', organization: 'HOU', ref: 'existing-2', date: '2029-07-01', description: 'existing: HOU-TEX', packages: [
      { from: 'HOU', to: 'TEX', players: [{ player: { full_name: 'Existing Three', external_ids: { MLBAM: '990903' } }, war: [{ system: 'BREF', scope: 'SEASON', season: 2029, organization: 'TEX', through_season: 2030, value: 1.5, observed_on: '2030-10-01', source_key: 'x:legacy' }] }] },
      { from: 'TEX', to: 'HOU', players: [{ player: { full_name: 'Existing Four', external_ids: { MLBAM: '990904' } } }] }] }] }))
  const { batch } = await P.stageFile(db, f, {})
  assert.ok((await P.validateBatch(db, batch.id)).ok)
  await P.applyBatch(db, batch.id, { write: true })
  assert.equal((await h.one(db, 'select count(*)::int n from transactions')).n, 2)
  baseline = await semantics()
  assert.ok(baseline.returns.length >= 2)
})

test('the candidate batch stages, validates and carries one lineage, the exact attribution and no amount', async () => {
  assert.equal(cand.doc.records.length, 6, 'two-club, multi-team, two same-day, PTBNL, and the one on the existing day: staged')
  assert.deepEqual(cand.holds.map((x) => x.source_id).sort(), ['106', '107', '108'], 'name-only, approximate and month-only dates are held')
  assert.ok(cand.doc.sources.some((x) => x.notes === R.RETROSHEET_ATTRIBUTION), 'the attribution travels with the source declaration')
  assert.doesNotMatch(JSON.stringify(cand.doc), /"amount_usd":\s*[1-9]/, 'no dollar amount is ever staged')
  const s = await stageDoc(cand.doc)
  assert.ok(s.validation.ok, JSON.stringify(s.validation.counts))
})

test('dry run writes nothing; the write inserts new trades and HOLDS the one that collides with an existing BAI trade', async () => {
  const before = await counts()
  const s = await stageDoc({ ...cand.doc, batch_key: 'retrosheet-test-batch-2' })
  const dry = await P.applyBatch(db, s.batch.id, { write: false })
  assert.deepEqual(await counts(), before)
  assert.deepEqual(dry.report.actions, { INSERT: 5, HELD: 1 })
  const done = await P.applyBatch(db, s.batch.id, { write: true })
  assert.deepEqual(done.report.actions, { INSERT: 5, HELD: 1 })
  const held = done.results.find((r) => r.action === 'HELD')
  assert.match(held.reason, /COLLISION: same day and clubs as transaction \d+/)
  const c = await counts()
  assert.equal(c.tx, before.tx + 5)
  assert.equal(c.xids, before.xids + 5)
  assert.equal(c.res, 1, 'the later-named player resolved the one PTBNL')
  assert.equal((await h.one(db, "select count(*)::int n from transactions where transaction_date = '2030-05-01'")).n, 1, 'the existing BAI trade is untouched and not duplicated')
})

test('packages: multi-team, two same-day trades between the same clubs, unknown cash, PTBNL resolved by the later-dated row', async () => {
  const tri = await h.rows(db, `select fo.franchise_key f, too.franchise_key t from trade_packages k join transaction_external_ids x on x.transaction_id = k.transaction_id join organizations fo on fo.id = k.from_organization_id join organizations too on too.id = k.to_organization_id where x.external_id = '101@20300611' order by 1`)
  assert.deepEqual(tri, [{ f: 'BOS', t: 'SD' }, { f: 'NYY', t: 'BOS' }, { f: 'SD', t: 'NYY' }])
  assert.equal((await h.one(db, "select count(distinct transaction_id)::int n from transaction_external_ids where external_id in ('102@20300620', '103@20300620')")).n, 2)
  const cash = await h.one(db, `select a.amount_usd, a.amount_disclosure from trade_package_assets a join trade_packages k on k.id = a.trade_package_id join transaction_external_ids x on x.transaction_id = k.transaction_id where x.external_id = '100@20300601' and a.asset_type = 'CASH'`)
  assert.deepEqual(cash, { amount_usd: null, amount_disclosure: 'UNKNOWN' })
  const rs = await h.one(db, `select r.resolution, to_char(r.resolved_on, 'YYYY-MM-DD') d, p.full_name from ptbnl_resolutions r join players p on p.id = r.resolved_player_id`)
  assert.deepEqual([rs.resolution, rs.d], ['PLAYER', '2030-09-15'])
  assert.match(rs.full_name, /Jackson/)
  assert.equal((await h.one(db, "select to_char(transaction_date, 'YYYY-MM-DD') d from transactions t join transaction_external_ids x on x.transaction_id = t.id where x.external_id = '104@20300701'")).d, '2030-07-01', 'the trade keeps its own date')
})

test('identity: players carry the Retrosheet id and the register MLBAM, attributed to the register source; none was matched by name', async () => {
  const p = await h.one(db, `select e1.external_id mlbam, e2.external_id retro, s.source_key from player_external_ids e1 join player_external_ids e2 on e2.player_id = e1.player_id and e2.id_system = 'RETROSHEET'
    join sources s on s.id = e1.source_id where e1.id_system = 'MLBAM' and e1.external_id = '990001'`)
  assert.deepEqual(p, { mlbam: '990001', retro: 'smitj001', source_key: KEYS.chadwick })
  assert.equal((await h.one(db, "select count(*)::int n from players where full_name = 'Some Prospect'")).n, 0, 'the name-only prospect was never imported')
})

test('replay: the same batch, and the same content under a new batch key, change nothing; the held record stays held', async () => {
  const before = await counts()
  const again = await stageDoc({ ...cand.doc, batch_key: 'retrosheet-test-batch-3' })
  const out = await P.applyBatch(db, again.batch.id, { write: true })
  assert.deepEqual(out.report.actions, { NO_CHANGE: 5, HELD: 1 })
  const first = (await h.one(db, "select id from ingest.import_batches where batch_key = 'retrosheet-test-batch-2'")).id
  assert.deepEqual((await P.applyBatch(db, first, { write: true })).report.actions, { NO_CHANGE: 5, HELD: 1 })
  const after = await counts()
  assert.deepEqual({ ...after, ledger: 0 }, { ...before, ledger: 0 })
})

test('zero duplicate asset attribution and zero integrity violations', async () => {
  assert.deepEqual(await h.rows(db, 'select trade_package_id, player_id from trade_package_assets where player_id is not null group by 1, 2 having count(*) > 1'), [])
  assert.deepEqual(await h.rows(db, `select a.player_id from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where a.player_id is not null group by k.transaction_id, a.player_id having count(*) > 1`), [])
  assert.deepEqual(await h.rows(db, 'select war_observation_id, organization_id from organization_value_attributions group by 1, 2 having count(*) > 1'), [])
  assert.deepEqual(await integrityViolations(db), [])
})

test('completeness: Retrosheet alone never makes a transaction complete; the gaps say why; a reviewer cannot verify it', async () => {
  const s = await status('100@20300601')
  assert.equal(s.completeness, 'PARTIAL')
  assert.equal(s.g, 1, 'one independent source group: the archive')
  for (const gap of ['FEWER_THAN_TWO_INDEPENDENT_SOURCES', 'NO_PRIMARY_ANNOUNCEMENT', 'PACKAGE_NOT_CORROBORATED', 'ASSET_NOT_CORROBORATED', 'CASH_AMOUNT_UNKNOWN']) assert.ok(s.gaps.includes(gap), gap)
  assert.equal((await status('104@20300701')).gaps.includes('PENDING_PTBNL'), false, 'the resolved PTBNL is not pending')
  assert.equal((await h.one(db, "select count(*)::int n from analytics.transaction_completeness where completeness = 'VERIFIED_COMPLETE'")).n, 0)
  const rv = await h.login(db, 'retro_reviewer', { reviewer: true })
  await rv.query("select * from research.enroll_reviewer('Retro Reviewer')")
  await rv.query("select * from research.set_certification_gate(true, 'isolated test database')")
  const tx = (await h.one(db, "select transaction_id id from transaction_external_ids where external_id = '100@20300601'")).id
  await assert.rejects(rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, 'the archive lists this transaction', 'only one source lineage']), /cannot be verified complete: .*FEWER_THAN_TWO_INDEPENDENT_SOURCES/)
})

test('semantics: BAI\'s existing trade returns and acquisition values are identical before and after the Retrosheet import', async () => {
  assert.deepEqual(await semantics().then((s) => s.returns), baseline.returns)
  const after = await semantics()
  for (const v of baseline.value) assert.ok(after.value.some((a) => JSON.stringify(a) === JSON.stringify(v)), 'an existing acquisition value row changed')
  assert.equal((await h.one(db, 'select count(*)::int n from war_observations')).n, 1, 'no WAR was created from Retrosheet')
})

test('source permissions: Retrosheet records are refused for a hosted database (publish_site is PENDING) and need no override locally', async () => {
  assert.equal(P.requirePublishable({ host: '127.0.0.1' }, cand.doc), null)
  assert.throws(() => P.requirePublishable({ host: 'db.projectref000000000000.supabase.co' }, cand.doc), (e) => e instanceof PermissionDenied && /retrosheet|publish_site|PENDING/i.test(e.message))
})

test('preview of the batch against the imported state is exact and read-only', async () => {
  const identityInput = (p) => ({ full_name: p.full_name, birth_date: p.birth_date ?? null, birth_country: p.birth_country ?? null, external_ids: p.external_ids ?? {} })
  const before = await counts()
  await db.query('begin read only')
  let kinds
  try { kinds = (await T.previewTrades(db, cand.doc, { identityInput })).map((r) => r.kind).sort() } finally { await db.query('rollback') }
  assert.deepEqual(kinds, ['COLLISION', 'EXISTING', 'EXISTING', 'EXISTING', 'EXISTING', 'EXISTING'])
  assert.deepEqual(await counts(), before)
})
