// The TLS-verified connection of the guarded migration push (scripts/db/lib/verified-push.mjs, scripts/db/supabase-hosted.mjs), proved on the FINAL connection of the ACTUAL pinned
// Supabase CLI against disposable local PostgreSQL servers that present different certificates. A URL that merely contains sslmode=verify-full is not evidence; a refused connection
// to a bad server and an accepted connection to a good one, from the same binary and the same URL shape, is. LOCAL ONLY: nothing here can reach hosted.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import * as R from '../support/tls-rig.mjs'
import { FORBIDDEN_ENV, OUTPUT_FLAGS, PINNED_CA, assertDirectEndpoint, buildVerifiedTarget, directEndpoint, parsePgOptions, redact, validateCaFile, VerifiedPushError } from '../../scripts/db/lib/verified-push.mjs'
import { parseDryRun } from '../../scripts/db/lib/gate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(root, 'node_modules/.bin/supabase')
const REF = 'dbnmktidheefoxaztivm'
const OPTS = '-c lock_timeout=5s -c statement_timeout=120000'
let work, pki, proj; const servers = {}
const cliVersion = () => spawnSync(CLI, ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0]

before(async () => {
  assert.ok(fs.existsSync(CLI), `the pinned Supabase CLI is missing at ${CLI}: this test cannot be skipped`)
  work = R.tmpDir('bai-tls-'); pki = R.makePki(path.join(work, 'pki'))
  proj = path.join(work, 'proj'); fs.mkdirSync(path.join(proj, 'supabase/migrations'), { recursive: true }); fs.copyFileSync(path.join(root, 'supabase/config.toml'), path.join(proj, 'supabase/config.toml'))
  for (const [name, cert] of [['good', 'good'], ['selfsigned', 'selfsigned'], ['untrusted', 'untrusted'], ['wrongname', 'wrongname'], ['notls', null]]) servers[name] = await R.startServer(work, pki, name, cert)
}, { timeout: 180000 })
after(async () => { for (const s of Object.values(servers)) await s.stop().catch(() => {}); fs.rmSync(work, { recursive: true, force: true }) })

const endpoint = (s) => ({ host: R.HOST, port: s.port, user: 'postgres', database: 'postgres' })
const baseEnv = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, BAI_SUPABASE_PROJECT_REF: REF, BAI_SUPABASE_DB_PASSWORD: R.PASSWORD, PGOPTIONS: OPTS, ...extra })
/** The verified target, aimed at a local test server with a test CA (the `testOnly` seam exists for this file only: a test below proves the guard never uses it). */
const target = (server, { ca = pki.rootA, env = baseEnv(), requireTimeouts = true } = {}) => buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: root, env, requireTimeouts, testOnly: { endpoint: endpoint(server), caFile: ca } })

/** Runs the real CLI with the target's arguments and environment, sampling every process's command line while it runs. */
function runCli (sub, t, { cwd = proj, secret = R.PASSWORD } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLI, [...sub, ...OUTPUT_FLAGS, ...t.args], { cwd, env: t.env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let sawInArgv = false; let sampled = 0
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
    const poll = setInterval(() => { try { for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) { try { const c = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); sampled++; if (c.includes(secret)) sawInArgv = true } catch { /* gone */ } } } catch { /* no /proc */ } }, 10)
    child.on('close', (status) => { clearInterval(poll); resolve({ status, out, sawInArgv, sampled }) })
  })
}
const setMigrations = (files) => { const d = path.join(proj, 'supabase/migrations'); for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f)); for (const [n, sql] of Object.entries(files)) fs.writeFileSync(path.join(d, n), sql) }
const refusedOrAccepted = (r) => `${r.status === 0 ? 'ACCEPTED' : 'REFUSED'}`

