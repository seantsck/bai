// Migration runner shared by scripts and tests. Applies database/migrations/NNN_*.sql in order, one transaction per file,
// and records each file's checksum in bai_meta.schema_migrations. An applied migration is frozen: a changed checksum aborts.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
export const migrationsDir = path.join(repoRoot, 'database/migrations')
export const fixturesDir = path.join(repoRoot, 'database/fixtures')

const normalize = (sql) => sql.replace(/\r\n/g, '\n')
export const checksum = (sql) => crypto.createHash('sha256').update(normalize(sql)).digest('hex')

export function listMigrations () {
  return fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{3}[a-z]?_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
      return { version: file.slice(0, file.indexOf('_')), file, sql, checksum: checksum(sql) }
    })
}

/** @param {import('pg').ClientBase} client */
export async function applyMigrations (client, { log = () => {} } = {}) {
  await client.query(`create schema if not exists bai_meta;
    revoke all on schema bai_meta from public;
    create table if not exists bai_meta.schema_migrations (
      version text primary key, file text not null, checksum text not null, applied_at timestamptz not null default now())`)
  const applied = new Map((await client.query('select version, file, checksum from bai_meta.schema_migrations')).rows.map((r) => [r.version, r]))
  const ran = []
  for (const m of listMigrations()) {
    const prior = applied.get(m.version)
    if (prior) {
      if (prior.checksum !== m.checksum || prior.file !== m.file) throw new Error(`applied migration ${m.file} has changed (frozen); add a new migration instead`)
      continue
    }
    await client.query('begin')
    try {
      await client.query(m.sql)
      await client.query('insert into bai_meta.schema_migrations (version, file, checksum) values ($1, $2, $3)', [m.version, m.file, m.checksum])
      await client.query('commit')
    } catch (err) {
      await client.query('rollback')
      throw new Error(`migration ${m.file} failed: ${err.message}`)
    }
    log(`applied ${m.file}`)
    ran.push(m.file)
  }
  return ran
}

/** @param {import('pg').ClientBase} client */
export async function loadFixtures (client, name = 'foundation') {
  const sql = fs.readFileSync(path.join(fixturesDir, `${name}.sql`), 'utf8')
  await client.query('begin')
  try { await client.query(sql); await client.query('commit') } catch (err) { await client.query('rollback'); throw err }
}
