// G1 release protocol v2: the final read-only parity check (scripts/db/final-parity.mjs, lib/final-parity.mjs) against a DISPOSABLE local database. A stand-in
// exporter (fixtures/local-export.sh) replaces logical-export.sh, which would reach hosted. Every mismatch must fail closed: exit 1, no record written.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { buildGate } from '../../scripts/db/lib/gate.mjs'
import { listMigrations, applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { takeSnapshot } from '../../scripts/db/lib/snapshot.mjs'
import * as fp from '../../scripts/db/lib/final-parity.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const exporter = path.join(root, 'tests/db/fixtures/local-export.sh')
const gate = buildGate({ gate: 'G1', commit: 'a'.repeat(40), through: '028', projectRef: 'dbnmktidheefoxaztivm', migrations: listMigrations().map((m) => ({ version: m.version, file: m.file, checksum: m.checksum })) })
const hex = (c) => c.repeat(64)
let db, tmp, gateFile, env, n = 0

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const exportTo = (dir) => { const r = spawnSync('bash', [exporter, dir], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); }
/** A complete backup directory of the CURRENT database state: <dir>/snapshot and <dir>/export. ageMs makes the directory NAME (and so the start time) older. */
async function backup (ageMs = 0) {
  const named = path.join(tmp, `b${n}`, `g1-${stamp(Date.now() - ageMs)}`)
  fs.mkdirSync(path.dirname(named), { recursive: true })
  await takeSnapshot(db, path.join(named, 'snapshot')); exportTo(path.join(named, 'export'))
  return named
}
const treeOf = (dir) => fp.contentTreeHash(dir)
const run = (b, extra = [], over = {}) => {
  const rec = path.join(tmp, `rec-${++n}.json`)
  const args = ['scripts/db/final-parity.mjs', '--backup-dir', b, '--gate', gateFile, '--record', rec, '--offsite-sha256', hex('a'), '--offsite-tree', treeOf(b), '--authorization-ref', 'owner message test', '--export-script', exporter, ...extra]
  for (let i = 0; i < extra.length; i += 2) { const j = args.indexOf(extra[i]); if (j >= 0 && j < args.length - extra.length) args.splice(j, 2) }   // an extra flag replaces the default one
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...env, ...over } })
  return { ...r, rec, out: r.stdout + r.stderr }
}
const undo = []

