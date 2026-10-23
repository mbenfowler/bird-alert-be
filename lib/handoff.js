const db = require('./db')

// A push older than this is no longer offered or followed.
const PENDING_MINUTES = 10

/**
 * Hand-off of a push from the service worker to the open app, through the server. One row per user
 * holds the latest push sent, when the worker reported a tap on it, when the app offered it as a
 * toast, and when the app navigated to it.
 */
const recordSent = (userId, payload) => {
  const url = payload && payload.data && typeof payload.data.url === 'string' ? payload.data.url : null
  if (!url) return Promise.resolve()
  return db('push_handoff')
    .insert({ user_id: userId, title: String(payload.title || 'Bird Alert'), url, sent_at: db.fn.now(), tapped_at: null, offered_at: null, opened_at: null })
    .onConflict('user_id')
    .merge()
}

/** The worker saw a tap. The url must match the latest push, so a tap on an old notification does nothing. */
const markTapped = (userId, url) =>
  db('push_handoff').where({ user_id: userId, url }).whereNull('tapped_at').update({ tapped_at: db.fn.now() })

const shape = (row) => ({
  title: row.title,
  url: row.url,
  sentAt: row.sent_at,
  tappedAt: row.tapped_at,
  offeredAt: row.offered_at,
  openedAt: row.opened_at
})

/** The latest push if it is recent enough to matter, else null. */
const pending = async (userId) => {
  const row = await db('push_handoff')
    .where({ user_id: userId })
    .where('sent_at', '>', db.raw(`now() - interval '${PENDING_MINUTES} minutes'`))
    .first()
  return row ? shape(row) : null
}

/** The app offered the push as a toast and/or navigated to it. */
const ack = (userId, { offered = false, opened = false } = {}) => {
  const changes = {}
  if (offered) changes.offered_at = db.fn.now()
  if (opened) changes.opened_at = db.fn.now()
  if (!Object.keys(changes).length) return Promise.resolve(0)
  return db('push_handoff').where({ user_id: userId }).update(changes)
}

module.exports = { recordSent, markTapped, pending, ack, PENDING_MINUTES }
