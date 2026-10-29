# Automated, verified off-site backup (replaces the manual Pack / Pull / Drive / Return / Check flow)

**Status: implemented and tested locally against a fake storage service; NOT activated.** Nothing here has contacted a real Drive, hosted, or a real backup. Activation needs the one-time setup and the owner decisions at the end. It changes no release-gate or `final-parity` code: it produces the evidence those tools already check.

**The end state:** one authorized operation, `all`, takes the snapshot and export, proves they restore, encrypts, uploads, downloads an independent copy, decrypts and compares it, and prints PASS or FAIL with a machine-readable record. A separate owner authorization still controls the migration.

## Audit: what existed, what is reused
| Existing piece | Role now |
| --- | --- |
| `snapshot-hosted.mjs`, `logical-export.sh`, `verify-snapshot.mjs`, `hosted-preflight.mjs` | unchanged; `capture` runs them in order (hosted is only read) |
| `backup-pack.sh` (tar + zstd + GnuPG AES-256) | unchanged; the archive format and its tests are the same |
| `openpgp-outer.mjs`, `verifyBackupDir`, `contentTreeHash`, `verifyOffsiteEvidence` (final-parity lib) | reused as the checks inside the workflow; the evidence it writes passes `verifyOffsiteEvidence` byte for byte |
| `final-parity.mjs`, gate files, push guard | **untouched** |
| `g1-offsite*.ps1` (Windows), `backup-offsite.sh` | no longer needed for releases; kept as the manual fallback |

The manual flow existed for two reasons: the passphrase must not live next to the data, and nothing automated could reach the owner's Drive. Both are solved below.

## Recommended architecture
**rclone to Google Drive (free, already owned) with envelope encryption.** No new paid service. rclone is one static binary; a Drive remote with the `drive.file` scope can only see files rclone itself created, which is the least privilege that works.

```
backup dir  --tar+zstd+gpg(AES-256, session key S)-->  <name>.tar.zst.gpg  (+ .sha256, .tree-sha256)
S (random, per backup, in a 0700 RAM dir)  --gpg encrypt to the OWNER'S PUBLIC KEY-->  <name>.key.pgp
four files --rclone copyto --immutable--> Drive: <remote>/<name>/attempt-<UTC>/   (a new directory per attempt, nothing overwritten)
Drive --rclone copyto--> a NEW empty local directory   (an independent download, never the local original)
verify: byte-identical to the original AND to Drive's own MD5; decrypt the DOWNLOADED copy with S; content-tree hash = backup dir; internal SHA256SUMS
then S is overwritten and removed.  Evidence: returned-<name>/ (what final-parity checks) + <name>.offsite-verification.json/.txt
```

**Key custody.** This host holds only the owner's PUBLIC key; the run refuses if a secret key is in its keyring. S exists unwrapped only for the duration of one run, in memory-backed storage, and is used to verify the download. Stealing the VPS, the backup directory, the archive, the wrapped key and the Drive token still opens nothing; opening a backup needs the owner's private key (`recover`). The private key never touches this machine.

