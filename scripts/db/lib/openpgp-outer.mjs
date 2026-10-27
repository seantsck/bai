// Validates the OUTER structure of an OpenPGP file from its bytes alone: no decryption, no gpg, no agent, no passphrase, no prompt.
// Used by scripts/db/backup-offsite.sh to decide that a file is the encrypted backup made by backup-pack.sh (and not plaintext, an export, a signed or
// public-key-encrypted file, an armored file, or a damaged one) before anything is copied off the machine.
//
// An accepted file is EXACTLY: one Symmetric-Key Encrypted Session Key packet (tag 3: version 4, cipher AES-256, S2K iterated+salted) followed by one
// Symmetrically Encrypted Integrity Protected Data packet (tag 18, version 1), and nothing else, to the last byte. Both packet formats are understood
// (GnuPG writes the first as an old-format packet and the second as a new-format packet with partial body lengths, as it must when it streams).
// Why not `gpg --list-packets`: it TRIES TO DECRYPT, so when gpg-agent holds a cached passphrase it prints the inner (compressed, literal) packets, and when
// it does not it can ask for the passphrase. Neither is acceptable in a check that must be safe to run with no passphrase.
import fs from 'node:fs'

export class OuterPacketError extends Error {}
const CIPHERS = { 1: 'IDEA', 2: '3DES', 3: 'CAST5', 4: 'Blowfish', 7: 'AES-128', 8: 'AES-192', 9: 'AES-256', 10: 'Twofish', 11: 'Camellia-128', 12: 'Camellia-192', 13: 'Camellia-256' }
const HASHES = { 1: 'MD5', 2: 'SHA1', 3: 'RIPEMD160', 8: 'SHA256', 9: 'SHA384', 10: 'SHA512', 11: 'SHA224' }
const TAGS = { 1: 'public-key encrypted session key', 2: 'signature', 3: 'symmetric-key encrypted session key', 4: 'one-pass signature', 5: 'secret key', 6: 'public key', 7: 'secret subkey', 8: 'compressed data', 9: 'symmetrically encrypted data (no integrity protection)', 10: 'marker', 11: 'literal data', 12: 'trust', 13: 'user id', 14: 'public subkey', 17: 'user attribute', 18: 'symmetrically encrypted integrity-protected data', 19: 'modification detection code', 20: 'AEAD encrypted data' }
export const tagName = (t) => TAGS[t] ?? `unknown tag ${t}`
const MIN_SEIPD_BODY = 1 + 18 + 22   // version, random prefix (block + 2 check bytes), modification-detection packet

/** @param {(offset: number, length: number) => Buffer} readAt @param {number} size */
export function parseOuterPackets (readAt, size) {
  const packets = []
  let off = 0
  const need = (o, n) => { if (o + n > size) throw new OuterPacketError('the file ends inside a packet header or body (truncated)'); return readAt(o, n) }
  while (off < size) {
    const start = off
    const b0 = need(off, 1)[0]
    if (!(b0 & 0x80)) throw new OuterPacketError(`byte ${off} (0x${b0.toString(16).padStart(2, '0')}) is not an OpenPGP packet header`)
    let tag; let bodyStart; let bodyLen = 0; let partial = false; let format
    if (b0 & 0x40) {   // new format
      format = 'new'; tag = b0 & 0x3f
      let o = off + 1
      let first = true
      for (;;) {
        const l1 = need(o, 1)[0]
        let chunk; let last = false
        if (l1 < 192) { chunk = l1; o += 1; last = true } else if (l1 < 224) { chunk = ((l1 - 192) << 8) + need(o + 1, 1)[0] + 192; o += 2; last = true } else if (l1 === 255) { chunk = need(o + 1, 4).readUInt32BE(0); o += 5; last = true } else { chunk = 1 << (l1 & 0x1f); o += 1; partial = true }
        if (first) bodyStart = o
        first = false
        if (o + chunk > size) throw new OuterPacketError('a packet body runs past the end of the file (truncated)')
        bodyLen += chunk; o += chunk
        if (last) break
      }
      off = o
    } else {            // old format
      format = 'old'; tag = (b0 >> 2) & 0x0f
      const lt = b0 & 3
      let o = off + 1
      if (lt === 0) { bodyLen = need(o, 1)[0]; o += 1 } else if (lt === 1) { bodyLen = need(o, 2).readUInt16BE(0); o += 2 } else if (lt === 2) { bodyLen = need(o, 4).readUInt32BE(0); o += 4 } else { bodyLen = size - o }
      bodyStart = o
      if (o + bodyLen > size) throw new OuterPacketError('a packet body runs past the end of the file (truncated)')
      off = o + bodyLen
    }
    packets.push({ tag, format, offset: start, bodyStart, bodyLen, partial })
  }
  if (off !== size) throw new OuterPacketError('data follows the last packet')
  return packets
}

