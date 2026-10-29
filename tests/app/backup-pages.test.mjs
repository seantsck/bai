import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ROUTES = ['/backup', '/backup/privacy', '/backup/terms']
const src = (r) => fs.readFileSync(path.join(root, 'app', r, 'page.tsx'), 'utf8')
const all = () => ROUTES.map(src).join('\n') + fs.readFileSync(path.join(root, 'components/BackupPages.tsx'), 'utf8')

test('the three public backup pages exist and set a title and description', () => {
  for (const r of ROUTES) {
    assert.ok(fs.existsSync(path.join(root, 'app', r, 'page.tsx')), r)
    assert.match(src(r), /title:/, r); assert.match(src(r), /description:/, r)
  }
})

test('the pages are public and static: no database, no auth, no dynamic rendering, no middleware', () => {
  for (const r of ROUTES) {
    assert.doesNotMatch(src(r), /lib\/(db|queries|transactions)|force-dynamic|cookies\(|headers\(|next-auth|getSession|supabase|redirect\(/i, r)
  }
  for (const f of ['middleware.ts', 'proxy.ts', 'middleware.js']) assert.ok(!fs.existsSync(path.join(root, f)), `${f} could gate the pages`)
})

test('the home page names the app and links visibly to the privacy policy and terms; every page links to both', () => {
  assert.match(src('/backup'), /BACKUP_APP_NAME/)
  assert.match(fs.readFileSync(path.join(root, 'components/BackupPages.tsx'), 'utf8'), /BAI Automated Backups/)
  for (const r of ROUTES) { const s = src(r); assert.match(s, /BackupFooter/, r); assert.match(s, /BackupNav/, r) }
  const c = fs.readFileSync(path.join(root, 'components/BackupPages.tsx'), 'utf8')
  assert.match(c, /href: '\/backup\/privacy'/); assert.match(c, /href: '\/backup\/terms'/); assert.match(c, /href='\/backup\/privacy'/); assert.match(c, /href='\/backup\/terms'/)
})

test('the privacy policy states the exact scope, revocation, retention, sharing and no-advertising commitments', () => {
  const s = src('/backup/privacy')
  for (const re of [/auth\/drive\.file/, /myaccount\.google\.com\/permissions/, /Retention and deletion/, /not shared with, sold to or transferred/, /not used for advertising/, /Limited Use/, /AES|encrypted before they leave/]) assert.match(s, re)
  assert.doesNotMatch(s, /auth\/drive['"` <]/, 'never the full-Drive scope')
})

test('nothing secret or internal is exposed: no keys, fingerprints, tokens, hosts, paths or e-mail addresses', () => {
  const t = all()
  for (const re of [/[0-9A-F]{40}/, /ya29\.|GOCSPX|1\/\/0/, /BEGIN [A-Z ]*KEY/, /\b\d{1,3}(\.\d{1,3}){3}\b/, /[\w.+-]+@[\w-]+\.[\w.]+/, /\/home\/|\.config\/|rclone\.conf|\.env/, /supabase\.co|dbnmktid/, /postgres(ql)?:\/\//])
    assert.doesNotMatch(t, re, String(re))
})

test('canonical URLs are the www production addresses', () => {
  for (const r of ROUTES) assert.match(src(r), new RegExp(`canonical: 'https://www\\.baibaseball\\.app${r}'`), r)
})

test('the privacy policy describes the session passphrase, the wrapped key in Drive and the off-server private key without promising secure erasure', () => {
  const s = src('/backup/privacy')
  for (const re of [/single-use session passphrase/, /exists temporarily on the server/, /wrapped key file is stored in Google Drive/, /private recovery key is never on the server/, /best-effort/, /not a guarantee of secure erasure/]) assert.match(s, re)
  assert.doesNotMatch(s, /not stored in Google Drive or on the server/)
})
