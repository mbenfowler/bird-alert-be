const crypto = require('crypto')
const db = require('./db')
const { HttpError } = require('./http')
const { assertArea } = require('./areas')
const { appUrl } = require('./appUrl')
const places = require('./places')

/**
 * Group events: a trip shared with a small group (a Big Day with friends). Made from one of the
 * organizer's trips; anyone who joins with the invite link can change the plan, its target birds
 * and the day's tally. A separate view-only link shows the plan and tally to anyone, with no names.
 * Each member's own life list decides which targets are lifers for them. During the event its
 * area alerts every member as a trip would (lib/places activePlacesFor), and each member gets
 * their own scouting report beforehand (lib/scouting).
 */
const MAX_MEMBERS = 10
const MAX_TARGETS = 50
const MAX_TALLY = 600
// Ended events stay listed (and their tally readable) this long, then go.
const KEEP_ENDED_DAYS = 30

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

/** Events as a member sees them: the plan, the group (by the names they chose), targets with whose lifer each is, and the tally. */
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
  return events.map((e) => {
    const group = members.filter((m) => m.event_id === e.id)
    const organizer = group.find((m) => m.role === 'organizer') || group[0]
    const nameOf = (userId) => group.find((m) => m.user_id === userId)?.display_name || null
    const trip = { starts_on: e.starts_on, ends_on: e.ends_on, scout_days: e.scout_days }
    return {
      id: e.id,
      name: e.name,
      state: e.state,
      location: e.location,
      range_mi: e.range_mi,
      starts_on: places.dayOf(e.starts_on),
      ends_on: places.dayOf(e.ends_on),
      kind: e.kind,
      scout: Boolean(e.scout),
      scout_days: Number(e.scout_days),
      scout_from: places.scoutFrom(trip),
      active: places.tripActive(trip, user.timezone, now),
      role: organizer && organizer.user_id === user.id ? 'organizer' : 'member',
      members: group.map((m) => ({ display_name: m.display_name, role: organizer && m.user_id === organizer.user_id ? 'organizer' : 'member', you: m.user_id === user.id })),
      targets: targets.filter((t) => t.event_id === e.id).map((t) => ({
        code: t.species_code,
        lifer_for: group.filter((m) => !has.has(`${m.user_id}|${t.species_code}`)).map((m) => m.display_name)
      })),
      tally: tally.filter((t) => t.event_id === e.id).map((t) => ({ code: t.species_code, added_by_name: nameOf(t.added_by), added_at: t.added_at })),
      invite_url: inviteUrl(e),
      view_url: viewUrl(e)
    }
  })
}

/** The person's events, soonest first; ended ones stay a month. */
const listEvents = async (user, now = new Date()) => {
  const events = await db('events').join('event_members', 'event_members.event_id', 'events.id')
    .where('event_members.user_id', user.id).where('events.ends_on', '>=', places.utcPlus(now, -KEEP_ENDED_DAYS))
    .orderBy('events.starts_on').orderBy('events.id').select('events.*')
  return shape(user, events, now)
}

const oneEvent = async (user, id, now = new Date()) => {
  const event = await db('events').where({ id: Number(id) }).first()
  return (await shape(user, [event], now))[0]
}

/**
 * "Share with my group": the person's trip becomes a group event at the trip's place (its area,
 * range and spot), dates, kind and scouting, with the place's target birds; the person organizes
 * it. The trip itself goes, so its alerts and scouting aren't doubled by the event's.
 */
const createFromTrip = async (user, input, now = new Date()) => {
  const displayName = cleanDisplayName(input.display_name)
  const trip = await places.ownTrip(user, input.trip_id)
  const place = await db('places').where({ id: trip.place_id }).first()
  const targets = await db('place_targets').where({ place_id: place.id }).pluck('species_code')
  const id = await db.transaction(async (trx) => {
    const [event] = await trx('events').insert({
      owner_id: user.id,
      name: place.name,
      state: place.state,
      location: place.location,
      range_mi: place.range_mi,
      home_lat: place.home_lat,
      home_lng: place.home_lng,
      starts_on: places.dayOf(trip.starts_on),
      ends_on: places.dayOf(trip.ends_on),
      kind: trip.kind || 'trip',
      scout: Boolean(trip.scout),
      scout_days: trip.scout_days || 21,
      invite_token: token(),
      view_token: token()
    }).returning('id')
    const eventId = event.id ?? event
    await trx('event_members').insert({ event_id: eventId, user_id: user.id, display_name: displayName, role: 'organizer' })
    if (targets.length) await trx('event_targets').insert(targets.map((code) => ({ event_id: eventId, species_code: code, added_by: user.id })))
    await trx('trips').where({ id: trip.id }).del()
    return eventId
  })
  return oneEvent(user, id, now)
}

/** Any member can change the plan: name, dates, area, range, kind and scouting. */
const updateEvent = async (user, id, input, now = new Date()) => {
  const event = await memberOf(user, id)
  const changes = {}
  if ('name' in input) changes.name = cleanEventName(input.name)
  if ('starts_on' in input || 'ends_on' in input) {
    Object.assign(changes, places.cleanDates(input.starts_on ?? places.dayOf(event.starts_on), input.ends_on ?? places.dayOf(event.ends_on), user.timezone, now))
  }
  if ('location' in input || 'state' in input) {
    const state = String(input.state ?? event.state)
    const location = String(input.location ?? event.location)
    await assertArea(state, location)
    Object.assign(changes, { state, location, home_lat: null, home_lng: null })
  }
  if ('range_mi' in input) changes.range_mi = places.cleanRange(input.range_mi)
  Object.assign(changes, places.cleanTripOptions(input, event))
  if (Object.keys(changes).length) await db('events').where({ id: event.id }).update(changes)
  return oneEvent(user, event.id, now)
}

/** The organizer ends the event for everyone. */
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

/** Ended events go a month after they end. */
const pruneEvents = (now = new Date()) => db('events').where('ends_on', '<', places.utcPlus(now, -KEEP_ENDED_DAYS)).del()

module.exports = {
  MAX_MEMBERS, MAX_TARGETS, MAX_TALLY,
  listEvents, createFromTrip, updateEvent, endEvent, leaveEvent, rotateInvite,
  setEventTargets, addTally, removeTally, joinEvent, previewEvent, viewEvent, pruneEvents, organizerOf
}
