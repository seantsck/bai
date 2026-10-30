// Non-trade acquisitions (migration 030): the ACQUISITION record of the research pipeline. One record is one transaction in which a club acquired one
// player: a free-agent signing, an amateur free-agent signing, a waiver claim, a purchase or a Rule 5 selection. It reuses the identity (a strong id only),
// provenance (transaction sources with an independence group), transaction, conflict and coverage structures of 028.
//
// What is NOT an acquisition and is never staged here: a departure (free agent granted, release), a void, a return, a roster-status change, and a DRAFT
// SELECTION. Draft selections live in the draft tables; a source reporting the draft event does not make a signing. Salaries, contract values and
// service-time control are not recorded and never inferred.
import crypto from 'node:crypto'
import { stableStringify } from './transactions.mjs'

export const ACQUISITION_SCHEMA = 1
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const GROUP = /^[a-z0-9][a-z0-9_.:-]{1,80}$/
const SCHEME = /^[A-Z][A-Z0-9_]{1,30}$/
export const ACQUISITION_CLASSES = {
  FREE_AGENT: { transaction_type: 'FREE_AGENT_SIGNING', codes: ['F', 'Fo'], from: 'NONE' },
  AMATEUR_FREE_AGENT: { transaction_type: 'AMATEUR_FREE_AGENT_SIGNING', codes: ['Fa', 'Fb'], from: 'NONE' },
  WAIVER: { transaction_type: 'WAIVER_CLAIM', codes: ['W', 'Wf'], from: 'ORGANIZATION' },
  PURCHASE: { transaction_type: 'PURCHASE', codes: ['P'], from: 'ANY' },
  RULE_5: { transaction_type: 'RULE_5', codes: ['D'], from: 'ORGANIZATION' }
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

export function canonicalizeAcquisition (r) {
  const out = {
    type: 'ACQUISITION', schema: ACQUISITION_SCHEMA, ref: r.ref, organization: r.organization, acquisition_class: r.acquisition_class, transaction_type: r.transaction_type,
    date: r.date, date_precision: r.date_precision ?? 'DAY', source_key: r.source_key,
    sources: [...(r.sources ?? [])].map((s) => ({ source_key: s.source_key, role: s.role, independence_group: s.independence_group, locator: s.locator ?? null, retrieved_on: s.retrieved_on ?? null })).sort((a, b) => (a.source_key < b.source_key ? -1 : 1)),
    external_ids: [...(r.external_ids ?? [])].map((x) => ({ scheme: x.scheme, id: String(x.id), source_key: x.source_key ?? r.source_key })).sort((a, b) => (a.scheme < b.scheme ? -1 : 1)),
    move: { player: r.move.player, to_organization: r.move.to_organization, from_organization: r.move.from_organization ?? null, from_club_text: r.move.from_club_text ?? null, source_event_code: r.move.source_event_code, source_info: r.move.source_info ?? null }
  }
  return JSON.parse(stableStringify(out))
}

export function prepareAcquisitionDoc (doc) {
  const out = { ...doc, sources: [...(doc.sources ?? [])].sort((a, b) => (a.source_key < b.source_key ? -1 : 1)), records: (doc.records ?? []).map(canonicalizeAcquisition) }
  out.records.sort((a, b) => { const x = a.external_ids.map((i) => `${i.scheme}:${i.id}`).join('|'); const y = b.external_ids.map((i) => `${i.scheme}:${i.id}`).join('|'); return x < y ? -1 : x > y ? 1 : 0 })
  return JSON.parse(stableStringify(out))
}
export const prepareAcquisitionText = (doc) => JSON.stringify(prepareAcquisitionDoc(doc), null, 2) + '\n'

/** Shape rules for one ACQUISITION record; no database. */
export function validateAcquisition (r, errors, warnings, needSource) {
  if (r.type !== 'ACQUISITION') errors.push('ACQUISITIONS batches hold ACQUISITION records')
  if (r.schema !== ACQUISITION_SCHEMA) errors.push(`schema must be ${ACQUISITION_SCHEMA}`)
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(r.ref ?? '')) errors.push('ref required (lowercase key)')
  const cls = ACQUISITION_CLASSES[r.acquisition_class]
  if (!cls) errors.push(`acquisition_class must be ${Object.keys(ACQUISITION_CLASSES).join('|')} (departures, voids, draft selections and roster-status rows are not acquisitions)`)
  else if (r.transaction_type !== cls.transaction_type) errors.push(`${r.acquisition_class} is transaction_type ${cls.transaction_type}`)
  if (!isDate(r.date)) errors.push('date must be YYYY-MM-DD')
  if (r.date_precision !== undefined && r.date_precision !== 'DAY') errors.push('only a day-precise date is staged (an unknown date is never made exact)')
  const keys = new Set()
  if (!Array.isArray(r.sources) || r.sources.length === 0) errors.push('sources must list every source of the record, each with a role and an independence_group')
  for (const [i, s] of (r.sources ?? []).entries()) {
    needSource(s.source_key, `sources[${i}]`)
    if (keys.has(s.source_key)) errors.push(`sources[${i}]: ${s.source_key} listed twice`)
    keys.add(s.source_key)
    if (!['PRIMARY_ANNOUNCEMENT', 'CORROBORATION', 'REFERENCE'].includes(s.role)) errors.push(`sources[${i}]: role invalid`)
    if (!GROUP.test(s.independence_group ?? '')) errors.push(`sources[${i}]: independence_group required`)
  }
  if (r.source_key && !keys.has(r.source_key)) errors.push('source_key must be one of sources[]')
  if (!Array.isArray(r.external_ids) || r.external_ids.length === 0) errors.push('external_ids required')
  const schemes = new Set()
  for (const [i, x] of (r.external_ids ?? []).entries()) {
    if (!SCHEME.test(x.scheme ?? '')) errors.push(`external_ids[${i}]: scheme invalid`)
    if (typeof x.id !== 'string' || !x.id.trim()) errors.push(`external_ids[${i}]: id must be a non-empty string`)
    if (schemes.has(x.scheme)) errors.push(`external_ids[${i}]: two identifiers in scheme ${x.scheme}`)
    schemes.add(x.scheme)
  }
  const m = r.move
  if (!m || typeof m !== 'object') { errors.push('move required'); return }
  if (!m.player?.full_name) errors.push('move.player.full_name required')
  else if (!m.player.external_ids?.MLBAM) errors.push('a player is identified by an MLBAM id (anything weaker waits for a researcher)')
  if (!m.to_organization) errors.push('move.to_organization required')
  if (r.organization !== m.to_organization) errors.push('organization is the acquiring club (move.to_organization)')
  if (m.from_organization && m.from_club_text) errors.push('a move comes from a club or a named team, not both')
  if (m.from_organization && m.from_organization === m.to_organization) errors.push('a club cannot acquire a player from itself')
  if (m.source_info != null && typeof m.source_info !== 'string') errors.push('move.source_info is the source\'s own note as text')
  if (!m.source_event_code || typeof m.source_event_code !== 'string') errors.push('move.source_event_code required (the source\'s own code is kept)')
  if (cls) {
    if (m.source_event_code && !cls.codes.includes(m.source_event_code)) errors.push(`event code ${m.source_event_code} is not a ${r.acquisition_class} code (${cls.codes.join('|')})`)
    if (cls.from === 'NONE' && (m.from_organization || m.from_club_text)) errors.push(`${r.acquisition_class} has no from-club`)
    if (cls.from === 'ORGANIZATION' && !m.from_organization) errors.push(`${r.acquisition_class} comes from another club (move.from_organization)`)
  }
}

