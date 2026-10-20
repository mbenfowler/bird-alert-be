const nodemailer = require('nodemailer')
const { signToken, passwordVersion } = require('./tokens')

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://bird-alert.vercel.app').replace(/\/$/, '')
const FROM = `bird-alert Admin <${process.env.APP_EMAIL || 'birdalert.info@gmail.com'}>`

// Gmail with an app password (Google Account > Security > App passwords). No OAuth dance, no refresh token to expire.
const mailConfigured = Boolean(process.env.APP_EMAIL && process.env.APP_PW)

const appUrl = (path) => `${APP_BASE_URL}${path}`

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

let transporter
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.APP_EMAIL, pass: process.env.APP_PW },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    })
  }
  return transporter
}

const footer = '<h3>Having trouble?</h3><p>Feel free to reach out with questions by replying to this email.</p>'

// Real email goes out only in production (or with FORCE_SEND_MAIL=true) and only when Gmail is configured.
// Otherwise the message is printed so links can be copied from the dev server log.
const shouldSend = mailConfigured && (process.env.NODE_ENV === 'production' || process.env.FORCE_SEND_MAIL === 'true')

const sendMail = async ({ to, subject, text, html }) => {
  if (!shouldSend) {
    console.log(`[mailer] simulated send to ${to}: ${subject}\n${text}`)
    return { accepted: [to], simulated: true }
  }
  return getTransporter().sendMail({ from: FROM, to, subject, text, html: `${html}${footer}` })
}

const sendConfirmationEmail = async (user) => {
  const token = signToken('confirm', { sub: user.id, email: user.email }, '7d')
  const link = appUrl(`/confirm/${token}`)
  return sendMail({
    to: user.email,
    subject: 'bird-alert email confirmation link',
    text: `Confirm your email: ${link}`,
    html: `<h2>Please click the link to confirm your email and start receiving Bird Alerts!</h2><p><a href="${link}">${link}</a></p>`
  })
}

const sendPasswordResetEmail = async (user) => {
  const token = signToken('reset', { sub: user.id, pv: passwordVersion(user.password_hash) }, '1h')
  const link = appUrl(`/reset/${token}`)
  return sendMail({
    to: user.email,
    subject: 'bird-alert reset password link',
    text: `Reset your password (link expires in one hour): ${link}`,
    html: `<h2>Please click the link to reset your password</h2><p><a href="${link}">${link}</a></p><p>This link expires in one hour.</p>`
  })
}

const unsubscribeLink = (user, emailType) => {
  const token = signToken('unsubscribe', { sub: user.id, emailType }, '365d')
  return appUrl(`/unsubscribe/${token}`)
}

const MAX_CARDS = 50

const sightingCards = (sightings) => sightings.slice(0, MAX_CARDS).map((sighting) => {
  const name = escapeHtml(sighting.comName)
  const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${sighting.lat},${sighting.lng}`)}`
  return `<div style="border: 1px solid black; margin: 3px; padding: 5px;">
    <h3 style="margin: 0;">${name}</h3>
    <p style="margin: 0;">Seen at ${escapeHtml(sighting.locName)} on ${escapeHtml(sighting.obsDt)} <a href="${mapUrl}" target="_blank">(map)</a></p>
    <p style="margin: 0;">Check this bird out on <a href="https://ebird.org/species/${encodeURIComponent(sighting.speciesCode)}">eBird</a>.</p>
  </div>`
}).join('') + (sightings.length > MAX_CARDS ? `<p>...and ${sightings.length - MAX_CARDS} more. See them all in the app.</p>` : '')

const sendAlertDigestEmail = async (user, sightings) => sendMail({
  to: user.email,
  subject: 'Your daily Bird Alert digest!',
  text: `Birds on your watch list were spotted nearby. Review your alerts in-app: ${appUrl('/')}`,
  html: `<h2>Birds on your watch list have been spotted nearby!</h2>${sightingCards(sightings)}<p><a href="${unsubscribeLink(user, 'alert_digest_email_enabled')}">Unsubscribe</a> from this digest.</p>`
})

const sendRareSightingsEmail = async (user, sightings) => sendMail({
  to: user.email,
  subject: 'Uncommon birds spotted in your area!',
  text: `Notable sightings were reported near you. Review them in-app: ${appUrl('/')}`,
  html: `<h2>Uncommon birds have been reported in your area!</h2>${sightingCards(sightings)}<p><a href="${unsubscribeLink(user, 'rare_sightings_email_enabled')}">Unsubscribe</a> from these emails.</p>`
})

module.exports = { sendConfirmationEmail, sendPasswordResetEmail, sendAlertDigestEmail, sendRareSightingsEmail, unsubscribeLink, appUrl }
