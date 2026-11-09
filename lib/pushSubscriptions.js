const db = require('./db')
const { platformOf } = require('./users')

/**
 * Push subscriptions per device. A device (one browser on one phone or computer) keeps one live
 * subscription: when it subscribes again, its older rows go. Apple in particular never answers a
 * dead endpoint with 404/410, so without this an iPhone that lost its subscription and was turned
 * back on keeps every old endpoint forever.
 */

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/
const deviceIdOf = (value) => (typeof value === 'string' && DEVICE_ID.test(value) ? value : null)

// The device_id column comes with migration 20261126090000. Until it has run, everything here works
// as before (no device ids), so this code is safe to deploy first. A "yes" is remembered; a "no" is
// asked again after a few minutes, so the migration takes effect without a redeploy.
let hasDeviceColumn = null
let checkedAt = 0
const deviceColumn = async () => {
  if (hasDeviceColumn) return true
  if (Date.now() - checkedAt < 300_000 && hasDeviceColumn === false) return false
  checkedAt = Date.now()
  hasDeviceColumn = await db.schema.hasColumn('push_subscriptions', 'device_id').catch(() => false)
  return hasDeviceColumn
}
const resetColumnCheck = () => { hasDeviceColumn = null; checkedAt = 0 }

/** 'ios', 'android', 'desktop-chrome', 'desktop-safari', ...: what kind of browser a user agent is. */
const familyOf = (userAgent) => {
  const ua = String(userAgent || '')
  const platform = platformOf(ua)
  if (!platform || platform !== 'desktop') return platform
  const browser = /Edg\//.test(ua) ? 'edge' : /Firefox\//.test(ua) ? 'firefox' : /Chrome\//.test(ua) ? 'chrome' : /Safari\//.test(ua) ? 'safari' : 'other'
  return `desktop-${browser}`
}

/**
 * Saves a subscription for a user, refreshing last_seen_at, and drops what it replaces: the same
 * device's older endpoints (by device id), the endpoint it was renewed from (the service worker's
 * pushsubscriptionchange sends `oldEndpoint`), and rows from before device ids with exactly this
 * user agent. That last one can catch a second computer with an identical browser; that computer
 * files its own subscription again the next time the app opens (the app's claim on load), with its
 * own device id from then on.
 * Returns how many rows were replaced.
 */
const saveSubscription = async (userId, { endpoint, p256dh, auth, user_agent: userAgent }, { deviceId: rawDeviceId, oldEndpoint } = {}) => {
  const withDevice = await deviceColumn()
  let deviceId = withDevice ? deviceIdOf(rawDeviceId) : null
  const renewedFrom = typeof oldEndpoint === 'string' && oldEndpoint !== endpoint ? oldEndpoint : null
  // A renewal from the service worker carries no device id; it keeps the one of the row it replaces.
  if (withDevice && !deviceId && renewedFrom) {
    deviceId = (await db('push_subscriptions').where({ user_id: userId, endpoint: renewedFrom }).first('device_id'))?.device_id || null
  }
  const fields = { user_id: userId, p256dh, auth, user_agent: userAgent, last_seen_at: db.fn.now(), ...(deviceId ? { device_id: deviceId } : {}) }
  await db('push_subscriptions').insert({ endpoint, ...fields }).onConflict('endpoint').merge(fields)
  if (!deviceId && !renewedFrom) return 0
  return db('push_subscriptions')
    .where({ user_id: userId })
    .whereNot({ endpoint })
    .andWhere((q) => {
      if (renewedFrom) q.orWhere({ endpoint: renewedFrom })
      if (deviceId) {
        q.orWhere({ device_id: deviceId })
        if (userAgent) q.orWhere((legacy) => legacy.whereNull('device_id').andWhere({ user_agent: userAgent }))
      }
    })
    .del()
}

/**
 * What the app asks on load and in the Alert Center: is this browser's endpoint filed under the
 * account (`subscribed`), and did this device have alerts on before (`knownDevice`: a row with its
 * device id, or a row from before device ids from the same kind of browser), which is what lets the
 * app turn alerts back on by itself after the browser lost its subscription. A known endpoint is
 * marked seen (at most hourly) and given the device id, so rows of devices no longer in use show
 * by their age.
 */
const subscriptionStatus = async (userId, { endpoint, deviceId: rawDeviceId, userAgent } = {}) => {
  const withDevice = await deviceColumn()
  const deviceId = withDevice ? deviceIdOf(rawDeviceId) : null
  const rows = await db('push_subscriptions').where({ user_id: userId }).select(['endpoint', 'user_agent', ...(withDevice ? ['device_id'] : [])])
  const subscribed = typeof endpoint === 'string' && rows.some((row) => row.endpoint === endpoint)
  if (subscribed) {
    await db('push_subscriptions')
      .where({ user_id: userId, endpoint })
      .andWhere((q) => {
        q.where('last_seen_at', '<', db.raw("now() - interval '1 hour'"))
        if (deviceId) q.orWhereNull('device_id')
      })
      .update({ last_seen_at: db.fn.now(), ...(deviceId ? { device_id: deviceId } : {}) })
      .catch((error) => console.error('push last_seen_at:', error.message))
  }
  const family = familyOf(userAgent)
  const knownDevice = subscribed ||
    Boolean(deviceId && rows.some((row) => row.device_id === deviceId)) ||
    Boolean(family && rows.some((row) => !row.device_id && familyOf(row.user_agent) === family))
  return { subscribed, knownDevice, devices: rows.length }
}

// ---- notification trace ----
// The last events of each device, so a busy laptop can't push a phone's events out.
const TRACE_PER_DEVICE = 30
const TRACE_DEVICES = 6

/** A short stable label for the device an event came from: its id when it sent one, else its kind and user agent. */
const traceDeviceOf = (detail, headerUserAgent) => {
  const id = deviceIdOf(detail.device)
  if (id) return id.slice(0, 12)
  const ua = String(detail.ua || headerUserAgent || '')
  let hash = 0
  for (const char of ua) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${familyOf(ua) || 'unknown'}-${hash.toString(36)}`
}

/** Adds an event to a trace kept as { events }: the newest TRACE_PER_DEVICE of each of the TRACE_DEVICES devices heard from latest. */
const appendTrace = (events, entry) => {
  const all = [...events, entry]
  const devices = [...new Set(all.map((e) => e.dev || 'unknown').reverse())].slice(0, TRACE_DEVICES)
  const kept = new Set()
  for (const dev of devices) all.filter((e) => (e.dev || 'unknown') === dev).slice(-TRACE_PER_DEVICE).forEach((e) => kept.add(e))
  return all.filter((e) => kept.has(e))
}

module.exports = { saveSubscription, subscriptionStatus, familyOf, traceDeviceOf, appendTrace, deviceIdOf, resetColumnCheck, TRACE_PER_DEVICE }
