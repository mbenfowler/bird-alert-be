const db = require('./db')
const { HttpError } = require('./http')
const { assertArea } = require('./areas')
const { RANGE_CHOICES } = require('./range')

/**
 * Places: somewhere besides home that a person birds ("Colorado (work)"), with its own area, alert
 * range, home spot and target birds, and trips (the dates they'll be there). The ACTIVE place is the
 * one a trip covers today, else the one they marked "I'm here now" (users.active_place_id), else
 * none (home). While a place is active its alerts are added to home's, or replace them when the
 * person turns home alerts off (users.keep_home_alerts). Target birds alert only in their place,
 * only while it's active.
 *
 * Trip dates are calendar days in the person's own time zone (users.timezone, the one quiet hours
 * use), both ends included; with no zone known, UTC. A zone change while travelling isn't followed.
 */
const MAX_PLACES = 10
const MAX_TARGETS = 50
const MAX_TRIP_DAYS = 60
const MAX_AHEAD_DAYS = 366
const KEEP_ENDED_DAYS = 30
// A place that becomes active within this many days has its area's checklists fetched now.
const LEAD_DAYS = 7
const DAY = /^\d{4}-\d{2}-\d{2}$/
const SPECIES = /^[a-z0-9]{3,12}$/

/** 'YYYY-MM-DD' today in a time zone (UTC when unknown or invalid). */
const localDay = (timezone, now = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

// The database hands a date column back as local midnight on that day, so it's read by its local parts.
const pad = (n) => String(n).padStart(2, '0')
const dayOf = (value) => (value instanceof Date ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}` : String(value).slice(0, 10))
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const utcPlus = (now, days) => new Date(Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

/** Pure: whether a trip is on today, for someone in `timezone`. */
const tripActive = (trip, timezone, now = new Date()) => {
  const today = localDay(timezone, now)
  return dayOf(trip.starts_on) <= today && today <= dayOf(trip.ends_on)
}

const publicTrip = (trip, timezone, now) => ({ id: trip.id, place_id: trip.place_id, starts_on: dayOf(trip.starts_on), ends_on: dayOf(trip.ends_on), active: tripActive(trip, timezone, now) })

// --- places ------------------------------------------------------------------------------------

const cleanName = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'Give the place a name')
  return value.trim().slice(0, 60)
}
const cleanRange = (value) => {
  if (!RANGE_CHOICES.includes(value)) throw new HttpError(400, 'Choose one of the offered distances')
  return value
}
/** 'life' (a lifer is a bird not on the life list) or 'place' (not on this place's own seen list). */
const cleanScope = (value) => {
  if (value !== 'life' && value !== 'place') throw new HttpError(400, 'Lifers count against the life list or this place\'s list')
  return value
}
const cleanSpot = (lat, lng) => {
  if (lat === null && lng === null) return { home_lat: null, home_lng: null }
  if (!(Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lng) && Math.abs(lng) <= 180)) throw new HttpError(400, 'That spot is not a place on the map')
  return { home_lat: lat, home_lng: lng }
}

/** A person's places, each with its targets and the trips not yet over. */
const listPlaces = async (user, now = new Date()) => {
  const places = await db('places').where({ user_id: user.id }).orderBy('created_at').orderBy('id')
  if (!places.length) return []
  const ids = places.map((p) => p.id)
  const today = localDay(user.timezone, now)
  const [targets, trips, seen] = await Promise.all([
    db('place_targets').whereIn('place_id', ids).orderBy('species_code'),
    db('trips').whereIn('place_id', ids).where('ends_on', '>=', today).orderBy('starts_on').orderBy('id'),
    db('place_seen').whereIn('place_id', ids).groupBy('place_id').select('place_id').count('* as n')
  ])
  const seenCount = new Map(seen.map((r) => [r.place_id, Number(r.n)]))
  return places.map((p) => ({
    id: p.id,
    name: p.name,
    state: p.state,
    location: p.location,
    range_mi: p.range_mi,
    home_lat: p.home_lat,
    home_lng: p.home_lng,
    lifers_scope: p.lifers_scope,
    seenCount: seenCount.get(p.id) || 0,
    targets: targets.filter((t) => t.place_id === p.id).map((t) => t.species_code),
    trips: trips.filter((t) => t.place_id === p.id).map((t) => publicTrip(t, user.timezone, now))
  }))
}

const ownPlace = async (user, id) => {
  const place = Number.isInteger(Number(id)) ? await db('places').where({ id: Number(id), user_id: user.id }).first() : null
  if (!place) throw new HttpError(404, 'No such place')
  return place
}

const onePlace = async (user, id) => (await listPlaces(user)).find((p) => p.id === Number(id))

const createPlace = async (user, input) => {
  const count = Number((await db('places').where({ user_id: user.id }).count('* as n').first()).n)
  if (count >= MAX_PLACES) throw new HttpError(400, 'You can save up to 10 places')
  const state = String(input.state || '').trim()
  const location = String(input.location || '').trim()
  if (!state || !location) throw new HttpError(400, 'Choose where the place is')
  await assertArea(state, location)
  const row = {
    user_id: user.id,
    name: cleanName(input.name),
    state,
    location,
    range_mi: 'range_mi' in input ? cleanRange(input.range_mi) : 30,
    lifers_scope: 'lifers_scope' in input ? cleanScope(input.lifers_scope) : 'life'
  }
  const [place] = await db('places').insert(row).returning('id')
  return onePlace(user, place.id ?? place)
}

/** Changes the fields given: name, area (state and location together), range, home spot. */
const updatePlace = async (user, id, input) => {
  const place = await ownPlace(user, id)
  const changes = {}
  if ('name' in input) changes.name = cleanName(input.name)
  if ('state' in input || 'location' in input) {
    const state = String(input.state ?? place.state).trim()
    const location = String(input.location ?? place.location).trim()
    await assertArea(state, location)
    Object.assign(changes, { state, location })
    // A new area makes the old spot meaningless: measured from the new area's center until set again.
    if (location !== place.location && !('home_lat' in input)) Object.assign(changes, { home_lat: null, home_lng: null })
  }
  if ('range_mi' in input) changes.range_mi = cleanRange(input.range_mi)
  if ('lifers_scope' in input) changes.lifers_scope = cleanScope(input.lifers_scope)
  if ('home_lat' in input || 'home_lng' in input) Object.assign(changes, cleanSpot(input.home_lat ?? null, input.home_lng ?? null))
  if (Object.keys(changes).length) await db('places').where({ id: place.id }).update(changes)
  return onePlace(user, place.id)
}

const deletePlace = async (user, id) => {
  const place = await ownPlace(user, id)
  // Its targets and trips go with it; "I'm here now" falls back to home (ON DELETE SET NULL).
  await db('places').where({ id: place.id }).del()
}

/** Replaces a place's target birds. */
const setTargets = async (user, id, codes) => {
  const place = await ownPlace(user, id)
  if (!Array.isArray(codes)) throw new HttpError(400, 'Target birds must be a list')
  const clean = [...new Set(codes.map((c) => String(c || '').trim()))]
  if (clean.length > MAX_TARGETS) throw new HttpError(400, 'A place can have up to 50 target birds')
  if (!clean.every((c) => SPECIES.test(c))) throw new HttpError(400, 'Invalid species code')
  await db.transaction(async (trx) => {
    await trx('place_targets').where({ place_id: place.id }).del()
    if (clean.length) await trx('place_targets').insert(clean.map((species_code) => ({ place_id: place.id, species_code })))
  })
  return onePlace(user, place.id)
}

// --- a place's own seen list -------------------------------------------------------------------

const MAX_SEEN = 2000

/** The birds seen at a place (like a state list), apart from the life list. */
const placeSeen = async (user, id) => {
  const place = await ownPlace(user, id)
  return db('place_seen').where({ place_id: place.id }).orderBy('species_code').pluck('species_code')
}

/** Replaces a place's seen list (manual edits); birds already on it keep the day they were first seen. */
const setPlaceSeen = async (user, id, codes) => {
  const place = await ownPlace(user, id)
  if (!Array.isArray(codes)) throw new HttpError(400, 'Seen birds must be a list')
  const clean = [...new Set(codes.map((c) => String(c || '').trim()))]
  if (clean.length > MAX_SEEN) throw new HttpError(400, 'A place\'s list can have up to 2000 birds')
  if (!clean.every((c) => SPECIES.test(c))) throw new HttpError(400, 'Invalid species code')
  await db.transaction(async (trx) => {
    await trx('place_seen').where({ place_id: place.id }).whereNotIn('species_code', clean).del()
    if (clean.length) await trx('place_seen').insert(clean.map((species_code) => ({ place_id: place.id, species_code }))).onConflict(['place_id', 'species_code']).ignore()
  })
  return placeSeen(user, place.id)
}

/** "Seen it" while away: the bird goes on the active place's list too, dated today. */
const markSeenAtPlace = async (user, speciesCode, now = new Date()) => {
  const away = (await activePlacesFor([user], now)).get(user.id)
  if (!away) return null
  await db('place_seen').insert({ place_id: away.place.id, species_code: speciesCode, seen_on: localDay(user.timezone, now) }).onConflict(['place_id', 'species_code']).ignore()
  return away.place.id
}

// --- trips -------------------------------------------------------------------------------------

/** Checks a trip's dates (as they'd be saved). */
const cleanDates = (startsOn, endsOn, timezone, now = new Date()) => {
  const starts = String(startsOn || '')
  const ends = String(endsOn || '')
  if (!DAY.test(starts) || !DAY.test(ends) || Number.isNaN(Date.parse(starts)) || Number.isNaN(Date.parse(ends))) throw new HttpError(400, 'A trip needs a start and an end date')
  if (ends < starts) throw new HttpError(400, 'A trip has to end on or after the day it starts')
  if (daysBetween(starts, ends) + 1 > MAX_TRIP_DAYS) throw new HttpError(400, 'A trip can be up to 60 days long')
  const today = localDay(timezone, now)
  if (ends < today) throw new HttpError(400, 'That trip has already ended')
  if (daysBetween(today, starts) > MAX_AHEAD_DAYS) throw new HttpError(400, 'A trip can start up to a year from now')
  return { starts_on: starts, ends_on: ends }
}

const ownTrip = async (user, id) => {
  const trip = Number.isInteger(Number(id))
    ? await db('trips').join('places', 'places.id', 'trips.place_id').where('trips.id', Number(id)).where('places.user_id', user.id).first('trips.*')
    : null
  if (!trip) throw new HttpError(404, 'No such trip')
  return trip
}

const createTrip = async (user, input, now = new Date()) => {
  const place = await ownPlace(user, input.place_id)
  const dates = cleanDates(input.starts_on, input.ends_on, user.timezone, now)
  const [trip] = await db('trips').insert({ place_id: place.id, ...dates }).returning('*')
  return { trip: publicTrip(trip, user.timezone, now), place }
}

const updateTrip = async (user, id, input, now = new Date()) => {
  const trip = await ownTrip(user, id)
  const placeId = 'place_id' in input ? (await ownPlace(user, input.place_id)).id : trip.place_id
  const dates = cleanDates(input.starts_on ?? dayOf(trip.starts_on), input.ends_on ?? dayOf(trip.ends_on), user.timezone, now)
  const [updated] = await db('trips').where({ id: trip.id }).update({ place_id: placeId, ...dates }).returning('*')
  return { trip: publicTrip(updated, user.timezone, now), place: await db('places').where({ id: placeId }).first() }
}

const deleteTrip = async (user, id) => {
  const trip = await ownTrip(user, id)
  await db('trips').where({ id: trip.id }).del()
}

/** Whether a trip starts soon enough that its area should be fetched now. */
const startsSoon = (trip, timezone, now = new Date()) => daysBetween(localDay(timezone, now), dayOf(trip.starts_on)) <= LEAD_DAYS

// --- the active place --------------------------------------------------------------------------

/**
 * Where each person is today, by user id: { place, via: 'trip' | 'manual', trip? } for those away
 * from home; absent for those at home. A trip covering today (in their own time zone) wins over
 * "I'm here now". The query takes a day either side, since time zones run up to a day apart.
 */
const activePlacesFor = async (users, now = new Date()) => {
  const active = new Map()
  if (!users.length) return active
  const ids = users.map((u) => u.id)
  const zone = new Map(users.map((u) => [u.id, u.timezone]))
  const trips = await db('trips').join('places', 'places.id', 'trips.place_id').whereIn('places.user_id', ids)
    .where('trips.starts_on', '<=', utcPlus(now, 1)).where('trips.ends_on', '>=', utcPlus(now, -1))
    .orderBy('trips.starts_on').orderBy('trips.id')
    .select('trips.id as trip_id', 'trips.starts_on', 'trips.ends_on', 'places.*')
  for (const row of trips) {
    if (active.has(row.user_id) || !tripActive(row, zone.get(row.user_id), now)) continue
    const { trip_id: tripId, starts_on: startsOn, ends_on: endsOn, ...place } = row
    active.set(row.user_id, { place, via: 'trip', trip: { id: tripId, starts_on: dayOf(startsOn), ends_on: dayOf(endsOn) } })
  }
  const manual = users.filter((u) => u.active_place_id && !active.has(u.id))
  if (manual.length) {
    const places = await db('places').whereIn('id', manual.map((u) => u.active_place_id))
    for (const user of manual) {
      const place = places.find((p) => p.id === user.active_place_id && p.user_id === user.id)
      if (place) active.set(user.id, { place, via: 'manual' })
    }
  }
  if (active.size) {
    const targets = await db('place_targets').whereIn('place_id', [...new Set([...active.values()].map((a) => a.place.id))])
    for (const a of active.values()) a.place.targets = targets.filter((t) => t.place_id === a.place.id).map((t) => t.species_code)
  }
  return active
}

/** For /me: the place the person is at today, or null at home. */
const activePlaceOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  const a = (await activePlacesFor([user], now)).get(user.id)
  if (!a) return null
  const { id, name, state, location } = a.place
  return { id, name, state, location, via: a.via, ...(a.trip ? { trip: { starts_on: a.trip.starts_on, ends_on: a.trip.ends_on } } : {}) }
}

/**
 * The person as alerts see them at a place: its area, range and home spot in place of home's, its
 * target birds, and no first-of-season news (a home-patch story).
 */
const atPlace = (user, active) => ({
  ...user,
  state: active.place.state,
  location: active.place.location,
  range_mi: active.place.range_mi,
  home_lat: active.place.home_lat,
  home_lng: active.place.home_lng,
  push_first_of_season: false,
  place: { id: active.place.id, name: active.place.name, state: active.place.state, location: active.place.location, targets: active.place.targets || [], lifers_scope: active.place.lifers_scope || 'life' }
})

/** Areas of places active today or starting within the week, so the background jobs keep them fresh. */
const activePlaceAreas = async (now = new Date()) => [...new Set([
  ...await db('trips').join('places', 'places.id', 'trips.place_id')
    .where('trips.starts_on', '<=', utcPlus(now, LEAD_DAYS)).where('trips.ends_on', '>=', utcPlus(now, -1)).distinct('places.location').pluck('places.location'),
  ...await db('users').join('places', 'places.id', 'users.active_place_id').distinct('places.location').pluck('places.location')
])]

/** An area's name ('Denver'), from eBird's cached list of its state's areas; its code when that can't be read. */
const areaName = async ({ state, location }) => {
  try {
    const { areasOf } = require('./areas')
    return (await areasOf(state)).find((a) => a.code === location)?.name || location
  } catch {
    return location
  }
}

/**
 * An area's name the way the app says it in prose: "Hall County" in the US (never "Orleans Parish
 * County" or "Juneau City and Borough County"), a municipality as eBird names it ("City of Cape
 * Town"), and elsewhere "<name> area" (a UK or Irish county as itself: "Kent").
 */
const ALREADY_SAYS = /\b(county|parish|borough|city|census area|municipality|municipio|area)\b/i
const areaLabel = (locale, state, name) => {
  if (!name || ALREADY_SAYS.test(name)) return name
  const { t } = require('./i18n')
  const { countyWord, countryOf } = require('./regions')
  const word = countyWord(state)
  if (word === 'county') return countryOf(state) === 'US' ? t(locale, 'areaName.county', { name }) : name
  if (word === 'municipality') return name
  return t(locale, 'areaName.area', { name })
}

/** Drops trips that ended more than a month ago. */
const pruneTrips = (now = new Date()) => db('trips').where('ends_on', '<', utcPlus(now, -KEEP_ENDED_DAYS)).del()

// --- suggestions -------------------------------------------------------------------------------

const SUGGEST_MAX = 15
const SAMPLE_DAYS = 7
const WINDOW_MAX_DAYS = 21
const SUGGEST_BUDGET_MS = 8000

/**
 * Likely lifers for a place on given dates: what was reported in its area on the same dates a year
 * earlier, minus the person's life list (scope 'life', the default) or this place's own seen list
 * (scope 'place'), ranked by the share of those days each species was reported on (the steadiest
 * first). Up to seven of last year's days are fetched from eBird the first time (cached for good in
 * the seasonality record), so later asks cost nothing. Whole species only.
 */
const suggestTargets = async (user, id, { from, to, scope = 'life' } = {}, now = new Date()) => {
  const place = await ownPlace(user, id)
  const seasonality = require('./seasonality')
  const today = localDay(user.timezone, now)
  const start = DAY.test(String(from || '')) ? String(from) : today
  let end = DAY.test(String(to || '')) && String(to) >= start ? String(to) : start
  if (daysBetween(start, end) + 1 > WINDOW_MAX_DAYS) end = seasonality.addDays(start, WINDOW_MAX_DAYS - 1)
  // Too short a window says little: at least a week, centered on the trip.
  let wFrom = seasonality.yearAgo(start)
  let wTo = seasonality.yearAgo(end)
  const short = 7 - (daysBetween(wFrom, wTo) + 1)
  if (short > 0) { wFrom = seasonality.addDays(wFrom, -Math.ceil(short / 2)); wTo = seasonality.addDays(wTo, Math.floor(short / 2)) }
  const all = seasonality.daysBetween(wFrom, wTo)
  const step = Math.max(1, Math.floor(all.length / SAMPLE_DAYS))
  const sample = all.filter((_, i) => i % step === 0).slice(0, SAMPLE_DAYS)
  await seasonality.ensureDays(place.location, sample, { limit: SAMPLE_DAYS, deadline: Date.now() + SUGGEST_BUDGET_MS }).catch(() => null)
  const [presence, covered, seen] = await Promise.all([
    seasonality.presence(place.location, wFrom, wTo),
    seasonality.coverage(place.location, wFrom, wTo),
    scope === 'place'
      ? db('place_seen').where({ place_id: place.id }).pluck('species_code')
      : db('seen_birds').where({ user_id: user.id }).pluck('species_code')
  ])
  const life = new Set(seen)
  const codes = [...presence.keys()].filter((c) => !life.has(c))
  const taxa = codes.length ? await db('taxonomy_ref').whereIn('species_code', codes).select('species_code', 'com_name', 'category') : []
  const taxon = new Map(taxa.map((t) => [t.species_code, t]))
  const ranked = codes
    .filter((c) => !taxon.has(c) || taxon.get(c).category === 'species')
    .map((c) => ({ speciesCode: c, comName: taxon.get(c)?.com_name || null, days: presence.get(c).size, sampled: covered }))
    .sort((a, b) => b.days - a.days || String(a.comName || a.speciesCode).localeCompare(String(b.comName || b.speciesCode)))
    .slice(0, SUGGEST_MAX)
  // Names for codes the taxonomy didn't have yet, from our birds.
  const unnamed = ranked.filter((r) => !r.comName).map((r) => r.speciesCode)
  if (unnamed.length) {
    const birds = await db('birds').whereIn('speciesCode', unnamed).select('speciesCode', 'comName')
    for (const r of ranked) r.comName = r.comName || birds.find((b) => b.speciesCode === r.speciesCode)?.comName || r.speciesCode
  }
  return { from: wFrom, to: wTo, sampled: covered, scope: scope === 'place' ? 'place' : 'life', suggestions: ranked }
}

// --- coming home -------------------------------------------------------------------------------

/**
 * For the app's "welcome back": a trip whose last day was yesterday or the day before (so it ended
 * at midnight, in the person's time zone), not yet acknowledged, with no other trip on now.
 */
const lastTripOf = async (user, now = new Date()) => {
  if (!user?.id) return null
  const today = localDay(user.timezone, now)
  const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
  if ((await activePlacesFor([user], now)).get(user.id)?.via === 'trip') return null
  const trip = await db('trips').join('places', 'places.id', 'trips.place_id').where('places.user_id', user.id)
    .whereNull('trips.return_seen_at').whereBetween('trips.ends_on', [day(-2), day(-1)])
    .orderBy('trips.ends_on', 'desc').first('trips.id', 'trips.ends_on', 'places.name')
  return trip ? { id: trip.id, place_name: trip.name, ended_on: dayOf(trip.ends_on) } : null
}

/** The "welcome back" was seen: it won't show again for trips ended so far. */
const markReturnSeen = (user) => db('trips').whereIn('place_id', db('places').where({ user_id: user.id }).select('id'))
  .whereNull('return_seen_at').where('ends_on', '<', localDay(user.timezone)).update({ return_seen_at: db.fn.now() })

// --- trip notes by email -----------------------------------------------------------------------

/**
 * The two trip notes, each sent once: when a trip starts ("you're set for…") and the day before it
 * ends ("a reminder: your account switches back…"), in the person's own dates. Only to confirmed
 * addresses that haven't turned the notes off; a note is marked sent before it goes, so a failure
 * or a second run can never send it twice. Stops at `deadline`.
 */
const runTripNotices = async ({ send = null, deadline = Infinity, now = new Date() } = {}) => {
  const mailer = require('./mailer')
  const deliver = send || mailer.sendTripNotice
  const rows = await db('trips').join('places', 'places.id', 'trips.place_id').join('users', 'users.id', 'places.user_id')
    .where('users.email_confirmed', true).where('users.trip_emails_enabled', true)
    .where('trips.ends_on', '>=', utcPlus(now, -1)).where('trips.starts_on', '<=', utcPlus(now, 2))
    .where((q) => q.whereNull('trips.started_notice_at').orWhereNull('trips.ending_notice_at'))
    .select('trips.id as trip_id', 'trips.starts_on', 'trips.ends_on', 'trips.started_notice_at', 'trips.ending_notice_at', 'places.name as place_name', 'places.user_id')
  const result = { started: 0, ending: 0, more: false }
  for (const row of rows) {
    if (Date.now() > deadline) { result.more = true; break }
    const user = await db('users').where({ id: row.user_id }).first()
    const today = localDay(user.timezone, now)
    const starts = dayOf(row.starts_on)
    const ends = dayOf(row.ends_on)
    const dayBefore = new Date(Date.parse(`${ends}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    const home = areaLabel(user.locale, user.state, await areaName(user))
    const vars = { tripId: row.trip_id, place: row.place_name, ends, home }
    try {
      if (!row.started_notice_at && starts <= today && today <= ends) {
        const claimed = await db('trips').where({ id: row.trip_id }).whereNull('started_notice_at').update({ started_notice_at: db.fn.now() })
        if (claimed) { await deliver(user, 'started', vars); result.started += 1 }
      } else if (!row.ending_notice_at && today === dayBefore && starts <= today) {
        const claimed = await db('trips').where({ id: row.trip_id }).whereNull('ending_notice_at').update({ ending_notice_at: db.fn.now() })
        if (claimed) { await deliver(user, 'ending', vars); result.ending += 1 }
      }
    } catch (error) {
      if (error.code === 'MAIL_CAP') { result.capped = true; break }
      await require('./errors').reportError(`trip note for trip ${row.trip_id}`, error)
    }
  }
  return result
}

module.exports = {
  MAX_PLACES, MAX_TARGETS, MAX_TRIP_DAYS, KEEP_ENDED_DAYS, LEAD_DAYS,
  localDay, tripActive, dayOf,
  listPlaces, createPlace, updatePlace, deletePlace, setTargets, ownPlace,
  placeSeen, setPlaceSeen, markSeenAtPlace, lastTripOf, markReturnSeen, runTripNotices,
  createTrip, updateTrip, deleteTrip, startsSoon,
  activePlacesFor, activePlaceOf, atPlace, activePlaceAreas, areaName, areaLabel, pruneTrips,
  suggestTargets
}
