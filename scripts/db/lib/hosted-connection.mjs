// The ONLY database connection the hosted promotion runner (scripts/db/promotion-hosted.mjs) may open: a node-postgres client to the pinned project's direct host,
// with the server certificate verified against the pinned Supabase root CA and the host name checked, and bounded lock/statement timeouts sent as startup options.
//
// It is built from the project reference alone. There is no way to hand it a URL, a pooler, another host or port, another database or user, a weaker SSL mode, a different CA, or
// timeouts outside the approved bounds. node-postgres is given `ssl: { ca, rejectUnauthorized: true, servername }` explicitly, so neither NODE_TLS_REJECT_UNAUTHORIZED nor any
// PG* variable can loosen it; those variables are refused anyway rather than silently ignored. The password goes into the client configuration (never an argument, a URL or a log line).
// tests/db/promotion-hosted-tls.test.mjs drives the real client against servers presenting a valid, a self-signed, an untrusted-CA and a wrong-name certificate, and a server without TLS.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'
import { FORBIDDEN_ENV, MAX_LOCK_TIMEOUT_MS, PINNED_CA, STATEMENT_TIMEOUT_MS, assertDirectEndpoint, directEndpoint, redact, validateCaFile } from './verified-push.mjs'

export class HostedConnectionError extends Error {}
const refuse = (m) => { throw new HostedConnectionError(m) }
const REF_RE = /^[a-z0-9]{20}$/

/** Anything beyond the push guard's list that could redirect, proxy or weaken a Node TLS connection or select another database. */
export const FORBIDDEN_NODE_ENV = Object.freeze(['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY',
  'BAI_DATABASE_URL', 'BAI_PUBLIC_DATABASE_URL', 'BAI_REVIEWER_DATABASE_URL', 'BAI_ALLOW_REMOTE_DB', 'PGOPTIONS', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGCLIENTENCODING', 'PGPASSFILE'])

/** Startup options sent on the connection (a direct connection honours them; poolers ignore them, which is one more reason poolers are refused). */
export const SESSION_TIMEOUTS = Object.freeze({ lock_timeout_ms: MAX_LOCK_TIMEOUT_MS, statement_timeout_ms: STATEMENT_TIMEOUT_MS })

/**
 * The client configuration for the pinned project. Throws HostedConnectionError (with no secret in the message) on anything but the exact approved shape.
 * @param {object} o
 * @param {string} o.ref            BAI_SUPABASE_PROJECT_REF
 * @param {string} o.expectedRef    the project the authorization/manifest names (must equal ref)
 * @param {string} o.repoRoot       the checkout (the CA file is read from here)
 * @param {NodeJS.ProcessEnv} o.env the caller's environment
 * @param {object} [o.testOnly]     TESTS ONLY, never passed by the CLI (a test asserts that): { endpoint:{host,port,user,database}, caFile, servername, options } to aim the verified path at a disposable local server
 */
export function hostedClientConfig ({ ref, expectedRef, repoRoot, env, now = new Date(), testOnly = null }) {
  if (!REF_RE.test(ref ?? '')) refuse('BAI_SUPABASE_PROJECT_REF is missing or malformed')
  if (!REF_RE.test(expectedRef ?? '')) refuse('the authorization names no valid project reference')
  if (ref !== expectedRef) refuse('the configured project is not the project the authorization names')
  for (const k of [...FORBIDDEN_ENV.filter((x) => x !== 'BAI_SUPABASE_CA_FILE'), ...FORBIDDEN_NODE_ENV, 'BAI_SUPABASE_CA_FILE']) if (k in env) refuse(`the environment variable ${k} is set; it could change where or how the runner connects, so it refuses to run with it`)
  const password = env.BAI_SUPABASE_DB_PASSWORD
  if (!password) refuse('BAI_SUPABASE_DB_PASSWORD is not set')
  if (password.length < 8) refuse('BAI_SUPABASE_DB_PASSWORD is implausibly short (under 8 characters)')
  const ep = testOnly?.endpoint ?? directEndpoint(ref)
  if (!testOnly) assertDirectEndpoint(ep, ref)
  const caFile = testOnly?.caFile ?? path.join(repoRoot, PINNED_CA.file)
  const ca = validateCaFile(caFile, { now, requirePin: !testOnly })
  const config = {
    host: ep.host, port: ep.port, user: ep.user, database: ep.database, password,
    ssl: { ca: fs.readFileSync(caFile, 'utf8'), rejectUnauthorized: true, servername: testOnly?.servername ?? ep.host, minVersion: 'TLSv1.2' },
    options: testOnly?.options ?? `-c lock_timeout=${SESSION_TIMEOUTS.lock_timeout_ms}ms -c statement_timeout=${SESSION_TIMEOUTS.statement_timeout_ms}ms -c idle_in_transaction_session_timeout=300000ms`,
    application_name: 'bai-promotion-hosted', connectionTimeoutMillis: 15000, keepAlive: true, query_timeout: SESSION_TIMEOUTS.statement_timeout_ms + 15000
  }
  return { config, facts: { host: ep.host, port: ep.port, ssl: 'verify-full (rejectUnauthorized, host name checked)', ca: { subject_cn: ca.subject_cn, sha256: ca.sha256, not_after: ca.not_after }, timeouts: SESSION_TIMEOUTS }, password }
}

/** Opens the connection and proves, from the server's side, that it is the intended session. Returns { client, facts }. The caller must end() the client. */
export async function connectHosted (opts) {
  const { config, facts, password } = hostedClientConfig(opts)
  const client = new pg.Client(config)
  client.on('error', () => {})   // a late socket error after a deliberate end() must not crash the runner
  try { await client.connect() } catch (e) { throw new HostedConnectionError(`could not open a verified connection: ${redact(String(e.code ? `${e.code}: ${e.message}` : e.message).split('\n')[0], password)}`) }
  try {
    const s = (await client.query(`select current_database() db, current_user usr, current_setting('lock_timeout') lt, current_setting('statement_timeout') st,
      (select ssl from pg_stat_ssl where pid = pg_backend_pid()) ssl, (select version from pg_stat_ssl where pid = pg_backend_pid()) tls, inet_server_port() port,
      current_setting('server_version') v, current_setting('transaction_read_only') ro`)).rows[0]
    if (s.ssl !== true) refuse('the server reports that this session is not encrypted')
    if (s.db !== config.database || s.usr !== config.user) refuse('the session is not the expected database and user')
    const ms = (v) => { const m = /^(\d+)(ms|s|min)?$/.exec(v); return m ? Number(m[1]) * ({ ms: 1, s: 1000, min: 60000 }[m[2] ?? 'ms']) : NaN }
    if (ms(s.lt) !== SESSION_TIMEOUTS.lock_timeout_ms || ms(s.st) !== SESSION_TIMEOUTS.statement_timeout_ms) refuse(`the session did not receive the required timeouts (lock_timeout ${s.lt}, statement_timeout ${s.st}); a pooler or proxy may be in the way`)
    if (!opts.testOnly && s.port !== 5432) refuse(`the server answers on port ${s.port}, not 5432`)
    return { client, facts: { ...facts, tls_version: s.tls, server_version: s.v, session: { database: s.db, user: s.usr, lock_timeout: s.lt, statement_timeout: s.st } } }
  } catch (e) { await client.end().catch(() => {}); throw e }
}
