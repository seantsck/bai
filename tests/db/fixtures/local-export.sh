#!/usr/bin/env bash
# Test stand-in for scripts/db/logical-export.sh (same interface: <new directory>), for a LOCAL disposable database only. See local-export.mjs.
set -euo pipefail
exec node "$(dirname "$0")/local-export.mjs" "$1"
