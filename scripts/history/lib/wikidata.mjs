// Wikidata (CC0): a secondary identity and biographical reference. Queries are small, serial, cached and sent with the
// project user agent (lib/outbound.mjs, via the fetcher). A Wikidata match supports an identity; it never establishes that
// a person belongs to a draft, and a missing statement means nothing (fewer than 1% of selections carry "drafted by").
import crypto from 'node:crypto'

export const PROPS = { MLB_ID: 'P3541', BBREF_MAJOR: 'P1825', RETROSHEET_PERSON: 'P6976', DRAFTED_BY: 'P647', DRAFT_PICK: 'P1836', BIRTH_DATE: 'P569' }
export const BASEBALL_PLAYER = 'Q10871364'
export const SPARQL = 'https://query.wikidata.org/sparql'

const lit = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ')}"@en`

/** Baseball players whose English label is exactly one of `names`, with ids, birth date and any "drafted by" statements. */
export function nameQuery (names) {
  if (!names.length || names.length > 50) throw new Error('1 to 50 names per query')
  return `SELECT ?p ?label ?mlb ?birth ?bbref ?retro ?dteamLabel ?dpick ?dtime WHERE {
  VALUES ?label { ${names.map(lit).join(' ')} }
  ?p rdfs:label ?label ; wdt:P106 wd:${BASEBALL_PLAYER} .
  OPTIONAL { ?p wdt:${PROPS.MLB_ID} ?mlb }
  OPTIONAL { ?p wdt:${PROPS.BIRTH_DATE} ?birth }
  OPTIONAL { ?p wdt:${PROPS.BBREF_MAJOR} ?bbref }
  OPTIONAL { ?p wdt:${PROPS.RETROSHEET_PERSON} ?retro }
  OPTIONAL { ?p p:${PROPS.DRAFTED_BY} ?d . ?d ps:${PROPS.DRAFTED_BY} ?dteam . OPTIONAL { ?d pq:${PROPS.DRAFT_PICK} ?dpick } OPTIONAL { ?d pq:P585 ?dtime }
             ?dteam rdfs:label ?dteamLabel . FILTER(LANG(?dteamLabel) = "en") }
}`
}

export const queryUrl = (query) => `${SPARQL}?format=json&query=${encodeURIComponent(query)}`
export const queryKey = (query) => `wikidata/sparql-${crypto.createHash('sha256').update(query).digest('hex').slice(0, 16)}.json`

/** SPARQL JSON -> Map label -> [{ qid, mlbam, birth_date, bbref, retrosheet, drafted: [{ team, pick, year }] }] (one entry per person). */
export function parseNameResults (json) {
  const out = new Map()
  for (const b of json?.results?.bindings ?? []) {
    const label = b.label?.value
    const qid = b.p?.value?.match(/\/(Q\d+)$/)?.[1]
    if (!label || !qid) continue
    const list = out.get(label) ?? []
    let e = list.find((x) => x.qid === qid)
    if (!e) { e = { qid, mlbam: null, birth_date: null, bbref: null, retrosheet: null, drafted: [] }; list.push(e) }
    if (b.mlb?.value) e.mlbam = b.mlb.value
    if (b.birth?.value) e.birth_date = b.birth.value.slice(0, 10)
    if (b.bbref?.value) e.bbref = b.bbref.value
    if (b.retro?.value) e.retrosheet = b.retro.value
    if (b.dteamLabel?.value) {
      const d = { team: b.dteamLabel.value, pick: b.dpick?.value ?? null, year: b.dtime?.value?.slice(0, 4) ?? null }
      if (!e.drafted.some((x) => x.team === d.team && x.pick === d.pick && x.year === d.year)) e.drafted.push(d)
    }
    out.set(label, list)
  }
  return out
}
