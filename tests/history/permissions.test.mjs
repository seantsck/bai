// Source permission gates (scripts/history/lib/permissions.mjs, publication.mjs, the fetcher and the CLIs). No database
// and no network: every fetch here goes to a stub that counts calls, and the CLI refusals happen before any request.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, validateCatalog, checkUse, requireUse, requireBatchUse, requireHostedPublication, PermissionDenied, USES } from '../../scripts/history/lib/permissions.mjs'
import { stageFile, isLocalClient } from '../../scripts/research/lib/pipeline.mjs'
import { scanForRestricted } from '../../scripts/history/lib/publication.mjs'
import { createFetcher } from '../../scripts/history/lib/fetch.mjs'
import { normalizePhase } from '../../scripts/history/lib/mlb.mjs'
import { buildPhaseBatches } from '../../scripts/history/lib/build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = loadCatalog(root)
const NOW = new Date('2026-10-21T12:00:00Z')
const ok = (src, use, ctx = {}) => checkUse(catalog, src, use, { now: NOW, ...ctx }, { root }).ok

// A synthetic catalog: one source per state, so the rules are tested independently of today's decisions.
const grant = (state, extra = {}) => ({ state, basis: `fixture ${state}`, ...extra })
const fixtureSource = (id, uses, extra = {}) => ({
  id, hosts: [`${id}.example.test`], url_prefixes: [`https://${id}.example.test/`], source_key_prefixes: [`hist:${id}-`],
  license: { name: 'fixture' }, review: { reviewed_on: '2026-10-01', review_due: '2027-01-01' },
  uses: Object.fromEntries(USES.map((u) => [u, uses[u] ?? grant('PENDING')])), authorization: null, ...extra
})
const fixtureCatalog = (...sources) => ({ format: 'bai-history-sources/2', sources })

test('the real catalog is well formed and encodes the current decisions', () => {
  assert.deepEqual(validateCatalog(catalog), [])
  // MLB's draft feed: no new requests of any kind, no publication; only the cached pilot years may be processed locally.
  for (const use of ['fetch_targeted', 'fetch_bulk', 'publish_repository', 'publish_site']) assert.equal(ok('mlb-statsapi-draft', use, { year: 2005 }), false, use)
  for (const y of [1965, 1985, 2005]) assert.equal(ok('mlb-statsapi-draft', 'process_local', { year: y }), true)
  for (const y of [1966, 2006, 2010]) assert.equal(ok('mlb-statsapi-draft', 'process_local', { year: y }), false)
  assert.equal(ok('mlb-statsapi-draft', 'process_local', {}), false, 'a year-scoped grant needs a year')
  // Archived Baseball-Reference pages: no crawling, no publication.
  for (const use of ['fetch_targeted', 'fetch_bulk', 'publish_repository', 'publish_site']) assert.equal(ok('bref-draft-archive', use, { year: 2005 }), false, use)
  // Openly licensed sources.
  for (const use of USES) assert.equal(ok('chadwick-register', use), true, use)
  assert.equal(ok('wikipedia-draft-articles', 'fetch_bulk', { requests: 70 }), true)
  assert.equal(ok('wikipedia-draft-articles', 'fetch_bulk', { requests: 71 }), false, 'per-run request scope')
  // Source keys resolve to their governing source.
  assert.equal(ok('hist:mlb-statsapi-draft-2005-jr', 'publish_site', { year: 2005 }), false)
  assert.equal(ok('hist:chadwick-register-781c175', 'publish_site'), true)
  assert.equal(ok('hist:invented-source', 'process_local'), false, 'unknown sources are refused')
})

