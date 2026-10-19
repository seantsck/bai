import pg from 'pg'
import { applyMigrations } from './lib/migrations.mjs'
import { ownerDatabaseUrl, requireHostedWriteConfirmation } from './lib/connection.mjs'

// On a Supabase-pushed database this only verifies the pushed history and records checksums (see lib/migrations.mjs).
const url = ownerDatabaseUrl()
requireHostedWriteConfirmation(url)
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const ran = await applyMigrations(client, { log: console.log })
  console.log(ran.length ? `${ran.length} migration(s) applied (or, on Supabase, verified and recorded)` : 'database is up to date')
} finally { await client.end() }
