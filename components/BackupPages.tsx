import { SubNav } from './ui.tsx'

// The three public pages that describe the private "BAI Automated Backups" utility (Google OAuth branding).
export const BACKUP_APP_NAME = 'BAI Automated Backups'
export const BACKUP_LAST_UPDATED = '29 October 2026'
export const BACKUP_CONTACT_URL = 'https://github.com/seantsck/bai/issues'

const ITEMS = [
  { href: '/backup', label: 'About' },
  { href: '/backup/privacy', label: 'Privacy policy' },
  { href: '/backup/terms', label: 'Terms of use' }
]

export function BackupNav () {
  return <SubNav items={ITEMS} />
}

export function BackupFooter () {
  return (
    <p className='note'>
      {BACKUP_APP_NAME} · last updated {BACKUP_LAST_UPDATED} · <a href='/backup/privacy'>Privacy policy</a> · <a href='/backup/terms'>Terms of use</a> ·
      questions: <a href={BACKUP_CONTACT_URL} rel='noopener noreferrer'>open an issue</a> (please do not post anything private)
    </p>
  )
}
