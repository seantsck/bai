// Controlled refresh of the bounded read models (rm_*). Run manually or from a scheduled operator job — never from a request.
import pg from 'pg'
import { ownerDatabaseUrl } from './lib/connection.mjs'

const client = new pg.Client({ connectionString: ownerDatabaseUrl() })
await client.connect()
try {
  const { rows: [{ role }] } = await client.query('select current_user as role')
  if (['anon', 'authenticated'].includes(role)) throw new Error(`refusing to refresh as ${role}`)
  const { rows: [{ g }] } = await client.query('select refresh_read_models() as g')
  const { rows: [r] } = await client.query('select * from read_model_refreshes where generation_id = $1', [g])
  console.log(`generation ${g}: ${r.organization_rows} organization rows, ${r.coverage_rows} coverage rows`)
} finally { await client.end() }
