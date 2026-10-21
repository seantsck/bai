// League-wide backfill orchestration: research classes, the job planner, the deterministic queue, resumable research
// batches, blockers, source leads, stage transitions and certification. Works for any of the 30 organizations; nothing
// here knows about a particular club. Canonical facts are never written here: they still enter only through ingest
// batches (pipeline.mjs). This module writes the private `research` schema only.
import { PipelineError, isoDate } from './pipeline.mjs'

const one = async (db, sql, p) => (await db.query(sql, p)).rows[0]
const rows = async (db, sql, p) => (await db.query(sql, p)).rows

export const STAGES = ['DISCOVERY', 'ROSTER_RECONSTRUCTION', 'IDENTITY_RECONCILIATION', 'SIGNING_STATUS', 'FINANCIALS', 'SOURCE_RECONCILIATION', 'OUTCOME_AUDIT', 'COVERAGE_REVIEW', 'CERTIFIED']
const TERMINAL = new Set(['DONE', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED'])
// Categories whose open jobs do not block certification: outcomes are audited on their own clock (NOT_AUDITED is not a
// failure), excerpt-only evidence is flagged rather than forbidden, and the certification job is closed by certify.
const NON_BLOCKING = new Set(['OUTCOME_NOT_AUDITED', 'LOW_QUALITY_SOURCE', 'COVERAGE_CERTIFICATION'])

/** Runs fn in a transaction with bai.actor set, so job/batch events record who acted. */
async function tx (db, actor, fn) {
  await db.query('begin')
  try {
    await db.query("select set_config('bai.actor', $1, true)", [actor])
    const r = await fn()
    await db.query('commit')
    return r
  } catch (err) { await db.query('rollback'); throw err }
}

const requireActor = (actor, what) => {
  if (!actor || actor === true) throw new PipelineError(`${what} needs --operator <name>`)
  return actor
}

// ---------------------------------------------------------------------------------------------------------------
// Organizations and class scope
// ---------------------------------------------------------------------------------------------------------------

/** Franchise key, abbreviation or (with a season) a historical name -> organization row. Never guesses. */
export async function resolveOrganization (db, name, season = null) {
  if (!name || name === true) throw new PipelineError('an organization is required (--org <franchise key>); BAI never assumes one')
  const r = await one(db, 'select public.resolve_organization($1, $2) as id', [String(name), season])
  if (!r.id) throw new PipelineError(`unknown or ambiguous organization "${name}"${season ? ` in ${season}` : ''}`)
  return one(db, 'select id, franchise_key, current_name, active from public.organizations where id = $1', [r.id])
}

const CHANNEL_ALIASES = { draft: 'DRAFT', international: 'INTERNATIONAL', intl: 'INTERNATIONAL' }
export function channelKey (c) {
  if (!c || c === true) throw new PipelineError('a channel is required (--channel draft|international)')
  return CHANNEL_ALIASES[String(c).toLowerCase()] ?? String(c).toUpperCase()
}

/** {org, channel, year | period} -> the class scope (no writes). */
export const DRAFT_KINDS = ['JUNE_AMATEUR', 'JANUARY_REGULAR', 'JANUARY_SECONDARY', 'JUNE_SECONDARY', 'JUNE_SECONDARY_DELAYED', 'AUGUST_LEGION']

export async function classScope (db, { org, channel, year, period, kind = 'JUNE_AMATEUR' }) {
  const ch = await one(db, 'select * from research.channels where channel_key = $1', [channelKey(channel)])
  if (!ch) throw new PipelineError(`unknown channel ${channel}`)
  let scope
  if (ch.scope_kind === 'DRAFT') {
    if (!year || year === true) throw new PipelineError('a draft class needs --year <YYYY>')
    // Historical years hold several phases (024); June regular is the default, others are named with --kind.
    const k = String(kind === true ? '' : kind || 'JUNE_AMATEUR').toUpperCase()
    if (!DRAFT_KINDS.includes(k)) throw new PipelineError(`unknown draft phase ${kind} (${DRAFT_KINDS.join(', ')})`)
    const d = await one(db, 'select id, draft_key, draft_year from public.drafts where draft_year = $1 and draft_kind = $2', [Number(year), k])
    if (!d) throw new PipelineError(`no ${year} ${k} draft on the calendar`)
    scope = { draftId: d.id, scopeKey: d.draft_key, season: d.draft_year }
  } else if (ch.scope_kind === 'SIGNING_PERIOD') {
    if (!period || period === true) throw new PipelineError('an international class needs --period <key, e.g. 2016-17>')
    const p = await one(db, 'select id, period_key, extract(year from start_date)::int as season from public.international_signing_periods where period_key = $1', [String(period)])
    if (!p) throw new PipelineError(`no signing period ${period} on the calendar`)
    scope = { periodId: p.id, scopeKey: p.period_key, season: p.season }
  } else throw new PipelineError(`channel ${ch.channel_key} is not implemented yet`)
  const o = await resolveOrganization(db, org, scope.season)
  if (scope.draftId && !(await one(db, 'select public.organization_exists_in_season($1, $2) as ok', [o.id, scope.season])).ok) {
    throw new PipelineError(`${o.franchise_key} did not exist in ${scope.season}`)
  }
  return { channel: ch, organization: o, ...scope, classKey: `${o.franchise_key}/${ch.channel_key}/${scope.scopeKey}` }
}

export async function findClass (db, ref) {
  const c = typeof ref === 'object'
    ? await one(db, 'select * from research.classes where class_key = $1', [(await classScope(db, ref)).classKey])
    : await one(db, 'select * from research.classes where class_key = $1 or id::text = $1', [String(ref)])
  if (!c) throw new PipelineError(`research class ${typeof ref === 'object' ? (await classScope(db, ref)).classKey : ref} does not exist; create it with research:class ... --create`)
  return c
}

export async function createClass (db, scopeArgs, { actor }) {
  requireActor(actor, 'creating a class')
  const s = await classScope(db, scopeArgs)
  return tx(db, actor, async () => {
    const existing = await one(db, 'select * from research.classes where class_key = $1', [s.classKey])
    if (existing) return { cls: existing, created: false }
    const cls = await one(db, `insert into research.classes (class_key, organization_id, channel_key, draft_id, signing_period_id, scope_key, created_by)
      values ($1, $2, $3, $4, $5, $6, $7) returning *`, [s.classKey, s.organization.id, s.channel.channel_key, s.draftId ?? null, s.periodId ?? null, s.scopeKey, actor])
    await db.query("insert into research.stage_events (class_id, from_stage, to_stage, actor, rationale) values ($1, null, 'DISCOVERY', $2, 'class created')", [cls.id, actor])
    return { cls, created: true }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Planner: data state -> deterministic jobs
// ---------------------------------------------------------------------------------------------------------------

/** Natural, database-independent labels (same on local and hosted). */
const playerLabel = (p) => p.mlbam ? `player-mlbam-${p.mlbam}` : `player-${p.slug}`

async function desiredJobs (db, cls) {
  const m = await one(db, 'select * from research.v_class_metrics where class_id = $1', [cls.id])
  const want = []
  const add = (category, label, title, extra = {}) => want.push({ category, label, title, ...extra })
  const universeKnown = m.expected_count != null && m.coverage_source_id != null
  if (!universeKnown) add('EXPECTED_UNIVERSE_UNKNOWN', 'class', `Establish the expected size of ${cls.class_key}`)
  if (m.tracked === 0 || (m.expected_count != null && m.tracked < m.expected_count)) add('CLASS_NOT_RECONSTRUCTED', 'class', `Reconstruct ${cls.class_key} (${m.tracked} tracked${m.expected_count != null ? ` of ${m.expected_count}` : ''})`)
  add('COVERAGE_CERTIFICATION', 'class', `Review coverage and certify ${cls.class_key}`)

  // Players of the class, with natural labels.
  const players = new Map((await rows(db, `select p.id, p.slug, p.display_name, (select external_id from public.player_external_ids x where x.player_id = p.id and x.id_system = 'MLBAM') as mlbam,
      exists (select 1 from public.player_external_ids x where x.player_id = p.id) as has_id, o.audit_state
    from public.players p join public.v_player_outcome_status o on o.player_id = p.id
    where p.id in (select player_id from public.draft_selections where draft_id = $1 and organization_id = $3
                   union select player_id from public.international_signings where signing_period_id = $2 and organization_id = $3)`,
  [cls.draft_id, cls.signing_period_id, cls.organization_id])).map((p) => [String(p.id), p]))
  const subjectLabels = new Map()
  for (const p of players.values()) {
    subjectLabels.set(`players:${p.id}`, playerLabel(p))
    if (!p.has_id) add('IDENTITY_UNRESOLVED', playerLabel(p), `Resolve identity of ${p.display_name}`, { subject: ['players', p.id], player: p.id })
    if (p.audit_state === 'NOT_AUDITED') add('OUTCOME_NOT_AUDITED', playerLabel(p), `Audit outcome of ${p.display_name}`, { subject: ['players', p.id], player: p.id })
  }

  if (cls.channel_key === 'DRAFT') {
    const picks = await rows(db, `select s.id, s.overall_pick, s.round_pick, s.school_id, s.player_id, r.round_order, r.round_code, g.id as signing_id, g.signing_status, g.signing_bonus_usd,
        v.id as slot_id, p.display_name
      from public.draft_selections s join public.draft_rounds r on r.id = s.round_id join public.players p on p.id = s.player_id
      left join public.draft_signings g on g.draft_selection_id = s.id
      left join public.slot_values v on v.draft_id = s.draft_id and v.overall_pick = s.overall_pick
      where s.draft_id = $1 and s.organization_id = $2 order by s.overall_pick`, [cls.draft_id, cls.organization_id])
    for (const k of picks) {
      const label = `pick-${k.overall_pick}`
      const who = `pick ${k.overall_pick} (${k.display_name})`
      subjectLabels.set(`draft_selections:${k.id}`, label)
      if (k.signing_id) subjectLabels.set(`draft_signings:${k.signing_id}`, `${label}-signing`)
      if (!k.signing_status) add('SIGNING_STATUS_UNKNOWN', label, `Determine signing status of ${who}`, { subject: ['draft_selections', k.id], player: k.player_id })
      if (k.signing_status === 'SIGNED' && k.signing_bonus_usd == null) add('ACQUISITION_COST_MISSING', label, `Find the signing bonus of ${who}`, { subject: ['draft_selections', k.id], player: k.player_id })
      if (k.round_order <= 100 && !k.slot_id) add('SLOT_VALUE_MISSING', label, `Capture the slot value of ${who}`, { subject: ['draft_selections', k.id], player: k.player_id })
      if (!k.school_id) add('SCHOOL_MISSING', label, `Identify the school of ${who}`, { subject: ['draft_selections', k.id], player: k.player_id })
    }
  } else {
    const sigs = await rows(db, `select i.id, i.player_id, i.signing_date_precision, i.cost_completeness, p.display_name
      from public.international_signings i join public.players p on p.id = i.player_id
      where i.signing_period_id = $1 and i.organization_id = $2 order by p.display_name, i.id`, [cls.signing_period_id, cls.organization_id])
    for (const s of sigs) {
      const label = `signing-${playerLabel(players.get(String(s.player_id)))}`
      subjectLabels.set(`international_signings:${s.id}`, label)
      if (s.signing_date_precision !== 'DAY') add('TRANSACTION_DATE_MISSING', label, `Find the transaction date of ${s.display_name}`, { subject: ['international_signings', s.id], player: s.player_id })
      if (s.cost_completeness === 'UNKNOWN') add('ACQUISITION_COST_MISSING', label, `Find the signing cost of ${s.display_name}`, { subject: ['international_signings', s.id], player: s.player_id })
    }
  }

  const labelOf = (t, id) => subjectLabels.get(`${t}:${id}`)
  for (const c of await rows(db, 'select subject_table, subject_id, field_name from public.v_open_fact_conflicts order by 1, 2, 3')) {
    const l = labelOf(c.subject_table, c.subject_id)
    if (l) add('SOURCE_CONFLICT', `${l}-${c.field_name}`, `Resolve conflicting ${c.field_name} on ${l}`, { subject: [c.subject_table, c.subject_id] })
  }
  for (const f of await rows(db, "select subject_table, subject_id from public.quality_flags where status = 'OPEN' and flag_code = 'EVIDENCE_EXCERPT_ONLY' order by 1, 2")) {
    const l = labelOf(f.subject_table, f.subject_id)
    if (l) add('LOW_QUALITY_SOURCE', l, `Replace excerpt-only evidence for ${l}`, { subject: [f.subject_table, f.subject_id] })
  }
  // Records held for an identity decision in imports linked to the class.
  for (const r of await rows(db, `select b.batch_key, s.record_index, s.payload #>> '{player,full_name}' as name from research.class_imports ci
      join ingest.import_batches b on b.id = ci.import_batch_id join ingest.staged_records s on s.batch_id = b.id
      where ci.class_id = $1 and s.validation_status = 'VALID' and s.review_state = 'NEEDS_REVIEW' and s.applied_at is null order by 1, 2`, [cls.id])) {
    add('IDENTITY_UNRESOLVED', `staged-${r.batch_key}-${r.record_index}`, `Decide the identity of ${r.name} (staged record ${r.record_index} of ${r.batch_key})`)
  }
  return { want, metrics: m }
}

/**
 * Brings a class's jobs in line with its data. Idempotent: creates missing jobs, closes PLANNER jobs whose condition no
 * longer holds (DONE, "resolved in data"), and reopens a DONE planner job whose condition came back. Never touches
 * UNRESOLVED/CANCELLED/SUPERSEDED jobs or jobs a researcher or agent created.
 */
export async function planClass (db, clsRef, { actor }) {
  requireActor(actor, 'planning')
  const cls = await findClass(db, clsRef)
  return tx(db, actor, async () => {
    const { want } = await desiredJobs(db, cls)
    const cats = new Map((await rows(db, 'select * from research.job_categories')).map((c) => [c.category_key, c]))
    const keyed = new Map(want.map((w) => [`${cls.class_key}/${w.category}/${w.label}`, w]))
    const existing = new Map((await rows(db, 'select * from research.jobs where class_id = $1', [cls.id])).map((j) => [j.job_key, j]))
    const out = { created: 0, closed: 0, reopened: 0 }
    for (const [key, w] of [...keyed].sort((a, b) => a[0].localeCompare(b[0]))) {
      const ex = existing.get(key)
      if (!ex) {
        await db.query(`insert into research.jobs (job_key, class_id, category_key, subject_table, subject_id, subject_label, player_id, title, source_requirements, origin)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PLANNER')`,
        [key, cls.id, w.category, w.subject?.[0] ?? null, w.subject?.[1] ?? null, w.label, w.player ?? null, w.title, cats.get(w.category).source_requirements])
        out.created++
      } else if (ex.state === 'DONE' && ex.origin === 'PLANNER' && w.category !== 'COVERAGE_CERTIFICATION') {
        await db.query("update research.jobs set state = 'OPEN', completed_at = null, completion_rationale = null, title = $2 where id = $1", [ex.id, w.title])
        out.reopened++
      } else if (!TERMINAL.has(ex.state) && ex.title !== w.title) {
        await db.query('update research.jobs set title = $2 where id = $1', [ex.id, w.title])
      }
    }
    for (const [key, j] of existing) {
      if (keyed.has(key) || TERMINAL.has(j.state) || j.origin !== 'PLANNER') continue
      await db.query("update research.jobs set state = 'DONE', completed_at = now(), completion_rationale = 'resolved in data (planner re-check)' where id = $1", [j.id])
      out.closed++
    }
    // Outcome audits wait for identity: an outcome job depends on the open identity job of the same player, if any.
    await db.query(`update research.jobs o set depends_on_job_id = i.id from research.jobs i
      where o.class_id = $1 and i.class_id = $1 and o.category_key = 'OUTCOME_NOT_AUDITED' and i.category_key = 'IDENTITY_UNRESOLVED'
        and o.subject_label = i.subject_label and o.depends_on_job_id is null and not research.job_state_terminal(i.state) and o.state = 'OPEN'`, [cls.id])
    return { cls, ...out }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------------------

/** The deterministic queue (research.v_next_jobs). A single-organization view needs org; league-wide needs league. */
export async function nextJobs (db, { org, league = false, channel, year, period, stage, limit = 10 } = {}) {
  if (!org && !league) throw new PipelineError('research:next needs --org <franchise key> or an explicit --league')
  const where = []
  const params = []
  const p = (v) => { params.push(v); return `$${params.length}` }
  if (org) where.push(`franchise_key = ${p((await resolveOrganization(db, org)).franchise_key)}`)
  if (channel) where.push(`channel_key = ${p(channelKey(channel))}`)
  if (year) where.push(`scope_key = ${p((await one(db, "select draft_key from public.drafts where draft_year = $1 and draft_kind = 'JUNE_AMATEUR'", [Number(year)]))?.draft_key ?? `none-${year}`)}`)
  if (period) where.push(`scope_key = ${p(String(period))}`)
  if (stage) {
    const st = String(stage).toUpperCase()
    if (!STAGES.includes(st)) throw new PipelineError(`unknown stage ${stage}`)
    where.push(`job_stage = ${p(st)}`)
  }
  return rows(db, `select * from research.v_next_jobs ${where.length ? `where ${where.join(' and ')}` : ''} order by queue_position limit ${Number(limit) || 10}`, params)
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs: state changes, blockers, leads
// ---------------------------------------------------------------------------------------------------------------

export async function findJob (db, key) {
  const j = await one(db, 'select * from research.jobs where job_key = $1 or id::text = $1', [String(key)])
  if (!j) throw new PipelineError(`job ${key} not found`)
  return j
}

const ALLOWED = {
  OPEN: ['IN_PROGRESS', 'BLOCKED', 'DONE', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED'],
  IN_PROGRESS: ['OPEN', 'BLOCKED', 'DONE', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED'],
  BLOCKED: ['OPEN', 'IN_PROGRESS', 'UNRESOLVED', 'CANCELLED', 'SUPERSEDED'],
  // "Unknown after research" can be overtaken by a later source; the job is superseded (with a rationale), never reopened,
  // and its UNRESOLVED closing stays in job_events.
  UNRESOLVED: ['SUPERSEDED']
}

/** Moves a job. Terminal states need a rationale; BLOCKED needs a reason; terminal jobs never move again, except UNRESOLVED -> SUPERSEDED. */
export async function setJobState (db, key, state, { actor, rationale = null, reason = null, assign } = {}) {
  requireActor(actor, 'changing a job')
  const j = await findJob(db, key)
  if (j.category_key === 'COVERAGE_CERTIFICATION' && ['DONE', 'UNRESOLVED'].includes(state)) throw new PipelineError('the certification job is closed only by research:certify')
  if (!(ALLOWED[j.state] ?? []).includes(state)) throw new PipelineError(`job ${j.job_key} is ${j.state}; cannot move to ${state}`)
  if (TERMINAL.has(state) && !rationale) throw new PipelineError(`closing a job as ${state} needs --rationale`)
  if (state === 'BLOCKED' && !reason) throw new PipelineError('blocking a job needs --reason')
  return tx(db, actor, async () => one(db, `update research.jobs set state = $2, completion_rationale = case when $3::text is not null then $3 else completion_rationale end,
      completed_at = case when research.job_state_terminal($2::research.job_state) then now() end,
      blocking_reason = case when $2 = 'BLOCKED' then $4 else blocking_reason end,
      assigned_to = case when $5::boolean then $6 else assigned_to end where id = $1 returning *`,
  [j.id, state, rationale, reason, assign !== undefined, assign ?? null]))
}

/** A researcher- or agent-created job inside a class (e.g. a question the planner cannot see). */
export async function addJob (db, clsRef, { category, label, title, actor, origin = 'RESEARCHER', dependsOn = null, notes = null }) {
  requireActor(actor, 'adding a job')
  const cls = await findClass(db, clsRef)
  const cat = await one(db, 'select * from research.job_categories where category_key = $1', [String(category).toUpperCase()])
  if (!cat) throw new PipelineError(`unknown category ${category}`)
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(label ?? '')) throw new PipelineError('a job label must be lowercase letters, digits, . _ -')
  const dep = dependsOn ? await findJob(db, dependsOn) : null
  return tx(db, actor, async () => one(db, `insert into research.jobs (job_key, class_id, category_key, subject_label, title, source_requirements, origin, depends_on_job_id, notes)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
  [`${cls.class_key}/${cat.category_key}/${label}`, cls.id, cat.category_key, label, title, cat.source_requirements, origin, dep?.id ?? null, notes]))
}

export async function addLead (db, jobKey, lead, { actor, origin = 'RESEARCHER' }) {
  requireActor(actor, 'recording a lead')
  const j = await findJob(db, jobKey)
  return tx(db, actor, async () => one(db, `insert into research.source_leads (job_id, url, reference, source_type, authority_level, access, retrieved_date, archived_url,
      evidence_note, excerpt_only, fields_supported, recorded_by, origin) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
  [j.id, lead.url ?? null, lead.reference ?? null, lead.source_type, lead.authority_level, lead.access, lead.retrieved_date ?? null, lead.archived_url ?? null,
    lead.evidence_note, Boolean(lead.excerpt_only || lead.access === 'EXCERPT_ONLY'), lead.fields_supported ?? [], actor, origin]))
}

// ---------------------------------------------------------------------------------------------------------------
// Research batches (resumable sessions)
// ---------------------------------------------------------------------------------------------------------------

export async function findResearchBatch (db, key) {
  const b = await one(db, 'select * from research.batches where batch_key = $1 or id::text = $1', [String(key)])
  if (!b) throw new PipelineError(`research batch ${key} not found`)
  return b
}

/** Starts a session on a class and takes the next N actionable jobs of that class (queue order) into it. */
export async function startBatch (db, clsRef, { key, actor, goal = null, take = 10 }) {
  requireActor(actor, 'starting a research batch')
  const cls = await findClass(db, clsRef)
  return tx(db, actor, async () => {
    const active = await one(db, "select batch_key from research.batches where class_id = $1 and state = 'STARTED'", [cls.id])
    if (active) throw new PipelineError(`class ${cls.class_key} already has an active batch ${active.batch_key}; resume, pause or complete it first`)
    const b = await one(db, 'insert into research.batches (batch_key, class_id, operator, goal) values ($1, $2, $3, $4) returning *', [key, cls.id, actor, goal])
    const jobs = await rows(db, `select job_id from research.v_next_jobs where class_key = $1 and job_id not in
        (select bj.job_id from research.batch_jobs bj join research.batches x on x.id = bj.batch_id where x.state in ('STARTED', 'PAUSED'))
      order by queue_position limit $2`, [cls.class_key, Number(take)])
    for (const j of jobs) {
      await db.query('insert into research.batch_jobs (batch_id, job_id) values ($1, $2)', [b.id, j.job_id])
      await db.query("update research.jobs set state = 'IN_PROGRESS', assigned_to = $2 where id = $1 and state = 'OPEN'", [j.job_id, actor])
    }
    return { batch: b, jobs: jobs.length }
  })
}

export async function batchProgress (db, key) {
  const b = await findResearchBatch(db, key)
  const jobs = await rows(db, `select j.job_key, j.title, j.state, j.blocking_reason, k.priority_rank from research.batch_jobs bj join research.jobs j on j.id = bj.job_id
    join research.job_categories k on k.category_key = j.category_key where bj.batch_id = $1 order by k.priority_rank, j.job_key`, [b.id])
  const remaining = jobs.filter((j) => !TERMINAL.has(j.state))
  return { batch: b, total: jobs.length, done: jobs.length - remaining.length, remaining }
}

async function moveBatch (db, key, to, actor, { note = null, failure = null, supersededBy = null } = {}) {
  const b = await findResearchBatch(db, key)
  const from = { STARTED: ['PAUSED', 'COMPLETED', 'FAILED', 'SUPERSEDED'], PAUSED: ['STARTED', 'COMPLETED', 'FAILED', 'SUPERSEDED'] }
  if (!(from[b.state] ?? []).includes(to)) throw new PipelineError(`research batch ${b.batch_key} is ${b.state}; cannot move to ${to}`)
  await db.query(`update research.batches set state = $2::research.batch_state, ended_at = case when $2::text in ('COMPLETED', 'FAILED', 'SUPERSEDED') then now() end,
      failure_reason = coalesce($3, failure_reason), superseded_by_id = coalesce($4, superseded_by_id), goal = coalesce(goal, $5) where id = $1`,
  [b.id, to, failure, supersededBy, note])
  return b
}

export const pauseBatch = (db, key, { actor, note }) => tx(db, requireActor(actor, 'pausing'), () => moveBatch(db, key, 'PAUSED', actor, { note }))

/** Resume: back to STARTED and return exactly what remains (never reconstruct progress from transcripts). */
export async function resumeBatch (db, key, { actor }) {
  requireActor(actor, 'resuming')
  const b = await findResearchBatch(db, key)
  if (b.state === 'PAUSED') await tx(db, actor, () => moveBatch(db, key, 'STARTED', actor))
  else if (b.state !== 'STARTED') throw new PipelineError(`research batch ${b.batch_key} is ${b.state}; it cannot be resumed`)
  return batchProgress(db, key)
}

/** Complete: all of its jobs must be finished, unless release=true, which returns the rest to the open queue. */
export async function completeBatch (db, key, { actor, release = false }) {
  requireActor(actor, 'completing')
  const { batch, remaining } = await batchProgress(db, key)
  if (remaining.length && !release) throw new PipelineError(`${remaining.length} job(s) in ${batch.batch_key} are not finished; finish them or pass --release to return them to the queue`)
  return tx(db, actor, async () => {
    for (const j of remaining) await db.query("update research.jobs set state = 'OPEN', assigned_to = null where job_key = $1 and state = 'IN_PROGRESS'", [j.job_key])
    await moveBatch(db, key, 'COMPLETED', actor)
    return { batch, released: remaining.length }
  })
}

export async function failBatch (db, key, { actor, reason }) {
  requireActor(actor, 'failing a batch')
  if (!reason || reason === true) throw new PipelineError('a failed batch needs --reason')
  const { remaining } = await batchProgress(db, key)
  return tx(db, actor, async () => {
    for (const j of remaining) await db.query("update research.jobs set state = 'OPEN', assigned_to = null where job_key = $1 and state = 'IN_PROGRESS'", [j.job_key])
    return moveBatch(db, key, 'FAILED', actor, { failure: reason })
  })
}

/** Supersede: a new batch takes over the unfinished jobs; the old one keeps its history and points at its successor. */
export async function supersedeBatch (db, key, { actor, newKey, goal = null }) {
  requireActor(actor, 'superseding')
  if (!newKey || newKey === true) throw new PipelineError('superseding needs --new <batch key>')
  const { batch, remaining } = await batchProgress(db, key)
  if (!['STARTED', 'PAUSED'].includes(batch.state)) throw new PipelineError(`research batch ${batch.batch_key} is ${batch.state}; it cannot be superseded`)
  return tx(db, actor, async () => {
    const nb = await one(db, "insert into research.batches (batch_key, class_id, operator, goal, state) values ($1, $2, $3, $4, 'PAUSED') returning *", [newKey, batch.class_id, actor, goal ?? batch.goal])
    await moveBatch(db, key, 'SUPERSEDED', actor, { supersededBy: nb.id })
    await db.query("update research.batches set state = 'STARTED' where id = $1", [nb.id])
    for (const j of remaining) await db.query('insert into research.batch_jobs (batch_id, job_id) select $1, id from research.jobs where job_key = $2', [nb.id, j.job_key])
    return { old: batch, batch: nb, moved: remaining.length }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Stages and certification
// ---------------------------------------------------------------------------------------------------------------

async function openJobsByStage (db, classId) {
  return Object.fromEntries((await rows(db, `select k.stage, count(*)::int n from research.jobs j join research.job_categories k on k.category_key = j.category_key
    where j.class_id = $1 and not research.job_state_terminal(j.state) group by 1 order by 1`, [classId])).map((r) => [r.stage, r.n]))
}

/** One step forward (or back). Moving on with unresolved items is allowed but recorded; skipping is refused. */
export async function advanceStage (db, clsRef, { actor, to = null, rationale = null }) {
  requireActor(actor, 'changing a stage')
  const cls = await findClass(db, clsRef)
  const i = STAGES.indexOf(cls.stage)
  const target = to ? String(to).toUpperCase() : STAGES[i + 1]
  if (!STAGES.includes(target)) throw new PipelineError(`unknown stage ${to}`)
  if (target === 'CERTIFIED') throw new PipelineError('CERTIFIED is reached only through research:certify')
  if (STAGES.indexOf(target) < i && !rationale) throw new PipelineError('moving a class back needs --rationale')
  const open = await openJobsByStage(db, cls.id)
  const leftBehind = STAGES.slice(0, STAGES.indexOf(target)).reduce((n, s) => n + (open[s] ?? 0), 0)
  return tx(db, actor, async () => {
    await db.query('update research.classes set stage = $2 where id = $1', [cls.id, target])
    await db.query('insert into research.stage_events (class_id, from_stage, to_stage, actor, rationale, open_jobs) values ($1, $2, $3, $4, $5, $6)',
      [cls.id, cls.stage, target, actor, rationale, JSON.stringify(open)])
    return { from: cls.stage, to: target, openJobsBefore: leftBehind, open }
  })
}

/** Deterministic certification check. Returns the list of blockers (empty = certifiable). */
export async function certificationBlockers (db, clsRef) {
  const cls = await findClass(db, clsRef)
  const m = await one(db, 'select * from research.v_class_metrics where class_id = $1', [cls.id])
  const jobs = await rows(db, 'select * from research.jobs where class_id = $1', [cls.id])
  const blockers = []
  const block = (code, detail) => blockers.push({ code, detail })
  const unresolved = (cat) => new Set(jobs.filter((j) => j.category_key === cat && j.state === 'UNRESOLVED').map((j) => `${j.subject_table}:${j.subject_id}`))
  if (cls.stage !== 'COVERAGE_REVIEW') block('STAGE', `class is at ${cls.stage}; certification happens from COVERAGE_REVIEW (advance one stage at a time)`)
  const universeKnown = m.expected_count != null && m.coverage_source_id != null
  const universeExplicitlyUnknown = jobs.some((j) => j.category_key === 'EXPECTED_UNIVERSE_UNKNOWN' && j.state === 'UNRESOLVED')

  if (cls.channel_key === 'DRAFT') {
    if (!universeKnown) block('EXPECTED_UNIVERSE', 'expected pick count not established with a source (a draft class must establish it)')
    else if (m.tracked !== m.expected_count) block('ROSTER', `${m.tracked} of ${m.expected_count} expected picks tracked`)
    if (m.tracked === 0) block('ROSTER', 'no picks tracked')
    if (m.round_pick_known !== m.tracked) block('PICK_NUMBERS', `${m.tracked - m.round_pick_known} pick(s) lack a round pick number`)
    if (m.status_unknown > 0) block('SIGNING_STATUS', `${m.status_unknown} pick(s) without a signing status`)
    const picks = await rows(db, `select s.id, s.school_id, r.round_order, g.signing_status, g.signing_bonus_usd, v.id as slot_id from public.draft_selections s
      join public.draft_rounds r on r.id = s.round_id left join public.draft_signings g on g.draft_selection_id = s.id
      left join public.slot_values v on v.draft_id = s.draft_id and v.overall_pick = s.overall_pick where s.draft_id = $1 and s.organization_id = $2`, [cls.draft_id, cls.organization_id])
    const uCost = unresolved('ACQUISITION_COST_MISSING')
    const uSlot = unresolved('SLOT_VALUE_MISSING')
    const uSchool = unresolved('SCHOOL_MISSING')
    const costGaps = picks.filter((p) => p.signing_status === 'SIGNED' && p.signing_bonus_usd == null && !uCost.has(`draft_selections:${p.id}`)).length
    const slotGaps = picks.filter((p) => p.round_order <= 100 && !p.slot_id && !uSlot.has(`draft_selections:${p.id}`)).length
    const schoolGaps = picks.filter((p) => !p.school_id && !uSchool.has(`draft_selections:${p.id}`)).length
    if (costGaps) block('COST', `${costGaps} signed pick(s) with no bonus and no recorded "unknown after research" (close the job as UNRESOLVED with a rationale)`)
    if (slotGaps) block('SLOT', `${slotGaps} pick(s) in rounds 1-10 without a slot value or an UNRESOLVED slot job`)
    if (schoolGaps) block('SCHOOL', `${schoolGaps} pick(s) without a school or an UNRESOLVED school job`)
    if (universeKnown && m.tracked === m.expected_count && !['COMPLETE_CENSUS', 'SUBSTANTIALLY_COMPLETE'].includes(m.coverage_state)) {
      block('COVERAGE', `every expected pick is tracked but coverage is ${m.coverage_state ?? 'not assessed'}; record a sourced COMPLETE_CENSUS claim through an import batch`)
    }
  } else {
    if (!universeKnown && !universeExplicitlyUnknown) block('EXPECTED_UNIVERSE', 'class size neither established with a source nor recorded as unknown after research (close EXPECTED_UNIVERSE_UNKNOWN as UNRESOLVED with a rationale)')
    if (universeKnown && m.tracked !== m.expected_count) block('ROSTER', `${m.tracked} of ${m.expected_count} expected signings tracked`)
    if (m.tracked === 0) block('ROSTER', 'no signings tracked')
    if (!universeKnown && public_rate_state(m.coverage_state)) block('COVERAGE', `coverage ${m.coverage_state} claims a census, but the class universe is unknown`)
    if (!universeKnown && m.coverage_state !== 'PARTIAL_RECONSTRUCTION') block('COVERAGE', `with an unknown universe the class must stay PARTIAL_RECONSTRUCTION (is ${m.coverage_state ?? 'not assessed'})`)
    const sigs = await rows(db, 'select id, signing_date_precision, cost_completeness from public.international_signings where signing_period_id = $1 and organization_id = $2', [cls.signing_period_id, cls.organization_id])
    const uDate = unresolved('TRANSACTION_DATE_MISSING')
    const uCost = unresolved('ACQUISITION_COST_MISSING')
    const dateGaps = sigs.filter((s) => s.signing_date_precision !== 'DAY' && !uDate.has(`international_signings:${s.id}`)).length
    const costGaps = sigs.filter((s) => s.cost_completeness === 'UNKNOWN' && !uCost.has(`international_signings:${s.id}`)).length
    if (dateGaps) block('TRANSACTION_DATE', `${dateGaps} signing(s) without a day-precision date or an UNRESOLVED date job`)
    if (costGaps) block('COST', `${costGaps} signing(s) with unknown cost and no recorded "unknown after research"`)
  }
  if (m.identity_complete !== m.tracked) block('IDENTITY', `${m.tracked - m.identity_complete} record(s) whose player has no external id`)
  if (m.provenanced !== m.tracked) block('PROVENANCE', `${m.tracked - m.provenanced} record(s) without a cited source`)
  if (m.open_conflicts > 0) block('CONFLICTS', `${m.open_conflicts} unresolved source conflict(s)`)
  // How each of the class's own acquisitions ended is a class fact (022); a contested one blocks like any other conflict.
  const dispConflicts = await one(db, `select count(*)::int n from public.v_open_fact_conflicts f
    join public.acquisition_dispositions x on f.subject_table = 'acquisition_dispositions' and f.subject_id = x.id
    left join public.draft_selections s on s.id = x.draft_selection_id left join public.international_signings i on i.id = x.international_signing_id
    where x.organization_id = $1 and (s.draft_id = $2 or i.signing_period_id = $3)`, [cls.organization_id, cls.draft_id, cls.signing_period_id])
  if (dispConflicts.n > 0) block('CONFLICTS', `${dispConflicts.n} unresolved conflict(s) on how the class's acquisitions ended (acquisition_dispositions)`)
  const unratified = await rows(db, 'select * from research.unratified_decisions($1) order by fact_resolution_id', [cls.id])
  if (unratified.length) block('DECISIONS', `${unratified.length} decision(s) taken without a reviewer session, not yet ratified: ${unratified.slice(0, 4).map((u) => `#${u.fact_resolution_id} ${u.subject_table}#${u.subject_id}.${u.field_name} (${u.decided_by})`).join(', ')}${unratified.length > 4 ? ', …' : ''} (research:ratify)`)
  const pending = jobs.filter((j) => !TERMINAL.has(j.state) && !NON_BLOCKING.has(j.category_key))
  if (pending.length) block('OPEN_JOBS', `${pending.length} open or blocked job(s) before outcome audit: ${pending.slice(0, 5).map((j) => j.job_key.split('/').slice(3).join('/')).join(', ')}${pending.length > 5 ? ', …' : ''}`)
  const held = await one(db, `select count(*)::int n from research.class_imports ci join ingest.staged_records s on s.batch_id = ci.import_batch_id
    where ci.class_id = $1 and s.validation_status = 'VALID' and s.review_state = 'NEEDS_REVIEW' and s.applied_at is null`, [cls.id])
  if (held.n) block('IDENTITY', `${held.n} staged record(s) held for an identity decision`)
  return { cls, metrics: m, blockers }
}

function public_rate_state (state) { return state === 'COMPLETE_CENSUS' || state === 'SUBSTANTIALLY_COMPLETE' }

/**
 * Records a deterministic certification check (021): the blockers, the metrics and a fingerprint of every record of the
 * class. Anyone may run it; it certifies nothing. A reviewer then certifies THAT check (certify), which the database
 * refuses if the class's evidence changed since.
 */
export async function recordCertificationCheck (db, clsRef, { actor }) {
  requireActor(actor, 'recording a certification check')
  const { cls, metrics, blockers } = await certificationBlockers(db, clsRef)
  const report = { metrics, checked_at: new Date().toISOString(), rules: 'docs/backfill-methodology.md#certification' }
  const chk = await one(db, `insert into research.certification_checks (class_id, checked_by, passed, coverage_state, blockers, report, fingerprint)
    values ($1, $2, $3, $4, $5, $6, research.class_fingerprint($1)) returning id, passed, fingerprint`,
  [cls.id, actor, blockers.length === 0, blockers.length === 0 ? metrics.coverage_state ?? 'UNKNOWN' : metrics.coverage_state ?? null, JSON.stringify(blockers), JSON.stringify(report)])
  return { cls, check: chk, blockers, coverage_state: metrics.coverage_state }
}

/**
 * Certifies a recorded, passing check. Only a reviewer session can (research.certify_class: the reviewer is the login
 * this connection authenticated as), only while the certification gate is open, and only if nothing changed since the
 * check. There is no force option and no name to pass.
 */
export async function certify (db, checkId) {
  if (!checkId) throw new PipelineError('certify needs --check <id> (record one with research:check)')
  await db.query('begin')
  try {
    const c = (await db.query('select * from research.certify_class($1)', [checkId])).rows[0]
    await db.query('commit')
    return c
  } catch (err) {
    await db.query('rollback')
    throw err.code === '42501' ? new PipelineError(`${err.message} (connect with your own reviewer login: BAI_REVIEWER_DATABASE_URL)`) : err
  }
}

/** Sets an organization's research program wave (priority data, no schema). A human decision with a rationale. */
export async function setWave (db, { org, wave, actor, rationale }) {
  requireActor(actor, 'setting a program wave')
  if (/^(agent|rule|system):/.test(actor)) throw new PipelineError('program waves are set by a human')
  if (![1, 2, 3].includes(Number(wave))) throw new PipelineError('wave must be 1, 2 or 3')
  if (!rationale) throw new PipelineError('setting a wave needs --rationale')
  const o = await one(db, 'select id from public.organizations where franchise_key = $1 and active', [String(org).toUpperCase()])
  if (!o) throw new PipelineError(`unknown organization ${org}`)
  return tx(db, actor, async () => one(db, `insert into research.program_waves (organization_id, wave, rationale, set_by) values ($1, $2, $3, $4)
    on conflict (organization_id) do update set wave = excluded.wave, rationale = excluded.rationale, set_by = excluded.set_by, set_at = now() returning *`, [o.id, Number(wave), rationale, actor]))
}

/**
 * Enrolls the reviewer this connection authenticated as (021): the human logs in with their own PostgreSQL role (a
 * member of bai_reviewer, created by an administrator) and binds a display name to it. No one enrolls anyone else.
 */
export async function enrollReviewer (db, { reviewer, note = null }) {
  if (!reviewer || /^(agent:|rule:|system:|bai-)/.test(reviewer)) throw new PipelineError('a reviewer is a named human (not agent:, rule:, system: or a bai- operator label)')
  try {
    return (await db.query('select * from research.enroll_reviewer($1, $2)', [reviewer, note])).rows[0]
  } catch (err) {
    throw err.code === '42501' ? new PipelineError(`${err.message} (enroll with your own reviewer login: BAI_REVIEWER_DATABASE_URL)`) : err
  }
}

/** Opening the certification gate is a reviewer-session decision (021); closing it removes power, so anyone may. */
export async function setCertificationGate (db, { enabled, reason, actor }) {
  if (!reason || reason === true) throw new PipelineError('changing the certification gate needs --reason')
  if (enabled) {
    try { return (await db.query('select * from research.set_certification_gate(true, $1)', [reason])).rows[0] } catch (err) {
      throw err.code === '42501' ? new PipelineError(`${err.message} (open the gate with your own reviewer login: BAI_REVIEWER_DATABASE_URL)`) : err
    }
  }
  requireActor(actor, 'closing the certification gate')
  return one(db, 'update research.certification_gate set enabled = false, changed_by = $1, reason = $2 returning *', [actor, reason])
}

/** Deactivating removes power, so any operator may do it (recorded with the session's role). */
export async function deactivateReviewer (db, { reviewer, actor }) {
  requireActor(actor, 'deactivating a reviewer')
  return tx(db, actor, async () => one(db, 'update research.reviewers set active = false, deactivated_at = now() where reviewer = $1 and active returning *', [reviewer]))
}

/** Revokes the active certification (a human act with a reason) and returns the class to COVERAGE_REVIEW. */
export async function revokeCertification (db, clsRef, { actor, reason }) {
  requireActor(actor, 'revoking a certification')
  if (/^agent:/.test(actor)) throw new PipelineError('an automated agent cannot revoke a certification')
  if (!reason || reason === true) throw new PipelineError('revoking needs --reason')
  const cls = await findClass(db, clsRef)
  return tx(db, actor, async () => {
    const c = await one(db, 'update research.certifications set revoked_at = now(), revoked_by = $2, revoke_reason = $3 where class_id = $1 and revoked_at is null returning id', [cls.id, actor, reason])
    if (!c) throw new PipelineError(`${cls.class_key} has no active certification`)
    await db.query("update research.classes set stage = 'COVERAGE_REVIEW' where id = $1", [cls.id])
    await db.query("insert into research.stage_events (class_id, from_stage, to_stage, actor, rationale) values ($1, 'CERTIFIED', 'COVERAGE_REVIEW', $2, $3)", [cls.id, actor, `certification revoked: ${reason}`])
    await db.query(`update research.jobs set state = 'OPEN', completed_at = null, completion_rationale = null
      where class_id = $1 and category_key = 'COVERAGE_CERTIFICATION' and state = 'DONE'`, [cls.id])
    return { cls, revoked: true }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------------------------

export async function classReport (db, clsRef) {
  const { cls, metrics, blockers } = await certificationBlockers(db, clsRef)
  const status = await one(db, 'select * from research.v_class_status where class_id = $1', [cls.id])
  const byStage = await rows(db, `select k.stage, count(*) filter (where not research.job_state_terminal(j.state))::int open,
      count(*) filter (where j.state = 'BLOCKED')::int blocked, count(*) filter (where j.state = 'UNRESOLVED')::int unresolved,
      count(*) filter (where j.state = 'DONE')::int done
    from research.jobs j join research.job_categories k on k.category_key = j.category_key where j.class_id = $1 group by 1 order by 1`, [cls.id])
  const blocked = await rows(db, "select job_key, blocking_reason from research.jobs where class_id = $1 and state = 'BLOCKED' order by job_key", [cls.id])
  const batches = await rows(db, 'select batch_key, state, operator, created_at::date::text as started from research.batches where class_id = $1 order by id', [cls.id])
  const imports = await rows(db, 'select b.batch_key, b.status from research.class_imports ci join ingest.import_batches b on b.id = ci.import_batch_id where ci.class_id = $1 order by b.id', [cls.id])
  const sources = await rows(db, `select s.authority_level, count(distinct s.id)::int n from public.source_observations o join public.sources s on s.id = o.source_id
    where (o.subject_table = 'draft_selections' and o.subject_id in (select id from public.draft_selections where draft_id = $1 and organization_id = $3))
       or (o.subject_table = 'draft_signings' and o.subject_id in (select g.id from public.draft_signings g join public.draft_selections s on s.id = g.draft_selection_id where s.draft_id = $1 and s.organization_id = $3))
       or (o.subject_table = 'slot_values' and o.subject_id in (select v.id from public.slot_values v join public.draft_selections s on s.draft_id = v.draft_id and s.overall_pick = v.overall_pick where s.draft_id = $1 and s.organization_id = $3))
       or (o.subject_table = 'international_signings' and o.subject_id in (select id from public.international_signings where signing_period_id = $2 and organization_id = $3))
    group by 1 order by 1`, [cls.draft_id, cls.signing_period_id, cls.organization_id])
  return { cls, status, metrics, blockers, byStage, blocked, batches, imports, sources }
}

/** Organization or league progress. League output covers every organization, including ones with no classes yet. */
export async function progress (db, { org = null } = {}) {
  const orgFilter = org ? (await resolveOrganization(db, org)).id : null
  const perOrg = await rows(db, `select o.franchise_key, o.current_name, coalesce(w.wave, 3) as wave,
      (select count(*) from research.classes c where c.organization_id = o.id)::int as classes,
      (select count(*) from research.v_class_status s join research.classes c on c.id = s.class_id where c.organization_id = o.id and s.workflow_status = 'CERTIFIED')::int as certified,
      (select count(*) from research.v_class_status s join research.classes c on c.id = s.class_id where c.organization_id = o.id and s.workflow_status = 'BLOCKED')::int as blocked_classes,
      (select count(*) from research.jobs j join research.classes c on c.id = j.class_id where c.organization_id = o.id and not research.job_state_terminal(j.state))::int as open_jobs,
      (select coalesce(sum(tracked_records), 0) from analytics.research_coverage_cells r where r.organization_id = o.id and r.domain = 'DRAFT')::int as draft_tracked,
      (select coalesce(sum(tracked_records), 0) from analytics.research_coverage_cells r where r.organization_id = o.id and r.domain = 'INTERNATIONAL')::int as intl_tracked,
      (select count(*) from analytics.research_coverage_cells r where r.organization_id = o.id and r.coverage_state is not null)::int as assessed_cells,
      (select count(*) from analytics.research_coverage_cells r where r.organization_id = o.id)::int as cells
    from public.organizations o left join research.program_waves w on w.organization_id = o.id
    where o.active and ($1::bigint is null or o.id = $1) order by coalesce(w.wave, 3), o.franchise_key`, [orgFilter])
  const classes = await rows(db, `select c.class_key, c.channel_key, c.scope_key, s.workflow_status, c.stage, m.coverage_state, m.tracked, m.expected_count, s.open_jobs, s.blocked_jobs
    from research.classes c join research.v_class_status s on s.class_id = c.id join research.v_class_metrics m on m.class_id = c.id
    where ($1::bigint is null or c.organization_id = $1) order by c.organization_id, c.channel_key, c.scope_key`, [orgFilter])
  return { perOrg, classes }
}

// ---------------------------------------------------------------------------------------------------------------
// Imports: organization scoping, class links, agent review
// ---------------------------------------------------------------------------------------------------------------

export { organizationScopeErrors } from './import-format.mjs'

export async function linkImport (db, clsRef, importBatchId, { actor }) {
  const cls = await findClass(db, clsRef)
  await db.query('insert into research.class_imports (class_id, import_batch_id, linked_by) values ($1, $2, $3) on conflict do nothing', [cls.id, importBatchId, actor])
  return cls
}

export async function reviewImport (db, batchRef, { reviewer, note }) {
  if (!reviewer || reviewer === true || /^agent:/.test(reviewer)) throw new PipelineError('an import review needs a human --reviewer (not agent:*)')
  if (!note || note === true) throw new PipelineError('an import review needs --note')
  const b = await one(db, 'select id, batch_key, imported_by from ingest.import_batches where id::text = $1 or batch_key = $1', [String(batchRef)])
  if (!b) throw new PipelineError(`batch ${batchRef} not found`)
  await db.query(`insert into research.import_reviews (import_batch_id, reviewed_by, review_note) values ($1, $2, $3)
    on conflict (import_batch_id) do update set reviewed_by = excluded.reviewed_by, review_note = excluded.review_note, reviewed_at = now()`, [b.id, reviewer, note])
  return b
}

export { isoDate }
