// The backup snapshot (scripts/db/lib/snapshot.mjs): one REPEATABLE READ, READ ONLY transaction, so the migration metadata and every table belong to the same
// database snapshot even when another session commits while it is being taken; verification of the archive; compatibility with earlier snapshots; restore.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { takeSnapshot, verifySnapshot } from '../../scripts/db/lib/snapshot.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
let db, writer, admin
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-snap-'))
let n = 0
const next = (label) => path.join(tmp, `${label}-${++n}`)
before(async () => {
  await h.startServer(); db = await h.freshDatabase(); writer = await h.connect(db.database); admin = await h.connect('postgres')
  await db.query("insert into players (slug, full_name, display_name) values ('snap-1', 'Snapshot One', 'Snapshot One'), ('snap-2', 'Snapshot Two', 'Snapshot Two')")
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })
const rowsOf = (dir, table) => fs.readFileSync(path.join(dir, `${table}.ndjson`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const playerCount = async () => Number((await h.one(db, 'select count(*) n from players')).n)

test('a snapshot is one REPEATABLE READ, READ ONLY transaction, verifies, and refuses to overwrite', async () => {
  const dir = next('plain')
  let insideWriteRefused = false
  const m = await takeSnapshot(db, dir, { hooks: { afterTable: async () => {
    if (insideWriteRefused) return
    await db.query('savepoint probe')
    await assert.rejects(db.query("insert into players (slug, full_name, display_name) values ('nope', 'Nope', 'Nope')"), /read-only transaction/)
    await db.query('rollback to savepoint probe')
    insideWriteRefused = true
  } } })
  assert.ok(insideWriteRefused, 'the server refused a write inside the snapshot transaction')
  assert.deepEqual([m.snapshot.isolation, m.snapshot.read_only], ['repeatable read', true])
  assert.ok(m.snapshot.pg_snapshot && m.snapshot.server_version)
  assert.deepEqual(verifySnapshot(dir), [])
  assert.equal(m.migrations.n, (await h.one(db, 'select count(*)::int n from bai_meta.schema_migrations')).n)
  assert.equal(rowsOf(dir, 'public.players').length, await playerCount())
  assert.ok(m.columns['public.players'].includes('slug'))
  await assert.rejects(takeSnapshot(db, dir), /not empty/, 'an existing snapshot is never overwritten')
  assert.ok(m.total_rows > 100, `${m.total_rows} rows`)
})

test('a write committed by another session while the snapshot is taken appears in no part of it (and READ COMMITTED would show it)', async () => {
  const before = await playerCount()
  const beforeMax = (await h.one(db, 'select max(version) v from bai_meta.schema_migrations')).v
  const concurrently = async (done) => {
    // fires once, after the first table has been read: a new player, a new migration record, and a changed existing row, all COMMITTED
    if (done.fired) return
    done.fired = true
    await writer.query("insert into players (slug, full_name, display_name) values ('snap-late', 'Late Arrival', 'Late Arrival')")
    await writer.query("insert into bai_meta.schema_migrations (version, file, checksum) values ('999', '999_late.sql', 'late')")
    await writer.query("update players set display_name = 'Changed Late' where slug = 'snap-1'")
  }
  const dir = next('repeatable')
  const m = await takeSnapshot(db, dir, { hooks: { afterTable: concurrently.bind(null, {}) } })
  assert.equal(await playerCount(), before + 1, 'the concurrent write really committed')
  assert.equal(rowsOf(dir, 'public.players').length, before, 'the new player is not in the snapshot')
  assert.equal(rowsOf(dir, 'public.players').find((p) => p.slug === 'snap-1').display_name, 'Snapshot One', 'the changed row is as of the snapshot')
  assert.equal(m.migrations.v, beforeMax, 'the migration level is as of the snapshot, not 999')
  assert.deepEqual(verifySnapshot(dir), [])

  // control: with READ COMMITTED the same interleaving gives data newer than the metadata, which is exactly what REPEATABLE READ prevents
  await db.query("delete from players where slug = 'snap-late'"); await db.query("delete from bai_meta.schema_migrations where version = '999'"); await db.query("update players set display_name = 'Snapshot One' where slug = 'snap-1'")
  const dir2 = next('read-committed')
  const m2 = await takeSnapshot(db, dir2, { isolation: 'read committed', hooks: { afterTable: concurrently.bind(null, {}) } })
  assert.ok(rowsOf(dir2, 'public.players').some((p) => p.slug === 'snap-late'), 'READ COMMITTED sees the late player')
  assert.equal(m2.migrations.v, beforeMax, 'while its migration metadata predates it: the inconsistency the guarantee removes')
  await db.query("delete from players where slug = 'snap-late'"); await db.query("delete from bai_meta.schema_migrations where version = '999'"); await db.query("update players set display_name = 'Snapshot One' where slug = 'snap-1'")
})

test('verification catches a changed byte, a missing file, an unlisted file, a wrong count, and a manifest that does not match', async () => {
  const good = next('good'); await takeSnapshot(db, good)
  const copy = (label) => { const d = next(label); fs.cpSync(good, d, { recursive: true }); return d }
  let d = copy('byte'); fs.appendFileSync(path.join(d, 'public.players.ndjson'), ' '); assert.ok(verifySnapshot(d).some((p) => /public\.players: SHA-256 differs/.test(p)))
  d = copy('missing'); fs.rmSync(path.join(d, 'public.organizations.ndjson')); assert.ok(verifySnapshot(d).some((p) => /organizations: file missing/.test(p)))
  d = copy('extra'); fs.writeFileSync(path.join(d, 'stray.ndjson'), ''); assert.ok(verifySnapshot(d).some((p) => /stray\.ndjson is not listed/.test(p)))
  d = copy('count'); const mf = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')); mf.tables['public.players'].rows += 1; fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(mf)); assert.ok(verifySnapshot(d).some((p) => /rows, manifest says/.test(p)) && verifySnapshot(d).some((p) => /manifest_sha256/.test(p)))
  d = copy('cols'); const rows = fs.readFileSync(path.join(d, 'public.players.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); delete rows[0].slug
  fs.writeFileSync(path.join(d, 'public.players.ndjson'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n'); const pr = verifySnapshot(d); assert.ok(pr.some((p) => /players: row 1 does not have the manifest's columns|SHA-256/.test(p)))
})

test('an earlier snapshot (no columns or snapshot keys) still verifies and restores; the restored database equals the snapshot in every table, column and row', async () => {
  const dir = next('old'); await takeSnapshot(db, dir)
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); delete mf.columns; delete mf.snapshot
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 1) + '\n')
  assert.deepEqual(verifySnapshot(dir), [], 'the earlier format is accepted')
  const name = `bai_restore_${process.pid}`
  await admin.query(`create database ${name}`)
  const { port } = db.connectionParameters
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/${name}`
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: url }
  const restore = spawnSync(process.execPath, ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', dir, '--database-url', url], { cwd: root, encoding: 'utf8', env })
  assert.equal(restore.status, 0, restore.stderr || restore.stdout); assert.match(restore.stdout, /restored \d+ tables, \d+ rows/)
  const pre = spawnSync(process.execPath, ['scripts/db/hosted-preflight.mjs', '--snapshot-dir', dir, '--expect-level', mf.migrations.v], { cwd: root, encoding: 'utf8', env })
  assert.equal(pre.status, 0, pre.stdout); assert.match(pre.stdout, /every table is byte-identical to the snapshot/)
  // a restore never targets hosted and never overwrites a database that already holds BAI objects
  const hosted = spawnSync(process.execPath, ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', dir, '--database-url', 'postgresql://postgres:x@db.dbnmktidheefoxaztivm.supabase.co:5432/postgres'], { cwd: root, encoding: 'utf8', env }) // credential-scan:allow (a deliberately fake password: the restore must refuse a non-local target)
  assert.equal(hosted.status, 2); assert.match(hosted.stderr, /local-only/)
  const again = spawnSync(process.execPath, ['scripts/db/restore-snapshot.mjs', '--snapshot-dir', dir, '--database-url', url], { cwd: root, encoding: 'utf8', env })
  assert.notEqual(again.status, 0); assert.match(again.stderr, /already holds BAI schemas/)
  // tamper with one restored row: the comparison notices
  await (await h.connect(name)).query("update public.players set full_name = 'Tampered' where slug = 'snap-2'")
  const bad = spawnSync(process.execPath, ['scripts/db/hosted-preflight.mjs', '--snapshot-dir', dir, '--expect-level', mf.migrations.v], { cwd: root, encoding: 'utf8', env })
  assert.equal(bad.status, 1); assert.match(bad.stdout, /public\.players: content differs/)
})
