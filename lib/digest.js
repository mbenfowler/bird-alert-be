const db = require('./db')
const { HttpError } = require('./http')
const { recordRun } = require('./jobRuns')

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

const todayUtc = () => new Date().toISOString().slice(0, 10)

/**
 * Runs one kind of email digest. Subscribers are grouped by region so eBird is asked once per
 * region, not once per bird per user. `select` narrows the region's sightings to one user.
 * Each send is logged per user, kind and UTC day, and a user already logged today is skipped.
 */
const runDigest = async ({ kind, preference, fetchSightings, select, send }) => {
  const users = await db('users')
    .where({ [preference]: true, email_confirmed: true })
    .whereNot('location', '')
    .whereNotNull('location')

  const sentOn = todayUtc()
  const alreadySent = new Set(
    await db('digest_log').where({ kind, sent_on: sentOn }).whereIn('user_id', users.map((u) => u.id)).pluck('user_id')
  )

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  const summary = []
  let skipped = 0
  for (const [region, regionUsers] of byRegion) {
    const pending = regionUsers.filter((user) => !alreadySent.has(user.id))
    skipped += regionUsers.length - pending.length
    if (!pending.length) continue

    let sightings
    try {
      sightings = newestPerSpecies(await fetchSightings(region))
    } catch (error) {
      console.error(`Sightings for ${region} failed:`, error.message)
      continue
    }
    for (const user of pending) {
      const relevant = await select(user, sightings)
      if (!relevant.length) continue
      try {
        await send(user, relevant)
        await db('digest_log').insert({ user_id: user.id, kind, sent_on: sentOn, alerts: relevant.length })
        summary.push({ userId: user.id, region, alerts: relevant.length })
      } catch (error) {
        console.error(`Digest to user ${user.id} failed:`, error.message)
      }
    }
  }
  const result = { sent: summary.length, skippedAlreadySent: skipped, summary }
  await recordRun(kind, { sent: result.sent, skippedAlreadySent: skipped })
  return result
}

/**
 * Sends one kind of digest to one user right now, outside the schedule and the once-a-day log, so
 * they can see what it looks like. Returns what happened rather than throwing for the empty case.
 */
const previewDigest = async (user, { fetchSightings, select, send }) => {
  if (!user.location) return { sent: false, reason: 'location' }
  if (!user.email_confirmed) return { sent: false, reason: 'unconfirmed' }
  const sightings = newestPerSpecies(await fetchSightings(user.location))
  const relevant = await select(user, sightings, { preview: true })
  if (!relevant.length) return { sent: false, reason: 'nothing' }
  await send(user, relevant)
  return { sent: true, items: relevant.length }
}

module.exports = { assertCronCaller, runDigest, previewDigest, newestPerSpecies }
