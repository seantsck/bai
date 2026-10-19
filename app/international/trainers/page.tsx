import { PageHeader, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getAcademies, getTrainers } from '../../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Trainers and academies' }

export default async function TrainersPage () {
  const [trainers, academies] = await Promise.all([load(getTrainers), load(getAcademies)])
  return (
    <>
      <PageHeader title='Trainers & academies' lede='Pre-acquisition development network. Only relationships with a source are recorded, marked VERIFIED or REPORTED.' />
      <Notice>A link between a trainer and a player is not evidence that the trainer caused any outcome.</Notice>
      <h2>Trainers</h2>
      {!trainers.ok ? <Unavailable message={trainers.message} /> : (
        <DataTable rows={trainers.data} empty='No trainers recorded yet.' columns={[
          { key: 'name', header: 'Trainer' }, { key: 'country', header: 'Country' }, { key: 'name_basis', header: 'Name basis' },
          { key: 'linked_players', header: 'Linked players', numeric: true }
        ]} />
      )}
      <section>
        <h2>Academies & programs</h2>
        {!academies.ok ? <Unavailable message={academies.message} /> : (
          <DataTable rows={academies.data} empty='No academies recorded yet.' columns={[
            { key: 'name', header: 'Academy' }, { key: 'academy_kind', header: 'Kind' }, { key: 'country', header: 'Country' }, { key: 'city', header: 'City' }
          ]} />
        )}
      </section>
    </>
  )
}
