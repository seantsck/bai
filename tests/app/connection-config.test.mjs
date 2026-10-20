import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connectionConfig, DatabaseUnavailableError } from '../../lib/db.ts'

const REF = 'abcdefghijklmnopqrst'
// URLs are assembled so no literal credential appears in the source (the credential scan rejects those).
const url = (user, host, password = 'placeholder') => { const u = new URL(`postgres://${host}/postgres`); u.username = user; u.password = password; return u.toString() }
const POOLER = url(`bai_web.${REF}`, 'aws-1-ca-central-1.pooler.supabase.com:6543')
const ca = () => 'CA'

test('local development uses BAI_DATABASE_URL without TLS', () => {
  const c = connectionConfig({ BAI_DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/bai' }, ca)
  assert.equal(c.ssl, undefined)
  assert.equal(c.max, 5)
})

test('on Vercel only BAI_PUBLIC_DATABASE_URL is read, never the owner URL', () => {
  assert.throws(() => connectionConfig({ VERCEL: '1', BAI_DATABASE_URL: url('postgres', `db.${REF}.supabase.co:5432`) }, ca),
    (e) => e instanceof DatabaseUnavailableError && /BAI_PUBLIC_DATABASE_URL is not set/.test(e.message))
})

test('on Vercel the web server must connect as bai_web', () => {
  for (const user of ['postgres', `postgres.${REF}`, 'anon', 'bai_reviewer', 'bai_web_x']) {
    assert.throws(() => connectionConfig({ VERCEL: '1', BAI_PUBLIC_DATABASE_URL: url(user, 'aws-1-ca-central-1.pooler.supabase.com:6543') }, ca),
      (e) => e instanceof DatabaseUnavailableError && !e.message.includes('placeholder'), user)
  }
  assert.throws(() => connectionConfig({ VERCEL: '1', BAI_PUBLIC_DATABASE_URL: url('bai_web', '127.0.0.1:54329') }, ca), /local database/)
})

test('remote connections always verify the certificate against the bundled CA, whatever the URL says', () => {
  const c = connectionConfig({ VERCEL: '1', BAI_PUBLIC_DATABASE_URL: `${POOLER}?sslmode=no-verify&sslrootcert=/nonexistent` }, ca)
  assert.deepEqual(c.ssl, { ca: 'CA', rejectUnauthorized: true })
  assert.doesNotMatch(String(c.connectionString), /sslmode|sslrootcert/)
  assert.equal(c.max, 3)
})
