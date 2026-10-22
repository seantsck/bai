// Retrosheet transactions (draft records only). Evidence about who was drafted, by whom, and whether they signed: never the
// draft population. Retrosheet lists people it tracks (almost all reached the majors), so a missing record means nothing.
//   Terms (research/history/sources.json, retrosheet-transactions): any use, with the attribution statement shown.
import zlib from 'node:zlib'
import { parseCsv } from './chadwick.mjs'

export const RETROSHEET_ATTRIBUTION = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'
export const DRAFT_TYPES = { Da: 'SELECTED_AND_SIGNED', Dn: 'SELECTED_DID_NOT_SIGN', Dv: 'SELECTION_VOIDED' }

// Retrosheet club codes -> BAI franchise keys. A code not listed is reported, never guessed.
export const RETRO_TEAM_CODES = {
  ANA: 'LAA', CAL: 'LAA', LAA: 'LAA', ARI: 'ARI', ATL: 'ATL', MLN: 'ATL', BAL: 'BAL', BOS: 'BOS', CHN: 'CHC', CHA: 'CWS', CIN: 'CIN',
  CLE: 'CLE', COL: 'COL', DET: 'DET', FLO: 'MIA', MIA: 'MIA', HOU: 'HOU', KCA: 'KC', KC1: 'ATH', LAN: 'LAD', MIL: 'MIL', SE1: 'MIL', MIN: 'MIN',
  MON: 'WSH', WAS: 'WSH', NYA: 'NYY', NYN: 'NYM', OAK: 'ATH', ATH: 'ATH', PHI: 'PHI', PIT: 'PIT', SDN: 'SD', SEA: 'SEA', SFN: 'SF',
  SLN: 'STL', TBA: 'TB', WS2: 'TEX', TEX: 'TEX', TOR: 'TOR'
}

/** Minimal ZIP reader (central directory + raw deflate or stored). No dependency, bounds-checked. */
export function readZipEntry (zip, name) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > zip.length) throw new Error('not a zip file (no end-of-central-directory record)')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = zip.readUInt16LE(p + 10)
    const csize = zip.readUInt32LE(p + 20)
    const usize = zip.readUInt32LE(p + 24)
    const nlen = zip.readUInt16LE(p + 28)
    const elen = zip.readUInt16LE(p + 30)
    const clen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const entryName = zip.subarray(p + 46, p + 46 + nlen).toString('latin1')
    if (entryName === name) {
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header')
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + csize)
      if (data.length !== csize) throw new Error('truncated zip entry')
      const out = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null
      if (!out) throw new Error(`unsupported zip method ${method}`)
      if (out.length !== usize) throw new Error('zip entry size mismatch')
      return out
    }
    p += 46 + nlen + elen + clen
  }
  throw new Error(`${name} not found in zip`)
}

const MAX_DRAFT_CODE = { '': 'R', S: 'S', A: 'A', L: 'L', D: 'D' }

/** Which BAI phase code a Retrosheet draft type implies, or null when it does not map unambiguously. */
export function phaseHint (draftType, dateYmd) {
  const month = Number(String(dateYmd).slice(4, 6))
  const t = MAX_DRAFT_CODE[draftType ?? '']
  if (t === 'R' && month >= 5 && month <= 8) return 'JR'
  if (t === 'R' && month >= 1 && month <= 4) return 'NR'
  if (t === 'S' && month >= 5 && month <= 8) return 'JS'
  if (t === 'S' && month >= 1 && month <= 4) return 'NS'
  if (t === 'L') return 'AL'
  return null   // A (secondary active), D (Dominican) and undated rows are kept raw, never guessed
}

