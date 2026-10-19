import Link from 'next/link'
import { PageHeader, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getInternationalSignings, LIST_LIMIT } from '../../../lib/queries.ts'
import { formatDate, formatUsd, label, PATHWAY_LABELS } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'International signings' }

export default async function SigningsPage () {
  const res = await load(getInternationalSignings)
  return (
    <>
      <PageHeader title='International signings' lede={`Most recent ${LIST_LIMIT} tracked signings. “Unknown” means the component is not established — it is not $0.`} />
      <Notice>Known total sums only the components that are known; check cost completeness before comparing totals.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No international signings recorded yet.' columns={[
          { key: 'display_name', header: 'Player', render: (r) => <Link href={`/players/${r.slug}`}>{r.display_name}</Link> },
          { key: 'organization_name', header: 'Organization', render: (r) => <Link href={`/organizations/${r.organization_slug}`}>{r.organization_name}</Link> },
          { key: 'period_key', header: 'Period' },
          { key: 'signing_date', header: 'Signed', render: (r) => formatDate(r.signing_date, r.signing_date_precision) },
          { key: 'pathway', header: 'Pathway', render: (r) => label(PATHWAY_LABELS, r.pathway) },
          { key: 'position', header: 'Pos' },
          { key: 'signing_bonus_usd', header: 'Bonus', numeric: true, render: (r) => formatUsd(r.signing_bonus_usd) },
          { key: 'posting_fee_usd', header: 'Posting fee', numeric: true, render: (r) => formatUsd(r.posting_fee_usd) },
          { key: 'known_total_cost_usd', header: 'Known total', numeric: true, render: (r) => formatUsd(r.known_total_cost_usd) },
          { key: 'cost_completeness', header: 'Cost completeness' }
        ]} />
      )}
    </>
  )
}
