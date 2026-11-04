const crypto = require('crypto')
const db = require('./db')
const { HttpError } = require('./http')
const places = require('./places')
const { eventZone, wallTime } = require('./timezones')

/**
 * The event recap: once an event is over, the day told from its tally. Each bird in the order it
 * was found, the lifers, the rarest bird, the bird the scouting email called, the targets got and
 * missed, the stops and the drive, and who found what.
 *
 * It opens when the tally closes (3 AM the morning after the last day, in the event's zone) and
 * stays open for fixes for FIX_HOURS: computed live, and members can still add or take away birds.
 * Then it's sealed: the first read after that, or the morning run, freezes it into event_recaps,
 * so a life list changed later never rewrites whose lifer a bird was.
 *
 * Members see it all. Anyone with the share code sees the public view: no names at all, and no
 * personal places (a stop that isn't a public eBird hotspot is left out, and its name goes from
 * every bird found there). Birds are named in the reader's language; the frozen copy is kept in
 * English and named when read.
 */
const FIX_HOURS = 48
const MAX_CANDIDATES = 150

const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
const iso = (value) => (value ? new Date(value).toISOString() : null)

/**
 * Pure: where an event's recap stands at `now`: 'live' (the tally still takes birds as usual, no
 * recap yet), 'open' (the fix window) or 'sealed'; closesAt is when the tally closes and fixesUntil
 * the end of the fix window, both Dates. The zone is the event's own, the same for everyone.
 */
const recapClock = (event, now = new Date()) => {
  const zone = eventZone(event)
  const ends = places.dayOf(event.ends_on || event.starts_on)
  const closesAt = wallTime(nextDay(ends), require('./events').GRACE_HOURS, zone)
  const fixesUntil = new Date(closesAt.getTime() + FIX_HOURS * 3_600_000)
  const status = now < closesAt ? 'live' : now < fixesUntil ? 'open' : 'sealed'
  return { zone, closesAt, fixesUntil, status }
}

// --- the share code ---------------------------------------------------------------------------

/**
 * The public link's code: the event id in base 36, a dash, and six base-36 characters of an HMAC of
 * it, as invite codes are (lib/invites). Nothing is stored; a code is checked by working it out
 * again, and one can't be guessed from another event's.
 */
const tag = (id) => BigInt('0x' + crypto.createHmac('sha256', process.env.SESSION_SECRET).update(`recap:${id}`).digest('hex')).toString(36).slice(0, 6).padStart(6, '0')

const recapCode = (id) => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('recapCode needs an event id')
  return `${id.toString(36)}-${tag(id)}`
}

/** Pure: the event id a code names, or null for anything forged or garbled. */
const readRecapCode = (value) => {
  const m = /^([0-9a-z]{1,11})-([0-9a-z]{6})$/.exec(String(value ?? '').trim().toLowerCase())
  if (!m) return null
  const id = parseInt(m[1], 36)
  if (!Number.isSafeInteger(id) || id <= 0 || id.toString(36) !== m[1]) return null
  return crypto.timingSafeEqual(Buffer.from(tag(id)), Buffer.from(m[2])) ? id : null
}

// --- the pure parts ---------------------------------------------------------------------------

/** Pure: 'HH:MM' on the 24-hour clock in `zone`. */
const clockIn = (at, zone) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  return `${parts.hour}:${parts.minute}`
}

/**
 * Pure: the tally (rows not removed) in the order the birds were found, each with `at`, the time it
 * was seen (observed_at; added_at for older rows). Ties keep the row added first.
 */
const inOrder = (tally) => tally
  .map((t) => ({ ...t, at: iso(t.observed_at ?? t.added_at) }))
  .sort((a, b) => a.at.localeCompare(b.at) || (a.id ?? 0) - (b.id ?? 0))

