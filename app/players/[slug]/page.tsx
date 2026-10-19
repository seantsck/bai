import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, DataTable, load, Unavailable } from '../../../components/ui.tsx'
import { getPlayer, getPlayerAcquisitions, getPlayerDevelopment, getPlayerExternalIds } from '../../../lib/queries.ts'
import { formatDate, formatWar, label, AUDIT_STATE_LABELS, PATHWAY_LABELS, SIGNING_STATUS_LABELS } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function PlayerPage ({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const res = await load(() => getPlayer(slug))
  if (!res.ok) return <Unavailable message={res.message} />
  if (!res.data) notFound()
  const p = res.data
  const [acq, dev, ids] = await Promise.all([load(() => getPlayerAcquisitions(p.id)), load(() => getPlayerDevelopment(p.id)), load(() => getPlayerExternalIds(p.id))])
  return (
    <>
      <PageHeader title={p.display_name} lede={[p.primary_position, p.birth_country].filter(Boolean).join(' · ') || undefined} />
      <dl className='facts'>
        <dt>Born</dt><dd>{formatDate(p.birth_date, p.birth_date_precision)}</dd>
        <dt>Outcome audit</dt><dd>{label(AUDIT_STATE_LABELS, p.audit_state)}{p.observation_through_season ? ` (observed through ${p.observation_through_season})` : ''}</dd>
        <dt>MLB debut</dt><dd>{p.debut_date ? <>{formatDate(p.debut_date)} with <Link href={`/organizations/${p.debut_organization_slug}`}>{p.debut_organization_name}</Link></> : (p.audit_state === 'AUDITED_NO_MLB' ? 'None observed' : 'Not established')}</dd>
        <dt>Career bWAR</dt><dd>{formatWar(p.career_bwar)}{p.career_bwar_through_season ? ` (through ${p.career_bwar_through_season})` : ''}</dd>
        {ids.ok && ids.data.length > 0 && <><dt>External ids</dt><dd>{ids.data.map((i) => `${i.id_system} ${i.external_id}`).join(' · ')}</dd></>}
      </dl>

      <section>
        <h2>Acquisitions</h2>
        {!acq.ok ? <Unavailable message={acq.message} /> : (
          <DataTable rows={acq.data} empty='No acquisitions tracked.' columns={[
            { key: 'channel', header: 'Channel' },
            { key: 'organization_name', header: 'Organization', render: (r) => <Link href={`/organizations/${r.organization_slug}`}>{r.organization_name}</Link> },
            { key: 'acquisition_date', header: 'Date', render: (r) => formatDate(r.acquisition_date) },
            { key: 'acquisition_kind', header: 'Pathway', render: (r) => r.channel === 'DRAFT' ? 'Draft selection' : label(PATHWAY_LABELS, r.acquisition_kind) },
            { key: 'signing_status', header: 'Draft signing', render: (r) => r.channel === 'DRAFT' ? label(SIGNING_STATUS_LABELS, r.signing_status) : '—' }
          ]} />
        )}
      </section>

      <section>
        <h2>Development chronology</h2>
        {!dev.ok ? <Unavailable message={dev.message} /> : (
          <DataTable rows={dev.data} empty='No assignments recorded.' columns={[
            { key: 'season', header: 'Season' },
            { key: 'sort_date', header: 'Date', render: (r) => formatDate(r.sort_date) },
            { key: 'entry_kind', header: 'Entry' },
            { key: 'level', header: 'Level' },
            { key: 'organization_name', header: 'Organization' },
            { key: 'games', header: 'G', numeric: true, render: (r) => r.games ?? '—' }
          ]} />
        )}
      </section>
    </>
  )
}
