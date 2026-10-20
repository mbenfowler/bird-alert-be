const nodemailer = require('nodemailer')
const { signToken, passwordVersion } = require('./tokens')
const { formatObsDt, mapImageUrl, sightingUrl } = require('./notifications')

const FROM = `bird-alert Admin <${process.env.APP_EMAIL || 'birdalert.info@gmail.com'}>`

// Gmail with an app password (Google Account > Security > App passwords). No OAuth dance, no refresh token to expire.
const mailConfigured = Boolean(process.env.APP_EMAIL && process.env.APP_PW)

const { appUrl } = require('./appUrl')

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

const footerText = 'Having trouble? Reply to this email and a human will read it.'

/** Shared email shell: grey canvas, white card, logo header, footer with links. Table-based for mail clients. */
const layout = ({ heading, intro, body, footerLinks = [] }) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#d3d3d3;font-family:Georgia,'Times New Roman',serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#d3d3d3;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:2px solid #111;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#808080;padding:14px 20px;">
    <table role="presentation" cellspacing="0" cellpadding="0"><tr>
      <td style="vertical-align:middle;"><img src="${appUrl('/images/bird.png')}" width="36" height="36" alt="" style="display:block;border-radius:8px;"></td>
      <td style="vertical-align:middle;padding-left:10px;font-size:22px;font-weight:bold;color:#111;">Bird <span style="color:#ff6a00;">Alert!</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:22px 20px 6px;">
    <h1 style="margin:0 0 6px;font-size:22px;line-height:1.25;">${heading}</h1>
    ${intro ? `<p style="margin:0 0 8px;font-size:15px;color:#4f4f4f;">${intro}</p>` : ''}
  </td></tr>
  <tr><td style="padding:0 20px 8px;">${body}</td></tr>
  <tr><td style="padding:14px 20px 20px;border-top:1px solid #ddd;font-size:13px;color:#4f4f4f;">
    ${footerLinks.map((l) => `<a href="${l.href}" style="color:#1a56db;">${escapeHtml(l.label)}</a>`).join(' &middot; ')}
    ${footerLinks.length ? '<br><br>' : ''}${footerText}
  </td></tr>
</table>
</td></tr></table>
</body></html>`

const button = (href, label) =>
  `<a href="${href}" style="display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border:2px solid #111;border-radius:999px;background:#ffd700;color:#111;font-weight:bold;font-size:14px;text-decoration:none;">${escapeHtml(label)}</a>`

const MAX_CARDS = 25
const MAX_MAPS = 8

/** One card per sighting: photo, name, where and when, a map for the first few, and two buttons. */
const sightingCard = (sighting, bird, { withMap }) => {
  const name = escapeHtml(sighting.comName)
  const photo = bird && bird.birdImg
    ? `<img src="${bird.birdImg}" width="120" height="90" alt="" style="display:block;width:120px;height:90px;object-fit:cover;border-radius:10px;">`
    : `<div style="width:120px;height:90px;border-radius:10px;background:#e8e8e8;"></div>`
  const count = Number(sighting.howMany)
  const meta = [escapeHtml(sighting.locName), escapeHtml(formatObsDt(sighting.obsDt)), Number.isFinite(count) && count > 1 ? `${count} seen` : null].filter(Boolean).join(' &middot; ')
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${sighting.lat},${sighting.lng}`)}`
  const ebirdHref = sighting.subId ? `https://ebird.org/checklist/${encodeURIComponent(sighting.subId)}` : `https://ebird.org/species/${encodeURIComponent(sighting.speciesCode)}`
  const map = withMap && Number.isFinite(sighting.lat) && Number.isFinite(sighting.lng)
    ? `<a href="${mapsHref}" style="display:block;margin-top:10px;"><img src="${mapImageUrl(sighting.lat, sighting.lng)}" width="520" alt="Map of the sighting location" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:1px solid #ccc;"></a>`
    : ''
  const pageHref = sightingUrl(sighting)
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border:2px solid #111;border-radius:12px;">
  <tr>
    <td style="padding:12px;vertical-align:top;width:120px;"><a href="${pageHref}">${photo}</a></td>
    <td style="padding:12px 12px 12px 0;vertical-align:top;">
      <div style="font-size:18px;font-weight:bold;"><a href="${pageHref}" style="color:#111;text-decoration:none;">${name}</a></div>
      <div style="font-size:14px;color:#4f4f4f;margin-top:4px;">${meta}</div>
      ${button(mapsHref, 'Open map')}${button(ebirdHref, 'View on eBird')}
    </td>
  </tr>
  ${map ? `<tr><td colspan="2" style="padding:0 12px 12px;">${map}</td></tr>` : ''}
