// Migration isolation for a production gate (scripts/db/gate.mjs, lib/gate.mjs, the push refusal in scripts/db/supabase-hosted.mjs). Nothing here touches hosted:
// the integration part builds a throwaway git repository with a FAKE `supabase` binary that records every call, so a refusal is proven by the absence of a call.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { buildGate, evaluateGate, parseDryRun, migrationsHash, validateGateShape } from '../../scripts/db/lib/gate.mjs'
import { listMigrations, applyMigrations } from '../../scripts/db/lib/migrations.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REF = 'dbnmktidheefoxaztivm'
const COMMIT = 'a'.repeat(40)
const all = listMigrations().map((m) => ({ version: m.version, file: m.file, checksum: m.checksum }))
const gate = buildGate({ gate: 'G1', commit: COMMIT, through: '028', projectRef: REF, migrations: all })
const upTo = (v) => all.filter((m) => m.version <= v)
const goodFacts = () => ({
  head: COMMIT, status: all.filter((m) => m.version > '028').map((m) => ` D database/migrations/${m.file}`), migrations: upTo('028'),
  env: { BAI_SUPABASE_PROJECT_REF: REF }, linkedRef: REF, urlRef: REF,
  hosted: { level: '027', recorded: upTo('027'), pushed: upTo('027').map((m) => m.version) }, dryRun: [gate.migration_file]
})

test('the gate file is built from the committed migrations 001..028 and describes exactly one migration', () => {
  assert.equal(gate.migration_file, '028_transaction_forensics_foundation.sql'); assert.equal(gate.from_level, '027')
  assert.equal(Object.keys(gate.checksums).length, 28); assert.equal(gate.checksums['028'], '7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501')
  assert.equal(gate.migrations_hash, migrationsHash(gate.checksums)); assert.deepEqual(validateGateShape(gate), [])
  assert.throws(() => buildGate({ gate: 'x', commit: 'abc', through: '028', projectRef: REF, migrations: all }), /40-character/)
  assert.throws(() => buildGate({ gate: 'x', commit: COMMIT, through: '999', projectRef: REF, migrations: all }), /does not exist/)
})

