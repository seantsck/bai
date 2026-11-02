// The TLS-verified connection for the guarded Supabase migration push (scripts/db/supabase-hosted.mjs).
//
// WHY. The Supabase CLI's linked connection (`--linked`) does not demonstrably verify the database server's certificate: a self-signed server is accepted, and PGSSLMODE / PGSSLROOTCERT
// are ignored on that path (G6 R3 review, CLI 2.121.0). Encryption without a verified server identity does not meet the release requirements. The same CLI DOES enforce
// `sslmode=verify-full&sslrootcert=<ca>` when it is given `--db-url`, and honours PGPASSWORD and PGOPTIONS from its environment: tests/db/supabase-push-tls.test.mjs proves all of this
// on the final connection of the pinned CLI (self-signed, untrusted CA, wrong name, no TLS, missing or wrong CA are all refused; the right CA and name succeed).
//
// WHAT THIS MODULE DOES. It builds the ONLY target a gated push may use, from the pinned project identity alone:
//     postgresql://postgres@db.<ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<repo>/supabase/prod-ca-2021.crt        (no password in the URL)
// with the password in PGPASSWORD (a child-process environment variable, never an argument), PGOPTIONS carrying lock_timeout <= 5 s and statement_timeout = 120 s, and a scrubbed
// environment. It refuses everything ambiguous: a pooler or any other host, a project reference that is not the linked one, a CA file that is not the pinned Supabase root, an
// insecure SSL mode, any environment variable that could redirect the connection or weaken TLS, missing or loose timeouts. There is no switch that relaxes any of it.
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'

export class VerifiedPushError extends Error {}
const refuse = (m) => { throw new VerifiedPushError(m) }

/** The pinned Supabase root certificate (supabase/prod-ca-2021.crt): identity, validity, and the SHA-256 fingerprint of its DER encoding. */
export const PINNED_CA = Object.freeze({
  file: 'supabase/prod-ca-2021.crt',
  subjectCn: 'Supabase Root 2021 CA',
  sha256: '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
  minDaysLeft: 30
})
/** The CLI prints the machine-readable result (`{"dryRun":…,"migrations":[…]}`) only when asked, or when it detects an AI-agent environment; the gate's dry-run check reads it, so it is always requested. */
export const OUTPUT_FLAGS = Object.freeze(['--output-format', 'json'])
export const MAX_LOCK_TIMEOUT_MS = 5000
export const STATEMENT_TIMEOUT_MS = 120000
const REF_RE = /^[a-z0-9]{20}$/
const DAY = 86400e3

/** Environment variables that could redirect the connection, weaken TLS, or hide where the password comes from. Any one of them present is a refusal (nothing is silently dropped). */
export const FORBIDDEN_ENV = Object.freeze(['PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLSNI', 'PGSSLNEGOTIATION', 'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER',
  'PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGPASSWORD', 'PGSYSCONFDIR', 'PGREQUIRESSL', 'PGCHANNELBINDING', 'PGTARGETSESSIONATTRS', 'PGGSSENCMODE', 'PGSSLCOMPRESSION',
  'SUPABASE_CA_SKIP_VERIFY', 'SUPABASE_SSL_DEBUG', 'SUPABASE_POSTGRES_URL', 'SUPABASE_DB_URL', 'SUPABASE_DB_PASSWORD', 'DATABASE_URL', 'BAI_SUPABASE_CA_FILE'])
/** What the child process may see besides what this module sets. Nothing else is inherited (in particular no BAI_* and no *_URL, and no other password). */
const CHILD_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'NO_COLOR', 'TZ'])

