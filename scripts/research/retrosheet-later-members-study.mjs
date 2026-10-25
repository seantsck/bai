// Study of trade groups that carry later-dated members (docs/transactions/later-added/proposal.md), from the cached original archive.
//   node scripts/research/retrosheet-later-members-study.mjs [--zip .local/retrosheet/trandb.zip] [--periods 2010-2014,2015-2020,2021-2021]
// Read-only: parses the archive, verifies its recorded checksum, prints one JSON object per period. Nothing is written.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readZipEntry } from '../history/lib/retrosheet.mjs'
import * as R from './lib/retrosheet-transactions.mjs'
import { laterMemberStudy } from './lib/retrosheet-later-members.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const zip = fs.readFileSync(path.resolve(root, opt('zip', '.local/retrosheet/trandb.zip')))
const recorded = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8')).entries['retrosheet/trandb.zip'].sha256
if (crypto.createHash('sha256').update(zip).digest('hex') !== recorded) throw new Error('the archive does not match its recorded checksum')
const groups = R.groupRows(R.parseTran(readZipEntry(zip, 'tran.txt').toString('utf8')))
for (const p of opt('periods', '2010-2014,2015-2020,2021-2021').split(',')) {
  const [from, to] = p.split('-').map(Number)
  console.log(JSON.stringify({ period: p, ...laterMemberStudy(groups.filter((g) => g.season >= from && g.season <= to)) }))
}
