// Retrosheet reader: zip entry extraction, draft record parsing, honest coverage and the exception cross-check.
// Offline: a synthetic transactions file; nothing here touches the network or the database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { readZipEntry, parseDraftTransactions, coverageByYear, phaseHint, compareNames, namesByRetrosheetId, RETROSHEET_ATTRIBUTION, RETRO_TEAM_CODES } from '../../scripts/history/lib/retrosheet.mjs'
import { crossCheckEntry, candidateNames } from '../../scripts/history/retrosheet.mjs'
import { loadCatalog, checkUse, validateCatalog } from '../../scripts/history/lib/permissions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeZip (name, data, deflate = true) {
  const raw = Buffer.from(data, 'latin1')
  const body = deflate ? zlib.deflateRawSync(raw) : raw
  const nm = Buffer.from(name, 'latin1')
  const crc = zlib.crc32(raw)
  const lh = Buffer.alloc(30)
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14)
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26)
  const cd = Buffer.alloc(46)
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(deflate ? 8 : 0, 10); cd.writeUInt32LE(crc, 16)
  cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42)
  const local = Buffer.concat([lh, nm, body])
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length + nm.length, 12); eocd.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, cd, nm, eocd])
}

const TRAN = [
  '"19650608",,,"19650701",,1,"smitj001","Da","","","BAL","AL","",1,3,',
  '"19650608",,,,,2,"jones001","Dn","","","NYA","AL","",2,,',
  '"19650608",,,,,3,"Pat Nobody","Da","","","KCA","AL","",5,,',
  '"19650608",,,,,4,"voidv001","Dv","","","XXX","AL","",1,,',
  '"19650801",,,,,5,"legio001","Da","","","LAN","NL","L",1,,',
  '"20030603",,,"20030629",,6,"aardd001","Da","","","SFN","NL",,1,22,',
  '"19650608",,,,,7,"smitj001","F ","","","BAL","AL",,,,',
  '"19650608",,,,,8,"ruleV001","D ","","","BAL","AL",,,,'
].join('\n')

test('zip entries are read from stored and deflated archives, and corruption is refused', () => {
  for (const deflate of [true, false]) assert.equal(readZipEntry(makeZip('tran.txt', TRAN, deflate), 'tran.txt').toString('latin1'), TRAN)
  assert.throws(() => readZipEntry(makeZip('tran.txt', TRAN), 'other.txt'), /not found/)
  assert.throws(() => readZipEntry(Buffer.from('not a zip at all'), 'tran.txt'), /not a zip/)
  const z = makeZip('tran.txt', TRAN)
  assert.throws(() => readZipEntry(z.subarray(0, z.length - 40), 'tran.txt'))
})

test('only draft records are read; ids, names, signing and club codes are kept as stated', () => {
  const { records, unknownTeams } = parseDraftTransactions(TRAN)
  assert.equal(records.length, 6, 'free agent and Rule 5 rows are not draft records')
  const [a, b, c, v, l, g] = records
  assert.deepEqual([a.retrosheet_id, a.status, a.franchise, a.round, a.pick, a.signing_date, a.phase_hint], ['smitj001', 'SELECTED_AND_SIGNED', 'BAL', '1', '3', '19650701', 'JR'])
  assert.deepEqual([b.status, b.signing_date], ['SELECTED_DID_NOT_SIGN', null])
  assert.deepEqual([c.retrosheet_id, c.name_only], [null, 'Pat Nobody'], 'a name-only row is not given an id')
  assert.equal(v.status, 'SELECTION_VOIDED')
  assert.deepEqual([l.draft_type, l.phase_hint], ['L', 'AL'])
  assert.equal(g.draft_year, 2003)
  assert.deepEqual(unknownTeams, { XXX: 1 }, 'an unknown club code is reported, never guessed')
  assert.equal(v.franchise, null)
})

test('phase hints are conservative: ambiguous draft types stay unmapped', () => {
  assert.equal(phaseHint('', '19850603'), 'JR')
  assert.equal(phaseHint('', '19850123'), 'NR')
  assert.equal(phaseHint('S', '19850107'), 'NS')
  assert.equal(phaseHint('S', '19850610'), 'JS')
  assert.equal(phaseHint('A', '19850610'), null)
  assert.equal(phaseHint('D', '19850610'), null)
  assert.equal(phaseHint('', '19851100'), null)
})

test('coverage counts what Retrosheet holds and the index is labelled as not a population', () => {
  const { records } = parseDraftTransactions(TRAN)
  const cov = coverageByYear(records)
  assert.deepEqual(cov[1965], { records: 5, selected_and_signed: 3, did_not_sign: 1, voided: 1, with_retrosheet_id: 4 })
  assert.match(RETROSHEET_ATTRIBUTION, /obtained free of charge from and is copyrighted by Retrosheet/)
  for (const franchise of Object.values(RETRO_TEAM_CODES)) assert.match(franchise, /^[A-Z]{2,3}$/)
})

