// READ-ONLY. Writes the R8B research queues for the published trade records into a NEW directory outside any git work tree and prints counts only.
//   node --env-file=<hosted env> scripts/research/r8b-queues.mjs --out ~/bai-gates/r8b-<date>
import pg from 'pg'
import { ownerDatabaseUrl } from '../db/lib/connection.mjs'
import { assertOutputAllowed, fetchTrades, writeQueues } from './lib/r8b-queue.mjs'

const argv = process.argv.slice(2); const i = argv.indexOf('--out')
if (i < 0 || !argv[i + 1] || argv.length !== 2) { console.error('usage: r8b-queues.mjs --out <new directory outside the repository>'); process.exit(2) }
try { assertOutputAllowed(argv[i + 1]) } catch (e) { console.error(e.message); process.exit(2) }
const client = new pg.Client({ connectionString: ownerDatabaseUrl(), application_name: 'bai-r8b-queues-ro', options: '-c default_transaction_read_only=on' })
await client.connect()
try {
  await client.query('begin isolation level repeatable read read only')
  const rows = await fetchTrades(client); await client.query('rollback')
  console.log(JSON.stringify({ published_trades: rows.length, ...writeQueues(rows, argv[i + 1]) }))
} finally { await client.end() }
