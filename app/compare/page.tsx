import Link from 'next/link'
import { PageHeader, DataTable, Notice, load, Unavailable } from '../../components/ui.tsx'
import { getOrganizationSummaries } from '../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Compare' }

export default async function ComparePage () {
  const res = await load(getOrganizationSummaries)
  return (
    <>
      <PageHeader title='Compare organizations' lede='Side-by-side tracked counts across both channels.' />
      <Notice tone='warn'>Comparisons of rates are shown only when coverage for both sides is a complete census or substantially complete. Until those assessments exist, this page compares tracked counts only — they reflect research coverage as much as organizational behavior, and support no causal or predictive claim.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='Read models have not been refreshed yet.' columns={[
          { key: 'name', header: 'Organization', render: (r) => <Link href={`/organizations/${r.slug}`}>{r.name}</Link> },
          { key: 'international_signings', header: 'Intl tracked', numeric: true },
          { key: 'draft_selections', header: 'Draft tracked', numeric: true },
          { key: 'acquired_players', header: 'Players', numeric: true },
          { key: 'coverage_assessments', header: 'Coverage rows', numeric: true },
          { key: 'population_rate_scopes', header: 'Rate-ready scopes', numeric: true }
        ]} />
      )}
    </>
  )
}
