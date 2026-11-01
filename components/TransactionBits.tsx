import Link from 'next/link'
import type { ReactNode } from 'react'
import { statusView, STATUS_LABELS } from '../lib/transactions.ts'

/** The reconstruction status, exactly as the database derived it. "Verified complete" appears only for an active, current human verification. */
export function StatusBadge ({ status, verifiedOn, gaps = [] }: { status: string, verifiedOn?: string | Date | null, gaps?: string[] }) {
  const v = statusView(status, verifiedOn ?? null, gaps)
  return <span className={`badge badge-${v.tone}`} title={v.detail}>{v.label}</span>
}

export const statusOptions = Object.entries(STATUS_LABELS)

export { Attribution } from './Attribution.tsx'

export function PlayerLink ({ slug, name }: { slug?: string | null, name?: string | null }): ReactNode {
  if (!name) return '—'
  return slug ? <Link href={`/players/${slug}`}>{name}</Link> : name
}
