// Runs a Supabase CLI command against the hosted BAI project only. Before anything runs it checks that this checkout is
// linked (supabase/.temp/project-ref) to BAI_SUPABASE_PROJECT_REF, and it hands the database password to the CLI through
// SUPABASE_DB_PASSWORD (environment), never on the command line, so it does not show up in process listings or logs.
//
//   npm run hosted:supabase -- db push --dry-run
//   npm run hosted:supabase -- migration list
//   npm run hosted:supabase -- db advisors --type all
//
// `db push` (a real push or its dry run) never uses the CLI's linked connection: it connects ONLY to db.<ref>.supabase.co:5432 with sslmode=verify-full against the pinned Supabase root CA
// (scripts/db/lib/verified-push.mjs; the CLI's linked connection does not verify the server certificate). The password travels in PGPASSWORD, never in an argument. A real push also
// requires PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120000' (lock_timeout at most 5 s). Any ambiguity is a refusal.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { repoRoot } from './lib/migrations.mjs'
import { PROTOCOL_V2_ENFORCED, verifyRecordFile } from './lib/final-parity.mjs'
import { OUTPUT_FLAGS, VerifiedPushError, buildVerifiedTarget, redact } from './lib/verified-push.mjs'

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
  const extra = args.slice(2)
  if (extra.length) { console.error(`refusing: db push takes no extra flags under a gate (${extra.join(' ')}); the connection is fixed to the verified direct endpoint`); process.exit(1) }
  // the verified target is built (and every TLS, endpoint, CA and timeout rule checked) BEFORE any network contact: a push that cannot be verified is refused here
  try { buildVerifiedTarget({ ref, linkedRef: linked, repoRoot, env: process.env, requireTimeouts: true }) } catch (e) { if (e instanceof VerifiedPushError) { console.error(`refusing: ${e.message}; nothing was pushed`); process.exit(1) } throw e }
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

const isPush = args[0] === 'db' && args[1] === 'push'
if (isPush) {
  // db push (real or --dry-run) over the verified connection only. No --linked, no pooler, no fallback.
  const dry = args.includes('--dry-run')
  if (args.slice(2).some((a) => a !== '--dry-run')) { console.error(`refusing: db push takes no flags except --dry-run (${args.slice(2).filter((a) => a !== '--dry-run').join(' ')})`); process.exit(1) }
  let target
  try { target = buildVerifiedTarget({ ref, linkedRef: linked, repoRoot, env: process.env, requireTimeouts: !dry }) } catch (e) { if (e instanceof VerifiedPushError) { console.error(`refusing: ${e.message}; nothing was pushed`); process.exit(1) } throw e }
  const secret = process.env.BAI_SUPABASE_DB_PASSWORD
  const res = spawnSync(path.join(repoRoot, 'node_modules/.bin/supabase'), ['db', 'push', ...(dry ? ['--dry-run'] : []), ...OUTPUT_FLAGS, ...target.args], { env: target.env, cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (res.stdout) process.stdout.write(redact(res.stdout, secret)); if (res.stderr) process.stderr.write(redact(res.stderr, secret))
  if (!dry && res.status === 0) console.log(`verified connection: ${target.facts.host}:${target.facts.port}, sslmode ${target.facts.ssl}, CA ${target.facts.ca.subject_cn} sha256 ${target.facts.ca.sha256}, lock_timeout ${target.facts.timeouts.lock_timeout_ms} ms, statement_timeout ${target.facts.timeouts.statement_timeout_ms} ms`)
  process.exit(res.status ?? 1)
}

const needsDb = !['link', 'projects', 'login'].includes(args[0])
const linkedFlag = needsDb && !args.includes('--linked') && !args.includes('--local') ? ['--linked'] : []
const env = { ...process.env, SUPABASE_DB_PASSWORD: process.env.BAI_SUPABASE_DB_PASSWORD ?? '' }
const res = spawnSync(path.join(repoRoot, 'node_modules/.bin/supabase'), [...args, ...linkedFlag], { stdio: 'inherit', env, cwd: repoRoot })
process.exit(res.status ?? 1)