</table>`
}

const sightingCards = (sightings, birdsByCode = new Map()) =>
  sightings.slice(0, MAX_CARDS).map((s, i) => sightingCard(s, birdsByCode.get(s.speciesCode), { withMap: i < MAX_MAPS })).join('')
  + (sightings.length > MAX_CARDS ? `<p style="color:#4f4f4f;">...and ${sightings.length - MAX_CARDS} more. See them all in the app.</p>` : '')

const sightingsText = (sightings) => sightings.slice(0, MAX_CARDS).map((s) => `- ${s.comName}: ${s.locName}, ${formatObsDt(s.obsDt)}`).join('\n')

const sendConfirmationEmail = async (user) => {
  const token = signToken('confirm', { sub: user.id, email: user.email }, '7d')
  const link = appUrl(`/confirm/${token}`)
  return sendMail({
    to: user.email,
    subject: 'Confirm your email for Bird Alert',
    text: `Confirm your email: ${link}`,
    html: layout({
      heading: 'One tap to confirm your email',
      intro: 'Then alerts and digests can reach you.',
      body: button(link, 'Confirm email') + `<p style="font-size:13px;color:#4f4f4f;margin-top:12px;">Or paste this link: ${link}</p>`
    })
  })
}

const sendPasswordResetEmail = async (user) => {
  const token = signToken('reset', { sub: user.id, pv: passwordVersion(user.password_hash) }, '1h')
  const link = appUrl(`/reset/${token}`)
  return sendMail({
    to: user.email,
    subject: 'Reset your Bird Alert password',
    text: `Reset your password (link expires in one hour): ${link}`,
    html: layout({
      heading: 'Reset your password',
      intro: 'This link works once and expires in an hour.',
      body: button(link, 'Choose a new password') + `<p style="font-size:13px;color:#4f4f4f;margin-top:12px;">Or paste this link: ${link}</p>`
    })
  })
}

const unsubscribeLink = (user, emailType) => {
  const token = signToken('unsubscribe', { sub: user.id, emailType }, '365d')
  return appUrl(`/unsubscribe/${token}`)
}

const sendAlertDigestEmail = async (user, sightings, birdsByCode) => sendMail({
  to: user.email,
  subject: sightings.length === 1 ? `${sightings[0].comName} was spotted near you` : `${sightings.length} birds from your watch list were spotted near you`,
  text: `Birds on your watch list were reported nearby:\n\n${sightingsText(sightings)}\n\nOpen the app: ${appUrl('/')}`,
  html: layout({
    heading: sightings.length === 1 ? `${escapeHtml(sightings[0].comName)} was spotted near you` : `${sightings.length} birds from your watch list were spotted near you`,
    intro: 'Reported to eBird in your area since yesterday.',
    body: sightingCards(sightings, birdsByCode),
    footerLinks: [
      { href: appUrl('/settings'), label: 'Alert settings' },
      { href: unsubscribeLink(user, 'alert_digest_email_enabled'), label: 'Unsubscribe from this digest' }
    ]
  })
})

const sendRareSightingsEmail = async (user, sightings, birdsByCode) => sendMail({
  to: user.email,
  subject: sightings.length === 1 ? `Uncommon bird near you: ${sightings[0].comName}` : `${sightings.length} uncommon birds reported near you`,
  text: `Notable sightings reported near you:\n\n${sightingsText(sightings)}\n\nOpen the app: ${appUrl('/')}`,
  html: layout({
    heading: sightings.length === 1 ? `Uncommon bird near you: ${escapeHtml(sightings[0].comName)}` : `${sightings.length} uncommon birds reported near you`,
    intro: "eBird's notable sightings for your area since yesterday.",
    body: sightingCards(sightings, birdsByCode),
    footerLinks: [
      { href: appUrl('/settings'), label: 'Alert settings' },
      { href: unsubscribeLink(user, 'rare_sightings_email_enabled'), label: 'Unsubscribe from these emails' }
    ]
  })
})

module.exports = { sendConfirmationEmail, sendPasswordResetEmail, sendAlertDigestEmail, sendRareSightingsEmail, unsubscribeLink, appUrl, layout, sightingCards }
