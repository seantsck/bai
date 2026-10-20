import { COVERAGE_STATE_CODES, COVERAGE_STATE_LABELS, formatDate, formatShare } from '../lib/format.ts'

type Cell = Record<string, any>

function cellTitle (c: Cell): string {
  const state = c.coverage_state ? COVERAGE_STATE_LABELS[c.coverage_state]?.label ?? c.coverage_state : 'Not assessed'
  return [
    `${c.organization_name}, ${c.scope_label}`,
    `Coverage: ${state}`,
    `Tracked: ${c.tracked_records}`,
    `Expected: ${c.expected_count ?? 'unknown'}`,
    `Audited outcomes: ${c.audited_outcomes}`,
    `Known cost: ${formatShare(c.cost_known_records, c.cost_basis_records)}`,
    `Last research: ${c.last_research_date ? formatDate(c.last_research_date) : 'none'}`,
    `Research class certified: ${c.certified ? `yes${c.certified_on ? `, ${formatDate(c.certified_on)}` : ''}` : 'no'}`
  ].join('\n')
}

/** Organizations x scopes grid. Each cell shows the coverage state code and the tracked count (✓ = research class certified); empty cells are blank. */
export function CoverageMatrix ({ cells, caption }: { cells: Cell[], caption: string }) {
  const scopes = [...new Map(cells.map((c) => [c.scope_key, c.scope_label])).entries()]
  const orgs = [...new Map(cells.map((c) => [c.franchise_key, c.organization_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]))
  const at = new Map(cells.map((c) => [`${c.franchise_key}|${c.scope_key}`, c]))
  return (
    <div className='table-wrap matrix-wrap'>
      <table className='matrix'>
        <caption>{caption}</caption>
        <thead>
          <tr><th scope='col'>Organization</th>{scopes.map(([k, l]) => <th key={k} scope='col'>{String(l).replace(/ international signing period$/i, '')}</th>)}</tr>
        </thead>
        <tbody>
          {orgs.map(([key, name]) => (
            <tr key={key}>
              <th scope='row' title={name}>{key}</th>
              {scopes.map(([s]) => {
                const c = at.get(`${key}|${s}`)
                if (!c || (c.tracked_records === 0 && !c.coverage_state && !c.certified)) return <td key={s} className='cell-empty' aria-label='No records' />
                const code = c.coverage_state ? COVERAGE_STATE_CODES[c.coverage_state] : 'NA'
                return (
                  <td key={s} className={`cell cell-${code}`} title={cellTitle(c)}>
                    <span className='cell-code'>{code}</span> <span className='cell-count'>{c.tracked_records}</span>{c.certified && <span className='cell-cert' aria-label='certified'> ✓</span>}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
