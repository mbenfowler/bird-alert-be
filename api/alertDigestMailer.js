const { route } = require('../lib/http')
const db = require('../lib/db')
const ebird = require('../lib/ebird')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { findOrCreateBirds } = require('../lib/enrich')
const { sendAlertDigestEmail } = require('../lib/mailer')

// GET /api/alertDigestMailer (daily cron) -> emails subscribed, confirmed users whose watch-list birds were seen yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  const result = await runDigest({
    kind: 'watchlist',
    preference: 'alert_digest_email_enabled',
    fetchSightings: (region) => ebird.recentObservations(region, 1),
    select: async (user, sightings) => {
      const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
      const pushed = new Set((await db('push_log').where('user_id', user.id).select('speciesCode', 'sub_id')).map((r) => `${r.speciesCode}:${r.sub_id}`))
      // Anything already pushed to this user's devices is old news by morning.
      return sightings.filter((obs) => saved.has(obs.speciesCode) && !pushed.has(`${obs.speciesCode}:${obs.subId}`))
    },
    send: async (user, sightings) => {
      const birds = await findOrCreateBirds(sightings.map((s) => s.speciesCode)).catch(() => [])
      return sendAlertDigestEmail(user, sightings, new Map(birds.map((b) => [b.speciesCode, b])))
    }
  })
  res.status(200).json(result)
})
