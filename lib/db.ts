// Public read access. Every page query runs in a read-only transaction as the `anon` role, so the RLS boundary that will
// protect the hosted database is exercised locally too. Statement timeout keeps a bad query from tying up the server.
import pg from 'pg'

let pool: pg.Pool | null = null

export class DatabaseUnavailableError extends Error {}

function getPool (): pg.Pool {
  const url = process.env.BAI_PUBLIC_DATABASE_URL || process.env.BAI_DATABASE_URL
  if (!url) throw new DatabaseUnavailableError('BAI_DATABASE_URL is not set')
  pool ??= new pg.Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10000 })
  return pool
}

const PUBLIC_ROLE = process.env.BAI_PUBLIC_ROLE || 'anon'
const STATEMENT_TIMEOUT_MS = Number(process.env.BAI_STATEMENT_TIMEOUT_MS || 3000)

export async function publicQuery<T extends pg.QueryResultRow = pg.QueryResultRow> (sql: string, params: unknown[] = []): Promise<T[]> {
  if (!/^[a-z_]+$/.test(PUBLIC_ROLE)) throw new Error('invalid BAI_PUBLIC_ROLE')
  let client: pg.PoolClient
  try {
    client = await getPool().connect()
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) throw err
    throw new DatabaseUnavailableError((err as Error).message)
  }
  try {
    await client.query('begin read only')
    await client.query(`set local role ${PUBLIC_ROLE}`)
    await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    const result = await client.query<T>(sql, params)
    await client.query('commit')
    return result.rows
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function closePool (): Promise<void> {
  await pool?.end()
  pool = null
}