test('states: PENDING and PROHIBITED refuse, LIMITED enforces its scope, an overdue review refuses', () => {
  const c = fixtureCatalog(
    fixtureSource('pend', {}),
    fixtureSource('prohib', { fetch_bulk: grant('PROHIBITED') }),
    fixtureSource('lim', { process_local: grant('LIMITED', { scope: { years: [1985] } }), fetch_bulk: grant('LIMITED', { scope: { max_requests_per_run: 2 } }) }),
    fixtureSource('clear', Object.fromEntries(USES.map((u) => [u, grant('CLEARED')])), { review: { reviewed_on: '2026-01-01', review_due: '2026-06-01' } })
  )
  assert.deepEqual(validateCatalog(c), [])
  assert.match(checkUse(c, 'pend', 'fetch_bulk', { now: NOW }).reason, /decision is pending/)
  assert.match(checkUse(c, 'prohib', 'fetch_bulk', { now: NOW }).reason, /prohibited/)
  assert.equal(checkUse(c, 'lim', 'process_local', { year: 1985, now: NOW }).ok, true)
  assert.match(checkUse(c, 'lim', 'process_local', { year: 1986, now: NOW }).reason, /outside the scope/)
  assert.equal(checkUse(c, 'lim', 'fetch_bulk', { requests: 2, now: NOW }).ok, true)
  assert.match(checkUse(c, 'lim', 'fetch_bulk', { requests: 3, now: NOW }).reason, /exceed/)
  // Review overdue: everything but processing an openly licensed source stops until a person reviews it again.
  assert.match(checkUse(c, 'clear', 'fetch_bulk', { now: NOW }).reason, /review was due/)
  assert.match(checkUse(c, 'clear', 'publish_site', { now: NOW }).reason, /review was due/)
  assert.equal(checkUse(c, 'clear', 'process_local', { now: NOW }).ok, true)
  assert.throws(() => requireUse(c, 'pend', 'publish_site', { now: NOW }), PermissionDenied)
  // Malformed grants are rejected when the catalog loads.
  const bad = fixtureCatalog(fixtureSource('x', { fetch_bulk: { state: 'LIMITED', basis: 'no scope' }, publish_site: { state: 'MAYBE', basis: 'b' } }))
  assert.deepEqual(validateCatalog(bad).sort(), ['x.fetch_bulk: LIMITED needs a scope', 'x.publish_site: unknown state MAYBE'])
})

