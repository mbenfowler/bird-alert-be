const db = require('./db')
const places = require('./places')
const { intlLocale } = require('./i18n')

/**
 * "Email me the scouting report now", from an event's page: the scouting email (lib/mailer
 * scoutingMessage) to the person asking, and only them, from the data as it is now. Any day before
 * the event ends, not only in the scouting window, so it reads the last 7 days as the event page
 * does (lib/events scoutFeed: the area's feed kept an hour and shared). It's asked for, so it goes
 * with trip emails off, and it leaves the morning report alone (last_scout_sent_on is untouched).
 *
 * Never empty: no targets, likely lifers stand in; none of those either, or none reported, and it
 * lists what else is being seen there this week. The group's saved route is listed if there is one
 * (never worked out here: that's many eBird and routing calls), else a link to plan one.
 *
 * A confirmed address only; up to LIMIT a person per event an hour, kept in nearby_cache (no table for it).
 */
const LIMIT = 3
const WINDOW_MS = 60 * 60 * 1000

/** "m•••@example.com": enough to say which address, not enough to read it off a screen. */
const maskEmail = (email) => {
  const [name, domain] = String(email || '').split('@')
  return domain ? `${name.slice(0, 1)}•••@${domain}` : '•••'
}

/** "9:14 AM" in the person's own time zone and language (UTC when the zone is unknown). */
const clockTime = (now, timezone, locale) => {
  const format = (timeZone) => new Intl.DateTimeFormat(intlLocale(locale), { hour: 'numeric', minute: '2-digit', timeZone }).format(now)
  let text
  try { text = format(timezone || 'UTC') } catch { text = format('UTC') }
  return text.replace(/[  ]/g, ' ')
}

const rateKey = (eventId, userId) => `scout-email:${eventId}:${userId}`

/**
 * Takes one of the person's sends for this event if the last hour has room: { ok: true, at } or
 * { ok: false, retryAfterMin }. The row is locked while it's read and written, so two taps at once count twice.
 */
const takeSlot = async (eventId, userId, now = new Date()) => db.transaction(async (trx) => {
  const key = rateKey(eventId, userId)
  await trx('nearby_cache').insert({ key, detail: JSON.stringify([]) }).onConflict('key').ignore()
  const row = await trx('nearby_cache').where({ key }).forUpdate().first()
  const stamps = (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail || [])
    .filter((at) => now.getTime() - Date.parse(at) < WINDOW_MS)
  if (stamps.length >= LIMIT) {
    const oldest = Math.min(...stamps.map((at) => Date.parse(at)))
    return { ok: false, retryAfterMin: Math.max(1, Math.ceil((oldest + WINDOW_MS - now.getTime()) / 60_000)) }
  }
  const at = now.toISOString()
  await trx('nearby_cache').where({ key }).update({ detail: JSON.stringify([...stamps, at]), fetched_at: now })
  return { ok: true, at }
})

/** Gives back a send that never went (the mail cap, an error): it shouldn't count against them. */
const returnSlot = async (eventId, userId, at) => db.transaction(async (trx) => {
  const key = rateKey(eventId, userId)
  const row = await trx('nearby_cache').where({ key }).forUpdate().first()
  if (!row) return
  const stamps = (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail || [])
  const i = stamps.indexOf(at)
  if (i >= 0) stamps.splice(i, 1)
  await trx('nearby_cache').where({ key }).update({ detail: JSON.stringify(stamps) })
}).catch(() => {})

/**
 * Sends it. Returns { status, body } for the API: 200 { sent, to }, 409 confirm_email, 400 event_over,
 * 429 too_many with retry_after_min, 503 mail_cap. Not a member: the 404 every event call gives.
 * Anything else is thrown (the API reports it and answers 500), with the send given back.
 */
const emailScoutingNow = async (user, id, { now = new Date(), fetchFeed = null, send = null } = {}) => {
  const events = require('./events')
  const scouting = require('./scouting')
  const mailer = require('./mailer')
  const event = await events.memberOf(user, id)
  if (!user.email_confirmed) return { status: 409, body: { error: 'confirm_email' } }
  const today = places.localDay(user.timezone, now)
  if (places.dayOf(event.ends_on || event.starts_on) < today) return { status: 400, body: { error: 'event_over' } }
  const slot = await takeSlot(event.id, user.id, now)
  if (!slot.ok) return { status: 429, body: { error: 'too_many', retry_after_min: slot.retryAfterMin } }
  try {
    const locale = user.locale
    // The event page's report: targets, else likely lifers, from the area's feed of the last week.
    const { targets, records } = await events.scoutingFor(user, event.id, { now, fetchFeed })
    const picked = await db('event_targets').where({ event_id: event.id }).count('* as n').first()
    const standIn = !Number(picked?.n) && targets.length > 0
    const noTargets = !targets.length
    const feed = noTargets ? (await events.scoutFeed(event, { fetchFeed })).records : records
    const report = scouting.scoutReport(targets, feed || [], today, events.SCOUT_VIEW_DAYS)
    const { seen, unreported } = await scouting.reportLines(report, locale, { region: event.location })
    // Nothing of theirs to tell: what else is about, rarest first, then the most reported.
    const thisWeek = noTargets || !seen.length ? await scouting.thisWeekRows(feed, today, targets, locale, { region: event.location }) : null
    const route = await require('./eventRoutePlan').getPlan(user, event.id)
    const members = await db('event_members').where({ event_id: event.id }).count('* as n').first()
    const message = mailer.scoutingMessage(user, {
      eventId: event.id,
      place: event.name,
      daysToGo: places.daysBetween(today, places.dayOf(event.starts_on)),
      seen,
      unreported,
      group: Number(members?.n) > 1,
      standIn,
      noTargets,
      targetCount: targets.length,
      recentDays: events.SCOUT_VIEW_DAYS,
      thisWeek,
      route: route.stops?.length ? route : null,
      requested: { asOf: clockTime(now, user.timezone, locale) },
      now
    })
    await (send || mailer.sendMail)(message)
    return { status: 200, body: { sent: true, to: maskEmail(user.email) } }
  } catch (error) {
    await returnSlot(event.id, user.id, slot.at)
    if (error.code === 'MAIL_CAP') return { status: 503, body: { error: 'mail_cap' } }
    throw error
  }
}

module.exports = { emailScoutingNow, maskEmail, clockTime, takeSlot, rateKey, LIMIT }
