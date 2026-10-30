// Off-hosted staging and atomic promotion (migration 032): the local delta builder, the release manifest and package, the promotion client with its recovery rule, and the withdrawal calls.
//
//   stage      the six pinned batches are imported OFF-HOSTED into a restored copy of a fresh baseline backup (the existing research importer; nothing here imports).
//   package    buildPackage() compares the staged database with the baseline, proves the staging changed no baseline row, applies the owner's exclusions and the credit annotation in a
//              release-candidate copy (so referential integrity is proven by the database), and writes an immutable package: manifest.json (named by its SHA-256), one payload file per table, the
//              withheld evidence, and a hash list. The manifest pins the archive, every batch file hash, the migration checksums, the baseline and release-state fingerprints and the sequences.
//   promote    ONE transaction on the owner connection (ingest.promote_begin / promote_load / promote_withhold / promote_commit). A lost connection is never guessed at: ask the database.
//   withdraw   ingest.withdraw_promotion, or in an emergency ingest.emergency_withdraw / finish_withdrawal / revert_emergency.
// Everything here is local-only until a hosted release is separately authorized (see assertLocalTarget).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const PROMOTION_FORMAT = 'bai-promotion/1'
export const SESSION_SQL = "set time zone 'UTC'; set datestyle = 'ISO, YMD'; set extra_float_digits = 1; set intervalstyle = 'postgres'; set bytea_output = 'hex'"
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
export const canon = (o) => Array.isArray(o) ? `[${o.map(canon).join(',')}]` : o && typeof o === 'object' ? `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}` : JSON.stringify(o)
const ident = (n) => { if (!/^[a-z0-9_]+$/.test(n)) throw new Error(`unsafe database name ${n}`); return n }
const q = async (c, sql, p) => (await c.query(sql, p)).rows

/** Owner decision (G5-4): the Retrosheet transaction_date observations are not part of the public delta. Their evidence is kept privately with the promotion. */
export const DEFAULT_EXCLUSIONS = Object.freeze([{
  table: 'public.source_observations',
  rule: "subject_table = 'transactions' and field_name = 'transaction_date' and source_id in (select id from public.sources where attribution_category = 'RETROSHEET')",
  reason: 'owner decision G5-4: Retrosheet transaction_date observations are not published; the evidence is preserved privately with the promotion'
}])

/** The promotion tools only ever run against a local database until a hosted release is separately authorized. */
export function assertLocalTarget (url) {
  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error('refusing: hosted promotion is NOT AUTHORIZED. This build is the local implementation (G5-4); a hosted promotion needs the G6 gate, a fresh verified baseline backup and the owner\'s written authorization.')
  }
}

export async function openSession (c) { await c.query(SESSION_SQL); return c }

export async function pkCols (c, t) {
  return (await q(c, `select a.attname from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
    where i.indrelid = $1::regclass and i.indisprimary order by k.ord`, [t])).map((r) => r.attname)
}

async function rowsOf (c, t, { json = false, masked = false } = {}) {
  const cols = await pkCols(c, t); const key = cols.map((x) => `"${x}"`).join(', ')
  const hash = masked
    ? `md5((to_jsonb(t) - array(select a.attname::text from pg_attribute a where a.attrelid = '${t}'::regclass and a.atttypid in ('timestamptz'::regtype, 'uuid'::regtype) and a.attnum > 0 and not a.attisdropped))::text)`
    : 'md5(t::text)'
  const rows = await q(c, `select to_jsonb(row(${key})) as k, ${hash} as hsh ${json ? ', to_jsonb(t) as j' : ''} from ${t} t order by ${key}`)
  const m = new Map(); for (const r of rows) m.set(JSON.stringify(r.k), r); return { cols, m }
}

/** Staged minus baseline, table by table. problems: any baseline row that is missing or different (a delta must be insert-only). masked: ignore timestamps and random UUIDs (to compare two stagings). */
export async function computeDelta (base, stage, { masked = false } = {}) {
  const scope = (await q(base, 'select unnest(ingest.promotion_scope()) t')).map((r) => r.t); const delta = {}; const problems = []
  for (const t of scope) {
    const b = await rowsOf(base, t, { masked }); const s = await rowsOf(stage, t, { json: true, masked })
    for (const [k, r] of b.m) { const x = s.m.get(k); if (!x) problems.push(`${t}: baseline row ${k} is gone`); else if (x.hsh !== r.hsh) problems.push(`${t}: baseline row ${k} changed`) }
    const add = [...s.m].filter(([k]) => !b.m.has(k)).map(([, r]) => r)
    if (add.length) delta[t] = { cols: s.cols, rows: add.map((r) => r.j), hashes: add.map((r) => r.hsh).sort() }
  }
  return { scope, delta, problems }
}

