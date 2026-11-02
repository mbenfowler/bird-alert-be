const { localize } = require('../lib/birdNames')
const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser } = require('../lib/auth')
const { assertSpecies } = require('../lib/ebird')
const { findOrCreateBirds } = require('../lib/enrich')
const { getRoute, putRoute } = require('../lib/savedRoutes')
const { importLifeList, seenList, markSeen, unmarkSeen } = require('../lib/lifeList')
const { splitEvidence } = require('../lib/splitEvidence')
const { createShare } = require('../lib/shares')
const { sendFeedback } = require('../lib/feedback')
const places = require('../lib/places')
const events = require('../lib/events')
const { eventRoute } = require('../lib/eventRoute')
const { requestLocale } = require('../lib/i18n')
const { syncNewRegionSoon } = require('../lib/checklists')

const savedBirdsFor = (userId) =>
  db('saved_birds')
    .join('birds', 'birds.id', 'saved_birds.bird_id')
    .where('saved_birds.user_id', userId)
    .select('birds.*')
    .orderBy('birds.taxonOrder')

// GET    /api/saved                      -> bird[]
// POST   /api/saved { speciesCode }      -> bird (idempotent; unknown codes are resolved and stored)
// DELETE /api/saved?speciesCode=         -> 204 (idempotent)
// GET    /api/saved?kind=route&region=   -> { region, stops: point[] | null, start: point | null, updatedAt }
// PUT    /api/saved?kind=route { region, stops?, start? } -> the same; stops null goes back to the suggested route
//   (a point is { locId, name, lat, lng, note }; the route rides on this function so it costs no function slot)
// GET    /api/saved?kind=seen                    -> [{ speciesCode, firstSeen, source }] the life list
// POST   /api/saved?kind=seen { speciesCode }    -> 201 (idempotent) "Seen it"
// DELETE /api/saved?kind=seen&speciesCode=       -> 204
// POST   /api/saved?kind=seen&import=1 { csv }   -> { added, already, skipped: [{ name, reason, choices?, where? }], total } from eBird's life list export
// POST   /api/saved?kind=seen&evidence=1 { choices: [{ speciesCode, comName }], locId?, region?, day }
//   -> { area, sampled, lean, strength: clear|mixed|thin, ranked: [{ speciesCode, comName, days }] } which of a slash it likely was, from local reports
// Places besides home and their target birds (lib/places). Dated outings are events, below.
// GET    /api/saved?kind=places                  -> [{ id, name, state, location, range_mi, home_lat, home_lng, lifers_scope, seenCount, targets: [code], trips: [] }] (trips always empty)
// POST   /api/saved?kind=place { name, state, location, range_mi?, lifers_scope? } -> 201 the place
// PATCH  /api/saved?kind=place&id= { name?, state?, location?, range_mi?, home_lat?, home_lng?, lifers_scope? } -> the place
// DELETE /api/saved?kind=place&id=               -> 204 (its targets and seen list go with it; events planned from it stay)
// PUT    /api/saved?kind=place-targets&id= { codes: [] } -> the place
// GET    /api/saved?kind=place-seen&id=          -> [code] the place's own seen list ("Seen it" while there adds to it)
// PUT    /api/saved?kind=place-seen&id= { codes: [] } -> [code] (manual edits, up to 2000)
// GET    /api/saved?kind=place-suggestions&id=&from=&to=&scope=life|place&limit=1..50 (default 15) -> { from, to, sampled, scope, suggestions: [{ speciesCode, comName, days, sampled }] }
// kind=trip and kind=event-from-trip -> 410: trips are events now.
// Events (lib/events): dated outings, solo or with a small group. Anyone in one can change it.
// POST   /api/saved?kind=event { name?, state?, location?, range_mi?, home_lat?, home_lng?, starts_on, ends_on, kind?: trip|bigday, scout?, scout_days?: 7|14|21|28, place_id? }
//                                                 -> 201 the event, solo, you the organizer (from a place: its area, range, spot and targets, unless given)
// GET    /api/saved?kind=events                   -> [{ id, name, state, location, range_mi, home_lat, home_lng, place_id, starts_on, ends_on, kind, scout, scout_days, scout_from,
//                                                     active, past, archived, role, display_name, members: [{ display_name|null, role, you }],
//                                                     targets: [{ code, lifer_for: [name], lifer_for_you }], tally: [{ code, added_by_name, added_by_you, added_at }],
//                                                     recap: { species, targets_got, targets_total }, invite_url|null, view_url|null }] (links once you've a display_name)
// POST   /api/saved?kind=event-invite-start&id= { display_name } -> the event, with its links
// PATCH  /api/saved?kind=event-member&id= { archived?, display_name? } -> the event
// GET    /api/saved?kind=event-suggestions&id=&scope=life|place&limit=1..50 -> { from, to, sampled, scope, suggestions: [{ speciesCode, comName, days, sampled }] }
// GET    /api/saved?kind=event-scouting&id=&locale= -> { checked_at, days_to_go|null, window: { from, to }, using: 'targets'|'likely_lifers',
//                                                     reported: [{ code, comName, locName, locId, lat, lng, obsDt, birders, confirmed|null, media, subId }],
//                                                     unreported: [{ code, comName }] } (last 7 days / none in 14; the area's feed kept an hour)
// GET    /api/saved?kind=event-route&id=&from=lat,lng&locale= -> { from|null, stops: [{ n, locId, locName, lat, lng, new_birds: [{ code, speciesCode, comName }], leg_min, leg_mi, private, merged: [{ locId, locName }] }],
//                                                     extras: [{ locId, locName, lat, lng, new_birds, add_min, add_mi, private, merged }], total_min, total_mi, covered, covered_with_extras,
//                                                     reported, skipped, geometry: [[lat, lng]], routed } (lib/eventRoute: every report of the targets this week, personal spots folded
//                                                     into hotspots, a core worth <= 15 min a bird plus extras; start: from, else the event's spot, both rounded to 2 decimals; kept an hour)
// PATCH  /api/saved?kind=event&id= { name?, starts_on?, ends_on?, state?, location?, range_mi?, kind?, scout?, scout_days? } -> the event
// DELETE /api/saved?kind=event&id=                -> 204 (organizer: deletes it for everyone; others leave)
// POST   /api/saved?kind=event-leave&id=          -> 204
// POST   /api/saved?kind=event-invite-rotate&id=  -> the event with a new invite link (organizer)
// PUT    /api/saved?kind=event-targets&id= { codes } -> the event
// POST   /api/saved?kind=event-tally&id= { species_code } -> the event; DELETE ...&code= -> the event
// POST   /api/saved?kind=event-join { token, display_name } -> the event
// GET    /api/saved?kind=event-preview&token=     -> { name, area, starts_on, ends_on, kind, members } (no sign-in)
// GET    /api/saved?kind=event-view&token=&locale= -> { name, area, starts_on, ends_on, kind, targets, tally, count } (no sign-in, no names)
module.exports = route(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], async (req, res) => {
  // The two event links anyone can open: what the event is, and (view-only) its plan and tally.
  if (req.query.kind === 'event-preview' || req.query.kind === 'event-view') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
    res.setHeader('Cache-Control', 'no-store')
    const locale = requestLocale(req) || 'en'
    if (req.query.kind === 'event-preview') return res.status(200).json(await events.previewEvent(String(req.query.token || ''), locale))
    const view = await events.viewEvent(String(req.query.token || ''), locale)
    // Bird names follow ?locale= only, as on the other public pages.
    return res.status(200).json(req.query.locale ? await localize(view, locale) : view)
  }
  const user = await requireUser(req)
  // Private and per person, so birds are named in the person's own language.
  const named = (data) => localize(data, user.locale)

  if (req.query.kind === 'route') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await getRoute(user.id, String(req.query.region || '')))
    if (req.method === 'PUT') return res.status(200).json(await putRoute(user.id, body(req)))
    throw new HttpError(405, 'Method not allowed')
  }
  // POST /api/saved?kind=feedback { kind: 'idea' | 'bug' | 'other', message, page? } -> { ok } emailed to the owner, reply-to the sender
  if (req.query.kind === 'feedback') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    return res.status(201).json(await sendFeedback(user, body(req), { userAgent: req.headers['user-agent'] }))
  }
  // POST /api/saved?kind=share { kind: 'route' | 'sighting', ... } -> { id, url } a read-only link anyone can open
  if (req.query.kind === 'share') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    return res.status(201).json(await createShare(user.id, body(req)))
  }
  // Places and their targets. A place becoming active soon has its area's checklists fetched now.
  const ready = (location) => syncNewRegionSoon(location)
  if (req.query.kind === 'places') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await places.listPlaces(user))
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.query.kind === 'place') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'POST') return res.status(201).json(await places.createPlace(user, body(req)))
    if (req.method === 'PATCH') {
      const place = await places.updatePlace(user, req.query.id, body(req))
      if (user.active_place_id === place.id) ready(place.location)
      return res.status(200).json(place)
    }
    if (req.method === 'DELETE') { await places.deletePlace(user, req.query.id); return res.status(204).end() }
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.query.kind === 'place-targets') {
    if (req.method !== 'PUT') throw new HttpError(405, 'Method not allowed')
    return res.status(200).json(await places.setTargets(user, req.query.id, body(req).codes))
  }
  if (req.query.kind === 'place-suggestions') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
    res.setHeader('Cache-Control', 'no-store')
    const found = await places.suggestTargets(user, req.query.id, { from: req.query.from, to: req.query.to, scope: req.query.scope === 'place' ? 'place' : 'life', limit: req.query.limit })
    return res.status(200).json({ ...found, suggestions: await named(found.suggestions) })
  }
  if (req.query.kind === 'place-seen') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await places.placeSeen(user, req.query.id))
    if (req.method === 'PUT') return res.status(200).json(await places.setPlaceSeen(user, req.query.id, body(req).codes))
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.query.kind === 'trip' || req.query.kind === 'event-from-trip') throw new HttpError(410, 'Trips are events now')
  if (String(req.query.kind || '').startsWith('event')) {
    res.setHeader('Cache-Control', 'no-store')
    const kind = req.query.kind
    const id = req.query.id
    if (kind === 'events' && req.method === 'GET') return res.status(200).json(await events.listEvents(user))
    if (kind === 'event-invite-start' && req.method === 'POST') return res.status(200).json(await events.startInvite(user, id, body(req)))
    if (kind === 'event-member' && req.method === 'PATCH') return res.status(200).json(await events.updateMembership(user, id, body(req)))
    if (kind === 'event-suggestions' && req.method === 'GET') {
      const found = await events.suggestForEvent(user, id, { scope: req.query.scope === 'place' ? 'place' : 'life', limit: req.query.limit })
      return res.status(200).json({ ...found, suggestions: await named(found.suggestions) })
    }
    if (kind === 'event-scouting' && req.method === 'GET') {
      return res.status(200).json(await localize(await events.eventScouting(user, id), req.query.locale || user.locale))
    }
    if (kind === 'event-route' && req.method === 'GET') {
      return res.status(200).json(await localize(await eventRoute(user, id, { from: req.query.from }), req.query.locale || user.locale))
    }
    if (kind === 'event-join' && req.method === 'POST') {
      const event = await events.joinEvent(user, body(req))
      if (places.startsSoon(event, user.timezone)) ready(event.location)
      return res.status(200).json(event)
    }
    if (kind === 'event') {
      if (req.method === 'POST') {
        const event = await events.createEvent(user, body(req))
        if (places.startsSoon(event, user.timezone)) ready(event.location)
        return res.status(201).json(event)
      }
      if (req.method === 'PATCH') {
        const event = await events.updateEvent(user, id, body(req))
        if (places.startsSoon(event, user.timezone)) ready(event.location)
        return res.status(200).json(event)
      }
      if (req.method === 'DELETE') { await events.endEvent(user, id); return res.status(204).end() }
    }
    if (kind === 'event-leave' && req.method === 'POST') { await events.leaveEvent(user, id); return res.status(204).end() }
    if (kind === 'event-invite-rotate' && req.method === 'POST') return res.status(200).json(await events.rotateInvite(user, id))
    if (kind === 'event-targets' && req.method === 'PUT') return res.status(200).json(await events.setEventTargets(user, id, body(req).codes))
    if (kind === 'event-tally') {
      if (req.method === 'POST') return res.status(200).json(await events.addTally(user, id, body(req).species_code))
      if (req.method === 'DELETE') return res.status(200).json(await events.removeTally(user, id, req.query.code))
    }
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.method === 'PATCH') throw new HttpError(405, 'Method not allowed')
  if (req.query.kind === 'seen') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await seenList(user.id))
    if (req.method === 'POST' && req.query.evidence === '1') return res.status(200).json(await named(await splitEvidence(body(req))))
    if (req.method === 'POST' && req.query.import === '1') return res.status(200).json(await importLifeList(user.id, body(req).csv))
    const code = assertSpecies(String(req.method === 'POST' ? body(req).speciesCode || '' : req.query.speciesCode || ''))
    if (req.method === 'POST') {
      await markSeen(user.id, code)
      // Away at one of their places: on that place's own list too.
      const placeId = await places.markSeenAtPlace(user, code)
      return res.status(201).json({ speciesCode: code, ...(placeId ? { placeId } : {}) })
    }
    if (req.method === 'DELETE') { await unmarkSeen(user.id, code); return res.status(204).end() }
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.method === 'PUT') throw new HttpError(405, 'Method not allowed')

  if (req.method === 'GET') {
    return res.status(200).json(await named(await savedBirdsFor(user.id)))
  }

  if (req.method === 'POST') {
    const { speciesCode } = body(req)
    if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
    const [bird] = await findOrCreateBirds([assertSpecies(String(speciesCode))])
    if (!bird) throw new HttpError(404, `Unknown species code ${speciesCode}`)
    await db('saved_birds')
      .insert({ user_id: user.id, bird_id: bird.id, speciesCode: bird.speciesCode })
      .onConflict(['user_id', 'bird_id'])
      .ignore()
    return res.status(201).json(await named(bird))
  }

  const { speciesCode } = req.query
  if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
  await db('saved_birds').where({ user_id: user.id, speciesCode }).del()
  return res.status(204).end()
})
