import Link from 'next/link'
import { PageHeader, SubNav, DataTable, Notice, Stat, load, Unavailable } from '../../../components/ui.tsx'
import { Attribution } from '../../../components/TransactionBits.tsx'
import { getTransactionOverview, getTransactionSeasonTotals, getTransactionClubSeasons, getAttributionStatements } from '../../../lib/queries.ts'
import { CATEGORY_LABELS } from '../../../lib/transactions.ts'
import { TRANSACTION_NAV } from '../../../lib/nav.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Transaction coverage' }

const STATE_MARK: Record<string, string> = { COMPLETE_CENSUS: 'C', SUBSTANTIALLY_COMPLETE: 'S', PARTIAL_RECONSTRUCTION: 'P', RANKED_SAMPLE: 'R', INDIVIDUALLY_VERIFIED: 'V', NOT_ASSESSED: '' }

export default async function TransactionCoveragePage () {
  const [ov, seasons, clubSeasons, statements] = await Promise.all([load(getTransactionOverview), load(getTransactionSeasonTotals), load(getTransactionClubSeasons), load(getAttributionStatements)])
  const o = ov.ok ? ov.data : null
  const authorized: string[] = o?.display_authorized_categories ?? []
  const required = statements.ok ? statements.data.filter((s) => !o || authorized.includes(s.attribution_category)) : []   // totals unavailable: credit every source rather than none
  const years = clubSeasons.ok ? [...new Set(clubSeasons.data.map((r) => Number(r.season)))].sort((a, b) => b - a) : []
  const clubs = clubSeasons.ok ? [...new Set(clubSeasons.data.map((r) => r.club_key as string))].sort() : []
  const cell = new Map((clubSeasons.ok ? clubSeasons.data : []).map((r) => [`${r.season}|${r.club_key}`, r]))
  return (
    <>
      <PageHeader title='Transaction coverage and limitations' lede='What the transaction ledger holds, how complete each part is, and what it cannot say.' />
      <SubNav items={TRANSACTION_NAV} />
      <Attribution statements={required} />
      <section>
        <h2>Three different statements</h2>
        <div className='cards'>
          <div className='card'><h3>A source may be displayed</h3><p>A recorded permission basis lets BAI show records from that source. It says nothing about whether any record or club-season is complete. Records whose sources are not yet cleared are withheld{o ? ` (${o.withheld_unauthorized} withheld from this ledger)` : ''}.</p></div>
          <div className='card'><h3>A transaction is verified complete</h3><p>A person checked every party and asset against two independent sources, and the verification is still current. One source repeating another does not count twice. Verified: {o ? o.verified_complete : '—'}.</p></div>
          <div className='card'><h3>A club-season is a complete census</h3><p>Every transaction of the club in that season is known, with the expected number established from a source. Club-seasons with this state: {o ? o.complete_census_club_seasons : '—'}.</p></div>
        </div>
      </section>
      {ov.ok && !o && <Notice tone='warn'>The totals on this page are being refreshed after a change to the record set (a permission, a verification or a record changed). Nothing is shown from the earlier counts, so none can be stale.</Notice>}
      {o && (
        <div className='stats'>
          <Stat label='Transactions shown' value={o.transactions} />
          <Stat label='Partial' value={o.by_status?.PARTIAL ?? 0} note='sourced, not verified complete' />
          <Stat label='Unverified' value={o.by_status?.UNVERIFIED ?? 0} />
          <Stat label='Verified complete' value={o.verified_complete} />
        </div>
      )}
      <Notice tone='warn'>Tracked is not the complete population. The reconstruction comes from one published archive (see the attribution above) that does not say what it leaves out. Contract terms, salaries, cash amounts and service time are not recorded and are never estimated. Minor leaguers named without an identifier are not matched to players by name; transactions involving them are held back.</Notice>
      {o && (
        <section>
          <h2>By type</h2>
          <DataTable rows={Object.entries(o.by_category ?? {}).map(([k, v]) => ({ category: k, records: v }))} empty='Nothing published yet.' columns={[
            { key: 'category', header: 'Type', render: (r) => CATEGORY_LABELS[r.category] ?? r.category },
            { key: 'records', header: 'Transactions', numeric: true }
          ]} />
        </section>
      )}
      <section>
        <h2>By season</h2>
        {!seasons.ok ? <Unavailable message={seasons.message} /> : (
          <DataTable rows={seasons.data} empty='Nothing published yet.' columns={[
            { key: 'season', header: 'Season' }, { key: 'records', header: 'Transactions', numeric: true }, { key: 'partial', header: 'Partial', numeric: true },
            { key: 'unverified', header: 'Unverified', numeric: true }, { key: 'verified_complete', header: 'Verified complete', numeric: true }
          ]} />
        )}
      </section>
      <section>
        <h2>By club and season</h2>
        <p className='note'>Each cell is the number of transactions BAI shows for that club and season (a trade counts for both clubs). A letter marks a recorded population assessment: P = partial reconstruction, C = complete census. No letter means no assessment, not an empty season.</p>
        {!clubSeasons.ok ? <Unavailable message={clubSeasons.message} /> : years.length === 0 ? <p className='empty'>Nothing published yet.</p> : (
          <div className='table-wrap'>
            <table className='matrix'>
              <thead><tr><th scope='col'>Club</th>{years.map((y) => <th key={y} scope='col' className='cell'>{y}</th>)}</tr></thead>
              <tbody>
                {clubs.map((c) => (
                  <tr key={c}><th scope='row'>{c}</th>
                    {years.map((y) => { const r = cell.get(`${y}|${c}`); return <td key={y} className='cell'>{r ? <>{r.records}<span className='cell-code'>{STATE_MARK[r.coverage_state] ?? ''}</span></> : ''}</td> })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className='note'>Method and sources: <Link href='/sources'>sources &amp; methodology</Link>. Draft and international acquisitions have their own coverage on <Link href='/research'>research coverage</Link>.</p>
    </>
  )
}
