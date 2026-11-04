// The gated hosted promotion runner (G6). The LOCAL tool scripts/db/promotion.mjs is unchanged and still refuses every hosted target; this is a separate, narrow entrypoint.
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs status    --manifest <sha256>                                                      read-only, no authorization needed
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs verify-promoted --package <dir>                                               read-only post-promotion checks
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs promote   --package <dir> --authorization <file> --attribution-evidence <file> --parity-record <file>
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs withdraw  --manifest <sha256> --authorization <file>
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs emergency --manifest <sha256> --authorization <file>     (the authorization says whether it closes the Data API)
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs finish    --manifest <sha256> --authorization <file>
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs revert    --manifest <sha256> --authorization <file>
//   node --env-file=<hosted env> scripts/db/promotion-hosted.mjs analyze   --manifest <sha256> --authorization <file>     planner statistics only
//   node scripts/db/promotion-hosted.mjs check-authorization --operation <op> --manifest <sha256> --authorization <file>   offline: verifies the owner's signature and the file, connects to nothing
// Common options: --owner-keyring <dir> (a GnuPG home holding the owner's PUBLIC signing key; default ~/.config/bai-release/gnupg), --report <new file> (the JSON report, never overwritten).
// There are no other options. A signed owner authorization is required for every write: see docs/transactions/g6-hosted-promotion-runner.md. The connection is the pinned project's direct host,
// verified TLS only (lib/hosted-connection.mjs). Nothing is ever retried; an unclear result is resolved read-only and left for the owner.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectHosted } from './lib/hosted-connection.mjs'
import { OWNER_SIGNING_FINGERPRINTS, attemptLedger, verifyAuthorization } from './lib/promotion-authorization.mjs'
import { HostedPromotionError, operateHosted, promoteHosted, statusHosted, verifyPromotedHosted } from './lib/promotion-hosted.mjs'
import { parseArgs } from './lib/promotion-hosted-args.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const usage = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')
const die = (m, code = 1) => { console.error(m); process.exit(code) }

const parsed = parseArgs(process.argv.slice(2), usage)
if (parsed.error) die(parsed.error, 2)
const { cmd, o } = parsed
const keyring = path.resolve(o['owner-keyring'] ?? path.join(os.homedir(), '.config/bai-release/gnupg'))
const emit = (report) => {
  const text = JSON.stringify(report, null, 1); console.log(text)
  if (o.report) { try { fs.writeFileSync(o.report, text + '\n', { flag: 'wx', mode: 0o600 }) } catch (e) { console.error(`could not write the report: ${e.message}`) } }
}

if (cmd === 'check-authorization') {
  const ref = process.env.BAI_SUPABASE_PROJECT_REF
  const v = verifyAuthorization(o.authorization, { operation: o.operation, projectRef: ref, manifest: o.manifest, keyring, isConsumed: attemptLedger().isConsumed })
  emit({ command: cmd, ok: v.problems.length === 0, problems: v.problems, sha256: v.sha256, signed_by: v.signature?.fingerprint ?? null })
  process.exit(v.problems.length ? 1 : 0)
}

const projectRef = process.env.BAI_SUPABASE_PROJECT_REF
const connect = () => connectHosted({ ref: projectRef, expectedRef: projectRef, repoRoot, env: process.env })
const ctx = { connect, projectRef, keyring, pinned: OWNER_SIGNING_FINGERPRINTS, ledger: attemptLedger(), env: process.env, log: (m) => console.error(m) }
try {
  let report
  if (cmd === 'status') report = await statusHosted(ctx, o.manifest)
  else if (cmd === 'verify-promoted') report = await verifyPromotedHosted(ctx, o.package)
  else if (cmd === 'promote') report = await promoteHosted(ctx, { pkgDir: o.package, authFile: o.authorization, evidenceFile: o['attribution-evidence'], parityFile: o['parity-record'] })
  else report = await operateHosted(ctx, cmd, { manifest: o.manifest, authFile: o.authorization })
  emit({ command: cmd, ok: true, ...report })
} catch (e) {
  emit({ command: cmd, ok: false, error: String(e.message), ...(e instanceof HostedPromotionError ? e.report ?? {} : {}) })
  process.exit(1)
}
