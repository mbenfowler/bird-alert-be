const { route, body, HttpError } = require('../../lib/http')
const db = require('../../lib/db')
const { requireUser } = require('../../lib/auth')
const { assertCronCaller } = require('../../lib/digest')
const push = require('../../lib/push')
const { runPushAlerts } = require('../../lib/pushAlerts')
const { sightingNotification } = require('../../lib/notifications')
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

  // GET /api/push/status?endpoint= -> { subscribed, devices }
  status: {
    methods: ['GET'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const rows = await db('push_subscriptions').where({ user_id: user.id }).select('endpoint')
      const subscribed = typeof req.query.endpoint === 'string' && rows.some((row) => row.endpoint === req.query.endpoint)
      res.status(200).json({ subscribed, devices: rows.length })
    }
  },

  // POST /api/push/test -> sends a test notification to all of the user's devices
  test: {
    methods: ['POST'],
    handler: async (req, res) => {
      assertConfigured()
      const user = await requireUser(req)
      // Preview with a real recent sighting from the user's region when there is one, so the test
      // looks exactly like the real thing: photo, map and actions.
      let payload = null
      if (user.location) {
        try {
          const [latest] = await ebird.recentObservations(user.location, 7)
          if (latest) {
            const bird = await db('birds').where({ speciesCode: latest.speciesCode }).first()
            payload = sightingNotification({ ...latest, kind: 'watchlist' }, bird)
            payload.title = `Test: ${payload.title}`
            payload.tag = 'bird-alert-test'
          }
        } catch (error) {
          console.error('Test preview sighting failed, sending a plain test:', error.message)
        }
      }
      const result = await push.sendToUser(user.id, payload || {
        title: 'Bird Alert notifications are on',
        body: 'You will hear from us when a bird on your watch list is reported nearby.',
        tag: 'bird-alert-test',
        data: { url: '/' }
      })
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
