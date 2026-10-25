// Migration 028 against the existing BAI schema: nothing existing changes meaning. A database is built through 027, trades
// and outcomes are imported with the existing (legacy-shaped) importer, the value views are snapshotted, 028 is applied, and
// the snapshot must be identical; no existing row is rewritten. Then the new boundary: internal tables, human-only functions.
// FICTIONAL players and TEST_FIXTURE sources only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'

let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-txn-mig-'))
before(async () => { await h.startServer(); db = await h.freshDatabase({ migrate: false }) }, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const src = (key, authority = 'OFFICIAL') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Compat fixture ${key}` })
let n = 0
async function run (doc, org = 'LAD') {
  const f = path.join(dir, `b-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', ...doc }))
  const { batch } = await P.stageFile(db, f, { organization: org })
  const v = await P.validateBatch(db, batch.id)
  assert.ok(v.ok, JSON.stringify(v.counts))
  return P.applyBatch(db, batch.id, { write: true })
}
const who = (id, name) => ({ full_name: name, external_ids: { MLBAM: String(id) } })
const season = (s, org, value) => ({ system: 'BREF', scope: 'SEASON', season: s, organization: org, through_season: 2026, value, observed_on: '2026-10-20', source_key: 'c:bref' })
const career = (value) => ({ system: 'BREF', scope: 'CAREER', through_season: 2026, value, observed_on: '2026-10-20', source_key: 'c:bref' })

const snapshot = async () => ({
  returns: await h.rows(db, 'select to_jsonb(t) j from analytics.trade_returns t order by package_id, war_system'),
  value: await h.rows(db, 'select to_jsonb(v) j from analytics.acquisition_value v order by player_id, war_system, channel'),
  classes: await h.rows(db, 'select to_jsonb(c) j from analytics.class_value c order by organization_id, scope_key, war_system'),
  assets: await h.rows(db, 'select id, trade_package_id, asset_type, player_id, amount_usd::text amount, description from trade_package_assets order by id'),
  counts: await h.one(db, 'select (select count(*) from transactions)::int tx, (select count(*) from trade_packages)::int pk, (select count(*) from trade_package_assets)::int a, (select count(*) from war_observations)::int w, (select count(*) from acquisition_dispositions)::int d')
})
let before027

test('setup on migrations 001-027: a draft class, an outcome audit with a trade, a trade return, cash and PTBNL assets', async () => {
  await applyMigrations(db, { through: '027' })
  assert.equal((await h.one(db, "select count(*)::int n from bai_meta.schema_migrations")).n, 27)
  await run({ batch_key: 'c-draft', channel: 'DRAFT', sources: [src('c:draft')], records: [
    { type: 'DRAFT_SELECTION', source_key: 'c:draft', draft_key: '2016-JUNE_AMATEUR', round_code: '2', overall_pick: 50, round_pick: 20, organization: 'LAD', player: who(9870001, 'Compat Traded'),
      school: { name: 'Compat U', school_type: 'COLLEGE' }, signing: { status: 'SIGNED', bonus_usd: 400000, source_key: 'c:draft' } },
    { type: 'DRAFT_SELECTION', source_key: 'c:draft', draft_key: '2016-JUNE_AMATEUR', round_code: '3', overall_pick: 80, round_pick: 20, organization: 'LAD', player: who(9870002, 'Compat Kept'),
      school: { name: 'Compat U', school_type: 'COLLEGE' }, signing: { status: 'SIGNED', bonus_usd: 300000, source_key: 'c:draft' } }] })
  const trade = { ref: 'c-trade', type: 'TRADE', date: '2018-07-18', from_organization: 'LAD', to_organization: 'BAL', description: 'compat fixture trade' }
  await run({ batch_key: 'c-out', channel: 'OUTCOMES', sources: [src('c:mlb'), src('c:bref', 'AGGREGATOR')], records: [
    { type: 'OUTCOME_AUDIT', source_key: 'c:mlb', organization: 'LAD', player: who(9870001, 'Compat Traded'), audit_state: 'AUDITED_REACHED_MLB', observation_through_season: 2026, audited_on: '2026-10-20',
      debut: { date: '2020-09-06', organization: 'BAL' }, transactions: [trade],
      details: { as_of_date: '2026-10-20', current_status: 'WITH_OTHER_ORGANIZATION', disposition: 'TRADED', disposition_transaction_ref: 'c-trade' },
      war: [career(4.0), season(2020, 'BAL', 1.0), season(2021, 'BAL', 3.0)] }] })
  await run({ batch_key: 'c-trade-back', channel: 'TRADES', sources: [src('c:mlb'), src('c:bref', 'AGGREGATOR')], records: [{ type: 'TRADE', source_key: 'c:mlb', organization: 'LAD', ref: 'c-trade', date: '2018-07-18', packages: [
    { from: 'BAL', to: 'LAD', players: [{ player: { ...who(9870101, 'Compat Star'), source_key: 'c:mlb' }, war: [career(9.0), season(2018, 'LAD', 1.5), season(2019, 'LAD', 2.5), season(2019, 'SD', 5.0)] }],
      other_assets: [{ asset_type: 'CASH', amount_usd: 250000 }, { asset_type: 'PLAYER_TO_BE_NAMED', description: 'PTBNL or cash' }] }] }] })
  before027 = await snapshot()
  assert.ok(before027.returns.length >= 2 && before027.value.length >= 2, 'the views have rows to compare')
  assert.ok(before027.counts.tx === 1 && before027.counts.a >= 4)
})

