// Migration runner shared by scripts and tests. Applies database/migrations/NNN_*.sql in order, one transaction per file,
// and records each file's checksum in bai_meta.schema_migrations. An applied migration is frozen: a changed checksum aborts.
//
// Hosted (Supabase) databases are migrated by `supabase db push`, which reads the same files through the
// supabase/migrations symlink and records them in supabase_migrations.schema_migrations. On such a database this runner
// never applies SQL: it verifies each pushed migration statement-for-statement against the committed file and records
// the file's checksum in bai_meta, so both histories describe the same frozen files.
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

/** Returns the Supabase CLI migration history (version -> {name, statements}), or null when the database has none. */
export async function supabaseHistory (client) {
  const exists = (await client.query("select to_regclass('supabase_migrations.schema_migrations') is not null as e")).rows[0].e
  if (!exists) return null
  const rows = (await client.query('select version, name, statements from supabase_migrations.schema_migrations')).rows
  return new Map(rows.map((r) => [r.version, r]))
}

/**
 * True when the pushed statements are exactly the committed file: every statement appears verbatim and in order, and
 * what lies between them is only whitespace, semicolons and line comments.
 */
export function pushedMatchesFile (statements, sql) {
  let pos = 0
  let rest = ''
  for (const st of statements ?? []) {
    const i = sql.indexOf(st, pos)
    if (i < 0) return false
    rest += sql.slice(pos, i)
    pos = i + st.length
  }
  rest += sql.slice(pos)
  return rest.replace(/--[^\n]*/g, '').replace(/[\s;]/g, '') === ''
}

/** Verifies a Supabase-pushed database against the committed files and records their checksums in bai_meta. */
async function adoptSupabaseHistory (client, history, applied, log) {
  const files = listMigrations()
  const known = new Set(files.map((m) => m.version))
  const unknown = [...history.keys()].filter((v) => !known.has(v))
  if (unknown.length) throw new Error(`supabase migration history has versions not in the repository: ${unknown.sort().join(', ')}`)
  const recorded = []
  for (const m of files) {
    const pushed = history.get(m.version)
    if (!pushed) throw new Error(`migration ${m.file} is not applied on this Supabase database; apply it with \`supabase db push\` (dry run first), not this runner`)
    if (`${m.version}_${pushed.name}.sql` !== m.file || !pushedMatchesFile(pushed.statements, m.sql)) throw new Error(`pushed migration ${m.version} does not match ${m.file} (frozen)`)
    const prior = applied.get(m.version)
    if (prior) {
      if (prior.checksum !== m.checksum || prior.file !== m.file) throw new Error(`applied migration ${m.file} has changed (frozen); add a new migration instead`)
      continue
    }
    await client.query('insert into bai_meta.schema_migrations (version, file, checksum) values ($1, $2, $3)', [m.version, m.file, m.checksum])
    log(`recorded ${m.file} (verified against supabase_migrations history)`)
    recorded.push(m.file)
  }
  return recorded
}

/** @param {import('pg').ClientBase} client */
export async function applyMigrations (client, { log = () => {} } = {}) {
  await client.query(`create schema if not exists bai_meta;
    revoke all on schema bai_meta from public;
    create table if not exists bai_meta.schema_migrations (
      version text primary key, file text not null, checksum text not null, applied_at timestamptz not null default now())`)
  const applied = new Map((await client.query('select version, file, checksum from bai_meta.schema_migrations')).rows.map((r) => [r.version, r]))
  const history = await supabaseHistory(client)
  if (history) {
    await client.query('begin')
    try {
      const recorded = await adoptSupabaseHistory(client, history, applied, log)
      await client.query('commit')
      return recorded
    } catch (err) { await client.query('rollback'); throw err }
  }
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
