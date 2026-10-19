// Execute-and-roll-back rehearsal of pending migrations on the target database (usually hosted, before `supabase db
// push`). `db push --dry-run` only lists files; this actually runs every pending file, in order, inside ONE transaction
// as the same owner role the push will use, reports what each one created per schema, and then ROLLS BACK. Nothing
// persists (role creation and extensions are transactional in PostgreSQL). Read-only in effect, so no confirmation flag.
//
//   npm run hosted:rehearse
import pg from 'pg'
import { listMigrations, supabaseHistory } from './lib/migrations.mjs'
import { ownerDatabaseUrl } from './lib/connection.mjs'

const db = new pg.Client({ connectionString: ownerDatabaseUrl() })
await db.connect()
const objects = async () => (await db.query(`select n.nspname s, count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' group by 1`)).rows.reduce((m, r) => ({ ...m, [r.s]: r.n }), {})
let failed = false
try {
  const history = await supabaseHistory(db)
  const pending = listMigrations().filter((m) => !history?.has(m.version))
  console.log(`${pending.length} pending migration(s): ${pending.map((m) => m.version).join(', ') || 'none'}`)
  await db.query('begin')
  try {
    for (const m of pending) {
      const before = await objects()
      const notices = []
      const onNotice = (n) => notices.push(n.message)
      db.on('notice', onNotice)
      try { await db.query(m.sql) } catch (err) { failed = true; console.log(`  ${m.file}: FAILED: ${err.message}`); break } finally { db.off('notice', onNotice) }
      const after = await objects()
      const delta = Object.keys({ ...before, ...after }).filter((s) => (after[s] ?? 0) !== (before[s] ?? 0)).map((s) => `${s} ${(after[s] ?? 0) - (before[s] ?? 0) >= 0 ? '+' : ''}${(after[s] ?? 0) - (before[s] ?? 0)}`)
      console.log(`  ${m.file}: ok  relations ${delta.join(', ') || 'unchanged'}${notices.length ? `  notices: ${[...new Set(notices)].join(' | ')}` : ''}`)
    }
  } finally {
    await db.query('rollback')
  }
  const left = await objects()
  console.log(`rolled back; BAI schemas now hold ${['public', 'analytics', 'ingest', 'bai_meta'].map((s) => `${s}=${left[s] ?? 0}`).join(' ')} relations`)
} finally { await db.end() }
console.log(failed ? 'REHEARSAL FAILED' : 'REHEARSAL OK')
process.exit(failed ? 1 : 0)
