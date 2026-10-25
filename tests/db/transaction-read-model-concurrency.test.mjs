// Concurrent refresh and revocation (migration 030), with independent sessions on one disposable PostgreSQL 17 database. FICTIONAL data.
// The invariant: no COMMITTED state exposes a withdrawn permission or an obsolete VERIFIED_COMPLETE claim.
//   * refresh first, writer second  -> the writer waits for the refresh to commit, then its withdrawal removes what the refresh published;
//   * writer first, refresh second  -> the refresh fails at once (55P03, nothing published) and succeeds, without the revoked rows, after the writer commits;
//   * the refresh never waits while holding a lock, so no cycle with a writer exists: no 40P01 appears in any ordering below.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import { refreshWithRetry } from '../../scripts/db/refresh-transaction-read-models.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let db, rv, R, W
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rmc-'))
before(async () => {
  await h.startServer(); db = await h.freshDatabase(); rv = await h.login(db, 'rmc_reviewer', { reviewer: true })
  R = await h.connect(db.database); W = await h.connect(db.database)
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

const RETRO = { source_key: 'hist:retrosheet-0123456789', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (fixture)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tran.txt', retrieved_date: '2026-10-22' }
const SECOND = { source_key: 'hist:wikipedia-2030-fixture-r1', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikipedia: fixture, revision 1', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=Fixture&oldid=1', retrieved_date: '2026-10-22' }
const pl = (n) => ({ full_name: `Concurrency Player ${n}`, external_ids: { MLBAM: String(9870000 + n) } })
const pk = (from, to, players, keys) => ({ from, to, source_keys: keys, players: players.map((p) => ({ player: p, source_keys: keys })), other_assets: [] })
let n = 0
async function trade (ref, date, decls, packages, ext, groups) {
  const doc = T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: `c-${ref}`, channel: 'TRADES', sources: decls, records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: groups[0].source_key, sources: groups, packages, external_ids: [{ scheme: 'TEST', id: ext, source_key: groups[0].source_key }] }] })
  const f = path.join(dir, `b-${++n}.json`); fs.writeFileSync(f, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, f, {}); assert.ok((await P.validateBatch(db, batch.id)).ok)
  await P.applyBatch(db, batch.id, { write: true })
  return Number((await h.one(db, 'select transaction_id id from transaction_external_ids where external_id = $1', [ext])).id)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const REFRESH = 'select public.refresh_transaction_read_models() g'
const GRANT = "insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', 'fixture: a person recorded the basis', 'fixture scope')"
/** Starts a statement and reports whether it is still waiting after a moment (and, from the server's side, that it waits on a lock). */
async function startBlocked (client, sql, params) {
  const p = client.query(sql, params).then(() => ({ ok: true }), (e) => ({ error: e }))
  await sleep(700)
  const state = await Promise.race([p.then(() => 'finished'), sleep(50).then(() => 'waiting')])
  const waits = await h.one(db, "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid = $1", [client.processID])
  return { p, state, onLock: waits.n === 1 }
}
const published = async (role) => h.asRole(db, role, async () => (await h.one(db, "select count(*)::int n, count(*) filter (where status = 'VERIFIED_COMPLETE')::int v from rm_transactions")))
const nothingPublished = async () => { for (const role of ['anon', 'authenticated']) assert.deepEqual(await published(role), { n: 0, v: 0 }, role) }
const rejectedWith = async (promise, code) => { try { await promise; assert.fail('expected a refusal') } catch (e) { assert.equal(e.code, code, e.message) } }
let tRetro, tVer

async function verify (tx) {
  const sources = await h.rows(db, 'select id from transaction_sources where transaction_id = $1', [tx])
  for (const s of sources) {
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_id) select $1, id from trade_packages where transaction_id = $2 on conflict do nothing', [s.id, tx])
    await db.query('insert into transaction_source_links (transaction_source_id, trade_package_asset_id) select $1, a.id from trade_package_assets a join trade_packages k on k.id = a.trade_package_id where k.transaction_id = $2 on conflict do nothing', [s.id, tx])
  }
  await rv.query('select * from research.verify_transaction($1, $2, $3)', [tx, 'checked both sources against each asset', 'a reference record and a separately written wire report'])
}
async function publishVerified () {
  // a verified, published transaction (the Retrosheet grant present)
  await db.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")
  await db.query(GRANT)
  if (await h.one(db, "select 1 ok from research.transaction_verifications where transaction_id = $1 and state = 'ACTIVE'", [tVer])) await rv.query('select * from research.revoke_transaction_verification($1, $2)', [tVer, 'reset'])
  await verify(tVer)
  await db.query(REFRESH)
  assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [tVer])).status, 'VERIFIED_COMPLETE')
}

