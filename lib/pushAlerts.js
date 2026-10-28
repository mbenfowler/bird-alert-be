const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { sightingNotification, watchlistNotification, summaryNotification } = require('./notifications')
const { findOrCreateBirds } = require('./enrich')
const { inQuietHours } = require('./quietHours')
const { recordRun } = require('./jobRuns')
const seasonality = require('./seasonality')

const LOG_RETENTION_DAYS = 7
const THROTTLE_RETENTION_HOURS = 24
// Users who opt into batching get notable-only news at most this often. Watch-list news never waits.
const NOTABLE_BATCH_HOURS = 6
// Notable and first-of-season sightings get their own rich notification up to this many per run;
// the rest share one summary. Watch-list sightings always travel together in one notification.
const MAX_RICH_PER_RUN = 4
// Time each run may spend fetching older days of seasonality history, after the pushes themselves.
const BACKFILL_BUDGET_MS = 6000
const KIND_ORDER = { lifer: -1, season: 0, both: 1, watchlist: 1, notable: 2 }
// A lifer alert needs a life list to measure against; with fewer birds on it, everything is a lifer.
const MIN_LIFE_LIST = 10
// The same lifer reported again and again (a rarity everyone chases) is news once every few days.
const LIFER_REPEAT_DAYS = 3

const newestPerSpecies = (observations) => {
  const seen = new Set()
  return observations.filter((obs) => !seen.has(obs.speciesCode) && seen.add(obs.speciesCode))
}

const obsKey = (obs) => `${obs.speciesCode}:${obs.subId}`

/**
 * Merges watch-list, notable and first-of-season sightings for one user into one list, each
 * tagged with why it is there. The same observation in the watch-list and notable feeds becomes
 * one entry tagged 'both'; a first of the season keeps that tag whatever else it is.
 */
const mergeSightings = ({ watchlist = [], notable = [], season = [], lifer = [] }) => {
  const merged = new Map()
  for (const obs of watchlist) merged.set(obsKey(obs), { ...obs, kind: 'watchlist' })
  for (const obs of notable) {
    const existing = merged.get(obsKey(obs))
    if (existing) existing.kind = 'both'
    else merged.set(obsKey(obs), { ...obs, kind: 'notable' })
  }
  for (const obs of season) {
    const existing = merged.get(obsKey(obs))
    if (existing) Object.assign(existing, { kind: 'season', lastSeenOn: obs.lastSeenOn })
    else merged.set(obsKey(obs), { ...obs, kind: 'season' })
  }
  // A bird the person has never seen outranks every other reason to tell them.
  for (const obs of lifer) {
    const existing = merged.get(obsKey(obs))
    if (existing) existing.kind = 'lifer'
    else merged.set(obsKey(obs), { ...obs, kind: 'lifer' })
  }
  return [...merged.values()]
}

/** Birds reported in the region that are not on the person's life list, minus ones announced as lifers lately. */
const liferSightings = async (userId, recent) => {
  const seen = new Set(await db('seen_birds').where({ user_id: userId }).pluck('species_code'))
  if (seen.size < MIN_LIFE_LIST) return []
  const candidates = recent.filter((obs) => !seen.has(obs.speciesCode))
  if (!candidates.length) return []
  const lately = new Set(await db('push_log').where({ user_id: userId, kind: 'lifer' }).whereIn('speciesCode', candidates.map((c) => c.speciesCode))
    .where('created_at', '>', db.raw(`now() - interval '${LIFER_REPEAT_DAYS} days'`)).pluck('speciesCode'))
  return candidates.filter((obs) => !lately.has(obs.speciesCode))
}

const regionFeeds = async (region, { needNotable }) => {
  const feeds = { recent: newestPerSpecies(await ebird.recentObservations(region, 1)) }
  if (needNotable) feeds.notable = newestPerSpecies(await ebird.notableObservations(region, 1))
  return feeds
}

/**
 * Keeps the seasonality record current for every region anyone has chosen: looks for returning
 * migrants in today's reports, files today's reports, and fetches a few more days of history.
 * Each region gets one eBird call (shared with the push feeds) plus whatever the time budget allows.
 */
const updateSeasonality = async (regions, feeds, deadline) => {
  const result = { regions: regions.length, seasonFirsts: 0, daysFetched: 0 }
  for (const region of regions) {
    try {
      const recent = feeds.get(region)?.recent || newestPerSpecies(await ebird.recentObservations(region, 1))
      result.seasonFirsts += (await seasonality.detectSeasonFirsts(region, recent)).length
      await seasonality.recordObservations(region, recent)
    } catch (error) {
      console.error(`Seasonality update for ${region} failed:`, error.message)
    }
  }
  for (const region of regions) {
    if (Date.now() > deadline) break
    try {
      result.daysFetched += (await seasonality.backfill(region, { deadline })).fetched
    } catch (error) {
      console.error(`Seasonality backfill for ${region} failed:`, error.message)
    }
  }
  return result
}

/**
 * Pushes new sightings to every subscribed user. Runs hourly (GitHub Actions), asks eBird at most
 * twice per region, and uses push_log so the same observation is never announced twice, whichever
 * feed it came from. Afterwards it brings the seasonality record up to date.
 */
