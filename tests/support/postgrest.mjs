// The pinned PostgREST binary the Data API tests run against (PostgREST 12.2.3, linux static x64; release tarball sha256 in .github/workflows/check.yml).
// Locally: BAI_POSTGREST_BIN, default ~/tmp-bai/g5-2-bin/postgrest. When BAI_REQUIRE_POSTGREST=1 (CI) a missing binary is a FAILURE, never a skip: a Data API boundary that was not
// exercised over real HTTP is UNVERIFIED, not passed.
import fs from 'node:fs'
import os from 'node:os'
export const BIN = process.env.BAI_POSTGREST_BIN ?? `${os.homedir()}/tmp-bai/g5-2-bin/postgrest`
export const REQUIRED = process.env.BAI_REQUIRE_POSTGREST === '1'
if (REQUIRED && !fs.existsSync(BIN)) throw new Error(`BAI_REQUIRE_POSTGREST=1 but there is no PostgREST binary at ${BIN}: the Data API boundary tests cannot be skipped`)
export const SKIP = fs.existsSync(BIN) ? false : `SKIPPED: no PostgREST binary at ${BIN} (set BAI_POSTGREST_BIN): the Data API boundary is UNVERIFIED`
