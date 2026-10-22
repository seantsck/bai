import { PageHeader, DataTable, Notice, load, Unavailable } from '../../components/ui.tsx'
import { getSourceAttribution } from '../../lib/queries.ts'
import { SOURCE_GROUP_LABELS, label } from '../../lib/format.ts'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Sources & methodology' }

// What each source group is, what BAI takes from it, and how it is credited. Crediting a source is not a claim of a right
// to redistribute its data (docs/history/hosted-provenance.md).
// Retrosheet's required statement (https://www.retrosheet.org/notice.txt), verbatim.
const RETROSHEET_CREDIT = 'The information used here was obtained free of charge from and is copyrighted by Retrosheet. Interested parties may contact Retrosheet at "www.retrosheet.org".'

const GROUPS: { key: string, uses: string, credit: string }[] = [
  {
    key: 'MLB',
    uses: 'Draft selections, signings and dates from the MLB Stats API and transaction wire; MLB.com articles and pages for slot values, calendars and rules.',
    credit: 'Data from MLB Advanced Media (MLB Stats API, MLB.com). MLB\'s terms limit how its data may be used; BAI\'s use is under review, and historical (pre-2015) MLB-sourced records are not published here.'
  },
  {
    key: 'BASEBALL_REFERENCE',
    uses: 'Observations from Baseball-Reference pages, some read through Internet Archive captures: signing details, schools, season WAR.',
    credit: 'Baseball-Reference.com, Sports Reference LLC. WAR shown here is Baseball-Reference\'s statistic. Sports Reference restricts reuse of its data; these observations are under review.'
  },
  {
    key: 'CHADWICK_REGISTER',
    uses: 'Player identity crosswalk: links between MLBAM, Baseball-Reference, FanGraphs and Retrosheet ids.',
    credit: 'Chadwick Baseball Bureau Register, licensed under the Open Data Commons Attribution License 1.0.'
  },
  {
    key: 'WIKIPEDIA',
    uses: 'Facts such as draft dates and stated totals, each cited by article revision.',
    credit: 'Wikipedia contributors. Facts only; article text is not reproduced (text is CC BY-SA 4.0).'
  },
  {
    key: 'WIKIDATA',
    uses: 'Identity corroboration: a person\'s Wikidata item (Q-id), recorded as a field observation on records whose identifiers were checked against it.',
    credit: 'Wikidata contributors. Structured data released under CC0 1.0; no permission or attribution is required, credited as a courtesy.'
  },
  {
    key: 'BAI_RESEARCH',
    uses: 'Independent researcher observations: BAI\'s own reference compilations (franchise histories, calendars) and research determinations, each citing the public evidence it rests on.',
    credit: 'BAI research.'
  },
  {
    key: 'OTHER_PUBLICATION',
    uses: 'Facts reported by news media, Baseball America, FanGraphs and clubs (for example a bonus or a signing date), cited with a link.',
    credit: 'Credited to each publication on the record it supports. Only facts are recorded, never article text or rankings.'
  }
]

export default async function SourcesPage () {
  const res = await load(getSourceAttribution)
  const totals = new Map<string, { records: number, observations: number }>()
  if (res.ok) {
    for (const r of res.data) {
      const t = totals.get(r.attribution_category) ?? { records: 0, observations: 0 }
      if (r.domain === 'FIELD_OBSERVATION') t.observations += r.records; else t.records += r.records
      totals.set(r.attribution_category, t)
    }
  }
  return (
    <>
      <PageHeader title='Sources & methodology' lede='Where BAI’s records come from, how they are credited, and the rules that keep unknowns from looking like facts.' />
      <Notice>
        BAI is an independent research project. It is not affiliated with, endorsed by or sponsored by Major League Baseball, MLB Advanced Media, any
        club, Sports Reference, the Chadwick Baseball Bureau or the Wikimedia Foundation. Club and league names are used only to identify them.
      </Notice>

      <h2>How records are sourced</h2>
      <ul>
        <li>Every record cites a primary source, and each field can carry observations from several sources. Disagreements are kept side by side, never overwritten.</li>
        <li>Missing is not zero: an unknown bonus is blank, and “not researched” is never “did not sign”.</li>
        <li>A class is complete only when an independent source lists the same people. One source’s row count is never treated as the whole population.</li>
        <li>Records are imported through a validated pipeline. No AI model writes research facts; judgments on disputed records are made by a human reviewer.</li>
        <li>Historical drafts before 2015 are not published while the permissions for their sources are reviewed.</li>
      </ul>

      <h2>Source groups</h2>
      {!res.ok && <Unavailable message={res.message} />}
      <DataTable rows={GROUPS} empty='No sources.' columns={[
        { key: 'key', header: 'Source', render: (g) => label(SOURCE_GROUP_LABELS, g.key) },
        { key: 'uses', header: 'What BAI takes from it' },
        { key: 'credit', header: 'Credit' },
        { key: 'records', header: 'Records citing it', numeric: true, render: (g) => res.ok ? (totals.get(g.key)?.records ?? 0).toLocaleString('en-US') : '—' },
        { key: 'observations', header: 'Field observations', numeric: true, render: (g) => res.ok ? (totals.get(g.key)?.observations ?? 0).toLocaleString('en-US') : '—' }
      ]} />

      <h2>Reference data used in research</h2>
      <p>
        BAI’s research tooling also reads Retrosheet’s transactions file, an openly licensed reference dataset. It is not shown on this site yet; it is credited
        here because Retrosheet’s notice requires its statement to appear prominently wherever its data is used.
      </p>
      <ul>
        <li>{RETROSHEET_CREDIT}</li>
      </ul>

      <h2>Rights</h2>
      <p>
        Crediting a source records where a fact came from. It is not a claim that BAI holds a license to redistribute that source’s data. The terms of
        some sources, MLB’s and Sports Reference’s among them, restrict reuse; BAI is reviewing its use of them, and records may be restricted as a result.
        Questions or requests about a source’s data are welcome through the project repository.
      </p>
    </>
  )
}
