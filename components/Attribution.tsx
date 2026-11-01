type Statement = Record<string, any>

/** The attribution a source group requires, verbatim and prominent (Retrosheet's notice: the statement must appear prominently). */
export function Attribution ({ statements }: { statements: Statement[] }) {
  if (!statements.length) return null
  return (
    <aside className='attribution' aria-label='Source attribution'>
      {statements.map((s) => (
        <p key={s.attribution_category}><strong>{s.statement}</strong> <span className='note'>(<a href={s.notice_url}>{s.attribution_category === 'RETROSHEET' ? 'Retrosheet notice' : 'notice'}</a>)</span></p>
      ))}
    </aside>
  )
}

