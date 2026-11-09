const { route, body, HttpError } = require('../../lib/http')
const db = require('../../lib/db')
const { requireUser } = require('../../lib/auth')
const { assertCronCaller } = require('../../lib/digest')
const push = require('../../lib/push')
const { runPushAlerts } = require('../../lib/pushAlerts')
const { lastRun, recordRun } = require('../../lib/jobRuns')
const { testNotification } = require('../../lib/notifications')
const { t, langFor } = require('../../lib/i18n')
const { inLanguage } = require('../../lib/birdNames')
const handoff = require('../../lib/handoff')
const ebird = require('../../lib/ebird')
const { saveSubscription, subscriptionStatus, traceDeviceOf, appendTrace } = require('../../lib/pushSubscriptions')

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

  // POST /api/push/subscribe { endpoint, keys: { p256dh, auth }, userAgent?, deviceId?, oldEndpoint? } -> 201 (idempotent per endpoint)
  // deviceId is the app's id for this browser: the device's older subscriptions are replaced. oldEndpoint
  // comes from the service worker when the browser renewed the subscription (pushsubscriptionchange).
  subscribe: {
    methods: ['POST'],
    handler: async (req, res) => {
      assertConfigured()
      const user = await requireUser(req)
      const subscription = subscriptionFromBody(req)
      const { deviceId, oldEndpoint } = body(req)
      const replaced = await saveSubscription(user.id, subscription, { deviceId, oldEndpoint, origin: req.headers.origin || req.headers.referer })
      res.status(201).json({ ok: true, replaced })
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

  // GET /api/push/status?endpoint=&deviceId= -> { subscribed, knownDevice, devices, lastRun: { at, notified, heldForQuietHours } | null }
  // knownDevice: this device (or, for rows from before device ids, this kind of browser) had alerts on.
  status: {
    methods: ['GET'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const [status, run] = await Promise.all([
        subscriptionStatus(user.id, { endpoint: req.query.endpoint, deviceId: req.query.deviceId, userAgent: req.headers['user-agent'], origin: req.headers.origin || req.headers.referer }),
        lastRun('push')
      ])
      res.status(200).json({
        ...status,
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
          payload = testNotification(recent.map(await inLanguage(user.locale)), saved, new Map(birds.map((b) => [b.speciesCode, b])), langFor(user))
        } catch (error) {
          console.error('Test preview sighting failed, sending a plain test:', error.message)
        }
      }
      const { endpoint } = body(req)
      const result = await push.sendToUser(user.id, payload || {
        title: t(user.locale, 'push.testPlainTitle'),
        body: t(user.locale, 'push.testPlainBody'),
        tag: 'bird-alert-test',
        data: { url: '/' }
      }, { endpoint: typeof endpoint === 'string' ? endpoint : undefined })
      res.status(200).json(result)
    }
  },

  // GET /api/push/pending -> { push: { title, url, sentAt, tappedAt, offeredAt, openedAt } | null }
  // The latest push of the last ten minutes. The open app polls this: a tapped push is navigated to,
  // an unoffered one becomes an in-app toast.
  pending: {
    methods: ['GET'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      res.setHeader('Cache-Control', 'no-store')
      res.status(200).json({ push: await handoff.pending(user.id) })
    }
  },

  // POST /api/push/tap { url } -> the service worker saw a tap on the latest push
  tap: {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const { url } = body(req)
      if (typeof url !== 'string') throw new HttpError(400, 'A url is required')
      res.status(200).json({ marked: (await handoff.markTapped(user.id, url)) > 0 })
    }
  },

  // POST /api/push/ack { offered?, opened? } -> the app offered the push as a toast and/or navigated to it
  ack: {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const { offered, opened } = body(req)
      await handoff.ack(user.id, { offered: offered === true, opened: opened === true })
      res.status(204).end()
    }
  },

  // POST /api/push/trace { event, device?, ... } -> remembers the last 30 things this user's service worker
  // and app did with notifications on each device (the six latest devices), so a tap that goes nowhere on
  // a phone can be read back from the server, however busy the user's laptops are.
  trace: {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      const detail = body(req)
      if (!detail || typeof detail.event !== 'string') throw new HttpError(400, 'An event is required')
      const kind = `sw-trace:${user.id}`
      const previous = (await lastRun(kind))?.detail?.events || []
      let entry
      try { entry = JSON.parse(JSON.stringify(detail).slice(0, 4000)) } catch { entry = { event: detail.event.slice(0, 100), truncated: true } }
      entry = { ...entry, dev: traceDeviceOf(detail, req.headers['user-agent']), at: new Date().toISOString() }
      await recordRun(kind, { events: appendTrace(previous, entry) })
      res.status(204).end()
    }
  },

  // GET /api/push/alerts (hourly cron) -> pushes new watch-list sightings
  alerts: {
    methods: ['GET'],
    handler: async (req, res) => {
      assertCronCaller(req)
      assertConfigured()
      // 45 seconds a call; while `more` is true the caller repeats with ?after=<next>.
      const after = Number.parseInt(req.query.after ?? '0', 10) || 0
      res.status(200).json(await runPushAlerts({ after, deadline: Date.now() + 45_000 }))
    }
  }
}

module.exports = async (req, res) => {
  const action = actions[req.query.action]
  if (!action) return res.status(404).json({ error: 'Not found' })
  return route(action.methods, action.handler)(req, res)
}
