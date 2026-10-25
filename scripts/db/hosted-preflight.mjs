// READ-ONLY preflight (and post-check) for a hosted migration gate. One `begin read only` transaction; nothing is written, nothing secret is printed.
//   node --env-file=.env.hosted.local scripts/db/hosted-preflight.mjs --snapshot-dir <dir> --expect-level 027 [--expect-checksum 028:<sha256>] [--after 028] [--json]
//
// Checks: the target is the configured BAI project; the recorded migration level; every recorded migration (bai_meta and, on Supabase, the pushed
// history statement for statement) equals its committed file; and the CONTENT of every table equals the checksummed snapshot (a snapshot made by
// scripts/db/bench/snapshot-hosted.mjs). Strict mode (default) wants every table byte-identical. `--after <level>` is the post-migration check: the
// migration level is that version, tables the snapshot does not know may exist, existing tables may have gained columns (only the snapshot's own columns
// are compared) and the registries internal_objects / provenance_fact_tables may have gained rows (the snapshot's rows must all still be present).
// The snapshot must be taken IMMEDIATELY before the gate; the same file then doubles as the data backup (restore: docs/transactions/gate-g1-authorization.md).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import pg from 'pg'
import { ownerDatabaseUrl, isLocalUrl, supabaseProjectRef } from './lib/connection.mjs'
import { listMigrations, supabaseHistory, pushedMatchesFile } from './lib/migrations.mjs'

const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const snapDir = opt('snapshot-dir'); const expectLevel = opt('expect-level'); const after = opt('after'); const expectChecksum = opt('expect-checksum')
if (!snapDir || !(expectLevel || after)) { console.error('usage: --snapshot-dir <dir> --expect-level <NNN> | --after <NNN> [--expect-checksum NNN:<sha256>] [--json]'); process.exit(2) }
const REGISTRIES = ['public.internal_objects', 'public.provenance_fact_tables']
const level = after ?? expectLevel
const url = ownerDatabaseUrl()
const out = { checks: [], facts: {} }
const check = (name, ok, detail) => out.checks.push({ name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) })
const manifest = JSON.parse(fs.readFileSync(path.join(snapDir, 'manifest.json'), 'utf8'))
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex')
for (const [t, m] of Object.entries(manifest.tables)) check(`snapshot file ${t} matches its checksum`, sha(fs.readFileSync(path.join(snapDir, `${t}.ndjson`), 'utf8')) === m.sha256)