**The trade-off, stated plainly.** (1) The verifier runs on the same host that made the backup, with a transient S. It proves the bytes in Drive decrypt to exactly the backup; it cannot prove the owner can unwrap S. That is closed by a one-time recovery drill and a periodic repeat (below), not per release. (2) During a run, an attacker already on the host could read S, but that attacker already has the plaintext data. (3) The Drive token on the host can delete what rclone created (scope-limited, and Drive's trash keeps 30 days); an optional second pull to the owner's PC (`rclone copy` with the owner's own token) removes that single point. (4) Archive hashes are checked against Drive's own MD5 (computed by Google), an independent witness to the upload. A second, fully separate verifier machine would remove (1) but needs a place to hold a decryption secret unattended, which is exactly what we refuse to create.

## Implemented
* `scripts/db/backup-run.mjs` (also `npm run hosted:backup --`) with `all`, `capture`, `run`, `check`, `setup-check`, `selftest`, `recover`.
* `scripts/db/lib/offsite-auto.mjs` (pipeline, rclone and key handling, record, scrubbing); `scripts/db/restore-check.mjs` (disposable PostgreSQL restore + strict preflight + export check).
* `tests/db/offsite-auto.test.mjs` with `tests/db/fixtures/fake-rclone.mjs` (a local directory as the "remote", with failure injection).

## Failure behaviour (all tested)
| Situation | Result |
| --- | --- |
| upload fails, truncated upload, provider MD5 differs, object missing from the listing | FAIL at `upload`; nothing is reported verified |
| download fails, "succeeds" with no file, or bytes differ (corruption or substitution) | FAIL at `download`; the original local archive is never substituted (the downloaded file must be a different file, in a new directory) |
| backup older than 6 h, damaged snapshot or export | FAIL before anything is packed or uploaded |
| secret key on the host, wrong or malformed owner fingerprint, storage config readable by others | FAIL before anything is transferred |
| wrong private key at recovery, or wrong expected hash | recovery refused |
| any failure | the attempt's files are moved (never deleted) to `<name>.failed-<UTC>/` with a report; no PASS record, no `returned-<name>/`, so `final-parity` cannot use it; the session key is removed even on failure |
| retry | a new remote `attempt-<UTC>` directory; earlier attempts and their remote objects are kept; a backup that already has a valid PASS record is a no-op that re-checks the evidence |
| a damaged PASS record | never overwritten; `check` re-derives everything from the files (archive, downloaded copy, wrapped key, backup content, age) |
| tokens, passphrases, connection strings | scrubbed from anything printed or recorded (tested with token-shaped storage errors) |
PASS is only ever written after the download has been decrypted and compared; upload confirmation alone is never success.

## One-time setup (owner; about 30 minutes; free)
1. **Owner key (Windows, or any machine that is not the VPS).** Install GnuPG (Gpg4win), create a key with a strong passphrase kept in your password manager, and keep an offline copy of the private key (losing it makes every backup unreadable): `gpg --quick-generate-key "BAI backups <you@example>" ed25519 cert 5y`, then `gpg --quick-add-key <fpr> cv25519 encr 5y`; export the public key: `gpg --export <fpr> > bai-backup.pub`.
2. **VPS keyring with the public key only.** `install -d -m 700 ~/.config/bai-backup/gnupg && gpg --homedir ~/.config/bai-backup/gnupg --import bai-backup.pub`. Write `~/.config/bai-backup/config.json`: `{"remote": "gdrive:BAI-G1-backups", "recipient_fingerprint": "<40 hex>"}`.
3. **rclone on the VPS** (`rclone.org/install`, verify its checksum). In Google Cloud (free) create an OAuth client "Desktop app" and **publish the consent screen to Production** (a "Testing" app's refresh token expires after 7 days). Create the remote with scope `drive.file`: run `rclone config --config ~/.config/bai-backup/rclone.conf` on the VPS and, when asked to authorize, run `rclone authorize "drive" …` on your PC and paste the result; then `chmod 600` the config and `rclone --config … mkdir gdrive:BAI-G1-backups`. Note: with `drive.file` rclone cannot see your existing hand-made folder; it creates its own (you can still open it in Drive). Use the broader `drive` scope only if you want rclone inside the existing folder, at the cost of broader access.
4. `node scripts/db/backup-run.mjs setup-check` then `selftest` (synthetic data, real Drive, the whole path). Both must PASS.
5. **Recovery drill (once, then every few months):** `rclone copy gdrive:BAI-G1-backups/selftest <dir>` on your PC, then `node scripts/db/backup-run.mjs recover --archive … --key … --out <new dir> --gnupg-home <your keyring>` (gpg asks for your key passphrase). It must print RECOVERED. This is the only step that proves *you* can open a backup.

## The new workflow
1. You authorize Phase A (one message). I run **`node --env-file=<hosted env> scripts/db/backup-run.mjs all --gate ~/bai-gates/<gate>.gate.json`** (capture, restore check, strict preflight, encrypt, upload, download, decrypt, evidence): minutes, no owner action.
2. It prints a PASS report with the backup name, T0, six-hour eligibility, archive hash, content-tree hash and the record path. (`check --backup-dir …` re-verifies it at any time.)
3. You read the report and send your **backup-specific authorization** (unchanged). Phase C (`final-parity` then the gated push) takes its two hashes from the record.

**Manual steps that remain:** the one-time setup; the owner's authorization message; the periodic recovery drill; renewing the Drive token if Google expires it. The Windows Pack/Pull/Return/Check ceremony and the manual Drive upload and download are gone.

## What is required to activate safely
1. Review and approve this PR (it adds files only; no gate, `final-parity`, migration or existing script changes).
2. **An explicit owner decision** that machine verification (decrypt of the downloaded copy with a transient session key, plus Drive's MD5, plus a periodic recovery drill) replaces the owner-attested Drive round trip and decrypt of protocol v2. Until you decide, release authorization can keep using the manual flow; the evidence layout is identical, so either path satisfies `final-parity`.
3. The one-time setup, then `setup-check` and `selftest` against real Drive. Not run here: real rclone and Drive behaviour (listing hashes, exit codes, token refresh) are exercised only by a fake in the tests; `selftest` is the proof on the real service.
4. Optional, needs its own review and authorization: let `final-parity` take `--offsite-record <file>` and verify it (`verifyRecord`) instead of two typed hashes.

## Limits
Not tested against real rclone/Drive; GnuPG 2.4.8 only; the Windows helper is not updated; the host's gpg-agent may briefly cache nothing for `--passphrase-file` use, but process memory during a run is not hardened; no unattended scheduling is installed (a systemd timer could run `all` for routine backups, but a release backup must still be started on purpose).
