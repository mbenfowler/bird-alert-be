const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { sightingNotification, summaryNotification } = require('./notifications')

const LOG_RETENTION_DAYS = 7
const THROTTLE_RETENTION_HOURS = 24
// Users who opt into batching get notable-only news at most this often. Watch-list news never waits.
const NOTABLE_BATCH_HOURS = 6
const MAX_NAMED = 3
// Sightings get their own rich notification up to this many per run; the rest share one summary.
const MAX_RICH_PER_RUN = 4

const newestPerSpecies = (observations) => {
  const seen = new Set()
  return observations.filter((obs) => !seen.has(obs.speciesCode) && seen.add(obs.speciesCode))
}

const obsKey = (obs) => `${obs.speciesCode}:${obs.subId}`

/**
 * Merges watch-list and notable sightings for one user into one list, each tagged with why it
 * is there. The same observation appearing in both feeds becomes one entry tagged 'both'.
 */
const mergeSightings = ({ watchlist = [], notable = [] }) => {
  const merged = new Map()
  for (const obs of watchlist) merged.set(obsKey(obs), { ...obs, kind: 'watchlist' })
  for (const obs of notable) {
    const existing = merged.get(obsKey(obs))
    if (existing) existing.kind = 'both'
    else merged.set(obsKey(obs), { ...obs, kind: 'notable' })
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

const regionFeeds = async (region, { needWatchlist, needNotable }) => {
  const feeds = {}
  if (needWatchlist) feeds.recent = newestPerSpecies(await ebird.recentObservations(region, 1))
  if (needNotable) feeds.notable = newestPerSpecies(await ebird.notableObservations(region, 1))
  return feeds
}

/**
 * Pushes new sightings to every subscribed user. Runs hourly (GitHub Actions), asks eBird at most
 * twice per region, and uses push_log so the same observation is never announced twice, whichever
 * feed it came from.
 */
const runPushAlerts = async () => {
  const users = await db('users')
    .whereIn('id', db('push_subscriptions').distinct('user_id'))
    .where((q) => q.where('push_watchlist_enabled', true).orWhere('push_notable_enabled', true))
    .whereNot('location', '')
    .whereNotNull('location')

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  const summary = []
  for (const [region, regionUsers] of byRegion) {
    let feeds
    try {
      feeds = await regionFeeds(region, {
        needWatchlist: regionUsers.some((u) => u.push_watchlist_enabled),
        needNotable: regionUsers.some((u) => u.push_notable_enabled)
      })
    } catch (error) {
      console.error(`Sightings for ${region} failed:`, error.message)
      continue
    }

    for (const user of regionUsers) {
      let watchlist = []
      if (user.push_watchlist_enabled && feeds.recent) {
        const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
        watchlist = feeds.recent.filter((obs) => saved.has(obs.speciesCode))
      }
      const notable = user.push_notable_enabled && feeds.notable ? feeds.notable : []
      const candidates = mergeSightings({ watchlist, notable })
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
      fresh = fresh.sort((a, b) => (a.kind === 'notable') - (b.kind === 'notable'))

      // One rich notification per sighting (photo, map, actions), then a summary for any overflow.
      const birds = await db('birds').whereIn('speciesCode', fresh.map((obs) => obs.speciesCode)).select('speciesCode', 'birdImg')
      const birdByCode = new Map(birds.map((b) => [b.speciesCode, b]))
      const individual = fresh.slice(0, MAX_RICH_PER_RUN)
      const overflow = fresh.slice(MAX_RICH_PER_RUN)
      const result = { sent: 0, gone: 0 }
      for (const obs of individual) {
        const r = await sendToUser(user.id, sightingNotification(obs, birdByCode.get(obs.speciesCode)))
        result.sent += r.sent; result.gone += r.gone
      }
      if (overflow.length) {
        const r = await sendToUser(user.id, summaryNotification(overflow))
        result.sent += r.sent; result.gone += r.gone
      }
      summary.push({ userId: user.id, region, birds: fresh.length, ...result })
    }
  }

  // Housekeeping that rides along with the hourly run.
  await db('push_log').where('created_at', '<', db.raw(`now() - interval '${LOG_RETENTION_DAYS} days'`)).del()
  await db('auth_throttle').where('window_start', '<', db.raw(`now() - interval '${THROTTLE_RETENTION_HOURS} hours'`)).del()

  return { notified: summary.length, summary }
}

module.exports = { runPushAlerts, describe, newestPerSpecies, mergeSightings }
