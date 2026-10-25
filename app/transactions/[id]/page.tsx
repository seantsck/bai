import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, SubNav, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { StatusBadge, Attribution, PlayerLink } from '../../../components/TransactionBits.tsx'
import { getTransaction, getTransactionAssets, getTransactionSources, getTransactionFollowups, getTransactionReturns, getTransactionPackages, getAttributionStatements } from '../../../lib/queries.ts'
import { statusView, gapLabel, formatTransactionDate, CATEGORY_LABELS, EVIDENCE_LABELS, AMOUNT_LABELS } from '../../../lib/transactions.ts'
import { formatUsd, formatDate } from '../../../lib/format.ts'
import { TRANSACTION_NAV } from '../../../lib/nav.ts'

export const dynamic = 'force-dynamic'

const ASSET_LABELS: Record<string, string> = { PLAYER: 'Player', PLAYER_TO_BE_NAMED: 'Player to be named', CASH: 'Cash', DRAFT_PICK: 'Draft pick', INTERNATIONAL_POOL_SPACE: 'International pool space', OTHER: 'Other' }
const RESOLUTION_LABELS: Record<string, string> = { PLAYER: 'named', CASH: 'settled in cash', NOTHING: 'never named' }

export default async function TransactionPage ({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^\d{1,12}$/.test(id)) notFound()
  const res = await load(() => getTransaction(Number(id)))
  if (!res.ok) return <Unavailable message={res.message} />
  if (!res.data) notFound()
  const t = res.data
  const n = Number(t.transaction_id)
  const [assets, sources, followups, returns, packages, statements] = await Promise.all([load(() => getTransactionAssets(n)), load(() => getTransactionSources(n)), load(() => getTransactionFollowups(n)), load(() => getTransactionReturns(n)), load(() => getTransactionPackages(n)), load(getAttributionStatements)])
  const sv = statusView(t.status, t.verified_on, t.gaps)
  const required = statements.ok ? statements.data.filter((s) => (t.source_categories as string[]).includes(s.attribution_category)) : []
  const parties = t.parties as Array<{ key: string, name: string, slug: string }>
  const nameOf = (k: string | null) => parties.find((p) => p.key === k)?.name ?? k ?? '—'
  const unknowns: string[] = [...(t.gaps as string[]).map(gapLabel)]
  if (t.cash_unknown && !(t.gaps as string[]).includes('CASH_AMOUNT_UNKNOWN')) unknowns.push('A cash amount is not established')
  return (
    <>
      <PageHeader title={`${CATEGORY_LABELS[t.category] ?? t.category}: ${parties.map((p) => p.name).join(' / ')}`}
        lede={`${formatTransactionDate(t.transaction_date, t.date_precision)}${t.date_precision !== 'DAY' ? ' (date not known to the day)' : ''}`} />
      <SubNav items={TRANSACTION_NAV} />
      <Attribution statements={required} />
      <section className='status-panel'>
        <h2>Reconstruction status: <StatusBadge status={t.status} verifiedOn={t.verified_on} gaps={t.gaps} /></h2>
        <p>{sv.detail}</p>
        {sv.tone === 'complete' && t.verified_on && <p className='note'>Verified on {formatDate(t.verified_on)}.</p>}
        {t.independent_source_groups !== undefined && <p className='note'>Independent source groups recorded: {t.independent_source_groups}. One source repeating another counts once.</p>}
      </section>

      <section>
        <h2>Assets</h2>
        {!assets.ok ? <Unavailable message={assets.message} /> : (
          <DataTable rows={assets.data} empty='No assets recorded.' columns={[
            { key: 'from', header: 'From', render: (r) => (r.from_key ? <Link href={`/organizations/${parties.find((p) => p.key === r.from_key)?.slug ?? ''}`}>{nameOf(r.from_key)}</Link> : (r.from_club_text ?? '—')) },
            { key: 'to', header: 'To', render: (r) => (r.to_key ? <Link href={`/organizations/${parties.find((p) => p.key === r.to_key)?.slug ?? ''}`}>{nameOf(r.to_key)}</Link> : '—') },
            { key: 'asset_kind', header: 'Asset', render: (r) => ASSET_LABELS[r.asset_kind] ?? r.asset_kind },
            { key: 'player_name', header: 'Detail', render: (r) => (r.asset_kind === 'PLAYER' ? <PlayerLink slug={r.player_slug} name={r.player_name} /> : (r.detail ?? '—')) },
            { key: 'amount', header: 'Amount', render: (r) => (r.amount_status ? (r.amount_status === 'DISCLOSED' ? formatUsd(r.amount_usd) : AMOUNT_LABELS[r.amount_status]) : '—') },
            { key: 'conditions', header: 'Conditions and resolution', render: (r) => [r.conditional ? `conditional${r.condition_text ? `: ${r.condition_text}` : ''}` : null,
              r.asset_kind === 'PLAYER_TO_BE_NAMED' ? (r.resolution_kind ? `${RESOLUTION_LABELS[r.resolution_kind] ?? r.resolution_kind}${r.resolved_player_name ? `: ${r.resolved_player_name}` : ''} on ${formatDate(r.resolved_on)}` : 'not named in the record') : null,
              r.source_event_code ? `source code ${r.source_event_code}` : null].filter(Boolean).join('; ') || '—' }
          ]} />
        )}
      </section>

      <section>
        <h2>Unknown or unresolved</h2>
        {unknowns.length ? <ul className='gaps'>{unknowns.map((u) => <li key={u}>{u}</li>)}</ul> : <p className='note'>Nothing is listed as unresolved for this record.</p>}
      </section>

      <section>
        <h2>Subsequent movement of these players</h2>
        <p className='note'>Only later transactions recorded in this same ledger. It is not a career history.</p>
        {!followups.ok ? <Unavailable message={followups.message} /> : (
          <DataTable rows={followups.data} empty='No later movement is recorded in this ledger.' columns={[
            { key: 'player_name', header: 'Player', render: (r) => <PlayerLink slug={r.player_slug} name={r.player_name} /> },
            { key: 'later_date', header: 'Later', render: (r) => <Link href={`/transactions/${r.later_transaction_id}`}>{formatDate(r.later_date)}</Link> },
            { key: 'later_category', header: 'Type', render: (r) => CATEGORY_LABELS[r.later_category] ?? r.later_category },
            { key: 'later_club_keys', header: 'Clubs', render: (r) => (r.later_club_keys as string[]).join(' · ') }
          ]} />
        )}
      </section>

      {t.category === 'TRADE' && (
        <section>
          <h2>What each club received (performance evidence)</h2>
          <p className='note'>Observed production of the players a club received, for that club, during the period it held them. Each figure is the club&apos;s total across the whole trade: in a trade with three or more clubs it is not split by trading partner and is never added up per package. It is evidence, not a verdict: no score, grade or winner is derived from it, and providers are never combined. Figures appear only where the provider&apos;s sources may be displayed here.</p>
          {!returns.ok ? <Unavailable message={returns.message} /> : (
            <DataTable rows={returns.data} empty='No performance evidence is recorded.' columns={[
              { key: 'club_key', header: 'Club', render: (r) => nameOf(r.club_key) },
              { key: 'provider', header: 'WAR provider' },
              { key: 'players_received', header: 'Players received (club total)', numeric: true },
              { key: 'return_war_known', header: 'Known WAR (club total)', numeric: true, render: (r) => (r.return_war_known === null ? '—' : Number(r.return_war_known).toFixed(1)) },
              { key: 'evidence', header: 'Evidence', render: (r) => EVIDENCE_LABELS[r.evidence] ?? r.evidence }
            ]} />
          )}
          <h3>Packages</h3>
          <p className='note'>What each club sent to each other club. Counts only; the performance figures above belong to the club, not to a package.</p>
          {!packages.ok ? <Unavailable message={packages.message} /> : (
            <DataTable rows={packages.data} empty='No package is recorded.' columns={[
              { key: 'from_key', header: 'From', render: (r) => nameOf(r.from_key) },
              { key: 'to_key', header: 'To', render: (r) => nameOf(r.to_key) },
              { key: 'players_sent', header: 'Players', numeric: true },
              { key: 'other_assets_sent', header: 'Other assets', numeric: true }
            ]} />
          )}
        </section>
      )}

      <section>
        <h2>Sources</h2>
        {!sources.ok ? <Unavailable message={sources.message} /> : (
          <DataTable rows={sources.data} empty='No source recorded.' columns={[
            { key: 'title', header: 'Source', render: (r) => (r.url ? <a href={r.url}>{r.title}</a> : r.title) },
            { key: 'publisher', header: 'Publisher' },
            { key: 'role', header: 'Role' },
            { key: 'independence_group', header: 'Source group' },
            { key: 'locator', header: 'Where' }
          ]} />
        )}
        <Notice>Sources are credited on <Link href='/sources'>sources &amp; methodology</Link>. Crediting a source is not a statement that the record is complete.</Notice>
      </section>
    </>
  )
}