test('AUTHORIZED needs a documented, current authorization covering the use and scope', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-auth-'))
  fs.writeFileSync(path.join(dir, 'letter.txt'), 'fixture authorization letter')
  const sha = crypto.createHash('sha256').update('fixture authorization letter').digest('hex')
  const auth = { reference: 'FIX-1', granted_by: 'Fixture Rights Holder', granted_on: '2026-10-01', expires_on: '2027-10-01', uses: ['fetch_bulk'], scope: { years: [2005, 2006] }, document: 'letter.txt', document_sha256: sha }
  const cat = (a) => fixtureCatalog(fixtureSource('auth', { fetch_bulk: grant('AUTHORIZED'), publish_site: grant('AUTHORIZED') }, { authorization: a }))
  const check = (a, use, ctx) => checkUse(cat(a), 'auth', use, { now: NOW, ...ctx }, { root: dir })
  assert.equal(check(auth, 'fetch_bulk', { year: 2006 }).ok, true)
  assert.match(check(null, 'fetch_bulk', { year: 2006 }).reason, /no authorization is on file/)
  assert.match(check(auth, 'publish_site', { year: 2006 }).reason, /does not cover publish_site/, 'download permission never implies publication')
  assert.match(check(auth, 'fetch_bulk', { year: 2007 }).reason, /outside the scope/)
  assert.match(check({ ...auth, expires_on: '2026-10-20' }, 'fetch_bulk', { year: 2006 }).reason, /expired/)
  assert.match(check({ ...auth, granted_on: '2026-11-01' }, 'fetch_bulk', { year: 2006 }).reason, /starts on/)
  assert.match(check({ ...auth, document: 'missing.pdf' }, 'fetch_bulk', { year: 2006 }).reason, /missing/)
  assert.match(check({ ...auth, document: '../outside.txt' }, 'fetch_bulk', { year: 2006 }).reason, /missing/)
  assert.match(check({ ...auth, document_sha256: '0'.repeat(64) }, 'fetch_bulk', { year: 2006 }).reason, /does not match its checksum/)
  assert.match(check({ ...auth, granted_by: '' }, 'fetch_bulk', { year: 2006 }).reason, /no granted_by/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('fetcher: an allowlisted host is not a permission; refusals happen before any request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-gate-'))
  const c = fixtureCatalog(
    fixtureSource('pend', { process_local: grant('LIMITED', { scope: { years: [1985] } }) }),
    fixtureSource('open', Object.fromEntries(USES.map((u) => [u, grant('CLEARED')])))
  )
  let calls = 0
  const fetchImpl = async () => { calls++; return new Response('{"fixture":1}', { status: 200 }) }
  const f = createFetcher({ root: dir, catalog: c, minIntervalMs: 0, userAgent: 'test', fetchImpl, now: () => NOW })
  await assert.rejects(f.get('p/1985.json', 'https://pend.example.test/1985', { source: 'pend', use: 'fetch_bulk', scope: { year: 1985 } }), PermissionDenied)
  await assert.rejects(f.get('p/1985.json', 'https://pend.example.test/1985', { source: 'pend', use: 'fetch_targeted', scope: { year: 1985 } }), PermissionDenied)
  await assert.rejects(f.get('p/x.json', 'https://pend.example.test/x', { source: 'open', use: 'fetch_bulk' }), /does not belong to source open/, 'a cleared source cannot vouch for another host')
  await assert.rejects(f.get('p/y.json', 'https://open.example.test.evil/', { source: 'open', use: 'fetch_bulk' }), /does not belong/)
  await assert.rejects(f.get('p/z.json', 'https://open.example.test/z', { source: 'open' }), /must declare its use/)
  await assert.rejects(f.get('p/z.json', 'https://open.example.test/z', { source: 'nobody', use: 'fetch_bulk' }), /not a catalogued source/)
  assert.equal(calls, 0)
  assert.equal((await f.get('o/1.json', 'https://open.example.test/1', { source: 'open', use: 'fetch_bulk' })).cached, false)
  assert.equal(calls, 1)
  // A restricted file already in the cache (here planted with a valid manifest entry) is readable only inside its scope.
  const body = Buffer.from('{"fixture":"restricted"}')
  fs.mkdirSync(path.join(dir, '.cache/history/p'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.cache/history/p/1986.json'), body)
  fs.writeFileSync(path.join(dir, '.cache/history/p/1985.json'), body)
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'research/history/manifest.json'), 'utf8'))
  for (const y of [1985, 1986]) man.entries[`p/${y}.json`] = { url: `https://pend.example.test/${y}`, source_key: 'pend', bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), retrieved_at: NOW.toISOString() }
  fs.writeFileSync(path.join(dir, 'research/history/manifest.json'), JSON.stringify(man))
  const g = createFetcher({ root: dir, catalog: c, offline: true, userAgent: 'test', fetchImpl, now: () => NOW })
  assert.equal((await g.get('p/1985.json', 'https://pend.example.test/1985', { source: 'pend', use: 'fetch_bulk', scope: { year: 1985 } })).cached, true)
  await assert.rejects(g.get('p/1986.json', 'https://pend.example.test/1986', { source: 'pend', use: 'fetch_bulk', scope: { year: 1986 } }), /process_local refused: year 1986 is outside the scope/)
  assert.equal(calls, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

// Fictional picks; the batch cites MLB's feed key and an archive evidence key exactly as the importer writes them.
function fixtureBatch () {
  const picks = normalizePhase({ drafts: { rounds: [{ picks: [1, 2].map((n) => ({ pickRound: '1', pickNumber: n, roundPickNumber: n, year: '2005', isDrafted: true, draftType: { code: 'JR' },
    team: { id: 119 }, person: { id: 9870200 + n, fullName: `Fixture Gate ${n}` } })) }] } }, { year: 2005, code: 'JR' }).picks
  return buildPhaseBatches(picks, {
    year: 2005, code: 'JR', phase: { label: 'June regular phase' }, organizations: [{ franchise_key: 'LAD', mlb_team_id: 119 }], crosswalk: new Map(), commit: '781c175e748b8',
    mlbEntry: { url: 'https://statsapi.mlb.com/api/v1/draft/2005?draftType=JR', retrieved_at: '2026-10-21T00:00:00Z', sha256: 'x' }, chadwickRetrieved: '2026-10-21',
    evidence: { LAD: { agrees: true, count: 2, note: 'fixture', source: { source_key: 'hist:bref-archive-2005-jr-lad', url: 'https://web.archive.org/web/1id_/x', retrieved_date: '2026-10-21', capture: '1' } } }
  }).batches[0].doc
}

test('batches: restricted sources cannot be published to the site; evidence used for a claim is cited and gated', () => {
  const doc = fixtureBatch()
  assert.deepEqual(doc.sources.map((s) => s.source_key), ['hist:mlb-statsapi-draft-2005-jr', 'hist:bref-archive-2005-jr-lad'])
  assert.throws(() => requireBatchUse(catalog, doc, 'publish_site', { now: NOW }, { root }), (e) => e instanceof PermissionDenied && e.source === 'mlb-statsapi-draft')
  assert.throws(() => requireBatchUse(catalog, { ...doc, sources: doc.sources.slice(1) }, 'publish_site', { now: NOW }, { root }), /bref-draft-archive: publish_site refused/)
  assert.deepEqual(requireBatchUse(catalog, doc, 'process_local', { now: NOW }, { root }).governed.length, 2, 'pilot year: local processing is allowed')
  assert.throws(() => requireBatchUse(catalog, { ...doc, coverage_claims: [{ scope_key: '2006-JUNE_AMATEUR' }] }, 'process_local', { now: NOW }, { root }), /year 2006 is outside the scope/)
  // Batches that predate the catalog (targeted research, research/imports) cite no governed key: the gate leaves them to
  // the research pipeline's rules, and lists them for the licensing review instead (docs/history/hosted-provenance.md).
  for (const f of fs.readdirSync(path.join(root, 'research/imports')).filter((x) => x.endsWith('.json'))) {
    const r = requireBatchUse(catalog, JSON.parse(fs.readFileSync(path.join(root, 'research/imports', f), 'utf8')), 'publish_site', { now: NOW }, { root })
    assert.equal(r.governed.length, 0, f)
  }
})

test('hosted publication: no new MLB or Baseball-Reference records; aliases, unknown keys and borrowed labels cannot bypass the gate', () => {
  const pub = (doc) => () => requireHostedPublication(catalog, doc, { now: NOW }, { root })
  const rec = (draftKey) => ({ type: 'DRAFT_SELECTION', draft_key: draftKey, source_key: 'x' })
  const doc = (sources, draftKey = '2006-JUNE_AMATEUR', claims = []) => ({ sources, coverage_claims: claims, records: [rec(draftKey)] })
  // MLB and Baseball-Reference: no new publication in any year (existing hosted records are preserved, not republished).
  for (const y of ['2006', '2016', '2026']) {
    assert.throws(pub(doc([{ source_key: 'mlb-feed', url: `https://statsapi.mlb.com/api/v1/draft/${y}` }], `${y}-JUNE_AMATEUR`)), /mlb-statsapi-draft: publish_site refused: a decision is pending/, y)
  }
  // Governed by URL whatever the key: aliases, MLB.com editorial pages and archive captures of Baseball-Reference.
  assert.throws(pub(doc([{ source_key: 'lad2016:slots', url: 'https://www.mlb.com/news/2016-draft-pick-values' }], '2016-JUNE_AMATEUR')), /mlb-statsapi-draft/)
  assert.throws(pub(doc([{ source_key: 'bref:2016', url: 'https://web.archive.org/web/2019id_/https://www.baseball-reference.com/draft/x' }], '2016-JUNE_AMATEUR')), /bref-draft-archive: publish_site refused/)
  // Case and whitespace variants of a governed key resolve to the same source.
  assert.throws(pub(doc([{ source_key: ' HIST:MLB-STATSAPI-DRAFT-2006-JR ' }])), /mlb-statsapi-draft/)
  // Unknown keys fail closed: an invented hist: key, and any uncatalogued source in any year.
  assert.throws(pub(doc([{ source_key: 'hist:new-source-2006' }])), /hist: source key the catalog does not govern/)
  assert.throws(pub(doc([{ source_key: 'news:2016', url: 'https://example.test/2016' }], '2016-JUNE_AMATEUR')), /not in the source catalog/)
  assert.throws(pub({ sources: [], records: [rec('2016-JUNE_AMATEUR')] }), /no declared sources/)
  // A borrowed label cannot carry another source's data: every catalog entry matching by key OR by URL must permit it.
  assert.throws(pub(doc([{ source_key: 'bai-reference:x', source_type: 'BAI_REFERENCE', url: 'https://statsapi.mlb.com/api/v1/teams' }], '2016-JUNE_AMATEUR')), /mlb-statsapi-draft/)
  assert.throws(pub(doc([{ source_key: 'verify:x', source_type: 'OFFICIAL_LEAGUE' }], '2016-JUNE_AMATEUR')), /not in the source catalog/, 'verify: keys only for declared test fixtures')
  assert.throws(pub(doc([{ source_key: 'verify:x', source_type: 'TEST_FIXTURE', url: 'https://statsapi.mlb.com/api/v1/draft/2016' }], '2016-JUNE_AMATEUR')), /mlb-statsapi-draft/)
  // Openly licensed and BAI's own sources pass under their documented scope (historical years are still locked per
  // database by 025); fictional verification fixtures pass for hosted:verify's rolled-back transactions.
  assert.deepEqual(pub(doc([{ source_key: 'hist:chadwick-register-781c175' }, { source_key: 'hist:wikipedia-2006-rev1' }]))(), { years: [2006], historical: true })
  assert.equal(pub(doc([{ source_key: 'bai-reference:calendar-2027', source_type: 'BAI_REFERENCE' }], '2027-JUNE_AMATEUR'))().historical, false)
  assert.equal(pub(doc([{ source_key: 'verify:official', source_type: 'TEST_FIXTURE' }], '2017-JUNE_AMATEUR'))().historical, false)
  // Every batch already in the repository (whose records are on hosted) would be refused as a NEW publication today.
  for (const f of fs.readdirSync(path.join(root, 'research/imports')).filter((x) => x.endsWith('.json'))) {
    assert.throws(pub(JSON.parse(fs.readFileSync(path.join(root, 'research/imports', f), 'utf8'))), PermissionDenied, f)
  }
})

test('pipeline: staging on a non-local database applies the gate before any write (runbooks included)', async () => {
  assert.equal(isLocalClient({ host: '127.0.0.1' }), true)
  assert.equal(isLocalClient({ host: '/var/run/postgresql' }), true)
  assert.equal(isLocalClient({ host: 'db.abcdefghijklmnopqrst.supabase.co' }), false)
  assert.equal(isLocalClient({}), false, 'unknown host: treated as hosted')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-stage-'))
  const file = path.join(dir, 'b.json')
  const rec = { type: 'DRAFT_SELECTION', source_key: 'alias:mlb', draft_key: '2006-JUNE_AMATEUR', round_code: '1', overall_pick: 1, round_pick: 1, organization: 'LAD',
    player: { full_name: 'Fixture Gate', external_ids: { MLBAM: '9870301' } }, signing: { status: 'UNKNOWN' } }
  fs.writeFileSync(file, JSON.stringify({ format: 'bai-research-import/1', batch_key: 'gate-fixture', channel: 'DRAFT',
    sources: [{ source_key: 'alias:mlb', source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: 'Fixture alias', url: 'https://statsapi.mlb.com/api/v1/draft/2006', retrieved_date: '2026-10-21' }], records: [rec] }))
  const queries = []
  const fake = { host: 'db.abcdefghijklmnopqrst.supabase.co', query: async (sql) => { queries.push(sql); return { rows: [], rowCount: 0 } } }
  await assert.rejects(stageFile(fake, file, { organization: 'LAD' }), PermissionDenied)
  assert.ok(queries.every((q) => /^\s*select/i.test(q)), `only reads before the refusal: ${queries.join(' | ')}`)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('publication check: restricted paths, restricted source keys and invented keys fail; the repository passes', () => {
  const doc = JSON.stringify(fixtureBatch())
  const scan = (files) => scanForRestricted(files, catalog, { root, now: NOW }).findings.map((f) => `${f.kind} ${f.path}`)
  assert.deepEqual(scan([{ path: 'research/history/batches/2005/x.json', text: '{}' }]), ['RESTRICTED_PATH research/history/batches/2005/x.json'])
  assert.deepEqual(scan([{ path: '.restricted/history/plan.json', text: '{}' }]), ['RESTRICTED_PATH .restricted/history/plan.json'])
  assert.deepEqual(scan([{ path: 'research/imports/hist-2005.json', text: doc }]), ['RESTRICTED_SOURCE research/imports/hist-2005.json', 'RESTRICTED_SOURCE research/imports/hist-2005.json'])
  assert.deepEqual(scan([{ path: 'docs/x.json', text: '{"source_key": "hist:made-up-2005"}' }]), ['UNKNOWN_HIST_KEY docs/x.json'])
  assert.deepEqual(scan([{ path: 'docs/ids.json', text: '{"source_key": "hist:chadwick-register-781c175"}' }]), [])
  assert.deepEqual(scan([{ path: 'research/history/reports/2006-notes.md', text: 'anything' }]), ['UNREVIEWED_HISTORY_FILE research/history/reports/2006-notes.md'])
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((p) => p && fs.statSync(path.join(root, p), { throwIfNoEntry: false })?.isFile())
  assert.deepEqual(scan(tracked.map((p) => ({ path: p, text: fs.readFileSync(path.join(root, p), 'utf8') }))), [])
})

test('CLI: restricted downloads (history importer and research downloaders) are refused (exit 4) before any request', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-cli-'))
  const run = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts/history/cli.mjs'), ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, BAI_HISTORY_OUT: out, BAI_DATABASE_URL: 'postgresql://127.0.0.1:1/none' } })
  for (const args of [['fetch-draft', '--years', '2006', '--max-requests', '0'], ['fetch-evidence', '--year', '2006', '--max-requests', '0']]) {
    const r = run(...args)
    assert.equal(r.status, 4, `${args.join(' ')}: ${r.stderr}`)
    assert.match(r.stderr, /permission refused: (mlb-statsapi-draft|bref-draft-archive)/)
  }
  // The research program's own downloaders are gated the same way.
  for (const [script, args] of [['fetch-mlb-player-outcomes.mjs', ['--ids', '1', '--out', path.join(out, 'mlb')]], ['fetch-bref-player-pages.mjs', ['--ids', 'fixtu01', '--before', '20260101', '--out', path.join(out, 'bref')]]]) {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/research/sources', script), ...args], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 4, `${script}: ${r.stderr}`)
    assert.equal(fs.existsSync(args.at(-1)), false, 'nothing written')
  }
  fs.rmSync(out, { recursive: true, force: true })
})
