import Link from 'next/link'
import { PageHeader, SubNav, DataTable, Notice, load, Unavailable } from '../../../components/ui.tsx'
import { getDraftExplorer, getOrganizationKeys, getSelectionAttribution } from '../../../lib/queries.ts'
import { formatUsd, label, KIND_LABELS, SIGNING_STATUS_LABELS, SOURCE_GROUP_SHORT } from '../../../lib/format.ts'
import { DRAFT_NAV } from '../../../lib/nav.ts'
import { editorialNote } from '../../../lib/partial-years.ts'
import { parseExplorerParams, explorerHref, PAGE_SIZE, DRAFT_KINDS } from '../../../lib/search.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Historical draft explorer' }

type Search = Record<string, string | string[] | undefined>

export default async function ExplorerPage ({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams
  const f = parseExplorerParams(raw)
  const rawQ = typeof raw.q === 'string' ? raw.q.slice(0, 80) : ''
  const rawSchool = typeof raw.school === 'string' ? raw.school.slice(0, 80) : ''
  const [res, orgs] = await Promise.all([load(() => getDraftExplorer(f)), load(getOrganizationKeys)])
  const rows = res.ok ? res.data.slice(0, PAGE_SIZE) : []
  const hasNext = res.ok && res.data.length > PAGE_SIZE
  // Source groups for this page's rows (025). Optional: without them the column shows a dash.
  const attr = await load(() => getSelectionAttribution(rows.map((r) => Number(r.selection_id))))
  const sourceOf = new Map(attr.ok ? attr.data.map((a) => [Number(a.selection_id), a]) : [])
  const sourceCell = (r: Record<string, any>) => {
    const a = sourceOf.get(Number(r.selection_id))
    if (!a) return '—'
    const sel = label(SOURCE_GROUP_SHORT, a.selection_source_category)
    const sign = a.signing_source_category ? label(SOURCE_GROUP_SHORT, a.signing_source_category) : null
    return sign && sign !== sel ? `${sel}; signing: ${sign}` : sel
  }
  // The 2021 later-round note shows only when 2021 rows are on screen or the search can include 2021.
  const covers2021 = f.year ? f.year === 2021 : (f.from ?? 0) <= 2021 && 2021 <= (f.to ?? 9999)
  const note = editorialNote([...rows.map((r) => r.draft_year), ...(covers2021 && (f.year || f.from || f.to) ? [2021] : [])])
  return (
    <>
      <PageHeader title='Historical draft explorer'
        lede='Every imported selection since 1965, searchable by player, franchise, year, phase, round and school. Clubs appear under the name they used that year.' />
      <SubNav items={DRAFT_NAV} />
      <Notice>Historical years are being added in stages and most are partial. See <Link href='/draft/years'>draft years &amp; coverage</Link> before reading a year as complete. “Not researched” signing status is not the same as “did not sign”. A pick that is absent is a gap in BAI&apos;s sources, not an unsigned player or a failed outcome.</Notice>
      {note && <Notice>{note}</Notice>}
      <form className='filters' method='get' action='/draft/explorer'>
        <label>Player <input name='q' defaultValue={rawQ} placeholder='Name begins with' maxLength={80} /></label>
        <label>Franchise
          <select name='org' defaultValue={f.org ?? ''}>
            <option value=''>All</option>
            {orgs.ok && orgs.data.map((o) => <option key={o.franchise_key} value={o.franchise_key}>{o.current_name}</option>)}
          </select>
        </label>
        <label>Year <input name='year' defaultValue={f.year ?? ''} inputMode='numeric' pattern='[0-9]{4}' size={5} /></label>
        <label>From <input name='from' defaultValue={f.from ?? ''} inputMode='numeric' pattern='[0-9]{4}' size={5} /></label>
        <label>To <input name='to' defaultValue={f.to ?? ''} inputMode='numeric' pattern='[0-9]{4}' size={5} /></label>
        <label>Phase
          <select name='kind' defaultValue={f.kind ?? ''}>
            <option value=''>All</option>
            {DRAFT_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
        </label>
        <label>Round <input name='round' defaultValue={f.round ?? ''} placeholder='1, C-1, CB-A' size={6} /></label>
        <label>School <input name='school' defaultValue={rawSchool} placeholder='Begins with' maxLength={80} /></label>
        <label>Signing
          <select name='signing' defaultValue={f.signing ?? ''}>
            <option value=''>All</option>
            <option value='SIGNED'>Signed</option>
            <option value='DID_NOT_SIGN'>Did not sign</option>
            <option value='UNKNOWN'>Not researched</option>
          </select>
        </label>
        <button type='submit'>Search</button>
      </form>
      {!res.ok ? <Unavailable message={res.message} /> : (
        <>
          <DataTable rows={rows} empty='No selections match these filters (or the year has not been imported yet).' columns={[
            { key: 'draft_year', header: 'Year' },
            { key: 'draft_kind', header: 'Phase', render: (r) => label(KIND_LABELS, r.draft_kind) },
            { key: 'round_code', header: 'Round' },
            { key: 'overall_pick', header: 'Overall', numeric: true },
            { key: 'display_name', header: 'Player', render: (r) => <Link href={`/players/${r.player_slug}`}>{r.display_name}</Link> },
            { key: 'organization_name_then', header: 'Club (that year)', render: (r) => <Link href={`/organizations/${r.organization_slug}`}>{r.organization_name_then}</Link> },
            { key: 'league_then', header: 'League', render: (r) => [r.league_then, r.division_then].filter(Boolean).join(' ') || '—' },
            { key: 'school_name', header: 'School / program' },
            { key: 'signing_status', header: 'Signing', render: (r) => label(SIGNING_STATUS_LABELS, r.signing_status) },
            { key: 'signing_bonus_usd', header: 'Bonus', numeric: true, render: (r) => r.signing_status === 'SIGNED' ? formatUsd(r.signing_bonus_usd) : '—' },
            { key: 'source', header: 'Source', render: sourceCell }
          ]} />
          <p className='note'>Source is the primary citation of the selection (and of its signing when different). See <Link href='/sources'>sources &amp; methodology</Link>.</p>
          <nav className='pager' aria-label='Pages'>
            {f.page > 1 ? <Link href={explorerHref(f, f.page - 1, { q: rawQ, school: rawSchool })}>← Previous</Link> : <span />}
            <span>Page {f.page}</span>
            {hasNext ? <Link href={explorerHref(f, f.page + 1, { q: rawQ, school: rawSchool })}>Next →</Link> : <span />}
          </nav>
        </>
      )}
    </>
  )
}
