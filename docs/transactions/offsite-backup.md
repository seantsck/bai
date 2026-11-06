# Off-machine backup: runbook for G1 (encrypted file only; nothing here has been done)

**Status (2026-10-27): the procedure has been rehearsed successfully end to end on the 2026-10-25 backup (section 6). No DAY-OF copy exists, and the rehearsal copy is far too old for a production push.** A copy counts for G1 only when every box in section 5 is ticked by the owner, on the day, from a *fresh* download of a *fresh* backup taken no more than 30 minutes before the push. Until then G1's backup condition is not met.

Destination: a **private folder in the owner's Google Drive**, which the owner controls. Nothing in the repository or in the assistant's session has Drive access, and none is needed: the file is about **1.1 MB**, and the owner moves it by hand (browser upload, or the local folder of Google Drive for desktop if the owner uses it).

## Rules this runbook enforces

* **Only the encrypted file ever leaves** (`<name>.tar.zst.gpg`, plus its two small hash files). `scripts/db/backup-offsite.sh` reads the file's OUTER OpenPGP packets from its bytes (`scripts/db/lib/openpgp-outer.mjs`; it never decrypts, never calls gpg or the agent, and cannot ask for a passphrase) and accepts exactly one symmetric-key packet (version 4, AES-256, iterated+salted) followed by one integrity-protected data packet, to the last byte. It refuses a plaintext archive, export, SQL, NDJSON or database file, an armored, signed, public-key-encrypted, unprotected or damaged file, whatever it is called, and a destination inside the repository. The plaintext snapshot and export never leave `~/bai-backups/`.
* **The passphrase never touches the assistant, a prompt, an argument, an environment variable, a log or a chat.** GnuPG asks for it itself, on the terminal. **Run the pack and check commands in your own terminal** (not through the assistant's session), so what you type is not recorded anywhere. The scripts contain no way to accept a passphrase except gpg's own prompt (a test-only `--passphrase-file` exists and is never used for real backups).
* **You confirm the destination.** `copy` prints the absolute destination and asks you to type the folder's name; anything else cancels, and nothing is copied.
* **No network code.** The scripts copy into a local folder you name, or help you check a file you uploaded and downloaded yourself.
* **Fresh, not stale.** The snapshot and export are taken immediately before the push (G1's stop condition: older than 30 minutes at push time means start again).

## 1. Before the day (once)

1. Choose the Drive folder. In Drive: owner = you; **General access = Restricted** (never "Anyone with the link"); no one else listed; 2-step verification on for the account.
2. Put a long random passphrase in your password manager under a name you will recognise, **now**, and confirm you can copy it back out. Without it the backup cannot be opened and nobody can recover it. Do not keep the passphrase in the Drive folder or beside the file.
3. (Optional dress rehearsal) run sections 3–4 below on the *existing* rehearsal backup (`~/bai-backups/g1-rehearsal-*`) so the first time is not on G1 day. That backup is real hosted data: use the same private folder, and delete the rehearsal file from Drive afterwards if you do not want it kept.

## 2. On the day — take the copies (assistant or you; hosted is only read)

```
B=~/bai-backups/g1-$(date -u +%Y%m%dT%H%M%SZ) ; mkdir -p -m 700 $B
node --env-file=.env.hosted.local scripts/db/bench/snapshot-hosted.mjs --out $B/snapshot
set -a; . ./.env.hosted.local; set +a; scripts/db/logical-export.sh $B/export
node scripts/db/verify-snapshot.mjs $B/snapshot
node --env-file=.env.hosted.local scripts/db/hosted-preflight.mjs --snapshot-dir $B/snapshot --expect-level 027      # hosted equals the snapshot
```

(restore verification as in `backup-and-recovery.md` §2 is optional on the day: it was done on the rehearsal copy.)

## 3. In YOUR terminal — encrypt, then prepare

```
scripts/db/backup-pack.sh pack $B ~/bai-backups/g1-offsite.tar.zst.gpg        # gpg asks for the passphrase twice; type or paste it from your password manager
scripts/db/backup-offsite.sh prepare ~/bai-backups/g1-offsite.tar.zst.gpg      # checks it is really ciphertext; prints the three files and BOTH hashes
```

Write the two hashes (encrypted-file SHA-256 and content-tree SHA-256) in your own notes and tell the assistant only the first 12 characters of each. They are not secret; they are what the later check is compared against, so they must come from somewhere other than the downloaded file.

## 4. Transfer, then verify from a fresh download

* **Local synced folder** (Google Drive for desktop): `scripts/db/backup-offsite.sh copy ~/bai-backups/g1-offsite.tar.zst.gpg "<the folder>"` — read the destination it prints, type the folder name to confirm. It copies the three files and re-hashes the copy. Wait until the Drive client shows them as synced.
* **Browser upload:** upload the three files from `~/bai-backups/` to the private folder.

Then prove it is really there and really readable — do **not** check the local copy:

1. In the Drive web page, **download the `.gpg` file again** to a new folder (for example `~/Downloads/g1-check/`).
2. `scripts/db/backup-offsite.sh check ~/Downloads/g1-check/g1-offsite.tar.zst.gpg --expect-sha256 <hash from your notes> --expect-tree <hash from your notes>` — it compares the SHA-256, then gpg asks for the passphrase (take it from your password manager, not from memory or a note beside the file), decrypts, and checks the content hash and the `SHA256SUMS` inside.
3. Delete the downloaded copy and `~/Downloads/g1-check/`.

## 5. Ledger — tick only what you have seen yourself

- [ ] Drive folder is Restricted, owned by me, no one else has access
- [ ] passphrase is in my password manager and I retrieved it from there for the check
- [ ] fresh snapshot + export taken today, preflight against hosted passed
- [ ] encrypted file packed in my terminal; `prepare` printed the three files and two hashes; I noted both hashes elsewhere
- [ ] the three files are in the Drive folder
- [ ] a fresh download passed `check` (hash matched, decrypted, contents verified)
- [ ] I told the assistant: "off-site copy verified" with the first 12 characters of both hashes

Only after the last box does G1's backup condition count as met. If any step fails, stop: do not push; fix and repeat from section 2 with a new snapshot.

## What the assistant will not do

Handle or see the passphrase; upload or copy anything off this machine; assume an off-site copy exists; copy any plaintext; proceed to the push without your "off-site copy verified" message.

## 6. Rehearsal evidence (2026-10-25 backup; recorded 2026-10-27)

The rehearsal used the real hosted data of `g1-20261025T224416Z` (snapshot taken 2026-10-25T22:44:17Z, 92 tables / 30,604 rows, migration level 027). Two kinds of fact are kept apart.

**Verified by the assistant on this machine, read-only (archive untouched: SHA-256, mtime, ctime, inode, mode and size identical before and after):**

| | |
| --- | --- |
| File | `~/bai-backups/g1-20261025T224416Z.tar.zst.gpg`, 1,117,456 bytes, mode 600 |
| Encrypted-file SHA-256 | `445743098f74e7ee5595a3556918daab9de917236fd4936adc951b10212cdec5` — equal to the `.sha256` companion and to the value the owner reported |
| Content-tree SHA-256 | `a4ddf6d01f8dd402202e90ee6b5703df6adfc7555c81d699cb57ca8c470e29c5` — equal to the `.tree-sha256` companion, to the owner's value, and recomputed from the plaintext backup directory with the same function `backup-pack.sh` uses |
| Outer OpenPGP packets | tags `[3, 18]`: an old-format symmetric-key packet (version 4, **AES-256**, S2K iterated+salted, **SHA-512**, 65,011,712 iterations) and a new-format **partial-length** integrity-protected data packet (version 1, MDC); nothing else, no trailing bytes — read from the bytes, with no passphrase |

**Reported by the owner (not observable by the assistant):** the encrypted file was created in the owner's own terminal with the passphrase typed into GnuPG; all three files were uploaded to the owner's private Google Drive folder, which is Restricted; a fresh download's SHA-256 matched; the downloaded copy was transferred back to the VPS; decryption and content comparison passed. Not reported, to be confirmed on the day: that the passphrase is stored in the owner's password manager (§1 step 2). The downloaded copy itself is not on this machine, so the assistant did not re-verify the decryption.

**A defect the rehearsal found, now fixed.** `backup-offsite.sh` decided that a file was ciphertext with `gpg --list-packets`. That command does not only read headers: it tries to decrypt, so when gpg-agent holds a cached passphrase (as it does right after the owner has typed it) it prints the INNER compressed and literal-data packets, and the check refused the valid archive as "plaintext". The same call could also prompt for a passphrase. It is replaced by the byte-level outer-packet check above; `tests/db/openpgp-outer.test.mjs` reproduces the false positive (giving gpg the session key makes it list the inner literal packet), shows the new check accepts the archive regardless, and refuses 50+ malformed, wrong-cipher, wrong-structure, plaintext, truncated, extended and armored inputs.

**What the rehearsal does not establish:** anything about the day-of copy. G1 still needs a new backup on the day, within 30 minutes of the push, encrypted, uploaded, downloaded fresh and checked (§2–§5), and the owner's message "off-site copy verified".

## 7. G1 release log — day-of backup `g1-20261027T235441Z` (recorded 2026-10-28)

**Status: off-site copy verified by the owner; backup EXPIRED for G1. Migration 028 was NOT applied. Hosted remains at migration 027.**

| | |
| --- | --- |
| Snapshot | transaction began 2026-10-27T23:54:41Z (conservative window start), finished 23:55:05Z; 92 tables / 30,604 rows, level 027, `REPEATABLE READ` read-only; `manifest_sha256` `b7f8858c845232f86a63416890b354d0ab6c23094a59db8e1469b2ef215b17a1` (identical to the 2026-10-25 snapshot: hosted unchanged) |
| Window | the 30 minutes ended **2026-10-28T00:24:41Z**; the owner's confirmation arrived after that, so the backup may not be used to push 028 |
| Checks the assistant ran (all passed) | `verify-snapshot`; logical-export restore into a throwaway PostgreSQL 17 (rows equal the snapshot, 2,818 catalog objects, 0 unexplained differences); snapshot restore + strict preflight; read-only hosted preflight at level 027 (every table byte-identical); `gate check --dry-run` in the restricted worktree listing exactly `028_transaction_forensics_foundation.sql` |
| Encrypted-file SHA-256 | `2936287a8f5b5f0bf3db894489d0f5a1a9a48ad1ab38384dac0e9c20d48a59a1` |
| Content-tree SHA-256 | `6c9da73e1a28fac6a61b631a09e5041f6b1c7e1019f6afdc4feb47384a8d9701` |

**Verified by the assistant, read-only:** `~/bai-backups/g1-20261027T235441Z.tar.zst.gpg` is 1,121,531 bytes, mode 600; its SHA-256 equals the value above and the `.sha256` companion; the `.tree-sha256` companion equals the value above and the hash recomputed from the plaintext backup directory; the outer packets are `[3, 18]` (AES-256, S2K iterated+salted SHA-512, 65,011,712 iterations, integrity-protected), nothing else. The assistant did not decrypt it and never saw the passphrase.

**Reported by the owner (not observable by the assistant):** the fresh Google Drive download was verified independently; the downloaded archive passed decryption, content comparison and its internal `SHA256SUMS` verification; the owner's confirmation "Off-site copy verified." for this backup.

**Preserved:** the backup directory, the encrypted archive and its companions are kept unmodified. The next release attempt needs a NEW backup window (§2–§5) and a new authorization naming it; this evidence does not carry over.

## 8. Windows off-site helper and its rehearsal (recorded 2026-10-28)

The helper `~/bai-gates/g1-offsite.ps1` (kept outside the repository; Windows PowerShell 5.1 and 7; OpenSSH `ssh`/`scp` with `-i` and `IdentitiesOnly=yes`) runs the owner's side from ONE Windows terminal: `Pack` (encrypt on the VPS, then `backup-offsite.sh prepare`), `Pull` (three files to Windows, hashed three ways), manual Google Drive upload and fresh download, `Return` (fresh copy to a NEW directory on the VPS), `Check` (`backup-offsite.sh check`: SHA-256, decryption, content-tree hash, internal `SHA256SUMS`). It takes no passphrase, checks every ssh/scp exit code, never overwrites, and cannot start a backup, apply a migration or deploy. `-Step Config` prints settings with no network access; `-Step PackRefusalTest` is a read-only proof that `Pack` refuses an existing archive (it runs only `test` on the VPS).

**Owner-reported rehearsal (Windows PowerShell 5.1, backup `g1-20261027T235441Z`, a rehearsal and NOT an authorization of anything):** script syntax, Config, Pull, Return and Check passed; the returned archive decrypted; the content-tree hash matched; the internal `SHA256SUMS` verified. Hashes quoted by the owner equal the assistant-verified values in §7 (`2936287a…59a1`, `6c9da73e…9701`).

**Finding, fixed:** Windows kept an OLDER `CreationTimeUtc` on a fresh Google Drive download, so the helper's "must be newer than the original" test rejected a legitimate copy. File times are not a reliable freshness signal, so that test is now a warning (with a second warning when the file has no browser `Zone.Identifier` mark). Freshness still rests on the owner's explicit `-DownloadedFreshFromDrive` attestation, a separate download folder, byte equality with the original (SHA-256) and the full recovery check; none of those was weakened. Also added: `Return` removes only the EMPTY remote folder it just created if its `scp` fails.

**Assistant checks of the helper:** no PowerShell exists on the assistant's machine, so Windows execution is evidenced only by the owner's rehearsal; the assistant inspected the script (bracket balance, 5.1 syntax such as `${Name}:` variable references, exit-code handling) and ran the exact remote refusal command read-only against the real October 27 archive (it exits 1, i.e. refuses; the archive's hash is unchanged).

**Not yet rehearsed:** `Pack` against a real new window (it needs a fresh, complete backup directory), the timing of a full pass, and anything on the day. The October 27 archive remains a rehearsal backup and must not be used to authorize migration 028.

## 9. Windows helper v3 test results and the execution checklist for the next G1 window (recorded 2026-10-28)

**Owner-reported tests of `g1-offsite.ps1` (SHA-256 `ff598b5ecca52cf434d963ef821dfeea45ea18243987a4f5f6938f577612a825`, equal to the assistant-verified file):** Windows PowerShell 5.1 syntax PASS; `Config` PASS; `PackRefusalTest` against the existing 2026-10-27 archive PASS; the earlier v2 `Pull`, `Return` and full recovery `Check` PASS. **Not yet tested: the v3 `Pack` and the full end-to-end flow** — the first real run is the G1 window itself, so the owner should expect to watch each step.

**Fixed identity (must still match on the day):** `main` `076b68b…` or a later reviewed docs-only commit; release commit `41cb3da70a8daef2b4792d1053c982a7e9fad349`; gate file SHA-256 `5d6103348404f162def5402d0c7eb5d7ef9e955897c85cdd4335368656f6a0bb`; migration 028 SHA-256 `7598519f104c779868a3edcf89fdd7d4a9afd5ade26b2ea784c810806165b501`; restricted worktree `~/tmp-bai/g1-release` with migrations 001–028 only (029, 030 absent).

| T | Who | Step |
| --- | --- | --- |
| before | owner | password manager, Google Drive and Windows PowerShell open; passphrase stored; says "start the G1 window" |
| before | assistant | re-verify `main`, release commit, gate and 028 hashes, restricted worktree (28 migrations, `git status` = the two removed files), offline gate check |
| 0:00 | assistant | snapshot (`snapshot-hosted.mjs`) into a new `~/bai-backups/g1-<UTC>`; **T0 = the snapshot start time; the push must BEGIN before T0 + 30:00** |
| ~0:30 | assistant | logical export; `verify-snapshot`; logs written OUTSIDE the backup directory; both directories complete |
| ~2:30 | assistant | posts READY: name, T0, deadline, `manifest_sha256`; the owner may now start `Pack` |
| 2:30+ | owner | `.\g1-offsite.ps1 -Step Pack -Name <name>` (passphrase twice; `prepare` runs) |
| concurrent | assistant | restore checks (throwaway PostgreSQL 17, outside the backup directory) and the read-only hosted preflight against the new snapshot (strict byte parity at level 027, 028 checksum) — never writes into the backup directory |
| after Pack | owner | `-Step Pull`; upload the three files to the private Restricted Drive folder; download the `.gpg` again from the Drive web page into the `-fresh` folder |
| | owner | `-Step Return -DownloadedFreshFromDrive`; then `-Step Check` (passphrase once) |
| | owner | sends "Off-site copy verified for backup <name>." with both hashes, and the signed authorization naming that backup, T0 and the deadline (`~/bai-gates/g1-authorization-template.md`) |
| before the deadline | assistant | re-verify identity; `gate check --dry-run` (must list exactly `028_transaction_forensics_foundation.sql`); strict hosted preflight again; confirm the time is before the deadline |
| push | assistant | only if everything above is true: `BAI_GATE_FILE=<gate> npm run hosted:supabase -- db push`, then `hosted:migrate`, then `hosted-preflight --after 028` — then STOP; no import, publication change, read-model refresh or deployment |

**Stop conditions (no push; retake the backup if time or parity is lost):** any check fails or a hash differs; the deadline passes; `main`, the commit or either hash differs; the worktree is dirty or holds anything beyond 001–028; the dry run lists anything but 028; hosted is not at 027 or any table differs from the snapshot; the owner's verification or authorization is missing or names a different backup; the 2026-10-25 and 2026-10-27 backups are never reused. Unmeasured and likely to decide the deadline: the Drive upload and download and the `Check` run.

## 10. G1 attempt 2 — backup `g1-20261028T040939Z` (recorded 2026-10-28): window expired, 028 NOT applied

**Status: expired. Migration 028 was not applied; hosted was not changed and remains at migration 027. No new window is authorized.**

| | |
| --- | --- |
| T0 (snapshot start) / deadline | 2026-10-28 04:09:39Z / 04:39:39Z |
| Measured (assistant) | snapshot finished 04:10:04Z (25 s); export and `verify-snapshot` finished 04:11:48Z; READY announced and all restore and hosted checks passed by 04:12:30Z (about 2 min 50 s after T0). Hosted preflight: level 027, every table byte-identical to this snapshot, `manifest_sha256` `b7f8858c…17a1`; gate dry-run listed exactly 028 |
| Measured (file times) | `.tree-sha256` written 04:38:47Z, archive and `.sha256` 04:39:04Z — the encrypted file existed **35 seconds before the deadline**, roughly 26½ minutes after READY. When the owner started `Pack` is not recorded; the Drive upload, fresh download, `Return` and `Check` had not yet happened |
| Encrypted-file SHA-256 | `fe838df9ded2609aaeb7cba9be5072eda7f0476d0cb7bf95ac171afda8382668` |
| Content-tree SHA-256 | `93c454733f6048844ae1d45f834910905531b61cfeb6562b57dc621f5b8c2c73` |

**Verified by the assistant, read-only (no decryption):** the archive is 1,117,390 bytes, mode 600; its SHA-256 equals the `.sha256` companion and the owner's value; the `.tree-sha256` companion equals the owner's value and the hash recomputed from the plaintext backup directory; outer OpenPGP packets `[3, 18]`, AES-256, SHA-512 iterated 65,011,712, integrity-protected. **Reported by the owner:** the Windows v3 `Pack` step succeeded (first real run). Off-site upload, fresh download and recovery verification of this backup are not reported and are not claimed.

**Finding:** the manual owner path from READY to an encrypted file consumed almost the whole 30-minute window, so the rest (upload, fresh download, check, authorization) could not fit. The 30-minute rule cannot be met by this sequence unless the owner's steps are far faster or the sequence changes. A change of the freshness rule is a decision for the owner (for example: keep the time limit but start `Pack` the moment READY appears and pre-stage everything; or accept a strict read-only preflight proving byte parity with the snapshot at push time, which replaces the time limit and therefore needs the owner's explicit written approval). Neither is in effect.

**Preserved, never to be reused to authorize 028:** `g1-20261025T224416Z` (rehearsal), `g1-20261027T235441Z` (rehearsal), `g1-20261028T040939Z` (expired attempt) — directories, archives and companions unmodified.
