const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')

const LOG_RETENTION_DAYS = 7
const THROTTLE_RETENTION_HOURS = 24

const newestPerSpecies = (observations) => {
  const seen = new Set()
  return observations.filter((obs) => !seen.has(obs.speciesCode) && seen.add(obs.speciesCode))
}

const describe = (sightings) => {
  if (sightings.length === 1) {
    const [s] = sightings
    return { title: `${s.comName} spotted nearby!`, body: `Reported at ${s.locName} (${s.obsDt}).`, tag: `bird-${s.speciesCode}` }
  }
  const names = sightings.slice(0, 3).map((s) => s.comName).join(', ')
  const more = sightings.length > 3 ? ` and ${sightings.length - 3} more` : ''
  return { title: `${sightings.length} birds from your watch list spotted nearby!`, body: `${names}${more}.`, tag: 'bird-alerts' }
}

/**
 * Pushes new watch-list sightings to every subscribed user. Runs hourly (GitHub Actions), asks
 * eBird once per region, and uses push_log so the same observation is never announced twice.
 */
const runPushAlerts = async () => {
  const users = await db('users')
    .whereIn('id', db('push_subscriptions').distinct('user_id'))
    .whereNot('location', '')
    .whereNotNull('location')

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  const summary = []
  for (const [region, regionUsers] of byRegion) {
    let sightings
    try {
      sightings = newestPerSpecies(await ebird.recentObservations(region, 1))
    } catch (error) {
      console.error(`Sightings for ${region} failed:`, error.message)
      continue
    }
    for (const user of regionUsers) {
      const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
      const candidates = sightings.filter((obs) => saved.has(obs.speciesCode))
      if (!candidates.length) continue

      const announced = new Set(
        (await db('push_log').where('user_id', user.id).whereIn('speciesCode', candidates.map((c) => c.speciesCode)))
          .map((row) => `${row.speciesCode}:${row.sub_id}`)
      )
      const fresh = candidates.filter((obs) => !announced.has(`${obs.speciesCode}:${obs.subId}`))
      if (!fresh.length) continue

      const result = await sendToUser(user.id, { ...describe(fresh), url: '/' })
      if (result.sent > 0) {
        await db('push_log')
          .insert(fresh.map((obs) => ({ user_id: user.id, speciesCode: obs.speciesCode, sub_id: obs.subId })))
          .onConflict(['user_id', 'speciesCode', 'sub_id'])
          .ignore()
      }
      summary.push({ userId: user.id, region, birds: fresh.length, ...result })
    }
  }

  // Housekeeping that rides along with the hourly run.
  await db('push_log').where('created_at', '<', db.raw(`now() - interval '${LOG_RETENTION_DAYS} days'`)).del()
  await db('auth_throttle').where('window_start', '<', db.raw(`now() - interval '${THROTTLE_RETENTION_HOURS} hours'`)).del()

  return { notified: summary.length, summary }
}

module.exports = { runPushAlerts, describe, newestPerSpecies }