test('the pinned CA file is exactly the Supabase root: identity, CA flag, validity, and the SHA-256 fingerprint', () => {
  const f = validateCaFile(path.join(root, PINNED_CA.file), { now: new Date('2026-11-02T00:00:00Z') })
  assert.equal(f.subject_cn, 'Supabase Root 2021 CA'); assert.equal(f.sha256, PINNED_CA.sha256); assert.equal(f.not_after, '2031-04-26T10:56:53.000Z')
  // the test CAs are valid certificates but not the pinned root
  assert.throws(() => validateCaFile(pki.rootA, { now: new Date() }), /fingerprint .* is not the pinned Supabase root|subject is/)
  // the same checks without the pin (used only by the test seam) still enforce: one certificate, a CA, validity
  assert.equal(validateCaFile(pki.rootA, { requirePin: false }).subject_cn, 'rootA')
  assert.throws(() => validateCaFile(path.join(pki.dir, 'good.crt'), { requirePin: false }), /not a certificate authority/)
  const two = path.join(work, 'two.crt'); fs.writeFileSync(two, fs.readFileSync(pki.rootA) + fs.readFileSync(pki.rootB)); assert.throws(() => validateCaFile(two, { requirePin: false }), /exactly one certificate, it holds 2/)
  const junk = path.join(work, 'junk.crt'); fs.writeFileSync(junk, 'x'.repeat(500)); assert.throws(() => validateCaFile(junk, { requirePin: false }), /exactly one certificate, it holds 0/)
  const tail = path.join(work, 'tail.crt'); fs.writeFileSync(tail, fs.readFileSync(pki.rootA, 'utf8') + 'trailing text\n'); assert.throws(() => validateCaFile(tail, { requirePin: false }), /besides its one certificate/)
  assert.throws(() => validateCaFile(path.join(work, 'missing.crt')), /does not exist/); assert.throws(() => validateCaFile(work), /not a regular file/)
  // validity windows (relative to the pinned certificate's 2031-04-26 end)
  assert.throws(() => validateCaFile(path.join(root, PINNED_CA.file), { now: new Date('2031-04-10T00:00:00Z') }), /needs at least 30 days left/)
  assert.throws(() => validateCaFile(path.join(root, PINNED_CA.file), { now: new Date('2031-05-01T00:00:00Z') }), /needs at least 30 days left/)
  assert.throws(() => validateCaFile(path.join(root, PINNED_CA.file), { now: new Date('2020-01-01T00:00:00Z') }), /not yet valid/)
  // a tampered copy of the pinned file (any other certificate in its place) is refused by the pin
  const tampered = path.join(work, 'tampered.crt'); fs.copyFileSync(pki.rootA, tampered); assert.throws(() => validateCaFile(tampered), /pinned Supabase root|subject is/)
})

test('PGOPTIONS must be exactly lock_timeout (1 ms to 5 s) and statement_timeout=120000 ms', () => {
  for (const ok of ['-c lock_timeout=5s -c statement_timeout=120000', '-c statement_timeout=120000 -c lock_timeout=5000ms', '-c lock_timeout=1ms -c statement_timeout=120s', '-c lock_timeout=2s -c statement_timeout=2min', '-c lock_timeout=5000 -c statement_timeout=120000'])
    assert.deepEqual(Object.keys(parsePgOptions(ok)), ['lock_timeout_ms', 'statement_timeout_ms'], ok)
  assert.deepEqual(parsePgOptions('-c lock_timeout=5s -c statement_timeout=2min'), { lock_timeout_ms: 5000, statement_timeout_ms: 120000 })
  const bad = { missing: undefined, empty: '', blank: '   ', 'no lock': '-c statement_timeout=120000', 'no statement': '-c lock_timeout=5s', 'lock zero (no timeout)': '-c lock_timeout=0 -c statement_timeout=120000', 'lock 6s': '-c lock_timeout=6s -c statement_timeout=120000',
    'lock 5001ms': '-c lock_timeout=5001ms -c statement_timeout=120000', 'statement 60s': '-c lock_timeout=5s -c statement_timeout=60s', 'statement 121s': '-c lock_timeout=5s -c statement_timeout=121000', 'statement zero': '-c lock_timeout=5s -c statement_timeout=0',
    'duplicate lock': '-c lock_timeout=5s -c lock_timeout=1s -c statement_timeout=120000', 'extra option': '-c lock_timeout=5s -c statement_timeout=120000 -c work_mem=1GB', 'no -c': 'lock_timeout=5s statement_timeout=120000',
    'long form': '--lock_timeout=5s --statement_timeout=120000', glued: '-clock_timeout=5s -cstatement_timeout=120000', 'words': '-c lock_timeout=5seconds -c statement_timeout=120000', negative: '-c lock_timeout=-1 -c statement_timeout=120000', odd: '-c lock_timeout=5s -c' }
  for (const [what, v] of Object.entries(bad)) assert.throws(() => parsePgOptions(v), VerifiedPushError, what)
})

