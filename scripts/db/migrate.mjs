import pg from 'pg'
import { applyMigrations } from './lib/migrations.mjs'
import { ownerDatabaseUrl } from './lib/connection.mjs'

const client = new pg.Client({ connectionString: ownerDatabaseUrl() })
await client.connect()
try {
  const ran = await applyMigrations(client, { log: console.log })
  console.log(ran.length ? `${ran.length} migration(s) applied` : 'database is up to date')
} finally { await client.end() }