/**
 * Pure: each member's lifers from the tally, in the order they were found. `members` are
 * { userId, name, before } with `before` their life list as it stood when the event started (a Set),
 * or null when it's too short to judge by (lib/lifeList MIN_LIFE_LIST): no lifers are claimed for
 * them. The tally is the group's, so a bird on it counts for every member. `number` is the bird's
 * place on that member's life list.
 */
const lifersOf = (ordered, members) => {
  const lifers = []
  for (const m of members) {
    if (!m.before) continue
    let count = m.before.size
    for (const t of ordered) {
      if (m.before.has(t.species_code)) continue
      count += 1
      lifers.push({ speciesCode: t.species_code, at: t.at, stopIndex: t.stop_index ?? null, userId: m.userId, who: m.name ?? null, number: count })
    }
  }
  return lifers.sort((a, b) => a.at.localeCompare(b.at) || members.findIndex((m) => m.userId === a.userId) - members.findIndex((m) => m.userId === b.userId))
}

/**
 * Pure: the hour of the day (in `zone`) that put the most new birds on the list, { start: 'HH:00',
 * added }; the earlier on a tie; null with no birds.
 */
const bestHour = (ordered, zone) => {
  const hours = new Map()
  for (const t of ordered) {
    const hour = clockIn(t.at, zone).slice(0, 2)
    hours.set(hour, (hours.get(hour) || 0) + 1)
  }
  let best = null
  for (const [hour, added] of [...hours.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!best || added > best.added) best = { start: `${hour}:00`, added }
  }
  return best
}

/**
 * Pure: each stop of the saved route with what the tally says happened there: when the first bird
 * there was seen (arrive), how long between the first and last (stayMin; with one bird, the stay the
 * route planned, else null), and how many birds were found there. The tally keeps one row a bird,
 * where it was first found, so a stop's species are the ones it added to the day: `species` and
 * `added` are the same count.
 */
const stopStats = (stops, ordered) => (stops || []).map((s, i) => {
  const here = ordered.filter((t) => t.stop_index === i)
  const first = here[0]?.at ?? null
  const last = here[here.length - 1]?.at ?? null
  const span = here.length > 1 ? Math.round((Date.parse(last) - Date.parse(first)) / 60_000) : null
  return {
    index: i,
    name: s.name ?? null,
    lat: s.lat ?? null,
    lng: s.lng ?? null,
    arrive: first,
    stayMin: span ?? (Number.isInteger(s.stay_min) ? s.stay_min : null),
    species: here.length,
    added: here.length
  }
})

/** Pure: the stop that added the most birds, { index, name, species }; the earlier on a tie; null when none added any. */
const bestStop = (stats) => {
  let best = null
  for (const s of stats) if (s.added > 0 && (!best || s.added > best.species)) best = { index: s.index, name: s.name, species: s.added }
  return best
}

/**
 * Pure: who found what. Each member's birds are the ones they put on the tally (they found it first)
 * and the ones they ticked as on their own eBird checklist. `only`: birds no one else in the group
 * has; `together`: birds every member has.
 */
const whoFound = (ordered, members, marks = []) => {
  const sets = members.map((m) => new Set([
    ...ordered.filter((t) => t.added_by === m.userId).map((t) => t.species_code),
    ...marks.filter((k) => k.user_id === m.userId).map((k) => ordered.find((t) => t.id === k.tally_id)?.species_code).filter(Boolean)
  ]))
  const order = ordered.map((t) => t.species_code)
  const byMember = members.map((m, i) => ({
    name: m.name ?? null,
    count: sets[i].size,
    only: order.filter((code) => sets[i].has(code) && sets.every((other, j) => j === i || !other.has(code)))
  }))
  const together = members.length ? order.filter((code) => sets.every((s) => s.has(code))).length : 0
  return { byMember, together }
}

/** How many more found birds the scouting card lists under its star. */
const MAX_SCOUTED_OTHERS = 12

