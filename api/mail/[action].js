const { route, body, HttpError } = require('../../lib/http')
const { requireUser } = require('../../lib/auth')
const { assertCronCaller, runDigest, previewDigest } = require('../../lib/digest')
const { DIGESTS } = require('../../lib/digests')
const { runHqDesk } = require('../../lib/hqDesk')

// One function for every email the app sends on a schedule, plus the preview; Vercel's Hobby plan
// allows twelve functions per deployment, so routes that share a shape share a file.
const cron = (kind) => ({
  methods: ['GET'],
  handler: async (req, res) => {
    assertCronCaller(req)
    // Each call gets 45 seconds; the caller repeats while `more` is true.
    res.status(200).json(await runDigest({ kind, ...DIGESTS[kind], deadline: Date.now() + 45_000 }))
  }
})

const actions = {
  // GET /api/mail/watchlist (daily cron) -> emails subscribed, confirmed users whose watch-list birds were seen yesterday
  watchlist: cron('watchlist'),
  // GET /api/mail/rare (daily cron) -> emails subscribed, confirmed users eBird's notable sightings from yesterday
  rare: cron('rare'),
  // GET /api/mail/migration (weekly, GitHub Actions) -> the week's arrivals, departures and expected species per region
  migration: cron('migration'),
  // GET /api/mail/hq-desk (daily cron) -> the country's top rarities, ranked, with drafted posts and share links, emailed to the owner
  'hq-desk': {
    methods: ['GET'],
    handler: async (req, res) => {
      assertCronCaller(req)
      res.status(200).json(await runHqDesk())
    }
  },

  // POST /api/mail/preview { kind: 'watchlist' | 'rare' | 'migration' } -> sends that email to the caller now
  // -> { sent: true, items } or { sent: false, reason: 'nothing' | 'unconfirmed' | 'location' }
  preview: {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const { kind } = body(req)
      if (!Object.hasOwn(DIGESTS, kind)) throw new HttpError(400, 'Unknown email kind')
      res.status(200).json(await previewDigest(user, DIGESTS[kind]))
    }
  }
}

module.exports = async (req, res) => {
  const action = actions[req.query.action]
  if (!action) return res.status(404).json({ error: 'Not found' })
  return route(action.methods, action.handler)(req, res)
}
