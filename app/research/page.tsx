import { PageHeader, DataTable, load, Unavailable, Notice } from '../../components/ui.tsx'
import { CoverageMatrix } from '../../components/CoverageMatrix.tsx'
import { getResearchCoverage, getResearchQueueSummary } from '../../lib/queries.ts'
import { formatDate, formatShare, label, COVERAGE_STATE_LABELS, COVERAGE_STATE_CODES, AUDIT_STATE_LABELS } from '../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Research' }

const PRINCIPLES = [
  ['Public data only', 'Every researched fact cites a publicly accessible source.'],
  ['Missing is not zero', 'Unknown bonuses, fees and WAR stay unknown; totals sum only known components.'],
  ['Unaudited is not failed', 'Only audited outcomes enter reach-rate denominators.'],
  ['Tracked is not the complete population', 'Rates require complete-census or substantially-complete coverage.'],
  ['No hindsight', 'Acquisition-time expectations use only evidence published before the acquisition.'],
  ['Conflicts are kept', 'Disagreeing sources are all recorded; a canonical value records which evidence and which rule or researcher chose it.'],
  ['No unsupported claims', 'BAI publishes no causal or predictive claims the evidence cannot support.']
]

const DETAIL_COLUMNS = [
  { key: 'scope_label', header: 'Scope' },
  { key: 'organization_name', header: 'Organization' },
  { key: 'coverage_state', header: 'Coverage', render: (r: Record<string, any>) => r.coverage_state ? label(Object.fromEntries(Object.entries(COVERAGE_STATE_LABELS).map(([k, v]) => [k, v.label])), r.coverage_state) : 'Not assessed' },
  { key: 'tracked_records', header: 'Tracked', numeric: true },
  { key: 'expected_count', header: 'Expected', numeric: true, render: (r: Record<string, any>) => r.expected_count ?? 'Unknown' },
  { key: 'audited_outcomes', header: 'Audited outcomes', numeric: true },
  { key: 'cost', header: 'Known cost', numeric: true, render: (r: Record<string, any>) => formatShare(r.cost_known_records, r.cost_basis_records) },
  { key: 'last_research_date', header: 'Last research', render: (r: Record<string, any>) => r.last_research_date ? formatDate(r.last_research_date) : '—' },
  { key: 'supports_population_rate', header: 'Rates', render: (r: Record<string, any>) => r.supports_population_rate ? 'Allowed' : 'Blocked' }
]

export default async function ResearchPage () {
  const [coverage, queues] = await Promise.all([load(getResearchCoverage), load(getResearchQueueSummary)])
  const cells = coverage.ok ? coverage.data : []
  const draft = cells.filter((c) => c.domain === 'DRAFT')
  const intl = cells.filter((c) => c.domain === 'INTERNATIONAL')
  const active = cells.filter((c) => c.tracked_records > 0 || c.coverage_state)
  return (
    <>
      <PageHeader title='Research' lede='Coverage, open research work, and the limits of what BAI data can support.' />

      <section>
        <h2>Coverage dashboard</h2>
        <Notice>
          Cells show the coverage state and the number of tracked records. A blank cell means nothing is tracked yet. No hit rates are shown:
          only complete-census or substantially-complete cells could support them, and none do yet. Counts come from the last read-model refresh.
        </Notice>
        <p className='legend'>
          {Object.entries(COVERAGE_STATE_CODES).filter(([k]) => k !== 'UNKNOWN').map(([k, code]) => (
            <span key={k} className={`legend-item cell-${code}`}><b>{code}</b> {COVERAGE_STATE_LABELS[k].label}</span>
          ))}
          <span className='legend-item cell-NA'><b>NA</b> Records, not assessed</span>
        </p>
        {!coverage.ok ? <Unavailable message={coverage.message} /> : (
          <>
            <h3>Draft coverage by year and organization</h3>
            <CoverageMatrix cells={draft} caption='Rule 4 draft classes, 2015–2026' />
            <h3>International coverage by signing period and organization</h3>
            <CoverageMatrix cells={intl} caption='International signing periods (date ranges, not calendar years)' />
            <h3>Cells with records</h3>
            <DataTable rows={active} empty='Nothing tracked yet. Every count should be read as incomplete.' columns={[{ key: 'domain', header: 'Channel' }, ...DETAIL_COLUMNS]} />
          </>
        )}
      </section>

      <section>
        <h2>Research queues</h2>
        <p className='lede'>Open work by type. Priorities are a fixed, documented ordering (1 blocks correct canonical data, 5 is enrichment), not a model score. Item lists are internal.</p>
        {!queues.ok ? <Unavailable message={queues.message} /> : (
          <DataTable rows={queues.data} empty='No queue counts yet; run the read-model refresh.' columns={[
            { key: 'priority', header: 'Priority', numeric: true },
            { key: 'queue_key', header: 'Queue' },
            { key: 'description', header: 'What it holds' },
            { key: 'open_items', header: 'Open', numeric: true }
          ]} />
        )}
      </section>

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
    </>
  )
}
