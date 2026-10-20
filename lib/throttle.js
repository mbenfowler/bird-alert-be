const db = require('./db')
const { HttpError } = require('./http')

// Failed attempts allowed per key within the window before a 429.
const LIMITS = {
  login: { max: 10, minutes: 15 },
  forgot: { max: 5, minutes: 60 }
}

const windowStart = (scope) => new Date(Date.now() - LIMITS[scope].minutes * 60 * 1000)

const assertNotThrottled = async (scope, id) => {
  const key = `${scope}:${id}`
  const row = await db('auth_throttle').where({ key }).first()
  if (!row) return
  if (new Date(row.window_start) < windowStart(scope)) {
    await db('auth_throttle').where({ key }).del()
    return
  }
  if (row.attempts >= LIMITS[scope].max) throw new HttpError(429, 'Too many attempts. Please try again later.')
}

const recordAttempt = async (scope, id) => {
  const key = `${scope}:${id}`
  const cutoff = windowStart(scope)
  await db('auth_throttle')
    .insert({ key, attempts: 1, window_start: db.fn.now() })
    .onConflict('key')
    .merge({
      attempts: db.raw('case when auth_throttle.window_start < ? then 1 else auth_throttle.attempts + 1 end', [cutoff]),
      window_start: db.raw('case when auth_throttle.window_start < ? then now() else auth_throttle.window_start end', [cutoff])
    })
}

const clearAttempts = (scope, id) => db('auth_throttle').where({ key: `${scope}:${id}` }).del()

module.exports = { assertNotThrottled, recordAttempt, clearAttempts }
