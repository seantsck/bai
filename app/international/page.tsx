import { PageHeader, SubNav, DataTable, load, Unavailable } from '../../components/ui.tsx'
import { getSigningPeriods } from '../../lib/queries.ts'
import { formatDate } from '../../lib/format.ts'
import { INTERNATIONAL_NAV } from '../../lib/nav.ts'

export const dynamic = 'force-dynamic'

export default async function InternationalPage () {
  const res = await load(getSigningPeriods)
  return (
    <>
      <PageHeader title='International acquisition'
        lede='International amateur signings, posted players and other international professionals — kept as distinct pathways. Signing periods are stored as explicit date ranges; costs (bonus, posting fee, transfer fee, other) are separate and unknown is never zero.' />
      <SubNav items={INTERNATIONAL_NAV} />
      <h2>Signing periods</h2>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No signing periods recorded yet.' columns={[
          { key: 'period_key', header: 'Period' },
          { key: 'start_date', header: 'Opens', render: (r) => formatDate(r.start_date) },
          { key: 'end_date', header: 'Closes', render: (r) => formatDate(r.end_date) },
          { key: 'tracked_signings', header: 'Tracked signings', numeric: true }
        ]} />
      )}
    </>
  )
}
