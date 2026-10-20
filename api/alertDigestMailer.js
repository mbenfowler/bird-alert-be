const { route, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { sendAlertDigestEmail } = require('../lib/mailer')

// Vercel sends `Authorization: Bearer <CRON_SECRET>` with scheduled invocations when CRON_SECRET is set.
const assertCronCaller = (req) => {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'CRON_SECRET is not configured')
    return
  }
  if (req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Unauthorized')
}

const recentSighting = async (region, speciesCode) => {
  const url = `https://api.ebird.org/v2/data/obs/${encodeURIComponent(region)}/recent/${encodeURIComponent(speciesCode)}?back=1`
  const response = await fetch(url, { headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY } })
  if (!response.ok) {
    console.error(`eBird ${response.status} for ${region}/${speciesCode}`)
    return null
  }
  const observations = await response.json()
  return observations[0] || null
}

// GET /api/alertDigestMailer -> emails each subscribed, confirmed user whose watch-list birds were seen in the last day
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)

  const users = await db('users')
    .where({ alert_digest_email_enabled: true, email_confirmed: true })
    .whereNot('location', '')
    .whereNotNull('location')

  const summary = []
  for (const user of users) {
    const savedCodes = (await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
    if (!savedCodes.length) continue

    const sightings = (await Promise.all(savedCodes.map((code) => recentSighting(user.location, code)))).filter(Boolean)
    if (!sightings.length) continue

    try {
      await sendAlertDigestEmail(user, sightings)
      summary.push({ userId: user.id, alerts: sightings.length })
    } catch (error) {
      console.error(`Digest to user ${user.id} failed:`, error)
    }
  }

  res.status(200).json({ sent: summary.length, summary })
})
