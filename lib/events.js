const crypto = require('crypto')
const db = require('./db')
const { HttpError } = require('./http')
const { assertArea } = require('./areas')
const { appUrl } = require('./appUrl')
const places = require('./places')
const { zoneForArea, eventZone } = require('./timezones')
const { localHour } = require('./quietHours')
const { metresBetween } = require('./hotspots')

/**
 * Events: dated outings, solo or with a group (a weekend away, a Big Day with friends). Places are
 * the spots you keep; an event is when you'll be somewhere, with its own target birds and, on the
 * day, a tally. It starts solo; an invite link brings in a group, and anyone in it can change the
 * plan, its targets and the tally. A separate view-only link shows the plan and tally to anyone,
 * with no names. Each member's own life list decides which targets are lifers for them. During the
 * event its area alerts every member (lib/places activePlacesFor), and each member gets their own
 * scouting report beforehand (lib/scouting). Events are kept as history: each member can archive
 * theirs, and only the organizer deletes one, for everyone.
 */
const MAX_MEMBERS = 10
const MAX_TARGETS = 50
const MAX_TALLY = 600
// Upcoming and current events a person can have at once (past ones don't count).
const MAX_OPEN = 50

// Late entries: the tally takes birds until 3 AM the morning after the last day, in the event's zone.
const GRACE_HOURS = 3
// A tally entry's spot counts as at a stop of the group's route within this far of it.
const STOP_METRES = 2000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const dayBefore = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

/**
 * Pure: an event's day as its own zone sees it (lib/timezones eventZone: stored, else from its
 * area, else the person's own zone): { zone, today, active, past, tally_open }. active is the
 * calendar days, both ends included; tally_open runs on GRACE_HOURS past the last midnight.
 */
const eventClock = (event, fallbackZone = null, now = new Date()) => {
  const zone = eventZone(event, fallbackZone)
  const today = places.localDay(zone, now)
  const starts = places.dayOf(event.starts_on)
  const ends = places.dayOf(event.ends_on || event.starts_on)
  const active = starts <= today && today <= ends
  const grace = dayBefore(today) === ends && (localHour(zone, now) ?? 24) < GRACE_HOURS
  return { zone, today, active, past: ends < today, tally_open: active || grace }
}

const token = () => crypto.randomBytes(16).toString('base64url')
const inviteUrl = (e) => appUrl(`/events/join/${e.invite_token}`)
const viewUrl = (e) => appUrl(`/events/view/${e.view_token}`)

const cleanDisplayName = (value) => {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 40) throw new HttpError(400, 'Choose a name the group will see (up to 40 characters)')
  return name
}
const cleanEventName = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Give the event a name')
  return value.trim().slice(0, 80)
}

/** The event and the person's membership in it, or 404: not a member reads as no such event. */
const memberOf = async (user, id) => {
  const row = Number.isInteger(Number(id))
    ? await db('event_members').join('events', 'events.id', 'event_members.event_id')
      .where('events.id', Number(id)).where('event_members.user_id', user.id).first('events.*', 'event_members.role')
    : null
  if (!row) throw new HttpError(404, 'No such event')
  return row
}

/** The organizer: whoever holds the role, or the longest-standing member if no one does (an account deleted). */
const organizerOf = async (eventId) => {
  const members = await db('event_members').where({ event_id: eventId }).orderBy('joined_at').orderBy('user_id')
  return members.find((m) => m.role === 'organizer') || members[0] || null
}

const requireOrganizer = async (user, event) => {
  const organizer = await organizerOf(event.id)
  if (!organizer || organizer.user_id !== user.id) throw new HttpError(403, 'Only the organizer can do that')
}

/**
 * Events as a member sees them: the plan, the group (by the names they chose; someone who hasn't
 * chosen one yet shows as null), targets with whose lifer each is, the tally and its recap.
 */
