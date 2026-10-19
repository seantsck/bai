// Disposable PostgreSQL 17 per test file (embedded binaries, random port, temp data dir). Each call to freshDatabase()
// creates a new database and replays every migration from 001, so every test file proves a clean replay.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations, loadFixtures } from '../../scripts/db/lib/migrations.mjs'

let server, port, dataDir
let dbCounter = 0
const clients = []

export async function startServer () {
  port = 20000 + Math.floor(Math.random() * 30000)
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-pg-'))
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
  await server.initialise()
  await server.start()
}

export async function stopServer () {
  for (const c of clients) await c.end().catch(() => {})
  await server?.stop()
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
}

export async function connect (database) {
  const c = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password: 'postgres', database })
  await c.connect()
  clients.push(c)
  return c
}

/** Fresh database with all migrations applied (and optionally the foundation fixtures). */
export async function freshDatabase ({ fixtures = false, migrate = true } = {}) {
  const name = `bai_test_${process.pid}_${++dbCounter}`
  const admin = await connect('postgres')
  await admin.query(`create database ${name}`)
  const db = await connect(name)
  if (migrate) await applyMigrations(db)
  if (fixtures) await loadFixtures(db)
  return db
}

export const rows = async (db, sql, params) => (await db.query(sql, params)).rows
export const one = async (db, sql, params) => (await db.query(sql, params)).rows[0]

/** Runs fn inside a transaction as the given role, then rolls back. */
export async function asRole (db, role, fn) {
  await db.query('begin')
  try {
    await db.query(`set local role ${role}`)
    return await fn()
  } finally {
    await db.query('rollback')
  }
}

/** Expects the statement to fail with a message matching re; uses a savepoint-free transaction and rolls back. */
export async function rejects (db, sql, params, re) {
  await db.query('begin')
  let error
  try { await db.query(sql, params); await db.query('commit') } catch (err) { error = err; await db.query('rollback') }
  if (!error) throw new Error(`expected failure for: ${sql}`)
  if (re && !re.test(error.message)) throw new Error(`unexpected error "${error.message}" for: ${sql}`)
  return error
}

export const id = async (db, sql, params) => Number((await one(db, sql, params)).id)