test('every check passes for the authorized state, and each of the guard\'s refusals fires on exactly its own violation', () => {
  assert.deepEqual(evaluateGate(gate, goodFacts()), [])
  const bad = (mutate, re) => { const f = goodFacts(); mutate(f); const p = evaluateGate(gate, f); assert.ok(p.some((x) => re.test(x)), `${re}: got ${JSON.stringify(p)}`); return p }
  // 1. the exact reviewed commit, nothing else changed
  bad((f) => { f.head = 'b'.repeat(40) }, /HEAD is bbbbbbbbbbbb/)
  bad((f) => { f.status.push(' M database/migrations/028_transaction_forensics_foundation.sql') }, /unexpected change .*028_transaction/)
  bad((f) => { f.status.push(' M scripts/db/migrate.mjs') }, /unexpected change/)
  bad((f) => { f.status.push('?? database/migrations/031_extra.sql') }, /unexpected change/)
  bad((f) => { f.status.push(' D database/migrations/027_wikidata_attribution.sql') }, /unexpected change .*027/)
  // 2. migrations 001..028 and nothing later, unchanged
  bad((f) => { f.migrations = upTo('029') }, /later than 028 are present: 029/)
  bad((f) => { f.migrations = all }, /later than 028 are present: 029, 030/)
  bad((f) => { f.migrations = upTo('028').filter((m) => m.version !== '028') }, /not exactly 001–028|is not present/)
  bad((f) => { f.migrations = upTo('028').filter((m) => m.version !== '014') }, /not exactly 001–028/)
  bad((f) => { f.migrations = upTo('028').map((m) => (m.version === '028' ? { ...m, checksum: 'f'.repeat(64) } : m)) }, /028_transaction.* differs from the gate's checksum/)
  bad((f) => { f.migrations = upTo('028').map((m) => (m.version === '005' ? { ...m, checksum: 'f'.repeat(64) } : m)) }, /005_.* differs from the gate's checksum/)
  // 3. the project
  bad((f) => { f.env = { BAI_SUPABASE_PROJECT_REF: 'a'.repeat(20) } }, /BAI_SUPABASE_PROJECT_REF is not the gate's project/)
  bad((f) => { f.env = {} }, /BAI_SUPABASE_PROJECT_REF is not the gate's project/)
  bad((f) => { f.linkedRef = 'a'.repeat(20) }, /project-ref is aaaaaaaa/)
  bad((f) => { f.linkedRef = null }, /project-ref is missing/)
  bad((f) => { f.urlRef = 'a'.repeat(20) }, /different project/)
  // 4. hosted migration history
  bad((f) => { f.hosted.level = '028'; f.hosted.recorded = upTo('028'); f.hosted.pushed = upTo('028').map((m) => m.version) }, /hosted is at migration 028, the gate starts from 027/)
  bad((f) => { f.hosted.level = '026'; f.hosted.recorded = upTo('026'); f.hosted.pushed = upTo('026').map((m) => m.version) }, /hosted is at migration 026/)
  bad((f) => { f.hosted.recorded = [...upTo('027'), { version: '099', file: '099_x.sql', checksum: 'x' }] }, /unexpected versions/)
  bad((f) => { f.hosted.recorded = f.hosted.recorded.map((r) => (r.version === '020' ? { ...r, checksum: 'e'.repeat(64) } : r)) }, /hosted records a different 020_/)
  bad((f) => { f.hosted.pushed = f.hosted.pushed.slice(1) }, /Supabase migration history has unexpected versions/)
  bad((f) => { f.hosted.pushed = [...f.hosted.pushed, '028'] }, /Supabase migration history has unexpected versions/)
  // 5. the dry run
  bad((f) => { f.dryRun = [gate.migration_file, '029_value_view_scale.sql', '030_transaction_public_read_model.sql'] }, /not exactly/)
  bad((f) => { f.dryRun = [] }, /not exactly/)
  bad((f) => { f.dryRun = ['029_value_view_scale.sql'] }, /not exactly/)
  bad((f) => { f.dryRun = null }, /not exactly/)
  // a tampered gate file is refused whole
  for (const t of [(g) => { g.migrations_hash = '0'.repeat(64) }, (g) => { delete g.checksums['010'] }, (g) => { g.commit = 'xyz' }, (g) => { g.project_ref = 'short' }, (g) => { g.migration_file = '029_value_view_scale.sql' }]) {
    const g = structuredClone(gate); t(g); assert.ok(evaluateGate(g, goodFacts()).every((x) => x.startsWith('gate file: ')), JSON.stringify(evaluateGate(g, goodFacts())))
  }
})

test('the dry-run output of the Supabase CLI is read strictly', () => {
  const ok = 'DRY RUN: migrations will *not* be pushed to the database.\nConnecting to remote database...\nWould push these migrations:\n • 028_transaction_forensics_foundation.sql\n{"upToDate":false,"dryRun":true,"migrations":["028_transaction_forensics_foundation.sql"],"seeds":[],"roles":[],"message":"Finished supabase db push."}\n'
  assert.deepEqual(parseDryRun(ok), ['028_transaction_forensics_foundation.sql'])
  assert.deepEqual(parseDryRun('{"upToDate":true,"dryRun":true,"migrations":[]}'), [])
  assert.equal(parseDryRun('{"upToDate":false,"dryRun":false,"migrations":["028_x.sql"]}'), null, 'a real push is not a dry run')
  assert.equal(parseDryRun('Would push these migrations:\n • 028_x.sql'), null); assert.equal(parseDryRun(''), null); assert.equal(parseDryRun('{"migrations": nope}'), null)
})

// ---- integration: a real git repository, a real working directory, a fake supabase binary
let tmp, repo, work, db
const run = (cwd, script, args, env = {}) => spawnSync(process.execPath, [path.join(cwd, script), ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), ...env } })
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const marker = () => (fs.existsSync(path.join(tmp, 'cli-calls.log')) ? fs.readFileSync(path.join(tmp, 'cli-calls.log'), 'utf8').trim().split('\n') : [])
let gateFile, commit

before(async () => {
  await h.startServer()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-gate-'))
  repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
  for (const d of ['scripts/db', 'database/migrations']) fs.cpSync(path.join(root, d), path.join(repo, d), { recursive: true, filter: (s) => !s.includes('/bench') })
  for (const f of ['prod-ca-2021.crt', '.gitignore']) fs.cpSync(path.join(root, 'supabase', f), path.join(repo, 'supabase', f))
  for (const f of ['package.json', '.gitignore']) fs.copyFileSync(path.join(root, f), path.join(repo, f))
  // node_modules: only `pg` (a symlink to the real package) and a FAKE supabase binary that records its arguments and answers a dry run with the three pending files
  fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true }); fs.symlinkSync(path.join(root, 'node_modules/pg'), path.join(repo, 'node_modules/pg'))
  fs.writeFileSync(path.join(repo, 'node_modules/.bin/supabase'), `#!/usr/bin/env bash\necho "$*" >> "${path.join(tmp, 'cli-calls.log')}"\nif [[ "$*" == *"--dry-run"* ]]; then echo '{"upToDate":false,"dryRun":true,"migrations":'"$FAKE_DRY_RUN"',"seeds":[],"roles":[]}'; fi\n`, { mode: 0o755 })
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 't')
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'all migrations'); commit = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'update-ref', 'refs/remotes/origin/main', commit)
  gateFile = path.join(tmp, 'g1.gate.json')
  db = await h.freshDatabase({ migrate: false })
  await applyMigrations(db, { through: '027' })
  await db.query('create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text)')
  for (const m of listMigrations().filter((x) => x.version <= '027')) await db.query('insert into supabase_migrations.schema_migrations values ($1, $2, $3)', [m.version, [m.sql], m.file.slice(4, -4)])
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('create: only a reviewed (origin/main) commit can be a gate, and the gate file is not overwritten', () => {
  const unreviewed = spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/main'], { cwd: repo }); assert.equal(unreviewed.status, 0)
  let r = run(repo, 'scripts/db/gate.mjs', ['create', '--gate', 'G1', '--commit', commit, '--through', '028', '--project-ref', REF, '--out', gateFile])
  assert.notEqual(r.status, 0); assert.match(r.stderr, /not an ancestor of origin\/main/)
  git(repo, 'update-ref', 'refs/remotes/origin/main', commit)
  r = run(repo, 'scripts/db/gate.mjs', ['create', '--gate', 'G1', '--commit', commit, '--through', '028', '--project-ref', REF, '--out', gateFile])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /028_transaction_forensics_foundation\.sql/); assert.match(r.stdout, /gate file SHA-256 [0-9a-f]{64}/)
  assert.deepEqual(JSON.parse(fs.readFileSync(gateFile, 'utf8')).checksums['028'], gate.checksums['028'], 'checksums come from the committed files')
  assert.notEqual(run(repo, 'scripts/db/gate.mjs', ['create', '--gate', 'G1', '--commit', commit, '--through', '028', '--project-ref', REF, '--out', gateFile]).status, 0)
})

