// G6B + G6D: migrations 033 and 034, the Data API boundary for raw player identities, evidence and aliases, over real HTTP with a REAL PostgREST (tests/support/postgrest.mjs; in CI the pinned release, and a
// missing binary FAILS the run there). Locally, without the binary the tests report SKIPPED and the boundary is UNVERIFIED: a skip is never a pass.
// FICTIONAL data (tests/db/promotion-fixture.mjs): a baseline with MLB trades, then a representative Retrosheet promotion (no full-scale import).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import * as h from './harness.mjs'
import { BIN, SKIP, freePort } from '../support/postgrest.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { SESSION_SQL, buildPackage, promote, sha256 } from '../../scripts/db/lib/promotion.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g6b-'))
const MAIN = 'g6b_main'; const PRE = 'g6b_pre033'; const POST033 = 'g6d_post033'; const STAGE = 'g6b_stage'
const T4 = ['players', 'player_external_ids', 'source_observations', 'coverage_assessments']
const V3 = ['v_draft_explorer', 'v_player_outcome_status', 'v_source_attribution']
const CLOSED = [...T4, 'player_aliases', ...V3]   // 033: the four tables and three views; 034: player_aliases
const KEEP = ['sources', 'source_attribution_statements', 'organizations']
let admin, main, rest = null, port = 0, pkg, preHashes, preReadable
const SECRET = crypto.randomBytes(32).toString('hex'); const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (role) => { const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role })}`; return `${head}.${crypto.createHmac('sha256', SECRET).update(head).digest('base64url')}` }
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const rows = (c, sql, p) => h.rows(c, sql, p)
const startRest = async () => {
  rest?.kill(); await new Promise((r) => setTimeout(r, 500)); port = await freePort()
  rest = spawn(BIN, [], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', PGRST_DB_URI: `postgresql://authenticator:local@127.0.0.1:${main.port}/${MAIN}`, PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_SERVER_PORT: String(port), PGRST_SERVER_HOST: '127.0.0.1', PGRST_JWT_SECRET: SECRET } })
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).status < 500) return } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)) }
  throw new Error('PostgREST did not start')
}
const req = async (method, p, role, headers = {}, body) => { const r = await fetch(`http://127.0.0.1:${port}/${p}`, { method, headers: { ...(role ? { Authorization: `Bearer ${jwt(role)}` } : {}), ...headers }, body }); const text = await r.text(); return { status: r.status, range: r.headers.get('content-range'), text } }
const denied = (r) => [401, 403].includes(r.status)
const noIdentity = (r) => !/"full_name"|"birth_date"|"observed_value"|"external_id"|Stage Player|Existing Player|Base Player/.test(r.text)
const ROLES = [['anon', null], ['authenticated', 'authenticated']]
// a stable fingerprint of what a role reads from a relation
const readHash = async (c, role, rel) => { await c.query('begin'); try { await c.query(`set local role ${role}`); const r = (await c.query(`select count(*)::int n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from public.${rel} t`)).rows[0]; return `${r.n}:${r.h}` } catch (e) { return `ERR ${e.code}` } finally { await c.query('rollback') } }

