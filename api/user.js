const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser } = require('../lib/auth')
const { normalizeEmail, assertValidEmail, findUserByEmail, sanitizeUser } = require('../lib/users')
const { sendConfirmationEmail } = require('../lib/mailer')

const STRING_FIELDS = ['state', 'location', 'phone']
const BOOLEAN_FIELDS = ['alert_digest_email_enabled', 'rare_sightings_email_enabled']

// PATCH /api/user { email?, state?, location?, phone?, alert_digest_email_enabled?, rare_sightings_email_enabled? }
module.exports = route(['PATCH'], async (req, res) => {
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
  if (emailChanged) sendConfirmationEmail(updated).catch((error) => console.error('Confirmation email failed:', error))

  res.status(200).json(sanitizeUser(updated))
})
