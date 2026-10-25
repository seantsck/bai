// Disposable-database rehearsal of the Retrosheet candidates (docs/transactions/retrosheet-integration.md). Hosted is only READ (one
// read-only transaction, to copy its data); nothing is written to it. A throwaway PostgreSQL 17 is built from migrations 001-027, the
// hosted data is copied in, migration 028 is applied, and the staged candidates batch is dry-run, applied and replayed there.
//
//   node --env-file=.env.hosted.local scripts/research/retrosheet-rehearsal.mjs [--batch .local/retrosheet/out/candidates-batch.json] [--out .local/retrosheet/out/rehearsal.json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from '../db/lib/migrations.mjs'
import { ownerDatabaseUrl, isLocalUrl, supabaseProjectRef } from '../db/lib/connection.mjs'
import * as P from './lib/pipeline.mjs'
import { integrityViolations } from './lib/integrity.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const batchFile = path.resolve(root, opt('batch', '.local/retrosheet/out/candidates-batch.json'))
const outFile = path.resolve(root, opt('out', '.local/retrosheet/out/rehearsal.json'))
const SCHEMAS = ['public', 'ingest', 'research']
const q = async (db, sql, p) => (await db.query(sql, p)).rows
const report = { started_at: new Date().toISOString(), steps: [] }
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }

