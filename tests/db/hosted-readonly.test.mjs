// Non-persistent verification suite. By default it runs on a fresh local database like every other DB test. With
// BAI_VERIFY_TARGET=hosted (npm run hosted:verify) it runs against BAI_DATABASE_URL, i.e. the hosted BAI project, and
// leaves no trace there:
//   * each test runs inside ONE outer transaction that is always rolled back;
//   * the pipeline's own BEGIN/COMMIT/ROLLBACK become savepoints inside it (see nested()), so the real staged
//     ingestion code runs end to end and still persists nothing;
//   * the suite snapshots row counts of every BAI table before and after and asserts they are identical.
// Players and sources created here are FICTIONAL (TEST_FIXTURE sources, MLBAM ids 98000xx) and exist only inside the
// rolled-back transactions.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import { validateSource } from '../../scripts/research/lib/import-format.mjs'
import { integrityViolations } from '../../scripts/research/lib/integrity.mjs'
import { listMigrations, supabaseHistory, pushedMatchesFile } from '../../scripts/db/lib/migrations.mjs'
import { ownerDatabaseUrl } from '../../scripts/db/lib/connection.mjs'

const HOSTED = process.env.BAI_VERIFY_TARGET === 'hosted'
let raw
let db
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-verify-'))

/** Client view whose transaction statements become savepoints inside the caller's outer transaction. */
function nested (client) {
  let depth = 0
  const query = async (sql, params) => {
    const s = typeof sql === 'string' ? sql.trim().toLowerCase() : null
    if (s === 'begin' || s === 'begin read only') { depth++; return client.query(`savepoint bai_verify_${depth}`) }
    if (s === 'commit') { const r = await client.query(`release savepoint bai_verify_${depth}`); depth--; return r }
    if (s === 'rollback') { await client.query(`rollback to savepoint bai_verify_${depth}`); const r = await client.query(`release savepoint bai_verify_${depth}`); depth--; return r }
    return client.query(sql, params)
  }
  return { query }
}

async function tableCounts () {
  const tables = (await raw.query(`select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'analytics', 'ingest', 'research', 'bai_meta') and c.relkind = 'r' order by 1`)).rows.map((r) => r.t)
  const out = {}
  for (const t of tables) out[t] = Number((await raw.query(`select count(*) n from ${t}`)).rows[0].n)
  out['read_model_generation'] = Number((await raw.query('select coalesce(max(generation_id), 0) g from public.read_model_refreshes')).rows[0].g)
  return out
}

let countsBefore
before(async () => {
  if (HOSTED) {
    raw = new pg.Client({ connectionString: ownerDatabaseUrl() })
    await raw.connect()
  } else {
    await h.startServer()
    raw = await h.freshDatabase()
  }
  db = nested(raw)
  countsBefore = await tableCounts()
}, { timeout: 120000 })

