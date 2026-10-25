// Deterministic local report from the Retrosheet inventory, identity, reconciliation and candidate results. No front-office score
// or ranking: this is an inventory of what the archive supports, with what is missing stated. The attribution statement is mandatory.
import { RETROSHEET_ATTRIBUTION } from './retrosheet-transactions.mjs'

const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')
const n = (v) => Number(v ?? 0).toLocaleString('en-US')
const sorted = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))

export function renderReport ({ archive, inventory: inv, identity, reconciliation: rec, candidates, bai, from, to }) {
  const L = []
  L.push(`# Retrosheet acquisition inventory, ${from}-${to} (local research report)`, '')
  L.push(`> ${RETROSHEET_ATTRIBUTION}`, '')
  L.push('This report inventories what the Retrosheet transactions archive records. It is **not** a census, not a verified-complete record, and contains **no front-office score or ranking**. Retrosheet is one source lineage; none of its transactions is corroborated by this report.', '')
  L.push('## Source', '', `- Archive: ${archive.url}`, `- Archive SHA-256: \`${archive.sha256}\` (${n(archive.bytes)} bytes), retrieved ${archive.retrieved_at} in an earlier phase; no new download was made`,
    `- tran.txt SHA-256: \`${archive.tran_sha256}\`: ${n(archive.tran_rows)} rows, ${n(archive.tran_columns)} fields each; last record dated ${archive.last_record_date}; zip entry modified ${archive.zip_entry_modified}`, '')
  L.push(`## 1. Raw records and groups, ${from}-${to}`, '', table(['Measure', 'Count'], [
    ['Raw Retrosheet records', n(inv.raw_records)], ['Unique source transaction ids', n(inv.unique_source_transaction_ids)],
    ['Ids that appear as more than one group (non-trade ids repeat across unrelated rows)', n(inv.ids_with_several_groups)], ['Transaction groups', n(inv.groups)],
    ['Trade groups (rows sharing an id, including players added or named later)', n(inv.trade_groups)], ['Trade groups with two or more directions', n(inv.trade_groups_two_or_more_directions)],
    ['Rows with a Retrosheet player id', n(inv.retrosheet_id_rows)], ['Rows naming a player without an id (minor leaguers)', n(inv.name_only_player_rows)], ['Rows with no player (cash, picks, PTBNL, slot money)', n(inv.no_player_rows)],
    ['Rows with an unknown or blank type code (kept raw)', n(inv.unclassified_rows)]]), '')
  L.push('### By acquisition class (groups)', '', table(['Class', 'Groups'], sorted(inv.by_class).map(([k, v]) => [k, n(v)])), '')
  L.push('### By category (groups; original codes are kept on every record)', '', table(['Category', 'Groups'], sorted(inv.by_category).map(([k, v]) => [k, n(v)])), '')
  L.push('### By season (groups)', '', table(['Season', 'Groups'], Object.entries(inv.by_season).sort().map(([k, v]) => [k, n(v)])), '')
  L.push('### Records touching each club (rows; a club both sends and receives in a trade)', '', table(['Club', 'Rows'], Object.entries(inv.by_club).sort().map(([k, v]) => [k, n(v)])), '')
  L.push('### Date precision and ordering', '', table(['Item', 'Rows'], [...Object.entries(inv.date_precision_rows).sort().map(([k, v]) => [`precision ${k}`, n(v)]), ['approximate ("@")', n(inv.approximate_date_rows)], ['with a same-day order code', n(inv.same_day_ordered_rows)]]),
    '', 'A "00" day is MONTH precision and has no ISO date; no exact date is ever invented.', '')
  L.push('### Groups with limitations (a group can carry several)', '', table(['Flag', 'Groups'], sorted(inv.group_flag_counts).map(([k, v]) => [k, n(v)])), '')
  L.push('## 2. Identities', '', table(['Retrosheet id outcome', 'Players'], sorted(identity.states).map(([k, v]) => [k, n(v)])), '',
    `Repeat activity (resolved or not): ${n(identity.repeat.players_with_acquisitions)} players with acquisitions; ${n(identity.repeat.repeat_acquisition_players)} acquired more than once; ${n(identity.repeat.multi_organization_players)} acquired by more than one club.`,
    'Players are linked only by Retrosheet id through the pinned Chadwick Register; no name-only link is made, no MLBAM id is invented, and unresolved minor leaguers stay unresolved.', '')
  L.push('## 3. Reconciliation with the trades BAI already holds (read-only)', '', `BAI holds ${n(rec.bai_transactions)} trades (${n(rec.bai_outside_period)} outside ${from}-${to}). No BAI record or id is replaced.`, '',
    table(['Classification', 'Retrosheet trade groups'], Object.entries(rec.counts).map(([k, v]) => [k, n(v)])), '',
    `BAI trades in the period with no Retrosheet counterpart: ${n(rec.bai_in_period_without_retrosheet_counterpart.length)}.`, '')
  L.push('## 4. Local import candidates and holds', '', table(['Item', 'Groups'], [['Stageable trade candidates (version-2 records)', n(candidates.candidates)], ['Held trade groups', n(candidates.holds)]]), '',
    table(['Hold reason', 'Groups'], sorted(candidates.hold_reasons).map(([k, v]) => [k, n(v)])), '',
    'A candidate is staged with one source lineage (independence group `retrosheet-archive`, role REFERENCE). It cannot be marked VERIFIED_COMPLETE on this source: that needs a primary announcement and a second independent group, and a human verification.', '')
  L.push('## 5. What BAI can say about value today', '', `- WAR observations in BAI for the players identified here: ${n(bai.war_players)} players with at least one observation (Baseball-Reference WAR only; its publication permission is still PENDING).`,
    `- Organization value attributions: ${n(bai.attributions)}. Contract, salary and cost data for these transactions: none (no cleared source). Free-agent and waiver contract terms are not in the archive.`,
    '- Therefore this report states no organizational WAR gained or surrendered and no cost.', '')
  L.push('## 6. Limits of the source', '', ...archive.limits.map((s) => `- ${s}`), '')
  L.push('## 7. Future comparison flow (design only)', '',
    '1. **Acquisition-time record**: what the club knew and committed on the date (parties, assets, conditions, cash status, ranking and projection evidence dated before the date). Never edited with hindsight.',
    '2. **Realized outcome record**: per player and provider, value produced for the acquiring club during the acquisition tenure and value that left (023 views), kept apart from section 1.',
    '3. **Channels** compared on the same terms: trade, free agent, draft, international; each with its own cost fields and its own completeness class.',
    '4. **Leadership eras**: executive tenures from sourced records, attributing a decision only on evidence of who made it, never from a job title.',
    '5. Eligibility rules (docs/transactions/04) decide what may be compared; nothing here is ranked.', '')
  return L.join('\n') + '\n'
}
