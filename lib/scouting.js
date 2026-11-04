const db = require('./db')
const ebird = require('./ebird')
const { localDay, dayOf, daysBetween, scoutFrom } = require('./places')
const { regionCenter, rangeKm, wholeState, stateCodeOf } = require('./range')
const { withEvidence, evidenceLine } = require('./evidence')
const { inQuietHours } = require('./quietHours')
const { t, formatObsDt } = require('./i18n')
const { appUrl } = require('./appUrl')

/**
 * Scouting: for the days before an event that scouts (a Big Day does unless told not to), one report
 * a day, to each member, of which of the event's target birds were reported in its area lately, and which haven't
 * been. A push and an email, each morning with the watch-list run, for the person's own dates.
 */
const RECENT_DAYS = 3
const QUIET_DAYS = 14
// The look-back asked of eBird: long enough to say a target has gone quiet for two weeks.
const BACK = QUIET_DAYS
const PUSH_LINES = 3

/**
 * The area a place watches, and how to read it: its whole state (range -1), a circle around its spot
 * or county centre (15 or 30 mi; eBird allows up to 50 km), or just its county. The key lets places
 * that watch the same area share one eBird call per run. `fetchSpecies(code, back)` gives one
 * species' newest report at every location in the same area (the feed has only its newest overall).
 */
const feedFor = async (place) => {
  if (wholeState(place)) {
    const state = stateCodeOf(place.location)
    return { key: `state:${state}`, fetch: () => ebird.recentObservations(state, BACK, { detail: 'full' }), fetchSpecies: (code, back) => ebird.speciesObservations(state, code, back) }
  }
  const km = rangeKm(place)
  if (km > 0) {
    const center = Number.isFinite(place.home_lat) && Number.isFinite(place.home_lng)
      ? { lat: place.home_lat, lng: place.home_lng }
      : await regionCenter(place.location)
    if (center) {
      const lat = Number(center.lat.toFixed(2))
      const lng = Number(center.lng.toFixed(2))
      return { key: `geo:${lat},${lng},${km}`, fetch: () => ebird.geoRecent(lat, lng, km, BACK), fetchSpecies: (code, back) => ebird.geoSpecies(lat, lng, km, code, back) }
    }
  }
  return { key: `county:${place.location}`, fetch: () => ebird.recentObservations(place.location, BACK, { detail: 'full' }), fetchSpecies: (code, back) => ebird.speciesObservations(place.location, code, back) }
}

/**
 * Pure: the report from a feed (eBird's latest report of each species in the area, two weeks back).
 * `seen`: targets with a report in the last `recentDays` (three unless asked; newest first), with evidence where eBird
 * flagged the report for review. `unreported`: targets with none in the two weeks.
 */
const scoutReport = (targets, records, today, recentDays = RECENT_DAYS) => {
  const since = sinceDay(today, recentDays)
  const latest = latestReports(targets, records)
  const seen = [...latest.values()].filter((o) => String(o.obsDt).slice(0, 10) >= since)
    .sort((a, b) => String(b.obsDt).localeCompare(String(a.obsDt)))
  const unreported = targets.filter((code) => !latest.has(code))
  return { seen, unreported }
}

/** The first day of a window of `days` ending `today` (both counted). */
const sinceDay = (today, days) => new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)

/** Pure: each target's newest report in the feed (with evidence), by species code. */
const latestReports = (targets, records) => {
  const wanted = new Set(targets)
  const latest = new Map()
  for (const o of withEvidence((records || []).filter((r) => wanted.has(r.speciesCode)))) {
    const had = latest.get(o.speciesCode)
    if (!had || String(o.obsDt) > String(had.obsDt)) latest.set(o.speciesCode, o)
  }
  return latest
}

/**
 * Pure: every target with where it stands, read the way scoutReport reads it: 'around' (reported in
 * the last `recentDays`, scoutReport's seen), 'missing' (nothing in the feed's two weeks, its
 * unreported) or 'quiet' (in between). `latest` is its newest report, or null. Around first, then
 * quiet, each newest first, then missing in the order given.
 */
