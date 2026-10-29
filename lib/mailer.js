const nodemailer = require('nodemailer')
const { countyWord } = require('./regions')
const { signToken, passwordVersion } = require('./tokens')
const { formatObsDt } = require('./notifications')

const FROM = `bird-alert Admin <${process.env.APP_EMAIL || 'birdalert.info@gmail.com'}>`

// Gmail with an app password by default (Google Account > Security > App passwords). SMTP_URL, when set,
// switches to any provider's SMTP (e.g. smtps://user:pass@smtp.provider.com:465) with no code change.
const mailConfigured = Boolean(process.env.SMTP_URL || (process.env.APP_EMAIL && process.env.APP_PW))

// Gmail suspends an account that sends to more than about 500 recipients a day. Bulk mail (digests)
// stops at 85% of the cap so confirmation and reset emails always have room. MAIL_DAILY_CAP overrides.
const dailyCap = () => Number(process.env.MAIL_DAILY_CAP) || (process.env.SMTP_URL ? Infinity : 450)
const BULK_SHARE = 0.85

class MailCapError extends Error {
  constructor (sent, cap) {
    super(`Daily mail cap reached (${sent} of ${cap})`)
    this.code = 'MAIL_CAP'
  }
}

/** Reserves one send for today; throws MailCapError when the day's share is used up. */
const reserveSend = async (bulk, { day = new Date().toISOString().slice(0, 10) } = {}) => {
  const cap = dailyCap()
  if (!Number.isFinite(cap)) return
  const db = require('./db')
  const limit = bulk ? Math.floor(cap * BULK_SHARE) : cap
  let rows
  try {
    ({ rows } = await db.raw('insert into mail_counts (day, sent) values (?, 1) on conflict (day) do update set sent = mail_counts.sent + 1 returning sent', [day]))
  } catch (error) {
    // Counting must never stop mail: without the table, send and say so.
    console.error('Mail count unavailable:', error.message)
    return
  }
  const sent = Number(rows[0].sent)
  if (sent > limit) {
    await db.raw('update mail_counts set sent = sent - 1, held = held + 1 where day = ?', [day])
    throw new MailCapError(sent - 1, limit)
  }
}

const { appUrl } = require('./appUrl')

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

