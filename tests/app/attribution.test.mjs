// G6A: public Retrosheet attribution. Retrosheet's notice (https://www.retrosheet.org/notice.txt) requires its statement to appear prominently wherever its data is used.
// These tests keep the one statement verbatim everywhere, and keep every page that can display Retrosheet-derived records carrying it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RETROSHEET_STATEMENT, RETROSHEET_NOTICE_URL, RETROSHEET_ENTRY, pageStatements, retrosheetOwed } from '../../lib/attribution.ts'
import { Attribution } from '../../components/Attribution.tsx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const VERBATIM = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'

test('the statement is Retrosheet\'s wording, byte for byte, in the site constant, the database seed and the importer', () => {
  assert.equal(RETROSHEET_STATEMENT, VERBATIM)
  assert.ok(read('database/migrations/030_transaction_public_read_model.sql').includes(VERBATIM), 'the statement stored for the site (migration 030)')
  assert.ok(read('scripts/history/lib/retrosheet.mjs').includes(VERBATIM), 'the statement the importer writes into the source notes')
})

const OTHER = { attribution_category: 'CHADWICK_REGISTER', statement: 'c', notice_url: 'u' }
const DB_RETRO = { attribution_category: 'RETROSHEET', statement: 'a stale copy from the database', notice_url: 'x' }
const cats = (e) => pageStatements(e).map((s) => s.attribution_category)

test('Retrosheet\'s entry comes from the constants only, whatever the database says', () => {
  assert.equal(RETROSHEET_ENTRY.statement, VERBATIM); assert.equal(RETROSHEET_ENTRY.notice_url, RETROSHEET_NOTICE_URL)
  const out = pageStatements({ statements: [DB_RETRO, OTHER], authorized: ['RETROSHEET', 'CHADWICK_REGISTER'] })
  assert.equal(out.find((s) => s.attribution_category === 'RETROSHEET').statement, VERBATIM)
})

test('fail closed: the statement is owed unless the page proves none of its content is shown', () => {
  assert.equal(retrosheetOwed({ statements: [], authorized: null }), true, 'overview unavailable')
  assert.equal(retrosheetOwed({ statements: null, authorized: [] , rowsRequire: true }), true, 'rows name it, overview stale/empty')
  assert.equal(retrosheetOwed({ statements: null, authorized: [], aggregatesPresent: true }), true, 'aggregates built from published rows')
  assert.equal(retrosheetOwed({ statements: null, authorized: ['RETROSHEET'] }), true, 'published')
  assert.equal(retrosheetOwed({ statements: [], authorized: ['CHADWICK_REGISTER'] }), false, 'baseline: overview answered, nothing Retrosheet shown')
  assert.deepEqual(cats({ statements: null, authorized: null }), ['RETROSHEET'], 'statements lookup failed: still shown')
})

test('a record page follows the record\'s own source groups, not the overview or the lookup', () => {
  assert.deepEqual(cats({ statements: null, authorized: null, recordCategories: ['RETROSHEET', 'MLB'] }), ['RETROSHEET'])
  assert.deepEqual(cats({ statements: [OTHER], authorized: [], recordCategories: ['RETROSHEET', 'CHADWICK_REGISTER'] }), ['CHADWICK_REGISTER', 'RETROSHEET'])
  assert.deepEqual(cats({ statements: [OTHER], authorized: ['RETROSHEET'], recordCategories: ['MLB'] }), [], 'an MLB-only record owes nothing')
  assert.deepEqual(cats({ statements: null, authorized: [], recordCategories: null }), ['RETROSHEET'], 'unknown groups: fail closed')
})

test('the rendered box is prominent, carries the statement verbatim (quotes intact) and links the notice', () => {
  const html = renderToStaticMarkup(React.createElement(Attribution, { statements: [{ attribution_category: 'RETROSHEET', statement: VERBATIM, notice_url: 'https://www.retrosheet.org/notice.txt' }] }))
  assert.match(html, /class="attribution"/)
  assert.ok(html.replace(/&quot;/g, '"').includes(`<strong>${VERBATIM}</strong>`), html)
  assert.match(html, /href="https:\/\/www\.retrosheet\.org\/notice\.txt"/)
  assert.equal(renderToStaticMarkup(React.createElement(Attribution, { statements: [] })), '')
})

test('every page that can show Retrosheet-derived records carries the attribution box', () => {
  for (const f of ['app/transactions/page.tsx', 'app/transactions/[id]/page.tsx', 'app/transactions/coverage/page.tsx']) assert.match(read(f), /<Attribution statements=/, f)
  for (const f of ['app/players/page.tsx', 'app/players/[slug]/page.tsx']) assert.match(read(f), /<Attribution statements=\{\[RETROSHEET_ENTRY\]\} \/>/, `${f}: unconditional (players created from Retrosheet transactions are displayed here)`)
  const sources = read('app/sources/page.tsx')
  assert.match(sources, /<Attribution statements=\{\[RETROSHEET_ENTRY\]\} \/>/, 'the sources page always shows it')
  assert.match(sources, /const RETROSHEET_CREDIT = RETROSHEET_STATEMENT/, 'the group table credits the same text')
})

test('the sources page no longer says the Retrosheet data is not shown on the site', () => {
  const src = read('app/sources/page.tsx')
  assert.doesNotMatch(src, /not shown on this site yet/)
  assert.doesNotMatch(src, /Reference data used in research/)
})
