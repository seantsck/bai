// Phase C of G1 release protocol v2 (docs/transactions/g1-protocol-v2-proposal.md): the FINAL READ-ONLY comparison, run immediately before the push.
//   node --env-file=<env file> scripts/db/final-parity.mjs --backup-dir <~/bai-backups/g1-…> --gate <gate.json> --record <new file>
//        (--offsite-sha256 <hex> --offsite-tree <hex> | --offsite-record <backup-run record> --offsite-recipient <owner key fingerprint>) --authorization-ref "<owner message, date/time>"
//   The second form takes the two hashes from an automated off-site verification record (scripts/db/backup-run.mjs) AFTER re-deriving it from the files, and requires
//   its wrapped key to be addressed to the owner key named; the owner's authorization reference is required either way.
// 1. the backup is sound (snapshot and export checksums), at most SIX hours old, its content hash equals the off-site verified one, and the encrypted archive
//    beside it and the copy that came back from the owner's round trip match the reported hashes (decryption itself is the owner's attested Check);
// 2. the strict hosted preflight passes (migration level, 028 checksum, every table byte-identical to the backup's snapshot);
// 3. a FRESH logical export (scripts/db/logical-export.sh, read-only) into a NEW directory equals the backup's export (roles, schema, data, migration history)
//    once pg_dump's random \restrict lines are ignored;
// then it writes a short-lived hashed record that `db push` re-verifies. Any failure stops at once, exits 1 and writes no record. It never writes to the database.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ownerDatabaseUrl, isLocalUrl } from './lib/connection.mjs'
import { validateGateShape } from './lib/gate.mjs'
import os from 'node:os'
import { verifyRecordForRelease } from './lib/offsite-auto.mjs'
import { MAX_BACKUP_AGE_MS, backupStartedAt, buildRecord, compareExports, contentTreeHash, verifyBackupDir, verifyOffsiteEvidence } from './lib/final-parity.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null }
const fail = (m) => { console.error(`FINAL PARITY FAILED: ${m}\nNothing was written; do not push.`); process.exit(1) }
const usage = 'usage: final-parity.mjs --backup-dir <dir> --gate <gate.json> --record <new file> (--offsite-sha256 <hex> --offsite-tree <hex> | --offsite-record <file> --offsite-recipient <40 hex> [--offsite-gnupg-home <dir>]) --authorization-ref <text> [--export-dir <new dir>]'
const backupDir = opt('backup-dir'); const gateFile = opt('gate'); const recordFile = opt('record')
let encrypted = opt('offsite-sha256'); let tree = opt('offsite-tree'); const authRef = opt('authorization-ref')
const offsiteRecord = opt('offsite-record'); let offsiteRecordSha = null
if (offsiteRecord && (encrypted || tree)) { console.error('give EITHER --offsite-record OR --offsite-sha256/--offsite-tree, not both'); process.exit(2) }
if (offsiteRecord) {
  if (!backupDir || !opt('offsite-recipient')) { console.error(usage); process.exit(2) }
  const v = verifyRecordForRelease(offsiteRecord, { backupDir, fingerprint: opt('offsite-recipient'), gnupgHome: opt('offsite-gnupg-home') ?? path.join(os.homedir(), '.config/bai-backup/gnupg') })
  if (v.problems.length) fail(`off-site verification record: ${v.problems.join('; ')}`)
  encrypted = v.encrypted; tree = v.tree; offsiteRecordSha = v.recordSha256
}
if (!backupDir || !gateFile || !recordFile || !encrypted || !tree || !authRef) { console.error(usage); process.exit(2) }
if (!/^[0-9a-f]{64}$/.test(encrypted) || !/^[0-9a-f]{64}$/.test(tree)) fail('--offsite-sha256 and --offsite-tree must be 64 hex characters')
const absBackup = path.resolve(backupDir)
if (fs.existsSync(recordFile)) fail(`${recordFile} exists; a record is never overwritten`)
if (path.resolve(recordFile).startsWith(absBackup + path.sep)) fail('the record must be written outside the backup directory (the backup content must not change)')
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
const exportDir = path.resolve(opt('export-dir') ?? `${absBackup}.final-${stamp}`)
if (exportDir === absBackup || exportDir.startsWith(absBackup + path.sep)) fail('the fresh export must be OUTSIDE the backup directory')
if (fs.existsSync(exportDir) && fs.readdirSync(exportDir).length) fail(`${exportDir} is not empty`)
let gate; try { gate = JSON.parse(fs.readFileSync(gateFile, 'utf8')) } catch (e) { fail(`gate file unreadable: ${e.message}`) }
const gp = validateGateShape(gate); if (gp.length) fail(`gate file: ${gp.join('; ')}`)