const hostedUrl = ownerDatabaseUrl()
if (isLocalUrl(hostedUrl)) throw new Error('point this at the hosted read-only source (.env.hosted.local)')
report.hosted_ref = supabaseProjectRef(hostedUrl)
const port = 20000 + Math.floor(Math.random() * 30000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-retro-rehearsal-'))
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
let failed = false
try {
  await server.initialise(); await server.start(); await server.createDatabase('bai_copy')
  const copy = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/bai_copy` }); await copy.connect()
  await applyMigrations(copy, { through: '027' })
  const hosted = new pg.Client({ connectionString: hostedUrl }); await hosted.connect()
  await hosted.query('begin read only')
  const list = async (db) => (await q(db, `select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE' order by 1, 2`, [[...SCHEMAS, 'bai_meta']])).map((r) => `${r.s}.${r.t}`)
  const data = (await list(hosted)).filter((t) => t !== 'bai_meta.schema_migrations')
  await copy.query('set session_replication_role = replica')
  await copy.query(`truncate ${data.join(', ')} restart identity`)
  let total = 0
  for (const t of data) {
    const [s, n] = t.split('.')
    const cols = (await q(copy, `select column_name c from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [s, n])).map((r) => `"${r.c}"`)
    const rows = (await hosted.query(`select to_jsonb(x) j from ${t} x`)).rows.map((r) => r.j)
    total += rows.length
    for (let i = 0; i < rows.length; i += 200) await copy.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 200))])
  }
  for (const r of await q(copy, `select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid where a.attidentity <> '' and s.nspname = any($1) and c.relkind = 'r'`, [SCHEMAS])) {
    await copy.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await copy.query('reset session_replication_role')
  await hosted.query('rollback'); await hosted.end()
  step('hosted data copied through a read-only transaction', true, `${total} rows in ${data.length} tables`)
  await applyMigrations(copy)
  step('migration 028 applied to the copy', (await q(copy, 'select max(version) v from bai_meta.schema_migrations'))[0].v === '028')
  // BAI baseline: the rows and view results that must not change
  const old = { tx: Number((await q(copy, 'select max(id) m from public.transactions'))[0].m), players: Number((await q(copy, 'select max(id) m from public.players'))[0].m) }
  const fp = async (sql) => (await q(copy, `select count(*)::int n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from (${sql}) x`))[0]
  const rowsSql = {
    transactions: `select id, transaction_type, transaction_date, date_precision, description, source_id from public.transactions where id <= ${old.tx}`,
    packages: `select k.* from public.trade_packages k where k.transaction_id <= ${old.tx}`,
    assets: `select a.id, a.trade_package_id, a.asset_type, a.player_id, a.amount_usd, a.description from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where k.transaction_id <= ${old.tx}`,
    players: `select id, slug, full_name, birth_date from public.players where id <= ${old.players}`,
    war: 'select * from public.war_observations',
    dispositions: 'select * from public.acquisition_dispositions'
  }
  // analytics.acquisition_value re-evaluates analytics.trade_returns for each traded acquisition. Over the whole database it takes
  // minutes with BAI's 65 trades and, measured in this rehearsal, far longer once hundreds of trades exist (docs/transactions/retrosheet-integration.md).
  // It is therefore compared for a deterministic bounded sample (5 traded acquisitions, 10 other players of existing trades), each query
  // bounded by a timeout; trade_returns is compared in full for every pre-existing trade. Timings are reported.
  const sample = (await q(copy, `with traded as (select distinct player_id from public.acquisition_dispositions where disposition = 'TRADED' order by 1 limit 5),
    other as (select distinct a.player_id from public.trade_package_assets a where a.player_id is not null and a.player_id not in (select player_id from public.acquisition_dispositions where disposition = 'TRADED') order by 1 limit 10)
    select array_agg(player_id order by player_id) ids from (select * from traded union select * from other) x`))[0].ids.map(Number)
  const viewsSql = {
    trade_returns: `select to_jsonb(t) j from analytics.trade_returns t where transaction_id <= ${old.tx}`,
    acquisition_value_sample: `select to_jsonb(v) j from analytics.acquisition_value v where player_id = any ('{${sample.join(',')}}'::bigint[])`
  }
  const timings = {}
  const timedFp = async (label, sql, when) => {
    await copy.query("set statement_timeout = '480s'")
    const t0 = Date.now()
    try { const r = await fp(sql); timings[`${label}_${when}_seconds`] = Math.round((Date.now() - t0) / 100) / 10; return r } catch (e) { if (!/timeout/.test(e.message)) throw e; timings[`${label}_${when}_seconds`] = 'TIMEOUT>480'; return null } finally { await copy.query('reset statement_timeout') }
  }
  const before = {}; const viewBefore = {}
  for (const [k, s] of Object.entries(rowsSql)) before[k] = await fp(s)
  for (const [k, s] of Object.entries(viewsSql)) viewBefore[k] = await timedFp(k, s, 'before')
  const existingTrades = before.transactions.n

  // --- the batch ----------------------------------------------------------------------------------------------------------------
  const stage = async (file, key) => {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    const tmp = path.join(dir, `${key}.json`)
    fs.writeFileSync(tmp, JSON.stringify({ ...doc, batch_key: key }))
    const { batch } = await P.stageFile(copy, tmp, { allowFixtures: true })
    return { batch, validation: await P.validateBatch(copy, batch.id) }
  }
  const doc = JSON.parse(fs.readFileSync(batchFile, 'utf8'))
  const s1 = await stage(batchFile, 'retrosheet-rehearsal-1')
  step('candidates staged and validated', s1.validation.ok, JSON.stringify({ records: doc.records.length, ...s1.validation.counts }))
  const invalid = await q(copy, `select record_index, validation_errors from ingest.staged_records where batch_id = $1 and validation_status <> 'VALID' order by 1`, [s1.batch.id])
  report.invalid = invalid.map((r) => ({ record_index: r.record_index, errors: r.validation_errors }))
  const dry = await P.applyBatch(copy, s1.batch.id, { write: false, allowPartial: true })
  step('dry run', true, JSON.stringify(dry.report.actions))
  const afterDry = await q(copy, 'select count(*)::int n from public.transactions')
  step('the dry run wrote nothing', afterDry[0].n === existingTrades)
  const done = await P.applyBatch(copy, s1.batch.id, { write: true, allowPartial: true })
  report.apply = { actions: done.report.actions, new_players: done.report.new_players, held: done.report.held, conflicts: done.report.conflicts }
  report.held_reasons = done.results.filter((r) => r.action === 'HELD').map((r) => ({ record_index: r.record_index, reason: r.reason }))
  step('batch applied', true, JSON.stringify(done.report.actions) + ` new players ${done.report.new_players}`)
  const collisions = report.held_reasons.filter((h) => /^COLLISION/.test(h.reason)).length
  const conflictsHeld = report.held_reasons.filter((h) => /^CONFLICT/.test(h.reason)).length
  step('records held for a collision with an existing BAI trade or a conflict (never overwritten)', true, `${collisions} collisions, ${conflictsHeld} conflicts`)
  const replay = await stage(batchFile, 'retrosheet-rehearsal-2')
  const again = await P.applyBatch(copy, replay.batch.id, { write: true, allowPartial: true })
  const noInserts = !((again.report.actions.INSERT ?? 0) || (again.report.actions.UPDATE_UNKNOWN ?? 0))
  step('replay (same content, new batch) inserts nothing', noInserts, JSON.stringify(again.report.actions))

  // --- checks -----------------------------------------------------------------------------------------------------------------
  await copy.query('analyze')
  const after = {}; const viewAfter = {}
  for (const [k, s] of Object.entries(rowsSql)) after[k] = await fp(s)
  for (const [k, s] of Object.entries(viewsSql)) viewAfter[k] = await timedFp(k, s, 'after')
  const changed = Object.keys(before).filter((k) => before[k].h !== after[k].h || before[k].n !== after[k].n)
  step('every pre-existing BAI row (trades, packages, assets, players, WAR, dispositions) is byte-identical', !changed.length, changed.join(', ') || `${existingTrades} trades unchanged`)
  const vchanged = Object.keys(viewBefore).filter((k) => viewBefore[k] && viewAfter[k] && (viewBefore[k].h !== viewAfter[k].h || viewBefore[k].n !== viewAfter[k].n))
  const vincomplete = Object.keys(viewBefore).filter((k) => !viewBefore[k] || !viewAfter[k])
  report.timings = timings
  step('trade-return results for every pre-existing trade, and acquisition-value results for the bounded sample, are identical', !vchanged.length, (vchanged.join(', ') || Object.entries(viewBefore).filter(([, v]) => v).map(([k, v]) => `${k} ${v.n} rows`).join(', ')) + (vincomplete.length ? `; NOT COMPLETED within the bound: ${vincomplete.join(', ')}` : '') + `; timings ${JSON.stringify(timings)}`)
  const dup = (await q(copy, 'select count(*)::int n from (select k.transaction_id, a.player_id from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id where a.player_id is not null group by 1, 2 having count(*) > 1) x'))[0].n
  step('no player is attributed twice within a transaction', dup === 0)
  const integ = await integrityViolations(copy)
  step('integrity checks', integ.length === 0, integ.length ? integ.map((v) => v.key).join(', ') : 'zero violations')
  const comp = await q(copy, `select c.completeness, count(*)::int n from analytics.transaction_completeness c join public.transaction_external_ids x on x.transaction_id = c.transaction_id and x.scheme = 'RETROSHEET_TXN' group by 1`)
  step('no Retrosheet transaction is VERIFIED_COMPLETE', !comp.some((c) => c.completeness === 'VERIFIED_COMPLETE'), comp.map((c) => `${c.completeness} ${c.n}`).join(', '))
  const gaps = await q(copy, `select g, count(*)::int n from analytics.transaction_completeness c join public.transaction_external_ids x on x.transaction_id = c.transaction_id and x.scheme = 'RETROSHEET_TXN', unnest(c.gaps) g group by 1 order by 2 desc, 1`)
  report.gap_counts = Object.fromEntries(gaps.map((g) => [g.g, g.n]))
  const nums = (await q(copy, `select (select count(*) from public.transactions)::int tx, (select count(*) from public.transaction_external_ids where scheme = 'RETROSHEET_TXN')::int retro_tx,
    (select count(*) from public.trade_package_assets a join public.trade_packages k on k.id = a.trade_package_id join public.transaction_external_ids x on x.transaction_id = k.transaction_id and x.scheme = 'RETROSHEET_TXN')::int retro_assets,
    (select count(*) from public.ptbnl_resolutions)::int ptbnl_resolutions, (select count(*) from public.players where id > $1)::int new_players`, [old.players]))[0]
  report.counts = nums
  step('result counts', true, JSON.stringify(nums))
  await copy.end()
} catch (err) {
  failed = true
  step('rehearsal ran', false, String(err.message).replace(/postgres(ql)?:\/\/\S+/g, '<redacted>'))
} finally {
  await server.stop().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
failed = failed || report.steps.some((s) => !s.ok)
report.finished_at = new Date().toISOString(); report.ok = !failed
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')
console.log(failed ? 'REHEARSAL FAILED' : 'REHEARSAL OK')
process.exit(failed ? 1 : 0)
