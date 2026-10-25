// Clone a benchmark database and apply the committed migrations on the clone (029 only, normally).   node apply-029.mjs <from> <to>
import { startCluster } from './cluster.mjs'
import { applyMigrations } from '../lib/migrations.mjs'
const [from, to] = process.argv.slice(2)
const c = await startCluster()
try { await c.clone(from, to); const db = await c.connect(to); await applyMigrations(db); await db.query('analyze'); console.log(`${to}: ${(await db.query('select max(version) v from bai_meta.schema_migrations')).rows[0].v}`); await db.end() } finally { await c.stop() }
