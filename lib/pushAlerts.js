const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { sightingNotification, summaryNotification } = require('./notifications')
const { findOrCreateBirds } = require('./enrich')
const { inQuietHours } = require('./quietHours')
const { recordRun } = require('./jobRuns')
const seasonality = require('./seasonality')

const LOG_RETENTION_DAYS = 7
const THROTTLE_RETENTION_HOURS = 24
// Users who opt into batching get notable-only news at most this often. Watch-list news never waits.
const NOTABLE_BATCH_HOURS = 6
const MAX_NAMED = 3
// Sightings get their own rich notification up to this many per run; the rest share one summary.
const MAX_RICH_PER_RUN = 4
// Time each run may spend fetching older days of seasonality history, after the pushes themselves.
const BACKFILL_BUDGET_MS = 6000
const KIND_ORDER = { season: 0, both: 1, watchlist: 1, notable: 2 }

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
const mergeSightings = ({ watchlist = [], notable = [], season = [] }) => {
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
  return [...merged.values()]
}

const label = (s) => (s.kind === 'notable' ? `${s.comName} (notable)` : s.comName)

const describe = (sightings) => {
  const onList = sightings.filter((s) => s.kind !== 'notable')
  const notableOnly = sightings.filter((s) => s.kind === 'notable')
  if (sightings.length === 1) {
    const [s] = sightings
    const title = s.kind === 'notable' ? `Notable sighting nearby: ${s.comName}` : `${s.comName} spotted nearby!`
    return { title, body: `Reported at ${s.locName} (${s.obsDt}).`, tag: `bird-${s.speciesCode}` }
  }
  const names = sightings.slice(0, MAX_NAMED).map(label).join(', ')
  const more = sightings.length > MAX_NAMED ? ` and ${sightings.length - MAX_NAMED} more` : ''
  let title
  if (!notableOnly.length) title = `${sightings.length} birds from your watch list spotted nearby!`
  else if (!onList.length) title = `${sightings.length} notable sightings nearby`
  else title = `${sightings.length} sightings nearby (${onList.length} watch list, ${notableOnly.length} notable)`
  return { title, body: `${names}${more}.`, tag: 'bird-alerts' }
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
const runPushAlerts = async ({ send = sendToUser } = {}) => {
  const started = Date.now()
  const users = await db('users')
    .whereIn('id', db('push_subscriptions').distinct('user_id'))
    .where((q) => q.where('push_watchlist_enabled', true).orWhere('push_notable_enabled', true).orWhere('push_first_of_season', true))
    .whereNot('location', '')
    .whereNotNull('location')

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  // Every chosen region keeps its seasonality record, with or without push users there.
  const allRegions = (await db('users').whereNot('location', '').whereNotNull('location').distinct('location').pluck('location'))
  const feeds = new Map()

  const summary = []
  let held = 0
  for (const [region, regionUsers] of byRegion) {
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
      // Quiet hours: nothing is sent or logged, so it all goes out on the first run after they end.
      if (inQuietHours(user)) { held += 1; continue }
      let watchlist = []
      if (user.push_watchlist_enabled) {
        const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
        watchlist = regionFeed.recent.filter((obs) => saved.has(obs.speciesCode))
      }
      const notable = user.push_notable_enabled && regionFeed.notable ? regionFeed.notable : []
      const season = user.push_first_of_season ? await seasonality.recentSeasonFirsts(region) : []
      const candidates = mergeSightings({ watchlist, notable, season })
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

      // One rich notification per sighting (photo, map, actions), then a summary for any overflow.
      // Notable species may be new to us; resolve them so the notification has a photo.
      const birds = await findOrCreateBirds(fresh.map((obs) => obs.speciesCode)).catch((error) => {
        console.error('Bird lookup for notifications failed:', error.message)
        return []
      })
      const birdByCode = new Map(birds.map((b) => [b.speciesCode, b]))
      const individual = fresh.slice(0, MAX_RICH_PER_RUN)
      const overflow = fresh.slice(MAX_RICH_PER_RUN)
      const result = { sent: 0, gone: 0 }
      for (const obs of individual) {
        const r = await send(user.id, sightingNotification(obs, birdByCode.get(obs.speciesCode)))
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

  const seasons = await updateSeasonality(allRegions, feeds, started + BACKFILL_BUDGET_MS)

  // Housekeeping that rides along with the hourly run.
  await db('push_log').where('created_at', '<', db.raw(`now() - interval '${LOG_RETENTION_DAYS} days'`)).del()
  await db('auth_throttle').where('window_start', '<', db.raw(`now() - interval '${THROTTLE_RETENTION_HOURS} hours'`)).del()

  const result = { notified: summary.length, heldForQuietHours: held, summary, seasonality: seasons }
  await recordRun('push', { notified: result.notified, heldForQuietHours: held })
  return result
}

module.exports = { runPushAlerts, describe, newestPerSpecies, mergeSightings }
