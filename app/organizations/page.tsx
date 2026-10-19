import Link from 'next/link'
import { PageHeader, DataTable, Notice, load, Unavailable } from '../../components/ui.tsx'
import { getOrganizationSummaries } from '../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Organizations' }

export default async function OrganizationsPage () {
  const res = await load(getOrganizationSummaries)
  return (
    <>
      <PageHeader title='Organizations' lede='All 30 MLB franchises. Identities are stable across renames; counts come from the bounded read model.' />
      <Notice>Counts are what BAI tracks, not complete populations. Outcome columns partition tracked players by audit state; “not audited” is not a failure.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='Read models have not been refreshed yet. Run npm run refresh:read-models.' columns={[
          { key: 'name', header: 'Organization', render: (r) => <Link href={`/organizations/${r.slug}`}>{r.name}</Link> },
          { key: 'league', header: 'Lg' },
          { key: 'division', header: 'Div' },
          { key: 'international_signings', header: 'Intl signings', numeric: true },
          { key: 'draft_selections', header: 'Draft picks', numeric: true },
          { key: 'draft_signed', header: 'Signed', numeric: true },
          { key: 'audited_reached_mlb', header: 'Reached MLB (audited)', numeric: true },
          { key: 'audited_no_mlb', header: 'No MLB (audited)', numeric: true },
          { key: 'not_audited', header: 'Not audited', numeric: true },
          { key: 'population_rate_scopes', header: 'Rate-ready scopes', numeric: true }
        ]} />
      )}
    </>
  )
}