const shape = async (user, events, now = new Date()) => {
  if (!events.length) return []
  const ids = events.map((e) => e.id)
  const [members, targets, tally, marks, routes] = await Promise.all([
    db('event_members').whereIn('event_id', ids).orderBy('joined_at').orderBy('user_id'),
    db('event_targets').whereIn('event_id', ids).orderBy('species_code'),
    // Removed birds stay (undo, the log) but are off the tally.
    db('event_tally').whereIn('event_id', ids).whereNull('removed_at').orderByRaw('coalesce(observed_at, added_at), id'),
    db('event_tally_marks').whereIn('event_id', ids).where({ user_id: user.id }).pluck('tally_id'),
    db('event_routes').whereIn('event_id', ids).select('event_id', 'stops')
  ])
  const marked = new Set(marks)
  const memberIds = [...new Set(members.map((m) => m.user_id))]
  const codes = [...new Set(targets.map((t) => t.species_code))]
  const seen = memberIds.length && codes.length
    ? await db('seen_birds').whereIn('user_id', memberIds).whereIn('species_code', codes).select('user_id', 'species_code')
    : []
  const has = new Set(seen.map((r) => `${r.user_id}|${r.species_code}`))
  return events.map((e) => {
    const clock = eventClock(e, user.timezone, now)
    const stops = routes.find((r) => r.event_id === e.id)?.stops || []
    const group = members.filter((m) => m.event_id === e.id)
    const organizer = group.find((m) => m.role === 'organizer') || group[0]
    const me = group.find((m) => m.user_id === user.id)
    const nameOf = (userId) => group.find((m) => m.user_id === userId)?.display_name || null
    const trip = { starts_on: e.starts_on, ends_on: e.ends_on, scout_days: e.scout_days }
    const eventTargets = targets.filter((t) => t.event_id === e.id).map((t) => t.species_code)
    const eventTally = tally.filter((t) => t.event_id === e.id)
    const got = new Set(eventTally.map((t) => t.species_code))
    return {
      id: e.id,
      name: e.name,
      state: e.state,
      location: e.location,
      range_mi: e.range_mi,
      home_lat: e.home_lat,
      home_lng: e.home_lng,
      place_id: e.place_id ?? null,
      starts_on: places.dayOf(e.starts_on),
      ends_on: places.dayOf(e.ends_on),
      kind: e.kind,
      scout: Boolean(e.scout),
      scout_days: Number(e.scout_days),
      scout_from: places.scoutFrom(trip),
      // The event's own day, the same for every member: its zone, whether it's on, over, and taking birds.
      timezone: clock.zone,
      active: clock.active,
      past: clock.past,
      tally_open: clock.tally_open,
      archived: Boolean(me?.archived_at),
      role: organizer && organizer.user_id === user.id ? 'organizer' : 'member',
      display_name: me?.display_name ?? null,
      members: group.map((m) => ({ display_name: m.display_name, role: organizer && m.user_id === organizer.user_id ? 'organizer' : 'member', you: m.user_id === user.id })),
      // Whose lifer each target is: the names of those who chose one, and lifer_for_you for the caller.
      targets: eventTargets.map((code) => ({
        code,
        lifer_for: group.filter((m) => m.display_name && !has.has(`${m.user_id}|${code}`)).map((m) => m.display_name),
        lifer_for_you: !has.has(`${user.id}|${code}`)
      })),
      tally: eventTally.map((t) => tallyEntry(t, { nameOf, user, stops, marked })),
      recap: { species: eventTally.length, targets_got: eventTargets.filter((c) => got.has(c)).length, targets_total: eventTargets.length },
      // The links show once the caller has chosen the name the group will see them by.
      invite_url: me?.display_name ? inviteUrl(e) : null,
      view_url: me?.display_name ? viewUrl(e) : null
    }
  })
}

/**
 * One bird on the tally as a member sees it: who found it first (their name in the group, never an
 * email), when it was seen (observed_at; added_at is when it reached the server), where (3 decimals)
 * and at which stop of the group's route, and whether the caller has it on their eBird checklist.
 */
const tallyEntry = (t, { nameOf, user, stops = [], marked = new Set() }) => ({
  id: t.id,
  code: t.species_code,
  client_id: t.client_id ?? null,
  added_by_name: nameOf(t.added_by),
  added_by_you: t.added_by === user.id,
  added_at: t.added_at,
  observed_at: t.observed_at ?? t.added_at,
  lat: t.lat ?? null,
  lng: t.lng ?? null,
  stop_index: t.stop_index ?? null,
  stop_name: Number.isInteger(t.stop_index) ? stops[t.stop_index]?.name ?? null : null,
  marked_by_me: marked.has(t.id)
})

/** All the person's events, kept as history (archived ones too, marked), soonest first. */
const listEvents = async (user, now = new Date()) => {
  const events = await db('events').join('event_members', 'event_members.event_id', 'events.id')
    .where('event_members.user_id', user.id)
    .orderBy('events.starts_on').orderBy('events.id').select('events.*')
  return shape(user, events, now)
}

const oneEvent = async (user, id, now = new Date()) => {
  const event = await db('events').where({ id: Number(id) }).first()
  return (await shape(user, [event], now))[0]
}

/**
 * A new event, solo, with the person as organizer. From one of their places (`place_id`) it takes the
 * place's area, range, spot and target birds; fields given override them. Without a place the area
 * comes as `state` and `location`. A Big Day is one day and scouts unless told not to.
 */
