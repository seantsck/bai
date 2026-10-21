// MLB Stats API draft data -> normalized historical selections. Pure functions (no I/O), so the transformation is
// deterministic and testable: the same cached file always gives the same picks, duplicates and findings.

// MLB draftType codes -> BAI draft_kind (024). Rule V phases are not amateur acquisitions and are not imported.
export const PHASES = {
  JR: { kind: 'JUNE_AMATEUR', label: 'June regular phase', month: 6 },
  NR: { kind: 'JANUARY_REGULAR', label: 'January regular phase', month: 1 },
  NS: { kind: 'JANUARY_SECONDARY', label: 'January secondary phase', month: 1 },
  JS: { kind: 'JUNE_SECONDARY', label: 'June secondary phase', month: 6 },
  JD: { kind: 'JUNE_SECONDARY_DELAYED', label: 'June secondary phase (delayed)', month: 6 },
  AL: { kind: 'AUGUST_LEGION', label: 'August American Legion phase', month: 8 }
}

export const draftKey = (year, code) => `${year}-${PHASES[code].kind}`

/** MLB round labels -> BAI round codes: "1C"/"C-1" compensation, "CB-A"/"CBA" competitive balance, plain numbers pass. */
export function roundCode (label) {
  const s = String(label).trim().toUpperCase()
  let m
  if ((m = s.match(/^(\d+)C$/))) return `C-${m[1]}`
  if ((m = s.match(/^C-?(\d+)$/))) return `C-${m[1]}`
  if ((m = s.match(/^CB-?([AB])$/))) return `CB-${m[1]}`
  if ((m = s.match(/^(\d+)S$/))) return `S-${m[1]}`
  if (/^\d+$/.test(s)) return String(Number(s))
  return s
}

export const selectionType = (code) => /^CB-/.test(code) ? 'COMPETITIVE_BALANCE' : /^C-/.test(code) ? 'COMPENSATION' : /^S-/.test(code) ? 'SUPPLEMENTAL' : 'STANDARD'

/**
 * School label -> { name, school_type | null, rule }. MLB's labels are free text ("Great Bridge HS, VA",
 * "Crenshaw HS (Los Angeles, CA)", "Arizona State"). The type is taken only from explicit words in the label; anything
 * else stays untyped (the pipeline then records the school as unresolved instead of inventing a type).
 */
export function schoolFromLabel (label) {
  const name = String(label ?? '').trim()
  if (!name) return null
  const parts = name.match(/^(.*?)\s*\(([^,]+),\s*([^)]+)\)$/) ?? name.match(/^(.*?),\s*([A-Z]{2})$/)
  const base = parts ? parts[1] : name
  const city = parts && parts.length === 4 ? parts[2] : null
  const region = parts ? (parts.length === 4 ? parts[3] : parts[2]) : null
  const t = ` ${base} `
  const type = /\b(HS|H\.S\.|High School|Academy|Prep)\b/i.test(t) ? 'HIGH_SCHOOL'
    : /\b(JC|J\.C\.|CC|Junior College|Community College)\b/i.test(t) ? 'JUNIOR_COLLEGE'
      : /\b(University|Univ\.?|State|College|Institute|Tech)\b/i.test(t) ? 'COLLEGE' : null
  return { name, school_type: type, city, region, rule: type ? 'type from explicit words in MLB\'s label' : 'type not stated in MLB\'s label' }
}

/** Picks of one phase file, sorted by overall pick, with duplicate and integrity findings. */
export function normalizePhase (json, { year, code }) {
  const rounds = json?.drafts?.rounds ?? []
  const raw = rounds.flatMap((r) => r.picks ?? [])
  const findings = []
  const picks = []
  for (const p of raw) {
    if (p.draftType?.code && p.draftType.code !== code) { findings.push({ kind: 'WRONG_PHASE', pick: p.pickNumber, detail: `${p.draftType.code} in a ${code} file` }); continue }
    if (String(p.year ?? year) !== String(year)) { findings.push({ kind: 'WRONG_YEAR', pick: p.pickNumber, detail: String(p.year) }); continue }
    if (!p.isDrafted || p.isPass) { findings.push({ kind: 'NOT_A_SELECTION', pick: p.pickNumber, detail: p.isPass ? 'pass' : 'isDrafted false' }); continue }
    if (!p.person?.id || !p.team?.id || !p.pickNumber) { findings.push({ kind: 'INCOMPLETE', pick: p.pickNumber ?? null, detail: 'missing person, team or pick number' }); continue }
    const code2 = roundCode(p.pickRound)
    picks.push({
      year, phase: code, draft_key: draftKey(year, code), overall_pick: p.pickNumber, round_code: code2, round_pick: p.roundPickNumber ?? null,
      selection_type: selectionType(code2), team_id: p.team.id, team_name_now: p.team.name,
      person: { id: String(p.person.id), full_name: p.person.fullName, birth_date: p.person.birthDate ?? null, birth_country: p.person.birthCountry ?? null,
        position: p.person.primaryPosition?.abbreviation ?? null, mlb_debut: p.person.mlbDebutDate ?? null },
      school: schoolFromLabel(p.school?.name), bis_player_id: p.bisPlayerId ?? null
    })
  }
  picks.sort((a, b) => a.overall_pick - b.overall_pick)
  // Same overall pick twice, or one person at two picks of one phase: the database allows neither, so both are reported
  // and the later pick is held (never silently dropped or merged).
  const byPick = new Map()
  const byPerson = new Map()
  for (const p of picks) {
    if (byPick.has(p.overall_pick)) findings.push({ kind: 'DUPLICATE_PICK_NUMBER', pick: p.overall_pick, detail: `${byPick.get(p.overall_pick).person.full_name} / ${p.person.full_name}` })
    else byPick.set(p.overall_pick, p)
    const first = byPerson.get(p.person.id)
    if (first) {
      findings.push({ kind: 'SAME_PERSON_TWICE', pick: p.overall_pick, detail: `MLBAM ${p.person.id} ${p.person.full_name}: #${first.overall_pick} (team ${first.team_id}) and #${p.overall_pick} (team ${p.team_id})` })
      p.hold = `same MLBAM person as pick #${first.overall_pick} in this phase`
    } else byPerson.set(p.person.id, p)
  }
  const numbers = picks.map((p) => p.overall_pick)
  const gaps = []
  for (let n = 1; n <= Math.max(0, ...numbers); n++) if (!byPick.has(n)) gaps.push(n)
  if (gaps.length) findings.push({ kind: 'PICK_NUMBER_GAPS', pick: null, detail: `${gaps.length} missing overall pick number(s): ${gaps.slice(0, 20).join(', ')}${gaps.length > 20 ? ' ...' : ''}` })
  return { picks, findings, rawCount: raw.length }
}