async function orderTables (c, tables) {
  const fks = await q(c, `select (select k.relnamespace::regnamespace::text || '.' || k.relname from pg_class k where k.oid = conrelid) child, (select k.relnamespace::regnamespace::text || '.' || k.relname from pg_class k where k.oid = confrelid) parent from pg_constraint where contype = 'f'`)
  const deps = new Map(tables.map((t) => [t, new Set()]))
  for (const f of fks) if (f.child !== f.parent && deps.has(f.child) && deps.has(f.parent)) deps.get(f.child).add(f.parent)
  const out = []; const seen = new Set(); const visit = (t) => { if (seen.has(t)) return; seen.add(t); for (const d of [...deps.get(t)].sort()) visit(d); out.push(t) }
  for (const t of [...tables].sort()) visit(t); return out
}

const fingerprint = async (c, t) => (await q(c, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f

/**
 * Builds the release package from a baseline database and a staged database (both local, both reachable through `connect(name)`; `admin` creates the release-candidate copy).
 * The staged database must have no other session open on it. config: { category, authorization: { effective_from, expires_on }, attribution: { evidence_sha256, verified_at, max_age_hours },
 * archive: { name, sha256 }, exclusions?, expectBatches?: [{ name, sha256 }] }.
 */
export async function buildPackage ({ connect, admin, baseName, stageName, outDir = null, config, keepCandidate = false }) {
  const category = config.category; const exclusions = config.exclusions ?? DEFAULT_EXCLUSIONS
  const base = await openSession(await connect(baseName)); let stage = await openSession(await connect(stageName))
  const delta0 = await computeDelta(base, stage)
  if (delta0.problems.length) throw new Error(`the staging changed the baseline, so there is no insert-only delta: ${delta0.problems.slice(0, 5).join('; ')}`)
  await stage.end()
  const rcName = ident(`${stageName}_release`)
  await admin.query(`drop database if exists ${rcName} with (force)`); await admin.query(`create database ${rcName} template ${ident(stageName)}`)
  let rc; let pkg
  try {
    rc = await openSession(await connect(rcName))
    // credit: the verbatim statement in the metadata of the category's sources that this release adds
    const stmt = (await q(base, 'select statement from public.source_attribution_statements where attribution_category = $1', [category]))[0]?.statement
    if (!stmt) throw new Error(`no attribution statement for ${category} on the baseline`)
    const newSources = (delta0.delta['public.sources']?.rows ?? []).map((r) => r.id)
    const annotated = newSources.length ? (await rc.query(
      `update public.sources set notes = case when notes is null or notes = '' then $2 else notes || E'\\n' || $2 end where attribution_category = $1 and id = any($3) returning id`,
      [category, `Attribution required: ${stmt}`, newSources])).rowCount : 0
    // exclusions: only delta rows; the database proves nothing in the release still refers to them (a foreign key would stop the delete)
    const withheld = {}; const exManifest = []; const exApplied = []
    for (const ex of exclusions) {
      const pk = await pkCols(rc, ex.table); if (pk.length !== 1) throw new Error(`exclusion on ${ex.table}: single-column key required`)
      const ids = (delta0.delta[ex.table]?.rows ?? []).map((r) => r[pk[0]])
      const sel = ids.length ? await q(rc, `select to_jsonb(t) j from ${ex.table} t where (${ex.rule}) and "${pk[0]}" = any($1) order by "${pk[0]}"`, [ids]) : []
      exApplied.push({ table: ex.table, rule: ex.rule, n: sel.length })
      if (!sel.length) continue
      try { await rc.query(`delete from ${ex.table} where "${pk[0]}" = any($1)`, [sel.map((r) => r.j[pk[0]])]) } catch (e) {
        throw new Error(`excluding ${sel.length} rows of ${ex.table} breaks integrity (${e.message}); the release is not built`)
      }
      const text = JSON.stringify(sel.map((r) => r.j)); withheld[ex.table] = text
      exManifest.push({ table: ex.table, rule: ex.rule, reason: ex.reason, n: sel.length, rows_sha256: sha256(text), ids: sel.map((r) => r.j[pk[0]]) })
    }
    const d = await computeDelta(base, rc)
    if (d.problems.length) throw new Error(`the release candidate differs from the baseline in existing rows: ${d.problems.slice(0, 5).join('; ')}`)
    const tables = Object.keys(d.delta); if (!tables.length) throw new Error('there is nothing to promote')
    const batches = (d.delta['ingest.import_batches']?.rows ?? []).map((b) => ({ name: b.batch_key, sha256: b.file_sha256 })).sort((x, y) => x.sha256.localeCompare(y.sha256))
    if (config.expectBatches) {
      const want = config.expectBatches.map((b) => b.sha256).sort().join(); const have = batches.map((b) => b.sha256).sort().join()
      if (want !== have) throw new Error(`the staged batches are not the pinned batches (expected ${config.expectBatches.length}, staged ${batches.length}: ${want === have})`)
    }
    const grant = (await q(base, 'select basis_reference, scope_note from ingest.source_publication_grants where attribution_category = $1', [category]))[0]
    if (!grant) throw new Error(`no ${category} grant on the baseline`)
    const fps = {}; for (const t of d.scope) fps[t] = await fingerprint(base, t)
    const after = {}; const seqs = {}
    for (const t of tables) {
      after[t] = await fingerprint(rc, t)
      const hasId = (await q(rc, "select exists (select 1 from pg_attribute where attrelid = $1::regclass and attname = 'id' and not attisdropped) e", [t]))[0].e
      const s = hasId ? (await q(rc, "select pg_get_serial_sequence($1, 'id') s", [t]))[0].s : null
      if (s) seqs[t] = Number((await q(rc, 'select pg_sequence_last_value($1::regclass) v', [s]))[0].v)
    }
    const order = await orderTables(base, tables)
    const manifest = {
      format: PROMOTION_FORMAT, category,
      authorization: { effective_from: config.authorization.effective_from, expires_on: config.authorization.expires_on, grant_binding_sha256: sha256(grant.basis_reference + '\n' + grant.scope_note) },
      attribution: { statement_sha256: sha256(stmt), evidence_sha256: config.attribution.evidence_sha256, verified_at: config.attribution.verified_at, max_age_hours: config.attribution.max_age_hours ?? 72 },
      archive: config.archive, batches,
      migrations: Object.fromEntries((await q(base, 'select version, checksum from bai_meta.schema_migrations')).map((r) => [r.version, r.checksum])),
      baseline: { scope: d.scope, fingerprints: fps }, load_order: order,
      delta: Object.fromEntries(order.map((t) => [t, { n: d.delta[t].rows.length, pk_cols: d.delta[t].cols }])),
      after, sequences: seqs, exclusions: exManifest, exclusion_rules: exApplied,
      annotations: [{ table: 'public.sources', column: 'notes', rule: 'attribution statement appended verbatim to the sources this release adds', statement_sha256: sha256(stmt), rows: annotated }],
      summary: Object.fromEntries(order.map((t) => [t, d.delta[t].rows.length]))
    }
    const manifestText = canon(manifest); const sha = sha256(manifestText)
    const payload = Object.fromEntries(order.map((t) => [t, JSON.stringify(d.delta[t].rows)]))
    pkg = { manifestText, manifest, sha, payload, withheld }
  } finally {
    await rc?.end().catch(() => {}); await base.end().catch(() => {})
    if (!keepCandidate) await admin.query(`drop database if exists ${rcName} with (force)`)   // also when the build is refused: no release candidate is left behind
  }
  if (outDir) writePackage(outDir, pkg)
  return pkg
}

const fileFor = (t) => `${t.replace(/\./g, '__')}.json`
export function writePackage (dir, pkg) {
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true }); fs.mkdirSync(path.join(dir, 'withheld'), { recursive: true })
  const hashes = {}
  const put = (rel, text) => { fs.writeFileSync(path.join(dir, rel), text); hashes[rel] = sha256(text) }
  put('manifest.json', pkg.manifestText)
  for (const [t, text] of Object.entries(pkg.payload)) put(`payload/${fileFor(t)}`, text)
  for (const [t, text] of Object.entries(pkg.withheld)) put(`withheld/${fileFor(t)}`, text)
  fs.writeFileSync(path.join(dir, 'PACKAGE.sha256.json'), JSON.stringify({ manifest_sha256: pkg.sha, files: hashes }, null, 1))
}