// a different export script (tests only) is allowed against a LOCAL database; this is checked before anything can reach a database
const script = opt('export-script')
let url; try { url = ownerDatabaseUrl() } catch (e) { fail(e.message) }
if (script && !isLocalUrl(url)) fail('--export-script is only allowed against a local database')

// 1. the backup itself
const bp = verifyBackupDir(absBackup); if (bp.length) fail(`backup directory: ${bp.join('; ')}`)
const started = backupStartedAt(absBackup); if (started == null) fail('cannot determine when the backup started')
const ageH = (Date.now() - started) / 3600000
if (Date.now() - started > MAX_BACKUP_AGE_MS) fail(`the backup is ${ageH.toFixed(1)} hours old; the maximum is 6`)
const manifest = JSON.parse(fs.readFileSync(path.join(absBackup, 'snapshot/manifest.json'), 'utf8'))
if (manifest.migrations?.v !== gate.from_level) fail(`the backup is at migration ${manifest.migrations?.v}; the gate starts from ${gate.from_level}`)
if (contentTreeHash(absBackup) !== tree) fail('--offsite-tree is not the content hash of this backup directory (the off-site verified copy is not this backup, or the directory changed)')
const oe = verifyOffsiteEvidence(absBackup, encrypted, tree); if (oe.length) fail(`off-site evidence: ${oe.join('; ')}`)
console.log(`backup ok: ${path.basename(absBackup)}, ${ageH.toFixed(2)} h old (limit 6), content hash equals the off-site verified one`)

// 2. strict hosted preflight (read-only)
const pre = spawnSync(process.execPath, [path.join(here, 'hosted-preflight.mjs'), '--snapshot-dir', path.join(absBackup, 'snapshot'), '--expect-level', gate.from_level, '--expect-checksum', `${gate.through}:${gate.checksums[gate.through]}`], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 26 })
if (pre.status !== 0 || !/PREFLIGHT OK/.test(pre.stdout)) fail(`the strict preflight did not pass:\n${(pre.stdout || '').split('\n').filter((l) => /^FAIL|PREFLIGHT/.test(l)).join('\n')}${pre.stderr ? '\n' + pre.stderr.slice(-400) : ''}`)
console.log('preflight ok: migration level, migration checksum and every table byte-identical to the backup snapshot')

// 3. fresh logical export, compared with the backup's
const exp = spawnSync('bash', [script ?? path.join(here, 'logical-export.sh'), exportDir], { encoding: 'utf8', env: process.env, maxBuffer: 1 << 26 })
if (exp.status !== 0) fail(`the fresh logical export failed (exit ${exp.status}): ${(exp.stderr || '').slice(-300)}`)
const cmp = compareExports(path.join(absBackup, 'export'), exportDir)
if (!cmp.ok) fail(`the fresh export differs from the backup's:\n  ${cmp.problems.join('\n  ')}\n  inspect with: diff <(grep -v '^.\\(un\\)\\?restrict' ${absBackup}/export/FILE) <(grep -v '^.\\(un\\)\\?restrict' ${exportDir}/FILE)`)
console.log(`export ok: ${Object.keys(cmp.hashes).join(', ')} identical to the backup's (fresh export kept in ${exportDir})`)

// 4. the record
const rec = buildRecord({ backupDir: absBackup, gate, offsite: { encrypted, tree, authorizationRef: authRef, recordSha256: offsiteRecordSha }, exportHashes: cmp.hashes })
fs.writeFileSync(recordFile, JSON.stringify(rec, null, 1) + '\n', { flag: 'wx', mode: 0o600 })
console.log(`FINAL PARITY OK. Record ${recordFile} valid until ${rec.expires_at} (10 minutes). Push now: BAI_GATE_FILE=${gateFile} BAI_PARITY_RECORD=${recordFile} npm run hosted:supabase -- db push`)
