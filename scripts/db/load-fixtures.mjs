// Loads the TEST_FIXTURE dataset into a local development database. Fixture rows cite a TEST_FIXTURE source and are fictional.
import pg from 'pg'
import { loadFixtures } from './lib/migrations.mjs'
import { ownerDatabaseUrl } from './lib/connection.mjs'

const client = new pg.Client({ connectionString: ownerDatabaseUrl() })
await client.connect()
try {
  const research = await client.query("select 1 from information_schema.tables where table_schema = 'ingest' and table_name = 'import_batches'")
  if (research.rowCount && (await client.query('select 1 from ingest.import_batches limit 1')).rowCount) {
    throw new Error('this database holds research imports; fictional fixtures belong in a separate database')
  }
  const { rows } = await client.query("select 1 from sources where source_key = 'fixture:foundation'")
  if (rows.length) console.log('fixtures already loaded')
  else { await loadFixtures(client); console.log('fixtures loaded') }
  const { rows: [{ g }] } = await client.query('select refresh_read_models() as g')
  console.log(`read models refreshed (generation ${g})`)
} finally { await client.end() }
