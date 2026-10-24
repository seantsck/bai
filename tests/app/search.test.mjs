import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseExplorerParams, buildExplorerQuery, explorerHref, normalizeName, PAGE_SIZE, MAX_PAGE } from '../../lib/search.ts'

test('explorer filters are whitelisted or parsed; anything else is dropped', () => {
  const f = parseExplorerParams({ q: "  José O'Brien-Núñez ", org: 'lad', year: '1985', kind: 'january_regular', round: 'c-1', school: 'Arizona St.', signing: 'unknown', page: '3' })
  assert.deepEqual(f, { q: 'jose o brien nunez', org: 'LAD', year: 1985, from: null, to: null, kind: 'JANUARY_REGULAR', round: 'C-1', school: 'arizona st', schoolType: null, signing: 'UNKNOWN', page: 3 })
  const bad = parseExplorerParams({ org: "LAD'; drop table players;--", year: '1850', kind: 'ROUND_ROBIN', round: '1; select', signing: 'MAYBE', page: '-4', schoolType: 'PRISON' })
  assert.deepEqual([bad.org, bad.year, bad.kind, bad.round, bad.signing, bad.page, bad.schoolType], [null, null, null, null, null, 1, null])
  assert.equal(parseExplorerParams({ page: '99999' }).page, MAX_PAGE)
})

test('the query is fixed SQL with every value as a parameter; pages fetch one extra row', () => {
  const f = parseExplorerParams({ q: "o'neil%_", org: 'NYY', from: '1965', to: '1975', signing: 'SIGNED', page: '2' })
  const { sql, params } = buildExplorerQuery(f)
  assert.doesNotMatch(sql, /neil|NYY|1965|SIGNED/)
  assert.deepEqual(params, ['o neil%', 'NYY', 1965, 1975, 'SIGNED', PAGE_SIZE + 1, PAGE_SIZE])
  assert.match(sql, /from v_draft_explorer where name_normalized like \$1 and franchise_key = \$2 and draft_year >= \$3 and draft_year <= \$4 and signing_status = \$5/)
  assert.match(sql, /limit \$6 offset \$7$/)
  assert.deepEqual(buildExplorerQuery(parseExplorerParams({ year: '2005', from: '1990' })).params, [2005, PAGE_SIZE + 1, 0], 'a single year overrides a range')
})

test('pager links keep the filters', () => {
  const f = parseExplorerParams({ q: 'smith', org: 'TEX', kind: 'JUNE_AMATEUR' })
  assert.equal(explorerHref(f, 2, { q: 'Smith' }), '/draft/explorer?q=Smith&org=TEX&kind=JUNE_AMATEUR&page=2')
  assert.equal(explorerHref(parseExplorerParams({}), 1), '/draft/explorer')
})

test('normalizeName mirrors public.normalize_name on representative names', () => {
  assert.equal(normalizeName('Gaby Sánchez'), 'gaby sanchez')
  assert.equal(normalizeName('  B.J.  Surhoff '), 'b j surhoff')
  assert.equal(normalizeName('!!!'), null)
})

test('the round filter accepts the prospect promotion incentive code', () => {
  assert.equal(parseExplorerParams({ round: 'ppi' }).round, 'PPI')
  assert.equal(parseExplorerParams({ round: 'PPI-1' }).round, null)
})
