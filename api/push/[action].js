const { route, body, HttpError } = require('../../lib/http')
const db = require('../../lib/db')
const { requireUser } = require('../../lib/auth')
const { assertCronCaller } = require('../../lib/digest')
const push = require('../../lib/push')
const { runPushAlerts } = require('../../lib/pushAlerts')
const { lastRun } = require('../../lib/jobRuns')
const { testNotification } = require('../../lib/notifications')
const ebird = require('../../lib/ebird')

const assertConfigured = () => {
  if (!push.configured) throw new HttpError(503, 'Push notifications are not configured on the server')
}

const subscriptionFromBody = (req) => {
  const { endpoint, keys, userAgent } = body(req)
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 2000) throw new HttpError(400, 'A push endpoint is required')
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw new HttpError(400, 'Subscription keys are required')
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: typeof userAgent === 'string' ? userAgent.slice(0, 255) : null }
}

const actions = {
  // GET /api/push/public-key -> { publicKey }
  'public-key': {
    methods: ['GET'],
    handler: async (req, res) => {
      assertConfigured()
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.status(200).json({ publicKey: push.publicKey() })
    }
  },

  // POST /api/push/subscribe { endpoint, keys: { p256dh, auth }, userAgent? } -> 201 (idempotent per endpoint)
  subscribe: {
    methods: ['POST'],
    handler: async (req, res) => {
      assertConfigured()
      const user = await requireUser(req)
      const subscription = subscriptionFromBody(req)
      await db('push_subscriptions')
        .insert({ ...subscription, user_id: user.id })
        .onConflict('endpoint')
        .merge({ user_id: user.id, p256dh: subscription.p256dh, auth: subscription.auth, user_agent: subscription.user_agent, last_seen_at: db.fn.now() })
      res.status(201).json({ ok: true })
    }
  },

  // POST /api/push/unsubscribe { endpoint } -> 204
  unsubscribe: {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const { endpoint } = body(req)
      if (typeof endpoint !== 'string') throw new HttpError(400, 'A push endpoint is required')
      await db('push_subscriptions').where({ user_id: user.id, endpoint }).del()
      res.status(204).end()
    }
  },

  // GET /api/push/status?endpoint= -> { subscribed, devices, lastRun: { at, notified, heldForQuietHours } | null }
  status: {
    methods: ['GET'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const [rows, run] = await Promise.all([
        db('push_subscriptions').where({ user_id: user.id }).select('endpoint'),
        lastRun('push')
      ])
      const subscribed = typeof req.query.endpoint === 'string' && rows.some((row) => row.endpoint === req.query.endpoint)
      res.status(200).json({
        subscribed,
        devices: rows.length,
        lastRun: run ? { at: run.ran_at, ...(run.detail || {}) } : null
      })
    }
  },

  // POST /api/push/test { endpoint? } -> sends a test notification to this device (or all of the user's devices)
  test: {
    methods: ['POST'],
    handler: async (req, res) => {
      assertConfigured()
      const user = await requireUser(req)
      // Preview with the user's own birds from the region's recent reports, so the test looks and
      // taps exactly like a real watch-list alert: names first, and the sightings page behind it.
      let payload = null
      if (user.location) {
        try {
          const recent = await ebird.recentObservations(user.location, 7)
          const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
          const codes = [...new Set(recent.slice(0, 20).map((obs) => obs.speciesCode))]
          const birds = codes.length ? await db('birds').whereIn('speciesCode', codes) : []
          payload = testNotification(recent, saved, new Map(birds.map((b) => [b.speciesCode, b])))
        } catch (error) {
          console.error('Test preview sighting failed, sending a plain test:', error.message)
        }
      }
      const { endpoint } = body(req)
      const result = await push.sendToUser(user.id, payload || {
        title: 'Bird Alert notifications are on',
        body: 'You will hear from us when a bird on your watch list is reported nearby.',
        tag: 'bird-alert-test',
        data: { url: '/' }
      }, { endpoint: typeof endpoint === 'string' ? endpoint : undefined })
      res.status(200).json(result)
    }
  },

  // GET /api/push/alerts (hourly cron) -> pushes new watch-list sightings
  alerts: {
    methods: ['GET'],
    handler: async (req, res) => {
      assertCronCaller(req)
      assertConfigured()
      res.status(200).json(await runPushAlerts())
    }
  }
}

module.exports = async (req, res) => {
  const action = actions[req.query.action]
  if (!action) return res.status(404).json({ error: 'Not found' })
  return route(action.methods, action.handler)(req, res)
}
