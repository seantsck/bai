import { PageHeader, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getDrafts } from '../../../lib/queries.ts'
import { formatDate } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Draft years' }

export default async function DraftYearsPage () {
  const res = await load(getDrafts)
  return (
    <>
      <PageHeader title='Draft years' lede='Each draft carries its own structure: rounds, phases (compensation, competitive balance) and dates.' />
      <Notice>Round counts and pick numbering have changed across eras; BAI records the published structure of each draft.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No drafts recorded yet.' columns={[
          { key: 'draft_key', header: 'Draft' },
          { key: 'start_date', header: 'Began', render: (r) => formatDate(r.start_date) },
          { key: 'end_date', header: 'Ended', render: (r) => formatDate(r.end_date) },
          { key: 'total_rounds', header: 'Published rounds', numeric: true, render: (r) => r.total_rounds ?? 'Unknown' },
          { key: 'recorded_rounds', header: 'Rounds recorded', numeric: true },
          { key: 'tracked_selections', header: 'Tracked selections', numeric: true }
        ]} />
      )}
    </>
  )
}