before(async () => {
  if (SKIP) return
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN)
  await applyMigrations(main, { through: '030' }); await main.query("create role authenticator login noinherit password 'local'")
  await buildBaseline(main, dir); await applyMigrations(main, { through: '032' }); await main.query('grant anon, authenticated to authenticator')
  // two baseline aliases (the hosted baseline has seven): their bytes must survive 034 and its reversal
  await main.query("insert into public.player_aliases (player_id, alias, alias_type, source_id) select p.id, 'Baseline Alias ' || p.slug, 'LEGAL_NAME', s.id from public.players p, public.sources s where p.slug in ('g54-existing', 'g54-base-1') and s.source_key = 'g54:base'")
  // what the public site reads at the 032 stage (every relation anon may read), as the website role would
  preReadable = (await rows(main, "select c.relname r from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') and has_table_privilege('anon', c.oid, 'SELECT') order by 1")).map((r) => r.r)
  preHashes = Object.fromEntries(await Promise.all(preReadable.map(async (r) => [r, await readHash(main, 'bai_site', r)])))
  await main.end(); await admin.query(`create database ${PRE} template ${MAIN}`)
  main = await open(MAIN); await applyMigrations(main, { through: '033' })
  await main.end(); await admin.query(`create database ${POST033} template ${MAIN}`)   // the post-033 state, for the 034 recovery comparison
  main = await open(MAIN); await applyMigrations(main)   // 034
  await main.end(); await admin.query(`create database ${STAGE} template ${MAIN}`)
  const s = await open(STAGE); const batches = await importSample(s, dir); await s.end(); main = await open(MAIN)
  pkg = await buildPackage({ connect: open, admin, baseName: MAIN, stageName: STAGE, config: { category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2027-01-22' },
    attribution: { evidence_sha256: sha256('fixture evidence'), verified_at: new Date().toISOString(), max_age_hours: 72 }, archive: { name: 'fixture', sha256: sha256('a') }, expectBatches: batches } })
  await startRest()
}, { timeout: 240000 })
after(async () => { rest?.kill(); if (!SKIP) await h.stopServer(); fs.rmSync(dir, { recursive: true, force: true }) })

test('033 is the next migration after 032, records its checksum, and changes exactly the objects it names', { skip: SKIP }, async () => {
  const led = await rows(main, "select version from bai_meta.schema_migrations where version >= '032' order by 1"); assert.deepEqual(led.map((r) => r.version), ['032', '033', '034'])
  const acl = Object.fromEntries((await rows(main, "select relname, relacl::text a from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)", [[...CLOSED, 'sources', 'source_attribution_statements']])).map((r) => [r.relname, r.a]))
  for (const t of CLOSED) assert.match(acl[t], /^\{postgres=arwdDxtm\/postgres,bai_site=r\/postgres\}$/, `${t}: owner and bai_site only`)
  for (const t of ['sources', 'source_attribution_statements']) assert.match(acl[t], /anon=r\/postgres,authenticated=r\/postgres/, `${t} stays readable`)
  const T5 = [...T4, 'player_aliases']; const pol = await rows(main, "select tablename, policyname, roles::text r from pg_policies where schemaname = 'public' and tablename = any($1) order by 1", [T5]); assert.deepEqual(pol.map((p) => [p.policyname, p.r]), T5.map(() => ['site_read', '{bai_site}']))
  assert.equal((await rows(main, 'select count(*)::int n from public.internal_objects where object_name = any($1)', [CLOSED]))[0].n, 8)
  const colAcl = await rows(main, "select count(*)::int n from pg_attribute where attacl is not null and attrelid = any($1::regclass[])", [CLOSED.map((t) => `public.${t}`)]); assert.equal(colAcl[0].n, 0, 'no column-level grants reopen anything')
})

test('no role other than the owner, superusers and bai_site holds SELECT on player_aliases or on any of the other seven (inherited privileges do not bypass the boundary)', { skip: SKIP }, async () => {
  for (const t of CLOSED) {
    const who = (await rows(main, "select rolname from pg_roles where not rolsuper and rolname !~ '^pg_' and has_table_privilege(rolname, $1::regclass, 'SELECT') order by 1", [`public.${t}`])).map((r) => r.rolname)
    assert.deepEqual(who, ['bai_site'], `${t}: ${who}`)
  }
  const m = (await rows(main, "select pg_has_role('bai_web', 'bai_site', 'USAGE') u, pg_has_role('anon', 'bai_site', 'MEMBER') a, pg_has_role('authenticated', 'bai_site', 'MEMBER') b, pg_has_role('authenticator', 'bai_site', 'MEMBER') c"))[0]; assert.deepEqual(m, { u: false, a: false, b: false, c: false }, 'bai_web may SET ROLE but does not inherit; nobody on the Data API side is a member')
})

