# Bird Alert API

Vercel serverless functions backing [bird-alert](https://github.com/mbenfowler/bird-alert). Postgres via knex.

## Endpoints

All request and response bodies are JSON. Authenticated routes read an `HttpOnly` session cookie set by login or signup; the front end proxies `/api` so the cookie is first-party.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/auth/exists?email=` | no | `{ userExists }` |
| POST | `/api/auth/signup` | no | `{ email, password }` → user, sets cookie, sends confirmation email |
| POST | `/api/auth/login` | no | `{ email, password }` → user, sets cookie |
| POST | `/api/auth/logout` | no | clears cookie |
| GET | `/api/auth/me` | yes | current user |
| POST | `/api/auth/forgot` | no | `{ email }` → always 200, emails a one-hour reset link |
| POST | `/api/auth/reset` | no | `{ token, password }` |
| POST | `/api/auth/confirm` | no | `{ token }` marks the email confirmed |
| POST | `/api/auth/resend-confirmation` | yes | re-sends the confirmation email |
| POST | `/api/auth/unsubscribe` | no | `{ token }` turns off one email preference |
| PATCH | `/api/user` | yes | update `email`, `state`, `location`, `phone`, `alert_digest_email_enabled`, `rare_sightings_email_enabled` |
| GET | `/api/saved` | yes | the user's watch list |
| POST | `/api/saved` | yes | `{ speciesCode }` → adds to watch list, resolving unknown codes first (idempotent) |
| DELETE | `/api/saved?speciesCode=` | yes | removes from watch list |
| GET | `/api/birds?codes=a,b,c` | no | birds by eBird species code, in request order (max 50); unknown codes are resolved from eBird taxonomy plus image and Wikipedia lookups and stored |
| GET | `/api/birds?q=term` | no | common-name search (max 50) |
| GET | `/api/ebird/species-list?region=` | no | eBird species codes for a region (CDN-cached a day) |
| GET | `/api/ebird/observations?region=` | no | recent observations (cached 5 min) |
| GET | `/api/ebird/notable?region=&back=` | no | notable observations, `back` 1–30 days (cached 5 min) |
| GET | `/api/ebird/species-observations?region=&code=&back=` | no | recent observations of one species (cached 5 min) |
| GET | `/api/ebird/regions?state=` | no | eBird subregions for a US state (cached a week) |
| GET | `/api/alertDigestMailer` | cron | daily watch-list digest (one eBird call per region); requires `Authorization: Bearer $CRON_SECRET` when that variable is set |
| GET | `/api/rareSightingsMailer` | cron | daily notable-sightings email for users who opted in; same auth |

Email links (`/confirm/:token`, `/reset/:token`, `/unsubscribe/:token`) carry signed, purpose-scoped tokens. Reset tokens are bound to the current password hash, so each works once.

## Local development

```bash
npm install
cp .env.example .env   # fill in DEV_PG_URL and SESSION_SECRET at minimum
npm run migrate
npm run seed           # optional: three accounts, password "birdalert"
npm run dev            # vercel dev on http://localhost:3001
```

Outside production, email is printed to the dev server log instead of sent, so confirmation and reset links can be copied from there. Set `FORCE_SEND_MAIL=true` to send for real.

## Maintenance

`node scripts/backfill-images.js` fills in pictures for stored birds that have none (Nuthatch, then Wikipedia's lead image). Prefix with `NODE_ENV=production PROD_PG_URL=...` to run against production.

## Deploying

Set these in the Vercel project: `PROD_PG_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_BASE_URL`, `EBIRD_API_KEY`, `NUTHATCH_API_KEY` (bird images; optional), and `APP_EMAIL` plus `APP_PW` (a Gmail app password). Run `NODE_ENV=production npx knex migrate:latest` against the production database before the first deploy of a migration.
