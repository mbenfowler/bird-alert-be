const { route } = require('../lib/http')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { DIGESTS } = require('../lib/digests')

// GET /api/rareSightingsMailer (daily cron) -> emails subscribed, confirmed users eBird's notable sightings from yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  res.status(200).json(await runDigest({ kind: 'rare', ...DIGESTS.rare }))
})
