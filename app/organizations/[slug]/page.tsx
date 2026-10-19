import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PageHeader, DataTable, Stat, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getOrganization, getOrganizationAcquisitions, getOrganizationCoverage, getOrganizationSummary } from '../../../lib/queries.ts'
import { formatCount, formatDate, label, COVERAGE_STATE_LABELS, PATHWAY_LABELS, SIGNING_STATUS_LABELS } from '../../../lib/format.ts'

export const dynamic = 'force-dynamic'

export default async function OrganizationPage ({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const org = await load(() => getOrganization(slug))
  if (!org.ok) return <Unavailable message={org.message} />
  if (!org.data) notFound()
  const o = org.data
  const [summary, acquisitions, coverage] = await Promise.all([
    load(() => getOrganizationSummary(o.id)), load(() => getOrganizationAcquisitions(o.id)), load(() => getOrganizationCoverage(o.id))
  ])
  const s = summary.ok ? summary.data : null
  const coverageLabels = Object.fromEntries(Object.entries(COVERAGE_STATE_LABELS).map(([k, v]) => [k, v.label]))
  return (
    <>
      <PageHeader title={o.current_name} lede={`${o.league} ${o.division} · franchise key ${o.franchise_key}${o.mlb_team_id ? ` · MLBAM team ${o.mlb_team_id}` : ''}`} />
      {s ? (
        <div className='stats'>
          <Stat label='International signings tracked' value={formatCount(s.international_signings)} />
          <Stat label='Draft selections tracked' value={formatCount(s.draft_selections)} note={`${s.draft_signed} signed · ${s.draft_did_not_sign} did not sign · ${s.draft_signing_unknown} not researched`} />
          <Stat label='Audited: reached MLB' value={formatCount(s.audited_reached_mlb)} />
          <Stat label='Audited: no MLB' value={formatCount(s.audited_no_mlb)} />
          <Stat label='Not audited' value={formatCount(s.not_audited)} note='Not counted as failures' />
        </div>
      ) : <Notice>Summary not available until read models are refreshed.</Notice>}

      <section>
        <h2>Name history</h2>
        <DataTable rows={o.names ?? []} empty='No name history recorded.' columns={[
          { key: 'name', header: 'Name' },
          { key: 'first_season', header: 'From', render: (r) => r.first_season ?? 'Before recorded history' },
          { key: 'last_season', header: 'Through', render: (r) => r.last_season ?? 'Current' }
        ]} />
      </section>

      <section>
        <h2>Tracked acquisitions</h2>
        {!acquisitions.ok ? <Unavailable message={acquisitions.message} /> : (
          <DataTable rows={acquisitions.data} empty='No acquisitions tracked yet.' columns={[
            { key: 'display_name', header: 'Player', render: (r) => <Link href={`/players/${r.slug}`}>{r.display_name}</Link> },
            { key: 'channel', header: 'Channel' },
            { key: 'acquisition_date', header: 'Date', render: (r) => formatDate(r.acquisition_date) },
            { key: 'acquisition_kind', header: 'Pathway', render: (r) => r.channel === 'DRAFT' ? 'Draft selection' : label(PATHWAY_LABELS, r.acquisition_kind) },
            { key: 'signing_status', header: 'Draft signing', render: (r) => r.channel === 'DRAFT' ? label(SIGNING_STATUS_LABELS, r.signing_status) : '—' }
          ]} />
        )}
      </section>

      <section>
        <h2>Coverage</h2>
        {!coverage.ok ? <Unavailable message={coverage.message} /> : (
          <DataTable rows={coverage.data} empty='No coverage assessments for this organization yet — treat all counts as incomplete.' columns={[
            { key: 'domain', header: 'Domain' },
            { key: 'scope_key', header: 'Scope' },
            { key: 'coverage_state', header: 'State', render: (r) => label(coverageLabels, r.coverage_state) },
            { key: 'tracked_count', header: 'Tracked', numeric: true },
            { key: 'expected_count', header: 'Expected', numeric: true, render: (r) => r.expected_count ?? 'Unknown' },
            { key: 'supports_population_rate', header: 'Rates supported', render: (r) => r.supports_population_rate ? 'Yes' : 'No' }
          ]} />
        )}
      </section>
    </>
  )
}
