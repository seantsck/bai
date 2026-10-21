// Research ingestion pipeline: stage -> validate (incl. identity) -> apply (dry run by default) -> reconcile.
//
// Invariants:
//   * Staging never touches canonical tables. Apply runs inside one transaction; a dry run executes the same code and rolls
//     back to a savepoint, so its report is exactly what a write would do and nothing canonical persists.
//   * Unknown is not evidence: null inputs never overwrite anything, and UNKNOWN signing status writes nothing.
//   * A canonical value is only ever filled when it is unknown. A differing value becomes a preserved observation and an
//     open conflict; it never replaces the canonical value (no last-write-wins). Resolution is a separate, recorded step.
//   * Identity: only EXACT_EXTERNAL_ID / EXACT_COMPOSITE link automatically, NO_MATCH creates a player, everything else
//     is HELD until a researcher records a decision.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { validateEnvelope, validateRecordShape, roundStructure, slugify, EVIDENCE_SUBJECTS, organizationScopeErrors } from './import-format.mjs'

const SAFE_STATES = new Set(['EXACT_EXTERNAL_ID', 'EXACT_COMPOSITE', 'NO_MATCH'])
const ACTION_RANK = { HELD: 6, CONFLICT: 5, INSERT: 4, UPDATE_UNKNOWN: 3, CORROBORATE: 2, NO_CHANGE: 1 }
const strongest = (a, b) => (ACTION_RANK[b] ?? 0) > (ACTION_RANK[a] ?? 0) ? b : a
// Per-field attribution inside one record (e.g. pick facts from MLB, draft-day position from Baseball-Reference).
const fieldSource = (r, f) => r.field_sources?.[f] ?? r.source_key
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

export class PipelineError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------------------------

export async function findBatch (db, ref) {
  const r = await db.query('select * from ingest.import_batches where id::text = $1 or batch_key = $1', [String(ref)])
  if (!r.rows[0]) throw new PipelineError(`batch ${ref} not found`)
  return r.rows[0]
}

