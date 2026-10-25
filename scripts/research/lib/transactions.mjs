// Transaction forensics importer (migration 028, docs/transactions/03 and 06): the version-2 TRADE record.
//
//   * prepare  - deterministic normalization of an input file (same content in any order gives the same bytes and the
//                same derived identity), no database;
//   * validate - shape and in-batch rules, no database (validateTradeV2, batchProblemsV2);
//   * plan     - read-only comparison with canonical data: NEW, EXISTING, COLLISION (same day, same clubs, no shared
//                identity) or CONFLICT (a value that disagrees). Used by preview and by apply, so a preview is exact;
//   * apply    - all-or-nothing per batch (the pipeline's transaction), idempotent, replay-protected by
//                ingest.transaction_apply_ledger. A collision or conflict holds the whole record and writes nothing but the
//                conflict record. Completeness is never set here: only a human verification does that.
//
// A version-2 record names, for every package and every asset, the sources that support it, and groups sources by
// independence (two articles repeating one announcement are one group).
import crypto from 'node:crypto'

export const TRADE_SCHEMA = 2
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isDate = (v) => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const KEY = /^[a-z0-9][a-z0-9_.:-]*$/
const GROUP = /^[a-z0-9][a-z0-9_.:-]{1,80}$/
const SCHEME = /^[A-Z][A-Z0-9_]{1,30}$/
export const SOURCE_ROLES = ['PRIMARY_ANNOUNCEMENT', 'CORROBORATION', 'REFERENCE']
export const DISCLOSURES = ['DISCLOSED', 'UNDISCLOSED', 'UNKNOWN']
export const CASH_TYPES = new Set(['CASH', 'INTERNATIONAL_POOL_SPACE'])
const ASSET_TYPES = ['CASH', 'PLAYER_TO_BE_NAMED', 'DRAFT_PICK', 'INTERNATIONAL_POOL_SPACE', 'OTHER']
const RESOLUTIONS = ['PLAYER', 'CASH', 'NOTHING']

// ---------------------------------------------------------------------------------------------------------------
// Canonical form
// ---------------------------------------------------------------------------------------------------------------

/** JSON with sorted object keys: equal content gives equal bytes. */
export function stableStringify (v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  if (v && typeof v === 'object') return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  return JSON.stringify(v)
}
const by = (f) => (a, b) => { const x = f(a); const y = f(b); return x < y ? -1 : x > y ? 1 : 0 }
const uniqSorted = (a) => [...new Set(a ?? [])].sort()
export const playerKey = (p) => `P:${p?.player?.external_ids?.MLBAM ?? ''}`
export const otherKey = (a) => `${a.asset_type}:${a.description ?? ''}`

function canonicalAsset (a) {
  const out = { asset_type: a.asset_type, description: a.description ?? null, source_keys: uniqSorted(a.source_keys) }
  if (CASH_TYPES.has(a.asset_type)) {
    out.amount_usd = a.amount_usd ?? null
    out.amount_disclosure = a.amount_usd != null ? 'DISCLOSED' : (a.amount_disclosure ?? 'UNKNOWN')
  }
  if (a.conditional || a.asset_type === 'PLAYER_TO_BE_NAMED') out.conditional = true
  if (a.condition_text != null) out.condition_text = a.condition_text
  if (a.resolution) {
    const r = a.resolution
    out.resolution = { kind: r.kind, resolved_on: r.resolved_on, resolved_on_precision: r.resolved_on_precision ?? 'DAY', source_key: r.source_key, notes: r.notes ?? null }
    if (r.kind === 'PLAYER') out.resolution.player = r.player
    if (r.kind === 'CASH') { out.resolution.amount_usd = r.amount_usd ?? null; out.resolution.amount_disclosure = r.amount_usd != null ? 'DISCLOSED' : (r.amount_disclosure ?? 'UNKNOWN') }
  }
  return out
}

/** The identity content of a trade: date, direction of each package, and what each carries. Independent of sources and wording. */
export function identityContent (r) {
  return {
    date: r.date,
    packages: (r.packages ?? []).map((k) => ({
      from: k.from, to: k.to,
      assets: [...(k.players ?? []).map(playerKey), ...(k.other_assets ?? []).map(otherKey)].sort()
    })).sort(by((k) => `${k.from}>${k.to}`))
  }
}
/** Deterministic importer identity (scheme BAI_TXN), used when the sources give no identifier of their own. */
export const derivedIdentity = (r) => sha('bai-txn|' + stableStringify(identityContent(r))).slice(0, 24)