test('setup: a Retrosheet trade and a trade verified against two independent sources', async () => {
  tRetro = await trade('c1', '2030-06-01', [RETRO], [pk('LAD', 'SEA', [pl(1)], [RETRO.source_key]), pk('SEA', 'LAD', [pl(2)], [RETRO.source_key])], 'C-1', [{ source_key: RETRO.source_key, role: 'REFERENCE', independence_group: 'g-retro' }])
  tVer = await trade('c2', '2030-06-04', [RETRO, SECOND], [pk('SD', 'SF', [pl(7)], [RETRO.source_key, SECOND.source_key]), pk('SF', 'SD', [pl(8)], [RETRO.source_key, SECOND.source_key])], 'C-2',
    [{ source_key: RETRO.source_key, role: 'PRIMARY_ANNOUNCEMENT', independence_group: 'g-retro' }, { source_key: SECOND.source_key, role: 'CORROBORATION', independence_group: 'g-wire' }])
  await rv.query("select * from research.enroll_reviewer('Concurrency Reviewer')")
  await rv.query("select * from research.set_certification_gate(true, 'isolated test database')")
  await db.query(GRANT)
})

test('grant withdrawal, refresh FIRST: the withdrawal waits for the refresh to commit, then removes everything the refresh published', async () => {
  await db.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'"); await db.query(GRANT); await db.query(REFRESH)
  await db.query("update ingest.source_publication_grants set scope_note = scope_note where false")
  await R.query('begin'); await R.query(REFRESH)                                                    // published inside R, uncommitted
  const w = await startBlocked(W, "delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")
  assert.deepEqual([w.state, w.onLock], ['waiting', true], 'the writer waits on the refresh\'s lock')
  await R.query('commit')
  assert.deepEqual(await w.p, { ok: true })
  await nothingPublished()                                                                          // the committed end state
})

test('grant withdrawal, writer FIRST: the refresh fails at once with 55P03 and publishes nothing; after the commit it publishes none of the withdrawn rows', async () => {
  await db.query(GRANT); await db.query(REFRESH)
  await W.query('begin'); await W.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")   // uncommitted
  assert.ok((await published('anon')).n >= 2, 'while the withdrawal is uncommitted, the committed grant still stands')
  await R.query('begin')
  const t0 = Date.now()
  await rejectedWith(R.query(REFRESH), '55P03')
  assert.ok(Date.now() - t0 < 2000, 'NOWAIT: it does not queue behind the writer')
  await R.query('rollback')
  await W.query('commit')
  await nothingPublished()
  await db.query(REFRESH)                                                                           // no grant: still nothing
  await nothingPublished()
  // the writer rolls back instead: the grant stands and the refresh publishes
  await db.query(GRANT)
  await W.query('begin'); await W.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'"); await W.query('rollback')
  await db.query(REFRESH)
  assert.ok((await published('anon')).n >= 2)
})

test('verification revocation, refresh FIRST: the revocation waits, then no VERIFIED_COMPLETE claim remains committed', async () => {
  await publishVerified()
  await R.query('begin'); await R.query(REFRESH)
  const w = await startBlocked(rv, 'select * from research.revoke_transaction_verification($1, $2)', [tVer, 'withdrawn during a refresh'])
  assert.deepEqual([w.state, w.onLock], ['waiting', true])
  await R.query('commit')
  assert.deepEqual(await w.p, { ok: true })
  for (const role of ['anon', 'authenticated']) assert.equal((await published(role)).v, 0, `${role}: no obsolete VERIFIED_COMPLETE`)
  assert.equal(await h.asRole(db, 'anon', async () => (await h.one(db, 'select count(*)::int n from rm_transactions where transaction_id = $1', [tVer])).n), 0)
})

test('verification revocation, writer FIRST: the refresh fails at once; after the commit it publishes the transaction as what it now is', async () => {
  await publishVerified()
  await rv.query('begin'); await rv.query('select * from research.revoke_transaction_verification($1, $2)', [tVer, 'revoked first'])
  await R.query('begin'); await rejectedWith(R.query(REFRESH), '55P03'); await R.query('rollback')
  assert.equal((await published('anon')).v, 1, 'uncommitted revocation: the committed verification still stands')
  await rv.query('commit')
  assert.equal((await published('anon')).v, 0, 'committed revocation: the claim is gone without any refresh')
  await db.query(REFRESH)
  assert.equal((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [tVer])).status, 'PARTIAL')
})