test('apply_public_boundary() (re-run by earlier and future migrations) cannot reopen the eight', { skip: SKIP }, async () => {
  await main.query('begin')
  try { await main.query('select public.apply_public_boundary()'); const a = await rows(main, "select relname, relacl::text a from pg_class where relnamespace = 'public'::regnamespace and relname = any($1)", [CLOSED]); for (const r of a) assert.doesNotMatch(r.a, /anon=|authenticated=/, r.relname) } finally { await main.query('rollback') }
})

test('SQL: anon and authenticated are refused on the eight (42501); bai_site reads exactly what the public read before 033; no function or role path remains', async () => {
  for (const role of ['anon', 'authenticated']) for (const t of CLOSED) assert.equal(await readHash(main, role, t), 'ERR 42501', `${role} ${t}`)
  for (const r of preReadable) assert.equal(await readHash(main, 'bai_site', r), preHashes[r], `website parity: bai_site reads ${r} exactly as before 033`)
  assert.equal((await rows(main, "select count(*)::int n from pg_proc p where pronamespace in ('public'::regnamespace, 'ingest'::regnamespace) and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))"))[0].n, 0)
  const m = (await rows(main, "select pg_has_role('authenticator', 'bai_site', 'member') a, pg_has_role('authenticated', 'bai_site', 'member') b, pg_has_role('anon', 'bai_site', 'member') c"))[0]; assert.deepEqual(m, { a: false, b: false, c: false })
  const au = new (await import('pg')).default.Client({ host: '127.0.0.1', port: main.port, user: 'authenticator', password: 'local', database: MAIN }); await au.connect()
  try { for (const r of ['bai_site', 'postgres', 'bai_web']) { await au.query('begin'); await assert.rejects(au.query(`set local role ${r}`), /permission denied/, r); await au.query('rollback') }
    await au.query('begin'); await au.query('set local role anon'); await assert.rejects(au.query('set local role bai_site'), /permission denied/); await au.query('rollback') } finally { await au.end() }
})

const matrix = async (label) => {
  for (const [name, role] of ROLES) for (const t of CLOSED) {
    for (const prefer of ['count=exact', 'count=planned', 'count=estimated']) { const r = await req('GET', `${t}?select=*&limit=1`, role, { Prefer: prefer }); assert.ok(denied(r), `${label} ${name} GET ${t} ${prefer} -> ${r.status}`); assert.ok(noIdentity(r) && !(r.range ?? '').includes('/'), `${label} ${name} ${t}: no rows and no count`) }
    for (const prefer of ['count=exact', 'count=planned', 'count=estimated']) { const r = await req('HEAD', `${t}?select=*`, role, { Prefer: prefer }); assert.ok(denied(r) && !(r.range ?? '').includes('/'), `${label} ${name} HEAD ${t} ${prefer} -> ${r.status} ${r.range}`) }
    const dup = await req('GET', `${t}?select=*&limit=1`, role, { Prefer: 'count=planned, count=exact' }); assert.ok(denied(dup), `${label} ${name} ${t} duplicated Prefer`)
    const post = await req('POST', t, role, { 'Content-Type': 'application/json' }, '{}'); assert.ok(post.status >= 400 && noIdentity(post), `${label} ${name} POST ${t}`)
  }
}

test('Data API on the baseline: all eight are refused for anon and authenticated in every count mode, GET and HEAD, duplicated Prefer, writes', { skip: SKIP }, async () => { await matrix('baseline') })

