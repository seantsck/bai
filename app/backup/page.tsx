import type { Metadata } from 'next'
import { PageHeader, Notice } from '../../components/ui.tsx'
import { BackupNav, BackupFooter, BACKUP_APP_NAME } from '../../components/BackupPages.tsx'

export const metadata: Metadata = {
  title: BACKUP_APP_NAME,
  description: 'BAI Automated Backups is a privately operated utility that makes encrypted backups of the BAI database and stores them in the operator’s own Google Drive.',
  alternates: { canonical: '/backup' }
}

export default function BackupPage () {
  return (
    <div className='prose'>
      <PageHeader title={BACKUP_APP_NAME} lede='A privately operated utility that keeps an encrypted off-site copy of the BAI database in Google Drive.' />
      <BackupNav />
      <Notice>
        This is not a public service. It has no sign-up, no visitor accounts and nothing for visitors to use. This page exists to describe the
        application and its use of Google Drive, as required for Google’s OAuth consent screen.
      </Notice>

      <h2>What it is</h2>
      <p>
        {BACKUP_APP_NAME} is a command-line tool run by the operator of BAI (Baseball Acquisition Intelligence, this website). It makes a backup of BAI’s own
        research database and stores an encrypted copy off-site, so the database can be recovered if the primary copy is lost.
      </p>

      <h2>What it does</h2>
      <ol>
        <li>It exports the BAI database to a backup on the operator’s own server and checks that the backup restores.</li>
        <li>It encrypts the backup there (AES-256) with a random key made for that one backup. That key is itself encrypted to a public key whose private half is held only by the operator, never on the server.</li>
        <li>It uploads the encrypted backup, a small encrypted key file and plain-text checksums to a folder in the operator’s own Google Drive.</li>
        <li>It downloads a fresh copy, confirms it is byte-for-byte identical, decrypts it to prove it can be recovered, and writes a PASS or FAIL report.</li>
      </ol>

      <h2>Use of Google Drive</h2>
      <p>
        Google Drive is used only as off-site file storage, from the operator’s own Google account. The application asks for a single permission, the
        <code> drive.file </code> scope (“See, edit, create, and delete only the specific Google Drive files you use with this app”). With it the application can
        reach only the files and folders it creates itself. It cannot see, list or read anything else in the account’s Drive, and it asks for no other Google
        data. Details are in the <a href='/backup/privacy'>privacy policy</a>.
      </p>

      <h2>Policies</h2>
      <ul>
        <li><a href='/backup/privacy'>Privacy policy</a></li>
        <li><a href='/backup/terms'>Terms of use</a></li>
      </ul>
      <BackupFooter />
    </div>
  )
}