let transporter
const getTransporter = () => {
  if (!transporter) {
    transporter = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : nodemailer.createTransport({
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

// Real sends happen in production (or with FORCE_SEND_MAIL=true locally); elsewhere a send is logged.
const shouldSend = () => mailConfigured && (process.env.NODE_ENV === 'production' || process.env.FORCE_SEND_MAIL === 'true')

/**
 * Sends one message. Every email in this module goes through here. `bulk` marks digests, which
 * give way to account mail when the day's cap nears.
 */
const sendMail = async ({ to, subject, text, html, bulk = false, replyTo }) => {
  if (!shouldSend()) {
    console.log(`[mailer] simulated send to ${to}: ${subject}`)
    return { accepted: [to], simulated: true }
  }
  await reserveSend(bulk)
  // Replies reach a person: the owner's own address when set (FEEDBACK_TO), not the sending account's inbox.
  const reply = replyTo || process.env.FEEDBACK_TO
  return getTransporter().sendMail({ from: FROM, to, subject, text, html, ...(reply ? { replyTo: reply } : {}) })
}

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
const MAX_PINS = 12

/** Sightings grouped by the checklist they were reported on, in the order they arrived. */
const byChecklist = (sightings) => {
  const groups = new Map()
  for (const s of sightings.slice(0, MAX_CARDS)) {
    const key = s.subId || `${s.lat},${s.lng}`
    if (!groups.has(key)) groups.set(key, { subId: s.subId, lat: s.lat, lng: s.lng, locName: s.locName, obsDt: s.obsDt, sightings: [] })
    groups.get(key).sightings.push(s)
  }
  return [...groups.values()].map((group, i) => ({ ...group, pin: i < MAX_PINS && Number.isFinite(group.lat) && Number.isFinite(group.lng) ? String(i + 1) : null }))
}

/** One map for the whole digest, a numbered pin per checklist. */
const checklistMapUrl = (groups) => {
  const pinned = groups.filter((g) => g.pin)
  if (!pinned.length) return null
  return appUrl(`/api/map?pins=${encodeURIComponent(pinned.map((g) => `${g.lat.toFixed(4)},${g.lng.toFixed(4)},${g.pin}`).join(';'))}`)
}

const pinBadge = (pin) => pin
  ? `<span style="display:inline-block;min-width:22px;height:22px;line-height:22px;border-radius:11px;background:#d62828;color:#fff;font-size:13px;font-weight:bold;text-align:center;margin-right:8px;">${pin}</span>`
  : ''

/** One bird within a checklist: photo, name, how many. */
const birdRow = (sighting, bird) => {
  const count = Number(sighting.howMany)
  const photo = bird && bird.birdImg
    ? `<img src="${bird.birdImg}" width="72" height="54" alt="" style="display:block;width:72px;height:54px;object-fit:cover;border-radius:8px;">`
    : `<div style="width:72px;height:54px;border-radius:8px;background:#e8e8e8;"></div>`
  return `<tr>
    <td style="padding:6px 10px 6px 12px;width:72px;vertical-align:middle;">${photo}</td>
    <td style="padding:6px 12px 6px 0;vertical-align:middle;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(sighting.comName)}${sighting.aba >= 3 && sighting.aba <= 5 ? ` <span style="display:inline-block;margin-left:6px;padding:1px 8px;border:2px solid #111;border-radius:999px;background:#ffd700;font-size:12px;font-weight:bold;vertical-align:2px;">ABA Code ${sighting.aba}</span>` : ''}</div>
      ${Number.isFinite(count) && count > 1 ? `<div style="font-size:13px;color:#4f4f4f;">${count} seen</div>` : ''}
    </td>
  </tr>`
}

/** One card per checklist: where and when, the birds on it, and buttons for the map and the checklist. */
const checklistCard = (group, birdsByCode) => {
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${group.lat},${group.lng}`)}`
  const ebirdHref = group.subId ? `https://ebird.org/checklist/${encodeURIComponent(group.subId)}` : null
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border:2px solid #111;border-radius:12px;">
  <tr><td colspan="2" style="padding:12px 12px 4px;">
    <div style="font-size:15px;">${pinBadge(group.pin)}<strong>${escapeHtml(group.locName)}</strong> <span style="color:#4f4f4f;">&middot; ${escapeHtml(formatObsDt(group.obsDt))}</span></div>
  </td></tr>
  ${group.sightings.map((s) => birdRow(s, birdsByCode.get(s.speciesCode))).join('')}
  <tr><td colspan="2" style="padding:4px 12px 12px;">${button(mapsHref, 'Open map')}${ebirdHref ? button(ebirdHref, 'View checklist on eBird') : ''}</td></tr>
</table>`
}

/**
 * The body of a sightings digest: one map with a numbered pin per checklist, then a card per
 * checklist listing the birds on it. A checklist's birds share one place and time, so the map and
 * the buttons appear once per checklist rather than once per bird.
 */
const sightingsBody = (sightings, birdsByCode = new Map()) => {
  const groups = byChecklist(sightings)
  const mapUrl = checklistMapUrl(groups)
  const map = mapUrl
    ? `<a href="${appUrl('/map')}" style="display:block;margin:0 0 14px;"><img src="${mapUrl}" width="520" alt="Map of where the birds were reported" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:1px solid #ccc;"></a>`
    : ''
  return map + groups.map((g) => checklistCard(g, birdsByCode)).join('')
    + (sightings.length > MAX_CARDS ? `<p style="color:#4f4f4f;">...and ${sightings.length - MAX_CARDS} more. See them all in the app.</p>` : '')
}

const sightingsText = (sightings) => byChecklist(sightings).map((g) =>
  `${g.pin ? `${g.pin}. ` : ''}${g.locName}, ${formatObsDt(g.obsDt)}${g.subId ? ` (https://ebird.org/checklist/${g.subId})` : ''}\n` +
  g.sightings.map((s) => `   - ${s.comName}${Number(s.howMany) > 1 ? ` (${s.howMany})` : ''}`).join('\n')
).join('\n\n')

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

/** The one reminder, a day after signing up, for someone who hasn't confirmed: a fresh link, and no more after it. */
const sendConfirmationReminder = async (user) => {
  const token = signToken('confirm', { sub: user.id, email: user.email }, '7d')
  const link = appUrl(`/confirm/${token}`)
  return sendMail({
    to: user.email,
    subject: 'Confirm your email to start getting bird alerts',
    text: `You signed up for Bird Alert! but haven't confirmed your email yet, so digests and alerts can't reach you. Confirm here: ${link}\n\nDidn't sign up? Ignore this; it's the only reminder.`,
    html: layout({
      heading: 'Your alerts are one tap away',
      intro: 'You signed up for Bird Alert! but haven’t confirmed your email yet, so digests and rare-bird alerts can’t reach you.',
      body: button(link, 'Confirm email') + `<p style="font-size:13px;color:#4f4f4f;margin-top:12px;">Or paste this link: ${link}</p><p style="font-size:13px;color:#4f4f4f;">Didn’t sign up? Ignore this; it’s the only reminder.</p>`
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

// Sent as the fallback (push alerts asked for, no device to push to), it says so and unsubscribes from the fallback.
const alertDigestMessage = (user, sightings, birdsByCode, fallback = !user.alert_digest_email_enabled) => ({
  bulk: true,
  to: user.email,
  subject: sightings.length === 1 ? `${sightings[0].comName} was spotted near you` : `${sightings.length} birds from your watch list were spotted near you`,
  text: `Birds on your watch list were reported nearby:\n\n${sightingsText(sightings)}\n\nOpen the app: ${appUrl('/')}`,
  html: layout({
    heading: sightings.length === 1 ? `${escapeHtml(sightings[0].comName)} was spotted near you` : `${sightings.length} birds from your watch list were spotted near you`,
    intro: fallback
      ? 'Reported to eBird in your area since yesterday. This comes by email because alerts aren’t set up on a phone or computer yet; turn them on in Settings and they’ll arrive the moment a bird is reported.'
      : 'Reported to eBird in your area since yesterday.',
    body: sightingsBody(sightings, birdsByCode),
    footerLinks: [
      { href: appUrl('/settings'), label: 'Alert settings' },
      { href: unsubscribeLink(user, fallback ? 'watchlist_email_fallback' : 'alert_digest_email_enabled'), label: 'Unsubscribe from this digest' }
    ]
  })
})

const sendAlertDigestEmail = (user, sightings, birdsByCode) => sendMail(alertDigestMessage(user, sightings, birdsByCode))

const sendRareSightingsEmail = async (user, sightings, birdsByCode) => sendMail({
  bulk: true,
  to: user.email,
  // A bird rare in the whole ABA Area leads with its code; the sightings arrive rarest first.
  subject: sightings[0].aba >= 3 && sightings[0].aba <= 5
    ? `ABA Code ${sightings[0].aba} near you: ${sightings[0].comName}${sightings.length > 1 ? ` + ${sightings.length - 1} more` : ''}`
    : sightings.length === 1 ? `Uncommon bird near you: ${sightings[0].comName}` : `${sightings.length} uncommon birds reported near you`,
  text: `Notable sightings reported near you:\n\n${sightingsText(sightings)}\n\nOpen the app: ${appUrl('/')}`,
  html: layout({
    heading: sightings.length === 1 ? `Uncommon bird near you: ${escapeHtml(sightings[0].comName)}` : `${sightings.length} uncommon birds reported near you`,
    intro: "eBird's notable sightings for your area since yesterday.",
    body: sightingsBody(sightings, birdsByCode) + (sightings.some((s) => s.aba >= 3 && s.aba <= 5) ? '<p style="font-size:12px;color:#4f4f4f;margin-top:12px;">In the ABA Area (the US and Canada), ABA Code 3 birds turn up a few times each year, Code 4 not every year, and Code 5 only a few times ever. Codes from the ABA Checklist, used with permission of the American Birding Association.</p>' : ''),
    footerLinks: [
      { href: appUrl('/settings'), label: 'Alert settings' },
      { href: unsubscribeLink(user, 'rare_sightings_email_enabled'), label: 'Unsubscribe from these emails' }
    ]
  })
})

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const longDate = (day) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '')
  return m ? `${MONTHS_LONG[Number(m[2]) - 1]} ${Number(m[3])}` : ''
}

/** Compact rows for the migration email: photo, name, one line of context, linked out. */
const speciesRows = (items, note, href) => items.map((item) => {
  const photo = item.birdImg
    ? `<img src="${item.birdImg}" width="64" height="48" alt="" style="display:block;width:64px;height:48px;object-fit:cover;border-radius:8px;">`
    : `<div style="width:64px;height:48px;border-radius:8px;background:#e8e8e8;"></div>`
  return `<tr>
    <td style="padding:6px 10px 6px 0;width:64px;vertical-align:middle;">${photo}</td>
    <td style="padding:6px 0;vertical-align:middle;">
      <a href="${href(item)}" style="font-size:16px;font-weight:bold;color:#111;text-decoration:none;">${escapeHtml(item.comName)}</a>
      <div style="font-size:13px;color:#4f4f4f;">${escapeHtml(note(item))}</div>
    </td>
  </tr>`
}).join('')

const section = (heading, rows, empty) => `<h2 style="margin:18px 0 4px;font-size:17px;">${heading}</h2>
  ${rows ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>` : `<p style="margin:4px 0 0;font-size:14px;color:#4f4f4f;">${empty}</p>`}`

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Sunday's migration summary for one region: who arrived this week after a month or more away,
 * which regulars have gone quiet, and what last year says to expect over the next two weeks.
 */
const migrationMessage = (user, report, regionName) => {
  const place = regionName || 'your area'
  const mapHref = (item) => appUrl(`/map?code=${encodeURIComponent(item.speciesCode)}`)
  const ebirdHref = (item) => `https://ebird.org/species/${encodeURIComponent(item.speciesCode)}`
  const birdcast = `https://dashboard.birdcast.info/region/${encodeURIComponent(user.location)}`
  const arrivedRows = speciesRows(report.arrived, (i) => `Back since ${longDate(i.firstSeen)}${i.daysThisWeek > 1 ? `, reported on ${plural(i.daysThisWeek, 'day')} this week` : ''}`, mapHref)
  const departedRows = speciesRows(report.departed, (i) => `Last reported ${longDate(i.lastSeen)}, after ${plural(i.daysBefore, 'day')} in the month before`, mapHref)
  const comingRows = speciesRows(report.coming, (i) => `This time last year: reported on ${i.daysLastYear} of ${i.windowDays} days${i.firstLastYear ? `, from ${longDate(i.firstLastYear)}` : ''}`, ebirdHref)
  const headline = [report.arrived.length && `${plural(report.arrived.length, 'arrival')}`, report.departed.length && `${report.departed.length} moved on`, report.coming.length && `${report.coming.length} to watch for`].filter(Boolean).join(', ')
  const text = [
    `Migration this week in ${place}`,
    '', 'Arrived this week:', ...report.arrived.map((i) => `- ${i.comName} (back since ${longDate(i.firstSeen)})`),
    '', 'Moved on:', ...report.departed.map((i) => `- ${i.comName} (last reported ${longDate(i.lastSeen)})`),
    '', 'Expected over the next two weeks:', ...report.coming.map((i) => `- ${i.comName} (${i.daysLastYear} of ${i.windowDays} days this time last year)`),
    '', `Tonight's migration radar: ${birdcast}`, `Open the app: ${appUrl('/')}`
  ].join('\n')
  return {
    to: user.email,
    subject: `Migration this week in ${place}: ${headline || 'a quiet week'}`,
    text,
    html: layout({
      heading: `Migration this week in ${escapeHtml(place)}`,
      intro: `Who turned up, who moved on, and who to expect next, from a year of eBird reports for your ${countyWord(user.state)}.`,
      body: section('Arrived this week', arrivedRows, 'No species returned this week after a month or more away.')
        + section('Moved on', departedRows, 'Every regular from the past month was reported again in the last two weeks.')
        + section('Expected over the next two weeks', comingRows, 'Everything that was here this time last year has already been reported.')
        + `<p style="margin:18px 0 6px;font-size:14px;">${button(birdcast, "Tonight's migration radar")}${button(appUrl('/'), 'Open Bird Alert')}</p>
           <p style="font-size:12px;color:#4f4f4f;margin:8px 0 0;">Radar counts are from BirdCast (Cornell Lab of Ornithology and Colorado State University).</p>`,
      footerLinks: [
        { href: appUrl('/settings'), label: 'Alert settings' },
        { href: unsubscribeLink(user, 'migration_email_enabled'), label: 'Unsubscribe from this email' }
      ]
    })
  }
}

const sendMigrationEmail = (user, report, regionName) => sendMail({ ...migrationMessage(user, report, regionName), bulk: true })

module.exports = { sendMail, MailCapError, dailyCap, reserveSend, sendMigrationEmail, migrationMessage, sendConfirmationEmail, sendConfirmationReminder, sendPasswordResetEmail, sendAlertDigestEmail, alertDigestMessage, sendRareSightingsEmail, unsubscribeLink, appUrl, layout, sightingsBody, byChecklist }
