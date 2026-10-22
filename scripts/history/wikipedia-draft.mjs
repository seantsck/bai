// Wikipedia-sourced draft year, researched locally: fetch the article revision, match identities against Chadwick and
// Wikidata, build review batches. Nothing is published: output goes to .local/history/<year>/ (gitignored), the import
// writes only to the local database, and a hosted release needs its own review of permissions, quality and coverage.
//
//   node scripts/history/wikipedia-draft.mjs fetch    --year 2020
//   node scripts/history/wikipedia-draft.mjs identify --year 2020        (Chadwick cache + Wikidata queries, cached)
//   node scripts/history/wikipedia-draft.mjs build    --year 2020        (batches into .local/history/batches/<year>)
//   then: BAI_HISTORY_OUT=.local/history npm run history -- import --year 2020 [--write --no-plan]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCatalog, requireUse } from './lib/permissions.mjs'
import { createFetcher, PermissionDenied, BudgetExhausted } from './lib/fetch.mjs'
import { userAgent } from './lib/outbound.mjs'
import { SHARDS, indexShard } from './lib/chadwick.mjs'
import { parseDraftArticle, WIKI_TEAMS } from './lib/wikipedia-draft.mjs'
import { chadwickCandidates, candidatesFor, decideIdentity } from './lib/identity-2020.mjs'
import { nameQuery, queryUrl, queryKey, parseNameResults } from './lib/wikidata.mjs'
import { parseDraftTransactions, RETROSHEET_ATTRIBUTION } from './lib/retrosheet.mjs'
import { draftKey } from './lib/mlb.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0]
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const year = Number(opt('year'))
const catalog = loadCatalog(root)
const OUT = path.resolve(root, process.env.BAI_HISTORY_OUT || '.local/history')
const YEAR_DIR = path.join(OUT, String(year))
const log = (m) => console.log(m)
const chadwickSrc = catalog.sources.find((s) => s.id === 'chadwick-register')
const commit7 = chadwickSrc.pinned_commit.slice(0, 7)
const ARTICLE_KEY = `wikipedia/${year}-major-league-baseball-draft.json`
const fetcher = () => createFetcher({ root, catalog, maxRequests: Number(opt('max-requests', 12)), minIntervalMs: 1500, userAgent: userAgent('wikipedia draft research'), log })
const write = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) + '\n') }
const folded = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim()

