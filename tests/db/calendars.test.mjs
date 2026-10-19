// Sourced reference calendars (015): Rule 4 drafts 2015-2026 and international signing periods 2014-15 through 2026.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'

let db
before(async () => { await h.startServer(); db = await h.freshDatabase() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('draft dates and rounds for 2015-2026, including the 2020 and 2021 changes', async () => {
  const r = await h.rows(db, `select draft_year, start_date::text s, end_date::text e, total_rounds, re.rules_era_key era
    from drafts d join rules_eras re on re.id = d.rules_era_id where draft_kind = 'JUNE_AMATEUR' order by draft_year`)
  assert.deepEqual(r.map((d) => d.draft_year), [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026])
  const by = Object.fromEntries(r.map((d) => [d.draft_year, d]))
  assert.deepEqual([by[2015].s, by[2015].e, by[2015].total_rounds], ['2015-06-08', '2015-06-10', 40])
  assert.deepEqual([by[2020].s, by[2020].e, by[2020].total_rounds], ['2020-06-10', '2020-06-11', 5])
  assert.deepEqual([by[2021].s, by[2021].e, by[2021].total_rounds], ['2021-07-11', '2021-07-13', 20])
  assert.deepEqual([by[2026].s, by[2026].e, by[2026].total_rounds], ['2026-07-11', '2026-07-12', 20])
  assert.deepEqual([by[2016].era, by[2017].era, by[2022].era], ['DRAFT_CBA_2012_2016', 'DRAFT_CBA_2017_2021', 'DRAFT_CBA_2022_2026'])
  for (const d of r) assert.ok(d.e >= d.s && d.s.startsWith(String(d.draft_year)))
})

test('international periods are date ranges with the pandemic shift, not calendar years', async () => {
  const r = await h.rows(db, 'select period_key, start_date::text s, end_date::text e from international_signing_periods order by start_date')
  assert.deepEqual(r.map((p) => p.period_key), ['2014-15', '2015-16', '2016-17', '2017-18', '2018-19', '2019-20', '2020-21', '2022', '2023', '2024', '2025', '2026'])
  const by = Object.fromEntries(r.map((p) => [p.period_key, p]))
  assert.deepEqual([by['2015-16'].s, by['2015-16'].e], ['2015-07-02', '2016-06-15'])
  assert.deepEqual([by['2019-20'].s, by['2019-20'].e], ['2019-07-02', '2020-10-15'], '2019-20 extended to Oct 15, 2020')
  assert.deepEqual([by['2020-21'].s, by['2020-21'].e], ['2021-01-15', '2021-12-15'], '2020-21 opened Jan 15, 2021')
  assert.deepEqual([by['2026'].s, by['2026'].e], ['2026-01-15', '2026-12-15'])
  const at = async (d) => (await h.one(db, 'select ip.period_key from international_signing_periods ip where ip.id = international_period_for_date($1)', [d]))?.period_key ?? null
  assert.equal(await at('2016-06-15'), '2015-16', 'end day inclusive')
  assert.equal(await at('2016-06-16'), null, 'pre-pandemic closed window June 16 - July 1')
  assert.equal(await at('2016-07-02'), '2016-17')
  assert.equal(await at('2020-06-16'), '2019-20', 'inside the extension')
  assert.equal(await at('2020-12-01'), null, 'no period between Oct 16, 2020 and Jan 14, 2021')
  assert.equal(await at('2021-12-16'), null)
  assert.equal(await at('2022-01-15'), '2022')
})

test('every calendar row cites a source and its dates are backed by observations', async () => {
  const missing = await h.rows(db, `select 'drafts' t, draft_key k from drafts d where not exists (select 1 from source_observations o where o.subject_table = 'drafts' and o.subject_id = d.id and o.field_name = 'start_date')
    union all select 'periods', period_key from international_signing_periods p where not exists (select 1 from source_observations o where o.subject_table = 'international_signing_periods' and o.subject_id = p.id and o.field_name = 'start_date')`)
  assert.deepEqual(missing, [])
  const authorities = await h.rows(db, "select distinct s.authority_level::text a from sources s where s.source_key like 'cal:%' order by 1")
  assert.ok(authorities.some((a) => a.a === 'OFFICIAL'))
  const notes = await h.one(db, "select count(*)::int n from sources where source_key like 'cal:%' and (url is null or retrieved_date is null)")
  assert.equal(notes.n, 0)
})

test('recorded calendar disagreements are kept as evidence and resolved with a rationale', async () => {
  const r = await h.rows(db, `select f.subject_table, f.field_name, o.observed_value #>> '{}' chosen, cardinality(f.considered_observation_ids) n, f.rationale
    from fact_resolutions f join source_observations o on o.id = f.chosen_observation_id order by 1`)
  assert.deepEqual(r.map((x) => [x.subject_table, x.chosen]), [['drafts', '2019-06-05'], ['international_signing_periods', '2019-06-15']])
  for (const x of r) { assert.ok(x.n >= 2); assert.ok(x.rationale.length > 20) }
  assert.equal((await h.one(db, "select count(*)::int n from v_open_fact_conflicts where subject_table in ('drafts', 'international_signing_periods')")).n, 0)
  assert.equal((await h.one(db, "select count(*)::int n from source_observations o join international_signing_periods p on p.id = o.subject_id where o.subject_table = 'international_signing_periods' and p.period_key = '2018-19' and o.observed_value = '\"2019-06-25\"'")).n, 1, 'the rejected claim stays on record')
})

test('the calendar seed converges: re-running 015 adds nothing', async () => {
  const before = await h.one(db, 'select (select count(*) from sources)::int s, (select count(*) from source_observations)::int o, (select count(*) from fact_resolutions)::int f')
  const fs = await import('node:fs')
  await db.query(fs.readFileSync(new URL('../../database/migrations/015_reference_calendars.sql', import.meta.url), 'utf8'))
  assert.deepEqual(await h.one(db, 'select (select count(*) from sources)::int s, (select count(*) from source_observations)::int o, (select count(*) from fact_resolutions)::int f'), before)
})
