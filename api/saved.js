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
// Places besides home, their target birds and trips (lib/places):
// GET    /api/saved?kind=places                  -> [{ id, name, state, location, range_mi, home_lat, home_lng, lifers_scope, seenCount, targets: [code], trips: [{ id, place_id, starts_on, ends_on, active }] }]
// POST   /api/saved?kind=place { name, state, location, range_mi?, lifers_scope? } -> 201 the place
// PATCH  /api/saved?kind=place&id= { name?, state?, location?, range_mi?, home_lat?, home_lng?, lifers_scope? } -> the place
// DELETE /api/saved?kind=place&id=               -> 204 (its targets, seen list and trips go with it)
// PUT    /api/saved?kind=place-targets&id= { codes: [] } -> the place
// GET    /api/saved?kind=place-seen&id=          -> [code] the place's own seen list ("Seen it" while there adds to it)
// PUT    /api/saved?kind=place-seen&id= { codes: [] } -> [code] (manual edits, up to 2000)
// GET    /api/saved?kind=place-suggestions&id=&from=&to=&scope=life|place&limit=1..50 (default 15) -> { from, to, sampled, scope, suggestions: [{ speciesCode, comName, days, sampled }] }
// POST   /api/saved?kind=trip { place_id, starts_on, ends_on, kind?: trip|bigday, scout?, scout_days?: 7|14|21|28 } -> 201 the trip (a Big Day scouts by default)
// PATCH  /api/saved?kind=trip&id= { place_id?, starts_on?, ends_on?, kind?, scout?, scout_days? } -> the trip
// DELETE /api/saved?kind=trip&id=                -> 204
// Group events (lib/events): a trip shared with a small group. Anyone in it can change it.
// POST   /api/saved?kind=event-from-trip { trip_id, display_name } -> 201 the event (the trip becomes it)
// GET    /api/saved?kind=events                   -> [{ id, name, state, location, range_mi, starts_on, ends_on, kind, scout, scout_days, scout_from, active, role,
//                                                     members: [{ display_name, role, you }], targets: [{ code, lifer_for: [name] }], tally: [{ code, added_by_name, added_at }], invite_url, view_url }]
// PATCH  /api/saved?kind=event&id= { name?, starts_on?, ends_on?, state?, location?, range_mi?, kind?, scout?, scout_days? } -> the event
// DELETE /api/saved?kind=event&id=                -> 204 (organizer: ends it for everyone)
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
  // Places, their targets and trips. A place becoming active soon has its area's checklists fetched now.
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
  if (req.query.kind === 'trip') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'POST' || req.method === 'PATCH') {
      const { trip, place } = req.method === 'POST' ? await places.createTrip(user, body(req)) : await places.updateTrip(user, req.query.id, body(req))
      if (places.startsSoon(trip, user.timezone)) ready(place.location)
      return res.status(req.method === 'POST' ? 201 : 200).json(trip)
    }
    if (req.method === 'DELETE') { await places.deleteTrip(user, req.query.id); return res.status(204).end() }
    throw new HttpError(405, 'Method not allowed')
  }
  if (String(req.query.kind || '').startsWith('event')) {
    res.setHeader('Cache-Control', 'no-store')
    const kind = req.query.kind
    const id = req.query.id
    if (kind === 'events' && req.method === 'GET') return res.status(200).json(await events.listEvents(user))
    if (kind === 'event-from-trip' && req.method === 'POST') return res.status(201).json(await events.createFromTrip(user, body(req)))
    if (kind === 'event-join' && req.method === 'POST') {
      const event = await events.joinEvent(user, body(req))
      if (places.startsSoon(event, user.timezone)) ready(event.location)
      return res.status(200).json(event)
    }
    if (kind === 'event') {
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
