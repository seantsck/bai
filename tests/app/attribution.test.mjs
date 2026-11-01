// G6A: public Retrosheet attribution. Retrosheet's notice (https://www.retrosheet.org/notice.txt) requires its statement to appear prominently wherever its data is used.
// These tests keep the one statement verbatim everywhere, and keep every page that can display Retrosheet-derived records carrying it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RETROSHEET_STATEMENT, requiredStatements } from '../../lib/attribution.ts'
import { Attribution } from '../../components/Attribution.tsx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const VERBATIM = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'

test('the statement is Retrosheet\'s wording, byte for byte, in the site constant, the database seed and the importer', () => {
  assert.equal(RETROSHEET_STATEMENT, VERBATIM)
  assert.ok(read('database/migrations/030_transaction_public_read_model.sql').includes(VERBATIM), 'the statement stored for the site (migration 030)')
  assert.ok(read('scripts/history/lib/retrosheet.mjs').includes(VERBATIM), 'the statement the importer writes into the source notes')
})

test('which statements a page must show: only published groups, every group while that is unknown, forced when rows name one', () => {
  const st = [{ attribution_category: 'RETROSHEET', statement: VERBATIM }, { attribution_category: 'CHADWICK_REGISTER', statement: 'c' }]
  assert.deepEqual(requiredStatements(st, ['RETROSHEET']).map((s) => s.attribution_category), ['RETROSHEET'])
  assert.deepEqual(requiredStatements(st, []), [])
  assert.equal(requiredStatements(st, null).length, 2, 'totals unavailable: credit rather than omit')
  assert.equal(requiredStatements(st, undefined).length, 2)
  assert.equal(requiredStatements(st, [], true).length, 2)
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
  for (const f of ['app/players/page.tsx', 'app/players/[slug]/page.tsx']) assert.match(read(f), /<PageAttribution \/>/, `${f}: players created from Retrosheet transactions are displayed here`)
  const sources = read('app/sources/page.tsx')
  assert.match(sources, /<Attribution statements=\{\[\{ attribution_category: 'RETROSHEET', statement: RETROSHEET_STATEMENT/, 'the sources page always shows it')
  assert.match(sources, /const RETROSHEET_CREDIT = RETROSHEET_STATEMENT/, 'the group table credits the same text')
})

test('the sources page no longer says the Retrosheet data is not shown on the site', () => {
  const src = read('app/sources/page.tsx')
  assert.doesNotMatch(src, /not shown on this site yet/)
  assert.doesNotMatch(src, /Reference data used in research/)
})

test('PageAttribution fails toward crediting: unknown totals show every statement, unavailable statements show nothing and never an error', () => {
  const src = read('components/PageAttribution.tsx')
  assert.match(src, /: null\n?\s*return <Attribution statements=\{requiredStatements\(statements\.data, authorized\)\}/)
  assert.match(src, /if \(!statements\.ok\) return null/)
})