const targetStatuses = (targets, records, today, recentDays = RECENT_DAYS) => {
  const since = sinceDay(today, recentDays)
  const latest = latestReports(targets, records)
  const rank = { around: 0, quiet: 1, missing: 2 }
  return targets.map((code, i) => {
    const o = latest.get(code) || null
    return { code, latest: o, i, status: !o ? 'missing' : String(o.obsDt).slice(0, 10) >= since ? 'around' : 'quiet' }
  }).sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.latest?.obsDt || '').localeCompare(String(a.latest?.obsDt || '')) || a.i - b.i)
    .map(({ i, ...t }) => t)
}

/** Whether a report was flagged by eBird for review (an ordinary report has no evidence to show). */
const flagged = (o) => Boolean(o.obsReviewed) || o.obsValid === false

/**
 * A report (scoutReport) as the email's rows, in the reader's language. `seen` rows are
 * { code, bird, where, locId, lat, lng, obsDt, date, subId, flagged, evidence, aba, birdImg }: evidence is
 * a line only for a report eBird flagged; aba, the ABA code (null outside the US and Canada, or none);
 * birdImg, our photo of the bird (birds table) or null. `unreported` is a list of names.
 * Shared by the morning report and the one asked for from the event page (lib/scoutEmail).
 */
const reportLines = async (report, locale, { region } = {}) => {
  const codes = [...new Set([...report.unreported, ...report.seen.map((o) => o.speciesCode)])]
  const birds = new Map((await require('./enrich').findOrCreateBirds(codes).catch(() => [])).map((b) => [b.speciesCode, b]))
  const name = await require('./birdNames').inLanguage(locale)
  const rows = await require('./abaCodes').withAba(report.seen.map((o) => ({ ...o, sciName: o.sciName || birds.get(o.speciesCode)?.sciName })), { region }).catch(() => report.seen)
  const seen = rows.map((o) => ({
    code: o.speciesCode,
    bird: name(o).comName,
    where: o.locName,
    locId: o.locId || null,
    lat: o.lat,
    lng: o.lng,
    obsDt: o.obsDt,
    date: formatObsDt(o.obsDt, locale),
    subId: o.subId || null,
    flagged: flagged(o),
    evidence: flagged(o) ? evidenceLine(o.evidence, locale) : '',
    aba: o.aba ?? null,
    birdImg: birds.get(o.speciesCode)?.birdImg || null
  }))
  const unreported = report.unreported.map((code) => name({ speciesCode: code, comName: birds.get(code)?.comName || code }).comName)
  return { seen, unreported }
}

/** A name eBird gives to something that isn't one species: "duck sp.", "Mallard x American Black Duck", "Western/Eastern Wood-Pewee". */
const notOneSpecies = (comName) => / sp\.|\/| x |hybrid|Domestic/i.test(String(comName || ''))

/** How many species "what's being seen there this week" lists. */
const THIS_WEEK = 10

/**
 * Pure: up to `limit` species reported in the area since `since` (a day), rarest first (eBird
 * flagged the report for review, which it does for a bird unusual there, or an ABA code of 3 or
 * more), then the most reported (rows in the feed: places it was seen), then the newest. Each with
 * its newest report. Escaped captives, non-species and anything in `skip` are left out.
 */
const thisWeekPicks = (records, since, { skip = new Set(), limit = THIS_WEEK } = {}) => {
  const { isShown } = require('./abaCodes')
  const by = new Map()
  for (const o of records || []) {
    if (!o?.speciesCode || skip.has(o.speciesCode) || o.exoticCategory === 'X' || notOneSpecies(o.comName)) continue
    if (String(o.obsDt).slice(0, 10) < since) continue
    const had = by.get(o.speciesCode)
    const rare = flagged(o) || isShown(o.aba)
    if (!had) { by.set(o.speciesCode, { latest: o, reports: 1, rare, aba: isShown(o.aba) ? o.aba : 0 }); continue }
    had.reports += 1
    had.rare = had.rare || rare
    if (String(o.obsDt) > String(had.latest.obsDt)) had.latest = o
  }
  return [...by.values()]
    .sort((a, b) => (b.rare - a.rare) || (b.aba - a.aba) || (b.reports - a.reports) || String(b.latest.obsDt).localeCompare(String(a.latest.obsDt)))
    .slice(0, limit)
}

