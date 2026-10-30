// Fixtures for the promotion tests (migration 032). Every row is FICTIONAL (years 2029-2030, MLBAM 9530xx / 9890xxx). A small baseline stands in for the hosted database
// (existing players, two existing MLB-sourced trades that must stay withheld, the single RETROSHEET grant of G4-C); importSample() stands in for the six pinned batches.
import fs from 'node:fs'
import path from 'node:path'
import * as P from '../../scripts/research/lib/pipeline.mjs'
import * as T from '../../scripts/research/lib/transactions.mjs'
import { prepareAcquisitionDoc } from '../../scripts/research/lib/acquisitions.mjs'

export const CHADWICK = { source_key: 'hist:chadwick-register-abc1234', source_type: 'REFERENCE_DATABASE', authority_level: 'AGGREGATOR', title: 'Chadwick register, fixture commit', publisher: 'Chadwick Baseball Bureau', url: 'https://github.com/chadwickbureau/register/tree/abc1234', retrieved_date: '2026-10-22' }
export const RETRO = { source_key: 'hist:retrosheet-g54000001', source_type: 'REFERENCE_DATABASE', authority_level: 'REPUTABLE_SECONDARY', title: 'Retrosheet transactions database (tranDB.zip)', publisher: 'Retrosheet', url: 'https://www.retrosheet.org/transactions/tranDB.zip', retrieved_date: '2026-10-22' }
export const MLB = { source_key: 'rm:mlb-g54', source_type: 'OFFICIAL_LEAGUE', authority_level: 'OFFICIAL', title: 'MLB transactions (fixture)', publisher: 'MLB Advanced Media', url: 'https://statsapi.mlb.com/api/v1/transactions', retrieved_date: '2026-10-22' }
export const GRANT = { basis: 'fixture: owner-recorded basis (G4-B)', scope: 'fixture: category-wide RETROSHEET; review due 2027-01-22' }

const rec = (n, date, player) => ({ type: 'ACQUISITION', schema: 1, ref: `g54-${n}`, organization: 'LAD', acquisition_class: 'FREE_AGENT', transaction_type: 'FREE_AGENT_SIGNING', date, date_precision: 'DAY', source_key: RETRO.source_key,
  sources: [{ source_key: RETRO.source_key, role: 'REFERENCE', independence_group: 'retrosheet-archive', locator: `line ${n}` }], external_ids: [{ scheme: 'RETROSHEET_TXN', id: `g54${n}@${date}`, source_key: RETRO.source_key }],
  move: { player: { full_name: `Stage Player ${n}`, source_key: RETRO.source_key, external_ids: { MLBAM: String(953000 + n), RETROSHEET: `g54p${String(n).padStart(3, '0')}` }, external_id_sources: { MLBAM: CHADWICK.source_key, RETROSHEET: CHADWICK.source_key }, birth_date: '1991-04-12', ...player }, to_organization: 'LAD', source_event_code: 'F', source_info: null } })
export const pl = (n, name, ext) => ({ full_name: name ?? `Trade Player ${n}`, external_ids: ext ?? { MLBAM: String(9890000 + n) } })
export const pk = (from, to, players, keys) => ({ from, to, source_keys: keys, players: players.map((p) => ({ player: p, source_keys: keys })), other_assets: [] })
export const rg = (k) => ({ source_key: k, role: 'REFERENCE', independence_group: `g-${k}` })
export const tradeDoc = (key, ref, date, sourceDecls, packages, ext, groups) => T.prepareTradeDoc({ format: 'bai-research-import/1', batch_key: key, channel: 'TRADES', sources: sourceDecls, records: [{ type: 'TRADE', schema: 2, ref, organization: packages[0].from, date, source_key: groups[0].source_key, sources: groups, packages, external_ids: [{ scheme: 'MLB_TXN', id: ext }] }] })

/** Stages, validates and applies one document; the file lives at a fixed path so that two stagings of the same sample are byte-identical records. */
export async function stageAndApply (db, doc, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(doc))
  const { batch } = await P.stageFile(db, file, {}); const v = await P.validateBatch(db, batch.id)
  if (!v.ok) throw new Error('invalid sample ' + JSON.stringify(v))
  return P.applyBatch(db, batch.id, { write: true })
}