/** The pinned CA file: exactly one PEM certificate, the Supabase root (identity and fingerprint), a CA, currently valid with at least 30 days left. Returns facts for the evidence. */
export function validateCaFile (file, { now = new Date(), pinned = PINNED_CA, requirePin = true } = {}) {
  let st
  try { st = fs.lstatSync(file) } catch { refuse(`the CA file ${file} does not exist`) }
  if (!st.isFile()) refuse(`the CA file ${file} is not a regular file`)
  if (st.size < 100 || st.size > 65536) refuse(`the CA file ${file} has an implausible size (${st.size} bytes)`)
  const pem = fs.readFileSync(file, 'utf8')
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
  if (blocks.length !== 1) refuse(`the CA file must hold exactly one certificate, it holds ${blocks.length}`)
  if (pem.replace(blocks[0], '').trim() !== '') refuse('the CA file holds something besides its one certificate')
  let cert; try { cert = new X509Certificate(blocks[0]) } catch { refuse('the CA file does not parse as an X.509 certificate') }
  if (!cert.ca) refuse('the CA certificate is not a certificate authority (basicConstraints CA:TRUE)')
  const cn = /(?:^|\n)CN=([^\n]*)/.exec(cert.subject)?.[1]
  if (requirePin && cn !== pinned.subjectCn) refuse(`the CA subject is "${cn}", not "${pinned.subjectCn}"`)
  if (requirePin && cert.fingerprint256 !== pinned.sha256) refuse(`the CA fingerprint ${cert.fingerprint256} is not the pinned Supabase root`)
  const from = new Date(cert.validFrom); const to = new Date(cert.validTo)
  if (!(from <= now)) refuse('the CA certificate is not yet valid')
  if (!(to.getTime() - now.getTime() >= pinned.minDaysLeft * DAY)) refuse(`the CA certificate expires ${to.toISOString().slice(0, 10)} (needs at least ${pinned.minDaysLeft} days left)`)
  return { file, subject_cn: cn, sha256: cert.fingerprint256, not_before: from.toISOString(), not_after: to.toISOString() }
}

const durationMs = (v) => {   // PostgreSQL's accepted spellings of a plain duration; anything else is ambiguous and refused
  const m = /^(\d+)(ms|s|min)?$/.exec(String(v).trim()); if (!m) return null
  const n = Number(m[1]); return m[2] === 's' ? n * 1000 : m[2] === 'min' ? n * 60000 : n
}
/** PGOPTIONS must be exactly `-c lock_timeout=<d> -c statement_timeout=<d>`, in either order: lock_timeout 1 ms .. 5 s, statement_timeout 120000 ms. Anything else (duplicates, other options, 0) is a refusal. */
export function parsePgOptions (text) {
  if (typeof text !== 'string' || text.trim() === '') refuse('PGOPTIONS is not set: the push must carry lock_timeout (at most 5s) and statement_timeout=120000')
  const parts = text.trim().split(/\s+/); const got = {}
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== '-c' || !parts[i + 1]) refuse('PGOPTIONS must consist of "-c name=value" pairs only')
    const m = /^(lock_timeout|statement_timeout)=(.+)$/.exec(parts[i + 1]); if (!m) refuse(`PGOPTIONS may set only lock_timeout and statement_timeout, found "${parts[i + 1].split('=')[0]}"`)
    if (m[1] in got) refuse(`PGOPTIONS sets ${m[1]} twice`)
    const ms = durationMs(m[2]); if (ms === null) refuse(`PGOPTIONS ${m[1]}="${m[2]}" is not a plain duration (use 5s, 5000ms or 120000)`)
    got[m[1]] = ms
  }
  if (!('lock_timeout' in got) || !('statement_timeout' in got)) refuse('PGOPTIONS must set both lock_timeout and statement_timeout')
  if (!(got.lock_timeout >= 1 && got.lock_timeout <= MAX_LOCK_TIMEOUT_MS)) refuse(`lock_timeout is ${got.lock_timeout} ms; it must be between 1 ms and ${MAX_LOCK_TIMEOUT_MS} ms (0 means no timeout)`)
  if (got.statement_timeout !== STATEMENT_TIMEOUT_MS) refuse(`statement_timeout is ${got.statement_timeout} ms; it must be exactly ${STATEMENT_TIMEOUT_MS} ms`)
  return { lock_timeout_ms: got.lock_timeout, statement_timeout_ms: got.statement_timeout }
}

