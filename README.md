# Bird Alert API

Vercel serverless functions backing [bird-alert](https://github.com/mbenfowler/bird-alert). Postgres via knex.

## Endpoints

All request and response bodies are JSON. Authenticated routes read an `HttpOnly` session cookie set by login or signup; the front end proxies `/api` so the cookie is first-party.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api` | no | health: `{ ok, db, latencyMs }`; the hourly GitHub workflow checks it and emails on failure |
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
| PATCH | `/api/user` | yes | update `email`, `state`, `location`, `alert_digest_email_enabled`, `rare_sightings_email_enabled`, `push_watchlist_enabled`, `push_notable_enabled`, `push_notable_batched`, `push_first_of_season`, `migration_email_enabled`, `push_quiet_start`, `push_quiet_end` (hours 0-23 or null), `timezone` (IANA name the browser reports) |
| GET | `/api/saved` | yes | the user's watch list |
| POST | `/api/saved` | yes | `{ speciesCode }` → adds to watch list, resolving unknown codes first (idempotent) |
| DELETE | `/api/saved?speciesCode=` | yes | removes from watch list |
| GET | `/api/birds?codes=a,b,c` | no | birds by eBird species code, in request order (max 50); unknown codes are resolved from eBird taxonomy plus image and Wikipedia lookups and stored; each carries `tips: { habitat, look, time }` from `data/species-tips.json` (field craft for the Southeast, written once for the 440 species of the users' counties; null for others) |
| GET | `/api/birds?q=term` | no | common-name search (max 50) |
| GET | `/api/ebird/species-list?region=` | no | eBird species codes for a region, true species only (CDN-cached a day) |
| GET | `/api/ebird/observations?region=` | no | recent observations (cached 5 min) |
| GET | `/api/ebird/notable?region=&back=` | no | notable observations, `back` 1–30 days (cached 5 min) |
| GET | `/api/ebird/species-observations?region=&code=&back=` | no | recent observations of one species (cached 5 min) |
| GET | `/api/ebird/regions?state=` | no | eBird subregions for a US state (cached a week) |
| GET | `/api/ebird/arriving?region=` | no | `{ arrivals, learning }`: species reported this time last year but not in the last two weeks, judged as returning migrants once enough history is on file (cached an hour) |
| GET | `/api/ebird/seasonality?region=&code=` | no | `{ months: [{ month, reported, covered }] }`: days per month the species was reported in the region over the last year (cached a day) |
| GET | `/api/ebird/where?region=&code=` | no | where to find the species in the region: places from the last 30 days, each with `chance` (0-100: the measured detection rate faded for staleness when the place has 3+ checklists in the fortnight, else an inference from recency, 55 × (1 − 0.5^score), which approaches 55 so only measured places reach High) and a band from it (High ≥60, Good ≥40, Fair ≥20, else Long shot), each flagged `isHotspot` (false for someone's personal location, null when unknown); a personal location within 600 m of a public hotspot is folded into it (`merged` lists what was folded in), hotspots never merge with each other, with the evidence behind each: distinct report days, last seen, checklists at the place in the last 14 days and how many had the species (detection), the two newest birders' notes; each place also carries its own `bestTime` when it has five timed reports; plus `grades` (see `/api/ebird/grades`) and the species' persistence class (resident 21-day half-life, seasonal 10, passage 4, rare 2, judged from its own year here and eBird's notable flag) and the best two-hour window from report times, or a typical time for its order (cached 10 min) |
| GET | `/api/ebird/where-to-go?region=&codes=a,b,c` | no | the watch list's places folded together (any number of codes, one query per table however many; beyond 1000 the rest are ignored): each place with `expected` (sum of the birds' chances: how many watch-list birds a visit can expect), the birds it offers with their chance and band, a best window and `seenToday`; plus `route`: up to three hotspot stops picked greedily so they cover the most different birds, with `covers` and a Google Maps directions `url`; per-species summary with each bird's best place (stored data only; cached 10 min) |
| GET | `/api/ebird/nearby?lat=&lng=` | no | public land near a point, for when a bird's best place is someone's yard: eBird hotspots within 10 km with all-time checklists and species (`lightlyBirded` under 10 checklists) and named parks from OpenStreetMap within about 5 km that eBird does not list; each point looked up once a month (`nearby_cache`), CDN-cached a day |
| GET | `/api/ebird/grades?region=` | no | how the bands have fared: per band over the last 60 days, graded predictions (n), how many had the bird on a checklist at the place within a week (hits), the rate, and whether there are enough (20) to trust (cached an hour) |
| GET | `/api/ebird/sync-checklists[?region=]` | cron | hourly (GitHub Actions): lists the region's newest 200 checklists, stores new ones, and fetches up to 40 per region in full (species, counts, the observer's note, photo/audio counts) into `checklists` and `checklist_species`; these are the ground truth for how often a location is birded and how often each species turns up there |
| GET | `/api/sound?code=` | no | one representative xeno-canto recording for the species: `{ found, url, page, type, length, recordist, license, licenseName }`; chosen once per species (song over call, short clean mp3 from this continent preferred) and kept in `bird_sounds` for 90 days; `found: false` when xeno-canto has nothing usable (cached a day) |
| GET | `/api/push/public-key` | no | VAPID public key for subscribing |
| POST | `/api/push/subscribe` | yes | browser push subscription → stored per device (idempotent) |
| POST | `/api/push/unsubscribe` | yes | `{ endpoint }` |
| GET | `/api/push/status?endpoint=` | yes | `{ subscribed, devices, lastRun }` (lastRun: when the hourly push job last ran and what it did) |
| POST | `/api/push/test` | yes | `{ endpoint? }` sends a test notification to that device, or all of the user's devices: a real watch-list batch built from the user's birds among the region's reports of the last week (or the newest three reports), tapping through to `/sightings`; a plain message when the region has no reports |
| GET | `/api/push/pending` | yes | the latest push of the last ten minutes with `tappedAt`, `offeredAt`, `openedAt`; the open app polls it to follow a tap or show an in-app toast (iPhone Home Screen apps run push where it cannot reach the page) |
| POST | `/api/push/tap` | yes | `{ url }` the service worker saw a tap on the latest push |
| POST | `/api/push/ack` | yes | `{ offered?, opened? }` the app offered the push as a toast and/or navigated to it |
| POST | `/api/push/trace` | yes | `{ event, … }` appends to the user's last 30 notification events (service worker and app), kept in `job_runs` as `sw-trace:<user id>`, for debugging taps that go nowhere on a phone |
| GET | `/api/push/alerts` | cron | hourly (GitHub Actions): pushes new watch-list and/or notable sightings per the user's push preferences, watch-list birds share one notification per run (names first, then a line per bird; tapping opens `/sightings?s=code:subId,…` in the app, which maps them all); notable and first-of-season birds each get a rich notification (bird photo, map, actions) up to four per run plus a summary for the rest; nothing during the user's quiet hours (sent on the first run after); each observation announced once via `push_log` whichever feed it came from; notable-only news goes out immediately, or at most every 6 hours for users who chose batching; greets the first report of a returning migrant for users who opted in (once per species per region per season); also prunes old throttle and log rows, files the day's reports into the seasonality tables and fetches a few more days of history |
| GET | `/api/map?lat=&lng=&zoom=` or `?pins=lat,lng,1;lat,lng,2` | no | JPEG map stitched from OpenStreetMap tiles: one pin at the centre (the picture on push notifications), or up to twelve labelled pins framed to fit (the map in email digests, one pin per checklist); cached a month |
| GET | `/api/mail/watchlist` | cron | daily watch-list digest with photos, maps and eBird links, skipping sightings already pushed (one eBird call per region; each send logged in `digest_log`, never twice a day); requires `Authorization: Bearer $CRON_SECRET` when that variable is set |
| GET | `/api/mail/rare` | cron | daily notable-sightings email for users who opted in; same auth |
| POST | `/api/mail/preview` | yes | `{ kind: 'watchlist' \| 'rare' \| 'migration' }` sends that email to the caller right now, outside the schedule and the once-a-day log, so they can see it; `{ sent: false, reason }` when there is nothing to send, the address is unconfirmed, or no county is set |
| GET | `/api/mail/migration` | cron | Sunday (GitHub Actions) migration summary per region: species back after a month or more away, regulars gone quiet, and what last year says to expect over the next two weeks; same auth |

The four mail routes share one function (`api/mail/[action].js`): Vercel's Hobby plan allows twelve functions per deployment. The old paths (`/api/alertDigestMailer`, `/api/rareSightingsMailer`, `/api/migrationMailer`, `/api/mailPreview`) are rewritten to the new ones in `vercel.json`.

### Seasonality

`region_species_days` holds which species were reported in a region on which day, from eBird's historic feed (one request per day, fetched once and kept) plus the hourly job's live reports. `region_days` records which days are on file in full. The hourly job fills in 16 months a few days at a time within a time budget; `node scripts/backfill-seasonality.js [region...]` does it in one go for a new region. A species counts as a returning migrant when it was reported on at least three days within three weeks of today's date last year and at most once in the two to four months before that.

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

## Tests

`npm test` runs the unit tests and, when `TEST_PG_URL` points at a Postgres database, the database-backed ones (migrations are applied to it and its tables emptied). CI does the same against a throwaway Postgres on every pull request.

## Backups

A GitHub Actions workflow dumps the production database every Monday (and on demand from the Actions tab), encrypts it with a passphrase, and keeps it as a workflow artifact for 90 days. It needs two repository secrets: `BACKUP_PG_URL` (the non-pooled connection string) and `BACKUP_PASSPHRASE`. Each run decrypts its own artifact and lists the dump as a check. To restore: download the artifact (you need `gpg`, e.g. `brew install gnupg`, and a `pg_restore` at least as new as the server), then

```bash
gpg --decrypt bird-alert-YYYY-MM-DD.dump.gpg > restore.dump
pg_restore --clean --if-exists --no-owner --dbname "$TARGET_PG_URL" restore.dump
```

## Maintenance

`node scripts/backfill-images.js` fills in pictures for stored birds that have none (Nuthatch, then Wikipedia's lead image). Prefix with `NODE_ENV=production PROD_PG_URL=...` to run against production.

## Deploying

Set these in the Vercel project: `PROD_PG_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_BASE_URL`, `EBIRD_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (web push; generate the keys with `npx web-push generate-vapid-keys`), `NUTHATCH_API_KEY` (bird images; optional), and `APP_EMAIL` plus `APP_PW` (a Gmail app password). Run `NODE_ENV=production npx knex migrate:latest` against the production database before the first deploy of a migration.
