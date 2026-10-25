import Link from 'next/link'
import { PageHeader, SubNav, DataTable, Notice, Stat, load, Unavailable } from '../../components/ui.tsx'
import { StatusBadge, Attribution } from '../../components/TransactionBits.tsx'
import { getTransactionPage, getTransactionOverview, getAttributionStatements, getOrganizationKeys } from '../../lib/queries.ts'
import { parseTransactionParams, transactionHref, formatTransactionDate, CATEGORY_LABELS, TX_CATEGORIES, TX_STATUSES, STATUS_LABELS, TX_PAGE_SIZE } from '../../lib/transactions.ts'
import { TRANSACTION_NAV } from '../../lib/nav.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Transactions' }

type Search = Record<string, string | string[] | undefined>

export default async function TransactionsPage ({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams
  const f = parseTransactionParams(raw)
  const rawQ = typeof raw.q === 'string' ? raw.q.slice(0, 80) : ''
  const [res, overview, statements, orgs] = await Promise.all([load(() => getTransactionPage(f)), load(getTransactionOverview), load(getAttributionStatements), load(getOrganizationKeys)])
  const rows = res.ok ? res.data.slice(0, TX_PAGE_SIZE) : []
  const hasNext = res.ok && res.data.length > TX_PAGE_SIZE
  const o = overview.ok ? overview.data : null
  const shown = new Set(rows.flatMap((r) => (r.attribution_required ? ['x'] : [])))
  const authorized: string[] = o?.display_authorized_categories ?? []
  const required = statements.ok ? statements.data.filter((s) => authorized.includes(s.attribution_category) || shown.size > 0) : []
  return (
    <>
      <PageHeader title='Transactions' lede='A searchable ledger of reconstructed historical transactions: trades, signings, waiver claims, purchases and Rule 5 selections. Each is shown with what is known, what is not, and where it came from.' />
      <SubNav items={TRANSACTION_NAV} />
      <Attribution statements={required} />
      <Notice>Everything here is a reconstruction from the sources listed on each record. <strong>Partial</strong> means sourced but not verified complete; <strong>Verified complete</strong> appears only after a person has checked a record against two independent sources, and is withdrawn if the record changes. A source being shown here is a separate matter from a record being complete, and neither says a club-season list is complete (see <Link href='/transactions/coverage'>coverage &amp; limitations</Link>). No trade is graded and no winner is named.</Notice>
      {o && (
        <div className='stats'>
          <Stat label='Transactions shown' value={o.transactions} />
          <Stat label='Verified complete' value={o.verified_complete} note='an active human verification' />
          <Stat label='Seasons' value={o.first_season && o.last_season ? `${o.first_season}–${o.last_season}` : '—'} />
        </div>
      )}
      <form className='filters' method='get' action='/transactions'>
        <label>Player or club <input name='q' defaultValue={rawQ} placeholder='Name begins with' maxLength={80} /></label>
        <label>Season <input name='season' defaultValue={f.season ?? ''} inputMode='numeric' pattern='[0-9]{4}' size={5} /></label>
        <label>Club
          <select name='club' defaultValue={f.club ?? ''}>
            <option value=''>All</option>
            {orgs.ok && orgs.data.map((c) => <option key={c.franchise_key} value={c.franchise_key}>{c.current_name}</option>)}
          </select>
        </label>
        <label>Type
          <select name='type' defaultValue={f.category ?? ''}>
            <option value=''>All</option>
            {TX_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </label>
        <label>Reconstruction status
          <select name='status' defaultValue={f.status ?? ''}>
            <option value=''>All</option>
            {TX_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <button type='submit'>Search</button>
      </form>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <>
          <DataTable rows={rows} empty='No transactions match these filters, or none has been published yet.' columns={[
            { key: 'transaction_date', header: 'Date', render: (r) => <Link href={`/transactions/${r.transaction_id}`}>{formatTransactionDate(r.transaction_date, r.date_precision)}</Link> },
            { key: 'category', header: 'Type', render: (r) => CATEGORY_LABELS[r.category] ?? r.category },
            { key: 'parties', header: 'Clubs', render: (r) => (r.parties as Array<{ key: string, name: string, slug: string }>).map((p) => p.key).join(' · ') },
            { key: 'players', header: 'Players', render: (r) => `${r.players ?? '—'}${r.player_count > 4 ? ` +${r.player_count - 4}` : ''}` },
            { key: 'unknowns', header: 'Unresolved', render: (r) => [r.cash_unknown ? 'cash unknown' : null, r.has_unresolved_ptbnl ? 'PTBNL pending' : null].filter(Boolean).join(', ') || '—' },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} verifiedOn={r.verified_on} /> }
          ]} />
          <nav className='pager' aria-label='Pages'>
            {f.page > 1 && <Link href={transactionHref(f, f.page - 1)}>← Newer</Link>}
            <span className='note'>Page {f.page}</span>
            {hasNext && <Link href={transactionHref(f, f.page + 1)}>Older →</Link>}
          </nav>
        </>
      )}
    </>
  )
}