export function canonicalizeTrade (r) {
  const out = {
    type: 'TRADE', schema: TRADE_SCHEMA, ref: r.ref, organization: r.organization, date: r.date, date_precision: r.date_precision ?? 'DAY',
    description: r.description ?? null, source_key: r.source_key,
    sources: [...(r.sources ?? [])].map((s) => ({ source_key: s.source_key, role: s.role, independence_group: s.independence_group, locator: s.locator ?? null, retrieved_on: s.retrieved_on ?? null }))
      .sort(by((s) => s.source_key)),
    packages: [...(r.packages ?? [])].map((k) => ({
      from: k.from, to: k.to, source_keys: uniqSorted(k.source_keys),
      players: [...(k.players ?? [])].map((p) => ({ player: p.player, war: p.war ?? undefined, source_keys: uniqSorted(p.source_keys) })).sort(by(playerKey)),
      other_assets: [...(k.other_assets ?? [])].map(canonicalAsset).sort(by(otherKey))
    })).sort(by((k) => `${k.from}>${k.to}`)),
    distinct_from: uniqSorted(r.distinct_from)
  }
  const ids = [...(r.external_ids ?? [])].map((x) => ({ scheme: x.scheme, id: String(x.id), source_key: x.source_key ?? r.source_key }))
  // The derived identity is a fallback for a record whose sources give no identifier; it never joins one that has its own.
  if (ids.length === 0) ids.push({ scheme: 'BAI_TXN', id: derivedIdentity(out), source_key: r.source_key })
  out.external_ids = ids.sort(by((x) => x.scheme))
  return JSON.parse(stableStringify(out))
}

/** Prepare an input document: every record canonical, sources sorted. Deterministic and idempotent. */
export function prepareTradeDoc (doc) {
  const out = { ...doc, sources: [...(doc.sources ?? [])].sort(by((s) => s.source_key)), records: (doc.records ?? []).map(canonicalizeTrade) }
  out.records.sort(by((r) => r.external_ids.map((x) => `${x.scheme}:${x.id}`).join('|')))
  return JSON.parse(stableStringify(out))
}
export const prepareToText = (doc) => JSON.stringify(prepareTradeDoc(doc), null, 2) + '\n'

// ---------------------------------------------------------------------------------------------------------------
// Validation without a database
// ---------------------------------------------------------------------------------------------------------------

const isPlayer = (p, e, at) => {
  if (!p || typeof p !== 'object' || !p.full_name) e.push(`${at}: player.full_name required`)
  else if (!p.external_ids?.MLBAM) e.push(`${at}: a traded player is identified by an MLBAM id (anything weaker waits for a researcher)`)
}
const cashKinds = (a, e, at) => {
  const d = a.amount_disclosure
  if (!CASH_TYPES.has(a.asset_type)) { if (a.amount_usd != null || d != null) e.push(`${at}: ${a.asset_type} takes no amount or amount_disclosure`); return }
  if (d != null && !DISCLOSURES.includes(d)) e.push(`${at}: amount_disclosure must be ${DISCLOSURES.join('|')}`)
  if (a.amount_usd != null && (typeof a.amount_usd !== 'number' || !Number.isFinite(a.amount_usd) || a.amount_usd < 0)) e.push(`${at}: amount_usd must be a non-negative number (zero only when a source states no cash)`)
  if (a.amount_usd != null && d != null && d !== 'DISCLOSED') e.push(`${at}: an amount is DISCLOSED`)
  if (a.amount_usd == null && d === 'DISCLOSED') e.push(`${at}: DISCLOSED needs amount_usd`)
}

