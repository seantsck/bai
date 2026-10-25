// Retrosheet historical transaction pipeline (local research only; docs/transactions/retrosheet-integration.md).
//   node scripts/research/retrosheet-transactions.mjs archive   [--zip f] [--out dir]            verify the cached original archive, write its checksum manifest (no download)
//   node --env-file=.env.hosted.local scripts/research/retrosheet-transactions.mjs snapshot-bai    READ-ONLY copy of BAI's trades and player ids into the local output directory
//   node scripts/research/retrosheet-transactions.mjs run --register-dir <pinned Chadwick shards> [--from 2015 --to 2020] [--bai-snapshot f]
// Writes only to the (gitignored) output directory. Nothing touches a database except the read-only snapshot.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { readZipEntry } from '../history/lib/retrosheet.mjs'
import * as R from './lib/retrosheet-transactions.mjs'
import { indexRegisterByRetro, resolveAll, repeatActivity } from './lib/retrosheet-identity.mjs'
import { reconcileTrades } from './lib/retrosheet-reconcile.mjs'
import { buildCandidates, sourceDeclarations, sourceKeys } from './lib/retrosheet-adapter.mjs'
import { renderReport } from './lib/retrosheet-report.mjs'
import { prepareToText } from './lib/transactions.mjs'
import { prepareAcquisitionText } from './lib/acquisitions.mjs'
import { buildAcquisitionCandidates } from './lib/retrosheet-acquisitions.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i]
const outDir = path.resolve(root, args.out ?? '.local/retrosheet/out')
const zipFile = path.resolve(root, args.zip ?? '.local/retrosheet/trandb.zip')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const write = (name, text) => { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, name), typeof text === 'string' ? text : JSON.stringify(text, null, 1) + '\n') }
const LIMITS = [
  'The archive lists transactions Retrosheet recorded; it is not a certified complete census of any club or season.',
  'A transaction id is not unique across the file for non-trade rows; only trade-family rows sharing an id are one transaction.',
  'The info field is free text. Only an exact, closed vocabulary is read ("$" = money sent, amount not stated; player to be named; international slot money; draft pick); no amount, bonus or contract value is read.',
  'Minor-league players are often named without an id and cannot be matched; they are held, never matched by name.',
  'Signing bonuses, contract terms and cash amounts are not in the archive.',
  'The latest record is dated 2022-02-27; the file says it will not be updated, so coverage after 2021 is nil.'
]

function archiveFacts () {
  const zip = fs.readFileSync(zipFile)
  const tran = readZipEntry(zip, 'tran.txt')
  const readme = readZipEntry(zip, 'readme.txt')
  // zip central directory: entry names, sizes, modified times
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i++) {
    const nlen = zip.readUInt16LE(p + 28); const elen = zip.readUInt16LE(p + 30); const clen = zip.readUInt16LE(p + 32)
    const t = zip.readUInt16LE(p + 12); const d = zip.readUInt16LE(p + 14)
    const name = zip.subarray(p + 46, p + 46 + nlen).toString('latin1')
    entries.push({ name, bytes: zip.readUInt32LE(p + 24), modified: `${1980 + (d >> 9)}-${String((d >> 5) & 15).padStart(2, '0')}-${String(d & 31).padStart(2, '0')}T${String(t >> 11).padStart(2, '0')}:${String((t >> 5) & 63).padStart(2, '0')}` })
    p += 46 + nlen + elen + clen
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
  const recorded = Object.entries(manifest.entries).find(([k]) => k === 'retrosheet/trandb.zip')?.[1] ?? null
  const text = tran.toString('utf8')
  const rows = R.parseTran(text)
  return { zip, tran, readme, entries, recorded, rows, text }
}