/** Rules across one batch: shared identity with different content, and the same player acquired twice by the same club on the same day. */
export function batchProblemsAcquisitions (records) {
  const problems = new Map()
  const add = (i, m) => problems.set(i, [...(problems.get(i) ?? []), m])
  const byId = new Map(); const byMove = new Map()
  for (const [i, r] of records.entries()) {
    for (const x of r.external_ids ?? []) {
      const k = `${x.scheme}:${x.id}`
      if (byId.has(k)) add(i, `identity ${k} is also used by record ${byId.get(k)}`)
      else byId.set(k, i)
    }
    const mk = `${r.move?.player?.external_ids?.MLBAM}|${r.move?.to_organization}|${r.date}|${r.transaction_type}`
    if (byMove.has(mk)) add(i, `the same acquisition (player, club, day, type) is also record ${byMove.get(mk)}`)
    else byMove.set(mk, i)
  }
  return problems
}

export const contentSha = (r) => sha(stableStringify(canonicalizeAcquisition(r)))

/**
 * Plan one record against canonical data (reads only). kind: NEW | EXISTING | COLLISION | CONFLICT.
 * COLLISION: the same player, club, day and type is already recorded under a different identity (a duplicate acquisition is never inserted).
 */
export async function planAcquisition (a, r, { identityInput }) {
  const ids = (r.external_ids ?? []).map((x) => `${x.scheme}:${x.id}`)
  const hits = (await a.q('select distinct transaction_id from public.transaction_external_ids where scheme || \':\' || external_id = any ($1)', [ids])).rows.map((x) => String(x.transaction_id))
  const res = await a.one('select * from ingest.resolve_identity($1)', [identityInput(r.move.player)])
  if (!['EXACT_EXTERNAL_ID', 'NO_MATCH'].includes(res.state)) throw new Error(`player ${r.move.player.full_name}: identity ${res.state}; decide it before importing`)
  const playerId = res.state === 'EXACT_EXTERNAL_ID' ? String(res.player_id) : null
  const plan = { kind: 'NEW', transactionId: null, playerId, conflicts: [], collisions: [] }
  if (hits.length > 1) { plan.kind = 'CONFLICT'; plan.conflicts.push({ field_path: 'external_ids', existing: `identities point at transactions ${hits.join(', ')}`, incoming: ids.join(', ') }); return plan }
  if (hits.length === 1) {
    plan.kind = 'EXISTING'; plan.transactionId = hits[0]
    const t = await a.one(`select to_char(t.transaction_date, 'YYYY-MM-DD') d, t.transaction_type::text ty, m.player_id, m.source_event_code code, m.source_info,
        (select franchise_key from public.organizations where id = m.to_organization_id) to_org, (select franchise_key from public.organizations where id = m.from_organization_id) from_org, m.from_club_text
      from public.transactions t left join public.transaction_player_moves m on m.transaction_id = t.id where t.id = $1`, [hits[0]])
    const c = (f, e, i) => plan.conflicts.push({ field_path: f, existing: String(e), incoming: String(i) })
    if (t.d !== r.date) c('date', t.d, r.date)
    if (t.ty !== r.transaction_type) c('transaction_type', t.ty, r.transaction_type)
    if (t.to_org !== r.move.to_organization) c('to_organization', t.to_org, r.move.to_organization)
    if ((t.from_org ?? null) !== (r.move.from_organization ?? null)) c('from_organization', t.from_org, r.move.from_organization)
    if ((t.from_club_text ?? null) !== (r.move.from_club_text ?? null)) c('from_club_text', t.from_club_text, r.move.from_club_text)
    if (t.code !== r.move.source_event_code) c('source_event_code', t.code, r.move.source_event_code)
    if ((t.source_info ?? null) !== (r.move.source_info ?? null)) c('source_info', t.source_info, r.move.source_info)
    if (playerId && String(t.player_id) !== playerId) c('player', t.player_id, playerId)
    if (plan.conflicts.length) plan.kind = 'CONFLICT'
    return plan
  }
  if (playerId) {
    const dup = (await a.q(`select t.id from public.transactions t join public.transaction_player_moves m on m.transaction_id = t.id join public.organizations o on o.id = m.to_organization_id
      where m.player_id = $1 and o.franchise_key = $2 and t.transaction_date = $3 and t.transaction_type::text = $4`, [playerId, r.move.to_organization, r.date, r.transaction_type])).rows
    if (dup.length) { plan.kind = 'COLLISION'; plan.collisions = dup.map((x) => String(x.id)) }
  }
  return plan
}