/** Version-2 TRADE record shape. needSource(key, label) reports an undeclared source. */
export function validateTradeV2 (r, errors, warnings, needSource) {
  if (r.type !== 'TRADE') errors.push('TRADES batches hold TRADE records')
  if (r.schema !== TRADE_SCHEMA) errors.push(`schema must be ${TRADE_SCHEMA}`)
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(r.ref ?? '')) errors.push('ref required (lowercase key)')
  if (!r.organization) errors.push('organization (franchise key) required')
  if (!isDate(r.date)) errors.push('date must be YYYY-MM-DD')
  const keys = new Set()
  if (!Array.isArray(r.sources) || r.sources.length === 0) errors.push('sources must list every source of the record, each with a role and an independence_group')
  for (const [i, s] of (r.sources ?? []).entries()) {
    const at = `sources[${i}]`
    needSource(s.source_key, at)
    if (keys.has(s.source_key)) errors.push(`${at}: ${s.source_key} listed twice`)
    keys.add(s.source_key)
    if (!SOURCE_ROLES.includes(s.role)) errors.push(`${at}: role must be ${SOURCE_ROLES.join('|')}`)
    if (!GROUP.test(s.independence_group ?? '')) errors.push(`${at}: independence_group required (sources repeating one announcement share a group)`)
    if (s.retrieved_on != null && !isDate(s.retrieved_on)) errors.push(`${at}: retrieved_on must be YYYY-MM-DD`)
  }
  if (r.source_key && !keys.has(r.source_key)) errors.push('source_key must be one of sources[]')
  const schemes = new Set()
  if (!Array.isArray(r.external_ids) || r.external_ids.length === 0) errors.push('external_ids required: give the source identifier(s), or run the preparer, which derives a BAI_TXN identity')
  for (const [i, x] of (r.external_ids ?? []).entries()) {
    if (!SCHEME.test(x.scheme ?? '')) errors.push(`external_ids[${i}]: scheme must match ${SCHEME}`)
    if (typeof x.id !== 'string' || !x.id.trim()) errors.push(`external_ids[${i}]: id must be a non-empty string`)
    if (schemes.has(x.scheme)) errors.push(`external_ids[${i}]: two identifiers in scheme ${x.scheme}`)
    schemes.add(x.scheme)
    if (x.source_key) needSource(x.source_key, `external_ids[${i}]`)
  }
  if (!Array.isArray(r.packages) || r.packages.length === 0) { errors.push('packages must be a non-empty array'); return }
  const pairs = new Set()
  const parties = new Set()
  const seenPlayers = new Map()
  const srcOk = (list, at) => {
    if (!Array.isArray(list) || list.length === 0) errors.push(`${at}: source_keys required (every package and asset names the sources that support it)`)
    for (const k of list ?? []) if (!keys.has(k)) errors.push(`${at}: source ${k} is not one of this record's sources[]`)
  }
  for (const [i, k] of r.packages.entries()) {
    const at = `packages[${i}]`
    if (!k.from || !k.to || k.from === k.to) errors.push(`${at}: from and to required and different`)
    if (pairs.has(`${k.from}>${k.to}`)) errors.push(`${at}: two packages in the direction ${k.from}>${k.to}`)
    pairs.add(`${k.from}>${k.to}`)
    parties.add(k.from); parties.add(k.to)
    srcOk(k.source_keys, at)
    if (!(k.players ?? []).length && !(k.other_assets ?? []).length) errors.push(`${at}: no players and no other assets`)
    const mine = new Set()
    for (const [j, p] of (k.players ?? []).entries()) {
      const a = `${at}.players[${j}]`
      isPlayer(p.player, errors, a)
      srcOk(p.source_keys, a)
      const mk = playerKey(p)
      if (mine.has(mk)) errors.push(`${a}: ${p.player?.full_name} listed twice in this package`)
      mine.add(mk)
      if (seenPlayers.has(mk) && seenPlayers.get(mk) !== i) errors.push(`${a}: ${p.player?.full_name} is sent by two packages of one trade`)
      seenPlayers.set(mk, i)
    }
    const others = new Set()
    for (const [j, a] of (k.other_assets ?? []).entries()) {
      const at2 = `${at}.other_assets[${j}]`
      if (!ASSET_TYPES.includes(a.asset_type)) { errors.push(`${at2}: asset_type must be ${ASSET_TYPES.join('|')}`); continue }
      if (!a.description || typeof a.description !== 'string') errors.push(`${at2}: description required (it tells two assets of one type apart)`)
      if (others.has(otherKey(a))) errors.push(`${at2}: another asset of this package has the same type and description`)
      others.add(otherKey(a))
      srcOk(a.source_keys, at2)
      cashKinds(a, errors, at2)
      if (a.conditional && a.asset_type !== 'PLAYER_TO_BE_NAMED' && !a.condition_text) errors.push(`${at2}: a conditional asset states its condition (condition_text)`)
      if (a.resolution) {
        const x = a.resolution
        if (a.asset_type !== 'PLAYER_TO_BE_NAMED') errors.push(`${at2}: only a player to be named has a resolution`)
        if (!RESOLUTIONS.includes(x.kind)) errors.push(`${at2}.resolution: kind must be ${RESOLUTIONS.join('|')}`)
        if (!isDate(x.resolved_on)) errors.push(`${at2}.resolution: resolved_on must be YYYY-MM-DD`)
        else if (isDate(r.date) && x.resolved_on < r.date) errors.push(`${at2}.resolution: a player cannot be named before the trade`)
        needSource(x.source_key, `${at2}.resolution`)
        if (x.source_key && !keys.has(x.source_key)) errors.push(`${at2}.resolution: source ${x.source_key} is not one of this record's sources[]`)
        if (x.kind === 'PLAYER') isPlayer(x.player, errors, `${at2}.resolution`)
        if (x.kind === 'CASH') cashKinds({ asset_type: 'CASH', amount_usd: x.amount_usd, amount_disclosure: x.amount_disclosure }, errors, `${at2}.resolution`)
        if (x.kind !== 'PLAYER' && x.player) errors.push(`${at2}.resolution: only a PLAYER resolution names a player`)
      }
    }
  }
  if (r.organization && !parties.has(r.organization)) errors.push(`organization ${r.organization} is not a party to the trade`)
  if (!(r.packages.length >= 2)) warnings.push('ONE_SIDED_TRADE: a trade has two directions; the record stays incomplete')
  if (parties.size > 2) warnings.push('a trade between more than two clubs: each package is recorded as given')
  const bai = (r.external_ids ?? []).find((x) => x.scheme === 'BAI_TXN')
  if (bai && bai.id !== derivedIdentity(r)) warnings.push('BAI_TXN identity is not the derived one for this content (kept as supplied)')
  // a PTBNL cannot be named as a player the same package already carries
  for (const k of r.packages) {
    const direct = new Set((k.players ?? []).map(playerKey))
    for (const x of k.other_assets ?? []) if (x.resolution?.kind === 'PLAYER' && direct.has(playerKey({ player: x.resolution.player }))) errors.push(`${k.from}>${k.to}: a PTBNL is named as a player this package already carries (a named player is counted once)`)
  }
  for (const d of r.distinct_from ?? []) if (!/^[A-Z][A-Z0-9_]{1,30}:.+$/.test(d)) errors.push(`distinct_from entry ${d} must be SCHEME:id`)
}

