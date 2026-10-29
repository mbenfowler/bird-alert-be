# Bird Alert API

Vercel serverless functions backing [bird-alert](https://github.com/mbenfowler/bird-alert). Postgres via knex.

## Endpoints

All request and response bodies are JSON. Authenticated routes read an `HttpOnly` session cookie set by login or signup; the front end proxies `/api` so the cookie is first-party.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api` | no | health: `{ ok, db, latencyMs, errors: { lastHour, by } }`; `?strict=1` (the hourly GitHub workflow) answers 503 when the database is down or 5+ server errors were logged in the last hour, and the failed run emails the owner |
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
| GET | `/api/ebird/where?region=&code=` | no | where to find the species in the region: places from the last 30 days, each with `chance` (0-100, see *How the chances are worked out* below: the place's detection rate leaning on the county-wide detectability when its checklists are few, faded for staleness, or an inference from recency capped by detectability) and a band from it (High ≥60, Good ≥40, Fair ≥20, else Long shot), each flagged `isHotspot` (false for someone's personal location, null when unknown); a personal location within 600 m of a public hotspot is folded into it (`merged` lists what was folded in), hotspots never merge with each other, with the evidence behind each: distinct report days, last seen, checklists at the place in the last 14 days and how many had the species (detection), the two newest birders' notes; each place also carries its own `bestTime` when it has five timed reports; plus `grades` (see `/api/ebird/grades`), the species' county-wide `detectability` and the species' persistence class (resident 21-day half-life, seasonal 10, passage 4, rare 2, judged from its own year here and eBird's notable flag) and the best two-hour window from report times, or a typical time for its order (cached 10 min) |
| GET | `/api/ebird/where-to-go?region=&codes=a,b,c` | no | the watch list's places folded together (any number of codes, one query per table however many; beyond 1000 the rest are ignored): each place with `expected` (sum of the birds' chances: how many watch-list birds a visit can expect), the birds it offers with their chance and band, a best window and `seenToday`; plus `route`: up to three hotspot stops chosen by the birds they cover together less the driving between them (a kilometre costs 1/12 of a bird), visited in the shortest order, with `covers`, a Google Maps directions `url` and `drive: { minutes, miles, legs, geometry }` by road through the stops (OSRM, cached; null when routing fails); per-species summary with each bird's best place (stored data only; cached 10 min) |
| GET | `/api/ebird/nearby?lat=&lng=` | no | public land near a point, for when a bird's best place is someone's yard: eBird hotspots within 10 km with all-time checklists and species (`lightlyBirded` under 10 checklists) and named parks from OpenStreetMap within about 5 km that eBird does not list, each with `drive: { minutes, miles, geometry }` by road from OSRM (null when routing fails), sorted by drive time; each point looked up once a month (`nearby_cache`), each drive once a month (`drive_cache`), CDN-cached a day |
| GET | `/api/ebird/grades?region=` | no | how the bands have fared: per band over the last 60 days, graded predictions (n), how many had the bird on a checklist at the place within a week (hits), the rate, and whether there are enough (20) to trust (cached an hour) |
| GET | `/api/ebird/sync-checklists[?region=]` | cron | hourly (cron-job.org → GitHub Actions): lists the region's newest 200 checklists, stores new ones, and fetches up to 40 per region in full (species, counts, the observer's note, photo/audio counts) into `checklists` and `checklist_species`; these are the ground truth for how often a location is birded and how often each species turns up there |
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
| GET | `/api/push/alerts` | cron | hourly (cron-job.org → GitHub Actions): pushes new watch-list and/or notable sightings per the user's push preferences, watch-list birds share one notification per run (names first, then a line per bird; tapping opens `/sightings?s=code:subId,…` in the app, which maps them all); notable and first-of-season birds each get a rich notification (bird photo, map, actions) up to four per run plus a summary for the rest; nothing during the user's quiet hours (sent on the first run after); each observation announced once via `push_log` whichever feed it came from; notable-only news goes out immediately, or at most every 6 hours for users who chose batching; greets the first report of a returning migrant for users who opted in (once per species per region per season); also prunes old throttle and log rows, files the day's reports into the seasonality tables and fetches a few more days of history |
| GET | `/api/map?lat=&lng=&zoom=` or `?pins=lat,lng,1;lat,lng,2` | no | JPEG map stitched from OpenStreetMap tiles: one pin at the centre (the picture on push notifications), or up to twelve labelled pins framed to fit (the map in email digests, one pin per checklist); cached a month |
| GET | `/api/mail/watchlist` | cron | daily watch-list digest with photos, maps and eBird links, skipping sightings already pushed (one eBird call per region; each send logged in `digest_log`, never twice a day); requires `Authorization: Bearer $CRON_SECRET` when that variable is set |
| GET | `/api/mail/rare` | cron | daily notable-sightings email for users who opted in; same auth |
| GET | `/api/mail/reminders` | cron | hourly (cron-job.org → GitHub Actions): one "confirm your email" reminder, with a fresh link, to each account between a day and a week old whose email isn't confirmed; logged in `digest_log` (kind `confirm-reminder`), so never twice; same auth |
| POST | `/api/mail/preview` | yes | `{ kind: 'watchlist' \| 'rare' \| 'migration' }` sends that email to the caller right now, outside the schedule and the once-a-day log, so they can see it; `{ sent: false, reason }` when there is nothing to send, the address is unconfirmed, or no county is set |
| GET | `/api/mail/migration` | cron | Sunday (cron-job.org → GitHub Actions) migration summary per region: species back after a month or more away, regulars gone quiet, and what last year says to expect over the next two weeks; same auth |

The four mail routes share one function (`api/mail/[action].js`): Vercel's Hobby plan allows twelve functions per deployment. The old paths (`/api/alertDigestMailer`, `/api/rareSightingsMailer`, `/api/migrationMailer`, `/api/mailPreview`) are rewritten to the new ones in `vercel.json`.

### Seasonality

`region_species_days` holds which species were reported in a region on which day, from eBird's historic feed (one request per day, fetched once and kept) plus the hourly job's live reports. `region_days` records which days are on file in full. The hourly job fills in 16 months a few days at a time within a time budget; `node scripts/backfill-seasonality.js [region...]` does it in one go for a new region. A species counts as a returning migrant when it was reported on at least three days within three weeks of today's date last year and at most once in the two to four months before that.

### How the chances are worked out

Each place on a species' list gets a chance (0-100) that a visit there finds the bird. Four things go into it.

1. **The place's own checklists.** When a place has three or more checklists in the last 14 days, the base is the share of them that reported the species (its *detection rate*). This is the strongest signal and already holds a lot: a bird that is common there and easy to notice is on most lists.
2. **Freshness, by persistence class.** Every report fades with a half-life that depends on how the species uses the county, judged from its own last year here: **resident** (reported in 10+ months, half-life 21 days), **seasonal** (10 days), **passage** migrant (under 12 days or 3 months a year, 4 days), and **rare** (eBird flags it notable, 2 days). A measured rate is multiplied by the square root of how faded the newest report is; a place without enough checklists is scored on the sum of its faded report days instead.
3. **Detectability, county-wide.** How readily a bird that is present gets noticed and reported: a Northern Cardinal is confiding and loud, a Chuck-will's-widow calls only after dark. It is measured as the share of the county's checklists over the last 60 days that report the species (at least 30 checklists on file). For owls and nightjars (Strigiformes, Caprimulgiformes) only checklists started before 7 am or from 6 pm count, once there are 10 of those, so the daytime lists do not bury them. In Hall in autumn 2026: cardinals on 59% of lists, Carolina Wrens 60%, Pileated Woodpeckers 13%, Swamp Sparrows 2%, Great Horned Owls 29% of night lists. It enters twice:
   - *Thin checklists lean on it.* A place's rate is blended with the county rate as if the county had contributed two more checklists: `(reported + 2 × county) / (checklists + 2)`. Three of three is promising, not certain (a Pileated at a park with 3 of 3 reads 63%, not 97%), and with dozens of checklists the place's own rate dominates.
   - *Inferred chances are capped by it.* Without enough checklists the chance is `cap × (1 − 0.5^score)`, approaching the cap, never reaching it. The cap is 55 for a bird the county reports on a quarter of its lists or more, and `55 × √(county ÷ 0.25)` below that, never under 35% of 55 (about 19). Reports of a hard-to-notice bird promise less: a Swamp Sparrow reported once at a park reads 8%, a cardinal on the same days would read far higher. Without a county rate (too few checklists on file) the cap stays 55.
4. **Bands follow the number.** High is 60 and up, Good 40-59, Fair 20-39, Long shot under 20. Only a measured rate can reach High; inference tops out below it.

Each species' `detectability` (`{ rate, basis: 'all' | 'night', lists }`) is in the `/api/ebird/where` response. What this model still leaves out: habitat (a marsh bird's county rate is low partly because most checklists are not from marshes), a place's own night effort, and the time of year within the 60-day window. The track record below is how to tell whether any of it is helping.

### Is it still there? (`/api/ebird/chase`)

For one bird at one place, used on a rarity's page and on shared sightings. eBird's report feed lags (a rarity's reports wait for review), so after the newest report the newest checklists filed at the place (up to 8) are opened one by one to see whether the bird is on them. A checklist that has it becomes the new "last seen".

- **Fading with time.** Before any checklist is counted, the chance it's still there halves every 48 hours for a rarity, 4 days for a bird passing through, 10 days for a seasonal bird and 3 weeks for a resident (`?cls=`). eBird times are the place's local clock, read in a zone estimated from its longitude.
- **Each miss counts.** Every checklist after the last find that doesn't have the bird lowers the chance, by Bayes, in proportion to how readily the bird is found when it's there. That rate comes only from checklists up to the last find (a miss after it may mean the bird left), pulled toward 60% until there are a few, and kept between 30% and 95%.
- **The answer.** `stillThere` is the chance it's there; `chance` is that times the find rate, the odds a visit now turns it up. The verdict is `fresh` (no misses, seen in the last day), `likely` (60%+), `maybe` (30%+), `gone`, or `unknown` (no report in 14 days).

Results are kept 10 minutes. It doesn't know about effort (a 5-minute drive-by and a 3-hour stakeout count the same) or whether the observer was looking for this bird.

### Testing a change to the odds (`scripts/backtest-odds.js`)

A change to how chances are worked out can be scored on past days before it ships: the backtest re-runs the model as of each day (queries never read past that day) and checks each place's chance against the next checklist filed there (`PER_VISIT=1`) or any in the following week. It only reads the database. What it found in October 2026, over 31 days and about 5,200 place predictions (mostly Hall County, GA):

- Per visit the chances run a little low: places said to be 74% had the bird 80% of the time, 46% had it 52%, 28% had it 38%, 9% had it 17%. Birds passing through were the most understated.
- Lowering a place's chance for each checklist since the last report that missed the bird made things worse for every class (Brier 0.1918 to 0.1935): the chances were already low, and a missed bird mostly hadn't left. That rule (`MODEL.misses`) is built but off.
- Only checklists we've opened count as effort now (`MODEL.detailedEffort`); one we haven't opened would otherwise read as a miss.

### How good are the chances? (the track record)

The chances on the species page and Where to go are checked against what birders go on to report. Once a day, inside the hourly sync, each region's species of interest (its users' watch-list birds and whatever eBird flags notable, reported there in the last 30 days, at most 40) have their ranked places written to `place_predictions`: the chance, its band, and the day. Seven days later each one is graded on what a chance promises, one visit: did the first checklist filed there afterwards (the first we've opened, within the week) have the bird? Nobody birded it that week: not graded. Grading on "anyone found it within the week" would have called a 9% place right a third of the time, since several visits add up. That uses stored checklists only, never a live eBird call.

`accuracy(region)` (served at `/api/ebird/grades` and inside the species and Where to go responses) gives, per band over the last 60 days, the predictions graded, how many came true, and the rate. A well-calibrated band comes true at about the rate it claims: High (60% or better) should land at 60% or above, Good (40-59%) near the middle, and so on. A High band that comes true a third of the time means the scoring is overconfident and the half-lives or the inferred-chance ceiling (55) want tuning.

The app shows it only behind a "Checked against real reports" badge, and only for bands with 20 or more graded predictions. To see the full numbers, including bands still short of 20:

```bash
node scripts/grades.js              # every region with a user
node scripts/grades.js US-GA-139    # one region
```

prints, per region, each band's range, how often it came true (hits/n), and how many predictions are still waiting out their week. Prefix with `NODE_ENV=production PROD_PG_URL=...` to read production. Predictions began 2026-10-26, so the first grades arrive 2026-11-02.

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

**HQ desk** (`.github/workflows/hq-desk.yml`, daily at 12:00 UTC, or run it from the Actions tab): one call to eBird's nationwide notable feed, ranked for national interest. eBird flags sightings rare for their *county*, so the feed is mostly local oddities; a headliner shows instead as many separate checklists in one state (birders chasing it), reviewers confirming it, and the bird being notable in only one or two states (one notable in eight or more is an irruption, not a rarity). Forms, hybrids and private locations are never pitched; a bird pitched in the last five days isn't repeated. The top eight arrive at `FEEDBACK_TO` each with a drafted post under 280 characters and a share link (`/share/s/…`, which unfurls with the bird's photo); Mondays add the week's top five. Picks are kept in `hq_picks`. A person reads and posts: nothing is published automatically. Each pick in the email has **Post on X**, which opens X's composer with the draft filled in (free; you tap Post there). With `X_POSTING=api` set it also has **Post automatically**, a link (signed, two days) to a confirmation page showing the draft; its button posts it to @BirdAlertHQ through X's API (OAuth 1.0a: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`), once only, recorded in `hq_picks.posted_at`/`post_id`. Opening the link never posts, so mail scanners that follow links are harmless. X's API charges credits for posting, which is why the composer link is the default.