test('name comparison is conservative', () => {
  assert.equal(compareNames('Jim Johnson', 'James Johnson'), 'SAME_SURNAME_COMPATIBLE_FIRST')
  assert.equal(compareNames('Steve Tolleson', 'Steven Tolleson'), 'SAME_SURNAME_COMPATIBLE_FIRST')
  assert.equal(compareNames('Rod Austin', 'Frank Austin'), 'SAME_SURNAME_DIFFERENT_FIRST')
  assert.equal(compareNames('Iván De Jesús Jr.', 'Ivan De Jesus'), 'EXACT')
  assert.equal(compareNames('Gary Griffith', 'Larry Smith'), 'DIFFERENT_SURNAME')
  assert.equal(compareNames('J Smith', 'John Smith'), 'SAME_SURNAME_COMPATIBLE_FIRST')
})

test('the cross-check proposes findings and never concludes', () => {
  const entry = { id: 'EX-1965-JR-NAMES', year: 1965, kind: 'NAME_VARIANTS', review_kind: 'ALTERNATE_NAME', club: null, claims: [{ source: 'mlb-statsapi-draft / bref-draft-archive', says: ['BAL #130 MLB "Rod Austin" / "Frank Austin"', 'NYY #150 MLB "Jim Johnson" / "James Johnson"'] }] }
  assert.deepEqual(candidateNames(entry).map((c) => [c.club, c.variants]), [['BAL', ['Rod Austin', 'Frank Austin']], ['NYY', ['Jim Johnson', 'James Johnson']]])
  const records = parseDraftTransactions(TRAN).records.filter((r) => r.retrosheet_id)
  const text = 'key_retro,name_first,name_last,birth_year,birth_month,birth_day\nsmitj001,Rod,Austin,1947,1,2\njones001,James,Johnson,1947,3,4\n'
  const names = namesByRetrosheetId(text, new Set(records.map((r) => r.retrosheet_id)))
  const f = crossCheckEntry(entry, records.map((r) => ({ ...r, franchise: r.franchise })), names)
  assert.equal(f.status, 'PROPOSED_FINDING')
  assert.equal(f.outcome, 'RETROSHEET_FAVORS_ONE_VARIANT')
  assert.equal(f.results.length, 2)
  assert.ok(!('conclusion' in f), 'a finding carries no conclusion')
  const none = crossCheckEntry({ ...entry, id: 'EX-1965-JR-NUMBERING', kind: 'PICK_NUMBERING_DIFFERS', claims: [{ source: 's', says: '78 matched picks carry different overall numbers' }] }, records, names)
  assert.equal(none.outcome, 'NOT_COMPARABLE')
  const absent = crossCheckEntry({ ...entry, claims: [{ source: 's', says: ['BAL #9 MLB "Nobody Real" / "N. Real"'] }] }, records, names)
  assert.equal(absent.outcome, 'NO_RETROSHEET_RECORD', 'no Retrosheet record is not evidence of anything')
})

test('the catalog records Retrosheet (no site publication yet) and Wikidata (CC0, identity-bound publication)', () => {
  const catalog = loadCatalog(root)
  assert.deepEqual(validateCatalog(catalog), [])
  const ctx = { now: new Date('2026-10-22T12:00:00Z') }
  const ok = (id, use) => checkUse(catalog, id, use, ctx, { root }).ok
  for (const use of ['fetch_targeted', 'fetch_bulk', 'process_local', 'publish_repository']) assert.equal(ok('retrosheet-transactions', use), true, use)
  assert.equal(ok('retrosheet-transactions', 'publish_site'), false, 'hosted publication waits for the attribution surface and a person')
  for (const use of ['fetch_targeted', 'process_local', 'publish_repository', 'publish_site']) assert.equal(ok('wikidata', use), true, use)
  const retro = catalog.sources.find((s) => s.id === 'retrosheet-transactions')
  assert.equal(retro.license.attribution, RETROSHEET_ATTRIBUTION)
  assert.ok(retro.does_not_supply.some((x) => /complete draft population/.test(x)))
  assert.match(catalog.sources.find((s) => s.id === 'wikidata').license.name, /CC0/)
})

test('the /sources page shows the exact Retrosheet statement', () => {
  const page = fs.readFileSync(path.join(root, 'app/sources/page.tsx'), 'utf8')
  assert.ok(page.includes(RETROSHEET_ATTRIBUTION))
})