/** Apply one ACQUISITION record. a = the pipeline's Applier. Returns { action, reason?, canonical, newPlayers }. */
export async function applyAcquisition (a, rec, { identityInput, PipelineError, conflicts: sink }) {
  const r = rec.payload
  const batchId = a.batch.id
  const prior = await a.one('select action from ingest.transaction_apply_ledger where import_batch_id = $1 and record_index = $2', [batchId, rec.record_index])
  if (prior) return { action: 'NO_CHANGE', reason: 'replay: this record was already applied by this batch', canonical: null, newPlayers: 0 }
  const plan = await planAcquisition(a, r, { identityInput })
  if (plan.kind === 'COLLISION') return { action: 'HELD', reason: `COLLISION: the same player, club, day and type is already recorded as transaction ${plan.collisions.join(', ')} under another identity`, canonical: null, newPlayers: 0 }
  if (plan.kind === 'CONFLICT') {
    if (plan.transactionId) {
      for (const c of plan.conflicts) {
        await a.q(`insert into public.transaction_conflicts (transaction_id, field_path, existing_value, incoming_value, incoming_sha256, import_batch_id) values ($1, $2, $3, $4, $5, $6)
          on conflict (transaction_id, incoming_sha256, field_path) do nothing`, [plan.transactionId, c.field_path, c.existing, c.incoming, rec.record_sha256, batchId])
      }
    }
    sink?.push(...plan.conflicts.map((c) => ({ table: 'transactions', id: plan.transactionId, field: c.field_path, incoming: c.incoming, canonical: c.existing })))
    return { action: 'HELD', reason: `CONFLICT: ${plan.conflicts.map((c) => `${c.field_path} (${c.existing} vs ${c.incoming})`).join('; ')}`, canonical: plan.transactionId ? ['transactions', plan.transactionId] : null, newPlayers: 0 }
  }
  let changed = false; let created = false; let newPlayers = 0
  let txId = plan.transactionId
  const src = (k) => a.sourceId(k)
  if (!txId) {
    txId = String((await a.one('insert into public.transactions (transaction_type, transaction_date, date_precision, description, source_id) values ($1::public.transaction_type, $2, $3, null, $4) returning id',
      [r.transaction_type, r.date, r.date_precision ?? 'DAY', await src(r.source_key)])).id)
    changed = true; created = true
  }
  const ins = async (sql, params) => { const x = await a.q(sql, params); if (x.rowCount) changed = true; return x }
  for (const x of r.external_ids) await ins('insert into public.transaction_external_ids (transaction_id, scheme, external_id, source_id) values ($1, $2, $3, $4) on conflict do nothing', [txId, x.scheme, x.id, await src(x.source_key ?? r.source_key)])
  for (const s of r.sources) await ins('insert into public.transaction_sources (transaction_id, source_id, role, independence_group, locator, retrieved_on) values ($1, $2, $3, $4, $5, $6) on conflict (transaction_id, source_id) do nothing',
    [txId, await src(s.source_key), s.role, s.independence_group, s.locator ?? null, s.retrieved_on ?? null])
  const p = r.move.player
  const res = await a.one('select * from ingest.resolve_identity($1)', [identityInput(p)])
  let playerId
  if (res.state === 'EXACT_EXTERNAL_ID') playerId = res.player_id
  else if (res.state === 'NO_MATCH') { playerId = await a.createPlayer(p, p.source_key ?? r.source_key); newPlayers++; changed = true } else throw new PipelineError(`player ${p.full_name}: identity ${res.state}`)
  await a.attachIdentifiers(playerId, p, p.source_key ?? r.source_key)
  const to = await a.organizationId(r.move.to_organization)
  const from = r.move.from_organization ? await a.organizationId(r.move.from_organization) : null
  await ins('insert into public.transaction_player_moves (transaction_id, player_id, to_organization_id, from_organization_id, from_club_text, source_event_code, source_info) values ($1, $2, $3, $4, $5, $6, $7) on conflict (transaction_id, player_id) do nothing',
    [txId, playerId, to, from, r.move.from_club_text ?? null, r.move.source_event_code, r.move.source_info ?? null])
  await recordCoverage(a, r, [to, from].filter(Boolean))
  const action = created ? 'INSERT' : (changed ? 'UPDATE_UNKNOWN' : 'NO_CHANGE')
  await a.q('insert into ingest.transaction_apply_ledger (import_batch_id, record_index, record_sha256, transaction_id, action) values ($1, $2, $3, $4, $5)', [batchId, rec.record_index, rec.record_sha256, txId, action])
  return { action, canonical: ['transactions', txId], newPlayers }
}

