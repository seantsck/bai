// A manifest-bound research release for ONE draft year. This script prepares, verifies, previews and (only when told to,
// on a database that has migration 027) applies the release described by an immutable manifest.
//
//   node scripts/history/release.mjs build   --year 2020 --release-dir .local/history/2020/release/<name> [--brown held|name-only]
//   node scripts/history/release.mjs verify  --release-dir <dir>                       (files, scope, source permissions; no database)
//   node --env-file=... scripts/history/release.mjs preview --release-dir <dir>        (read-only collision report on BAI_DATABASE_URL)
//   node --env-file=... scripts/history/release.mjs apply   --release-dir <dir> --manifest-sha256 <hex> --operator <name> [--confirm-hosted <ref>]
//
// apply: every batch goes through the research pipeline (stage, validate, dry run, write) inside ONE transaction that commits
// only if the collision report is all SAFE, no record is held, and the in-transaction counts equal the manifest. A hosted
// target needs --confirm-hosted <project ref>, a checksum that names this exact manifest, and migrations 001-027.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadCatalog } from './lib/permissions.mjs'
import { buildManifest, loadRelease, verifyReleaseContent, collisionReport, applyRelease, fileSha256, canonicalJson } from './lib/release.mjs'
import { ownerDatabaseUrl, isLocalUrl, requireHostedWriteConfirmation, supabaseProjectRef } from '../db/lib/connection.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const command = argv[0]
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const releaseDir = opt('release-dir') ? path.resolve(root, opt('release-dir')) : null
const log = (m) => console.log(m)
const EXIT = { problems: 4, review: 3 }

function need (cond, msg) { if (!cond) { console.error(msg); process.exit(1) } }

async function withDb (fn) {
  const url = ownerDatabaseUrl()
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try { return await fn(db, url) } finally { await db.end() }
}