test('Data API bypass attempts: embedding, inner joins, filters through the closed tables, RPC, JWT role claims, schema switch', { skip: SKIP }, async () => {
  const attempts = ['draft_selections?select=*,players(*)', 'international_signings?select=*,players(full_name,birth_date)', 'player_aliases?select=*,players(*)', 'sources?select=*,source_observations(*)', 'organizations?select=*,players(*)',
    'draft_selections?select=id,players!inner(id)&players.id=gt.0', 'sources?select=id&source_observations.id=gt.0', 'draft_selections?select=*&player_id=in.(select id from players)', 'sources?select=*&order=source_observations(id)']
  for (const [, role] of ROLES) for (const a of attempts) { const r = await req('GET', a, role, { Prefer: 'count=exact' }); assert.ok(noIdentity(r), `${a} leaked`); assert.ok(r.status >= 400 || !/Stage Player|full_name|birth_date|observed_value/.test(r.text), a) }
  for (const [, role] of ROLES) { for (const fn of ['normalize_name', 'refresh_read_models', 'refresh_transaction_read_models', 'apply_public_boundary', 'resolve_player']) { const r = await req('POST', `rpc/${fn}`, role, { 'Content-Type': 'application/json' }, '{}'); assert.ok([401, 403, 404].includes(r.status), `rpc ${fn} -> ${r.status}`) } }
  for (const claim of ['bai_site', 'postgres', 'bai_web', 'supabase_admin', 'service_role']) { const r = await req('GET', 'players?select=*&limit=1', claim, { Prefer: 'count=exact' }); assert.ok(r.status >= 400 && noIdentity(r), `JWT role claim ${claim} -> ${r.status}`) }
  for (const prof of ['ingest', 'analytics', 'research', 'bai_meta']) { const r = await req('GET', 'players?select=*&limit=1', null, { 'Accept-Profile': prof }); assert.ok(r.status >= 400 && noIdentity(r), `Accept-Profile ${prof}`) }
})

test('what stays open: sources, the attribution statements and organizations answer; the transaction tables and read models stay closed (the MLB trades remain withheld)', { skip: SKIP }, async () => {
  for (const [, role] of ROLES) for (const t of KEEP) assert.ok([200, 206].includes((await req('GET', `${t}?select=*&limit=1`, role, { Prefer: 'count=exact' })).status), `${t} readable`)
  for (const [, role] of ROLES) for (const t of ['transactions', 'trade_packages', 'trade_package_assets', 'rm_transactions', 'rm_transaction_overview', 'rm_transaction_sources', 'rm_transaction_withdrawals']) { const r = await req('GET', `${t}?select=*&limit=1`, role, { Prefer: 'count=exact' }); assert.ok(denied(r) && noIdentity(r), `${t} -> ${r.status}`) }
})

let promoted = false
test('after a representative Retrosheet promotion and both refreshes: the eight are still refused, no promoted identity or observation appears in ANY readable endpoint, the credit stays public', { skip: SKIP }, async () => {
  assert.equal((await promote({ connect: open, name: MAIN, pkg })).result, 'PROMOTED'); promoted = true
  await main.query('select public.refresh_read_models()'); await main.query('select public.refresh_transaction_read_models()'); await main.query('analyze')
  const names = (await rows(main, "select full_name from players where full_name like 'Stage Player%' order by id")).map((r) => r.full_name); assert.ok(names.length >= 3, 'the promoted players exist')
  const retroIds = (await rows(main, "select external_id from player_external_ids where id_system = 'RETROSHEET' and external_id like 'g54%'")).map((r) => r.external_id)
  await startRest(); await matrix('promoted')
  // crawl every endpoint the Data API exposes to each role and search for the promoted identities and evidence
  for (const [name, role] of ROLES) {
    const root = JSON.parse((await req('GET', '', role)).text); const paths = Object.keys(root.paths ?? {}).filter((p) => p !== '/' && !p.startsWith('/rpc/')).map((p) => p.slice(1))
    assert.ok(!paths.some((p) => CLOSED.includes(p)), `${name}: the closed relations are not even advertised (${paths.filter((p) => CLOSED.includes(p))})`)
    let leaks = 0; for (const p of paths) { const r = await req('GET', `${p}?select=*&limit=1000`, role); if (names.some((n) => r.text.includes(n)) || retroIds.some((i) => r.text.includes(`"${i}"`))) leaks++ }
    assert.equal(leaks, 0, `${name}: no endpoint returns a promoted player name or Retrosheet id (${paths.length} endpoints crawled)`)
  }
  const src = JSON.parse((await req('GET', 'sources?select=source_key,notes,attribution_category&attribution_category=eq.RETROSHEET', null)).text); assert.equal(src.length, 1); assert.match(src[0].notes, /obtained free of charge from and is copyrighted by Retrosheet\. Interested parties may contact Retrosheet at "www\.retrosheet\.org"\./)
  const stm = JSON.parse((await req('GET', 'source_attribution_statements?select=*', null)).text); assert.ok(stm.some((s) => s.attribution_category === 'RETROSHEET' && s.notice_url === 'https://www.retrosheet.org/notice.txt'))
})

