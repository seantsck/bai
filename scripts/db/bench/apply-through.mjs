// Clone a benchmark database and apply the committed migrations through a version.   node apply-through.mjs <from> <to> [<through>]
import { startCluster } from './cluster.mjs'
import { applyMigrations } from '../lib/migrations.mjs'
const [from, to, through] = process.argv.slice(2)
const c = await startCluster()
try { await c.clone(from, to); const db = await c.connect(to); await applyMigrations(db, { through: through ?? null }); await db.query('analyze'); console.log(`${to}: ${(await db.query('select max(version) v from bai_meta.schema_migrations')).rows[0].v}`); await db.end() } finally { await c.stop() }