const createEvent = async (user, input, now = new Date()) => {
  const open = Number((await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).where('events.ends_on', '>=', places.utcPlus(now, -1)).count('* as n').first()).n)
  if (open >= MAX_OPEN) throw new HttpError(400, 'You can plan up to 50 events at a time')
  const place = input.place_id !== undefined && input.place_id !== null ? await places.ownPlace(user, input.place_id) : null
  const targets = place ? await db('place_targets').where({ place_id: place.id }).pluck('species_code') : []
  const state = String(input.state ?? place?.state ?? '')
  const location = String(input.location ?? place?.location ?? '')
  if (!state || !location) throw new HttpError(400, 'Choose where the event is')
  if (!place || 'state' in input || 'location' in input) await assertArea(state, location)
  const options = places.cleanTripOptions(input)
  const sameArea = place && place.state === state && place.location === location
  const spot = 'home_lat' in input || 'home_lng' in input
    ? places.cleanSpot(input.home_lat, input.home_lng)
    : (sameArea ? { home_lat: place.home_lat, home_lng: place.home_lng } : { home_lat: null, home_lng: null })
  // The event's days are judged in its own zone, from the start.
  const timezone = zoneForArea({ state, location, ...spot })
  const dates = places.cleanDates(input.starts_on, options.kind === 'bigday' ? input.starts_on : input.ends_on, timezone || user.timezone, now)
  const id = await db.transaction(async (trx) => {
    const [event] = await trx('events').insert({
      owner_id: user.id,
      place_id: place?.id ?? null,
      name: cleanEventName('name' in input ? input.name : (place?.name || 'My trip')),
      state,
      location,
      range_mi: 'range_mi' in input ? places.cleanRange(input.range_mi) : (place?.range_mi ?? 30),
      ...spot,
      timezone,
      ...dates,
      ...options,
      scout_days: options.scout_days ?? 21,
      invite_token: token(),
      view_token: token()
    }).returning('id')
    const eventId = event.id ?? event
    await trx('event_members').insert({ event_id: eventId, user_id: user.id, display_name: null, role: 'organizer' })
    if (targets.length) await trx('event_targets').insert(targets.map((code) => ({ event_id: eventId, species_code: code, added_by: user.id })))
    return eventId
  })
  return oneEvent(user, id, now)
}

/** Inviting: the member chooses the name the group will see, and gets the invite and view-only links. */
const startInvite = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  await db('event_members').where({ event_id: event.id, user_id: user.id }).update({ display_name: cleanDisplayName(input.display_name) })
  return oneEvent(user, event.id, now)
}

/** The person's own side of an event: archive it from their list (or bring it back), or change their name. */
const updateMembership = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  const changes = {}
  if ('archived' in input) {
    if (typeof input.archived !== 'boolean') throw new HttpError(400, 'archived is true or false')
    changes.archived_at = input.archived ? db.fn.now() : null
  }
  if ('display_name' in input) changes.display_name = cleanDisplayName(input.display_name)
  if (Object.keys(changes).length) await db('event_members').where({ event_id: event.id, user_id: user.id }).update(changes)
  return oneEvent(user, event.id, now)
}

/** Likely lifers for the event's area and dates (lib/places likelyLifers); `place` scope counts the place it was planned from. */
const suggestForEvent = async (user, id, { scope = 'life', limit } = {}, now = new Date()) => {
  const event = await memberOf(user, id)
  return places.likelyLifers(user, { id: event.place_id ?? null, location: event.location },
    { from: places.dayOf(event.starts_on), to: places.dayOf(event.ends_on), scope: scope === 'place' && event.place_id ? 'place' : 'life', limit }, now)
}

/** How long an area's scouting feed is kept for the event page: one eBird call per area an hour at most. */
const SCOUT_VIEW_SECONDS = 3600
const SCOUT_VIEW_DAYS = 7

/**
 * The event page's Scouting section: which of its target birds were reported in its area in the
 * last week (each bird's latest report, newest first) and which none in two weeks. With no targets,
 * the person's likely lifers for the dates stand in, as in the morning report. Any time before the
 * event ends, not only in the scouting window. The area's feed is shared by everyone asking for an
 * hour. No observer names.
 */
const eventScouting = async (user, id, opts = {}) => {
  const found = await module.exports.scoutingFor(user, id, opts)
  return { ...found.view, ...await scoutingToday(user, found, { now: opts.now, locale: opts.locale || user.locale }) }
}

/**
 * The event page's "today" card, from the same code as the morning push and the email (lib/scouting
 * reportLines, lib/scoutMail scoutSummary), over the page's 7-day window as "Email me the report now"
 * reads it: `fresh` (new in the last 24 hours, rarest then newest), `bird_of_day`, `headline` (the
 * email's subject), and `targets`, each with where it stands and whether it'd be a lifer (lib/lifeList
 * lifeListFor: none flagged under MIN_LIFE_LIST birds, as the lifer alerts). No eBird calls of its own:
 * the hour-kept feed, and the birds and ABA codes kept here.
 */