test('the endpoint is the direct host of the pinned project and nothing else: poolers, other projects, ports, users and look-alikes are refused', () => {
  assert.deepEqual(directEndpoint(REF), { host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', database: 'postgres' }); assertDirectEndpoint(directEndpoint(REF), REF)
  const other = 'a'.repeat(20)
  for (const [what, ep] of Object.entries({
    'the pooler (session)': { host: 'aws-1-ca-central-1.pooler.supabase.com', port: 5432, user: `postgres.${REF}`, database: 'postgres' }, 'the pooler (transaction port)': { host: 'aws-1-ca-central-1.pooler.supabase.com', port: 6543, user: `postgres.${REF}`, database: 'postgres' },
    'a pooler host with the right user': { host: 'x.pooler.supabase.com', port: 5432, user: 'postgres', database: 'postgres' }, 'another project': { host: `db.${other}.supabase.co`, port: 5432, user: 'postgres', database: 'postgres' },
    'the right host, port 6543': { host: `db.${REF}.supabase.co`, port: 6543, user: 'postgres', database: 'postgres' }, 'a look-alike suffix': { host: `db.${REF}.supabase.co.evil.example`, port: 5432, user: 'postgres', database: 'postgres' },
    'an address literal': { host: '2600:1f11:63d:d100:1b29:63a4:ee28:b984', port: 5432, user: 'postgres', database: 'postgres' }, 'localhost': { host: 'localhost', port: 5432, user: 'postgres', database: 'postgres' },
    'another user': { host: `db.${REF}.supabase.co`, port: 5432, user: 'bai_web', database: 'postgres' }, 'another database': { host: `db.${REF}.supabase.co`, port: 5432, user: 'postgres', database: 'template1' }, 'nothing': null
  })) assert.throws(() => assertDirectEndpoint(ep, REF), VerifiedPushError, what)
  assert.throws(() => directEndpoint('short'), VerifiedPushError); assert.throws(() => directEndpoint(undefined), VerifiedPushError)
})

test('buildVerifiedTarget: the exact shape for the pinned project, a password-free URL, a scrubbed environment, and a refusal for every ambiguity', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, BAI_SUPABASE_PROJECT_REF: REF, BAI_SUPABASE_DB_PASSWORD: R.PASSWORD, PGOPTIONS: '-c lock_timeout=5s -c statement_timeout=120000', BAI_DATABASE_URL: 'postgres://x', SUPABASE_ACCESS_TOKEN: 'sbp_x', BAI_SUPABASE_URL: 'https://x' }
  const t = buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: root, env, requireTimeouts: true, now: new Date('2026-11-02T00:00:00Z') })
  const url = new URL(t.args[1]); assert.deepEqual(t.args.slice(0, 1), ['--db-url'])
  assert.equal(url.protocol, 'postgresql:'); assert.equal(url.hostname, `db.${REF}.supabase.co`); assert.equal(url.port, '5432'); assert.equal(url.username, 'postgres'); assert.equal(url.password, ''); assert.equal(url.pathname, '/postgres')
  assert.equal(url.searchParams.get('sslmode'), 'verify-full'); assert.equal(url.searchParams.get('sslrootcert'), path.join(root, PINNED_CA.file)); assert.deepEqual([...url.searchParams.keys()].sort(), ['sslmode', 'sslrootcert'])
  assert.ok(!t.args.join(' ').includes(R.PASSWORD), 'the password is not in the arguments'); assert.ok(!t.args.includes('--linked'))
  assert.equal(t.env.PGPASSWORD, R.PASSWORD); assert.equal(t.env.PGSSLMODE, 'verify-full'); assert.equal(t.env.PGSSLROOTCERT, path.join(root, PINNED_CA.file)); assert.equal(t.env.PGOPTIONS, '-c lock_timeout=5000ms -c statement_timeout=120000ms')
  assert.deepEqual(Object.keys(t.env).filter((k) => /^BAI_|^SUPABASE_|URL/.test(k)), [], 'no other credential, URL or BAI variable reaches the CLI'); assert.ok(!JSON.stringify(t.facts).includes(R.PASSWORD))
  const must = (patch, re, what, opts = {}) => assert.throws(() => buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: root, env: { ...env, ...patch }, requireTimeouts: true, now: new Date('2026-11-02T00:00:00Z'), ...opts }), re, what)
  must({ BAI_SUPABASE_DB_PASSWORD: '' }, /BAI_SUPABASE_DB_PASSWORD is not set/, 'no password')
  must({}, /linked to/, 'unlinked checkout', { linkedRef: null }); must({}, /linked to a{20}, not to/, 'a differently linked checkout', { linkedRef: 'a'.repeat(20) }); must({}, /missing or malformed/, 'malformed ref', { ref: 'x' })
  for (const k of FORBIDDEN_ENV) must({ [k]: 'x' }, new RegExp(`${k} is set`), `forbidden variable ${k}`)
  must({ PGOPTIONS: undefined }, /PGOPTIONS is not set/, 'a real push needs PGOPTIONS'); must({ PGOPTIONS: '-c lock_timeout=0 -c statement_timeout=120000' }, /lock_timeout is 0 ms/, 'lock_timeout 0')
  // a dry run applies nothing and may omit PGOPTIONS, but a PGOPTIONS that is present must still be valid
  assert.equal(buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: root, env: { ...env, PGOPTIONS: undefined }, requireTimeouts: false, now: new Date('2026-11-02T00:00:00Z') }).env.PGOPTIONS, undefined)
  assert.throws(() => buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: root, env: { ...env, PGOPTIONS: '-c lock_timeout=60s' }, requireTimeouts: false, now: new Date('2026-11-02T00:00:00Z') }), VerifiedPushError)
  // a checkout whose CA file was swapped is refused before any connection
  const fake = path.join(work, 'fakerepo'); fs.mkdirSync(path.join(fake, 'supabase'), { recursive: true }); fs.copyFileSync(pki.rootA, path.join(fake, 'supabase/prod-ca-2021.crt'))
  assert.throws(() => buildVerifiedTarget({ ref: REF, linkedRef: REF, repoRoot: fake, env, requireTimeouts: true, now: new Date('2026-11-02T00:00:00Z') }), /pinned Supabase root|subject is/)
  assert.equal(redact(`a ${R.PASSWORD} b ${R.PASSWORD}`, R.PASSWORD), 'a *** b ***'); assert.equal(redact('x', ''), 'x')
})

