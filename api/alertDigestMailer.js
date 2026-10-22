const { route } = require('../lib/http')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { DIGESTS } = require('../lib/digests')

// GET /api/alertDigestMailer (daily cron) -> emails subscribed, confirmed users whose watch-list birds were seen yesterday
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  res.status(200).json(await runDigest({ kind: 'watchlist', ...DIGESTS.watchlist }))
})