const scoutingToday = async (user, { event, today, records, targets, view }, { now = new Date(), locale } = {}) => {
  const none = { fresh: [], bird_of_day: null, headline: null, targets: [] }
  if (!event || !targets.length || !records) return none
  const scouting = require('./scouting')
  const { scoutSummary, rarerFirst } = require('./scoutMail')
  const region = event.location
  const report = scouting.scoutReport(targets, records, today, SCOUT_VIEW_DAYS)
  const { seen } = await scouting.reportLines(report, locale, { region })
  const english = new Map(report.seen.map((o) => [o.speciesCode, o]))
  const { fresh, hero, subject } = scoutSummary({
    locale, timezone: user.timezone, now, place: event.name, daysToGo: places.daysBetween(today, places.dayOf(event.starts_on)),
    seen, targetCount: targets.length, standIn: view.using === 'likely_lifers'
  })
  // English names here: the API names them in the reader's language (lib/birdNames localize).
  const bird = (s) => ({ code: s.code, speciesCode: s.code, comName: english.get(s.code)?.comName || s.bird, locName: s.where })
  const statuses = scouting.targetStatuses(targets, records, today, SCOUT_VIEW_DAYS)
  const birds = new Map((await require('./enrich').findOrCreateBirds(report.unreported).catch(() => [])).map((b) => [b.speciesCode, b]))
  const named = statuses.map((t) => ({ ...t, comName: t.latest?.comName || birds.get(t.code)?.comName || t.code, sciName: t.latest?.sciName || birds.get(t.code)?.sciName }))
  const coded = await require('./abaCodes').withAba(named, { region }).catch(() => named)
  const lifeList = await require('./lifeList').lifeListFor(user).catch(() => null)
  return {
    fresh: [...fresh].sort(rarerFirst).map((s) => ({ ...bird(s), locId: s.locId, obsDt: s.obsDt, aba: s.aba ?? null, flagged: s.flagged })),
    bird_of_day: hero ? { ...bird(hero), obsDt: hero.obsDt, aba: hero.aba ?? null, evidence: hero.evidence || null, photo: hero.birdImg || null } : null,
    headline: subject,
    targets: coded.map((t) => ({
      code: t.code,
      speciesCode: t.code,
      comName: t.comName,
      status: t.status,
      last_obs_dt: t.latest?.obsDt ?? null,
      last_loc_name: t.latest?.locName ?? null,
      aba: t.aba ?? null,
      lifer: Boolean(lifeList) && !lifeList.has(t.code)
    }))
  }
}

/**
 * The event's area feed (lib/scouting feedFor) as the event page reads it: eBird's latest report of
 * each species there, two weeks back, kept an hour and shared by everyone asking (one call per area an hour).
 */
const scoutFeed = async (event, { fetchFeed = null } = {}) => {
  const { shared } = require('./apiGuard')
  const feed = await require('./scouting').feedFor(event)
  const records = await shared(`scout-view:${feed.key}`, SCOUT_VIEW_SECONDS, () => (fetchFeed ? fetchFeed(feed.key) : feed.fetch()))
  return { feed, records }
}

/**
 * The work behind eventScouting, with what it was made from: the event, the area's feed (its key and
 * per-species reader), the cached records and the targets asked about (the route planner reads these).
 */
const scoutingFor = async (user, id, { now = new Date(), fetchFeed = null } = {}) => {
  const scouting = require('./scouting')
  const event = await memberOf(user, id)
  // Days to go and "over" in the event's own zone.
  const { today, past } = eventClock(event, user.timezone, now)
  const startsOn = places.dayOf(event.starts_on)
  const base = {
    checked_at: now.toISOString(),
    days_to_go: startsOn > today ? places.daysBetween(today, startsOn) : null,
    window: { from: places.scoutFrom(event), to: startsOn }
  }
  const none = { event, today, feed: null, records: [], targets: [] }
  let targets = await db('event_targets').where({ event_id: event.id }).orderBy('species_code').pluck('species_code')
  const using = targets.length ? 'targets' : 'likely_lifers'
  if (past) return { ...none, view: { ...base, using, reported: [], unreported: [] } }
  if (!targets.length) targets = await scouting.likelyFor(user, event).catch(() => [])
  if (!targets.length) return { ...none, view: { ...base, using, reported: [], unreported: [] } }
  const { feed, records } = await module.exports.scoutFeed(event, { fetchFeed })
  const { seen, unreported } = scouting.scoutReport(targets, records, today, SCOUT_VIEW_DAYS)
  const names = new Map((await require('./enrich').findOrCreateBirds(unreported).catch(() => [])).map((b) => [b.speciesCode, b.comName]))
  const view = {
    ...base,
    using,
    reported: seen.map((o) => ({
      code: o.speciesCode,
      speciesCode: o.speciesCode,
      comName: o.comName,
      locName: o.locName,
      locId: o.locId,
      lat: o.lat,
      lng: o.lng,
      obsDt: o.obsDt,
      birders: o.evidence?.birders ?? 1,
      confirmed: scouting.flagged(o) ? Boolean(o.evidence?.confirmed) : null,
      media: o.evidence?.media ?? null,
      subId: o.subId
    })),
    unreported: unreported.map((code) => ({ code, speciesCode: code, comName: names.get(code) || code }))
  }
  return { event, today, feed, records, targets, view }
}

/** Any member can change the plan: name, dates, area, range, kind and scouting. */
const updateEvent = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  const changes = {}
  if ('name' in input) changes.name = cleanEventName(input.name)
  const options = places.cleanTripOptions(input, event)
  const kind = options.kind ?? event.kind
  if ('location' in input || 'state' in input) {
    const state = String(input.state ?? event.state)
    const location = String(input.location ?? event.location)
    await assertArea(state, location)
    Object.assign(changes, { state, location, home_lat: null, home_lng: null })
  }
  if ('home_lat' in input || 'home_lng' in input) Object.assign(changes, places.cleanSpot(input.home_lat, input.home_lng))
  // A new area or spot can mean a new zone (a split state); the dates are checked in it.
  if ('state' in changes || 'home_lat' in changes) changes.timezone = zoneForArea({ ...event, ...changes })
  if ('starts_on' in input || 'ends_on' in input || (options.kind === 'bigday' && event.kind !== 'bigday')) {
    const starts = input.starts_on ?? places.dayOf(event.starts_on)
    const ends = kind === 'bigday' ? starts : (input.ends_on ?? places.dayOf(event.ends_on))
    Object.assign(changes, places.cleanDates(starts, ends, eventZone({ ...event, ...changes }, user.timezone), now))
  }
  if ('range_mi' in input) changes.range_mi = places.cleanRange(input.range_mi)
  Object.assign(changes, options)
  if (Object.keys(changes).length) await db('events').where({ id: event.id }).update(changes)
  return oneEvent(user, event.id, now)
}

