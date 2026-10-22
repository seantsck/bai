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

// --- people reached through the draft article's own links ------------------------------------------------------------
// The article's player cells link to Wikipedia pages; each page's Wikibase item is a Q-id curated by people, independent of
// name matching. A Q-id obtained this way identifies the person the article means.

/** Wikipedia API URL: Wikibase item (Q-id) of up to 50 page titles, following redirects. */
export function pagePropsUrl (titles) {
  if (!titles.length || titles.length > 50) throw new Error('1 to 50 titles per request')
  return `https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(titles.join('|'))}`
}
export const pagePropsKey = (titles) => `wikipedia/pageprops-${crypto.createHash('sha256').update(titles.join('|')).digest('hex').slice(0, 16)}.json`

/** pageprops JSON -> Map requested title -> Q-id (missing pages and pages without an item are absent). */
export function parsePageProps (json) {
  const q = json?.query ?? {}
  const norm = new Map((q.normalized ?? []).map((n) => [n.from, n.to]))
  const redir = new Map((q.redirects ?? []).map((r) => [r.from, r.to]))
  const byTitle = new Map((q.pages ?? []).filter((p) => p.pageprops?.wikibase_item && !p.missing).map((p) => [p.title, p.pageprops.wikibase_item]))
  const out = new Map()
  const requested = new Set([...norm.keys(), ...redir.keys(), ...byTitle.keys()])
  for (const t of requested) {
    let cur = t
    if (norm.has(cur)) cur = norm.get(cur)
    if (redir.has(cur)) cur = redir.get(cur)
    if (byTitle.has(cur)) out.set(t, byTitle.get(cur))
  }
  return out
}

/** The same person fields for known Q-ids, plus where each was educated (P69). */
export function qidQuery (qids) {
  if (!qids.length || qids.length > 50) throw new Error('1 to 50 Q-ids per query')
  if (!qids.every((q) => /^Q\d+$/.test(q))) throw new Error('not a Q-id')
  return `SELECT ?p ?label ?mlb ?birth ?bbref ?retro ?schoolLabel ?dteamLabel ?dpick ?dtime WHERE {
  VALUES ?p { ${qids.map((q) => `wd:${q}`).join(' ')} }
  ?p rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { ?p wdt:${PROPS.MLB_ID} ?mlb }
  OPTIONAL { ?p wdt:${PROPS.BIRTH_DATE} ?birth }
  OPTIONAL { ?p wdt:${PROPS.BBREF_MAJOR} ?bbref }
  OPTIONAL { ?p wdt:${PROPS.RETROSHEET_PERSON} ?retro }
  OPTIONAL { ?p wdt:P69 ?school . ?school rdfs:label ?schoolLabel . FILTER(LANG(?schoolLabel) = "en") }
  OPTIONAL { ?p p:${PROPS.DRAFTED_BY} ?d . ?d ps:${PROPS.DRAFTED_BY} ?dteam . OPTIONAL { ?d pq:${PROPS.DRAFT_PICK} ?dpick } OPTIONAL { ?d pq:P585 ?dtime }
             ?dteam rdfs:label ?dteamLabel . FILTER(LANG(?dteamLabel) = "en") }
}`
}

/** qidQuery JSON -> Map Q-id -> person (parseNameResults' shape plus label and educated_at). */
export function parseQidResults (json) {
  const out = new Map()
  for (const b of json?.results?.bindings ?? []) {
    const qid = b.p?.value?.match(/\/(Q\d+)$/)?.[1]
    if (!qid) continue
    const e = out.get(qid) ?? { qid, label: b.label?.value ?? null, mlbam: null, birth_date: null, bbref: null, retrosheet: null, educated_at: [], drafted: [] }
    if (b.mlb?.value) e.mlbam = b.mlb.value
    if (b.birth?.value) e.birth_date = b.birth.value.slice(0, 10)
    if (b.bbref?.value) e.bbref = b.bbref.value
    if (b.retro?.value) e.retrosheet = b.retro.value
    if (b.schoolLabel?.value && !e.educated_at.includes(b.schoolLabel.value)) e.educated_at.push(b.schoolLabel.value)
    if (b.dteamLabel?.value) {
      const d = { team: b.dteamLabel.value, pick: b.dpick?.value ?? null, year: b.dtime?.value?.slice(0, 4) ?? null }
      if (!e.drafted.some((x) => x.team === d.team && x.pick === d.pick && x.year === d.year)) e.drafted.push(d)
    }
    out.set(qid, e)
  }
  return out
}

/** Wikidata people holding any of these MLB.com player ids (P3541), whatever their occupation statements say. */
export function mlbamQuery (ids) {
  if (!ids.length || ids.length > 50) throw new Error('1 to 50 ids per query')
  if (!ids.every((i) => /^\d{3,8}$/.test(String(i)))) throw new Error('not an MLB id')
  return `SELECT ?p ?label ?mlb ?birth ?bbref ?retro WHERE {
  VALUES ?mlb { ${ids.map((i) => `"${i}"`).join(' ')} }
  ?p wdt:${PROPS.MLB_ID} ?mlb . ?p rdfs:label ?label . FILTER(LANG(?label) = "en")
  OPTIONAL { ?p wdt:${PROPS.BIRTH_DATE} ?birth }
  OPTIONAL { ?p wdt:${PROPS.BBREF_MAJOR} ?bbref }
  OPTIONAL { ?p wdt:${PROPS.RETROSHEET_PERSON} ?retro }
}`
}
