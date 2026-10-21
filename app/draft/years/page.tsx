import { PageHeader, SubNav, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getDraftYearCoverage } from '../../../lib/queries.ts'
import { formatDate, label, KIND_LABELS } from '../../../lib/format.ts'
import { DRAFT_NAV } from '../../../lib/nav.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Draft years & coverage' }

export default async function DraftYearsPage () {
  const res = await load(getDraftYearCoverage)
  return (
    <>
      <PageHeader title='Draft years & coverage' lede='Every draft phase on the calendar since 1965, with what BAI holds for it. Counts only: no rates are published.' />
      <SubNav items={DRAFT_NAV} />
      <Notice>A phase is complete only when every club that existed that year has a sourced census. “Expected” stays blank until then: one source&apos;s row count is not proof of the population. Months shown without a day are known only to the month.</Notice>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No drafts recorded yet.' columns={[
          { key: 'draft_year', header: 'Year' },
          { key: 'draft_kind', header: 'Phase', render: (r) => label(KIND_LABELS, r.draft_kind) },
          { key: 'start_date', header: 'Held', render: (r) => r.start_date_precision === 'MONTH' ? formatDate(r.start_date, 'MONTH') : formatDate(r.start_date) },
          { key: 'clubs_with_census', header: 'Clubs with census', numeric: true, render: (r) => `${r.clubs_with_census} / ${r.clubs}` },
          { key: 'expected_selections', header: 'Expected', numeric: true, render: (r) => r.expected_selections ?? 'Not established' },
          { key: 'imported_selections', header: 'Imported', numeric: true },
          { key: 'identities_resolved', header: 'Identities (MLBAM)', numeric: true },
          { key: 'signing_known', header: 'Signing known', numeric: true },
          { key: 'bonus_known', header: 'Bonus known', numeric: true },
          { key: 'outcomes_audited', header: 'Outcomes audited', numeric: true }
        ]} />
      )}
    </>
  )
}