/** The organizer deletes the event, for everyone. */
const endEvent = async (user, id) => {
  const event = await memberOf(user, id)
  await requireOrganizer(user, event)
  await db('events').where({ id: event.id }).del()
}

/** Leaving: the organizer's role passes to the longest-standing member; the last one out ends it. */
const leaveEvent = async (user, id) => {
  const event = await memberOf(user, id)
  await db.transaction(async (trx) => {
    await trx('event_members').where({ event_id: event.id, user_id: user.id }).del()
    const rest = await trx('event_members').where({ event_id: event.id }).orderBy('joined_at').orderBy('user_id')
    if (!rest.length) { await trx('events').where({ id: event.id }).del(); return }
    if (!rest.some((m) => m.role === 'organizer')) {
      await trx('event_members').where({ event_id: event.id, user_id: rest[0].user_id }).update({ role: 'organizer' })
    }
  })
}

/** A fresh invite link (the old one stops working); the organizer's call. */
const rotateInvite = async (user, id, now = new Date()) => {
  const event = await memberOf(user, id)
  await requireOrganizer(user, event)
  await db('events').where({ id: event.id }).update({ invite_token: token() })
  return oneEvent(user, event.id, now)
}

const cleanCode = (code) => {
  const value = String(code || '')
  if (!places.SPECIES.test(value)) throw new HttpError(400, 'Unknown species')
  return value
}

/** The target list as a whole; who added each bird is kept for those already on it. */
const setEventTargets = async (user, id, codes, now = new Date()) => {
  const event = await memberOf(user, id)
  if (!Array.isArray(codes)) throw new HttpError(400, 'Target birds must be a list')
  const wanted = [...new Set(codes.map(cleanCode))]
  if (wanted.length > MAX_TARGETS) throw new HttpError(400, 'An event can have up to 50 target birds')
  await db.transaction(async (trx) => {
    await trx('event_targets').where({ event_id: event.id }).whereNotIn('species_code', wanted.length ? wanted : ['']).del()
    if (wanted.length) {
      await trx('event_targets').insert(wanted.map((code) => ({ event_id: event.id, species_code: code, added_by: user.id })))
        .onConflict(['event_id', 'species_code']).ignore()
    }
  })
  return oneEvent(user, event.id, now)
}

/**
 * A tally add as the app sends it, checked: { species_code, client_id?, observed_at?, lat?, lng? }
 * (a bare code still works). client_id is the app's own UUID for the add, so a retry is the same
 * add; observed_at the time of the sighting, which may be long before signal came back (never in
 * the future: a fast phone's clock is taken as now); lat/lng the spot, kept to 3 decimals (about
 * 100 m) for privacy, both or neither.
 */
const cleanEntry = (input, now = new Date()) => {
  const given = typeof input === 'string' ? { species_code: input } : (input && typeof input === 'object' ? input : {})
  const species = cleanCode(given.species_code)
  let clientId = null
  if (given.client_id !== undefined && given.client_id !== null) {
    if (typeof given.client_id !== 'string' || !UUID.test(given.client_id)) throw new HttpError(400, 'client_id is a UUID')
    clientId = given.client_id.toLowerCase()
  }
  let observedAt = now
  if (given.observed_at !== undefined && given.observed_at !== null) {
    const at = typeof given.observed_at === 'string' || typeof given.observed_at === 'number' ? new Date(given.observed_at) : null
    if (!at || Number.isNaN(at.getTime())) throw new HttpError(400, 'observed_at is a date and time')
    observedAt = at.getTime() > now.getTime() ? now : at
  }
  let spot = null
  const hasLat = given.lat !== undefined && given.lat !== null
  const hasLng = given.lng !== undefined && given.lng !== null
  if (hasLat || hasLng) {
    const { lat, lng } = given
    if (!(typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180)) {
      throw new HttpError(400, 'That spot is not a place on the map')
    }
    spot = { lat, lng }
  }
  return { species, clientId, observedAt, spot }
}

const round3 = (n) => Math.round(n * 1000) / 1000

/** The index (0-based, as event-route-plan lists them) of the route's stop nearest `spot`, within STOP_METRES; else null. */
const nearestStop = (stops, spot) => {
  if (!spot || !Array.isArray(stops)) return null
  let best = null
  stops.forEach((stop, i) => {
    if (!stop || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) return
    const metres = metresBetween(spot, stop)
    if (metres <= STOP_METRES && (!best || metres < best.metres)) best = { i, metres }
  })
  return best ? best.i : null
}

