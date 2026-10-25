// Controlled refresh of the public transaction read model (migration 030): public.refresh_transaction_read_models().
// Owner-run, never from a request. The refresh locks everything it reads (NOWAIT) so that a publication grant, a verification or a record changing
// at the same moment is ordered strictly before or after it; when a writer is mid-transaction it fails at once with 55P03 and publishes nothing.
// That, 40P01 (deadlock) and 40001 (serialization) are SAFE to retry, and are retried here with backoff. Any other error stops the command.
//   node scripts/db/refresh-transaction-read-models.mjs [--attempts 10] [--confirm-hosted <project ref>]
// A hosted target needs the same deliberate confirmation as every hosted write. Environment: BAI_REFRESH_BACKOFF_MS (first delay, default 500).
import pg from 'pg'
import { ownerDatabaseUrl, requireHostedWriteConfirmation } from './lib/connection.mjs'

export const RETRYABLE = ['55P03', '40P01', '40001']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Runs the refresh on a connected client; retries only the SQLSTATEs above. Returns { generation, attempts }. */
export async function refreshWithRetry (client, { attempts = 10, backoffMs = 500, log = () => {} } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await client.query('begin isolation level read committed')
      const { rows: [{ g }] } = await client.query('select public.refresh_transaction_read_models() as g')
      await client.query('commit')
      return { generation: Number(g), attempts: i }
    } catch (e) {
      await client.query('rollback').catch(() => {})
      if (!RETRYABLE.includes(e.code) || i === attempts) throw e
      const wait = Math.min(backoffMs * 2 ** (i - 1), 8000)
      log(`attempt ${i} did not run (${e.code}: ${e.message.split('\n')[0]}); the read model is unchanged. Retrying in ${wait} ms`)
      await sleep(wait)
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const url = ownerDatabaseUrl()
  requireHostedWriteConfirmation(url)
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const { rows: [{ role }] } = await client.query('select current_user as role')
    if (['anon', 'authenticated'].includes(role)) throw new Error(`refusing to refresh as ${role}`)
    const i = argv.indexOf('--attempts')
    const r = await refreshWithRetry(client, { attempts: i >= 0 ? Number(argv[i + 1]) : 10, backoffMs: Number(process.env.BAI_REFRESH_BACKOFF_MS ?? 500), log: (m) => console.error(m) })
    const { rows: [o] } = await client.query('select transactions, withheld_unauthorized, verified_complete from public.rm_transaction_overview')
    console.log(`generation ${r.generation} (attempt ${r.attempts}): ${o.transactions} transactions published, ${o.withheld_unauthorized} withheld by permission, ${o.verified_complete} verified complete`)
  } finally { await client.end() }
}