test('applying 028 changes no existing row and no existing view result (010, 022, 023 semantics preserved)', async () => {
  await applyMigrations(db)
  assert.equal((await h.one(db, 'select count(*)::int n from bai_meta.schema_migrations')).n, (await import('../../scripts/db/lib/migrations.mjs')).listMigrations().length)
  assert.deepEqual(await snapshot(), before027)
  // existing assets: no disclosure recorded before 028, nothing conditional, and the PTBNL is not claimed resolved
  const r = await h.rows(db, 'select asset_type, amount_disclosure, conditional from trade_package_assets where asset_type <> $1 order by id', ['PLAYER'])
  assert.deepEqual(r, [{ asset_type: 'CASH', amount_disclosure: null, conditional: false }, { asset_type: 'PLAYER_TO_BE_NAMED', amount_disclosure: null, conditional: false }])
  assert.equal((await h.one(db, 'select completeness from analytics.transaction_completeness')).completeness, 'UNVERIFIED', 'a record from before 028 is not claimed verified or partial')
})

test('the 022 guard and 023 views behave as before on the new schema', async () => {
  await assert.rejects(db.query("update acquisition_dispositions set disposition_date = '2010-01-01', disposition_date_precision = 'DAY' where disposition = 'TRADED'"), /acquisition disposition .* is inconsistent/)
  const cols = (await h.rows(db, "select column_name from information_schema.columns where table_schema = 'analytics' and table_name = 'trade_returns' order by ordinal_position")).map((r) => r.column_name)
  assert.deepEqual(cols, ['package_id', 'transaction_id', 'transaction_date', 'organization_id', 'counterparty_id', 'sent_player_ids', 'players_sent', 'other_assets_sent', 'war_system', 'received_player_ids', 'return_war_known', 'return_coverage'])
})

