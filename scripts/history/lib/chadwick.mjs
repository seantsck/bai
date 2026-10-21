// Chadwick Baseball Bureau Register (ODC-BY 1.0): MLBAM id -> other systems' ids. Read from the pinned commit's shards.
export const SHARDS = '0123456789abcdef'.split('')

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

// Ids are kept only when well formed; anything else is dropped, never repaired.
const PATTERNS = {
  BBREF: /^[a-z][a-z.'-]*\d{2}$/,
  BBREF_MINORS: /^[a-z-]+\d{3}[a-z-]{3}$/,
  FANGRAPHS: /^(sa)?\d+$/,
  RETROSHEET: /^[a-z][a-z-]{3}\d{3}$/
}

/** Index rows whose key_mlbam is in `wanted` (a Set of strings). Returns Map mlbam -> { ids, mlb_played_first, ... }. */
export function indexShard (text, wanted, into = new Map()) {
  const rows = parseCsv(text)
  const head = rows.shift()
  const col = Object.fromEntries(head.map((h, i) => [h, i]))
  for (const r of rows) {
    const mlbam = r[col.key_mlbam]
    if (!mlbam || !wanted.has(mlbam)) continue
    if (into.has(mlbam)) { into.get(mlbam).duplicate = true; continue }
    const ids = {}
    for (const [sys, key] of [['BBREF', 'key_bbref'], ['BBREF_MINORS', 'key_bbref_minors'], ['FANGRAPHS', 'key_fangraphs'], ['RETROSHEET', 'key_retro']]) {
      const v = (r[col[key]] ?? '').trim()
      if (v && PATTERNS[sys].test(v)) ids[sys] = v
    }
    into.set(mlbam, {
      ids,
      name: [r[col.name_first], r[col.name_last]].filter(Boolean).join(' '),
      birth: [r[col.birth_year], r[col.birth_month], r[col.birth_day]].map((x) => x || null),
      pro_played_first: Number(r[col.pro_played_first]) || null,
      mlb_played_first: Number(r[col.mlb_played_first]) || null,
      mlb_played_last: Number(r[col.mlb_played_last]) || null
    })
  }
  return into
}