async function main () {
  switch (command) {
    case 'archive': {
      const a = archiveFacts()
      const archiveSha = sha(a.zip)
      const m = {
        source: 'Retrosheet transactions database', url: R.RETROSHEET_ARCHIVE.url, readme_url: R.RETROSHEET_ARCHIVE.readme_url, notice_url: R.RETROSHEET_ARCHIVE.notice_url,
        download: { performed_in_this_phase: false, note: 'the original archive was downloaded once in an earlier phase (research/history/manifest.json); the source catalog forbids re-downloading while the cache is valid', retrieved_at: a.recorded?.retrieved_at ?? null },
        archive: { bytes: a.zip.length, sha256: archiveSha, recorded_sha256: a.recorded?.sha256 ?? null, matches_recorded_checksum: a.recorded?.sha256 === archiveSha },
        entries: a.entries.map((e) => ({ ...e, sha256: sha(readZipEntry(a.zip, e.name)) })),
        readme_matches_cached_readme: sha(a.readme) === (fs.existsSync(path.join(path.dirname(zipFile), 'readme.txt')) ? sha(fs.readFileSync(path.join(path.dirname(zipFile), 'readme.txt'))) : null),
        tran: { rows: a.rows.length, malformed_rows: a.rows.filter((r) => r.malformed).length, fields_per_row: 16, first_record_date: a.rows.map((r) => r.date.text).sort()[0], last_record_date: a.rows.map((r) => r.date.text).sort().pop() },
        format: { fields: ['primary-date', 'time', 'approximate-indicator', 'secondary-date', 'secondary approximate-indicator', 'transaction-ID', 'player', 'type', 'from-team', 'from-league', 'to-team', 'to-league', 'draft-type', 'draft-round', 'pick-number', 'info'],
          date: 'yyyymmdd; "00" day = unknown day; "0000" month and day = before the season; "@" = approximate', time: 'empty = before games, 1 = between, 2 = after (also orders off-season rows)',
          player: 'eight-character Retrosheet id, or "First Last" for players who never reached the majors, or empty', teams: 'three-letter MLB code with a two-letter league, or an independent club name with its league in parentheses',
          missing: 'empty field = not applicable or not known; no explicit null token', type_codes: Object.fromEntries(Object.entries(R.TYPE_CODES).map(([k, v]) => [k, v.note])) },
        attribution: R.RETROSHEET_ATTRIBUTION,
        publication: 'the notice permits any use if the attribution statement appears prominently; hosted publication stays gated (publish_site PENDING in research/history/sources.json) until a person grants it'
      }
      write('archive-manifest.json', m)
      console.log(`archive ${archiveSha} ${m.archive.matches_recorded_checksum ? '(matches the recorded checksum)' : '(DOES NOT MATCH the recorded checksum)'}; tran.txt ${m.tran.rows} rows, ${m.tran.malformed_rows} malformed, ${m.tran.first_record_date}..${m.tran.last_record_date}`)
      return m.archive.matches_recorded_checksum ? 0 : 1
    }
    case 'snapshot-bai': {
      const { ownerDatabaseUrl } = await import('../db/lib/connection.mjs')
      const pg = (await import('pg')).default
      const db = new pg.Client({ connectionString: ownerDatabaseUrl() }); await db.connect()
      try {
        await db.query('begin read only')
        const q = async (s) => (await db.query(s)).rows
        const txs = await q(`select t.id, to_char(t.transaction_date, 'YYYY-MM-DD') date, t.date_precision from public.transactions t order by t.id`)
        const pk = await q(`select k.transaction_id, k.id pid, fo.franchise_key f, too.franchise_key t from public.trade_packages k join public.organizations fo on fo.id = k.from_organization_id join public.organizations too on too.id = k.to_organization_id order by k.id`)
        const as = await q(`select a.trade_package_id, a.asset_type, a.player_id, a.amount_usd::text amount_usd, a.description from public.trade_package_assets a order by a.id`)
        const ids = await q(`select player_id, id_system, external_id from public.player_external_ids where id_system in ('MLBAM', 'RETROSHEET')`)
        const names = await q('select id, full_name from public.players')
        const war = await q(`select player_id, war_system, count(*)::int n from public.war_observations group by 1, 2`)
        const attr = (await q('select count(*)::int n from public.organization_value_attributions'))[0].n
        const idsBy = new Map(); for (const r of ids) { const e = idsBy.get(String(r.player_id)) ?? {}; e[r.id_system] = r.external_id; idsBy.set(String(r.player_id), e) }
        const nameBy = new Map(names.map((r) => [String(r.id), r.full_name]))
        const snap = {
          taken_on: new Date().toISOString().slice(0, 10), access: 'hosted, one read-only transaction; nothing written',
          transactions: txs.map((t) => ({ id: Number(t.id), date: t.date, date_precision: t.date_precision, packages: pk.filter((k) => k.transaction_id === t.id).map((k) => ({ from: k.f, to: k.t,
            assets: as.filter((a) => a.trade_package_id === k.pid).map((a) => ({ asset_type: a.asset_type, player_id: a.player_id ? Number(a.player_id) : null, mlbam: idsBy.get(String(a.player_id))?.MLBAM ?? null, retro: idsBy.get(String(a.player_id))?.RETROSHEET ?? null, name: nameBy.get(String(a.player_id)) ?? null, amount_usd: a.amount_usd, description: a.description })) })) })),
          players: [...idsBy.entries()].map(([id, e]) => ({ id: Number(id), mlbam: e.MLBAM ?? null, retro: e.RETROSHEET ?? null })),
          war_players_by_system: Object.fromEntries(['BREF', 'FANGRAPHS', 'OTHER'].map((s) => [s, war.filter((w) => w.war_system === s).length])),
          war_player_ids: [...new Set(war.map((w) => Number(w.player_id)))], organization_value_attributions: attr, contract_tables: 'none'
        }
        write('bai-snapshot.json', snap)
        await db.query('rollback')
        console.log(`snapshot: ${snap.transactions.length} trades, ${snap.players.length} players with MLBAM/Retrosheet ids`)
      } finally { await db.end() }
      return 0
    }
    case 'run': {
      const from = Number(args.from ?? 2015); const to = Number(args.to ?? 2020)
      const a = archiveFacts()
      const archiveSha = sha(a.zip)
      if (a.recorded?.sha256 !== archiveSha) throw new Error('the archive does not match its recorded checksum; refusing to process')
      const rows = a.rows
      const groups = R.groupRows(rows)
      const inv = R.inventory(rows, groups, { from, to })
      const snap = JSON.parse(fs.readFileSync(path.resolve(root, args['bai-snapshot'] ?? path.join(outDir, 'bai-snapshot.json')), 'utf8'))
      const bai = { byMlbam: new Map(snap.players.filter((p) => p.mlbam).map((p) => [p.mlbam, { id: p.id, retro: p.retro }])), byRetro: new Map(snap.players.filter((p) => p.retro).map((p) => [p.retro, { id: p.id, mlbam: p.mlbam }])) }
      const periodRows = R.inSeasons(rows, from, to)
      const wanted = new Set(periodRows.filter((r) => r.player.kind === 'RETROSHEET_ID').map((r) => r.player.retro_id))
      const regDir = path.resolve(root, need('register-dir'))
      const register = indexRegisterByRetro(regDir, wanted)
      const resolved = resolveAll(periodRows, register, bai)
      const states = {}
      for (const v of resolved.values()) states[v.state] = (states[v.state] ?? 0) + 1
      states.NAME_ONLY = new Set(periodRows.filter((r) => r.player.kind === 'NAME_ONLY').map((r) => r.player.name)).size
      const periodGroups = groups.filter((g) => g.season >= from && g.season <= to)
      const identity = { states, repeat: repeatActivity(periodGroups, resolved) }
      const reconciliation = reconcileTrades(groups, resolved, snap, { from, to })
      const registerCommit = path.basename(regDir)
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
      const files = manifest.entries
      const chadRetrieved = Object.entries(files).find(([k]) => k.startsWith('chadwick/'))?.[1]?.retrieved_at?.slice(0, 10) ?? '2026-10-21'
      const keys = sourceKeys(archiveSha, registerCommit)
      const declarations = sourceDeclarations({ archiveSha256: archiveSha, retrievedOn: a.recorded.retrieved_at.slice(0, 10), registerCommit, registerCommitFull: JSON.parse(fs.readFileSync(path.join(root, 'research/history/sources.json'), 'utf8')).sources.find((x) => x.id === 'chadwick-register').pinned_commit, registerRetrievedOn: chadRetrieved })
      const cand = buildCandidates(groups, resolved, { from, to, declarations, keys, batchKey: `retrosheet-trades-${from}-${to}-${archiveSha.slice(0, 8)}` })
      const holdReasons = {}
      for (const h of cand.holds) for (const r of h.reasons) holdReasons[r.replace(/^IDENTITY_[a-z-]+\d{3}:/, 'IDENTITY_')] = (holdReasons[r.replace(/^IDENTITY_[a-z-]+\d{3}:/, 'IDENTITY_')] ?? 0) + 1
      const archive = { url: R.RETROSHEET_ARCHIVE.url, sha256: archiveSha, bytes: a.zip.length, retrieved_at: a.recorded.retrieved_at, tran_sha256: sha(a.tran), tran_rows: rows.length, tran_columns: 16,
        last_record_date: rows.map((r) => r.date.text).sort().pop(), zip_entry_modified: a.entries.find((e) => e.name === 'tran.txt').modified, limits: LIMITS }
      const warPlayers = new Set(snap.war_player_ids)
      const identified = [...resolved.values()].filter((v) => v.state === 'STRONG' && v.evidence.bai_player_id && warPlayers.has(v.evidence.bai_player_id)).length
      const report = renderReport({ archive, inventory: inv, identity, reconciliation: { ...reconciliation }, candidates: { candidates: cand.candidates.length, holds: cand.holds.length, hold_reasons: holdReasons },
        bai: { war_players: identified, attributions: snap.organization_value_attributions }, from, to })
      write('inventory.json', { attribution: R.RETROSHEET_ATTRIBUTION, ...inv })
      write('identity.json', { attribution: R.RETROSHEET_ATTRIBUTION, summary: identity, players: Object.fromEntries([...resolved.entries()].sort().map(([k, v]) => [k, v])) })
      write('identity-holds.json', { attribution: R.RETROSHEET_ATTRIBUTION, players: [...resolved.entries()].filter(([, v]) => v.state !== 'STRONG').sort().map(([k, v]) => ({ retro_id: k, state: v.state, evidence: v.evidence })),
        name_only_players: [...new Set(periodRows.filter((r) => r.player.kind === 'NAME_ONLY').map((r) => r.player.name))].sort() })
      write('reconciliation.json', { attribution: R.RETROSHEET_ATTRIBUTION, ...reconciliation })
      write('candidates-batch.json', prepareToText(cand.doc))
      write('candidate-holds.json', { attribution: R.RETROSHEET_ATTRIBUTION, holds: cand.holds })
      const csv = ['# ' + R.RETROSHEET_ATTRIBUTION, 'season,club,category,records_touching_club', ...Object.entries(inv.by_season_club_category).map(([k, v]) => { const [se, cl, ca] = k.split('|'); return [se, cl, ca, v] }).sort((x, y) => (`${x[0]}|${x[1]}|${x[2]}` < `${y[0]}|${y[1]}|${y[2]}` ? -1 : 1)).map((r) => r.join(','))].join('\n') + '\n'
      write('coverage-season-club-category.csv', csv)
      write('report.md', report)
      write('run-summary.json', { from, to, archive_sha256: archiveSha, inventory: { raw_records: inv.raw_records, unique_ids: inv.unique_source_transaction_ids, groups: inv.groups, trade_groups: inv.trade_groups }, identity: states, reconciliation: reconciliation.counts, candidates: cand.candidates.length, holds: cand.holds.length, hold_reasons: holdReasons })
      console.log(JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, 'run-summary.json'), 'utf8')), null, 1))
      return 0
    }
    case 'acquisitions': {
      // Non-trade acquisitions (free agent, amateur free agent, waiver, purchase, Rule 5) for one period: candidates, holds and an inventory that also
      // counts what is NOT an acquisition (departures, voids, returns, roster status, draft selections). Local files only.
      const from = Number(args.from ?? 2015); const to = Number(args.to ?? 2015)
      const a = archiveFacts()
      const archiveSha = sha(a.zip)
      if (a.recorded?.sha256 !== archiveSha) throw new Error('the archive does not match its recorded checksum; refusing to process')
      const groups = R.groupRows(a.rows)
      const snapFile = path.resolve(root, args['bai-snapshot'] ?? path.join(outDir, 'bai-snapshot.json'))
      const snap = fs.existsSync(snapFile) ? JSON.parse(fs.readFileSync(snapFile, 'utf8')) : { players: [] }
      const bai = { byMlbam: new Map(snap.players.filter((p) => p.mlbam).map((p) => [p.mlbam, { id: p.id, retro: p.retro }])), byRetro: new Map(snap.players.filter((p) => p.retro).map((p) => [p.retro, { id: p.id, mlbam: p.mlbam }])) }
      const periodRows = R.inSeasons(a.rows, from, to)
      const wanted = new Set(periodRows.filter((r) => r.player.kind === 'RETROSHEET_ID').map((r) => r.player.retro_id))
      const regDir = path.resolve(root, need('register-dir'))
      const resolved = resolveAll(periodRows, indexRegisterByRetro(regDir, wanted), bai)
      const registerCommit = path.basename(regDir)
      const catalog = JSON.parse(fs.readFileSync(path.join(root, 'research/history/sources.json'), 'utf8'))
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/history/manifest.json'), 'utf8'))
      const chadRetrieved = Object.entries(manifest.entries).find(([k]) => k.startsWith('chadwick/'))?.[1]?.retrieved_at?.slice(0, 10) ?? '2026-10-21'
      const keys = sourceKeys(archiveSha, registerCommit)
      const declarations = sourceDeclarations({ archiveSha256: archiveSha, retrievedOn: a.recorded.retrieved_at.slice(0, 10), registerCommit, registerCommitFull: catalog.sources.find((x) => x.id === 'chadwick-register').pinned_commit, registerRetrievedOn: chadRetrieved })
      const out = buildAcquisitionCandidates(groups, resolved, { from, to, declarations, keys, batchKey: `retrosheet-acquisitions-${from}-${to}-${archiveSha.slice(0, 8)}` })
      write('acquisitions-batch.json', prepareAcquisitionText(out.doc))
      write('acquisition-holds.json', { attribution: R.RETROSHEET_ATTRIBUTION, holds: out.holds })
      write('acquisitions-summary.json', { attribution: R.RETROSHEET_ATTRIBUTION, from, to, archive_sha256: archiveSha, candidates: out.candidates, holds: out.holds.length, ...out.inventory })
      console.log(JSON.stringify({ from, to, candidates: out.candidates, holds: out.holds.length, by_class: out.inventory.by_class, hold_reasons: out.inventory.hold_reasons, record_kinds: out.inventory.record_kinds }, null, 1))
      return 0
    }
    default:
      console.error('usage: retrosheet-transactions <archive|snapshot-bai|run|acquisitions> (see the header of this file)')
      return 1
  }
}
function need (k) { if (!args[k] || args[k] === true) throw new Error(`--${k} is required`); return args[k] }
try { process.exit(await main()) } catch (err) { console.error(`error: ${String(err.message).replace(/postgres(ql)?:\/\/\S+/g, '<redacted>')}`); process.exit(1) }
