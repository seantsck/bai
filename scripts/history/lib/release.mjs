// A manifest-bound research release (Phase 10.4): one draft year, an explicit scope, immutable batches, read-only collision
// checks, and an all-or-nothing apply through the established research pipeline. The functions here build and verify the
// manifest, classify collisions against a target database (read-only), and apply. Nothing in this module chooses to run.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { requireHostedPublication, loadCatalog, governingSources } from './permissions.mjs'
import { listMigrations } from '../../db/lib/migrations.mjs'
import * as P from '../../research/lib/pipeline.mjs'
import * as B from '../../research/lib/backfill.mjs'
import { withOuterTransaction } from '../../research/lib/txn.mjs'

export const RELEASE_FORMAT = 'bai-release-manifest/1'
export const REQUIRED_MIGRATION = '027'
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
export const fileSha256 = (file) => sha256(fs.readFileSync(file))

/** JSON with sorted keys, so a checksum does not depend on key order. */
export function canonicalJson (value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export const manifestChecksum = (manifest) => { const { manifest_sha256: _drop, ...rest } = manifest; return sha256(canonicalJson(rest)) }

const norm = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/g, '').replace(/[^a-z0-9]+/g, ' ').trim()

/** Builds a manifest from a release directory's batches (and the identity file's tiers). Pure given its inputs. */
export function buildManifest ({ humanApprovals = [], releaseKey, year, draftKey, batches, identity, article, chadwickCommit, identityFileSha256, brownVariant, heldPicks, catalog, maxSelections, createdOn }) {
  const docs = batches.map((b) => ({ ...b, picks: b.doc.records.map((r) => r.overall_pick).sort((x, y) => x - y) }))
  const records = docs.flatMap((b) => b.doc.records)
  const byPick = new Map(identity.picks.map((x) => [x.overall_pick, x]))
  const confidence = records.map((r) => {
    const x = byPick.get(r.overall_pick)
    const hasIds = Boolean(r.player.external_ids)
    return { pick: r.overall_pick, name: r.player.full_name, club: r.organization, identity: hasIds ? 'VERIFIED' : x?.status === 'AMBIGUOUS' ? 'UNRESOLVED_NAME_ONLY' : 'SINGLE_SOURCE_NAME_ONLY', ids_attached: hasIds ? Object.keys(r.player.external_ids) : [], basis: hasIds ? (x?.basis ?? null) : null }
  }).sort((a, b) => a.pick - b.pick)
  const tier = {}
  for (const c of confidence) tier[c.identity] = (tier[c.identity] ?? 0) + 1
  const sourceKeys = [...new Set(docs.flatMap((b) => b.doc.sources.map((s) => s.source_key)))].sort()
  const sources = sourceKeys.map((k) => {
    const cited = docs.flatMap((b) => b.doc.sources).find((s) => s.source_key === k)
    const { sources: gov } = governingSources(catalog, cited)
    return { source_key: k, catalog_source: gov.map((g) => g.id), license: gov.map((g) => g.license?.name), publish_site: gov.map((g) => g.uses.publish_site.state), attribution_required: gov.map((g) => g.license?.attribution ?? null), url: cited.url, publisher: cited.publisher ?? null }
  })
  const orgs = Object.fromEntries([...new Set(records.map((r) => r.organization))].sort().map((o) => [o, records.filter((r) => r.organization === o).length]))
  const idCount = records.reduce((n, r) => n + Object.keys(r.player.external_ids ?? {}).length, 0)
  const wdObs = records.reduce((n, r) => n + (r.evidence?.length ?? 0), 0)
  const manifest = {
    format: RELEASE_FORMAT, release_key: releaseKey, created_on: createdOn,
    authorization_scope: { draft_year: year, draft_key: draftKey, channel: 'DRAFT', max_selections: maxSelections, note: 'This manifest authorises nothing by itself. A separate, explicit approval must name its checksum.' },
    article: { revision: article.revision, response_sha256: article.response_sha256, title: `${year} Major League Baseball draft` },
    chadwick_commit: chadwickCommit, identity_file_sha256: identityFileSha256, tyler_brown_101: brownVariant,
    required_migration: REQUIRED_MIGRATION,
    batches: docs.map((b) => ({ file: b.file, batch_key: b.doc.batch_key, organization: b.doc.records[0].organization, sha256: b.sha256, records: b.doc.records.length, picks: b.picks })),
    totals: { selections: records.length, organizations: Object.keys(orgs).length, per_organization: orgs, held: heldPicks, identity_tiers: tier },
    coverage: { state: 'PARTIAL_RECONSTRUCTION', clubs: Object.keys(orgs).length, note: 'One aggregator list per club; no independently compiled list. No club is a complete census.' },
    human_approvals: humanApprovals,
    sources, identity_confidence: confidence,
    expected_database_changes: {
      draft_selections_inserted: records.length, draft_signings_inserted: 0, signing_rows: 0, bonuses: 0,
      players_created_max: records.length, external_ids_inserted_max: idCount, source_observations_inserted_max: wdObs + records.length * 3,
      sources_inserted_max: sources.length, coverage_claims: Object.keys(orgs).length, import_batches: docs.length, research_classes_max: Object.keys(orgs).length, release_audits: 1,
      untouched: ['migrations', 'views', 'grants', 'certification', 'reviewers', 'historical years', 'existing players, selections and observations']
    },
    verification_plan: [
      'preview with --target hosted (read-only): every batch checksum, source permission, organization, identity and collision check is SAFE',
      'apply runs every batch inside ONE transaction and commits only if the in-transaction counts equal this manifest (selections, per-club counts, zero signings)',
      'after commit: npm run hosted:refresh; hosted:verify (11/11); hosted:parity (0 differences over expected objects); hosted:security; integrity violations 0; public /draft shows the 2020 class as partial',
      'ingest.release_audits holds the per-record outcomes for this manifest'
    ],
    rollback_plan: [
      'before commit: any failed check rolls the whole transaction back; nothing persists',
      'after commit, if a verification fails: delete only what this release inserted, identified by the batch keys and release audit (draft selections of draft 2020-JUNE_AMATEUR whose source is the manifest article revision, their observations and the players created by those batches that have no other citation), in one transaction, then refresh read models; the audit table keeps its record',
      'Vercel needs no rollback: production code is unchanged by this release'
    ]
  }
  manifest.manifest_sha256 = manifestChecksum(manifest)
  return manifest
}

