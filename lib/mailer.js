const nodemailer = require('nodemailer')
const { google } = require('googleapis')
const { signToken, passwordVersion } = require('./tokens')

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://bird-alert.vercel.app').replace(/\/$/, '')
const FROM = `bird-alert Admin <${process.env.APP_EMAIL || 'birdalert.info@gmail.com'}>`
const REDIRECT_URI = 'https://developers.google.com/oauthplayground'

const mailConfigured = Boolean(
  process.env.APP_CLIENT_ID && process.env.APP_CLIENT_SECRET && process.env.APP_REFRESH_TOKEN && process.env.APP_EMAIL
)

const appUrl = (path) => `${APP_BASE_URL}${path}`

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

let transporterPromise
const getTransporter = async () => {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      const oAuthClient = new google.auth.OAuth2(process.env.APP_CLIENT_ID, process.env.APP_CLIENT_SECRET, REDIRECT_URI)
      oAuthClient.setCredentials({ refresh_token: process.env.APP_REFRESH_TOKEN })
      const { token: accessToken } = await oAuthClient.getAccessToken()
      return nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          type: 'OAuth2',
          user: process.env.APP_EMAIL,
          clientId: process.env.APP_CLIENT_ID,
          clientSecret: process.env.APP_CLIENT_SECRET,
          refreshToken: process.env.APP_REFRESH_TOKEN,
          accessToken
        },
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 5000
      })
    })()
    transporterPromise.catch(() => { transporterPromise = undefined })
  }
  return transporterPromise
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
  const transporter = await getTransporter()
  return transporter.sendMail({ from: FROM, to, subject, text, html: `${html}${footer}` })
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

const sendAlertDigestEmail = async (user, alerts) => {
  const cards = alerts.map((alert) => {
    const name = escapeHtml(alert.comName)
    const mapUrl = `https://www.google.com/maps?q=${encodeURIComponent(`${alert.lat},${alert.lng}`)}`
    return `<div style="border: 1px solid black; margin: 3px; padding: 5px;">
      <h3 style="margin: 0;">${name}</h3>
      <p style="margin: 0;">Confirmed sighting at ${escapeHtml(alert.locName)}! <a href="${mapUrl}" target="_blank">(map)</a></p>
      <p style="margin: 0;">Check this bird out on <a href="https://ebird.org/species/${encodeURIComponent(alert.speciesCode)}">eBird</a>.</p>
    </div>`
  })
  return sendMail({
    to: user.email,
    subject: 'Your daily Bird Alert digest!',
    text: `Review your alerts in-app: ${appUrl('/')}`,
    html: `<h2>Birds on your watch list have been spotted nearby!</h2>${cards.join('')}<p><a href="${unsubscribeLink(user, 'alert_digest_email_enabled')}">Unsubscribe</a> from this digest.</p>`
  })
}

module.exports = { sendConfirmationEmail, sendPasswordResetEmail, sendAlertDigestEmail, unsubscribeLink, appUrl }
