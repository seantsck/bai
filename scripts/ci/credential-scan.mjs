// Scans every tracked or staged-able file (git ls-files, excluding ignored) for credentials. Exits 1 on any finding.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const PATTERNS = [
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['JWT (e.g. Supabase key)', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ['Remote database URL with password', /postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@(?!(?:127\.0\.0\.1|localhost|\[::1\])[:/])[^\s'"`]+/]
]

const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const findings = []
for (const file of files) {
  // Regular files only: a symlink (e.g. supabase/migrations -> database/migrations) is scanned through its target.
  if (file === 'package-lock.json' || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size > 2_000_000) continue
  const text = fs.readFileSync(file, 'utf8')
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line) && !line.includes('credential-scan:allow')) findings.push(`${file}:${i + 1}  ${name}`)
  })
}
if (findings.length) {
  console.error(`credential scan: ${findings.length} finding(s)\n${findings.join('\n')}`)
  process.exit(1)
}
console.log(`credential scan: ${files.length} files clean`)
