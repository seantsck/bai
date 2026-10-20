// Public read access. Every page query runs in a read-only transaction as the `anon` role, so the RLS boundary that will
// protect the hosted database is exercised locally too. Statement timeout keeps a bad query from tying up the server.
import fs from 'node:fs'
import path from 'node:path'
import pg from 'pg'

let pool: pg.Pool | null = null

export class DatabaseUnavailableError extends Error {}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
// Supabase's root CA (public), committed and traced into the server bundle (next.config.ts). Remote connections always
// verify the server certificate against it; a URL's own sslmode/sslrootcert is ignored, so it cannot weaken that.
const SUPABASE_CA = 'supabase/prod-ca-2021.crt'

/**
 * Pool settings from the environment. On Vercel the server must read hosted BAI through the least-privilege web role
 * (bai_web, or bai_web.<ref> through Supabase's pooler) and never falls back to BAI_DATABASE_URL, which may hold the
 * owner credential. Throws DatabaseUnavailableError, whose message never contains the URL.
 */
export function connectionConfig (env: NodeJS.ProcessEnv = process.env, readCa = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8')): pg.PoolConfig {
  const hosted = Boolean(env.VERCEL)
  const url = hosted ? env.BAI_PUBLIC_DATABASE_URL : (env.BAI_PUBLIC_DATABASE_URL || env.BAI_DATABASE_URL)
  if (!url) throw new DatabaseUnavailableError(hosted ? 'BAI_PUBLIC_DATABASE_URL is not set' : 'BAI_DATABASE_URL is not set')
  let u: URL
  try { u = new URL(url) } catch { throw new DatabaseUnavailableError('database URL is malformed') }
  const user = decodeURIComponent(u.username)
  if (hosted && !/^bai_web(\.[a-z0-9]{20})?$/.test(user)) throw new DatabaseUnavailableError('the web server must connect as bai_web')
  const pooled = hosted ? { max: 3, idleTimeoutMillis: 5000 } : { max: 5, idleTimeoutMillis: 10000 }
  if (LOCAL_HOSTS.has(u.hostname)) {
    if (hosted) throw new DatabaseUnavailableError('BAI_PUBLIC_DATABASE_URL points at a local database')
    return { connectionString: url, ...pooled }
  }
  u.searchParams.delete('sslmode')
  u.searchParams.delete('sslrootcert')
  return { connectionString: u.toString(), ssl: { ca: readCa(SUPABASE_CA), rejectUnauthorized: true }, ...pooled }
}

function getPool (): pg.Pool {
  pool ??= new pg.Pool(connectionConfig())
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
