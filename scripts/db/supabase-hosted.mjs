// Runs a Supabase CLI command against the hosted BAI project only. Before anything runs it checks that this checkout is
// linked (supabase/.temp/project-ref) to BAI_SUPABASE_PROJECT_REF, and it hands the database password to the CLI through
// SUPABASE_DB_PASSWORD (environment), never on the command line, so it does not show up in process listings or logs.
//
//   npm run hosted:supabase -- db push --dry-run
//   npm run hosted:supabase -- migration list
//   npm run hosted:supabase -- db advisors --type all
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { repoRoot } from './lib/migrations.mjs'

const ref = process.env.BAI_SUPABASE_PROJECT_REF
if (!ref || !/^[a-z0-9]{20}$/.test(ref)) { console.error('BAI_SUPABASE_PROJECT_REF is missing or malformed (see .env.example)'); process.exit(1) }
const linkedFile = path.join(repoRoot, 'supabase/.temp/project-ref')
const linked = fs.existsSync(linkedFile) ? fs.readFileSync(linkedFile, 'utf8').trim() : null
const args = process.argv.slice(2)
if (args[0] !== 'link' && linked !== ref) {
  console.error(linked ? `this checkout is linked to ${linked}, not the BAI project ${ref}; refusing` : `this checkout is not linked; run: npm run hosted:supabase -- link --project-ref ${ref}`)
  process.exit(1)
}
if (args[0] === 'link' && !args.includes(ref)) { console.error(`link only to the BAI project: --project-ref ${ref}`); process.exit(1) }
if (args.some((a) => /^--(db-url|password)$|^-p$/.test(a))) { console.error('pass credentials through .env.hosted.local, not flags'); process.exit(1) }

const needsDb = !['link', 'projects', 'login'].includes(args[0])
const linkedFlag = needsDb && !args.includes('--linked') && !args.includes('--local') ? ['--linked'] : []
const env = { ...process.env, SUPABASE_DB_PASSWORD: process.env.BAI_SUPABASE_DB_PASSWORD ?? '' }
const res = spawnSync(path.join(repoRoot, 'node_modules/.bin/supabase'), [...args, ...linkedFlag], { stdio: 'inherit', env, cwd: repoRoot })
process.exit(res.status ?? 1)