// Coverage follows the data and states only what is true: the club-season is a PARTIAL_RECONSTRUCTION of one source lineage; the tracked count is
// recounted from the transactions BAI holds for that club and season. A club-season already assessed as anything else is left as it is, and a count that did not
// change writes nothing: a replay must not touch assessed_on or updated_at, or fire the evidence triggers.
async function recordCoverage (a, r, orgIds) {
  const season = r.date.slice(0, 4)
  const source = await a.sourceId(r.source_key)
  for (const org of orgIds) {
    const tracked = Number((await a.one(`select count(distinct t.id) n from public.transactions t where extract(year from t.transaction_date) = $2::int
      and (exists (select 1 from public.transaction_player_moves m where m.transaction_id = t.id and $1 in (m.to_organization_id, m.from_organization_id))
        or exists (select 1 from public.trade_packages k where k.transaction_id = t.id and $1 in (k.from_organization_id, k.to_organization_id)))`, [org, season])).n)
    const ex = await a.one("select id, coverage_state::text s from public.coverage_assessments where domain::text = 'TRANSACTIONS' and scope_key = $1 and organization_id = $2", [season, org])
    if (!ex) {
      await a.q(`insert into public.coverage_assessments (domain, scope_key, organization_id, coverage_state, tracked_count, expected_count, sample_basis, gap_notes, source_id, assessed_on)
        values ('TRANSACTIONS', $1, $2, 'PARTIAL_RECONSTRUCTION', $3, null, 'Retrosheet transactions archive: one source lineage, reconstructed rows only; not a census of the club-season', 'The archive does not say which transactions it omits; contracts and amounts are not recorded.', $4, current_date)`, [season, org, tracked, source])
    } else if (ex.s === 'PARTIAL_RECONSTRUCTION') {
      await a.q('update public.coverage_assessments set tracked_count = $2, assessed_on = current_date where id = $1 and tracked_count is distinct from $2', [ex.id, tracked])
    }
  }
}
