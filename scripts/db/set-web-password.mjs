// Sets a fresh random password for the web server's login role (bai_web, migration 016) and writes the matching
// BAI_PUBLIC_DATABASE_URL into the env file. Nothing secret is printed. The password reaches the server only as a
// SCRAM-SHA-256 verifier computed here, so even statement logging on the server never sees the password itself.
//
//   npm run hosted:web-role -- --confirm-hosted <project ref>
import crypto from 'node:crypto'
import fs from 'node:fs'
import pg from 'pg'
import { ownerDatabaseUrl, requireHostedWriteConfirmation, isLocalUrl } from './lib/connection.mjs'

const ENV_FILE = process.env.BAI_ENV_FILE || '.env.hosted.local'

function scramVerifier (password, iterations = 4096) {
  const salt = crypto.randomBytes(16)
  const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256')
  const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest()
  const storedKey = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest()
  const serverKey = hmac(salted, 'Server Key')
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
}

const ownerUrl = ownerDatabaseUrl()
requireHostedWriteConfirmation(ownerUrl)
if (isLocalUrl(ownerUrl) && !process.env.BAI_ENV_FILE) throw new Error('local databases use the owner URL; set BAI_ENV_FILE to target a file deliberately')
const password = crypto.randomBytes(32).toString('base64url')
const db = new pg.Client({ connectionString: ownerUrl })
await db.connect()
try {
  const exists = (await db.query("select 1 from pg_roles where rolname = 'bai_web'")).rowCount
  if (!exists) throw new Error('role bai_web does not exist; push migration 016 first')
  await db.query(`alter role bai_web password '${scramVerifier(password)}'`)
} finally { await db.end() }

const owner = new URL(ownerUrl)
const web = new URL(ownerUrl)
web.username = 'bai_web'
web.password = encodeURIComponent(password)
web.search = owner.search
const line = `BAI_PUBLIC_DATABASE_URL=${web.toString()}`
const text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
const next = /^BAI_PUBLIC_DATABASE_URL=.*$/m.test(text) ? text.replace(/^BAI_PUBLIC_DATABASE_URL=.*$/m, line) : `${text.replace(/\n?$/, '\n')}${line}\n`
fs.writeFileSync(ENV_FILE, next, { mode: 0o600 })
fs.chmodSync(ENV_FILE, 0o600)
console.log(`bai_web password rotated; BAI_PUBLIC_DATABASE_URL updated in ${ENV_FILE} (value not shown)`)
