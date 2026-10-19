import Link from 'next/link'
import type { ReactNode } from 'react'
import { DatabaseUnavailableError } from '../lib/db.ts'

export function PageHeader ({ title, lede, children }: { title: string, lede?: string, children?: ReactNode }) {
  return (
    <header className='page-header'>
      <h1>{title}</h1>
      {lede && <p className='lede'>{lede}</p>}
      {children}
    </header>
  )
}

export function Notice ({ tone = 'info', children }: { tone?: 'info' | 'warn', children: ReactNode }) {
  return <div className={`notice notice-${tone}`} role='note'>{children}</div>
}

export function SubNav ({ items }: { items: Array<{ href: string, label: string }> }) {
  return (
    <ul className='subnav'>
      {items.map((i) => <li key={i.href}><Link href={i.href}>{i.label}</Link></li>)}
    </ul>
  )
}

export interface Column<T> { key: string, header: string, render?: (row: T) => ReactNode, numeric?: boolean }

export function DataTable<T extends Record<string, any>> ({ columns, rows, empty }: { columns: Array<Column<T>>, rows: T[], empty: string }) {
  if (rows.length === 0) return <p className='empty'>{empty}</p>
  return (
    <div className='table-wrap'>
      <table>
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.numeric ? 'num' : undefined} scope='col'>{c.header}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => <td key={c.key} className={c.numeric ? 'num' : undefined}>{c.render ? c.render(row) : String(row[c.key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Stat ({ label, value, note }: { label: string, value: ReactNode, note?: string }) {
  return (
    <div className='stat'>
      <div className='stat-value'>{value}</div>
      <div className='stat-label'>{label}</div>
      {note && <div className='stat-note'>{note}</div>}
    </div>
  )
}

export type Loaded<T> = { ok: true, data: T } | { ok: false, message: string }

export async function load<T> (fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) return { ok: false, message: 'Database not configured. Start PostgreSQL 17 with `npm run db:server`, then `npm run db:migrate`.' }
    console.error(err)
    return { ok: false, message: 'Data is temporarily unavailable.' }
  }
}

export function Unavailable ({ message }: { message: string }) {
  return <Notice tone='warn'>{message}</Notice>
}
