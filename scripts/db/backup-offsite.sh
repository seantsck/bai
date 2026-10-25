#!/usr/bin/env bash
# The off-machine step of the backup procedure (docs/transactions/offsite-backup.md). It handles ONLY the encrypted file produced by backup-pack.sh and its two
# hash companions; it never sees, asks for or stores a passphrase (GnuPG prompts for it itself, on the terminal), and it has no network code: it copies into a
# folder the OWNER names (for example the local folder of Google Drive for desktop), or helps check a file the owner uploaded by hand and downloaded again.
#
#   scripts/db/backup-offsite.sh prepare <backup.tar.zst.gpg>
#       checks the file is OpenPGP symmetric AES-256 encrypted (not plaintext), that both companions exist and match, and lists the three files to transfer
#   scripts/db/backup-offsite.sh copy    <backup.tar.zst.gpg> <existing destination folder>
#       shows the absolute destination, asks the owner to TYPE the folder's name to confirm, copies the three files, re-hashes the copies
#   scripts/db/backup-offsite.sh check   <downloaded backup.tar.zst.gpg> --expect-sha256 <hex> --expect-tree <hex>
#       for a file that came BACK from the remote: SHA-256 against the recorded value, then decrypts (GnuPG asks for the passphrase) and checks the content hash
#       and the SHA256SUMS inside it
# --passphrase-file <file> is for automated tests only.
set -euo pipefail
cmd="${1:-}"; shift || true
args=(); pfile=()
while [ $# -gt 0 ]; do case "$1" in --passphrase-file) pfile=(--passphrase-file "$2"); shift 2 ;; --expect-sha256) exp_sha="$2"; shift 2 ;; --expect-tree) exp_tree="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
for t in gpg sha256sum; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
GPG_TTY="$(tty 2>/dev/null || true)"; export GPG_TTY
die() { echo "$*" >&2; exit "${2:-1}"; }
hash_of() { sha256sum "$1" | cut -d' ' -f1; }

# the file must be GnuPG symmetric AES-256 (symmetric-key packet, algorithm 9) followed by encrypted data; a plaintext archive, an export or a database file is refused
require_encrypted() {
  local f="$1" packets
  [ -f "$f" ] || die "not a file: $f" 2
  case "$f" in *.gpg) ;; *) die "refusing $f: only a .gpg file made by backup-pack.sh is ever transferred" 2 ;; esac
  packets="$(gpg --batch --list-packets "$f" 2>&1 || true)"
  echo "$packets" | grep -q ':symkey enc packet:' || die "refusing $f: it is not an OpenPGP symmetric-encrypted file" 2
  echo "$packets" | grep -qE 'cipher 9|algo 9' || die "refusing $f: the cipher is not AES-256" 2
  echo "$packets" | grep -q ':encrypted data packet:' || die "refusing $f: no encrypted data packet" 2
  echo "$packets" | grep -q ':literal data packet:' && die "refusing $f: it contains a plaintext literal packet" 2
  return 0
}
require_companions() {
  local f="$1"
  [ -f "$f.sha256" ] && [ -f "$f.tree-sha256" ] || die "the companions $f.sha256 and $f.tree-sha256 are missing (backup-pack.sh pack writes them)" 2
  [ "$(hash_of "$f")" = "$(cat "$f.sha256")" ] || die "$f does not match its recorded SHA-256" 1
}

case "$cmd" in
  prepare)
    f="${args[0]:?encrypted file}"; require_encrypted "$f"; require_companions "$f"
    echo "ready to transfer (and nothing else):"
    for x in "$f" "$f.sha256" "$f.tree-sha256"; do printf '  %-14s %s\n' "$(du -h "$x" | cut -f1)" "$x"; done
    echo "  encrypted file SHA-256 : $(cat "$f.sha256")"
    echo "  content tree SHA-256   : $(cat "$f.tree-sha256")"
    echo "record both hashes somewhere other than the file; after transfer use: check <downloaded file> --expect-sha256 … --expect-tree …"
    ;;
  copy)
    f="${args[0]:?encrypted file}"; dest="${args[1]:?existing destination folder}"
    require_encrypted "$f"; require_companions "$f"
    [ -d "$dest" ] || die "the destination folder does not exist: $dest (nothing is created for you)" 2
    abs="$(cd "$dest" && pwd -P)"
    case "$abs/" in "$root"/*) die "refusing: the destination is inside the repository" 2 ;; esac
    echo "ONLY these three encrypted/hash files will be copied:"; for x in "$f" "$f.sha256" "$f.tree-sha256"; do echo "  $(basename "$x")"; done
    echo "destination: $abs"
    printf 'Type the destination folder name (%s) to confirm, anything else cancels: ' "$(basename "$abs")"
    read -r answer || answer=""
    [ "$answer" = "$(basename "$abs")" ] || die "cancelled: nothing was copied" 3
    for x in "$f" "$f.sha256" "$f.tree-sha256"; do [ ! -e "$abs/$(basename "$x")" ] || die "refusing to overwrite $abs/$(basename "$x")" 2; done
    for x in "$f" "$f.sha256" "$f.tree-sha256"; do cp --no-clobber "$x" "$abs/"; done
    [ "$(hash_of "$abs/$(basename "$f")")" = "$(cat "$f.sha256")" ] || die "the copy's SHA-256 differs from the original: do not rely on it" 1
    echo "copied and re-hashed: $abs/$(basename "$f") = $(hash_of "$abs/$(basename "$f")")"
    echo "this is a LOCAL copy into the folder you named; it is off-machine only once that folder's contents have reached the remote and a fresh download has passed 'check'."
    ;;
  check)
    f="${args[0]:?downloaded encrypted file}"; require_encrypted "$f"
    [ -n "${exp_sha:-}" ] && [ -n "${exp_tree:-}" ] || die "check needs --expect-sha256 and --expect-tree (the values recorded when the file was packed)" 2
    [ "$(hash_of "$f")" = "$exp_sha" ] || die "SHA-256 of the downloaded file differs from the recorded value" 1
    echo "SHA-256 matches the recorded value"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    cp "$f" "$tmp/b.gpg"; printf '%s\n' "$exp_sha" > "$tmp/b.gpg.sha256"; printf '%s\n' "$exp_tree" > "$tmp/b.gpg.tree-sha256"
    "$here/backup-pack.sh" verify "$tmp/b.gpg" "${pfile[@]}" | tail -1
    echo "decrypts, content hash matches the recorded value, and the SHA256SUMS inside it verify"
    ;;
  *) sed -n 2,13p "$0"; exit 2 ;;
esac