/**
 * Pure: what the scouting emails pointed to that the day found. `records` are event_scout_birds rows
 * ({ day, species_code: the bird of the day or null, species: [{ code, loc, locName }] or null for
 * rows from before it was kept }); only those on or before `firstDay` count, the scouting being for
 * the day itself. A bird is scouted if any of them named it, and found if it's on the tally.
 *
 * Each found, scouted bird with how many days it was named (timesScouted), the first (firstScouted),
 * where the latest of them placed it (scoutedAt, and its eBird loc to tell a personal spot), and
 * whether it was ever a bird of the day. `liferFor(code)` gives whose lifer it was (names, null for a
 * member with none); `abaOf(code)` its ABA code. Ranked: lifers first (for more of the group first),
 * then the rarer (an ABA code of 2 or up), then a bird of the day, then the more often scouted, then
 * the earlier found.
 *
 * The star is the top of them that isn't `rarestCode` (the recap's rarest bird has its own card) and
 * is a lifer, a rarity or a bird of the day; null when none is. `others` are the rest, most
 * significant first, up to MAX_SCOUTED_OTHERS, and `othersTotal` how many there were. Null with no
 * scouting records at all.
 */
const scoutingCalled = (records, ordered, { firstDay = null, abaOf = () => null, liferFor = () => [], rarestCode = null } = {}) => {
  const counted = (records || []).filter((r) => !firstDay || places.dayOf(r.day) <= firstDay)
    .sort((a, b) => places.dayOf(a.day).localeCompare(places.dayOf(b.day)))
  if (!counted.length) return null
  const scouted = new Map()
  for (const r of counted) {
    const day = places.dayOf(r.day)
    const named = new Map((Array.isArray(r.species) ? r.species : []).filter((b) => b?.code).map((b) => [b.code, b]))
    if (r.species_code && !named.has(r.species_code)) named.set(r.species_code, { code: r.species_code, loc: null, locName: null })
    for (const [code, b] of named) {
      const had = scouted.get(code) || { firstScouted: day, timesScouted: 0, scoutedAt: null, loc: null, birdOfTheDay: false }
      had.timesScouted += 1
      // The latest report that placed it says where.
      if (b.locName) Object.assign(had, { scoutedAt: b.locName, loc: b.loc || null })
      had.birdOfTheDay = had.birdOfTheDay || r.species_code === code
      scouted.set(code, had)
    }
  }
  const rarity = (aba) => (Number.isInteger(aba) && aba >= 2 ? aba : null)
  const found = ordered.filter((t) => scouted.has(t.species_code)).map((t) => {
    const who = liferFor(t.species_code) || []
    return { speciesCode: t.species_code, at: t.at, stopIndex: t.stop_index ?? null, ...scouted.get(t.species_code), aba: rarity(abaOf(t.species_code)), lifers: who.length, liferFor: who }
  }).sort((a, b) => (b.lifers - a.lifers) || ((b.aba || 0) - (a.aba || 0)) || (b.birdOfTheDay - a.birdOfTheDay) ||
    (b.timesScouted - a.timesScouted) || a.at.localeCompare(b.at))
  const top = found.find((f) => f.speciesCode !== rarestCode)
  const star = top && (top.lifers || top.aba || top.birdOfTheDay) ? top : null
  const why = star ? (star.lifers ? 'lifer' : star.aba ? 'rarity' : 'bird_of_the_day') : null
  const rest = found.filter((f) => f !== star)
  return { reports: counted.length, star: star ? { ...star, why } : null, others: rest.slice(0, MAX_SCOUTED_OTHERS), othersTotal: rest.length }
}

/** Pure: the rarest bird on the tally by its ABA code (3 to 5), the earlier on a tie; null with none coded. */
const rarest = (ordered, abaOf) => {
  const { isShown } = require('./abaCodes')
  let best = null
  for (const t of ordered) {
    const aba = abaOf(t.species_code)
    if (isShown(aba) && (!best || aba > best.aba)) best = { speciesCode: t.species_code, aba, at: t.at, stopIndex: t.stop_index ?? null }
  }
  return best
}

// --- gathering --------------------------------------------------------------------------------

