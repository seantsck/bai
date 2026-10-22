// Wikidata publication basis (migration 027's catalog side): only a source that carries the Wikidata identity is recognised;
// restricted sources, look-alikes, borrowed keys and missing citations are refused. No database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, validateCatalog, matchesIdentity, governingSources, requireHostedPublication, requireBatchUse, PermissionDenied } from '../../scripts/history/lib/permissions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = loadCatalog(root)
const wd = catalog.sources.find((s) => s.id === 'wikidata')
const GOOD = { source_key: 'hist:wikidata-2020-identity', source_type: 'REFERENCE_DATABASE', publisher: 'Wikimedia Foundation (Wikidata contributors)', url: 'https://www.wikidata.org/' }
const doc = (sources) => ({ sources, coverage_claims: [{ scope_key: '2020-JUNE_AMATEUR' }] })
const refused = (sources, re) => assert.throws(() => requireHostedPublication(catalog, doc(sources), {}, { root }), (e) => e instanceof PermissionDenied && re.test(e.message))

test('the catalog reviews Wikidata as CC0 and declares its identity', () => {
  assert.deepEqual(validateCatalog(catalog), [])
  assert.equal(wd.uses.publish_site.state, 'CLEARED')
  assert.match(wd.license.name, /CC0/)
  assert.deepEqual(wd.identity.hosts, ['www.wikidata.org', 'query.wikidata.org'])
  assert.equal(wd.required_source_type, 'REFERENCE_DATABASE')
  assert.match(wd.uses.publish_site.basis, /migration 027/i)
})

test('a catalog identity must be complete', () => {
  const broken = { ...catalog, sources: catalog.sources.map((s) => (s.id === 'wikidata' ? { ...s, identity: { hosts: ['www.wikidata.org'] } } : s)) }
  assert.match(validateCatalog(broken).join(';'), /identity needs hosts or url_prefixes, a publisher, source_type and key_pattern/)
})

test('identity needs host, publisher, type and key together', () => {
  assert.equal(matchesIdentity(wd.identity, GOOD), true)
  assert.equal(matchesIdentity(wd.identity, { ...GOOD, url: 'https://query.wikidata.org/sparql?query=x' }), true)
  for (const bad of [{ url: 'https://www.wikidata.org.evil.example/' }, { url: `https://www.wikidata.org${'@'}evil.example/` }, { url: 'http://www.wikidata.org/' }, { url: 'https://evil.example/www.wikidata.org/' },
    { url: 'https://www.wikidata.orgx/' }, { url: 'https://www.wikidata.org/ x' }, { url: null }, { publisher: 'Someone Else' }, { publisher: undefined }, { source_type: 'NEWS_REPORT' },
    { source_key: 'hist:wikidata-' }, { source_key: 'hist:wikidata-UPPER' }, { source_key: 'wikidata:2020' }, { source_key: 'hist:wikipedia-2020' }]) {
    assert.equal(matchesIdentity(wd.identity, { ...GOOD, ...bad }), false, JSON.stringify(bad))
  }
})

test('a genuine Wikidata source passes the hosted gate; look-alikes, borrowed keys and URL-only claims do not', () => {
  assert.deepEqual(requireHostedPublication(catalog, doc([GOOD]), {}, { root }).years, [2020])
  refused([{ ...GOOD, url: 'https://www.wikidata.org.evil.example/' }], /does not carry its identity/)
  refused([{ ...GOOD, publisher: 'Someone Else' }], /does not carry its identity/)
  refused([{ ...GOOD, source_type: 'NEWS_REPORT' }], /does not carry its identity|claims to be/)
  // A Wikidata key on an MLB URL: refused as MLB and as a false Wikidata claim.
  refused([{ ...GOOD, url: 'https://statsapi.mlb.com/api/v1/draft/2020' }], /does not carry its identity|mlb-statsapi-draft/)
  // A Wikidata URL under another key: governed by the Wikidata entry by host, which requires the identity.
  refused([{ ...GOOD, source_key: 'hist:other-2020' }], /does not carry its identity|not in the source catalog/)
  refused([{ ...GOOD, source_key: 'wikidata-2020' }], /does not carry its identity|not in the source catalog/)
})

