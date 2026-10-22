// Outbound request identity: research requests identify the project by URL only, and private configuration (emails,
// credentials, environment secrets) can never reach a network header. No database, no network (stub fetch).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { userAgent, assertSafeHeaders, publicRequestHeaders, privateEnvValues, PROJECT_URL } from '../../scripts/history/lib/outbound.mjs'
import { loadCatalog } from '../../scripts/history/lib/permissions.mjs'
import { createFetcher } from '../../scripts/history/lib/fetch.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('the user agent names the project and its URL, never a person', () => {
  const ua = userAgent('wikidata reader')
  assert.equal(ua, `BAI-research/0.1 (wikidata reader; +${PROJECT_URL})`)
  assert.match(ua, /^BAI-research\/0\.1 \(/)
  assert.doesNotMatch(ua, /@/)
  assert.throws(() => userAgent('me <me@example.test>'), /plain label/)
  assert.throws(() => userAgent(''), /plain label/)
})

test('headers carrying an email address, credentials or tokens are refused', () => {
  const env = {}
  for (const bad of ['BAI/1 (contact: someone@example.test)', 'BAI/1 someone@example.test', 'postgresql://owner:hunter22@localhost:5432/x', 'bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk', ['sb', 'secret', 'abcdef123456'].join('_'), 'a'.repeat(10) + '0123456789abcdef'.repeat(3)]) {
    assert.throws(() => assertSafeHeaders({ 'User-Agent': bad }, { env }), /outbound header User-Agent/, bad)
  }
  for (const name of ['Authorization', 'Cookie', 'From', 'X-Api-Key']) assert.throws(() => assertSafeHeaders({ [name]: 'x' }, { env }), /not allowed/)
  assert.deepEqual(assertSafeHeaders({ 'User-Agent': userAgent('importer'), Accept: 'application/json' }, { env }), { 'User-Agent': userAgent('importer'), Accept: 'application/json' })
})

test('a value from a private environment variable cannot be sent, whatever it looks like', () => {
  const env = { BAI_OPERATOR_NAME: 'ignored: not a private name', SOME_PASSWORD: 'correct horse battery', CONTACT_EMAIL: 'plainvalue-not-an-email', VERCEL_TOKEN: 'short', OWNER_NOTE: 'owner-private-note' }
  assert.deepEqual(privateEnvValues(env).sort(), ['correct horse battery', 'owner-private-note', 'plainvalue-not-an-email'].sort())   // 'short' (< 6 chars) is not treated as a secret
  for (const v of ['correct horse battery', 'owner-private-note', 'plainvalue-not-an-email']) assert.throws(() => assertSafeHeaders({ 'User-Agent': `BAI (${v})` }, { env }), /private environment variable/)
  assert.doesNotThrow(() => assertSafeHeaders({ 'User-Agent': userAgent('importer') }, { env }))
})

test('the fetcher checks headers before any request leaves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-outbound-'))
  try {
    const catalog = loadCatalog(root)
    let calls = 0
    const seen = []
    const stub = async (url, init) => { calls++; seen.push(init.headers); return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }) }
    const url = 'https://www.retrosheet.org/transactions/readme.txt'
    const bad = createFetcher({ root: dir, catalog, userAgent: 'BAI-research (someone@example.test)', minIntervalMs: 0, fetchImpl: stub })
    await assert.rejects(bad.get('retrosheet/readme.txt', url, { source: 'retrosheet-transactions', use: 'fetch_targeted' }), /email address/)
    assert.equal(calls, 0, 'no request is made with an unsafe header')
    const good = createFetcher({ root: dir, catalog, userAgent: userAgent('test'), minIntervalMs: 0, fetchImpl: stub })
    await good.get('retrosheet/readme.txt', url, { source: 'retrosheet-transactions', use: 'fetch_targeted' })
    assert.equal(calls, 1)
    assert.equal(seen[0]['User-Agent'], userAgent('test'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('source code builds request headers only through the outbound module', () => {
  const files = execFileSync('git', ['ls-files', '--', 'scripts', 'lib', 'app', 'components'], { cwd: root, encoding: 'utf8' }).split('\n').filter((f) => /\.(mjs|js|ts|tsx)$/.test(f))
  const offenders = []
  for (const f of files) {
    if (f === 'scripts/history/lib/outbound.mjs') continue
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n')
    lines.forEach((l, i) => {
      if (/user-agent/i.test(l) && !/publicRequestHeaders|assertSafeHeaders|userAgent/.test(l)) offenders.push(`${f}:${i + 1}`)
      if (/user-agent/i.test(l) && /process\.env|mailto:|@[a-z0-9-]+\.[a-z]{2,}/i.test(l)) offenders.push(`${f}:${i + 1} (private value in a User-Agent)`)
    })
  }
  assert.deepEqual(offenders, [])
})

test('no email address is committed anywhere in the repository (placeholders excepted)', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f && f !== 'package-lock.json' && !/\.(png|jpg|ico|woff2?)$/.test(f))
  const allowed = new Set(['admin@email.com'])   // documentation placeholders
  const found = []
  for (const f of files) {
    let text
    try { text = fs.readFileSync(path.join(root, f), 'utf8') } catch { continue }
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g)) {
      if (allowed.has(m[0]) || /^x@db\.[a-z]+\.supabase\.co$/.test(m[0]) || /@(users\.noreply\.github\.com|example\.(test|com|org))$/.test(m[0])) continue
      found.push(`${f}: an email address`)
    }
  }
  assert.deepEqual(found, [])
})

test('publicRequestHeaders always yields a project user agent', () => {
  const h = publicRequestHeaders('retrosheet transactions importer', { Accept: 'text/csv' }, { env: {} })
  assert.equal(h.Accept, 'text/csv')
  assert.ok(h['User-Agent'].includes(PROJECT_URL))
})

test('the standing agent brief forbids custom HTTP code, personal identifiers and workarounds', async () => {
  const { AGENT_REQUEST_RULES, agentRequestRulesBlock } = await import('../../scripts/history/lib/agent-brief.mjs')
  const block = agentRequestRulesBlock()
  assert.match(block, /WebSearch and WebFetch/)
  assert.match(block, /no HTTP code/i)
  assert.ok(block.includes(PROJECT_URL))
  assert.match(block, /personal information or credentials/)
  assert.match(block, /never work around it/)
  assert.doesNotMatch(block, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/, 'the brief contains no email address')
  assert.equal(AGENT_REQUEST_RULES.length, 6)
})