/** The direct database endpoint of a Supabase project, derived from the project reference alone. */
export function directEndpoint (ref) {
  if (!REF_RE.test(ref ?? '')) refuse('the project reference is missing or malformed')
  return { host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres', database: 'postgres' }
}

/** The endpoint must be exactly the direct host of the pinned project: not a pooler, not another project, not an address literal, not another port, user or database. */
export function assertDirectEndpoint (ep, ref) {
  if (!ep || typeof ep !== 'object') refuse('there is no endpoint')
  if (/pooler|pgbouncer|supavisor/i.test(String(ep.host))) refuse('a pooler endpoint is refused: the push connects to the direct database host only')
  if (ep.host !== `db.${ref}.supabase.co`) refuse(`the host ${ep.host} is not db.${ref}.supabase.co`)
  if (ep.port !== 5432) refuse(`the port ${ep.port} is not 5432`)
  if (ep.user !== 'postgres' || ep.database !== 'postgres') refuse('the user and database must be postgres')
}

/**
 * Builds { args, env, facts } for `supabase db push` against the pinned project. Throws VerifiedPushError (with no secret in the message) on anything that is not exactly the approved shape.
 * @param {object} o
 * @param {string} o.ref            the project reference (BAI_SUPABASE_PROJECT_REF)
 * @param {string|null} o.linkedRef the checkout's supabase/.temp/project-ref
 * @param {string} o.repoRoot       the checkout (the CA file is read from here)
 * @param {NodeJS.ProcessEnv} o.env the caller's environment
 * @param {boolean} o.requireTimeouts true for a real push (PGOPTIONS mandatory); a dry run applies nothing and may omit it, but a present PGOPTIONS must still be valid
 * @param {object} [o.testOnly]     TESTS ONLY, never passed by the guard (a test asserts that): { endpoint, caFile } to aim the verified path at a disposable local server with a test CA
 */
export function buildVerifiedTarget ({ ref, linkedRef, repoRoot, env, requireTimeouts, now = new Date(), testOnly = null }) {
  if (!REF_RE.test(ref ?? '')) refuse('BAI_SUPABASE_PROJECT_REF is missing or malformed')
  if (!testOnly && linkedRef !== ref) refuse(`this checkout is linked to ${linkedRef ?? 'no project'}, not to ${ref}`)
  for (const k of FORBIDDEN_ENV) if (k in env) refuse(`the environment variable ${k} is set; it could change where or how the push connects, so the push refuses to run with it`)
  const password = env.BAI_SUPABASE_DB_PASSWORD; if (!password) refuse('BAI_SUPABASE_DB_PASSWORD is not set')
  if (password.length < 8) refuse('BAI_SUPABASE_DB_PASSWORD is implausibly short (under 8 characters); a password that short cannot be reliably kept out of output')
  const ep = testOnly?.endpoint ?? directEndpoint(ref)
  if (!testOnly) assertDirectEndpoint(ep, ref)
  const caFile = testOnly?.caFile ?? path.join(repoRoot, PINNED_CA.file)
  const ca = validateCaFile(caFile, { now, requirePin: !testOnly })
  let timeouts = null
  if (requireTimeouts || (env.PGOPTIONS ?? '') !== '') timeouts = parsePgOptions(env.PGOPTIONS)
  const url = `postgresql://${ep.user}@${ep.host}:${ep.port}/${ep.database}?sslmode=verify-full&sslrootcert=${encodeURIComponent(caFile)}`
  const u = new URL(url)
  if (u.password !== '' || u.username !== 'postgres' && !testOnly) refuse('internal error: the connection URL would carry a password')
  if (u.searchParams.get('sslmode') !== 'verify-full') refuse('internal error: the SSL mode is not verify-full')
  const childEnv = {}
  for (const k of CHILD_ENV_ALLOW) if (env[k] !== undefined) childEnv[k] = env[k]
  Object.assign(childEnv, { PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile })
  if (timeouts) childEnv.PGOPTIONS = `-c lock_timeout=${timeouts.lock_timeout_ms}ms -c statement_timeout=${timeouts.statement_timeout_ms}ms`
  return {
    args: ['--db-url', url], env: childEnv,
    facts: { host: ep.host, port: ep.port, ssl: 'verify-full', ca: { subject_cn: ca.subject_cn, sha256: ca.sha256, not_after: ca.not_after }, timeouts, password_in: 'child environment PGPASSWORD only' }
  }
}

/** Replaces every occurrence of the secret in text (CLI output is echoed through this, so a CLI that ever printed the password would not leak it). */
export const redact = (text, secret) => (secret ? String(text).split(secret).join('***') : String(text))