/** The saved route's stops that are public eBird hotspots, by locId: what eBird lists as one, here or on a checklist. */
const publicHotspots = async (stops) => {
  const ids = [...new Set((stops || []).map((s) => s.locId).filter(Boolean))]
  if (!ids.length) return new Set()
  const [listed, onLists] = await Promise.all([
    db('hotspot_ref').whereIn('loc_id', ids).pluck('loc_id').catch(() => []),
    db('checklists').whereIn('loc_id', ids).where('is_hotspot', true).distinct('loc_id').pluck('loc_id').catch(() => [])
  ])
  return new Set([...listed, ...onLists])
}

/**
 * Each member's life list as it stood when the event started: the list their lifers count against
 * (lib/lifeList lifeListFor) less every bird it gained on or after the first day (an app tap or an
 * eBird import dated then). Null when it's too short to judge by, before or after.
 */
const listBefore = async (user, event) => {
  const { lifeListFor, MIN_LIFE_LIST } = require('./lifeList')
  const list = await lifeListFor(user).catch(() => null)
  if (!list) return null
  const startsOn = places.dayOf(event.starts_on)
  const startedAt = wallTime(startsOn, 0, eventZone(event))
  const since = await db('seen_birds').where({ user_id: user.id })
    .where((q) => q.where('first_seen', '>=', startsOn).orWhere((n) => n.whereNull('first_seen').where('created_at', '>=', startedAt)))
    .pluck('species_code')
  const before = new Set(list)
  for (const code of since) before.delete(code)
  return before.size < MIN_LIFE_LIST ? null : before
}

/**
 * What to tick in the "fill in the recap" check-off, while it's open: the targets, then what's been
 * reported in the area in the last two weeks (the event page's hour-kept feed, lib/events
 * scoutFeed), newest first, less what's on the tally already. Targets reported lately come before
 * the rest of them. No feed, just the targets.
 */
const candidatesFor = async (event, onTally, targets, { fetchFeed = null } = {}) => {
  const { notOneSpecies } = require('./scouting')
  const records = await require('./events').scoutFeed(event, { fetchFeed }).then((f) => f.records || []).catch(() => [])
  const latest = new Map()
  for (const r of records) {
    if (!r?.speciesCode || notOneSpecies(r.comName) || r.exoticCategory === 'X') continue
    const held = latest.get(r.speciesCode)
    if (!held || String(r.obsDt).localeCompare(String(held.obsDt)) > 0) latest.set(r.speciesCode, r)
  }
  const when = (code) => String(latest.get(code)?.obsDt || '')
  const wanted = targets.filter((code) => !onTally.has(code)).sort((a, b) => (latest.has(b) - latest.has(a)) || when(b).localeCompare(when(a)))
  const rest = [...latest.keys()].filter((code) => !onTally.has(code) && !targets.includes(code)).sort((a, b) => when(b).localeCompare(when(a)))
  return { codes: [...wanted, ...rest].slice(0, MAX_CANDIDATES), names: new Map([...latest.values()].map((r) => [r.speciesCode, r.comName])) }
}

/**
 * The recap's facts from the tables, birds named in English: the members' view less what's worked
 * out when it's read (the event, status, the share code). Kept as is when sealed. Underscored
 * fields are for the public view (which stops are personal) and the email (whose lifer), and never
 * leave the server. `candidates` only while open. `drive` and `fetchFeed` stand in for OSRM and
 * eBird in tests.
 */