/** Throws OuterPacketError (with a precise reason) unless the file is exactly [SKESK v4 AES-256 iterated+salted, SEIPD v1]. Returns a summary. */
export function inspectEncryptedArchive (readAt, size) {
  if (size < 40) throw new OuterPacketError(`the file is only ${size} bytes`)
  const first = readAt(0, 1)[0]
  if (first === 0x2d) throw new OuterPacketError('it looks ASCII-armored ("-----BEGIN"), not a binary OpenPGP file')
  const packets = parseOuterPackets(readAt, size)
  const tags = packets.map((p) => p.tag)
  const unexpected = packets.filter((p) => p.tag !== 3 && p.tag !== 18)
  if (unexpected.length) throw new OuterPacketError(`unexpected outer packet(s): ${[...new Set(unexpected.map((p) => `${p.tag} ${tagName(p.tag)}`))].join(', ')} (only a symmetric-key session packet and an integrity-protected data packet are allowed)`)
  if (tags.length !== 2 || tags[0] !== 3 || tags[1] !== 18) throw new OuterPacketError(`the outer packets are [${tags.join(', ')}], expected exactly [3, 18]`)
  const [sk, data] = packets
  if (sk.bodyLen < 3) throw new OuterPacketError('the session-key packet is too short to name its cipher and key derivation')
  const body = readAt(sk.bodyStart, Math.min(sk.bodyLen, 13))
  if (body[0] !== 4) throw new OuterPacketError(`the session-key packet is version ${body[0]}, expected 4`)
  if (body[1] !== 9) throw new OuterPacketError(`the cipher is ${CIPHERS[body[1]] ?? `algorithm ${body[1]}`}, not AES-256`)
  if (body[2] !== 3) throw new OuterPacketError(`the key derivation is S2K type ${body[2]}, not iterated+salted (3)`)
  if (sk.bodyLen < 13) throw new OuterPacketError('the session-key packet is too short to describe an iterated, salted key derivation')
  const countByte = body[12]
  const count = (16 + (countByte & 15)) << ((countByte >> 4) + 6)
  if (data.bodyLen < MIN_SEIPD_BODY) throw new OuterPacketError('the encrypted data packet is too short to be a real archive')
  const ver = readAt(data.bodyStart, 1)[0]
  if (ver !== 1) throw new OuterPacketError(`the encrypted data packet is version ${ver}, expected 1 (integrity protected, CFB)`)
  return { tags, cipher: 'AES-256', s2k: { type: 'iterated+salted', hash: HASHES[body[3]] ?? `algorithm ${body[3]}`, count }, integrity: 'MDC (SEIPD v1)', formats: packets.map((p) => `${p.format}${p.partial ? '/partial' : ''}`), bytes: size }
}

export function inspectFile (file) {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const readAt = (o, n) => { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, o); if (got < n) throw new OuterPacketError('the file ends inside a packet (truncated)'); return b }
    return inspectEncryptedArchive(readAt, size)
  } finally { fs.closeSync(fd) }
}
export const inspectBuffer = (buf) => inspectEncryptedArchive((o, n) => buf.subarray(o, o + n), buf.length)

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2]
  if (!file) { console.error('usage: openpgp-outer.mjs <file>'); process.exit(2) }
  try { console.log(JSON.stringify(inspectFile(file))) } catch (e) { console.error(e instanceof OuterPacketError ? e.message : `cannot read ${file}: ${e.message}`); process.exit(1) }
}
