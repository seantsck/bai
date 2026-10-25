// Production-gate tooling: makes "exactly this migration, from exactly this reviewed commit, to exactly this project" checkable. Nothing here writes to the
// hosted database; `check` reads it inside a read-only transaction.
//
//   node scripts/db/gate.mjs create  --gate G1 --commit <40-hex> --through 028 --project-ref <ref> --out <gate.json> [--repo <checkout>]
//        writes the gate file from the committed migrations at that commit (which must be on origin/main, i.e. reviewed) and prints its SHA-256
//   node scripts/db/gate.mjs workdir --gate <gate.json> --dir <new directory> [--repo <checkout>]
//        a detached git worktree at the gate's commit with every migration later than the gate's removed (so no tool can see, let alone push, a later one)
//   node --env-file=.env.hosted.local scripts/db/gate.mjs check --gate <gate.json> [--offline] [--dry-run]
//        run INSIDE the working directory: commit, files, checksums, project ref, hosted migration history and (with --dry-run) the CLI's dry-run list
//
// `hosted:supabase -- db push` refuses to run unless BAI_GATE_FILE names a gate file and `check --dry-run` passes (see scripts/db/supabase-hosted.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { buildGate, evaluateGate, parseDryRun, fileSha256, validateGateShape } from './lib/gate.mjs'
import { checksum, listMigrations, repoRoot } from './lib/migrations.mjs'
import { ownerDatabaseUrl, supabaseProjectRef, isLocalUrl } from './lib/connection.mjs'