/** The event as the caller sees it, with one tally row as it shows there (or { id, code, removed: true } if it's off the tally). */
const withEntry = async (user, eventId, row, now) => {
  const event = await oneEvent(user, eventId, now)
  return { ...event, entry: event.tally.find((t) => t.id === row.id) || { id: row.id, code: row.species_code, removed: true } }
}

/**
 * A bird on the day's tally, once however many members tap it: the event with `entry`, the row as
 * the tally shows it. A repeat of a client_id already seen changes nothing and gives the row back.
 * A bird already there keeps one row, credited to whoever saw it first (the earliest observed_at,
 * with its spot, stop and client_id; on a tie, the row already there), so two members adding it at once, or
 * one syncing a sighting from hours ago, both end with the first finder. A removed bird comes back
 * with its original finder and time. Taken at any time: an add queued offline may sync the next day.
 */
const addTally = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  const { species, clientId, observedAt, spot } = cleanEntry(input, now)
  const byClient = () => (clientId ? db('event_tally').where({ event_id: event.id, client_id: clientId }).first() : null)
  const repeat = await byClient()
  if (repeat) return withEntry(user, event.id, repeat, now)
  const count = Number((await db('event_tally').where({ event_id: event.id }).whereNull('removed_at').count('* as n').first()).n)
  if (count >= MAX_TALLY && !(await db('event_tally').where({ event_id: event.id, species_code: species }).whereNull('removed_at').first())) {
    throw new HttpError(400, 'The tally is full')
  }
  const route = spot ? await db('event_routes').where({ event_id: event.id }).first('stops') : null
  const stopIndex = nearestStop(route?.stops, spot)
  const earlier = 'excluded.observed_at < coalesce(event_tally.observed_at, event_tally.added_at)'
  const pick = (column) => `${column} = case when ${earlier} then excluded.${column} else event_tally.${column} end`
  let row
  try {
    ;({ rows: [row] } = await db.raw(`
      insert into event_tally (event_id, species_code, added_by, client_id, observed_at, lat, lng, stop_index)
      values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (event_id, species_code) do update set
        ${['added_by', 'client_id', 'lat', 'lng', 'stop_index'].map(pick).join(', ')},
        observed_at = least(coalesce(event_tally.observed_at, event_tally.added_at), excluded.observed_at),
        removed_at = null, removed_by = null
      returning *`, [event.id, species, user.id, clientId, observedAt, spot ? round3(spot.lat) : null, spot ? round3(spot.lng) : null, stopIndex]))
  } catch (error) {
    // The same client_id raced in, or came with another bird: it's the add already made.
    if (error.code === '23505' && clientId) row = await byClient()
    if (!row) throw error
  }
  return withEntry(user, event.id, row, now)
}

/** Off the tally for everyone, but kept: undo (or adding it again) brings back who found it and when. */
const removeTally = async (user, id, code, now = new Date()) => {
  const event = await memberOf(user, id)
  await db('event_tally').where({ event_id: event.id, species_code: cleanCode(code) }).whereNull('removed_at')
    .update({ removed_at: db.fn.now(), removed_by: user.id })
  return oneEvent(user, event.id, now)
}

/** Undoes a removal, any time after: the bird is back as it was (finder, time, spot, marks). The event with `entry`. */
const undoRemoveTally = async (user, id, code, now = new Date()) => {
  const event = await memberOf(user, id)
  const species = cleanCode(code)
  const row = await db('event_tally').where({ event_id: event.id, species_code: species }).first()
  if (!row) throw new HttpError(404, 'That bird isn’t on the tally')
  if (row.removed_at) await db('event_tally').where({ id: row.id }).update({ removed_at: null, removed_by: null })
  return withEntry(user, event.id, row, now)
}

/** A bird on the tally (not removed) in this event, by its id; 404 otherwise. */
const tallyRowOf = async (event, tallyId) => {
  const row = Number.isInteger(Number(tallyId)) && String(tallyId) !== ''
    ? await db('event_tally').where({ id: Number(tallyId), event_id: event.id }).whereNull('removed_at').first()
    : null
  if (!row) throw new HttpError(404, 'That bird isn’t on the tally')
  return row
}

/** "Added to my eBird checklist": the caller's own tick on one tally bird (each member keeps their own). */
const markTally = async (user, id, tallyId, now = new Date()) => {
  const event = await memberOf(user, id)
  const row = await tallyRowOf(event, tallyId)
  await db('event_tally_marks').insert({ event_id: event.id, user_id: user.id, tally_id: row.id }).onConflict(['user_id', 'tally_id']).ignore()
  return oneEvent(user, event.id, now)
}

const unmarkTally = async (user, id, tallyId, now = new Date()) => {
  const event = await memberOf(user, id)
  const row = await tallyRowOf(event, tallyId)
  await db('event_tally_marks').where({ user_id: user.id, tally_id: row.id }).del()
  return oneEvent(user, event.id, now)
}

/**
 * The group's log: every bird put on the tally, removed ones too (marked), in the order they were
 * seen. stop_name is the stop at stop_index on the group's route as it's saved now.
 */