`node scripts/stats.js` prints how the app is doing from our own tables: new accounts (and how many set a county or confirmed their email), push devices, watch-list and life-list birds added, passkeys, saved routes, share links made and opened, for the last 7 and 30 days and all time. Page views, referrers and countries are in Vercel Web Analytics on the front end. Prefix with `NODE_ENV=production PROD_PG_URL=...` to read production.

`node scripts/backfill-images.js` fills in pictures for stored birds that have none (the lead photo of the Wikipedia article that names the bird). Prefix with `NODE_ENV=production PROD_PG_URL=...` to run against production.

`node scripts/refresh-photos.js --report photos.json` re-checks every species' photo and Wikipedia link and writes the planned changes without touching the database; after a look, `--apply photos.json` writes exactly those. A bird whose article can't be confirmed loses its photo rather than keep a wrong one.

## ABA Checklist codes

The HQ desk ranks rarities nationally with the [ABA Checklist](https://www.aba.org/aba-checklist/)'s codes (1-2 regular, 3 rare, 4 casual, 5 accidental, 6 extinct or extirpated; the app and emails say these in plain words, since "casual" reads as commoner than "rare": a few each year, not every year, a few records ever), used with permission of the American Birding Association (Oct 2026), credited in the HQ email and named in posts ("ABA Code 4"). A Code 3 adds 4 to a pick's score, Code 4 adds 7, Code 5 adds 10; codes 1-2 add nothing, so a bird rare only in its state still ranks on its chase.

The checklist is the ABA's copyrighted work, so it is **not in this repository**: download the CSV from the ABA's page, unzip, and load it into `aba_codes` (it replaces whatever is there; rerun when the ABA publishes a new version):

```bash
node scripts/load-aba-checklist.js ~/Downloads/ABA_Checklist-8.19.csv   # prefix NODE_ENV=production PROD_PG_URL=... for production
```

Species are matched by scientific name, then English name. eBird splits the ABA hasn't adopted (Prairie Willet, Western Marsh Wren) and exotics not on the list get no code, which ranks them as codes 1-2 do.

## Schedules

The scheduled jobs are GitHub workflows (`.github/workflows/`), but GitHub runs `schedule:` triggers late or not at all (in October 2026 the hourly push ran every 4 to 7 hours). So a free [cron-job.org](https://cron-job.org) account starts each one on time through GitHub's API, `POST https://api.github.com/repos/mbenfowler/bird-alert-be/actions/workflows/<file>/dispatches` with body `{"ref":"main"}` (the digests add `"inputs":{"kind":"watchlist"}` or `"rare"`). Its token is a fine-grained GitHub token limited to Actions read and write on this repository; the cron password never leaves GitHub and Vercel.

| Job | Workflow | When (UTC) |
|---|---|---|
| Push alerts, health check, checklist sync | `push-alerts.yml` | hourly at :17 |
| HQ desk email | `hq-desk.yml` | daily 12:00 |
| Watch-list digest | `daily-mail.yml` (`watchlist`) | daily 15:00 |
| Rare-sightings digest | `daily-mail.yml` (`rare`) | daily 16:00 |
| Migration email | `migration-mail.yml` | Sundays 13:00 |
| Database backup | `backup.yml` | Mondays 09:00 |

The workflows keep their own `schedule:` as a backup. Running a job twice is harmless: `push_log` and `digest_log` stop repeats, and the HQ desk sends once a day (`?force=1` to resend). If the token expires, cron-job.org emails a failure; make a new one and paste it into each job's Authorization header.

## Deploying

Set these in the Vercel project: `PROD_PG_URL`, `SESSION_SECRET`, `CRON_SECRET`, `APP_BASE_URL`, `EBIRD_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (web push; generate the keys with `npx web-push generate-vapid-keys`), and `APP_EMAIL` plus `APP_PW` (a Gmail app password). Run `NODE_ENV=production npx knex migrate:latest` against the production database before the first deploy of a migration.

## Running at scale

- **Jobs work in 45-second slices.** `/api/push/alerts?after=` and `/api/mail/{watchlist,rare,migration}` stop when their budget runs out and answer `more: true` (push also `next`, the resume point). The GitHub workflows (`push-alerts.yml`, `daily-mail.yml`, `migration-mail.yml`) call again until done; `push_log` and `digest_log` make every re-call safe.
- **Mail has a daily cap.** Gmail suspends accounts past about 500 recipients a day, so sends are counted per UTC day in `mail_counts` (default cap 450, `MAIL_DAILY_CAP` overrides). Digests stop at 85% of it so confirmation and reset emails always get through; a capped digest run fails its workflow, which emails the owner. Set `SMTP_URL` to move to any SMTP provider (Resend, Brevo, SES…) with no code change; with it the cap is off unless set.
- **Errors are kept a week** in `error_log` (every unexpected 500 and failed digest send) and summarized by the health check.
- **Database:** production uses Neon's pooled endpoint, so bursts of function instances share connections.
