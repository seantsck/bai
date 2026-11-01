// Fresh migration replay, frozen checksums, convergent seeds and read-model refresh.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from './harness.mjs'
import { applyMigrations, listMigrations } from '../../scripts/db/lib/migrations.mjs'
import { numberingProblems } from '../../scripts/db/lib/migration-numbers.mjs'

before(async () => { await h.startServer() }, { timeout: 120000 })
after(async () => { await h.stopServer() })

test('migrations are numbered from 001, contiguous apart from the reserved 031, LF-only and wrapped by the runner', () => {
  const ms = listMigrations()
  assert.equal(ms[0].version, '001')
  assert.deepEqual(numberingProblems(ms.map((m) => m.version)), [])
  for (const m of ms) {
    assert.ok(!m.sql.includes('\r'), `${m.file} has CRLF`)
    assert.ok(!/^\s*(begin|commit)\s*;/im.test(m.sql), `${m.file} must not manage its own transaction`)
  }
})

test('fresh replay applies every migration; a second run is a no-op', async () => {
  const db = await h.freshDatabase({ migrate: false })
  const first = await applyMigrations(db)
  assert.equal(first.length, listMigrations().length)
  const objects = async () => h.one(db, `select
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public','analytics'))::int rels,
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')::int funcs,
      (select count(*) from organizations)::int orgs`)
  const before = await objects()
  assert.deepEqual(await applyMigrations(db), [])
  assert.deepEqual(await objects(), before)
  assert.equal(before.orgs, 30)
})

test('an applied migration that changes is refused (frozen)', async () => {
  const db = await h.freshDatabase()
  await db.query("update bai_meta.schema_migrations set checksum = 'tampered' where version = '001'")
  await assert.rejects(applyMigrations(db), /has changed \(frozen\)/)
})

test('seed sections converge: re-running the organization seed changes nothing', async () => {
  const db = await h.freshDatabase()
  const seed = listMigrations().find((m) => m.version === '002').sql
  const section = seed.slice(seed.indexOf('-- Seed:'))
  const snap = async () => h.one(db, `select (select string_agg(franchise_key || slug || mlb_team_id, ',' order by id) from organizations) o,
      (select string_agg(organization_id || name || coalesce(first_season, 0) || coalesce(last_season, 0), ',' order by id) from organization_names) n,
      (select count(*) from organization_aliases)::int a, (select count(*) from sources)::int s`)
  const before = await snap()
  await db.query(section)
  assert.deepEqual(await snap(), before)
})

test('read-model refresh is bounded, validated and convergent', async () => {
  const db = await h.freshDatabase({ fixtures: true })
  const g1 = Number((await h.one(db, 'select refresh_read_models() g')).g)
  const content = async () => h.rows(db, 'select * from rm_organization_summary order by organization_id').then((rs) => rs.map(({ generation_id, refreshed_at, ...r }) => r))
  const a = await content()
  const g2 = Number((await h.one(db, 'select refresh_read_models() g')).g)
  assert.equal(g2, g1 + 1)
  assert.deepEqual(await content(), a)
  assert.equal(a.length, 30)
  const ov = await h.one(db, 'select * from rm_overview')
  assert.equal(ov.organizations, 30)
  assert.equal(Number(ov.generation_id), g2)
  const lad = a.find((r) => r.franchise_key === 'LAD')
  assert.equal(lad.international_signings, 1)
  assert.equal(lad.draft_selections, 1)
  assert.equal(lad.not_audited, 1, 'unaudited acquisitions are reported as such, not as failures')
  assert.equal(lad.audited_no_mlb, 0)
})