test('the guard never uses the test seam, never builds an insecure target and never falls back to the linked connection for a push', () => {
  const guard = fs.readFileSync(path.join(root, 'scripts/db/supabase-hosted.mjs'), 'utf8')
  assert.ok(!/testOnly/.test(guard), 'the guard does not pass the test-only endpoint/CA override')
  const code = (guard + fs.readFileSync(path.join(root, 'scripts/db/lib/verified-push.mjs'), 'utf8')).replace(/\/\/.*$/gm, '')
  assert.ok(!/sslmode=(require|prefer|allow|disable|verify-ca)|InsecureSkipVerify|rejectUnauthorized/.test(code), 'no insecure SSL mode is spelled anywhere in the push path')
  assert.ok(!/SKIP_VERIFY/.test(guard.replace(/\/\/.*$/gm, '')), 'the guard has no skip switch (the library only lists it as a forbidden variable)')
  const pushPath = guard.replace(/\/\/.*$/gm, '').slice(guard.replace(/\/\/.*$/gm, '').indexOf('const isPush')); const beforeLinked = pushPath.slice(0, pushPath.indexOf('const needsDb'))
  assert.ok(!/--linked/.test(beforeLinked), 'the push branch never adds --linked'); assert.match(beforeLinked, /process\.exit\(res\.status \?\? 1\)/, 'the push branch ends the process: it cannot fall through to the linked connection')
})

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The ACTUAL Supabase CLI, final connection.
test('real CLI: the same URL shape is ACCEPTED by the right server and REFUSED by every wrong one (self-signed, untrusted CA, wrong hostname, no TLS), never downgrading', async () => {
  setMigrations({ '001_x.sql': 'select 1;\n' })
  const ver = cliVersion(); assert.match(ver, /^\d+\.\d+\.\d+/); console.log(`# Supabase CLI ${ver}`)
  const row = {}
  for (const name of ['good', 'selfsigned', 'untrusted', 'wrongname', 'notls']) { const r = await runCli(['db', 'push', '--dry-run'], target(servers[name])); row[name] = refusedOrAccepted(r); assert.equal(r.sawInArgv, false, `${name}: the password never appeared in any process command line (${r.sampled} samples)`); assert.ok(!r.out.includes(R.PASSWORD), `${name}: not in the output`) }
  assert.deepEqual(row, { good: 'ACCEPTED', selfsigned: 'REFUSED', untrusted: 'REFUSED', wrongname: 'REFUSED', notls: 'REFUSED' })
  const good = await runCli(['db', 'push', '--dry-run'], target(servers.good)); assert.deepEqual(parseDryRun(good.out), ['001_x.sql'])
  const bad = await runCli(['db', 'push', '--dry-run'], target(servers.selfsigned)); assert.match(bad.out, /tls error \(self.signed certificate\)/)
  const no = await runCli(['db', 'push', '--dry-run'], target(servers.notls)); assert.match(no.out, /tls error|does not support SSL/i, 'a server without TLS is refused, not used in plaintext')
})