test('workdir + offline check: the restricted checkout has migrations 001–028 only and passes; the full repository and every tampering fails', () => {
  work = path.join(tmp, 'work')
  const w = run(repo, 'scripts/db/gate.mjs', ['workdir', '--gate', gateFile, '--dir', work]); assert.equal(w.status, 0, w.stderr)
  assert.deepEqual(fs.readdirSync(path.join(work, 'database/migrations')).filter((f) => /^\d/.test(f)).slice(-2), ['027_wikidata_attribution.sql', '028_transaction_forensics_foundation.sql'])
  fs.mkdirSync(path.join(work, 'supabase/.temp'), { recursive: true }); fs.writeFileSync(path.join(work, 'supabase/.temp/project-ref'), REF)
  const env = { BAI_SUPABASE_PROJECT_REF: REF }
  const check = (cwd = work, e = env, extra = []) => run(cwd, 'scripts/db/gate.mjs', ['check', '--gate', gateFile, '--offline', ...extra], e)
  let c = check(); assert.equal(c.status, 0, c.stdout + c.stderr); assert.match(c.stdout, /GATE CHECK OK/)
  // the full repository is not a valid place to run a gate: 029 and 030 are visible there
  fs.mkdirSync(path.join(repo, 'supabase/.temp'), { recursive: true }); fs.writeFileSync(path.join(repo, 'supabase/.temp/project-ref'), REF)
  c = check(repo); assert.equal(c.status, 1); assert.match(c.stdout, /later than 028 are present: 029, 030/)
  // tampering inside the working directory
  const mig = path.join(work, 'database/migrations/028_transaction_forensics_foundation.sql')
  const orig = fs.readFileSync(mig, 'utf8')
  fs.writeFileSync(mig, orig + '\n-- sneaked in\n'); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /differs from the gate's checksum/); assert.match(c.stdout, /unexpected change .*028/); fs.writeFileSync(mig, orig)
  fs.copyFileSync(path.join(repo, 'database/migrations/029_value_view_scale.sql'), path.join(work, 'database/migrations/029_value_view_scale.sql')); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /later than 028 are present: 029/); fs.rmSync(path.join(work, 'database/migrations/029_value_view_scale.sql'))
  fs.writeFileSync(path.join(work, 'database/migrations/031_extra.sql'), 'select 1;'); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /031/); fs.rmSync(path.join(work, 'database/migrations/031_extra.sql'))
  fs.writeFileSync(path.join(work, 'scripts/db/migrate.mjs'), '// changed\n'); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /unexpected change .*migrate\.mjs/); git(work, 'checkout', '--', 'scripts/db/migrate.mjs')
  // the project
  c = check(work, { BAI_SUPABASE_PROJECT_REF: 'a'.repeat(20) }); assert.equal(c.status, 1); assert.match(c.stdout, /not the gate's project/)
  fs.writeFileSync(path.join(work, 'supabase/.temp/project-ref'), 'a'.repeat(20)); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /supabase\/\.temp\/project-ref is aaaa/); fs.writeFileSync(path.join(work, 'supabase/.temp/project-ref'), REF)
  // a different commit
  fs.writeFileSync(path.join(work, 'note.txt'), 'x'); git(work, 'add', 'note.txt'); git(work, 'commit', '-q', '-m', 'drift'); c = check(); assert.equal(c.status, 1); assert.match(c.stdout, /HEAD is /); git(work, 'reset', '-q', '--mixed', commit); fs.rmSync(path.join(work, 'note.txt'))   // the working tree (with 029 and 030 removed) is left as it was
  c = check(); assert.equal(c.status, 0, c.stdout)
})

