// Research import file format (bai-research-import/1) and its record-level validation rules.
// The file is the raw source of a batch: sources + records. Nothing in here touches the database.
export const FORMAT = 'bai-research-import/1'

export const SOURCE_AUTHORITIES = ['OFFICIAL', 'PRIMARY_PUBLIC', 'REPUTABLE_SECONDARY', 'AGGREGATOR', 'ARCHIVE', 'OTHER']
export const SOURCE_TYPES = ['OFFICIAL_LEAGUE', 'OFFICIAL_TEAM', 'REFERENCE_DATABASE', 'NEWS_REPORT', 'PUBLICATION_RANKING', 'PUBLIC_RECORD', 'SOCIAL_MEDIA', 'BAI_REFERENCE', 'TEST_FIXTURE', 'OTHER']
export const ID_SYSTEMS = ['MLBAM', 'BBREF', 'BBREF_MINORS', 'FANGRAPHS', 'BASEBALL_PROSPECTUS', 'RETROSHEET', 'NPB', 'KBO', 'CPBL', 'OTHER']
export const PRECISIONS = ['DAY', 'MONTH', 'SEASON', 'YEAR', 'UNKNOWN']
export const PATHWAYS = ['INTERNATIONAL_AMATEUR', 'POSTING_SYSTEM', 'INTERNATIONAL_PROFESSIONAL', 'OTHER']
export const SCHOOL_TYPES = ['HIGH_SCHOOL', 'COLLEGE', 'JUNIOR_COLLEGE', 'OTHER']
export const SIGNING_STATUSES = ['SIGNED', 'DID_NOT_SIGN', 'UNKNOWN']
export const SELECTION_TYPES = ['STANDARD', 'COMPENSATION', 'COMPETITIVE_BALANCE', 'PRIZE', 'SUPPLEMENTAL', 'OTHER']
export const IMPORTABLE_COVERAGE_STATES = ['COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE', 'PARTIAL_RECONSTRUCTION', 'RANKED_SAMPLE', 'INDIVIDUALLY_VERIFIED']
export const EVIDENCE_SUBJECTS = { player: 'players', selection: 'draft_selections', draft_signing: 'draft_signings', signing: 'international_signings', slot: 'slot_values' }

const KEY = /^[a-z0-9][a-z0-9_.:-]*$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const isMoney = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

// Rule 4 round codes as published; the order is a sort key that keeps compensation / balance rounds between regular ones.
export function roundStructure (code) {
  const m = /^(\d+)$/.exec(code)
  if (m) return { order: Number(m[1]) * 10, phase: 'REGULAR' }
  const c = /^C-(\d+)$/.exec(code)
  if (c) return { order: Number(c[1]) * 10 + 3, phase: 'COMPENSATION' }
  if (code === 'CB-A') return { order: 16, phase: 'COMPETITIVE_BALANCE_A' }
  if (code === 'CB-B') return { order: 26, phase: 'COMPETITIVE_BALANCE_B' }
  return null
}

