// Strict argument parser of scripts/db/promotion-hosted.mjs (kept apart so that the tests can import it without running the CLI).
const SPEC = {
  status: { need: ['manifest'], opt: [] },
  'verify-promoted': { need: ['package'], opt: ['release-evidence', 'expect-head'] },
  'record-release-evidence': { need: ['package', 'authorization', 'anchor', 'out'], opt: ['previous-evidence'] },
  promote: { need: ['package', 'authorization', 'attribution-evidence', 'parity-record'], opt: [] },
  withdraw: { need: ['manifest', 'authorization'], opt: [] },
  emergency: { need: ['manifest', 'authorization'], opt: [] },
  finish: { need: ['manifest', 'authorization'], opt: [] },
  revert: { need: ['manifest', 'authorization'], opt: [] },
  analyze: { need: ['manifest', 'authorization'], opt: [] },
  'check-authorization': { need: ['operation', 'manifest', 'authorization'], opt: [] },
  'draft-authorization': { need: ['operation', 'out'], opt: ['manifest', 'package', 'parity-record', 'attribution-evidence', 'reason', 'close-api', 'with-grant', 'after-attempt', 'hours'], flags: ['close-api', 'with-grant'] }
}
const COMMON = ['owner-keyring', 'report']

/** Strict parser: a known command, only its own options (each exactly once, with a value), nothing positional. Returns { cmd, o }. Exported for the tests. */
export function parseArgs (argv, usage = 'usage: see scripts/db/promotion-hosted.mjs') {
  const [cmd, ...rest] = argv
  if (!cmd || !Object.hasOwn(SPEC, cmd)) return { error: usage }
  const allowed = new Set([...SPEC[cmd].need, ...SPEC[cmd].opt, ...COMMON]); const o = {}
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]
    if (!k.startsWith('--')) return { error: `unexpected argument "${k}"` }
    const name = k.slice(2)
    if (!(SPEC[cmd].opt.includes(name)) && ['hosted', 'confirm-hosted', 'database', 'url', 'database-url', 'with-grant', 'close-api', 'reason', 'force', 'retry', 'attempts', 'yes'].includes(name)) return { error: `refusing: --${name} is not an option of the hosted runner (what an operation does is fixed by the owner's signed authorization)` }
    if (!allowed.has(name)) return { error: `unsupported option --${name} for "${cmd}"` }
    if (name in o) return { error: `--${name} given twice` }
    if ((SPEC[cmd].flags ?? []).includes(name)) { o[name] = true; i -= 1; continue }   // a switch without a value (draft-authorization only)
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) return { error: `--${name} needs a value` }
    o[name] = rest[i + 1]
  }
  for (const n of SPEC[cmd].need) if (!(n in o)) return { error: `missing --${n}` }
  if (cmd === 'verify-promoted') {   // the head of the release history is pinned whenever release evidence is used, and is meaningless without it
    if ('release-evidence' in o && !('expect-head' in o)) return { error: '--release-evidence needs --expect-head <sha256 of the latest signed release evidence> (a release removed from the end of the history cannot otherwise be seen)' }
    if ('expect-head' in o && !('release-evidence' in o)) return { error: '--expect-head needs --release-evidence' }
  }
  return { cmd, o }
}

