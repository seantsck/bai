// Retrosheet player ids -> BAI identity. Reuses the pinned Chadwick Register (ODC-BY; shards of one commit) as the crosswalk and
// BAI's own player ids as the second witness. A name alone never links a player; a missing id is never invented.
import fs from 'node:fs'
import path from 'node:path'
import { parseCsv, SHARDS } from '../../history/lib/chadwick.mjs'

export const IDENTITY_STATES = {
  STRONG: 'one register person carries this Retrosheet id and an MLBAM id, and the id is consistent with the person\'s name',
  ID_NAME_PATTERN_MISMATCH: 'the register links the id to a person whose name does not fit the id (held)',
  REGISTER_WITHOUT_MLBAM: 'the register knows the Retrosheet id but holds no MLBAM id (held)',
  REGISTER_AMBIGUOUS: 'more than one register person carries this Retrosheet id (held)',
  NOT_IN_REGISTER: 'the Retrosheet id is not in the register (held)',
  BAI_CONFLICT: 'BAI already holds this id or MLBAM id on a different player (held)',
  NAME_ONLY: 'the source gives a name and no id: never matched by name (held)'
}

/** Retrosheet ids are four letters of the surname (padded with "-"), the first initial and three digits. */
export function idFitsName (retroId, last, first) {
  const letters = String(last ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')
  const stem = (letters + '----').slice(0, 4)
  const initial = String(first ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '')[0]
  return retroId.slice(0, 4) === stem && retroId[4] === initial
}

/** Index register rows whose key_retro is wanted: Map retro -> rows[]. Reads the pinned shards, nothing else. */
export function indexRegisterByRetro (shardDir, wanted) {
  const out = new Map()
  for (const s of SHARDS) {
    const file = path.join(shardDir, `people-${s}.csv`)
    const rows = parseCsv(fs.readFileSync(file, 'utf8'))
    const head = rows.shift()
    const col = Object.fromEntries(head.map((h, i) => [h, i]))
    for (const r of rows) {
      const retro = r[col.key_retro]
      if (!retro || !wanted.has(retro)) continue
      if (!out.has(retro)) out.set(retro, [])
      out.get(retro).push({ key_person: r[col.key_person], mlbam: r[col.key_mlbam] || null, bbref: r[col.key_bbref] || null, fangraphs: r[col.key_fangraphs] || null,
        name_first: r[col.name_first], name_last: r[col.name_last], birth: [r[col.birth_year], r[col.birth_month], r[col.birth_day]].every(Boolean) ? `${r[col.birth_year]}-${String(r[col.birth_month]).padStart(2, '0')}-${String(r[col.birth_day]).padStart(2, '0')}` : null,
        mlb_played_first: r[col.mlb_played_first] || null, mlb_played_last: r[col.mlb_played_last] || null })
    }
  }
  return out
}

/**
 * Resolve one Retrosheet id. bai = { byMlbam: Map mlbam -> {id, retro}, byRetro: Map retro -> {id, mlbam} } (BAI's own players).
 * Returns { state, evidence } where evidence preserves the source-to-canonical chain.
 */
export function resolveRetroId (retroId, register, bai) {
  const rows = register.get(retroId) ?? []
  const evidence = { retrosheet_id: retroId, register_rows: rows.map((r) => ({ key_person: r.key_person, mlbam: r.mlbam })) }
  if (rows.length === 0) return { state: 'NOT_IN_REGISTER', evidence }
  if (rows.length > 1) return { state: 'REGISTER_AMBIGUOUS', evidence }
  const p = rows[0]
  Object.assign(evidence, { mlbam: p.mlbam, bbref: p.bbref, name: `${p.name_first} ${p.name_last}`.trim(), birth_date: p.birth, mlb_played_first: p.mlb_played_first, mlb_played_last: p.mlb_played_last })
  if (!p.mlbam) return { state: 'REGISTER_WITHOUT_MLBAM', evidence }
  const mine = bai.byMlbam.get(p.mlbam)
  const holder = bai.byRetro.get(retroId)
  evidence.bai_player_id = mine?.id ?? holder?.id ?? null
  if ((holder && holder.mlbam && holder.mlbam !== p.mlbam) || (mine && mine.retro && mine.retro !== retroId)) {
    evidence.bai_detail = { by_retro: holder ?? null, by_mlbam: mine ?? null }
    return { state: 'BAI_CONFLICT', evidence }
  }
  if (!idFitsName(retroId, p.name_last, p.name_first)) return { state: 'ID_NAME_PATTERN_MISMATCH', evidence }
  evidence.witnesses = ['chadwick-register key_retro -> key_mlbam', 'retrosheet id pattern fits register name', ...(mine || holder ? ['BAI player already holds the same MLBAM/Retrosheet id'] : [])]
  return { state: 'STRONG', evidence }
}

/** Resolve every Retrosheet id in rows; returns Map retro -> {state, evidence}. */
export function resolveAll (rows, register, bai) {
  const out = new Map()
  for (const r of rows) {
    if (r.malformed || r.player.kind !== 'RETROSHEET_ID' || out.has(r.player.retro_id)) continue
    out.set(r.player.retro_id, resolveRetroId(r.player.retro_id, register, bai))
  }
  return out
}

/** Players with several acquisitions or several organizations in the period (resolved ids only). */
export function repeatActivity (groups, resolved) {
  const by = new Map()
  for (const g of groups) {
    for (const r of g.rows) {
      if (r.player.kind !== 'RETROSHEET_ID' || g.acquisition_class == null) continue
      const e = by.get(r.player.retro_id) ?? { acquisitions: 0, clubs: new Set(), seasons: new Set() }
      e.acquisitions++
      if (r.to.kind === 'MLB') e.clubs.add(r.to.franchise)
      e.seasons.add(g.season)
      by.set(r.player.retro_id, e)
    }
  }
  const out = { players_with_acquisitions: by.size, repeat_acquisition_players: 0, multi_organization_players: 0, resolved_repeat: 0 }
  for (const [id, e] of by) {
    if (e.acquisitions > 1) { out.repeat_acquisition_players++; if (resolved.get(id)?.state === 'STRONG') out.resolved_repeat++ }
    if (e.clubs.size > 1) out.multi_organization_players++
  }
  return out
}