test('new rows: cash is explicit, a PTBNL is conditional, and the table checks refuse contradictions', async () => {
  const k = await h.id(db, 'select id from trade_packages order by id limit 1')
  const cash = await h.one(db, "insert into trade_package_assets (trade_package_id, asset_type, amount_usd, description) values ($1, 'CASH', 0, 'stated zero') returning amount_disclosure, amount_usd::text amount", [k])
  assert.deepEqual(cash, { amount_disclosure: 'DISCLOSED', amount: '0.00' }, 'a stated zero is DISCLOSED zero')
  const unk = await h.one(db, "insert into trade_package_assets (trade_package_id, asset_type, description) values ($1, 'CASH', 'unknown cash') returning amount_disclosure, amount_usd", [k])
  assert.deepEqual(unk, { amount_disclosure: 'UNKNOWN', amount_usd: null }, 'null is unknown, never zero')
  const p = await h.one(db, "insert into trade_package_assets (trade_package_id, asset_type, description) values ($1, 'PLAYER_TO_BE_NAMED', 'another PTBNL') returning conditional", [k])
  assert.equal(p.conditional, true)
  await h.rejects(db, "insert into trade_package_assets (trade_package_id, asset_type, amount_disclosure, description) values ($1, 'CASH', 'DISCLOSED', 'x')", [k], /trade_asset_disclosed_has_amount|disclosed/)
  await h.rejects(db, "insert into trade_package_assets (trade_package_id, asset_type, amount_usd, amount_disclosure, description) values ($1, 'CASH', 5, 'UNDISCLOSED', 'x')", [k], /check/)
  await h.rejects(db, "insert into trade_package_assets (trade_package_id, asset_type, amount_disclosure, description) values ($1, 'DRAFT_PICK', 'DISCLOSED', 'x')", [k], /check/)
  await h.rejects(db, "insert into trade_package_assets (trade_package_id, asset_type, conditional, description) values ($1, 'OTHER', true, 'x')", [k], /trade_asset_condition_stated/)
  await db.query('delete from trade_package_assets where description in ($1, $2, $3)', ['stated zero', 'unknown cash', 'another PTBNL'])
})

test('internal by default: the new tables, the research tables and the analytics views are closed to public roles; other legacy tables keep their grants; the raw transaction tables are closed (030)', async () => {
  const internal = ['transaction_external_ids', 'transaction_sources', 'transaction_source_links', 'transaction_conflicts', 'ptbnl_resolutions', 'season_calendar_events']
  for (const role of ['anon', 'authenticated']) {
    for (const t of internal) await assert.rejects(h.asRole(db, role, () => db.query(`select * from ${t}`)), /permission denied/, `${role}.${t}`)
    for (const s of ['select * from research.transaction_verifications', 'select * from analytics.transaction_completeness', 'select * from analytics.trade_asset_players', 'select * from ingest.transaction_apply_ledger',
      'select research.transaction_gaps(1)', "select * from research.verify_transaction(1, 'x', 'y')"]) {
      await assert.rejects(h.asRole(db, role, () => db.query(s)), /permission denied/, `${role}: ${s}`)
    }
    // 030 closed the raw record tables (they hold records no refresh has published); the public reads rm_transactions
    for (const t of ['transactions', 'trade_packages', 'trade_package_assets']) await assert.rejects(h.asRole(db, role, () => db.query(`select * from ${t}`)), /permission denied/, `${role}.${t}`)
    for (const t of [...internal, 'transactions']) await assert.rejects(h.asRole(db, role, () => db.query(`delete from ${t}`)), /permission denied/, `${role} delete ${t}`)
  }
  const noRls = await h.rows(db, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'research') and c.relkind = 'r' and not c.relrowsecurity")
  assert.deepEqual(noRls, [], 'every table has RLS on')
  const writes = await h.rows(db, "select table_name from information_schema.role_table_grants where table_schema in ('public', 'research', 'ingest') and grantee in ('anon', 'authenticated', 'PUBLIC') and privilege_type <> 'SELECT'")
  assert.deepEqual(writes, [])
  const exposed = await h.rows(db, "select table_name from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon' and table_name = any ($1)", [internal])
  assert.deepEqual(exposed, [])
})

test('a reviewer login holds no table privileges: the human-only functions are the only way in', async () => {
  const rv = await h.login(db, 'compat_reviewer', { reviewer: true })
  await assert.rejects(rv.query('select * from research.transaction_verifications'), /permission denied/)
  await assert.rejects(rv.query('select * from analytics.transaction_completeness'), /permission denied/)
  await assert.rejects(rv.query("insert into research.transaction_verifications (transaction_id, verified_by, content_fingerprint, basis_note, independence_note) values (1, 'x', 'y', 'xxxxxxxxxx', 'yyyyyyyyyy')"), /permission denied/)
  await assert.rejects(rv.query('select * from research.verify_transaction(1, $1, $2)', ['a basis that is long enough', 'independence that is long enough']), /not an enrolled, active human reviewer|certification is disabled/)
})

