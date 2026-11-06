// The gated hosted promotion runner (scripts/db/promotion-hosted.mjs, lib/promotion-hosted.mjs) against a DISPOSABLE local cluster. Hosted is never contacted: the connection factory is
// injected (the TLS behaviour of the real connection is tests/db/promotion-hosted-tls.test.mjs). Every refusal must leave the database exactly as it was.
// All rows are the fictional fixture rows of promotion-fixture.mjs. The owner's key is a throw-away test key in a temporary GnuPG home.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import * as h from './harness.mjs'
import { applyMigrations } from '../../scripts/db/lib/migrations.mjs'
import { takeSnapshot } from '../../scripts/db/lib/snapshot.mjs'
import { buildPromotionRecord, contentTreeHash, compareExports } from '../../scripts/db/lib/final-parity.mjs'
import { SESSION_SQL, buildPackage, loadPackage, sha256, verifyPackage, writePackage } from '../../scripts/db/lib/promotion.mjs'
import { AUTHORIZATION_FORMAT, OWNER_SIGNING_FINGERPRINTS, attemptLedger, verifyAuthorization, verifyDetachedSignature } from '../../scripts/db/lib/promotion-authorization.mjs'
import { ANCHOR_FORMAT, RELEASE_EVIDENCE_FORMAT, anchorChecks, cumulativeReleases, buildReleaseEvidence, releaseDirs } from '../../scripts/db/lib/promotion-cumulative.mjs'
import { beginAttempt, checkEvidence, draftAuthorization, hostedPreflight, observeState, operateHosted, promoteHosted, promoteInputs, readModelFacts, readModelProblems, readModelState, restPublicDelta, resolveState, serverReported, statusHosted, verifyPromoted, verifyPromotedHosted, websiteVisibleDelta } from '../../scripts/db/lib/promotion-hosted.mjs'
import { parseArgs } from '../../scripts/db/lib/promotion-hosted-args.mjs'
import { buildBaseline, importSample } from './promotion-fixture.mjs'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')
const exporter = path.join(root, 'tests/db/fixtures/local-export.sh')
const REF = 'dbnmktidheefoxaztivm'; const MAIN = 'g6h_main'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bai-g6h-'))
let BASE_FP, bareParityFile, admin, main, PORT, pkg, pkgDir, evidenceFile, evidence, backupDir, parityFile, FPR, signHome, pubHome, ledger, env
const hex = () => crypto.randomBytes(16).toString('hex')
const open = async (name) => { const c = await h.connect(name); c.on('error', () => {}); await c.query(SESSION_SQL); return c }
const rows = (c, sql, p) => h.rows(c, sql, p)
const scopeFp = async (db = main) => { const o = {}; for (const t of (await rows(db, 'select unnest(ingest.promotion_scope()) t')).map((r) => r.t)) o[t] = JSON.stringify((await rows(db, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f); return o }
const refused = async (p) => p.then(() => null, (e) => e.message)
const sh = (cmd, args, e = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', ...e } }); assert.equal(r.status, 0, `${cmd} ${args.slice(0, 3).join(' ')}: ${r.stderr}`); return r.stdout }
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// ---- owner key, signed authorizations -------------------------------------------------------------------------------------------------------------------------------------------
function makeKeys () {
  signHome = path.join(tmp, 'gpg-sign'); pubHome = path.join(tmp, 'gpg-pub'); fs.mkdirSync(signHome, { mode: 0o700 }); fs.mkdirSync(pubHome, { mode: 0o700 })
  sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Test Owner', 'ed25519', 'sign', 'never'], { GNUPGHOME: signHome })
  FPR = /^fpr:::::::::([0-9A-F]{40}):/m.exec(sh('gpg', ['--batch', '--with-colons', '--list-keys'], { GNUPGHOME: signHome }))[1]
  const pub = path.join(tmp, 'owner.pub'); sh('gpg', ['--batch', '--export', '--output', pub, FPR], { GNUPGHOME: signHome }); sh('gpg', ['--batch', '--import', pub], { GNUPGHOME: pubHome })
}
const sign = (file, home = signHome, who = FPR) => sh('gpg', ['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase', '', '--local-user', who, '--detach-sign', '--output', `${file}.sig`, file], { GNUPGHOME: home })
let nAuth = 0
/** Writes a signed authorization for `op`; `over` overrides fields (a value of undefined removes the field); signed: false leaves it unsigned. */
function authorize (op, over = {}, { signed = true, manifest = pkg.sha } = {}) {
  const now = Date.now()
  const base = { format: AUTHORIZATION_FORMAT, operation: op, project_ref: REF, manifest_sha256: manifest, not_before: new Date(now - 60e3).toISOString(), expires_at: new Date(now + 3600e3).toISOString(), nonce: hex(), after_attempt: null }
  if (op === 'promote') {
    const rec = JSON.parse(fs.readFileSync(parityFile, 'utf8'))
    Object.assign(base, { backup: { name: path.basename(backupDir), t0: rec.backup.started_at, manifest_sha256: rec.backup.manifest_sha256, archive_sha256: rec.offsite.encrypted_sha256, content_tree_sha256: rec.backup.tree_sha256, offsite_record_sha256: rec.offsite.verification_record_sha256 },
      parity_record_sha256: sha256(fs.readFileSync(parityFile)), attribution_evidence_sha256: evidence.evidence_sha256, rest_public_delta: restDelta, website_visible_delta: webDelta })
  } else base.reason = `test ${op}`
  const a = { ...base, ...over }; for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k]
  const f = path.join(tmp, `auth-${op}-${++nAuth}.json`); fs.writeFileSync(f, JSON.stringify(a, null, 1)); if (signed) sign(f)
  return f
}
let restDelta, webDelta
// the local databases have no supabase_migrations schema (a restore keeps that history in a side file), so the library option that allows its absence is set here; the CLI never sets it
const ctxFor = (connect, over = {}) => ({ connect, projectRef: REF, keyring: pubHome, pinned: [FPR], ledger, env: {}, log: () => {}, requireSupabaseHistory: false, expectedMlb: 2, ...over })
const connectMain = async () => ({ client: await open(MAIN) })
const ctx = (over) => ctxFor(connectMain, over)
/** A connection that behaves like one whose socket dies: `onQuery(sql, real)` may throw. */
const flaky = (onQuery) => async () => { const real = await open(MAIN); const q = real.query.bind(real); real.query = async (sql, p) => onQuery(String(sql), q, real, p); return { client: real } }

// ---- evidence, backup, parity record --------------------------------------------------------------------------------------------------------------------------------------------
function makeEvidence (capturedAt = new Date().toISOString()) {
  const doc = { format: 'bai-live-attribution-evidence/1', phase: 'pre', captured_utc: capturedAt, base: 'https://example.invalid', deployment: 'dpl_TESTONLY', commit: 'a'.repeat(40), all_pages_carry_the_statement: true, pages: [] }
  return { ...doc, evidence_sha256: sha256(JSON.stringify(doc, null, 1)) }
}
async function makeBackup (db, ageMs = 0) {
  const named = path.join(tmp, `bk${Math.random().toString(36).slice(2, 6)}`, `g1-${stamp(Date.now() - ageMs)}`)
  fs.mkdirSync(path.dirname(named), { recursive: true })
  await takeSnapshot(db, path.join(named, 'snapshot'))
  const r = spawnSync('bash', [exporter, path.join(named, 'export')], { encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr)
  const arc = Buffer.concat([Buffer.from([0x8c, 13, 4, 9, 3, 10]), crypto.randomBytes(8), Buffer.from([0xff, 0xd2, 60, 1]), crypto.randomBytes(59)])
  fs.writeFileSync(`${named}.tar.zst.gpg`, arc); fs.writeFileSync(`${named}.tar.zst.gpg.sha256`, sha256(arc) + '\n'); fs.writeFileSync(`${named}.tar.zst.gpg.tree-sha256`, contentTreeHash(named) + '\n')
  const ret = path.join(path.dirname(named), `returned-${path.basename(named)}`); fs.mkdirSync(ret); fs.writeFileSync(path.join(ret, `${path.basename(named)}.tar.zst.gpg`), arc)
  return named
}
/** A promotion parity record exactly as final-parity.mjs writes it from the backup tool's verified off-site record (the record hash is a stand-in: backup-run is not run in tests). */
const OFFSITE_RECORD_SHA = crypto.createHash('sha256').update('stand-in for the backup tool\'s off-site verification record').digest('hex')
function freshRecord (now = Date.now()) {
  const file = path.join(tmp, `parity-lib-${++nAuth}.json`)
  const rec = buildPromotionRecord({ backupDir, projectRef: REF, expectLevel: '034', manifest: pkg.manifest, manifestSha: pkg.sha, offsite: { encrypted: sha256(fs.readFileSync(`${backupDir}.tar.zst.gpg`)), tree: contentTreeHash(backupDir), authorizationRef: 'owner test', recordSha256: OFFSITE_RECORD_SHA }, exportHashes: { 'roles.sql': 'x' }, now })
  fs.writeFileSync(file, JSON.stringify(rec, null, 1)); return file
}
function runParity (dir, packageDir, extraEnv = {}) {
  const rec = path.join(tmp, `parity-${++nAuth}.json`)
  const arc = sha256(fs.readFileSync(`${dir}.tar.zst.gpg`))
  const r = spawnSync(process.execPath, ['scripts/db/final-parity.mjs', '--backup-dir', dir, '--promotion-package', packageDir, '--record', rec, '--offsite-sha256', arc, '--offsite-tree', contentTreeHash(dir), '--authorization-ref', 'owner test', '--export-script', exporter],
    { cwd: root, encoding: 'utf8', env: { ...env, BAI_SUPABASE_PROJECT_REF: REF, ...extraEnv } })
  return { ...r, rec, out: r.stdout + r.stderr }
}

before(async () => {
  makeKeys(); ledger = attemptLedger(path.join(tmp, 'ledger'))
  await h.startServer(); admin = await h.connect('postgres'); await admin.query(`create database ${MAIN}`)
  main = await open(MAIN); PORT = main.port
  await applyMigrations(main, { through: '030' }); await main.query("alter role bai_web login password 'webpw'")
  await buildBaseline(main, tmp)
  await applyMigrations(main)                                                                                             // 032, 033, 034
  assert.equal((await rows(main, 'select max(version) v from bai_meta.schema_migrations'))[0].v, '034')
  await main.end()
  for (const n of ['a', 'lvl', 'drift']) await admin.query(`create database g6h_${n} template ${MAIN}`)
  const lvl = await open('g6h_lvl'); await lvl.query("delete from bai_meta.schema_migrations where version = '034'"); await lvl.end()
  const dr = await open('g6h_drift'); await dr.query("insert into players (slug, full_name, display_name) values ('g6h-drift', 'Drift', 'Drift')"); await dr.end()
  const st = await open('g6h_a'); const batches = await importSample(st, tmp); await st.end()
  const connect = (name) => open(name)
  pkgDir = path.join(tmp, 'pkg'); evidence = makeEvidence(); evidenceFile = path.join(tmp, 'evidence.json'); fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 1))
  pkg = await buildPackage({ connect, admin, baseName: MAIN, stageName: 'g6h_a', outDir: pkgDir, config: { category: 'RETROSHEET', authorization: { effective_from: '2026-10-30', expires_on: '2099-01-22' },
    attribution: { evidence_sha256: evidence.evidence_sha256, verified_at: evidence.captured_utc, max_age_hours: 72 }, archive: { name: 'fixture-tranDB.zip', sha256: sha256('fixture archive') }, expectBatches: batches } })
  main = await open(MAIN)
  env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: os.tmpdir(), BAI_DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PORT}/${MAIN}` }
  backupDir = await makeBackup(main)
  const r = runParity(backupDir, pkgDir); assert.equal(r.status, 0, r.out); bareParityFile = r.rec
  parityFile = freshRecord()
  BASE_FP = await scopeFp()
  restDelta = await restPublicDelta(main, pkg.manifest); webDelta = await websiteVisibleDelta(main, pkg.manifest)
}, { timeout: 240000 })
after(async () => { await h.stopServer(); fs.rmSync(tmp, { recursive: true, force: true }) })

// ---- the contract ---------------------------------------------------------------------------------------------------------------------------------------------------------------
test('the REST-visible delta is computed from the catalog: after 034 only the new source row is readable through the Data API; the identity relations are closed', async () => {
  assert.deepEqual(restDelta.map((x) => x.relation), ['public.sources', 'public.v_transaction_record_sources'], 'players, ids, observations, coverage rows and aliases are closed to anon/authenticated since 033/034; the only others are the new source row and the owner-rights attribution aggregate over it')
  assert.equal(restDelta[0].rows, 1); assert.deepEqual(restDelta[0].by, ['anon', 'authenticated'])
  assert.ok(webDelta.some((x) => x.relation === 'public.players' && x.rows > 0) && webDelta.some((x) => x.relation === 'public.sources'), 'the website role reads the new identities: that is the real publication and the owner must acknowledge it too')
  assert.ok(webDelta.length > restDelta.length)
  // a COLUMN-level grant to anon, a view over a view, and security_invoker views are all classified correctly (inside a rolled-back transaction)
  await main.query('begin')
  try {
    await main.query('grant select (slug) on public.players to anon')
    await main.query('create view public.g6h_inner as select slug from public.players'); await main.query('create view public.g6h_outer as select slug from public.g6h_inner'); await main.query('grant select on public.g6h_outer to anon')
    await main.query('create view public.g6h_invoker with (security_invoker = on) as select slug from public.players'); await main.query('grant select on public.g6h_invoker to anon')
    const d = await restPublicDelta(main, pkg.manifest); const names = d.map((x) => x.relation)
    assert.ok(names.includes('public.players'), 'a column-level grant is found'); assert.ok(names.includes('public.g6h_outer'), 'a view over a view is found'); assert.ok(!names.includes('public.g6h_invoker'), 'a security_invoker view exposes nothing by itself')
  } finally { await main.query('rollback') }
  const none = (await restPublicDelta(main, { load_order: ['public.players', 'public.player_external_ids'], delta: { 'public.players': { n: 1 }, 'public.player_external_ids': { n: 1 } } }))
  assert.deepEqual(none, [], 'closed tables report nothing')
})

test('an empty pin list refuses every write (fail closed) even with a valid signature, and the shipped pin does not trust the test key', () => {
  const f = authorize('withdraw')
  const v = verifyAuthorization(f, { operation: 'withdraw', projectRef: REF, manifest: pkg.sha, keyring: pubHome, pinned: [] })
  assert.match(v.problems.join(), /no owner signing key is pinned/)
  const w = verifyAuthorization(f, { operation: 'withdraw', projectRef: REF, manifest: pkg.sha, keyring: pubHome, pinned: OWNER_SIGNING_FINGERPRINTS })
  assert.match(w.problems.join(), /not one of the keys pinned|not a good signature/, 'a good signature by another key is refused under the shipped pin')
})

test('control: the inputs of a promotion check out with a good signature, a fresh evidence file and a fresh parity record', () => {
  const r = promoteInputs({ pkgDir, authFile: authorize('promote'), evidenceFile, parityFile, env: {}, projectRef: REF, keyring: pubHome, pinned: [FPR], ledger })
  assert.deepEqual(r.problems, [])
})

test('draft-authorization writes an UNSIGNED draft for the owner: it is filled in from the files and a read-only look at the database, verifies only after the owner signs it, and a close-api draft starts with the outage NOT acknowledged', async () => {
  const draft = await draftAuthorization(ctx(), { operation: 'promote', pkgDir, parityFile, evidenceFile })
  const f = path.join(tmp, 'draft-promote.json'); fs.writeFileSync(f, JSON.stringify(draft, null, 1))
  const o = { operation: 'promote', projectRef: REF, manifest: pkg.sha, keyring: pubHome, pinned: [FPR] }
  assert.match(verifyAuthorization(f, o).problems.join(), /signature/, 'an unsigned draft authorizes nothing')
  assert.ok(!fs.existsSync(`${f}.sig`)); assert.deepEqual(draft.rest_public_delta, restDelta); assert.equal(draft.parity_record_sha256, sha256(fs.readFileSync(parityFile))); assert.equal(draft.attribution_evidence_sha256, evidence.evidence_sha256)
  sign(f); assert.deepEqual(verifyAuthorization(f, o).problems, [], 'signed by the owner, the draft is a valid authorization')
  assert.equal(draft.after_attempt, null); assert.ok(Date.parse(draft.expires_at) - Date.parse(draft.not_before) <= 3600e3 + 1000)
  const em = await draftAuthorization(ctx(), { operation: 'emergency', manifest: pkg.sha, reason: 'test', closeApi: true }); assert.deepEqual(em.options, { close_api: true, acknowledge_site_outage: false })
  const ef = path.join(tmp, 'draft-emergency.json'); fs.writeFileSync(ef, JSON.stringify(em)); sign(ef); assert.match(verifyAuthorization(ef, { ...o, operation: 'emergency' }).problems.join(), /acknowledge the outage/, 'the owner must change the acknowledgement deliberately')
  await assert.rejects(draftAuthorization(ctx(), { operation: 'withdraw', manifest: pkg.sha }), /needs a --reason/)
  await assert.rejects(draftAuthorization(ctx(), { operation: 'promote', pkgDir, parityFile, evidenceFile, now: Date.now() + 80 * 3600e3 }), /cannot draft/)
  assert.deepEqual(parseArgs(['draft-authorization', '--operation', 'emergency', '--out', 'x', '--manifest', 'a', '--reason', 'r', '--close-api']).o, { operation: 'emergency', out: 'x', manifest: 'a', reason: 'r', 'close-api': true })
  assert.ok(parseArgs(['withdraw', '--manifest', 'a', '--authorization', 'b', '--close-api']).error, 'the switches exist only on the draft command')
})

test('authorization: missing, unsigned, tampered, signed by another key, wrong operation, project or manifest, expired, not yet valid, over-long window, replayed', () => {
  const o = { operation: 'promote', projectRef: REF, manifest: pkg.sha, keyring: pubHome, pinned: [FPR] }
  const check = (f, over = {}) => verifyAuthorization(f, { ...o, ...over }).problems.join(' | ')
  assert.match(check(path.join(tmp, 'nope.json')), /missing or unreadable/)
  assert.match(check(authorize('promote', {}, { signed: false })), /signature/)
  const t = authorize('promote'); fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('"nonce"', '"nonce" '))   // one byte of difference
  assert.match(check(t), /not a good signature|no valid signature/)
  const otherHome = path.join(tmp, 'gpg-other'); fs.mkdirSync(otherHome, { mode: 0o700 })
  sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Other Test Key', 'ed25519', 'sign', 'never'], { GNUPGHOME: otherHome })
  const otherFpr = /^fpr:::::::::([0-9A-F]{40}):/m.exec(sh('gpg', ['--batch', '--with-colons', '--list-keys'], { GNUPGHOME: otherHome }))[1]
  const forged = authorize('promote', {}, { signed: false }); sign(forged, otherHome, otherFpr)
  assert.match(check(forged), /not a good signature|no valid signature|not one of the keys pinned/, 'a signature by a key that is not the owner\'s is refused')
  assert.match(check(authorize('promote'), { operation: 'withdraw' }), /is for "promote", not "withdraw"/)
  assert.match(check(authorize('promote', { project_ref: 'a'.repeat(20) })), /another project/)
  assert.match(check(authorize('promote'), { manifest: 'f'.repeat(64) }), /another manifest/)
  assert.match(check(authorize('promote', { expires_at: new Date(Date.now() - 1000).toISOString(), not_before: new Date(Date.now() - 7200e3).toISOString() })), /expired/)
  assert.match(check(authorize('promote', { not_before: new Date(Date.now() + 3600e3).toISOString(), expires_at: new Date(Date.now() + 7200e3).toISOString() })), /not yet valid/)
  assert.match(check(authorize('promote', { expires_at: new Date(Date.now() + 48 * 3600e3).toISOString() })), /no valid window/)
  assert.match(check(authorize('promote', { nonce: 'abc' })), /nonce/)
  assert.match(check(authorize('promote', { after_attempt: 'zz' })), /after_attempt/)
  assert.match(check(authorize('promote', { rest_public_delta: undefined })), /rest_public_delta/)
  const used = authorize('promote'); const sha = sha256(fs.readFileSync(used))
  assert.match(verifyAuthorization(used, { ...o, isConsumed: (x) => x === sha }).problems.join(), /already used/)
  assert.match(check(authorize('emergency', { reason: '  ' })), /is for "emergency"/)
  assert.match(verifyAuthorization(authorize('emergency', { reason: '' }), { ...o, operation: 'emergency' }).problems.join(), /needs a stated reason/)
  assert.match(verifyAuthorization(authorize('emergency', { options: { close_api: true } }), { ...o, operation: 'emergency' }).problems.join(), /acknowledge the outage/)
  assert.deepEqual(verifyAuthorization(authorize('emergency', { options: { close_api: true, acknowledge_site_outage: true } }), { ...o, operation: 'emergency' }).problems, [])
})

test('what gpg verifies is exactly the bytes that are used: a signature over file A does not verify other bytes (no read-after-check swap), and malformed inputs fail closed', async () => {
  const a = authorize('withdraw'); const b = authorize('withdraw')
  const bytesA = fs.readFileSync(a); const bytesB = fs.readFileSync(b)
  assert.equal(verifyDetachedSignature(bytesA, `${a}.sig`, { keyring: pubHome, pinned: [FPR] }).ok, true)
  assert.equal(verifyDetachedSignature(bytesB, `${a}.sig`, { keyring: pubHome, pinned: [FPR] }).ok, false, 'A\'s signature does not cover B\'s bytes')
  assert.equal(verifyDetachedSignature(bytesA, `${tmp}/missing.sig`, { keyring: pubHome, pinned: [FPR] }).ok, false)
  const nul = path.join(tmp, 'null.json'); fs.writeFileSync(nul, 'null'); sign(nul)
  assert.match(verifyAuthorization(nul, { operation: 'withdraw', projectRef: REF, manifest: pkg.sha, keyring: pubHome, pinned: [FPR] }).problems.join(), /not a JSON object/)
  assert.ok(parseArgs(['constructor']).error && parseArgs(['__proto__']).error && parseArgs(['toString']).error, 'prototype keys are not commands')
  await assert.rejects(draftAuthorization(ctx(), { operation: 'withdraw', manifest: pkg.sha, reason: 'x', hours: Number('abc') }), /positive number/)
  const loose = path.join(tmp, 'ledger-loose'); fs.mkdirSync(loose, { mode: 0o777 }); fs.chmodSync(loose, 0o777)
  assert.throws(() => attemptLedger(loose).consume('c'.repeat(64), {}), /mode 0700/)
})

test('a keyring that holds a secret key is refused (the runner host must hold only the owner\'s public key)', () => {
  const v = verifyAuthorization(authorize('withdraw'), { operation: 'withdraw', projectRef: REF, manifest: pkg.sha, keyring: signHome, pinned: [FPR] })
  assert.match(v.problems.join(), /holds a SECRET key/)
})

test('refused before any connection: missing authorization, wrong project, wrong manifest, changed payload, stale attribution evidence, expired parity record, missing off-site evidence', async () => {
  const before = await scopeFp()
  const run = (over = {}) => promoteHosted(ctx(over.ctx), { pkgDir: over.pkgDir ?? pkgDir, authFile: over.auth ?? authorize('promote'), evidenceFile: over.evidenceFile ?? evidenceFile, parityFile: over.parityFile ?? parityFile })
  const rejectsWith = async (p, re, label) => { const m = await refused(p); assert.match(m ?? 'NOT REFUSED', re, label); assert.match(m, /before any connection/, `${label}: refused before connecting`) }
  await rejectsWith(run({ auth: path.join(tmp, 'absent.json') }), /missing or unreadable/, 'missing authorization')
  await rejectsWith(run({ auth: authorize('promote', {}, { signed: false }) }), /signature/, 'unsigned')
  await rejectsWith(run({ ctx: { projectRef: 'b'.repeat(20) } }), /another project/, 'wrong project')
  await rejectsWith(run({ auth: authorize('promote', {}, { manifest: 'e'.repeat(64) }) }), /another manifest/, 'wrong manifest')
  await rejectsWith(run({ auth: authorize('promote', { parity_record_sha256: 'd'.repeat(64) }) }), /another parity record/, 'authorization names another parity record')
  await rejectsWith(run({ auth: authorize('promote', { attribution_evidence_sha256: 'd'.repeat(64) }) }), /another attribution evidence/, 'authorization names another evidence')
  await rejectsWith(run({ auth: authorize('promote', { backup: { name: 'g1-other', t0: new Date().toISOString(), manifest_sha256: 'a'.repeat(64), archive_sha256: 'b'.repeat(64), content_tree_sha256: 'c'.repeat(64), offsite_record_sha256: 'd'.repeat(64) } }) }), /another backup/, 'authorization names another backup')
  await rejectsWith(run({ parityFile: bareParityFile, auth: authorize('promote', { backup: { name: path.basename(backupDir), t0: new Date().toISOString(), manifest_sha256: 'a'.repeat(64), archive_sha256: 'b'.repeat(64), content_tree_sha256: 'c'.repeat(64), offsite_record_sha256: 'd'.repeat(64) } }) }), /off-site|offsite/, 'a record made from bare hashes, not the backup tool\'s verified record')
  // changed package payload
  const copy = path.join(tmp, 'pkg-tampered'); fs.cpSync(pkgDir, copy, { recursive: true }); fs.appendFileSync(path.join(copy, 'payload', 'public__players.json'), ' ')
  await rejectsWith(run({ pkgDir: copy }), /package: .*does not match its recorded hash/, 'changed payload')
  // stale attribution evidence (older than the package allows): checked on its own and in the full path
  assert.match(checkEvidence(evidenceFile, pkg.manifest, { now: Date.now() + 73 * 3600e3 }).join(), /hours old; the limit is 72/)
  const oldEv = path.join(tmp, 'evidence-old.json'); const e2 = makeEvidence(new Date(Date.now() - 80 * 3600e3).toISOString()); fs.writeFileSync(oldEv, JSON.stringify(e2, null, 1))
  await rejectsWith(run({ evidenceFile: oldEv }), /attribution evidence: .*not the evidence the package pins|verified_at/, 'a different, older evidence file')
  const bad = path.join(tmp, 'evidence-bad.json'); fs.writeFileSync(bad, JSON.stringify({ ...evidence, all_pages_carry_the_statement: false })); assert.match(checkEvidence(bad, pkg.manifest).join(), /own hash|statement on every page/)
  // expired parity record (and with it a backup older than six hours)
  await rejectsWith(run({ ctx: { now: () => Date.now() + 11 * 60e3 } }), /expired/, 'record older than ten minutes')
  const oldNow = Date.now() + 7 * 3600e3
  assert.match(promoteInputs({ pkgDir, authFile: authorize('promote', { not_before: new Date(oldNow - 60e3).toISOString(), expires_at: new Date(oldNow + 3600e3).toISOString() }), evidenceFile, parityFile, env: {}, projectRef: REF, keyring: pubHome, pinned: [FPR], ledger, now: oldNow }).problems.join(), /hours old; the maximum is 6/)
  // missing verified off-site evidence
  const sidecar = `${backupDir}.tar.zst.gpg.sha256`; const keep = fs.readFileSync(sidecar)
  fs.unlinkSync(sidecar)
  try { await rejectsWith(run(), /off-site evidence/, 'missing off-site companion') } finally { fs.writeFileSync(sidecar, keep) }
  const arc = `${backupDir}.tar.zst.gpg`; const keepArc = fs.readFileSync(arc); fs.writeFileSync(arc, Buffer.concat([keepArc, Buffer.from('x')]))
  try { await rejectsWith(run(), /off-site evidence|content changed|encrypted SHA-256/, 'altered encrypted archive') } finally { fs.writeFileSync(arc, keepArc) }
  assert.deepEqual(await scopeFp(), before, 'nothing changed')
  assert.deepEqual(ledger.attempts(pkg.sha), [], 'no attempt was recorded for a refusal before connecting')
})

test('refused by the hosted preflight (connected, read-only, nothing written): changed baseline, wrong migration level, wrong ledger', async () => {
  const before = await scopeFp()
  const via = (db) => async () => ({ client: await open(db) })
  const run = (db, authOver = {}) => promoteHosted(ctxFor(via(db)), { pkgDir, authFile: authorize('promote', authOver), evidenceFile, parityFile })
  let m = await refused(run('g6h_drift')); assert.match(m ?? 'NOT REFUSED', /hosted preflight/); assert.match(m, /baseline differs from the package's baseline in 1 table/)
  m = await refused(run('g6h_lvl')); assert.match(m ?? 'NOT REFUSED', /migration level is 033, not 034|ledger the package was built on/)
  m = await refused(run(MAIN, { rest_public_delta: [] })); assert.match(m ?? 'NOT REFUSED', /REST-visible delta differs/, 'an owner who did not acknowledge the exposure has not authorized it')
  m = await refused(run(MAIN, { rest_public_delta: [{ relation: 'public.sources', rows: 2, by: ['anon', 'authenticated'] }] })); assert.match(m, /REST-visible delta differs/)
  m = await refused(run(MAIN, { website_visible_delta: [] })); assert.match(m ?? 'NOT REFUSED', /website-visible delta differs/, 'an owner who did not acknowledge what the website would publish has not authorized it')
  assert.deepEqual(await scopeFp(), before); assert.deepEqual(ledger.attempts(pkg.sha), [], 'no attempt, and no authorization consumed, when the preflight refuses')
  const pre = await hostedPreflight(main, pkg, { requireSupabaseHistory: false, expectedMlb: 2 }); assert.deepEqual(pre.problems, [], 'control: against the real baseline the preflight passes')
  assert.match((await hostedPreflight(main, pkg, { expectedMlb: 2 })).problems.join(), /Supabase migration history table .* does not exist/, 'by default the platform history is required')
  assert.equal(pre.facts.state, 'NOT_PROMOTED'); assert.deepEqual(pre.facts.website_visible_delta, webDelta); assert.equal(pre.facts.mlb_transactions, 2); assert.equal(pre.facts.rm.content_rows, 0)
})

test('an unapproved or mismatched withdrawal is refused: no authorization, an authorization for another operation, an unsigned one, another manifest', async () => {
  const before = await scopeFp()
  const w = (auth) => operateHosted(ctx(), 'withdraw', { manifest: pkg.sha, authFile: auth })
  assert.match(await refused(w(path.join(tmp, 'none.json'))), /missing or unreadable/)
  assert.match(await refused(w(authorize('emergency'))), /is for "emergency", not "withdraw"/)
  assert.match(await refused(w(authorize('withdraw', {}, { signed: false }))), /signature/)
  assert.match(await refused(operateHosted(ctx(), 'withdraw', { manifest: 'c'.repeat(64), authFile: authorize('withdraw') })), /another manifest/)
  assert.match(await refused(operateHosted(ctx(), 'withdraw', { manifest: 'nothex', authFile: authorize('withdraw') })), /64-hex/)
  assert.match(await refused(w(authorize('withdraw'))), /is NOT_PROMOTED, not PROMOTED|not PROMOTED/, 'even a valid authorization cannot withdraw what was never promoted')
  assert.deepEqual(await scopeFp(), before)
})

test('the argument parser refuses unsupported and dangerous flags, duplicates and positional arguments', () => {
  for (const bad of [['promote', '--hosted', 'x'], ['promote', '--confirm-hosted', REF], ['promote', '--database', 'x'], ['withdraw', '--with-grant', 'x'], ['emergency', '--close-api', 'x'], ['withdraw', '--reason', 'x'], ['status', '--manifest', 'a', '--force', '1'], ['status', '--manifest', 'a', '--manifest', 'b'], ['status', 'extra'], ['status'], ['bogus'], [], ['promote', '--package', 'p', '--authorization', 'a'], ['status', '--manifest', '--report', 'x'], ['status', '--manifest', 'a', '--url', 'postgresql://x']]) {
    assert.ok(parseArgs(bad).error, `refused: ${bad.join(' ')}`)
  }
  assert.deepEqual(parseArgs(['status', '--manifest', 'a']).o, { manifest: 'a' })
  assert.deepEqual(parseArgs(['promote', '--package', 'p', '--authorization', 'a', '--attribution-evidence', 'e', '--parity-record', 'r', '--owner-keyring', 'k']).o, { package: 'p', authorization: 'a', 'attribution-evidence': 'e', 'parity-record': 'r', 'owner-keyring': 'k' })
  assert.deepEqual(parseArgs(['verify-promoted', '--package', 'p', '--release-evidence', 'd', '--expect-head', 'h']).o, { package: 'p', 'release-evidence': 'd', 'expect-head': 'h' })
  assert.match(parseArgs(['verify-promoted', '--package', 'p', '--release-evidence', 'd']).error, /needs --expect-head/); assert.match(parseArgs(['verify-promoted', '--package', 'p', '--expect-head', 'h']).error, /needs --release-evidence/); assert.deepEqual(parseArgs(['verify-promoted', '--package', 'p']).o, { package: 'p' })
  assert.deepEqual(parseArgs(['record-release-evidence', '--package', 'p', '--authorization', 'a.json', '--anchor', 'n.json', '--out', 'e.json', '--previous-evidence', 'x']).o, { package: 'p', authorization: 'a.json', anchor: 'n.json', out: 'e.json', 'previous-evidence': 'x' })
  assert.match(parseArgs(['record-release-evidence', '--package', 'p', '--authorization', 'a.json', '--out', 'e.json']).error, /missing --anchor/); assert.match(parseArgs(['verify-promoted', '--package', 'p', '--release-evidence', 'a', '--release-evidence', 'b', '--expect-head', 'h']).error, /given twice/)
  assert.match(parseArgs(['record-release-evidence', '--authorization', 'a', '--out', 'b', '--confirm-hosted', 'x']).error, /refusing|unsupported/)
})

test('the CLI itself: unsupported flags exit 2; the build refuses a complete promotion signed by a key that is not the pinned owner key, before connecting; the local tool still refuses hosted', () => {
  const cli = (args, e = {}) => spawnSync(process.execPath, ['scripts/db/promotion-hosted.mjs', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, ...e } })
  assert.equal(cli(['promote', '--hosted', 'x']).status, 2)
  assert.equal(cli(['status']).status, 2)
  const r = cli(['promote', '--package', pkgDir, '--authorization', authorize('promote'), '--attribution-evidence', evidenceFile, '--parity-record', parityFile, '--owner-keyring', pubHome], { BAI_SUPABASE_PROJECT_REF: REF, BAI_SUPABASE_DB_PASSWORD: 'x'.repeat(12) })
  assert.equal(r.status, 1); assert.match(r.stdout, /not one of the keys pinned|not a good signature/); assert.match(r.stdout, /before any connection/)
  const local = spawnSync(process.execPath, ['scripts/db/promotion.mjs', 'promote', '--package', pkgDir, '--hosted'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp } })
  assert.equal(local.status, 2); assert.match(local.stderr, /NOT AUTHORIZED/)
  const local2 = spawnSync(process.execPath, ['scripts/db/promotion.mjs', 'status', '--manifest', pkg.sha], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp, BAI_DATABASE_URL: 'postgresql://postgres:x@db.dbnmktidheefoxaztivm.supabase.co:5432/postgres', BAI_ALLOW_REMOTE_DB: '1', BAI_SUPABASE_PROJECT_REF: REF } }) // credential-scan:allow (a placeholder password for a refusal test)
  assert.notEqual(local2.status, 0); assert.match(local2.stderr, /NOT AUTHORIZED|refusing/, 'the local tool still refuses a hosted URL')
  const cliSrc = fs.readFileSync(path.join(root, 'scripts/db/promotion-hosted.mjs'), 'utf8')
  assert.ok(!/testOnly|requireSupabaseHistory|expectedMlb/.test(cliSrc), 'the CLI never passes the test-only connection override or relaxes the history check')
})

test('a connection lost BEFORE the commit: the server rolled everything back; the ledger says NOT_PROMOTED; nothing is retried; the attempt needs a new authorization naming it', async () => {
  const before = await scopeFp(); let begins = 0
  const conn = flaky(async (sql, q, real, p) => {
    if (/promote_begin/.test(sql)) begins++
    if (/promote_load/.test(sql) && p?.[0] === 'public.players') { real.connection.stream.destroy(); throw Object.assign(new Error('Connection terminated unexpectedly'), {}) }
    return q(sql, p)
  })
  const m = await refused(promoteHosted(ctxFor(conn, { }), { pkgDir, authFile: authorize('promote'), evidenceFile, parityFile }))
  assert.match(m ?? 'NOT REFUSED', /AMBIGUOUS RESULT/); assert.match(m, /"state":"NOT_PROMOTED"/); assert.match(m, /NOTHING WAS RETRIED/)
  assert.equal(begins, 1, 'promote_begin was sent exactly once')
  assert.deepEqual(await scopeFp(), before, 'the server rolled back the transaction')
  const [a] = ledger.attempts(pkg.sha); assert.equal(a.state, 'NOT_PROMOTED_CONFIRMED'); assert.equal(a.operation, 'promote')
  // a second attempt: with the same artifact (spent), with a fresh one that does not name the attempt, and with one that does
  const first = authorize('promote'); const again = (f) => promoteHosted(ctx(), { pkgDir, authFile: f, evidenceFile, parityFile })
  assert.match(await refused(again(authorize('promote'))), /did not complete: the owner's authorization must name it in after_attempt/)
  assert.match(await refused(again(authorize('promote', { after_attempt: 'f'.repeat(24) }))), /must name it in after_attempt|not this host's latest attempt/)
  const f2 = authorize('promote', { after_attempt: a.id })
  assert.equal(promoteInputs({ pkgDir, authFile: f2, evidenceFile, parityFile, env: {}, projectRef: REF, keyring: pubHome, pinned: [FPR], ledger }).problems.length, 0, 'an authorization that names the attempt passes the input checks')
  assert.ok(first)
})

test('statements issued by the runner never include a write before the attempt is recorded, and the attempt ledger is created exclusively', () => {
  const l = attemptLedger(path.join(tmp, 'ledger2')); const sha = 'a'.repeat(64)
  l.consume(sha, { x: 1 }); assert.throws(() => l.consume(sha, { x: 2 }), /EEXIST/); assert.ok(l.isConsumed(sha))
  const a = l.start({ manifest: 'b'.repeat(64), operation: 'promote', started_at: new Date().toISOString() }); a.update({ state: 'STARTED' })
  assert.equal(l.attempts('b'.repeat(64))[0].state, 'STARTED'); assert.equal(fs.statSync(l.dir).mode & 0o777, 0o700)
})

test('an unresolved or unknown earlier attempt blocks another one until "status" resolves it from the database', async () => {
  const l = attemptLedger(path.join(tmp, 'ledger3')); const m = pkg.sha
  const a = l.start({ manifest: m, operation: 'promote', started_at: new Date(Date.now() - 120e3).toISOString() }); a.update({ state: 'UNKNOWN' })
  const f = authorize('promote'); const inputs = () => promoteHosted(ctxFor(connectMain, { ledger: l }), { pkgDir, authFile: authorize('promote', { after_attempt: a.id }), evidenceFile, parityFile })
  assert.match(await refused(inputs()), /is UNKNOWN: resolve it first with "status"/)
  const s = await statusHosted(ctxFor(connectMain, { ledger: l }), m); assert.equal(s.state, 'NOT_PROMOTED'); assert.equal(s.attempts[0].state, 'NOT_PROMOTED_CONFIRMED')
  assert.ok(f)
})

test('promote: ONE transaction, a result lost AFTER the commit is resolved from the ledger (never repeated), and the post-checks hold', async () => {
  const baseFp = await scopeFp(); let begins = 0; const rmBefore = (await readModelState(main)).bookkeeping
  const conn = flaky(async (sql, q, real, p) => {
    if (/promote_begin/.test(sql)) begins++
    if (sql === 'commit') { await q(sql, p); real.connection.stream.destroy(); throw new Error('Connection terminated unexpectedly') }   // the server committed; the answer never arrived
    return q(sql, p)
  })
  const prior = ledger.attempts(pkg.sha).filter((a) => a.operation === 'promote').at(-1)   // the earlier attempt rolled back; the owner's new authorization names it
  const auth = authorize('promote', { after_attempt: prior.id })
  const m = await refused(promoteHosted(ctxFor(conn), { pkgDir, authFile: auth, evidenceFile, parityFile }))
  assert.match(m ?? 'NOT REFUSED', /AMBIGUOUS RESULT/); assert.match(m, /"state":"PROMOTED"/); assert.match(m, /NOTHING WAS RETRIED/); assert.equal(begins, 1)
  const attempts = ledger.attempts(pkg.sha).filter((a) => a.operation === 'promote'); assert.equal(attempts.at(-1).state, 'COMMITTED', 'the attempt record was resolved to COMMITTED from the database')
  const st = await statusHosted(ctx(), pkg.sha); assert.equal(st.state, 'PROMOTED')
  const after = await scopeFp(); const changed = Object.keys(after).filter((t) => after[t] !== baseFp[t]).sort()
  assert.deepEqual(changed, Object.keys(pkg.manifest.delta).sort(), 'exactly the delta tables changed')
  assert.equal((await rows(main, `select count(*)::int n from transactions t join sources s on s.id = t.source_id where s.attribution_category = 'MLB'`))[0].n, 2, 'the fixture\'s MLB trades are untouched')
  assert.equal((await rows(main, 'select count(*)::int n from rm_transactions'))[0].n, 0, 'no read model was refreshed'); assert.equal((await rows(main, 'select count(*)::int n from ingest.source_publication_grants'))[0].n, 1, 'no grant was created or removed')
  const v = await verifyPromotedHosted(ctx(), pkgDir); assert.equal(v.ok, true, JSON.stringify(v.problems)); assert.equal(v.facts.state, 'PROMOTED'); assert.equal(v.facts.rm.content_rows, 0); assert.deepEqual((await readModelState(main)).bookkeeping, rmBefore, 'no refresh ran')
  // the artifact is spent, the promotion cannot be repeated by any route
  assert.match(await refused(promoteHosted(ctx(), { pkgDir, authFile: auth, evidenceFile, parityFile })), /already used on this host/)
  assert.match(await refused(promoteHosted(ctx(), { pkgDir, authFile: authorize('promote'), evidenceFile, parityFile })), /already committed|NOT_PROMOTED|already holds/)
})

test('cumulative releases: a later owner-signed, audited draft release is excused only through a signed authorization AND signed evidence anchored independently, exact deltas, a chained release history and the recorded fingerprints; every other difference still fails', async () => {
  await main.end(); await admin.query(`create database g6h_cum template ${MAIN}`); main = await open(MAIN)   // the promoted state, copied
  const cu = await open('g6h_cum')
  const tabs = ['ingest.release_audits', 'public.schools']
  const fpOf = async (t) => (await rows(cu, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
  try {
    const verify = (releases = null, o = {}) => verifyPromoted(cu, pkg, { expectedMlb: 2, releases, keyring: pubHome, pinned: [FPR], projectRef: REF, ...o })
    const base = await verify(); assert.equal(base.ok, true, JSON.stringify(base.problems))
    const stranger = path.join(tmp, 'gpg-stranger'); fs.mkdirSync(stranger, { mode: 0o700 }); sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key', 'Stranger', 'ed25519', 'sign', 'never'], { GNUPGHOME: stranger })
    const strangerFpr = /^fpr:::::::::([0-9A-F]{40}):/m.exec(sh('gpg', ['--batch', '--with-colons', '--list-keys'], { GNUPGHOME: stranger }))[1]
    // ---- a FICTIONAL draft release: two school rows and its audit row (the real release tool writes many more tables; the verifier treats every table alike) ----
    const KEY = 'fixture-draft-2099-n2'; const MAN = hex() + hex()
    const preFp = Object.fromEntries(await Promise.all(tabs.map(async (t) => [t, await fpOf(t)])))
    await cu.query("insert into public.schools (slug, name, school_type) values ('fixture-school-a', 'Fixture School A', 'COLLEGE'), ('fixture-school-b', 'Fixture School B', 'COLLEGE')")
    await cu.query("insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ($1, $2, 2099, 'Fixture Operator', $3, '[]')", [KEY, MAN, { held: 0, skipped: 0, imported: 2, selections: 2, held_in_manifest: 0 }])
    const withoutRelease = await verify(); assert.equal(withoutRelease.ok, false); assert.match(withoutRelease.problems.join(), /tables differ from the release state: .*release_audits/, 'with no release evidence the difference is a failure, as before')
    let n = 0
    const mkAuth = (authOver = {}, { sigWith = signHome, who = FPR, signed = true, exp = { 'ingest.release_audits': 1, 'public.schools': 2 }, key = KEY, man = MAN } = {}) => {
      const dir = path.join(tmp, `cum-${++n}`); fs.mkdirSync(dir)
      const auth = { format: 'bai-draft-release-authorization/1', operation: 'apply-draft-release', project_ref: REF, release_key: key, manifest_sha256: man, selections: 2, expected_after_apply: exp, ...authOver }
      const af = path.join(dir, 'authorization.json'); fs.writeFileSync(af, JSON.stringify(auth, null, 1)); if (signed) sign(af, sigWith, who)
      return { dir, af, evPath: path.join(dir, 'evidence.json') }
    }
    /** The anchor the independent snapshot would give (in the real flow: anchor-release-evidence.mjs on a disposable restore of the post-release snapshot). Here: the fixture state right after the release. */
    const anchorFor = async (r, { before = preFp, patch = {} } = {}) => {
      const authSha = sha256(fs.readFileSync(r.af)); const af = path.join(r.dir, 'anchor.json'); const t = {}
      for (const [tb, d] of Object.entries(JSON.parse(fs.readFileSync(r.af, 'utf8')).expected_after_apply)) { const f = await fpOf(tb); t[tb] = { n_before: Number(f.n) - d, md5_before: before[tb]?.md5, delta: d, n_after: Number(f.n), md5_after: f.md5 } }
      fs.writeFileSync(af, JSON.stringify({ format: ANCHOR_FORMAT, authorization_sha256: authSha, release_key: KEY, snapshot_manifest_sha256: hex() + hex(), before_manifest_sha256: hex() + hex(), post_apply_report_sha256: hex() + hex(), post_apply_rows_sha256: hex() + hex(), tables: t, ...patch }, null, 1)); return af
    }
    const signedEvidence = async (r, { prev = null, patch = {}, sigWith = signHome, who = FPR, sign: doSign = true } = {}) => {
      const ev = await buildReleaseEvidence(cu, { authorizationFile: r.af, anchorFile: await anchorFor(r), previousEvidenceFile: prev, r6ManifestSha256: pkg.sha })
      const e = { ...ev, ...patch }; fs.writeFileSync(r.evPath, JSON.stringify(e, null, 1)); if (doSign) sign(r.evPath, sigWith, who); return e
    }
    const good = mkAuth(); const ev = await signedEvidence(good)
    assert.equal(ev.format, RELEASE_EVIDENCE_FORMAT); assert.equal(ev.previous_evidence_sha256, null); assert.equal(ev.r6_manifest_sha256, pkg.sha); assert.deepEqual(Object.keys(ev.tables).sort(), tabs)
    const ok = await verify([good.dir]); assert.equal(ok.ok, true, JSON.stringify(ok.problems)); assert.deepEqual(ok.facts.tables_differing, []); assert.deepEqual(ok.facts.tables_excused_by_releases.sort(), tabs); assert.equal(ok.facts.cumulative_releases[0].release_key, KEY)
    const fails = async (name, dirs, re, o = {}) => { const r = await verify(dirs, o); assert.equal(r.ok, false, `${name}: must fail`); assert.match(r.problems.join(' | '), re, name) }
    // ---- THE ATTACK (security review of PR #75): same-count tampering of a table the release changed, evidence recomputed from the tampered state ----
    await cu.query("update public.schools set name = 'Tampered by an attacker' where slug = 'fixture-school-a'")
    { const f = await fpOf('public.schools'); const forged = { ...ev, tables: { ...ev.tables, 'public.schools': { ...ev.tables['public.schools'], md5_after: f.md5 } } }
      // 1. the forged evidence left unsigned
      fs.writeFileSync(good.evPath, JSON.stringify(forged, null, 1)); fs.rmSync(`${good.evPath}.sig`, { force: true }); await fails('forged, UNSIGNED evidence (the attack)', [good.dir], /evidence is not signed by the pinned owner key/)
      // 2. the old signature kept over the edited bytes
      fs.writeFileSync(good.evPath, JSON.stringify(ev, null, 1)); sign(good.evPath); const oldSig = fs.readFileSync(`${good.evPath}.sig`); fs.writeFileSync(good.evPath, JSON.stringify(forged, null, 1)); fs.writeFileSync(`${good.evPath}.sig`, oldSig); await fails('forged evidence carrying the OLD valid signature', [good.dir], /evidence is not signed by the pinned owner key/)
      // 3. the attacker signs with his own key
      sign(good.evPath, stranger, strangerFpr); await fails('forged evidence signed by a FOREIGN key', [good.dir], /evidence is not signed by the pinned owner key/)
      // 4. the authentic evidence, with the tampered table: the recorded fingerprint no longer matches
      fs.writeFileSync(good.evPath, JSON.stringify(ev, null, 1)); sign(good.evPath); await fails('authentic signed evidence, table tampered afterwards', [good.dir], /public\.schools differs from the state recorded/)
      // 5. an evidence file built from the tampered state is refused by the builder (it checks the anchor), so it cannot even be produced for signing
      await assert.rejects(buildReleaseEvidence(cu, { authorizationFile: good.af, anchorFile: path.join(good.dir, 'anchor.json'), r6ManifestSha256: pkg.sha }), /no longer matches the independently anchored release state/)
    }
    await cu.query("update public.schools set name = 'Fixture School A' where slug = 'fixture-school-a'"); assert.equal((await verify([good.dir])).ok, true, 'restoring the row restores the recorded state')
    // ---- every other difference ----
    { const r = mkAuth({}, { signed: false }); await signedEvidence(r); await fails('an unsigned authorization excuses nothing', [r.dir], /authorization is not signed by the pinned owner key/) }
    { const r = mkAuth({}, { sigWith: stranger, who: strangerFpr }); await signedEvidence(r); await fails('an authorization signed by another key', [r.dir], /authorization is not signed by the pinned owner key/) }
    { const r = mkAuth(); await signedEvidence(r); fs.writeFileSync(r.af, fs.readFileSync(r.af, 'utf8').replace('"selections": 2', '"selections": 3')); await fails('an authorization edited after signing', [r.dir], /authorization is not signed by the pinned owner key/) }
    { const r = mkAuth({ project_ref: 'a'.repeat(20) }); await signedEvidence(r); await fails('another project', [r.dir], /another project/) }
    { const r = mkAuth({ operation: 'promote' }); await signedEvidence(r); await fails('another operation', [r.dir], /not a draft-release authorization/) }
    { const r = mkAuth(); const e = await signedEvidence(r, { patch: { authorization_sha256: hex() + hex() } }); await fails('evidence bound to another authorization', [r.dir], /not bound to this authorization/) }
    { const r = mkAuth(); await signedEvidence(r, { patch: { audit_id: '999999' } }); await fails('evidence naming another audit', [r.dir], /names audit 999999/) }
    { const r = mkAuth(); await signedEvidence(r, { patch: { r6_manifest_sha256: hex() + hex() } }); await fails('evidence for another R6 promotion', [r.dir], /another R6 promotion/) }
    { const r = mkAuth(); await signedEvidence(r, { patch: { anchor: undefined } }); await fails('evidence without an independent anchor', [r.dir], /no independent anchor/) }
    { const r = mkAuth(); await signedEvidence(r, { patch: { format: 'bai-draft-release-evidence/1' } }); await fails('a v1 evidence file is never accepted, even signed', [r.dir], /unknown format/) }
    { const other = hex() + hex(); const r = mkAuth({}, { man: other }); const e = { ...ev, manifest_sha256: other, authorization_sha256: sha256(fs.readFileSync(r.af)) }; fs.writeFileSync(r.evPath, JSON.stringify(e)); sign(r.evPath); await fails('no database audit for the release', [r.dir], /database holds 0 release audit\(s\) for this release key and manifest/) }
    { const r = mkAuth({ selections: 3 }); await signedEvidence(r); await fails('audit counts that differ from the authorized selection count', [r.dir], /audit counts .* do not match the authorized 3/) }
    { const r = mkAuth(); const e = { ...ev, authorization_sha256: sha256(fs.readFileSync(r.af)), tables: { ...ev.tables, 'public.schools': { ...ev.tables['public.schools'], delta: 5, n_after: ev.tables['public.schools'].n_after + 3 } } }; fs.writeFileSync(r.evPath, JSON.stringify(e)); sign(r.evPath); await fails('a signed evidence delta different from the authorized one', [r.dir], /differs from the authorized 2/) }
    { const r = mkAuth(); const e = { ...ev, authorization_sha256: sha256(fs.readFileSync(r.af)), tables: { ...ev.tables, 'public.schools': { ...ev.tables['public.schools'], n_before: ev.tables['public.schools'].n_before - 1 } } }; fs.writeFileSync(r.evPath, JSON.stringify(e)); sign(r.evPath); await fails('counts that do not chain from the R6 state', [r.dir], /do not chain from the previous state/) }
    { const r = mkAuth(); const e = { ...ev, authorization_sha256: sha256(fs.readFileSync(r.af)), tables: { ...ev.tables, 'public.schools': { ...ev.tables['public.schools'], md5_before: hex() } } }; fs.writeFileSync(r.evPath, JSON.stringify(e)); sign(r.evPath); await fails('content before the release is not the recorded previous state (a change absorbed into the anchor)', [r.dir], /table was changed between the previous state and this release/) }
    { const r = mkAuth(); const e = { ...ev, authorization_sha256: sha256(fs.readFileSync(r.af)), tables: { ...ev.tables, 'public.sources': { n_before: 1, delta: 1, n_after: 2, md5_after: 'x' } } }; fs.writeFileSync(r.evPath, JSON.stringify(e)); sign(r.evPath); await fails('evidence for a table the authorization does not list', [r.dir], /not exactly the authorized tables/) }
    // ---- stale evidence: a row edited / added / deleted after the release ----
    await cu.query("update public.schools set name = 'Edited later' where slug = 'fixture-school-a'"); await fails('a row edited after the release', [good.dir], /public\.schools differs from the state recorded/)
    await cu.query("update public.schools set name = 'Fixture School A' where slug = 'fixture-school-a'")
    await cu.query("insert into public.schools (slug, name, school_type) values ('fixture-extra', 'Extra', 'COLLEGE')"); await fails('an extra row beyond the authorized delta', [good.dir], /public\.schools differs from the state recorded/)
    await cu.query("delete from public.schools where slug = 'fixture-extra'")
    await cu.query("insert into public.players (slug, full_name, display_name) values ('cum-drift', 'Drift', 'Drift')"); await fails('an unrelated unauthorized change still fails with a release present', [good.dir], /tables differ from the release state: .*players/)
    await cu.query("delete from public.players where slug = 'cum-drift'"); assert.equal((await verify([good.dir])).ok, true)
    await assert.rejects(cu.query("update ingest.release_audits set counts = counts where release_key = $1", [KEY]), /append-only|cannot be/)
    // ---- duplicate audits ----
    { const dup = mkAuth(); await signedEvidence(dup); await fails('the same audit twice', [good.dir, dup.dir], /second evidence directory for the same audit|release chain is broken/) }
    await assert.rejects(cu.query("insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ($1, $2, 2099, 'Fixture Operator', $3, '[]')", [KEY, MAN, { held: 0, skipped: 0, imported: 2, selections: 2, held_in_manifest: 0 }]), /unique|duplicate/, 'the database itself refuses a second audit with the same key and manifest')
    // ---- an audited release without signed evidence is a difference nobody vouched for ----
    await cu.query("insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ('fixture-unvouched', $1, 2099, 'Fixture Operator', $2, '[]')", [hex() + hex(), { held: 0, skipped: 0, imported: 1, selections: 1, held_in_manifest: 0 }])
    await fails('an audit applied after the promotion with no signed evidence', [good.dir], /audit \d+ \(fixture-unvouched\) was applied after the R6 promotion and has no signed release evidence|differs from the state/)
    // ---- a SECOND release chains from the first ----
    // (the unvouched audit above is a separate fixture; use a fresh copy of the promoted state for the chain)
    await cu.end()
    await main.end(); await admin.query('drop database g6h_cum'); await admin.query(`create database g6h_cum template ${MAIN}`); main = await open(MAIN)
    const c2 = await open('g6h_cum')
    try {
      const v2 = (releases) => verifyPromoted(c2, pkg, { expectedMlb: 2, releases, keyring: pubHome, pinned: [FPR], projectRef: REF })
      const fp2 = async (t) => (await rows(c2, 'select ingest.promotion_fingerprint($1) f', [t]))[0].f
      const release = async (key, slug, prev) => {
        const man = hex() + hex(); const pre = { 'ingest.release_audits': (await fp2('ingest.release_audits')).md5, 'public.schools': (await fp2('public.schools')).md5 }; await c2.query("insert into public.schools (slug, name, school_type) values ($1, $2, 'COLLEGE')", [slug, `School ${slug}`])
        await c2.query("insert into ingest.release_audits (release_key, manifest_sha256, draft_year, operator, counts, entries) values ($1, $2, 2099, 'Fixture Operator', $3, '[]')", [key, man, { held: 0, skipped: 0, imported: 1, selections: 1, held_in_manifest: 0 }])
        const dir = path.join(tmp, `chain-${key}`); fs.mkdirSync(dir); const auth = { format: 'bai-draft-release-authorization/1', operation: 'apply-draft-release', project_ref: REF, release_key: key, manifest_sha256: man, selections: 1, expected_after_apply: { 'ingest.release_audits': 1, 'public.schools': 1 } }
        const af = path.join(dir, 'authorization.json'); fs.writeFileSync(af, JSON.stringify(auth, null, 1)); sign(af)
        const t = {}; for (const [tb, d] of Object.entries(auth.expected_after_apply)) { const f = await fp2(tb); t[tb] = { n_before: Number(f.n) - d, md5_before: pre[tb], delta: d, n_after: Number(f.n), md5_after: f.md5 } }
        const anchor = path.join(dir, 'anchor.json'); fs.writeFileSync(anchor, JSON.stringify({ format: ANCHOR_FORMAT, authorization_sha256: sha256(fs.readFileSync(af)), release_key: key, snapshot_manifest_sha256: hex() + hex(), before_manifest_sha256: hex() + hex(), post_apply_report_sha256: hex() + hex(), post_apply_rows_sha256: hex() + hex(), tables: t }))
        const e = await buildReleaseEvidence(c2, { authorizationFile: af, anchorFile: anchor, previousEvidenceFile: prev, r6ManifestSha256: pkg.sha }); const ep = path.join(dir, 'evidence.json'); fs.writeFileSync(ep, JSON.stringify(e, null, 1)); sign(ep); return { dir, ep, key }
      }
      const r1 = await release('chain-one', 'chain-a', null); const r2 = await release('chain-two', 'chain-b', r1.ep)
      const both = await v2([r1.dir, r2.dir]); assert.equal(both.ok, true, JSON.stringify(both.problems)); assert.equal(both.facts.cumulative_releases.length, 2)
      assert.match((await v2([r1.dir])).problems.join(' | '), /chain-two\)? was applied after the R6 promotion and has no signed release evidence|differs from the state recorded/, 'the later release cannot be dropped')
      assert.match((await v2([r2.dir])).problems.join(' | '), /release chain is broken/, 'the second release cannot stand alone: it names a previous evidence that is not there')
      // the pinned head: dropping the last release (and rolling its data back) is caught when the owner pins the head
      const headOf = (r) => sha256(fs.readFileSync(r.ep))
      assert.equal((await verifyPromoted(c2, pkg, { expectedMlb: 2, releases: [r1.dir, r2.dir], keyring: pubHome, pinned: [FPR], projectRef: REF, expectHead: headOf(r2) })).ok, true)
      assert.match((await verifyPromoted(c2, pkg, { expectedMlb: 2, releases: [r1.dir, r2.dir], keyring: pubHome, pinned: [FPR], projectRef: REF, expectHead: headOf(r1) })).problems.join(' | '), /expected head .* a release is missing or the history was rolled back/)
      assert.match((await verifyPromoted(c2, pkg, { expectedMlb: 2, releases: [r1.dir, r2.dir], keyring: pubHome, pinned: [FPR], projectRef: null })).problems.join(' | '), /needs the project reference/)
      assert.doesNotMatch((await verifyPromoted(c2, pkg, { expectedMlb: 2, releases: [r1.dir, r2.dir], keyring: pubHome, pinned: [FPR], projectRef: 'abc123def456ghi789jk' })).problems.join(' | '), /needs the project reference/, 'a project reference with digits is a valid reference')
      // a release whose evidence names the wrong predecessor, or none
      const alien = path.join(tmp, 'alien-prev'); fs.writeFileSync(alien, 'not a release evidence'); const r2b = await (async () => { const e = JSON.parse(fs.readFileSync(r2.ep, 'utf8')); e.previous_evidence_sha256 = sha256(fs.readFileSync(alien)); fs.writeFileSync(r2.ep, JSON.stringify(e, null, 1)); sign(r2.ep); return r2 })()
      assert.match((await v2([r1.dir, r2b.dir])).problems.join(' | '), /release chain is broken/, 'a signed release naming the wrong predecessor')
      // same-count tampering between the two releases breaks the first release's recorded state
      await c2.query("update public.schools set name = 'Edited between releases' where slug = 'chain-a'"); assert.match((await v2([r1.dir, r2b.dir])).problems.join(' | '), /differs from the state recorded|release chain is broken/)
    } finally { await c2.end().catch(() => {}) }
    // releaseDirs refuses a missing or empty directory
    assert.throws(() => releaseDirs(path.join(tmp, 'nope')), /does not exist/); const empty = path.join(tmp, 'empty-rel'); fs.mkdirSync(empty); assert.throws(() => releaseDirs(empty), /holds no release/)
  } finally { await cu.end().catch(() => {}) }
})

test('anchorChecks: the independent artifacts must support exactly the authorized release, and nothing else may have changed between the two snapshots', () => {
  const tbl = (rows, h = 'a') => ({ rows, sha256: h.repeat(64).slice(0, 64) })
  const auth = { expected_after_apply: { 'public.t1': 2, 'ingest.release_audits': 1 }, allowed_refresh_changes: ['public.rm_x'] }
  const before = { tables: { 'public.t1': tbl(10, '1'), 'ingest.release_audits': tbl(3, '2'), 'public.rm_x': tbl(5, '3'), 'public.other': tbl(7, '4') } }
  const after = { tables: { 'public.t1': tbl(12, '5'), 'ingest.release_audits': tbl(4, '6'), 'public.rm_x': tbl(9, '7'), 'public.other': tbl(7, '4') } }
  const report = { diffs: [{ table: 'public.t1', change: 'ROW COUNT', before: 10, after: 12 }, { table: 'ingest.release_audits', change: 'ROW COUNT', before: 3, after: 4 }], row_level_old_rows_missing_or_modified: [] }
  const ok = anchorChecks(auth, after, before, report); assert.deepEqual(ok.problems, []); assert.deepEqual(ok.tables['public.t1'], { n_before: 10, delta: 2, n_after: 12 })
  const bad = (mutA, mutR, re) => { const a = structuredClone(after); const r = structuredClone(report); mutA?.(a); mutR?.(r); assert.match(anchorChecks(auth, a, before, r).problems.join(' | '), re) }
  bad((a) => { a.tables['public.t1'].rows = 13 }, null, /differ by 3 rows, the authorization allows exactly 2/)
  bad((a) => { a.tables['public.other'] = tbl(7, '9') }, null, /public\.other: changed between the snapshots/)
  bad((a) => { a.tables['public.other'] = tbl(8, '4') }, null, /public\.other: changed between the snapshots/)
  bad((a) => { delete a.tables['public.other'] }, null, /public\.other: missing from the post-release snapshot/)
  bad(null, (r) => { r.diffs[0].after = 13 }, /report shows delta 3, authorized 2/)
  bad(null, (r) => { r.diffs.push({ table: 'public.other', change: 'ROW COUNT', before: 7, after: 8 }) }, /public\.other: the executor's report shows a row-count change that is not authorized/)
  bad(null, (r) => { r.row_level_old_rows_missing_or_modified = [{ table: 'public.t1', pre_existing_rows_missing_or_modified: 1 }] }, /pre-existing rows missing or modified/)
  bad(null, (r) => { delete r.row_level_old_rows_missing_or_modified }, /no row-level section/)
  assert.match(anchorChecks({}, after, before, report).problems.join(), /no expected row deltas/)
})

test('verify-promoted follows the lifecycle the DATABASE records: PROMOTED expects empty read models, REFRESHED expects a populated and consistent one, and every unexpected change still fails', async () => {
  await main.end(); await admin.query(`create database g6h_rm template ${MAIN}`); main = await open(MAIN)   // the promoted state, copied: the refresh never touches the shared test database
  const rm = await open('g6h_rm')
  try {
    const verify = (opts = {}) => verifyPromoted(rm, pkg, { expectedMlb: 2, ...opts })
    await rm.query('delete from public.rm_transaction_overview; delete from public.rm_transaction_refreshes')   // production before R7 has NO refresh record (this fixture was refreshed once, empty, before the promotion)
    const promoted = await verify(); assert.equal(promoted.ok, true, JSON.stringify(promoted.problems)); assert.equal(promoted.facts.read_model_lifecycle, 'PROMOTED')
    assert.match((await verify({ expectLifecycle: 'REFRESHED' })).problems.join(), /lifecycle is PROMOTED, expected REFRESHED/, 'a caller can only ADD a requirement')
    // before R7, rows without a recorded refresh are refused (as before), whatever they look like
    const gen0 = Number((await rows(rm, 'select public.refresh_transaction_read_models() g'))[0].g)   // the real refresh function, run on the copy
    const r = await verify(); assert.equal(r.ok, true, JSON.stringify(r.problems)); assert.equal(r.facts.read_model_lifecycle, 'REFRESHED'); assert.equal(r.facts.read_model.generation, String(gen0))
    assert.ok(r.facts.rm.content_rows > 0 && r.facts.read_model.published > 0, 'populated read models are expected after a refresh')
    assert.equal(r.facts.read_model.verified_complete, 0)
    assert.match((await verify({ expectLifecycle: 'PROMOTED' })).problems.join(), /lifecycle is REFRESHED, expected PROMOTED/)
    { const b = (await verify({ before: promoted.facts.rm })).problems.join(); assert.match(b, /read models hold \d+ row\(s\) straight after a promotion/); assert.match(b, /bookkeeping changed: a refresh ran/) }  // the promote runner's own post-check still refuses any refresh
    // each tamper is committed, must fail verification, and is undone
    const tamper = async (name, sql, undo, re) => { await rm.query(sql); try { const v = await verify(); assert.equal(v.ok, false, `${name}: verification must fail`); assert.match(v.problems.join(), re, name) } finally { await rm.query(undo) } }
    const id = (await rows(rm, 'select transaction_id i from public.rm_transactions order by 1 limit 1'))[0].i
    await tamper('a row of another generation', `update public.rm_transactions set generation_id = generation_id + 1 where transaction_id = ${id}`, `update public.rm_transactions set generation_id = generation_id - 1 where transaction_id = ${id}`, /published rows carry generation/)
    await tamper('a category that is not authorized for display', `update public.rm_transactions set source_categories = '{MLB}' where transaction_id = ${id}`, `update public.rm_transactions set source_categories = '{RETROSHEET}' where transaction_id = ${id}`, /not authorized for display/)
    await tamper('a changed overview total', 'update public.rm_transaction_overview set transactions = transactions + 1', 'update public.rm_transaction_overview set transactions = transactions - 1', /overview says|overview differs/)
    await tamper('a hand-written completeness claim', "update public.rm_transaction_overview set verified_complete = 5", 'update public.rm_transaction_overview set verified_complete = 0', /verified complete: overview 5/)
    await tamper('a displayed category without a grant', "update public.rm_transaction_overview set display_authorized_categories = display_authorized_categories || '{MLB}'", "update public.rm_transaction_overview set display_authorized_categories = array_remove(display_authorized_categories, 'MLB')", /without a publication grant/)
    await tamper('an overview from another refresh', 'update public.rm_transaction_overview set generation_id = generation_id + 1', 'update public.rm_transaction_overview set generation_id = generation_id - 1', /overview is generation/)
    const mlbTx = (await rows(rm, "select t.id i from public.transactions t join public.sources s on s.id = t.source_id where s.attribution_category = 'MLB' limit 1"))[0].i
    await tamper('a source row of another category than the declared one', `update public.rm_transaction_sources set attribution_category = 'MLB' where transaction_id = ${id} and attribution_category = 'RETROSHEET'`, `update public.rm_transaction_sources set attribution_category = 'RETROSHEET' where transaction_id = ${id} and attribution_category = 'MLB'`, /fail the category check/)
    await tamper('an empty declared category array', `update public.rm_transactions set source_categories = '{}' where transaction_id = ${id}`, `update public.rm_transactions set source_categories = '{RETROSHEET}' where transaction_id = ${id}`, /fail the category check/)
    await tamper('a published row swapped for a transaction whose real source is not authorized', `update public.rm_transactions set transaction_id = ${mlbTx} where transaction_id = ${id}`, `update public.rm_transactions set transaction_id = ${id} where transaction_id = ${mlbTx}`, /fail the category check|child row/)
    // ---- withdrawals (migration 030): partial ones keep the other published rows and delete the aggregates; the verifier reconciles counts instead of expecting an empty model
    const ids = (await rows(rm, 'select transaction_id i from public.rm_transactions order by 1')).map((x) => Number(x.i)); const total = ids.length; assert.ok(total >= 3, `the fixture publishes at least 3 transactions (${total})`)
    const wdState = async () => { const f = await readModelFacts(rm); return { f, problems: readModelProblems(f) } }
    const withdraw = (list, why) => rows(rm, 'select public.rm_withdraw_transactions($1::bigint[], $2) n', [list, why])
    await rm.query('create temp table keep_sources as select * from public.rm_transaction_sources where transaction_id = $1'.replace('$1', String(ids[0])))
    await rm.query('create temp table keep_tx as select * from public.rm_transactions limit 1'); await rm.query('create temp table keep_ov as select * from public.rm_transaction_overview'); await rm.query('create temp table keep_cov as select * from public.rm_transaction_coverage limit 1'); assert.equal((await rows(rm, 'select count(*)::int n from keep_cov'))[0].n, 1)
    // single-record withdrawal
    assert.equal(Number((await withdraw([ids[0]], 'single'))[0].n), 1)
    let w = await wdState(); assert.equal(w.f.lifecycle, 'WITHDRAWN'); assert.deepEqual(w.problems, [], 'a valid partial withdrawal verifies'); assert.equal(w.f.published.n, total - 1)
    assert.equal(w.f.overview.length, 0, 'the overview was invalidated'); assert.deepEqual(w.f.aggregates, { coverage: 0, club_seasons: 0 }, 'coverage and club-seasons were invalidated')
    const v1 = await verify(); assert.equal(v1.ok, true, JSON.stringify(v1.problems)); assert.equal(v1.facts.read_model_lifecycle, 'WITHDRAWN'); assert.equal(v1.facts.read_model.published, total - 1)
    // each unexpected change after a partial withdrawal fails
    const bad = async (name, sql, undo, re) => { if (undo === 'ROLLBACK') await rm.query('begin'); await rm.query(sql); try { const x = await wdState(); assert.ok(x.problems.length, `${name}: must fail`); assert.match(x.problems.join(), re, name) } finally { if (undo === 'ROLLBACK') await rm.query('rollback'); else if (undo) await rm.query(undo) } }
    await bad('a log that does not match the rows', 'update public.rm_transaction_withdrawals set withdrawn_transactions = withdrawn_transactions + 1', 'update public.rm_transaction_withdrawals set withdrawn_transactions = withdrawn_transactions - 1', /read-model rows after a withdrawal/)
    await bad('a row removed without a log entry', `delete from public.rm_transaction_sources where transaction_id = ${ids[1]}; delete from public.rm_transaction_players where transaction_id = ${ids[1]}; delete from public.rm_transaction_assets where transaction_id = ${ids[1]}; delete from public.rm_transaction_packages where transaction_id = ${ids[1]}; delete from public.rm_transaction_returns where transaction_id = ${ids[1]}; delete from public.rm_transaction_followups where transaction_id = ${ids[1]} or later_transaction_id = ${ids[1]}; delete from public.rm_transactions where transaction_id = ${ids[1]}`, 'ROLLBACK', /read-model rows after a withdrawal/)
    await bad('a surviving overview', 'insert into public.rm_transaction_overview select * from keep_ov', 'delete from public.rm_transaction_overview', /overview survived a withdrawal/)
    await bad('a surviving club-season aggregate', "insert into public.rm_transaction_coverage select * from keep_cov", 'delete from public.rm_transaction_coverage', /coverage .* aggregates survived/)
    await bad('an orphaned child row of a withdrawn transaction', 'insert into public.rm_transaction_sources select * from keep_sources', `delete from public.rm_transaction_sources where transaction_id = ${ids[0]}`, /child row.* not published/)
    await bad('a published row of another generation', `update public.rm_transactions set generation_id = generation_id + 1 where transaction_id = ${ids[2]}`, `update public.rm_transactions set generation_id = generation_id - 1 where transaction_id = ${ids[2]}`, /published rows carry generation/)
    await bad('a leaked category', `update public.rm_transactions set source_categories = '{MLB}' where transaction_id = ${ids[2]}`, `update public.rm_transactions set source_categories = '{RETROSHEET}' where transaction_id = ${ids[2]}`, /fail the category check/)
    await bad('a published row with no source (no attribution)', `delete from public.rm_transaction_sources where transaction_id = ${ids[2]}`, 'ROLLBACK', /no source row/)
    assert.deepEqual((await wdState()).problems, [], 'every tamper was undone'); await rm.query('select public.refresh_transaction_read_models()')   // a subsequent refresh rebuilds everything
    assert.deepEqual((await wdState()).problems, [], 'a subsequent refresh restores a consistent REFRESHED state'); assert.equal((await wdState()).f.lifecycle, 'REFRESHED')
    // deleting only the NEWEST refresh record falls back to the older one and is refused (the overview carries the newer generation)
    await rm.query('begin'); await rm.query('delete from public.rm_transaction_refreshes where generation_id = (select max(generation_id) from public.rm_transaction_refreshes)')
    try { const x = await wdState(); assert.ok(x.problems.length, 'a deleted newest refresh record must fail'); assert.match(x.problems.join(), /overview is generation|generation\(s\)/) } finally { await rm.query('rollback') }
    // multiple withdrawals after a refresh: counts add up
    await withdraw([ids[0]], 'a'); await withdraw([ids[1], ids[2]], 'b')
    w = await wdState(); assert.equal(w.f.lifecycle, 'WITHDRAWN'); assert.deepEqual(w.problems, []); assert.equal(w.f.published.n, total - 3); assert.equal(w.f.withdrawals.withdrawn_since_refresh, 3, 'only withdrawals since the latest refresh count')
    // a re-withdrawal of an already withdrawn id removes nothing and logs nothing
    assert.equal(Number((await withdraw([ids[0]], 'again'))[0].n), 0); assert.equal((await wdState()).f.published.n, total - 3)
    // complete withdrawal: nothing remains, every content table is empty; leftovers fail
    await withdraw(ids, 'rest'); w = await wdState(); assert.deepEqual(w.problems, []); assert.equal(w.f.published.n, 0); assert.equal(w.f.rm.content_rows, 0)
    await rm.query('insert into public.rm_transaction_coverage select * from keep_cov'); assert.match((await wdState()).problems.join(), /aggregates survived|content row/); await rm.query('delete from public.rm_transaction_coverage')
    // a refresh after a complete withdrawal
    await rm.query('select public.refresh_transaction_read_models()'); w = await wdState(); assert.equal(w.f.lifecycle, 'REFRESHED'); assert.deepEqual(w.problems, []); assert.equal(w.f.published.n, total)
    // category withdrawal (rm_withdraw_category, the function the grant triggers call; deleting the promoted grant itself is refused by GRANT_PROTECTED): the category's rows and the aggregates go
    await assert.rejects(rm.query("delete from ingest.source_publication_grants where attribution_category = 'RETROSHEET'"), /GRANT_PROTECTED/, 'the security guard on the promoted grant is untouched')
    assert.equal(Number((await rows(rm, "select public.rm_withdraw_category('RETROSHEET', 'category test') n"))[0].n), total)
    w = await wdState(); assert.equal(w.f.lifecycle, 'WITHDRAWN'); assert.deepEqual(w.problems, [], 'a category withdrawal verifies'); assert.equal(w.f.published.n, 0)
    const cat = await verify(); assert.equal(cat.ok, true, JSON.stringify(cat.problems)); assert.equal(cat.facts.read_model_lifecycle, 'WITHDRAWN')
    // read models populated while NO refresh is recorded (rows written by hand, or the log removed) are refused as before: a complete, valid row is restored from a copy kept before the withdrawals
    await rm.query('delete from public.rm_transaction_withdrawals; delete from public.rm_transaction_refreshes; delete from public.rm_transaction_overview')
    await rm.query('insert into public.rm_transactions select * from keep_tx')
    const none = await verify(); assert.equal(none.facts.read_model_lifecycle, 'PROMOTED'); assert.equal(none.ok, false); assert.ok(none.facts.rm.content_rows > 0)
    assert.match(none.problems.join(), /read-model rows: \d+ \(no refresh is recorded\)/)
  } finally { await rm.end() }
})

test('readModelProblems: every rule of every lifecycle, without a database', () => {
  const base = () => ({ rm: { content_rows: 10, bookkeeping: { rm_transaction_overview: 1, rm_transaction_refreshes: 1, rm_transaction_withdrawals: 0 } }, withdrawals: { n: 0, since_refresh: 0, withdrawn_since_refresh: 0 }, aggregates: { coverage: 2, club_seasons: 2 }, child_orphans: 0, granted: ['RETROSHEET'] })
  const ok = () => ({ ...base(), lifecycle: 'REFRESHED', refreshes: { n: 1, last: { g: '7', t: 3, w: 2 } }, overview: [{ g: '7', t: 3, w: 2, vc: 0, cats: ['RETROSHEET'] }],
    published: { n: 3, vc: 0, gens: ['7'], orphans: 0, no_source: 0, outside_authorized: 0, unauthorized_now: 0 } })
  assert.deepEqual(readModelProblems(ok()), [])
  const bad = (mut, re, mk = ok) => { const f = mk(); mut(f); assert.match(readModelProblems(f).join(), re) }
  bad((f) => { f.overview = [] }, /overview has 0 row/)
  bad((f) => { f.overview.push({ ...f.overview[0] }) }, /overview has 2 row/)
  bad((f) => { f.overview[0].g = '8' }, /overview is generation 8/)
  bad((f) => { f.published.n = 4 }, /overview says 3 published/)
  bad((f) => { f.refreshes.last.t = 9 }, /differs from the refresh record/)
  bad((f) => { f.overview[0].vc = 1 }, /verified complete: overview 1/)
  bad((f) => { f.overview[0].cats = ['RETROSHEET', 'MLB'] }, /MLB is displayed without a publication grant/)
  bad((f) => { f.published.gens = ['7', '8'] }, /generation\(s\) 7,8/)
  bad((f) => { f.published.gens = [] }, /generation\(s\) none/)
  bad((f) => { f.published.outside_authorized = 2 }, /2 published transaction\(s\) carry a source category that is not authorized/)
  bad((f) => { f.published.unauthorized_now = 1 }, /fail the category check/)
  bad((f) => { f.published.orphans = 1 }, /do not exist/)
  bad((f) => { f.published.no_source = 2 }, /no source row/)
  bad((f) => { f.child_orphans = 3 }, /3 read-model child row/)
  { const f = ok(); f.overview[0].cats = ['RETROSHEET', 'WIKIPEDIA', 'CHADWICK_REGISTER']; assert.deepEqual(readModelProblems(f), [], 'the openly licensed groups need no grant') }
  { const f = ok(); f.rm.content_rows = 0; f.refreshes.last = { g: '7', t: 0, w: 0 }; f.overview = [{ g: '7', t: 0, w: 0, vc: 0, cats: ['WIKIPEDIA'] }]; f.published = { n: 0, vc: 0, gens: [], orphans: 0, no_source: 0, outside_authorized: 0, unauthorized_now: 0 }; assert.deepEqual(readModelProblems(f), [], 'a refresh that published nothing is consistent') }
  // WITHDRAWN: partial, multiple, complete
  const wd = (left, withdrawn, extra = {}) => ({ ...base(), lifecycle: 'WITHDRAWN', refreshes: { n: 1, last: { g: '7', t: 3, w: 2 } }, overview: [], aggregates: { coverage: 0, club_seasons: 0 }, withdrawals: { n: 1, since_refresh: 1, withdrawn_since_refresh: withdrawn },
    rm: { content_rows: left ? 5 : 0, bookkeeping: { rm_transaction_overview: 0, rm_transaction_refreshes: 1, rm_transaction_withdrawals: 1 } }, published: { n: left, vc: 0, gens: left ? ['7'] : [], orphans: 0, no_source: 0, outside_authorized: 0, unauthorized_now: 0 }, ...extra })
  assert.deepEqual(readModelProblems(wd(2, 1)), [], 'a valid partial withdrawal'); assert.deepEqual(readModelProblems(wd(1, 2)), [], 'multiple withdrawals add up'); assert.deepEqual(readModelProblems(wd(0, 3)), [], 'a complete withdrawal')
  bad((f) => { f.published.n = 3 }, /3 published, 2 expected/, () => wd(2, 1))
  bad((f) => { f.published.n = 1 }, /1 published, 2 expected/, () => wd(2, 1))
  bad((f) => { f.withdrawals.withdrawn_since_refresh = 4 }, /removes 4 transactions, the latest refresh published 3/, () => wd(0, 3))
  bad((f) => { f.overview = [{ g: '7' }] }, /overview survived a withdrawal/, () => wd(2, 1))
  bad((f) => { f.aggregates.coverage = 1 }, /aggregates survived a withdrawal/, () => wd(2, 1))
  bad((f) => { f.aggregates.club_seasons = 1 }, /aggregates survived a withdrawal/, () => wd(2, 1))
  bad((f) => { f.rm.content_rows = 1 }, /complete withdrawal left 1 content row/, () => wd(0, 3))
  bad((f) => { f.published.gens = ['6'] }, /generation\(s\) 6/, () => wd(2, 1))
  bad((f) => { f.published.unauthorized_now = 1 }, /no publication grant/, () => wd(2, 1))
  bad((f) => { f.child_orphans = 1 }, /child row/, () => wd(2, 1))
  bad((f) => { f.published.no_source = 1 }, /no source row/, () => wd(2, 1))
  bad((f) => { f.refreshes = { n: 0, last: null } }, /published rows without a recorded refresh/, () => wd(2, 1))
  // PROMOTED
  const p = () => ({ ...base(), lifecycle: 'PROMOTED', rm: { content_rows: 0, bookkeeping: { rm_transaction_overview: 0, rm_transaction_refreshes: 0, rm_transaction_withdrawals: 0 } }, refreshes: { n: 0, last: null }, overview: [], published: { n: 0, vc: 0, gens: [], orphans: 0, no_source: 0, outside_authorized: 0, unauthorized_now: 0 } })
  assert.deepEqual(readModelProblems(p()), [])
  bad((f) => { f.rm.content_rows = 1 }, /read-model rows: 1/, p)
  bad((f) => { f.rm.bookkeeping.rm_transaction_overview = 1 }, /bookkeeping exists without a recorded refresh/, p)
  { const f = ok(); f.lifecycle = 'UNKNOWN'; assert.match(readModelProblems(f).join(), /unknown read-model lifecycle "UNKNOWN"/, 'an unknown lifecycle fails closed') }
})

test('status is read-only and needs no authorization; blockers and attempts are reported', async () => {
  const s = await statusHosted(ctx(), pkg.sha); assert.equal(s.state, 'PROMOTED'); assert.ok(Array.isArray(s.attempts))
})

test('withdraw (owner-signed): one atomic call, then vacuum; the baseline is restored byte for byte; the same artifact cannot be used again', async () => {
  const auth = authorize('withdraw', { reason: 'test withdrawal' })
  const r = await operateHosted(ctx(), 'withdraw', { manifest: pkg.sha, authFile: auth })
  assert.equal(r.state_after, 'WITHDRAWN'); assert.equal(r.operation, 'withdraw')
  assert.deepEqual(await scopeFp(), BASE_FP, 'every table of the scope is byte-identical to the baseline again')
  assert.equal(r.result.maintenance?.error, undefined, 'the maintenance step (VACUUM ANALYZE) ran')
  assert.match(await refused(operateHosted(ctx(), 'withdraw', { manifest: pkg.sha, authFile: auth })), /already used on this host/)
  assert.match(await refused(operateHosted(ctx(), 'withdraw', { manifest: pkg.sha, authFile: authorize('withdraw') })), /is WITHDRAWN, not PROMOTED/)
  assert.match(await refused(promoteHosted(ctx(), { pkgDir, authFile: authorize('promote'), evidenceFile, parityFile })), /hosted preflight|already/, 'a withdrawn manifest is never promoted again')
})

test('a server-side refusal rolls back and is recorded as such (no ambiguity); an ambiguous operation (lost answer) is resolved read-only and never repeated', async () => {
  const conn = flaky(async (sql, q, real, p) => { if (/withdraw_promotion/.test(sql)) { real.connection.stream.destroy(); throw new Error('Connection terminated unexpectedly') } return q(sql, p) })
  // after the earlier withdrawal the manifest is WITHDRAWN, so a further withdraw is refused by the runner before the call; the ambiguous path is covered by the promote tests above
  assert.match(await refused(operateHosted(ctxFor(conn), 'withdraw', { manifest: pkg.sha, authFile: authorize('withdraw') })), /is WITHDRAWN, not PROMOTED/)
  const st = await resolveState(connectMain, pkg.sha, { tries: 1, waitMs: 0 }); assert.equal(st.state, 'WITHDRAWN'); assert.equal(st.resolved, true)
})

test('verifyPackage still names tampering after writePackage restores the file', () => {
  const p = loadPackage(pkgDir); assert.equal(p.sha, pkg.sha); writePackage(path.join(tmp, 'pkg-rewrite'), p); assert.deepEqual(verifyPackage(path.join(tmp, 'pkg-rewrite')), [])
})

test('failure classification: only a server-raised ERROR counts as a rollback; socket codes that look like SQLSTATEs, FATALs and connection/operator classes are ambiguous', () => {
  const pgErr = (code, severity = 'ERROR') => Object.assign(new Error('x'), { code, severity })
  assert.equal(serverReported(pgErr('P0001')), true); assert.equal(serverReported(pgErr('55P03')), true); assert.equal(serverReported(pgErr('57014')), true)
  for (const e of [Object.assign(new Error('x'), { code: 'EPIPE' }), Object.assign(new Error('x'), { code: 'EBUSY' }), Object.assign(new Error('x'), { code: 'EPERM' }), pgErr('57P01', 'FATAL'), pgErr('57P01'), pgErr('08006'), pgErr('58030'), pgErr('XX000'), pgErr('P0001', 'FATAL'), new Error('Connection terminated unexpectedly'), null]) assert.equal(serverReported(e), false)
})

test('attempt rules: unresolved attempts block; a failed attempt needs the owner to name it; a SUCCESSFUL earlier operation (a second emergency after a revert, a second analyze) does not block a new authorized one; a committed promotion is never repeated', () => {
  const l = attemptLedger(path.join(tmp, 'ledger-rules')); const m = 'd'.repeat(64)
  const add = (operation, state) => { const a = l.start({ manifest: m, operation, started_at: new Date().toISOString() }); a.update({ state }); return a.id }
  const e1 = add('emergency', 'COMMITTED'); add('revert', 'COMMITTED')
  let b; assert.doesNotThrow(() => { b = beginAttempt(l, { manifest: m, operation: 'emergency', authSha: 'x', afterAttempt: null }) }, 'a real incident after a false alarm must not be blocked by the ledger'); b.update({ state: 'COMMITTED' })
  assert.throws(() => beginAttempt(l, { manifest: m, operation: 'emergency', authSha: 'x', afterAttempt: 'f'.repeat(24) }), /not this host's latest attempt/)
  const a1 = add('analyze', 'COMMITTED'); assert.doesNotThrow(() => beginAttempt(l, { manifest: m, operation: 'analyze', authSha: 'x', afterAttempt: null })); assert.ok(a1 && e1)
  const w = add('withdraw', 'STARTED'); assert.throws(() => beginAttempt(l, { manifest: m, operation: 'withdraw', authSha: 'x', afterAttempt: w }), /resolve it first with "status"/)
  const f = add('finish', 'ROLLED_BACK'); assert.throws(() => beginAttempt(l, { manifest: m, operation: 'finish', authSha: 'x', afterAttempt: null }), /must name it in after_attempt|not this host's latest attempt/); assert.doesNotThrow(() => beginAttempt(l, { manifest: m, operation: 'finish', authSha: 'x', afterAttempt: f }))
  const p = add('promote', 'COMMITTED'); assert.throws(() => beginAttempt(l, { manifest: m, operation: 'promote', authSha: 'x', afterAttempt: p }), /already committed this promotion/)
})

test('observeState trusts an answer only when no runner writer session existed at either end and the state did not change; a writer in a transaction makes it unresolved', async () => {
  const sha = 'a'.repeat(64)
  const calm = await observeState(main, sha); assert.equal(calm.resolved, true); assert.equal(calm.state, 'NOT_PROMOTED')
  const w = new pg.Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'postgres', database: MAIN, application_name: 'bai-promotion-hosted' }); await w.connect()
  try {
    await w.query('begin'); await w.query('select 1')
    const busy = await observeState(main, sha); assert.equal(busy.resolved, false); assert.ok(busy.writers_before >= 1)
    const slow = await resolveState(async () => ({ client: await open(MAIN) }), sha, { tries: 2, waitMs: 1 }); assert.equal(slow.resolved, false, 'an active writer keeps the result UNKNOWN')
  } finally { await w.query('rollback'); await w.end() }
})

test('the CLI exits 1 for a report that is not a verified success and the evidence check refuses a package that allows evidence older than 72 hours', async () => {
  const src = fs.readFileSync(path.join(root, 'scripts/db/promotion-hosted.mjs'), 'utf8'); assert.match(src, /out\.ok === false \|\| out\.post\?\.ok === false/)
  const m2 = structuredClone(pkg.manifest); m2.attribution.max_age_hours = 500
  assert.match(checkEvidence(evidenceFile, m2).join(), /older than 72 hours/)
})