const gather = async (event, { withCandidates = false, drive = null, fetchFeed = null } = {}) => {
  const zone = eventZone(event)
  const [memberRows, tally, marks, targets, route, scoutRows] = await Promise.all([
    db('event_members').join('users', 'users.id', 'event_members.user_id').where('event_members.event_id', event.id)
      .orderBy('event_members.joined_at').orderBy('event_members.user_id').select('users.*', 'event_members.display_name', 'event_members.role'),
    db('event_tally').where({ event_id: event.id }).whereNull('removed_at'),
    db('event_tally_marks').where({ event_id: event.id }).select('user_id', 'tally_id'),
    db('event_targets').where({ event_id: event.id }).orderBy('species_code').pluck('species_code'),
    db('event_routes').where({ event_id: event.id }).first('start', 'stops'),
    db('event_scout_birds').where({ event_id: event.id }).select('day', 'species_code', 'species')
  ])
  const ordered = inOrder(tally)
  const organizer = memberRows.find((m) => m.role === 'organizer') || memberRows[0]
  const members = await Promise.all(memberRows.map(async (m) => ({ userId: m.id, name: m.display_name ?? null, organizer: m === organizer, before: await listBefore(m, event) })))
  const onTally = new Set(ordered.map((t) => t.species_code))
  const candidates = withCandidates ? await candidatesFor(event, onTally, targets, { fetchFeed }) : { codes: [], names: new Map() }

  const codes = [...new Set([...onTally, ...targets, ...candidates.codes])]
  const birds = codes.length ? await require('./enrich').findOrCreateBirds(codes).catch(() => []) : []
  const bird = new Map(birds.map((b) => [b.speciesCode, b]))
  const nameOf = (code) => bird.get(code)?.comName || candidates.names.get(code) || code
  const named = (code) => ({ speciesCode: code, comName: nameOf(code) })
  const coded = await require('./abaCodes').withAba(ordered.map((t) => ({ speciesCode: t.species_code, comName: nameOf(t.species_code), sciName: bird.get(t.species_code)?.sciName })), { region: event.location })
    .catch(() => [])
  const aba = new Map(coded.map((b) => [b.speciesCode, b.aba ?? null]))

  // The stops and where each bird was found, by the route as it's saved now.
  const stops = Array.isArray(route?.stops) ? route.stops : []
  const hotspots = await publicHotspots(stops)
  const stats = stopStats(stops, ordered).map((s, i) => ({ ...s, _private: !(stops[i].locId && hotspots.has(stops[i].locId)) }))
  const placeOf = (stopIndex) => (Number.isInteger(stopIndex) ? stops[stopIndex]?.name ?? null : null)

  // The drive: miles over the whole route (from the start, as the app times it), and the line through the stops alone.
  let miles = null
  let line = null
  if (stops.length) {
    const { routeDetails } = require('./eventRoutePlan')
    const details = await routeDetails({ start: route.start || null, stops }, {}, { drive }).catch(() => null)
    if (details?.routed && details.legs?.some(Boolean)) miles = Math.round(details.legs.reduce((sum, l) => sum + (l?.mi || 0), 0))
    const road = stops.length > 1 ? await (drive || require('./routing').drive)(stops).catch(() => null) : null
    line = Array.isArray(road?.geometry) && road.geometry.length > 1 ? road.geometry : (stops.length > 1 ? stops.map((s) => [s.lat, s.lng]) : null)
  }
  const publicStops = stats.filter((s) => !s._private)

  const lifers = lifersOf(ordered, members)
  const liferFor = new Map()
  for (const l of lifers) liferFor.set(l.speciesCode, [...(liferFor.get(l.speciesCode) || []), l.who])
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const best = bestStop(stats)
  const rare = rarest(ordered, (code) => aba.get(code))
  const called = scoutingCalled(scoutRows, ordered, {
    firstDay: places.dayOf(event.starts_on), abaOf: (code) => aba.get(code) ?? null, liferFor: (code) => liferFor.get(code) || [], rarestCode: rare?.speciesCode ?? null
  })
  // Where the scouting placed a bird is personal unless it's a public eBird hotspot, as a stop is.
  const scoutedHotspots = called ? await publicHotspots([called.star, ...called.others].filter(Boolean).map((f) => ({ locId: f.loc }))) : new Set()
  const scoutedPrivate = (f) => !(f.loc && scoutedHotspots.has(f.loc))
  const { byMember, together } = whoFound(ordered, members, marks)
  return {
    members: members.map((m) => ({ id: m.userId, name: m.name, organizer: m.organizer })),
    totals: {
      species: ordered.length,
      stops: stops.length,
      miles,
      fieldMinutes: first ? Math.round((Date.parse(last.at) - Date.parse(first.at)) / 60_000) : null,
      firstBird: first ? { ...named(first.species_code), at: first.at } : null,
      lastBird: last ? { ...named(last.species_code), at: last.at } : null,
      bestStop: best ? { ...best, _private: stats[best.index]._private } : null,
      bestHour: bestHour(ordered, zone)
    },
    timeline: ordered.map((t, i) => ({
      n: i + 1,
      ...named(t.species_code),
      at: t.at,
      stopIndex: t.stop_index ?? null,
      place: placeOf(t.stop_index),
      lifer: liferFor.has(t.species_code),
      liferFor: (liferFor.get(t.species_code) || []).filter(Boolean)
    })),
    lifers: lifers.map((l) => ({ ...named(l.speciesCode), at: l.at, place: placeOf(l.stopIndex), who: l.who, number: l.number, _stopIndex: l.stopIndex, _userId: l.userId })),
    highlights: {
      rarest: rare ? { ...named(rare.speciesCode), aba: rare.aba, at: rare.at, place: placeOf(rare.stopIndex), _stopIndex: rare.stopIndex } : null,
      scoutingCalled: called ? {
        reports: called.reports,
        star: called.star ? {
          ...named(called.star.speciesCode),
          at: called.star.at,
          place: placeOf(called.star.stopIndex),
          why: called.star.why,
          aba: called.star.aba,
          liferFor: called.star.lifers ? called.star.liferFor.filter(Boolean) : null,
          firstScouted: called.star.firstScouted,
          timesScouted: called.star.timesScouted,
          scoutedAt: called.star.scoutedAt,
          birdOfTheDay: called.star.birdOfTheDay,
          _stopIndex: called.star.stopIndex,
          _scoutedPrivate: scoutedPrivate(called.star)
        } : null,
        others: called.others.map((f) => ({
          ...named(f.speciesCode), at: f.at, place: placeOf(f.stopIndex), firstScouted: f.firstScouted, timesScouted: f.timesScouted, lifer: f.lifers > 0, aba: f.aba, _stopIndex: f.stopIndex
        })),
        othersTotal: called.othersTotal
      } : null
    },
    targets: { total: targets.length, found: targets.filter((c) => onTally.has(c)).length, missed: targets.filter((c) => !onTally.has(c)).map(named) },
    stops: stats,
    route: {
      miles,
      line,
      // Personal spots stay off the public map: the line through the hotspots alone, straight.
      _publicLine: publicStops.length === stats.length ? line : (publicStops.length > 1 ? publicStops.map((s) => [s.lat, s.lng]) : null)
    },
    byMember: byMember.map((m) => ({ ...m, only: m.only.map(named) })),
    together,
    candidates: candidates.codes.map(named)
  }
}

