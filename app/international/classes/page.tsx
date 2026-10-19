import { PageHeader, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getSigningPeriods } from '../../../lib/queries.ts'
import { formatDate } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'International signing classes' }

export default async function ClassesPage () {
  const res = await load(getSigningPeriods)
  return (
    <>
      <PageHeader title='Signing classes' lede='Signing classes are defined by dated signing periods, not by an integer year. Period calendars have shifted over time.' />
      <Notice>Tracked signings are what BAI holds for a period, not the full class. Coverage per period and organization is listed on the Research page.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No signing periods recorded yet.' columns={[
          { key: 'label', header: 'Class' },
          { key: 'start_date', header: 'Opens', render: (r) => formatDate(r.start_date) },
          { key: 'end_date', header: 'Closes', render: (r) => formatDate(r.end_date) },
          { key: 'tracked_signings', header: 'Tracked signings', numeric: true }
        ]} />
      )}
    </>
  )
}