export function loadPackage (dir) {
  const manifestText = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'); const manifest = JSON.parse(manifestText)
  const payload = {}; for (const t of manifest.load_order) payload[t] = fs.readFileSync(path.join(dir, 'payload', fileFor(t)), 'utf8')
  const withheld = {}; for (const e of manifest.exclusions ?? []) withheld[e.table] = fs.readFileSync(path.join(dir, 'withheld', fileFor(e.table)), 'utf8')
  return { manifestText, manifest, sha: sha256(manifestText), payload, withheld }
}

/** Offline check of a package against its own hash list and manifest: nothing is trusted from the file names. */
export function verifyPackage (dir) {
  const problems = []
  let listing; try { listing = JSON.parse(fs.readFileSync(path.join(dir, 'PACKAGE.sha256.json'), 'utf8')) } catch { return ['PACKAGE.sha256.json is missing or unreadable'] }
  for (const [rel, h] of Object.entries(listing.files)) { let text; try { text = fs.readFileSync(path.join(dir, rel), 'utf8') } catch { problems.push(`${rel} is missing`); continue } if (sha256(text) !== h) problems.push(`${rel} does not match its recorded hash`) }
  let pkg; try { pkg = loadPackage(dir) } catch (e) { return [...problems, `the package cannot be loaded: ${e.message}`] }
  if (pkg.sha !== listing.manifest_sha256) problems.push('the manifest hash differs from the hash list')
  if (pkg.manifest.format !== PROMOTION_FORMAT) problems.push('unknown manifest format')
  for (const t of pkg.manifest.load_order) { const n = JSON.parse(pkg.payload[t]).length; if (n !== pkg.manifest.delta[t].n) problems.push(`${t}: ${n} rows, the manifest says ${pkg.manifest.delta[t].n}`) }
  for (const e of pkg.manifest.exclusions ?? []) { if (sha256(pkg.withheld[e.table]) !== e.rows_sha256) problems.push(`withheld ${e.table} does not match the manifest`) }
  return problems
}

