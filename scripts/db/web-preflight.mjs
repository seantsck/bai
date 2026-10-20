// Preflight for `npm run hosted:start`: the app must read the hosted BAI project through the least-privilege bai_web
// role, never silently fall back to the local database or to the owner credential. Prints no secrets.
import pg from 'pg'
import { supabaseProjectRef } from './lib/connection.mjs'

const url = process.env.BAI_PUBLIC_DATABASE_URL
const ref = process.env.BAI_SUPABASE_PROJECT_REF
const die = (m) => { console.error(`hosted preflight: ${m}`); process.exit(1) }
if (!url) die('BAI_PUBLIC_DATABASE_URL is not set (run npm run hosted:web-role -- --confirm-hosted <ref>)')
if (!ref || supabaseProjectRef(url) !== ref) die('BAI_PUBLIC_DATABASE_URL does not point at the BAI project')
if (!/^bai_web(\.[a-z0-9]{20})?$/.test(decodeURIComponent(new URL(url).username))) die('the web server must connect as bai_web, not the owner role')
for (const k of Object.keys(process.env)) {
  if (k.startsWith('NEXT_PUBLIC_') && /SECRET|SERVICE|PASSWORD|DATABASE_URL/i.test(k)) die(`${k} would expose a server-only credential to the browser`)
}
const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  await db.query('begin read only')
  await db.query('set local role anon')
  const { rows: [r] } = await db.query('select count(*)::int n from organizations')
  await db.query('rollback')
  console.log(`hosted preflight: bai_web -> anon read OK on project ${ref} (${r.n} organizations)`)
} finally { await db.end() }
