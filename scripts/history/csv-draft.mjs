// Staging CSV workflow for draft selections. No network and no AI: it reads a CSV and the cached Chadwick register, applies the rules in
// lib/csv-draft.mjs and writes a release directory that the ordinary release tools verify, preview, rehearse and apply.
//
//   node scripts/history/csv-draft.mjs template [--out file.csv]
//   node scripts/history/csv-draft.mjs check --csv file.csv --year 2024                (validation report only, writes nothing)
//   node scripts/history/csv-draft.mjs wikidata-map --csv file.csv --year 2024 --out map.json   (cached, polite Wikidata lookup by MLBAM id; CC0)
//   node scripts/history/csv-draft.mjs build --csv file.csv --year 2024 --release-dir .local/history/2024/release/csv --retrieved 2026-10-24
//                                         [--documented 614] [--approvals file.json] [--wikidata-map map.json]
//   then: node scripts/history/release.mjs verify|preview --release-dir <dir>      (permissions, collisions; apply needs a separate approval)
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadCatalog } from './lib/permissions.mjs'
import { SHARDS } from './lib/chadwick.mjs'
import { buildManifest, fileSha256, canonicalJson } from './lib/release.mjs'
import { CSV_COLUMNS, csvTemplate, readCsv, validateRow, buildCsvBatches, findDuplicates } from './lib/csv-draft.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0]
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const log = (m) => console.log(m)
const die = (m) => { console.error(`error: ${m}`); process.exit(2) }

if (command === 'template') {
  const out = opt('out')
  if (out) { fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true }); fs.writeFileSync(path.resolve(root, out), csvTemplate()); log(`wrote ${out}: ${CSV_COLUMNS.join(', ')}`) } else process.stdout.write(csvTemplate())
  process.exit(0)
}
if (!['check', 'build', 'wikidata-map'].includes(command)) die('usage: csv-draft.mjs template | check | wikidata-map | build (see the header of this file)')
const csvFile = opt('csv'); const year = Number(opt('year'))
if (!csvFile || !year) die('--csv and --year are required')
const text = fs.readFileSync(path.resolve(root, csvFile), 'utf8')
const csvSha = crypto.createHash('sha256').update(text).digest('hex')
const catalog = loadCatalog(root)
const { rows, problems } = readCsv(text)
if (problems.length) { for (const p of problems) log(`PROBLEM: ${p}`); process.exit(1) }
const heldRows = []; const clean = []
for (const r of rows) { const v = validateRow(r, { year, catalog, root }); if (v.errors.length) heldRows.push({ line: r.line, pick: r.overall_pick, name: r.player_name, org: null, reason: v.errors.join('; ') }); else clean.push(v.clean) }
log(`${rows.length} rows: ${clean.length} pass the row checks, ${heldRows.length} held`)
for (const h of heldRows) log(`  held line ${h.line} (#${h.pick} ${h.name}): ${h.reason}`)
if (command === 'check') process.exit(heldRows.length ? 1 : 0)
if (command === 'wikidata-map') {
  const out = opt('out'); if (!out) die('--out required')
  const { createFetcher } = await import('./lib/fetch.mjs'); const { userAgent } = await import('./lib/outbound.mjs'); const { mlbamQuery, queryUrl, queryKey } = await import('./lib/wikidata.mjs')
  const f = createFetcher({ root, catalog, maxRequests: 16, minIntervalMs: 1500, userAgent: userAgent('csv draft research'), log })
  const ids = [...new Set(clean.map((c) => c.mlbam).filter(Boolean))]
  const map = {}
  for (let i = 0; i < ids.length; i += 50) {
    const q = mlbamQuery(ids.slice(i, i + 50))
    const json = JSON.parse((await f.get(queryKey(q), queryUrl(q), { source: 'wikidata', use: 'fetch_bulk' })).buf.toString('utf8'))
    for (const b of json.results.bindings) {
      const mlbam = b.mlb.value; const qid = b.p.value.split('/').pop(); const birth = b.birth?.value?.slice(0, 10) ?? null
      if (map[mlbam] && map[mlbam].qid !== qid) map[mlbam] = { qid: null, ambiguous: true }   // two items for one id: never guessed
      else if (!map[mlbam]) map[mlbam] = { qid, birth: /^\d{4}-\d{2}-\d{2}$/.test(birth ?? '') ? birth : null }
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true }); fs.writeFileSync(path.resolve(root, out), JSON.stringify(map, null, 1) + '\n')
  log(`${Object.keys(map).length} of ${ids.length} MLBAM ids found on Wikidata; wrote ${out}`)
  process.exit(0)
}

