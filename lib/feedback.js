const db = require('./db')
const { HttpError } = require('./http')
const { sendMail, layout } = require('./mailer')

/**
 * Feedback: an idea, a problem, or anything else, from someone signed in. Kept in the database
 * first, then emailed to the owner with the sender as reply-to, so answering is just Reply.
 * Five a day each keeps a stuck button (or a bored person) from filling the inbox.
 */
const KINDS = { idea: 'Idea', bug: 'Something’s broken', other: 'Other' }
const MAX_LENGTH = 4000
const DAILY_LIMIT = 5

const ownerAddress = () => process.env.FEEDBACK_TO || process.env.APP_EMAIL || 'birdalert.info@gmail.com'
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const sendFeedback = async (user, { kind, message, page } = {}, { userAgent = '' } = {}) => {
  const k = KINDS[kind] ? kind : 'other'
  const text = String(message ?? '').replace(/\r\n/g, '\n').trim()
  if (text.length < 3) throw new HttpError(400, 'Say a little more, then send')
  if (text.length > MAX_LENGTH) throw new HttpError(400, `That’s a lot! Keep it under ${MAX_LENGTH} characters`)
  const today = await db('feedback').where({ user_id: user.id }).where('created_at', '>', db.raw("now() - interval '1 day'")).count('* as n').first()
  if (Number(today.n) >= DAILY_LIMIT) throw new HttpError(429, 'Thanks for all the ideas! Send more tomorrow.')
  const where = typeof page === 'string' && /^\/[\w\-/]*$/.test(page) ? page.slice(0, 200) : null
  const [row] = await db('feedback').insert({ user_id: user.id, kind: k, message: text, page: where, user_agent: String(userAgent).slice(0, 300) }).returning('id')

  const subject = `[Bird Alert feedback] ${KINDS[k]} from ${user.email}`
  const details = [`From: ${user.email}`, user.location ? `County: ${user.location}` : null, where ? `Page: ${where}` : null, userAgent ? `Device: ${userAgent}` : null].filter(Boolean)
  try {
    const sent = await sendMail({
      to: ownerAddress(),
      replyTo: user.email,
      subject,
      text: `${KINDS[k]}\n\n${text}\n\n${details.join('\n')}\n\nReply to this email to answer them directly.`,
      html: layout({
        heading: KINDS[k],
        intro: `From ${escapeHtml(user.email)}. Reply to answer them directly.`,
        body: `<p style="white-space:pre-wrap;font-size:16px;line-height:1.5">${escapeHtml(text)}</p><p style="color:#4f4f4f;font-size:13px">${details.map(escapeHtml).join('<br>')}</p>`
      })
    })
    if (!sent?.simulated) await db('feedback').where({ id: row.id ?? row }).update({ emailed: true })
  } catch (error) {
    // Kept either way; the owner can read it from the table.
    console.error('Feedback email failed:', error.message)
  }
  return { ok: true }
}

module.exports = { sendFeedback, KINDS, DAILY_LIMIT }
