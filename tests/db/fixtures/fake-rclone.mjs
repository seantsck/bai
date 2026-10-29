#!/usr/bin/env node
// A stand-in for `rclone` that stores "remote" files in a local directory (RCLONE_FAKE_RCLONE_ROOT) and can be told to misbehave. It records every call in RCLONE_FAKE_RCLONE_LOG.
// Remote syntax: "fake:some/path" -> $RCLONE_FAKE_RCLONE_ROOT/some/path. Failure injection (environment): RCLONE_FAKE_FAIL_UPLOAD=<name substring|1>, RCLONE_FAKE_FAIL_DOWNLOAD, RCLONE_FAKE_CORRUPT=<substring>,
// RCLONE_FAKE_TRUNC=<substring> (stores half a file), RCLONE_FAKE_NO_DOWNLOAD=<substring> (exit 0, writes nothing), RCLONE_FAKE_HIDE=<substring> (omit from lsjson), RCLONE_FAKE_WRONG_MD5=1, RCLONE_FAKE_NO_HASH=1, RCLONE_FAKE_LS_FAIL=1.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const a = process.argv.slice(2)
if (a[0] === '--config') a.splice(0, 2)
const root = process.env.RCLONE_FAKE_RCLONE_ROOT
if (process.env.RCLONE_FAKE_RCLONE_LOG) fs.appendFileSync(process.env.RCLONE_FAKE_RCLONE_LOG, a.join(' ') + '\n')
const hit = (v, name) => v && (v === '1' || name.includes(v))
const real = (r) => path.join(root, r.replace(/^fake:/, ''))
const cmd = a[0]
if (cmd === 'version') { console.log('rclone fake v0.0-test'); process.exit(0) }
if (cmd === 'lsjson') {
  if (process.env.RCLONE_FAKE_LS_FAIL) { console.error('Failed to lsjson: oauth2: token expired ya29.FAKE-SECRET-TOKEN-123456'); process.exit(1) }
  const dir = real(a.at(-1))
  if (!fs.existsSync(dir)) { console.error('directory not found'); process.exit(3) }
  const out = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && !hit(process.env.RCLONE_FAKE_HIDE, e.name)).map((e) => {
    const buf = fs.readFileSync(path.join(dir, e.name)); const md5 = crypto.createHash('md5').update(buf).digest('hex')
    return { Name: e.name, Size: buf.length, IsDir: false, ...(process.env.RCLONE_FAKE_NO_HASH ? {} : { Hashes: { md5: process.env.RCLONE_FAKE_WRONG_MD5 ? '0'.repeat(32) : md5 } }) }
  })
  console.log(JSON.stringify(out)); process.exit(0)
}
if (cmd === 'copyto') {
  const flags = a.slice(1).filter((x) => x.startsWith('--')); const [src, dst] = a.slice(1).filter((x) => !x.startsWith('--'))
  const up = dst.startsWith('fake:'); const name = path.basename(up ? dst : src)
  if (up) {
    if (hit(process.env.RCLONE_FAKE_FAIL_UPLOAD, name)) { console.error('Failed to copy: googleapi: Error 503: backendError token=ya29.FAKE-SECRET-TOKEN-123456'); process.exit(1) }
    const target = real(dst); fs.mkdirSync(path.dirname(target), { recursive: true })
    if (fs.existsSync(target) && flags.includes('--immutable')) { console.error('immutable file modified'); process.exit(9) }
    let buf = fs.readFileSync(src); if (hit(process.env.RCLONE_FAKE_TRUNC, name)) buf = buf.subarray(0, Math.floor(buf.length / 2))
    fs.writeFileSync(target, buf); process.exit(0)
  }
  if (hit(process.env.RCLONE_FAKE_FAIL_DOWNLOAD, name)) { console.error('Failed to copy: connection reset'); process.exit(1) }
  if (!fs.existsSync(real(src))) { console.error('object not found'); process.exit(3) }
  if (hit(process.env.RCLONE_FAKE_NO_DOWNLOAD, name)) process.exit(0)
  let buf = fs.readFileSync(real(src)); if (hit(process.env.RCLONE_FAKE_CORRUPT, name)) { buf = Buffer.from(buf); buf[buf.length - 1] ^= 1 }
  fs.writeFileSync(dst, buf); process.exit(0)
}
console.error(`fake rclone: unsupported ${cmd}`); process.exit(2)