/** Reads a release directory and verifies the manifest checksum and every batch file's checksum. */
export function loadRelease (dir) {
  const manifestFile = path.join(dir, 'release-manifest.json')
  if (!fs.existsSync(manifestFile)) throw new Error(`${manifestFile} not found`)
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  if (manifest.format !== RELEASE_FORMAT) throw new Error('not a release manifest')
  if (manifestChecksum(manifest) !== manifest.manifest_sha256) throw new Error('the manifest does not match its own checksum (edited after it was written)')
  const batches = manifest.batches.map((b) => {
    const file = path.join(dir, 'batches', b.file)
    if (!fs.existsSync(file)) throw new Error(`batch file ${b.file} is missing`)
    const sha = fileSha256(file)
    if (sha !== b.sha256) throw new Error(`batch ${b.file} does not match the manifest checksum`)
    return { ...b, path: file, doc: JSON.parse(fs.readFileSync(file, 'utf8')) }
  })
  const extra = fs.readdirSync(path.join(dir, 'batches')).filter((f) => f.endsWith('.json') && !manifest.batches.some((b) => b.file === f))
  if (extra.length) throw new Error(`batch files not in the manifest: ${extra.join(', ')}`)
  return { manifest, batches, dir }
}

/** Scope, content and permission checks that need no database. Returns a list of problems (empty = ok). */
export function verifyReleaseContent (rel, { root }) {
  const m = rel.manifest
  const problems = []
  const catalog = loadCatalog(root)
  const picks = []
  let signing = 0
  for (const b of rel.batches) {
    const doc = b.doc
    if (doc.channel !== 'DRAFT') problems.push(`${b.file}: not a DRAFT batch`)
    if (doc.records.length !== b.records) problems.push(`${b.file}: record count differs from the manifest`)
    for (const c of doc.coverage_claims ?? []) {
      if (c.coverage_state !== 'PARTIAL_RECONSTRUCTION') problems.push(`${b.file}: coverage ${c.coverage_state} (a release of this kind is PARTIAL_RECONSTRUCTION only)`)
      if (c.scope_key !== m.authorization_scope.draft_key) problems.push(`${b.file}: coverage scope ${c.scope_key} is outside the authorised ${m.authorization_scope.draft_key}`)
    }
    for (const r of doc.records) {
      picks.push(r.overall_pick)
      if (r.draft_key !== m.authorization_scope.draft_key) problems.push(`${b.file}: pick ${r.overall_pick} is in ${r.draft_key}, outside the authorised ${m.authorization_scope.draft_key}`)
      if (r.type !== 'DRAFT_SELECTION') problems.push(`${b.file}: record type ${r.type}`)
      if (r.signing && (r.signing.status !== 'UNKNOWN' || r.signing.bonus_usd != null || r.signing.signing_date)) signing++
      if (!r.player?.full_name) problems.push(`${b.file}: pick ${r.overall_pick} has no player name`)
      if (r.player.external_ids && !r.player.external_id_sources) problems.push(`${b.file}: pick ${r.overall_pick} carries ids with no provenance`)
      if (r.player.external_ids && !(r.evidence ?? []).some((e) => e.field === 'wikidata_item')) problems.push(`${b.file}: pick ${r.overall_pick} carries ids without the recorded Wikidata corroboration`)
    }
    try { requireHostedPublication(catalog, doc, {}, { root }) } catch (err) { problems.push(`${b.file}: ${err.message}`) }
  }
  for (const a of m.human_approvals ?? []) {
    if (!a.approved_by || /^agent:/i.test(a.approved_by) || !a.approved_on || !a.note || !a.code || !Number.isInteger(a.pick)) problems.push(`human approval for pick ${a.pick}: needs a human approved_by, approved_on, code and note`)
    if (!picks.includes(a.pick)) problems.push(`human approval for pick ${a.pick}, which is not in the release`)
  }
  if (signing) problems.push(`${signing} record(s) carry a signing status, date or bonus; a release carries none`)
  if (new Set(picks).size !== picks.length) problems.push('a pick appears in more than one batch')
  if (picks.length !== m.totals.selections) problems.push(`records (${picks.length}) differ from the manifest total (${m.totals.selections})`)
  if (picks.length > m.authorization_scope.max_selections) problems.push(`records (${picks.length}) exceed the authorised maximum (${m.authorization_scope.max_selections})`)
  return problems
}