test('website role after the promotion: reads the promoted identities, evidence, the 11 transaction read models and the views; anon does not; the grant and MLB trades are unchanged', { skip: SKIP }, async () => {
  assert.ok(promoted)
  const n = async (role, t) => { await main.query('begin'); try { await main.query(`set local role ${role}`); return (await main.query(`select count(*)::int n from public.${t}`)).rows[0].n } catch (e) { return e.code } finally { await main.query('rollback') } }
  for (const t of T4) assert.ok((await n('bai_site', t)) > 0, `bai_site reads ${t}`)
  assert.ok((await n('bai_site', 'players')) >= pkg.manifest.delta['public.players'].n)
  for (const t of V3) assert.ok(typeof (await n('bai_site', t)) === 'number', `bai_site reads ${t}`)
  assert.equal(await n('bai_site', 'rm_transactions'), pkg.manifest.delta['public.transactions'].n, 'the promoted transactions are in the website read model')
  assert.equal(await n('anon', 'players'), '42501'); assert.equal(await n('anon', 'rm_transactions'), '42501')
  assert.equal((await rows(main, "select count(*)::int n from public.transactions t join public.sources s on s.id = t.source_id where s.attribution_category = 'MLB'"))[0].n, 2, 'the baseline MLB trades are unchanged')
  assert.equal((await rows(main, 'select count(*)::int n from public.rm_transactions r join public.transactions t on t.id = r.transaction_id join public.sources s on s.id = t.source_id where s.attribution_category = \'MLB\''))[0].n, 0, 'and still withheld from the read model')
})

test('a future Retrosheet-associated alias (pipeline-style insert for a promoted player, citing the Retrosheet source) cannot become anonymously readable; the website role reads it', { skip: SKIP }, async () => {
  assert.ok(promoted)
  const P = (await rows(main, "select id from players where full_name like 'Stage Player%' order by id limit 1"))[0].id; const S = (await rows(main, "select id from sources where attribution_category = 'RETROSHEET'"))[0].id; const C = (await rows(main, "select id from sources where source_key like 'hist:chadwick%' limit 1"))[0].id
  await main.query("insert into public.player_aliases (player_id, alias, alias_type, source_id) values ($1, 'Zzretro Futurealias', 'OTHER', $2), ($1, 'Zzchad Futurealias', 'OTHER', $3)", [P, S, C])
  try {
    await main.query('select public.apply_public_boundary()')   // a later migration re-running the boundary must not matter either
    await startRest()
    for (const [name, role] of ROLES) {
      for (const prefer of ['count=exact', 'count=planned', 'count=estimated']) { const r = await req('GET', 'player_aliases?select=*&alias=like.Zz*', role, { Prefer: prefer }); assert.ok(denied(r) && !/Futurealias/.test(r.text), `${name} ${prefer}`) }
      assert.ok(denied(await req('HEAD', 'player_aliases?select=*', role, { Prefer: 'count=exact' })), `${name} HEAD`)
      const root = JSON.parse((await req('GET', '', role)).text); let leaks = 0
      for (const p of Object.keys(root.paths ?? {}).filter((x) => x !== '/' && !x.startsWith('/rpc/')).map((x) => x.slice(1))) if ((await req('GET', `${p}?select=*&limit=1000`, role)).text.includes('Futurealias')) leaks++
      assert.equal(leaks, 0, `${name}: no advertised endpoint returns the alias`)
      const emb = await req('GET', 'draft_selections?select=*,player_aliases(*)', role); assert.ok(!/Futurealias/.test(emb.text), `${name} embed`)
    }
    await main.query('begin'); await main.query('set local role bai_site'); const seen = (await main.query("select count(*)::int n from public.player_aliases where alias like 'Zz%'")).rows[0].n; await main.query('rollback'); assert.equal(seen, 2, 'the website role reads both')
    const viaView = await rows(main, "select 1 from public.v_source_attribution limit 1"); assert.ok(Array.isArray(viaView))
  } finally { await main.query("delete from public.player_aliases where alias like 'Zz%'") }
})