/** Draft records (Da/Dn/Dv) from transactions text. Returns { records, unknownTeams, skipped }. */
export function parseDraftTransactions (text) {
  const records = []
  const unknownTeams = new Map()
  let skipped = 0
  for (const r of parseCsv(text)) {
    const type = r[7]
    if (!(type in DRAFT_TYPES)) continue
    const date = r[0]
    if (!/^\d{8}$/.test(date)) { skipped++; continue }
    const player = (r[6] ?? '').trim()
    if (!player) { skipped++; continue }
    const idLike = /^[a-z][a-z-]{3}[a-z0-9]\d{3}$/.test(player)
    const team = (r[10] ?? '').trim()
    const franchise = RETRO_TEAM_CODES[team] ?? null
    if (team && !franchise) unknownTeams.set(team, (unknownTeams.get(team) ?? 0) + 1)
    const signed = (r[3] ?? '').trim()
    records.push({
      transaction_id: Number(r[5]) || null,
      retrosheet_id: idLike ? player : null,
      name_only: idLike ? null : player,
      draft_year: Number(date.slice(0, 4)),
      draft_date: date,
      status: DRAFT_TYPES[type],
      signing_date: type === 'Da' && /^\d{8}$/.test(signed) && !signed.endsWith('0000') ? signed : null,
      club_code: team,
      franchise,
      draft_type: (r[12] ?? '').trim(),
      phase_hint: phaseHint((r[12] ?? '').trim(), date),
      round: (r[13] ?? '').trim() || null,
      pick: (r[14] ?? '').trim() || null
    })
  }
  return { records, unknownTeams: Object.fromEntries(unknownTeams), skipped }
}

/** Per-year counts: what Retrosheet holds, so it is never mistaken for the population. */
export function coverageByYear (records) {
  const out = {}
  for (const r of records) {
    const y = (out[r.draft_year] ??= { records: 0, selected_and_signed: 0, did_not_sign: 0, voided: 0, with_retrosheet_id: 0 })
    y.records++
    if (r.status === 'SELECTED_AND_SIGNED') y.selected_and_signed++
    else if (r.status === 'SELECTED_DID_NOT_SIGN') y.did_not_sign++
    else y.voided++
    if (r.retrosheet_id) y.with_retrosheet_id++
  }
  return out
}

// --- name comparison (conservative: a stronger claim than the evidence supports is never made) -------------------------

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim()
export const splitName = (full) => {
  const parts = fold(full).replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, '').trim().split(' ')
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') }
}
// Common given-name short forms; anything else must match exactly.
const SHORT = { jim: 'james', jimmy: 'james', joe: 'joseph', joey: 'joseph', bob: 'robert', bobby: 'robert', rob: 'robert', bill: 'william', billy: 'william', will: 'william', mike: 'michael', dave: 'david', dan: 'daniel', danny: 'daniel', tom: 'thomas', tommy: 'thomas', chris: 'christopher', rick: 'richard', rich: 'richard', dick: 'richard', ron: 'ronald', don: 'donald', donnie: 'donald', ken: 'kenneth', steve: 'steven', stephen: 'steven', frank: 'francis', fran: 'francis', jack: 'john', johnny: 'john', jon: 'john', charlie: 'charles', chuck: 'charles', jonathon: 'jonathan', ed: 'edward', eddie: 'edward', ted: 'theodore', tony: 'anthony', andy: 'andrew', matt: 'matthew', pat: 'patrick', ray: 'raymond', larry: 'lawrence', jerry: 'gerald', jeff: 'jeffrey', greg: 'gregory', tim: 'timothy', phil: 'philip', ben: 'benjamin', sam: 'samuel', alex: 'alexander', nick: 'nicholas', josh: 'joshua', zach: 'zachary', jake: 'jacob', nate: 'nathan' }
const canon = (g) => SHORT[g] ?? g

/** 'EXACT' | 'SAME_SURNAME_COMPATIBLE_FIRST' | 'SAME_SURNAME_DIFFERENT_FIRST' | 'DIFFERENT_SURNAME' */
export function compareNames (a, b) {
  const x = splitName(a)
  const y = splitName(b)
  if (!x.last || x.last !== y.last) return 'DIFFERENT_SURNAME'
  if (x.first === y.first) return 'EXACT'
  if (canon(x.first) === canon(y.first) || (x.first.length === 1 && y.first.startsWith(x.first)) || (y.first.length === 1 && x.first.startsWith(y.first))) return 'SAME_SURNAME_COMPATIBLE_FIRST'
  return 'SAME_SURNAME_DIFFERENT_FIRST'
}

/** Index Chadwick shard text by Retrosheet id for the wanted ids: id -> { name, birth }. */
export function namesByRetrosheetId (shardText, wanted, into = new Map()) {
  const rows = parseCsv(shardText)
  const head = rows.shift()
  const col = Object.fromEntries(head.map((h, i) => [h, i]))
  for (const r of rows) {
    const id = (r[col.key_retro] ?? '').trim()
    if (!id || !wanted.has(id)) continue
    into.set(id, { name: [r[col.name_first], r[col.name_last]].filter(Boolean).join(' '), birth: [r[col.birth_year], r[col.birth_month], r[col.birth_day]].map((x) => x || null) })
  }
  return into
}
