const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser, clearSession } = require('../lib/auth')
const { normalizeEmail, assertValidEmail, findUserByEmail, sanitizeUser } = require('../lib/users')
const { sendConfirmationEmail } = require('../lib/mailer')
const { isValidTimezone } = require('../lib/quietHours')
const { syncNewRegionSoon } = require('../lib/checklists')

const STRING_FIELDS = ['state', 'location']
const BOOLEAN_FIELDS = ['alert_digest_email_enabled', 'rare_sightings_email_enabled', 'push_watchlist_enabled', 'push_notable_enabled', 'push_notable_batched', 'push_first_of_season', 'push_lifer_enabled', 'migration_email_enabled']

// DELETE /api/user { confirm: 'delete' } -> 204: the account and everything kept for it (watch list, life
// list, alerts, passkeys, routes) are gone for good, and the session ends. Shared links stay up,
// unattributed; they hold no personal data.
const deleteAccount = async (req, res) => {
  const user = await requireUser(req)
  if (body(req).confirm !== 'delete') throw new HttpError(400, 'Confirm by sending { confirm: "delete" }')
  await db.transaction(async (trx) => {
    // Throttle rows are keyed 'scope:email' (login, forgot), not by id, so they go by address.
    await trx('auth_throttle').whereRaw("substring(key from position(':' in key) + 1) = ?", [user.email]).del()
    await trx('users').where({ id: user.id }).del()
  })
  clearSession(res)
  res.status(204).end()
}

// PATCH /api/user { onboarded?: true (setup finished or skipped; it never shows again), email?, state?, location?, alert_digest_email_enabled?, rare_sightings_email_enabled?, push_watchlist_enabled?, push_notable_enabled?, push_notable_batched?, push_first_of_season?, push_lifer_enabled?, migration_email_enabled? }
module.exports = route(['PATCH', 'DELETE'], async (req, res) => {
  if (req.method === 'DELETE') return deleteAccount(req, res)
  const user = await requireUser(req)
  const input = body(req)
  const changes = { updated_at: new Date() }

  for (const field of STRING_FIELDS) {
    if (field in input) {
      if (typeof input[field] !== 'string') throw new HttpError(400, `${field} must be a string`)
      changes[field] = input[field].trim()
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (field in input) {
      if (typeof input[field] !== 'boolean') throw new HttpError(400, `${field} must be true or false`)
      changes[field] = input[field]
    }
  }

  // Quiet hours: an hour 0-23 or null to disable; the time zone is whatever the browser reports.
  for (const field of ['push_quiet_start', 'push_quiet_end']) {
    if (field in input) {
      const value = input[field]
      if (value !== null && !(Number.isInteger(value) && value >= 0 && value <= 23)) throw new HttpError(400, `${field} must be an hour from 0 to 23, or null`)
      changes[field] = value
    }
  }
  if ('timezone' in input) {
    if (!isValidTimezone(input.timezone)) throw new HttpError(400, 'timezone must be an IANA time zone name')
    changes.timezone = input.timezone
  }

  if ('onboarded' in input) {
    if (input.onboarded !== true) throw new HttpError(400, 'onboarded can only be set to true')
    changes.onboarded_at = user.onboarded_at || new Date()
  }

  let emailChanged = false
  if ('email' in input) {
    const email = assertValidEmail(normalizeEmail(input.email))
    if (email !== user.email) {
      const taken = await findUserByEmail(email)
      if (taken) throw new HttpError(409, 'An account with that email already exists')
      changes.email = email
      changes.email_confirmed = false
      emailChanged = true
    }
  }

  const [updated] = await db('users').where({ id: user.id }).update(changes).returning('*')
  if (updated.location && updated.location !== user.location) syncNewRegionSoon(updated.location)
  if (emailChanged) sendConfirmationEmail(updated).catch((error) => console.error('Confirmation email failed:', error))

  res.status(200).json(sanitizeUser(updated))
})