export function slugify (name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Envelope checks. Returns a list of errors (empty = structurally valid). */
export function validateEnvelope (doc) {
  const errors = []
  if (!doc || typeof doc !== 'object') return ['file is not a JSON object']
  if (doc.format !== FORMAT) errors.push(`format must be "${FORMAT}"`)
  if (typeof doc.batch_key !== 'string' || !KEY.test(doc.batch_key)) errors.push('batch_key must match ' + KEY)
  if (!['DRAFT', 'INTERNATIONAL'].includes(doc.channel)) errors.push('channel must be DRAFT or INTERNATIONAL')
  if (!Array.isArray(doc.sources)) errors.push('sources must be an array')
  if (!Array.isArray(doc.records) || doc.records.length === 0) errors.push('records must be a non-empty array')
  for (const c of doc.coverage_claims ?? []) {
    if (!IMPORTABLE_COVERAGE_STATES.includes(c.coverage_state)) errors.push(`coverage claim ${c.scope_key}: unsupported state ${c.coverage_state}`)
    if (!c.scope_key || !c.organization) errors.push('coverage claim needs scope_key and organization')
  }
  const recordType = doc.channel === 'DRAFT' ? 'DRAFT_SELECTION' : 'INTERNATIONAL_SIGNING'
  for (const [i, r] of (Array.isArray(doc.records) ? doc.records : []).entries()) if (r?.type !== recordType) errors.push(`records[${i}]: type must be ${recordType} in a ${doc.channel} batch`)
  const keys = new Set()
  for (const [i, s] of (doc.sources ?? []).entries()) errors.push(...validateSource(s).map((e) => `sources[${i}]: ${e}`))
  for (const s of doc.sources ?? []) { if (keys.has(s.source_key)) errors.push(`duplicate source_key ${s.source_key}`); keys.add(s.source_key) }
  return errors
}

export function validateSource (s) {
  const e = []
  if (!s || typeof s !== 'object') return ['not an object']
  if (!KEY.test(s.source_key ?? '')) e.push('source_key invalid')
  if (!SOURCE_TYPES.includes(s.source_type)) e.push('source_type invalid')
  if (!SOURCE_AUTHORITIES.includes(s.authority_level)) e.push('authority_level required (' + SOURCE_AUTHORITIES.join('|') + ')')
  if (!s.title) e.push('title required')
  if (s.source_type !== 'TEST_FIXTURE' && !s.url && !s.reference) e.push('url or reference required')
  if (s.url && !/^https?:\/\//.test(s.url)) e.push('url must be http(s)')
  if (s.source_type !== 'TEST_FIXTURE' && !isDate(s.retrieved_date)) e.push('retrieved_date required (YYYY-MM-DD)')
  for (const f of ['published_date', 'retrieved_date', 'effective_from', 'effective_to']) if (s[f] != null && !isDate(s[f])) e.push(`${f} must be YYYY-MM-DD`)
  if (s.publicly_accessible === false) e.push('public sources only')
  return e
}

function validatePlayer (p, errors) {
  if (!p || typeof p !== 'object') { errors.push('player block required'); return }
  if (!p.full_name || typeof p.full_name !== 'string') errors.push('player.full_name required')
  if (p.birth_date != null && !isDate(p.birth_date)) errors.push('player.birth_date must be YYYY-MM-DD (day precision only)')
  for (const [k, v] of Object.entries(p.external_ids ?? {})) {
    if (!ID_SYSTEMS.includes(k)) errors.push(`player.external_ids: unknown system ${k}`)
    if (typeof v !== 'string' || !v.trim()) errors.push(`player.external_ids.${k} must be a non-empty string`)
  }
}

function validateDate (obj, dateKey, precKey, label, errors) {
  const d = obj[dateKey]; const p = obj[precKey]
  if (d == null && p == null) return
  if (d == null || p == null) errors.push(`${label}: date and precision go together`)
  else if (!isDate(d)) errors.push(`${label}: date must be YYYY-MM-DD`)
  else if (!PRECISIONS.includes(p)) errors.push(`${label}: precision invalid`)
}

/** Record-level checks that need no database. `declared` = source keys usable by the record. */
export function validateRecordShape (r, channel, declared) {
  const errors = []
  const warnings = []
  const needSource = (k, label) => { if (!k) errors.push(`${label}: source_key required`); else if (!declared.has(k)) errors.push(`${label}: source_key ${k} is not declared in the batch or registered`) }
  needSource(r.source_key, 'record')
  validatePlayer(r.player, errors)
  if (!r.organization) errors.push('organization (franchise key) required')
  for (const [f, k] of Object.entries(r.field_sources ?? {})) needSource(k, `field_sources.${f}`)
  for (const [i, ev] of (r.evidence ?? []).entries()) {
    needSource(ev.source_key, `evidence[${i}]`)
    if (!EVIDENCE_SUBJECTS[ev.subject]) errors.push(`evidence[${i}]: subject must be one of ${Object.keys(EVIDENCE_SUBJECTS).join('|')}`)
    if (!/^[a-z_][a-z0-9_]*$/.test(ev.field ?? '')) errors.push(`evidence[${i}]: field invalid`)
    if (!('value' in ev)) errors.push(`evidence[${i}]: value required (null = source gives no value)`)
  }
  for (const [i, f] of (r.flags ?? []).entries()) if (!/^[A-Z][A-Z0-9_]*$/.test(f.code ?? '') || !['INFO', 'WARNING', 'BLOCKING'].includes(f.severity)) errors.push(`flags[${i}]: code / severity invalid`)

  if (channel === 'DRAFT') {
    if (r.type !== 'DRAFT_SELECTION') errors.push('DRAFT batches hold DRAFT_SELECTION records')
    if (!/^\d{4}-[A-Z_]+$/.test(r.draft_key ?? '')) errors.push('draft_key required, e.g. 2015-JUNE_AMATEUR')
    if (!r.round_code || !roundStructure(r.round_code)) errors.push(`round_code ${r.round_code} not recognised (1..N, C-n, CB-A, CB-B)`)
    if (!Number.isInteger(r.overall_pick) || r.overall_pick < 1) errors.push('overall_pick must be a positive integer')
    if (r.round_pick != null && (!Number.isInteger(r.round_pick) || r.round_pick < 1)) errors.push('round_pick must be a positive integer')
    if (r.selection_type && !SELECTION_TYPES.includes(r.selection_type)) errors.push('selection_type invalid')
    if (r.school) {
      if (!r.school.name) errors.push('school.name required when school is given')
      if (r.school.school_type && !SCHOOL_TYPES.includes(r.school.school_type)) errors.push('school.school_type invalid')
    } else warnings.push('no school given')
    const s = r.signing ?? { status: 'UNKNOWN' }
    if (!SIGNING_STATUSES.includes(s.status)) errors.push('signing.status must be SIGNED | DID_NOT_SIGN | UNKNOWN')
    if (s.status !== 'UNKNOWN') needSource(s.source_key, 'signing')
    if (!isMoney(s.bonus_usd)) errors.push('signing.bonus_usd must be a non-negative number or null (null = unknown)')
    if (s.status === 'DID_NOT_SIGN' && (s.bonus_usd != null || s.date != null)) errors.push('DID_NOT_SIGN carries no bonus or signing date')
    if (s.status === 'UNKNOWN' && (s.bonus_usd != null || s.date != null)) errors.push('UNKNOWN signing status cannot carry a bonus or date')
    validateDate(s, 'date', 'date_precision', 'signing', errors)
    if (r.slot_value) {
      if (!isMoney(r.slot_value.usd) || r.slot_value.usd == null) errors.push('slot_value.usd must be a non-negative number')
      needSource(r.slot_value.source_key, 'slot_value')
    }
  } else {
    if (r.type !== 'INTERNATIONAL_SIGNING') errors.push('INTERNATIONAL batches hold INTERNATIONAL_SIGNING records')
    if (!PATHWAYS.includes(r.pathway)) errors.push('pathway must be one of ' + PATHWAYS.join('|'))
    validateDate(r, 'signing_date', 'signing_date_precision', 'signing', errors)
    if (r.signing_date == null && !r.period_key) errors.push('a signing needs a signing_date or a period_key')
    if (r.signing_date != null && r.signing_date_precision !== 'DAY' && !r.period_key) errors.push('a signing without a day-precision date needs an explicit period_key')
    const costs = r.costs ?? {}
    for (const k of ['signing_bonus_usd', 'posting_fee_usd', 'transfer_fee_usd', 'other_cost_usd']) if (!isMoney(costs[k])) errors.push(`costs.${k} must be a non-negative number or null (null = unknown)`)
    if (Object.values(costs).some((v) => v != null)) needSource(r.cost_source_key ?? r.source_key, 'costs')
    if (r.market && !/^[A-Z]{2,12}$/.test(r.market.key ?? '')) errors.push('market.key must be an uppercase code (ISO 3166-1 alpha-3)')
    if (!r.market) warnings.push('no market given')
  }
  return { errors, warnings }
}

/**
 * Multi-team safety: every record must belong to the declared organization unless it says why not
 * (cross_organization: "<reason>", e.g. a re-draft by another club). Coverage claims must be for that organization.
 */
export function organizationScopeErrors (doc, franchiseKey) {
  const errors = []
  for (const [i, r] of (doc.records ?? []).entries()) {
    if (r.organization !== franchiseKey && !(typeof r.cross_organization === 'string' && r.cross_organization.trim().length >= 5)) {
      errors.push(`records[${i}]: organization ${r.organization} is not ${franchiseKey} (add cross_organization: "<reason>" if this is deliberate)`)
    }
  }
  for (const c of doc.coverage_claims ?? []) if (c.organization !== franchiseKey) errors.push(`coverage claim for ${c.organization} in a ${franchiseKey} batch`)
  return errors
}
