// Draft-release compatibility across migrations: the same fictional release verifies, previews and applies identically on a
// database at migration 027 and on one at 028, and the release tooling's migration guard accepts both. FICTIONAL data only.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as h from './harness.mjs'
import { loadCatalog } from '../../scripts/history/lib/permissions.mjs'
import { buildManifest, observationMax, observationLimit, HISTORICAL_OBSERVATION_ALLOWANCES, loadRelease, verifyReleaseContent, collisionReport, applyRelease, canonicalJson, manifestChecksum, fileSha256 } from '../../scripts/history/lib/release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const catalog = loadCatalog(root)
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { migrationProblems } from '../../scripts/history/lib/release.mjs'

let db27, db28
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-release-compat-'))
before(async () => {
  await h.startServer()
  db27 = await h.freshDatabase({ migrate: false }); await applyMigrations(db27, { through: '027' })
  db28 = await h.freshDatabase()
}, { timeout: 120000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

const WIKI = 'hist:wikipedia-2020-fixture-r1'
const CW = 'hist:chadwick-register-abc1234'
const WD = 'hist:wikidata-2020-fixture'
const sources = (verified) => [
  { source_key: WIKI, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikipedia: fixture draft, revision 1', publisher: 'Wikimedia Foundation (contributors)', url: 'https://en.wikipedia.org/w/index.php?title=Fixture&oldid=1', retrieved_date: '2026-10-22' },
  ...(verified ? [{ source_key: CW, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Chadwick Baseball Bureau Register, fixture', publisher: 'Chadwick Baseball Bureau', url: 'https://github.com/chadwickbureau/register/tree/fixture', retrieved_date: '2026-10-22' },
    { source_key: WD, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Wikidata identity corroboration fixture', publisher: 'Wikimedia Foundation (Wikidata contributors)', url: 'https://www.wikidata.org/', retrieved_date: '2026-10-22' }] : [])
]
const record = (pick, org, name, { ids = null, birth = null, birthCountry = null, position = null, roundPick = null } = {}) => ({
  type: 'DRAFT_SELECTION', source_key: WIKI, draft_key: '2020-JUNE_AMATEUR', round_code: '1', overall_pick: pick, round_pick: roundPick, ...(position ? { position } : {}), organization: org, selection_type: 'STANDARD',
  player: { full_name: name, source_key: WIKI, ...(birth ? { birth_date: birth } : {}), ...(birthCountry ? { birth_country: birthCountry } : {}), ...(ids ? { external_ids: ids, external_id_sources: Object.fromEntries(Object.keys(ids).map((k) => [k, CW])) } : {}) },
  ...(ids ? { evidence: [{ subject: 'player', field: 'wikidata_item', value: 'Q1', source_key: WD }] } : {}),
  signing: { status: 'UNKNOWN' }, notes: 'fixture'
})
let tag = 0
const batch = (org, records, verified) => ({
  format: 'bai-research-import/1', batch_key: `hist-2020-june-amateur-${org.toLowerCase()}-fixture-${++tag}`, channel: 'DRAFT', description: `${org} fixture`,
  coverage_claims: [{ domain: 'DRAFT', scope_key: '2020-JUNE_AMATEUR', organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: WIKI, gap_notes: 'fixture: one list' }],
  sources: sources(verified), records
})
const writeRelease = (name, docs, { approvals = [], mutate = null, supplementOf = null, documentedSelections = null, excludedOrganizations = [] } = {}) => {
  const dir = path.join(tmp, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'batches'), { recursive: true })
  const batches = docs.map((doc, i) => { const file = `${String(i).padStart(2, '0')}-${doc.batch_key}.json`; fs.writeFileSync(path.join(dir, 'batches', file), JSON.stringify(doc, null, 1) + '\n'); return { file, sha256: fileSha256(path.join(dir, 'batches', file)), doc } })
  let manifest = buildManifest({ releaseKey: `fixture-${name}`, year: 2020, draftKey: '2020-JUNE_AMATEUR', batches, identity: { picks: [] }, article: { revision: 1, response_sha256: 'a'.repeat(64) }, chadwickCommit: 'f'.repeat(40),
    identityFileSha256: 'b'.repeat(64), brownVariant: 'HELD', heldPicks: [], humanApprovals: approvals, supplementOf, documentedSelections, excludedOrganizations, catalog, maxSelections: docs.reduce((n, d) => n + d.records.length, 0), createdOn: '2026-10-22' })
  if (mutate) { manifest = mutate(manifest); manifest.manifest_sha256 = manifestChecksum(manifest) }
  fs.writeFileSync(path.join(dir, 'release-manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  return dir
}

test('a release verifies, previews, applies and replays identically at migration 027 and 028', async () => {
  const dir = writeRelease('compat', [batch('KC', [record(21, 'KC', 'Fixture Compat One'), record(22, 'KC', 'Fixture Compat Two', { ids: { MLBAM: '910101' } })], true), batch('LAD', [record(23, 'LAD', 'Fixture Compat Three')], true)])
  const manifestBefore = fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8')
  const rel = loadRelease(dir)
  assert.deepEqual(verifyReleaseContent(rel, { root }), [])
  assert.equal(rel.manifest.required_migration, '027', 'the manifest still names 027')
  const results = []
  for (const db of [db27, db28]) {
    assert.deepEqual(await migrationProblems(db), [])
    const report = await collisionReport(db, rel)
    assert.equal(report.overall, 'SAFE')
    const out = await applyRelease(db, rel, { operator: 'Fixture Owner' })
    const again = await applyRelease(db, rel, { operator: 'Fixture Owner' })
    const rows = await h.one(db, `select (select count(*) from draft_selections)::int sel, (select count(*) from players)::int pl, (select count(*) from draft_signings)::int sg,
      (select count(*) from ingest.release_audits)::int audits, (select jsonb_array_length(entries) from ingest.release_audits where release_key = 'fixture-compat')::int entries`)
    results.push({ report: canonicalJson(report), counts: out.counts, already: [out.already, again.already], rows })
  }
  assert.deepEqual(results[1], results[0], 'identical on 027 and 028')
  assert.deepEqual(results[0].rows, { sel: results[0].rows.sel, pl: results[0].rows.pl, sg: results[0].rows.sg, audits: 1, entries: 3 })
  assert.equal(fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8'), manifestBefore, 'the manifest and its checksum are untouched')
  // 028 left the draft tables alone: nothing it added holds a row after a release
  for (const t of ['transaction_external_ids', 'transaction_sources', 'transaction_source_links', 'transaction_conflicts', 'ptbnl_resolutions', 'season_calendar_events']) {
    assert.equal(Number((await h.one(db28, `select count(*) n from ${t}`)).n), 0, t)
  }
})
