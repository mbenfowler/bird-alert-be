const { route, body, HttpError } = require('../../lib/http')
const { requireUser } = require('../../lib/auth')
const { assertCronCaller, runDigest, previewDigest } = require('../../lib/digest')
const { DIGESTS } = require('../../lib/digests')
const { runHqDesk, approvePost } = require('../../lib/hqDesk')
const { runConfirmReminders } = require('../../lib/confirmReminder')

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
  // GET /api/mail/reminders (hourly cron) -> one "confirm your email" reminder to each account a day to a week old that hasn't
  //   confirmed yet; logged in digest_log, so never twice
  reminders: {
    methods: ['GET'],
    handler: async (req, res) => {
      assertCronCaller(req)
      res.status(200).json(await runConfirmReminders())
    }
  },
  // GET /api/mail/migration (weekly, GitHub Actions) -> the week's arrivals, departures and expected species per region
  migration: cron('migration'),
  // GET /api/mail/hq-desk[?force=1] (daily cron) -> the country's top rarities, ranked, with drafted posts and share links, emailed
  //   to the owner; once a day unless forced
  'hq-desk': {
    methods: ['GET'],
    handler: async (req, res) => {
      assertCronCaller(req)
      res.status(200).json(await runHqDesk({ force: req.query.force === '1' }))
    }
  },

  // GET /api/mail/hq-post?token= -> a page to confirm one of the morning's picks; POST (its button) posts it to @BirdAlertHQ.
  //   The signed token is the authority (it lasts two days, one post per pick); a GET never posts, so link scanners are harmless.
  'hq-post': {
    methods: ['GET', 'POST'],
    handler: async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.status(200).send(await approvePost({ method: req.method, token: req.query.token }))
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