/** "What's being seen there this week" from the area's feed: the last 7 days, the targets left out, as email rows. */
const thisWeekRows = async (records, today, targets, locale, { region } = {}) => {
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
  const coded = await require('./abaCodes').withAba(records || [], { region }).catch(() => records || [])
  const name = await require('./birdNames').inLanguage(locale)
  return thisWeekPicks(coded, since, { skip: new Set(targets) }).map(({ latest: o, rare }) => ({
    code: o.speciesCode, bird: name(o).comName, where: o.locName, locId: o.locId || null, lat: o.lat, lng: o.lng,
    obsDt: o.obsDt, date: formatObsDt(o.obsDt, locale), subId: o.subId || null, notable: rare
  }))
}

/**
 * Sends the day's scouting reports, each member of each event once a day (claimed in the database before anything
 * goes, so a second run or a failure never repeats one). The push waits for no one: in someone's
 * quiet hours it's left out and the email carries the report. Stops at `deadline`.
 */
/** Up to how many likely lifers stand in for an event with no target birds. */
const STAND_IN = 10

/**
 * A member's likely lifers for an event's dates in its area (lib/places likelyLifers, scope
 * life): the eBird history behind it is fetched once per area and dates and kept, so each person's
 * list costs only their life list.
 */
const likelyFor = async (user, row) => {
  const { likelyLifers } = require('./places')
  const found = await likelyLifers(user, { id: row.place_id ?? null, location: row.location },
    { from: dayOf(row.starts_on), to: dayOf(row.ends_on || row.starts_on), scope: 'life', limit: STAND_IN })
  return found.suggestions.map((s) => s.speciesCode)
}

/**
 * Keeps the bird of the day the email led with (lib/scoutMail birdOfTheDay), one a day per event, so
 * the recap can say the scouting called it. The first member's email that day sets it; members
 * scouting their own likely lifers may each have had another. Never stops the run.
 */
const recordBirdOfDay = async (eventId, day, seen) => {
  const hero = require('./scoutMail').birdOfTheDay(seen)
  if (!hero?.code) return
  await db('event_scout_birds').insert({ event_id: eventId, day, species_code: hero.code }).onConflict(['event_id', 'day']).ignore()
    .catch((error) => console.error(`Bird of the day ${eventId}:`, error.message))
}

