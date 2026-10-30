// Off-hosted staging, atomic promotion and withdrawal of reviewed data (migration 032). LOCAL ONLY in this build: every command refuses a hosted database.
//   node scripts/db/promotion.mjs package  --base-db <name> --stage-db <name> --config <file.json> --out <dir>     build the release package (the staged database must have no open session)
//   node scripts/db/promotion.mjs verify   --package <dir>                                                        offline hash and count check of a package
//   node scripts/db/promotion.mjs promote  --package <dir> [--database <name>]                                   one transaction; recovers from a lost connection by asking the ledger
//   node scripts/db/promotion.mjs status   --manifest <sha256> [--database <name>]
//   node scripts/db/promotion.mjs withdraw --manifest <sha256> --reason <text> [--with-grant] [--database <name>]   atomic; refuses while unrelated rows depend on the promoted data
//   node scripts/db/promotion.mjs emergency --manifest <sha256> --reason <text> [--close-api] [--database <name>]   stops public exposure now, deletes nothing
//   node scripts/db/promotion.mjs finish   --manifest <sha256> --reason <text> [--database <name>]                  completes an emergency withdrawal once the blockers are gone
//   node scripts/db/promotion.mjs revert   --manifest <sha256> --reason <text> [--database <name>]                  lifts an emergency (a false alarm); republishes nothing
// A hosted release is NOT AUTHORIZED by this build: see docs/transactions/g5-promotion.md.
import fs from 'node:fs'
import pg from 'pg'
import { ownerDatabaseUrl } from './lib/connection.mjs'
import { assertLocalTarget, buildPackage, dependents, emergencyWithdraw, finishWithdrawal, loadPackage, openSession, promote, revertEmergency, statusOf, verifyPackage, withdraw } from './lib/promotion.mjs'

const [cmd, ...argv] = process.argv.slice(2)
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes(`--${k}`)
const die = (m, code = 1) => { console.error(m); process.exit(code) }
if (!cmd || !['package', 'verify', 'promote', 'status', 'withdraw', 'emergency', 'finish', 'revert'].includes(cmd)) die(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'), 2)
if (flag('hosted') || flag('confirm-hosted')) die('refusing: hosted promotion is NOT AUTHORIZED by this build (local implementation, G5-4).', 2)

if (cmd === 'verify') {
  const problems = verifyPackage(opt('package') ?? die('usage: verify --package <dir>', 2))
  if (problems.length) die(`PACKAGE NOT VERIFIED\n  ${problems.join('\n  ')}`)
  const p = loadPackage(opt('package')); console.log(`VERIFIED  manifest ${p.sha}  tables ${p.manifest.load_order.length}  rows ${Object.values(p.manifest.delta).reduce((a, d) => a + d.n, 0)}  withheld ${(p.manifest.exclusions ?? []).reduce((a, e) => a + e.n, 0)}`)
  process.exit(0)
}

let baseUrl
try { baseUrl = ownerDatabaseUrl(); assertLocalTarget(baseUrl) } catch (e) { die(e.message, 2) }
const connectTo = async (name) => { const u = new URL(baseUrl); u.pathname = `/${name}`; const c = new pg.Client({ connectionString: u.toString() }); c.on('error', () => {}); await c.connect(); return c }
const target = opt('database') ?? decodeURIComponent(new URL(baseUrl).pathname.slice(1))
const need = (k) => opt(k) ?? die(`missing --${k}`, 2)

if (cmd === 'package') {
  const admin = await connectTo('postgres')
  try {
    const pkg = await buildPackage({ connect: connectTo, admin, baseName: need('base-db'), stageName: need('stage-db'), config: JSON.parse(fs.readFileSync(need('config'), 'utf8')), outDir: need('out') })
    console.log(`PACKAGE  manifest ${pkg.sha}\n  tables ${pkg.manifest.load_order.length}, rows ${Object.values(pkg.manifest.delta).reduce((a, d) => a + d.n, 0)}, withheld ${(pkg.manifest.exclusions ?? []).reduce((a, e) => a + e.n, 0)}\n  written to ${opt('out')}`)
  } finally { await admin.end() }
} else if (cmd === 'promote') {
  const problems = verifyPackage(need('package')); if (problems.length) die(`PACKAGE NOT VERIFIED\n  ${problems.join('\n  ')}`)
  const pkg = loadPackage(need('package'))
  try { const r = await promote({ connect: connectTo, name: target, pkg }); console.log(`${r.result}\n  ${r.log.join('\n  ')}`) } catch (e) { die(`NOT PROMOTED: ${e.message}${e.log ? '\n  ' + e.log.join('\n  ') : ''}`) }
} else {
  const c = await openSession(await connectTo(target))
  try {
    const sha = cmd === 'status' || cmd === 'withdraw' || cmd === 'emergency' || cmd === 'finish' || cmd === 'revert' ? need('manifest') : null
    if (cmd === 'status') console.log(JSON.stringify({ ...(await statusOf(c, sha)), blockers: await dependents(c, sha).catch(() => null) }, null, 1))
    else if (cmd === 'withdraw') console.log(JSON.stringify(await withdraw(c, sha, need('reason'), { withdrawGrant: flag('with-grant') }), null, 1))
    else if (cmd === 'emergency') console.log(JSON.stringify(await emergencyWithdraw(c, sha, need('reason'), { closeApi: flag('close-api') }), null, 1))
    else if (cmd === 'finish') console.log(JSON.stringify(await finishWithdrawal(c, sha, need('reason')), null, 1))
    else console.log(JSON.stringify(await revertEmergency(c, sha, need('reason')), null, 1))
  } catch (e) { die(`${cmd.toUpperCase()} REFUSED: ${e.message}`) } finally { await c.end() }
}
