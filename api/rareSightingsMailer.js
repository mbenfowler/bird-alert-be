const { route } = require('../lib/http')
const db = require('../lib/db')
const ebird = require('../lib/ebird')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { findOrCreateBirds } = require('../lib/enrich')
const { sendRareSightingsEmail } = require('../lib/mailer')

// GET /api/rareSightingsMailer (daily cron) -> emails subscribed, confirmed users eBird's notable sightings from yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  const result = await runDigest({
    kind: 'rare',
    preference: 'rare_sightings_email_enabled',
    fetchSightings: (region) => ebird.notableObservations(region, 1),
    select: async (user, sightings) => {
      const pushed = new Set((await db('push_log').where('user_id', user.id).select('speciesCode', 'sub_id')).map((r) => `${r.speciesCode}:${r.sub_id}`))
      return sightings.filter((obs) => !pushed.has(`${obs.speciesCode}:${obs.subId}`))
    },
    send: async (user, sightings) => {
      const birds = await findOrCreateBirds(sightings.map((s) => s.speciesCode)).catch(() => [])
      return sendRareSightingsEmail(user, sightings, new Map(birds.map((b) => [b.speciesCode, b])))
    }
  })
  res.status(200).json(result)
})