// --- reading ----------------------------------------------------------------------------------

const KINDS = { bigday: 'big_day' }

/** The event's own block: what it was, where and when. The spot is the event's own for members, the area's centre for anyone. */
const eventBlock = async (event, audience, locale) => {
  const area = places.areaLabel(locale, event.state, await places.areaName(event))
  const own = audience === 'members' && Number.isFinite(event.home_lat) && Number.isFinite(event.home_lng) ? { lat: event.home_lat, lng: event.home_lng } : null
  const centre = own || await require('./range').regionCenter(event.location).catch(() => null)
  const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)
  return {
    id: event.id,
    name: event.name,
    kind: KINDS[event.kind] || event.kind,
    area: /^[A-Z]{2}$/.test(event.state || '') && area ? `${area}, ${event.state}` : area,
    startsOn: places.dayOf(event.starts_on),
    endsOn: places.dayOf(event.ends_on),
    timezone: eventZone(event),
    lat: own ? own.lat : round2(centre?.lat),
    lng: own ? own.lng : round2(centre?.lng)
  }
}

/** Underscored fields off, at any depth. */
const strip = (value) => {
  if (Array.isArray(value)) return value.map(strip)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('_')).map(([key, item]) => [key, strip(item)]))
}

/**
 * The scouting highlight as kept, or null. A recap sealed before the scouting card had its star and
 * others kept the bird of the day alone, which the page can't show, so it shows none.
 */
