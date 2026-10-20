// Stores the web server's database URL in the BAI Vercel project as a sensitive variable. The value is built here from
// BAI_PUBLIC_DATABASE_URL (bai_web, written by npm run hosted:web-role) and goes to Vercel's API in a request body: it is
// never printed, logged, written to disk or put on a command line. Vercel functions have no IPv6 egress and the direct db.<ref> host is
// IPv6-only, so the URL goes through Supabase's IPv4 transaction pooler as bai_web.<ref>. lib/db.ts verifies the
// certificate against the bundled Supabase CA; no sslmode is carried in the URL.
//
//   npm run deploy:web-env -- --target preview --confirm-hosted <project ref>
// Requires a linked checkout (.vercel/project.json for project "bai") and VERCEL_TOKEN or a logged-in Vercel CLI.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { supabaseProjectRef } from '../db/lib/connection.mjs'

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const die = (m) => { console.error(`deploy:web-env: ${m}`); process.exit(1) }

const target = arg('--target')
if (!['preview', 'production'].includes(target)) die('--target preview|production is required')
const ref = process.env.BAI_SUPABASE_PROJECT_REF
if (!ref || arg('--confirm-hosted') !== ref) die('pass --confirm-hosted <BAI project ref>')
const linked = JSON.parse(fs.readFileSync('.vercel/project.json', 'utf8'))
if (linked.projectName !== 'bai') die(`this checkout is linked to Vercel project "${linked.projectName}", not "bai"`)

const web = process.env.BAI_PUBLIC_DATABASE_URL
if (!web || supabaseProjectRef(web) !== ref) die('BAI_PUBLIC_DATABASE_URL is not set for the BAI project (run npm run hosted:web-role)')
const source = new URL(web)
if (!/^bai_web(\.[a-z0-9]{20})?$/.test(decodeURIComponent(source.username))) die('BAI_PUBLIC_DATABASE_URL is not the bai_web role')

let host = process.env.BAI_SUPABASE_POOLER_HOST
if (!host) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/database/pooler`, { headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` } })
  if (!r.ok) die(`could not read the pooler configuration (HTTP ${r.status}); set BAI_SUPABASE_POOLER_HOST`)
  const primary = (await r.json()).find((p) => p.database_type === 'PRIMARY' && p.pool_mode === 'transaction')
  host = primary?.db_host
}
if (!host?.endsWith('.pooler.supabase.com')) die('no Supabase transaction pooler host found')

const url = new URL(`postgres://${host}:6543${source.pathname}`)
url.username = `bai_web.${ref}`
url.password = source.password
if (supabaseProjectRef(url.toString()) !== ref) die('pooler URL does not resolve to the BAI project')

const cliAuth = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'com.vercel.cli/auth.json')
const token = process.env.VERCEL_TOKEN || (fs.existsSync(cliAuth) ? JSON.parse(fs.readFileSync(cliAuth, 'utf8')).token : undefined)
if (!token) die('set VERCEL_TOKEN or log in with the Vercel CLI')
const api = `https://api.vercel.com/v10/projects/${linked.projectId}/env?teamId=${linked.orgId}&upsert=true`
const res = await fetch(api, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: 'BAI_PUBLIC_DATABASE_URL', value: url.toString(), type: 'sensitive', target: [target] })
})
if (!res.ok) die(`Vercel API refused the variable (HTTP ${res.status}): ${((await res.json().catch(() => ({}))).error?.code) ?? 'unknown'}`)
console.log(`BAI_PUBLIC_DATABASE_URL set for ${target} on Vercel project bai (sensitive; bai_web.<ref> via ${host}:6543; value not shown)`)