test('real CLI: a missing, empty, wrong or absent CA is refused, and the right CA with the wrong password is refused', async () => {
  setMigrations({ '001_x.sql': 'select 1;\n' })
  const dry = (t) => runCli(['db', 'push', '--dry-run'], t)
  assert.equal((await dry(target(servers.good, { ca: pki.rootB }))).status === 0, false, 'right server, wrong CA (rootB signed nothing here)')
  const nofile = target(servers.good); nofile.args = ['--db-url', nofile.args[1].replace(/sslrootcert=[^&]*/, `sslrootcert=${encodeURIComponent(path.join(work, 'missing.crt'))}`)]; nofile.env.PGSSLROOTCERT = path.join(work, 'missing.crt')
  assert.equal((await dry(nofile)).status === 0, false, 'missing CA file')
  const norootcert = target(servers.good); norootcert.args = ['--db-url', norootcert.args[1].replace(/&sslrootcert=[^&]*/, '')]; delete norootcert.env.PGSSLROOTCERT
  assert.equal((await dry(norootcert)).status === 0, false, 'verify-full with no CA: the system roots do not contain the test CA')
  const WRONG = 'zzz-wrong-password-1'; const wrongpw = target(servers.good, { env: baseEnv({ BAI_SUPABASE_DB_PASSWORD: WRONG }) }); const r = await dry(wrongpw)
  assert.equal(r.status === 0, false); assert.ok(!r.out.includes(R.PASSWORD) && !r.out.includes(WRONG), 'neither password is echoed')
  // and the settings the verified path relies on really are what make the difference: the same CLI accepts the self-signed server under sslmode=require
  const weak = target(servers.selfsigned); weak.args = ['--db-url', weak.args[1].replace('verify-full', 'require').replace(/&sslrootcert=[^&]*/, '')]; delete weak.env.PGSSLMODE; delete weak.env.PGSSLROOTCERT
  assert.equal((await dry(weak)).status, 0, 'control: sslmode=require does not verify (which is why the guard never uses it)')
})