const [cmd, ...argv] = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr.trim()}`); return r.stdout }
const die = (m, code = 1) => { console.error(m); process.exit(code) }

if (cmd === 'create') {
  const repo = path.resolve(opt('repo') ?? repoRoot); const commit = opt('commit'); const out = opt('out')
  if (!commit || !out || !opt('through') || !opt('project-ref')) die('usage: create --gate <name> --commit <sha> --through <NNN> --project-ref <ref> --out <file>', 2)
  if (fs.existsSync(out)) die(`refusing to overwrite ${out}`, 2)
  git(repo, 'cat-file', '-e', `${commit}^{commit}`)
  const onMain = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], { cwd: repo }).status === 0
  if (!onMain) die(`commit ${commit.slice(0, 12)} is not an ancestor of origin/main: only reviewed (merged) code can be a gate's commit`)
  const names = git(repo, 'ls-tree', '--name-only', commit, 'database/migrations/').split('\n').filter((n) => /\/\d{3}_[a-z0-9_]+\.sql$/.test(n))
  const migrations = names.map((n) => { const f = path.basename(n); return { version: f.slice(0, 3), file: f, checksum: checksum(git(repo, 'show', `${commit}:${n}`)) } })
  const gate = buildGate({ gate: opt('gate') ?? '', commit, through: opt('through'), projectRef: opt('project-ref'), migrations })
  fs.writeFileSync(out, JSON.stringify(gate, null, 2) + '\n')
  console.log(`gate file ${out}\n  commit ${gate.commit}\n  migration ${gate.migration_file} (${gate.checksums[gate.through]})\n  from level ${gate.from_level}, project ${gate.project_ref}\n  migrations_hash ${gate.migrations_hash}\n  gate file SHA-256 ${fileSha256(out)}`)
} else if (cmd === 'workdir') {
  const gateFile = opt('gate'); const dir = opt('dir'); const repo = path.resolve(opt('repo') ?? repoRoot)
  if (!gateFile || !dir) die('usage: workdir --gate <gate.json> --dir <new directory>', 2)
  const g = JSON.parse(fs.readFileSync(gateFile, 'utf8')); const bad = validateGateShape(g); if (bad.length) die(`gate file: ${bad.join('; ')}`)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) die(`refusing: ${dir} is not empty`, 2)
  git(repo, 'worktree', 'add', '--detach', path.resolve(dir), g.commit)
  for (const f of fs.readdirSync(path.join(dir, 'database/migrations'))) if (/^\d{3}_/.test(f) && f.slice(0, 3) > g.through) fs.rmSync(path.join(dir, 'database/migrations', f))
  if (fs.existsSync(path.join(repo, 'node_modules')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'))
    // a symlink is not matched by the tracked `node_modules/` ignore rule; exclude it locally (git's own info/exclude, not a tracked file) so the check sees no stray entry
    const exclude = path.resolve(dir, git(path.resolve(dir), 'rev-parse', '--git-path', 'info/exclude').trim())
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    if (!fs.existsSync(exclude) || !fs.readFileSync(exclude, 'utf8').split('\n').includes('/node_modules')) fs.appendFileSync(exclude, '/node_modules\n')
  }
  console.log(`working directory ${dir} at ${g.commit.slice(0, 12)} with migrations 001–${g.through} only.\nNext, inside it: place .env.hosted.local and supabase/.temp (both git-ignored), then\n  node --env-file=.env.hosted.local scripts/db/gate.mjs check --gate ${path.resolve(gateFile)} --offline`)
} else if (cmd === 'check') {
  const gateFile = opt('gate'); if (!gateFile) die('usage: check --gate <gate.json> [--offline] [--dry-run]', 2)
  const g = JSON.parse(fs.readFileSync(gateFile, 'utf8'))
  const facts = {
    head: git(repoRoot, 'rev-parse', 'HEAD').trim(),
    status: git(repoRoot, 'status', '--porcelain').split('\n').filter(Boolean),
    migrations: listMigrations().map((m) => ({ version: m.version, file: m.file, checksum: m.checksum })),
    env: { BAI_SUPABASE_PROJECT_REF: process.env.BAI_SUPABASE_PROJECT_REF },
    linkedRef: fs.existsSync(path.join(repoRoot, 'supabase/.temp/project-ref')) ? fs.readFileSync(path.join(repoRoot, 'supabase/.temp/project-ref'), 'utf8').trim() : null
  }
  if (!argv.includes('--offline')) {
    const url = ownerDatabaseUrl()
    // a LOCAL database can only be a rehearsal stand-in for the project (it cannot be hosted); anything else must name its Supabase project
    facts.urlRef = isLocalUrl(url) ? process.env.BAI_SUPABASE_PROJECT_REF : (supabaseProjectRef(url) ?? undefined)
    if (facts.urlRef === undefined) die('the database connection does not name a Supabase project; refusing')
    const c = new pg.Client({ connectionString: url }); await c.connect()
    try {
      await c.query('begin read only')
      const recorded = (await c.query('select version, file, checksum from bai_meta.schema_migrations order by version')).rows
      const pushed = (await c.query('select version from supabase_migrations.schema_migrations order by version')).rows.map((r) => r.version)
      await c.query('rollback')
      facts.hosted = { level: recorded.at(-1)?.version, recorded, pushed }
    } finally { await c.end() }
  }
  if (argv.includes('--dry-run')) {
    if (argv.includes('--offline')) die('--dry-run needs the hosted connection (omit --offline)', 2)
    const r = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/db/supabase-hosted.mjs'), 'db', 'push', '--dry-run'], { cwd: repoRoot, encoding: 'utf8', env: process.env, maxBuffer: 1 << 24 })
    facts.dryRun = r.status === 0 ? parseDryRun(r.stdout) : null
    if (facts.dryRun === null) console.error(`the dry run could not be read (exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`)
  }
  const problems = evaluateGate(g, facts)
  console.log(`gate ${g.gate || '(unnamed)'}: ${g.migration_file}, commit ${g.commit.slice(0, 12)}, project ${g.project_ref.slice(0, 4)}…`)
  console.log(`checked: ${['commit and working directory', 'migration files and checksums', 'project reference', facts.hosted ? 'hosted migration history (read-only)' : null, facts.dryRun !== undefined ? 'dry run lists exactly the gate migration' : null].filter(Boolean).join('; ')}`)
  console.log(problems.length ? `GATE CHECK FAILED\n  ${problems.join('\n  ')}` : 'GATE CHECK OK')
  process.exit(problems.length ? 1 : 0)
} else die('usage: gate.mjs create|workdir|check (see the header of this file)', 2)
