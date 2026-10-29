import type { Metadata } from 'next'
import { PageHeader } from '../../../components/ui.tsx'
import { BackupNav, BackupFooter, BACKUP_APP_NAME } from '../../../components/BackupPages.tsx'

export const metadata: Metadata = {
  title: `Privacy policy · ${BACKUP_APP_NAME}`,
  description: 'How BAI Automated Backups uses its Google Drive access (drive.file): what is uploaded, how credentials are kept, retention, sharing and how to revoke access.',
  alternates: { canonical: 'https://www.baibaseball.app/backup/privacy' }
}

export default function BackupPrivacyPage () {
  return (
    <div className='prose'>
      <PageHeader title='Privacy policy' lede={`${BACKUP_APP_NAME} · last updated 29 October 2026`} />
      <BackupNav />

      <h2>Who this covers</h2>
      <p>
        {BACKUP_APP_NAME} is a private utility operated by the owner of BAI (<a href='/backup'>about</a>). It is used only with the operator’s own Google
        account. It is not offered to the public and does not collect information from visitors to this website.
      </p>

      <h2>Google access requested</h2>
      <p>
        One scope: <code>https://www.googleapis.com/auth/drive.file</code>. It lets the application create, read, update and delete only the files and folders
        that the application itself created in Google Drive. It does not give access to any other file in the Drive. The application does not request access to
        Gmail, Contacts, Calendar, Photos or any other Google service, and does not use the full-Drive scopes.
      </p>

      <h2>What the application does with that access</h2>
      <ul>
        <li><strong>Uploads</strong>, to a folder it creates, for each backup: the encrypted backup archive, a small encrypted key file, and plain-text checksum files (hashes only; they contain no database content).</li>
        <li><strong>Reads file metadata</strong> for those files only (name, size and Google’s MD5 checksum) to confirm each upload arrived intact.</li>
        <li><strong>Downloads</strong> those same files again to check they are identical to what was uploaded and that they can be decrypted.</li>
        <li>Uploads small synthetic test files, containing no real data, when the operator runs a connection self-test.</li>
      </ul>
      <h2>Encryption keys</h2>
      <ul>
        <li>Each backup is encrypted on the operator’s server (AES-256) with a random, single-use session passphrase. That passphrase exists temporarily on the server, in an owner-only temporary location, while the backup is encrypted and while the downloaded copy is checked. When the run ends the tool overwrites the file and removes it. This cleanup is best-effort: it is not a guarantee of secure erasure, because the operating system or storage hardware may retain traces.</li>
        <li>The session passphrase is also encrypted (“wrapped”) to the operator’s public key, and that wrapped key file is stored in Google Drive next to the backup.</li>
        <li>The operator’s long-term private recovery key is never on the server. Only it can unwrap the session passphrase, so the files in Google Drive cannot be decrypted by Google, by the application’s Drive credentials, or by anyone who has only the Drive files.</li>
      </ul>

      <h2>How credentials are stored</h2>
      <p>
        The OAuth client credentials and the access token granted by the operator are kept in a configuration file on the operator’s private server, readable
        only by the operator’s account. They are not stored in this website, its source code repository or its logs, and the tool strips tokens and similar
        secrets from anything it prints or records.
      </p>

      <h2>Retention and deletion</h2>
      <ul>
        <li>Backups stay in Google Drive until the operator deletes them. The application does not currently expire or delete backups automatically, and it keeps the files of a failed upload attempt for inspection rather than deleting them.</li>
        <li>The operator can delete the backup folder in Google Drive at any time. Deleted Drive files are handled under Google’s own trash and retention rules.</li>
        <li>Copies of backups are also kept on the operator’s server until the operator removes them.</li>
        <li>Revoking access (below) stops the application from reaching Drive. Files already in Drive remain until deleted.</li>
      </ul>

      <h2>Sharing</h2>
      <p>
        Data is not shared with, sold to or transferred to anyone. Google, as the storage provider, holds the encrypted files. No other third party has access to
        them. The application uses the files only to verify that each backup is intact and recoverable, and they are not used to train machine-learning models.
      </p>

      <h2>No advertising, no sale</h2>
      <p>
        Data obtained through Google Drive is not used for advertising, is not sold, and is not used for any purpose other than storing and verifying the
        operator’s own BAI backups. {BACKUP_APP_NAME}’s use of information received from Google APIs adheres to the{' '}
        <a href='https://developers.google.com/terms/api-services-user-data-policy' rel='noopener noreferrer'>Google API Services User Data Policy</a>, including its
        Limited Use requirements.
      </p>

      <h2>Revoking access</h2>
      <ol>
        <li>Open <a href='https://myaccount.google.com/permissions' rel='noopener noreferrer'>myaccount.google.com/permissions</a> while signed in to the Google account.</li>
        <li>Select “{BACKUP_APP_NAME}” and choose “Delete all connections” (or “Remove access”).</li>
        <li>Optionally delete the backup folder in Google Drive.</li>
      </ol>
      <p>Once revoked, the stored token stops working and the application can no longer reach the account.</p>

      <h2>Changes and contact</h2>
      <p>
        If this policy changes, this page is updated and the date above changes. Questions can be raised through the issue tracker linked below; please do not
        post anything private there.
      </p>
      <BackupFooter />
    </div>
  )
}
