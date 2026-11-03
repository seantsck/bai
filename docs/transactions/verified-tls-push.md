# The TLS-verified connection of the guarded migration push

`scripts/db/supabase-hosted.mjs db push` (a real push and its dry run) connects to the database over **verified TLS, directly, and nowhere else**. Added after the G6 R3 review found that the Supabase CLI's linked connection does not demonstrably verify the server certificate.

## What was found (Supabase CLI 2.121.0, disposable local servers)
* A plain `--db-url`, `sslmode=require`, and the linked connection all accept a server with a **self-signed** certificate, including from a remote-looking hostname. Encryption without a verified server identity.
* On the **linked** path `PGSSLMODE` / `PGSSLROOTCERT` are ignored: with `verify-full` and a wrong trust root against hosted, the dry run still succeeded. Verification could not be enforced there.
* On `--db-url` the CLI does enforce `sslmode=verify-full&sslrootcert=<ca>` on the **final connection**, honours `PGPASSWORD` and `PGOPTIONS` from its environment, and does not use `SUPABASE_DB_PASSWORD`. It does not fall back to plaintext, to the pooler or to the system trust store.
* The CLI prints the machine-readable dry-run result (`{"dryRun":true,"migrations":[…]}`, which the gate reads) only when it detects an AI-agent environment or is asked: the guard now always passes `--output-format json`.

## What the guard does now
1. Builds the target from the pinned project reference alone: `postgresql://postgres@db.<ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=<checkout>/supabase/prod-ca-2021.crt`. **No password in the URL.** The password is `BAI_SUPABASE_DB_PASSWORD`, handed to the CLI only as `PGPASSWORD` in the child's environment (never an argument, never printed; CLI output is passed through a redaction).
2. Refuses: a pooler or any other host, port, user or database; a project reference that is not the checkout's linked one; any variable that could redirect the connection or weaken TLS (`PGSSLMODE`, `PGSSLROOTCERT`, `PGHOST`, `PGSERVICE`, `PGPASSFILE`, `PGPASSWORD`, `SUPABASE_CA_SKIP_VERIFY`, `SUPABASE_DB_URL`, `BAI_SUPABASE_CA_FILE`, …, nothing is silently dropped); `--linked`, `--db-url` and any other flag on a push; a password shorter than 8 characters.
3. **Pins the CA:** the file must hold exactly one certificate: `Supabase Root 2021 CA`, a CA, valid with at least 30 days left, SHA-256 fingerprint `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA` (valid 2021-04-28 to 2031-04-26). A look-alike CA with the right name and another key is refused. The hosted direct endpoint presents a certificate for `db.<ref>.supabase.co` that verifies against it (`openssl s_client -starttls postgres -verify_hostname …`: Verification OK), and fails against the system roots.
4. **Requires `PGOPTIONS`** for a real push: exactly `-c lock_timeout=<d> -c statement_timeout=<d>` with lock_timeout from 1 ms to 5 s (0 means none, so it is refused) and statement_timeout exactly 120000 ms (`120000`, `120s`, `2min`). Duplicates, other options and unusual spellings are refused. The child receives the values normalised to milliseconds.
5. Gives the CLI a **scrubbed environment**: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM`, `NO_COLOR`, `TZ` plus `PGPASSWORD`, `PGSSLMODE=verify-full`, `PGSSLROOTCERT`, `PGOPTIONS`. No `BAI_*`, no access token, no other URL or credential reaches it.
6. Keeps every earlier rule: the gate (restricted checkout, commit, migration checksums, hosted history, a dry run of exactly the gate's migration), the protocol-v2 final-parity record, no widening flags. The verified target is built **before** any of them runs and before any network contact, so a push that cannot be verified is refused first.

There is no switch that relaxes any of this. The library's `testOnly` option (a local test server and a test CA) is used only by `tests/db/supabase-push-tls.test.mjs`; a test asserts that the guard never mentions it. Commands other than `db push` (`migration list`, advisors, `link`) still use the CLI's linked connection: they are read-only, outside the migration push, and unchanged.

## How to run the push (R3-style)
```
PGOPTIONS='-c lock_timeout=5s -c statement_timeout=120000' \
BAI_GATE_FILE=~/bai-gates/<gate>.gate.json BAI_PARITY_RECORD=~/bai-gates/parity-<UTC>.json \
node --env-file=$E scripts/db/supabase-hosted.mjs db push
```
Do not use `--debug` for a release operation: its TLS behaviour was not verified, and it was not needed.

## Evidence
`tests/db/supabase-push-tls.test.mjs` runs the ACTUAL pinned CLI against five disposable local PostgreSQL servers (right certificate; self-signed; trusted CA but wrong hostname; right name but untrusted CA; TLS off): the right one is accepted, every other is refused with a TLS error, and there is no plaintext fallback. It also covers a missing CA file, no CA, a wrong CA, a wrong password, the password absent from every process command line while the CLI runs (sampled from `/proc`) and from the output, `PGOPTIONS` reaching the migration session (`lock_timeout`/`statement_timeout` seen by the migration), a held lock failing the push at the lock timeout with nothing applied or recorded, a statement timeout rolling a whole file back, and a dry run that lists exactly the one pending migration. `tests/db/gate-guard.test.mjs` proves, with a fake CLI, that the guard refuses each rule above before any call and that the one real push is `db push --output-format json --db-url <password-free verified URL>` with the scrubbed environment.
Read-only on hosted: the guard's dry run succeeds over `verify-full` with the pinned CA, and the same CLI against the same host with a wrong trust root fails ("self signed certificate in certificate chain").