const eventLog = async (user, id) => {
  const event = await memberOf(user, id)
  const [rows, members, route] = await Promise.all([
    db('event_tally').where({ event_id: event.id }).orderByRaw('coalesce(observed_at, added_at), id'),
    db('event_members').where({ event_id: event.id }).select('user_id', 'display_name'),
    db('event_routes').where({ event_id: event.id }).first('stops')
  ])
  const codes = [...new Set(rows.map((t) => t.species_code))]
  const birds = codes.length ? await require('./enrich').findOrCreateBirds(codes).catch(() => []) : []
  const names = new Map(birds.map((b) => [b.speciesCode, b.comName]))
  const stops = route?.stops || []
  return rows.map((t) => ({
    id: t.id,
    speciesCode: t.species_code,
    comName: names.get(t.species_code) || t.species_code,
    by_name: members.find((m) => m.user_id === t.added_by)?.display_name || null,
    observed_at: t.observed_at ?? t.added_at,
    stop_index: t.stop_index ?? null,
    stop_name: Number.isInteger(t.stop_index) ? stops[t.stop_index]?.name ?? null : null,
    removed: Boolean(t.removed_at)
  }))
}

const byInvite = async (inviteToken) => {
  const event = typeof inviteToken === 'string' && inviteToken.length >= 16 ? await db('events').where({ invite_token: inviteToken }).first() : null
  if (!event) throw new HttpError(404, 'This link is invalid or has expired')
  return event
}

/** Joining by the invite link, under a name the group will see. Joining twice just renames. */
const joinEvent = async (user, input, now = new Date()) => {
  const displayName = cleanDisplayName(input.display_name)
  const event = await byInvite(input.token)
  const already = await db('event_members').where({ event_id: event.id, user_id: user.id }).first()
  if (already) {
    await db('event_members').where({ event_id: event.id, user_id: user.id }).update({ display_name: displayName })
  } else {
    const count = Number((await db('event_members').where({ event_id: event.id }).count('* as n').first()).n)
    if (count >= MAX_MEMBERS) throw new HttpError(400, 'This group is full')
    await db('event_members').insert({ event_id: event.id, user_id: user.id, display_name: displayName, role: 'member' })
  }
  return oneEvent(user, event.id, now)
}

const areaText = async (event, locale) => places.areaLabel(locale, event.state, await places.areaName(event))

/** For the join page, before signing in: what the event is, never who is in it. */
const previewEvent = async (inviteToken, locale = 'en') => {
  const event = await byInvite(inviteToken)
  const members = Number((await db('event_members').where({ event_id: event.id }).count('* as n').first()).n)
  return { name: event.name, area: await areaText(event, locale), starts_on: places.dayOf(event.starts_on), ends_on: places.dayOf(event.ends_on), kind: event.kind, members }
}

/** The view-only link: the plan, targets, the saved route (no start) and the day's tally for anyone, with no names at all. */
const viewEvent = async (viewToken, locale = 'en', now = new Date()) => {
  const event = typeof viewToken === 'string' && viewToken.length >= 16 ? await db('events').where({ view_token: viewToken }).first() : null
  if (!event) throw new HttpError(404, 'This link is invalid or has expired')
  const [targets, tally, route] = await Promise.all([
    db('event_targets').where({ event_id: event.id }).orderBy('species_code').pluck('species_code'),
    db('event_tally').where({ event_id: event.id }).whereNull('removed_at').orderByRaw('coalesce(observed_at, added_at), id').select('species_code', 'added_at'),
    require('./eventRoutePlan').viewPlan(event.id)
  ])
  // On or not in the event's own zone (no viewer account to go by), so the page knows to keep refreshing.
  const clock = eventClock(event, null, now)
  const codes = [...new Set([...targets, ...tally.map((t) => t.species_code)])]
  const birds = codes.length ? await require('./enrich').findOrCreateBirds(codes).catch(() => []) : []
  const nameOf = (code) => birds.find((b) => b.speciesCode === code)?.comName || code
  return {
    name: event.name,
    area: await areaText(event, locale),
    starts_on: places.dayOf(event.starts_on),
    ends_on: places.dayOf(event.ends_on),
    kind: event.kind,
    timezone: clock.zone,
    active: clock.active,
    tally_open: clock.tally_open,
    targets: targets.map((code) => ({ code, speciesCode: code, comName: nameOf(code) })),
    tally: tally.map((t) => ({ code: t.species_code, speciesCode: t.species_code, comName: nameOf(t.species_code), added_at: t.added_at })),
    count: tally.length,
    // The group's saved route, its stops only: the start can be someone's home.
    route
  }
}

// --- for /me and the daily notes -----------------------------------------------------------------

/** An event the person is in that starts within the week (not one already on, in its own zone), soonest first; or null. */
const upcomingEventOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  // A day either side in the query, since zones run up to a day apart; then each by its own day.
  const rows = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).whereNull('event_members.archived_at')
    .where('events.starts_on', '>=', places.utcPlus(now, 0)).where('events.starts_on', '<=', places.utcPlus(now, places.LEAD_DAYS + 1))
    .orderBy('events.starts_on').orderBy('events.id').select('events.*')
  const row = rows.find((e) => {
    const { today } = eventClock(e, user.timezone, now)
    const starts = places.dayOf(e.starts_on)
    return starts > today && places.daysBetween(today, starts) <= places.LEAD_DAYS
  })
  return row ? { id: row.id, name: row.name, starts_on: places.dayOf(row.starts_on) } : null
}

