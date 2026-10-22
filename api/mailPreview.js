const { route, body, HttpError } = require('../lib/http')
const { requireUser } = require('../lib/auth')
const { previewDigest } = require('../lib/digest')
const { DIGESTS } = require('../lib/digests')

// POST /api/mailPreview { kind: 'watchlist' | 'rare' | 'migration' } -> sends that email to the caller now
// -> { sent: true, items } or { sent: false, reason: 'nothing' | 'unconfirmed' | 'location' }
module.exports = route(['POST'], async (req, res) => {
  const user = await requireUser(req)
  const { kind } = body(req)
  if (!Object.hasOwn(DIGESTS, kind)) throw new HttpError(400, 'Unknown email kind')
  res.status(200).json(await previewDigest(user, DIGESTS[kind]))
})
