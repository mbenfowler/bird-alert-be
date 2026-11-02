const db = require('./db')
const { HttpError } = require('./http')
const { recordRun } = require('./jobRuns')
const { activePlacesFor, atPlace: placeVisitor, areaName } = require('./places')

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
 * `preference` is the user column that asks for the email, or a function narrowing the users query.
 */
const runDigest = async ({ kind, preference, fetchSightings, select, send, places = false, deadline = Infinity }) => {
  const users = await db('users')
    .modify((q) => (typeof preference === 'function' ? preference(q) : q.where({ [preference]: true })))
    .where({ email_confirmed: true })
    .whereNot('location', '')
    .whereNotNull('location')

  const sentOn = todayUtc()
  const alreadySent = new Set(
    await db('digest_log').where({ kind, sent_on: sentOn }).whereIn('user_id', users.map((u) => u.id)).pluck('user_id')
  )

  const byRegion = new Map()
  for (const user of users) byRegion.set(user.location, [...(byRegion.get(user.location) || []), user])

  // Someone at one of their places (lib/places) also gets that place's birds, under its name, and
  // home's only if they kept home alerts on. Each place's area is asked for once per run.
  const active = places ? await activePlacesFor(users) : new Map()
  const areaSightings = new Map()
  const placeRows = async (user) => {
    const away = active.get(user.id)
    if (!away) return []
    const area = away.place.location
    if (!areaSightings.has(area)) areaSightings.set(area, fetchSightings(area).then(newestPerSpecies).catch(() => []))
    const county = await areaName(away.place)
    const rows = await select(placeVisitor(user, away), await areaSightings.get(area))
    return rows.map((obs) => ({ ...obs, ...(obs.away ? { away: { ...obs.away, miles: null } } : {}), atPlace: { id: away.place.id, name: away.place.name, county } }))
  }
  const homeToo = (user) => !active.has(user.id) || user.keep_home_alerts !== false

  const summary = []
  let skipped = 0
  let more = false
  let capped = false
  regions: for (const [region, regionUsers] of byRegion) {
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
      // Out of time: the log makes the next call pick up exactly here.
      if (Date.now() > deadline) { more = true; break regions }
      const home = homeToo(user) ? await select(user, sightings) : []
      const seen = new Set(home.map((obs) => `${obs.speciesCode}:${obs.subId}`))
      const relevant = [...home, ...(await placeRows(user)).filter((obs) => !seen.has(`${obs.speciesCode}:${obs.subId}`))]
      if (!relevant.length) continue
      try {
        await send(user, relevant)
        await db('digest_log').insert({ user_id: user.id, kind, sent_on: sentOn, alerts: relevant.length })
        summary.push({ userId: user.id, region, alerts: relevant.length })
      } catch (error) {
        if (error.code === 'MAIL_CAP') {
          capped = true
          await require('./errors').reportError(`digest ${kind}`, error)
          break regions
        }
        await require('./errors').reportError(`digest ${kind} to user ${user.id}`, error)
      }
    }
  }
  const result = { sent: summary.length, skippedAlreadySent: skipped, more, capped, summary }
  await recordRun(kind, { sent: result.sent, skippedAlreadySent: skipped, more, capped })
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