/**
 * For the app's "welcome back": an event whose last day was yesterday or the day before (so it ended
 * at midnight, in the event's time zone), not yet acknowledged, with no other event on now.
 */
const lastEventOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  if ((await places.activePlacesFor([user], now)).get(user.id)?.event) return null
  const rows = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).whereNull('event_members.return_seen_at')
    .whereBetween('events.ends_on', [places.utcPlus(now, -3), places.utcPlus(now, 0)])
    .orderBy('events.ends_on', 'desc').orderBy('events.id', 'desc').select('events.*')
  const row = rows.find((e) => {
    const { today } = eventClock(e, user.timezone, now)
    const gone = places.daysBetween(places.dayOf(e.ends_on), today)
    return gone >= 1 && gone <= 2
  })
  return row ? { id: row.id, name: row.name, ended_on: places.dayOf(row.ends_on) } : null
}

/** The "welcome back" was seen: it won't show again for events ended so far (each in its own zone). */
const markEventReturnSeen = async (user, now = new Date()) => {
  const rows = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).whereNull('event_members.return_seen_at')
    .where('events.ends_on', '<=', places.utcPlus(now, 1)).select('events.*')
  const over = rows.filter((e) => eventClock(e, user.timezone, now).past).map((e) => e.id)
  if (!over.length) return 0
  return db('event_members').where({ user_id: user.id }).whereNull('return_seen_at').whereIn('event_id', over).update({ return_seen_at: db.fn.now() })
}

/**
 * The two event notes, to each member and each once: when an event starts ("you're set for…") and
 * the day before it ends ("a reminder: your account switches back…"), in the event's own dates (its zone).
 * Only to confirmed addresses that haven't turned the notes off; a note is marked sent before it
 * goes, so a failure or a second run can never send it twice. Stops at `deadline`.
 */
const runEventNotices = async ({ send = null, deadline = Infinity, now = new Date() } = {}) => {
  const mailer = require('./mailer')
  const deliver = send || mailer.sendTripNotice
  const rows = await db('event_members').join('events', 'events.id', 'event_members.event_id').join('users', 'users.id', 'event_members.user_id')
    .where('users.email_confirmed', true).where('users.trip_emails_enabled', true)
    .where('events.ends_on', '>=', places.utcPlus(now, -1)).where('events.starts_on', '<=', places.utcPlus(now, 2))
    .where((q) => q.whereNull('event_members.started_notice_at').orWhereNull('event_members.ending_notice_at'))
    .select('events.id as event_id', 'events.name', 'events.starts_on', 'events.ends_on', 'events.timezone', 'events.state', 'events.location',
      'events.home_lat', 'events.home_lng', 'event_members.user_id',
      'event_members.started_notice_at', 'event_members.ending_notice_at')
  const result = { started: 0, ending: 0, more: false }
  for (const row of rows) {
    if (Date.now() > deadline) { result.more = true; break }
    const user = await db('users').where({ id: row.user_id }).first()
    // The event's own days: it starts and ends for everyone in it at once.
    const { today } = eventClock(row, user.timezone, now)
    const starts = places.dayOf(row.starts_on)
    const ends = places.dayOf(row.ends_on)
    const dayBefore = new Date(Date.parse(`${ends}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const home = places.areaLabel(user.locale, user.state, await places.areaName(user))
    const vars = { eventId: row.event_id, place: row.name, ends, home }
    const mine = db('event_members').where({ event_id: row.event_id, user_id: row.user_id })
    try {
      if (!row.started_notice_at && starts <= today && today <= ends) {
        const claimed = await mine.clone().whereNull('started_notice_at').update({ started_notice_at: db.fn.now() })
        if (claimed) { await deliver(user, 'started', vars); result.started += 1 }
      } else if (!row.ending_notice_at && today === dayBefore && starts <= today) {
        const claimed = await mine.clone().whereNull('ending_notice_at').update({ ending_notice_at: db.fn.now() })
        if (claimed) { await deliver(user, 'ending', vars); result.ending += 1 }
      }
    } catch (error) {
      if (error.code === 'MAIL_CAP') { result.capped = true; break }
      await require('./errors').reportError(`event note for event ${row.event_id}`, error)
    }
  }
  return result
}

module.exports = {
  MAX_MEMBERS, MAX_TARGETS, MAX_TALLY, MAX_OPEN,
  SCOUT_VIEW_DAYS, listEvents, createEvent, startInvite, updateMembership, suggestForEvent, eventScouting, scoutingFor, scoutFeed, updateEvent, endEvent, leaveEvent, rotateInvite,
  GRACE_HOURS, STOP_METRES, eventClock, cleanEntry, nearestStop,
  setEventTargets, addTally, removeTally, undoRemoveTally, markTally, unmarkTally, eventLog, joinEvent, previewEvent, viewEvent, organizerOf, memberOf,
  upcomingEventOf, lastEventOf, markEventReturnSeen, runEventNotices
}