const runPushAlerts = async ({ send = sendToUser, after = 0, deadline = Infinity } = {}) => {
  const started = Date.now()
  const users = await db('users')
    .where('id', '>', after)
    .orderBy('id')
    .whereIn('id', db('push_subscriptions').distinct('user_id'))
    .where((q) => q.where('push_watchlist_enabled', true).orWhere('push_notable_enabled', true).orWhere('push_first_of_season', true).orWhere('push_lifer_enabled', true))
    .whereNot('location', '')
    .whereNotNull('location')

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  // Every chosen region keeps its seasonality record, with or without push users there.
  const allRegions = (await db('users').whereNot('location', '').whereNotNull('location').distinct('location').pluck('location'))
  const feeds = new Map()

  const summary = []
  let held = 0
  // A call that runs out of time says where it stopped; the caller passes it back as `after`.
  let next = null
  const done = new Set()
  regions: for (const [region, regionUsers] of byRegion) {
    let regionFeed
    try {
      regionFeed = await regionFeeds(region, { needNotable: regionUsers.some((u) => u.push_notable_enabled) })
      feeds.set(region, regionFeed)
      // Firsts are judged before today's reports are filed, so a report is never its own precedent.
      if (regionUsers.some((u) => u.push_first_of_season)) await seasonality.detectSeasonFirsts(region, regionFeed.recent)
    } catch (error) {
      console.error(`Sightings for ${region} failed:`, error.message)
      continue
    }

    for (const user of regionUsers) {
      if (Date.now() > deadline) {
        // Users are grouped by region, so ids are not visited in order: resume just below the
        // lowest id not yet done. Anyone re-visited is harmless; push_log stops a second send.
        next = Math.min(...users.filter((u) => !done.has(u.id)).map((u) => u.id)) - 1
        break regions
      }
      done.add(user.id)
      // Quiet hours: nothing is sent or logged, so it all goes out on the first run after they end.
      if (inQuietHours(user)) { held += 1; continue }
      let watchlist = []
      if (user.push_watchlist_enabled) {
        const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
        watchlist = regionFeed.recent.filter((obs) => saved.has(obs.speciesCode))
      }
      const notable = user.push_notable_enabled && regionFeed.notable ? regionFeed.notable : []
      const season = user.push_first_of_season ? await seasonality.recentSeasonFirsts(region) : []
      const lifer = user.push_lifer_enabled ? await liferSightings(user.id, regionFeed.recent) : []
      const candidates = mergeSightings({ watchlist, notable, season, lifer })
      if (!candidates.length) continue

      const announced = new Set(
        (await db('push_log').where('user_id', user.id).whereIn('speciesCode', candidates.map((c) => c.speciesCode)))
          .map((row) => `${row.speciesCode}:${row.sub_id}`)
      )
      let fresh = candidates.filter((obs) => !announced.has(obsKey(obs)))
      if (!fresh.length) continue

      // Notable-only news goes out at once unless the user chose batching, in which case it waits
      // while a notable push went out recently. Watch-list news always goes immediately.
      if (user.push_notable_batched && fresh.every((obs) => obs.kind === 'notable')) {
        const recentNotable = await db('push_log')
          .where({ user_id: user.id, kind: 'notable' })
          .where('created_at', '>', db.raw(`now() - interval '${NOTABLE_BATCH_HOURS} hours'`))
          .first()
        if (recentNotable) continue
      }
      fresh = fresh.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

      // Watch-list birds share one notification. Notable, notable-and-watched and first-of-season
      // birds each get a rich one (photo, map, actions), with a summary for any overflow. The
      // batch goes first so the rare birds end up on top. Notable species may be new to us;
      // resolve them so the notification has a photo.
      const birds = await findOrCreateBirds(fresh.map((obs) => obs.speciesCode)).catch((error) => {
        console.error('Bird lookup for notifications failed:', error.message)
        return []
      })
      const birdByCode = new Map(birds.map((b) => [b.speciesCode, b]))
      const watched = fresh.filter((obs) => obs.kind === 'watchlist')
      const single = fresh.filter((obs) => obs.kind !== 'watchlist')
      const individual = single.slice(0, MAX_RICH_PER_RUN)
      const overflow = single.slice(MAX_RICH_PER_RUN)
      const result = { sent: 0, gone: 0 }
      if (watched.length) {
        const r = await send(user.id, watchlistNotification(watched, birdByCode, region))
        result.sent += r.sent; result.gone += r.gone
      }
      for (const obs of individual) {
        const r = await send(user.id, sightingNotification({ ...obs, region }, birdByCode.get(obs.speciesCode)))
        result.sent += r.sent; result.gone += r.gone
      }
      if (overflow.length) {
        const r = await send(user.id, summaryNotification(overflow))
        result.sent += r.sent; result.gone += r.gone
      }
      // Record what went out so no observation is ever announced twice.
      if (result.sent > 0) {
        await db('push_log')
          .insert(fresh.map((obs) => ({ user_id: user.id, speciesCode: obs.speciesCode, sub_id: obs.subId, kind: obs.kind === 'both' ? 'watchlist' : obs.kind })))
          .onConflict(['user_id', 'speciesCode', 'sub_id'])
          .ignore()
      }
      summary.push({ userId: user.id, region, birds: fresh.length, ...result })
    }
  }

  // The seasonality pass and housekeeping run once, on the call that finishes the users.
  if (next !== null) {
    const partial = { notified: summary.length, heldForQuietHours: held, summary, more: true, next }
    await recordRun('push', { notified: partial.notified, heldForQuietHours: held, more: true })
    return partial
  }
  const seasons = await updateSeasonality(allRegions, feeds, started + BACKFILL_BUDGET_MS)

  // Housekeeping that rides along with the hourly run.
  await db('push_log').where('created_at', '<', db.raw(`now() - interval '${LOG_RETENTION_DAYS} days'`)).del()
  await db('auth_throttle').where('window_start', '<', db.raw(`now() - interval '${THROTTLE_RETENTION_HOURS} hours'`)).del()

  const result = { notified: summary.length, heldForQuietHours: held, summary, seasonality: seasons, more: false, next: null }
  await recordRun('push', { notified: result.notified, heldForQuietHours: held })
  return result
}

module.exports = { runPushAlerts, newestPerSpecies, mergeSightings }