const c = new pg.Client({ connectionString: url }); await c.connect()
try {
  await c.query('begin read only')
  await c.query("set local timezone = 'UTC'")   // the snapshot was serialized on hosted (UTC); timestamps must render the same on any server
  const q = async (s, p) => (await c.query(s, p)).rows
  const ref = supabaseProjectRef(url)
  if (!isLocalUrl(url)) check('the target is the configured BAI project', ref && ref === process.env.BAI_SUPABASE_PROJECT_REF, { ref })
  const id = (await q("select current_database() d, current_setting('transaction_read_only') ro, current_setting('server_version') v, (select string_agg(nspname, ',' order by nspname) from pg_namespace where nspname in ('public','analytics','research','ingest','bai_meta')) s"))[0]
  check('the session is read-only', id.ro === 'on'); check('BAI schemas are present', id.s === 'analytics,bai_meta,ingest,public,research', id); out.facts.server = id.v
  // migrations
  const rows = await q('select version, file, checksum from bai_meta.schema_migrations order by version')
  const repo = listMigrations(); const byV = new Map(repo.map((m) => [m.version, m]))
  check(`the recorded migration level is ${level}`, rows.length && rows[rows.length - 1].version === level, { recorded: rows.map((r) => r.version).slice(-3), count: rows.length })
  check('every recorded migration equals its committed file (version, name, checksum)', rows.every((r) => byV.get(r.version)?.checksum === r.checksum && byV.get(r.version)?.file === r.file))
  const hist = await supabaseHistory(c)
  if (hist) {
    check(`the Supabase history holds exactly versions up to ${level}`, [...hist.keys()].sort().join() === repo.filter((m) => m.version <= level).map((m) => m.version).join())
    check('every pushed migration equals its committed file statement for statement', [...hist].every(([v, r]) => byV.get(v) && `${v}_${r.name}.sql` === byV.get(v).file && pushedMatchesFile(r.statements, byV.get(v).sql)))
  }
  out.facts.committed_not_applied = repo.filter((m) => m.version > level).map((m) => m.version)
  if (expectChecksum) { const [v, want] = expectChecksum.split(':'); check(`committed migration ${v} has the expected checksum`, byV.get(v)?.checksum === want, { actual: byV.get(v)?.checksum }) }
  // content vs the snapshot
  const tables = await q(`select table_schema s, table_name t from information_schema.tables where table_schema in ('public','ingest','research') and table_type = 'BASE TABLE' order by 1, 2`)
  const bad = []; const novel = []
  for (const { s, t } of tables) {
    const key = `${s}.${t}`; const m = manifest.tables[key]
    if (!m) { novel.push(key); continue }
    const rws = (await q(`select to_jsonb(x) j from ${key} x`)).map((r) => r.j)
    const snapRows = fs.readFileSync(path.join(snapDir, `${key}.ndjson`), 'utf8').split('\n').filter(Boolean)
    const canon = (a) => [...a].sort().join('\n')   // row order is physical, not data: compare as sets of canonical rows
    if (!after) {
      const text = rws.map((j) => JSON.stringify(j)).join('\n') + (rws.length ? '\n' : '')
      if (rws.length !== m.rows) bad.push(`${key}: ${m.rows} -> ${rws.length}`)
      else if (sha(text) !== m.sha256 && canon(rws.map((j) => JSON.stringify(j))) !== canon(snapRows.map((r) => JSON.stringify(JSON.parse(r))))) bad.push(`${key}: content differs`)
      continue
    }
    const keys = snapRows.length ? Object.keys(JSON.parse(snapRows[0])) : []
    const project = (j) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, j[k]])))
    const now = rws.map(project)
    if (REGISTRIES.includes(key)) { const have = new Set(now); if (!snapRows.map((r) => JSON.stringify(JSON.parse(r))).every((r) => have.has(r))) bad.push(`${key}: a snapshot row is missing`) }
    else if (now.length !== snapRows.length || canon(now) !== canon(snapRows.map((r) => JSON.stringify(JSON.parse(r))))) bad.push(`${key}: ${snapRows.length} -> ${now.length}`)
  }
  check(after ? 'every snapshot table is unchanged in its original columns (registries only gained rows)' : 'every table is byte-identical to the snapshot', bad.length === 0, bad)
  if (!after) check('no table exists that the snapshot does not know', novel.length === 0, novel); else out.facts.new_tables = novel
  const n = async (t) => Number((await q(`select count(*) n from ${t}`))[0].n)
  out.facts.counts = { transactions: await n('public.transactions'), trade_packages: await n('public.trade_packages'), trade_package_assets: await n('public.trade_package_assets'), players: await n('public.players'), war_observations: await n('public.war_observations'),
    draft_selections: await n('public.draft_selections'), international_signings: await n('public.international_signings'), release_audits: await n('ingest.release_audits'), historical_releases: await n('ingest.historical_releases'), source_publication_grants: await n('ingest.source_publication_grants') }
  await c.query('rollback')
} finally { await c.end() }
out.ok = out.checks.every((x) => x.ok)
if (argv.includes('--json')) console.log(JSON.stringify(out, null, 1))
else { for (const x of out.checks) console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.name}${!x.ok && x.detail ? ' ' + JSON.stringify(x.detail) : ''}`); console.log(`facts: ${JSON.stringify(out.facts)}`); console.log(out.ok ? 'PREFLIGHT OK' : 'PREFLIGHT FAILED') }
process.exit(out.ok ? 0 : 1)