// ---- the promotion client -----------------------------------------------------------------------------------------------------------------------------------------------------------

/** One promotion attempt in one transaction. hooks (tests): afterBegin, beforeLoad(client, table, index), tamper(table, rows), afterCommit. */
export async function promoteOnce (c, pkg, hooks = {}) {
  await c.query('begin')
  try {
    const r = (await c.query('select ingest.promote_begin($1) r', [pkg.manifestText])).rows[0].r
    if (r === 'ALREADY_PROMOTED') { await c.query('rollback'); return r }
    await hooks.afterBegin?.(c)
    let i = 0
    for (const t of pkg.manifest.load_order) {
      await hooks.beforeLoad?.(c, t, i++)
      const text = hooks.tamper ? JSON.stringify(hooks.tamper(t, JSON.parse(pkg.payload[t]))) : pkg.payload[t]
      await c.query('select ingest.promote_load($1, $2::jsonb)', [t, text])
    }
    for (const [t, text] of Object.entries(pkg.withheld)) await c.query('select ingest.promote_withhold($1, $2)', [t, text])
    await c.query('select ingest.promote_commit()')
    await c.query('commit'); await hooks.afterCommit?.(c)
    return 'PROMOTED'
  } catch (e) { await c.query('rollback').catch(() => {}); throw e }
}

export const statusOf = async (c, sha) => (await q(c, 'select ingest.promotion_status($1) s', [sha]))[0].s

/**
 * The rule for a connection that fails: never guess. Ask the database (a fresh connection) what became of this exact manifest. PROMOTED: done, do not repeat. Not promoted: the
 * transaction was rolled back by the server, so it is safe to start again from the beginning. Anything else (withdrawn, emergency, refused) is returned for a human.
 */
export async function promote ({ connect, name, pkg, hooks = {}, attempts = 3 }) {
  const log = []; let c = await openSession(await connect(name))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { const r = await promoteOnce(c, pkg, attempt === 1 ? hooks : {}); log.push(`attempt ${attempt}: ${r}`); await c.end().catch(() => {}); return { result: r, log } } catch (e) {
      log.push(`attempt ${attempt}: ${String(e.message).split('\n')[0].slice(0, 120)}`); await c.end().catch(() => {})
      if (!/terminated|ECONN|Connection|closed|reset|socket|ambiguous/i.test(e.message)) throw Object.assign(e, { log })
      const s = await openSession(await connect(name)); let st; try { st = await statusOf(s, pkg.sha) } finally { await s.end().catch(() => {}) }
      log.push(`state after reconnect: ${st.state}`)
      if (st.state === 'PROMOTED') return { result: 'PROMOTED (confirmed after reconnect)', log }
      if (st.state !== 'NOT_PROMOTED') throw Object.assign(new Error(`manifest is ${st.state}`), { log })
      c = await openSession(await connect(name))
    }
  }
  throw new Error(`gave up after ${attempts} attempts: ${log.join(' | ')}`)
}

export const withdraw = async (c, sha, reason, { withdrawGrant = false } = {}) => (await q(c, 'select ingest.withdraw_promotion($1, $2, $3) r', [sha, reason, withdrawGrant]))[0].r
export const emergencyWithdraw = async (c, sha, reason, { closeApi = false } = {}) => (await q(c, 'select ingest.emergency_withdraw($1, $2, $3) r', [sha, reason, closeApi]))[0].r
export const finishWithdrawal = async (c, sha, reason) => (await q(c, 'select ingest.finish_withdrawal($1, $2) r', [sha, reason]))[0].r
export const revertEmergency = async (c, sha, reason) => (await q(c, 'select ingest.revert_emergency($1, $2) r', [sha, reason]))[0].r
export const dependents = async (c, sha) => (await q(c, 'select ingest.promotion_dependents($1) r', [sha]))[0].r
