// Security verifier for a BAI database. Checks the declared model from the catalog (grants, RLS, policies, view/function settings, the reviewer boundary),
// then proves it behaviourally. Two explicit modes (scripts/db/lib/security-audit.mjs):
//   FULL       (a disposable LOCAL database; the default there)   attempts every private operation as anon and authenticated, each rolled back.
//   READ-ONLY  (--read-only; REQUIRED for any non-local database) one `begin read only` transaction, plain SELECT probes only, HTTP GET only: it cannot
//              INSERT, UPDATE, DELETE, TRUNCATE or run DDL, sends no POST/PATCH/DELETE, and calls no function with side effects.
// A non-local database without --read-only is refused before any connection is made; neither mode falls back to the other.
// Exit 1 on any failure. Optional: BAI_SUPABASE_URL + BAI_SUPABASE_PUBLISHABLE_KEY also probe the Data API (GET only unless it and the database are local).
//
//   npm run db:security        npm run hosted:security   (= --read-only)
import pg from 'pg'
import { ownerDatabaseUrl, isLocalUrl } from './lib/connection.mjs'
import { runSecurityAudit } from './lib/security-audit.mjs'

const json = process.argv.includes('--json')
const readOnly = process.argv.includes('--read-only')
const url = ownerDatabaseUrl()
const localDb = isLocalUrl(url)
if (!localDb && !readOnly) {
  console.error('refusing: this is not a local database, and the full behavioural audit attempts writes (rolled back) and HTTP POST/DELETE probes.\nRun the read-only audit instead: add --read-only (npm run hosted:security does).')
  process.exit(2)
}
const db = new pg.Client({ connectionString: url })
await db.connect()
let result
try { result = await runSecurityAudit(db, { readOnly, localDb }) } finally { await db.end() }
const { failures, notes, functions: fnAudit, behaviour, data_api: api } = result
if (json) console.log(JSON.stringify(result, null, 2))
else {
  console.log(readOnly ? 'mode: READ-ONLY (no INSERT/UPDATE/DELETE/TRUNCATE/DDL; no HTTP POST/PATCH/DELETE; no side-effect functions)' : 'mode: FULL behavioural audit (disposable local database; every write probe is rolled back)')
  for (const n of notes) console.log(n)
  console.log(`functions audited: ${fnAudit.length} (SECURITY DEFINER: ${fnAudit.filter((f) => f.security === 'DEFINER').length}; executable by PUBLIC/anon/authenticated: ${fnAudit.filter((f) => f.public_execute || f.anon_execute || f.authenticated_execute).length}; search_path unset: ${fnAudit.filter((f) => f.search_path === 'NOT SET').length})`)
  console.table(fnAudit.map(({ function: f, security, search_path: sp, service_role_execute: s }) => ({ function: f, security, search_path: sp, service_role_execute: s })))
  const denied = behaviour.filter((b) => b.outcome === 'denied' || b.outcome.startsWith('empty')).length
  console.log(`behavioural attempts as anon/authenticated: ${behaviour.length} (denied or invisible: ${denied})`)
  if (api.length) console.table(api)
  console.log(failures.length ? `SECURITY FAILED (${failures.length})\n  ${failures.join('\n  ')}` : `SECURITY OK${readOnly ? ' (read-only audit)' : ''}`)
}
process.exit(failures.length ? 1 : 0)
