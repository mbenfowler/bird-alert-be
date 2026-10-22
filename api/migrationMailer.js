const { route } = require('../lib/http')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { DIGESTS } = require('../lib/digests')

// GET /api/migrationMailer (weekly, GitHub Actions) -> the week's arrivals, departures and expected species per region
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  res.status(200).json(await runDigest({ kind: 'migration', ...DIGESTS.migration }))
})