test('online check against a stand-in for hosted (a local database at 027): passes when the history is right, refuses each unexpected change, and demands a dry run of exactly 028', () => {
  const { port, database } = db.connectionParameters
  const env = (extra = {}) => ({ BAI_SUPABASE_PROJECT_REF: REF, BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`, BAI_SUPABASE_DB_PASSWORD: 'x', FAKE_DRY_RUN: '["028_transaction_forensics_foundation.sql"]', ...extra })
  const check = (e) => run(work, 'scripts/db/gate.mjs', ['check', '--gate', gateFile, '--dry-run'], e)
  let c = check(env()); assert.equal(c.status, 0, c.stdout + c.stderr); assert.match(c.stdout, /hosted migration history \(read-only\); dry run lists exactly the gate migration/); assert.match(c.stdout, /GATE CHECK OK/)
  c = check(env({ FAKE_DRY_RUN: '["028_transaction_forensics_foundation.sql","029_value_view_scale.sql","030_transaction_public_read_model.sql"]' })); assert.equal(c.status, 1); assert.match(c.stdout, /dry run lists/)
  c = check(env({ FAKE_DRY_RUN: '[]' })); assert.equal(c.status, 1)
})

test('db push is refused without a passing gate and never reaches the CLI; with one it runs exactly `db push --linked`', async () => {
  const { port, database } = db.connectionParameters
  const base = { BAI_SUPABASE_PROJECT_REF: REF, BAI_SUPABASE_DB_PASSWORD: 'x', BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`, FAKE_DRY_RUN: '["028_transaction_forensics_foundation.sql"]' }
  const push = (cwd, args, e) => run(cwd, 'scripts/db/supabase-hosted.mjs', args, e)
  fs.rmSync(path.join(tmp, 'cli-calls.log'), { force: true })
  // no gate file
  let r = push(work, ['db', 'push'], base); assert.equal(r.status, 1); assert.match(r.stderr, /needs BAI_GATE_FILE/)
  // widening flags
  for (const flag of ['--include-all', '--include-roles', '--include-seed', '--db-url']) { r = push(work, ['db', 'push', flag], { ...base, BAI_GATE_FILE: gateFile }); assert.equal(r.status, 1, flag); assert.match(r.stderr, /no extra flags|credentials through/) }
  // the full repository (029, 030 visible): the gate check fails, so the push is refused
  r = push(repo, ['db', 'push'], { ...base, BAI_GATE_FILE: gateFile }); assert.equal(r.status, 1); assert.match(r.stderr + r.stdout, /gate check failed|GATE CHECK FAILED/)
  // a dry run that would push three files
  r = push(work, ['db', 'push'], { ...base, BAI_GATE_FILE: gateFile, FAKE_DRY_RUN: '["028_transaction_forensics_foundation.sql","029_value_view_scale.sql"]' }); assert.equal(r.status, 1)
  // a hosted history that is not what the gate expects (028 already applied)
  await db.query("insert into supabase_migrations.schema_migrations values ('028', '{}', 'transaction_forensics_foundation')")
  r = push(work, ['db', 'push'], { ...base, BAI_GATE_FILE: gateFile }); assert.equal(r.status, 1); assert.match(r.stdout, /Supabase migration history has unexpected versions/)
  await db.query("delete from supabase_migrations.schema_migrations where version = '028'")
  assert.deepEqual(marker().filter((l) => /push(?!.*--dry-run)/.test(l)), [], 'the CLI was never asked to push in any refused case')
  // the authorized case: the gate passes (its own dry run is the only CLI call before the push)
  r = push(work, ['db', 'push'], { ...base, BAI_GATE_FILE: gateFile }); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /GATE CHECK OK/)
  const calls = marker(); assert.deepEqual(calls.filter((l) => !/--dry-run/.test(l)), ['db push --linked'], 'exactly one real push, with no widening flag')
})
