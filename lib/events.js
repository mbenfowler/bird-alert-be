const crypto = require('crypto')
const db = require('./db')
const { HttpError } = require('./http')
const { assertArea } = require('./areas')
const { appUrl } = require('./appUrl')
const places = require('./places')

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
  const [members, targets, tally] = await Promise.all([
    db('event_members').whereIn('event_id', ids).orderBy('joined_at').orderBy('user_id'),
    db('event_targets').whereIn('event_id', ids).orderBy('species_code'),
    db('event_tally').whereIn('event_id', ids).orderBy('added_at')
  ])
  const memberIds = [...new Set(members.map((m) => m.user_id))]
  const codes = [...new Set(targets.map((t) => t.species_code))]
  const seen = memberIds.length && codes.length
    ? await db('seen_birds').whereIn('user_id', memberIds).whereIn('species_code', codes).select('user_id', 'species_code')
    : []
  const has = new Set(seen.map((r) => `${r.user_id}|${r.species_code}`))
  const today = places.localDay(user.timezone, now)
  return events.map((e) => {
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
      active: places.tripActive(trip, user.timezone, now),
      past: places.dayOf(e.ends_on) < today,
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
      tally: eventTally.map((t) => ({ code: t.species_code, added_by_name: nameOf(t.added_by), added_by_you: t.added_by === user.id, added_at: t.added_at })),
      recap: { species: eventTally.length, targets_got: eventTargets.filter((c) => got.has(c)).length, targets_total: eventTargets.length },
      // The links show once the caller has chosen the name the group will see them by.
      invite_url: me?.display_name ? inviteUrl(e) : null,
      view_url: me?.display_name ? viewUrl(e) : null
    }
  })
}

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
  const dates = places.cleanDates(input.starts_on, options.kind === 'bigday' ? input.starts_on : input.ends_on, user.timezone, now)
  const sameArea = place && place.state === state && place.location === location
  const spot = 'home_lat' in input || 'home_lng' in input
    ? places.cleanSpot(input.home_lat, input.home_lng)
    : (sameArea ? { home_lat: place.home_lat, home_lng: place.home_lng } : { home_lat: null, home_lng: null })
  const id = await db.transaction(async (trx) => {
    const [event] = await trx('events').insert({
      owner_id: user.id,
      place_id: place?.id ?? null,
      name: cleanEventName('name' in input ? input.name : (place?.name || 'My trip')),
      state,
      location,
      range_mi: 'range_mi' in input ? places.cleanRange(input.range_mi) : (place?.range_mi ?? 30),
      ...spot,
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
const eventScouting = async (user, id, { now = new Date(), fetchFeed = null } = {}) => {
  const scouting = require('./scouting')
  const { shared } = require('./apiGuard')
  const event = await memberOf(user, id)
  const today = places.localDay(user.timezone, now)
  const startsOn = places.dayOf(event.starts_on)
  const past = places.dayOf(event.ends_on || event.starts_on) < today
  const base = {
    checked_at: now.toISOString(),
    days_to_go: startsOn > today ? places.daysBetween(today, startsOn) : null,
    window: { from: places.scoutFrom(event), to: startsOn }
  }
  let targets = await db('event_targets').where({ event_id: event.id }).orderBy('species_code').pluck('species_code')
  const using = targets.length ? 'targets' : 'likely_lifers'
  if (past) return { ...base, using, reported: [], unreported: [] }
  if (!targets.length) targets = await scouting.likelyFor(user, event).catch(() => [])
  if (!targets.length) return { ...base, using, reported: [], unreported: [] }
  const feed = await scouting.feedFor(event)
  const records = await shared(`scout-view:${feed.key}`, SCOUT_VIEW_SECONDS, () => (fetchFeed ? fetchFeed(feed.key) : feed.fetch()))
  const { seen, unreported } = scouting.scoutReport(targets, records, today, SCOUT_VIEW_DAYS)
  const names = new Map((await require('./enrich').findOrCreateBirds(unreported).catch(() => [])).map((b) => [b.speciesCode, b.comName]))
  return {
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
}

/** Any member can change the plan: name, dates, area, range, kind and scouting. */
const updateEvent = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  const changes = {}
  if ('name' in input) changes.name = cleanEventName(input.name)
  const options = places.cleanTripOptions(input, event)
  const kind = options.kind ?? event.kind
  if ('starts_on' in input || 'ends_on' in input || (options.kind === 'bigday' && event.kind !== 'bigday')) {
    const starts = input.starts_on ?? places.dayOf(event.starts_on)
    const ends = kind === 'bigday' ? starts : (input.ends_on ?? places.dayOf(event.ends_on))
    Object.assign(changes, places.cleanDates(starts, ends, user.timezone, now))
  }
  if ('location' in input || 'state' in input) {
    const state = String(input.state ?? event.state)
    const location = String(input.location ?? event.location)
    await assertArea(state, location)
    Object.assign(changes, { state, location, home_lat: null, home_lng: null })
  }
  if ('range_mi' in input) changes.range_mi = places.cleanRange(input.range_mi)
  if ('home_lat' in input || 'home_lng' in input) Object.assign(changes, places.cleanSpot(input.home_lat, input.home_lng))
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

/** A bird on the day's tally, once however many members tap it. */
const addTally = async (user, id, code, now = new Date()) => {
  const event = await memberOf(user, id)
  const species = cleanCode(code)
  const count = Number((await db('event_tally').where({ event_id: event.id }).count('* as n').first()).n)
  if (count >= MAX_TALLY && !(await db('event_tally').where({ event_id: event.id, species_code: species }).first())) {
    throw new HttpError(400, 'The tally is full')
  }
  await db('event_tally').insert({ event_id: event.id, species_code: species, added_by: user.id }).onConflict(['event_id', 'species_code']).ignore()
  return oneEvent(user, event.id, now)
}

const removeTally = async (user, id, code, now = new Date()) => {
  const event = await memberOf(user, id)
  await db('event_tally').where({ event_id: event.id, species_code: cleanCode(code) }).del()
  return oneEvent(user, event.id, now)
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

/** The view-only link: the plan, targets and the day's tally for anyone, with no names at all. */
const viewEvent = async (viewToken, locale = 'en') => {
  const event = typeof viewToken === 'string' && viewToken.length >= 16 ? await db('events').where({ view_token: viewToken }).first() : null
  if (!event) throw new HttpError(404, 'This link is invalid or has expired')
  const [targets, tally] = await Promise.all([
    db('event_targets').where({ event_id: event.id }).orderBy('species_code').pluck('species_code'),
    db('event_tally').where({ event_id: event.id }).orderBy('added_at').select('species_code', 'added_at')
  ])
  const codes = [...new Set([...targets, ...tally.map((t) => t.species_code)])]
  const birds = codes.length ? await require('./enrich').findOrCreateBirds(codes).catch(() => []) : []
  const nameOf = (code) => birds.find((b) => b.speciesCode === code)?.comName || code
  return {
    name: event.name,
    area: await areaText(event, locale),
    starts_on: places.dayOf(event.starts_on),
    ends_on: places.dayOf(event.ends_on),
    kind: event.kind,
    targets: targets.map((code) => ({ code, speciesCode: code, comName: nameOf(code) })),
    tally: tally.map((t) => ({ code: t.species_code, speciesCode: t.species_code, comName: nameOf(t.species_code), added_at: t.added_at })),
    count: tally.length
  }
}

// --- for /me and the daily notes -----------------------------------------------------------------

/** An event the person is in that starts within the week (not one already on), soonest first; or null. */
const upcomingEventOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  const today = places.localDay(user.timezone, now)
  const row = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).whereNull('event_members.archived_at')
    .where('events.starts_on', '>', today).where('events.starts_on', '<=', places.utcPlus(new Date(`${today}T12:00:00Z`), places.LEAD_DAYS))
    .orderBy('events.starts_on').orderBy('events.id').first('events.id', 'events.name', 'events.starts_on')
  return row ? { id: row.id, name: row.name, starts_on: places.dayOf(row.starts_on) } : null
}

/**
 * For the app's "welcome back": an event whose last day was yesterday or the day before (so it ended
 * at midnight, in the person's time zone), not yet acknowledged, with no other event on now.
 */
const lastEventOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  if ((await places.activePlacesFor([user], now)).get(user.id)?.event) return null
  const today = places.localDay(user.timezone, now)
  const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
  const row = await db('event_members').join('events', 'events.id', 'event_members.event_id')
    .where('event_members.user_id', user.id).whereNull('event_members.return_seen_at')
    .whereBetween('events.ends_on', [day(-2), day(-1)])
    .orderBy('events.ends_on', 'desc').first('events.id', 'events.name', 'events.ends_on')
  return row ? { id: row.id, name: row.name, ended_on: places.dayOf(row.ends_on) } : null
}

/** The "welcome back" was seen: it won't show again for events ended so far. */
const markEventReturnSeen = (user) => db('event_members').where({ user_id: user.id }).whereNull('return_seen_at')
  .whereIn('event_id', db('events').where('ends_on', '<', places.localDay(user.timezone)).select('id'))
  .update({ return_seen_at: db.fn.now() })

/**
 * The two event notes, to each member and each once: when an event starts ("you're set for…") and
 * the day before it ends ("a reminder: your account switches back…"), in the member's own dates.
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
    .select('events.id as event_id', 'events.name', 'events.starts_on', 'events.ends_on', 'event_members.user_id',
      'event_members.started_notice_at', 'event_members.ending_notice_at')
  const result = { started: 0, ending: 0, more: false }
  for (const row of rows) {
    if (Date.now() > deadline) { result.more = true; break }
    const user = await db('users').where({ id: row.user_id }).first()
    const today = places.localDay(user.timezone, now)
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
  listEvents, createEvent, startInvite, updateMembership, suggestForEvent, eventScouting, updateEvent, endEvent, leaveEvent, rotateInvite,
  setEventTargets, addTally, removeTally, joinEvent, previewEvent, viewEvent, organizerOf,
  upcomingEventOf, lastEventOf, markEventReturnSeen, runEventNotices
}
