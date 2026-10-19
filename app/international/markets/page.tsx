import { PageHeader, DataTable, load, Unavailable } from '../../../components/ui.tsx'
import { getMarkets } from '../../../lib/queries.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'International markets' }

export default async function MarketsPage () {
  const res = await load(getMarkets)
  return (
    <>
      <PageHeader title='Markets' lede='Countries / markets where signings occurred. Market is recorded separately from birth country.' />
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No markets recorded yet.' columns={[
          { key: 'name', header: 'Market' },
          { key: 'market_key', header: 'Code' },
          { key: 'region', header: 'Region' },
          { key: 'tracked_signings', header: 'Tracked signings', numeric: true }
        ]} />
      )}
    </>
  )
}
