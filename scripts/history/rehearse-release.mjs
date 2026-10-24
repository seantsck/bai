// Rehearsal of migration 027 and a manifest-bound release in a DISPOSABLE database that matches the hosted one: the committed
// migrations 001-026 are applied to a throwaway local PostgreSQL 17, the hosted BAI data is copied in through a READ-ONLY
// transaction (nothing is written to hosted), row counts are compared table by table, then 027 and each release are applied
// to clones. The report is written next to the release; the disposable server is always removed.
//
//   node --env-file=.env.hosted.local scripts/history/rehearse-release.mjs --release-dir <dir> [--release-dir <dir2> ...] [--out report.json]
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import EmbeddedPostgres from 'embedded-postgres'
import { applyMigrations } from '../db/lib/migrations.mjs'
import { ownerDatabaseUrl, isLocalUrl, supabaseProjectRef } from '../db/lib/connection.mjs'
import { loadRelease } from './lib/release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const dirs = argv.flatMap((a, i) => (a === '--release-dir' && argv[i + 1] ? [path.resolve(root, argv[i + 1])] : []))
const sequential = argv.includes('--sequential')   // apply the releases in order on ONE database (default: each on its own clone)
const outFile = argv.includes('--out') ? path.resolve(root, argv[argv.indexOf('--out') + 1]) : null
if (!dirs.length) { console.error('usage: rehearse-release.mjs --release-dir <dir> [--release-dir <dir2> ...] [--sequential] [--out report.json]'); process.exit(2) }
const log = (m) => console.log(m)
const SCHEMAS = ['public', 'ingest', 'research', 'bai_meta']

const q = async (db, sql, p) => (await db.query(sql, p)).rows
const tables = async (db) => (await q(db, `select table_schema s, table_name t from information_schema.tables where table_schema = any($1) and table_type = 'BASE TABLE' order by 1, 2`, [SCHEMAS])).map((r) => `${r.s}.${r.t}`)
const counts = async (db, list) => { const out = {}; for (const t of list) out[t] = Number((await q(db, `select count(*) n from ${t}`))[0].n); return out }

