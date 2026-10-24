// The committed download manifest (research/history/manifest.json) is metadata only: URL, size, SHA-256 and time per cached file. It is exempt
// from the publication check, so its shape and its labels are checked here: every entry is labelled with the catalog source that governs its URL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, sourceForUrl } from '../../scripts/history/lib/permissions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
const catalog = loadCatalog(root)

test('every cache entry is metadata only, well formed, and labelled with the catalog source that governs its URL', () => {
  assert.equal(typeof manifest.format, 'string')
  const problems = []
  for (const [key, e] of Object.entries(manifest.entries)) {
    const fields = Object.keys(e).sort().join(',')
    if (fields !== 'bytes,content_type,retrieved_at,sha256,source_key,url') problems.push(`${key}: fields are ${fields} (metadata only: url, source_key, bytes, sha256, retrieved_at, content_type)`)
    if (!/^[0-9a-f]{64}$/.test(e.sha256)) problems.push(`${key}: sha256 malformed`)
    if (!Number.isInteger(e.bytes) || e.bytes < 0) problems.push(`${key}: bytes must be a whole number`)
    if (Number.isNaN(Date.parse(e.retrieved_at))) problems.push(`${key}: retrieved_at is not a time`)
    if (!/^https:\/\//.test(e.url)) problems.push(`${key}: url must be https`)
    if (!catalog.sources.some((s) => s.id === e.source_key)) problems.push(`${key}: source_key ${e.source_key} is not a catalog source`)
    else if (sourceForUrl(catalog, e.url)?.id !== e.source_key) problems.push(`${key}: its URL is governed by ${sourceForUrl(catalog, e.url)?.id ?? 'no catalog source'}, not ${e.source_key}`)
  }
  assert.deepEqual(problems, [])
})

test('a mislabelled or content-carrying entry would be caught', () => {
  const bad = { url: 'https://statsapi.mlb.com/api/v1/draft/2022', source_key: 'wikipedia-draft-articles', bytes: 1, sha256: 'a'.repeat(64), retrieved_at: '2026-10-24T00:00:00Z', content_type: 'application/json', body: '{}' }
  assert.ok(Object.keys(bad).sort().join(',') !== 'bytes,content_type,retrieved_at,sha256,source_key,url', 'extra content field detected')
  assert.equal(sourceForUrl(catalog, bad.url)?.id, 'mlb-statsapi-draft', 'an MLB URL is governed by the MLB entry, so labelling it Wikipedia is caught')
  assert.notEqual(sourceForUrl(catalog, bad.url)?.id, bad.source_key)
})