const chadwickSrc = catalog.sources.find((s) => s.id === 'chadwick-register')
const commit7 = chadwickSrc.pinned_commit.slice(0, 7)
const shardDir = process.env.BAI_CHADWICK_DIR ?? path.join(root, '.cache/history/chadwick', commit7)
const shardTexts = SHARDS.map((s) => { const f = path.join(shardDir, `people-${s}.csv`); if (!fs.existsSync(f)) die(`the Chadwick register is not cached (${f}): fetch it once with the history tool`); return fs.readFileSync(f, 'utf8') })
const releaseDir = opt('release-dir'); if (!releaseDir) die('--release-dir required for build')
const retrieved = opt('retrieved'); if (!/^\d{4}-\d{2}-\d{2}$/.test(retrieved ?? '')) die('--retrieved YYYY-MM-DD required (the source retrieval date; never the build date)')
const wikidata = opt('wikidata-map') ? JSON.parse(fs.readFileSync(path.resolve(root, opt('wikidata-map')), 'utf8')) : {}
const built = buildCsvBatches({ rows: clean, year, chadwick: { commit7, commitFull: chadwickSrc.pinned_commit, shardTexts }, retrieved, csvSha256: csvSha, wikidata, duplicates: findDuplicates(rows) })
const held = [...heldRows.filter((h) => h.pick).map((h) => ({ pick: Number(h.pick), name: h.name, org: '??', reason: h.reason })), ...built.held].map((h) => ({ org: h.org, pick: h.pick, name: h.name, reason: h.reason }))
log('provenance: the cited sources are the supplier\'s claim; BAI did not read them')
log(`${built.batches.length} batches, ${built.batches.reduce((n, b) => n + b.doc.records.length, 0)} records, held ${held.length}`)
const abs = path.resolve(root, releaseDir)
const stage = `${abs}.building`; fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(path.join(stage, 'batches'), { recursive: true })
for (const b of built.batches) fs.writeFileSync(path.join(stage, 'batches', `${b.doc.batch_key}.json`), JSON.stringify(b.doc, null, 1) + '\n')
const batches = built.batches.map((b) => { const file = `${b.doc.batch_key}.json`; return { file, sha256: fileSha256(path.join(stage, 'batches', file)), doc: b.doc } })
const identity = { format: 'bai-csv-identity/1', year, csv_sha256: csvSha, chadwick_commit: chadwickSrc.pinned_commit, picks: built.picks }
const identityText = JSON.stringify(identity, null, 1) + '\n'
const total = batches.reduce((n, b) => n + b.doc.records.length, 0)
const approvals = opt('approvals') ? JSON.parse(fs.readFileSync(path.resolve(root, opt('approvals')), 'utf8')) : []
const manifest = buildManifest({
  releaseKey: `csv-${year}-june-amateur-${csvSha.slice(0, 8)}-n${total}`, year, draftKey: `${year}-JUNE_AMATEUR`, batches, identity,
  article: { revision: `csv:${csvSha.slice(0, 12)}`, response_sha256: csvSha }, chadwickCommit: chadwickSrc.pinned_commit, identityFileSha256: crypto.createHash('sha256').update(identityText).digest('hex'),
  brownVariant: 'NOT_IN_THIS_RELEASE', heldPicks: held, humanApprovals: approvals, catalog, maxSelections: total, documentedSelections: opt('documented') ? Number(opt('documented')) : null, createdOn: retrieved
})
const manifestText = JSON.stringify(manifest, null, 1) + '\n'
const manifestFile = path.join(abs, 'release-manifest.json')
if (fs.existsSync(manifestFile) && fs.readFileSync(manifestFile, 'utf8') !== manifestText) { fs.rmSync(stage, { recursive: true, force: true }); die(`${manifestFile} already exists with different content: a release manifest is immutable; build into a new --release-dir`) }
if (!fs.existsSync(manifestFile)) {
  fs.mkdirSync(abs, { recursive: true }); fs.rmSync(path.join(abs, 'batches'), { recursive: true, force: true })
  fs.renameSync(path.join(stage, 'batches'), path.join(abs, 'batches'))
  fs.writeFileSync(path.join(abs, 'build.json'), JSON.stringify({ year, csv_sha256: csvSha, provenance: 'SUPPLIED_UNVERIFIED', documented_selections: opt('documented') ? Number(opt('documented')) : null, held }, null, 1) + '\n')
  fs.writeFileSync(path.join(abs, 'identity.json'), identityText)
  fs.writeFileSync(path.join(abs, 'signing-proposals.json'), JSON.stringify(built.signingProposals, null, 1) + '\n')   // not part of the release: a separate reviewed path
  fs.writeFileSync(manifestFile, manifestText)
  fs.writeFileSync(path.join(abs, 'release-manifest.sha256'), `${manifest.manifest_sha256}  release-manifest.json\n`)
}
fs.rmSync(stage, { recursive: true, force: true })
if (built.signingProposals.length) log(`${built.signingProposals.length} row(s) state a signing status or bonus: kept in signing-proposals.json for a separate reviewed path; the release builds every selection with signing unknown`)
log(`${manifest.release_key}: ${total} selections, held ${held.length}; identity ${canonicalJson(manifest.totals.identity_tiers)}`)
log(`manifest sha256 ${manifest.manifest_sha256}`)