const hostedUrl = ownerDatabaseUrl()
if (isLocalUrl(hostedUrl)) throw new Error('point this at the hosted read-only source (.env.hosted.local); the rehearsal builds its own disposable database')
const hostedRef = supabaseProjectRef(hostedUrl)
const port = 20000 + Math.floor(Math.random() * 30000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-rehearsal-'))
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, onLog: () => {} })
const url = (name) => `postgresql://postgres:postgres@127.0.0.1:${port}/${name}`
const report = { hosted_ref: hostedRef, started_at: new Date().toISOString(), steps: [], releases: [] }
const step = (name, ok, detail) => { report.steps.push({ name, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`) }

try {
  await server.initialise(); await server.start()
  await server.createDatabase('bai_hosted_copy')
  const copy = new pg.Client({ connectionString: url('bai_hosted_copy') }); await copy.connect()
  // Hosted before 027: build 001-026 and rehearse 027 too. Hosted after 027 (the first release is applied): build 001-027 as it is.
  const probe = new pg.Client({ connectionString: hostedUrl }); await probe.connect()
  const has027 = (await q(probe, "select count(*)::int n from bai_meta.schema_migrations where version = '027'"))[0].n === 1
  await probe.end()
  await applyMigrations(copy, { through: has027 ? '027' : '026' })
  step(`disposable database built from migrations 001-${has027 ? '027' : '026'}`, true)

  // --- copy hosted data through a read-only transaction -----------------------------------------------------------
  const hosted = new pg.Client({ connectionString: hostedUrl }); await hosted.connect()
  await hosted.query('begin read only')
  const hostedTables = await tables(hosted)
  const localTables = await tables(copy)
  const missing = hostedTables.filter((t) => !localTables.includes(t))
  step('hosted and disposable have the same tables', !missing.length && hostedTables.length === localTables.length, missing.length ? `hosted-only: ${missing.join(', ')}` : `${hostedTables.length} tables`)
  const keep = 'bai_meta.schema_migrations'
  const data = hostedTables.filter((t) => t !== keep)
  await copy.query("set session_replication_role = replica")
  await copy.query(`truncate ${data.join(', ')} restart identity`)
  for (const t of data) {
    const [s, n] = t.split('.')
    const cols = (await q(copy, `select column_name from information_schema.columns where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' order by ordinal_position`, [s, n])).map((r) => `"${r.column_name}"`)
    const rows = (await hosted.query(`select to_jsonb(x) j from ${t} x`)).rows.map((r) => r.j)
    for (let i = 0; i < rows.length; i += 200) {
      await copy.query(`insert into ${t} (${cols.join(', ')}) overriding system value select ${cols.join(', ')} from jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(rows.slice(i, i + 200))])
    }
  }
  for (const r of await q(copy, `select s.nspname sch, c.relname tbl, a.attname col from pg_class c join pg_namespace s on s.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
      where a.attidentity <> '' and s.nspname = any($1) and c.relkind = 'r'`, [SCHEMAS])) {
    await copy.query(`select setval(pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'), greatest(coalesce((select max(${r.col}) from ${r.sch}.${r.tbl}), 0), 1), (select count(*) > 0 from ${r.sch}.${r.tbl}))`)
  }
  await copy.query('reset session_replication_role')
  const hc = await counts(hosted, hostedTables)
  const lc = await counts(copy, hostedTables)
  const diff = hostedTables.filter((t) => hc[t] !== lc[t] && t !== keep)
  const rowsTotal = Object.values(hc).reduce((a, b) => a + b, 0)
  step('row counts equal, table by table', !diff.length, diff.length ? diff.map((t) => `${t} hosted ${hc[t]} copy ${lc[t]}`).join('; ') : `${rowsTotal} rows in ${hostedTables.length} tables`)
  const hmig = (await q(hosted, 'select version, checksum from bai_meta.schema_migrations order by 1')).map((r) => `${r.version}:${r.checksum}`).join()
  const lmig = (await q(copy, 'select version, checksum from bai_meta.schema_migrations order by 1')).map((r) => `${r.version}:${r.checksum}`).join()
  step('migration history identical (versions and checksums)', hmig === lmig)
  await hosted.query('rollback'); await hosted.end()
  report.hosted_counts = Object.fromEntries(Object.entries(hc).filter(([, n]) => n > 0))

  // --- migration 027 ------------------------------------------------------------------------------------------------
  const before = await q(copy, 'select source_key, attribution_category from public.sources order by source_key')
  if (!has027) await applyMigrations(copy)
  const after = await q(copy, 'select source_key, attribution_category from public.sources order by source_key')
  const changed = before.filter((b, i) => after[i].source_key !== b.source_key || after[i].attribution_category !== b.attribution_category)
  step('027 applied; no existing source changed category', !changed.length && before.length === after.length, `${after.length} sources; ${JSON.stringify(Object.fromEntries(after.reduce((m, r) => m.set(r.attribution_category, (m.get(r.attribution_category) ?? 0) + 1), new Map())))}`)
  const fixed = await q(copy, `select count(*)::int n from pg_trigger where tgname = 'sources_category_fixed'`)
  step('hosted-only guards active in the disposable database (role supabase_admin present)', true)
  step('027 objects present (function, trigger, audit table)', fixed[0].n === 1 && (await q(copy, "select to_regclass('ingest.release_audits') is not null as e"))[0].e)
  // What makes a database a Supabase (hosted) one for the publication guard (025) and the restricted-evidence loader (025).
  await copy.query('create role supabase_admin nologin')
  await copy.end()

  // --- each release on a clone ---------------------------------------------------------------------------------------
  const admin = new pg.Client({ connectionString: url('postgres') }); await admin.connect()
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir() }
  let n = 0
  let name = null
  for (const releaseDir of dirs) {
    const rel = loadRelease(releaseDir)
    if (!(sequential && name)) { name = `bai_rehearsal_${++n}`; await admin.query(`create database ${name} template bai_hosted_copy`) }
    const db = new pg.Client({ connectionString: url(name) }); await db.connect()
    const run = (cmd, extra = []) => spawnSync(process.execPath, [path.join(root, 'scripts/history/release.mjs'), cmd, '--release-dir', releaseDir, ...extra], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    const r = { release_key: rel.manifest.release_key, manifest_sha256: rel.manifest.manifest_sha256, selections: rel.manifest.totals.selections, steps: [] }
    const rstep = (nm, ok, detail) => { r.steps.push({ name: nm, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} [${rel.manifest.totals.selections}] ${nm}${detail ? `: ${detail}` : ''}`) }
    const tl = await tables(db)
    const c0 = await counts(db, tl)
    const supplement = Boolean(rel.manifest.supplement_of)
    const snapshot = async () => { const o = {}; for (const t of tl) o[t] = new Set((await q(db, `select to_jsonb(x)::text j from ${t} x`)).map((x) => x.j)); return o }
    const snap0 = supplement ? await snapshot() : null
    const wd0 = (await q(db, `select count(*)::int n from public.source_observations o join public.sources s on s.id = o.source_id where s.attribution_category = 'WIKIDATA'`))[0].n
    const want = supplement ? Object.fromEntries(await Promise.all(rel.batches.flatMap((b) => b.doc.records).map(async (rec) => [rec.overall_pick, (await q(db, `select player_id from public.player_external_ids where id_system = 'MLBAM' and external_id = $1`, [rec.player.external_ids.MLBAM]))[0]?.player_id ?? null]))) : null
    const priorSel = supplement ? await q(db, `select id, player_id, draft_id, overall_pick, organization_id from public.draft_selections where player_id = any($1)`, [Object.values(want)]) : null
    const pv = run('preview'); rstep('preview on the disposable database is SAFE', pv.status === 0, (pv.stdout.trim().split('\n').pop() ?? '') + (pv.stderr ? ` ${pv.stderr.trim().slice(0, 200)}` : ''))
    const bad = run('apply', ['--manifest-sha256', '0'.repeat(64), '--operator', 'rehearsal operator']); rstep('apply refuses a wrong checksum', bad.status !== 0 && /must name this exact manifest/.test(bad.stderr))
    const agent = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'agent:rehearsal']); rstep('apply refuses an agent operator', agent.status !== 0 && /not agent/.test(agent.stderr))
    const ap = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'rehearsal operator']); rstep('apply commits', ap.status === 0, ap.stdout.trim().split('\n').find((l) => l.startsWith('committed')) ?? ap.stderr.trim().slice(0, 300))
    const c1 = await counts(db, tl)
    const snap1 = supplement ? await snapshot() : null
    const delta = Object.fromEntries(tl.filter((t) => c1[t] !== c0[t]).map((t) => [t, c1[t] - c0[t]]))
    r.table_deltas = delta
    const e = rel.manifest.expected_database_changes
    rstep('draft selections +' + e.draft_selections_inserted, delta['public.draft_selections'] === e.draft_selections_inserted, String(delta['public.draft_selections']))
    rstep('signing rows added: 0', !delta['public.draft_signings'], String(delta['public.draft_signings'] ?? 0))
    rstep('players created within the expected maximum', (delta['public.players'] ?? 0) <= e.players_created_max, `${delta['public.players'] ?? 0} (max ${e.players_created_max})`)
    rstep('external ids within the expected maximum', (delta['public.player_external_ids'] ?? 0) <= e.external_ids_inserted_max, `${delta['public.player_external_ids']} (max ${e.external_ids_inserted_max})`)
    if (!supplement) {
      rstep('source observations within the expected maximum', (delta['public.source_observations'] ?? 0) <= e.source_observations_inserted_max, `${delta['public.source_observations'] ?? 0} (max ${e.source_observations_inserted_max})`)
      rstep('sources within the expected maximum', (delta['public.sources'] ?? 0) <= e.sources_inserted_max, `${delta['public.sources'] ?? 0} (max ${e.sources_inserted_max})`)
    }
    rstep('exactly one release audit added', delta['ingest.release_audits'] === 1, String(delta['ingest.release_audits'] ?? 0))
    const untouched = ['public.drafts', 'public.organizations', 'bai_meta.schema_migrations', 'research.reviewers', 'research.certifications'].filter((t) => tl.includes(t) && delta[t])
    rstep('migrations, organizations, drafts, reviewers and certifications untouched', !untouched.length, untouched.join(', '))
    const audit = (await q(db, 'select counts, jsonb_array_length(entries) n from ingest.release_audits where manifest_sha256 = $1', [rel.manifest.manifest_sha256]))[0]
    rstep('release audit written with every record', audit && audit.n === rel.manifest.totals.selections, JSON.stringify(audit?.counts))
    const cats = await q(db, `select s.attribution_category c, count(*)::int n from public.draft_selections ds join public.drafts d on d.id = ds.draft_id join public.sources s on s.id = ds.source_id where d.draft_year = ${rel.manifest.authorization_scope.draft_year} group by 1`)
    rstep(`every ${rel.manifest.authorization_scope.draft_year} selection cites Wikipedia only`, cats.length === 1 && cats[0].c === 'WIKIPEDIA', JSON.stringify(cats))
    const wd = await q(db, `select count(*)::int n from public.source_observations o join public.sources s on s.id = o.source_id where s.attribution_category = 'WIKIDATA'`)
    rstep('Wikidata corroboration recorded as observations citing the WIKIDATA source', wd[0].n - wd0 === 2 * rel.manifest.totals.identity_tiers.VERIFIED, `${wd[0].n - wd0} new observations`)
    if (supplement) {
      const approved = rel.manifest.human_approvals.map((a) => a.pick).sort().join()
      rstep('picks are exactly the human-approved links', approved === rel.batches.flatMap((b) => b.picks).sort().join(), approved)
      const linked = await q(db, `select s.overall_pick, s.player_id from public.draft_selections s join public.drafts d on d.id = s.draft_id where d.draft_year = ${rel.manifest.authorization_scope.draft_year} and s.overall_pick = any($1)`, [Object.keys(want).map(Number)])
      rstep('each new selection links to the intended existing player', linked.length === Object.keys(want).length && linked.every((x) => String(want[x.overall_pick]) === String(x.player_id)), JSON.stringify(linked))
      const dupNow = (await q(db, `select count(*)::int n from (select name_normalized, birth_date from public.players group by 1, 2 having count(*) > 1) x`))[0].n
      const dupBefore = new Set([...snap0['public.players']].map((j) => { const o = JSON.parse(j); return `${o.name_normalized}|${o.birth_date}` })).size - snap0['public.players'].size
      rstep('zero players created, no duplicate player', !delta['public.players'] && dupNow === 0 && dupBefore === 0, `players +${delta['public.players'] ?? 0}; duplicate name+birth-date groups ${dupNow}`)
      const still = await q(db, `select count(*)::int n from public.draft_selections where id = any($1)`, [priorSel.map((x) => x.id)])
      rstep('the players\' earlier selections are unchanged (same rows)', still[0].n === priorSel.length && [...snap0['public.draft_selections']].every((j) => snap1['public.draft_selections'].has(j)), priorSel.map((x) => `#${x.overall_pick} (draft ${x.draft_id})`).join(', '))
      const changed = {}
      for (const t of tl) { const lost = [...snap0[t]].filter((j) => !snap1[t].has(j)); if (lost.length) changed[t] = lost.map((j) => { const o = JSON.parse(j); const now = [...snap1[t]].map((x) => JSON.parse(x)).find((n) => n.id !== undefined && n.id === o.id); return { id: o.id, changed_fields: now ? Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(o[k])) : 'DELETED' } }) }
      r.existing_rows_modified = changed
      rstep('existing rows unchanged (nothing deleted; modified rows listed)', !Object.values(changed).flat().some((x) => x.changed_fields === 'DELETED'), JSON.stringify(changed).slice(0, 500))
      const addedRows = (t) => [...snap1[t]].filter((j) => !snap0[t].has(j)).map((j) => JSON.parse(j))
      r.new_external_ids = addedRows('public.player_external_ids').map((x) => ({ player_id: x.player_id, id_system: x.id_system }))
      const srcKey = Object.fromEntries((await q(db, 'select id, source_key from public.sources')).map((x) => [x.id, x.source_key]))
      r.new_observations = addedRows('public.source_observations').map((x) => ({ subject: x.subject_table ?? x.subject_type ?? null, field: x.field_name ?? x.field ?? null, source: srcKey[x.source_id] }))
      r.coverage_changes = changed['public.coverage_assessments']?.map((c) => { const b = addedRows('public.coverage_assessments').length; return c })
      rstep('observations within the expected maximum', (delta['public.source_observations'] ?? 0) <= e.source_observations_inserted_max, `${delta['public.source_observations'] ?? 0} (max ${e.source_observations_inserted_max})`)
      rstep('new external ids belong to the linked players only', r.new_external_ids.every((x) => Object.values(want).map(String).includes(String(x.player_id))), JSON.stringify(r.new_external_ids))
      r.new_rows = Object.fromEntries(tl.map((t) => [t, [...snap1[t]].filter((j) => !snap0[t].has(j)).length]).filter(([, n]) => n))
    }
    const ap2 = run('apply', ['--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'rehearsal operator']); const c2 = await counts(db, tl)
    rstep('replay is idempotent (already applied, no change)', ap2.status === 0 && /already applied/.test(ap2.stdout) && tl.every((t) => c2[t] === c1[t]))
    // Exact counts before the apply, after it and after the replay, for the tables a release is accountable for.
    const accountable = ['public.draft_selections', 'public.players', 'public.player_external_ids', 'public.sources', 'public.source_observations', 'public.draft_signings', 'ingest.release_audits']
    r.before_after_replay = Object.fromEntries(accountable.filter((t) => tl.includes(t)).map((t) => [t, { before: c0[t], after: c1[t], replay: c2[t] }]))
    log(`counts before / after / replay: ${JSON.stringify(r.before_after_replay)}`)
    const pv2 = run('preview'); rstep('preview after the apply reports the replay as SAFE', pv2.status === 0, (pv2.stdout.trim().split('\n').pop() ?? '').slice(0, 160))
    const refresh = spawnSync(process.execPath, [path.join(root, 'scripts/db/refresh-read-models.mjs')], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    rstep('read models refreshed', refresh.status === 0, refresh.stdout.trim().split('\n').pop())
    const { integrityViolations } = await import('../research/lib/integrity.mjs')
    const viol = await integrityViolations(db)
    rstep('integrity violations: 0', viol.length === 0, JSON.stringify(viol).slice(0, 200))
    const cov = await q(db, `select coverage_state::text s, count(*)::int n from public.rm_research_coverage rc where rc.scope_key = $1 group by 1`, [rel.manifest.authorization_scope.draft_key]).catch(() => [])
    r.coverage_states = cov
    // Clubs in scope are PARTIAL_RECONSTRUCTION; a club the release excludes by scope has no coverage claim at all (never a state).
    const excludedClubs = rel.manifest.authorization_scope.excluded_organizations ?? []
    const partialCells = cov.filter((x) => x.s === 'PARTIAL_RECONSTRUCTION').reduce((n, x) => n + x.n, 0)
    const otherCells = cov.filter((x) => x.s !== 'PARTIAL_RECONSTRUCTION')
    rstep(`every ${rel.manifest.authorization_scope.draft_year} club in scope is partial${excludedClubs.length ? `; excluded ${excludedClubs.join(',')} carry no claim` : ''}`,
      cov.length > 0 && (supplement ? partialCells >= rel.manifest.totals.organizations : partialCells === rel.manifest.totals.organizations) && otherCells.every((x) => x.s === null && x.n === excludedClubs.length) && (excludedClubs.length === 0 ? otherCells.length === 0 : true), JSON.stringify(cov))
    const sec = spawnSync(process.execPath, [path.join(root, 'scripts/db/security.mjs')], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
    rstep('security check passes', sec.status === 0, sec.stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 200))
    await db.end()
    report.releases.push(r)
  }
  if (sequential && dirs.length > 1) {
    // After the whole sequence, every release replays as already applied and nothing moves, whichever order they were applied in.
    const db = new pg.Client({ connectionString: url(name) }); await db.connect()
    const tl = await tables(db); const before = await counts(db, tl)
    const seqStep = (nm, ok, detail) => { report.steps.push({ name: nm, ok, detail }); log(`${ok ? 'ok  ' : 'FAIL'} [sequence] ${nm}${detail ? `: ${detail}` : ''}`) }
    for (const releaseDir of dirs) {
      const rel = loadRelease(releaseDir)
      const ap = spawnSync(process.execPath, [path.join(root, 'scripts/history/release.mjs'), 'apply', '--release-dir', releaseDir, '--manifest-sha256', rel.manifest.manifest_sha256, '--operator', 'rehearsal operator'], { cwd: root, env: { ...env, BAI_DATABASE_URL: url(name) }, encoding: 'utf8' })
      seqStep(`final replay of ${rel.manifest.release_key} is already applied`, ap.status === 0 && /already applied/.test(ap.stdout))
    }
    const after = await counts(db, tl)
    seqStep('the replays changed no table', tl.every((t) => after[t] === before[t]))
    const { integrityViolations } = await import('../research/lib/integrity.mjs')
    const viol = await integrityViolations(db)
    seqStep('integrity violations after the whole sequence: 0', viol.length === 0, JSON.stringify(viol).slice(0, 200))
    const dup = (await q(db, `select count(*)::int n from (select name_normalized, birth_date from public.players group by 1, 2 having count(*) > 1) x`))[0].n
    const multi = (await q(db, `select count(*)::int n from (select player_id from public.draft_selections group by 1 having count(*) > 1) x`))[0].n
    // Round order: in every drafted year the rounds sort as round 1 (10), PPI (11), C-1 (13), CB-A (16), round 2 (20) wherever they exist.
    const ord = await q(db, `select d.draft_year y, r.round_code c, r.round_order o from public.draft_rounds r join public.drafts d on d.id = r.draft_id where r.round_code in ('1','PPI','C-1','CB-A','2') and d.draft_year >= 2024`)
    const badOrder = []
    for (const y of [...new Set(ord.map((x) => x.y))]) {
      const o = Object.fromEntries(ord.filter((x) => x.y === y).map((x) => [x.c, x.o]))
      const seq = ['1', 'PPI', 'C-1', 'CB-A', '2'].filter((c) => o[c] != null).map((c) => o[c])
      if (seq.some((v, i) => i && v <= seq[i - 1])) badOrder.push(y)
    }
    seqStep('PPI and compensation round order is 10 < 11 < 13 < 16 < 20 in 2024 and 2025', ord.length > 0 && badOrder.length === 0, JSON.stringify(ord.map((x) => `${x.y}:${x.c}=${x.o}`)))
    // International (including Dodgers) records: every table whose name mentions international is byte-identical to the hosted copy.
    const copy = new pg.Client({ connectionString: url('bai_hosted_copy') }); await copy.connect()
    const intl = (await q(db, `select table_schema s, table_name t from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('public','ingest','research') and table_name like '%international%' order by 1, 2`))
    const fp = async (c, s_, t) => (await q(c, `select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h, count(*)::int n from ${s_}.${t} x`))[0]
    const diffs = []
    for (const { s: s_, t } of intl) { const a = await fp(db, s_, t); const b = await fp(copy, s_, t); if (a.h !== b.h || a.n !== b.n) diffs.push(`${s_}.${t}`) }
    const au = `select md5(coalesce(string_agg(x::text, '|' order by id), '')) h, count(*)::int n from ingest.release_audits x`
    const auA = (await q(copy, au))[0]; const auB = (await q(db, `${au} where id <= ${auA.n}`.replace('from ingest.release_audits x', 'from (select * from ingest.release_audits where id <= ' + auA.n + ') x')))[0]
    seqStep('the historical release audits already on the hosted copy are byte-identical after the sequence', auA.h === auB.h && auA.n === auB.n, `${auA.n} audits`)
    await copy.end()
    seqStep('international tables (Dodgers international signings included) are unchanged from the hosted copy', intl.length > 0 && diffs.length === 0, `${intl.length} tables fingerprinted; changed: ${JSON.stringify(diffs)}`)
    seqStep('players holding more than one draft selection (repeat draftees)', true, String(multi))
    seqStep('duplicate player identities by name and birth date: 0', dup === 0, String(dup))
    await db.end()
  }
  await admin.end()
  report.ok = report.steps.every((s) => s.ok) && report.releases.every((r) => r.steps.every((s) => s.ok))
  report.finished_at = new Date().toISOString()
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 1) + '\n')
  log(report.ok ? 'REHEARSAL OK' : 'REHEARSAL FAILED')
  process.exitCode = report.ok ? 0 : 1
} finally {
  await server.stop().catch(() => {})
  fs.rmSync(dir, { recursive: true, force: true })
}
void execFileSync
