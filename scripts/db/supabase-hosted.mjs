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
import { PROTOCOL_V2_ENFORCED, verifyRecordFile } from './lib/final-parity.mjs'

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

// A push applies every committed migration that hosted has not got, so it is only allowed under a gate (scripts/db/gate.mjs): BAI_GATE_FILE must name the gate
// file, the working directory must be the gate's restricted checkout, and `gate.mjs check --dry-run` must pass (it runs the dry run itself and demands exactly the
// gate's migration). No push-widening flag is accepted.
if (args[0] === 'db' && args[1] === 'push' && !args.includes('--dry-run')) {
  const extra = args.slice(2).filter((a) => a !== '--linked')
  if (extra.length) { console.error(`refusing: db push takes no extra flags under a gate (${extra.join(' ')})`); process.exit(1) }
  const gateFile = process.env.BAI_GATE_FILE
  if (!gateFile || !fs.existsSync(gateFile)) { console.error('refusing: db push needs BAI_GATE_FILE=<gate file> naming the authorized gate (scripts/db/gate.mjs); nothing was pushed'); process.exit(1) }
  const chk = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/db/gate.mjs'), 'check', '--gate', gateFile, '--dry-run'], { stdio: 'inherit', env: process.env, cwd: repoRoot })
  if (chk.status !== 0) { console.error('refusing: the gate check failed; nothing was pushed'); process.exit(1) }
  // G1 release protocol v2 (scripts/db/final-parity.mjs): when active (the reviewed constant, or BAI_REQUIRE_PARITY_RECORD=1, or whenever a record is offered), the push also needs
  // a PASS record of the final read-only parity check, fresh (10 minutes) and for a backup at most six hours old; nothing is pushed otherwise.
  const recordFile = process.env.BAI_PARITY_RECORD
  if (PROTOCOL_V2_ENFORCED || process.env.BAI_REQUIRE_PARITY_RECORD === '1' || recordFile) {
    if (!recordFile) { console.error('refusing: this push needs BAI_PARITY_RECORD=<record from scripts/db/final-parity.mjs>; nothing was pushed'); process.exit(1) }
    let problems
    try { problems = verifyRecordFile(recordFile, { gate: JSON.parse(fs.readFileSync(gateFile, 'utf8')) }) } catch (e) { problems = [e.message] }
    if (problems.length) { console.error(`refusing: the final parity record does not authorize this push; nothing was pushed\n  ${problems.join('\n  ')}`); process.exit(1) }
    console.log('final parity record verified (fresh, backup within six hours, off-site evidence matches this backup)')
  }
}

const needsDb = !['link', 'projects', 'login'].includes(args[0])
const linkedFlag = needsDb && !args.includes('--linked') && !args.includes('--local') ? ['--linked'] : []
const env = { ...process.env, SUPABASE_DB_PASSWORD: process.env.BAI_SUPABASE_DB_PASSWORD ?? '' }
const res = spawnSync(path.join(repoRoot, 'node_modules/.bin/supabase'), [...args, ...linkedFlag], { stdio: 'inherit', env, cwd: repoRoot })
process.exit(res.status ?? 1)
