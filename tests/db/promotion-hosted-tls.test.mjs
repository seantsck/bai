// The TLS-verified connection of the hosted promotion runner (scripts/db/lib/hosted-connection.mjs), proved on the FINAL connection of the ACTUAL node-postgres client against disposable
// local PostgreSQL servers that present different certificates: a trusted CA with the right name is accepted; a self-signed certificate, an untrusted CA, a certificate for another host
// name, a server without TLS and the wrong CA file are refused; session timeouts arrive as startup options; every redirecting environment variable is refused. LOCAL ONLY.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as R from '../support/tls-rig.mjs'
import { PINNED_CA } from '../../scripts/db/lib/verified-push.mjs'
import { FORBIDDEN_NODE_ENV, HostedConnectionError, SESSION_TIMEOUTS, connectHosted, hostedClientConfig } from '../../scripts/db/lib/hosted-connection.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REF = 'dbnmktidheefoxaztivm'
let work, pki; const servers = {}
before(async () => {
  work = R.tmpDir('bai-hosttls-'); pki = R.makePki(path.join(work, 'pki'))
  for (const [name, cert] of [['good', 'good'], ['selfsigned', 'selfsigned'], ['untrusted', 'untrusted'], ['wrongname', 'wrongname'], ['notls', null]]) servers[name] = await R.startServer(work, pki, name, cert)
}, { timeout: 180000 })
after(async () => { for (const s of Object.values(servers)) await s.stop().catch(() => {}); fs.rmSync(work, { recursive: true, force: true }) })

const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, BAI_SUPABASE_PROJECT_REF: REF, BAI_SUPABASE_DB_PASSWORD: R.PASSWORD, ...extra })
const ep = (s) => ({ host: R.HOST, port: s.port, user: 'postgres', database: 'postgres' })
const opts = (server, over = {}) => ({ ref: REF, expectedRef: REF, repoRoot: root, env: env(), testOnly: { endpoint: ep(server), caFile: pki.rootA, servername: R.HOST }, ...over })
const refusal = async (p) => p.then(() => null, (e) => `${e.constructor.name}: ${e.message}`)

test('a trusted CA and the right host name are accepted; the server reports an encrypted session with exactly the required timeouts', async () => {
  const { client, facts } = await connectHosted(opts(servers.good))
  try {
    assert.equal(facts.session.lock_timeout, '5s'); assert.equal(facts.session.statement_timeout, '2min'); assert.match(facts.tls_version, /^TLSv1\.[23]$/)
    assert.equal(SESSION_TIMEOUTS.lock_timeout_ms, 5000); assert.equal(SESSION_TIMEOUTS.statement_timeout_ms, 120000)
    const r = (await client.query("select current_setting('idle_in_transaction_session_timeout') i, (select application_name from pg_stat_activity where pid = pg_backend_pid()) a")).rows[0]
    assert.equal(r.a, 'bai-promotion-hosted'); assert.equal(r.i, '5min')
  } finally { await client.end() }
})

test('refused: a self-signed server, a server whose CA is not trusted, a certificate for another host name, a server without TLS, and the wrong CA file for a good server', async () => {
  for (const [name, re] of [['selfsigned', /self.signed|unable to verify|certificate/i], ['untrusted', /self.signed|unable to verify|certificate/i], ['wrongname', /Hostname\/IP does not match|altnames|certificate/i], ['notls', /does not support SSL|SSL/i]]) {
    const m = await refusal(connectHosted(opts(servers[name]))); assert.match(m ?? 'ACCEPTED', /HostedConnectionError/, name); assert.match(m, re, name)
    assert.ok(!m.includes(R.PASSWORD), `${name}: the password is not in the message`)
  }
  const wrongCa = await refusal(connectHosted(opts(servers.good, { testOnly: { endpoint: ep(servers.good), caFile: pki.rootB, servername: R.HOST } })))
  assert.match(wrongCa ?? 'ACCEPTED', /certificate|self.signed|unable to verify/i, 'the right server with a CA that did not sign it')
})

test('a wrong password is refused without echoing it; an unreachable port is refused', async () => {
  const m = await refusal(connectHosted(opts(servers.good, { env: env({ BAI_SUPABASE_DB_PASSWORD: 'definitely-wrong-password-1' }) })))
  assert.match(m ?? 'ACCEPTED', /password authentication failed|SCRAM|authentication/i); assert.ok(!m.includes('definitely-wrong-password-1'))
  const closed = await refusal(connectHosted(opts(servers.good, { testOnly: { endpoint: { ...ep(servers.good), port: 1 }, caFile: pki.rootA, servername: R.HOST } })))
  assert.match(closed ?? 'ACCEPTED', /ECONNREFUSED|could not open/)
})

test('a path that drops the startup options (as a pooler does) is refused: the session must carry lock_timeout 5s and statement_timeout 120000 ms', async () => {
  const m = await refusal(connectHosted(opts(servers.good, { testOnly: { endpoint: ep(servers.good), caFile: pki.rootA, servername: R.HOST, options: '' } })))
  assert.match(m ?? 'ACCEPTED', /did not receive the required timeouts/)
  const loose = await refusal(connectHosted(opts(servers.good, { testOnly: { endpoint: ep(servers.good), caFile: pki.rootA, servername: R.HOST, options: '-c lock_timeout=30s -c statement_timeout=120000ms' } })))
  assert.match(loose ?? 'ACCEPTED', /did not receive the required timeouts/, 'a longer lock timeout is refused too')
})

