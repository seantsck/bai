import Link from 'next/link'
import { PageHeader, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getDraftPicks, LIST_LIMIT } from '../../../lib/queries.ts'
import { formatUsd, label, SIGNING_STATUS_LABELS } from '../../../lib/format.ts'
import { editorialNote, ABSENCE_STATEMENT } from '../../../lib/partial-years.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Draft picks' }

export default async function PicksPage () {
  const res = await load(getDraftPicks)
  const note = res.ok ? editorialNote(res.data.map((r) => r.draft_year)) : null
  return (
    <>
      <PageHeader title='Draft picks' lede={`Most recent ${LIST_LIMIT} tracked selections.`} />
      <Notice>“Not researched” means no signing evidence has been recorded — it is not the same as “Did not sign”. Some years are published only in part (see <Link href='/draft/years'>draft years &amp; coverage</Link>). {ABSENCE_STATEMENT}</Notice>
      {res.ok && note && <Notice>{note}</Notice>}
      {!res.ok ? <Unavailable message={res.message} /> : (
        <DataTable rows={res.data} empty='No draft selections recorded yet.' columns={[
          { key: 'draft_year', header: 'Year' },
          { key: 'round_code', header: 'Round' },
          { key: 'overall_pick', header: 'Overall', numeric: true },
          { key: 'display_name', header: 'Player', render: (r) => <Link href={`/players/${r.slug}`}>{r.display_name}</Link> },
          { key: 'organization_name', header: 'Organization', render: (r) => <Link href={`/organizations/${r.organization_slug}`}>{r.organization_name}</Link> },
          { key: 'position', header: 'Pos' },
          { key: 'school_name', header: 'School / program' },
          { key: 'school_type', header: 'Type' },
          { key: 'slot_value_usd', header: 'Slot value', numeric: true, render: (r) => formatUsd(r.slot_value_usd) },
          { key: 'signing_status', header: 'Signing', render: (r) => label(SIGNING_STATUS_LABELS, r.signing_status) },
          { key: 'signing_bonus_usd', header: 'Bonus', numeric: true, render: (r) => r.signing_status === 'SIGNED' ? formatUsd(r.signing_bonus_usd) : '—' }
        ]} />
      )}
    </>
  )
}