async function article () {
  const f = fetcher()
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=ids|timestamp|content&rvslots=main&format=json&formatversion=2&titles=${year}_Major_League_Baseball_draft`
  const r = await f.get(ARTICLE_KEY, url, { source: 'wikipedia-draft-articles', use: 'fetch_targeted', scope: { year } })
  const rev = JSON.parse(r.buf.toString('utf8')).query.pages[0].revisions[0]
  return { entry: r.entry, revid: rev.revid, timestamp: rev.timestamp, text: rev.slots.main.content, ...parseDraftArticle(rev.slots.main.content, { year }) }
}

const COMMANDS = {
  async fetch () { const a = await article(); log(`revision ${a.revid} (${a.timestamp}): ${a.picks.length} selections, stated ${a.stated.overall}, findings ${a.findings.length}`) },

  async identify () {
    requireUse(catalog, 'chadwick-register', 'process_local', {}, { root })
    requireUse(catalog, 'wikidata', 'process_local', {}, { root })
    const a = await article()
    const f = fetcher()
    const index = new Map()
    for (const s of SHARDS) {
      const key = `chadwick/${commit7}/people-${s}.csv`
      const e = f.manifest.entries[key]
      if (!e) throw new Error('Chadwick register not cached: run history -- fetch-crosswalk first')
      chadwickCandidates((await f.get(key, e.url, { source: 'chadwick-register', use: 'fetch_bulk' })).buf.toString('utf8'), { minBirth: year - 26, maxBirth: year - 16 }, index)
    }
    const names = [...new Set(a.picks.map((p) => p.name))]
    const wd = new Map()
    for (let i = 0; i < names.length; i += 40) {
      const q = nameQuery(names.slice(i, i + 40))
      const r = await f.get(queryKey(q), queryUrl(q), { source: 'wikidata', use: 'fetch_bulk' })
      for (const [k, v] of parseNameResults(JSON.parse(r.buf.toString('utf8')))) wd.set(k, v)
    }
    const retro = new Map()   // Retrosheet draft records of the year (it holds almost none for recent years)
    const ri = path.join(root, '.cache/history/retrosheet/draft-index.json')
    if (fs.existsSync(ri)) for (const r of JSON.parse(fs.readFileSync(ri, 'utf8')).records.filter((x) => x.draft_year === year && x.retrosheet_id)) retro.set(r.retrosheet_id, r)
    const out = a.picks.map((p) => {
      const cands = candidatesFor(p.name, index, { draftYear: year })
      const people = wd.get(p.name) ?? []
      const id = decideIdentity(cands, people)
      // Independent corroboration of the selection itself: a Wikidata "drafted by" statement for the same club and pick.
      const checks = []
      for (const w of people.filter((x) => id.wikidata ? x.qid === id.wikidata.qid : true)) {
        for (const d of w.drafted) {
          const fr = WIKI_TEAMS[d.team] ?? null
          if (fr !== p.franchise && !(d.pick && Number(d.pick) === p.overall_pick)) continue
          const clubOk = fr === p.franchise
          const pickOk = d.pick != null && Number(d.pick) === p.overall_pick
          checks.push({ source: 'wikidata', qid: w.qid, team: d.team, pick: d.pick, year: d.year, club_agrees: clubOk, pick_agrees: pickOk })
        }
      }
      const rid = id.chadwick?.ids.RETROSHEET ?? id.wikidata?.retrosheet ?? null
      const rr = rid ? retro.get(rid) : null
      if (rr) checks.push({ source: 'retrosheet', retrosheet_id: rr.retrosheet_id, club: rr.franchise, status: rr.status, club_agrees: rr.franchise === p.franchise })
      return {
        overall_pick: p.overall_pick, name: p.name, club: p.franchise, status: id.status, basis: id.basis ?? null, reason: id.reason ?? null,
        candidates: id.candidates, wikidata_people: id.wikidata_people,
        chadwick: id.chadwick ? { key_person: id.chadwick.key_person, ids: id.chadwick.ids, birth: id.chadwick.birth, qid: id.chadwick.qid, pro_played_first: id.chadwick.pro_played_first, mlb_played_first: id.chadwick.mlb_played_first, name_match: id.chadwick.name_match } : null,
        wikidata: id.wikidata ?? null, corroboration: checks, candidate_keys: id.candidate_keys ?? null
      }
    })
    const tally = {}
    for (const x of out) tally[x.status] = (tally[x.status] ?? 0) + 1
    write(path.join(YEAR_DIR, 'identity.json'), { format: 'bai-wikipedia-identity/1', year, revision: a.revid, chadwick_commit: chadwickSrc.pinned_commit, tally, picks: out })
    log(`identities: ${JSON.stringify(tally)}; wikidata requests ${f.stats().requests}`)
  },

  async build () {
    requireUse(catalog, 'wikipedia-draft-articles', 'process_local', { year }, { root })
    const a = await article()
    const idFile = path.join(YEAR_DIR, 'identity.json')
    if (!fs.existsSync(idFile)) throw new Error('run identify first')
    const identity = JSON.parse(fs.readFileSync(idFile, 'utf8'))
    if (identity.revision !== a.revid) throw new Error(`identity.json is for revision ${identity.revision}, article is ${a.revid}: run identify again`)
    const byPick = new Map(identity.picks.map((x) => [x.overall_pick, x]))
    const holdFile = path.join(YEAR_DIR, 'holds.json')   // picks a dry run refused (a person decides what happens to them)
    const holdDoc = fs.existsSync(holdFile) ? JSON.parse(fs.readFileSync(holdFile, 'utf8')) : {}
    const extraHolds = holdDoc.holds ?? {}
    const suffixes = holdDoc.batch_suffix ?? {}   // a staged batch is immutable: a changed batch gets a new key (org -> suffix)
    // Verified ids come from the Chadwick register (validated patterns), attributed to it.
    const f = fetcher()
    const wanted = new Set(identity.picks.filter((x) => x.status === 'VERIFIED' && x.chadwick?.ids.MLBAM).map((x) => x.chadwick.ids.MLBAM))
    const cw = new Map()
    for (const s of SHARDS) indexShard((await f.get(`chadwick/${commit7}/people-${s}.csv`, f.manifest.entries[`chadwick/${commit7}/people-${s}.csv`].url, { source: 'chadwick-register', use: 'fetch_bulk' })).buf.toString('utf8'), wanted, cw)
    const retrieved = (iso) => iso.slice(0, 10)
    const wikiKey = `hist:wikipedia-${year}-${draftKey(year, 'JR').slice(5).toLowerCase().replace(/_/g, '-')}-r${a.revid}`
    const cwKey = `hist:chadwick-register-${commit7}`
    const wdKey = `hist:wikidata-${year}-identity`
    const wikiSource = { source_key: wikiKey, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Wikipedia: ${year} Major League Baseball draft, revision ${a.revid}`, publisher: 'Wikimedia Foundation (contributors)', url: `https://en.wikipedia.org/w/index.php?title=${year}_Major_League_Baseball_draft&oldid=${a.revid}`, retrieved_date: retrieved(a.entry.retrieved_at), published_date: a.timestamp.slice(0, 10), notes: `Revision ${a.revid} (${a.timestamp}); sha256 of the API response ${a.entry.sha256}. Facts only (pick, round table, club, school label); text CC BY-SA 4.0, not reproduced. No signing, bonus or outcome data.` }
    const cwSource = { source_key: cwKey, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Chadwick Baseball Bureau Register, commit ${commit7}`, publisher: 'Chadwick Baseball Bureau', url: `https://github.com/chadwickbureau/register/tree/${chadwickSrc.pinned_commit}`, retrieved_date: retrieved(f.manifest.entries[`chadwick/${commit7}/people-0.csv`].retrieved_at), notes: 'MLBAM -> Baseball-Reference, Baseball-Reference minors, FanGraphs and Retrosheet ids; birth dates. Open Data Commons Attribution License 1.0.' }
    const wdSource = { source_key: wdKey, source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: `Wikidata identity corroboration for the ${year} draft`, publisher: 'Wikimedia Foundation (Wikidata contributors)', url: 'https://www.wikidata.org/', retrieved_date: retrieved(new Date().toISOString()), notes: 'CC0 1.0. Used only to corroborate that a Chadwick candidate is the person named in the draft table (Q-id, MLBAM id or birth date agreeing).' }
    const orgs = [...new Set(a.picks.map((p) => p.franchise))].sort()
    const outDir = path.join(OUT, 'batches', String(year))
    fs.rmSync(outDir, { recursive: true, force: true })
    const summary = { batches: [], held: [] }
    for (const org of orgs) {
      const mine = a.picks.filter((p) => p.franchise === org)
      const records = []
      const held = []
      let usedCw = false; let usedWd = false
      for (const p of mine) {
        const id = byPick.get(p.overall_pick)
        const why = id.status === 'AMBIGUOUS' ? `identity ambiguous: ${id.reason}` : extraHolds[p.overall_pick] ?? null
        if (why) { held.push({ pick: p.overall_pick, name: p.name, reason: why }); continue }
        const player = { full_name: p.name, source_key: wikiKey }
        const rec = { type: 'DRAFT_SELECTION', source_key: wikiKey, draft_key: draftKey(year, 'JR'), round_code: p.round_code, overall_pick: p.overall_pick, round_pick: null, organization: org, selection_type: p.selection_type, player }
        if (id.status === 'VERIFIED' && id.chadwick?.ids.MLBAM) {
          const c = cw.get(id.chadwick.ids.MLBAM)
          if (c) {
            player.external_ids = { MLBAM: id.chadwick.ids.MLBAM, ...c.ids }
            player.external_id_sources = Object.fromEntries(Object.keys(player.external_ids).map((k) => [k, cwKey]))
            if (c.birth[0] && c.birth[1] && c.birth[2]) { player.birth_date = `${c.birth[0]}-${String(c.birth[1]).padStart(2, '0')}-${String(c.birth[2]).padStart(2, '0')}`; rec.field_sources = { birth_date: cwKey } }
            usedCw = true; usedWd = true
          }
        }
        if (p.school) rec.school = { name: p.school.name, school_type: p.school.school_type, city: p.school.city, region: p.school.region, source_key: wikiKey }
        rec.signing = { status: 'UNKNOWN' }
        rec.notes = `From Wikipedia's ${year} draft article (revision ${a.revid}). Identity: ${id.status}${id.basis ? ` (${id.basis.join(', ')})` : ''}${id.status === 'VERIFIED' ? '' : '; no ids attached'}. Signing status not researched: unknown, not unsigned.${p.round_code === 'C-2' ? ' Round C-2 is derived from the article\'s "Compensatory round" table title, not from MLB\'s label.' : ''}`
        records.push(rec)
      }
      const claim = {
        domain: 'DRAFT', scope_key: draftKey(year, 'JR'), organization: org, coverage_state: 'PARTIAL_RECONSTRUCTION', source_key: wikiKey,
        gap_notes: [
          `Wikipedia's article (revision ${a.revid}) lists ${mine.length} selection(s) for the club in the ${year} June draft; the article states ${a.stated.overall} in all.`,
          'One aggregator list and no independent per-club list: the rows are not proof of the population.',
          held.length ? `Held, not imported: ${held.map((h) => `#${h.pick} (${h.reason})`).join('; ')}.` : null,
          'Signing status, bonuses and outcomes not researched.'
        ].filter(Boolean).join(' ')
      }
      const sources = [wikiSource, ...(usedCw ? [cwSource] : []), ...(usedWd ? [wdSource] : [])]
      const doc = { format: 'bai-research-import/1', batch_key: `hist-${year}-june-amateur-${org.toLowerCase()}${suffixes[org] ? `-${suffixes[org]}` : ''}`, channel: 'DRAFT', description: `${org}, ${year} June draft: ${records.length} of ${mine.length} selections from Wikipedia's article (local research import).`, coverage_claims: [claim], sources, records }
      if (!records.length) { summary.held.push(...held.map((h) => ({ org, ...h }))); continue }
      write(path.join(outDir, `${doc.batch_key}.json`), doc)
      summary.batches.push({ org, records: records.length, held: held.length }); summary.held.push(...held.map((h) => ({ org, ...h })))
    }
    write(path.join(YEAR_DIR, 'build.json'), { year, revision: a.revid, ...summary })
    log(`${summary.batches.length} batches, ${summary.batches.reduce((n, b) => n + b.records, 0)} records, held ${summary.held.length}`)
  }
}

if (!COMMANDS[command] || !year) { console.error(`usage: wikipedia-draft.mjs ${Object.keys(COMMANDS).join('|')} --year YYYY`); process.exit(2) }
try { await COMMANDS[command]() } catch (err) {
  if (err instanceof PermissionDenied) { console.error(`permission refused: ${err.message}`); process.exit(4) }
  if (err instanceof BudgetExhausted) { console.error(err.message); process.exit(3) }
  console.error(err.stack ?? err.message); process.exit(1)
}
void folded; void RETROSHEET_ATTRIBUTION; void parseDraftTransactions
