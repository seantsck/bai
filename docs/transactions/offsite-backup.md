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