const rowsOf = async (db, sql, params) => (await db.query(sql, params)).rows

/** The migration history must be exactly the committed files 001..REQUIRED, with their checksums. */
export async function migrationProblems (db) {
  const files = listMigrations().filter((m) => m.version <= REQUIRED_MIGRATION)
  const have = new Map((await rowsOf(db, 'select version, file, checksum from bai_meta.schema_migrations')).map((r) => [r.version, r]))
  const problems = []
  for (const f of files) {
    const h = have.get(f.version)
    if (!h) problems.push(`migration ${f.file} is not applied`)
    else if (h.checksum !== f.checksum || h.file !== f.file) problems.push(`migration ${f.file} differs from the committed file`)
  }
  const known = new Set(files.map((f) => f.version))
  const extra = [...have.keys()].filter((v) => !known.has(v))
  if (extra.length) problems.push(`target has migrations the repository does not: ${extra.join(', ')}`)
  return problems
}

/**
 * Read-only collision classification of every record against a target database. SAFE: the record can be applied as it is.
 * HUMAN_REVIEW: a person must decide first (the pick is left out of a release until then). BLOCKED: the release cannot
 * proceed as built. Identity is never linked by name: a name-only record that shares a name with an existing player is
 * HUMAN_REVIEW, because the importer would hold it.
 */