before(async () => {
  await h.startServer()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-fp-'))
  db = await h.freshDatabase({ migrate: false }); await applyMigrations(db, { through: '027' })
  const { port, database } = db.connectionParameters
  env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}` }
  gateFile = path.join(tmp, 'g1.gate.json'); fs.writeFileSync(gateFile, JSON.stringify(gate))
  await db.query("insert into players (slug, full_name, display_name) values ('fp-1', 'Parity One', 'Parity One')")
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('the normalization ignores only pg_dump\'s random \\restrict lines; the tree hash equals backup-pack.sh\'s', () => {
  assert.equal(fp.normalizeExport('a\n\\restrict ABC\nb\n-- \\restrict XYZ\n-- \\unrestrict XYZ\n\\unrestrict ABC\nON DELETE RESTRICT\nc'), 'a\nb\nON DELETE RESTRICT\nc')
  assert.notEqual(fp.normalizeExport('x\nrestrict policy'), fp.normalizeExport('x'), 'a line merely containing the word is data, not noise')
  const d = path.join(tmp, 'tree'); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); fs.writeFileSync(path.join(d, 'b.txt'), 'two'); fs.writeFileSync(path.join(d, 'a.txt'), 'one'); fs.writeFileSync(path.join(d, 'sub/c.txt'), 'three')
  const sh = spawnSync('bash', ['-c', `cd ${d} && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1`], { encoding: 'utf8' })
  assert.equal(fp.contentTreeHash(d), sh.stdout.trim())
})

test('control: an unchanged database passes, the record is hashed, short-lived and verifies; the fresh export differed only by the random lines', async () => {
  const b = await backup()
  const r = run(b); assert.equal(r.status, 0, r.out); assert.match(r.out, /FINAL PARITY OK/)
  assert.match(fs.readFileSync(path.join(b, 'export/schema.sql'), 'utf8'), /^\\restrict /m, 'the stand-in writes raw restrict lines like pg_dump')
  const rec = JSON.parse(fs.readFileSync(r.rec, 'utf8'))
  assert.equal(rec.result, 'PASS'); assert.equal(rec.record_sha256, fp.recordHash(rec)); assert.ok(Date.parse(rec.expires_at) - Date.parse(rec.checked_at) <= 10 * 60 * 1000)
  assert.deepEqual(fp.verifyRecordFile(r.rec, { gate }), [])
  assert.equal(fs.statSync(r.rec).mode & 0o777, 0o600)
  assert.deepEqual(fs.readdirSync(b).sort(), ['export', 'snapshot'], 'nothing was written into the backup directory')
  assert.equal(run(b, [], {}).out.includes('exists'), false)
})

// each mutation changes ONE recoverable thing; table-byte parity alone cannot see most of them, the export comparison must
const mutations = [
  ['a table row (the strict preflight)', "update players set display_name = 'Changed' where slug = 'fp-1'", "update players set display_name = 'Parity One' where slug = 'fp-1'", /preflight did not pass/],
  ['a new table row', "insert into players (slug, full_name, display_name) values ('fp-2', 'Two', 'Two')", "delete from players where slug = 'fp-2'", /preflight did not pass/],
  ['a recorded migration', "insert into bai_meta.schema_migrations (version, file, checksum) values ('099', '099_x.sql', 'x')", "delete from bai_meta.schema_migrations where version = '099'", /preflight did not pass/],
  ['a privilege grant', 'grant insert on public.sources to bai_web', 'revoke insert on public.sources from bai_web', /schema\.sql: DIFFERS/],
  ['an RLS policy', 'create policy fp_probe on public.sources for select using (true)', 'drop policy fp_probe on public.sources', /schema\.sql: DIFFERS/],
  ['a function', 'create function public.fp_probe() returns int language sql as $$select 1$$', 'drop function public.fp_probe()', /schema\.sql: DIFFERS/],
  ['an RLS flag', 'alter table public.sources disable row level security', 'alter table public.sources enable row level security', /schema\.sql: DIFFERS/],
  ['a sequence position (no row changes)', "select nextval(pg_get_serial_sequence('public.players', 'id'))", null, /data\.sql: DIFFERS/],
  ['a role attribute', 'alter role bai_web createdb', 'alter role bai_web nocreatedb', /roles\.sql: DIFFERS/]
]
for (const [what, apply, revert, re] of mutations) {
  test(`fails closed when ${what} changed after the backup`, async () => {
    const b = await backup()
    await db.query(apply)
    try {
      const r = run(b); assert.equal(r.status, 1, r.out); assert.match(r.out, /FINAL PARITY FAILED/); assert.match(r.out, re); assert.ok(!fs.existsSync(r.rec), 'no record is written')
      if (re.source !== 'preflight did not pass') assert.match(r.out, /preflight ok/, 'the strict preflight alone passed: this is a gap the export comparison closes')
    } finally { if (revert) await db.query(revert); else undo.push(what) }
  })
}

test('fails closed on a damaged or inconsistent backup, an old backup, a wrong off-site hash and unsafe paths', async () => {
  const b = await backup()
  // a tampered export file
  const schema = path.join(b, 'export/schema.sql'); const orig = fs.readFileSync(schema)
  fs.appendFileSync(schema, '-- tampered\n'); let r = run(b); assert.equal(r.status, 1, r.out); assert.match(r.out, /does not match SHA256SUMS/); fs.writeFileSync(schema, orig)
  // a tampered snapshot table file
  const snap = path.join(b, 'snapshot/public.players.ndjson'); const so = fs.readFileSync(snap)
  fs.appendFileSync(snap, '{"x":1}\n'); r = run(b); assert.equal(r.status, 1, r.out); assert.match(r.out, /backup directory: .*snapshot/); fs.writeFileSync(snap, so)
  // a missing export file
  const hist = path.join(b, 'export/supabase_migrations_history.json'); const ho = fs.readFileSync(hist); fs.rmSync(hist)
  r = run(b); assert.equal(r.status, 1, r.out); assert.match(r.out, /supabase_migrations_history\.json/); fs.writeFileSync(hist, ho)
  // the off-site verified content hash is not this backup's
  r = run(b, ['--offsite-tree', hex('b')]); assert.equal(r.status, 1, r.out); assert.match(r.out, /not the content hash of this backup/)
  r = run(b, ['--offsite-sha256', 'zz']); assert.equal(r.status, 1)
  // a record is never overwritten; a record or the fresh export inside the backup directory is refused
  const rec = path.join(tmp, 'exists.json'); fs.writeFileSync(rec, '{}')
  r = spawnSync(process.execPath, ['scripts/db/final-parity.mjs', '--backup-dir', b, '--gate', gateFile, '--record', rec, '--offsite-sha256', hex('a'), '--offsite-tree', treeOf(b), '--authorization-ref', 'x', '--export-script', exporter], { cwd: root, encoding: 'utf8', env }); assert.equal(r.status, 1, r.out); assert.match(r.stderr, /never overwritten/)
  r = run(b, ['--export-dir', path.join(b, 'inner')]); assert.equal(r.status, 1, r.out); assert.match(r.out, /OUTSIDE the backup directory/)
  r = spawnSync(process.execPath, ['scripts/db/final-parity.mjs', '--backup-dir', b, '--gate', gateFile, '--record', path.join(b, 'rec.json'), '--offsite-sha256', hex('a'), '--offsite-tree', treeOf(b), '--authorization-ref', 'x', '--export-script', exporter], { cwd: root, encoding: 'utf8', env }); assert.equal(r.status, 1, r.out); assert.match(r.stderr, /outside the backup directory/)
  // a backup older than six hours (by its own name) is refused even though everything else is identical
  const old = await backup(6.5 * 3600 * 1000); r = run(old); assert.equal(r.status, 1, r.out); assert.match(r.out, /hours old; the maximum is 6/)
  const ok = await backup(5 * 3600 * 1000); r = run(ok); assert.equal(r.status, 0, r.out)
  // a backup at the wrong migration level for the gate
  await db.query("insert into bai_meta.schema_migrations (version, file, checksum) values ('028', '028_x.sql', 'x')")
  try { const wrong = await backup(); r = run(wrong); assert.equal(r.status, 1, r.out); assert.match(r.out, /backup is at migration 028; the gate starts from 027/) } finally { await db.query("delete from bai_meta.schema_migrations where version = '028'") }
})

test('a different export script is refused against any non-local database, before any connection is made', () => {
  const b = path.join(tmp, 'never-touched')
  const r = spawnSync(process.execPath, ['scripts/db/final-parity.mjs', '--backup-dir', b, '--gate', gateFile, '--record', path.join(tmp, 'r-nonlocal.json'), '--offsite-sha256', hex('a'), '--offsite-tree', hex('a'), '--authorization-ref', 'x', '--export-script', exporter],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, BAI_DATABASE_URL: 'postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres', BAI_ALLOW_REMOTE_DB: '1', BAI_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' } }) // credential-scan:allow (placeholder; never connected)
  assert.equal(r.status, 1, r.out); assert.match(r.stderr, /only allowed against a local database/)
  const r2 = spawnSync(process.execPath, ['scripts/db/final-parity.mjs', '--backup-dir', path.join(tmp, 'never-touched-2'), '--gate', gateFile, '--record', path.join(tmp, 'r-nonlocal2.json'), '--offsite-sha256', hex('a'), '--offsite-tree', hex('a'), '--authorization-ref', 'x', '--export-script', exporter],
    { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, BAI_DATABASE_URL: 'postgresql://postgres:x@db.abcdefghijklmnopqrst.supabase.co:5432/postgres', BAI_ALLOW_REMOTE_DB: '1', BAI_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' } }) // credential-scan:allow (placeholder; never connected)
  assert.equal(r2.status, 1, r2.stderr); assert.match(r2.stderr, /only allowed against a local database/)
})

test('the record is re-verified from the files: altered, expired, for another gate, a changed backup, too old at push time, or for other off-site evidence are all refused', async () => {
  const b = await backup(); const r = run(b); assert.equal(r.status, 0, r.out)
  const good = JSON.parse(fs.readFileSync(r.rec, 'utf8')); const t = Date.parse(good.checked_at)
  const write = (mut, reseal = true) => { const x = structuredClone(good); mut(x); if (reseal) x.record_sha256 = fp.recordHash(x); const f = path.join(tmp, `v-${++n}.json`); fs.writeFileSync(f, JSON.stringify(x)); return f }
  const probs = (f, now = t + 1000) => fp.verifyRecordFile(f, { gate, now })
  assert.deepEqual(probs(r.rec), [])
  assert.match(probs(write((x) => { x.result = 'PASS'; x.checked_at = new Date(t - 1).toISOString() }, false))[0], /altered/)
  assert.ok(probs(r.rec, t + 11 * 60 * 1000).some((p) => /expired/.test(p)))
  assert.ok(probs(r.rec, t - 60 * 1000).some((p) => /future/.test(p)))
  assert.ok(probs(write((x) => { x.result = 'FAIL' })).some((p) => /not a PASS/.test(p)))
  assert.ok(probs(write((x) => { x.expires_at = new Date(t + 3600e3).toISOString() })).some((p) => /time window/.test(p)))
  assert.ok(probs(write((x) => { x.max_age_ms = 24 * 3600e3 })).some((p) => /longer backup age/.test(p)))
  assert.ok(fp.verifyRecordFile(r.rec, { gate: { ...gate, migrations_hash: 'f'.repeat(64) }, now: t + 1000 }).some((p) => /another gate|gate file/.test(p)))
  assert.ok(fp.verifyRecordFile(r.rec, { gate: { ...gate, from_level: '026' }, now: t + 1000 }).length > 0)
  assert.ok(probs(write((x) => { x.offsite.tree_sha256 = hex('c') })).some((p) => /not this backup's content hash/.test(p)))
  assert.ok(probs(write((x) => { x.offsite.authorization_ref = ' ' })).some((p) => /authorization reference/.test(p)))
  assert.ok(probs(write((x) => { x.offsite.encrypted_sha256 = 'nothex' })).some((p) => /off-site verification hashes/.test(p)))
  assert.ok(probs(write((x) => { x.backup.dir = path.join(tmp, 'nowhere') })).some((p) => /not found/.test(p)))
  // too old AT PUSH TIME: a record made six hours and a second after the backup started
  const started = fp.backupStartedAt(b)
  const late = fp.buildRecord({ backupDir: b, gate, offsite: { encrypted: hex('a'), tree: treeOf(b), authorizationRef: 'x' }, preflight: true, exportHashes: {}, now: started + 6 * 3600e3 + 1000 })
  const lf = path.join(tmp, 'late.json'); fs.writeFileSync(lf, JSON.stringify(late))
  assert.ok(fp.verifyRecordFile(lf, { gate, now: started + 6 * 3600e3 + 2000 }).some((p) => /hours old; the maximum is 6/.test(p)))
  // the backup changed after the record was written
  fs.writeFileSync(path.join(b, 'export/extra.txt'), 'x'); assert.ok(probs(r.rec).some((p) => /content changed|SHA256SUMS/.test(p))); fs.rmSync(path.join(b, 'export/extra.txt'))
  const data = path.join(b, 'export/data.sql'); const od = fs.readFileSync(data); fs.appendFileSync(data, 'x'); assert.ok(probs(r.rec).some((p) => /backup: export\/data\.sql/.test(p))); fs.writeFileSync(data, od)
  assert.deepEqual(probs(r.rec), [])
  assert.ok(probs(path.join(tmp, 'missing.json')).some((p) => /unreadable/.test(p)))
  assert.equal(fp.PROTOCOL_V2_ENFORCED, false, 'protocol v2 is not active until the owner approves the reviewed switch')
})