const runScouting = async ({ deadline = Infinity, now = new Date(), push = null, send = null, fetchFeed = null, drive = null } = {}) => {
  const mailer = require('./mailer')
  const pushTo = push || require('./push').sendToUser
  const deliver = send || mailer.sendMail
  const utc = (days) => new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
  // An event scouts for each member: their own report, sent to them once a day, from one shared feed.
  // With more than one member it's a group, and the report says so.
  const members = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('events.scout', true).where('events.starts_on', '>=', utc(0)).where('events.starts_on', '<=', utc(30))
    .select('events.id as event_id', 'events.place_id', 'events.starts_on', 'events.ends_on', 'events.scout_days', 'event_members.last_scout_sent_on', 'events.kind',
      'events.name', 'events.location', 'events.range_mi', 'events.home_lat', 'events.home_lng', 'events.state', 'events.timezone', 'event_members.user_id',
      db('event_members as m').whereRaw('m.event_id = events.id').count('*').as('member_count'))
  const rows = [
    ...members.map((r) => ({ ...r, group: Number(r.member_count) > 1, key: `event-${r.event_id}-${r.user_id}`, targetsOf: () => db('event_targets').where({ event_id: r.event_id }).orderBy('species_code').pluck('species_code'),
      claim: (today) => db('event_members').where({ event_id: r.event_id, user_id: r.user_id }).where((q) => q.whereNull('last_scout_sent_on').orWhereNot('last_scout_sent_on', today)).update({ last_scout_sent_on: today }) }))
  ]
  const feeds = new Map()
  const feedOf = async (place) => {
    const { key, fetch } = await feedFor(place)
    if (!feeds.has(key)) feeds.set(key, (fetchFeed ? fetchFeed(key) : fetch()).catch(() => null))
    return feeds.get(key)
  }
  const result = { reports: 0, pushed: 0, emailed: 0, calls: 0, more: false }
  for (const row of rows) {
    if (Date.now() > deadline) { result.more = true; break }
    const user = await db('users').where({ id: row.user_id }).first()
    if (!user) continue
    // The scouting window and days to go in the event's own zone (lib/timezones), the same for the whole group.
    const today = localDay(require('./timezones').eventZone(row, user.timezone), now)
    const starts = dayOf(row.starts_on)
    if (!(scoutFrom(row) <= today && today < starts)) continue
    if (row.last_scout_sent_on && dayOf(row.last_scout_sent_on) === today) continue
    // No target birds picked yet: rather than a silent week, scout the person's likely lifers for
    // the event's dates (last year's reports there, minus their life list), and say so.
    let targets = await row.targetsOf()
    const standIn = !targets.length
    if (standIn) {
      targets = await likelyFor(user, row).catch(() => [])
      if (!targets.length) continue
    }
    const claimed = await row.claim(today)
    if (!claimed) continue
    const before = feeds.size
    const records = await feedOf({ location: row.location, range_mi: row.range_mi, home_lat: row.home_lat, home_lng: row.home_lng })
    if (feeds.size > before) result.calls += 1
    if (!records) continue
    const report = scoutReport(targets, records, today)
    const locale = user.locale
    const { seen, unreported } = await reportLines(report, locale, { region: row.location })
    const daysToGo = daysBetween(today, starts)
    const final = daysToGo === 1
    result.reports += 1
    try {
      if (!inQuietHours(user, now)) {
        const title = final ? t(locale, 'push.scout.final', { place: row.name })
          : row.group ? t(locale, 'push.scout.groupTitle', { place: row.name, count: daysToGo })
            : t(locale, 'push.scout.title', { place: row.name, count: daysToGo })
        const lines = seen.length
          ? seen.slice(0, PUSH_LINES).map((s) => t(locale, 'push.scout.line', { bird: s.bird, where: s.where, date: s.date })).join('; ')
          : t(locale, 'push.scout.none')
        const body = standIn ? `${t(locale, 'push.scout.standIn')} ${lines}` : lines
        const sent = await pushTo(user.id, { title, body, tag: `scout-${row.key}`, data: { url: appUrl(`/events/${row.event_id}#scouting`) } })
        if (sent?.sent) result.pushed += 1
      }
      if (user.email_confirmed && user.trip_emails_enabled) {
        // None of theirs about: what else is. The group's saved route, if any, timed as the app shows it
        // (lib/eventRoutePlan routeDetails: stays from this feed, drives from the cached route).
        const thisWeek = seen.length ? null : await thisWeekRows(records, today, targets, locale, { region: row.location })
        const saved = await db('event_routes').where({ event_id: row.event_id }).first('start', 'stops')
        const route = saved?.stops?.length ? await require('./eventRoutePlan').routeDetails(saved, { records, targets, today }, { drive }) : null
        await deliver(mailer.scoutingMessage(user, {
          eventId: row.event_id, place: row.name, daysToGo, seen, unreported, group: Boolean(row.group), standIn,
          targetCount: targets.length, recentDays: RECENT_DAYS, thisWeek, route, now
        }))
        result.emailed += 1
        await recordBirdOfDay(row.event_id, today, seen)
      }
    } catch (error) {
      if (error.code === 'MAIL_CAP') { result.capped = true; break }
      if (error.code === 'MAIL_DOWN') { result.mailDown = true; await require('./errors').reportError('mail down', error); break }
      await require('./errors').reportError(`scouting report ${row.key}`, error)
    }
  }
  return result
}

module.exports = { runScouting, notOneSpecies, scoutReport, targetStatuses, latestReports, reportLines, thisWeekPicks, thisWeekRows, feedFor, likelyFor, flagged, STAND_IN, RECENT_DAYS, QUIET_DAYS }
