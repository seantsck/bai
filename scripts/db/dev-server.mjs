// Local PostgreSQL 17 for development and replay (embedded binaries; no Docker, no hosted database).
// Data lives in .pgdata/ (gitignored). Ctrl-C stops the server.
import path from 'node:path'
import fs from 'node:fs'
import EmbeddedPostgres from 'embedded-postgres'
import { repoRoot } from './lib/migrations.mjs'

const port = Number(process.env.BAI_PG_PORT || 54329)
const databaseDir = path.join(repoRoot, '.pgdata')
const fresh = !fs.existsSync(path.join(databaseDir, 'PG_VERSION'))
const server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {} })
if (fresh) await server.initialise()
await server.start()
if (fresh) await server.createDatabase('bai')
console.log(`PostgreSQL 17 running: BAI_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/bai`)
const stop = async () => { await server.stop(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
setInterval(() => {}, 1 << 30)
