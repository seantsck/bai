// Retrosheet transactions: cached, checksummed, resumable download; a draft index; a cross-check against the historical
// exception register. Retrosheet is evidence about the people it tracks, never the draft population, and its records
// are never resolved facts: the cross-check writes PROPOSED findings for a human reviewer.
//
//   node --env-file-if-exists=.env.local scripts/history/retrosheet.mjs fetch
//   node scripts/history/retrosheet.mjs index [--offline]        (draft index + per-year coverage, from the cached file)
//   node scripts/history/retrosheet.mjs crosscheck               (proposed findings against .restricted/history/exceptions.json)
//   node scripts/history/retrosheet.mjs coverage [--years 1965,2020]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, requireUse } from './lib/permissions.mjs'
import { createFetcher, PermissionDenied, BudgetExhausted } from './lib/fetch.mjs'
import { userAgent } from './lib/outbound.mjs'
import { SHARDS } from './lib/chadwick.mjs'
import { RETROSHEET_ATTRIBUTION, readZipEntry, parseDraftTransactions, coverageByYear, namesByRetrosheetId, compareNames } from './lib/retrosheet.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0]
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const flag = (k) => argv.includes(`--${k}`)
const catalog = loadCatalog(root)
const SRC = 'retrosheet-transactions'
const BASE = 'https://www.retrosheet.org/transactions/'
const ZIP_KEY = 'retrosheet/trandb.zip'
const INDEX_DIR = path.join(root, '.cache/history/retrosheet')
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.restricted/history')
const log = (m) => console.log(m)
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const fetcher = () => createFetcher({ root, catalog, offline: flag('offline'), maxRequests: Number(opt('max-requests', 6)), minIntervalMs: 2000, userAgent: userAgent('retrosheet transactions importer'), log })
const atomicWrite = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.part`, text); fs.renameSync(`${file}.part`, file) }

async function cachedZip () {
  const f = fetcher()
  const entry = f.manifest.entries[ZIP_KEY]
  if (!entry) throw new Error('Retrosheet file not cached: run fetch first')
  return { ...(await f.get(ZIP_KEY, entry.url, { source: SRC, use: 'fetch_bulk' })) }
}

/** The draft index, rebuilt only when the cached zip's checksum changed (so a re-run resumes instantly). */
async function draftIndex () {
  const { buf, entry } = await cachedZip()
  const file = path.join(INDEX_DIR, 'draft-index.json')
  if (fs.existsSync(file)) {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (cur.source_sha256 === entry.sha256) return cur
  }
  const text = readZipEntry(buf, 'tran.txt').toString('latin1')
  const parsed = parseDraftTransactions(text)
  const index = {
    format: 'bai-retrosheet-draft-index/1',
    attribution: RETROSHEET_ATTRIBUTION,
    note: 'Retrosheet lists the people it tracks (almost all reached the majors). It is not the draft population; a missing record is not evidence of anything.',
    source_sha256: entry.sha256, source_url: entry.url, retrieved_at: entry.retrieved_at,
    records: parsed.records, unknown_club_codes: parsed.unknownTeams, skipped_rows: parsed.skipped,
    coverage_by_year: coverageByYear(parsed.records)
  }
  atomicWrite(file, JSON.stringify(index))
  return index
}

const COMMANDS = {
  async fetch () {
    const f = fetcher()
    // The notice and readme travel with the data so the terms we relied on are checksummed with it.
    await f.get('retrosheet/notice.txt', 'https://www.retrosheet.org/notice.txt', { source: SRC, use: 'fetch_targeted' })
    await f.get('retrosheet/readme.txt', `${BASE}readme.txt`, { source: SRC, use: 'fetch_targeted' })
    await f.get(ZIP_KEY, `${BASE}tranDB.zip`, { source: SRC, use: 'fetch_bulk' })
  },
  async index () {
    const idx = await draftIndex()
    log(`${idx.records.length} draft records (sha256 ${idx.source_sha256.slice(0, 12)}); unknown club codes: ${JSON.stringify(idx.unknown_club_codes)}`)
    log(RETROSHEET_ATTRIBUTION)
  },
  async coverage () {
    const idx = await draftIndex()
    const ys = (opt('years') ?? '').split(',').filter(Boolean)
    for (const y of ys.length ? ys : Object.keys(idx.coverage_by_year)) log(`${y} ${JSON.stringify(idx.coverage_by_year[y] ?? { records: 0 })}`)
  },
  async crosscheck () {
    const idx = await draftIndex()
    const regFile = path.join(OUT, 'exceptions.json')
    if (!fs.existsSync(regFile)) throw new Error(`${regFile} not found: run scripts/history/exceptions.mjs first`)
    const register = JSON.parse(fs.readFileSync(regFile, 'utf8'))
    for (const y of new Set(register.entries.map((e) => e.year))) {   // the register quotes restricted sources: same gates as exceptions.mjs
      requireUse(catalog, 'mlb-statsapi-draft', 'process_local', { year: y }, { root })
      requireUse(catalog, 'bref-draft-archive', 'process_local', { year: y }, { root })
    }
    const years = new Set(register.entries.map((e) => e.year))
    const byYear = new Map([...years].map((y) => [y, idx.records.filter((r) => r.draft_year === y && r.retrosheet_id)]))
    // Chadwick names for the Retrosheet ids involved (cleared source; the pinned commit's cached shards).
    const wanted = new Set([...byYear.values()].flat().map((r) => r.retrosheet_id))
    const names = new Map()
    const f = fetcher()
    const commit = catalog.sources.find((s) => s.id === 'chadwick-register').pinned_commit.slice(0, 7)
    for (const s of SHARDS) {
      const key = `chadwick/${commit}/people-${s}.csv`
      const e = f.manifest.entries[key]
      if (!e) throw new Error('Chadwick register not cached: run history -- fetch-crosswalk first')
      namesByRetrosheetId((await f.get(key, e.url, { source: 'chadwick-register', use: 'fetch_bulk' })).buf.toString('utf8'), wanted, names)
    }
    const findings = register.entries.map((e) => crossCheckEntry(e, byYear.get(e.year) ?? [], names))
    const out = {
      format: 'bai-retrosheet-crosscheck/1',
      note: 'PROPOSED FINDINGS ONLY. Nothing here resolves an exception: a reviewer decides through history:review. Retrosheet covers only people it tracks, so no record is not evidence. Quotes restricted-source names: keep in this directory.',
      attribution: RETROSHEET_ATTRIBUTION,
      retrosheet_sha256: idx.source_sha256, register_entries: register.entries.length,
      findings
    }
    atomicWrite(path.join(OUT, 'retrosheet-crosscheck.json'), JSON.stringify(out, null, 1) + '\n')
    const tally = {}
    for (const x of findings) tally[x.outcome] = (tally[x.outcome] ?? 0) + 1
    log(`cross-checked ${findings.length} exception groups: ${JSON.stringify(tally)}  -> ${path.join(OUT, 'retrosheet-crosscheck.json')}`)
  }
}

/** Names quoted in a register claim: "A" / "B" pairs, "#170 Name" picks and "MLBAM n Name". */
export function candidateNames (entry) {
  const out = []
  const lines = (entry.claims ?? []).flatMap((c) => (Array.isArray(c.says) ? c.says : [c.says])).map(String)
  for (const line of lines) {
    const club = line.match(/^([A-Z]{2,3}) #\d+/)?.[1] ?? entry.club ?? null
    const pairs = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1])
    if (pairs.length >= 2 && /\/ "/.test(line)) { out.push({ club, variants: pairs.slice(0, 2), pair: true }); continue }
    for (const m of line.matchAll(/(?:#|\b)(\d{1,4}) ([A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+){1,2})(?=;|$|,| \()/g)) out.push({ club, variants: [m[2]], pair: false })
    const mb = line.match(/MLBAM \d+ ([A-Z][A-Za-z'.-]+(?: [A-Z][A-Za-z'.-]+)+):/)
    if (mb) out.push({ club: null, variants: [mb[1]], pair: false })
  }
  return out
}

export function crossCheckEntry (entry, yearRecords, names) {
  const cands = candidateNames(entry)
  const results = cands.map((c) => {
    const matches = []
    for (const r of yearRecords) {
      if (c.club && r.franchise !== c.club && entry.kind !== 'SAME_PERSON_TWICE') continue
      const n = names.get(r.retrosheet_id)
      if (!n) continue
      const cmp = c.variants.map((v) => compareNames(v, n.name))
      if (cmp.every((x) => x === 'DIFFERENT_SURNAME')) continue
      matches.push({ retrosheet_id: r.retrosheet_id, chadwick_name: n.name, status: r.status, club: r.franchise, draft_type: r.draft_type || 'regular', round: r.round, pick: r.pick, signing_date: r.signing_date, compared: Object.fromEntries(c.variants.map((v, i) => [v, cmp[i]])) })
    }
    return { club: c.club, variants: c.variants, retrosheet_matches: matches }
  })
  const hits = results.filter((r) => r.retrosheet_matches.length)
  const discriminating = hits.filter((r) => r.variants.length === 2 && r.retrosheet_matches.some((m) => new Set(Object.values(m.compared).map((x) => (x === 'EXACT' ? 'E' : x === 'SAME_SURNAME_COMPATIBLE_FIRST' ? 'C' : 'N'))).size > 1))
  const outcome = !cands.length ? 'NOT_COMPARABLE' : !hits.length ? 'NO_RETROSHEET_RECORD' : discriminating.length ? 'RETROSHEET_FAVORS_ONE_VARIANT' : 'RETROSHEET_RECORD_NO_DISCRIMINATION'
  return {
    exception_id: entry.id, kind: entry.kind, review_kind: entry.review_kind, year: entry.year, status: 'PROPOSED_FINDING',
    outcome, candidates_compared: cands.length, candidates_with_records: hits.length,
    note: 'A Retrosheet record names a person; it does not say how the name was spelled in the draft list. Chadwick supplies the name for the id. A reviewer weighs this.',
    results: hits
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!COMMANDS[command]) { console.error(`usage: retrosheet.mjs ${Object.keys(COMMANDS).join('|')}`); process.exit(2) }
  try { await COMMANDS[command]() } catch (err) {
    if (err instanceof PermissionDenied) { console.error(`permission refused: ${err.message}`); process.exit(4) }
    if (err instanceof BudgetExhausted) { console.error(err.message); process.exit(3) }
    console.error(err.message); process.exit(1)
  }
}
