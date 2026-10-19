// Resolves the database URL for owner-level scripts and refuses anything that looks like a hosted/production target unless
// explicitly allowed. BAI never talks to DISI's database.
export function ownerDatabaseUrl () {
  const url = process.env.BAI_DATABASE_URL || process.env.DATABASE_URL
  if (!url) throw new Error('Set BAI_DATABASE_URL (see .env.example). Start a local PostgreSQL 17 with `npm run db:server`.')
  const host = new URL(url).hostname
  const local = ['localhost', '127.0.0.1', '::1'].includes(host)
  if (!local && process.env.BAI_ALLOW_REMOTE_DB !== '1') throw new Error(`refusing non-local database host ${host} (set BAI_ALLOW_REMOTE_DB=1 deliberately)`)
  return url
}
