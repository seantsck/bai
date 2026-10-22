// Identity matching for Wikipedia-sourced draft rows (names only) against two cleared reference sources: the Chadwick
// register (ODC-BY) and Wikidata (CC0). Pure functions. Nothing here decides an identity a person should decide:
//   VERIFIED            exactly one Chadwick candidate AND a Wikidata person tied to it by Wikidata Q-id, MLBAM id or full birth date
//   SINGLE_SOURCE       one candidate in one source only (kept as a candidate; no ids are attached)
//   AMBIGUOUS           several candidates that the two sources cannot tell apart
//   UNMATCHED           no candidate in either source
import { compareNames } from './retrosheet.mjs'
import { parseCsv, PATTERNS } from './chadwick.mjs'

const full = (b) => (b && b[0] && b[1] && b[2] ? `${b[0]}-${String(b[1]).padStart(2, '0')}-${String(b[2]).padStart(2, '0')}` : null)

/** Chadwick shard text -> candidates by folded surname, restricted to a plausible birth-year window. */
export function chadwickCandidates (shardText, { minBirth, maxBirth }, into = new Map()) {
  const rows = parseCsv(shardText)
  const head = rows.shift()
  const col = Object.fromEntries(head.map((h, i) => [h, i]))
  for (const r of rows) {
    const by = Number(r[col.birth_year])
    if (!by || by < minBirth || by > maxBirth) continue
    const ids = {}
    for (const [sys, key] of [['MLBAM', 'key_mlbam'], ['BBREF', 'key_bbref'], ['BBREF_MINORS', 'key_bbref_minors'], ['FANGRAPHS', 'key_fangraphs'], ['RETROSHEET', 'key_retro']]) {
      const v = (r[col[key]] ?? '').trim()
      if (v && (sys === 'MLBAM' ? /^\d+$/.test(v) : PATTERNS[sys].test(v))) ids[sys] = v
    }
    const last = (r[col.name_last] ?? '').trim()
    const entry = {
      key_person: r[col.key_person], qid: (r[col.key_wikidata] ?? '').trim() || null, ids,
      first: (r[col.name_first] ?? '').trim(), given: (r[col.name_given] ?? '').trim(), last, suffix: (r[col.name_suffix] ?? '').trim(),
      birth: [r[col.birth_year], r[col.birth_month], r[col.birth_day]].map((x) => x || null),
      pro_played_first: Number(r[col.pro_played_first]) || null, mlb_played_first: Number(r[col.mlb_played_first]) || null
    }
    const k = last.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    if (!k) continue
    if (!into.has(k)) into.set(k, [])
    into.get(k).push(entry)
  }
  return into
}

const surnameKey = (name) => String(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?$/g, '').replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim()

/** Candidates for a printed name: same surname, exact or compatible first name (given or common name), plausible career start. */
export function candidatesFor (name, index, { draftYear }) {
  const parts = surnameKey(name).split(' ')
  const tried = new Set()
  const out = []
  // The surname may be one or several words; try every split point.
  for (let i = 1; i < parts.length; i++) {
    const last = parts.slice(i).join(' ')
    if (tried.has(last)) continue
    tried.add(last)
    for (const c of index.get(last) ?? []) {
      const names = [`${c.first} ${c.last}`, `${c.given} ${c.last}`]
      const cmp = names.map((n) => compareNames(name, n))
      const best = cmp.includes('EXACT') ? 'EXACT' : cmp.includes('SAME_SURNAME_COMPATIBLE_FIRST') ? 'COMPATIBLE' : null
      if (!best) continue
      // A career that began well before the draft is another person with the same name.
      if (c.pro_played_first && c.pro_played_first < draftYear - 1) continue
      out.push({ ...c, name_match: best })
    }
  }
  return out
}

/** Decide one pick's identity from its Chadwick candidates and Wikidata people (both lists may be empty). */
export function decideIdentity (candidates, wdPeople) {
  const links = []
  for (const c of candidates) {
    for (const w of wdPeople) {
      const basis = c.qid && c.qid === w.qid ? 'WIKIDATA_QID_IN_CHADWICK' : c.ids.MLBAM && w.mlbam && c.ids.MLBAM === w.mlbam ? 'MLBAM_AGREES' : (full(c.birth) && w.birth_date && full(c.birth) === w.birth_date) ? 'BIRTH_DATE_AGREES' : null
      if (basis) links.push({ c, w, basis })
    }
  }
  const linkedCands = [...new Set(links.map((l) => l.c.key_person))]
  const linkedPeople = [...new Set(links.map((l) => l.w.qid))]
  if (linkedCands.length === 1 && linkedPeople.length === 1) {
    const l = links.find((x) => x.c.key_person === linkedCands[0])
    const strong = links.some((x) => x.basis !== 'BIRTH_DATE_AGREES')
    // Another unlinked candidate with an exact name keeps the match from being called verified.
    const rivals = candidates.filter((c) => c.key_person !== l.c.key_person && c.name_match === 'EXACT')
    if (!rivals.length || strong) {
      return { status: 'VERIFIED', basis: [...new Set(links.filter((x) => x.c.key_person === l.c.key_person).map((x) => x.basis))], chadwick: l.c, wikidata: l.w, candidates: candidates.length, wikidata_people: wdPeople.length }
    }
  }
  if (candidates.length === 1 && !wdPeople.length) return { status: 'SINGLE_SOURCE', source: 'CHADWICK', chadwick: candidates[0], wikidata: null, candidates: 1, wikidata_people: 0, reason: 'one Chadwick candidate; Wikidata has no baseball player of that name' }
  if (candidates.length === 1 && wdPeople.length) return { status: 'SINGLE_SOURCE', source: 'CHADWICK', chadwick: candidates[0], wikidata: null, candidates: 1, wikidata_people: wdPeople.length, reason: 'one Chadwick candidate that no Wikidata person is tied to' }
  if (!candidates.length && wdPeople.length === 1) return { status: 'SINGLE_SOURCE', source: 'WIKIDATA', chadwick: null, wikidata: wdPeople[0], candidates: 0, wikidata_people: 1, reason: 'one Wikidata person; no Chadwick candidate' }
  if (!candidates.length && !wdPeople.length) return { status: 'UNMATCHED', chadwick: null, wikidata: null, candidates: 0, wikidata_people: 0, reason: 'no candidate in Chadwick or Wikidata' }
  return { status: 'AMBIGUOUS', chadwick: null, wikidata: null, candidates: candidates.length, wikidata_people: wdPeople.length, reason: `${candidates.length} Chadwick candidate(s) and ${wdPeople.length} Wikidata person(s) that the sources cannot tell apart`, candidate_keys: candidates.map((c) => c.key_person) }
}
