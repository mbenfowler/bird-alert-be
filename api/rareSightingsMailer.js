const { route } = require('../lib/http')
const ebird = require('../lib/ebird')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { sendRareSightingsEmail } = require('../lib/mailer')

// GET /api/rareSightingsMailer (daily cron) -> emails subscribed, confirmed users eBird's notable sightings from yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  const summary = await runDigest({
    preference: 'rare_sightings_email_enabled',
    fetchSightings: (region) => ebird.notableObservations(region, 1),
    select: async (_user, sightings) => sightings,
    send: sendRareSightingsEmail
  })
  res.status(200).json({ sent: summary.length, summary })
})
