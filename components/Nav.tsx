'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { NAV_ITEMS, isActive } from '../lib/nav.ts'

export function Nav () {
  const pathname = usePathname() ?? '/'
  return (
    <nav className='nav' aria-label='Primary'>
      <Link href='/' className='brand'>BAI</Link>
      <ul>
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <Link href={item.href} aria-current={isActive(pathname, item.href) ? 'page' : undefined}>{item.label}</Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
