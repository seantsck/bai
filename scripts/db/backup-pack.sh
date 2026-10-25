#!/usr/bin/env bash
# Encrypts a backup directory (a snapshot and/or a logical export) into ONE file for storage OFF this workstation, and checks it can be decrypted and
# restored. Symmetric GnuPG (AES-256, salted, iterated key derivation) over tar + zstd. Nothing is uploaded and no network is used: copying the encrypted file
# to a second location is a separate, manual step that needs the owner's decision.
#
#   scripts/db/backup-pack.sh pack   <backup directory> <output file.tar.zst.gpg>
#   scripts/db/backup-pack.sh verify <encrypted file> [<backup directory to compare with>]
#   scripts/db/backup-pack.sh unpack <encrypted file> <new empty directory>
#
# The passphrase is asked for interactively by gpg (pinentry) and never appears in arguments or the environment. For automation and tests only:
# --passphrase-file <file> (mode 600). Keep the passphrase somewhere that is NOT the same place as the encrypted file (a password manager, not a sticky note
# beside the drive); without it the backup cannot be opened, and nobody can recover it.
set -euo pipefail
cmd="${1:-}"; shift || true
pf=(); pfile=()
args=()
while [ $# -gt 0 ]; do case "$1" in --passphrase-file) pf=(--batch --pinentry-mode loopback --passphrase-file "$2"); pfile=(--passphrase-file "$2"); shift 2 ;; *) args+=("$1"); shift ;; esac; done
for t in gpg tar zstd sha256sum; do command -v "$t" >/dev/null || { echo "missing tool: $t" >&2; exit 2; }; done
gpg_enc() { gpg --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none "${pf[@]}" "$@"; }
tree_hash() { (cd "$1" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1); }
case "$cmd" in
  pack)
    src="${args[0]:?backup directory}"; out="${args[1]:?output file}"
    [ -d "$src" ] || { echo "not a directory: $src" >&2; exit 2; }
    [ -e "$out" ] && { echo "refusing to overwrite $out" >&2; exit 2; }
    umask 077
    tree_hash "$src" > "$out.tree-sha256"
    tar -C "$src" -cf - . | zstd -q -19 | gpg_enc -o "$out"
    sha256sum "$out" | cut -d' ' -f1 > "$out.sha256"
    echo "encrypted $(du -h "$out" | cut -f1) -> $out"
    echo "  file SHA-256 : $(cat "$out.sha256")   (in $out.sha256)"
    echo "  content tree : $(cat "$out.tree-sha256")   (in $out.tree-sha256; the plain-text hash of the directory, for the restore check)"
    ;;
  unpack)
    in="${args[0]:?encrypted file}"; dst="${args[1]:?new empty directory}"
    [ -e "$dst" ] && [ -n "$(ls -A "$dst" 2>/dev/null)" ] && { echo "refusing: $dst is not empty" >&2; exit 2; }
    mkdir -p -m 700 "$dst"
    [ ! -f "$in.sha256" ] || [ "$(sha256sum "$in" | cut -d' ' -f1)" = "$(cat "$in.sha256")" ] || { echo "the encrypted file does not match its recorded SHA-256" >&2; exit 1; }
    gpg --decrypt "${pf[@]}" "$in" | zstd -d -q | tar -x -C "$dst"
    if [ -f "$in.tree-sha256" ]; then [ "$(tree_hash "$dst")" = "$(cat "$in.tree-sha256")" ] || { echo "the decrypted content does not match the recorded tree hash" >&2; exit 1; }; fi
    echo "decrypted to $dst and the content hash matches"
    ;;
  verify)
    in="${args[0]:?encrypted file}"; cmp_dir="${args[1]:-}"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    "$0" unpack "$in" "$tmp/out" "${pfile[@]}" >/dev/null
    if [ -f "$tmp/out/SHA256SUMS" ]; then (cd "$tmp/out" && sha256sum -c SHA256SUMS >/dev/null) || { echo "SHA256SUMS inside the backup do not verify" >&2; exit 1; }; fi
    [ -z "$cmp_dir" ] || [ "$(tree_hash "$tmp/out")" = "$(tree_hash "$cmp_dir")" ] || { echo "the decrypted backup differs from $cmp_dir" >&2; exit 1; }
    echo "verified: decrypts, content hash matches${cmp_dir:+, equals $cmp_dir}"
    ;;
  *) sed -n 2,14p "$0"; exit 2 ;;
esac
