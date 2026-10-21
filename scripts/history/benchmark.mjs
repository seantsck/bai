// Scale benchmark for the historical model: a disposable PostgreSQL 17 (embedded, random port, temp dir), every
// migration, and a synthetic league-wide draft history 1965-2026 at roughly the size of the real backfill (every club
// that existed, PICKS_PER_CLUB June picks a year). Synthetic rows are marked TEST_FIXTURE and never touch a real database.
// Times the public explorer queries (as anon, read-only, like the web app), the coverage views, the read-model refresh
// and the analytics views the integrity checks use. Writes research/history/reports/benchmark.json.
//
//   node scripts/history/benchmark.mjs [--picks 50]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from '../db/lib/migrations.mjs'
import { buildExplorerQuery, parseExplorerParams } from '../../lib/search.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PICKS = Number(process.argv[process.argv.indexOf('--picks') + 1]) || 50
const port = 20000 + Math.floor(Math.random() * 30000)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-bench-'))
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
await server.initialise()
await server.start()
const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'postgres' })
await admin.connect()
await admin.query('create database bai_bench')
await admin.end()
const db = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database: 'bai_bench' })
await db.connect()
const out = { generated_on: new Date().toISOString().slice(0, 10), postgres: (await db.query('show server_version')).rows[0].server_version, picks_per_club: PICKS, timings_ms: {}, plans: {} }
const time = async (label, fn) => { const t = process.hrtime.bigint(); const r = await fn(); out.timings_ms[label] = Number((process.hrtime.bigint() - t) / 1000000n); return r }

try {
  await time('migrate_001_024', () => applyMigrations(db))
  await time('load_synthetic', async () => {
    await db.query(`insert into sources (source_key, source_type, authority_level, title) values ('bench:synthetic', 'TEST_FIXTURE', 'OTHER', 'Synthetic benchmark data')`)
    await db.query(`insert into drafts (draft_key, draft_year, draft_kind, start_date, total_rounds, source_id)
      select y || '-JUNE_AMATEUR', y, 'JUNE_AMATEUR', make_date(y, 6, 5), $1, (select id from sources where source_key = 'bench:synthetic')
      from generate_series(1965, 2014) y on conflict do nothing`, [PICKS])
    await db.query(`insert into draft_rounds (draft_id, round_code, round_order, phase) select d.id, r::text, r * 10, 'REGULAR' from drafts d, generate_series(1, $1) r on conflict do nothing`, [PICKS])
    await db.query(`insert into schools (slug, name, school_type, source_id) select 'bench-school-' || i, 'Bench School ' || i || case when i % 3 = 0 then ' HS' else ' University' end,
      case when i % 3 = 0 then 'HIGH_SCHOOL'::school_type else 'COLLEGE'::school_type end, (select id from sources where source_key = 'bench:synthetic') from generate_series(1, 6000) i`)
    // One player per selection; names from a small pool so prefix searches return realistic result sizes.
    await db.query(`create temporary table bench_sel as
      select row_number() over (order by d.draft_year, r.round_order, o.franchise_key) as n, d.id as draft_id, r.id as round_id, o.id as organization_id, r.round_order / 10 as round_no,
             row_number() over (partition by d.id, r.id order by o.franchise_key) as round_pick
      from drafts d join draft_rounds r on r.draft_id = d.id join organizations o on o.active and coalesce(o.first_season, 0) <= d.draft_year
      where d.draft_kind = 'JUNE_AMATEUR'`)
    await db.query(`insert into players (slug, full_name, display_name, birth_date, birth_date_precision)
      select 'bench-' || n, (array['James','John','Michael','David','Robert','Carlos','Luis','Kevin','Brian','Jose'])[1 + n % 10] || ' ' ||
             (array['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Wilson','Anderson','Thomas'])[1 + (n / 10) % 15] || ' ' || n,
             'Bench Player ' || n, make_date(1940 + (n % 60)::int, 1 + (n % 12)::int, 1 + (n % 28)::int), 'DAY' from bench_sel`)
    await db.query(`insert into draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, player_id, school_id, source_id)
      select s.draft_id, s.round_id, row_number() over (partition by s.draft_id order by s.round_no, s.round_pick), s.round_pick, s.organization_id,
             (select id from players where slug = 'bench-' || s.n), 1 + s.n % 6000, (select id from sources where source_key = 'bench:synthetic') from bench_sel s`)
    await db.query(`insert into draft_signings (draft_selection_id, signing_status, signing_bonus_usd, source_id)
      select id, case when id % 5 = 0 then 'DID_NOT_SIGN'::draft_signing_status else 'SIGNED'::draft_signing_status end,
             case when id % 5 <> 0 and id % 2 = 0 then 10000 * (id % 300) end, (select id from sources where source_key = 'bench:synthetic')
      from draft_selections where id % 3 = 0`)
    await db.query('analyze')
  })
  const counts = (await db.query('select (select count(*) from draft_selections)::int selections, (select count(*) from players)::int players, (select count(*) from drafts)::int drafts')).rows[0]
  out.rows = counts

  // The web app's access path: read-only transaction, set local role anon, 3 s statement timeout.
  const asAnon = async (sql, params) => {
    await db.query('begin read only'); await db.query('set local role anon'); await db.query('set local statement_timeout = 3000')
    try { return await db.query(sql, params) } finally { await db.query('rollback') }
  }
  const cases = {
    explorer_default_page: {},
    explorer_name_prefix: { q: 'carlos gar' },
    explorer_franchise_range: { org: 'LAD', from: '1965', to: '1990' },
    explorer_year_round: { year: '1985', round: '1' },
    explorer_school_prefix: { school: 'bench school 12' },
    explorer_signing_unknown_deep_page: { signing: 'UNKNOWN', page: '100' },
    explorer_combined: { q: 'james', org: 'NYY', from: '1970', to: '2010', signing: 'SIGNED' }
  }
  for (const [label, params] of Object.entries(cases)) {
    const { sql, params: p } = buildExplorerQuery(parseExplorerParams(params))
    await asAnon(sql, p)                                       // warm
    const r = await time(label, () => asAnon(sql, p))
    out.timings_ms[label + '_rows'] = r.rowCount
    const plan = await asAnon(`explain (analyze, buffers, format json) ${sql}`, p)
    out.plans[label] = { execution_ms: Math.round(plan.rows[0]['QUERY PLAN'][0]['Execution Time'] * 10) / 10, top: plan.rows[0]['QUERY PLAN'][0].Plan['Node Type'] }
  }
  await time('year_coverage_all', () => asAnon('select * from v_draft_year_coverage order by draft_year desc limit 400'))
  await time('refresh_read_models', () => db.query('select refresh_read_models()'))
  await time('rm_research_coverage_read', () => asAnon("select * from rm_research_coverage where domain = 'DRAFT' limit 5000"))
  await time('analytics_acquisition_value_count', () => db.query('select count(*) from analytics.acquisition_value'))
} finally {
  await db.end()
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
fs.mkdirSync(path.join(root, 'research/history/reports'), { recursive: true })
fs.writeFileSync(path.join(root, 'research/history/reports/benchmark.json'), JSON.stringify(out, null, 1) + '\n')
console.log(JSON.stringify(out, null, 1))
