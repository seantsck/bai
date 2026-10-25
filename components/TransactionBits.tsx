import Link from 'next/link'
import type { ReactNode } from 'react'
import { statusView, STATUS_LABELS } from '../lib/transactions.ts'

/** The reconstruction status, exactly as the database derived it. "Verified complete" appears only for an active, current human verification. */
export function StatusBadge ({ status, verifiedOn, gaps = [] }: { status: string, verifiedOn?: string | Date | null, gaps?: string[] }) {
  const v = statusView(status, verifiedOn ?? null, gaps)
  return <span className={`badge badge-${v.tone}`} title={v.detail}>{v.label}</span>
}

export const statusOptions = Object.entries(STATUS_LABELS)

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

export function PlayerLink ({ slug, name }: { slug?: string | null, name?: string | null }): ReactNode {
  if (!name) return '—'
  return slug ? <Link href={`/players/${slug}`}>{name}</Link> : name
}
