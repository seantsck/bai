import { PageHeader, DataTable, load, Unavailable } from '../../../components/ui.tsx'
import { getSchools } from '../../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Schools & programs' }

export default async function SchoolsPage () {
  const res = await load(getSchools)
  return (
    <>
      <PageHeader title='Schools & programs' lede='Canonical high school, college, junior college and other programs, with aliases and location.' />
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No schools recorded yet.' columns={[
          { key: 'name', header: 'School / program' },
          { key: 'school_type', header: 'Type' },
          { key: 'city', header: 'City' },
          { key: 'region', header: 'State / region' },
          { key: 'country', header: 'Country' },
          { key: 'tracked_selections', header: 'Tracked selections', numeric: true }
        ]} />
      )}
    </>
  )
}
