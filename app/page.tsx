import Link from 'next/link'
import { PageHeader, Stat, Notice, load, Unavailable } from '../components/ui.tsx'
import { getOverview } from '../lib/queries.ts'
import { formatCount, formatDate } from '../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function OverviewPage () {
  const res = await load(getOverview)
  return (
    <>
      <PageHeader title='Baseball Acquisition Intelligence'
        lede='How effectively does each MLB organization acquire, develop, retain, trade and convert amateur talent into organizational value? BAI studies two equal acquisition channels — international signings and the amateur draft — on public data, with explicit coverage and provenance.' />
      {!res.ok ? <Unavailable message={res.message} /> : !res.data ? (
        <Notice>Read models have not been refreshed yet. Run <code>npm run refresh:read-models</code>.</Notice>
      ) : (
        <>
          <div className='stats'>
            <Stat label='Organizations' value={formatCount(res.data.organizations)} />
            <Stat label='Players' value={formatCount(res.data.players)} />
            <Stat label='International signings tracked' value={formatCount(res.data.international_signings)} note={`${formatCount(res.data.international_signing_periods)} signing periods recorded`} />
            <Stat label='Draft selections tracked' value={formatCount(res.data.draft_selections)} note={`${formatCount(res.data.drafts)} drafts recorded`} />
            <Stat label='Coverage assessments' value={formatCount(res.data.coverage_assessments)} note={`${formatCount(res.data.population_rate_scopes)} support population rates`} />
            <Stat label='Sources' value={formatCount(res.data.sources)} />
          </div>
          <p className='lede'>Read model generation {res.data.generation_id}, refreshed {formatDate(res.data.refreshed_at)}. Tracked counts are not complete populations; see <Link href='/research'>Research</Link> for coverage.</p>
        </>
      )}
      <section className='cards'>
        <div className='card'><h3><Link href='/international'>International</Link></h3><p>Signing periods, signings, markets, trainers and academies. Cost components kept separate.</p></div>
        <div className='card'><h3><Link href='/draft'>Draft</Link></h3><p>Drafts, selections and signings as separate facts — unsigned and repeat picks included.</p></div>
        <div className='card'><h3><Link href='/organizations'>Organizations</Link></h3><p>All 30 franchises with stable identities and name history.</p></div>
        <div className='card'><h3><Link href='/research'>Research</Link></h3><p>Methodology, coverage states and what the data can and cannot support.</p></div>
      </section>
    </>
  )
}