const snapOf = async (c, relsList) => ({
  acl: await rows(c, "select relname, relacl::text a from pg_class where relnamespace = 'public'::regnamespace and relname = any($1) order by 1", [relsList]),
  pol: await rows(c, "select tablename, policyname, roles::text r, cmd, qual from pg_policies where schemaname = 'public' and tablename = any($1) order by 1, 2", [relsList]),
  reg: await rows(c, 'select object_name, reason from public.internal_objects where object_name = any($1) order by 1', [relsList]),
  emergency: await rows(c, "select md5(pg_get_functiondef('ingest.emergency_withdraw(text, text, boolean)'::regprocedure)) d"),
  readers: await rows(c, "select to_regprocedure('ingest.promotion_readers(regclass)')::text f")
})
const doc = (f) => fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../docs/transactions', f), 'utf8').replace(/^begin;\s*$/m, '-- begin').replace(/^commit;\s*$/m, '-- commit')

test('recovery 034: the documented reverse script restores exactly the post-033 state of player_aliases (ACL, policy, registry), changes nothing else, and leaves the data identical', { skip: SKIP }, async () => {
  const post = await open(POST033); const want = await snapOf(post, [...CLOSED]); const wantAliases = (await rows(post, "select md5(coalesce(string_agg(t::text, '|' order by id), '')) h from public.player_aliases t"))[0].h; await post.end()
  const before = await snapOf(main, [...CLOSED]); assert.notDeepEqual(before, want, '034 is in place')
  const probe = await open(MAIN)
  try {
    await probe.query('begin'); await probe.query(doc('g6d-rollback-034.sql'))
    assert.deepEqual(await snapOf(probe, [...CLOSED]), want, 'identical to a database that never had 034')
    assert.equal((await rows(probe, "select md5(coalesce(string_agg(t::text, '|' order by id), '')) h from public.player_aliases t"))[0].h, wantAliases, 'the aliases are byte-identical')
    await probe.query('set local role anon'); assert.ok((await probe.query('select count(*)::int n from public.player_aliases')).rows[0].n > 0, 'the public can read player_aliases again (the exposure the script knowingly restores)')
  } finally { await probe.query('rollback'); await probe.end() }
  assert.deepEqual(await snapOf(main, [...CLOSED]), before, 'the test left the 034 state in place')
})

test('recovery 033 (after 034): reverse 034 first, then 033, and the result is exactly the 032-stage exposure of all eight, with the 032 emergency procedure back', { skip: SKIP }, async () => {
  const pre = await open(PRE); const want = await snapOf(pre, [...CLOSED]); await pre.end()
  const probe = await open(MAIN)
  try {
    await probe.query('begin'); await probe.query(doc('g6d-rollback-034.sql')); await probe.query(doc('g6b-rollback-033.sql'))
    assert.deepEqual(await snapOf(probe, [...CLOSED]), want, 'identical to a database that never had 033 or 034')
    await probe.query('set local role anon'); for (const t of [...T4, 'player_aliases']) assert.ok((await probe.query(`select count(*)::int n from public.${t}`)).rows[0].n >= 0, t)
  } finally { await probe.query('rollback'); await probe.end() }
})
