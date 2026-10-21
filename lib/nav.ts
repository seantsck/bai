export interface NavItem { href: string, label: string }

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/international', label: 'International' },
  { href: '/draft', label: 'Draft' },
  { href: '/organizations', label: 'Organizations' },
  { href: '/players', label: 'Players' },
  { href: '/compare', label: 'Compare' },
  { href: '/research', label: 'Research' }
]

// Every planned public route. tests/app asserts each has a page.
export const PLANNED_ROUTES = [
  '/',
  '/international', '/international/signings', '/international/classes', '/international/markets', '/international/trainers',
  '/draft', '/draft/picks', '/draft/explorer', '/draft/years', '/draft/schools',
  '/organizations', '/organizations/[slug]',
  '/players', '/players/[slug]',
  '/compare', '/research'
]

export function isActive (pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

export const INTERNATIONAL_NAV: NavItem[] = [
  { href: '/international/signings', label: 'Signings' },
  { href: '/international/classes', label: 'Signing classes' },
  { href: '/international/markets', label: 'Markets' },
  { href: '/international/trainers', label: 'Trainers & academies' }
]

export const DRAFT_NAV: NavItem[] = [
  { href: '/draft/picks', label: 'Picks' },
  { href: '/draft/explorer', label: 'Historical explorer' },
  { href: '/draft/years', label: 'Draft years & coverage' },
  { href: '/draft/schools', label: 'Schools & programs' }
]
