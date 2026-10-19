import { PageHeader, SubNav, DataTable, load, Unavailable } from '../../components/ui.tsx'
import { getDrafts } from '../../lib/queries.ts'
import { formatDate } from '../../lib/format.ts'
import { DRAFT_NAV } from '../../lib/nav.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Draft' }

export default async function DraftPage () {
  const res = await load(getDrafts)
  return (
    <>
      <PageHeader title='MLB amateur draft'
        lede='Players, drafts, selections and signings are separate facts. A player may be selected in several drafts; an unsigned selection remains a valid historical pick; draft structure is recorded per draft rather than assumed.' />
      <SubNav items={DRAFT_NAV} />
      <h2>Drafts</h2>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No drafts recorded yet.' columns={[
          { key: 'draft_year', header: 'Year' },
          { key: 'draft_kind', header: 'Draft' },
          { key: 'start_date', header: 'Began', render: (r) => formatDate(r.start_date) },
          { key: 'recorded_rounds', header: 'Rounds recorded', numeric: true },
          { key: 'tracked_selections', header: 'Tracked selections', numeric: true }
        ]} />
      )}
    </>
  )
}