export async function collisionReport (db, rel) {
  const m = rel.manifest
  const year = m.authorization_scope.draft_year
  const draftKey = m.authorization_scope.draft_key
  await db.query('begin read only')
  try {
    const report = { release_key: m.release_key, manifest_sha256: m.manifest_sha256, target: {}, entries: [], notes: [] }
    const mig = await migrationProblems(db)
    report.target.migrations = mig.length ? mig : 'ok'
    const draft = (await rowsOf(db, 'select id, draft_year from public.drafts where draft_key = $1', [draftKey]))[0] ?? null
    report.target.draft = draft ? 'present' : 'MISSING'
    const orgs = new Map((await rowsOf(db, 'select id, franchise_key, active, first_season from public.organizations')).map((o) => [o.franchise_key, o]))
    const existingSel = draft ? await rowsOf(db, `select s.id, s.overall_pick, s.player_id, o.franchise_key from public.draft_selections s join public.organizations o on o.id = s.organization_id where s.draft_id = $1`, [draft.id]) : []
    const players = await rowsOf(db, 'select id, full_name, birth_date from public.players')
    const aliases = await rowsOf(db, `select player_id, alias from public.player_aliases`).catch(() => [])
    const ids = await rowsOf(db, 'select player_id, id_system::text as id_system, external_id from public.player_external_ids')
    const sources = new Map((await rowsOf(db, 'select source_key, source_type::text as source_type, title, publisher, url from public.sources where source_key = any($1)', [rel.batches.flatMap((b) => b.doc.sources.map((s) => s.source_key))])).map((s) => [s.source_key, s]))
    const staged = new Map((await rowsOf(db, 'select batch_key, file_sha256, status::text as status from ingest.import_batches where batch_key = any($1)', [rel.batches.map((b) => b.doc.batch_key)])).map((r) => [r.batch_key, r]))
    const audit = (await rowsOf(db, 'select id from ingest.release_audits where release_key = $1 and manifest_sha256 = $2', [m.release_key, m.manifest_sha256]).catch(() => []))[0] ?? null
    report.target.already_applied = Boolean(audit)
    report.target.existing_selections_in_draft = existingSel.length
    const byName = new Map()
    for (const p of players) { const k = norm(p.full_name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(p) }
    for (const a of aliases) { const k = norm(a.alias); if (!byName.has(k)) byName.set(k, []); byName.get(k).push({ id: a.player_id, full_name: a.alias, birth_date: null }) }
    const idHolder = new Map(ids.map((r) => [`${r.id_system}:${r.external_id}`, r.player_id]))
    const idsOf = new Map()
    for (const r of ids) { if (!idsOf.has(r.player_id)) idsOf.set(r.player_id, {}); idsOf.get(r.player_id)[r.id_system] = r.external_id }

    for (const b of rel.batches) {
      const st = staged.get(b.batch_key)
      for (const s of b.doc.sources) {
        const ex = sources.get(s.source_key)
        if (ex && (ex.url !== (s.url ?? null) || ex.title !== s.title || (ex.publisher ?? null) !== (s.publisher ?? null) || ex.source_type !== s.source_type)) report.notes.push({ level: 'BLOCKED', code: 'SOURCE_CONFLICT', detail: `${s.source_key} exists with different details` })
      }
      for (const r of b.doc.records) {
        const checks = []
        const add = (level, code, detail) => checks.push({ level, code, detail })
        const org = orgs.get(r.organization)
        if (!draft) add('BLOCKED', 'DRAFT_MISSING', `${draftKey} is not on the target`)
        if (!org) add('BLOCKED', 'ORGANIZATION_MISSING', r.organization)
        else if (!org.active || (org.first_season ?? 0) > year) add('BLOCKED', 'ORGANIZATION_INCONSISTENT', `${r.organization} (active ${org.active}, first season ${org.first_season})`)
        if (st && st.file_sha256 !== b.sha256) add('BLOCKED', 'STAGED_BATCH_DIFFERS', `${b.batch_key} is already staged with other content`)
        else if (st && st.status !== 'APPLIED') add('HUMAN_REVIEW', 'STAGED_BATCH_NOT_APPLIED', `${b.batch_key} is staged (${st.status}) but not applied`)
        const at = existingSel.filter((e) => e.overall_pick === r.overall_pick)
        const supplied = r.player.external_ids ?? {}
        const holderIds = Object.entries(supplied).map(([sys, v]) => idHolder.get(`${sys}:${v}`)).filter((x) => x != null)
        // A replay: this exact batch is already applied and the selection on the target is this record (same club, and the same
        // player by identifier, or by name for a name-only record). Nothing else is checked for a replay.
        let replay = false
        if (at.length) {
          const batchApplied = st?.status === 'APPLIED' && st.file_sha256 === b.sha256
          const player = players.find((p) => p.id === at[0].player_id)
          const same = at[0].franchise_key === r.organization && (holderIds.length ? holderIds.every((h) => h === at[0].player_id) : player && norm(player.full_name) === norm(r.player.full_name))
          if (same && batchApplied) { add('SAFE', 'REPLAY', 'the selection is already on the target from this batch'); replay = true }
          else add('BLOCKED', 'SELECTION_EXISTS', `pick ${r.overall_pick} is already on the target (${at[0].franchise_key})`)
        }
        // Identifiers.
        const holders = [...new Set(holderIds)]
        if (replay) { /* nothing more to check */ } else if (holders.length > 1) add('BLOCKED', 'IDENTIFIERS_SPLIT', `the record's identifiers belong to ${holders.length} different players`)
        else if (holders.length === 1 && !at.length) {
          const held = idsOf.get(holders[0]) ?? {}
          const conflicting = Object.entries(supplied).filter(([sys, v]) => held[sys] && held[sys] !== v)
          if (conflicting.length) add('BLOCKED', 'IDENTIFIER_CONFLICT', `existing player ${holders[0]} holds a different ${conflicting.map(([s]) => s).join(', ')}`)
          else add('HUMAN_REVIEW', 'WOULD_LINK_EXISTING_PLAYER', `an identifier already belongs to existing player ${holders[0]}; the importer would link by that identifier`)
        }
        // Names: the importer's rule is that a same-name player is a candidate unless it holds a different id in a supplied system.
        const sameName = (byName.get(norm(r.player.full_name)) ?? []).filter((p) => !holders.includes(p.id))
        const candidates = sameName.filter((p) => { const held = idsOf.get(p.id) ?? {}; return !Object.entries(supplied).some(([sys, v]) => held[sys] && held[sys] !== v) })
        if (replay) { /* nothing more to check */ } else if (candidates.length) {
          const exactBirth = r.player.birth_date && candidates.some((p) => p.birth_date && new Date(p.birth_date).toISOString().slice(0, 10) === r.player.birth_date)
          add('HUMAN_REVIEW', Object.keys(supplied).length ? 'SAME_NAME_PLAYER_WITHOUT_ID_CONFLICT' : 'SAME_NAME_PLAYER', `${candidates.length} existing player(s) share the name${exactBirth ? ' and the birth date' : ''}; the importer would hold this record rather than link by name (players ${candidates.map((p) => p.id).join(', ')})`)
        } else if (sameName.length) add('SAFE', 'SAME_NAME_DIFFERENT_IDENTIFIERS', `${sameName.length} existing player(s) share the name but hold different identifiers`)
        // A HUMAN_REVIEW check is cleared only by a human approval recorded in the manifest for that pick and code; BLOCKED never is.
        for (const c of checks) if (c.level === 'HUMAN_REVIEW' && (m.human_approvals ?? []).some((a) => a.pick === r.overall_pick && a.code === c.code)) { c.level = 'SAFE'; c.approved = true }
        const level = checks.some((c) => c.level === 'BLOCKED') ? 'BLOCKED' : checks.some((c) => c.level === 'HUMAN_REVIEW') ? 'HUMAN_REVIEW' : 'SAFE'
        report.entries.push({ pick: r.overall_pick, name: r.player.full_name, organization: r.organization, batch: b.batch_key, classification: level, checks })
      }
    }
    report.entries.sort((a, b) => a.pick - b.pick)
    report.summary = { SAFE: 0, HUMAN_REVIEW: 0, BLOCKED: 0 }
    for (const e of report.entries) report.summary[e.classification]++
    const targetBlocked = mig.length || !draft || report.notes.some((n) => n.level === 'BLOCKED')
    report.overall = report.summary.BLOCKED || targetBlocked ? 'BLOCKED' : report.summary.HUMAN_REVIEW ? 'HUMAN_REVIEW' : 'SAFE'
    return report
  } finally { await db.query('rollback') }
}

/**
 * Applies a verified release to the target in ONE transaction, through the research pipeline (stage, validate, dry run,
 * write for every batch). Refuses unless the migration history is exact and the collision report is SAFE; commits only if
 * no record was held and the in-transaction counts equal the manifest; writes the release audit in the same transaction.
 * Returns { already } for a replay. Throws (after rolling everything back) on any failure.
 */
export async function applyRelease (db, rel, { operator }) {
  const m = rel.manifest
  if (!operator || /^agent:/i.test(operator)) throw new Error('an operator who approved the release is required (not agent:*)')
  const mig = await migrationProblems(db)
  if (mig.length) throw new Error(`target migration history: ${mig.join('; ')}`)
  const already = (await db.query('select id from ingest.release_audits where release_key = $1 and manifest_sha256 = $2', [m.release_key, m.manifest_sha256])).rows[0]
  if (already) return { already: true, audit_id: already.id }
  const report = await collisionReport(db, rel)
  if (report.overall !== 'SAFE') throw new Error(`collision report is ${report.overall}: ${canonicalJson(report.summary)}; resolve before applying (run preview)`)
  const signingCount = async () => (await db.query(`select count(*)::int n from public.draft_signings g join public.draft_selections s on s.id = g.draft_selection_id join public.drafts d on d.id = s.draft_id where d.draft_key = $1`, [m.authorization_scope.draft_key])).rows[0].n
  const result = await withOuterTransaction(db, async () => {
    const selectionCount = async () => (await db.query(`select count(*)::int n from public.draft_selections s join public.drafts d on d.id = s.draft_id where d.draft_key = $1`, [m.authorization_scope.draft_key])).rows[0].n
    const selectionsBefore = await selectionCount()
    const signingsBefore = await signingCount()
    const entries = []
    const batches = []
    for (const b of rel.batches) {
      const org = b.organization
      const { batch, already: stagedAlready } = await P.stageFile(db, b.path, { operator, organization: org })
      if (stagedAlready && batch.status === 'APPLIED') { entries.push(...b.picks.map((pick) => ({ pick, batch: b.batch_key, outcome: 'SKIPPED_ALREADY_APPLIED' }))); continue }
      const { cls } = await B.createClass(db, { org, channel: 'draft', year: m.authorization_scope.draft_year, kind: m.authorization_scope.draft_key.slice(5) }, { actor: operator })
      await B.linkImport(db, cls.class_key, batch.id, { actor: operator })
      const v = await P.validateBatch(db, batch.id)
      if (!v.ok) throw new Error(`${b.batch_key}: validation failed (${v.counts.invalid} invalid)`)
      const dry = await P.applyBatch(db, batch.id, { write: false })
      const held = dry.results.filter((r) => r.action === 'HELD')
      if (held.length || dry.conflicts.length) throw new Error(`${b.batch_key}: dry run held ${held.length} record(s) and found ${dry.conflicts.length} conflict(s)`)
      const applied = await P.applyBatch(db, batch.id, { write: true })
      entries.push(...applied.results.map((r) => ({ pick: b.doc.records[r.record_index]?.overall_pick ?? null, batch: b.batch_key, outcome: r.action, reason: r.reason ?? null })))
      batches.push({ batch_key: b.batch_key, records: b.records, report: applied.report })
    }
    // Verification against the manifest, still inside the transaction.
    const sel = (await db.query(`select s.overall_pick, o.franchise_key from public.draft_selections s join public.drafts d on d.id = s.draft_id join public.organizations o on o.id = s.organization_id join public.sources src on src.id = s.source_id
      where d.draft_key = $1 and src.source_key = any($2)`, [m.authorization_scope.draft_key, rel.batches.flatMap((b) => b.doc.sources.map((x) => x.source_key))])).rows
    const expected = new Map(rel.batches.flatMap((b) => b.doc.records.map((r) => [r.overall_pick, r.organization])))
    const missing = [...expected].filter(([pick, club]) => !sel.some((x) => x.overall_pick === pick && x.franchise_key === club))
    if (missing.length) throw new Error(`verification failed: manifest selections missing or at another club on the target: ${missing.map(([p]) => p).join(',')}`)
    // Every identifier in the manifest is held by the player of that selection, from the cited source; no other MLB id is.
    const idRows = (await db.query(`select s.overall_pick, e.external_id from public.draft_selections s join public.drafts d on d.id = s.draft_id join public.player_external_ids e on e.player_id = s.player_id and e.id_system = 'MLBAM' where d.draft_key = $1`, [m.authorization_scope.draft_key])).rows
    for (const b of rel.batches) for (const r of b.doc.records) {
      const want = r.player.external_ids?.MLBAM ?? null
      const have = idRows.find((x) => x.overall_pick === r.overall_pick)?.external_id ?? null
      if (want && have !== want) throw new Error(`verification failed: pick ${r.overall_pick} should hold MLBAM ${want} but holds ${have}`)
      if (!want && have) throw new Error(`verification failed: pick ${r.overall_pick} is name-only in the manifest but holds MLBAM ${have} (a link nobody approved)`)
    }
    const signingsAfter = await signingCount()
    if (signingsAfter !== signingsBefore + Number(m.expected_database_changes.draft_signings_inserted)) throw new Error(`verification failed: signing rows for the draft went from ${signingsBefore} to ${signingsAfter}; the manifest expects none added`)
    const counts = { selections: expected.size, imported: entries.filter((e) => !['SKIPPED_ALREADY_APPLIED', 'HELD'].includes(e.outcome)).length, skipped: entries.filter((e) => e.outcome === 'SKIPPED_ALREADY_APPLIED').length, held: entries.filter((e) => e.outcome === 'HELD').length, held_in_manifest: m.totals.held.length }
    if (counts.held) throw new Error(`verification failed: ${counts.held} record(s) were held by the importer`)
    const added = (await selectionCount()) - selectionsBefore
    if (added !== counts.imported) throw new Error(`verification failed: the draft gained ${added} selections but ${counts.imported} were imported; the manifest expects ${m.expected_database_changes.draft_selections_inserted}`)
    await db.query('insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ($1, $2, $3, $4, $5, $6)', [m.release_key, m.manifest_sha256, m.authorization_scope.draft_year, operator, JSON.stringify(counts), JSON.stringify(entries)])
    return { counts, entries, batches }
  })
  return { already: false, collision_overall: report.overall, ...result }
}
