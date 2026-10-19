// Resolves the database URL for owner-level scripts and refuses anything that looks like a hosted/production target unless
// explicitly allowed. BAI never talks to DISI's database.
//
// Hosted guardrails:
//   * a non-local host needs BAI_ALLOW_REMOTE_DB=1 (set only in .env.hosted.local);
//   * the host must belong to the BAI project named by BAI_SUPABASE_PROJECT_REF, so a URL pasted from another project
//     (DISI's, for instance) is refused before connecting;
//   * scripts that write (research import/validate/apply --write/resolve --write/identity, read-model refresh) must also
//     be given --confirm-hosted <project ref> on the command line: hosted writes are always deliberate.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]']
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/** Supabase project ref of a connection URL (direct `db.<ref>.supabase.co` or pooler user `postgres.<ref>`), else null. */
export function supabaseProjectRef (url) {
  const u = new URL(url)
  const direct = u.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/)
  if (direct) return direct[1]
  const pooled = decodeURIComponent(u.username).match(/^[a-z_]+\.([a-z0-9]{20})$/)
  if (pooled && u.hostname.endsWith('.pooler.supabase.com')) return pooled[1]
  return null
}

export const isLocalUrl = (url) => LOCAL_HOSTS.includes(new URL(url).hostname)

/**
 * Hosted owner URL built from BAI_SUPABASE_PROJECT_REF + BAI_SUPABASE_DB_PASSWORD (direct connection, TLS verified against
 * the Supabase root CA in supabase/prod-ca-2021.crt), so the raw password never has to be hand-encoded into a URL.
 */
export function hostedOwnerUrl () {
  const ref = process.env.BAI_SUPABASE_PROJECT_REF
  const password = process.env.BAI_SUPABASE_DB_PASSWORD
  if (!ref || !password) return null
  const ca = path.resolve(REPO_ROOT, process.env.BAI_SUPABASE_CA_FILE || 'supabase/prod-ca-2021.crt')
  return `postgresql://postgres:${encodeURIComponent(password)}@db.${ref}.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}` // credential-scan:allow (template filled from the environment)
}

export function ownerDatabaseUrl ({ localOnly = false } = {}) {
  const url = process.env.BAI_DATABASE_URL || process.env.DATABASE_URL || hostedOwnerUrl()
  if (!url) throw new Error('Set BAI_DATABASE_URL (see .env.example). Start a local PostgreSQL 17 with `npm run db:server`.')
  if (isLocalUrl(url)) return url
  const host = new URL(url).hostname
  if (localOnly) throw new Error(`refusing non-local database host ${host}: this script is local-only`)
  if (process.env.BAI_ALLOW_REMOTE_DB !== '1') throw new Error(`refusing non-local database host ${host} (set BAI_ALLOW_REMOTE_DB=1 deliberately)`)
  const expected = process.env.BAI_SUPABASE_PROJECT_REF
  if (!expected) throw new Error('refusing remote database: BAI_SUPABASE_PROJECT_REF is not set')
  const ref = supabaseProjectRef(url)
  if (ref !== expected) throw new Error(`refusing remote database: it does not belong to BAI project ${expected}`)
  return url
}

/** For writing scripts: on a hosted target, require `--confirm-hosted <ref>` naming the configured BAI project. */
export function requireHostedWriteConfirmation (url, argv = process.argv) {
  if (isLocalUrl(url)) return { hosted: false }
  const i = argv.indexOf('--confirm-hosted')
  const given = i >= 0 ? argv[i + 1] : null
  const ref = supabaseProjectRef(url)
  if (!given || given !== ref) throw new Error(`this writes to the hosted BAI database; re-run with --confirm-hosted ${ref} once you mean it`)
  return { hosted: true, ref }
}