const COMMANDS = {
  async build () {
    const year = Number(opt('year'))
    need(year && releaseDir, 'usage: build --year YYYY --release-dir <dir> [--brown held|name-only]')
    const brown = opt('brown', 'held')
    const manifestFile = path.join(releaseDir, 'release-manifest.json')
    const existing = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : null
    // Picks the collision report left for a human are held out of the build, unless the manifest records a human approval.
    const approvals = opt('approvals') ? JSON.parse(fs.readFileSync(path.resolve(root, opt('approvals')), 'utf8')) : []
    const holdsFile = `${releaseDir}.holds.json`
    const holds = {}
    if (opt('collision-report')) {
      const rep = JSON.parse(fs.readFileSync(path.resolve(root, opt('collision-report')), 'utf8'))
      for (const e of rep.entries) {
        const open = e.checks.filter((c) => c.level !== 'SAFE' && !approvals.some((a) => a.pick === e.pick && a.code === c.code))
        if (open.length) holds[e.pick] = `${e.classification === 'BLOCKED' ? 'blocked' : 'needs a human decision'} on the target: ${open.map((c) => c.code).join(', ')}`
      }
    }
    fs.writeFileSync(holdsFile, JSON.stringify(holds))
    const stage = `${releaseDir}.building`
    fs.rmSync(stage, { recursive: true, force: true })
    execFileSync(process.execPath, [path.join(root, 'scripts/history/wikipedia-draft.mjs'), 'build', '--year', String(year), '--release-dir', stage, '--brown', brown, '--holds-file', holdsFile], { cwd: root, stdio: 'inherit' })
    fs.rmSync(holdsFile, { force: true })
    const catalog = loadCatalog(root)
    const yearDir = path.resolve(root, process.env.BAI_HISTORY_OUT || '.local/history', String(year))
    const identityFile = path.join(yearDir, 'identity.json')
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'))
    const built = JSON.parse(fs.readFileSync(path.join(stage, 'build.json'), 'utf8'))
    const batches = fs.readdirSync(path.join(stage, 'batches')).filter((f) => f.endsWith('.json')).sort().map((file) => ({ file, sha256: fileSha256(path.join(stage, 'batches', file)), doc: JSON.parse(fs.readFileSync(path.join(stage, 'batches', file), 'utf8')) }))
    const history = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
    const art = history.entries[`wikipedia/${year}-major-league-baseball-draft.json`]
    need(art, 'the Wikipedia article is not in the manifest cache')
    const total = batches.reduce((n, b) => n + b.doc.records.length, 0)
    const manifest = buildManifest({
      releaseKey: `wikipedia-${year}-june-amateur-r${identity.revision}-${brown === 'held' ? 'brown-held' : 'brown-name-only'}-n${total}`, year, draftKey: `${year}-JUNE_AMATEUR`, batches, identity,
      article: { revision: identity.revision, response_sha256: art.sha256 }, chadwickCommit: identity.chadwick_commit, identityFileSha256: fileSha256(identityFile), brownVariant: brown === 'held' ? 'HELD' : 'IMPORTED_NAME_ONLY_UNRESOLVED',
      heldPicks: built.held, humanApprovals: approvals, catalog, maxSelections: total, createdOn: art.retrieved_at.slice(0, 10)
    })
    const text = JSON.stringify(manifest, null, 1) + '\n'
    if (existing !== null && existing !== text) {
      fs.rmSync(stage, { recursive: true, force: true })
      throw new Error(`${manifestFile} already exists with different content: a release manifest is immutable; build into a new --release-dir`)
    }
    if (existing === null) {
      fs.mkdirSync(releaseDir, { recursive: true })
      fs.rmSync(path.join(releaseDir, 'batches'), { recursive: true, force: true })
      fs.renameSync(path.join(stage, 'batches'), path.join(releaseDir, 'batches'))
      fs.copyFileSync(path.join(stage, 'build.json'), path.join(releaseDir, 'build.json'))
      fs.writeFileSync(manifestFile, text)
      fs.writeFileSync(path.join(releaseDir, 'release-manifest.sha256'), `${manifest.manifest_sha256}  release-manifest.json\n`)
    }
    fs.rmSync(stage, { recursive: true, force: true })
    log(`${manifest.release_key}: ${manifest.totals.selections} selections in ${manifest.batches.length} batches, held ${manifest.totals.held.length}; identity ${canonicalJson(manifest.totals.identity_tiers)}`)
    log(`manifest sha256 ${manifest.manifest_sha256}`)
  },

  async verify () {
    need(releaseDir, 'usage: verify --release-dir <dir>')
    const rel = loadRelease(releaseDir)
    const problems = verifyReleaseContent(rel, { root })
    for (const p of problems) log(`PROBLEM: ${p}`)
    log(`${rel.manifest.release_key}: ${rel.batches.length} batches, ${rel.manifest.totals.selections} selections, manifest ${rel.manifest.manifest_sha256}: ${problems.length ? `${problems.length} problem(s)` : 'files, scope and source permissions verified'}`)
    process.exit(problems.length ? EXIT.problems : 0)
  },

  async preview () {
    need(releaseDir, 'usage: preview --release-dir <dir>')
    const rel = loadRelease(releaseDir)
    const problems = verifyReleaseContent(rel, { root })
    const report = await withDb(async (db, url) => ({ ...(await collisionReport(db, rel)), target_label: isLocalUrl(url) ? 'local' : `hosted ${supabaseProjectRef(url)}` }))
    report.content_problems = problems
    const out = path.join(releaseDir, `collision-report-${report.target_label.replace(/\s+/g, '-')}.json`)
    fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n')
    log(`preview on ${report.target_label}: ${canonicalJson(report.summary)} overall ${report.overall}; content problems ${problems.length}; target migrations ${canonicalJson(report.target.migrations)}; draft ${report.target.draft}; existing 2020 selections ${report.target.existing_selections_in_draft}  -> ${out}`)
    process.exit(report.overall === 'BLOCKED' || problems.length ? EXIT.problems : report.overall === 'HUMAN_REVIEW' ? EXIT.review : 0)
  },

  async apply () {
    need(releaseDir, 'usage: apply --release-dir <dir> --manifest-sha256 <hex> --operator <name> [--confirm-hosted <ref>]')
    const rel = loadRelease(releaseDir)
    const m = rel.manifest
    need(opt('manifest-sha256') === m.manifest_sha256, `--manifest-sha256 must name this exact manifest (${m.manifest_sha256})`)
    const operator = opt('operator')
    need(operator && !/^agent:/i.test(operator), '--operator must name the person who approved this release (not agent:*)')
    const problems = verifyReleaseContent(rel, { root })
    need(!problems.length, `content problems:\n${problems.join('\n')}`)
    const url = ownerDatabaseUrl()
    const target = requireHostedWriteConfirmation(url)
    const db = new pg.Client({ connectionString: url })
    await db.connect()
    const audit = { release_key: m.release_key, manifest_sha256: m.manifest_sha256, operator, target: target.hosted ? `hosted ${target.ref}` : 'local', started_at: new Date().toISOString(), batches: [] }
    try {
      const out = await applyRelease(db, rel, { operator })
      if (out.already) { log(`already applied (release audit ${out.audit_id}); nothing to do`); audit.status = 'ALREADY_APPLIED'; return }
      audit.status = 'COMMITTED'; audit.counts = out.counts; audit.entries = out.entries; audit.batches = out.batches; audit.collision_overall = out.collision_overall
      log(`committed ${canonicalJson(out.counts)}`)
      log('next: npm run refresh:read-models (hosted: npm run hosted:refresh), then the verification plan in the manifest')
    } catch (err) {
      audit.status = 'ROLLED_BACK'; audit.error = err.message
      console.error(`ROLLED BACK: ${err.message}`)
      process.exitCode = 1
    } finally {
      audit.finished_at = new Date().toISOString()
      fs.writeFileSync(path.join(releaseDir, `audit-${audit.target.replace(/\s+/g, '-')}-${audit.started_at.replace(/[:.]/g, '')}.json`), JSON.stringify(audit, null, 1) + '\n')
      await db.end()
    }
  }
}

if (!COMMANDS[command]) { console.error(`usage: release.mjs ${Object.keys(COMMANDS).join('|')}`); process.exit(2) }
try { await COMMANDS[command]() } catch (err) { console.error(err.message); process.exit(1) }
