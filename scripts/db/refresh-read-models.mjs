// Controlled refresh of the bounded read models (rm_*). Run manually or from a scheduled operator job — never from a request.
import pg from 'pg'
import { ownerDatabaseUrl, requireHostedWriteConfirmation } from './lib/connection.mjs'

const url = ownerDatabaseUrl()
requireHostedWriteConfirmation(url)
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const { rows: [{ role }] } = await client.query('select current_user as role')
  if (['anon', 'authenticated'].includes(role)) throw new Error(`refusing to refresh as ${role}`)
  const { rows: [{ g }] } = await client.query('select refresh_read_models() as g')
  const { rows: [r] } = await client.query('select * from read_model_refreshes where generation_id = $1', [g])
  // Certification flags for the public dashboard (019). Separate function: the research schema stays private.
  const { rows: [{ n }] } = await client.query('select refresh_research_certification() as n')
  console.log(`generation ${g}: ${r.organization_rows} organization rows, ${r.coverage_rows} coverage rows; ${n} certified class(es)`)
} finally { await client.end() }
