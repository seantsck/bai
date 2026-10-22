// Wikidata reference queries: construction, escaping and parsing. Offline.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nameQuery, queryUrl, queryKey, parseNameResults, PROPS } from '../../scripts/history/lib/wikidata.mjs'

test('name queries escape literals and are bounded', () => {
  const q = nameQuery(['Pat "The Bat" O\'Neil', 'A\\B', 'Line\nBreak'])
  assert.ok(q.includes('"Pat \\"The Bat\\" O\'Neil"@en'))
  assert.ok(q.includes('"A\\\\B"@en'))
  assert.ok(!/Line\nBreak/.test(q))
  assert.throws(() => nameQuery([]), /1 to 50/)
  assert.throws(() => nameQuery(Array.from({ length: 51 }, (_, i) => `N${i}`)), /1 to 50/)
  assert.ok(q.includes(PROPS.MLB_ID) && q.includes(PROPS.DRAFTED_BY))
})

test('the cache key is stable per query and the URL is the public SPARQL endpoint', () => {
  const q = nameQuery(['A B'])
  assert.equal(queryKey(q), queryKey(nameQuery(['A B'])))
  assert.notEqual(queryKey(q), queryKey(nameQuery(['A C'])))
  assert.match(queryKey(q), /^wikidata\/sparql-[0-9a-f]{16}\.json$/)
  assert.ok(queryUrl(q).startsWith('https://query.wikidata.org/sparql?format=json&query='))
})

test('results group by person: several drafted-by statements stay together, ambiguity stays visible', () => {
  const b = (qid, extra = {}) => ({ label: { value: 'Jo Doe' }, p: { value: `http://www.wikidata.org/entity/${qid}` }, ...extra })
  const parsed = parseNameResults({ results: { bindings: [
    b('Q1', { mlb: { value: '1' }, birth: { value: '1999-02-03T00:00:00Z' }, dteamLabel: { value: 'Team A' }, dpick: { value: '11' }, dtime: { value: '2020-06-10T00:00:00Z' } }),
    b('Q1', { mlb: { value: '1' }, dteamLabel: { value: 'Team B' }, dpick: { value: '1014' } }),
    b('Q1', { mlb: { value: '1' }, dteamLabel: { value: 'Team B' }, dpick: { value: '1014' } }),
    b('Q2', { birth: { value: '1980-01-01T00:00:00Z' } })
  ] } })
  const people = parsed.get('Jo Doe')
  assert.equal(people.length, 2, 'two people with one label are both reported')
  assert.deepEqual(people[0], { qid: 'Q1', mlbam: '1', birth_date: '1999-02-03', bbref: null, retrosheet: null, drafted: [{ team: 'Team A', pick: '11', year: '2020' }, { team: 'Team B', pick: '1014', year: null }] })
  assert.equal(people[1].mlbam, null)
  assert.equal(parseNameResults({}).size, 0)
})