/** The hosted stand-in, at migration 030: call applyMigrations(db) afterwards to add 032 (the "migration" under test). */
export async function buildBaseline (db, dir) {
  await db.query(`insert into sources (source_key, source_type, authority_level, title, publisher, url, retrieved_date) values ($1,$2,$3,$4,$5,$6,$7)`, [CHADWICK.source_key, CHADWICK.source_type, CHADWICK.authority_level, CHADWICK.title, CHADWICK.publisher, CHADWICK.url, CHADWICK.retrieved_date])
  await db.query("insert into sources (source_key, source_type, authority_level, title, reference) values ('g54:base', 'REFERENCE_DATABASE', 'OTHER', 'Fixture base', 'fixture')")
  for (let i = 1; i <= 3; i++) await db.query('insert into players (slug, full_name, display_name) values ($1, $2, $2)', [`g54-base-${i}`, `Base Player ${i}`])
  await db.query("insert into players (slug, full_name, display_name) values ('g54-existing', 'Existing Player', 'Existing Player')")
  await db.query("insert into player_external_ids (player_id, id_system, external_id, source_id) select p.id, 'MLBAM', '988100', s.id from players p, sources s where p.slug = 'g54-existing' and s.source_key = 'g54:base'")
  await stageAndApply(db, tradeDoc('g54-base-mlb-1', 'g54-m1', '2029-05-01', [MLB], [pk('HOU', 'TEX', [pl(3)], [MLB.source_key]), pk('TEX', 'HOU', [pl(4)], [MLB.source_key])], 'G54-M1', [rg(MLB.source_key)]), path.join(dir, 'baseline', 'mlb-1.json'))
  await stageAndApply(db, tradeDoc('g54-base-mlb-2', 'g54-m2', '2029-05-02', [MLB], [pk('ATL', 'MIA', [pl(5)], [MLB.source_key]), pk('MIA', 'ATL', [pl(6)], [MLB.source_key])], 'G54-M2', [rg(MLB.source_key)]), path.join(dir, 'baseline', 'mlb-2.json'))
  // an existing MLB-sourced transaction_date observation (the hosted database has 65): it must be untouched by the Retrosheet exclusion rule
  await db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator)
    select s.id, 'transactions', (select min(id) from transactions), 'transaction_date', to_jsonb('2029-05-01'::text), 'baseline' from sources s where s.source_key = $1 on conflict do nothing`, [MLB.source_key])
  // the single RETROSHEET grant recorded on hosted by G4-C (no Retrosheet rows exist yet)
  await db.query("insert into ingest.source_publication_grants (attribution_category, basis_reference, scope_note) values ('RETROSHEET', $1, $2)", [GRANT.basis, GRANT.scope])
  await db.query('select public.refresh_read_models()'); await db.query('select public.refresh_transaction_read_models()')
}

/** The stand-in for the pinned batches: an acquisitions batch (four new players and new ids on the existing one) and two trade batches, then Retrosheet transaction_date observations
 *  (the kind the owner excludes from the public delta). Returns the batches as the manifest must pin them. */
export async function importSample (db, dir) {
  await stageAndApply(db, prepareAcquisitionDoc({ format: 'bai-research-import/1', batch_key: 'g54-sample-acq', channel: 'ACQUISITIONS', sources: [RETRO, CHADWICK], records: [rec(1, '2030-03-01'), rec(2, '2030-03-02'), rec(3, '2030-03-03'), rec(4, '2030-03-04'),
    rec(5, '2030-03-05', { full_name: 'Existing Player', external_ids: { MLBAM: '988100', RETROSHEET: 'g54x001', BBREF: 'existp01' }, external_id_sources: { MLBAM: CHADWICK.source_key, RETROSHEET: CHADWICK.source_key, BBREF: CHADWICK.source_key }, birth_date: undefined })] }), path.join(dir, 'sample', 'acq.json'))
  await stageAndApply(db, tradeDoc('g54-sample-trades-1', 'g54-t1', '2030-06-01', [RETRO], [pk('LAD', 'SEA', [pl(11)], [RETRO.source_key]), pk('SEA', 'LAD', [pl(12, 'Existing Player', { MLBAM: '988100' })], [RETRO.source_key])], 'G54-T1', [rg(RETRO.source_key)]), path.join(dir, 'sample', 'trades-1.json'))
  await stageAndApply(db, tradeDoc('g54-sample-trades-2', 'g54-t2', '2030-06-02', [RETRO], [pk('NYY', 'BOS', [pl(13)], [RETRO.source_key]), pk('BOS', 'NYY', [pl(14)], [RETRO.source_key])], 'G54-T2', [rg(RETRO.source_key)]), path.join(dir, 'sample', 'trades-2.json'))
  await db.query(`insert into source_observations (source_id, subject_table, subject_id, field_name, observed_value, locator)
    select s.id, 'transactions', t.id, 'transaction_date', to_jsonb(t.transaction_date::text), 'tranDB fixture' from transactions t join sources s on s.id = t.source_id where s.attribution_category = 'RETROSHEET' on conflict do nothing`)
  return (await db.query("select batch_key as name, file_sha256 as sha256 from ingest.import_batches where batch_key like 'g54-sample-%' order by batch_key")).rows
}