test('the release tooling accepts a later committed migration (028) but still refuses a changed or unknown one', async () => {
  const { migrationProblems } = await import('../../scripts/history/lib/release.mjs')
  const sum = async (v) => (await h.one(db, 'select checksum from bai_meta.schema_migrations where version = $1', [v])).checksum
  const [c027, c028] = [await sum('027'), await sum('028')]
  assert.deepEqual(await migrationProblems(db), [], '001-027 exact, 028 matches its committed file')
  await db.query("update bai_meta.schema_migrations set checksum = 'tampered' where version = '028'")
  assert.deepEqual(await migrationProblems(db), ['migration 028_transaction_forensics_foundation.sql differs from the committed file'])
  await db.query('update bai_meta.schema_migrations set checksum = $1 where version = $2', [c028, '028'])
  await db.query("update bai_meta.schema_migrations set checksum = 'tampered' where version = '027'")
  assert.match((await migrationProblems(db))[0], /027_wikidata_attribution\.sql differs/)
  await db.query('update bai_meta.schema_migrations set checksum = $1 where version = $2', [c027, '027'])
  await db.query("insert into bai_meta.schema_migrations (version, file, checksum) values ('099', '099_unknown.sql', 'x')")
  assert.deepEqual(await migrationProblems(db), ['target has migrations the repository does not: 099'])
  await db.query("delete from bai_meta.schema_migrations where version = '099'")
  assert.deepEqual(await migrationProblems(db), [])
})

test('migration guard: no gaps between successive committed migrations, no unknown or renamed ones', async () => {
  const { migrationProblems } = await import('../../scripts/history/lib/release.mjs')
  const { listMigrations } = await import('../../scripts/db/lib/migrations.mjs')
  const real = listMigrations()
  const fake = (v) => ({ version: v, file: `${v}_future.sql`, checksum: `sum-${v}` })
  const committed = [...real, fake('031'), fake('032')]
  const put = (v) => db.query("insert into bai_meta.schema_migrations (version, file, checksum) values ($1, $2, $3)", [v, `${v}_future.sql`, `sum-${v}`])
  assert.deepEqual(await migrationProblems(db, { committed }), [], 'a database at 028 is fine while 031 and 032 are merely not applied yet')
  await put('032')
  const gap = await migrationProblems(db, { committed })
  assert.equal(gap.length, 1)
  assert.match(gap[0], /031_future\.sql is not applied .*032.*in order/, 'a missing intermediate migration is refused')
  await put('031')
  assert.deepEqual(await migrationProblems(db, { committed }), [])
  await db.query("update bai_meta.schema_migrations set checksum = 'changed' where version = '031'")
  assert.deepEqual(await migrationProblems(db, { committed }), ['migration 031_future.sql differs from the committed file'])
  await db.query("update bai_meta.schema_migrations set checksum = 'sum-031', file = 'renamed.sql' where version = '031'")
  assert.deepEqual(await migrationProblems(db, { committed }), ['migration 031_future.sql differs from the committed file'])
  await db.query("delete from bai_meta.schema_migrations where version in ('031', '032')")
  await db.query("delete from bai_meta.schema_migrations where version = '027'")
  assert.match((await migrationProblems(db))[0], /^migration 027_wikidata_attribution\.sql is not applied/, 'a missing required migration is refused')
})

test('the repository security audit (RLS, grants, SECURITY DEFINER allowlist, reviewer boundary) passes with 028 applied', async () => {
  const { port, database } = db.connectionParameters
  const r = spawnSync(process.execPath, ['scripts/db/security.mjs'], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}` } })
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
})
