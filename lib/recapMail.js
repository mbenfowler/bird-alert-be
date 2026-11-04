const { t, colon, formatClock, formatLongDate, formatDistance, langFor, intlLocale } = require('./i18n')
const { isShown } = require('./abaCodes')

/**
 * "Your recap is ready": once to each member after the tally closes (lib/events runEventNotices),
 * in their language, as designed: a dark band with the event's numbers, their own lifers, the day's
 * highlights, how long fixes stay open, and a button to the recap at the top of the event page.
 */
const mailer = () => require('./mailer')
const h = (value) => mailer().escapeHtml(value)

/** "Wednesday, November 12" in the reader's words, on the event's own calendar. */
const dayIn = (at, zone, locale) => {
  try {
    return new Intl.DateTimeFormat(intlLocale(locale), { weekday: 'long', month: 'long', day: 'numeric', timeZone: zone }).format(at).replace(/[  ]/g, ' ')
  } catch {
    return formatLongDate(at.toISOString(), locale)
  }
}

/**
 * The message. `facts` are the recap's (lib/eventRecap gather) with birds already named in the
 * reader's language; `name` is the reader's name in the group, or null; `area` the event's area as
 * prose; `fixesUntil` a Date; `zone` the event's.
 */
const recapMessage = (user, { event, facts, name = null, area, fixesUntil, zone }) => {
  const m = mailer()
  const locale = user.locale
  const { unit } = langFor(user)
  const r = (key, vars) => t(locale, `mail.recap.${key}`, vars)
  const { clockIn } = require('./eventRecap')
  const bigDay = event.kind === 'bigday'
  const time = (at) => formatClock(clockIn(at, zone), locale)
  const birdLine = (b) => (b.place ? r('birdAt', { bird: b.comName, place: b.place, time: time(b.at) }) : r('birdWhen', { bird: b.comName, time: time(b.at) }))
  const title = r('title', { event: event.name, count: facts.totals.species, area })
  const href = m.appUrl(`/events/${event.id}`)

  const groupLifers = facts.lifers.length
  const meta = [
    formatLongDate(require('./places').dayOf(event.starts_on), locale),
    facts.totals.stops ? r('stops', { count: facts.totals.stops }) : null,
    Number.isFinite(facts.totals.miles) ? formatDistance(facts.totals.miles, unit, locale) : null,
    groupLifers ? r('lifers', { count: groupLifers }) : null
  ].filter(Boolean).join(' · ')
  const mine = facts.lifers.filter((l) => l._userId === user.id)
  const opening = [
    r(bigDay ? 'inBooksBigDay' : 'inBooksTrip'),
    mine.length
      ? r('yourLifers', { count: mine.length, first: birdLine(mine[0]), last: birdLine(mine[mine.length - 1]) })
      : r('onTally', { count: facts.totals.species })
  ].join(' ')
  const { rarest, scoutingCalled } = facts.highlights
  const highlights = [
    rarest && isShown(rarest.aba) ? r(rarest.place ? 'rarestAt' : 'rarest', { bird: rarest.comName, code: t(locale, 'mail.abaCode', { code: rarest.aba }), place: rarest.place }) : null,
    // The scouting card's star (an older shape has none).
    scoutingCalled?.star ? r('called', { bird: scoutingCalled.star.comName }) : null,
    facts.targets.total ? r('targets', { found: facts.targets.found, count: facts.targets.total }) : null
  ].filter(Boolean)
  const fixes = r('fixes', { date: dayIn(fixesUntil, zone, locale) })
  const hi = name ? r('hiName', { name }) : t(locale, 'mail.hi')
  const unsubscribe = m.unsubscribeLink(user, 'trip_emails_enabled')
  const SANS = 'font-family:Arial,Helvetica,sans-serif;'

  const html = `<!doctype html>
<html lang="${h(locale || 'en')}"><body style="margin:0;padding:0;background:#d3d3d3;font-family:Georgia,'Times New Roman',serif;color:#111;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#d3d3d3;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:576px;background:#fff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#111;padding:28px 28px 24px;">
    <div style="${SANS}font-size:12px;letter-spacing:0.14em;color:#ffd700;font-weight:bold;text-transform:uppercase;">${h(r(bigDay ? 'kickerBigDay' : 'kickerTrip'))}</div>
    <div style="margin-top:10px;font-size:30px;line-height:1.15;color:#fff;">${h(title)}</div>
    ${meta ? `<div style="margin-top:10px;font-size:16px;color:#d9d4c6;">${h(meta)}</div>` : ''}
  </td></tr>
  <tr><td style="padding:24px 28px 28px;font-size:16px;line-height:1.5;">
    <p style="margin:0 0 18px;">${h(hi)}</p>
    <p style="margin:0 0 18px;">${h(opening)}</p>
    ${highlights.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 18px;border:2px solid #111;border-radius:10px;"><tr><td style="padding:14px 16px;">
      <div style="${SANS}font-size:12px;letter-spacing:0.1em;font-weight:bold;color:#6b5800;text-transform:uppercase;margin-bottom:6px;">${h(r('highlights'))}</div>
      ${highlights.map((line) => `<div style="margin:0 0 6px;">${h(line)}</div>`).join('')}
    </td></tr></table>` : ''}
    <p style="margin:0 0 18px;">${h(fixes)}</p>
    <a href="${href}" style="display:inline-block;background:#ffd700;color:#111;border:2px solid #111;border-radius:999px;padding:12px 22px;${SANS}font-weight:bold;font-size:16px;text-decoration:none;">${h(r('button'))}</a>
    <p style="margin:18px 0 0;font-size:14px;color:#4f4f4f;">${t(locale, 'mail.ebirdCreditHtml')}</p>
  </td></tr>
</table>
<p style="margin:14px 0 0;text-align:center;${SANS}font-size:12px;color:#4f4f4f;">Bird Alert · <a href="${unsubscribe}" style="color:#1a56db;">${h(r('unsubscribe'))}</a></p>
</td></tr></table>
</body></html>`

  const text = [
    [r(bigDay ? 'kickerBigDay' : 'kickerTrip'), title, meta].filter(Boolean).join('\n'),
    hi,
    opening,
    highlights.length ? [colon(locale, r('highlights')), ...highlights.map((line) => `- ${line}`)].join('\n') : null,
    fixes,
    `${colon(locale, r('button'))} ${href}`,
    `${colon(locale, r('unsubscribe'))} ${unsubscribe}`,
    t(locale, 'mail.ebirdCreditText')
  ].filter(Boolean).join('\n\n')

  return {
    to: user.email,
    bulk: true,
    headers: m.listUnsubscribe(user, 'trip_emails_enabled'),
    subject: r('subject', { title }),
    text,
    html
  }
}

module.exports = { recapMessage, dayIn }
