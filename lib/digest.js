const db = require('./db')
const { HttpError } = require('./http')

// Vercel sends `Authorization: Bearer <CRON_SECRET>` with scheduled invocations when CRON_SECRET is set.
const assertCronCaller = (req) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'CRON_SECRET is not configured')
    return
  }
  if (req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Unauthorized')
}

// eBird lists observations newest first; keep the first per species.
const newestPerSpecies = (observations) => {
  const seen = new Set()
  return observations.filter((obs) => !seen.has(obs.speciesCode) && seen.add(obs.speciesCode))
}

/**
 * Runs one kind of email digest. Subscribers are grouped by region so eBird is asked once per
 * region, not once per bird per user. `select` narrows the region's sightings to one user.
 */
const runDigest = async ({ preference, fetchSightings, select, send }) => {
  const users = await db('users')
    .where({ [preference]: true, email_confirmed: true })
    .whereNot('location', '')
    .whereNotNull('location')

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  const summary = []
  for (const [region, regionUsers] of byRegion) {
    let sightings
    try {
      sightings = newestPerSpecies(await fetchSightings(region))
    } catch (error) {
      console.error(`Sightings for ${region} failed:`, error.message)
      continue
    }
    for (const user of regionUsers) {
      const relevant = await select(user, sightings)
      if (!relevant.length) continue
      try {
        await send(user, relevant)
        summary.push({ userId: user.id, region, alerts: relevant.length })
      } catch (error) {
        console.error(`Digest to user ${user.id} failed:`, error.message)
      }
    }
  }
  return summary
}

module.exports = { assertCronCaller, runDigest }