/** Stage a file. Same bytes => same batch (no-op). Writes only ingest.* tables. */
export async function stageFile (db, file, { operator = 'cli', allowFixtures = false, organization = null } = {}) {
  // Research data never shares a database with the fictional foundation fixtures.
  if (!allowFixtures && (await db.query("select 1 from public.sources where source_key = 'fixture:foundation'")).rowCount) {
    throw new PipelineError('this database holds the fictional foundation fixtures; research imports need a database without them')
  }
  const raw = fs.readFileSync(file)
  const digest = sha256(raw)
  const existing = await db.query('select id, batch_key, status from ingest.import_batches where file_sha256 = $1', [digest])
  if (existing.rows[0]) return { batch: existing.rows[0], already: true }
  let doc
  try { doc = JSON.parse(raw.toString('utf8')) } catch (err) { throw new PipelineError(`not JSON: ${err.message}`) }
  const errors = validateEnvelope(doc)
  // Multi-team safety: a batch staged for one organization may only carry that organization's records (plus records that
  // say why they belong to another club, such as re-drafts).
  if (organization) errors.push(...organizationScopeErrors(doc, organization))
  if (errors.length) throw new PipelineError('invalid import file:\n  ' + errors.join('\n  '))
  const clash = await db.query('select id from ingest.import_batches where batch_key = $1', [doc.batch_key])
  if (clash.rows[0]) throw new PipelineError(`batch_key ${doc.batch_key} is already used by a different file; batches are immutable, use a new key`)

  await db.query('begin')
  try {
    const b = (await db.query(`insert into ingest.import_batches (batch_key, channel, file_name, file_sha256, description, coverage_claim, record_count, imported_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, batch_key, status`,
    [doc.batch_key, doc.channel, path.basename(file), digest, doc.description ?? null, JSON.stringify(doc.coverage_claims ?? []), doc.records.length, operator])).rows[0]
    for (const s of doc.sources) await db.query('insert into ingest.staged_sources (batch_id, source_key, payload) values ($1, $2, $3)', [b.id, s.source_key, s])
    for (const [i, r] of doc.records.entries()) {
      await db.query(`insert into ingest.staged_records (batch_id, record_index, record_type, record_sha256, payload, source_key)
        values ($1, $2, $3, $4, $5, $6)`, [b.id, i, r.type ?? 'UNKNOWN_TYPE', sha256(JSON.stringify(r)), r, r.source_key ?? ''])
    }
    await db.query('commit')
    return { batch: b, already: false }
  } catch (err) { await db.query('rollback'); throw err }
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (writes only ingest.*)
// ---------------------------------------------------------------------------------------------------------------

const SOURCE_FIELDS = ['source_type', 'authority_level', 'title', 'publisher', 'url', 'reference', 'published_date', 'retrieved_date', 'archived_url', 'effective_from', 'effective_to']
// node-pg parses DATE columns to local-midnight Date objects; compare them as calendar dates.
const pad = (n) => String(n).padStart(2, '0')
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const norm = (v) => v instanceof Date ? isoDate(v) : (v ?? null)

async function sourceProblems (db, batchId) {
  const problems = []
  const staged = (await db.query('select source_key, payload from ingest.staged_sources where batch_id = $1', [batchId])).rows
  for (const { source_key: key, payload } of staged) {
    const ex = (await db.query(`select ${SOURCE_FIELDS.join(', ')} from public.sources where source_key = $1`, [key])).rows[0]
    if (!ex) continue
    const diffs = SOURCE_FIELDS.filter((f) => String(norm(ex[f])) !== String(payload[f] ?? null))
    if (diffs.length) problems.push(`source ${key} already registered with different ${diffs.join(', ')}; sources are immutable, use a new key`)
  }
  return problems
}

async function declaredSources (db, batchId) {
  const staged = (await db.query('select source_key from ingest.staged_sources where batch_id = $1', [batchId])).rows.map((r) => r.source_key)
  const registered = (await db.query('select source_key from public.sources')).rows.map((r) => r.source_key)
  return new Set([...staged, ...registered])
}

const identityInput = (p) => ({ full_name: p.full_name, birth_date: p.birth_date ?? null, birth_country: p.birth_country ?? null, external_ids: p.external_ids ?? {} })

export async function validateBatch (db, ref) {
  const batch = await findBatch(db, ref)
  if (batch.status === 'APPLIED' || batch.status === 'ABANDONED') throw new PipelineError(`batch ${batch.batch_key} is ${batch.status}`)
  const declared = await declaredSources(db, batch.id)
  const batchProblems = await sourceProblems(db, batch.id)
  const orgs = new Set((await db.query('select franchise_key from public.organizations where active')).rows.map((r) => r.franchise_key))
  const records = (await db.query('select * from ingest.staged_records where batch_id = $1 order by record_index', [batch.id])).rows
  const counts = { records: records.length, valid: 0, invalid: 0, warnings: 0, identity: {} }
  const seenPicks = new Map()

  await db.query('begin')
  try {
    for (const rec of records) {
      const r = rec.payload
      const { errors, warnings } = validateRecordShape(r, batch.channel, declared)
      if (r.organization && !orgs.has(r.organization)) errors.push(`unknown organization ${r.organization}`)
      // The source's own wording (e.g. "Florida Marlins") must resolve, for that season, to the franchise the record names.
      if (r.organization_as_named) {
        const season = Number(String(r.draft_key ?? r.period_key ?? r.signing_date ?? '').slice(0, 4)) || null
        const resolved = (await db.query('select o.franchise_key from public.organizations o where o.id = public.resolve_organization($1, $2)', [r.organization_as_named, season])).rows[0]
        if (!resolved) errors.push(`organization_as_named "${r.organization_as_named}" does not resolve to one franchise${season ? ` in ${season}` : ''}`)
        else if (resolved.franchise_key !== r.organization) errors.push(`organization_as_named "${r.organization_as_named}" is ${resolved.franchise_key}, not ${r.organization}`)
      }
      if (batch.channel === 'DRAFT' && r.draft_key) {
        const d = (await db.query('select id, total_rounds from public.drafts where draft_key = $1', [r.draft_key])).rows[0]
        if (!d) errors.push(`draft ${r.draft_key} is not on the calendar (add it with a source first)`)
        const k = `${r.draft_key}#${r.overall_pick}`
        if (seenPicks.has(k)) errors.push(`duplicate pick ${k} in batch (record ${seenPicks.get(k)})`)
        seenPicks.set(k, rec.record_index)
        if (d?.total_rounds && /^\d+$/.test(r.round_code ?? '') && Number(r.round_code) > d.total_rounds) errors.push(`round ${r.round_code} exceeds the ${d.total_rounds} rounds of ${r.draft_key}`)
      }
      if (batch.channel === 'INTERNATIONAL') {
        let periodId = null
        if (r.period_key) {
          periodId = (await db.query('select id from public.international_signing_periods where period_key = $1', [r.period_key])).rows[0]?.id ?? null
          if (!periodId) errors.push(`signing period ${r.period_key} is not on the calendar`)
        }
        if (r.signing_date && r.signing_date_precision === 'DAY') {
          const derived = (await db.query('select public.international_period_for_date($1) as id', [r.signing_date])).rows[0].id
          if (!derived) errors.push(`signing date ${r.signing_date} falls in no recorded signing period`)
          else if (periodId && String(derived) !== String(periodId)) errors.push(`signing date ${r.signing_date} is outside period ${r.period_key}`)
        }
      }
      if (errors.length === 0 && batchProblems.length) errors.push(...batchProblems)

      if (batch.channel === 'OUTCOMES') {
        for (const k of [r.debut?.organization, ...(r.transactions ?? []).flatMap((t) => [t.from_organization, t.to_organization]), ...(r.war ?? []).map((w) => w.organization)]) {
          if (k && !orgs.has(k)) errors.push(`unknown organization ${k}`)
        }
      }
      if (batch.channel === 'TRADES') {
        for (const k of r.packages ?? []) {
          for (const o of [k.from, k.to, ...(k.players ?? []).flatMap((p) => (p.war ?? []).map((w) => w.organization))]) if (o && !orgs.has(o)) errors.push(`unknown organization ${o}`)
          // A traded player links by a strong id or is new; anything weaker waits for a researcher.
          for (const p of k.players ?? []) {
            if (!p.player?.full_name) continue
            const id = (await db.query('select * from ingest.resolve_identity($1)', [identityInput(p.player)])).rows[0]
            if (!['EXACT_EXTERNAL_ID', 'NO_MATCH'].includes(id.state)) errors.push(`traded player ${p.player.full_name}: identity ${id.state}; decide it before importing the trade`)
          }
        }
      }
      let identity = { state: null, player_id: null, candidates: null }
      if (r.player?.full_name) identity = (await db.query('select * from ingest.resolve_identity($1)', [identityInput(r.player)])).rows[0]
      // Outcome audits describe players BAI already holds; they never create one.
      if (batch.channel === 'OUTCOMES' && identity.state === 'NO_MATCH') errors.push('outcome audit for a player BAI does not hold (import the acquisition first)')
      const status = errors.length ? 'INVALID' : 'VALID'
      const review = rec.review_state === 'APPROVED' || rec.review_state === 'REJECTED' ? rec.review_state
        : (identity.state && SAFE_STATES.has(identity.state) ? 'AUTO_ACCEPTED' : 'NEEDS_REVIEW')
      await db.query(`update ingest.staged_records set validation_status = $2, validation_errors = $3, validation_warnings = $4,
          identity_state = $5, identity_candidates = $6, matched_player_id = case when review_state = 'APPROVED' then matched_player_id else $7 end,
          review_state = $8 where id = $1`,
      [rec.id, status, errors, warnings, identity.state, JSON.stringify(identity.candidates ?? []), identity.player_id, review])
      counts[status === 'VALID' ? 'valid' : 'invalid']++
      counts.warnings += warnings.length
      if (identity.state) counts.identity[identity.state] = (counts.identity[identity.state] ?? 0) + 1
    }
    const newStatus = counts.invalid ? 'VALIDATION_FAILED' : 'VALIDATED'
    await db.query('update ingest.import_batches set status = $2, validated_at = now(), last_report = $3 where id = $1', [batch.id, newStatus, JSON.stringify({ step: 'validate', ...counts })])
    await db.query('commit')
    return { batch: { ...batch, status: newStatus }, counts, ok: counts.invalid === 0 }
  } catch (err) { await db.query('rollback'); throw err }
}

// ---------------------------------------------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------------------------------------------

// Observed values are stored with one JSON type per field so equal claims compare equal: money and pick numbers as
// numbers (node-pg returns NUMERIC as text), everything else (dates, codes, names) as strings.
const NUMERIC_FIELDS = new Set(['war_value', 'signing_bonus_usd', 'posting_fee_usd', 'transfer_fee_usd', 'other_cost_usd', 'slot_value_usd', 'round_pick', 'overall_pick', 'total_rounds', 'bonus_pool_usd'])
export const observedJson = (field, v) => v === null || v === undefined ? 'null'
  : NUMERIC_FIELDS.has(field) ? JSON.stringify(Number(v))
    : JSON.stringify(v instanceof Date ? isoDate(v) : String(v))
const same = (field, a, b) => observedJson(field, a) === observedJson(field, b)

class Applier {
  constructor (db, batch) { this.db = db; this.batch = batch; this.sourceIds = new Map(); this.touchedScopes = new Map() }
  q (sql, params) { return this.db.query(sql, params) }
  async one (sql, params) { return (await this.q(sql, params)).rows[0] }

  async sourceId (key) {
    if (!this.sourceIds.has(key)) {
      const r = await this.one('select id from public.sources where source_key = $1', [key])
      if (!r) throw new PipelineError(`source ${key} not registered`)
      this.sourceIds.set(key, r.id)
    }
    return this.sourceIds.get(key)
  }

  async registerSources () {
    let added = 0
    for (const { payload: s } of (await this.q('select payload from ingest.staged_sources where batch_id = $1 order by source_key', [this.batch.id])).rows) {
      const r = await this.q(`insert into public.sources (source_key, source_type, authority_level, title, publisher, url, reference, published_date, retrieved_date,
          archived_url, effective_from, effective_to, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) on conflict (source_key) do nothing`,
      [s.source_key, s.source_type, s.authority_level, s.title, s.publisher ?? null, s.url ?? null, s.reference ?? null, s.published_date ?? null,
        s.retrieved_date ?? null, s.archived_url ?? null, s.effective_from ?? null, s.effective_to ?? null, s.notes ?? null])
      added += r.rowCount
    }
    return added
  }

  /** Record what a source says about a field. Returns NEW | SAME | SAME_SOURCE_DIFFERENT. */
  async observe (sourceKey, table, id, field, value, locator) {
    const src = await this.sourceId(sourceKey)
    const prior = await this.one(`select observed_value from public.source_observations
      where source_id = $1 and subject_table = $2 and subject_id = $3 and field_name = $4 and status = 'ACTIVE'`, [src, table, id, field])
    if (prior) return JSON.stringify(prior.observed_value) === observedJson(field, value) ? 'SAME' : 'SAME_SOURCE_DIFFERENT'
    await this.q(`insert into public.source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator, observed_on)
      values ($1, $2, $3, $4, $5::jsonb, $6, current_date)`, [src, table, id, field, observedJson(field, value), locator ?? `batch ${this.batch.batch_key}`])
    return 'NEW'
  }

  /** Baseline: make sure the canonical value is itself on record (cited to the row's own source) before a rival is added. */
  async baseline (table, id, field, canonical, rowSourceId) {
    const has = await this.one(`select 1 from public.source_observations where subject_table = $1 and subject_id = $2 and field_name = $3 and status = 'ACTIVE'`, [table, id, field])
    if (has || canonical == null || rowSourceId == null) return
    await this.q(`insert into public.source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator, observed_on)
      values ($1, $2, $3, $4, $5::jsonb, 'canonical baseline', current_date) on conflict do nothing`, [rowSourceId, table, id, field, observedJson(field, canonical)])
  }

  /**
   * Reconcile one field of an existing canonical row against an incoming value.
   * column = null for fields that are evidence-only (e.g. round_code on a selection).
   */
  async reconcile ({ table, id, field, column = field, canonical, incoming, sourceKey, rowSourceId, locator, conflicts }) {
    if (incoming === undefined || incoming === null) return 'NO_CHANGE'
    if (canonical === null || canonical === undefined) {
      const rival = await this.one(`select 1 from public.source_observations where subject_table = $1 and subject_id = $2 and field_name = $3
        and status = 'ACTIVE' and observed_value is not null and observed_value <> $4::jsonb`, [table, id, field, observedJson(field, incoming)])
      const obs = await this.observe(sourceKey, table, id, field, incoming, locator)
      if (rival || obs === 'SAME_SOURCE_DIFFERENT') { conflicts.push({ table, id, field, incoming, canonical: null }); return 'CONFLICT' }
      if (column) await this.q(`update public.${table} set ${column} = $2 where id = $1`, [id, incoming])
      return 'UPDATE_UNKNOWN'
    }
    if (same(field, canonical, incoming)) {
      const obs = await this.observe(sourceKey, table, id, field, incoming, locator)
      return obs === 'NEW' ? 'CORROBORATE' : 'NO_CHANGE'
    }
    await this.baseline(table, id, field, canonical, rowSourceId)
    const obs = await this.observe(sourceKey, table, id, field, incoming, locator)
    conflicts.push({ table, id, field, incoming, canonical: observedJson(field, canonical), same_source_revision: obs === 'SAME_SOURCE_DIFFERENT' })
    return 'CONFLICT'
  }

  async observeAll (sourceKey, table, id, fields, locator) {
    for (const [f, v] of Object.entries(fields)) if (v !== null && v !== undefined) await this.observe(sourceKey, table, id, f, v, locator)
  }

  // --- identity -------------------------------------------------------------------------------------------------

  async uniqueSlug (p) {
    const base = slugify(p.display_name ?? p.full_name) || 'player'
    const candidates = [base, p.birth_date ? `${base}-${p.birth_date.slice(0, 4)}` : null].filter(Boolean)
    for (let i = 2; candidates.length < 12; i++) candidates.push(`${base}-${i}`)
    for (const s of candidates) if (!(await this.one('select 1 from public.players where slug = $1', [s]))) return s
    throw new PipelineError(`no free slug for ${base}`)
  }

  async createPlayer (p, sourceKey) {
    const slug = await this.uniqueSlug(p)
    const row = await this.one(`insert into public.players (slug, full_name, display_name, birth_date, birth_date_precision, birth_country, bats, throws, primary_position)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [slug, p.full_name, p.display_name ?? p.full_name, p.birth_date ?? null, p.birth_date ? 'DAY' : null, p.birth_country ?? null, p.bats ?? null, p.throws ?? null, p.primary_position ?? null])
    await this.observeAll(p.source_key ?? sourceKey, 'players', row.id, { full_name: p.full_name, birth_date: p.birth_date, birth_country: p.birth_country }, null)
    return row.id
  }

  async enrichPlayer (playerId, p, sourceKey, conflicts) {
    let action = 'NO_CHANGE'
    const cur = await this.one('select id, birth_date, birth_country from public.players where id = $1', [playerId])
    const src = p.source_key ?? sourceKey
    for (const [field, incoming] of [['birth_date', p.birth_date], ['birth_country', p.birth_country]]) {
      const res = await this.reconcile({ table: 'players', id: playerId, field, canonical: cur[field], incoming, sourceKey: src, rowSourceId: null, conflicts })
      if (res === 'UPDATE_UNKNOWN' && field === 'birth_date') await this.q("update public.players set birth_date_precision = 'DAY' where id = $1", [playerId])
      action = strongest(action, res)
    }
    return action
  }

  async attachIdentifiers (playerId, p, sourceKey) {
    const src = await this.sourceId(p.source_key ?? sourceKey)
    for (const [system, value] of Object.entries(p.external_ids ?? {})) {
      // external_id_sources names the source of an id another source supplied (e.g. a crosswalk); default: the player's source.
      const idSrc = p.external_id_sources?.[system] ? await this.sourceId(p.external_id_sources[system]) : src
      const owner = await this.one('select player_id from public.player_external_ids where id_system = $1 and external_id = $2', [system, value])
      if (owner) { if (String(owner.player_id) !== String(playerId)) throw new PipelineError(`${system} ${value} belongs to player ${owner.player_id}`); continue }
      const mine = await this.one('select external_id from public.player_external_ids where player_id = $1 and id_system = $2', [playerId, system])
      if (mine) continue // a different id in the same system was caught by identity resolution (CONFLICT); never replaced here
      await this.q('insert into public.player_external_ids (player_id, id_system, external_id, source_id) values ($1, $2, $3, $4)', [playerId, system, value, idSrc])
    }
    for (const a of p.aliases ?? []) {
      await this.q(`insert into public.player_aliases (player_id, alias, alias_type, source_id) values ($1, $2, $3, $4)
        on conflict (player_id, alias_normalized) do nothing`, [playerId, a.alias, a.alias_type ?? 'OTHER', src])
    }
  }

  /** Returns { playerId, action } or { held: reason }. Re-resolves against current state (earlier records in this batch count). */
  async resolvePlayer (rec, conflicts) {
    const p = rec.payload.player
    if (rec.review_state === 'REJECTED') return { held: 'rejected by researcher' }
    if (rec.review_state === 'APPROVED') {
      if (rec.matched_player_id) {
        const action = await this.enrichPlayer(rec.matched_player_id, p, rec.payload.source_key, conflicts)
        await this.attachIdentifiers(rec.matched_player_id, p, rec.payload.source_key)
        return { playerId: rec.matched_player_id, action, state: 'APPROVED_LINK' }
      }
      const id = await this.createPlayer(p, rec.payload.source_key)
      await this.attachIdentifiers(id, p, rec.payload.source_key)
      return { playerId: id, action: 'INSERT', state: 'APPROVED_NEW' }
    }
    const res = await this.one('select * from ingest.resolve_identity($1)', [identityInput(p)])
    if (res.state === 'EXACT_EXTERNAL_ID' || res.state === 'EXACT_COMPOSITE') {
      const action = await this.enrichPlayer(res.player_id, p, rec.payload.source_key, conflicts)
      await this.attachIdentifiers(res.player_id, p, rec.payload.source_key)
      return { playerId: res.player_id, action, state: res.state }
    }
    if (res.state === 'NO_MATCH' && this.batch.channel === 'OUTCOMES') return { held: 'outcome audits never create players', state: res.state }
    if (res.state === 'NO_MATCH') {
      const id = await this.createPlayer(p, rec.payload.source_key)
      await this.attachIdentifiers(id, p, rec.payload.source_key)
      return { playerId: id, action: 'INSERT', state: res.state }
    }
    return { held: `identity ${res.state}`, state: res.state, candidates: res.candidates }
  }

  // --- draft ----------------------------------------------------------------------------------------------------

  async organizationId (key) { return (await this.one('select id from public.organizations where franchise_key = $1', [key])).id }

  async roundId (draftId, code) {
    const ex = await this.one('select id from public.draft_rounds where draft_id = $1 and round_code = $2', [draftId, code])
    if (ex) return ex.id
    const s = roundStructure(code)
    return (await this.one('insert into public.draft_rounds (draft_id, round_code, round_order, phase) values ($1, $2, $3, $4) returning id', [draftId, code, s.order, s.phase])).id
  }

  /** Exactly one school by normalized name / alias -> link; none -> create when typed; several -> unresolved. */
  async schoolId (school, sourceKey) {
    if (!school?.name) return { id: null, note: null }
    const matches = (await this.q(`select distinct s.id from public.schools s left join public.school_aliases a on a.school_id = s.id
      where s.name_normalized = public.normalize_name($1) or a.alias_normalized = public.normalize_name($1)`, [school.name])).rows
    if (matches.length === 1) return { id: matches[0].id, note: null }
    if (matches.length > 1) return { id: null, note: `school unresolved: "${school.name}" matches ${matches.length} schools` }
    if (!school.school_type) return { id: null, note: `school unresolved: "${school.name}" has no type` }
    const slug = await (async () => {
      const base = slugify([school.name, school.region].filter(Boolean).join(' '))
      // A missing city must not yield "<base>-" (invalid slug); numbered fallbacks cover same-named schools.
      const city = slugify(school.city ?? '')
      for (const s of [base, city ? `${base}-${city}` : null, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}-${n}`)].filter(Boolean)) {
        if (!(await this.one('select 1 from public.schools where slug = $1', [s]))) return s
      }
      throw new PipelineError(`no free slug for school ${school.name}`)
    })()
    const row = await this.one(`insert into public.schools (slug, name, school_type, city, region, country, source_id) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [slug, school.name, school.school_type, school.city ?? null, school.region ?? null, school.country ?? null, await this.sourceId(school.source_key ?? sourceKey)])
    return { id: row.id, note: null, created: true }
  }

  async applyDraftSelection (rec, playerId, conflicts) {
    const r = rec.payload
    const draft = await this.one('select id, start_date from public.drafts where draft_key = $1', [r.draft_key])
    const orgId = await this.organizationId(r.organization)
    const roundId = await this.roundId(draft.id, r.round_code)
    const src = await this.sourceId(r.source_key)
    let action = 'NO_CHANGE'
    let sel = await this.one('select * from public.draft_selections where draft_id = $1 and overall_pick = $2', [draft.id, r.overall_pick])
    if (sel && String(sel.player_id) !== String(playerId)) {
      conflicts.push({ table: 'draft_selections', id: sel.id, field: 'player_id', incoming: playerId, canonical: sel.player_id })
      return { action: 'CONFLICT', canonical: ['draft_selections', sel.id] }
    }
    if (!sel) {
      const other = await this.one('select id, overall_pick from public.draft_selections where draft_id = $1 and player_id = $2', [draft.id, playerId])
      if (other) {
        conflicts.push({ table: 'draft_selections', id: other.id, field: 'overall_pick', incoming: r.overall_pick, canonical: other.overall_pick })
        return { action: 'CONFLICT', canonical: ['draft_selections', other.id] }
      }
      const school = await this.schoolId(r.school, r.school?.source_key ?? r.source_key)
      sel = await this.one(`insert into public.draft_selections (draft_id, round_id, overall_pick, round_pick, organization_id, selection_type, player_id, position,
          school_id, school_type_at_selection, selection_date, source_id, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
      [draft.id, roundId, r.overall_pick, r.round_pick ?? null, orgId, r.selection_type ?? 'STANDARD', playerId, r.position ?? null, school.id,
        r.school?.school_type ?? null, r.selection_date ?? null, src, [r.notes, school.note].filter(Boolean).join(' | ') || null])
      for (const [f, v] of Object.entries({ round_code: r.round_code, round_pick: r.round_pick, organization: r.organization, position: r.position, school: r.school?.name })) {
        const locator = f === 'organization' && r.organization_as_named ? `as named: "${r.organization_as_named}" (batch ${this.batch.batch_key})` : null
        if (v != null) await this.observe(fieldSource(r, f), 'draft_selections', sel.id, f, v, locator)
      }
      action = 'INSERT'
    } else {
      const curRound = await this.one('select round_code from public.draft_rounds where id = $1', [sel.round_id])
      const org = await this.one('select franchise_key from public.organizations where id = $1', [sel.organization_id])
      for (const [field, column, canonical, incoming] of [
        ['round_code', null, curRound.round_code, r.round_code], ['round_pick', 'round_pick', sel.round_pick, r.round_pick],
        ['organization', null, org.franchise_key, r.organization], ['position', 'position', sel.position, r.position]]) {
        action = strongest(action, await this.reconcile({ table: 'draft_selections', id: sel.id, field, column, canonical, incoming, sourceKey: fieldSource(r, field), rowSourceId: sel.source_id, conflicts }))
      }
      if (!sel.school_id && r.school?.name) {
        const school = await this.schoolId(r.school, r.school?.source_key ?? r.source_key)
        if (school.id) { await this.q('update public.draft_selections set school_id = $2 where id = $1', [sel.id, school.id]); action = strongest(action, 'UPDATE_UNKNOWN') }
      }
    }
    this.touch('DRAFT', r.draft_key, orgId)

    // Signing: UNKNOWN writes nothing (no row = unknown); a status is only ever added, never replaced.
    const s = r.signing ?? { status: 'UNKNOWN' }
    if (s.status !== 'UNKNOWN') {
      const ex = await this.one('select * from public.draft_signings where draft_selection_id = $1', [sel.id])
      if (!ex) {
        const row = await this.one(`insert into public.draft_signings (draft_selection_id, signing_status, signing_bonus_usd, signing_date, signing_date_precision, source_id, notes)
          values ($1, $2, $3, $4, $5, $6, $7) returning id`, [sel.id, s.status, s.bonus_usd ?? null, s.date ?? null, s.date_precision ?? null, await this.sourceId(s.source_key), s.notes ?? null])
        await this.observeAll(s.source_key, 'draft_signings', row.id, { signing_status: s.status, signing_bonus_usd: s.bonus_usd, signing_date: s.date }, null)
        if (s.bonus_source_key && s.bonus_usd != null) await this.observe(s.bonus_source_key, 'draft_signings', row.id, 'signing_bonus_usd', s.bonus_usd, null)
        action = strongest(action, 'INSERT')
      } else {
        action = strongest(action, await this.reconcile({ table: 'draft_signings', id: ex.id, field: 'signing_status', canonical: ex.signing_status, incoming: s.status, sourceKey: s.source_key, rowSourceId: ex.source_id, conflicts }))
        const statusAgrees = ex.signing_status === s.status
        if (statusAgrees && s.status === 'SIGNED') {
          action = strongest(action, await this.reconcile({ table: 'draft_signings', id: ex.id, field: 'signing_bonus_usd', canonical: ex.signing_bonus_usd, incoming: s.bonus_usd, sourceKey: s.bonus_source_key ?? s.source_key, rowSourceId: ex.source_id, conflicts }))
          // A signing date fills an unknown date (with its precision); a different date is a conflict.
          // (date and precision are written together: the table requires both or neither)
          const dated = await this.reconcile({ table: 'draft_signings', id: ex.id, field: 'signing_date', column: null, canonical: ex.signing_date ? isoDate(ex.signing_date) : null, incoming: s.date ?? null, sourceKey: s.source_key, rowSourceId: ex.source_id, conflicts })
          if (dated === 'UPDATE_UNKNOWN') await this.q('update public.draft_signings set signing_date = $2, signing_date_precision = $3 where id = $1', [ex.id, s.date, s.date_precision ?? 'DAY'])
          action = strongest(action, dated)
        }
      }
    }
    if (r.slot_value) {
      const ex = await this.one('select * from public.slot_values where draft_id = $1 and overall_pick = $2', [draft.id, r.overall_pick])
      if (!ex) {
        const row = await this.one('insert into public.slot_values (draft_id, overall_pick, slot_value_usd, source_id) values ($1, $2, $3, $4) returning id', [draft.id, r.overall_pick, r.slot_value.usd, await this.sourceId(r.slot_value.source_key)])
        await this.observe(r.slot_value.source_key, 'slot_values', row.id, 'slot_value_usd', r.slot_value.usd, r.slot_value.locator)
        action = strongest(action, 'INSERT')
      } else {
        action = strongest(action, await this.reconcile({ table: 'slot_values', id: ex.id, field: 'slot_value_usd', canonical: ex.slot_value_usd, incoming: r.slot_value.usd, sourceKey: r.slot_value.source_key, rowSourceId: ex.source_id, conflicts }))
      }
    }
    await this.applyEvidence(r, { selection: sel.id, player: playerId, draft_signing: (await this.one('select id from public.draft_signings where draft_selection_id = $1', [sel.id]))?.id, slot: (await this.one('select id from public.slot_values where draft_id = $1 and overall_pick = $2', [draft.id, r.overall_pick]))?.id }, conflicts)
    return { action, canonical: ['draft_selections', sel.id] }
  }

  // --- international --------------------------------------------------------------------------------------------

  async marketId (m) {
    if (!m) return null
    const ex = await this.one('select id from public.markets where market_key = $1', [m.key])
    if (ex) return ex.id
    return (await this.one('insert into public.markets (market_key, name, region, slug) values ($1, $2, $3, $4) returning id', [m.key, m.name ?? m.key, m.region ?? null, slugify(m.name ?? m.key)])).id
  }

  async applyInternationalSigning (rec, playerId, conflicts) {
    const r = rec.payload
    const orgId = await this.organizationId(r.organization)
    const periodId = r.period_key
      ? (await this.one('select id from public.international_signing_periods where period_key = $1', [r.period_key])).id
      : (await this.one('select public.international_period_for_date($1) as id', [r.signing_date])).id
    const period = await this.one('select period_key from public.international_signing_periods where id = $1', [periodId])
    const c = r.costs ?? {}
    const costSource = r.cost_source_key ?? r.source_key
    let action = 'NO_CHANGE'
    let row = await this.one('select * from public.international_signings where player_id = $1 and organization_id = $2 and signing_period_id = $3', [playerId, orgId, periodId])
    if (!row) {
      row = await this.one(`insert into public.international_signings (player_id, organization_id, signing_period_id, signing_date, signing_date_precision, pathway, market_id,
          birth_country, position, signing_bonus_usd, posting_fee_usd, transfer_fee_usd, other_cost_usd, source_id, notes)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning *`,
      [playerId, orgId, periodId, r.signing_date ?? null, r.signing_date_precision ?? null, r.pathway, await this.marketId(r.market), r.player.birth_country ?? null,
        r.position ?? null, c.signing_bonus_usd ?? null, c.posting_fee_usd ?? null, c.transfer_fee_usd ?? null, c.other_cost_usd ?? null, await this.sourceId(r.source_key), r.notes ?? null])
      await this.observeAll(r.source_key, 'international_signings', row.id, { signing_date: r.signing_date, pathway: r.pathway, position: r.position, market: r.market?.key }, null)
      await this.observeAll(costSource, 'international_signings', row.id, { signing_bonus_usd: c.signing_bonus_usd, posting_fee_usd: c.posting_fee_usd, transfer_fee_usd: c.transfer_fee_usd, other_cost_usd: c.other_cost_usd }, null)
      action = 'INSERT'
    } else {
      action = strongest(action, await this.reconcile({ table: 'international_signings', id: row.id, field: 'signing_date', canonical: row.signing_date, incoming: r.signing_date, sourceKey: r.source_key, rowSourceId: row.source_id, conflicts }))
      action = strongest(action, await this.reconcile({ table: 'international_signings', id: row.id, field: 'pathway', canonical: row.pathway, incoming: r.pathway, sourceKey: r.source_key, rowSourceId: row.source_id, conflicts }))
      for (const k of ['signing_bonus_usd', 'posting_fee_usd', 'transfer_fee_usd', 'other_cost_usd']) {
        action = strongest(action, await this.reconcile({ table: 'international_signings', id: row.id, field: k, canonical: row[k], incoming: c[k], sourceKey: costSource, rowSourceId: row.source_id, conflicts }))
      }
      if (!row.market_id && r.market) { await this.q('update public.international_signings set market_id = $2 where id = $1', [row.id, await this.marketId(r.market)]); action = strongest(action, 'UPDATE_UNKNOWN') }
    }
    this.touch('INTERNATIONAL', period.period_key, orgId)
    await this.applyEvidence(r, { signing: row.id, player: playerId }, conflicts)
    return { action, canonical: ['international_signings', row.id] }
  }

  // --- shared ---------------------------------------------------------------------------------------------------

  /** Extra field-level evidence from other sources: kept as observations; disagreement surfaces as a conflict. */
  async applyEvidence (r, subjects, conflicts) {
    for (const ev of r.evidence ?? []) {
      const table = EVIDENCE_SUBJECTS[ev.subject]
      const id = subjects[ev.subject]
      if (!id) continue
      const others = (await this.q(`select observed_value from public.source_observations where subject_table = $1 and subject_id = $2 and field_name = $3
        and status = 'ACTIVE' and observed_value is not null`, [table, id, ev.field])).rows
      const res = await this.observe(ev.source_key, table, id, ev.field, ev.value, ev.locator)
      if (ev.value != null && (res === 'SAME_SOURCE_DIFFERENT' || others.some((o) => JSON.stringify(o.observed_value) !== observedJson(ev.field, ev.value)))) {
        conflicts.push({ table, id, field: ev.field, incoming: ev.value, evidence: true })
      }
    }
  }

  async applyFlags (r, canonical) {
    for (const f of r.flags ?? []) {
      const [table, id] = f.subject === 'player' ? ['players', canonical.player] : canonical.row
      await this.q(`insert into public.quality_flags (subject_table, subject_id, flag_code, severity, notes)
        select $1, $2, $3, $4, $5 where not exists (select 1 from public.quality_flags where subject_table = $1 and subject_id = $2 and flag_code = $3 and status = 'OPEN')`,
      [table, id, f.code, f.severity, f.note ?? null])
    }
  }

  // --- outcomes ---------------------------------------------------------------------------------------------------

  /** One outcome audit: trades, the audit row, the debut, details as of a date, WAR per provider. Never overwrites. */
  async applyOutcomeAudit (rec, playerId, conflicts) {
    const r = rec.payload
    let action = 'NO_CHANGE'
    const txIds = {}
    for (const t of r.transactions ?? []) {
      const k = await this.tradePackage({ date: t.date, precision: t.date_precision, from: t.from_organization, to: t.to_organization, description: t.description, sourceKey: t.source_key ?? r.source_key, locator: t.locator })
      action = strongest(action, k.action)
      action = strongest(action, await this.tradeAsset(k.packageId, playerId))
      txIds[t.ref] = k.transactionId
    }
    if (r.debut) {
      const d = await this.one('select * from public.mlb_debuts where player_id = $1', [playerId])
      const dsrc = r.debut.source_key ?? r.source_key
      if (!d) {
        const row = await this.one('insert into public.mlb_debuts (player_id, debut_date, debut_organization_id, source_id) values ($1, $2, $3, $4) returning id',
          [playerId, r.debut.date, await this.organizationId(r.debut.organization), await this.sourceId(dsrc)])
        await this.observe(dsrc, 'mlb_debuts', row.id, 'debut_date', r.debut.date, r.debut.locator ?? null)
        action = strongest(action, 'INSERT')
      } else {
        action = strongest(action, await this.reconcile({ table: 'mlb_debuts', id: d.id, field: 'debut_date', column: 'debut_date', canonical: isoDate(d.debut_date), incoming: r.debut.date, sourceKey: dsrc, rowSourceId: d.source_id, conflicts }))
      }
    }
    let audit = await this.one('select * from public.outcome_audits where player_id = $1 and observation_through_season is not distinct from $2', [playerId, r.observation_through_season ?? null])
    if (!audit) {
      audit = await this.one(`insert into public.outcome_audits (player_id, audit_state, observation_through_season, audited_on, source_id, notes)
        values ($1, $2, $3, $4, $5, $6) returning *`, [playerId, r.audit_state, r.observation_through_season ?? null, r.audited_on, await this.sourceId(r.source_key), r.notes ?? null])
      action = strongest(action, 'INSERT')
    } else if (audit.audit_state !== r.audit_state) {
      conflicts.push({ table: 'outcome_audits', id: audit.id, field: 'audit_state', incoming: r.audit_state, canonical: audit.audit_state })
      action = 'CONFLICT'
    }
    if (r.details) {
      const d = r.details
      const ex = await this.one('select * from public.outcome_audit_details where outcome_audit_id = $1', [audit.id])
      // details.disposition is the legacy (pre-022) per-player form; new records give it per acquisition and leave it out here.
      const legacy = d.disposition !== undefined
      const vals = [d.as_of_date, d.reached_affiliated ?? null, d.first_affiliated_season ?? null, d.mlb_games ?? null, d.mlb_plate_appearances ?? null,
        d.mlb_innings_pitched ?? null, d.current_status ?? 'UNKNOWN', d.disposition ?? 'UNKNOWN', d.disposition_transaction_ref ? txIds[d.disposition_transaction_ref] : null]
      if (!ex) {
        await this.q(`insert into public.outcome_audit_details (outcome_audit_id, as_of_date, reached_affiliated, first_affiliated_season, mlb_games, mlb_plate_appearances,
            mlb_innings_pitched, current_status, disposition, disposition_transaction_id, source_id, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [audit.id, ...vals, await this.sourceId(d.source_key ?? r.source_key), d.notes ?? null])
        action = strongest(action, 'INSERT')
      } else {
        const cur = [isoDate(ex.as_of_date), ex.reached_affiliated, ex.first_affiliated_season, ex.mlb_games, ex.mlb_plate_appearances,
          ex.mlb_innings_pitched == null ? null : Number(ex.mlb_innings_pitched), ex.current_status, ex.disposition, ex.disposition_transaction_id == null ? null : Number(ex.disposition_transaction_id)]
        const inc = vals.map((v, i) => i === 8 && v != null ? Number(v) : v)
        const n = legacy ? 9 : 7      // player-level fields only, unless the record states the legacy disposition
        if (JSON.stringify(cur.slice(0, n)) !== JSON.stringify(inc.slice(0, n))) { conflicts.push({ table: 'outcome_audit_details', id: ex.id, field: 'details', incoming: d, canonical: cur }); action = 'CONFLICT' }
      }
    }
    // The acquisition's own disposition (022).
    const acqId = r.organization ? await this.acquisitionOf(playerId, r.organization, r.acquisition) : null
    if (r.disposition) {
      if (!acqId) throw new PipelineError(`${r.player?.full_name ?? 'record'}: no ${r.organization} acquisition ${JSON.stringify(r.acquisition)} of this player`)
      const x = r.disposition
      const tx = x.transaction_ref ? (r.transactions ?? []).find((t) => t.ref === x.transaction_ref) : null
      action = strongest(action, await this.applyDisposition(acqId, playerId, { value: x.value, date: x.date ?? tx?.date ?? null, precision: x.date_precision ?? (x.date || tx ? 'DAY' : null),
        transactionId: x.transaction_ref ? txIds[x.transaction_ref] : null, asOf: x.as_of_date, sourceKey: x.source_key ?? r.source_key, locator: x.locator, notes: x.notes }, conflicts))
    } else if (r.details?.disposition && r.details.disposition !== 'UNKNOWN' && acqId) {
      const d = r.details
      const tx = d.disposition_transaction_ref ? (r.transactions ?? []).find((t) => t.ref === d.disposition_transaction_ref) : null
      action = strongest(action, await this.applyDisposition(acqId, playerId, { value: d.disposition, date: tx?.date ?? null, precision: tx ? 'DAY' : null,
        transactionId: d.disposition_transaction_ref ? txIds[d.disposition_transaction_ref] : null, asOf: d.as_of_date, sourceKey: d.source_key ?? r.source_key, locator: null, notes: 'from the outcome audit details (legacy form)' }, conflicts))
    }
    action = strongest(action, await this.applyWar(playerId, r.war, r.source_key, conflicts))
    return { action, canonical: ['outcome_audits', audit.id] }
  }

  /**
   * The acquisition an outcome record audits: { draft_key, overall_pick } or { period_key } of the record's organization.
   * Without one (legacy records), the player's only acquisition with that organization, if exactly one exists.
   */
  async acquisitionOf (playerId, org, ref) {
    const orgId = await this.organizationId(org)
    if (ref?.draft_key) {
      const a = await this.one(`select s.id from public.draft_selections s join public.drafts d on d.id = s.draft_id
        where d.draft_key = $1 and s.overall_pick = $2 and s.organization_id = $3 and s.player_id = $4`, [ref.draft_key, ref.overall_pick, orgId, playerId])
      return a ? { draft_selection_id: a.id } : null
    }
    if (ref?.period_key) {
      const a = await this.one(`select i.id from public.international_signings i join public.international_signing_periods p on p.id = i.signing_period_id
        where p.period_key = $1 and i.organization_id = $2 and i.player_id = $3`, [ref.period_key, orgId, playerId])
      return a ? { international_signing_id: a.id } : null
    }
    const all = (await this.q('select draft_selection_id, international_signing_id from analytics.player_acquisitions where player_id = $1 and organization_id = $2', [playerId, orgId])).rows
    return all.length === 1 ? { draft_selection_id: all[0].draft_selection_id, international_signing_id: all[0].international_signing_id } : null
  }

  /** One acquisition's disposition: inserted once, then reconciled (a different value is a conflict, a missing date is filled). */
  async applyDisposition (acq, playerId, { value, date, precision, transactionId, asOf, sourceKey, locator, notes }, conflicts) {
    const key = acq.draft_selection_id ? ['draft_selection_id', acq.draft_selection_id] : ['international_signing_id', acq.international_signing_id]
    const ex = await this.one(`select * from public.acquisition_dispositions where ${key[0]} = $1`, [key[1]])
    if (!ex) {
      const org = await this.one(`select organization_id from analytics.player_acquisitions where ${key[0]} = $1`, [key[1]])
      const row = await this.one(`insert into public.acquisition_dispositions (${key[0]}, organization_id, player_id, disposition, disposition_date, disposition_date_precision,
          disposition_transaction_id, as_of_date, source_id, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [key[1], org.organization_id, playerId, value, date, date ? precision ?? 'DAY' : null, transactionId, asOf, await this.sourceId(sourceKey), notes ?? null])
      await this.observe(sourceKey, 'acquisition_dispositions', row.id, 'disposition', value, locator ?? null)
      if (date) await this.observe(sourceKey, 'acquisition_dispositions', row.id, 'disposition_date', date, locator ?? null)
      return 'INSERT'
    }
    let action = await this.reconcile({ table: 'acquisition_dispositions', id: ex.id, field: 'disposition', canonical: ex.disposition, incoming: value, sourceKey, rowSourceId: ex.source_id, locator, conflicts })
    if (date) {
      const r = await this.reconcile({ table: 'acquisition_dispositions', id: ex.id, field: 'disposition_date', column: null, canonical: ex.disposition_date ? isoDate(ex.disposition_date) : null, incoming: date, sourceKey, rowSourceId: ex.source_id, locator, conflicts })
      if (r === 'UPDATE_UNKNOWN' && ex.disposition === value) {
        await this.q('update public.acquisition_dispositions set disposition_date = $2, disposition_date_precision = $3 where id = $1', [ex.id, date, precision ?? 'DAY'])
      }
      action = strongest(action, r)
    }
    return action
  }

  /** WAR per provider as observed; a different value for the same observation key is a conflict, never an overwrite. */
  async applyWar (playerId, list, fallbackSource, conflicts) {
    let action = 'NO_CHANGE'
    for (const w of list ?? []) {
      const org = w.organization ? await this.organizationId(w.organization) : null
      const ex = await this.one(`select * from public.war_observations where player_id = $1 and war_system = $2 and scope = $3 and season is not distinct from $4
        and organization_id is not distinct from $5 and through_season = $6`, [playerId, w.system, w.scope, w.season ?? null, org, w.through_season])
      const wsrc = w.source_key ?? fallbackSource
      if (!ex) {
        const row = await this.one(`insert into public.war_observations (player_id, war_system, scope, season, organization_id, through_season, war_value, observed_on, source_id)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`, [playerId, w.system, w.scope, w.season ?? null, org, w.through_season, w.value, w.observed_on, await this.sourceId(wsrc)])
        await this.observe(wsrc, 'war_observations', row.id, 'war_value', w.value, w.locator ?? null)
        action = strongest(action, 'INSERT')
      } else {
        action = strongest(action, await this.reconcile({ table: 'war_observations', id: ex.id, field: 'war_value', column: 'war_value', canonical: Number(ex.war_value), incoming: w.value, sourceKey: wsrc, rowSourceId: ex.source_id, conflicts }))
      }
    }
    return action
  }

  // --- trades -----------------------------------------------------------------------------------------------------

  /**
   * One trade is one transaction, whichever side is imported first: it is found by date and the two clubs (in either
   * direction), and each direction is one package.
   */
  async tradePackage ({ date, precision, from, to, description, sourceKey, locator }) {
    const fromId = await this.organizationId(from)
    const toId = await this.organizationId(to)
    let action = 'NO_CHANGE'
    let tx = await this.one(`select t.id from public.transactions t where t.transaction_type = 'TRADE' and t.transaction_date = $1
      and exists (select 1 from public.trade_packages p where p.transaction_id = t.id
        and ((p.from_organization_id = $2 and p.to_organization_id = $3) or (p.from_organization_id = $3 and p.to_organization_id = $2))) order by t.id limit 1`, [date, fromId, toId])
    if (!tx) {
      tx = await this.one("insert into public.transactions (transaction_type, transaction_date, date_precision, description, source_id) values ('TRADE', $1, $2, $3, $4) returning id",
        [date, precision ?? 'DAY', description ?? null, await this.sourceId(sourceKey)])
      await this.observe(sourceKey, 'transactions', tx.id, 'transaction_date', date, locator ?? null)
      action = 'INSERT'
    }
    let pkg = await this.one('select id from public.trade_packages where transaction_id = $1 and from_organization_id = $2 and to_organization_id = $3', [tx.id, fromId, toId])
    if (!pkg) {
      pkg = await this.one('insert into public.trade_packages (transaction_id, from_organization_id, to_organization_id) values ($1, $2, $3) returning id', [tx.id, fromId, toId])
      action = strongest(action, action === 'INSERT' ? 'INSERT' : 'UPDATE_UNKNOWN')
    }
    return { transactionId: tx.id, packageId: pkg.id, action }
  }

  async tradeAsset (packageId, playerId) {
    if (await this.one('select 1 from public.trade_package_assets where trade_package_id = $1 and player_id = $2', [packageId, playerId])) return 'NO_CHANGE'
    await this.q("insert into public.trade_package_assets (trade_package_id, asset_type, player_id) values ($1, 'PLAYER', $2)", [packageId, playerId])
    return 'UPDATE_UNKNOWN'
  }

  /** TRADE: every package and player of one trade, plus the players' observed WAR. New players only by a strong id. */
  async applyTrade (rec, conflicts) {
    const r = rec.payload
    let action = 'NO_CHANGE'
    let newPlayers = 0
    let txId = null
    for (const k of r.packages) {
      const pk = await this.tradePackage({ date: r.date, precision: r.date_precision, from: k.from, to: k.to, description: r.description, sourceKey: r.source_key, locator: r.locator })
      txId = pk.transactionId
      action = strongest(action, pk.action)
      for (const p of k.players ?? []) {
        const src = p.player.source_key ?? r.source_key
        const res = await this.one('select * from ingest.resolve_identity($1)', [identityInput(p.player)])
        let playerId
        if (res.state === 'EXACT_EXTERNAL_ID') playerId = res.player_id
        else if (res.state === 'NO_MATCH') { playerId = await this.createPlayer(p.player, src); newPlayers++; action = strongest(action, 'INSERT') } else throw new PipelineError(`traded player ${p.player.full_name}: identity ${res.state}`)
        await this.attachIdentifiers(playerId, p.player, src)
        action = strongest(action, await this.tradeAsset(pk.packageId, playerId))
        action = strongest(action, await this.applyWar(playerId, p.war, r.source_key, conflicts))
      }
      for (const a of k.other_assets ?? []) {
        if (await this.one('select 1 from public.trade_package_assets where trade_package_id = $1 and asset_type = $2 and description is not distinct from $3', [pk.packageId, a.asset_type, a.description ?? null])) continue
        await this.q('insert into public.trade_package_assets (trade_package_id, asset_type, amount_usd, description) values ($1, $2, $3, $4)', [pk.packageId, a.asset_type, a.amount_usd ?? null, a.description ?? null])
        action = strongest(action, 'UPDATE_UNKNOWN')
      }
    }
    return { action, canonical: ['transactions', txId], newPlayers }
  }

  touch (domain, scope, orgId) { this.touchedScopes.set(`${domain}|${scope}|${orgId}`, { domain, scope, orgId }) }

  /** Coverage follows the data: tracked counts are recounted; a claimed state applies only to its declared scope. */
  async updateCoverage () {
    const claims = this.batch.coverage_claim ?? []
    const out = []
    for (const { domain, scope, orgId } of this.touchedScopes.values()) {
      const tracked = Number((await this.one(domain === 'DRAFT'
        ? 'select count(*) n from public.draft_selections s join public.drafts d on d.id = s.draft_id where d.draft_key = $1 and s.organization_id = $2'
        : 'select count(*) n from public.international_signings s join public.international_signing_periods p on p.id = s.signing_period_id where p.period_key = $1 and s.organization_id = $2',
      [scope, orgId])).n)
      const org = (await this.one('select franchise_key from public.organizations where id = $1', [orgId])).franchise_key
      const claim = claims.find((c) => c.scope_key === scope && c.organization === org && (c.domain ?? this.batch.channel) === domain)
      const ex = await this.one('select * from public.coverage_assessments where domain = $1 and scope_key = $2 and organization_id = $3', [domain, scope, orgId])
      const state = claim?.coverage_state ?? ex?.coverage_state ?? 'INDIVIDUALLY_VERIFIED'
      const params = [domain, scope, orgId, state, tracked, claim?.expected_count ?? ex?.expected_count ?? null, claim?.sample_basis ?? ex?.sample_basis ?? null,
        claim?.gap_notes ?? ex?.gap_notes ?? null, claim?.source_key ? await this.sourceId(claim.source_key) : (ex?.source_id ?? null)]
      if (ex) {
        await this.q(`update public.coverage_assessments set coverage_state = $4, tracked_count = $5, expected_count = $6, sample_basis = $7, gap_notes = $8,
            source_id = $9, assessed_on = current_date where domain = $1 and scope_key = $2 and organization_id = $3`, params)
      } else {
        await this.q(`insert into public.coverage_assessments (domain, scope_key, organization_id, coverage_state, tracked_count, expected_count, sample_basis, gap_notes, source_id, assessed_on)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, current_date)`, params)
      }
      out.push({ domain, scope, organization: org, state, tracked })
    }
    return out.sort((a, b) => `${a.domain}${a.scope}${a.organization}`.localeCompare(`${b.domain}${b.scope}${b.organization}`))
  }
}

/**
 * Apply a validated batch. write=false (default) is a dry run: everything executes, the report is collected, and the
 * canonical changes are rolled back. Re-applying an applied batch is allowed and must report no inserts (idempotency).
 */
export async function applyBatch (db, ref, { write = false, allowPartial = false } = {}) {
  const batch = await findBatch(db, ref)
  if (batch.status === 'STAGED') throw new PipelineError(`batch ${batch.batch_key} has not been validated; run research:validate first`)
  if (batch.status === 'ABANDONED') throw new PipelineError(`batch ${batch.batch_key} was abandoned`)
  if (batch.status === 'VALIDATION_FAILED' && !allowPartial) throw new PipelineError(`batch ${batch.batch_key} failed validation; fix the file or pass --allow-partial to apply only valid records`)
  // Automation safety: an agent may discover, stage and propose (validate, dry run), but its batch reaches canonical
  // tables only after a human review (research:review).
  if (write && /^agent:/.test(batch.imported_by)) {
    const reviewed = (await db.query('select reviewed_by from research.import_reviews where import_batch_id = $1', [batch.id])).rows[0]
    if (!reviewed) throw new PipelineError(`batch ${batch.batch_key} was staged by ${batch.imported_by}; a human must review it (research:review) before --write`)
  }

  const records = (await db.query("select * from ingest.staged_records where batch_id = $1 and validation_status = 'VALID' order by record_index", [batch.id])).rows
  const skippedInvalid = Number((await db.query("select count(*) n from ingest.staged_records where batch_id = $1 and validation_status <> 'VALID'", [batch.id])).rows[0].n)
  const a = new Applier(db, batch)
  const results = []
  const conflicts = []
  await db.query('begin')
  try {
    // Named in the decision history if this batch revokes a certification (021).
    await db.query("select set_config('bai.import_batch_id', $1, true), set_config('bai.actor', $2, true)", [String(batch.id), batch.imported_by])
    await db.query('savepoint canonical')
    const sourcesAdded = await a.registerSources()
    for (const rec of records) {
      const recConflicts = []
      if (rec.record_type === 'TRADE') {
        const res = await a.applyTrade(rec, recConflicts)
        results.push({ rec, action: strongest(res.action, recConflicts.length ? 'CONFLICT' : 'NO_CHANGE'), canonical: res.canonical, playerAction: res.newPlayers ? 'INSERT' : null })
        conflicts.push(...recConflicts.map((c) => ({ record_index: rec.record_index, ...c })))
        continue
      }
      const who = await a.resolvePlayer(rec, recConflicts)
      if (who.held) { results.push({ rec, action: 'HELD', reason: who.held }); continue }
      const res = rec.record_type === 'DRAFT_SELECTION' ? await a.applyDraftSelection(rec, who.playerId, recConflicts)
        : rec.record_type === 'OUTCOME_AUDIT' ? await a.applyOutcomeAudit(rec, who.playerId, recConflicts)
          : await a.applyInternationalSigning(rec, who.playerId, recConflicts)
      await a.applyFlags(rec.payload, { player: who.playerId, row: res.canonical })
      const action = strongest(strongest(res.action, who.action), recConflicts.length ? 'CONFLICT' : 'NO_CHANGE')
      results.push({ rec, action, canonical: res.canonical, identity: who.state, playerAction: who.action })
      conflicts.push(...recConflicts.map((c) => ({ record_index: rec.record_index, ...c })))
    }
    const coverage = await a.updateCoverage()
    // Every write above that touched a record of a certified class revoked it in the database (021 on_evidence_change),
    // in this transaction; the dry run reports the same revocations and then rolls them back.
    const revokedKeys = (await db.query(`select distinct c.class_key from research.decision_history h cross join unnest(h.revoked_class_ids) r(id)
      join research.classes c on c.id = r.id where h.import_batch_id = $1 and h.recorded_at = now() order by 1`, [batch.id])).rows.map((x) => x.class_key)
    if (!write) await db.query('rollback to savepoint canonical')

    for (const r of results) {
      await db.query(`update ingest.staged_records set ${write ? 'applied_action' : 'proposed_action'} = $2::ingest.apply_action, canonical_table = coalesce($3, canonical_table),
          canonical_id = coalesce($4, canonical_id), conflict_status = $5, conflict_details = $6 ${write ? ", applied_at = case when $2::ingest.apply_action = 'HELD' then null else coalesce(applied_at, now()) end" : ''} where id = $1`,
      [r.rec.id, r.action, write ? r.canonical?.[0] ?? null : null, write ? r.canonical?.[1] ?? null : null,
        conflicts.some((c) => c.record_index === r.rec.record_index) ? 'CONFLICT' : 'NONE',
        JSON.stringify(conflicts.filter((c) => c.record_index === r.rec.record_index))])
    }
    const counts = { records: records.length, skipped_invalid: skippedInvalid, sources_added: sourcesAdded, actions: {}, new_players: 0, held: 0, conflicts: conflicts.length, certifications_revoked: revokedKeys }
    for (const r of results) {
      counts.actions[r.action] = (counts.actions[r.action] ?? 0) + 1
      if (r.playerAction === 'INSERT') counts.new_players++
      if (r.action === 'HELD') counts.held++
    }
    const report = { step: write ? 'apply' : 'dry-run', ...counts, coverage }
    await db.query(`update ingest.import_batches set last_report = $2 ${write ? ", status = 'APPLIED', applied_at = coalesce(applied_at, now())" : ''} where id = $1`, [batch.id, JSON.stringify(report)])
    await db.query('commit')
    return { batch, report, results: results.map((r) => ({ record_index: r.rec.record_index, action: r.action, reason: r.reason ?? null, identity: r.identity ?? null })), conflicts }
  } catch (err) { await db.query('rollback'); throw err }
}

// ---------------------------------------------------------------------------------------------------------------
// Identity decisions, reconciliation, queues, coverage
// ---------------------------------------------------------------------------------------------------------------

export async function decideIdentity (db, recordId, { playerSlug = null, newPlayer = false, reject = false, operator, note }) {
  if (!operator || !note) throw new PipelineError('an identity decision needs --operator and --note')
  if ([playerSlug != null, newPlayer, reject].filter(Boolean).length !== 1) throw new PipelineError('choose exactly one of --player <slug>, --new-player, --reject')
  let playerId = null
  if (playerSlug) {
    const p = (await db.query('select id from public.players where slug = $1', [playerSlug])).rows[0]
    if (!p) throw new PipelineError(`player ${playerSlug} not found`)
    playerId = p.id
  }
  const r = await db.query(`update ingest.staged_records set review_state = $2, matched_player_id = $3, reviewed_by = $4, review_note = $5
    where id = $1 and applied_at is null returning id`, [recordId, reject ? 'REJECTED' : 'APPROVED', playerId, operator, note])
  if (!r.rowCount) throw new PipelineError(`staged record ${recordId} not found or already applied`)
  return { recordId, decision: reject ? 'REJECTED' : playerId ? `LINK ${playerSlug}` : 'NEW_PLAYER' }
}

export async function openConflicts (db) {
  const rows = (await db.query(`select c.subject_table, c.subject_id, c.field_name, c.declared_rule, c.observation_ids,
      json_agg(json_build_object('observation_id', o.id, 'source_key', s.source_key, 'authority', s.authority_level, 'value', o.observed_value,
        'locator', o.locator) order by o.id) as observations
    from public.v_open_fact_conflicts c
    join public.source_observations o on o.id = any (c.observation_ids)
    join public.sources s on s.id = o.source_id
    group by c.subject_table, c.subject_id, c.field_name, c.declared_rule, c.observation_ids
    order by c.subject_table, c.subject_id, c.field_name`)).rows
  return rows.map((r) => ({ ...r, rule_outcome: ruleOutcome(r) }))
}

const PRECISION_RANK = { DAY: 1, MONTH: 2, SEASON: 3, YEAR: 4, UNKNOWN: 5 }
const AUTHORITY_RANK = { OFFICIAL: 1, PRIMARY_PUBLIC: 2, REPUTABLE_SECONDARY: 3, AGGREGATOR: 4, ARCHIVE: 5, OTHER: 6 }

/** What the declared rule would choose: one observation id, or null when it falls back to an operator. */
export function ruleOutcome (conflict) {
  const obs = conflict.observations.filter((o) => o.value !== null)
  const pickStrict = (rank) => {
    const best = Math.min(...obs.map(rank))
    const top = obs.filter((o) => rank(o) === best)
    const values = new Set(top.map((o) => JSON.stringify(o.value)))
    return values.size === 1 ? top[0].observation_id : null
  }
  if (conflict.declared_rule === 'PREFER_HIGHER_AUTHORITY') return pickStrict((o) => AUTHORITY_RANK[o.authority])
  if (conflict.declared_rule === 'PREFER_MORE_PRECISE_DATE') {
    const p = (o) => PRECISION_RANK[typeof o.value === 'object' && o.value?.precision ? o.value.precision : 'DAY']
    return pickStrict(p)
  }
  return null
}

export const RESOLVABLE_COLUMNS = {
  players: ['birth_date', 'birth_country', 'primary_position'],
  draft_selections: ['position', 'round_pick'],
  draft_signings: ['signing_status', 'signing_bonus_usd', 'signing_date'],
  international_signings: ['signing_date', 'signing_bonus_usd', 'posting_fee_usd', 'transfer_fee_usd', 'other_cost_usd', 'pathway'],
  slot_values: ['slot_value_usd'],
  mlb_debuts: ['debut_date'],
  war_observations: ['war_value'],
  drafts: ['start_date', 'end_date', 'total_rounds'],
  acquisition_dispositions: ['disposition', 'disposition_date'],
  international_signing_periods: []
}

/**
 * Record a resolution. Either an operator choice (observationId + operator + rationale) or the declared rule
 * (useRule). The canonical column is set to the chosen value; non-column fields must already match the chosen value.
 * An operator choice made outside a reviewer session is a research judgment that blocks certification until a
 * reviewer ratifies it (021). Accepting a proposal is a reviewer action: acceptProposal.
 */
export async function resolveConflict (db, { subjectTable, subjectId, field, observationId = null, useRule = false, operator = null, rationale = null, proposalId = null, write = false }) {
  if (proposalId) throw new PipelineError('a proposal is accepted by a reviewer in their own session: research:accept --proposal <id> (not research:resolve)')
  const conflict = (await openConflicts(db)).find((c) => c.subject_table === subjectTable && String(c.subject_id) === String(subjectId) && c.field_name === field)
  if (!conflict) throw new PipelineError(`no open conflict on ${subjectTable}#${subjectId}.${field}`)
  let chosen = observationId
  let decidedBy = operator
  if (useRule) {
    chosen = conflict.rule_outcome
    if (!chosen) throw new PipelineError(`rule ${conflict.declared_rule} does not decide this conflict; an operator must choose`)
    decidedBy = `rule:${conflict.declared_rule}`
    rationale ??= `declared rule ${conflict.declared_rule}`
  } else if (!operator || !rationale || !observationId) throw new PipelineError('an operator resolution needs --observation, --operator and --rationale')
  const obs = conflict.observations.find((o) => String(o.observation_id) === String(chosen))
  if (!obs) throw new PipelineError(`observation ${chosen} is not part of this conflict`)
  const plan = { conflict: `${subjectTable}#${subjectId}.${field}`, chosen: obs, decided_by: decidedBy, rationale, canonical_update: null }

  await db.query('begin')
  try {
    await db.query("select set_config('bai.actor', $1, true)", [decidedBy])
    const resolvable = (RESOLVABLE_COLUMNS[subjectTable] ?? []).includes(field)
    if (!resolvable) {
      // Evidence-only field: the canonical value is what the row's own citation says; a resolution may only confirm it.
      const rowSource = (await db.query(`select s.source_key from public.${subjectTable} t join public.sources s on s.id = t.source_id where t.id = $1`, [subjectId])).rows[0]?.source_key
      const canonicalObs = conflict.observations.find((o) => o.source_key === rowSource)
      if (!canonicalObs || JSON.stringify(canonicalObs.value) !== JSON.stringify(obs.value)) {
        throw new PipelineError(`${field} is not a directly resolvable column; choosing a value other than the canonical one needs a corrective batch or migration`)
      }
    }
    // The decision first (its history row carries any revocation), then the canonical value.
    await db.query(`insert into public.fact_resolutions (subject_table, subject_id, field_name, chosen_observation_id, considered_observation_ids, rule, decided_by, rationale)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (subject_table, subject_id, field_name) do update set chosen_observation_id = excluded.chosen_observation_id,
        considered_observation_ids = excluded.considered_observation_ids, rule = excluded.rule, decided_by = excluded.decided_by,
        rationale = excluded.rationale, decided_at = now()`,
    [subjectTable, subjectId, field, chosen, conflict.observation_ids, useRule ? conflict.declared_rule : 'REQUIRE_OPERATOR', decidedBy, rationale])
    if (resolvable) {
      const cur = (await db.query(`select ${field} as v from public.${subjectTable} where id = $1`, [subjectId])).rows[0]
      // A date chosen for a row that had none gets DAY precision (observed dates are day-precise; the table needs both or neither).
      const extra = field.endsWith('_date') && ['draft_signings', 'international_signings', 'acquisition_dispositions'].includes(subjectTable) ? `, ${field}_precision = coalesce(${field}_precision, 'DAY')` : ''
      if (!same(field, cur.v, obs.value)) { plan.canonical_update = { from: cur.v, to: obs.value }; await db.query(`update public.${subjectTable} set ${field} = $2${extra} where id = $1`, [subjectId, obs.value]) }
    }
    await db.query(write ? 'commit' : 'rollback')
    return { ...plan, written: write }
  } catch (err) { await db.query('rollback'); throw err }
}

/** Runs a reviewer function (021) in a transaction; without write, a dry run that rolls back. */
async function reviewerCall (db, sql, params, write) {
  await db.query('begin')
  try {
    const r = (await db.query(sql, params)).rows[0]
    await db.query(write ? 'commit' : 'rollback')
    return r
  } catch (err) {
    await db.query('rollback')
    if (err.code === "42501") throw new PipelineError(`${err.message} (connect with your own reviewer login: BAI_REVIEWER_DATABASE_URL)`)
    throw err
  }
}

/**
 * Reconsiders a recorded resolution with the same evidence (021): the reviewer is whoever this database session
 * authenticated as (research.session_reviewer), never a name passed in. The previous judgment stays in the history; a
 * certified class touching the record loses its certification. Choosing the claim already chosen changes nothing.
 */
export async function reconsiderResolution (db, { subjectTable, subjectId, field, observationId, reason, evidence = [], proposalId = null, write = false }) {
  if (!reason) throw new PipelineError('reconsideration needs --reason')
  if (!observationId) throw new PipelineError('reconsideration needs --observation (the claim to choose)')
  const r = await reviewerCall(db, 'select research.reconsider_resolution($1, $2, $3, $4, $5, $6, $7) as r',
    [subjectTable, subjectId, field, observationId, reason, JSON.stringify(evidence.map((e) => ({ reviewer_evidence: e }))), proposalId], write)
  return { resolution: `${subjectTable}#${subjectId}.${field}`, ...r.r, written: write && !r.r.unchanged }
}

/** A reviewer accepts a proposal: decides the open conflict it names, or reconsiders the recorded decision. */
export async function acceptProposal (db, proposalId, { reason, evidence = [], write = false }) {
  if (!reason) throw new PipelineError('accepting a proposal needs --reason')
  const r = await reviewerCall(db, 'select research.accept_proposal($1, $2, $3) as r', [proposalId, reason, JSON.stringify(evidence.map((e) => ({ reviewer_evidence: e })))], write)
  return { proposal: proposalId, ...r.r, written: write }
}

/** A reviewer confirms, unchanged, a decision taken without a reviewer session. */
export async function ratifyResolution (db, resolutionId, { reason, evidence = [], write = false }) {
  if (!reason) throw new PipelineError('ratification needs --reason')
  const r = await reviewerCall(db, 'select * from research.ratify_resolution($1, $2, $3)', [resolutionId, reason, JSON.stringify(evidence.map((e) => ({ reviewer_evidence: e })))], write)
  return { ...r, written: write }
}

/**
 * Files a decision proposal: the claim the proposer recommends for a contested or decided field, with reasoning and
 * evidence. Anyone may propose (agents included); a proposal changes nothing until a reviewer accepts it
 * (research:accept) or rejects it. Filing the same open proposal twice returns it.
 */
export async function proposeDecision (db, { subjectTable, subjectId, field, observationId, proposedBy, rationale, evidence = [] }) {
  if (!proposedBy) throw new PipelineError('a proposal names its proposer (--operator or --agent)')
  if (!rationale) throw new PipelineError('a proposal needs --rationale')
  const obs = (await db.query(`select o.id, o.observed_value as value from public.source_observations o where o.id = $1 and o.subject_table = $2 and o.subject_id = $3 and o.field_name = $4 and o.status = 'ACTIVE'`,
    [observationId, subjectTable, subjectId, field])).rows[0]
  if (!obs) throw new PipelineError(`observation ${observationId} is not an active claim on ${subjectTable}#${subjectId}.${field}`)
  const open = (await openConflicts(db)).some((c) => c.subject_table === subjectTable && String(c.subject_id) === String(subjectId) && c.field_name === field)
  const decided = (await db.query('select 1 from public.fact_resolutions where subject_table = $1 and subject_id = $2 and field_name = $3', [subjectTable, subjectId, field])).rows.length > 0
  if (!open && !decided) throw new PipelineError('nothing to decide: the field has no conflict and no recorded resolution')
  const ex = (await db.query("select * from research.decision_proposals where subject_table = $1 and subject_id = $2 and field_name = $3 and proposed_observation_id = $4 and status = 'PROPOSED'",
    [subjectTable, subjectId, field, observationId])).rows[0]
  if (ex) return { proposal: ex, created: false, path: open ? 'resolve' : 'reconsider' }
  const proposal = (await db.query(`insert into research.decision_proposals (subject_table, subject_id, field_name, proposed_observation_id, proposed_value, proposed_by, rationale, evidence)
    values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`, [subjectTable, subjectId, field, observationId, JSON.stringify(obs.value), proposedBy, rationale, JSON.stringify(evidence)])).rows[0]
  return { proposal, created: true, path: open ? 'resolve' : 'reconsider' }
}

/** Rejects (a reviewer session, with a reason) or withdraws (the proposer) an open proposal. */
export async function closeProposal (db, id, { status, by = null, reason }) {
  if (!['REJECTED', 'WITHDRAWN'].includes(status)) throw new PipelineError('a proposal is closed as REJECTED or WITHDRAWN (accept it with research:accept)')
  if (!reason) throw new PipelineError('closing a proposal needs --reason')
  if (status === 'REJECTED') return reviewerCall(db, 'select * from research.reject_proposal($1, $2)', [id, reason], true)
  const r = (await db.query("update research.decision_proposals set status = 'WITHDRAWN', decided_by = $2, decided_at = now(), decision_reason = $3 where id = $1 returning *", [id, by, reason])).rows[0]
  if (!r) throw new PipelineError(`proposal ${id} not found`)
  return r
}

export async function listProposals (db, { status = 'PROPOSED' } = {}) {
  return (await db.query(`select p.id, p.created_at, p.subject_table, p.subject_id, p.field_name, p.proposed_observation_id, p.proposed_value, s.source_key, p.proposed_by, p.status, p.decided_by, p.rationale
    from research.decision_proposals p join public.source_observations o on o.id = p.proposed_observation_id join public.sources s on s.id = o.source_id
    where $1::text is null or p.status::text = $1 order by p.id`, [status])).rows
}

/** The decision history of one record, or of one class (newest first). */
export async function decisionHistory (db, { subjectTable = null, subjectId = null, classId = null, limit = 50 } = {}) {
  return (await db.query(`select id, recorded_at, kind, subject_table, subject_id, field_name, previous_value, new_value, previous_source_key, new_source_key, decided_by, reason,
      certification_impact, revoked_class_ids from research.decision_history
    where ($1::text is null or (subject_table = $1 and subject_id = $2)) and ($3::bigint is null or $3 = any (class_ids)) order by id desc limit $4`, [subjectTable, subjectId, classId, limit])).rows
}

export async function queueSummary (db) {
  return (await db.query(`select t.queue_key, t.priority, count(q.subject_id)::int as open_items
    from public.research_queue_types t left join public.v_research_queue q on q.queue_key = t.queue_key
    group by t.queue_key, t.priority order by t.priority, t.queue_key`)).rows
}

export async function queueItems (db, queueKey, limit = 25) {
  return (await db.query(`select q.queue_key, q.priority, q.subject_table, q.subject_id, q.scope_key, q.detail, p.slug as player, o.franchise_key as organization
    from public.v_research_queue q left join public.players p on p.id = q.player_id left join public.organizations o on o.id = q.organization_id
    where q.queue_key = $1 order by q.scope_key nulls last, q.subject_id limit $2`, [queueKey, limit])).rows
}

export async function coverageCells (db, { domain = null } = {}) {
  return (await db.query(`select c.domain, c.scope_key, o.franchise_key as organization, c.coverage_state, c.tracked_records, c.expected_count, c.audited_outcomes,
      c.cost_known_records, c.cost_basis_records, c.last_research_date, c.supports_population_rate
    from analytics.research_coverage_cells c join public.organizations o on o.id = c.organization_id
    where (c.tracked_records > 0 or c.coverage_state is not null) and ($1::text is null or c.domain::text = $1)
    order by c.domain, c.scope_start, o.franchise_key`, [domain])).rows
}