const scoutingOf = (facts) => {
  const called = facts.highlights?.scoutingCalled
  return called && Array.isArray(called.others) ? called : null
}

/**
 * Pure: the scouting highlight for anyone: whose lifer goes, and so does any place that's a personal
 * spot, where the bird was found (a stop that's `hidden`) or where the scouting placed it.
 */
const redactScouting = (called, hidden) => {
  if (!called) return null
  const star = called.star
  return {
    ...called,
    star: star ? { ...star, place: hidden(star._stopIndex) ? null : star.place, liferFor: null, scoutedAt: star._scoutedPrivate === false ? star.scoutedAt : null } : null,
    others: called.others.map((o) => ({ ...o, place: hidden(o._stopIndex) ? null : o.place }))
  }
}

/**
 * Pure: the public view of the facts: no names (members, who found what, whose lifer), no share
 * code or check-off, and nothing at a personal spot: those stops are left out, the line goes
 * through the hotspots alone, and birds found there keep their time but lose the place.
 */
const redact = (facts) => {
  const personal = new Set(facts.stops.filter((s) => s._private).map((s) => s.index))
  const hidden = (i) => Number.isInteger(i) && personal.has(i)
  const at = (item) => (item ? { ...item, place: hidden(item._stopIndex) ? null : item.place } : null)
  const best = facts.totals.bestStop
  return {
    totals: { ...facts.totals, bestStop: best ? { ...best, name: best._private ? null : best.name } : null },
    timeline: facts.timeline.map((t) => ({ ...t, stopIndex: hidden(t.stopIndex) ? null : t.stopIndex, place: hidden(t.stopIndex) ? null : t.place, liferFor: null })),
    lifers: facts.lifers.map((l) => ({ ...at(l), who: null })),
    highlights: { rarest: at(facts.highlights?.rarest), scoutingCalled: redactScouting(scoutingOf(facts), hidden) },
    targets: facts.targets,
    stops: facts.stops.filter((s) => !s._private),
    route: { miles: facts.route.miles, line: facts.route._publicLine }
  }
}

/** Bird names in `locale` (lib/birdNames), English kept where there's no translation. */
const nameIn = async (locale) => {
  const names = await require('./birdNames').namesFor(locale).catch(() => null)
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    if (names && typeof value.speciesCode === 'string' && typeof value.comName === 'string') out.comName = names.get(value.speciesCode) || value.comName
    return out
  }
  return walk
}

/** The facts as sent: the view for the audience, named in `locale`, missed and only as plain names. */
const present = async (event, facts, { audience, status, fixesUntil, locale }) => {
  const view = audience === 'public' ? redact(facts) : facts
  const named = (await nameIn(locale))(view)
  const out = {
    audience,
    status,
    fixesUntil: fixesUntil.toISOString(),
    ...(audience === 'members' ? { shareCode: recapCode(event.id) } : {}),
    event: await eventBlock(event, audience, locale),
    ...(audience === 'members' ? { members: named.members } : {}),
    totals: named.totals,
    timeline: named.timeline,
    lifers: named.lifers,
    highlights: { rarest: named.highlights?.rarest ?? null, scoutingCalled: scoutingOf(named) },
    targets: { ...named.targets, missed: named.targets.missed.map((b) => b.comName) },
    stops: named.stops,
    route: named.route
  }
  if (audience === 'members') {
    Object.assign(out, {
      byMember: named.byMember.map((m) => ({ ...m, only: m.only.map((b) => b.comName) })),
      together: named.together,
      candidates: status === 'open' ? named.candidates : []
    })
  }
  return strip(out)
}

