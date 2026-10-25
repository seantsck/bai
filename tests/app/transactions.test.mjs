import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTransactionParams, buildTransactionQuery, searchQueryText, transactionHref, statusView, gapLabel, formatTransactionDate, TX_PAGE_SIZE, TX_MAX_PAGE, GAP_LABELS } from '../../lib/transactions.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('filters are whitelisted or parsed; anything else is dropped', () => {
  const f = parseTransactionParams({ q: "  José O'Brien ", season: '2015', club: 'lad', type: 'free_agent', status: 'partial', page: '3' })
  assert.deepEqual(f, { q: 'jose o brien', season: 2015, club: 'LAD', category: 'FREE_AGENT', status: 'PARTIAL', page: 3 })
  const bad = parseTransactionParams({ q: '%%%', season: '1800', club: "LAD'; drop table x;--", type: 'GRADE', status: 'BEST', page: '-1' })
  assert.deepEqual(bad, { q: null, season: null, club: null, category: null, status: null, page: 1 })
  assert.equal(parseTransactionParams({ page: '99999' }).page, TX_MAX_PAGE)
  assert.equal(parseTransactionParams({ status: 'VERIFIED_COMPLETE' }).status, 'VERIFIED_COMPLETE')
})

test('the query is fixed SQL with every value as a parameter, bounded, paginated, newest first', () => {
  const f = parseTransactionParams({ q: "o'neil", season: '2015', club: 'NYY', type: 'TRADE', status: 'PARTIAL', page: '2' })
  const { sql, params } = buildTransactionQuery(f)
  assert.doesNotMatch(sql, /neil|NYY|2015|TRADE|PARTIAL/)
  assert.deepEqual(params, ["o:* & neil:*", 2015, 'NYY', 'TRADE', 'PARTIAL', TX_PAGE_SIZE + 1, TX_PAGE_SIZE])
  assert.match(sql, /from rm_transactions t where t\.search_tsv @@ to_tsquery\('simple', \$1\) and t\.season = \$2 and t\.club_keys @> array\[\$3\]::text\[\] and t\.category = \$4 and t\.status = \$5/)
  assert.match(sql, /order by t\.transaction_date desc, t\.transaction_id desc limit \$6 offset \$7$/)
  assert.doesNotMatch(sql, /analytics\.|research\.|ingest\./)
  assert.deepEqual(buildTransactionQuery(parseTransactionParams({})).params, [TX_PAGE_SIZE + 1, 0])
  assert.match(buildTransactionQuery(parseTransactionParams({})).sql, /from rm_transactions t\s+order by/, 'no filter: no where clause on the ledger')
})

test('search text is prefix tokens, capped; pager links keep the filters', () => {
  assert.equal(searchQueryText('smith john'), 'smith:* & john:*')
  assert.equal(searchQueryText(null), null)
  assert.equal(searchQueryText('a b c d e f g h').split(' & ').length, 6)
  const f = parseTransactionParams({ q: 'smith', club: 'TEX', type: 'waiver' })
  assert.equal(transactionHref(f, 2), '/transactions?q=smith&club=TEX&type=WAIVER&page=2')
  assert.equal(transactionHref(parseTransactionParams({}), 1), '/transactions')
})

test('VERIFIED_COMPLETE is claimed only with an active verification date and no gap; nothing else may look complete', () => {
  assert.equal(statusView('VERIFIED_COMPLETE', '2030-07-01', []).tone, 'complete')
  assert.equal(statusView('VERIFIED_COMPLETE', null, []).tone, 'partial', 'no verification date: not complete')
  assert.equal(statusView('VERIFIED_COMPLETE', '2030-07-01', ['PENDING_PTBNL']).tone, 'partial', 'a listed gap: not complete')
  assert.equal(statusView('PARTIAL', '2030-07-01', []).tone, 'partial')
  assert.equal(statusView('UNVERIFIED', null, []).tone, 'unverified')
  for (const s of ['PARTIAL', 'UNVERIFIED', 'SOMETHING_ELSE']) for (const v of [statusView(s, '2030-07-01', []), statusView(s, null, [])]) { assert.notEqual(v.label, 'Verified complete'); assert.notEqual(v.tone, 'complete'); assert.doesNotMatch(v.detail, /\bis verified complete\b|\bwas verified\b|checked every party/i) }
  assert.match(statusView('PARTIAL', null, []).detail, /not been verified complete/)
  assert.match(statusView('PARTIAL', null, []).detail, /does not mean|not that the record is complete/)
})

test('gaps are explained in words; unknown codes are shown, not hidden; imprecise dates are not made exact', () => {
  for (const code of Object.keys(GAP_LABELS)) assert.notEqual(gapLabel(code), code)
  assert.equal(gapLabel('SOMETHING_NEW'), 'SOMETHING_NEW')
  assert.equal(formatTransactionDate('2015-07-01', 'DAY'), '2015-07-01')
  assert.equal(formatTransactionDate('2015-07-01', 'MONTH'), '2015-07')
  assert.equal(formatTransactionDate('2015-07-01', 'YEAR'), '2015')
})

test('the pages exist, render dynamically, read only the public read model, and carry the attribution and the three-state explanation', () => {
  const files = ['app/transactions/page.tsx', 'app/transactions/[id]/page.tsx', 'app/transactions/coverage/page.tsx']
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    assert.match(src, /export const dynamic = 'force-dynamic'/, f)
    assert.doesNotMatch(src, /analytics\.\w|research\.\w|ingest\.\w|refresh_transaction_read_models/, f)
    assert.match(src, /Attribution/, `${f} renders the attribution`)
    assert.doesNotMatch(src, /winner:|grade:|score:|rank:|<th[^>]*>(Grade|Score|Winner|Rank)/i, `${f} names no winner, grade, score or rank`)
  }
  const q = fs.readFileSync(path.join(root, 'lib/queries.ts'), 'utf8').split('// Historical transactions (030)')[1]
  assert.doesNotMatch(q, /analytics\.\w|research\.\w|ingest\.\w/)
  for (const t of q.match(/from (rm_\w+|source_attribution_statements)/g)) assert.match(t, /rm_transaction|source_attribution_statements/)
  assert.match(fs.readFileSync(path.join(root, 'app/transactions/coverage/page.tsx'), 'utf8'), /A source may be displayed[\s\S]*verified complete[\s\S]*complete census/)
})

test('the attribution component shows the statement verbatim from the database rows it is given', () => {
  const src = fs.readFileSync(path.join(root, 'components/TransactionBits.tsx'), 'utf8')
  assert.match(src, /<strong>\{s\.statement\}<\/strong>/)
  assert.match(fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8'), /\.attribution \{[^}]*border: 2px solid/)
})
