const db = require('./db')
const { sendConfirmationReminder } = require('./mailer')

/**
 * One reminder per account, for someone who signed up at least a day ago and still hasn't
 * confirmed their email (so no digest or alert can reach them). Only accounts under a week old:
 * that's as long as a confirmation link lasts, and older ones were asked long ago. The send is
 * logged in digest_log as kind 'confirm-reminder', which is what makes it once ever.
 */
const KIND = 'confirm-reminder'
const AFTER_HOURS = 24
const WITHIN_DAYS = 7

const runConfirmReminders = async ({ send = sendConfirmationReminder, now = new Date() } = {}) => {
  const ago = (ms) => new Date(now.getTime() - ms)
  const due = await db('users as u')
    .where('u.email_confirmed', false)
    .where('u.created_at', '<=', ago(AFTER_HOURS * 3600_000))
    .where('u.created_at', '>', ago(WITHIN_DAYS * 86400_000))
    .whereNotExists(db('digest_log as d').whereRaw('d.user_id = u.id').where('d.kind', KIND))
    .select('u.id', 'u.email')
  let sent = 0
  for (const user of due) {
    try {
      await send(user)
      await db('digest_log').insert({ user_id: user.id, kind: KIND, sent_on: now.toISOString().slice(0, 10), alerts: 0 }).onConflict(['user_id', 'kind', 'sent_on']).ignore()
      sent += 1
    } catch (error) {
      // Over the day's mail cap, or the mail server said no: the next hourly run tries again.
      await require('./errors').reportError(`confirm reminder to user ${user.id}`, error)
      if (error.code === 'MAIL_CAP') break
    }
  }
  return { due: due.length, sent }
}

module.exports = { runConfirmReminders, KIND }
