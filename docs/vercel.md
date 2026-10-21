# Vercel deployment

BAI's public site runs on Vercel as project **`bai`** (team *Prism's projects*), reading the hosted BAI Supabase project.
It is read-only. Nothing that writes runs on Vercel: research ingestion, migrations, certification and reviewer actions
stay in the operator's shell (`npm run hosted:*`, `research:*`) and never ship.

## What runs where

| | Vercel (public site) | Operator shell |
|---|---|---|
| Code | `app/`, `components/`, `lib/` | `scripts/`, `database/`, `research/` |
| Database login | `bai_web` (pooler user `bai_web.<ref>`), every query `set local role anon` in a read-only transaction | `postgres` owner; reviewers' own logins |
| Variables | `BAI_PUBLIC_DATABASE_URL` (sensitive, server-only) | `.env.hosted.local` |

- The app has no API routes, server actions or middleware. Each page runs fixed `select`s from `lib/queries.ts` against the
  public read models and views that RLS exposes to `anon`.
- On Vercel (`VERCEL` is set) `lib/db.ts` reads **only** `BAI_PUBLIC_DATABASE_URL`, refuses any user but `bai_web` /
  `bai_web.<ref>` and any local host, and never falls back to `BAI_DATABASE_URL`.
- TLS is always verified against Supabase's root CA (`supabase/prod-ca-2021.crt`, public, traced into each function by
  `next.config.ts`). A URL's own `sslmode` / `sslrootcert` is ignored, so a URL cannot weaken verification.
- **Why the pooler:** Vercel functions have no IPv6 egress, and the direct `db.<ref>.supabase.co` host is IPv6-only. The
  web URL therefore goes through Supabase's IPv4 transaction pooler (port 6543). `set local` settings live inside the
  transaction, so transaction pooling is safe for this access pattern.
- **No `NEXT_PUBLIC_*` variables exist.** No Supabase key of any kind (publishable, secret or service-role) is used by
  the site.
- **Security headers** (`next.config.ts`): `nosniff`, `X-Frame-Options: DENY`, a strict referrer policy, a restrictive
  permissions policy and COOP. Vercel adds HSTS.
- **Function region** `yul1` (Montréal), next to the database in `ca-central-1`.

## Setting the database variable

```bash
npm run deploy:web-env -- --target preview --confirm-hosted <project ref>
```

- **Where the value comes from:** the script builds the pooler URL from `BAI_PUBLIC_DATABASE_URL` in `.env.hosted.local`,
  which `npm run hosted:web-role` writes.
- **How it is stored:** the script sends it to the Vercel API as a *sensitive* variable for one target. It is never
  printed, written to disk or placed on a command line.
- **Rotation:** after `hosted:web-role` rotates the password, re-run the script for each target.

## Deploying

**Uploads.** Deployments are made from the committed tree, never from a working directory that holds `.env*.local` or
`.pgdata`. `.vercelignore` is a second line of defence: it excludes env files, local data, research material, scripts and
migrations.

```bash
git archive <commit> | tar -x -C <empty dir>   # committed files only
cp .vercel/project.json <dir>/.vercel/          # link to project bai
npx vercel@51.6.1 deploy --cwd <dir>            # preview
```

**Production is manual.** `vercel.json`'s `ignoreCommand` skips Git-triggered production builds, so a push to `main`
never releases on its own. A release is a deliberate `vercel deploy --prod` (or *Promote* of a checked preview) after the
smoke test. Production also needs its own variable: `npm run deploy:web-env -- --target production ...`.

**Preview protection.** Previews sit behind Vercel Authentication. To smoke-test one, use `vercel curl` or open it while
logged in.

**Git integration.** The project is linked to `seantsck/bai` once the Vercel GitHub app has access to the repository
(GitHub → Settings → Applications → Vercel → Repository access). Until then, deploy with the CLI as above.

## Smoke test

Check each of these:
- `/`, `/research`, `/organizations`, `/organizations/los-angeles-dodgers`, `/draft`, `/draft/years`, `/draft/picks`,
  `/international`, `/international/signings`, `/international/classes`, `/players`, a player page, and `/compare`.
- An unknown slug returns 404.
- Response headers.
- A phone-width render.
- The deployment's function logs show no errors.

The site must show only what `anon` can read. `npm run hosted:security` proves the database side: `anon` has no
`analytics.*`, `research.*` or write access, and no function is executable by `PUBLIC`.
