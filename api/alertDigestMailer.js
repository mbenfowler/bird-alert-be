const { route } = require('../lib/http')
const db = require('../lib/db')
const ebird = require('../lib/ebird')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { sendAlertDigestEmail } = require('../lib/mailer')

// GET /api/alertDigestMailer (daily cron) -> emails subscribed, confirmed users whose watch-list birds were seen yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  const summary = await runDigest({
    preference: 'alert_digest_email_enabled',
    fetchSightings: (region) => ebird.recentObservations(region, 1),
    select: async (user, sightings) => {
      const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
      return sightings.filter((obs) => saved.has(obs.speciesCode))
    },
    send: sendAlertDigestEmail
  })
  res.status(200).json({ sent: summary.length, summary })
})
