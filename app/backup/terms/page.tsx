import type { Metadata } from 'next'
import { PageHeader } from '../../../components/ui.tsx'
import { BackupNav, BackupFooter, BACKUP_APP_NAME } from '../../../components/BackupPages.tsx'

export const metadata: Metadata = {
  title: `Terms of use · ${BACKUP_APP_NAME}`,
  description: 'Terms for BAI Automated Backups: a privately operated, non-public backup utility for the BAI database.',
  alternates: { canonical: 'https://www.baibaseball.app/backup/terms' }
}

export default function BackupTermsPage () {
  return (
    <div className='prose'>
      <PageHeader title='Terms of use' lede={`${BACKUP_APP_NAME} · last updated 29 October 2026`} />
      <BackupNav />

      <h2>Purpose</h2>
      <p>
        {BACKUP_APP_NAME} is a private operational tool. Its only purpose is to make encrypted backups of the BAI database and store them in the operator’s own
        Google Drive so the database can be recovered. See <a href='/backup'>what it does</a> and the <a href='/backup/privacy'>privacy policy</a>.
      </p>

      <h2>Authorized use</h2>
      <ul>
        <li>It is for the BAI operator, and for anyone the operator explicitly authorizes, using their own authorized accounts and servers.</li>
        <li>It is not a public service and is not offered to visitors. Visitors to this website do not use it and cannot sign in to it.</li>
        <li>Do not attempt to access, probe or interfere with it, its credentials or any backup.</li>
      </ul>

      <h2>Limitations</h2>
      <ul>
        <li>The tool is provided as is, without warranty. It is not a guaranteed backup or disaster-recovery service and carries no availability commitment.</li>
        <li>A backup can be opened only with the operator’s private key. If that key or its passphrase is lost, the encrypted backups cannot be recovered.</li>
        <li>Use of Google Drive remains subject to Google’s own terms and policies. The operator may change, suspend or discontinue the tool at any time.</li>
      </ul>

      <h2>Support</h2>
      <p>
        Questions can be raised through the issue tracker linked below. Please do not post credentials, keys, backups or any private information there.
      </p>
      <BackupFooter />
    </div>
  )
}
