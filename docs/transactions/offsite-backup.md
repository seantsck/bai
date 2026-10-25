# Off-machine backup: runbook for G1 (encrypted file only; nothing here has been done)

**Status: NO off-machine copy exists.** This document is the procedure. A copy counts only when every box in section 5 is ticked by the owner, on the day, from a *fresh* download. Until then G1's backup condition is not met.

Destination: a **private folder in the owner's Google Drive**, which the owner controls. Nothing in the repository or in the assistant's session has Drive access, and none is needed: the file is about **1.1 MB**, and the owner moves it by hand (browser upload, or the local folder of Google Drive for desktop if the owner uses it).

## Rules this runbook enforces

* **Only the encrypted file ever leaves** (`<name>.tar.zst.gpg`, plus its two small hash files). `scripts/db/backup-offsite.sh` refuses anything that is not an OpenPGP symmetric AES-256 file, refuses a plaintext archive, export, SQL, NDJSON or database file whatever it is called, and refuses a destination inside the repository. The plaintext snapshot and export never leave `~/bai-backups/`.
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
