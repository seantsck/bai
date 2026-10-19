// Runs every public page query against a real PostgreSQL 17 with migrations + fixtures, through the same anon-role wrapper
// the app uses.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import * as h from '../db/harness.mjs'

let q, db, closePool, publicQuery, DatabaseUnavailableError

before(async () => {
  ;({ publicQuery, closePool, DatabaseUnavailableError } = await import('../../lib/db.ts'))
  delete process.env.BAI_DATABASE_URL
  delete process.env.BAI_PUBLIC_DATABASE_URL
  await assert.rejects(publicQuery('select 1'), DatabaseUnavailableError)
  await h.startServer()
  db = await h.freshDatabase({ fixtures: true })
  await db.query('select refresh_read_models()')
  process.env.BAI_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${db.port}/${db.database}`
  q = await import('../../lib/queries.ts')
}, { timeout: 120000 })

after(async () => { await closePool?.(); await h.stopServer() })

test('public queries run as anon in a read-only transaction', async () => {
  assert.deepEqual(await publicQuery('select current_user as u'), [{ u: 'anon' }])
  await assert.rejects(publicQuery("insert into players (slug, full_name, display_name) values ('x','x','x')"), /read-only transaction|permission denied/)
  await assert.rejects(publicQuery('select * from research_tasks'), /permission denied/)
})

test('overview and organization summaries come from read models', async () => {
  const ov = await q.getOverview()
  assert.equal(ov.organizations, 30)
  const orgs = await q.getOrganizationSummaries()
  assert.equal(orgs.length, 30)
})

test('organization detail: identity, history, acquisitions in both channels, coverage', async () => {
  const lad = await q.getOrganization('los-angeles-dodgers')
  assert.equal(lad.franchise_key, 'LAD')
  const acq = await q.getOrganizationAcquisitions(lad.id)
  assert.deepEqual(acq.map((a) => a.channel).sort(), ['DRAFT', 'INTERNATIONAL'])
  assert.equal((await q.getOrganizationCoverage(lad.id)).length, 2)
  const cle = await q.getOrganization('cleveland-guardians')
  assert.deepEqual(cle.names.map((n) => n.name), ['Cleveland Indians', 'Cleveland Guardians'])
  assert.equal(await q.getOrganization('no-such-team'), null)
})

test('player detail: outcome status, acquisitions, development', async () => {
  const p = await q.getPlayer('fixture-two-time-draftee')
  assert.equal(p.audit_state, 'ACTIVE_TOO_RECENT')
  assert.equal(p.career_bwar, null)
  assert.equal((await q.getPlayerAcquisitions(p.id)).length, 2)
  const arm = await q.getPlayer('fixture-college-arm')
  assert.equal(arm.debut_organization_slug, 'seattle-mariners')
  assert.equal((await q.getPlayerDevelopment(arm.id)).length, 3)
  assert.equal((await q.getPlayerExternalIds(arm.id)).length, 1)
})

test('list queries return bounded results', async () => {
  for (const [name, fn, min] of [
    ['players', q.getPlayers, 4], ['signings', q.getInternationalSignings, 1], ['periods', q.getSigningPeriods, 1], ['markets', q.getMarkets, 1],
    ['trainers', q.getTrainers, 0], ['academies', q.getAcademies, 0], ['picks', q.getDraftPicks, 3], ['drafts', q.getDrafts, 3],
    ['schools', q.getSchools, 2], ['coverage', q.getCoverageSummary, 2]
  ]) {
    const rows = await fn()
    assert.ok(rows.length >= min && rows.length <= 500, `${name}: ${rows.length}`)
  }
  const picks = await q.getDraftPicks()
  assert.ok(picks.some((p) => p.signing_status === 'DID_NOT_SIGN'))
})

test('coverage dashboard: one cell per calendar scope and organization, queue counts only', async () => {
  const cells = await q.getResearchCoverage()
  assert.equal(cells.length, (12 + 12) * 30, 'bounded by the calendar, not by research volume')
  const lad = cells.filter((c) => c.franchise_key === 'LAD' && c.tracked_records > 0).map((c) => [c.domain, c.scope_key, c.coverage_state]).sort()
  assert.deepEqual(lad, [['DRAFT', '2019-JUNE_AMATEUR', 'INDIVIDUALLY_VERIFIED'], ['INTERNATIONAL', '2019-20', 'RANKED_SAMPLE']])
  assert.ok(cells.every((c) => c.supports_population_rate === false), 'no fixture cell supports rates')
  const queues = await q.getResearchQueueSummary()
  assert.equal(queues.length, 10)
  assert.ok(queues.every((r) => Number.isInteger(r.open_items) && !('detail' in r)))
})