/**
 * The sealed recap: the frozen copy, made now if it isn't yet (whoever gets there first writes it;
 * a second writer's copy is dropped and the first one read back).
 */
const sealed = async (event, opts = {}) => {
  const held = await db('event_recaps').where({ event_id: event.id }).first('data')
  if (held) return held.data
  const facts = await gather(event, { ...opts, withCandidates: false })
  await db('event_recaps').insert({ event_id: event.id, data: JSON.stringify({ ...facts, candidates: [] }) }).onConflict('event_id').ignore()
  return (await db('event_recaps').where({ event_id: event.id }).first('data')).data
}

/** The facts for an event at `now`, with its clock: live ones while open, the frozen copy once sealed. 409 { error: 'not_ended' } before. */
const factsAt = async (event, { now = new Date(), withCandidates = false, drive = null, fetchFeed = null } = {}) => {
  const clock = recapClock(event, now)
  if (clock.status === 'live') throw new HttpError(409, 'not_ended')
  const facts = clock.status === 'sealed' ? await sealed(event, { drive, fetchFeed }) : await gather(event, { withCandidates, drive, fetchFeed })
  return { clock, facts }
}

/** GET kind=event-recap&event=: the members' view, members only (404 otherwise). */
const memberRecap = async (user, id, { now = new Date(), locale = user.locale, drive = null, fetchFeed = null } = {}) => {
  const event = await require('./events').memberOf(user, id)
  const { clock, facts } = await factsAt(event, { now, withCandidates: true, drive, fetchFeed })
  return present(event, facts, { audience: 'members', status: clock.status, fixesUntil: clock.fixesUntil, locale })
}

/** GET kind=event-recap&share=: the public view, for anyone with the code (404 for a bad one, or an event gone). */
const publicRecap = async (code, { now = new Date(), locale = 'en', drive = null } = {}) => {
  const id = readRecapCode(code)
  const event = id ? await db('events').where({ id }).first() : null
  if (!event) throw new HttpError(404, 'This link is invalid or has expired')
  const { clock, facts } = await factsAt(event, { now, drive })
  return present(event, facts, { audience: 'public', status: clock.status, fixesUntil: clock.fixesUntil, locale })
}

/**
 * The tally's fix window: adds, removals and undos are taken until the recap is sealed, then
 * refused, so the frozen recap and the tally agree.
 */
const assertFixable = (event, now = new Date()) => {
  if (recapClock(event, now).status === 'sealed') throw new HttpError(409, 'The recap is final, so the tally can’t change now')
}

/**
 * The morning run's part: freezes every recap whose fix window has closed since (events that ended
 * within the last week), so no one has to open it first. Returns how many it sealed.
 */
const sealDue = async ({ now = new Date(), deadline = Infinity } = {}) => {
  const rows = await db('events').leftJoin('event_recaps', 'event_recaps.event_id', 'events.id').whereNull('event_recaps.event_id')
    .whereBetween('events.ends_on', [places.utcPlus(now, -7), places.utcPlus(now, 0)]).select('events.*')
  let count = 0
  for (const event of rows) {
    if (Date.now() > deadline) break
    if (recapClock(event, now).status !== 'sealed') continue
    try {
      await sealed(event)
      count += 1
    } catch (error) {
      await require('./errors').reportError(`recap seal for event ${event.id}`, error)
    }
  }
  return count
}

module.exports = {
  FIX_HOURS, MAX_CANDIDATES, recapClock, recapCode, readRecapCode, clockIn, inOrder, lifersOf, bestHour, stopStats, bestStop, whoFound,
  MAX_SCOUTED_OTHERS, scoutingCalled, redactScouting, rarest, redact, strip, nameIn, gather, present, factsAt, memberRecap, publicRecap, assertFixable, sealDue, listBefore
}