after(async () => {
  try {
    assert.deepEqual(await tableCounts(), countsBefore, 'the verification suite must leave every table exactly as it found it')
  } finally {
    if (HOSTED) await raw.end(); else await h.stopServer()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** Runs fn inside an outer transaction that is always rolled back. */
async function isolated (fn) {
  await raw.query('begin')
  try { return await fn() } finally { await raw.query('rollback') }
}
const one = async (sql, p) => (await raw.query(sql, p)).rows[0]
const rows = async (sql, p) => (await raw.query(sql, p)).rows

const src = (key, authority = 'OTHER') => ({ source_key: key, source_type: 'TEST_FIXTURE', authority_level: authority, title: `Verification source ${key}` })
let n = 0
function file (doc) {
  const f = path.join(dir, `verify-${++n}.json`)
  fs.writeFileSync(f, JSON.stringify({ format: 'bai-research-import/1', sources: [], ...doc }))
  return f
}
const pick = (o = {}) => ({
  type: 'DRAFT_SELECTION', source_key: 'verify:official', draft_key: '2017-JUNE_AMATEUR', round_code: '3', overall_pick: 80, round_pick: 5, organization: 'SEA',
  position: 'RHP', player: { full_name: 'Verifia Fixture', birth_date: '1996-02-02', external_ids: { MLBAM: '9800001' } },
  school: { name: 'Verification Tech', school_type: 'COLLEGE', region: 'OR', country: 'USA' },
  signing: { status: 'SIGNED', bonus_usd: 500000, source_key: 'verify:official' }, ...o
})
async function run (doc, { write = true } = {}) {
  const { batch } = await P.stageFile(db, file(doc))
  const v = await P.validateBatch(db, batch.id)
  if (!v.ok) return { validation: v }
  return { validation: v, ...(await P.applyBatch(db, batch.id, { write })) }
}
const canonical = () => one(`select (select count(*) from players)::int players, (select count(*) from draft_selections)::int selections,
  (select count(*) from draft_signings)::int signings, (select count(*) from international_signings)::int intl, (select count(*) from source_observations)::int observations,
  (select count(*) from sources)::int sources, (select count(*) from schools)::int schools, (select count(*) from coverage_assessments)::int coverage`)

test('migration history: every committed migration is recorded with its frozen checksum (and, on Supabase, its pushed statements)', async () => {
  const files = listMigrations()
  const meta = await rows('select version, file, checksum from bai_meta.schema_migrations order by version')
  assert.deepEqual(meta.map((m) => [m.version, m.file, m.checksum]), files.map((f) => [f.version, f.file, f.checksum]))
  const history = await supabaseHistory(raw)
  if (HOSTED) assert.ok(history, 'hosted database must carry Supabase migration history')
  if (history) {
    assert.deepEqual([...history.keys()].sort(), files.map((f) => f.version))
    for (const f of files) assert.ok(pushedMatchesFile(history.get(f.version).statements, f.sql), `${f.file} pushed statements match the file`)
  }
})

test('calendars: 12 sourced drafts 2015-2026 and 12 sourced signing periods, disagreements kept with their resolution', async () => {
  const drafts = await rows(`select draft_year, start_date::text s, end_date::text e, total_rounds, source_id, rules_era_id from drafts where draft_kind = 'JUNE_AMATEUR' order by 1`)
  assert.deepEqual(drafts.map((d) => d.draft_year), [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
  for (const d of drafts) assert.ok(d.s && d.e && d.total_rounds && d.source_id && d.rules_era_id, `draft ${d.draft_year} fully sourced`)
  assert.deepEqual(drafts.map((d) => d.total_rounds), [40, 40, 40, 40, 40, 5, 20, 20, 20, 20, 20, 20])
  const periods = await rows('select period_key, start_date::text s, end_date::text e, source_id, rules_era_id from international_signing_periods order by start_date')
  assert.equal(periods.length, 12)
  for (const p of periods) assert.ok(p.s && p.e && p.source_id && p.rules_era_id, `period ${p.period_key} fully sourced`)
  assert.equal(periods.find((p) => p.period_key === '2019-20').e, '2020-10-15')
  assert.equal(periods.find((p) => p.period_key === '2020-21').s, '2021-01-15')
  assert.equal((await one("select international_period_for_date('2020-10-16') p")).p, null, 'no period covers the 2020-21 gap')
  const unsourcedFields = await one(`select count(*)::int n from drafts d cross join unnest(array['start_date','end_date','total_rounds']) f
    where not exists (select 1 from source_observations o where o.subject_table = 'drafts' and o.subject_id = d.id and o.field_name = f)`)
  assert.equal(unsourcedFields.n, 0, 'every draft date and round count has an observation')
  const res = await rows(`select subject_table, field_name, decided_by, rationale, cardinality(considered_observation_ids) k from fact_resolutions
    where decided_by = 'bai-research calendar review 2026-10-19' order by 1`)
  assert.equal(res.length, 2)
  for (const r of res) assert.ok(r.k >= 2 && r.rationale.length > 40, 'calendar resolution keeps every claim and a rationale')
  assert.equal((await one("select count(distinct observed_value)::int n from source_observations o join drafts d on o.subject_table = 'drafts' and o.subject_id = d.id where d.draft_year = 2019 and o.field_name = 'end_date'")).n, 2, 'the rejected 2019 end-date claim stays on record')
})

test('calendar seed is idempotent: re-running migration 015 inside a rolled-back transaction changes nothing', async () => {
  await isolated(async () => {
    const snap = () => one(`select (select md5(string_agg(row(d.*)::text, ',' order by id)) from drafts d) d, (select md5(string_agg(row(p.*)::text, ',' order by id)) from international_signing_periods p) p,
      (select count(*) from sources)::int s, (select count(*) from source_observations)::int o, (select count(*) from fact_resolutions)::int r, (select count(*) from rules_eras)::int e`)
    const before = await snap()
    await raw.query(listMigrations().find((m) => m.version === '015').sql)
    assert.deepEqual(await snap(), before)
  })
})

test('research-ingestion schema: private staging area, lifecycle enums, identity resolver, conflict rules', async () => {
  const t = await rows("select table_name from information_schema.tables where table_schema = 'ingest' order by 1")
  // 025 adds the historical-year release table; this suite also runs against hosted before 025 is deployed.
  const with025 = (await one("select to_regclass('research.history_exceptions') is not null as ok")).ok
  assert.deepEqual(t.map((r) => r.table_name), [...(with025 ? ['historical_releases'] : []), 'import_batches', 'staged_records', 'staged_sources'])
  assert.equal((await one("select enum_range(null::ingest.identity_match_state)::text r")).r, '{EXACT_EXTERNAL_ID,EXACT_COMPOSITE,PROBABLE_MATCH,AMBIGUOUS,NO_MATCH,CONFLICT}')
  assert.equal((await one("select enum_range(null::ingest.apply_action)::text r")).r, '{INSERT,UPDATE_UNKNOWN,CORROBORATE,NO_CHANGE,CONFLICT,HELD}')
  assert.equal((await one("select count(*)::int n from conflict_rules")).n, 8)
  assert.equal((await one("select count(*)::int n from conflict_rules where rule::text = 'LAST_WRITE_WINS'")).n, 0)
  assert.ok(!(await one("select enum_range(null::conflict_rule)::text r")).r.includes('LAST'), 'no last-write-wins rule exists')
})

test('source requirements: a source must be locatable; research sources need authority and a retrieved date', async () => {
  await isolated(async () => {
    await assert.rejects(raw.query("insert into sources (source_key, source_type, title) values ('verify:nowhere', 'NEWS_REPORT', 'No locator')"), /sources_locatable_check/)
  })
  await isolated(async () => {
    await assert.rejects(raw.query("insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) values (null, 'players', 1, 'birth_date', '\"2000-01-01\"')"), /null value|violates/)
  })
  assert.ok(validateSource({ source_key: 'x', source_type: 'NEWS_REPORT', title: 't', url: 'https://example.org' }).some((e) => /authority_level/.test(e)))
  assert.ok(validateSource({ source_key: 'x', source_type: 'NEWS_REPORT', authority_level: 'OTHER', title: 't', url: 'https://example.org' }).some((e) => /retrieved_date/.test(e)))
})

test('pipeline end to end (rolled back): dry run writes nothing canonical, apply is idempotent, conflicts are preserved, unknown is not zero', async () => {
  await isolated(async () => {
    const base = await canonical()
    const doc = { batch_key: 'verify-pipeline', channel: 'DRAFT', sources: [src('verify:official', 'OFFICIAL')], records: [pick(), pick({ overall_pick: 81, round_pick: 6, player: { full_name: 'Verifia Unknownbonus', external_ids: { MLBAM: '9800002' } }, signing: { status: 'SIGNED', bonus_usd: null, source_key: 'verify:official' } })] }
    const dry = await run(doc, { write: false })
    assert.equal(dry.report.step, 'dry-run')
    assert.deepEqual(dry.report.actions, { INSERT: 2 })
    assert.deepEqual(await canonical(), base, 'dry run wrote nothing canonical')
    const write = await P.applyBatch(db, 'verify-pipeline', { write: true })
    assert.deepEqual(write.report.actions, { INSERT: 2 })
    const after = await canonical()
    assert.equal(after.selections, base.selections + 2)
    const again = await P.applyBatch(db, 'verify-pipeline', { write: true })
    assert.deepEqual(again.report.actions, { NO_CHANGE: 2 })
    assert.deepEqual(await canonical(), after, 're-apply changes nothing')
    const bonus = await rows("select p.display_name, g.signing_bonus_usd from draft_signings g join draft_selections s on s.id = g.draft_selection_id join players p on p.id = s.player_id where p.display_name like 'Verifia%' order by 1")
    assert.deepEqual(bonus.map((b) => [b.display_name, b.signing_bonus_usd]), [['Verifia Fixture', '500000.00'], ['Verifia Unknownbonus', null]], 'unknown bonus stays NULL, never 0')
    // A second source disagreeing on the bonus: canonical value kept, both claims on record, conflict open.
    const rival = await run({ batch_key: 'verify-rival', channel: 'DRAFT', sources: [src('verify:blog', 'OTHER')], records: [pick({ source_key: 'verify:blog', signing: { status: 'SIGNED', bonus_usd: 450000, source_key: 'verify:blog' } })] })
    assert.equal(rival.results[0].action, 'CONFLICT')
    assert.equal((await one("select g.signing_bonus_usd::float8 b from draft_signings g join draft_selections s on s.id = g.draft_selection_id join players p on p.id = s.player_id where p.display_name = 'Verifia Fixture'")).b, 500000, 'no last-write-wins')
    // Only this fixture's conflict: the database may hold real open conflicts awaiting a reviewer.
    const fixture = (await one("select g.id from draft_signings g join draft_selections s on s.id = g.draft_selection_id join players p on p.id = s.player_id where p.display_name = 'Verifia Fixture'")).id
    const open = (await P.openConflicts(db)).filter((c) => c.subject_table === 'draft_signings' && c.field_name === 'signing_bonus_usd' && String(c.subject_id) === String(fixture))
    assert.equal(open.length, 1)
    assert.equal(open[0].observations.length, 2)
    assert.equal(open[0].rule_outcome, open[0].observations.find((o) => o.authority === 'OFFICIAL').observation_id, 'PREFER_HIGHER_AUTHORITY picks the strictly stronger source, but only when asked')
  })
})

test('unknown international cost stays unknown; a stated zero stays zero', async () => {
  await isolated(async () => {
    await run({ batch_key: 'verify-costs', channel: 'INTERNATIONAL', sources: [src('verify:official', 'OFFICIAL')], records: [
      { type: 'INTERNATIONAL_SIGNING', source_key: 'verify:official', organization: 'KC', signing_date: '2023-01-15', signing_date_precision: 'DAY', pathway: 'INTERNATIONAL_AMATEUR', player: { full_name: 'Verifia Nocost', external_ids: { MLBAM: '9800040' } }, costs: {} },
      { type: 'INTERNATIONAL_SIGNING', source_key: 'verify:official', organization: 'KC', signing_date: '2023-01-16', signing_date_precision: 'DAY', pathway: 'POSTING_SYSTEM', player: { full_name: 'Verifia Zerofee', external_ids: { MLBAM: '9800041' } }, costs: { signing_bonus_usd: 100000, posting_fee_usd: 0 } }] })
    const r = await rows("select p.display_name, s.known_total_cost_usd::float8 t, s.cost_completeness::text c, s.posting_fee_usd::float8 f from international_signings s join players p on p.id = s.player_id where p.display_name like 'Verifia%' order by 1")
    assert.deepEqual(r, [{ display_name: 'Verifia Nocost', t: null, c: 'UNKNOWN', f: null }, { display_name: 'Verifia Zerofee', t: 100000, c: 'PARTIAL', f: 0 }])
  })
})

test('identity matching: ids dominate, name + exact birth date links, name-only is never merged', async () => {
  await isolated(async () => {
    const ins = async (slug, name, dob, ids = {}) => {
      const p = await one("insert into players (slug, full_name, display_name, birth_date, birth_date_precision) values ($1, $2, $2, $3, case when $3::date is null then null else 'DAY'::date_precision end) returning id", [slug, name, dob])
      for (const [sys, v] of Object.entries(ids)) await raw.query("insert into player_external_ids (player_id, id_system, external_id) values ($1, $2, $3)", [p.id, sys, v])
      return p.id
    }
    await ins('verifia-alpha', 'Verifia Alpha', '1999-01-01', { MLBAM: '9800101' })
    await ins('verifia-twin-1', 'Verifia Twin', '1999-02-02')
    await ins('verifia-twin-2', 'Verifia Twin', '2000-03-03')
    await ins('verifia-solo', 'Verifia Solo', '2001-04-04')
    const state = async (p) => (await one('select state::text from ingest.resolve_identity($1::jsonb)', [JSON.stringify(p)])).state
    assert.equal(await state({ full_name: 'Totally Different Spelling', external_ids: { MLBAM: '9800101' } }), 'EXACT_EXTERNAL_ID')
    assert.equal(await state({ full_name: 'Verifia Solo', birth_date: '2001-04-04' }), 'EXACT_COMPOSITE')
    assert.equal(await state({ full_name: 'Verifia Solo' }), 'PROBABLE_MATCH')
    assert.equal(await state({ full_name: 'Verifia Twin' }), 'AMBIGUOUS')
    assert.equal(await state({ full_name: 'Verifia Alpha', external_ids: { MLBAM: '9800101', BBREF: 'someone-else' } }), 'EXACT_EXTERNAL_ID')
    await raw.query("insert into player_external_ids (player_id, id_system, external_id) select id, 'BBREF', 'verifalp01' from players where slug = 'verifia-alpha'")
    assert.equal(await state({ full_name: 'Verifia Alpha', external_ids: { MLBAM: '9800101', BBREF: 'someone-else' } }), 'CONFLICT')
    assert.equal(await state({ full_name: 'Nobody Here At All' }), 'NO_MATCH')
  })
})

test('summary refresh is validated and idempotent (rolled back: the stored generation does not advance)', async () => {
  await isolated(async () => {
    const g1 = Number((await one('select refresh_read_models() g')).g)
    const content = async () => (await rows('select * from rm_research_coverage order by domain, scope_key, organization_id')).map(({ generation_id, refreshed_at, ...r }) => JSON.stringify(r))
    const q = async () => (await rows('select queue_key, priority, open_items from rm_research_queue_summary order by queue_key')).map((r) => JSON.stringify(r))
    const [c1, q1] = [await content(), await q()]
    const g2 = Number((await one('select refresh_read_models() g')).g)
    assert.equal(g2, g1 + 1)
    assert.deepEqual(await content(), c1)
    assert.deepEqual(await q(), q1)
    const expectedCells = (await one("select ((select count(*) from drafts where draft_kind = 'JUNE_AMATEUR') + (select count(*) from international_signing_periods)) * (select count(*) from organizations where active) n")).n
    assert.equal(c1.length, Number(expectedCells))
  })
})

test('research queues: fixed priorities; the summary equals the internal queue', async () => {
  await isolated(async () => {
    await raw.query('select refresh_read_models()')
    const types = await rows('select queue_key, priority from research_queue_types order by priority, queue_key')
    assert.deepEqual(types.map((t) => `${t.priority}:${t.queue_key}`), ['1:IDENTITY_AMBIGUOUS', '1:SOURCE_CONFLICT', '2:CLASS_INCOMPLETE', '2:DRAFT_SIGNING_STATUS_UNKNOWN', '2:MISSING_SIGNING_DATE',
      '3:MISSING_COST', '3:MISSING_SIGNING_MARKET', '3:SCHOOL_UNRESOLVED', '4:OUTCOME_NOT_AUDITED', '5:MISSING_EXPECTATION'])
    const live = await rows('select t.queue_key, count(q.queue_key)::int n from research_queue_types t left join v_research_queue q on q.queue_key = t.queue_key group by 1')
    const summary = await rows('select queue_key, open_items from rm_research_queue_summary')
    for (const l of live) assert.equal(summary.find((s) => s.queue_key === l.queue_key).open_items, l.n, l.queue_key)
  })
})

test('coverage states: only census-level states support rates; census claims are sourced and whole; no rate without certification; partial never shown as complete', async () => {
  const states = await rows("select s::text state, coverage_supports_population_rate(s) ok from unnest(enum_range(null::coverage_state)) s order by 1")
  assert.deepEqual(states.filter((s) => s.ok).map((s) => s.state).sort(), ['COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE'])
  // Shared invariants (scripts/research/lib/integrity.mjs; tests/db/integrity.test.mjs proves each detects a violation).
  assert.deepEqual(await integrityViolations(raw), [])
})
