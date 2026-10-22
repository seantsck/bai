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
import { chadwickCandidates, candidatesFor, decideIdentity, narrowByCareer } from './lib/identity-2020.mjs'
import { compareSchools } from './lib/evidence-compare.mjs'
import { nameQuery, queryUrl, queryKey, parseNameResults, pagePropsUrl, pagePropsKey, parsePageProps, qidQuery, parseQidResults, mlbamQuery } from './lib/wikidata.mjs'
import { parseDraftTransactions, RETROSHEET_ATTRIBUTION, compareNames } from './lib/retrosheet.mjs'
import { draftKey } from './lib/mlb.mjs'
import { parseEvidenceRows, compareLists } from './lib/evidence-compare.mjs'
import { requireBatchUse, requireHostedPublication, sourceForUrl, checkUse } from './lib/permissions.mjs'
import { ownerDatabaseUrl, isLocalUrl } from '../db/lib/connection.mjs'
import pg from 'pg'

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
const fetcher = () => createFetcher({ root, catalog, maxRequests: Number(opt('max-requests', 16)), minIntervalMs: 1500, userAgent: userAgent('wikipedia draft research'), log })
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
    // People the article itself links to: page title -> Wikibase item -> Wikidata person.
    const titles = [...new Set(a.picks.map((p) => p.link_title).filter(Boolean))]
    const qidByTitle = new Map()
    for (let i = 0; i < titles.length; i += 50) {
      const chunk = titles.slice(i, i + 50)
      const r = await f.get(pagePropsKey(chunk), pagePropsUrl(chunk), { source: 'wikipedia-draft-articles', use: 'fetch_bulk', scope: { year } })
      for (const [t, q] of parsePageProps(JSON.parse(r.buf.toString('utf8')))) qidByTitle.set(t, q)
    }
    const linkedPeople = new Map()
    const qids = [...new Set(qidByTitle.values())]
    for (let i = 0; i < qids.length; i += 50) {
      const q = qidQuery(qids.slice(i, i + 50))
      const r = await f.get(queryKey(q), queryUrl(q), { source: 'wikidata', use: 'fetch_bulk' })
      for (const [k, v] of parseQidResults(JSON.parse(r.buf.toString('utf8')))) linkedPeople.set(k, v)
    }
    const retro = new Map()   // Retrosheet draft records of the year (it holds almost none for recent years)
    const ri = path.join(root, '.cache/history/retrosheet/draft-index.json')
    if (fs.existsSync(ri)) for (const r of JSON.parse(fs.readFileSync(ri, 'utf8')).records.filter((x) => x.draft_year === year && x.retrosheet_id)) retro.set(r.retrosheet_id, r)
    // Second pass: for picks the first pass could not tie, ask Wikidata who holds each remaining candidate's MLB id.
    const firstPass = new Map()
    const wanted0 = new Set()
    for (const p of a.picks) {
      const cs = candidatesFor(p.name, index, { draftYear: year })
      firstPass.set(p.overall_pick, cs)
      if (cs.length <= 3) for (const c of cs) if (c.ids.MLBAM) wanted0.add(c.ids.MLBAM)
    }
    const byMlbam = new Map()
    const mlbList = [...wanted0]
    for (let i = 0; i < mlbList.length; i += 50) {
      const q = mlbamQuery(mlbList.slice(i, i + 50))
      const r = await f.get(queryKey(q), queryUrl(q), { source: 'wikidata', use: 'fetch_bulk' })
      for (const b of JSON.parse(r.buf.toString('utf8')).results.bindings) {
        const m = b.mlb.value
        const e = byMlbam.get(m) ?? { qid: b.p.value.split('/').pop(), label: b.label.value, mlbam: m, birth_date: b.birth?.value?.slice(0, 10) ?? null, bbref: b.bbref?.value ?? null, retrosheet: b.retro?.value ?? null, drafted: [] }
        byMlbam.set(m, e)
      }
    }
    const out = a.picks.map((p) => {
      const allCands = candidatesFor(p.name, index, { draftYear: year })
      let cands = allCands
      let eliminated = []
      let narrowed = false
      const qid = p.link_title ? qidByTitle.get(p.link_title) ?? null : null
      const linked = qid ? (linkedPeople.get(qid) ?? { qid, label: null, mlbam: null, birth_date: null, bbref: null, retrosheet: null, educated_at: [], drafted: [] }) : null
      const people = [...(wd.get(p.name) ?? [])]
      // A Wikidata person reached through a candidate's MLB id counts only if its English label is a compatible spelling of the printed name.
      for (const c of allCands) { const w = c.ids.MLBAM ? byMlbam.get(c.ids.MLBAM) : null; if (w && compareNames(p.name, w.label) !== 'DIFFERENT_SURNAME' && !people.some((x) => x.qid === w.qid)) people.push({ ...w, via: 'MLBAM_LOOKUP' }) }
      let id = decideIdentity(cands, people, linked)
      if (id.status === 'AMBIGUOUS') {
        const n = narrowByCareer(allCands, { schoolType: p.school?.school_type ?? null, draftYear: year })
        if (n.narrowed) { cands = n.kept; eliminated = n.eliminated; narrowed = true; id = decideIdentity(cands, people, linked) }
      }
      // Independent corroboration of the selection itself: a Wikidata "drafted by" statement for the same club and pick.
      const checks = []
      for (const w of (linked ? [linked] : people).filter((x) => id.wikidata ? x.qid === id.wikidata.qid : true)) {
        for (const d of w.drafted) {
          const fr = WIKI_TEAMS[d.team] ?? null
          if (fr !== p.franchise && !(d.pick && Number(d.pick) === p.overall_pick)) continue
          const clubOk = fr === p.franchise
          const pickOk = d.pick != null && Number(d.pick) === p.overall_pick
          checks.push({ source: 'wikidata', qid: w.qid, team: d.team, pick: d.pick, year: d.year, club_agrees: clubOk, pick_agrees: pickOk })
        }
      }
      if (linked?.educated_at?.length && id.status === 'VERIFIED') checks.push({ source: 'wikidata', qid: linked.qid, educated_at: linked.educated_at, school_agrees: linked.educated_at.some((e) => compareSchools(e, p.school_label ?? '') === 'SAME') })
      const rid = id.chadwick?.ids.RETROSHEET ?? id.wikidata?.retrosheet ?? null
      const rr = rid ? retro.get(rid) : null
      if (rr) checks.push({ source: 'retrosheet', retrosheet_id: rr.retrosheet_id, club: rr.franchise, status: rr.status, club_agrees: rr.franchise === p.franchise })
      return {
        overall_pick: p.overall_pick, name: p.name, club: p.franchise, status: id.status, basis: id.basis ?? null, reason: id.reason ?? null,
        candidates: id.candidates, wikidata_people: id.wikidata_people, link_conflict: id.link_conflict ?? null, link_title: p.link_title, link_qid: qid, narrowed_by_career: narrowed, narrowed_out: eliminated.length ? eliminated : null,
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
    const suffixes = holdDoc.batch_suffix ?? {}
    // A supplement run adds picks that earlier runs held: --only-picks 36,72 --suffix d1 (existing batch files are kept).
    const only = opt('only-picks') ? new Set(opt('only-picks').split(',').map(Number)) : null
    const deltaSuffix = opt('suffix')   // a staged batch is immutable: a changed batch gets a new key (org -> suffix)
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
    if (!only) fs.rmSync(outDir, { recursive: true, force: true })
    const summary = { batches: [], held: [] }
    for (const org of orgs) {
      const mine = a.picks.filter((p) => p.franchise === org)
      if (only && !mine.some((p) => only.has(p.overall_pick))) continue
      const records = []
      const held = []
      let usedCw = false; let usedWd = false
      for (const p of mine) {
        if (only && !only.has(p.overall_pick)) continue
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
      const doc = { format: 'bai-research-import/1', batch_key: `hist-${year}-june-amateur-${org.toLowerCase()}${deltaSuffix ? `-${deltaSuffix}` : suffixes[org] ? `-${suffixes[org]}` : ''}`, channel: 'DRAFT', description: `${org}, ${year} June draft: ${records.length} of ${mine.length} selections from Wikipedia's article (local research import).`, coverage_claims: [claim], sources, records }
      if (!records.length) { summary.held.push(...held.map((h) => ({ org, ...h }))); continue }
      write(path.join(outDir, `${doc.batch_key}.json`), doc)
      summary.batches.push({ org, records: records.length, held: held.length }); summary.held.push(...held.map((h) => ({ org, ...h })))
    }
    write(path.join(YEAR_DIR, only ? `build-${deltaSuffix ?? 'delta'}.json` : 'build.json'), { year, revision: a.revid, ...summary })
    log(`${summary.batches.length} batches, ${summary.batches.reduce((n, b) => n + b.records, 0)} records, held ${summary.held.length}`)
  },

  // Compare birth dates found in lawful public pages (dob-evidence.json, written by a research agent that was NOT given the
  // register's dates) with the Chadwick candidate's. Writes dob-comparison.json with proposals; changes no status.
  async 'dob-compare' () {
    const identity = JSON.parse(fs.readFileSync(path.join(YEAR_DIR, 'identity.json'), 'utf8'))
    const ev = JSON.parse(fs.readFileSync(path.join(YEAR_DIR, 'evidence', 'dob-evidence.json'), 'utf8'))
    const rows = ev.map((e) => {
      const x = identity.picks.find((p) => p.overall_pick === e.pick)
      // A fact whose cited page is on a source the catalog does not let BAI fetch is not used (an agent saw it in a snippet).
      const gov = e.source_url ? sourceForUrl(catalog, e.source_url) : null
      if (gov && !checkUse(catalog, gov, 'fetch_targeted', {}, { root }).ok) return { pick: e.pick, name: e.name, identity_status: x?.status, result: 'EXCLUDED_RESTRICTED_SOURCE', proposed: null, source_url: null, source_kind: null, excluded_because: `cited page is governed by ${gov.id} (fetch not permitted)` }
      const cb = x?.chadwick?.birth ?? null
      const cDate = cb && cb[0] && cb[1] && cb[2] ? `${cb[0]}-${String(cb[1]).padStart(2, '0')}-${String(cb[2]).padStart(2, '0')}` : null
      const found = e.birth_date ?? null
      const foundYear = e.birth_year ?? (found ? Number(found.slice(0, 4)) : null)
      const result = !x?.chadwick ? 'NO_CANDIDATE' : found && cDate ? (found === cDate ? 'DATE_AGREES' : 'DATE_DISAGREES') : foundYear && cb?.[0] ? (Number(cb[0]) === foundYear ? 'YEAR_ONLY_AGREES' : 'YEAR_DISAGREES') : 'NO_EVIDENCE'
      return { pick: e.pick, name: e.name, identity_status: x?.status, candidate_mlbam: x?.chadwick?.ids?.MLBAM ?? null, found_birth_date: found, found_birth_year: foundYear, candidate_birth_date: cDate, result,
        proposed: result === 'DATE_AGREES' && x?.status !== 'VERIFIED' ? 'CORROBORATED_BY_PUBLIC_RECORD' : result.endsWith('DISAGREES') ? 'CONFLICT_REVIEW' : null, source_url: e.source_url ?? null, source_kind: e.source_kind ?? null }
    })
    const tally = {}
    for (const r of rows) tally[r.result] = (tally[r.result] ?? 0) + 1
    write(path.join(YEAR_DIR, 'dob-comparison.json'), { year, summary: { tally, proposed_corroborations: rows.filter((r) => r.proposed === 'CORROBORATED_BY_PUBLIC_RECORD').length, conflicts: rows.filter((r) => r.proposed === 'CONFLICT_REVIEW').length }, rows })
    log(`birth-date comparison: ${JSON.stringify(tally)}`)
  },

  // Release-candidate checks: census reconciliation, integrity of what was imported, permissions, evidence comparison.
  // Reads the local database (read-only) and the local evidence files; writes .local/history/<year>/release-candidate.{json,md}.
  async 'release-check' () {
    const a = await article()
    const identity = JSON.parse(fs.readFileSync(path.join(YEAR_DIR, 'identity.json'), 'utf8'))
    const checks = []
    const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
    const nums = a.picks.map((p) => p.overall_pick)
    check('all picks 1..N present once', nums.length === new Set(nums).size && nums.every((n, i) => n === i + 1), `${nums.length} picks, ${a.stated.overall} stated`)
    check('article count equals its stated total', a.picks.length === a.stated.overall, `${a.picks.length} vs ${a.stated.overall}`)
    check('no parser findings', a.findings.length === 0, `${a.findings.length} findings`)
    const clubs = {}
    for (const p of a.picks) clubs[p.franchise] = (clubs[p.franchise] ?? 0) + 1
    check('30 clubs', Object.keys(clubs).length === 30, `${Object.keys(clubs).length} clubs`)

    // Evidence lists: one comparison per local evidence file.
    const evDir = path.join(YEAR_DIR, 'evidence')
    const evMeta = fs.existsSync(path.join(evDir, 'sources.json')) ? JSON.parse(fs.readFileSync(path.join(evDir, 'sources.json'), 'utf8')) : { lists: [] }
    const comparisons = []
    for (const f of fs.existsSync(evDir) ? fs.readdirSync(evDir).filter((x) => x.endsWith('-rows.txt')).sort() : []) {
      const id = f.replace(/-rows\.txt$/, '')
      const cmp = compareLists(a.picks, parseEvidenceRows(fs.readFileSync(path.join(evDir, f), 'utf8')))
      comparisons.push({ id, meta: evMeta.lists.find((l) => l.id.startsWith(id.split('-')[0])) ?? null, ...cmp })
      check(`evidence ${id}: every pick present`, cmp.summary.absent === 0 && cmp.summary.evidence_only === 0, JSON.stringify(cmp.summary))
      check(`evidence ${id}: no club disagrees`, !cmp.findings.some((x) => x.kind === 'CLUB_DIFFERS'), `${cmp.findings.filter((x) => x.kind === 'CLUB_DIFFERS').length} club disagreements`)
    }

    // The local database: what was imported, held, and linked.
    const url = ownerDatabaseUrl()
    if (!isLocalUrl(url)) throw new Error('release-check reads the local database only')
    const db = new pg.Client({ connectionString: url })
    await db.connect()
    let imported = []
    let integrity = null
    try {
      imported = (await db.query(`select s.overall_pick, o.franchise_key, p.id as player_id, p.full_name,
          exists (select 1 from player_external_ids e where e.player_id = p.id and e.id_system = 'MLBAM') as has_mlbam,
          (select count(*)::int from draft_signings g where g.draft_selection_id = s.id) as signings
        from draft_selections s join drafts d on d.id = s.draft_id join organizations o on o.id = s.organization_id join players p on p.id = s.player_id
        where d.draft_year = $1 order by s.overall_pick`, [year])).rows
      const { integrityViolations } = await import('../research/lib/integrity.mjs')
      integrity = await integrityViolations(db)
    } finally { await db.end() }
    const importedSet = new Set(imported.map((r) => r.overall_pick))
    const heldPicks = a.picks.filter((p) => !importedSet.has(p.overall_pick)).map((p) => ({ pick: p.overall_pick, name: p.name, club: p.franchise, identity_status: identity.picks.find((x) => x.overall_pick === p.overall_pick)?.status }))
    check('imported + held = all picks', imported.length + heldPicks.length === a.picks.length, `${imported.length} imported + ${heldPicks.length} held`)
    check('integrity violations', Array.isArray(integrity) && integrity.length === 0, `${Array.isArray(integrity) ? integrity.length : '?'} violations`)
    check('no signing rows created for the year', imported.every((r) => r.signings === 0), `${imported.filter((r) => r.signings > 0).length} selections with a signing row`)
    for (const r of imported) { const c = clubs[r.franchise_key]; if (!c) check(`imported club ${r.franchise_key} exists in the article`, false, '') }
    const byClubImported = {}
    for (const r of imported) byClubImported[r.franchise_key] = (byClubImported[r.franchise_key] ?? 0) + 1

    // Identity tiers per pick, and which imported players lack the ids the evidence now supports (a person decides those links).
    const tier = {}
    for (const x of identity.picks) tier[x.status] = (tier[x.status] ?? 0) + 1
    const proposedLinks = []
    for (const r of imported) {
      const x = identity.picks.find((y) => y.overall_pick === r.overall_pick)
      if (x?.status === 'VERIFIED' && !r.has_mlbam) proposedLinks.push({ pick: r.overall_pick, name: r.full_name, club: r.franchise_key, local_player_id: r.player_id, proposed_mlbam: x.chadwick?.ids?.MLBAM ?? null, basis: x.basis })
    }

    // Permissions: local processing of every batch, and what a hosted publication would be refused for.
    const batchDir = path.join(OUT, 'batches', String(year))
    const refusals = new Map()
    let localOk = 0
    const files = fs.existsSync(batchDir) ? fs.readdirSync(batchDir).filter((x) => x.endsWith('.json')) : []
    for (const file of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(batchDir, file), 'utf8'))
      try { requireBatchUse(catalog, doc, 'process_local', {}, { root }); localOk++ } catch (err) { refusals.set(`local: ${err.message}`, (refusals.get(`local: ${err.message}`) ?? 0) + 1) }
      try { requireHostedPublication(catalog, doc, {}, { root }) } catch (err) { refusals.set(`hosted: ${err.message}`, (refusals.get(`hosted: ${err.message}`) ?? 0) + 1) }
    }
    check('every batch may be processed locally', localOk === files.length, `${localOk} of ${files.length}`)
    const hostedRefusals = [...refusals].filter(([k]) => k.startsWith('hosted')).map(([k, n]) => ({ reason: k.slice(8), batches: n }))

    const dobFile = path.join(YEAR_DIR, 'dob-comparison.json')
    const out = {
      format: 'bai-release-candidate/1', year, revision: a.revid, generated_on: new Date().toISOString().slice(0, 10),
      accounted: { selections: a.picks.length, imported: imported.length, held: heldPicks },
      identity_tiers: tier, proposed_identity_links: proposedLinks,
      clubs: Object.fromEntries(Object.keys(clubs).sort().map((c) => [c, { article: clubs[c], imported: byClubImported[c] ?? 0, evidence: Object.fromEntries(comparisons.map((x) => [x.id, x.clubs[c] ?? null])) }])),
      evidence_comparisons: comparisons.map((x) => ({ id: x.id, summary: x.summary, findings: x.findings })),
      checks, permissions: { local_batches_ok: `${localOk}/${files.length}`, hosted_refusals: hostedRefusals },
      dob_comparison: fs.existsSync(dobFile) ? JSON.parse(fs.readFileSync(dobFile, 'utf8')).summary : null
    }
    write(path.join(YEAR_DIR, 'release-candidate.json'), out)
    const failed = checks.filter((c) => !c.ok)
    log(`checks: ${checks.length - failed.length}/${checks.length} pass${failed.length ? `; FAILED: ${failed.map((c) => c.name).join('; ')}` : ''}`)
    log(`imported ${imported.length}, held ${heldPicks.length}; identity ${JSON.stringify(tier)}; proposed links ${proposedLinks.length}; hosted refusals ${hostedRefusals.length}`)
  }
}

if (!COMMANDS[command] || !year) { console.error(`usage: wikipedia-draft.mjs ${Object.keys(COMMANDS).join('|')} --year YYYY`); process.exit(2) }
try { await COMMANDS[command]() } catch (err) {
  if (err instanceof PermissionDenied) { console.error(`permission refused: ${err.message}`); process.exit(4) }
  if (err instanceof BudgetExhausted) { console.error(err.message); process.exit(3) }
  console.error(err.stack ?? err.message); process.exit(1)
}
void folded; void RETROSHEET_ATTRIBUTION; void parseDraftTransactions
