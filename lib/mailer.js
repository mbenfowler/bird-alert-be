const nodemailer = require('nodemailer')
const { evidenceLine } = require('./evidence')
const { countyWord } = require('./regions')
const { signToken, passwordVersion } = require('./tokens')
const { t, formatObsDt, formatLongDate, formatDistance, langFor } = require('./i18n')

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

/**
 * Shared email shell: grey canvas, white card, logo header, footer with links. Table-based for mail
 * clients. The footer and eBird's credit (which its API terms ask for wherever its data is shown)
 * are in the reader's language.
 */
const layout = ({ heading, intro, body, footerLinks = [], ebird = false, locale = null }) => `<!doctype html>
<html lang="${escapeHtml(locale || 'en')}"><body style="margin:0;padding:0;background:#d3d3d3;font-family:Georgia,'Times New Roman',serif;color:#111;">
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
    ${footerLinks.length ? '<br><br>' : ''}${ebird ? `${t(locale, 'mail.ebirdCreditHtml')}<br><br>` : ''}${t(locale, 'mail.footer')}
  </td></tr>
</table>
</td></tr></table>
</body></html>`

const button = (href, label) =>
  `<a href="${href}" style="display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border:2px solid #111;border-radius:999px;background:#ffd700;color:#111;font-weight:bold;font-size:14px;text-decoration:none;">${escapeHtml(label)}</a>`

const MAX_CARDS = 25
const MAX_PINS = 12

/** "Owl Marsh (12 mi away in Hall)", in the reader's words and units, for a place past the county line. */
const awayPlace = (s, lang) => {
  if (!s.away) return s.locName
  // A whole-state range with no home to measure from: just the county.
  if (!Number.isFinite(s.away.miles)) return s.away.county ? t(lang.locale, 'distance.inParen', { place: s.locName, county: s.away.county }) : s.locName
  const distance = formatDistance(s.away.miles, lang.unit || 'mi', lang.locale)
  return s.away.county
    ? t(lang.locale, 'distance.awayInParen', { place: s.locName, distance, county: s.away.county })
    : t(lang.locale, 'distance.awayParen', { place: s.locName, distance })
}