test('restricted sources stay refused, with or without Wikidata beside them', () => {
  const mlb = { source_key: 'hist:mlb-statsapi-draft-2020-jr', source_type: 'OFFICIAL_LEAGUE', publisher: 'MLB Advanced Media', url: 'https://statsapi.mlb.com/api/v1/draft/2020' }
  const bref = { source_key: 'hist:bref-2020', source_type: 'REFERENCE_DATABASE', publisher: 'Sports Reference LLC', url: 'https://www.baseball-reference.com/draft/x' }
  refused([GOOD, mlb], /mlb-statsapi-draft|publish_site refused/)
  refused([GOOD, bref], /publish_site refused|not in the source catalog/)
  // A label borrowed from a free source, pointing at a restricted host, is governed by the host.
  refused([{ ...mlb, source_key: 'hist:chadwick-register-fake' }], /publish_site refused|mlb-statsapi-draft|claims to be/)
})

test('missing citations: a batch with no sources, or an unknown hist: key, cannot reach hosted', () => {
  assert.throws(() => requireHostedPublication(catalog, { sources: [], coverage_claims: [] }, {}, { root }), /no declared sources/)
  refused([{ source_key: 'hist:wikidata-', source_type: 'REFERENCE_DATABASE', publisher: GOOD.publisher, url: GOOD.url }], /does not carry its identity/)
  refused([{ source_key: 'hist:made-up-2020', source_type: 'REFERENCE_DATABASE', url: 'https://example.test/' }], /does not govern|not in the source catalog/)
})

test('local processing applies the same identity check, and the historical lock is untouched', () => {
  assert.throws(() => requireBatchUse(catalog, doc([{ ...GOOD, url: 'https://evil.example/' }]), 'process_local', {}, { root }), /does not carry its identity/)
  const historical = { sources: [GOOD], coverage_claims: [{ scope_key: '1985-JUNE_AMATEUR' }] }
  // A 1985 batch still needs every cited source catalogued and granting publish_site (here only Wikidata): the rule is unchanged,
  // and the database's own year lock (025) is separate and untouched by 027.
  assert.equal(requireHostedPublication(catalog, historical, {}, { root }).historical, true)
  const { misidentified } = governingSources(catalog, { ...GOOD, url: 'https://evil.example/' })
  assert.deepEqual(misidentified, ['wikidata'])
})

test('the pipeline refuses forged Chadwick and Wikipedia identities independently of the database', () => {
  const CW = { source_key: 'hist:chadwick-register-781c175', source_type: 'REFERENCE_DATABASE', publisher: 'Chadwick Baseball Bureau', url: 'https://github.com/chadwickbureau/register/tree/781c175e748b89e5730fd3f5de0086b9355b2f92' }
  const WP = { source_key: 'hist:wikipedia-2020-june-amateur-r1', source_type: 'REFERENCE_DATABASE', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=2020_Major_League_Baseball_draft&oldid=1' }
  assert.deepEqual(requireHostedPublication(catalog, doc([CW, WP]), {}, { root }).years, [2020])
  const forgeries = [
    [{ ...CW, url: 'https://github.com/someone-else/register' }, /does not carry its identity|claims to be/],
    [{ ...CW, url: 'https://github.com.evil.example/chadwickbureau/register' }, /does not carry its identity|claims to be/],
    [{ ...CW, publisher: 'Someone Else' }, /does not carry its identity/],
    [{ ...CW, source_type: 'NEWS_REPORT' }, /does not carry its identity|claims to be/],
    [{ ...CW, source_key: 'hist:chadwick-register-ZZZ' }, /does not carry its identity|does not govern/],
    [{ ...CW, url: 'https://statsapi.mlb.com/api/v1/draft/2020' }, /does not carry its identity|mlb-statsapi-draft/],
    [{ ...WP, url: 'https://de.wikipedia.org/wiki/X' }, /does not carry its identity/],
    [{ ...WP, url: 'https://en.wikipedia.org.evil.example/x' }, /does not carry its identity|claims to be/],
    [{ ...WP, publisher: 'MLB Advanced Media' }, /does not carry its identity/],
    [{ ...WP, source_type: 'NEWS_REPORT' }, /does not carry its identity/],
    [{ ...WP, url: 'https://www.mlb.com/news/x' }, /does not carry its identity|mlb-statsapi-draft/]
  ]
  for (const [bad, re] of forgeries) refused([bad], re)
  // The same forgeries are refused for local processing of a batch (identity is checked before any use).
  assert.throws(() => requireBatchUse(catalog, doc([{ ...CW, publisher: 'Someone Else' }]), 'process_local', {}, { root }), /does not carry its identity/)
})
