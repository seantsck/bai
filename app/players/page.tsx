import Link from 'next/link'
import { PageHeader, DataTable, load, Unavailable } from '../../components/ui.tsx'
import { getPlayers, LIST_LIMIT } from '../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Players' }

export default async function PlayersPage () {
  const res = await load(getPlayers)
  return (
    <>
      <PageHeader title='Players' lede={`Canonical player identities (first ${LIST_LIMIT} by name). One player record spans every acquisition, development, transaction and outcome fact.`} />
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No players recorded yet.' columns={[
          { key: 'display_name', header: 'Player', render: (r) => <Link href={`/players/${r.slug}`}>{r.display_name}</Link> },
          { key: 'primary_position', header: 'Pos' },
          { key: 'birth_country', header: 'Birth country' }
        ]} />
      )}
    </>
  )
}