test('NODE_TLS_REJECT_UNAUTHORIZED=0 in the real process environment does not loosen the client: a self-signed server is still refused', () => {
  const script = `
    import { connectHosted } from ${JSON.stringify(path.join(root, 'scripts/db/lib/hosted-connection.mjs'))}
    const o = { ref: ${JSON.stringify(REF)}, expectedRef: ${JSON.stringify(REF)}, repoRoot: ${JSON.stringify(root)}, env: { BAI_SUPABASE_DB_PASSWORD: ${JSON.stringify(R.PASSWORD)} },
      testOnly: { endpoint: { host: ${JSON.stringify(R.HOST)}, port: ${servers.selfsigned.port}, user: 'postgres', database: 'postgres' }, caFile: ${JSON.stringify(pki.rootA)}, servername: ${JSON.stringify(R.HOST)} } }
    try { const { client } = await connectHosted(o); await client.end(); console.log('ACCEPTED') } catch (e) { console.log('REFUSED ' + e.message.split('\\n')[0]) }`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
  assert.match(r.stdout, /^REFUSED /); assert.ok(!/ACCEPTED/.test(r.stdout), r.stdout + r.stderr)
})

test('the configuration refuses everything but the exact approved shape', () => {
  const good = { ref: REF, expectedRef: REF, repoRoot: root, env: env(), testOnly: { endpoint: ep(servers.good), caFile: pki.rootA, servername: R.HOST } }
  assert.doesNotThrow(() => hostedClientConfig(good))
  const throws = (o, re, label) => assert.throws(() => hostedClientConfig({ ...good, ...o }), (e) => e instanceof HostedConnectionError && re.test(e.message), label)
  throws({ ref: 'short' }, /missing or malformed/, 'malformed ref'); throws({ expectedRef: 'b'.repeat(20) }, /not the project the authorization names/, 'another project'); throws({ expectedRef: undefined }, /no valid project reference/, 'no project in the authorization')
  throws({ env: env({ BAI_SUPABASE_DB_PASSWORD: undefined }) }, /DB_PASSWORD is not set/, 'no password'); throws({ env: env({ BAI_SUPABASE_DB_PASSWORD: 'short' }) }, /implausibly short/, 'short password')
  for (const k of ['PGSSLMODE', 'PGHOST', 'PGPASSWORD', 'DATABASE_URL', 'PGOPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'BAI_DATABASE_URL', 'BAI_ALLOW_REMOTE_DB', 'BAI_SUPABASE_CA_FILE', 'SSL_CERT_FILE', 'NODE_OPTIONS']) throws({ env: env({ [k]: '0' }) }, new RegExp(`${k} is set`), k)
  for (const k of FORBIDDEN_NODE_ENV) assert.throws(() => hostedClientConfig({ ...good, env: env({ [k]: 'x' }) }), HostedConnectionError, k)
  // the production shape (no test seam): only the pinned project's direct host, never a pooler, another host or a port other than 5432
  const prod = hostedClientConfig({ ref: REF, expectedRef: REF, repoRoot: root, env: env() })
  assert.equal(prod.config.host, `db.${REF}.supabase.co`); assert.equal(prod.config.port, 5432); assert.equal(prod.config.user, 'postgres'); assert.equal(prod.config.database, 'postgres')
  assert.equal(prod.config.ssl.rejectUnauthorized, true); assert.equal(prod.config.ssl.servername, `db.${REF}.supabase.co`); assert.match(prod.config.options, /lock_timeout=5000ms.*statement_timeout=120000ms/)
  assert.equal(prod.facts.ca.sha256, PINNED_CA.sha256); assert.ok(prod.config.ssl.ca.includes('BEGIN CERTIFICATE')); assert.ok(!JSON.stringify(prod.facts).includes(R.PASSWORD), 'the facts never carry the password')
  assert.equal(Object.keys(prod.config).includes('connectionString'), false, 'no URL: nothing to carry a password or redirect')
  // the host is derived from the project reference alone: nothing in the arguments can name a pooler, another host or another port
  const other = hostedClientConfig({ ref: 'c'.repeat(20), expectedRef: 'c'.repeat(20), repoRoot: root, env: env() }); assert.equal(other.config.host, `db.${'c'.repeat(20)}.supabase.co`)
})

test('without the test seam the pinned CA is mandatory: a test CA, a missing CA file or a CA that is not the Supabase root is refused', () => {
  const repo = path.join(work, 'fakerepo'); fs.mkdirSync(path.join(repo, 'supabase'), { recursive: true })
  assert.throws(() => hostedClientConfig({ ref: REF, expectedRef: REF, repoRoot: repo, env: env() }), /does not exist/)
  fs.copyFileSync(pki.rootA, path.join(repo, PINNED_CA.file))
  assert.throws(() => hostedClientConfig({ ref: REF, expectedRef: REF, repoRoot: repo, env: env() }), /is not the pinned Supabase root|CA subject/)
})

test('the connection module has no URL, no sslmode other than verify-equivalent, and the CLI never uses its test seam', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/db/lib/hosted-connection.mjs'), 'utf8')
  assert.ok(!/sslmode\s*=\s*(require|prefer|allow|disable|verify-ca)/.test(src)); assert.ok(!/rejectUnauthorized:\s*false/.test(src)); assert.ok(!/connectionString/.test(src.replace(/\/\/.*$/gm, '')))
  assert.ok(!/testOnly/.test(fs.readFileSync(path.join(root, 'scripts/db/promotion-hosted.mjs'), 'utf8')))
  assert.ok(!/promotion-hosted/.test(fs.readFileSync(path.join(root, 'scripts/db/lib/promotion.mjs'), 'utf8')), 'the local library knows nothing of the hosted runner')
})