/** Sightings grouped by the checklist they were reported on, in the order they arrived. */
const byChecklist = (sightings, lang = {}) => {
  const groups = new Map()
  for (const s of sightings.slice(0, MAX_CARDS)) {
    const key = s.subId || `${s.lat},${s.lng}`
    // Past the county line it says how far, and where, like the push does.
    if (!groups.has(key)) groups.set(key, { subId: s.subId, lat: s.lat, lng: s.lng, locName: awayPlace(s, lang), obsDt: s.obsDt, sightings: [] })
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
const birdRow = (sighting, bird, locale) => {
  const count = Number(sighting.howMany)
  const photo = bird && bird.birdImg
    ? `<img src="${bird.birdImg}" width="72" height="54" alt="" style="display:block;width:72px;height:54px;object-fit:cover;border-radius:8px;">`
    : `<div style="width:72px;height:54px;border-radius:8px;background:#e8e8e8;"></div>`
  return `<tr>
    <td style="padding:6px 10px 6px 12px;width:72px;vertical-align:middle;">${photo}</td>
    <td style="padding:6px 12px 6px 0;vertical-align:middle;">
      <div style="font-size:17px;font-weight:bold;">${escapeHtml(sighting.comName)}${sighting.aba >= 3 && sighting.aba <= 5 ? ` <span style="display:inline-block;margin-left:6px;padding:1px 8px;border:2px solid #111;border-radius:999px;background:#ffd700;font-size:12px;font-weight:bold;vertical-align:2px;">${escapeHtml(t(locale, 'mail.abaCode', { code: sighting.aba }))}</span>` : ''}</div>
      ${Number.isFinite(count) && count > 1 ? `<div style="font-size:13px;color:#4f4f4f;">${escapeHtml(t(locale, 'mail.seen', { count }))}</div>` : ''}
      ${sighting.evidence ? `<div style="font-size:13px;color:#4f4f4f;">${escapeHtml(evidenceLine(sighting.evidence, locale))}</div>` : ''}
    </td>
  </tr>`
}

/** One card per checklist: where and when, the birds on it, and buttons for the map and the checklist. */
const checklistCard = (group, birdsByCode, locale) => {
  const mapsHref = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${group.lat},${group.lng}`)}`
  const ebirdHref = group.subId ? `https://ebird.org/checklist/${encodeURIComponent(group.subId)}` : null
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 14px;border:2px solid #111;border-radius:12px;">
  <tr><td colspan="2" style="padding:12px 12px 4px;">
    <div style="font-size:15px;">${pinBadge(group.pin)}<strong>${escapeHtml(group.locName)}</strong> <span style="color:#4f4f4f;">&middot; ${escapeHtml(formatObsDt(group.obsDt, locale))}</span></div>
  </td></tr>
  ${group.sightings.map((s) => birdRow(s, birdsByCode.get(s.speciesCode), locale)).join('')}
  <tr><td colspan="2" style="padding:4px 12px 12px;">${button(mapsHref, t(locale, 'mail.openMap'))}${ebirdHref ? button(ebirdHref, t(locale, 'mail.viewChecklist')) : ''}</td></tr>
</table>`
}

/**
 * The body of a sightings digest: one map with a numbered pin per checklist, then a card per
 * checklist listing the birds on it. A checklist's birds share one place and time, so the map and
 * the buttons appear once per checklist rather than once per bird. `lang` is the reader's
 * { locale, unit }; the birds arrive already named in their language.
 */
const sightingsBody = (sightings, birdsByCode = new Map(), lang = {}) => {
  // Someone at one of their places gets home's birds first, then the place's under its name, each with its map.
  const { home, there } = splitPlace(sightings)
  if (there.length) {
    return (home.length ? sightingsBody(home, birdsByCode, lang) : '')
      + `<h2 style="margin:18px 0 10px;font-size:18px;">${escapeHtml(placeHeading(there[0].atPlace, lang))}</h2>`
      + sightingsBody(there.map(({ atPlace: _, ...s }) => s), birdsByCode, lang)
  }
  const groups = byChecklist(sightings, lang)
  const mapUrl = checklistMapUrl(groups)
  const map = mapUrl
    ? `<a href="${appUrl('/map')}" style="display:block;margin:0 0 14px;"><img src="${mapUrl}" width="520" alt="${escapeHtml(t(lang.locale, 'mail.mapAlt'))}" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:1px solid #ccc;"></a>`
    : ''
  return map + groups.map((g) => checklistCard(g, birdsByCode, lang.locale)).join('')
    + (sightings.length > MAX_CARDS ? `<p style="color:#4f4f4f;">${escapeHtml(t(lang.locale, 'mail.moreCards', { count: sightings.length - MAX_CARDS }))}</p>` : '')
}

/** Pure: a digest's sightings at home, and those at the person's active place (marked `atPlace` by runDigest). */
const splitPlace = (sightings) => ({ home: sightings.filter((s) => !s.atPlace), there: sightings.filter((s) => s.atPlace) })
const placeHeading = (at, lang) => t(lang.locale, 'mail.placeHeading', { place: at.name, county: at.county })

const sightingsText = (sightings, lang = {}) => {
  const { home, there } = splitPlace(sightings)
  if (there.length) {
    return [home.length ? sightingsText(home, lang) : null, `${placeHeading(there[0].atPlace, lang)}:\n\n${sightingsText(there.map(({ atPlace: _, ...s }) => s), lang)}`].filter(Boolean).join('\n\n')
  }
  return checklistText(sightings, lang)
}

const checklistText = (sightings, lang = {}) => byChecklist(sightings, lang).map((g) =>
  `${g.pin ? `${g.pin}. ` : ''}${g.locName}, ${formatObsDt(g.obsDt, lang.locale)}${g.subId ? ` (https://ebird.org/checklist/${g.subId})` : ''}\n` +
  g.sightings.map((s) => `   - ${s.comName}${Number(s.howMany) > 1 ? ` (${s.howMany})` : ''}${s.evidence ? ` [${evidenceLine(s.evidence, lang.locale)}]` : ''}`).join('\n')
).join('\n\n')

/**
 * Account emails (confirm, reminder, reset) are written like a note from a person: a few lines of
 * text and one plain link, no images, no layout, no footer. Gmail files designed, image-led mail
 * under Promotions or Spam, and these are the ones that must be seen; only 1 in 5 signups was
 * confirming. The alert emails keep the full design. The words are Matt's, in the reader's language.
 */
const personal = (paragraphs) => ({
  text: paragraphs.map((p) => p.replace(/<[^>]+>/g, '')).join('\n\n'),
  html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#111;">${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`
})
// The link is written out in full, as text people can see is ours, rather than hidden behind a button.
const plainLink = (href) => `<a href="${href}">${href}</a>`

/** A note from Matt: hello, the line, the link, the line for whoever didn't ask, and his name. */
const note = (locale, kind, link) => personal([
  t(locale, 'mail.hi'),
  t(locale, `mail.${kind}.body`),
  plainLink(link),
  t(locale, `mail.${kind}.ignore`),
  t(locale, 'mail.signature')
])

const sendConfirmationEmail = async (user) => {
  const token = signToken('confirm', { sub: user.id, email: user.email }, '7d')
  return sendMail({ to: user.email, subject: t(user.locale, 'mail.confirm.subject'), ...note(user.locale, 'confirm', appUrl(`/confirm/${token}`)) })
}

/** The one reminder, a day after signing up, for someone who hasn't confirmed: a fresh link, and no more after it. */
const sendConfirmationReminder = async (user) => {
  const token = signToken('confirm', { sub: user.id, email: user.email }, '7d')
  return sendMail({ to: user.email, subject: t(user.locale, 'mail.reminder.subject'), ...note(user.locale, 'reminder', appUrl(`/confirm/${token}`)) })
}

const sendPasswordResetEmail = async (user) => {
  const token = signToken('reset', { sub: user.id, pv: passwordVersion(user.password_hash) }, '1h')
  return sendMail({ to: user.email, subject: t(user.locale, 'mail.reset.subject'), ...note(user.locale, 'reset', appUrl(`/reset/${token}`)) })
}

const unsubscribeLink = (user, emailType) => {
  const token = signToken('unsubscribe', { sub: user.id, emailType }, '365d')
  return appUrl(`/unsubscribe/${token}`)
}

/**
 * The two trip notes (lib/places runTripNotices), in the same plain note style as the account
 * emails: when a trip starts, and the day before it ends, with a link to extend it. `kind` is
 * 'started' or 'ending'; `vars` has the place's name, the trip's last day, home's area and the trip id.
 */
const tripNoticeMessage = (user, kind, { tripId, place, ends, home }) => {
  const locale = user.locale
  const words = { place, ends: formatLongDate(ends, locale), home }
  const extend = kind === 'ending' ? [`${t(locale, 'mail.trip.extend')} ${plainLink(appUrl(`/settings#places?trip=${tripId}`))}`] : []
  return {
    to: user.email,
    bulk: true,
    subject: t(locale, `mail.trip.${kind}.subject`, words),
    ...personal([
      t(locale, 'mail.hi'),
      escapeHtml(t(locale, `mail.trip.${kind}.body`, words)),
      ...extend,
      t(locale, 'mail.signature'),
      `${t(locale, 'mail.trip.unsubscribe')} ${plainLink(unsubscribeLink(user, 'trip_emails_enabled'))}`
    ])
  }
}

const sendTripNotice = (user, kind, vars) => sendMail(tripNoticeMessage(user, kind, vars))

// Sent as the fallback (push alerts asked for, no device to push to), it says so and unsubscribes from the fallback.
const alertDigestMessage = (user, sightings, birdsByCode, fallback = !user.alert_digest_email_enabled) => {
  const lang = langFor(user)
  const { locale } = lang
  const subject = t(locale, 'mail.digest.subject', { count: sightings.length, bird: sightings[0]?.comName })
  return {
    bulk: true,
    to: user.email,
    subject,
    text: `${t(locale, 'mail.digest.text')}\n\n${sightingsText(sightings, lang)}\n\n${t(locale, 'mail.openApp', { url: appUrl('/') })}\n\n${t(locale, 'mail.ebirdCreditText')}`,
    html: layout({
      locale,
      heading: t(locale, 'mail.digest.subject', { count: sightings.length, bird: escapeHtml(sightings[0]?.comName) }),
      intro: t(locale, fallback ? 'mail.digest.introFallback' : 'mail.digest.intro'),
      body: sightingsBody(sightings, birdsByCode, lang),
      ebird: true,
      footerLinks: [
        { href: appUrl('/settings?tab=alerts'), label: t(locale, 'mail.alertSettings') },
        { href: unsubscribeLink(user, fallback ? 'watchlist_email_fallback' : 'alert_digest_email_enabled'), label: t(locale, 'mail.digest.unsubscribe') }
      ]
    })
  }
}

const sendAlertDigestEmail = (user, sightings, birdsByCode) => sendMail(alertDigestMessage(user, sightings, birdsByCode))

const rareSightingsMessage = (user, sightings, birdsByCode) => {
  const lang = langFor(user)
  const { locale } = lang
  const first = sightings[0]
  const aba = first.aba >= 3 && first.aba <= 5
  // A bird rare in the whole ABA Area leads with its code; the sightings arrive rarest first.
  const subject = aba
    ? t(locale, 'mail.rare.subjectAba', { code: first.aba, bird: first.comName, more: sightings.length > 1 ? t(locale, 'mail.rare.subjectAbaMore', { count: sightings.length - 1 }) : '' })
    : t(locale, 'mail.rare.subject', { count: sightings.length, bird: first.comName })
  return {
    bulk: true,
    to: user.email,
    subject,
    text: `${t(locale, 'mail.rare.text')}\n\n${sightingsText(sightings, lang)}\n\n${t(locale, 'mail.openApp', { url: appUrl('/') })}\n\n${t(locale, 'mail.ebirdCreditText')}`,
    html: layout({
      locale,
      heading: t(locale, 'mail.rare.subject', { count: sightings.length, bird: escapeHtml(first.comName) }),
      intro: t(locale, 'mail.rare.intro'),
      body: sightingsBody(sightings, birdsByCode, lang) + (sightings.some((s) => s.aba >= 3 && s.aba <= 5) ? `<p style="font-size:12px;color:#4f4f4f;margin-top:12px;">${escapeHtml(t(locale, 'mail.rare.abaNote'))}</p>` : ''),
      ebird: true,
      footerLinks: [
        { href: appUrl('/settings?tab=alerts'), label: t(locale, 'mail.alertSettings') },
        { href: unsubscribeLink(user, 'rare_sightings_email_enabled'), label: t(locale, 'mail.rare.unsubscribe') }
      ]
    })
  }
}

const sendRareSightingsEmail = async (user, sightings, birdsByCode) => sendMail(rareSightingsMessage(user, sightings, birdsByCode))

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

/**
 * Sunday's migration summary for one region: who arrived this week after a month or more away,
 * which regulars have gone quiet, and what last year says to expect over the next two weeks.
 */
const migrationMessage = (user, report, regionName) => {
  const { locale } = langFor(user)
  const m = (key, vars) => t(locale, `mail.migration.${key}`, vars)
  const date = (day) => formatLongDate(day, locale)
  const place = regionName || m('yourArea')
  const mapHref = (item) => appUrl(`/map?code=${encodeURIComponent(item.speciesCode)}`)
  const ebirdHref = (item) => `https://ebird.org/species/${encodeURIComponent(item.speciesCode)}`
  const birdcast = `https://dashboard.birdcast.info/region/${encodeURIComponent(user.location)}`
  const arrivedRows = speciesRows(report.arrived, (i) => i.daysThisWeek > 1 ? m('backSinceDays', { date: date(i.firstSeen), count: i.daysThisWeek }) : m('backSince', { date: date(i.firstSeen) }), mapHref)
  const departedRows = speciesRows(report.departed, (i) => m('lastReported', { date: date(i.lastSeen), count: i.daysBefore }), mapHref)
  const comingRows = speciesRows(report.coming, (i) => i.firstLastYear ? m('lastYearFrom', { days: i.daysLastYear, window: i.windowDays, date: date(i.firstLastYear) }) : m('lastYear', { days: i.daysLastYear, window: i.windowDays }), ebirdHref)
  const headline = [
    report.arrived.length && m('arrivals', { count: report.arrived.length }),
    report.departed.length && m('movedOnCount', { count: report.departed.length }),
    report.coming.length && m('toWatchFor', { count: report.coming.length })
  ].filter(Boolean).join(', ')
  const text = [
    m('heading', { place }),
    '', m('arrivedText'), ...report.arrived.map((i) => m('backSinceText', { bird: i.comName, date: date(i.firstSeen) })),
    '', m('movedOnText'), ...report.departed.map((i) => m('lastReportedText', { bird: i.comName, date: date(i.lastSeen) })),
    '', m('expectedText'), ...report.coming.map((i) => m('lastYearText', { bird: i.comName, days: i.daysLastYear, window: i.windowDays })),
    '', m('radarText', { url: birdcast }), t(locale, 'mail.openApp', { url: appUrl('/') }),
    '', t(locale, 'mail.ebirdCreditText')
  ].join('\n')
  return {
    to: user.email,
    subject: m('subject', { place, headline: headline || m('quietWeek') }),
    text,
    html: layout({
      locale,
      heading: m('heading', { place: escapeHtml(place) }),
      intro: m('intro', { countyWord: t(locale, `places.${countyWord(user.state)}`) }),
      body: section(m('arrived'), arrivedRows, m('arrivedEmpty'))
        + section(m('movedOn'), departedRows, m('movedOnEmpty'))
        + section(m('expected'), comingRows, m('expectedEmpty'))
        + `<p style="margin:18px 0 6px;font-size:14px;">${button(birdcast, m('radar'))}${button(appUrl('/'), m('openBirdAlert'))}</p>
           <p style="font-size:12px;color:#4f4f4f;margin:8px 0 0;">${escapeHtml(m('birdcastCredit'))}</p>`,
      ebird: true,
      footerLinks: [
        { href: appUrl('/settings?tab=alerts'), label: t(locale, 'mail.alertSettings') },
        { href: unsubscribeLink(user, 'migration_email_enabled'), label: m('unsubscribe') }
      ]
    })
  }
}

const sendMigrationEmail = (user, report, regionName) => sendMail({ ...migrationMessage(user, report, regionName), bulk: true })

module.exports = { sendTripNotice, tripNoticeMessage, sendMail, MailCapError, dailyCap, reserveSend, sendMigrationEmail, migrationMessage, sendConfirmationEmail, sendConfirmationReminder, sendPasswordResetEmail, sendAlertDigestEmail, alertDigestMessage, rareSightingsMessage, sendRareSightingsEmail, unsubscribeLink, appUrl, layout, sightingsBody, byChecklist }