const edits = {
  'an asset': ["update trade_package_assets set description = 'edited' where trade_package_id in (select id from trade_packages where transaction_id = $1)"],
  'a source row': ["update sources set url = url || '?edition=2' where id = (select source_id from transactions where id = $1)"],
  'a source link': ["update transaction_sources set locator = 'p. 99' where transaction_id = $1 and role = 'CORROBORATION'"]
}
for (const [name, [sql]] of Object.entries(edits)) {
  test(`${name} modified while a refresh runs: refresh FIRST (the edit waits) and writer FIRST (the refresh fails at once); no obsolete VERIFIED_COMPLETE is ever committed`, async () => {
    // refresh first
    await publishVerified()
    await R.query('begin'); await R.query(REFRESH)
    const w = await startBlocked(W, sql, [tVer])
    assert.deepEqual([w.state, w.onLock], ['waiting', true], 'the edit waits for the refresh')
    await R.query('commit')
    assert.deepEqual(await w.p, { ok: true })
    assert.equal((await published('anon')).v, 0, 'the edit withdrew the claim the refresh had just published')
    assert.equal(await h.asRole(db, 'anon', async () => (await h.one(db, 'select count(*)::int n from rm_transactions where transaction_id = $1', [tVer])).n), 0)
    // writer first
    await db.query('select 1')
    await W.query('begin'); await W.query(sql, [tVer])
    await R.query('begin'); await rejectedWith(R.query(REFRESH), '55P03'); await R.query('rollback')
    await W.query('commit')
    await db.query(REFRESH)
    assert.notEqual((await h.one(db, 'select status from rm_transactions where transaction_id = $1', [tVer]))?.status, 'VERIFIED_COMPLETE', 'republished only as what it is now')
    assert.equal((await published('anon')).v, 0)
  })
}

test('lock orderings that could deadlock do not: a writer holding one locked table and wanting another never forms a cycle with the refresh (no 40P01)', async () => {
  await publishVerified()
  // the writer holds the verifications table, then wants the grants table; a waiting refresh would hold grants and wait for verifications
  await W.query('begin')
  await W.query("update research.transaction_verifications set state = 'REVOKED', revoked_at = now(), revoked_by = 'race test', revoked_reason = 'ordering test' where transaction_id = $1 and state = 'ACTIVE'", [tVer])
  await R.query('begin')
  await rejectedWith(R.query(REFRESH), '55P03')          // not a wait, so not a cycle
  await R.query('rollback')
  await W.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")   // the writer is free to proceed
  await W.query('commit')
  await nothingPublished()
  // the reverse: the refresh holds everything; the writer's FIRST statement waits, it holds nothing the refresh needs
  await db.query(GRANT)
  await R.query('begin'); await R.query(REFRESH)
  const w = await startBlocked(W, "delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")
  assert.equal(w.state, 'waiting')
  await R.query('commit'); assert.deepEqual(await w.p, { ok: true })
  await nothingPublished()
  const deadlocks = (await h.one(db, "select deadlocks from pg_stat_database where datname = current_database()")).deadlocks
  assert.equal(Number(deadlocks), 0, 'the server counted no deadlock in this database')
})

test('the operational refresh retries a lock that is not available and succeeds once the writer commits; other errors are not retried', async () => {
  await db.query(GRANT)
  const logs = []
  await W.query('begin'); await W.query("update ingest.source_publication_grants set scope_note = 'touched' where attribution_category = 'RETROSHEET'")   // a writer mid-transaction (fires the withdrawal)
  setTimeout(() => W.query('commit'), 1200)
  const c = await h.connect(db.database)
  const r = await refreshWithRetry(c, { attempts: 6, backoffMs: 300, log: (m) => logs.push(m) })
  assert.ok(r.attempts >= 2, `retried (${r.attempts} attempts)`); assert.ok(logs.every((m) => /55P03/.test(m) && /read model is unchanged/.test(m)))
  assert.ok((await published('anon')).n >= 2, 'published after the writer committed')
  // a real failure (wrong isolation level) is raised, not retried
  await c.query('begin isolation level repeatable read')
  await assert.rejects(c.query(REFRESH), /READ COMMITTED/)
  await c.query('rollback')
  let calls = 0
  const fake = { query: async (sql) => { if (/refresh_transaction/.test(sql)) { calls++; const e = new Error('boom'); e.code = '22012'; throw e } } }
  await assert.rejects(refreshWithRetry(fake, { attempts: 5, backoffMs: 1 }), /boom/); assert.equal(calls, 1)
  let k = 0
  const flaky = { query: async (sql) => { if (/refresh_transaction/.test(sql)) { if (++k < 3) { const e = new Error('deadlock detected'); e.code = '40P01'; throw e } return { rows: [{ g: 7 }] } } return { rows: [] } } }
  assert.deepEqual(await refreshWithRetry(flaky, { attempts: 5, backoffMs: 1 }), { generation: 7, attempts: 3 })
  await assert.rejects(refreshWithRetry({ query: async (sql) => { if (/refresh_transaction/.test(sql)) { const e = new Error('lock'); e.code = '55P03'; throw e } } }, { attempts: 2, backoffMs: 1 }), /lock/, 'gives up after the attempts, loudly')
})

test('the command-line refresh runs end to end against this database', async () => {
  const { port, database } = db.connectionParameters
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['scripts/db/refresh-transaction-read-models.mjs'], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME, BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}` } })
    let o = ''; p.stdout.on('data', (d) => { o += d }); p.stderr.on('data', (d) => { o += d }); p.on('close', (code) => resolve({ code, o }))
  })
  assert.equal(out.code, 0, out.o); assert.match(out.o, /generation \d+ \(attempt 1\): \d+ transactions published, \d+ withheld by permission, 0 verified complete/)
})
