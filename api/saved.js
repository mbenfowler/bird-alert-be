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
const routePlan = require('../lib/eventRoutePlan')
const { emailScoutingNow } = require('../lib/scoutEmail')
const { requestLocale, translateError } = require('../lib/i18n')
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
//                                                     timezone, active, past, tally_open, archived, role, display_name, members: [{ display_name|null, role, you }],
//                                                     targets: [{ code, lifer_for: [name], lifer_for_you }],
//                                                     tally: [{ id, code, client_id|null, added_by_name|null, added_by_you, added_at, observed_at, lat|null, lng|null, stop_index|null, stop_name|null, marked_by_me }],
//                                                     recap: { species, targets_got, targets_total }, invite_url|null, view_url|null }] (links once you've a display_name)
//                                                     The event's day is judged in its own zone (timezone: an IANA name, stored on the event from its area, lib/timezones;
//                                                     the caller's own zone, else UTC, where the area can't say), the same for every member whatever their account's zone:
//                                                     active: today there is one of its days; past: its last day is over there; tally_open: active, or before 3 AM there the
//                                                     morning after the last day (late entries). Adds are taken at any time all the same (an offline add can sync late).
//                                                     tally: birds not removed, in observed_at order. added_by_name: the first finder's display_name in the event (never an email;
//                                                     null when they haven't chosen one or left); added_at: when it reached the server; observed_at: when it was seen (the app's
//                                                     clock; added_at for older rows); lat/lng: 3 decimals; stop_index: 0-based in the group's saved route (event-route-plan stops),
//                                                     the nearest stop within 2 km of lat/lng when added, else null; stop_name: that stop's name in the route as saved now;
//                                                     marked_by_me: you ticked it as on your own eBird checklist (event-tally-mark)
// POST   /api/saved?kind=event-invite-start&id= { display_name } -> the event, with its links
// PATCH  /api/saved?kind=event-member&id= { archived?, display_name? } -> the event
// GET    /api/saved?kind=event-suggestions&id=&scope=life|place&limit=1..50 -> { from, to, sampled, scope, suggestions: [{ speciesCode, comName, days, sampled }] }
// GET    /api/saved?kind=event-scouting&id=&locale= -> { checked_at, days_to_go|null, window: { from, to }, using: 'targets'|'likely_lifers',
//                                                     reported: [{ code, comName, locName, locId, lat, lng, obsDt, birders, confirmed|null, media, subId }],
//                                                     unreported: [{ code, comName }],
//                                                     fresh: [{ code, speciesCode, comName, locName, locId, obsDt, aba|null, flagged }] targets whose newest report is in the 24 h
//                                                       before now on your clock, rarest first (ABA code 3-5, then flagged by eBird), then newest,
//                                                     bird_of_day: { code, speciesCode, comName, locName, obsDt, aba|null, evidence|null, photo|null }|null the rarest reported this week
//                                                       (ABA code, then flagged, then newest); evidence: the reviewer line, only for a flagged report; photo: our picture of the bird,
//                                                     headline: string|null the scouting email's subject line as it'd read today, in `locale` ("Big Day: Rufous-backed Robin new today ·
//                                                       6 days to go", "…: 42 of 50 targets around · …"),
//                                                     targets: [{ code, speciesCode, comName, status: 'around'|'missing'|'quiet', last_obs_dt|null, last_loc_name|null, aba|null, lifer }]
//                                                       one per target (or likely lifer when using is 'likely_lifers'): around = reported in the last 7 days, missing = nothing in
//                                                       14, quiet = in between; around, then quiet (each newest first), then missing. aba: US/CA only. lifer: not on your life list
//                                                       (lib/lifeList lifeListFor, as lifer alerts: all false while it has under 10 birds) }
//                                                     (last 7 days / none in 14; the area's feed kept an hour). fresh, bird_of_day and headline come from the same code as the morning
//                                                     push and email (lib/scoutMail scoutSummary); a past event, or one with nothing to scout: [], null, null, [].
// GET    /api/saved?kind=event-route&id=&from=lat,lng&add=L1,L2&drop=L3&locale= -> { from|null, stops: [{ n, locId, locName, lat, lng, new_birds: [{ code, speciesCode, comName }], leg_min, leg_mi, private, merged: [{ locId, locName }], picked, species: [code],
//                                                     targets_here, suggested_stay_min }],
//                                                     extras: [{ locId, locName, lat, lng, new_birds, add_min, add_mi, private, merged, dropped, species: [code] }], total_min, total_mi, stay_min_total, covered, covered_with_extras,
//                                                     reported, skipped, geometry: [[lat, lng]], routed, names: { code: comName }, add: [locId], drop: [locId] } (add: forced into the core, drop: kept out; lib/eventRoute: every report of the targets this week, personal spots folded
//                                                     into hotspots, a core worth <= 15 min a bird plus extras; start: from, else the start saved with the group's route (event-route-plan), else the event's spot,
//                                                     all rounded to 2 decimals; kept an hour, unless a species' eBird feed failed twice: then incomplete: true and not kept)
//                                                     targets_here: the targets reported at the stop this week (folded spots included); suggested_stay_min: 15 + 7 a target,
//                                                     to the nearest 5, from 15 to 90 (lib/eventRoute suggestStay); stay_min_total: the stops' suggested stays added up
// POST   /api/saved?kind=event-scouting-email&id=  -> 200 { sent: true, to: 'm•••@example.com' } the scouting email, now, to you alone (lib/scoutEmail): the last 7 days, any day
//                                                     until the event ends; targets, else likely lifers, else what's being seen there this week; the group's saved route if any.
//                                                     Goes with trip emails off and leaves the morning report as it is. Members only (404 otherwise);
//                                                     409 { error: 'confirm_email' } unconfirmed address; 400 { error: 'event_over' }; 429 { error: 'too_many', retry_after_min } past 3 an hour
//                                                     per event; 503 { error: 'mail_cap' } the day's mail is used up
// The group's own route, saved to the event (lib/eventRoutePlan): any member edits it, everyone sees the same one. Members only (404 otherwise).
// GET    /api/saved?kind=event-route-plan&id=     -> { start: { name, lat, lng, time? }|null, stops: [{ locId|null, name, lat, lng, stay_min|null, targets_here, suggested_stay_min }], version, updated_at, updated_by_name|null, updated_by_you,
//                                                     legs: [{ min, mi }|null]|null, totals: { drive_min|null, stay_min, total_min }, routed,
//                                                     position: { stop, at, by_name|null, by_you }|null }
//                                                     start.time: the meeting time, 'HH:MM' 24-hour on the event's own clock (events.timezone); absent: none.
//                                                     position: where the group is on the route (event-route-position): stop 0-based in stops, -1 at the meeting point;
//                                                     at: when the member tapped it (ISO); by_name: their display_name in the event, never an email. null when none
//                                                     is set, or the stops changed since so it's no longer on the route.
//                                                     stay_min: the group's minutes there (null: use suggested_stay_min, the suggestion's formula); targets_here: targets reported
//                                                     there this week from the event's hour-kept scouting feed (personal spots folded into the hotspot count; a typed address 0).
//                                                     legs: one a stop, the drive into it from the stop before (the first: from the start; null when there's none), from one
//                                                     OSRM route through start + stops, cached 30 days (lib/routing drive). totals.stay_min: each stay_min ?? suggested_stay_min.
//                                                     routed false (OSRM failed): legs and drive_min null, total_min the stays alone
//                                                     or { start: null, stops: null, version: 0, position: null } when none is saved (the suggestion stands). updated_by_name: their display_name in the event, never an email
// PUT    /api/saved?kind=event-route-plan&id= { start: { name, lat, lng, time?: 'HH:MM'|null }|null, stops: [{ locId: 'L123'|null, name (<= 200), lat, lng, stay_min?: 0..480|null }] (<= 8), version }
//                                                 -> 200 the saved route at version + 1, as GET gives it (stops rounded to 5 decimals, start to 2, stay_min to whole minutes); 400 when invalid
//                                                    version is the one it was read at (0: none saved yet); any other -> 409 { error, current: the route as GET gives it }
// DELETE /api/saved?kind=event-route-plan&id=&version= -> 200 { start: null, stops: null, version: 0, position: null } back to the suggestion; the same 409 rule
// POST   /api/saved?kind=event-route-position&id= { stop: int|null, at: ISO time } -> 200 { position: as GET event-route-plan gives it, applied }
//                                                    "We're here", shared with the group. stop: 0-based in the saved stops, -1 the meeting point (needs a start), null clears it.
//                                                    at: when the member tapped it (default now; one in the future is taken as now). The latest `at` wins whatever order
//                                                    taps arrive in: an older one (or the same time) changes nothing, applied false, and the newer position comes back.
//                                                    Never touches `version`, so it never conflicts with an edit of the route. Members only (404 otherwise);
//                                                    409 'The route isn't saved yet'; 400 'stop is a stop's place in the route (0 the first, -1 the meeting point), or null' |
//                                                    'That stop isn't on the route' | 'at is a date and time'
// PATCH  /api/saved?kind=event&id= { name?, starts_on?, ends_on?, state?, location?, range_mi?, kind?, scout?, scout_days? } -> the event
// DELETE /api/saved?kind=event&id=                -> 204 (organizer: deletes it for everyone; others leave)
// POST   /api/saved?kind=event-leave&id=          -> 204
// POST   /api/saved?kind=event-invite-rotate&id=  -> the event with a new invite link (organizer)
// PUT    /api/saved?kind=event-targets&id= { codes } -> the event
// POST   /api/saved?kind=event-tally&id= { species_code, client_id?: uuid, observed_at?: ISO time, lat?, lng? }
//                                                 -> 200 { ...the event, entry: the bird's tally row as above } (always 200). client_id: the app's own id for this add;
//                                                    a repeat with one already seen changes nothing and gives back that row (entry is { id, code, removed: true } if it's
//                                                    since been removed). observed_at: the sighting's time (default now; one in the future is taken as now). lat/lng: both or
//                                                    neither, kept to 3 decimals. One row a bird: already on the tally, it stays credited to whoever saw it FIRST (the
//                                                    earliest observed_at, with that one's spot and stop; on a tie, the one already there), so two members adding it at once
//                                                    keep the first finder. A removed bird added again comes back with its original finder and time (unless this one is earlier).
//                                                    400 'client_id is a UUID' | 'observed_at is a date and time' | 'That spot is not a place on the map' | 'Unknown species' | 'The tally is full'
// DELETE /api/saved?kind=event-tally&id=&code=   -> the event. Off the tally for everyone, but kept (removed_at, removed_by): undo or a re-add restores it
// POST   /api/saved?kind=event-tally-undo&id= { species_code } (or &code=) -> 200 { ...the event, entry } the removed bird back as it was (finder, time, spot,
//                                                    marks), however long ago it was removed; already on the tally: unchanged. 404 'That bird isn’t on the tally' if never added
// POST   /api/saved?kind=event-tally-mark&id= { tally_id } -> the event: "added to my eBird checklist" for that bird, yours alone (marked_by_me); idempotent
// DELETE /api/saved?kind=event-tally-mark&id=&tally_id= -> the event, the tick gone. Both: 404 'That bird isn’t on the tally' for a removed bird or another event's
// GET    /api/saved?kind=event-log&id=&locale=   -> [{ id, speciesCode, comName, by_name|null, observed_at, stop_index|null, stop_name|null, removed }] every bird put on
//                                                    the tally, removed ones too, in observed_at order (then id); by_name: the first finder's display_name, never an email.
//                                                    Bird names in ?locale= or your own language
// Every event-tally* and event-log call: members only (404 'No such event' otherwise).
// POST   /api/saved?kind=event-join { token, display_name } -> the event
// GET    /api/saved?kind=event-preview&token=     -> { name, area, starts_on, ends_on, kind, members } (no sign-in)
// GET    /api/saved?kind=event-view&token=&locale= -> { name, area, starts_on, ends_on, kind, timezone, active, tally_open, targets, tally: [{ code, speciesCode, comName, added_at }],
//                                                     count, route: { start: null, stops }|null } (no sign-in, no names, no spots; the saved route never shows its start;
//                                                     removed birds left out; active and tally_open as for members, in the event's zone, so the page knows to keep refreshing)
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
      const locale = req.query.locale || user.locale
      return res.status(200).json(await localize(await events.eventScouting(user, id, { locale }), locale))
    }
    if (kind === 'event-scouting-email' && req.method === 'POST') {
      const { status, body: answer } = await emailScoutingNow(user, id)
      return res.status(status).json(answer)
    }
    if (kind === 'event-route' && req.method === 'GET') {
      const locale = req.query.locale || user.locale
      const plan = await eventRoute(user, id, { from: req.query.from, add: req.query.add, drop: req.query.drop })
      // `names` is a map, which localize can't see into: named as a list, then put back.
      const names = await localize(Object.entries(plan.names || {}).map(([speciesCode, comName]) => ({ speciesCode, comName })), locale)
      return res.status(200).json({ ...(await localize(plan, locale)), names: Object.fromEntries(names.map((b) => [b.speciesCode, b.comName])) })
    }
    if (kind === 'event-route-plan') {
      // A save from an older copy: 409 with the route as it is now, so the app can say who changed it.
      const answer = (result) => (result.ok ? res.status(200).json(result.plan) : res.status(409).json({ error: translateError(requestLocale(req), 'Someone else changed the route'), current: result.current }))
      if (req.method === 'GET') return res.status(200).json(await routePlan.getPlan(user, id))
      if (req.method === 'PUT') return answer(await routePlan.putPlan(user, id, body(req)))
      if (req.method === 'DELETE') return answer(await routePlan.deletePlan(user, id, req.query.version ?? body(req).version))
    }
    if (kind === 'event-route-position' && req.method === 'POST') return res.status(200).json(await routePlan.postPosition(user, id, body(req)))
    if (kind === 'event-join' && req.method === 'POST') {
      const event = await events.joinEvent(user, body(req))
      if (places.startsSoon(event, event.timezone || user.timezone)) ready(event.location)
      return res.status(200).json(event)
    }
    if (kind === 'event') {
      if (req.method === 'POST') {
        const event = await events.createEvent(user, body(req))
        if (places.startsSoon(event, event.timezone || user.timezone)) ready(event.location)
        return res.status(201).json(event)
      }
      if (req.method === 'PATCH') {
        const event = await events.updateEvent(user, id, body(req))
        if (places.startsSoon(event, event.timezone || user.timezone)) ready(event.location)
        return res.status(200).json(event)
      }
      if (req.method === 'DELETE') { await events.endEvent(user, id); return res.status(204).end() }
    }
    if (kind === 'event-leave' && req.method === 'POST') { await events.leaveEvent(user, id); return res.status(204).end() }
    if (kind === 'event-invite-rotate' && req.method === 'POST') return res.status(200).json(await events.rotateInvite(user, id))
    if (kind === 'event-targets' && req.method === 'PUT') return res.status(200).json(await events.setEventTargets(user, id, body(req).codes))
    if (kind === 'event-tally') {
      if (req.method === 'POST') return res.status(200).json(await events.addTally(user, id, body(req)))
      if (req.method === 'DELETE') return res.status(200).json(await events.removeTally(user, id, req.query.code))
    }
    if (kind === 'event-tally-undo' && req.method === 'POST') return res.status(200).json(await events.undoRemoveTally(user, id, body(req).species_code ?? req.query.code))
    if (kind === 'event-tally-mark') {
      if (req.method === 'POST') return res.status(200).json(await events.markTally(user, id, body(req).tally_id))
      if (req.method === 'DELETE') return res.status(200).json(await events.unmarkTally(user, id, req.query.tally_id))
    }
    if (kind === 'event-log' && req.method === 'GET') return res.status(200).json(await localize(await events.eventLog(user, id), req.query.locale || user.locale))
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