test('real CLI: PGOPTIONS reach the migration session; a held lock fails the push at lock_timeout, atomically; only the intended migration is listed and applied', async () => {
  const t2 = (extra = {}) => target(servers.good, { env: baseEnv({ PGOPTIONS: '-c lock_timeout=2s -c statement_timeout=120000', ...extra }) })
  setMigrations({ '001_base.sql': "create table public.t (id int);\ncreate table public.settings_seen as select current_setting('lock_timeout') lt, current_setting('statement_timeout') st;\n" })
  let r = await runCli(['db', 'push'], t2()); assert.equal(r.status, 0, r.out)
  const client = new pg.Client({ host: R.HOST, port: servers.good.port, user: 'postgres', password: R.PASSWORD, database: 'postgres', ssl: { ca: fs.readFileSync(pki.rootA, 'utf8') } }); await client.connect()
  try {
    assert.deepEqual((await client.query('select lt, st from public.settings_seen')).rows, [{ lt: '2s', st: '2min' }], 'the migration session ran with the intended timeouts')
    setMigrations({ '001_base.sql': fs.readFileSync(path.join(proj, 'supabase/migrations/001_base.sql'), 'utf8'), '002_alter.sql': 'alter table public.t add column c int;\n' })
    const dry = await runCli(['db', 'push', '--dry-run'], t2()); assert.deepEqual(parseDryRun(dry.out), ['002_alter.sql'], 'the dry run lists exactly the one pending migration')
    // another session holds a lock that blocks the ALTER
    const holder = new pg.Client({ host: R.HOST, port: servers.good.port, user: 'postgres', password: R.PASSWORD, database: 'postgres', ssl: { ca: fs.readFileSync(pki.rootA, 'utf8') } }); await holder.connect(); await holder.query('begin'); await holder.query('lock table public.t in access share mode')
    const t0 = Date.now(); r = await runCli(['db', 'push'], t2()); const waited = Date.now() - t0
    assert.notEqual(r.status, 0); assert.match(r.out, /lock timeout|55P03/); assert.ok(waited < 8000, `failed fast (${waited} ms), it did not wait for the lock`)
    assert.equal((await client.query("select count(*)::int n from information_schema.columns where table_name = 't' and column_name = 'c'")).rows[0].n, 0, 'nothing was applied')
    assert.equal((await client.query("select count(*)::int n from supabase_migrations.schema_migrations where version = '002'")).rows[0].n, 0, 'nothing was recorded')
    await holder.query('rollback'); await holder.end()
    r = await runCli(['db', 'push'], t2()); assert.equal(r.status, 0, r.out); assert.match(r.out, /Applying migration 002_alter\.sql/); assert.ok(!/Applying migration 001/.test(r.out), 'the already applied migration is not pushed again')
    assert.equal((await client.query("select count(*)::int n from information_schema.columns where table_name = 't' and column_name = 'c'")).rows[0].n, 1)
  } finally { await client.end() }
})

test('real CLI: a statement longer than statement_timeout rolls the whole migration file back (the server-side behaviour the 120 s limit relies on)', async () => {
  // the guard fixes the client-side limit at 120 s, so this proof lowers it on the already built target; it tests the CLI and the server, not the guard
  const t = target(servers.good, { env: baseEnv({ PGOPTIONS: '-c lock_timeout=2s -c statement_timeout=120000' }) }); t.env.PGOPTIONS = '-c lock_timeout=2000ms -c statement_timeout=1500ms'
  const admin = new pg.Client({ host: R.HOST, port: servers.good.port, user: 'postgres', password: R.PASSWORD, database: 'postgres', ssl: { ca: fs.readFileSync(pki.rootA, 'utf8') } }); await admin.connect()
  try {
    const base = fs.readFileSync(path.join(proj, 'supabase/migrations/001_base.sql'), 'utf8'); const alter = fs.readFileSync(path.join(proj, 'supabase/migrations/002_alter.sql'), 'utf8')
    setMigrations({ '001_base.sql': base, '002_alter.sql': alter, '003_slow.sql': 'create table public.zz_atomic (id int);\nselect pg_sleep(4);\n' })
    const r = await runCli(['db', 'push'], t); assert.notEqual(r.status, 0); assert.match(r.out, /statement timeout|57014/)
    assert.equal((await admin.query("select to_regclass('public.zz_atomic') is not null as yes")).rows[0].yes, false, 'the created table was rolled back with the file')
    assert.equal((await admin.query("select count(*)::int n from supabase_migrations.schema_migrations where version = '003'")).rows[0].n, 0)
    // with the intended 120 s limit the same file simply completes
    const ok = await runCli(['db', 'push'], target(servers.good)); assert.equal(ok.status, 0, ok.out)
    assert.equal((await admin.query("select to_regclass('public.zz_atomic') is not null as yes")).rows[0].yes, true)
  } finally { await admin.end() }
})