const parties = (r) => [...new Set((r.packages ?? []).flatMap((k) => [k.from, k.to]))].sort()
const idsOf = (r) => (r.external_ids ?? []).map((x) => `${x.scheme}:${x.id}`)

/** Rules across the records of one batch. Returns problems per record index. */
export function batchProblemsV2 (records) {
  const problems = new Map()
  const add = (i, m) => problems.set(i, [...(problems.get(i) ?? []), m])
  const byId = new Map()
  for (const [i, r] of records.entries()) {
    for (const id of idsOf(r)) {
      if (byId.has(id)) {
        const j = byId.get(id)
        if (stableStringify(canonicalizeTrade(records[j])) !== stableStringify(canonicalizeTrade(r))) { add(i, `identity ${id} is also used by record ${j} with different content`) }
        else add(i, `duplicate of record ${j} (same identity and content)`)
      } else byId.set(id, i)
    }
  }
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]; const b = records[j]
      if (a.date !== b.date) continue
      const shared = parties(a).filter((p) => parties(b).includes(p))
      if (shared.length < 2) continue
      if (idsOf(a).some((x) => idsOf(b).includes(x))) continue
      const nameA = (a.distinct_from ?? []).some((d) => idsOf(b).includes(d))
      const nameB = (b.distinct_from ?? []).some((d) => idsOf(a).includes(d))
      if (!(nameA && nameB)) {
        add(i, `records ${i} and ${j} are two trades between the same clubs on ${a.date}: each must name the other in distinct_from`)
        add(j, `records ${i} and ${j} are two trades between the same clubs on ${a.date}: each must name the other in distinct_from`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Planning (read-only) and applying
// ---------------------------------------------------------------------------------------------------------------

export const reader = (db) => ({ q: (s, p) => db.query(s, p), one: async (s, p) => (await db.query(s, p)).rows[0] })
const idStr = (v) => (v === null || v === undefined ? null : String(v))

async function playerIds (a, r, identityInput) {
  // MLBAM key -> existing player id (null = BAI does not hold him; he would be created)
  const out = new Map()
  const all = []
  for (const k of r.packages) {
    for (const p of k.players ?? []) all.push(p.player)
    for (const x of k.other_assets ?? []) if (x.resolution?.player) all.push(x.resolution.player)
  }
  for (const p of all) {
    const res = await a.one('select * from ingest.resolve_identity($1)', [identityInput(p)])
    if (res.state === 'EXACT_EXTERNAL_ID') out.set(p.external_ids.MLBAM, String(res.player_id))
    else if (res.state === 'NO_MATCH') out.set(p.external_ids.MLBAM, null)
    else throw new TransactionPlanError(`player ${p.full_name}: identity ${res.state}; decide it before importing the trade`)
  }
  return out
}
export class TransactionPlanError extends Error {}

/**
 * Compare a version-2 record with what is canonical, writing nothing. kind: NEW | EXISTING | COLLISION | CONFLICT.
 * Conflicts are values that disagree; anything the record merely adds is not a conflict.
 */
export async function planTradeV2 (a, r, { identityInput }) {
  const org = new Map((await a.q('select franchise_key, id from public.organizations')).rows.map((x) => [x.franchise_key, String(x.id)]))
  const players = await playerIds(a, r, identityInput)
  const ids = idsOf(r)
  const hits = (await a.q(`select distinct x.transaction_id, x.scheme || ':' || x.external_id as ident from public.transaction_external_ids x where x.scheme || ':' || x.external_id = any ($1)`, [ids])).rows
  const txIds = [...new Set(hits.map((h) => String(h.transaction_id)))]
  const conflicts = []
  const plan = { kind: 'NEW', transactionId: null, collisions: [], conflicts, players }
  if (txIds.length > 1) {
    conflicts.push({ field_path: 'external_ids', existing: `identities ${hits.map((h) => `${h.ident}->${h.transaction_id}`).join(', ')}`, incoming: ids.join(', ') })
    plan.kind = 'CONFLICT'
    return plan
  }
  if (txIds.length === 0) {
    const mine = parties(r)
    const distinct = (await a.q(`select distinct x.transaction_id from public.transaction_external_ids x where x.scheme || ':' || x.external_id = any ($1)`, [r.distinct_from ?? []])).rows.map((x) => String(x.transaction_id))
    const cand = (await a.q(`select t.id, (select string_agg(distinct o.franchise_key, ',' order by o.franchise_key) from public.trade_packages k join public.organizations o on o.id in (k.from_organization_id, k.to_organization_id) where k.transaction_id = t.id) as parties
      from public.transactions t where t.transaction_type = 'TRADE' and t.transaction_date = $1`, [r.date])).rows
    for (const c of cand) {
      const theirs = String(c.parties ?? '').split(',').filter(Boolean)
      if (theirs.filter((p) => mine.includes(p)).length >= 2 && !distinct.includes(String(c.id))) plan.collisions.push({ transaction_id: String(c.id), parties: theirs })
    }
    if (plan.collisions.length) plan.kind = 'COLLISION'
    return plan
  }
  const tx = (await a.one(`select id, to_char(transaction_date, 'YYYY-MM-DD') as d, date_precision from public.transactions where id = $1`, [txIds[0]]))
  plan.kind = 'EXISTING'
  plan.transactionId = String(tx.id)
  const conflict = (field_path, existing, incoming) => conflicts.push({ field_path, existing: String(existing), incoming: String(incoming) })
  if (tx.d !== r.date || tx.date_precision !== (r.date_precision ?? 'DAY')) conflict('date', `${tx.d} (${tx.date_precision})`, `${r.date} (${r.date_precision ?? 'DAY'})`)
  for (const x of r.external_ids) {
    const mine = (await a.one('select external_id from public.transaction_external_ids where transaction_id = $1 and scheme = $2', [tx.id, x.scheme]))
    if (mine && mine.external_id !== x.id) conflict(`external_ids.${x.scheme}`, mine.external_id, x.id)
  }
  for (const s of r.sources) {
    const ex = await a.one(`select s.role, s.independence_group from public.transaction_sources s join public.sources so on so.id = s.source_id where s.transaction_id = $1 and so.source_key = $2`, [tx.id, s.source_key])
    if (ex && (ex.role !== s.role || ex.independence_group !== s.independence_group)) conflict(`sources.${s.source_key}`, `${ex.role}/${ex.independence_group}`, `${s.role}/${s.independence_group}`)
  }
  const pkgs = (await a.q(`select k.id, fo.franchise_key as f, too.franchise_key as t from public.trade_packages k join public.organizations fo on fo.id = k.from_organization_id
    join public.organizations too on too.id = k.to_organization_id where k.transaction_id = $1`, [tx.id])).rows
  const where = new Map() // player id -> direction
  for (const k of pkgs) {
    for (const p of (await a.q('select player_id from public.trade_package_assets where trade_package_id = $1 and player_id is not null', [k.id])).rows) where.set(String(p.player_id), `${k.f}>${k.t}`)
    for (const p of (await a.q(`select r.resolved_player_id as player_id from public.ptbnl_resolutions r join public.trade_package_assets x on x.id = r.trade_package_asset_id where x.trade_package_id = $1 and r.resolved_player_id is not null`, [k.id])).rows) where.set(String(p.player_id), `${k.f}>${k.t}`)
  }
  for (const k of r.packages) {
    const dir = `${k.from}>${k.to}`
    const ex = pkgs.find((p) => p.f === k.from && p.t === k.to)
    for (const p of k.players ?? []) {
      const pid = players.get(p.player.external_ids.MLBAM)
      const there = pid ? where.get(pid) : null
      if (there && there !== dir) conflict(`packages.${dir}.players.${p.player.external_ids.MLBAM}`, `sent ${there}`, `sent ${dir}`)
    }
    if (!ex) continue
    for (const x of k.other_assets ?? []) {
      const e = await a.one(`select x.id, x.amount_usd::text as amount, x.amount_disclosure, x.condition_text from public.trade_package_assets x
        where x.trade_package_id = $1 and x.asset_type = $2 and x.description is not distinct from $3`, [ex.id, x.asset_type, x.description])
      if (!e) continue
      const at = `packages.${dir}.${otherKey(x)}`
      if (CASH_TYPES.has(x.asset_type)) {
        const di = x.amount_disclosure; const de = e.amount_disclosure ?? 'UNKNOWN'
        if (di !== 'UNKNOWN' && de !== 'UNKNOWN') {
          if (di !== de) conflict(`${at}.amount`, `${de}${e.amount != null ? ' ' + e.amount : ''}`, `${di}${x.amount_usd != null ? ' ' + x.amount_usd : ''}`)
          else if (di === 'DISCLOSED' && Number(e.amount) !== Number(x.amount_usd)) conflict(`${at}.amount`, e.amount, x.amount_usd)
        }
      }
      if (e.condition_text != null && x.condition_text != null && e.condition_text !== x.condition_text) conflict(`${at}.condition`, e.condition_text, x.condition_text)
      if (x.resolution) {
        const rs = await a.one(`select resolution, resolved_player_id, amount_usd::text as amount, to_char(resolved_on, 'YYYY-MM-DD') as d from public.ptbnl_resolutions where trade_package_asset_id = $1`, [e.id])
        if (rs) {
          const pid = x.resolution.kind === 'PLAYER' ? players.get(x.resolution.player.external_ids.MLBAM) : null
          if (rs.resolution !== x.resolution.kind || idStr(rs.resolved_player_id) !== idStr(pid) || rs.d !== x.resolution.resolved_on
              || (x.resolution.kind === 'CASH' && rs.amount != null && x.resolution.amount_usd != null && Number(rs.amount) !== Number(x.resolution.amount_usd))) {
            conflict(`${at}.resolution`, `${rs.resolution} ${rs.resolved_player_id ?? ''} ${rs.d}`.trim(), `${x.resolution.kind} ${pid ?? x.resolution.player?.external_ids?.MLBAM ?? ''} ${x.resolution.resolved_on}`.trim())
          }
        }
      }
    }
  }
  if (conflicts.length) plan.kind = 'CONFLICT'
  return plan
}

/** Read-only report for a prepared document: what each record would be. */
export async function previewTrades (db, doc, { identityInput }) {
  const a = reader(db)
  const out = []
  const problems = batchProblemsV2(doc.records)
  for (const [i, r] of doc.records.entries()) {
    const plan = await planTradeV2(a, r, { identityInput })
    out.push({ index: i, ref: r.ref, date: r.date, identity: r.external_ids.map((x) => `${x.scheme}:${x.id}`), kind: plan.kind,
      transaction_id: plan.transactionId, collisions: plan.collisions, conflicts: plan.conflicts, in_batch_problems: problems.get(i) ?? [],
      new_players: [...plan.players.entries()].filter(([, v]) => v === null).map(([k]) => k) })
  }
  return out
}

/** Apply one version-2 record. `a` is the pipeline's Applier. Returns { action, reason?, canonical, newPlayers }. */
export async function applyTradeV2 (a, rec, { identityInput, PipelineError, conflicts: conflictSink }) {
  const r = rec.payload
  const batchId = a.batch.id
  const prior = await a.one('select action from ingest.transaction_apply_ledger where import_batch_id = $1 and record_index = $2', [batchId, rec.record_index])
  if (prior) return { action: 'NO_CHANGE', reason: 'replay: this record was already applied by this batch', canonical: null, newPlayers: 0 }
  const plan = await planTradeV2(a, r, { identityInput })
  if (plan.kind === 'COLLISION') {
    return { action: 'HELD', reason: `COLLISION: same day and clubs as transaction ${plan.collisions.map((c) => c.transaction_id).join(', ')} with no shared identity; link it with a shared external id or name it in distinct_from`, canonical: null, newPlayers: 0 }
  }
  if (plan.kind === 'CONFLICT') {
    if (plan.transactionId) {
      for (const c of plan.conflicts) {
        await a.q(`insert into public.transaction_conflicts (transaction_id, field_path, existing_value, incoming_value, incoming_sha256, import_batch_id)
          values ($1, $2, $3, $4, $5, $6) on conflict (transaction_id, incoming_sha256, field_path) do nothing`, [plan.transactionId, c.field_path, c.existing, c.incoming, rec.record_sha256, batchId])
      }
    }
    conflictSink?.push(...plan.conflicts.map((c) => ({ table: 'transactions', id: plan.transactionId, field: c.field_path, incoming: c.incoming, canonical: c.existing })))
    return { action: 'HELD', reason: `CONFLICT: ${plan.conflicts.map((c) => `${c.field_path} (${c.existing} vs ${c.incoming})`).join('; ')}`, canonical: plan.transactionId ? ['transactions', plan.transactionId] : null, newPlayers: 0 }
  }

  let changed = false
  let created = false
  let newPlayers = 0
  const src = (k) => a.sourceId(k)
  let txId = plan.transactionId
  if (!txId) {
    txId = String((await a.one(`insert into public.transactions (transaction_type, transaction_date, date_precision, description, source_id) values ('TRADE', $1, $2, $3, $4) returning id`,
      [r.date, r.date_precision ?? 'DAY', r.description ?? null, await src(r.source_key)])).id)
    await a.observe(r.source_key, 'transactions', txId, 'transaction_date', r.date, null)
    changed = true; created = true
  }
  const ins = async (sql, params) => { const x = await a.q(sql, params); if (x.rowCount) changed = true; return x }
  for (const x of r.external_ids) {
    await ins('insert into public.transaction_external_ids (transaction_id, scheme, external_id, source_id) values ($1, $2, $3, $4) on conflict do nothing', [txId, x.scheme, x.id, await src(x.source_key ?? r.source_key)])
  }
  const tsId = new Map()
  for (const s of r.sources) {
    await ins('insert into public.transaction_sources (transaction_id, source_id, role, independence_group, locator, retrieved_on) values ($1, $2, $3, $4, $5, $6) on conflict (transaction_id, source_id) do nothing',
      [txId, await src(s.source_key), s.role, s.independence_group, s.locator ?? null, s.retrieved_on ?? null])
    tsId.set(s.source_key, (await a.one('select id from public.transaction_sources where transaction_id = $1 and source_id = $2', [txId, await src(s.source_key)])).id)
  }
  const link = async (keys, col, id) => {
    for (const k of keys) await ins(`insert into public.transaction_source_links (transaction_source_id, ${col}) values ($1, $2) on conflict do nothing`, [tsId.get(k), id])
  }
  const playerFor = async (p, srcKey) => {
    const res = await a.one('select * from ingest.resolve_identity($1)', [identityInput(p)])
    let id
    if (res.state === 'EXACT_EXTERNAL_ID') id = res.player_id
    else if (res.state === 'NO_MATCH') { id = await a.createPlayer(p, srcKey); newPlayers++; changed = true } else throw new PipelineError(`traded player ${p.full_name}: identity ${res.state}`)
    await a.attachIdentifiers(id, p, srcKey)
    return id
  }
  for (const k of r.packages) {
    const from = await a.organizationId(k.from); const to = await a.organizationId(k.to)
    await ins('insert into public.trade_packages (transaction_id, from_organization_id, to_organization_id) values ($1, $2, $3) on conflict (transaction_id, from_organization_id, to_organization_id) do nothing', [txId, from, to])
    const pkg = (await a.one('select id from public.trade_packages where transaction_id = $1 and from_organization_id = $2 and to_organization_id = $3', [txId, from, to])).id
    await link(k.source_keys, 'trade_package_id', pkg)
    for (const p of k.players ?? []) {
      const pid = await playerFor(p.player, p.player.source_key ?? r.source_key)
      await ins("insert into public.trade_package_assets (trade_package_id, asset_type, player_id) values ($1, 'PLAYER', $2) on conflict do nothing", [pkg, pid])
      const asset = (await a.one('select id from public.trade_package_assets where trade_package_id = $1 and player_id = $2', [pkg, pid])).id
      await link(p.source_keys, 'trade_package_asset_id', asset)
      const w = await a.applyWar(pid, p.war, r.source_key, conflictSink ?? [])
      if (w !== 'NO_CHANGE') changed = true
    }
    for (const x of k.other_assets ?? []) {
      let e = await a.one('select id, amount_disclosure, condition_text from public.trade_package_assets where trade_package_id = $1 and asset_type = $2 and description is not distinct from $3', [pkg, x.asset_type, x.description])
      if (!e) {
        e = await a.one(`insert into public.trade_package_assets (trade_package_id, asset_type, amount_usd, amount_disclosure, conditional, condition_text, description)
          values ($1, $2, $3, $4, $5, $6, $7) returning id, amount_disclosure, condition_text`, [pkg, x.asset_type, x.amount_usd ?? null, CASH_TYPES.has(x.asset_type) ? x.amount_disclosure : null, Boolean(x.conditional), x.condition_text ?? null, x.description])
        changed = true
      } else {
        // fill what is unknown; a differing known value was reported as a conflict by the plan
        if (CASH_TYPES.has(x.asset_type) && (e.amount_disclosure ?? 'UNKNOWN') === 'UNKNOWN' && x.amount_disclosure !== 'UNKNOWN') {
          await a.q('update public.trade_package_assets set amount_usd = $2, amount_disclosure = $3 where id = $1', [e.id, x.amount_usd ?? null, x.amount_disclosure]); changed = true
        }
        if (e.condition_text == null && x.condition_text != null) { await a.q('update public.trade_package_assets set condition_text = $2 where id = $1', [e.id, x.condition_text]); changed = true }
      }
      await link(x.source_keys, 'trade_package_asset_id', e.id)
      if (x.resolution) {
        const rs = x.resolution
        const pid = rs.kind === 'PLAYER' ? await playerFor(rs.player, rs.player.source_key ?? rs.source_key) : null
        await ins(`insert into public.ptbnl_resolutions (trade_package_asset_id, resolution, resolved_player_id, amount_usd, amount_disclosure, resolved_on, resolved_on_precision, source_id, notes)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (trade_package_asset_id) do nothing`,
        [e.id, rs.kind, pid, rs.kind === 'CASH' ? (rs.amount_usd ?? null) : null, rs.kind === 'CASH' ? rs.amount_disclosure : null, rs.resolved_on, rs.resolved_on_precision ?? 'DAY', await src(rs.source_key), rs.notes ?? null])
      }
    }
  }
  const action = created ? 'INSERT' : (changed ? 'UPDATE_UNKNOWN' : 'NO_CHANGE')
  await a.q('insert into ingest.transaction_apply_ledger (import_batch_id, record_index, record_sha256, transaction_id, action) values ($1, $2, $3, $4, $5)', [batchId, rec.record_index, rec.record_sha256, txId, action])
  return { action, canonical: ['transactions', txId], newPlayers }
}
