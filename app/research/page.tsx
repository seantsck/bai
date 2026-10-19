import { PageHeader, DataTable, load, Unavailable } from '../../components/ui.tsx'
import { getCoverageSummary } from '../../lib/queries.ts'
import { formatDate, label, COVERAGE_STATE_LABELS, AUDIT_STATE_LABELS } from '../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Research' }

const PRINCIPLES = [
  ['Public data only', 'Every researched fact cites a publicly accessible source.'],
  ['Missing is not zero', 'Unknown bonuses, fees and WAR stay unknown; totals sum only known components.'],
  ['Unaudited is not failed', 'Only audited outcomes enter reach-rate denominators.'],
  ['Tracked is not the complete population', 'Rates require complete-census or substantially-complete coverage.'],
  ['No hindsight', 'Acquisition-time expectations use only evidence published before the acquisition.'],
  ['Value is separated', 'Career value, organization-realized value, trade value and value that left are kept apart and never double counted.'],
  ['No unsupported claims', 'BAI publishes no causal or predictive claims the evidence cannot support.']
]

export default async function ResearchPage () {
  const res = await load(getCoverageSummary)
  const coverageLabels = Object.fromEntries(Object.entries(COVERAGE_STATE_LABELS).map(([k, v]) => [k, v.label]))
  return (
    <>
      <PageHeader title='Research' lede='Methodology, coverage and the limits of what BAI data can support.' />
      <section className='cards'>
        {PRINCIPLES.map(([t, d]) => <div className='card' key={t}><h3>{t}</h3><p>{d}</p></div>)}
      </section>
      <section>
        <h2>Coverage states</h2>
        <DataTable rows={Object.entries(COVERAGE_STATE_LABELS).map(([key, v]) => ({ key, ...v }))} empty='' columns={[
          { key: 'label', header: 'State' }, { key: 'description', header: 'Meaning' },
          { key: 'supportsRates', header: 'Population rates', render: (r) => r.supportsRates ? 'Supported' : 'Not supported' }
        ]} />
      </section>
      <section>
        <h2>Outcome audit states</h2>
        <DataTable rows={Object.entries(AUDIT_STATE_LABELS).map(([key, l]) => ({ key, l }))} empty='' columns={[
          { key: 'key', header: 'State' }, { key: 'l', header: 'Label' }
        ]} />
      </section>
      <section>
        <h2>Coverage assessments</h2>
        {!res.ok ? <Unavailable message={res.message} /> : (
          <DataTable rows={res.data} empty='No coverage assessments yet. Every tracked count should be read as incomplete.' columns={[
            { key: 'domain', header: 'Domain' },
            { key: 'scope_key', header: 'Scope' },
            { key: 'organization_name', header: 'Organization', render: (r) => r.organization_name ?? 'League-wide' },
            { key: 'coverage_state', header: 'State', render: (r) => label(coverageLabels, r.coverage_state) },
            { key: 'tracked_count', header: 'Tracked', numeric: true },
            { key: 'expected_count', header: 'Expected', numeric: true, render: (r) => r.expected_count ?? 'Unknown' },
            { key: 'assessed_on', header: 'Assessed', render: (r) => formatDate(r.assessed_on) }
          ]} />
        )}
      </section>
    </>
  )
}
