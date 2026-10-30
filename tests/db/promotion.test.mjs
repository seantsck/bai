// Off-hosted staging and atomic promotion (migration 032): the 65-check G5-3C local proof as repository tests, with the owner's G5-4 decisions (the transaction_date evidence is withheld,
// the verbatim statement is in the source metadata, the emergency procedure). One disposable cluster; a small fictional sample stands in for the hosted database and the six pinned batches.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { runSecurityAudit } from '../../scripts/db/lib/security-audit.mjs'
import { SESSION_SQL, buildPackage, computeDelta, dependents, emergencyWithdraw, finishWithdrawal, loadPackage, promote, promoteOnce, revertEmergency, sha256, statusOf, verifyPackage, withdraw, writePackage } from '../../scripts/db/lib/promotion.mjs'
import { GRANT, MLB, RETRO, buildBaseline, importSample } from './promotion-fixture.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g54-'))
const MAIN = 'g54_main'
let admin, main, PORT, batches
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const connect = (name) => open(name)
const rows = (c, sql, p) => h.rows(c, sql, p)
const refused = async (p) => p.then(() => null, (e) => e.message)
const anonRels = async () => (await rows(main, "select c.relname r from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, 'SELECT') order by 1")).map((x) => x.r)
const scopeFp = async () => { const o = {}; for (const t of (await rows(main, 'select unnest(ingest.promotion_scope()) t')).map((r) => r.t)) o[t] = JSON.stringify((await rows(main, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f); return o }
const refreshAll = async () => { await main.query('select public.refresh_read_models()'); await main.query('select public.refresh_transaction_read_models()') }
const rmSummary = async () => ({
  overview: (await rows(main, 'select to_jsonb(o) - $1::text[] j from rm_overview o', [['refreshed_at', 'generation_id']])).map((r) => r.j),
  coverage: (await rows(main, 'select count(*)::int n, coalesce(sum(tracked_count), 0)::int s from rm_coverage_summary'))[0],
  org: (await rows(main, 'select count(*)::int n from rm_organization_summary'))[0],
  queue: (await rows(main, "select md5(coalesce(string_agg(x, '' order by x), '')) m from (select (to_jsonb(q) - $1::text[])::text x from rm_research_queue_summary q) s", [['refreshed_at', 'generation_id']]))[0].m,
  tx: (await rows(main, 'select transactions, withheld_unauthorized from rm_transaction_overview'))[0] ?? null
})
let GRANT_ROW, MLB_OBS
// records the grant again exactly as it was (every column), so that a later comparison with the baseline is byte for byte
const restoreGrant = () => main.query('insert into ingest.source_publication_grants select * from jsonb_populate_record(null::ingest.source_publication_grants, $1::jsonb) on conflict do nothing', [JSON.stringify(GRANT_ROW)])
const pageQueries = (role) => {
  const r = spawnSync(process.execPath, ['--import', './tests/support/register-ts.mjs', 'tests/support/page-queries.mjs'], { cwd: root, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.homedir(), BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/${MAIN}`, ...(role ? { BAI_PUBLIC_ROLE: role } : {}) } })
  try { return JSON.parse(r.stdout.trim().split('\n').pop()) } catch { return { error: (r.stderr || r.stdout).slice(0, 400) } }
}
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k])
const config = (extra = {}) => ({ category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
  attribution: { evidence_sha256: sha256('live attribution pages verified (fixture evidence)'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture-tranDB.zip', sha256: sha256('fixture archive') }, expectBatches: batches, ...extra })
let BASE_FP, BASE_RM, anonBefore, ANON_AFTER, attrBefore, W0, exId, exRowHash, exIdsBefore, PK = {}

before(async () => {
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN); PORT = main.port
  await applyMigrations(main, { through: '030' })
  await main.query("alter role bai_web login password 'webpw'")       // the role exists since 016 (NOINHERIT, member of anon); only the password is set here
  await buildBaseline(main, dir)
  anonBefore = await anonRels(); attrBefore = await rows(main, 'select attribution_category, domain, records, sources from v_source_attribution order by 1, 2')
  W0 = pageQueries(null)
  await applyMigrations(main)                                          // 032 is the only migration left to apply
  exId = Number((await rows(main, "select id from players where slug = 'g54-existing'"))[0].id)
  exRowHash = (await rows(main, 'select md5(p::text) h from players p where id = $1', [exId]))[0].h; exIdsBefore = (await rows(main, 'select count(*)::int n from player_external_ids where player_id = $1', [exId]))[0].n
  BASE_FP = await scopeFp(); BASE_RM = await rmSummary()
  GRANT_ROW = (await rows(main, "select to_jsonb(g) j from ingest.source_publication_grants g where attribution_category = 'RETROSHEET'"))[0].j
  MLB_OBS = (await rows(main, "select count(*)::int n from source_observations where subject_table = 'transactions' and field_name = 'transaction_date' and source_id = (select id from sources where source_key = $1)", [MLB.source_key]))[0].n
  await main.end()
  for (const n of ['a', 'b', 'c', 'd', 'bad']) await admin.query(`create database g54_stage_${n} template ${MAIN}`)
  for (const n of ['a', 'b', 'c', 'd', 'bad']) { const s = await open(`g54_stage_${n}`); batches = await importSample(s, dir); if (n === 'bad') await s.query(`update source_observations set status = 'SUPERSEDED', superseded_by_id = (select max(id) from source_observations where subject_table = 'transactions' and field_name = 'transaction_date') where id = (select min(id) from source_observations where subject_table = 'players' and field_name = 'full_name' and source_id = (select id from sources where source_key = $1))`, [RETRO.source_key]); await s.end() }
  main = await open(MAIN)
}, { timeout: 180000 })
after(async () => { await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('032 on the baseline: the site role reads the transaction read models; anon and authenticated lose exactly those; every existing page query is unchanged', async () => {
  const after = await anonRels(); ANON_AFTER = after; const lost = anonBefore.filter((x) => !after.includes(x))
  const rm = (await rows(main, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'rm\\_transaction%' order by 1")).map((r) => r.relname)
  assert.equal(rm.length, 12, 'there are 12 rm_transaction* tables')
  assert.deepEqual(lost.sort(), rm.filter((t) => !['rm_transaction_refreshes', 'rm_transaction_withdrawals'].includes(t)).sort(), 'the ten anon could read are closed; the two already closed stay closed')
  assert.deepEqual(after.filter((x) => !anonBefore.includes(x)), ['v_transaction_record_sources'], 'the only new public relation is the attribution aggregate')
  assert.deepEqual(await rows(main, 'select attribution_category, domain, records, sources from v_source_attribution order by 1, 2'), attrBefore, 'v_source_attribution is unchanged in content')
  for (const role of ['anon', 'authenticated']) for (const t of rm) await assert.rejects(h.asRole(main, role, () => main.query(`select 1 from ${t} limit 1`)), /permission denied/, `${role}: ${t}`)
  await h.asRole(main, 'bai_site', async () => { for (const t of rm.filter((x) => !['rm_transaction_refreshes', 'rm_transaction_withdrawals'].includes(x))) await main.query(`select 1 from ${t} limit 1`) })
  const W1 = pageQueries('bai_site'); const W1a = pageQueries(null)
  assert.ok(Object.keys(W0).length > 10 && !Object.values(W0).some((v) => String(v).startsWith('ERR')), `baseline page queries run: ${JSON.stringify(W0).slice(0, 200)}`)
  assert.deepEqual(diffKeys(W0, W1), [], 'BAI_PUBLIC_ROLE=bai_site: every page query returns what it did before, with no code change')
  const broken = diffKeys(W0, W1a); assert.ok(broken.length > 0 && broken.every((k) => /^getTransaction/.test(k) && String(W1a[k]).startsWith('ERR')), `the old role cannot read the transaction pages: ${broken}`)
  const dep = await rows(main, `select distinct v.relname from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class join pg_class t on t.oid = d.refobjid where d.classid = 'pg_rewrite'::regclass and t.relname like 'rm\\_transaction%' and v.relkind = 'v'`)
  assert.deepEqual(dep.map((r) => r.relname), ['v_transaction_record_sources'], 'no other public view depends on the closed tables')
})

test('the fingerprint is independent of the database collation: it equals a byte-order recomputation outside the database', async () => {
  for (const t of ['public.players', 'public.sources', 'ingest.import_batches']) {
    const hs = (await rows(main, `select md5(x::text) h from ${t} x`)).map((r) => r.h).sort()   // code-unit order = the "C" collation for hex digits
    const fp = (await rows(main, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
    assert.equal(fp.md5, crypto.createHash('md5').update(hs.join('')).digest('hex'), t); assert.equal(fp.n, hs.length)
  }
  const scope = (await rows(main, 'select unnest(ingest.promotion_scope()) t')).map((r) => r.t)
  assert.deepEqual(scope, [...scope].sort(), 'the scope list is in byte order as well')
})

test('the site role is a read-only member of anon: no login, no bypass, no write, nothing private; bai_web can only SET ROLE to it', async () => {
  const r = (await rows(main, "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication from pg_roles where rolname = 'bai_site'"))[0]
  assert.deepEqual(Object.values(r), [false, false, false, false, false, false])
  assert.equal((await rows(main, "select count(*)::int n from pg_class c where c.relkind in ('r','p','v') and c.relnamespace::regnamespace::text in ('public','ingest','research','analytics','bai_meta') and (has_table_privilege('bai_site', c.oid, 'INSERT') or has_table_privilege('bai_site', c.oid, 'UPDATE') or has_table_privilege('bai_site', c.oid, 'DELETE') or has_table_privilege('bai_site', c.oid, 'TRUNCATE'))"))[0].n, 0)
  assert.equal((await rows(main, "select count(*)::int n from pg_class c where c.relkind in ('r','p','v') and c.relnamespace::regnamespace::text in ('ingest','research','analytics','bai_meta') and has_table_privilege('bai_site', c.oid, 'SELECT')"))[0].n, 0, 'no private schema is readable')
  const web = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'bai_web', password: 'webpw', database: MAIN }); await web.connect()
  try {
    await web.query('begin read only'); await web.query('set local role bai_site'); await web.query('select count(*) from rm_transaction_overview')
    assert.match(await refused(web.query("insert into players (slug, full_name, display_name) values ('x', 'x', 'x')")), /permission denied|read-only/); await web.query('rollback')
    await web.query('begin read only'); assert.match(await refused(web.query('set local role postgres')), /permission denied|must be member/); await web.query('rollback')
    await web.query('begin read only'); assert.match(await refused(web.query('select 1 from rm_transaction_overview')), /does not exist|permission denied/, 'without SET ROLE bai_web still reads nothing'); await web.query('rollback')
  } finally { await web.end() }
  const audit = await runSecurityAudit(main, { readOnly: false, localDb: true })
  assert.deepEqual(audit.failures, [], 'the security audit (amended for bai_site and the declared owner-rights view) passes')
  assert.ok(audit.notes.some((n) => /owner-rights view public\.v_transaction_record_sources reads only/.test(n)))
})

test('the owner-rights aggregate view shows counts of displayed record sources and nothing else, and empties with the read model', async () => {
  const cols = (await rows(main, "select column_name from information_schema.columns where table_name = 'v_transaction_record_sources' order by ordinal_position")).map((r) => r.column_name)
  assert.deepEqual(cols, ['attribution_category', 'records', 'sources'])
  assert.equal((await rows(main, 'select count(*)::int n from v_transaction_record_sources'))[0].n, 0, 'nothing is displayed before any promotion')
})

test('staging is insert-only and repeatable: two local imports from one baseline give the same delta; the manifest pins one concrete staged delta', async () => {
  const a = await open('g54_stage_a'); const b = await open('g54_stage_b')
  try {
    const da = await computeDelta(main, a); const db = await computeDelta(main, b)
    assert.deepEqual(da.problems, []); assert.deepEqual(db.problems, [])
    const ma = await computeDelta(main, a, { masked: true }); const mb = await computeDelta(main, b, { masked: true })
    assert.deepEqual(Object.fromEntries(Object.entries(ma.delta).map(([t, v]) => [t, v.hashes])), Object.fromEntries(Object.entries(mb.delta).map(([t, v]) => [t, v.hashes])), 'same rows and ids, ignoring recorded timestamps and the random player_key UUIDs')
    assert.notDeepEqual(Object.values(da.delta).map((v) => v.hashes), Object.values(db.delta).map((v) => v.hashes), 'with those included the two stagings differ, which is why a manifest pins one staged delta')
    const ids = da.delta['public.player_external_ids'].rows.filter((r) => Number(r.player_id) === exId)
    assert.equal(ids.length, 2, 'the existing player gets two new ids'); assert.ok(!(da.delta['public.players'].rows.some((r) => Number(r.id) === exId)), 'and its own row is not part of the delta')
  } finally { await a.end(); await b.end() }
})

test('the package: exclusions are only the owner\'s rule, the statement is in the source metadata, the manifest pins everything, and a changed or wrongly pinned package is refused', async () => {
  const pkg = await buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_a', config: config(), outDir: path.join(dir, 'pkg-a') }); PK.a = pkg
  const m = pkg.manifest
  assert.equal(m.exclusions.length, 1); assert.equal(m.exclusions[0].table, 'public.source_observations')
  const nExcl = m.exclusions[0].n; assert.ok(nExcl >= 2, 'the Retrosheet transaction_date observations are withheld')
  assert.ok(!('public.source_observations' in m.delta) || m.delta['public.source_observations'].n > 0)
  const promotedObs = JSON.parse(pkg.payload['public.source_observations']); assert.ok(promotedObs.every((o) => !(o.subject_table === 'transactions' && o.field_name === 'transaction_date')), 'none of them is in the public payload')
  assert.equal(sha256(pkg.withheld['public.source_observations']), m.exclusions[0].rows_sha256, 'their evidence is preserved, with a hash')
  assert.equal(JSON.parse(pkg.withheld['public.source_observations']).length, nExcl)
  assert.equal(m.exclusion_rules[0].n, nExcl)
  const src = JSON.parse(pkg.payload['public.sources']); assert.equal(src.length, 1); assert.ok(src[0].notes.includes('The information used here was obtained free of charge from and is copyrighted by Retrosheet'), 'the verbatim statement is in the source metadata')
  assert.equal(m.annotations[0].rows, 1)
  assert.deepEqual(m.batches.map((b) => b.sha256).sort(), batches.map((b) => b.sha256).sort(), 'the manifest pins exactly the staged batch files')
  assert.deepEqual(verifyPackage(path.join(dir, 'pkg-a')), [])
  assert.equal(loadPackage(path.join(dir, 'pkg-a')).sha, pkg.sha)
  fs.appendFileSync(path.join(dir, 'pkg-a', 'payload', 'public__players.json'), ' ')
  assert.match(verifyPackage(path.join(dir, 'pkg-a')).join(), /public__players.json does not match/); writePackage(path.join(dir, 'pkg-a'), pkg); assert.deepEqual(verifyPackage(path.join(dir, 'pkg-a')), [])
  await assert.rejects(buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_b', config: config({ expectBatches: batches.slice(1) }) }), /not the pinned batches/)
  await assert.rejects(buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_bad', config: config() }), /breaks integrity/, 'excluding evidence that other promoted rows refer to is refused, never silently dropped')
  assert.equal(JSON.parse(pkg.payload['ingest.import_batches']).length, 3)
  assert.ok(!(await rows(admin, "select 1 from pg_database where datname like 'g54_stage_%_release'")).length, 'the release candidates are dropped')
})

test('refused before any change: lapsed or future authorization, another grant text, a different statement, stale or missing attribution evidence, a different schema level, an unknown format, no grant', async () => {
  const m1 = PK.a.manifest
  const attempt = async (mod, re, label) => { const m = mod(structuredClone(m1)); const c = await open(MAIN); await c.query('begin'); const e = await refused(c.query('select ingest.promote_begin($1)', [JSON.stringify(m)])); await c.query('rollback'); await c.end(); assert.match(e ?? 'NOT REFUSED', re, label) }
  await attempt((m) => { m.authorization.expires_on = '2026-10-01'; return m }, /authorization window/, 'lapsed')
  await attempt((m) => { m.authorization.effective_from = '2027-12-01'; m.authorization.expires_on = '2028-01-01'; return m }, /authorization window/, 'not yet effective')
  await attempt((m) => { m.authorization.grant_binding_sha256 = sha256('other'); return m }, /grant on this database/, 'other grant text')
  await attempt((m) => { m.attribution.statement_sha256 = sha256('other'); return m }, /attribution statement differs/, 'other statement')
  await attempt((m) => { m.attribution.verified_at = new Date(Date.now() - 100 * 3600e3).toISOString(); return m }, /stale/, 'stale evidence')
  await attempt((m) => { m.attribution.evidence_sha256 = 'x'; return m }, /no attribution evidence/, 'no evidence')
  await attempt((m) => { m.migrations['001'] = 'f'.repeat(64); return m }, /migration level/, 'schema level')
  await attempt((m) => { m.format = 'x'; return m }, /unknown manifest format/, 'format')
  const c = await open(MAIN); await c.query('begin'); await c.query("select set_config('bai.promotion_withdrawal', 'test', true)"); await c.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")
  assert.match(await refused(c.query('select ingest.promote_begin($1)', [PK.a.manifestText])), /no publication grant/); await c.query('rollback'); await c.end()
})

test('drift: one extra baseline row blocks promotion and names the table; a concurrent writer is blocked while the locks are held, readers are not', async () => {
  await main.query("insert into players (slug, full_name, display_name) values ('g54-drift', 'Drift', 'Drift')")
  await main.query('begin'); assert.match(await refused(main.query('select ingest.promote_begin($1)', [PK.a.manifestText])), /DRIFT: public\.players changed/); await main.query('rollback')
  await main.query("delete from players where slug = 'g54-drift'")
  assert.deepEqual(await scopeFp(), BASE_FP, 'the baseline is exactly the baseline again')
  const a = await open(MAIN); await a.query('begin'); await a.query('select ingest.promote_begin($1)', [PK.a.manifestText])
  const b = await open(MAIN); await b.query("set lock_timeout = '1500ms'")
  assert.match(await refused(b.query("insert into players (slug, full_name, display_name) values ('g54-concurrent', 'C', 'C')")), /lock timeout|could not obtain lock/)
  assert.equal((await rows(b, 'select count(*)::int n from players'))[0].n, Number(PK.a.manifest.baseline.fingerprints['public.players'].n), 'readers see the baseline')
  await a.query('rollback'); await a.end(); await b.end()
})

test('failures leave nothing: a rejected bulk load late in the order, a payload that disagrees with the manifest, a killed connection, a load outside a promotion', async () => {
  const none = async (label) => { assert.deepEqual(await scopeFp(), BASE_FP, label); assert.equal((await rows(main, 'select (select count(*) from ingest.promotion_events)::int e, (select count(*) from ingest.promotion_manifests)::int m, (select count(*) from ingest.promotion_ledger)::int l'))[0].e, 0, label) }
  const fkCol = (r) => ['transaction_id', 'source_id', 'batch_id', 'player_id'].find((k) => k in r[0])
  const late = [...PK.a.manifest.load_order].reverse().find((t) => fkCol(JSON.parse(PK.a.payload[t])))
  assert.ok(PK.a.manifest.load_order.indexOf(late) >= PK.a.manifest.load_order.length - 3, `the fault is injected late (${late})`)
  let c = await open(MAIN)
  assert.match(await refused(promoteOnce(c, PK.a, { tamper: (t, r) => t === late ? r.map((x, i) => (i === 0 ? { ...x, [fkCol(r)]: 99999999 } : x)) : r })), /violates foreign key/); await c.end(); await none('rejected bulk load')
  c = await open(MAIN); assert.match(await refused(promoteOnce(c, PK.a, { tamper: (t, r) => t === 'public.player_external_ids' ? r.slice(1) : r })), /manifest says/); await c.end(); await none('short payload')
  c = await open(MAIN); assert.match(await refused(promoteOnce(c, PK.a, { tamper: (t, r) => t === 'public.sources' ? r.map((x) => ({ ...x, notes: 'no credit' })) : r })), /does not match the staged state|attribution statement/); await c.end(); await none('source without the statement')
  c = await open(MAIN); assert.match(await refused(promoteOnce(c, PK.a, { beforeLoad: async (cl, t, i) => { if (i === 4) { cl.connection.stream.destroy(); await new Promise((r) => setTimeout(r, 300)) } } })), /terminated|ECONN|closed|reset|socket|Connection/i); await c.end().catch(() => {})
  await new Promise((r) => setTimeout(r, 500)); await none('killed connection')
  c = await open(MAIN); assert.match(await refused(c.query('select ingest.promote_load($1, $2::jsonb)', ['public.players', '[]'])), /no promotion is open/); await c.end()
  c = await open(MAIN); await c.query('begin'); assert.match(await refused(c.query('select ingest.promote_withhold($1, $2)', ['public.source_observations', '[]'])), /no promotion is open/); await c.query('rollback'); await c.end()
})

test('promotion 1: the lost acknowledgement is resolved by the ledger, a duplicate is a no-op, the database equals the staged release state, the existing player is intact', async () => {
  const r = await promote({ connect, name: MAIN, pkg: PK.a, hooks: { afterCommit: async () => { throw new Error('connection reset after COMMIT was sent (acknowledgement lost)') } } })
  assert.match(r.result, /confirmed after reconnect/); assert.deepEqual(r.log.map((x) => x.replace(/:.*/, '')).slice(0, 2), ['attempt 1', 'state after reconnect'])
  assert.equal((await rows(main, 'select count(*)::int n from ingest.promotion_events where manifest_sha256 = $1 and event = $2', [PK.a.sha, 'PROMOTED']))[0].n, 1)
  const want = Object.fromEntries(Object.entries(PK.a.manifest.baseline.fingerprints).map(([t, v]) => [t, JSON.stringify(PK.a.manifest.after[t] ?? v)]))
  assert.deepEqual(await scopeFp(), want, 'every table equals the staged release state')
  const counts = async () => Object.fromEntries(await Promise.all(Object.keys(PK.a.manifest.delta).map(async (t) => [t, (await rows(main, `select count(*)::int n from ${t}`))[0].n])))
  const c1 = await counts(); const dup = await promote({ connect, name: MAIN, pkg: PK.a }); assert.equal(dup.result, 'ALREADY_PROMOTED'); assert.deepEqual(await counts(), c1)
  const second = await open(MAIN); assert.match(await refused(promoteOnce(second, { ...PK.a, manifestText: PK.a.manifestText + ' ', sha: 'x' })), /DRIFT/, 'a different manifest cannot be promoted over this one'); await second.end()
  assert.equal((await rows(main, 'select sum(n)::int n from ingest.promotion_ledger where manifest_sha256 = $1', [PK.a.sha]))[0].n, Object.values(PK.a.manifest.delta).reduce((a, d) => a + d.n, 0), 'the ledger names exactly the promoted rows')
  assert.equal((await rows(main, 'select md5(p::text) h from players p where id = $1', [exId]))[0].h, exRowHash, 'the existing player row is untouched')
  assert.equal((await rows(main, 'select count(*)::int n from player_external_ids where player_id = $1', [exId]))[0].n, exIdsBefore + 2)
  const w = (await rows(main, 'select n, rows_sha256 from ingest.promotion_withheld_rows where manifest_sha256 = $1', [PK.a.sha]))[0]; assert.equal(w.rows_sha256, PK.a.manifest.exclusions[0].rows_sha256, 'the withheld evidence is stored privately with its hash')
  assert.equal((await rows(main, "select count(*)::int n from source_observations where subject_table = 'transactions' and field_name = 'transaction_date' and source_id = (select id from sources where source_key = $1)", [RETRO.source_key]))[0].n, 0, 'no Retrosheet transaction_date observation is public')
  assert.equal((await rows(main, "select count(*)::int n from source_observations where subject_table = 'transactions' and field_name = 'transaction_date' and source_id = (select id from sources where source_key = $1)", [MLB.source_key]))[0].n, MLB_OBS, 'the existing MLB ones are untouched'); assert.ok(MLB_OBS >= 1)
  assert.match((await rows(main, 'select notes from sources where source_key = $1', [RETRO.source_key]))[0].notes, /obtained free of charge from and is copyrighted by Retrosheet/)
  for (const e of [main.query("update ingest.promotion_manifests set category = 'x'"), main.query('delete from ingest.promotion_ledger'), main.query('truncate ingest.promotion_events'), main.query('delete from ingest.promotion_withheld_rows')]) assert.match(await refused(e), /append-only/)
  const st = await statusOf(main, PK.a.sha); assert.equal(st.state, 'PROMOTED'); assert.equal(st.withheld_rows, PK.a.manifest.exclusions[0].n)
})

test('promotion records and functions are private to the owner', async () => {
  for (const role of ['anon', 'authenticated', 'bai_site']) {
    assert.equal((await rows(main, "select count(*)::int n from pg_class c where c.relnamespace = 'ingest'::regnamespace and c.relname like 'promotion\\_%' and has_table_privilege($1, c.oid, 'SELECT')", [role]))[0].n, 0, role)
    assert.equal((await rows(main, "select count(*)::int n from pg_proc p where p.pronamespace = 'ingest'::regnamespace and p.proname ~ '^(promot|withdraw|emergency|finish|revert)' and has_function_privilege($1, p.oid, 'EXECUTE')", [role]))[0].n, 0, role)
  }
})

test('publication follows the refresh and the grant: promotion publishes nothing; after the refresh the Retrosheet transactions are PARTIAL and the existing MLB trades stay withheld', async () => {
  assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, 0, 'promotion alone publishes no transaction')
  await refreshAll()
  const nTx = PK.a.manifest.delta['public.transactions'].n
  const ov = (await rows(main, 'select transactions, withheld_unauthorized from rm_transaction_overview'))[0]
  assert.deepEqual([ov.transactions, ov.withheld_unauthorized], [nTx, 2], 'all promoted transactions shown, the two MLB trades withheld')
  assert.equal((await rows(main, "select count(*)::int n from rm_transactions where status = 'PARTIAL'"))[0].n, nTx, 'all PARTIAL')
  assert.equal((await rows(main, "select count(*)::int n from rm_transaction_sources where attribution_category = 'MLB'"))[0].n, 0)
  await h.asRole(main, 'bai_site', async () => assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, nTx))
  for (const role of ['anon', 'authenticated']) await assert.rejects(h.asRole(main, role, () => main.query('select count(*) from rm_transactions')), /permission denied/)
  const attr = await h.asRole(main, 'anon', () => rows(main, "select records, sources from v_source_attribution where attribution_category = 'RETROSHEET' and domain = 'TRANSACTION'"))
  assert.ok(attr[0].records > 0, 'the public attribution summary counts the displayed Retrosheet records without access to the closed table')
})

test('withdrawal refuses while unrelated rows depend on promoted rows (foreign key or subject), changes nothing, and never cascades', async () => {
  const player = Number((await rows(main, "select id from players where full_name like 'Stage Player%' order by id limit 1"))[0].id)
  await main.query("insert into player_aliases (player_id, alias, alias_type, source_id) select $1, 'Unrelated Alias', 'NICKNAME', s.id from sources s where s.source_key = 'g54:base'", [player])
  assert.match(await refused(main.query("select ingest.withdraw_promotion($1, 'drill', false)", [PK.a.sha])), /WITHDRAWAL_REFUSED.*player_aliases/s)
  assert.equal((await statusOf(main, PK.a.sha)).state, 'PROMOTED'); assert.equal((await rows(main, "select count(*)::int n from player_aliases where alias = 'Unrelated Alias'"))[0].n, 1)
  await main.query("delete from player_aliases where alias = 'Unrelated Alias'")
  const obs = await rows(main, "insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value) select s.id, 'players', $1, 'nickname', to_jsonb('X'::text) from sources s where s.source_key = 'g54:base' returning id", [player])
  assert.match(await refused(main.query("select ingest.withdraw_promotion($1, 'drill', false)", [PK.a.sha])), /WITHDRAWAL_REFUSED.*by subject/s)
  assert.deepEqual((await dependents(main, PK.a.sha)).map((x) => x.kind ?? 'fk'), ['by subject'])
  await main.query('delete from source_observations where id = $1', [obs[0].id])
  assert.match(await refused(main.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'")), /GRANT_PROTECTED/, 'the grant cannot be deleted on its own while promoted data depends on it')
  assert.match(await refused(main.query('truncate ingest.source_publication_grants cascade')), /GRANT_PROTECTED/)
})

test('withdrawal 1: only ledger-owned rows go; every baseline table, the existing player and the MLB records are exactly as before; summaries are recomputed; the withheld evidence stays', async () => {
  const r = await withdraw(main, PK.a.sha, 'drill: owner withdrawal'); assert.equal(r.rows_deleted, Object.values(PK.a.manifest.delta).reduce((a, d) => a + d.n, 0))
  assert.deepEqual(await scopeFp(), BASE_FP, 'every baseline table is byte-identical to the baseline')
  assert.equal((await rows(main, 'select md5(p::text) h from players p where id = $1', [exId]))[0].h, exRowHash)
  assert.equal((await rows(main, 'select count(*)::int n from player_external_ids where player_id = $1', [exId]))[0].n, exIdsBefore)
  assert.deepEqual(await rmSummary(), BASE_RM, 'the cached summaries equal the baseline')
  assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, 0)
  assert.equal((await rows(main, 'select count(*)::int n from v_transaction_record_sources'))[0].n, 0)
  assert.equal((await rows(main, "select count(*)::int n from ingest.source_publication_grants where attribution_category = 'RETROSHEET'"))[0].n, 1, 'the grant is untouched when only the promotion is withdrawn')
  assert.equal((await statusOf(main, PK.a.sha)).state, 'WITHDRAWN'); assert.equal((await statusOf(main, PK.a.sha)).withheld_rows, PK.a.manifest.exclusions[0].n)
  assert.ok(Number((await rows(main, "select pg_sequence_last_value(pg_get_serial_sequence('public.players', 'id')) v"))[0].v) >= Math.max(...JSON.parse(PK.a.payload['public.players']).map((p) => Number(p.id))), 'ids are never reused')
  assert.match(await refused(promoteOnce(await open(MAIN), PK.a)), /withdrawn/); assert.match(await refused(main.query("select ingest.withdraw_promotion($1, 'again', false)", [PK.a.sha])), /not currently promoted/)
})

test('EMERGENCY (hide): physical deletion is blocked by an unrelated row; public exposure stops at once; nothing unrelated is deleted; refreshes fail closed; the way out is audited', async () => {
  const pkg = await buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_b', config: config(), outDir: path.join(dir, 'pkg-b') }); PK.b = pkg
  assert.equal((await promote({ connect, name: MAIN, pkg })).result, 'PROMOTED'); await refreshAll()
  const player = Number((await rows(main, "select id from players where full_name like 'Stage Player%' order by id limit 1"))[0].id)
  await main.query("insert into player_aliases (player_id, alias, alias_type, source_id) select $1, 'Unrelated Alias', 'NICKNAME', s.id from sources s where s.source_key = 'g54:base'", [player])
  const publicCounts = async (role) => h.asRole(main, role, async () => Object.fromEntries(await Promise.all(['players', 'player_external_ids', 'source_observations', 'coverage_assessments', 'sources'].map(async (t) => [t, (await rows(main, `select count(*)::int n from ${t}`))[0].n]))))
  const exposed = await publicCounts('anon'); const baseCounts = JSON.parse(JSON.stringify(exposed))
  for (const t of Object.keys(PK.b.manifest.delta)) if (baseCounts[t.replace('public.', '')] !== undefined) baseCounts[t.replace('public.', '')] -= PK.b.manifest.delta[t].n
  const e = await emergencyWithdraw(main, pkg.sha, 'drill: licence withdrawn'); assert.equal(e.state, 'EMERGENCY'); assert.equal(e.blockers.length, 1); assert.equal(e.blockers[0].table, 'public.player_aliases')
  for (const role of ['anon', 'authenticated', 'bai_site']) assert.deepEqual(await publicCounts(role), baseCounts, `${role}: the promoted rows are hidden, every other row is still public`)
  assert.equal((await h.asRole(main, 'anon', () => rows(main, "select count(*)::int n from v_source_attribution where attribution_category = 'RETROSHEET'")))[0].n, 0, 'no Retrosheet row in the public attribution summary')
  assert.equal((await h.asRole(main, 'anon', () => rows(main, "select count(*)::int n from sources where attribution_category = 'RETROSHEET'")))[0].n, 0)
  assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, 0); assert.equal((await rows(main, 'select count(*)::int n from rm_overview'))[0].n, 0, 'the cached summaries are emptied')
  assert.equal((await rows(main, "select count(*)::int n from ingest.source_publication_grants where attribution_category = 'RETROSHEET'"))[0].n, 0, 'the grant is gone: nothing can republish')
  assert.match(await refused(main.query('select public.refresh_read_models()')), /emergency withdrawal/); assert.match(await refused(main.query('select public.refresh_transaction_read_models()')), /emergency withdrawal|no publication grant|emergency/, 'a refresh fails closed')
  assert.equal((await rows(main, "select count(*)::int n from player_aliases where alias = 'Unrelated Alias'"))[0].n, 1, 'the unrelated row is untouched')
  assert.equal((await rows(main, 'select count(*)::int n from players p where p.full_name like $1', ['Stage Player%']))[0].n, 4, 'the promoted rows are still physically there (nothing was deleted)')
  assert.equal((await statusOf(main, pkg.sha)).state, 'EMERGENCY')
  assert.match(await refused(finishWithdrawal(main, pkg.sha, 'too early')), /blockers remain/, 'finishing is refused while the blocker remains')
  assert.match(await refused(promoteOnce(await open(MAIN), PK.a)), /DRIFT|withdrawn|emergency/, 'no promotion can start during an emergency')
  await main.query("delete from player_aliases where alias = 'Unrelated Alias'")
  const f = await finishWithdrawal(main, pkg.sha, 'blocker removed'); assert.equal(f.rows_deleted, Object.values(PK.b.manifest.delta).reduce((a, d) => a + d.n, 0))
  await restoreGrant()
  assert.deepEqual(await scopeFp(), BASE_FP, 'back to the baseline exactly'); assert.equal((await rows(main, "select count(*)::int n from pg_policy where polname like 'emergency_hide_%'"))[0].n, 0, 'the hiding policies are gone')
  assert.deepEqual(await publicCounts('anon'), JSON.parse(JSON.stringify(baseCounts))); await refreshAll(); assert.deepEqual(await rmSummary(), BASE_RM)
  const ev = (await rows(main, 'select event from ingest.promotion_events where manifest_sha256 = $1 order by id', [pkg.sha])).map((x) => x.event); assert.deepEqual(ev, ['PROMOTED', 'EMERGENCY_WITHDRAWN', 'WITHDRAWN'])
})

test('EMERGENCY (revert): a false alarm lifts the hiding and the refresh block, republishes nothing, and the grant must be recorded again deliberately', async () => {
  const pkg = await buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_c', config: config(), outDir: path.join(dir, 'pkg-c') }); PK.c = pkg
  await promote({ connect, name: MAIN, pkg }); await refreshAll()
  await emergencyWithdraw(main, pkg.sha, 'drill: possible licence change')
  const r = await revertEmergency(main, pkg.sha, 'drill: false alarm'); assert.equal(r.state, 'PROMOTED')
  assert.equal((await rows(main, "select count(*)::int n from pg_policy where polname like 'emergency_hide_%'"))[0].n, 0)
  assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, 0, 'nothing is republished by the revert')
  assert.equal((await rows(main, "select count(*)::int n from players where full_name like 'Stage Player%'"))[0].n, 4, 'public again, as promoted')
  await restoreGrant(); await refreshAll(); assert.equal((await rows(main, 'select transactions from rm_transaction_overview'))[0].transactions, pkg.manifest.delta['public.transactions'].n)
  assert.deepEqual((await rows(main, 'select event from ingest.promotion_events where manifest_sha256 = $1 order by id', [pkg.sha])).map((x) => x.event), ['PROMOTED', 'EMERGENCY_WITHDRAWN', 'EMERGENCY_REVERTED'])
  await withdraw(main, pkg.sha, 'drill: end of the revert test')
  assert.deepEqual(await scopeFp(), BASE_FP)
})

test('EMERGENCY (close the endpoints): the stricter mode closes the readable tables to the Data API roles and the website role altogether, and reopens them when finished', async () => {
  const pkg = await buildPackage({ connect, admin, baseName: MAIN, stageName: 'g54_stage_d', config: config(), outDir: path.join(dir, 'pkg-d') }); PK.d = pkg
  await promote({ connect, name: MAIN, pkg }); await refreshAll()
  const e = await emergencyWithdraw(main, pkg.sha, 'drill: close', { closeApi: true }); assert.deepEqual(e.hidden, []); assert.ok(e.closed.length >= 4)
  for (const role of ['anon', 'authenticated', 'bai_site']) for (const t of ['players', 'player_external_ids', 'source_observations', 'coverage_assessments', 'sources']) await assert.rejects(h.asRole(main, role, () => main.query(`select 1 from ${t} limit 1`)), /permission denied/, `${role}: ${t}`)
  await finishWithdrawal(main, pkg.sha, 'done'); await restoreGrant()
  for (const role of ['anon', 'authenticated', 'bai_site']) await h.asRole(main, role, async () => { for (const t of ['players', 'sources', 'source_observations']) await main.query(`select 1 from ${t} limit 1`) })
  assert.deepEqual(await scopeFp(), BASE_FP); assert.deepEqual(await anonRels(), ANON_AFTER, 'the public relations are exactly what they were after 032')
})

test('the command line is local-only: a hosted URL and --hosted are refused, a package verifies offline', () => {
  const run = (args, env) => spawnSync(process.execPath, ['scripts/db/promotion.mjs', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.homedir(), ...env } })
  const hosted = run(['status', '--manifest', 'a'.repeat(64)], { BAI_DATABASE_URL: 'postgresql://db.abcdefghijklmnopqrst.supabase.co:5432/postgres' })
  assert.equal(hosted.status, 2); assert.match(hosted.stderr, /refusing non-local database host/, 'the connection layer refuses a remote host first')
  const forced = run(['status', '--manifest', 'a'.repeat(64)], { BAI_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst', BAI_SUPABASE_DB_PASSWORD: 'not-a-real-password', BAI_ALLOW_REMOTE_DB: '1' })
  assert.equal(forced.status, 2); assert.match(forced.stderr, /NOT AUTHORIZED/, 'and even with the remote override this build refuses a hosted promotion')
  assert.equal(run(['promote', '--package', path.join(dir, 'pkg-a'), '--hosted'], { BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/${MAIN}` }).status, 2)
  const v = run(['verify', '--package', path.join(dir, 'pkg-a')], {}); assert.equal(v.status, 0); assert.match(v.stdout, /VERIFIED  manifest [0-9a-f]{64}/)
  const bad = path.join(dir, 'pkg-bad'); fs.cpSync(path.join(dir, 'pkg-a'), bad, { recursive: true }); fs.appendFileSync(path.join(bad, 'manifest.json'), ' ')
  assert.equal(run(['verify', '--package', bad], {}).status, 1)
})
