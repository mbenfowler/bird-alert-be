// Runs against a real Postgres (TEST_PG_URL). Covers the pieces that only make sense with a database.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const db = require('../lib/db')
const { assertNotThrottled, recordAttempt, clearAttempts } = require('../lib/throttle')
const { runDigest } = require('../lib/digest')
const ebird = require('../lib/ebird')
const seasonality = require('../lib/seasonality')

let userId
before(async () => {
  await db.migrate.latest()
  for (const table of ['event_recaps', 'event_scout_birds', 'event_routes', 'event_tally_marks', 'event_tally', 'event_targets', 'event_members', 'events', 'trips', 'place_targets', 'places', 'taxonomy_names', 'hq_alerts', 'hotspot_weeks', 'hq_picks', 'feedback', 'passkeys', 'shares', 'seen_birds', 'taxonomy_ref', 'user_routes', 'hotspot_ref', 'mail_counts', 'error_log', 'drive_cache', 'nearby_cache', 'place_predictions', 'checklist_species', 'checklists', 'bird_sounds', 'digest_log', 'push_handoff', 'push_log', 'push_subscriptions', 'saved_birds', 'auth_throttle', 'season_firsts', 'region_species_days', 'region_days', 'job_runs', 'users', 'birds']) await db(table).del()
  // Nothing in here may reach eBird; the hourly job's history fetch is a no-op unless a test says otherwise.
  ebird.historicObservations = async () => []
  ;[{ id: userId }] = await db('users').insert({
    email: 'tester@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true
  }).returning('id')
})
after(async () => { await db.destroy() })

test('watch-list alerts with no device to push to come by email instead, until that is turned off', async () => {
  const { DIGESTS } = require('../lib/digests')
  const base = { password_hash: 'x', location: 'US-ZZ-001', state: 'GA', email_confirmed: true, alert_digest_email_enabled: false, push_watchlist_enabled: true }
  const ids = {}
  for (const [name, over] of Object.entries({
    noDevice: {}, hasDevice: {}, optedOut: { watchlist_email_fallback: false }, chose: { alert_digest_email_enabled: true, push_watchlist_enabled: false },
    noAlerts: { push_watchlist_enabled: false }, unconfirmed: { email_confirmed: false }
  })) [{ id: ids[name] }] = await db('users').insert({ ...base, email: `fallback-${name}@example.com`, ...over }).returning('id')
  await db('push_subscriptions').insert({ user_id: ids.hasDevice, endpoint: 'https://push.example/fallback', p256dh: 'k', auth: 'a' })
  const sent = []
  await runDigest({ ...DIGESTS.watchlist, kind: 'watchlist-fallback-test', fetchSightings: async () => [{ speciesCode: 'cangoo', subId: 'S1' }], select: async (_u, s) => s, send: async (user) => { sent.push(user.id) } })
  assert.deepEqual(sent.filter((id) => Object.values(ids).includes(id)).sort(), [ids.noDevice, ids.chose].sort())

  // The email says why it came, and its unsubscribe link turns off the fallback only.
  const { alertDigestMessage } = require('../lib/mailer')
  const { verifyToken } = require('../lib/tokens')
  const sighting = [{ speciesCode: 'cangoo', comName: 'Canada Goose', locName: 'Lake', obsDt: '2026-10-29 08:00', subId: 'S1' }]
  const fallback = alertDigestMessage(await db('users').where({ id: ids.noDevice }).first(), sighting, new Map())
  assert.match(fallback.html, /alerts aren’t set up on a phone or computer yet/)
  const tokenOf = (html) => verifyToken(html.match(/unsubscribe\/([A-Za-z0-9._-]+)/)[1], 'unsubscribe').emailType
  assert.equal(tokenOf(fallback.html), 'watchlist_email_fallback')
  const chosen = alertDigestMessage(await db('users').where({ id: ids.chose }).first(), sighting, new Map())
  assert.doesNotMatch(chosen.html, /aren’t set up/)
  assert.equal(tokenOf(chosen.html), 'alert_digest_email_enabled')
  assert.match(chosen.html, /eBird<\/a>, the Cornell Lab of Ornithology/)
  assert.match(chosen.text, /from eBird \(https:\/\/ebird\.org\)/)
  await db('push_subscriptions').whereIn('user_id', Object.values(ids)).del()
  await db('digest_log').whereIn('user_id', Object.values(ids)).del()
  await db('users').whereIn('id', Object.values(ids)).del()
})

test('login throttle opens after ten failures and clears on success', async () => {
  for (let i = 0; i < 10; i += 1) await recordAttempt('login', 'tester@example.com')
  await assert.rejects(assertNotThrottled('login', 'tester@example.com'), (error) => error.status === 429)
  await clearAttempts('login', 'tester@example.com')
  await assertNotThrottled('login', 'tester@example.com')
})

test('a digest is sent once per user per day and logged', async () => {
  const sent = []
  const options = {
    kind: 'watchlist',
    preference: 'alert_digest_email_enabled',
    fetchSightings: async () => [
      { speciesCode: 'cangoo', comName: 'Canada Goose', obsDt: '2026-10-20 08:00' },
      { speciesCode: 'cangoo', comName: 'Canada Goose', obsDt: '2026-10-19 08:00' },
      { speciesCode: 'snogoo', comName: 'Snow Goose', obsDt: '2026-10-20 07:00' }
    ],
    select: async (_user, sightings) => sightings.filter((s) => s.speciesCode === 'cangoo'),
    send: async (user, sightings) => { sent.push({ user: user.id, count: sightings.length }) }
  }
  const first = await runDigest(options)
  assert.equal(first.sent, 1)
  assert.deepEqual(sent, [{ user: userId, count: 1 }], 'duplicates per species collapse to the newest')

  const second = await runDigest(options)
  assert.equal(second.sent, 0)
  assert.equal(second.skippedAlreadySent, 1)
  assert.equal(sent.length, 1)
  assert.equal(await db('digest_log').where({ user_id: userId, kind: 'watchlist' }).count('* as n').first().then((r) => Number(r.n)), 1)
})

test('a pushed observation is logged and never pushed again', async () => {
  const ebird = require('../lib/ebird')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const original = ebird.recentObservations
  ebird.recentObservations = async () => [
    { speciesCode: 'cangoo', comName: 'Canada Goose', locName: 'Lake', obsDt: '2026-10-20 08:00', lat: 34.2, lng: -83.9, subId: 'S77' },
    { speciesCode: 'snogoo', comName: 'Snow Goose', locName: 'Dam', obsDt: '2026-10-20 09:30', lat: 34.2, lng: -83.9, subId: 'S78' }
  ]
  try {
    await db('push_subscriptions').insert({ user_id: userId, endpoint: 'https://push.example/dev1', p256dh: 'k', auth: 'a' })
    for (const [speciesCode, comName, sciName] of [['cangoo', 'Canada Goose', 'Branta canadensis'], ['snogoo', 'Snow Goose', 'Anser caerulescens']]) {
      await db('saved_birds').insert({ user_id: userId, speciesCode, bird_id: (await db('birds').insert({ speciesCode, comName, sciName }).returning('id'))[0].id })
    }
    await db('users').where({ id: userId }).update({ push_watchlist_enabled: true, push_quiet_start: null, push_quiet_end: null })
    const sent = []
    const send = async (id, payload) => { sent.push(payload); return { sent: 1, gone: 0 } }

    const first = await runPushAlerts({ send })
    assert.equal(first.notified, 1)
    assert.deepEqual(sent.map((n) => n.title), ['⭐ 2 watch list birds spotted nearby'], 'watch-list birds travel together')
    assert.equal(sent[0].body, 'Canada Goose, Snow Goose\nCanada Goose · Lake · Oct 20, 8:00 AM\nSnow Goose · Dam · Oct 20, 9:30 AM')
    assert.ok(sent[0].data.url.endsWith('/sightings?s=' + encodeURIComponent('cangoo:S77,snogoo:S78') + '&region=US-GA-139'), sent[0].data.url)
    assert.equal(Number((await db('push_log').where({ user_id: userId }).whereIn('sub_id', ['S77', 'S78']).count('* as n').first()).n), 2)

    const second = await runPushAlerts({ send })
    assert.equal(second.notified, 0, 'same observation must not be pushed twice')
    assert.equal(sent.length, 1)
  } finally {
    ebird.recentObservations = original
  }
})

test('rare birds in range but past the county alert with how far, never repeat at a place, and stay away when range is off', async () => {
  const ebird = require('../lib/ebird')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const originals = { recent: ebird.recentObservations, notable: ebird.notableObservations, geo: ebird.geoNotable }
  const [{ id }] = await db('users').insert({ email: 'range@example.com', password_hash: 'x', location: 'US-ZZ-002', state: 'GA', push_notable_enabled: true, push_watchlist_enabled: false, range_mi: 30, home_lat: 34.3, home_lng: -83.8, push_quiet_start: null, push_quiet_end: null }).returning('id')
  await db('push_subscriptions').insert({ user_id: id, endpoint: 'https://push.example/range', p256dh: 'k', auth: 'a' })
  await db('birds').insert({ speciesCode: 'snoowl1', comName: 'Snowy Owl', sciName: 'Bubo scandiacus', category: 'species' }).onConflict('speciesCode').ignore()
  await db('birds').insert({ speciesCode: 'rthhum', comName: 'Ruby-throated Hummingbird', sciName: 'Archilochus colubris', category: 'species' }).onConflict('speciesCode').ignore()
  const owl = (subId, locId, lat) => ({ speciesCode: 'snoowl1', comName: 'Snowy Owl', locId, locName: 'Owl Field', obsDt: '2026-10-30 08:00', lat, lng: -83.8, subId, subnational2Code: 'US-ZZ-003', subnational2Name: 'Forsyth' })
  let geo = []
  let geoCalls = 0
  ebird.recentObservations = async () => []
  ebird.notableObservations = async (region) => (region === 'US-ZZ-002' ? [{ speciesCode: 'rthhum', comName: 'Ruby-throated Hummingbird', locId: 'LH', locName: 'Yard', obsDt: '2026-10-30 07:00', lat: 34.3, lng: -83.8, subId: 'H1' }] : [])
  ebird.geoNotable = async () => { geoCalls += 1; return geo }
  const sent = []
  const send = async (userId, payload) => { if (userId === id) sent.push(payload); return { sent: 1, gone: 0 } }
  try {
    // The county's own rarity and the owl one county over; the hummingbird in range too is the county's, so it isn't repeated.
    geo = [owl('R1', 'L9', 34.6), { speciesCode: 'rthhum', comName: 'Ruby-throated Hummingbird', locId: 'LH2', locName: 'Elsewhere', obsDt: '2026-10-30 07:30', lat: 34.4, lng: -83.8, subId: 'H2', subnational2Code: 'US-ZZ-003', subnational2Name: 'Forsyth' }]
    await runPushAlerts({ send })
    const titles = sent.map((n) => n.title)
    assert.ok(titles.some((t) => /Ruby-throated Hummingbird reported nearby/.test(t)), titles.join(' | '))
    const owlPush = sent.find((n) => /Snowy Owl/.test(n.title))
    assert.match(owlPush.title, /Snowy Owl reported 21 mi away/)
    assert.match(owlPush.body, /Owl Field · 21 mi away in Forsyth/)
    assert.match(owlPush.data.url, /region=US-ZZ-003/, 'the sighting opens on the county it is in')
    assert.equal(sent.filter((n) => /Hummingbird/.test(n.title)).length, 1)

    // A newer checklist of the owl at the same field is not news again.
    sent.length = 0
    geo = [owl('R2', 'L9', 34.6)]
    await runPushAlerts({ send })
    assert.equal(sent.length, 0, 'same bird, same place, new checklist: no second alert')

    // The owl somewhere new is.
    geo = [owl('R3', 'L10', 34.65)]
    await runPushAlerts({ send })
    assert.equal(sent.filter((n) => /Snowy Owl/.test(n.title)).length, 1)

    // Range off: the county only, no range lookups.
    sent.length = 0
    geoCalls = 0
    await db('users').where({ id }).update({ range_mi: 0 })
    geo = [owl('R4', 'L11', 34.7)]
    await runPushAlerts({ send })
    assert.equal(geoCalls, 0)
    assert.equal(sent.length, 0)
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, notableObservations: originals.notable, geoNotable: originals.geo })
    await db('push_log').where({ user_id: id }).del()
    await db('push_subscriptions').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('a push is handed to the open app through the server: offered, tapped, opened', async () => {
  const handoff = require('../lib/handoff')
  const url = 'https://bird-alert.vercel.app/sightings?s=cangoo:S1'
  await handoff.recordSent(userId, { title: '⭐ Canada Goose spotted nearby!', data: { url } })
  let push = await handoff.pending(userId)
  assert.equal(push.url, url)
  assert.equal(push.tappedAt, null)
  assert.equal(push.offeredAt, null)

  await handoff.ack(userId, { offered: true })
  assert.ok((await handoff.pending(userId)).offeredAt, 'the toast was offered')

  assert.equal(await handoff.markTapped(userId, 'https://bird-alert.vercel.app/'), 0, 'a tap on some other notification is ignored')
  assert.equal(await handoff.markTapped(userId, url), 1)
  push = await handoff.pending(userId)
  assert.ok(push.tappedAt)
  assert.equal(push.openedAt, null)

  await handoff.ack(userId, { opened: true })
  assert.ok((await handoff.pending(userId)).openedAt)

  await handoff.recordSent(userId, { title: 'Newer', data: { url: 'https://bird-alert.vercel.app/' } })
  push = await handoff.pending(userId)
  assert.equal(push.title, 'Newer', 'a newer push replaces the old one')
  assert.equal(push.tappedAt, null, 'with a clean slate')

  await db('push_handoff').where({ user_id: userId }).update({ sent_at: db.raw("now() - interval '11 minutes'") })
  assert.equal(await handoff.pending(userId), null, 'old pushes are not offered')
  await handoff.recordSent(userId, { title: 'No link' })
  assert.equal(await handoff.pending(userId), null, 'a push without an app link is not recorded')
})

// A year of made-up history for one county: a resident reported daily, a migrant that arrived on
// October 12 last year, and a summer bird that was still around until three weeks ago.
test('seasonality: history is fetched once, arrivals are judged by last year, and a returning migrant is greeted once', async () => {
  const region = 'US-GA-999'
  const today = seasonality.today()
  const ly = seasonality.yearAgo(today)
  const inRange = (day, from, to) => day >= from && day <= to
  const fetched = []
  const originals = { historic: ebird.historicObservations, recent: ebird.recentObservations }
  ebird.historicObservations = async (_region, day) => {
    fetched.push(day)
    const list = [{ speciesCode: 'resident' }]
    if (inRange(day, seasonality.addDays(ly, -8), seasonality.addDays(ly, 60))) list.push({ speciesCode: 'migrant' })
    if (inRange(day, seasonality.addDays(today, -200), seasonality.addDays(today, -21))) list.push({ speciesCode: 'summer' })
    return list
  }
  const live = []
  ebird.recentObservations = async () => live
  await db('birds').insert([
    { speciesCode: 'resident', comName: 'Resident Wren', sciName: 'R r', category: 'species' },
    { speciesCode: 'migrant', comName: 'Migrant Sparrow', sciName: 'M s', category: 'species' },
    { speciesCode: 'summer', comName: 'Summer Tanager', sciName: 'S t', category: 'species' }
  ])
  try {
    // One day answers 502 once, then succeeds on the retry.
    let flaked = false
    const flaky = ebird.historicObservations
    ebird.historicObservations = async (r, day) => {
      if (!flaked && fetched.length === 10) { flaked = true; const e = new Error('eBird responded with 502'); e.status = 502; throw e }
      return flaky(r, day)
    }
    const first = await seasonality.backfill(region)
    assert.deepEqual(first, { fetched: 491, remaining: 0, failed: 0 })
    assert.equal(fetched.length, 491)
    assert.ok(flaked)
    assert.deepEqual(await seasonality.backfill(region), { fetched: 0, remaining: 0, failed: 0 }, 'fetched days are never asked for again')

    live.push({ speciesCode: 'resident', comName: 'Resident Wren', obsDt: `${today} 08:00`, subId: 'S1', locName: 'Yard', lat: 1, lng: 1 })
    const { arrivals, learning } = await seasonality.arrivingSoon(region)
    assert.equal(learning, false)
    assert.deepEqual(arrivals.map((a) => [a.speciesCode, a.comName, a.daysLastYear, a.firstLastYear]), [['migrant', 'Migrant Sparrow', 15, seasonality.addDays(ly, -8)]])

    // The migrant turns up today: the hourly job files a season first and pushes it to users who asked.
    await db('users').where({ id: userId }).update({ location: region, push_first_of_season: true, push_watchlist_enabled: false })
    live.push({ speciesCode: 'migrant', comName: 'Migrant Sparrow', obsDt: `${today} 09:30`, subId: 'S2', locName: 'Lake', lat: 1, lng: 1, howMany: 2 })
    const sent = []
    const { runPushAlerts } = require('../lib/pushAlerts')
    const run = await runPushAlerts({ send: async (_id, payload) => { sent.push(payload); return { sent: 1, gone: 0 } } })
    assert.equal(run.notified, 1)
    assert.equal(sent.length, 1)
    assert.match(sent[0].title, /^(🍂|🌱) First Migrant Sparrow of the season!$/)
    assert.match(sent[0].body, new RegExp(`Lake · .* · 2 seen · first since`))
    assert.equal(await db('season_firsts').where({ region, speciesCode: 'migrant' }).count('* as n').first().then((r) => Number(r.n)), 1)

    const again = await runPushAlerts({ send: async () => { throw new Error('must not send twice') } })
    assert.equal(again.notified, 0)

    // The week in review: the migrant arrived, the summer bird has moved on.
    const report = await seasonality.migrationReport(region)
    assert.deepEqual(report.arrived.map((a) => a.speciesCode), ['migrant'])
    assert.deepEqual(report.departed.map((d) => [d.speciesCode, d.lastSeen]), [['summer', seasonality.addDays(today, -21)]])
    assert.deepEqual(report.coming, [])

    const strip = await seasonality.seasonality(region, 'migrant')
    assert.equal(strip.months.length, 12)
    const yearStart = seasonality.addDays(today, -365)
    const onFile = seasonality.daysBetween(seasonality.addDays(ly, -8) > yearStart ? seasonality.addDays(ly, -8) : yearStart, seasonality.addDays(today, -2)).filter((d) => d <= seasonality.addDays(ly, 60)).length
    assert.equal(strip.months.reduce((n, m) => n + m.reported, 0), onFile + 1, 'last autumn\'s days within the year, plus today')
    assert.ok(strip.months.every((m) => m.covered >= 28 && m.covered <= 31))
  } finally {
    ebird.historicObservations = originals.historic
    ebird.recentObservations = originals.recent
  }
})

test('a species sound is looked up on xeno-canto once and then served from the table', async () => {
  const { soundFor } = require('../lib/sounds')
  const { withFetch, jsonResponse } = require('./helpers')
  process.env.XENO_CANTO_KEY = 'test-key'
  await db('birds').insert({ speciesCode: 'snogoo', comName: 'Snow Goose', sciName: 'Anser caerulescens' }).onConflict('speciesCode').ignore()
  const calls = []
  const recording = { id: '4242', file: 'https://xeno-canto.org/4242/download', 'file-name': 'XC4242.mp3', type: 'call', q: 'A', length: '0:12', cnt: 'United States', rec: 'A Birder', lic: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' }
  const sound = await withFetch((url) => { calls.push(url); return jsonResponse({ recordings: [recording] }) }, () => soundFor('snogoo'))
  assert.equal(calls.length, 1)
  assert.match(calls[0], /query=sp%3A%22Anser\+caerulescens%22\+q%3AA/)
  assert.ok(calls[0].includes('key=test-key'))
  assert.deepEqual({ found: sound.found, xcId: sound.xcId, url: sound.url, page: sound.page, licenseName: sound.licenseName, length: sound.length },
    { found: true, xcId: 4242, url: recording.file, page: 'https://xeno-canto.org/4242', licenseName: 'CC BY-NC-SA 4.0', length: 12 })
  const again = await withFetch(() => { throw new Error('should not fetch') }, () => soundFor('snogoo'))
  assert.equal(again.xcId, 4242)

  // Nothing suitable: A then B are tried, the miss is remembered, and no third search follows.
  await db('birds').insert({ speciesCode: 'emgoo1', comName: 'Emperor Goose', sciName: 'Anser canagicus' }).onConflict('speciesCode').ignore()
  const misses = []
  const none = await withFetch((url) => { misses.push(url); return jsonResponse({ recordings: [] }) }, () => soundFor('emgoo1'))
  assert.equal(none.found, false)
  assert.equal(misses.length, 2)
  const stillNone = await withFetch(() => { throw new Error('should not fetch') }, () => soundFor('emgoo1'))
  assert.equal(stillNone.found, false)
})

test('history days gain locations: new fetches keep them, old days are refetched once', async () => {
  const { ensureDays, backfillLocations } = seasonality
  ebird.historicObservations = async (_region, day) => [{ speciesCode: 'reshaw', locId: 'L2664464', locName: 'Lanier Village Estates', obsDt: `${day} 08:10`, subId: 'S77' }]
  await ensureDays('US-GA-121', ['2026-09-01'])
  let row = await db('region_species_days').where({ region: 'US-GA-121', day: '2026-09-01', speciesCode: 'reshaw' }).first()
  assert.equal(row.locId, 'L2664464')
  assert.equal(row.obsTime, '08:10')
  assert.equal((await db('region_days').where({ region: 'US-GA-121' }).first()).has_locations, true)

  // A day stored before locations were kept.
  await db('region_days').where({ region: 'US-GA-121' }).update({ has_locations: false })
  await db('region_species_days').where({ region: 'US-GA-121' }).update({ locId: null, locName: null, obsTime: null, subId: null })
  let calls = 0
  ebird.historicObservations = async (_region, day) => { calls += 1; return [{ speciesCode: 'reshaw', locId: 'L1', locName: 'Somewhere', obsDt: `${day} 07:00`, subId: 'S78' }] }
  assert.deepEqual(await backfillLocations('US-GA-121'), { fetched: 1, failed: 0, remaining: 0 })
  row = await db('region_species_days').where({ region: 'US-GA-121', day: '2026-09-01', speciesCode: 'reshaw' }).first()
  assert.equal(row.locId, 'L1')
  assert.deepEqual(await backfillLocations('US-GA-121'), { fetched: 0, failed: 0, remaining: 0 })
  assert.equal(calls, 1)
  ebird.historicObservations = async () => []
})

test('checklists are listed once, fetched in full newest first, and not fetched again', async () => {
  const { syncChecklists } = require('../lib/checklists')
  const listed = [
    { locId: 'L1', subId: 'S200', userDisplayName: 'B', numSpecies: 2, obsDt: '25 Oct 2026', obsTime: '09:00', isoObsDate: '2026-10-25 09:00', loc: { locName: 'Park', latitude: 34.3, longitude: -83.7, isHotspot: true } },
    { locId: 'L1', subId: 'S100', userDisplayName: 'A', numSpecies: 1, obsDt: '24 Oct 2026', obsTime: '08:00', isoObsDate: '2026-10-24 08:00', loc: { locName: 'Park', latitude: 34.3, longitude: -83.7, isHotspot: true } }
  ]
  const views = {
    S200: { numSpecies: 2, numObservers: 1, durationHrs: 1.5, obs: [{ speciesCode: 'cangoo', howManyAtleast: 4, comments: 'north ramp', mediaCounts: { P: 1 } }, { speciesCode: 'norcar', howManyAtleast: 1 }] },
    S100: { numSpecies: 1, obs: [{ speciesCode: 'cangoo', howManyAtleast: 2 }] }
  }
  const fetched = []
  ebird.recentChecklists = async () => listed
  ebird.checklistView = async (subId) => { fetched.push(subId); return views[subId] }

  const first = await syncChecklists('US-GA-139', { detailLimit: 1, pause: 0 })
  assert.deepEqual(first, { region: 'US-GA-139', listed: 2, added: 2, detailed: 1, failed: 0, pending: 1 })
  assert.deepEqual(fetched, ['S200'])
  const s200 = await db('checklists').where({ sub_id: 'S200' }).first()
  assert.equal(s200.loc_name, 'Park')
  assert.equal(Number(s200.duration_hrs), 1.5)
  assert.ok(s200.detail_fetched_at)
  const species = await db('checklist_species').where({ sub_id: 'S200' }).orderBy('species_code')
  assert.deepEqual(species.map((r) => [r.species_code, r.how_many, r.comments, r.photos]), [['cangoo', 4, 'north ramp', 1], ['norcar', 1, null, 0]])

  const second = await syncChecklists('US-GA-139', { detailLimit: 10, pause: 0 })
  assert.deepEqual(second, { region: 'US-GA-139', listed: 2, added: 0, detailed: 1, failed: 0, pending: 0 })
  assert.deepEqual(fetched, ['S200', 'S100'])
  const third = await syncChecklists('US-GA-139', { detailLimit: 10, pause: 0 })
  assert.equal(third.detailed, 0)
  assert.equal(fetched.length, 2)
})

test('a checklist sync stops waiting on eBird when it hangs', async () => {
  const { syncChecklists } = require('../lib/checklists')
  const quiet = console.error
  console.error = () => {}
  try {
    // The list never comes: the region fails within the call's time instead of holding it.
    const asked = []
    ebird.recentChecklists = async (_region, _max, { timeoutMs }) => { asked.push(timeoutMs); const e = new Error('eBird took too long to answer'); e.upstream = 'timeout'; throw e }
    await assert.rejects(syncChecklists('US-GA-131', { deadline: Date.now() + 2_000, pause: 0 }), (error) => error.upstream === 'timeout')
    assert.ok(asked[0] > 0 && asked[0] <= 7_000, String(asked[0]))
    // Full fetches: the first that times out ends the region's run; the rest wait for the next.
    ebird.recentChecklists = async () => [
      { locId: 'LT', subId: 'ST2', obsTime: '09:00', isoObsDate: '2026-10-25 09:00', loc: { locName: 'T' } },
      { locId: 'LT', subId: 'ST1', obsTime: '08:00', isoObsDate: '2026-10-24 08:00', loc: { locName: 'T' } }
    ]
    const fetched = []
    ebird.checklistView = async (subId) => { fetched.push(subId); const e = new Error('eBird took too long to answer'); e.upstream = 'timeout'; throw e }
    const result = await syncChecklists('US-GA-131', { detailLimit: 10, pause: 0 })
    assert.deepEqual(fetched, ['ST2'])
    assert.equal(result.failed, 1)
    assert.equal(result.pending, 2)
  } finally {
    console.error = quiet
  }
})

test('the checklist sync takes the region synced longest ago first, and says more when out of time', async () => {
  const { runChecklistSync } = require('../lib/checklists')
  const regions = ['US-GA-139', 'US-NC-119', 'US-FL-071']
  const order = []
  // Each sync uses up the call's time, so one region fits per call.
  const slow = (budget) => async (code) => { order.push(code); budget.left = 0; return { region: code } }
  const call = async () => {
    const budget = { left: 1 }
    const fake = slow(budget)
    let now = Date.now()
    const realNow = Date.now
    Date.now = () => (budget.left ? now : now + 60_000)
    try { return await runChecklistSync({ regions, deadline: now + 45_000, sync: fake, budget: 200 }) } finally { Date.now = realNow }
  }
  await db('job_runs').where('kind', 'like', 'checklist-sync:%').del()
  // US-GA-139 was synced recently, the others never: they go first.
  await db('job_runs').insert({ kind: 'checklist-sync:US-GA-139', ran_at: new Date(Date.now() - 3_600_000), detail: null })
  const first = await call()
  assert.equal(first.more, true)
  const second = await call()
  assert.equal(second.more, true)
  const third = await call()
  assert.equal(third.more, false, 'the third call reaches the last region due, so the round is done')
  assert.deepEqual(order.slice(0, 2).sort(), ['US-FL-071', 'US-NC-119'])
  assert.equal(order[2], 'US-GA-139')
  // All three were synced in this round, so a further call has nothing left and says so.
  const done = await runChecklistSync({ regions, deadline: Date.now() + 45_000, sync: async (code) => ({ region: code }), budget: 200 })
  assert.equal(done.more, false)
  assert.equal(done.regions.length, 0)
  // An hour on, every region is due again, and with time to spare all are synced in one call.
  await db('job_runs').where('kind', 'like', 'checklist-sync:%').update({ ran_at: new Date(Date.now() - 3_600_000) })
  const hourLater = await runChecklistSync({ regions, deadline: Date.now() + 45_000, sync: async (code) => ({ region: code }), budget: 200 })
  assert.equal(hourLater.more, false)
  assert.equal(hourLater.regions.length, 3)
})

test('the hourly sync shares one budget of full fetches, and stops at the first sign of throttling', async () => {
  const { runChecklistSync } = require('../lib/checklists')
  const regions = ['US-GA-139', 'US-NC-119', 'US-FL-071']
  await db('job_runs').where('kind', 'like', 'checklist-sync:%').del()
  const asked = []
  const fetching = async (code, { detailLimit }) => { asked.push([code, detailLimit]); return { region: code, detailed: detailLimit } }
  const allActive = async (codes) => new Map(codes.map((c) => [c, { active: true, detailed14: 0 }]))
  const shared = await runChecklistSync({ regions, deadline: Date.now() + 45_000, sync: fetching, detailLimit: 40, budget: 50, needs: allActive })
  assert.deepEqual(asked.map(([, limit]) => limit), [17, 17, 16], 'the hour is split evenly among the regions waiting')

  await db('job_runs').where('kind', 'like', 'checklist-sync:%').del()
  asked.length = 0
  const mixed = async (codes) => new Map(codes.map((c, i) => [c, [{ active: false, detailed14: 0 }, { active: true, detailed14: 5000 }, { active: true, detailed14: 10 }][i]]))
  await runChecklistSync({ regions, deadline: Date.now() + 45_000, sync: fetching, detailLimit: 40, budget: 200, needs: mixed })
  const limitFor = Object.fromEntries(asked)
  assert.deepEqual(Object.values(limitFor).sort((x, y) => x - y), [0, 5, 40], 'a quiet region is only listed, a well-stocked one tops up, a thin one gets its fill')
  assert.equal(shared.more, false)

  await db('job_runs').where('kind', 'like', 'checklist-sync:%').del()
  const reached = []
  const busy = async (code) => { reached.push(code); const error = new Error('eBird is busy right now. Trying again in a moment.'); error.upstream = 429; throw error }
  let graded = 0
  const stopped = await runChecklistSync({ regions, deadline: Date.now() + 45_000, sync: busy, grade: async () => { graded += 1 }, budget: 200, needs: allActive })
  assert.equal(reached.length, 1, 'no more eBird calls once it says busy')
  assert.equal(stopped.throttled, true)
  assert.equal(stopped.more, false, 'the workflow stops calling; the next hour carries on')
  assert.equal(graded, 0)
  assert.equal(await db('job_runs').where('kind', 'like', 'checklist-sync:%').count('* as n').first().then((r) => Number(r.n)), 0, 'the throttled region stays first in line')
})

test('a newly chosen county is synced at once, and only the first time', async () => {
  const { syncNewRegion } = require('../lib/checklists')
  await db('job_runs').where('kind', 'like', 'checklist-sync:%').del()
  const synced = []
  const fake = async (code, opts) => { synced.push([code, opts.detailLimit]); return { region: code } }
  assert.deepEqual(await syncNewRegion('CA-QC-BH', { sync: fake, left: 200 }), { region: 'CA-QC-BH' })
  assert.ok(await db('job_runs').where({ kind: 'checklist-sync:CA-QC-BH' }).first(), 'the claim also tells the hourly run it was just done')
  assert.equal(await syncNewRegion('CA-QC-BH', { sync: fake }), null, 'a second save of the same area does not sync again')
  assert.equal(await syncNewRegion('', { sync: fake }), null)
  assert.equal(await syncNewRegion('US-GA', { sync: fake }), null, 'a state is not a county')
  assert.deepEqual(synced, [['CA-QC-BH', 30]])
  // The hourly budget is shared: a new area when it's nearly spent fetches only what's left.
  await syncNewRegion('CA-ON-TO', { sync: fake, left: 12 })
  await syncNewRegion('CA-ON-OT', { sync: fake, left: 0 })
  assert.deepEqual(synced.slice(1), [['CA-ON-TO', 12], ['CA-ON-OT', 0]], 'past the budget it is still listed, and the hourly run fills it in')
})

test('retention deletes checklists past 90 days and strips old history to region, day and species, once a day', async () => {
  const { pruneOld, pruneDaily } = require('../lib/retention')
  const ago = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
  await db('checklists').insert([
    { sub_id: 'S900000001', region: 'US-GA-139', loc_id: 'L1', obs_day: ago(120), detail_fetched_at: new Date() },
    { sub_id: 'S900000002', region: 'US-GA-139', loc_id: 'L1', obs_day: ago(10), detail_fetched_at: new Date() }
  ])
  await db('checklist_species').insert([{ sub_id: 'S900000001', species_code: 'cangoo' }, { sub_id: 'S900000002', species_code: 'cangoo' }])
  await db('region_species_days').insert([
    { region: 'US-GA-139', day: ago(200), speciesCode: 'retenta', locId: 'L1', locName: 'Old Lake', obsTime: '07:00', subId: 'S1' },
    { region: 'US-GA-139', day: ago(20), speciesCode: 'retenta', locId: 'L1', locName: 'New Lake', obsTime: '08:00', subId: 'S2' }
  ])
  const result = await pruneOld()
  assert.ok(result.checklists >= 1)
  assert.equal(await db('checklists').where({ sub_id: 'S900000001' }).first(), undefined)
  assert.equal(await db('checklist_species').where({ sub_id: 'S900000001' }).first(), undefined, 'species rows go with their checklist')
  assert.ok(await db('checklist_species').where({ sub_id: 'S900000002' }).first())
  const rows = await db('region_species_days').where({ speciesCode: 'retenta' }).orderBy('day')
  assert.equal(rows.length, 2, 'seasonality keeps every day')
  assert.deepEqual([rows[0].locId, rows[0].locName, rows[0].obsTime, rows[0].subId], [null, null, null, null])
  assert.equal(rows[1].locName, 'New Lake')
  await db('job_runs').where({ kind: 'retention' }).del()
  await db('hotspot_weeks').insert({ loc_id: 'L1', region: 'US-GA-139', week_start: '2025-07-14', checklists: 3, species: 40 })
  const daily = await pruneDaily()
  assert.ok(daily)
  assert.equal(typeof daily.hotspotWeeks, 'number', 'the weekly tallies are brought up to date in the same pass')
  assert.ok(await db('hotspot_weeks').where({ loc_id: 'L1', week_start: '2025-07-14' }).first(), 'and are never pruned')
  assert.equal(await pruneDaily(), null, 'a second pass the same day does nothing')
  await db('region_species_days').where({ speciesCode: 'retenta' }).del()
  await db('checklists').whereIn('sub_id', ['S900000002']).del()
  await db('hotspot_weeks').del()
})

test('hotspot weeks: each hotspot\'s week tallied (lists, species the birders\' way, best list), redone in place as lists arrive', async () => {
  const { rollupHotspotWeeks } = require('../lib/hotspotWeeks')
  const region = 'US-ZZ-778'
  await db('taxonomy_ref').insert([
    { species_code: 'duck', sci_name: 'Anatidae sp.', com_name: 'duck sp.', category: 'spuh' },
    { species_code: 'yerwar1', sci_name: 'Setophaga coronata coronata', com_name: 'Yellow-rumped Warbler (Myrtle)', category: 'issf', report_as: 'yerwar' }
  ]).onConflict('species_code').ignore()
  const list = (sub, loc, day, numSpecies, { detailed = true, hotspot = true } = {}) => ({
    sub_id: sub, region, loc_id: loc, loc_name: `Place ${loc}`, is_hotspot: hotspot, obs_day: day, obs_time: '08:00',
    num_species: numSpecies, detail_fetched_at: detailed ? new Date() : null
  })
  // Friday 2026-10-30 is in the week of Monday 2026-10-26; Sunday 2026-10-25 closes the week before.
  await db('checklists').insert([
    list('SHW1', 'LHW1', '2026-10-26', 4), list('SHW2', 'LHW1', '2026-10-30', 2), list('SHW3', 'LHW1', '2026-10-25', 7, { detailed: false }),
    list('SHW4', 'LHW2', '2026-10-28', 3), list('SHW5', 'LHW9', '2026-10-28', 30, { hotspot: false }),
    // Long past the window: left alone.
    list('SHW6', 'LHW1', '2026-08-03', 12)
  ])
  await db('checklist_species').insert([
    ...['yerwar', 'yerwar1', 'norcar', 'duck'].map((code) => ({ sub_id: 'SHW1', species_code: code })),
    ...['norcar', 'blujay'].map((code) => ({ sub_id: 'SHW2', species_code: code })),
    ...['carwre'].map((code) => ({ sub_id: 'SHW4', species_code: code }))
  ])
  const asOf = '2026-10-31'
  const tally = async () => (await db('hotspot_weeks').where({ region }).orderBy(['loc_id', 'week_start']))
    .map((r) => [r.loc_id, new Date(r.week_start).toISOString().slice(0, 10) <= '2026-10-25' ? 'before' : 'this', r.checklists, r.species, r.best_list, r.best_sub_id])
  assert.ok(await rollupHotspotWeeks({ asOf }) >= 3)
  assert.deepEqual(await tally(), [
    ['LHW1', 'before', 1, 0, 7, 'SHW3'],
    ['LHW1', 'this', 2, 3, 4, 'SHW1'],
    ['LHW2', 'this', 1, 1, 3, 'SHW4']
  ])
  const weeks = await db('hotspot_weeks').where({ region, loc_id: 'LHW1' }).orderBy('week_start').pluck('week_start')
  assert.deepEqual(weeks.map((d) => new Date(d).getDay()), [1, 1], 'weeks start on a Monday')
  // A late list and its detail: the week is redone in place, not added to.
  await db('checklists').insert(list('SHW7', 'LHW1', '2026-10-31', 9))
  await db('checklist_species').insert(['baleag', 'norcar'].map((code) => ({ sub_id: 'SHW7', species_code: code })))
  await rollupHotspotWeeks({ asOf })
  await rollupHotspotWeeks({ asOf })
  assert.deepEqual((await tally())[1], ['LHW1', 'this', 3, 4, 9, 'SHW7'])
  assert.equal(await db('hotspot_weeks').where({ region }).count('* as n').first().then((r) => Number(r.n)), 3)
  await db('checklists').where({ region }).del()
  await db('hotspot_weeks').where({ region }).del()
})

test('where to find a species: tables and the live feed become ranked places with evidence', async () => {
  const { whereToFind } = require('../lib/hotspots')
  const asOf = '2026-10-25'
  await db('birds').insert({ speciesCode: 'hoomer', comName: 'Hooded Merganser', sciName: 'Lophodytes cucullatus', order: 'Anseriformes' }).onConflict('speciesCode').ignore()
  // A winter visitor: five months of last year's days in the county.
  const days = []
  for (const m of ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']) for (const d of ['03', '10', '17', '24']) days.push({ region: 'US-GA-139', day: `${m}-${d}`, speciesCode: 'hoomer' })
  await db('region_species_days').insert(days).onConflict().ignore()
  // Checklists this fortnight: the cove birded six times, the merganser on four; the dam birded twice, once with it.
  const lists = []
  for (let i = 0; i < 6; i += 1) lists.push({ sub_id: `SC${i}`, region: 'US-GA-139', loc_id: 'LCOVE', loc_name: 'Quiet Cove', lat: 34.31, lng: -83.82, obs_day: `2026-10-${20 + (i % 5)}`, obs_time: '07:30', num_species: 10, detail_fetched_at: new Date() })
  for (let i = 0; i < 2; i += 1) lists.push({ sub_id: `SD${i}`, region: 'US-GA-139', loc_id: 'LDAM', loc_name: 'The Dam', lat: 34.2, lng: -83.9, obs_day: `2026-10-2${i}`, obs_time: '16:00', num_species: 8, detail_fetched_at: new Date() })
  await db('checklists').insert(lists).onConflict('sub_id').ignore()
  await db('checklist_species').insert([
    ...[0, 1, 2, 3].map((i) => ({ sub_id: `SC${i}`, species_code: 'hoomer', how_many: 3, comments: i === 3 ? 'Back of the cove by the beaver lodge' : null })),
    { sub_id: 'SD0', species_code: 'hoomer', how_many: 1 }
  ]).onConflict(['sub_id', 'species_code']).ignore()
  ebird.notableObservations = async () => []
  ebird.speciesObservations = async () => [{ speciesCode: 'hoomer', locId: 'LDAM', locName: 'The Dam', obsDt: '2026-10-25 16:40', lat: 34.2, lng: -83.9, subId: 'SLIVE' }]

  const result = await whereToFind('US-GA-139', 'hoomer', { asOf })
  assert.equal(result.class, 'seasonal')
  assert.equal(result.halfLifeDays, 10)
  assert.equal(result.bestTime.source, 'reports')
  assert.equal(result.bestTime.label, '6 am to 8 am')
  assert.deepEqual(result.places.map((p) => p.locId), ['LCOVE', 'LDAM'])
  const [cove, dam] = result.places
  assert.equal(cove.band, 'High')
  assert.deepEqual(cove.effort, { checklists: 6, withSpecies: 4, detection: 67 })
  assert.equal(cove.notes[0].text, 'Back of the cove by the beaver lodge')
  assert.equal(dam.lastSeen.day, '2026-10-25')
  assert.equal(dam.lastSeen.subId, 'SLIVE')
  assert.equal(dam.effort.detection, null)
  ebird.speciesObservations = async () => []
})

test('predictions are recorded once a day and graded a week later against the checklists that followed', async () => {
  const { recordPredictions, gradeDue, accuracy, dailyPass, speciesOfInterest } = require('../lib/grading')
  const asOf = '2026-10-01'
  await db('users').where({ id: userId }).update({ location: 'US-GA-139' })
  await db('birds').insert({ speciesCode: 'norcar', comName: 'Northern Cardinal', sciName: 'Cardinalis cardinalis' }).onConflict('speciesCode').ignore()
  const bird = await db('birds').where({ speciesCode: 'norcar' }).first()
  await db('saved_birds').insert({ speciesCode: 'norcar', user_id: userId, bird_id: bird.id }).onConflict(['user_id', 'bird_id']).ignore()
  // Only species reported here lately are worth a prediction.
  await db('region_species_days').insert([{ region: 'US-GA-139', day: '2026-09-28', speciesCode: 'norcar' }, { region: 'US-GA-139', day: '2026-09-28', speciesCode: 'hoomer' }]).onConflict().ignore()
  const interest = await speciesOfInterest('US-GA-139', new Set(['hoomer', 'nothere']), asOf)
  assert.ok(interest.includes('norcar') && interest.includes('hoomer'), interest.join(','))
  assert.ok(!interest.includes('nothere'), 'a species with no recent report is skipped')
  assert.equal(new Set(interest).size, interest.length, 'no duplicates')

  const result = { class: 'resident', places: [
    { locId: 'LA', band: 'High', score: 2.1, effort: { checklists: 5, detection: 80 } },
    { locId: 'LB', band: 'Fair', score: 0.5, effort: { checklists: 1, detection: null } },
    { locId: 'LC', band: 'Good', score: 1.3, effort: { checklists: 4, detection: 50 } }
  ] }
  assert.equal(await recordPredictions('US-GA-139', 'norcar', asOf, result), 3)
  assert.equal(await recordPredictions('US-GA-139', 'norcar', asOf, result), 3)
  assert.equal(Number((await db('place_predictions').where({ region: 'US-GA-139', species_code: 'norcar' }).count('* as n').first()).n), 3)

  // The week after: LA's first visit missed the cardinal and a later one found it (graded on the first,
  // the one visit a chance is about; an unopened list before it doesn't count); LB birded once without
  // it; LC never birded.
  const opened = new Date()
  await db('checklists').insert([
    { sub_id: 'SGAX', region: 'US-GA-139', loc_id: 'LA', loc_name: 'A', obs_day: '2026-10-02', num_species: 9 },
    { sub_id: 'SGA1', region: 'US-GA-139', loc_id: 'LA', loc_name: 'A', obs_day: '2026-10-03', num_species: 3, detail_fetched_at: opened },
    { sub_id: 'SGA2', region: 'US-GA-139', loc_id: 'LA', loc_name: 'A', obs_day: '2026-10-06', num_species: 3, detail_fetched_at: opened },
    { sub_id: 'SGB1', region: 'US-GA-139', loc_id: 'LB', loc_name: 'B', obs_day: '2026-10-05', num_species: 2, detail_fetched_at: opened },
    { sub_id: 'SGA0', region: 'US-GA-139', loc_id: 'LA', loc_name: 'A', obs_day: '2026-10-01', num_species: 1, detail_fetched_at: opened }
  ]).onConflict('sub_id').ignore()
  await db('checklist_species').insert([{ sub_id: 'SGA2', species_code: 'norcar', how_many: 1 }, { sub_id: 'SGA0', species_code: 'norcar', how_many: 1 }]).onConflict(['sub_id', 'species_code']).ignore()
  assert.equal(await gradeDue('2026-10-07'), 0, 'not due until a week has passed')
  assert.equal(await gradeDue('2026-10-08'), 3)
  const graded = Object.fromEntries((await db('place_predictions').where({ region: 'US-GA-139' }).select('loc_id', 'visits', 'outcome')).map((r) => [r.loc_id, [r.visits, r.outcome]]))
  assert.deepEqual(graded, { LA: [3, false], LB: [1, false], LC: [0, null] })
  const acc = await accuracy('US-GA-139', { asOf: '2026-10-08' })
  assert.deepEqual(acc, { High: { n: 1, hits: 0, rate: 0, enough: false }, Fair: { n: 1, hits: 0, rate: 0, enough: false } })

  // The daily pass runs once per day per region and grades what is due.
  let whereCalls = 0
  const where = async () => { whereCalls += 1; return { class: 'resident', places: [{ locId: 'LA', band: 'High', score: 1, effort: { checklists: 2, detection: 50 } }] } }
  const first = await dailyPass('US-GA-139', { where, asOf: '2026-10-08', notable: new Set() })
  assert.equal(first.region, 'US-GA-139')
  assert.ok(first.species >= 1 && first.predicted === first.species && first.recorded === first.species, JSON.stringify(first))
  assert.equal(first.graded, 0)
  // Done for the day: the notable feed (an eBird call) isn't even asked for.
  let notableAsked = 0
  const second = await dailyPass('US-GA-139', { where, asOf: '2026-10-08', notable: async () => { notableAsked += 1; return new Set() } })
  assert.deepEqual(second, { region: 'US-GA-139', skipped: true })
  assert.equal(notableAsked, 0)
  assert.equal(whereCalls, first.species)
  // Due the next day, it is asked for once; and grading out of time leaves the rest for the next pass.
  await recordPredictions('US-GA-139', 'norcar', '2026-10-02', result)
  const late = await dailyPass('US-GA-139', { where, asOf: '2026-10-09', notable: async () => { notableAsked += 1; return new Set() }, deadline: Date.now() - 1 })
  assert.equal(notableAsked, 1)
  assert.equal(late.graded, 0, 'past the deadline nothing is graded')
  assert.equal(await gradeDue('2026-10-09', { deadline: Date.now() - 1 }), 0)
  assert.equal(await gradeDue('2026-10-09'), 3, 'the next pass with time grades what was left')
})

test('public land near a point comes from eBird and OpenStreetMap once, then from the cache', async () => {
  const { nearbyPublic } = require('../lib/nearby')
  const { withFetch, jsonResponse } = require('./helpers')
  process.env.EBIRD_API_KEY = process.env.EBIRD_API_KEY || 'test'
  const calls = []
  const handler = (url) => {
    calls.push(url)
    if (url.includes('project-osrm.org')) return jsonResponse({ code: 'Ok', routes: [{ duration: 660, distance: 7725, legs: [{ duration: 660, distance: 7725 }], geometry: { type: 'LineString', coordinates: [[-83.869886, 34.37594], [-83.85, 34.378], [-83.83, 34.38]] } }] })
    if (url.includes('ebird.org')) return jsonResponse([
      { locId: 'L1', locName: 'Lake Lanier--Sardis Creek Park', lat: 34.40, lng: -83.90, numChecklistsAllTime: 80, numSpeciesAllTime: 103, latestObsDt: '2026-07-25 09:00' },
      { locId: 'L2', locName: 'Little River Park', lat: 34.38, lng: -83.83, numChecklistsAllTime: 1, numSpeciesAllTime: 23, latestObsDt: '2026-04-13 09:14' }
    ])
    return jsonResponse([
      { name: 'Sardis Creek Park', lat: '34.40', lon: '-83.90', category: 'leisure', type: 'park', display_name: 'Sardis Creek Park, Hall County' },
      { name: 'Wahoo Park', lat: '34.37', lon: '-83.86', category: 'leisure', type: 'park', display_name: 'Wahoo Park, Hall County' },
      { name: 'Some Street', lat: '34.37', lon: '-83.86', category: 'highway', type: 'residential', display_name: 'Some Street' },
      { name: '', lat: '34.36', lon: '-83.85', category: 'leisure', type: 'park', display_name: 'Hall County, Georgia' }
    ])
  }
  const first = await withFetch(handler, () => nearbyPublic(34.37594, -83.869886))
  assert.equal(calls.filter((u) => !u.includes('osrm')).length, 2)
  assert.equal(calls.filter((u) => u.includes('osrm')).length, 3, 'one drive per hotspot and park')
  assert.deepEqual(first.hotspots[0].drive, { minutes: 11, miles: 4.8, geometry: [[34.37594, -83.86989], [34.378, -83.85], [34.38, -83.83]] })
  assert.deepEqual(first.hotspots.map((h) => [h.name, h.lightlyBirded, h.latest]), [['Little River Park', true, '2026-04-13'], ['Lake Lanier--Sardis Creek Park', false, '2026-07-25']])
  assert.ok(first.hotspots[0].miles < first.hotspots[1].miles)
  assert.deepEqual(first.parks.map((p) => p.name), ['Wahoo Park'], 'a park that is also a hotspot appears once; non-parks and unnamed parks are dropped')
  const second = await withFetch(() => { throw new Error('should not fetch') }, () => nearbyPublic(34.3759, -83.8699))
  assert.deepEqual(second.parks.map((p) => p.name), ['Wahoo Park'])
  await assert.rejects(nearbyPublic(Number.NaN, 1), (e) => e.status === 400)
})

test('a drive is fetched once per point list and served from the cache after', async () => {
  const { drive } = require('../lib/routing')
  const { withFetch, jsonResponse } = require('./helpers')
  let calls = 0
  const stops = [{ lat: 34.1, lng: -83.9 }, { lat: 34.2, lng: -83.8 }, { lat: 34.3, lng: -83.7 }]
  const answer = () => { calls += 1; return jsonResponse({ code: 'Ok', routes: [{ duration: 1560, distance: 24140, legs: [{ duration: 420, distance: 8000 }, { duration: 1140, distance: 16140 }], geometry: { type: 'LineString', coordinates: [[-83.9, 34.1], [-83.8, 34.2], [-83.7, 34.3]] } }] }) }
  const first = await withFetch(answer, () => drive(stops))
  assert.deepEqual({ minutes: first.minutes, miles: first.miles, legs: first.legs }, { minutes: 26, miles: 15, legs: [{ minutes: 7, miles: 5 }, { minutes: 19, miles: 10 }] })
  const second = await withFetch(() => { throw new Error('should not fetch') }, () => drive(stops))
  assert.equal(second.minutes, 26)
  assert.equal(calls, 1)
  assert.equal(await withFetch(() => jsonResponse({ code: 'NoRoute' }), () => drive([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])), null, 'no route answers null')
  assert.equal(await drive([{ lat: 0, lng: 0 }]), null, 'one point is not a drive')
})

test('mail stops at the daily cap, bulk first, and counts what it held', async () => {
  const { reserveSend } = require('../lib/mailer')
  const saved = { cap: process.env.MAIL_DAILY_CAP, smtp: process.env.SMTP_URL }
  process.env.MAIL_DAILY_CAP = '4'
  delete process.env.SMTP_URL
  try {
    // A day of its own: other test files send mail against the same database at the same time.
    const day = '1999-01-01'
    for (let i = 0; i < 3; i += 1) await reserveSend(true, { day })
    await assert.rejects(reserveSend(true, { day }), (e) => e.code === 'MAIL_CAP', 'digests stop at 85% of the cap')
    await reserveSend(false, { day })
    await assert.rejects(reserveSend(false, { day }), (e) => e.code === 'MAIL_CAP', 'account mail stops at the cap')
    const row = await db('mail_counts').where({ day }).first()
    assert.deepEqual([row.sent, row.held], [4, 2])
  } finally {
    if (saved.cap === undefined) delete process.env.MAIL_DAILY_CAP; else process.env.MAIL_DAILY_CAP = saved.cap
    if (saved.smtp !== undefined) process.env.SMTP_URL = saved.smtp
  }
})

test('a digest out of time says there is more, and the next call sends', async () => {
  await db('users').where({ id: userId }).update({ alert_digest_email_enabled: true, email_confirmed: true, location: 'US-GA-139' })
  const sent = []
  const options = {
    kind: 'budgettest',
    preference: 'alert_digest_email_enabled',
    fetchSightings: async () => [{ speciesCode: 'cangoo', comName: 'Canada Goose', obsDt: '2026-10-26 08:00' }],
    select: async (_user, sightings) => sightings,
    send: async (user) => { sent.push(user.id) }
  }
  const first = await runDigest({ ...options, deadline: Date.now() - 1 })
  assert.equal(first.more, true)
  assert.equal(sent.length, 0)
  const second = await runDigest(options)
  assert.equal(second.more, false)
  assert.deepEqual(sent, [userId])
})

test('a refused mail sign-in ends the digest at the first send, logged once, nobody marked sent', async () => {
  await db('users').where({ id: userId }).update({ alert_digest_email_enabled: true, email_confirmed: true, location: 'US-GA-139' })
  let tries = 0
  const before = await db('error_log').where('where', 'mail down').count('* as n').first().then((r) => Number(r.n))
  const result = await runDigest({
    kind: 'maildowntest',
    preference: 'alert_digest_email_enabled',
    fetchSightings: async () => [{ speciesCode: 'cangoo', comName: 'Canada Goose', obsDt: '2026-11-04 08:00' }],
    select: async (_user, sightings) => sightings,
    send: async () => { tries += 1; throw Object.assign(new Error('Mail server refused the sign-in'), { code: 'MAIL_DOWN' }) }
  })
  assert.equal(tries, 1)
  assert.equal(result.mailDown, true)
  assert.equal(result.sent, 0)
  assert.equal(await db('digest_log').where({ kind: 'maildowntest' }).count('* as n').first().then((r) => Number(r.n)), 0, 'the next run sends to everyone')
  assert.equal(await db('error_log').where('where', 'mail down').count('* as n').first().then((r) => Number(r.n)), before + 1)
})

test('digest sends go out spaced apart; a gap that would overrun the call says there is more', async () => {
  await db('users').where({ id: userId }).update({ alert_digest_email_enabled: true, email_confirmed: true, location: 'US-GA-139' })
  const [{ id: other }] = await db('users').insert({ email: 'gap@example.com', password_hash: 'x', location: 'US-GA-139', alert_digest_email_enabled: true, email_confirmed: true }).returning('id')
  try {
    const at = []
    const options = {
      kind: 'gaptest',
      preference: 'alert_digest_email_enabled',
      fetchSightings: async () => [{ speciesCode: 'cangoo', comName: 'Canada Goose', obsDt: '2026-11-04 08:00' }],
      select: async (_user, sightings) => sightings,
      send: async () => { at.push(Date.now()) }
    }
    const whole = await runDigest({ ...options, gapMs: 40 })
    assert.equal(whole.sent, 2)
    assert.ok(at[1] - at[0] >= 40, 'the second waits its gap')
    await db('digest_log').where({ kind: 'gaptest' }).del()
    at.length = 0
    const short = await runDigest({ ...options, gapMs: 1000, deadline: Date.now() + 500 })
    assert.deepEqual([short.sent, short.more], [1, true], 'no wait past the deadline')
  } finally {
    await db('digest_log').where({ kind: 'gaptest' }).del()
    await db('users').where({ id: other }).del()
  }
})

test('one-click unsubscribe turns off that email from the token in the address', async () => {
  const handler = require('../api/auth/[action].js')
  const { signToken } = require('../lib/tokens')
  await db('users').where({ id: userId }).update({ rare_sightings_email_enabled: true })
  const token = signToken('unsubscribe', { sub: userId, emailType: 'rare_sightings_email_enabled' }, '1d')
  const res = { statusCode: 0, headers: {}, status (c) { this.statusCode = c; return this }, json (b) { this.body = b; return this }, setHeader (k, v) { this.headers[k] = v } }
  await handler({ method: 'POST', query: { action: 'one-click', token }, body: 'List-Unsubscribe=One-Click', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  assert.equal((await db('users').where({ id: userId }).first()).rare_sightings_email_enabled, false)
  const bad = { ...res, statusCode: 0 }
  await handler({ method: 'POST', query: { action: 'one-click', token: 'nope' }, body: '', headers: {} }, bad)
  assert.ok(bad.statusCode >= 400)
})

test('the hourly push out of time says where to resume', async () => {
  const { runPushAlerts } = require('../lib/pushAlerts')
  await db('users').where({ id: userId }).update({ push_watchlist_enabled: true, location: 'US-GA-139', push_quiet_start: null, push_quiet_end: null })
  if (!await db('push_subscriptions').where({ user_id: userId }).first()) {
    await db('push_subscriptions').insert({ user_id: userId, endpoint: 'https://push.example/budget', p256dh: 'k', auth: 'a' })
  }
  const keep = { recent: ebird.recentObservations, notable: ebird.notableObservations }
  ebird.recentObservations = async () => []
  ebird.notableObservations = async () => []
  try {
    const partial = await runPushAlerts({ send: async () => ({ sent: 0, gone: 0 }), deadline: Date.now() - 1 })
    assert.equal(partial.more, true)
    assert.equal(partial.next, userId - 1)
    const done = await runPushAlerts({ send: async () => ({ sent: 0, gone: 0 }), after: partial.next })
    assert.equal(done.more, false)
  } finally {
    ebird.recentObservations = keep.recent
    ebird.notableObservations = keep.notable
  }
})

test('the strict health check fails once errors pile up', async () => {
  const health = require('../api/index')
  const { fakeReq, fakeRes } = require('./helpers')
  const { reportError } = require('../lib/errors')
  let res = fakeRes()
  await health(fakeReq({ query: { strict: '1' } }), res)
  assert.equal(res.statusCode, 200)
  for (let i = 0; i < 5; i += 1) await reportError('GET /api/test', new Error('boom'))
  res = fakeRes()
  await health(fakeReq({ query: { strict: '1' } }), res)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.errors.by.find((e) => e.where === 'GET /api/test').count, 5)
  res = fakeRes()
  await health(fakeReq({ query: {} }), res)
  assert.equal(res.statusCode, 200, 'the plain check still answers ok')
})

test('a page view on a new county fetches only a few history days; the rest wait for the hourly pass', async () => {
  const keep = { hist: ebird.historicObservations, recent: ebird.recentObservations }
  let fetched = 0
  ebird.historicObservations = async () => { fetched += 1; return [] }
  ebird.recentObservations = async () => []
  try {
    await seasonality.arrivingSoon('US-NC-001', { day: '2026-10-26' })
    assert.equal(fetched, 4)
    await seasonality.arrivingSoon('US-NC-001', { day: '2026-10-26' })
    assert.equal(fetched, 8, 'each view adds a few more, never the whole month at once')
  } finally {
    ebird.historicObservations = keep.hist
    ebird.recentObservations = keep.recent
  }
})

test('hotspots are searched by every word typed, loaded once a week from eBird', async () => {
  const { searchHotspots } = require('../lib/placeSearch')
  let calls = 0
  const original = ebird.stateHotspots
  ebird.stateHotspots = async () => {
    calls += 1
    return [
      { locId: 'L1', locName: 'Yahoola Creek Park', subnational2Code: 'US-GA-187', lat: 34.53, lng: -83.96, numSpeciesAllTime: 74, numChecklistsAllTime: 32, latestObsDt: '2026-08-15 12:16' },
      { locId: 'L2', locName: 'Wimpy Mill Picnic Area at Yahoola Creek', subnational2Code: 'US-GA-187', lat: 34.55, lng: -83.98, numSpeciesAllTime: 57, numChecklistsAllTime: 16 },
      { locId: 'L3', locName: 'Chicopee Lake', subnational2Code: 'US-GA-139', lat: 34.25, lng: -83.85, numChecklistsAllTime: 300 },
      { locId: 'L4', locName: '100% Park_land', subnational2Code: 'US-GA-139', lat: 34.2, lng: -83.8, numChecklistsAllTime: 1 }
    ]
  }
  try {
    const found = await searchHotspots('GA', 'yahoola')
    assert.deepEqual(found.map((h) => h.locId), ['L1', 'L2'])
    assert.equal(found[0].county, 'US-GA-187')
    assert.equal(found[0].latest, '2026-08-15')
    assert.deepEqual((await searchHotspots('GA', 'creek yahoola picnic')).map((h) => h.locId), ['L2'])
    // LIKE wildcards never reach the query.
    assert.deepEqual(await searchHotspots('GA', '%_'), [])
    assert.deepEqual((await searchHotspots('GA', '100% park')).map((h) => h.locId), ['L4'])
    assert.equal(calls, 1)
    assert.deepEqual(await searchHotspots('GA', '  '), [])
  } finally { ebird.stateHotspots = original }
})

test('a saved route is kept per county and the start once, and each can be cleared', async () => {
  const { getRoute, putRoute } = require('../lib/savedRoutes')
  assert.deepEqual(await getRoute(userId, 'US-GA-139'), { region: 'US-GA-139', stops: null, start: null, updatedAt: null })
  const stops = [{ locId: 'L1', name: 'Chicopee Lake', lat: 34.25, lng: -83.85 }, { locId: null, name: 'Wahoo Park', lat: 34.3, lng: -83.8, note: 'not an eBird hotspot' }]
  const saved = await putRoute(userId, { region: 'US-GA-139', stops, start: { locId: null, name: 'Gainesville, Georgia', lat: 34.2979, lng: -83.8241 } })
  assert.deepEqual(saved.stops.map((s) => s.name), ['Chicopee Lake', 'Wahoo Park'])
  assert.equal(saved.stops[1].note, 'not an eBird hotspot')
  assert.equal(saved.start.name, 'Gainesville, Georgia')
  // Another county has its own stops but shares the start.
  const other = await getRoute(userId, 'US-GA-187')
  assert.equal(other.stops, null)
  assert.equal(other.start.name, 'Gainesville, Georgia')
  // Changing only the stops leaves the start alone, and the reverse.
  await putRoute(userId, { region: 'US-GA-139', stops: [stops[1], stops[0]] })
  assert.deepEqual((await getRoute(userId, 'US-GA-139')).stops.map((s) => s.name), ['Wahoo Park', 'Chicopee Lake'])
  await putRoute(userId, { region: 'US-GA-139', start: null })
  const cleared = await putRoute(userId, { region: 'US-GA-139', stops: null })
  assert.equal(cleared.stops, null)
  assert.equal(cleared.start, null)
  await assert.rejects(putRoute(userId, { region: 'nope!', stops: [] }), (error) => error.status === 400)
})

test('a life list starts from an import, grows by taps, and an import never removes', async () => {
  const { importLifeList, seenList, markSeen, unmarkSeen } = require('../lib/lifeList')
  await db('taxonomy_ref').insert([
    { species_code: 'tenwar', sci_name: 'Leiothlypis peregrina', com_name: 'Tennessee Warbler', category: 'species' },
    { species_code: 'musduc', sci_name: 'Cairina moschata', com_name: 'Muscovy Duck', category: 'species' }
  ])
  const original = ebird.fullTaxonomy
  ebird.fullTaxonomy = async () => { throw new Error('should use the stored taxonomy') }
  try {
    const csv = 'Category,Common Name,Scientific Name,Date,Exotic,Countable\nspecies,Tennessee Warbler,Leiothlypis peregrina,13 Oct 2026,,1\nspecies,Muscovy Duck,Cairina moschata,14 Sep 2025,X,0\n'
    const first = await importLifeList(userId, csv)
    assert.equal(first.added, 1)
    assert.equal(first.skipped.length, 1)
    await markSeen(userId, 'norcar')
    const again = await importLifeList(userId, csv)
    assert.deepEqual([again.added, again.already, again.total], [0, 1, 2])
    const list = await seenList(userId)
    assert.deepEqual(list.map((s) => [s.speciesCode, s.source]), [['norcar', 'tap'], ['tenwar', 'import']])
    assert.equal(list[1].comName, 'Tennessee Warbler', 'named from the taxonomy when the bird is not stored yet')
    assert.equal(list[1].firstSeen, '2026-10-13')
    await unmarkSeen(userId, 'norcar')
    assert.equal((await seenList(userId)).length, 1)
    // Marked seen here, then logged on eBird: the next import counts it as eBird's.
    await unmarkSeen(userId, 'tenwar')
    await markSeen(userId, 'tenwar')
    assert.equal((await seenList(userId))[0].source, 'tap')
    await importLifeList(userId, csv)
    assert.equal((await seenList(userId))[0].source, 'import')
  } finally { ebird.fullTaxonomy = original }
})

test('a share is made by a person, read by anyone, and capped per day', async () => {
  const { createShare, getShare } = require('../lib/shares')
  await db('birds').insert({ speciesCode: 'paibun', comName: 'Painted Bunting', sciName: 'Passerina ciris', birdImg: 'https://img.example/pb.jpg' }).onConflict('speciesCode').ignore()
  const made = await createShare(userId, { kind: 'sighting', speciesCode: 'paibun', comName: 'Fake Name', locName: 'Chicopee Lake', lat: 34.25, lng: -83.85, obsDt: '2026-10-27 08:10', subId: 'S123456' })
  assert.match(made.url, /\/share\/s\/[A-Za-z0-9]{10}$/)
  const read = await getShare(made.id)
  assert.equal(read.comName, 'Painted Bunting', 'the name comes from our birds, not the request')
  assert.equal(read.locName, 'Chicopee Lake')
  await assert.rejects(getShare('nope'), (e) => e.status === 404)
  // A view is a person opening it in the app: the share page's preview card and link previewers don't count.
  assert.equal((await db('shares').where({ id: made.id }).first()).views, 0, 'reading it for the preview card is not a view')
  const api = require('../api/ebird/[resource]')
  const { fakeReq, fakeRes } = require('./helpers')
  const open = async (userAgent) => api(fakeReq({ method: 'GET', query: { resource: 'share', id: made.id }, headers: { 'user-agent': userAgent } }), fakeRes())
  await open('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)')
  await open('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal((await db('shares').where({ id: made.id }).first()).views, 1, 'one person, not the previewer')
  await assert.rejects(createShare(userId, { kind: 'poem' }), (e) => e.status === 400)
  await db('shares').insert(Array.from({ length: 50 }, (_, i) => ({ id: `cap${String(i).padStart(4, '0')}`, kind: 'route', user_id: userId, payload: '{}' })))
  await assert.rejects(createShare(userId, { kind: 'route', stops: [{ name: 'x', lat: 1, lng: 1 }] }), (e) => e.status === 429)
})

test('signup can bring a county, /me renews the session, and passkey calls need a known origin', async () => {
  const auth = require('../api/auth/[action]')
  const { fakeReq, fakeRes } = require('./helpers')
  const signup = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'signup' }, body: { email: 'county@example.com', password: 'longenough1', state: 'GA', location: 'US-GA-139', source: { ref: 'l.instagram.com', landing: 'home', junk: 'x' } } }), signup)
  assert.equal(signup.statusCode, 201)
  assert.deepEqual([signup.body.state, signup.body.location, signup.body.hasPasskey], ['GA', 'US-GA-139', false])
  assert.equal(signup.body.signup_source, undefined, 'where they came from stays on the server')
  assert.deepEqual((await db('users').where({ email: 'county@example.com' }).first('signup_source')).signup_source, { ref: 'l.instagram.com', landing: 'home' })
  assert.equal(signup.body.password_hash, undefined)
  // A county from another state, or nonsense, is dropped rather than refused.
  const odd = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'signup' }, body: { email: 'odd@example.com', password: 'longenough1', state: 'NC', location: 'US-GA-139' } }), odd)
  assert.deepEqual([odd.statusCode, odd.body.location], [201, ''])

  const cookie = String(signup.headers['set-cookie']).split(';')[0]
  const me = fakeRes()
  await auth(fakeReq({ method: 'GET', query: { action: 'me' }, headers: { cookie } }), me)
  assert.equal(me.statusCode, 200)
  assert.match(String(me.headers['set-cookie']), /Max-Age=2592000/, 'a visit renews the session')

  const options = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'passkey-register-options' }, headers: { cookie, origin: 'http://localhost:3000' } }), options)
  assert.equal(options.statusCode, 200)
  assert.equal(options.body.options.rp.id, 'localhost')
  assert.equal(options.body.options.authenticatorSelection.residentKey, 'required')
  const foreign = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'passkey-login-options' }, headers: { origin: 'https://evil.example' } }), foreign)
  assert.equal(foreign.statusCode, 400)
  const unknown = fakeRes()
  const login = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'passkey-login-options' }, headers: { origin: 'http://localhost:3000' } }), login)
  await auth(fakeReq({ method: 'POST', query: { action: 'passkey-login' }, headers: { origin: 'http://localhost:3000' }, body: { token: login.body.token, response: { id: 'nope', response: {} } } }), unknown)
  assert.equal(unknown.statusCode, 401)
  assert.match(unknown.body.error, /isn’t on any account/)
})

test('feedback is kept, emailed with the sender as reply-to, and capped per day', async () => {
  const { sendFeedback, DAILY_LIMIT } = require('../lib/feedback')
  const user = await db('users').where({ id: userId }).first()
  assert.deepEqual(await sendFeedback(user, { kind: 'idea', message: '  Follow a hotspot, please!  ', page: '/settings' }, { userAgent: 'test' }), { ok: true })
  const [row] = await db('feedback').where({ user_id: userId })
  assert.deepEqual([row.kind, row.message, row.page, row.emailed], ['idea', 'Follow a hotspot, please!', '/settings', false], 'outside production the email is only simulated')
  assert.equal((await sendFeedback(user, { kind: 'weird', message: 'odd kind', page: 'javascript:alert(1)' })).ok, true)
  const odd = await db('feedback').where({ user_id: userId }).orderBy('id', 'desc').first()
  assert.deepEqual([odd.kind, odd.page], ['other', null])
  await assert.rejects(sendFeedback(user, { message: 'hi' }), (e) => e.status === 400)
  for (let i = 2; i < DAILY_LIMIT; i += 1) await sendFeedback(user, { message: `idea ${i}` })
  await assert.rejects(sendFeedback(user, { message: 'one too many' }), (e) => e.status === 429)
})

test('an unconfirmed account gets one reminder a day after signing up, and never another', async () => {
  const { runConfirmReminders } = require('../lib/confirmReminder')
  const now = new Date('2026-11-10T12:00:00Z')
  const hoursAgo = (h) => new Date(now.getTime() - h * 3600_000)
  // Other tests' accounts are made with today's real date, which drifts into this test's window: only these count.
  await db('users').where('email_confirmed', false).update({ email_confirmed: true })
  const [due] = await db('users').insert({ email: 'remind-me@example.com', password_hash: 'x', email_confirmed: false, created_at: hoursAgo(30) }).returning('id')
  await db('users').insert([
    { email: 'too-new@example.com', password_hash: 'x', email_confirmed: false, created_at: hoursAgo(5) },
    { email: 'too-old@example.com', password_hash: 'x', email_confirmed: false, created_at: hoursAgo(24 * 9) },
    { email: 'confirmed@example.com', password_hash: 'x', email_confirmed: true, created_at: hoursAgo(30) }
  ])
  const sent = []
  const send = async (user) => { sent.push(user.email) }
  assert.deepEqual(await runConfirmReminders({ send, now }), { due: 1, sent: 1 })
  assert.deepEqual(sent, ['remind-me@example.com'])
  assert.ok(await db('digest_log').where({ user_id: due.id ?? due, kind: 'confirm-reminder' }).first())
  // An hour later: nothing more. The next day only the account that was too new then gets its one.
  assert.deepEqual(await runConfirmReminders({ send, now: new Date(now.getTime() + 3600_000) }), { due: 0, sent: 0 })
  assert.deepEqual(await runConfirmReminders({ send, now: new Date(now.getTime() + 86400_000) }), { due: 1, sent: 1 })
  assert.deepEqual(sent, ['remind-me@example.com', 'too-new@example.com'])
  sent.length = 0
  // A failed send isn't logged, so the next run tries again.
  await db('users').insert({ email: 'flaky@example.com', password_hash: 'x', email_confirmed: false, created_at: hoursAgo(26) })
  assert.deepEqual(await runConfirmReminders({ send: async () => { throw new Error('SMTP down') }, now }), { due: 1, sent: 0 })
  assert.deepEqual(await runConfirmReminders({ send, now }), { due: 1, sent: 1 })
  assert.deepEqual(sent, ['flaky@example.com'])
})

test('the HQ desk stores its picks, makes share links, emails them, and never pitches a bird twice in a row', async () => {
  const { runHqDesk } = require('../lib/hqDesk')
  const noCheck = async () => null
  await db('birds').insert({ speciesCode: 'anhing', comName: 'Anhinga', sciName: 'Anhinga anhinga', birdImg: 'https://img.example/anhinga.jpg' }).onConflict('speciesCode').ignore()
  const records = Array.from({ length: 6 }, (_, i) => ({ speciesCode: 'anhing', comName: 'Anhinga', sciName: 'Anhinga anhinga', subnational1Code: 'US-NJ', subnational1Name: 'New Jersey', subnational2Name: 'Burlington', locId: 'L1', locName: 'Laurel Acres Park', lat: 39.9, lng: -74.9, obsDt: '2026-10-26 08:00', subId: `S${i}`, userDisplayName: `B${i}`, obsValid: true, obsReviewed: true, locationPrivate: false }))
  const mails = []
  process.env.FEEDBACK_TO = 'hq@example.com'
  try {
    const first = await runHqDesk({ asOf: '2026-10-27', records, check: noCheck, send: async (m) => { mails.push(m); return {} } })
    assert.deepEqual([first.picks, first.considered], [1, 6])
    assert.equal(mails[0].to, 'hq@example.com')
    assert.match(mails[0].text, /Anhinga in New Jersey/)
    assert.match(mails[0].text, /\/share\/s\/[A-Za-z0-9]{10}/)
    const [row] = await db('hq_picks').where({ species_code: 'anhing' })
    assert.ok(row.share_id)
    const share = await db('shares').where({ id: row.share_id }).first()
    assert.equal(share.user_id, null)
    // A late scheduled run the same morning sends nothing more; a forced one sends again.
    assert.equal((await runHqDesk({ asOf: '2026-10-27', records, check: noCheck, send: async (m) => { mails.push(m); return {} } })).skipped, 'already sent today')
    assert.equal(mails.length, 1)
    await runHqDesk({ asOf: '2026-10-27', records, check: noCheck, force: true, send: async (m) => { mails.push(m); return {} } })
    assert.equal(mails.length, 2)
    mails.pop()
    // A bird three checklists since have missed is left out, and the email says so; two misses aren't enough.
    await db('birds').insert({ speciesCode: 'gocspa', comName: 'Golden-crowned Sparrow', sciName: 'Zonotrichia atricapilla' }).onConflict('speciesCode').ignore()
    const sparrows = Array.from({ length: 4 }, (_, i) => ({ ...records[0], speciesCode: 'gocspa', comName: 'Golden-crowned Sparrow', locId: 'L2', locName: 'Palmyra Cove', subId: `G${i}` }))
    const gone = async ({ code }) => ({ verdict: code === 'gocspa' ? 'gone' : 'fresh', checkedSince: 3, foundSince: 0, missesSince: 3 })
    const ran = await runHqDesk({ asOf: '2026-11-15', records: sparrows, check: gone, send: async (m) => { mails.push(m); return {} } })
    assert.deepEqual([ran.picks, ran.gone], [0, 1])
    assert.equal(mails.length, 2, 'nothing to pitch, but the app numbers still go out')
    const quiet = mails.pop()
    assert.match(quiet.subject, /no rarities for 2026-11-15, app numbers inside/)
    assert.match(quiet.html, /App, last 24 hours/)
    const twoMisses = async () => ({ verdict: 'gone', checkedSince: 2, foundSince: 0, missesSince: 2 })
    assert.equal((await runHqDesk({ asOf: '2026-11-16', records: sparrows, check: twoMisses, send: async (m) => { mails.push(m); return {} } })).picks, 1)
    assert.match(mails.pop().html, /Still there\?<\/strong> probably gone · 0 of 2 checklists since had it/)
    // The next morning the same bird isn't pitched again.
    const second = await runHqDesk({ asOf: '2026-10-28', records, check: noCheck, send: async (m) => { mails.push(m); return {} } })
    assert.equal(second.picks, 0)
    assert.equal(mails.length, 2, 'nothing new to pitch: the app numbers alone')
    assert.match(mails.pop().subject, /no rarities/)
  } finally { delete process.env.FEEDBACK_TO }
})

test('an HQ rarity alert: a Code 4-5 bird goes to the owner at once with a post ready, a Code 6 report gets a heads-up, each once a week', async () => {
  const { runHqAlerts } = require('../lib/hqAlerts')
  const codes = { bySci: new Map([['Phylloscopus inornatus', 4], ['Anhinga anhinga', 1], ['Campephilus principalis', 6], ['Calidris pugnax', 3]]), byName: new Map() }
  const base = { subnational1Code: 'US-CA', subnational1Name: 'California', subnational2Name: 'San Mateo', lat: 37.52, lng: -122.5, obsDt: '2026-10-22 12:50', userDisplayName: 'A', locationPrivate: false }
  // Awaiting review (valid false, not reviewed) still counts: that's how a true rarity looks on day one.
  const warbler = { ...base, speciesCode: 'yebwar3', comName: 'Yellow-browed Warbler', sciName: 'Phylloscopus inornatus', locId: 'L77', locName: 'Rancho Corral de Tierra--Moss Beach area', subId: 'S900', obsValid: false, obsReviewed: false }
  const records = [
    warbler,
    // Rejected by reviewers: never.
    { ...warbler, subnational1Code: 'US-OR', subnational1Name: 'Oregon', subId: 'S901', obsReviewed: true },
    // A Code 3 waits for the morning desk.
    { ...base, speciesCode: 'ruff', comName: 'Ruff', sciName: 'Calidris pugnax', locId: 'L2', locName: 'Somewhere', subId: 'S902', obsValid: true, obsReviewed: true },
    // Code 6, in someone's yard: a heads-up, the place never named.
    { ...base, speciesCode: 'ivbwoo', comName: 'Ivory-billed Woodpecker', sciName: 'Campephilus principalis', subnational1Code: 'US-AR', subnational1Name: 'Arkansas', subnational2Name: 'Monroe', locId: 'L3', locName: '12 Private Lane', subId: 'S903', obsValid: false, obsReviewed: false, locationPrivate: true },
    // Mexico has no ABA codes.
    { ...warbler, subnational1Code: 'MX-BCN', subnational1Name: 'Baja California', subId: 'S904' }
  ]
  await db('birds').insert({ speciesCode: 'yebwar3', comName: 'Yellow-browed Warbler', sciName: 'Phylloscopus inornatus', birdImg: 'https://img.example/ybw.jpg' }).onConflict('speciesCode').ignore()
  const [{ id: owner }] = await db('users').insert({ email: 'Owner@example.com', password_hash: 'x' }).returning('id')
  const [{ id: someone }] = await db('users').insert({ email: 'someone@example.com', password_hash: 'x' }).returning('id')
  const pushes = []
  const mails = []
  const run = (now) => runHqAlerts({ records, codes, now, push: async (userId, payload) => { pushes.push({ userId, payload }); return { sent: 1 } }, send: async (m) => { mails.push(m); return {} } })
  process.env.FEEDBACK_TO = 'owner@example.com'
  try {
    const first = await run(new Date('2026-10-22T20:00:00Z'))
    assert.deepEqual([first.post, first.extinct, first.pushed, first.emailed], [1, 1, true, true])
    assert.deepEqual([...new Set(pushes.map((p) => p.userId))], [owner], 'the owner\'s devices only')
    assert.ok(!pushes.some((p) => p.userId === someone))
    const [code4, code6] = pushes.map((p) => p.payload)
    assert.equal(code4.title, '🚨 ABA Code 4: Yellow-browed Warbler in California')
    assert.match(code4.body, /Rancho Corral de Tierra – Moss Beach area, San Mateo Co\. · Oct 22, 12:50 PM · 1 checklist, awaiting review/)
    assert.match(code4.data.url, /\/share\/s\/[A-Za-z0-9]{10}$/)
    assert.match(mails[0].subject, /^HQ alert: ABA Code 4 Yellow-browed Warbler in California$/)
    // A Code 4 gets the mega drafts: the X post and one to copy for Facebook.
    assert.match(mails[0].html, /🚨 ABA CODE 4 · YELLOW-BROWED WARBLER in California!/)
    assert.match(mails[0].html, /Post on X/)
    assert.match(mails[0].html, /Copy for Facebook/)
    assert.match(mails[0].html, /🚨 An ABA Code 4 rarity in California: YELLOW-BROWED WARBLER/)
    assert.match(mails[0].html, /facebook\.com\/sharer\/sharer\.php\?u=/)
    // Its share keeps the mega card's details.
    const megaShare = await db('shares').whereRaw("payload->>'speciesCode' = 'yebwar3'").first('payload')
    assert.equal(megaShare?.payload?.card?.aba, 4)
    assert.equal(code6.title, '⚠️ Unconfirmed: Ivory-billed Woodpecker reported in Arkansas')
    assert.match(code6.body, /Almost certainly a misidentification/)
    assert.equal(code6.data.url, 'https://ebird.org/checklist/S903', 'no share page for a Code 6')
    assert.match(mails[1].subject, /^HQ heads-up: unconfirmed Ivory-billed Woodpecker report in Arkansas$/)
    assert.doesNotMatch(mails[1].html, /Post on X|\/share\/|Private Lane/)
    assert.equal(await db('shares').whereRaw("payload->>'speciesCode' = 'ivbwoo'").count('* as n').first().then((r) => Number(r.n)), 0)
    // Reported again the next day: already told this week.
    records.push({ ...warbler, subId: 'S905', obsDt: '2026-10-23 08:37', userDisplayName: 'B' })
    const again = await run(new Date('2026-10-23T18:00:00Z'))
    assert.deepEqual([again.post, again.extinct, pushes.length, mails.length], [0, 0, 2, 2])
    // A week on, it would be news again.
    assert.equal((await run(new Date('2026-10-30T21:00:00Z'))).post, 1)
    // The owner can sign in with another address than the desk mails: HQ_PUSH_EMAIL names that account.
    process.env.HQ_PUSH_EMAIL = 'someone@example.com'
    await db('hq_alerts').del()
    pushes.length = 0
    mails.length = 0
    await run(new Date('2026-10-30T22:00:00Z'))
    assert.deepEqual([...new Set(pushes.map((p) => p.userId))], [someone], 'pushes go to the named account')
    assert.ok(mails.every((m) => m.to === 'owner@example.com'), 'the email still goes to the desk\'s address')
  } finally {
    delete process.env.FEEDBACK_TO
    delete process.env.HQ_PUSH_EMAIL
    await db('hq_alerts').del()
    await db('users').whereIn('id', [owner, someone]).del()
  }
})

test('an HQ pick is posted only from its confirmation page, once, and a failed post can be retried', async () => {
  const { approvePost } = require('../lib/hqDesk')
  const { signToken } = require('../lib/tokens')
  const [pick] = await db('hq_picks').insert({ day: '2026-11-01', species_code: 'ruff', state: 'US-ME', score: 14, detail: JSON.stringify({ comName: 'Ruff', stateName: 'Maine', draft: '🚨 Ruff in Maine', intentUrl: 'https://x.com/intent/post?text=x' }) }).returning('id')
  const token = signToken('hq-post', { pick: pick.id }, 3600)
  const keys = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']
  keys.forEach((k) => { process.env[k] = 'test' })
  const original = globalThis.fetch
  const calls = []
  try {
    // Opening the link (or a scanner opening it) only shows the page, after asking X whose keys these are.
    globalThis.fetch = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify({ data: { username: 'BirdAlertHQ' } }), { status: 200 }) }
    const shown = await approvePost({ method: 'GET', token })
    assert.match(shown, /Posting as @BirdAlertHQ ✓/)
    assert.equal(calls.length, 1)
    assert.match(String(calls[0][0]), /users\/me$/)
    calls.length = 0
    globalThis.fetch = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify({ title: 'Forbidden' }), { status: 403 }) }
    assert.match(await approvePost({ method: 'POST', token }), /didn’t post/)
    assert.equal((await db('hq_picks').where({ id: pick.id }).first()).posted_at, null, 'a failure leaves it postable')
    globalThis.fetch = async (url, init) => { calls.push([url, init]); return new Response(JSON.stringify({ data: { id: '1850000000000000000' } }), { status: 201 }) }
    assert.match(await approvePost({ method: 'POST', token }), /Posted ✓/)
    assert.equal(JSON.parse(calls.at(-1)[1].body).text, '🚨 Ruff in Maine')
    assert.match(calls.at(-1)[1].headers.Authorization, /^OAuth /)
    assert.match(await approvePost({ method: 'POST', token }), /Already posted/)
    assert.equal(calls.length, 2, 'never posted twice')
    assert.equal((await db('hq_picks').where({ id: pick.id }).first()).post_id, '1850000000000000000')
    assert.match(await approvePost({ method: 'GET', token: 'forged' }), /expired/)
  } finally { globalThis.fetch = original; keys.forEach((k) => delete process.env[k]) }
})

test('setup is marked done once, and only true is accepted', async () => {
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  await db('users').where({ id: userId }).update({ onboarded_at: null })
  const user = await db('users').where({ id: userId }).first()
  const session = fakeRes(); createSession(session, user)
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const bad = fakeRes()
  await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { onboarded: false } }), bad)
  assert.equal(bad.statusCode, 400)
  const done = fakeRes()
  await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { onboarded: true } }), done)
  assert.equal(done.statusCode, 200)
  const first = done.body.onboarded_at
  assert.ok(first)
  const again = fakeRes()
  await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { onboarded: true } }), again)
  assert.equal(new Date(again.body.onboarded_at).getTime(), new Date(first).getTime(), 'the first time is kept')
})

test('a person can delete their account: everything kept for it goes, shared links stay unattributed, and the session ends', async () => {
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession, getSessionUser } = require('../lib/auth')
  const [{ id }] = await db('users').insert({ email: 'leaving@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('id')
  const [{ id: birdId }] = await db('birds').insert({ comName: 'Leaving Sparrow', sciName: 'Passer abiens', speciesCode: 'leaspa', category: 'species' }).returning('id')
  await db('saved_birds').insert({ user_id: id, speciesCode: 'leaspa', bird_id: birdId })
  await db('seen_birds').insert({ user_id: id, species_code: 'leaspa', source: 'manual' })
  await db('shares').insert({ id: 'leavingAbc', user_id: id, kind: 'sighting', payload: JSON.stringify({}) })
  await db('auth_throttle').insert({ key: 'login:leaving@example.com', attempts: 3, window_start: new Date() })
  await db('auth_throttle').insert({ key: 'login:other@example.com', attempts: 1, window_start: new Date() })
  const count = async (table, where) => Number((await db(table).where(where).count('* as n').first()).n)
  assert.equal(await count('saved_birds', { user_id: id }), 1)
  const user = await db('users').where({ id }).first()
  const session = fakeRes(); createSession(session, user)
  const cookie = String(session.headers['set-cookie']).split(';')[0]

  const unconfirmed = fakeRes()
  await userApi(fakeReq({ method: 'DELETE', headers: { cookie }, body: {} }), unconfirmed)
  assert.equal(unconfirmed.statusCode, 400, 'nothing goes without the confirmation')
  assert.ok(await db('users').where({ id }).first())

  const res = fakeRes()
  await userApi(fakeReq({ method: 'DELETE', headers: { cookie }, body: { confirm: 'delete' } }), res)
  assert.equal(res.statusCode, 204)
  assert.match(String(res.headers['set-cookie']), /Max-Age=0|Expires=Thu, 01 Jan 1970/i, 'the session cookie is cleared')
  assert.equal(await db('users').where({ id }).first(), undefined)
  assert.equal(await count('saved_birds', { user_id: id }), 0, 'the watch list goes with it')
  assert.equal(await count('seen_birds', { user_id: id }), 0, 'and the life list')
  assert.equal(await count('auth_throttle', { key: 'login:leaving@example.com' }), 0)
  assert.equal(await count('auth_throttle', { key: 'login:other@example.com' }), 1, 'someone else’s attempts are left alone')
  assert.equal((await db('shares').where({ id: 'leavingAbc' }).first()).user_id, null, 'a shared link stays up, unattributed')
  assert.equal(await getSessionUser(fakeReq({ headers: { cookie } })), null, 'the old cookie no longer signs anyone in')
})

test('the watch list follows the range: in range, or anywhere in the state, once, and never a county sighting twice', async () => {
  const ebird = require('../lib/ebird')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const originals = { recent: ebird.recentObservations, notable: ebird.notableObservations, geoRecent: ebird.geoRecent, info: ebird.regionInfo, subregions: ebird.subregions, provinces: ebird.provinces }
  // eBird's state feed names no county: the hotspot list knows the owl's, the state's county list names it,
  // and a yard nobody listed is just "in" the state.
  ebird.subregions = async () => [{ code: 'US-ZZ-009', name: 'Division No. 11' }]
  ebird.provinces = async () => [{ code: 'US-ZZ', name: 'Zedland' }]
  await db('hotspot_ref').insert({ loc_id: 'L1', state: 'ZZ', county: 'US-ZZ-009', name: 'Owl Field', lat: 35.9, lng: -84.1 }).onConflict('loc_id').merge()
  await db('birds').insert({ speciesCode: 'bkcchi', comName: 'Black-capped Chickadee', sciName: 'Poecile atricapillus', category: 'species' }).onConflict('speciesCode').ignore()
  const [{ id }] = await db('users').insert({ email: 'statewide@example.com', password_hash: 'x', location: 'US-ZZ-002', state: 'ZZ', push_notable_enabled: false, push_watchlist_enabled: true, range_mi: -1, push_quiet_start: null, push_quiet_end: null }).returning('id')
  await db('push_subscriptions').insert({ user_id: id, endpoint: 'https://push.example/statewide', p256dh: 'k', auth: 'a' })
  await db('birds').insert({ speciesCode: 'snoowl1', comName: 'Snowy Owl', sciName: 'Bubo scandiacus', category: 'species' }).onConflict('speciesCode').ignore()
  await db('birds').insert({ speciesCode: 'paibun', comName: 'Painted Bunting', sciName: 'Passerina ciris', category: 'species' }).onConflict('speciesCode').ignore()
  await db('saved_birds').insert([{ user_id: id, speciesCode: 'snoowl1' }, { user_id: id, speciesCode: 'paibun' }, { user_id: id, speciesCode: 'bkcchi' }])
  const owl = (subId, locId) => ({ speciesCode: 'snoowl1', comName: 'Snowy Owl', locId, locName: 'Owl Field', obsDt: '2026-10-30 08:00', lat: 35.9, lng: -84.1, subId })
  const yard = { speciesCode: 'bkcchi', comName: 'Black-capped Chickadee', locId: 'P9', locName: 'Backyard', obsDt: '2026-10-30 07:00', lat: 36.1, lng: -84.4, subId: 'Y1' }
  const bunting = { speciesCode: 'paibun', comName: 'Painted Bunting', locId: 'LB', locName: 'Feeder', obsDt: '2026-10-30 09:00', lat: 34.3, lng: -83.8, subId: 'B1', subnational2Code: 'US-ZZ-002', subnational2Name: 'Home' }
  let county = []
  let state = []
  const calls = { state: 0 }
  ebird.recentObservations = async (region) => { if (region === 'US-ZZ') { calls.state += 1; return state } return county }
  ebird.notableObservations = async () => []
  ebird.geoRecent = async () => [{ ...owl('G1', 'LG'), lat: 34.5, lng: -83.8, subnational2Code: 'US-ZZ-003', subnational2Name: 'Forsyth' }]
  // No home to measure from (the county center can't be had): the whole state still works, just without a distance.
  ebird.regionInfo = async () => { throw new Error('no center') }
  const sent = []
  const send = async (userId, payload) => { if (userId === id) sent.push(payload); return { sent: 1, gone: 0 } }
  try {
    // Anywhere in the state: the owl two hundred miles off. The bunting is the county's own, in both feeds: one alert.
    county = [bunting]
    state = [owl('S1', 'L1'), yard, { ...bunting, subnational2Code: undefined, subnational2Name: undefined }]
    await runPushAlerts({ send })
    assert.equal(calls.state, 1, 'one state feed per run')
    const text = sent.map((n) => `${n.title} | ${n.body}`).join('\n')
    assert.equal(sent.length, 1, text)
    assert.match(sent[0].body, /Snowy Owl · Owl Field · in Division No\. 11/)
    assert.match(sent[0].body, /Black-capped Chickadee · Backyard · in Zedland/, 'no county known: the state')
    assert.doesNotMatch(sent[0].body, /undefined|null/)
    assert.match(sent[0].body, /Painted Bunting · Feeder/)
    assert.doesNotMatch(sent[0].body, /Painted Bunting · Feeder · in /, 'the county bird is just nearby')
    assert.equal(await db('push_log').where({ user_id: id, speciesCode: 'paibun' }).count('* as n').first().then((r) => Number(r.n)), 1)

    // Next hour: nothing new, nothing sent.
    sent.length = 0
    await runPushAlerts({ send })
    assert.equal(sent.length, 0)

    // A distance: the watch list reaches the birds within it, past the county line, with how far.
    await db('push_log').where({ user_id: id }).del()
    await db('users').where({ id }).update({ range_mi: 30, home_lat: 34.3, home_lng: -83.8 })
    county = []
    state = []
    calls.state = 0
    await runPushAlerts({ send })
    assert.equal(calls.state, 0, 'no state feed for a distance')
    assert.equal(sent.length, 1)
    assert.match(sent[0].title, /Snowy Owl spotted 14 mi away!/)
    assert.match(sent[0].body, /Owl Field · 14 mi away in Forsyth/)

    // Just the county: nothing from beyond it.
    sent.length = 0
    await db('push_log').where({ user_id: id }).del()
    await db('users').where({ id }).update({ range_mi: 0 })
    await runPushAlerts({ send })
    assert.equal(sent.length, 0)
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, notableObservations: originals.notable, geoRecent: originals.geoRecent, regionInfo: originals.info, subregions: originals.subregions, provinces: originals.provinces })
    await db('hotspot_ref').where({ loc_id: 'L1' }).del()
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('push_log').where({ user_id: id }).del()
    await db('saved_birds').where({ user_id: id }).del()
    await db('push_subscriptions').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('the watch-list email follows the range too: a bird anywhere in the state, beside the county\'s own', async () => {
  const ebird = require('../lib/ebird')
  const { DIGESTS } = require('../lib/digests')
  const original = ebird.recentObservations
  const lists = { subregions: ebird.subregions, provinces: ebird.provinces }
  ebird.subregions = async () => []
  ebird.provinces = async () => []
  const [{ id }] = await db('users').insert({ email: 'statemail@example.com', password_hash: 'x', location: 'US-ZY-002', state: 'ZY', range_mi: -1, home_lat: 34.3, home_lng: -83.8 }).returning('id')
  await db('saved_birds').insert([{ user_id: id, speciesCode: 'snoowl1' }])
  const owl = { speciesCode: 'snoowl1', comName: 'Snowy Owl', locId: 'LO', locName: 'Owl Field', obsDt: '2026-10-30 08:00', lat: 35.3, lng: -83.8, subId: 'E1', subnational2Code: 'US-ZY-009', subnational2Name: 'Division No. 11' }
  ebird.recentObservations = async (region) => (region === 'US-ZY' ? [owl] : [])
  try {
    const user = await db('users').where({ id }).first()
    const rows = await DIGESTS.watchlist.select(user, [], { preview: true })
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].comName, rows[0].away.county, rows[0].away.miles], ['Snowy Owl', 'Division No. 11', 69])
    // Just the county: only the county's own.
    assert.equal((await DIGESTS.watchlist.select({ ...user, range_mi: 0 }, [], { preview: true })).length, 0)
  } finally {
    ebird.recentObservations = original
    Object.assign(ebird, lists)
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('saved_birds').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('the alert range is one of the offered distances, measured from a home spot or the county center', async () => {
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const user = await db('users').where({ id: userId }).first()
  const session = fakeRes(); createSession(session, user)
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const patch = async (body) => { const res = fakeRes(); await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body }), res); return res }
  assert.equal((await patch({ range_mi: 25 })).statusCode, 400)
  assert.equal((await patch({ range_mi: -2 })).statusCode, 400)
  const whole = await patch({ range_mi: -1 })
  assert.deepEqual([whole.statusCode, whole.body.range_mi], [200, -1], 'the whole state or province')
  assert.equal((await patch({ home_lat: 34.3 })).statusCode, 400, 'a point needs both halves')
  const ok = await patch({ range_mi: 15, home_lat: 34.3, home_lng: -83.8 })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual([ok.body.range_mi, ok.body.home_lat, ok.body.home_lng], [15, 34.3, -83.8])
  const back = await patch({ home_lat: null, home_lng: null, range_mi: 30 })
  assert.deepEqual([back.body.range_mi, back.body.home_lat, back.body.home_lng], [30, null, null], 'back to the county center')
})

test('each visit notes the platform and whether it is the installed app, at once when they change', async () => {
  const { platformOf, touchLastSeen } = require('../lib/users')
  assert.equal(platformOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15'), 'ios')
  assert.equal(platformOf('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131'), 'android')
  assert.equal(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605'), 'desktop')
  assert.equal(platformOf(''), null)
  const [{ id }] = await db('users').insert({ email: 'platform@example.com', password_hash: 'x' }).returning('id')
  await touchLastSeen(await db('users').where({ id }).first(), { platform: 'ios', installed: false })
  let row = await db('users').where({ id }).first()
  assert.deepEqual([row.last_platform, row.last_installed, Boolean(row.last_seen_at)], ['ios', false, true])
  // Added to the home screen a minute later: noted straight away, though the hour isn't up.
  await touchLastSeen(row, { platform: 'ios', installed: true })
  row = await db('users').where({ id }).first()
  assert.equal(row.last_installed, true)
  const { sanitizeUser } = require('../lib/users')
  assert.equal('last_platform' in sanitizeUser(row), false, 'not sent back to the app')
  await db('users').where({ id }).del()
})

test('the admin numbers: signups with their source, who opened the app, late jobs, and the database against its limit', async () => {
  const { adminStats, adminSection } = require('../lib/adminStats')
  const { touchLastSeen } = require('../lib/users')
  const [{ id }] = await db('users').insert({ email: 'admin-stats@example.com', password_hash: 'x', location: 'US-WA-033', state: 'WA', signup_source: JSON.stringify({ app: 'facebook' }) }).returning('id')
  const user = await db('users').where({ id }).first()
  await touchLastSeen(user)
  const seen = (await db('users').where({ id }).first()).last_seen_at
  assert.ok(seen, 'opening the app notes it')
  await touchLastSeen({ ...user, last_seen_at: seen })
  assert.equal((await db('users').where({ id }).first()).last_seen_at.getTime(), seen.getTime(), 'not again within the hour')
  await db('job_runs').where({ kind: 'push' }).del()
  await db('job_runs').insert({ kind: 'push', ran_at: new Date(Date.now() - 5 * 3_600_000), detail: null })
  const { EBIRD_THROTTLED } = require('../lib/adminStats')
  await db('error_log').insert({ where: EBIRD_THROTTLED, message: 'throttled' })
  await db('feedback').insert({ user_id: id, kind: 'idea', message: 'Could it show owls first?\nMore detail below.', page: '/' })
  await db('shares').insert({ id: 'adminStat1', user_id: id, kind: 'sighting', payload: JSON.stringify({}), views: 7 })
  // Signed up two days ago and opened the app today: one who came back.
  const [{ id: back }] = await db('users').insert({ email: 'came-back@example.com', password_hash: 'x', location: 'US-WA-033', state: 'WA', created_at: new Date(Date.now() - 2 * 86_400_000), last_seen_at: new Date(), email_confirmed: true, push_watchlist_enabled: true, alert_digest_email_enabled: false }).returning('id')
  await db('digest_log').insert({ user_id: back, kind: 'watchlist', sent_on: new Date().toISOString().slice(0, 10), alerts: 1 })
  const s = await adminStats()
  const mine = s.signups.find((u) => u.id === id)
  assert.equal(mine.source, 'facebook')
  assert.equal(mine.confirmed, false)
  assert.ok(s.totals.seen_day >= 1)
  assert.ok(s.topStates.some((r) => r.state === 'WA' && r.seen >= 1))
  assert.equal(s.jobs.find((j) => j.label.startsWith('Push')).late, true, 'five hours without a push run is late')
  assert.ok(s.db.bytes > 0 && s.db.limit === 512 * 1024 * 1024)
  const { html, text } = adminSection(s)
  assert.match(html, /new signup/)
  assert.match(html, /US-WA-033 · from facebook · not confirmed yet/)
  assert.match(html, /late: Push alerts \(hourly\)/)
  assert.match(text, /Database: \d+ MB of 512 MB/)
  assert.ok(s.ebird.throttled >= 1)
  assert.match(html, /⚠️ throttled \d+ times?/)
  assert.ok(s.ebird.gathering >= 1, 'US-WA-033 has no checklists on file')
  assert.ok(s.reach.returned >= 1)
  assert.ok(s.reach.fallback >= 1, 'a watch-list email to someone who never chose the digest is the fallback')
  assert.match(html, /Reaching people:.*confirmed overall/)
  assert.match(html, /idea: “Could it show owls first\?”/, 'feedback shows its first line')
  assert.ok(s.shares.people.today >= 1 && s.shares.people.views >= 7, 'a person\'s share counts as theirs')
  assert.ok(s.shares.hq, 'the HQ desk\'s links are counted on their own')
  assert.ok(s.platforms.length >= 1)
  assert.match(html, /<strong>Devices:<\/strong>/)
  await db('digest_log').where({ user_id: back }).del()
  await db('feedback').where({ user_id: id }).del()
  await db('shares').where({ id: 'adminStat1' }).del()
  await db('error_log').where({ where: EBIRD_THROTTLED }).del()
  await db('users').whereIn('id', [id, back]).del()
})

test('where to go in an area chosen minutes ago: no places, and it says nothing is on file yet', async () => {
  const { whereToGo } = require('../lib/whereToGo')
  const go = await whereToGo('CA-QC-BH', ['cangoo', 'killde'])
  assert.deepEqual(go.places, [])
  assert.deepEqual(go.onFile, { checklists: 0 })
})

test('best hotspots: ranked by species reported lately, birders\' way of counting, then checklists, with the best list', async () => {
  const { bestHotspots, parseDays, assertCounty } = require('../lib/bestHotspots')
  const region = 'US-ZZ-777'
  const asOf = '2026-10-31'
  await db('taxonomy_ref').insert([
    { species_code: 'duck', sci_name: 'Anatidae sp.', com_name: 'duck sp.', category: 'spuh' },
    { species_code: 'yerwar1', sci_name: 'Setophaga coronata coronata', com_name: 'Yellow-rumped Warbler (Myrtle)', category: 'issf', report_as: 'yerwar' }
  ]).onConflict('species_code').ignore()
  const list = (sub, loc, day, numSpecies, { detailed = true, hotspot = true, name = `Place ${loc}` } = {}) => ({
    sub_id: sub, region, loc_id: loc, loc_name: name, lat: 34.3, lng: -83.9, is_hotspot: hotspot, obs_day: day, obs_time: '08:00',
    num_species: numSpecies, detail_fetched_at: detailed ? new Date() : null
  })
  await db('checklists').insert([
    // L1: three species once the warbler's forms and the duck sp. are counted the birders' way; two lists.
    list('SBH1', 'L1', '2026-10-30', 4), list('SBH2', 'L1', '2026-10-28', 2),
    // L2: two species but three lists; one never opened (counts as a checklist, not for species).
    list('SBH3', 'L2', '2026-10-29', 2), list('SBH4', 'L2', '2026-10-29', 2), list('SBH5', 'L2', '2026-10-27', 9, { detailed: false }),
    // L3: only an unopened list: ranked last, species 0.
    list('SBH6', 'L3', '2026-10-30', 5, { detailed: false, name: 'Alpha Pond' }),
    // Out of the week, and a private spot: neither counts.
    list('SBH7', 'L1', '2026-10-05', 40), list('SBH8', 'L9', '2026-10-30', 30, { hotspot: false })
  ])
  await db('checklist_species').insert([
    ...['yerwar', 'yerwar1', 'norcar', 'duck'].map((code) => ({ sub_id: 'SBH1', species_code: code })),
    ...['norcar', 'blujay'].map((code) => ({ sub_id: 'SBH2', species_code: code })),
    ...['norcar', 'carwre'].map((code) => ({ sub_id: 'SBH3', species_code: code })),
    ...['norcar', 'carwre'].map((code) => ({ sub_id: 'SBH4', species_code: code })),
    ...['bkbplo', 'baleag'].map((code) => ({ sub_id: 'SBH7', species_code: code }))
  ])
  const week = await bestHotspots(region, 7, { asOf })
  assert.equal(week.since, '2026-10-25')
  assert.deepEqual(week.hotspots.map((h) => [h.locId, h.species, h.checklists]), [['L1', 3, 2], ['L2', 2, 3], ['L3', 0, 1]])
  assert.deepEqual(week.hotspots[0].bestList, { species: 4, subId: 'SBH1', day: '2026-10-30' })
  // The unopened list's count still makes it L2's best list.
  assert.equal(week.hotspots[1].bestList.subId, 'SBH5')
  assert.equal(week.hotspots[2].name, 'Alpha Pond')
  // On file counts the county's every list in the week, private spots too.
  assert.deepEqual(week.onFile, { checklists: 7, detailed: 5, firstDay: '2026-10-05' })
  // A month reaches the older list at L1: its two species join, and it's the best list.
  const month = await bestHotspots(region, 30, { asOf })
  assert.deepEqual(month.hotspots.map((h) => [h.locId, h.species]), [['L1', 5], ['L2', 2], ['L3', 0]])
  assert.equal(month.hotspots[0].bestList.subId, 'SBH7')
  assert.equal(parseDays(undefined), 7)
  assert.equal(parseDays('90'), 90)
  assert.throws(() => parseDays('14'), /days must be 7, 30 or 90/)
  assert.throws(() => assertCounty('US-GA'), /county/)
  assert.equal(assertCounty('CA-ON-OT'), 'CA-ON-OT')
  await db('checklists').where({ region }).del()
})

test('best hotspots for one bird: ranked by how reliably it was reported, a long record over a lucky list, its forms counted', async () => {
  const { bestHotspotsFor, wilsonLow } = require('../lib/bestHotspots')
  const ebird = require('../lib/ebird')
  const region = 'US-ZZ-778'
  const asOf = '2026-10-31'
  await db('taxonomy_ref').insert([
    { species_code: 'zzbun', sci_name: 'Passerina zz', com_name: 'Test Bunting', category: 'species' },
    { species_code: 'zzbun1', sci_name: 'Passerina zz east', com_name: 'Test Bunting (Eastern)', category: 'issf', report_as: 'zzbun' }
  ]).onConflict('species_code').ignore()
  const list = (sub, loc, day, { detailed = true } = {}) => ({
    sub_id: sub, region, loc_id: loc, loc_name: `Place ${loc}`, lat: 34.3, lng: -83.9, is_hotspot: true, obs_day: day, obs_time: '08:00',
    num_species: 10, detail_fetched_at: detailed ? new Date() : null
  })
  // L1: the bird on its only list. L2: on 8 of 10 opened lists (one as its eastern form), plus one never opened.
  // L3: three lists without it, so it isn't listed at all.
  const l2 = Array.from({ length: 10 }, (_, i) => list(`SBS2${i}`, 'L2', `2026-10-${String(20 + i).padStart(2, '0')}`))
  await db('checklists').insert([
    list('SBS1', 'L1', '2026-10-30'), ...l2, list('SBS2X', 'L2', '2026-10-30', { detailed: false }),
    list('SBS31', 'L3', '2026-10-30'), list('SBS32', 'L3', '2026-10-29'), list('SBS33', 'L3', '2026-10-28')
  ])
  await db('checklist_species').insert([
    { sub_id: 'SBS1', species_code: 'zzbun', how_many: 1 },
    ...l2.slice(0, 7).map((l) => ({ sub_id: l.sub_id, species_code: 'zzbun', how_many: 2 })),
    { sub_id: 'SBS27', species_code: 'zzbun1', how_many: 3 },
    ...['SBS31', 'SBS32', 'SBS33'].map((sub) => ({ sub_id: sub, species_code: 'norcar' }))
  ])
  assert.ok(wilsonLow(1, 1) < wilsonLow(8, 10))
  const month = await bestHotspotsFor(region, 30, 'zzbun', { asOf })
  assert.deepEqual(month.species, { code: 'zzbun', comName: 'Test Bunting' })
  assert.deepEqual(month.hotspots.map((h) => [h.locId, h.reports, h.detailed, h.checklists]), [['L2', 8, 10, 11], ['L1', 1, 1, 1]])
  assert.equal(month.hotspots[0].frequency, 0.8)
  // The latest list with it at L2 is the eastern form's, Oct 27, three of them.
  assert.deepEqual(month.hotspots[0].lastSeen, { day: '2026-10-27', subId: 'SBS27', howMany: 3 })
  assert.deepEqual(month.onFile, { checklists: 15, detailed: 14, firstDay: '2026-10-20' })
  const none = await bestHotspotsFor(region, 30, 'nobird1', { asOf })
  assert.deepEqual(none.hotspots, [])
  assert.deepEqual(none.species, { code: 'nobird1', comName: null })
  assert.throws(() => ebird.assertSpecies('not a code!'), /species code/)
  await db('checklists').where({ region }).del()
  await db('taxonomy_ref').whereIn('species_code', ['zzbun', 'zzbun1']).del()
})

test('a rare bird sent before review: one follow-up when eBird confirms it, none if rejected, never for Codes 1-2, never after a week', async () => {
  const { runReviewChecks } = require('../lib/reviewWatch')
  const [{ id }] = await db('users').insert({ email: 'review@example.com', password_hash: 'x', location: 'US-CA-081', state: 'CA', email_confirmed: true }).returning('id')
  const row = (over) => ({ user_id: id, speciesCode: 'yebwar', sub_id: 'S1', kind: 'notable', aba: 4, sighting_region: 'US-CA-081', loc_name: 'Rancho Corral de Tierra', review_state: 'pending', ...over })
  await db('push_log').insert([
    row({}),
    row({ speciesCode: 'rejected', sub_id: 'S2' }),
    row({ speciesCode: 'common', sub_id: 'S3', aba: 2 })
  ])
  await db('push_log').insert(row({ speciesCode: 'old', sub_id: 'S4', created_at: db.raw("now() - interval '8 days'") }))
  const feed = (reviewed) => [
    { speciesCode: 'yebwar', subId: 'S1', comName: 'Yellow-browed Warbler', locName: 'Rancho Corral de Tierra', obsDt: '2026-10-22 12:50', obsReviewed: reviewed, obsValid: reviewed },
    { speciesCode: 'common', subId: 'S3', comName: 'Common', obsReviewed: true, obsValid: true },
    { speciesCode: 'old', subId: 'S4', comName: 'Old', obsReviewed: true, obsValid: true }
  ]
  const keep = ebird.notableObservations
  const sent = []
  const send = async (userId, payload) => { sent.push([userId, payload.title]); return { sent: 1, gone: 0 } }
  try {
    // Still unreviewed: it waits; the report missing from the feed was rejected and is dropped quietly.
    ebird.notableObservations = async () => feed(false)
    const first = await runReviewChecks({ send })
    assert.deepEqual([first.pending, first.confirmed, first.dropped, sent.length], [2, 0, 1, 0])
    // Confirmed: told once, and only once.
    ebird.notableObservations = async () => feed(true)
    await runReviewChecks({ send })
    await runReviewChecks({ send })
    assert.deepEqual(sent, [[id, '✅ Now confirmed by eBird: Yellow-browed Warbler']])
    const states = Object.fromEntries((await db('push_log').where({ user_id: id }).select('speciesCode', 'review_state')).map((r) => [r.speciesCode, r.review_state]))
    assert.deepEqual(states, { yebwar: 'confirmed', rejected: 'dropped', common: 'pending', old: 'pending' }, 'Code 2 and week-old rows are never acted on')
    // Quiet hours hold a follow-up until they end.
    await db('push_log').insert(row({ sub_id: 'S5' }))
    await db('users').where({ id }).update({ push_quiet_start: 0, push_quiet_end: 24, timezone: 'UTC' })
    ebird.notableObservations = async () => [{ ...feed(true)[0], subId: 'S5' }]
    await runReviewChecks({ send })
    assert.equal(sent.length, 1, 'held for quiet hours')
    assert.equal((await db('push_log').where({ user_id: id, sub_id: 'S5' }).first()).review_state, 'pending')
  } finally {
    ebird.notableObservations = keep
    await db('push_log').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('strict alerts: a rare report waits for proof and then goes out once; watch list and everyone else unchanged', async () => {
  const { runPushAlerts } = require('../lib/pushAlerts')
  const { runReviewChecks } = require('../lib/reviewWatch')
  const { DIGESTS } = require('../lib/digests')
  const region = 'US-ZZ-077'
  const base = { password_hash: 'x', location: region, state: 'GA', push_notable_enabled: true, push_watchlist_enabled: true, range_mi: 0, push_quiet_start: null, push_quiet_end: null }
  const [{ id: strict }] = await db('users').insert({ ...base, email: 'strict@example.com', rare_alerts_need_proof: true }).returning('id')
  const [{ id: open }] = await db('users').insert({ ...base, email: 'open@example.com' }).returning('id')
  await db('push_subscriptions').insert([{ user_id: strict, endpoint: 'https://push.example/strict', p256dh: 'k', auth: 'a' }, { user_id: open, endpoint: 'https://push.example/open', p256dh: 'k', auth: 'a' }])
  for (const [speciesCode, comName] of [['zzowl', 'Strict Owl'], ['zzwren', 'Watched Wren'], ['zzgull', 'Late Gull']]) {
    await db('birds').insert({ speciesCode, comName, sciName: `${comName} sci`, category: 'species' }).onConflict('speciesCode').ignore()
  }
  await db('saved_birds').insert({ user_id: strict, speciesCode: 'zzwren', bird_id: (await db('birds').where({ speciesCode: 'zzwren' }).first('id')).id })
  const owl = (subId, birder) => ({ speciesCode: 'zzowl', comName: 'Strict Owl', locId: 'LO', locName: 'Owl Marsh', obsDt: '2026-10-31 08:00', lat: 34.3, lng: -83.8, subId, userDisplayName: birder, obsReviewed: false, obsValid: false })
  // The watched wren is rare here too: the person asked for it, so it is never held.
  const wren = { speciesCode: 'zzwren', comName: 'Watched Wren', locId: 'LW', locName: 'Wren Wood', obsDt: '2026-10-31 07:00', lat: 34.1, lng: -83.7, subId: 'W1', userDisplayName: 'Al', obsReviewed: false, obsValid: false }
  let notable = [owl('O1', 'Ann'), wren]
  const keep = { recent: ebird.recentObservations, notable: ebird.notableObservations }
  ebird.recentObservations = async () => [wren]
  ebird.notableObservations = async () => notable
  const sent = []
  const send = async (userId, payload) => { sent.push([userId, payload.title, payload.body]); return { sent: 1, gone: 0 } }
  const to = (userId, re) => sent.filter(([u, title]) => u === userId && re.test(title))
  try {
    // One birder, unreviewed: the open account hears at once; the strict one only about its watched wren.
    await runPushAlerts({ send })
    assert.equal(to(open, /Strict Owl/).length, 1)
    assert.equal(to(strict, /Strict Owl/).length, 0, 'held for proof')
    assert.ok(sent.some(([u, title, body]) => u === strict && /Watched Wren/.test(`${title} ${body}`)), 'watch list is never held')
    assert.equal((await db('push_log').where({ user_id: strict, speciesCode: 'zzowl' }).first()).review_state, 'held')
    // Still no proof next hour: still waiting, nothing sent.
    await runPushAlerts({ send })
    assert.equal(to(strict, /Strict Owl/).length, 0)
    // A second birder reports it: out it goes, once, saying why.
    notable = [owl('O1', 'Ann'), owl('O2', 'Bo'), wren]
    await runPushAlerts({ send })
    await runPushAlerts({ send })
    const late = to(strict, /Strict Owl/)
    assert.equal(late.length, 1, 'sent once the proof came, and only once')
    assert.match(late[0][2], /Unconfirmed: not yet reviewed · 2 birders$/)
    assert.equal(to(open, /Strict Owl/).length, 1, 'the open account was told the first time and not again')
    assert.equal(await db('push_log').where({ user_id: strict, review_state: 'held' }).count('* as n').first().then((r) => Number(r.n)), 0)

    // Proof that comes after the day's feed: the review pass releases it, once.
    await db('push_log').insert({ user_id: strict, speciesCode: 'zzgull', sub_id: 'G1', loc_id: 'LG', kind: 'notable', review_state: 'held', sighting_region: region, loc_name: 'Gull Beach' })
    const gull = (reviewed) => ({ speciesCode: 'zzgull', comName: 'Late Gull', locId: 'LG', locName: 'Gull Beach', obsDt: '2026-10-28 09:00', lat: 34.0, lng: -83.6, subId: 'G1', userDisplayName: 'Cy', obsReviewed: reviewed, obsValid: reviewed })
    ebird.notableObservations = async () => [gull(false)]
    assert.equal((await runReviewChecks({ send })).released, 0)
    ebird.notableObservations = async () => [gull(true)]
    assert.equal((await runReviewChecks({ send })).released, 1)
    await runReviewChecks({ send })
    const gullPush = to(strict, /Late Gull/)
    assert.equal(gullPush.length, 1)
    assert.match(gullPush[0][2], /Confirmed by eBird reviewer · 1 birder$/)
    assert.equal((await db('push_log').where({ user_id: strict, speciesCode: 'zzgull' }).first()).review_state, 'released')

    // The uncommon-sightings email shows a strict account only the reports with proof.
    await db('push_log').whereIn('user_id', [strict, open]).del()
    const rows = [
      { speciesCode: 'zzowl', subId: 'E1', evidence: { confirmed: false, media: null, birders: 1 } },
      { speciesCode: 'zzgull', subId: 'E2', evidence: { confirmed: true, media: null, birders: 1 } },
      { speciesCode: 'zzwren', subId: 'E3' }
    ]
    const strictUser = await db('users').where({ id: strict }).first()
    const openUser = await db('users').where({ id: open }).first()
    assert.deepEqual((await DIGESTS.rare.select(strictUser, rows)).map((o) => o.subId).sort(), ['E2', 'E3'])
    assert.equal((await DIGESTS.rare.select(openUser, rows)).length, 3)
  } finally {
    Object.assign(ebird, { recentObservations: keep.recent, notableObservations: keep.notable })
    await db('push_log').whereIn('user_id', [strict, open]).del()
    await db('saved_birds').where({ user_id: strict }).del()
    await db('push_subscriptions').whereIn('user_id', [strict, open]).del()
    await db('users').whereIn('id', [strict, open]).del()
  }
})

test('areas anywhere eBird covers: lists are kept, a point or a town becomes an area (never kept), and saves are checked', async () => {
  const areas = require('../lib/areas')
  const placeSearch = require('../lib/placeSearch')
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const saved = { ...ebird }
  const savedSearch = placeSearch.searchAddresses
  const calls = { countries: 0, near: [] }
  ebird.countries = async () => { calls.countries += 1; return [{ code: 'GB', name: 'United Kingdom' }, { code: 'AU', name: 'Australia' }] }
  ebird.provinces = async (country) => country === 'AU' ? [{ code: 'AU-ACT', name: 'Australian Capital Territory' }] : [{ code: 'GB-ENG', name: 'England' }]
  ebird.subregions = async (state) => state === 'AU-ACT' ? [] : [{ code: 'GB-ENG-LND', name: 'London' }, { code: 'GB-ENG-KEN', name: 'Kent' }]
  ebird.regionInfo = async (code) => ({ result: code === 'GB-ENG-LND' ? 'London, England, United Kingdom' : 'Kent, England, United Kingdom' })
  // Nothing within 5 km of the point; London's hotspots within 15, the nearest first.
  ebird.hotspotsNear = async (lat, lng, km) => {
    calls.near.push(km)
    return km < 15 ? [] : [
      { locId: 'L2', countryCode: 'GB', subnational1Code: 'GB-ENG', subnational2Code: 'GB-ENG-KEN', lat: lat + 0.1, lng },
      { locId: 'L1', countryCode: 'GB', subnational1Code: 'GB-ENG', subnational2Code: 'GB-ENG-LND', lat: lat + 0.01, lng }
    ]
  }
  process.env.EBIRD_API_KEY = 'test-key'
  try {
    assert.deepEqual(await areas.countries(), [{ code: 'GB', name: 'United Kingdom' }, { code: 'AU', name: 'Australia' }])
    await areas.countries()
    assert.equal(calls.countries, 1, 'the list is kept, not asked for again')
    assert.deepEqual(await areas.provincesOf('GB'), [{ code: 'GB-ENG', region: 'GB-ENG', name: 'England' }])
    // Where eBird has no counties, the province is the one area.
    assert.deepEqual(await areas.areasOf('AU-ACT'), [{ code: 'AU-ACT', name: 'Australian Capital Territory', whole: true }])

    const area = await areas.areaAt(51.5, -0.12)
    assert.deepEqual(calls.near, [5, 15], 'it widens until hotspots are near')
    assert.deepEqual(area, { location: 'GB-ENG-LND', state: 'GB-ENG', country: 'GB', name: 'London', label: 'London, England, United Kingdom', countyWord: 'county' })
    const kept = await db('nearby_cache').select('key')
    assert.ok(kept.every((r) => !/51\.5|0\.12/.test(r.key)), 'the point itself is never kept')

    placeSearch.searchAddresses = async (q, { countries }) => {
      assert.equal(countries, null, 'towns anywhere')
      return [{ kind: 'address', name: 'Westminster', lat: 51.5, lng: -0.12 }, { kind: 'address', name: 'Soho', lat: 51.5, lng: -0.12 }]
    }
    assert.deepEqual((await areas.areaSearch('westminster')).map((a) => [a.location, a.place]), [['GB-ENG-LND', 'Westminster']], 'one row per area')

    // Saving: the county must sit in its state and be one eBird knows; people already set up are untouched.
    const [{ id }] = await db('users').insert({ email: 'abroad@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('id')
    const session = fakeRes(); createSession(session, await db('users').where({ id }).first())
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    const patch = async (body) => { const res = fakeRes(); await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body }), res); return res }
    assert.equal((await patch({ state: 'GB-ENG', location: 'GB-ENG-LND' })).statusCode, 200)
    assert.deepEqual(await db('users').where({ id }).first('state', 'location'), { state: 'GB-ENG', location: 'GB-ENG-LND' })
    assert.equal((await patch({ state: 'GA', location: 'GB-ENG-LND' })).statusCode, 400, 'not in that state')
    assert.equal((await patch({ state: 'GB-ENG', location: 'GB-ENG-XYZ' })).statusCode, 400, 'not an area eBird has')
    assert.equal((await patch({ state: 'AU-ACT', location: 'AU-ACT' })).statusCode, 200, 'a province standing in for its counties')
    // eBird unreachable: the shape is trusted rather than locking anyone out.
    ebird.subregions = async () => { throw new Error('eBird down') }
    await db('nearby_cache').where('key', 'like', 'areas:counties:%').del()
    assert.equal((await patch({ state: 'GA', location: 'US-GA-121' })).statusCode, 200)
    await db('users').where({ id }).del()
  } finally {
    Object.assign(ebird, saved)
    placeSearch.searchAddresses = savedSearch
    delete process.env.EBIRD_API_KEY
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
  }
})

test('languages: bird names come from eBird in the reader\'s language, the words from its catalog, and distances follow the country', async () => {
  const birdNames = require('../lib/birdNames')
  const { sightingNotification } = require('../lib/notifications')
  const { alertDigestMessage } = require('../lib/mailer')
  const { langFor } = require('../lib/i18n')
  const { createSession } = require('../lib/auth')
  const { fakeReq, fakeRes } = require('./helpers')
  const userApi = require('../api/user')
  const api = require('../api/ebird/[resource]')
  const saved = { fullTaxonomy: ebird.fullTaxonomy, notableObservations: ebird.notableObservations, recentObservations: ebird.recentObservations }
  let calls = 0
  ebird.fullTaxonomy = async (locale) => {
    calls += 1
    assert.equal(locale, 'es_MX', 'eBird is asked in its own code')
    return [{ speciesCode: 'vermfl', comName: 'Mosquero Cardenal' }, { speciesCode: 'norcar', comName: 'Cardenal Norteño' }]
  }
  birdNames.forget()
  try {
    // One whole-language call, kept: asking again reads it back.
    const named = await birdNames.localize([{ speciesCode: 'vermfl', comName: 'Vermilion Flycatcher' }, { speciesCode: 'zzz', comName: 'Unknown Bird' }], 'es-MX')
    assert.deepEqual(named[0], { speciesCode: 'vermfl', comName: 'Mosquero Cardenal', comNameEn: 'Vermilion Flycatcher' })
    assert.equal(named[1].comName, 'Unknown Bird', 'no translation, English stays')
    birdNames.forget()
    await birdNames.localize([], 'es-MX')
    assert.equal(calls, 1, 'read back from taxonomy_names, not asked of eBird again')
    assert.deepEqual(await birdNames.localize([{ speciesCode: 'vermfl', comName: 'Vermilion Flycatcher' }], 'en'), [{ speciesCode: 'vermfl', comName: 'Vermilion Flycatcher' }], 'English needs nothing')

    // The API: ?locale= names every bird; without it, English (the CDN caches by URL).
    ebird.notableObservations = async () => [{ speciesCode: 'vermfl', comName: 'Vermilion Flycatcher', locId: 'L1', subId: 'S1', obsDt: '2026-10-30 08:00', lat: 32, lng: -110 }]
    ebird.recentObservations = async () => []
    const spanish = fakeRes()
    await api(fakeReq({ query: { resource: 'notable', region: 'US-AZ-019', locale: 'es-MX' } }), spanish)
    assert.equal(spanish.body[0].comName, 'Mosquero Cardenal')
    const english = fakeRes()
    await api(fakeReq({ query: { resource: 'notable', region: 'US-AZ-019' } }), english)
    assert.equal(english.body[0].comName, 'Vermilion Flycatcher')
    const offered = fakeRes()
    await api(fakeReq({ query: { resource: 'name-locales' } }), offered)
    assert.deepEqual(offered.body.map((l) => l.locale), ['en', 'es-MX', 'fr-CA'])

    // A push to someone reading Spanish in Mexico: the bird and the words in Spanish, km.
    const reader = { locale: 'es-MX', state: 'SON' }
    const inSpanish = await birdNames.inLanguage(reader.locale)
    const push = sightingNotification(inSpanish({ kind: 'notable', speciesCode: 'vermfl', comName: 'Vermilion Flycatcher', subId: 'S1', locName: 'Río', obsDt: '2026-10-30 08:00', lat: 32, lng: -110, away: { miles: 12, county: 'Pima' } }), {}, langFor(reader))
    assert.equal(push.title, '❗ Notable: Mosquero Cardenal a 19 km')
    assert.match(push.body, /^Río · a 19 km, en Pima · /)

    // Units follow the country: miles in the US, km in Canada and everywhere else.
    assert.deepEqual([langFor({ state: 'GA' }).unit, langFor({ state: 'ON' }).unit, langFor({ state: 'ZA-WC' }).unit], ['mi', 'km', 'km'])
    const digest = alertDigestMessage({ id: 1, email: 'x@example.com', state: 'ON', alert_digest_email_enabled: true }, [{ speciesCode: 'norcar', comName: 'Northern Cardinal', subId: 'S2', locName: 'Pond', obsDt: '2026-10-30 08:00', lat: 43, lng: -79, away: { miles: 10, county: 'York' } }], new Map())
    assert.match(digest.text, /Pond \(16 km away in York\)/)

    // The setting: an offered locale, or null for English; it comes back with the user.
    const [{ id }] = await db('users').insert({ email: 'lingua@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('id')
    const session = fakeRes(); createSession(session, await db('users').where({ id }).first())
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    const patch = async (body) => { const res = fakeRes(); await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body }), res); return res }
    const ok = await patch({ locale: 'es-mx' })
    assert.deepEqual([ok.statusCode, ok.body.locale], [200, 'es-MX'])
    assert.equal((await patch({ locale: 'klingon' })).statusCode, 400)
    assert.equal((await patch({ locale: null })).body.locale, null)
    await db('users').where({ id }).del()
  } finally {
    Object.assign(ebird, saved)
    birdNames.forget()
    await db('taxonomy_names').del()
  }
})

// --- places and targets (lib/places), events (lib/events) -------------------------------------------

/** 'YYYY-MM-DD' n days from today, UTC (test users have no time zone, so UTC is their day). */
const dayFrom = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)

/**
 * A solo event as lib/events makes one from a place, straight into the tables so any dates go: the
 * place's area and targets, the person its organizer with no name chosen yet. `place.id` may be null.

 * Its days are UTC days (timezone 'UTC') unless given, so dayFrom's dates are the event's own at any
 * hour; lib/events judges an event's day in its own zone (the area's, from lib/timezones, otherwise).
 */
const eventAt = async (userId, place, fields = {}) => {
  const token = () => require('crypto').randomBytes(16).toString('base64url')
  const [event] = await db('events').insert({
    owner_id: userId, place_id: place.id ?? null, name: place.name, state: place.state, location: place.location, range_mi: place.range_mi ?? 30,
    home_lat: place.home_lat ?? null, home_lng: place.home_lng ?? null, kind: 'trip', scout: false, scout_days: 21, timezone: 'UTC', invite_token: token(), view_token: token(), ...fields
  }).returning('*')
  await db('event_members').insert({ event_id: event.id, user_id: userId, display_name: null, role: 'organizer' })
  const targets = place.id ? await db('place_targets').where({ place_id: place.id }).pluck('species_code') : []
  if (targets.length) await db('event_targets').insert(targets.map((code) => ({ event_id: event.id, species_code: code, added_by: userId })))
  return event
}

test('places are saved with their area, range, spot and targets; events planned from them, with dates; all within limits, and gone with the account', async () => {
  const places = require('../lib/places')
  const events = require('../lib/events')
  const [{ id }] = await db('users').insert({ email: 'places@example.com', password_hash: 'x', location: 'US-ZX-002', state: 'ZX' }).returning('id')
  const user = await db('users').where({ id }).first()
  const status = async (fn) => { try { await fn(); return 200 } catch (error) { return error.status } }
  try {
    const place = await places.createPlace(user, { name: ' Colorado (work) ', state: 'CO', location: 'US-CO-031' })
    assert.deepEqual([place.name, place.location, place.range_mi, place.targets, place.trips], ['Colorado (work)', 'US-CO-031', 30, [], []])
    assert.equal(await status(() => places.createPlace(user, { name: '', state: 'CO', location: 'US-CO-031' })), 400, 'a name')
    assert.equal(await status(() => places.createPlace(user, { name: 'x', state: 'CO', location: 'US-GA-139' })), 400, 'the area must be in its state')
    assert.equal(await status(() => places.createPlace(user, { name: 'x', state: 'CO', location: 'US-CO-031', range_mi: 25 })), 400, 'an offered distance')
    const moved = await places.updatePlace(user, place.id, { range_mi: -1, home_lat: 39.7, home_lng: -105 })
    assert.deepEqual([moved.range_mi, moved.home_lat], [-1, 39.7])
    assert.equal((await places.updatePlace(user, place.id, { location: 'US-CO-005', state: 'CO' })).home_lat, null, 'a new area drops the old spot')
    assert.equal(await status(() => places.updatePlace(user, place.id, { home_lat: 39.7 })), 400, 'a spot needs both halves')

    assert.deepEqual((await places.setTargets(user, place.id, ['paibun', 'paibun', 'lazbun'])).targets, ['lazbun', 'paibun'])
    assert.equal(await status(() => places.setTargets(user, place.id, Array.from({ length: 51 }, (_, i) => `sp${i}x`))), 400, 'up to 50')
    assert.equal(await status(() => places.setTargets(user, place.id, ['NOT A CODE'])), 400)

    // An event planned from the place: its name, area, range and targets, solo, with no links until a name is chosen.
    const trip = await events.createEvent(user, { place_id: place.id, starts_on: dayFrom(2), ends_on: dayFrom(5) })
    assert.deepEqual([trip.name, trip.location, trip.range_mi, trip.place_id, trip.starts_on, trip.ends_on, trip.kind, trip.scout, trip.active, trip.past, trip.archived, trip.role, trip.display_name, trip.invite_url],
      ['Colorado (work)', 'US-CO-005', -1, place.id, dayFrom(2), dayFrom(5), 'trip', false, false, false, false, 'organizer', null, null])
    assert.deepEqual(trip.targets.map((t) => [t.code, t.lifer_for, t.lifer_for_you]), [['lazbun', [], true], ['paibun', [], true]])
    assert.deepEqual(trip.members, [{ display_name: null, role: 'organizer', you: true }])
    // Fields given win over the place's.
    const elsewhere = await events.createEvent(user, { place_id: place.id, name: 'Denver weekend', state: 'CO', location: 'US-CO-031', range_mi: 15, starts_on: dayFrom(9), ends_on: dayFrom(10) })
    assert.deepEqual([elsewhere.name, elsewhere.location, elsewhere.range_mi, elsewhere.home_lat], ['Denver weekend', 'US-CO-031', 15, null])
    // With no place: the area given, nothing else; a Big Day is one day and scouts.
    const solo = await events.createEvent(user, { name: 'Big Sit', state: 'CO', location: 'US-CO-031', starts_on: dayFrom(3), ends_on: dayFrom(8), kind: 'bigday' })
    assert.deepEqual([solo.place_id, solo.range_mi, solo.starts_on, solo.ends_on, solo.scout, solo.scout_days, solo.targets], [null, 30, dayFrom(3), dayFrom(3), true, 21, []])
    assert.equal(await status(() => events.createEvent(user, { name: 'Nowhere', starts_on: dayFrom(3), ends_on: dayFrom(3) })), 400, 'somewhere')
    assert.equal(await status(() => events.createEvent(user, { name: 'x', state: 'CO', location: 'US-GA-139', starts_on: dayFrom(3), ends_on: dayFrom(3) })), 400, 'the area must be in its state')
    assert.equal(await status(() => events.createEvent(user, { place_id: place.id, starts_on: dayFrom(5), ends_on: dayFrom(2) })), 400, 'ends before it starts')
    assert.equal(await status(() => events.createEvent(user, { place_id: place.id, starts_on: dayFrom(1), ends_on: dayFrom(61) })), 400, 'over 60 days')
    assert.equal(await status(() => events.createEvent(user, { place_id: place.id, starts_on: dayFrom(-9), ends_on: dayFrom(-2) })), 400, 'already over')
    assert.equal(await status(() => events.createEvent(user, { place_id: place.id, starts_on: dayFrom(400), ends_on: dayFrom(401) })), 400, 'over a year ahead')
    assert.equal(await status(() => events.createEvent(user, { place_id: place.id, starts_on: dayFrom(2), ends_on: dayFrom(2), scout_days: 10 })), 400, 'a lead time on offer')
    assert.equal((await events.updateEvent(user, trip.id, { ends_on: dayFrom(6) })).ends_on, dayFrom(6))
    assert.deepEqual((await places.listPlaces(user))[0].trips, [], 'places carry no dates')

    // Someone else's place or event doesn't exist, as far as they're concerned.
    const [{ id: other }] = await db('users').insert({ email: 'places-other@example.com', password_hash: 'x' }).returning('id')
    const stranger = await db('users').where({ id: other }).first()
    assert.equal(await status(() => places.updatePlace(stranger, place.id, { name: 'mine' })), 404)
    assert.equal(await status(() => events.endEvent(stranger, trip.id)), 404)
    assert.equal(await status(() => events.createEvent(stranger, { place_id: place.id, starts_on: dayFrom(2), ends_on: dayFrom(2) })), 404)
    await db('users').where({ id: other }).del()

    // Up to ten places.
    for (let i = 1; i < places.MAX_PLACES; i += 1) await places.createPlace(user, { name: `Place ${i}`, state: 'CO', location: 'US-CO-031' })
    assert.equal(await status(() => places.createPlace(user, { name: 'One too many', state: 'CO', location: 'US-CO-031' })), 400)

    // "I'm here now" falls back to home when its place goes; a place takes its targets with it, and
    // the events planned from it stay, with their own.
    await db('users').where({ id }).update({ active_place_id: place.id })
    await places.deletePlace(user, place.id)
    assert.equal((await db('users').where({ id }).first()).active_place_id, null)
    assert.equal(Number((await db('place_targets').where({ place_id: place.id }).count('* as n').first()).n), 0)
    const kept = (await events.listEvents(user)).find((e) => e.id === trip.id)
    assert.deepEqual([kept.place_id, kept.targets.length], [null, 2])

    // Up to 50 upcoming and current events at a time; past ones don't count.
    await eventAt(id, { name: 'Long ago', state: 'CO', location: 'US-CO-031' }, { starts_on: dayFrom(-60), ends_on: dayFrom(-58) })
    const open = (await events.listEvents(user)).filter((e) => !e.past).length
    for (let i = open; i < events.MAX_OPEN; i++) await eventAt(id, { name: `Outing ${i}`, state: 'CO', location: 'US-CO-031' }, { starts_on: dayFrom(20), ends_on: dayFrom(20) })
    assert.equal(await status(() => events.createEvent(user, { name: 'One too many', state: 'CO', location: 'US-CO-031', starts_on: dayFrom(20), ends_on: dayFrom(20) })), 400)
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('users').where({ id }).del()
  }
  assert.equal(Number((await db('places').where({ user_id: id }).count('* as n').first()).n), 0, 'gone with the account')
})

test('the active place: an event covering today, else "I\'m here now", else home; dates in the person\'s own time zone', async () => {
  const places = require('../lib/places')
  const [{ id }] = await db('users').insert({ email: 'active-place@example.com', password_hash: 'x', location: 'US-ZX-002', state: 'ZX' }).returning('id')
  try {
    const user = await db('users').where({ id }).first()
    const work = await places.createPlace(user, { name: 'Colorado (work)', state: 'CO', location: 'US-CO-031' })
    const cabin = await places.createPlace(user, { name: 'Cabin', state: 'CO', location: 'US-CO-005' })
    assert.equal(await places.activePlaceOf(user), null, 'at home')

    await db('users').where({ id }).update({ active_place_id: cabin.id })
    let me = await db('users').where({ id }).first()
    assert.deepEqual(await places.activePlaceOf(me), { id: cabin.id, name: 'Cabin', state: 'CO', location: 'US-CO-005', via: 'manual' })

    // An event covering today wins over "I'm here now" (and is reported as the event, not a place);
    // its last day still counts, tomorrow's start doesn't.
    const trip = await eventAt(id, work, { starts_on: dayFrom(-3), ends_on: dayFrom(0) })
    assert.equal(await places.activePlaceOf(me), null)
    assert.deepEqual(await places.activeEventOf(me), { id: trip.id, name: 'Colorado (work)', state: 'CO', location: 'US-CO-031', kind: 'trip', starts_on: dayFrom(-3), ends_on: dayFrom(0) })
    await db('events').where({ id: trip.id }).update({ starts_on: dayFrom(1), ends_on: dayFrom(3) })
    assert.equal((await places.activePlaceOf(me)).via, 'manual', 'starts tomorrow: not yet')

    // Far east of UTC it may already be tomorrow for the member, but an event's day is its own zone's
    // (be#168; here UTC): it hasn't begun, whatever the hour.
    await db('users').where({ id }).update({ timezone: 'Pacific/Kiritimati', active_place_id: null })
    me = await db('users').where({ id }).first()
    assert.equal((await places.activeEventOf(me))?.id ?? null, null)
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('at a place its alerts come too (its targets only there), home keeps alerting unless turned off, and nothing is said twice', async () => {
  const ebird = require('../lib/ebird')
  const places = require('../lib/places')
  const events = require('../lib/events')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const originals = { recent: ebird.recentObservations, notable: ebird.notableObservations, subregions: ebird.subregions, info: ebird.regionInfo }
  ebird.subregions = async () => [{ code: 'US-ZW-009', name: 'Denver' }, { code: 'US-ZW-002', name: 'Home' }]
  ebird.notableObservations = async () => []
  ebird.regionInfo = async () => { throw new Error('no center') }
  for (const [speciesCode, comName] of [['snoowl1', 'Snowy Owl'], ['paibun', 'Painted Bunting'], ['lazbun', 'Lazuli Bunting']]) {
    await db('birds').insert({ speciesCode, comName, sciName: comName, category: 'species' }).onConflict('speciesCode').ignore()
  }
  const [{ id }] = await db('users').insert({ email: 'traveller@example.com', password_hash: 'x', location: 'US-ZW-002', state: 'ZW', push_watchlist_enabled: true, push_notable_enabled: false, range_mi: 0 }).returning('id')
  await db('push_subscriptions').insert({ user_id: id, endpoint: 'https://push.example/traveller', p256dh: 'k', auth: 'a' })
  await db('saved_birds').insert({ user_id: id, speciesCode: 'snoowl1' })
  const sighting = (speciesCode, comName, subId, locName) => ({ speciesCode, comName, locId: `L${subId}`, locName, obsDt: '2026-11-10 08:00', lat: 39.7, lng: -105, subId })
  // Home: a watched owl, and a Lazuli Bunting (a target at the place, not on the watch list).
  // The place: another owl, and the Lazuli Bunting.
  const feeds = {
    'US-ZW-002': [sighting('snoowl1', 'Snowy Owl', 'H1', 'Home Pond'), sighting('lazbun', 'Lazuli Bunting', 'H2', 'Home Pond')],
    'US-ZW-009': [sighting('snoowl1', 'Snowy Owl', 'P1', 'City Park'), sighting('lazbun', 'Lazuli Bunting', 'P2', 'City Park')]
  }
  ebird.recentObservations = async (region) => feeds[region] || []
  const sent = []
  const send = async (userId, payload) => { if (userId === id) sent.push(payload); return { sent: 1, gone: 0 } }
  const text = () => sent.map((n) => `${n.title} | ${n.body}`).join('\n')
  try {
    const user = await db('users').where({ id }).first()
    const work = await places.createPlace(user, { name: 'Colorado (work)', state: 'ZW', location: 'US-ZW-009', range_mi: 0 })
    await places.setTargets(user, work.id, ['lazbun'])
    // An event there that hasn't started: home only, and the place's target means nothing at home.
    const trip = await eventAt(id, work, { starts_on: dayFrom(2), ends_on: dayFrom(4) })
    await runPushAlerts({ send })
    assert.match(text(), /Snowy Owl/)
    assert.doesNotMatch(text(), /Lazuli|City Park/, text())

    // The event has begun: the owl there and its target, saying where and which event; home's owl is old news.
    sent.length = 0
    await db('events').where({ id: trip.id }).update({ starts_on: dayFrom(0), ends_on: dayFrom(2) })
    await runPushAlerts({ send })
    assert.match(text(), /Lazuli Bunting/)
    assert.match(text(), /City Park · in Denver \(Colorado \(work\)\)/, text())
    assert.doesNotMatch(text(), /Home Pond/, 'home said nothing new')
    assert.equal(await db('push_log').where({ user_id: id, speciesCode: 'lazbun', sub_id: 'H2' }).first(), undefined, 'the target never alerted at home')

    // Home turned off while away: a new home owl stays quiet, a new owl at the place doesn't.
    sent.length = 0
    await db('users').where({ id }).update({ keep_home_alerts: false })
    feeds['US-ZW-002'] = [sighting('snoowl1', 'Snowy Owl', 'H3', 'Home Pond')]
    feeds['US-ZW-009'] = [sighting('snoowl1', 'Snowy Owl', 'P3', 'City Park')]
    await runPushAlerts({ send })
    assert.match(text(), /City Park/)
    assert.doesNotMatch(text(), /Home Pond/)

    // An event in the home county: one alert for one bird, never two.
    sent.length = 0
    await db('push_log').where({ user_id: id }).del()
    await db('users').where({ id }).update({ keep_home_alerts: true })
    await events.updateEvent(user, trip.id, { state: 'ZW', location: 'US-ZW-002' })
    feeds['US-ZW-002'] = [sighting('snoowl1', 'Snowy Owl', 'H4', 'Home Pond')]
    await runPushAlerts({ send })
    assert.equal(sent.length, 1, text())
    assert.equal(Number((await db('push_log').where({ user_id: id, sub_id: 'H4' }).count('* as n').first()).n), 1)
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, notableObservations: originals.notable, subregions: originals.subregions, regionInfo: originals.info })
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('push_log').where({ user_id: id }).del()
    await db('events').where({ owner_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('the watch-list email puts the active place\'s birds under its name, after home\'s', async () => {
  const ebird = require('../lib/ebird')
  const places = require('../lib/places')
  const { DIGESTS } = require('../lib/digests')
  const { alertDigestMessage } = require('../lib/mailer')
  const originals = { recent: ebird.recentObservations, subregions: ebird.subregions }
  ebird.subregions = async () => [{ code: 'US-ZV-009', name: 'Denver' }]
  const [{ id }] = await db('users').insert({ email: 'place-digest@example.com', password_hash: 'x', location: 'US-ZV-002', state: 'ZV', email_confirmed: true, alert_digest_email_enabled: true, range_mi: 0 }).returning('id')
  await db('saved_birds').insert({ user_id: id, speciesCode: 'snoowl1' })
  const sighting = (speciesCode, comName, subId, locName) => ({ speciesCode, comName, locId: `L${subId}`, locName, obsDt: '2026-11-10 08:00', lat: 39.7, lng: -105, subId })
  ebird.recentObservations = async (region) => (region === 'US-ZV-002' ? [sighting('snoowl1', 'Snowy Owl', 'D1', 'Home Pond')] : [sighting('lazbun', 'Lazuli Bunting', 'D2', 'City Park')])
  const sends = []
  try {
    const user = await db('users').where({ id }).first()
    const work = await places.createPlace(user, { name: 'Colorado (work)', state: 'ZV', location: 'US-ZV-009', range_mi: 0 })
    await places.setTargets(user, work.id, ['lazbun'])
    await db('users').where({ id }).update({ active_place_id: work.id })
    await runDigest({ kind: 'watchlist', ...DIGESTS.watchlist, send: async (u, rows) => { if (u.id === id) sends.push(rows) } })
    assert.equal(sends.length, 1)
    assert.deepEqual(sends[0].map((r) => [r.comName, r.atPlace?.name ?? null]), [['Snowy Owl', null], ['Lazuli Bunting', 'Colorado (work)']])
    const html = alertDigestMessage(await db('users').where({ id }).first(), sends[0], new Map()).html
    assert.ok(html.indexOf('Home Pond') < html.indexOf('Colorado (work) · Denver'), 'home first, then the place under its name')
    assert.ok(html.indexOf('Colorado (work) · Denver') < html.indexOf('City Park'))
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, subregions: originals.subregions })
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('digest_log').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('suggested targets for a trip: what was reported there on those dates last year, steadiest first, never a bird already seen', async () => {
  const places = require('../lib/places')
  const seasonality = require('../lib/seasonality')
  const [{ id }] = await db('users').insert({ email: 'suggest@example.com', password_hash: 'x', location: 'US-ZU-002', state: 'ZU' }).returning('id')
  const area = 'US-ZU-009'
  const from = dayFrom(20)
  const to = dayFrom(22)
  // Last year's window around those dates, all on file, so nothing is asked of eBird.
  const days = seasonality.daysBetween(seasonality.addDays(seasonality.yearAgo(from), -5), seasonality.addDays(seasonality.yearAgo(to), 5))
  await db('region_days').insert(days.map((day) => ({ region: area, day, species_count: 1, has_locations: true }))).onConflict(['region', 'day']).ignore()
  // The window read is the trip's dates a year back, widened to a week: days[3]..days[9] here.
  const reported = (code, start, n) => days.slice(start, start + n).map((day) => ({ region: area, day, speciesCode: code }))
  await db('region_species_days').insert([...reported('lazbun', 0, 13), ...reported('wesmea', 5, 3), ...reported('cangoo', 0, 13), ...reported('duck1', 0, 13)]).onConflict(['region', 'day', 'speciesCode']).ignore()
  await db('taxonomy_ref').insert([
    { species_code: 'lazbun', sci_name: 'Passerina amoena', com_name: 'Lazuli Bunting', category: 'species' },
    { species_code: 'wesmea', sci_name: 'Sturnella neglecta', com_name: 'Western Meadowlark', category: 'species' },
    { species_code: 'cangoo', sci_name: 'Branta canadensis', com_name: 'Canada Goose', category: 'species' },
    { species_code: 'duck1', sci_name: 'Anatidae sp.', com_name: 'duck sp.', category: 'spuh' }
  ]).onConflict('species_code').ignore()
  await db('seen_birds').insert({ user_id: id, species_code: 'cangoo' })
  try {
    const user = await db('users').where({ id }).first()
    const place = await places.createPlace(user, { name: 'Colorado (work)', state: 'ZU', location: area })
    const found = await places.suggestTargets(user, place.id, { from, to })
    assert.deepEqual(found.suggestions.map((s) => s.speciesCode), ['lazbun', 'wesmea'], 'steadiest first; no goose (seen), no "duck sp."')
    assert.equal(found.suggestions[0].comName, 'Lazuli Bunting')
    assert.ok(found.suggestions[0].days > found.suggestions[1].days)
  } finally {
    await db('region_species_days').where({ region: area }).del()
    await db('region_days').where({ region: area }).del()
    await db('seen_birds').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('the API: places, targets and events by kind; trips are gone; "I\'m here now" and home alerts on the account; the active place and event with /me', async () => {
  const savedApi = require('../api/saved')
  const userApi = require('../api/user')
  const auth = require('../api/auth/[action]')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const [{ id }] = await db('users').insert({ email: 'places-api@example.com', password_hash: 'x', location: 'US-ZT-002', state: 'ZT' }).returning('id')
  const session = fakeRes(); createSession(session, await db('users').where({ id }).first())
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const call = async (api, method, query, body) => { const res = fakeRes(); await api(fakeReq({ method, headers: { cookie }, query, body }), res); return res }
  try {
    const made = await call(savedApi, 'POST', { kind: 'place' }, { name: 'Colorado (work)', state: 'ZT', location: 'US-ZT-009' })
    assert.equal(made.statusCode, 201)
    const pid = made.body.id
    assert.deepEqual((await call(savedApi, 'PUT', { kind: 'place-targets', id: String(pid) }, { codes: ['lazbun'] })).body.targets, ['lazbun'])
    const trip = await call(savedApi, 'POST', { kind: 'event' }, { place_id: pid, starts_on: dayFrom(0), ends_on: dayFrom(2) })
    assert.deepEqual([trip.statusCode, trip.body.active, trip.body.name, trip.body.targets.map((t) => t.code), trip.body.invite_url], [201, true, 'Colorado (work)', ['lazbun'], null])
    const list = await call(savedApi, 'GET', { kind: 'places' })
    assert.deepEqual([list.body.length, list.body[0].targets, list.body[0].trips], [1, ['lazbun'], []])
    assert.equal((await call(savedApi, 'PATCH', { kind: 'event', id: String(trip.body.id) }, { ends_on: dayFrom(-1) })).statusCode, 400)
    // Trips are events now.
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await call(savedApi, method, { kind: 'trip', id: '1' }, { place_id: pid, starts_on: dayFrom(1), ends_on: dayFrom(1) })).statusCode, 410)
    assert.equal((await call(savedApi, 'POST', { kind: 'event-from-trip' }, { trip_id: 1, display_name: 'Me' })).statusCode, 410)

    // Inviting asks for the name the group will see, then gives the links.
    const eid = String(trip.body.id)
    assert.equal((await call(savedApi, 'POST', { kind: 'event-invite-start', id: eid }, {})).statusCode, 400)
    const invite = await call(savedApi, 'POST', { kind: 'event-invite-start', id: eid }, { display_name: ' Matt ' })
    assert.equal(invite.body.display_name, 'Matt')
    assert.match(invite.body.invite_url, /\/events\/join\//)
    assert.match(invite.body.view_url, /\/events\/view\//)
    // Archiving is the person's own; suggestions are the event's likely lifers.
    assert.equal((await call(savedApi, 'PATCH', { kind: 'event-member', id: eid }, { archived: true })).body.archived, true)
    assert.equal((await call(savedApi, 'PATCH', { kind: 'event-member', id: eid }, { archived: 'yes' })).statusCode, 400)
    assert.equal((await call(savedApi, 'PATCH', { kind: 'event-member', id: eid }, { archived: false })).body.archived, false)
    const suggestions = await call(savedApi, 'GET', { kind: 'event-suggestions', id: eid, scope: 'place', limit: '5' })
    assert.deepEqual([suggestions.statusCode, suggestions.body.scope, suggestions.body.suggestions], [200, 'place', []])
    const listed = await call(savedApi, 'GET', { kind: 'events' })
    assert.deepEqual(listed.body.map((e) => [e.id, e.display_name, e.recap]), [[trip.body.id, 'Matt', { species: 0, targets_got: 0, targets_total: 1 }]])

    const me = await call(auth, 'GET', { action: 'me' })
    assert.deepEqual([me.body.activePlace, me.body.activeEvent.id, me.body.keep_home_alerts], [null, trip.body.id, true])
    assert.equal('lastTrip' in me.body, false)

    assert.equal((await call(userApi, 'PATCH', {}, { active_place_id: 999999 })).statusCode, 404, 'only one of their own places')
    const here = await call(userApi, 'PATCH', {}, { active_place_id: pid, keep_home_alerts: false })
    assert.deepEqual([here.statusCode, here.body.active_place_id, here.body.keep_home_alerts, here.body.activePlace], [200, pid, false, null], 'the event still wins')
    assert.equal((await call(userApi, 'PATCH', {}, { keep_home_alerts: 'no' })).statusCode, 400)
    assert.equal((await call(savedApi, 'DELETE', { kind: 'event', id: eid })).statusCode, 204)
    assert.equal((await call(auth, 'GET', { action: 'me' })).body.activePlace.via, 'manual')

    assert.equal((await call(savedApi, 'DELETE', { kind: 'place', id: String(pid) })).statusCode, 204)
    const after = await call(auth, 'GET', { action: 'me' })
    assert.equal(after.body.activePlace, null)
  } finally {
    await db('users').where({ id }).del()
  }
})

test('a place keeps its own seen list: edited by hand, added to by "Seen it" while there, and its lifers can count against it', async () => {
  const places = require('../lib/places')
  const savedApi = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const [{ id }] = await db('users').insert({ email: 'place-seen@example.com', password_hash: 'x', location: 'US-ZS-002', state: 'ZS' }).returning('id')
  const session = fakeRes(); createSession(session, await db('users').where({ id }).first())
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const call = async (method, query, body) => { const res = fakeRes(); await savedApi(fakeReq({ method, headers: { cookie }, query, body }), res); return res }
  const status = async (fn) => { try { await fn(); return 200 } catch (error) { return error.status } }
  try {
    const user = await db('users').where({ id }).first()
    const place = await places.createPlace(user, { name: 'Colorado (work)', state: 'ZS', location: 'US-ZS-009', lifers_scope: 'place' })
    assert.equal(place.lifers_scope, 'place')
    assert.equal(await status(() => places.updatePlace(user, place.id, { lifers_scope: 'state' })), 400)
    assert.deepEqual((await call('PUT', { kind: 'place-seen', id: String(place.id) }, { codes: ['lazbun', 'wesmea'] })).body, ['lazbun', 'wesmea'])
    assert.equal((await call('PUT', { kind: 'place-seen', id: String(place.id) }, { codes: Array.from({ length: 2001 }, (_, i) => `sp${i}x`) })).statusCode, 400, 'up to 2000')

    // At home, "Seen it" is the life list only; at the place, its own list too.
    await call('POST', { kind: 'seen' }, { speciesCode: 'mallar3' })
    assert.deepEqual(await places.placeSeen(user, place.id), ['lazbun', 'wesmea'])
    await db('users').where({ id }).update({ active_place_id: place.id })
    const seen = await call('POST', { kind: 'seen' }, { speciesCode: 'stejay' })
    assert.deepEqual([seen.statusCode, seen.body.placeId], [201, place.id])
    assert.deepEqual((await call('GET', { kind: 'place-seen', id: String(place.id) })).body, ['lazbun', 'stejay', 'wesmea'])
    assert.equal((await places.listPlaces(user))[0].seenCount, 3)
    // A hand edit keeps the day a bird was first seen there.
    await places.setPlaceSeen(await db('users').where({ id }).first(), place.id, ['stejay'])
    assert.notEqual((await db('place_seen').where({ place_id: place.id, species_code: 'stejay' }).first()).seen_on, null)

    // During an event planned from the place, "Seen it" goes on the place's list too; at one planned
    // from nowhere, the life list only.
    await db('users').where({ id }).update({ active_place_id: null })
    const there = await eventAt(id, place, { starts_on: dayFrom(0), ends_on: dayFrom(0) })
    assert.equal((await call('POST', { kind: 'seen' }, { speciesCode: 'moublu' })).body.placeId, place.id)
    assert.deepEqual(await places.placeSeen(user, place.id), ['moublu', 'stejay'])
    await db('events').where({ id: there.id }).update({ place_id: null })
    assert.equal((await call('POST', { kind: 'seen' }, { speciesCode: 'clanut' })).body.placeId, undefined)
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('seen_birds').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('lifers at a place count against the life list, or the place\'s own list when it says so; suggestions likewise', async () => {
  const ebird = require('../lib/ebird')
  const places = require('../lib/places')
  const seasonality = require('../lib/seasonality')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const originals = { recent: ebird.recentObservations, notable: ebird.notableObservations, subregions: ebird.subregions, info: ebird.regionInfo }
  ebird.subregions = async () => [{ code: 'US-ZR-009', name: 'Denver' }]
  ebird.notableObservations = async () => []
  ebird.regionInfo = async () => { throw new Error('no center') }
  await db('birds').insert({ speciesCode: 'stejay', comName: "Steller's Jay", sciName: 'Cyanocitta stelleri', category: 'species' }).onConflict('speciesCode').ignore()
  const [{ id }] = await db('users').insert({ email: 'place-lifers@example.com', password_hash: 'x', location: 'US-ZR-002', state: 'ZR', push_lifer_enabled: true, push_watchlist_enabled: false, push_notable_enabled: false, range_mi: 0 }).returning('id')
  await db('push_subscriptions').insert({ user_id: id, endpoint: 'https://push.example/place-lifers', p256dh: 'k', auth: 'a' })
  // Seen Steller's Jay in life; ten other birds on each list, so both are trusted.
  const ten = Array.from({ length: 10 }, (_, i) => `xx${i}yy`)
  await db('seen_birds').insert([...ten, 'stejay'].map((species_code) => ({ user_id: id, species_code, first_seen: '2020-01-01', source: 'tap' })))
  ebird.recentObservations = async (region) => (region === 'US-ZR-009' ? [{ speciesCode: 'stejay', comName: "Steller's Jay", locId: 'LJ', locName: 'Pine Grove', obsDt: '2026-11-10 08:00', lat: 39.7, lng: -105, subId: 'J1' }] : [])
  const sent = []
  const send = async (userId, payload) => { if (userId === id) sent.push(payload); return { sent: 1, gone: 0 } }
  try {
    const user = await db('users').where({ id }).first()
    const place = await places.createPlace(user, { name: 'Colorado (work)', state: 'ZR', location: 'US-ZR-009', range_mi: 0 })
    await db('users').where({ id }).update({ active_place_id: place.id })
    // Against the life list: seen before, so no lifer.
    await runPushAlerts({ send })
    assert.equal(sent.length, 0)
    // The place's own list, but under ten birds: the life list still decides, so still none.
    await places.updatePlace(user, place.id, { lifers_scope: 'place' })
    await places.setPlaceSeen(user, place.id, ten.slice(0, 3))
    await runPushAlerts({ send })
    assert.equal(sent.length, 0, 'a short place list falls back to the life list')
    // Ten birds on it: the place's own list decides, and the jay is new there.
    await places.setPlaceSeen(user, place.id, ten)
    await runPushAlerts({ send })
    assert.equal(sent.length, 1)
    assert.match(`${sent[0].title} ${sent[0].body}`, /Steller's Jay/)

    // Suggestions: scope 'place' leaves out only the place's list, 'life' the life list.
    const area = 'US-ZR-009'
    const from = dayFrom(20)
    const days = seasonality.daysBetween(seasonality.addDays(seasonality.yearAgo(from), -5), seasonality.addDays(seasonality.yearAgo(from), 5))
    await db('region_days').insert(days.map((day) => ({ region: area, day, species_count: 1, has_locations: true }))).onConflict(['region', 'day']).ignore()
    await db('region_species_days').insert(days.map((day) => ({ region: area, day, speciesCode: 'stejay' }))).onConflict(['region', 'day', 'speciesCode']).ignore()
    assert.deepEqual((await places.suggestTargets(user, place.id, { from, to: from, scope: 'place' })).suggestions.map((s) => s.speciesCode), ['stejay'])
    assert.deepEqual((await places.suggestTargets(user, place.id, { from, to: from })).suggestions.map((s) => s.speciesCode), [], 'already on the life list')
    await places.setPlaceSeen(user, place.id, ten.slice(0, 3))
    assert.deepEqual((await places.suggestTargets(user, place.id, { from, to: from, scope: 'place' })).suggestions.map((s) => s.speciesCode), [], 'under ten on the place list: the life list')
    await db('region_species_days').where({ region: area }).del()
    await db('region_days').where({ region: area }).del()
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, notableObservations: originals.notable, subregions: originals.subregions, regionInfo: originals.info })
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('push_log').where({ user_id: id }).del()
    await db('seen_birds').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('event notes: to each member, one when an event starts and one the day before it ends, each once, only when wanted', async () => {
  const places = require('../lib/places')
  const events = require('../lib/events')
  const { tripNoticeMessage } = require('../lib/mailer')
  const ebird = require('../lib/ebird')
  const original = ebird.subregions
  ebird.subregions = async () => [{ code: 'US-GA-139', name: 'Hall' }]
  await db('nearby_cache').where('key', 'like', 'areas:%').del()
  const [{ id }] = await db('users').insert({ email: 'trip-notes@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const [{ id: friend }] = await db('users').insert({ email: 'trip-notes-friend@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const notes = []
  const send = async (user, kind, vars) => { if (user.id === id || user.id === friend) notes.push({ who: user.id, kind, ...vars }) }
  try {
    const user = await db('users').where({ id }).first()
    const place = await places.createPlace(user, { name: 'Colorado (work)', state: 'CO', location: 'US-CO-031' })
    const trip = await events.createEvent(user, { place_id: place.id, starts_on: dayFrom(0), ends_on: dayFrom(3) })
    assert.equal(trip.timezone, 'America/Denver', 'its zone, from its area')
    // dayFrom's days are UTC days: the event's too (it would be Denver's, from its area).
    await db('events').where({ owner_id: id }).update({ timezone: 'UTC' })
    await events.runEventNotices({ send })
    assert.deepEqual(notes.map((n) => [n.kind, n.place, n.ends, n.home, n.eventId]), [['started', 'Colorado (work)', dayFrom(3), 'Hall County', trip.id]], 'home said the way the app says it')
    await events.runEventNotices({ send })
    assert.equal(notes.length, 1, 'once')

    // The day before it ends: the reminder, once.
    notes.length = 0
    await db('events').where({ id: trip.id }).update({ ends_on: dayFrom(1) })
    await events.runEventNotices({ send })
    await events.runEventNotices({ send })
    assert.deepEqual(notes.map((n) => [n.kind, n.eventId]), [['ending', trip.id]])

    // Turned off, or an unconfirmed address: none.
    notes.length = 0
    const later = await events.createEvent(user, { place_id: place.id, starts_on: dayFrom(0), ends_on: dayFrom(5) })
    // dayFrom's days are UTC days: the event's too (it would be Denver's, from its area).
    await db('events').where({ owner_id: id }).update({ timezone: 'UTC' })
    await db('users').where({ id }).update({ trip_emails_enabled: false })
    await events.runEventNotices({ send })
    assert.equal(notes.length, 0)
    await db('users').where({ id }).update({ trip_emails_enabled: true, email_confirmed: false })
    await events.runEventNotices({ send })
    assert.equal(notes.length, 0)
    assert.equal((await db('event_members').where({ event_id: later.id, user_id: id }).first()).started_notice_at, null, 'still owed if they confirm')

    // In a group, each member gets their own.
    await db('users').where({ id }).update({ email_confirmed: true })
    await db('event_members').insert({ event_id: later.id, user_id: friend, display_name: 'Jo', role: 'member' })
    await events.runEventNotices({ send })
    assert.deepEqual(notes.map((n) => [n.who, n.kind, n.eventId]).sort(), [[id, 'started', later.id], [friend, 'started', later.id]].sort())

    // Areas named the way the app says them, never doubled.
    assert.equal(places.areaLabel('en', 'GA', 'Hall'), 'Hall County')
    assert.equal(places.areaLabel('en', 'LA', 'Orleans Parish'), 'Orleans Parish')
    assert.equal(places.areaLabel('en', 'NY', 'Kings County'), 'Kings County', 'no "County County"')
    assert.equal(places.areaLabel('en', 'ZA-WC', 'City of Cape Town'), 'City of Cape Town')
    assert.equal(places.areaLabel('en', 'AB', 'Division No. 11'), 'Division No. 11 area')
    assert.equal(places.areaLabel('en', 'GB-ENG', 'Kent'), 'Kent')

    // The words.
    const start = tripNoticeMessage(user, 'started', { eventId: trip.id, place: 'Colorado (work)', ends: '2026-11-15', home: 'Hall County' })
    assert.equal(start.subject, 'Your trip to Colorado (work) has started')
    assert.match(start.text, /You’re set for Colorado \(work\) until November 15\. Your account will switch back to Hall County when your trip ends\./)
    assert.match(start.text, /\/unsubscribe\//)
    const ending = tripNoticeMessage(user, 'ending', { eventId: trip.id, place: 'Colorado (work)', ends: '2026-11-15', home: 'Hall County' })
    assert.equal(ending.subject, 'Your trip to Colorado (work) ends tomorrow')
    assert.match(ending.text, /A reminder: your account switches back to Hall County at the end of your trip on November 15\./)
    assert.match(ending.text, new RegExp(`Extend my trip: .*/events/${trip.id}\\b`))
  } finally {
    ebird.subregions = original
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('events').where({ owner_id: id }).del()
    await db('users').whereIn('id', [id, friend]).del()
  }
})

test('back home: /me says an event just ended, once, until the app says it was seen; and one coming up within the week', async () => {
  const auth = require('../api/auth/[action]')
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const [{ id }] = await db('users').insert({ email: 'back-home@example.com', password_hash: 'x', location: 'US-ZP-002', state: 'ZP' }).returning('id')
  const session = fakeRes(); createSession(session, await db('users').where({ id }).first())
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const me = async () => { const res = fakeRes(); await auth(fakeReq({ method: 'GET', headers: { cookie }, query: { action: 'me' } }), res); return res.body }
  try {
    const [place] = await db('places').insert({ user_id: id, name: 'Colorado (work)', state: 'CO', location: 'US-CO-031' }).returning('*')
    const ended = await eventAt(id, place, { starts_on: dayFrom(-4), ends_on: dayFrom(-1) })
    assert.deepEqual((await me()).lastEvent, { id: ended.id, name: 'Colorado (work)', ended_on: dayFrom(-1) })
    const res = fakeRes()
    await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { event_return_seen: true } }), res)
    assert.equal(res.body.lastEvent, null)
    assert.equal((await me()).lastEvent, null, 'once')
    // The old name is still taken, harmlessly; anything but true isn't.
    const old = fakeRes()
    await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { trip_return_seen: true } }), old)
    assert.equal(old.statusCode, 200)
    const wrong = fakeRes()
    await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body: { event_return_seen: false } }), wrong)
    assert.equal(wrong.statusCode, 400)
    // An event ending today hasn't ended yet.
    await eventAt(id, place, { starts_on: dayFrom(-1), ends_on: dayFrom(0) })
    assert.equal((await me()).lastEvent, null)
    // Coming up: the soonest event starting within the week, not one already on, not one weeks off.
    assert.equal((await me()).upcomingEvent, null)
    await eventAt(id, place, { name: 'Far off', starts_on: dayFrom(20), ends_on: dayFrom(20) })
    const soon = await eventAt(id, place, { name: 'Cabin weekend', starts_on: dayFrom(3), ends_on: dayFrom(4) })
    assert.deepEqual((await me()).upcomingEvent, { id: soon.id, name: 'Cabin weekend', starts_on: dayFrom(3) })
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('an explored area with little on file is filled once, and only a few new areas an hour', async () => {
  const { fillExplored, EXPLORE_FILLS_PER_HOUR } = require('../lib/checklists')
  await db('job_runs').where('kind', 'like', 'explore-fill:%').del()
  const filled = []
  const fill = async (region) => { filled.push(region); return {} }
  await fillExplored('US-CO-031', { fill })
  await fillExplored('US-CO-031', { fill })
  assert.deepEqual(filled, ['US-CO-031'], 'once per area')
  assert.equal(await fillExplored('US-CO', { fill }), null, 'a whole state is never filled this way')
  for (let i = 0; i < EXPLORE_FILLS_PER_HOUR + 3; i++) await fillExplored(`US-CO-${String(100 + i).padStart(3, '0')}`, { fill })
  assert.equal(filled.length, EXPLORE_FILLS_PER_HOUR, 'a handful an hour across everyone')
  await db('job_runs').where('kind', 'like', 'explore-fill:%').del()
})

test('the HQ desk leads with new finds and puts birds that have been around a while under "Still around", once a week', async () => {
  const { runHqDesk } = require('../lib/hqDesk')
  const noCheck = async () => null
  await db('hq_picks').where('day', '>=', '2026-11-02').del()
  await db('birds').insert([
    { speciesCode: 'motowl', comName: 'Mottled Owl', sciName: 'Strix virgata', birdImg: 'https://img.example/owl.jpg' },
    { speciesCode: 'rucwar', comName: 'Rufous-capped Warbler', sciName: 'Basileuterus rufifrons', birdImg: 'https://img.example/rcw.jpg' }
  ]).onConflict('speciesCode').ignore()
  const rec = (over) => ({ subnational1Code: 'US-TX', subnational1Name: 'Texas', subnational2Name: 'Starr', lat: 26.47, lng: -98.88, obsDt: '2026-11-01 18:25', obsValid: true, obsReviewed: true, locationPrivate: false, ...over })
  const records = [
    ...[1, 2, 3, 4].map((i) => rec({ speciesCode: 'motowl', comName: 'Mottled Owl', sciName: 'Strix virgata', locId: 'L9', locName: 'Santa Margarita Ranch (restricted access)', subId: `SO${i}`, userDisplayName: `O${i}` })),
    ...[1, 2].map((i) => rec({ speciesCode: 'rucwar', comName: 'Rufous-capped Warbler', sciName: 'Basileuterus rufifrons', subnational2Name: 'Brewster', locId: 'L5', locName: 'Big Bend NP--Santa Elena Canyon', lat: 29.17, lng: -103.6, subId: `SW${i}`, userDisplayName: `W${i}` }))
  ]
  // The owl has been there since Oct 5; the warbler turned up yesterday.
  const credit = async (picks) => picks.map((p) => ({ ...p, credit: p.speciesCode === 'motowl'
    ? { name: 'Zachary Johnson', others: 17, observers: 18, firstDay: '2026-10-05', lastDay: '2026-11-01', checklists: 25, verified: true, fresh: false }
    : { name: 'Wes Finder', others: 1, observers: 2, firstDay: '2026-11-01', lastDay: '2026-11-01', checklists: 2, verified: true, fresh: true } }))
  const mails = []
  const send = async (m) => { mails.push(m); return {} }
  process.env.FEEDBACK_TO = 'hq@example.com'
  try {
    const first = await runHqDesk({ asOf: '2026-11-02', records, check: noCheck, credit, send })
    assert.deepEqual([first.picks, first.still], [1, 1])
    const html = mails[0].html
    assert.ok(html.indexOf('Rufous-capped Warbler') < html.indexOf('Still around'), 'the new find leads')
    assert.match(html, /Mottled Owl · Texas · present since Oct 5, last seen Nov 1 \(25 checklists\)/)
    assert.match(html, /👀 Still being seen: MOTTLED OWL in Texas/)
    assert.doesNotMatch(html, /Zachary Johnson/, 'no names at a private place')
    assert.match(mails[0].text, /Still around:/)
    const rows = await db('hq_picks').where({ day: '2026-11-02' }).select('species_code', db.raw("coalesce(detail->>'kind', 'new') as kind"))
    assert.deepEqual(Object.fromEntries(rows.map((r) => [r.species_code, r.kind])), { rucwar: 'new', motowl: 'still' })
    // The next day: the owl isn't back in Still around for a week, and the warbler isn't re-pitched for 5 days.
    const next = await runHqDesk({ asOf: '2026-11-03', records, check: noCheck, credit, send })
    assert.deepEqual([next.picks, next.still], [0, 0])
    // A week on, the owl is back under Still around (never as a new find).
    const later = await runHqDesk({ asOf: '2026-11-09', records, check: noCheck, credit, send })
    assert.equal(later.still, 1)
  } finally {
    delete process.env.FEEDBACK_TO
    await db('hq_picks').where('day', '>=', '2026-11-02').del()
  }
})

test('an instant HQ alert goes out for a fresh Code 4-5 find, never for one that has been around a while', async () => {
  const { runHqAlerts } = require('../lib/hqAlerts')
  await db('hq_alerts').del()
  const codes = { bySci: new Map([['Strix virgata', 5], ['Phylloscopus inornatus', 4]]), byName: new Map() }
  const base = { subnational1Code: 'US-TX', subnational1Name: 'Texas', subnational2Name: 'Starr', lat: 26.47, lng: -98.88, obsDt: '2026-11-01 18:25', userDisplayName: 'A', locationPrivate: false, obsValid: true, obsReviewed: true }
  const records = [
    { ...base, speciesCode: 'motowl', comName: 'Mottled Owl', sciName: 'Strix virgata', locId: 'L9', locName: 'Santa Margarita Ranch', subId: 'S1' },
    { ...base, speciesCode: 'yebwar3', comName: 'Yellow-browed Warbler', sciName: 'Phylloscopus inornatus', subnational1Code: 'US-CA', subnational1Name: 'California', locId: 'L77', locName: 'Moss Beach', subId: 'S2' }
  ]
  const credit = async (picks) => picks.map((p) => ({ ...p, credit: { name: 'A', others: 0, observers: 1, firstDay: p.speciesCode === 'motowl' ? '2026-10-05' : '2026-11-01', lastDay: '2026-11-01', checklists: 1, verified: true, fresh: p.speciesCode !== 'motowl' } }))
  const mails = []
  process.env.FEEDBACK_TO = 'owner@example.com'
  try {
    const ran = await runHqAlerts({ records, codes, credit, now: new Date('2026-11-01T23:00:00Z'), push: async () => ({ sent: 1 }), send: async (m) => { mails.push(m); return {} } })
    assert.deepEqual([ran.post, ran.continuing], [1, 1])
    assert.deepEqual(mails.map((m) => m.subject), ['HQ alert: ABA Code 4 Yellow-browed Warbler in California'])
    assert.equal(await db('hq_alerts').where({ species_code: 'motowl' }).first(), undefined, 'not recorded: a fresh find there later still alerts')
  } finally {
    delete process.env.FEEDBACK_TO
    await db('hq_alerts').del()
  }
})

test('the eBird data endpoints answer only the app once the lockdown is on, cached here and never at the edge', async () => {
  const api = require('../api/ebird/[resource]')
  const birdsApi = require('../api/birds')
  const ebird = require('../lib/ebird')
  const { fakeReq, fakeRes } = require('./helpers')
  const { PER_MINUTE } = require('../lib/apiGuard')
  const [notable, recent] = [ebird.notableObservations, ebird.recentObservations]
  let calls = 0
  ebird.notableObservations = async () => { calls += 1; return [{ speciesCode: 'paibun', comName: 'Painted Bunting', subId: 'S1', locId: 'L1', lat: 34.2, lng: -83.9, obsDt: '2026-11-01 08:00', obsValid: true, obsReviewed: true, userDisplayName: 'Ann' }] }
  ebird.recentObservations = async () => []
  const ask = async (resource, headers = {}, query = {}) => {
    const res = fakeRes()
    await api(fakeReq({ query: { resource, region: 'US-GA-139', back: '7', ...query }, headers }), res)
    return res
  }
  const app = { 'x-bird-alert': '1', 'x-real-ip': '203.0.113.9' }
  await db('auth_throttle').where('key', 'like', 'api:%').del()
  await db('nearby_cache').where('key', 'like', 'api:%').del()
  process.env.API_LOCKDOWN = 'on'
  try {
    assert.equal((await ask('notable')).statusCode, 403, 'no app header: turned away')
    assert.equal((await ask('notable', { ...app, origin: 'https://elsewhere.example' })).statusCode, 403, 'another site: turned away')
    const ok = await ask('notable', { ...app, origin: 'https://bird-alert.vercel.app' })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.body[0].speciesCode, 'paibun')
    assert.equal(ok.body[0].userDisplayName, undefined, 'observer names still stay on the server')
    assert.match(ok.headers['cache-control'], /^private, max-age=\d+$/, 'the browser may keep it; the edge may not')
    assert.doesNotMatch(ok.headers['cache-control'], /s-maxage|public/)
    // A second ask within the lifetime comes from the shared cache: eBird isn't asked again.
    assert.equal((await ask('notable', app)).statusCode, 200)
    assert.equal(calls, 1)
    // Previews and local development count as the app.
    assert.equal((await ask('notable', { ...app, origin: 'https://bird-alert-git-feat-x-mben.vercel.app' })).statusCode, 200)
    // Open on purpose: a share link answers anyone (404 here only because there is no such share).
    assert.equal((await ask('share', {}, { id: 'NoSuchOne1' })).statusCode, 404)
    // The birds endpoint is the app's too.
    const birds = fakeRes()
    await birdsApi(fakeReq({ query: { q: 'bunting' } }), birds)
    assert.equal(birds.statusCode, 403)
    // One address asking too often is slowed down.
    await db('auth_throttle').insert({ key: 'api:198.51.100.7', attempts: PER_MINUTE, window_start: db.fn.now() })
    assert.equal((await ask('notable', { 'x-bird-alert': '1', 'x-real-ip': '198.51.100.7' })).statusCode, 429)
  } finally {
    delete process.env.API_LOCKDOWN
    ebird.notableObservations = notable
    ebird.recentObservations = recent
  }
  // Until the switch is flipped, nothing is refused (the app ships its header first).
  assert.equal((await ask('notable')).statusCode, 200)
  await db('auth_throttle').where('key', 'like', 'api:%').del()
  await db('nearby_cache').where('key', 'like', 'api:%').del()
})


test('Big Days scout by default, and scouting sends one report a day in the window before an event', async () => {
  const events = require('../lib/events')
  const { runScouting, scoutReport, feedFor } = require('../lib/scouting')
  const { scoutingMessage } = require('../lib/mailer')
  const birds = [['eletro', 'Elegant Trogon'], ['mexchi', 'Mexican Chickadee'], ['monqua', 'Montezuma Quail'], ['flaowl', 'Flammulated Owl']]
  await db('birds').insert(birds.map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const [{ id }] = await db('users').insert({ email: 'scout@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const [{ id: other }] = await db('users').insert({ email: 'scout-friend@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const placeRow = async (userId, name) => (await db('places').insert({ user_id: userId, name, state: 'AZ', location: 'US-AZ-003', range_mi: 0 }).returning('*'))[0]
  try {
    const user = await db('users').where({ id }).first()
    const place = await placeRow(id, 'Chiricahuas')
    await db('place_targets').insert(birds.map(([code]) => ({ place_id: place.id, species_code: code })))

    // A Big Day is one day and scouts by default, three weeks out; a plain trip doesn't; the choices are checked.
    const trip = await events.createEvent(user, { place_id: place.id, starts_on: dayFrom(5), ends_on: dayFrom(7), kind: 'bigday' })
    assert.deepEqual([trip.kind, trip.ends_on, trip.scout, trip.scout_days, trip.scout_from], ['bigday', dayFrom(5), true, 21, dayFrom(-16)])
    const plain = await events.createEvent(user, { place_id: place.id, starts_on: dayFrom(40), ends_on: dayFrom(41) })
    // dayFrom's days are UTC days: the event's too (it would be Phoenix's, from its area).
    await db('events').where({ owner_id: id }).update({ timezone: 'UTC' })
    assert.deepEqual([plain.kind, plain.scout], ['trip', false])
    assert.equal((await events.updateEvent(user, plain.id, { scout: true, scout_days: 14 })).scout_from, dayFrom(26))
    await assert.rejects(events.createEvent(user, { place_id: place.id, starts_on: dayFrom(5), ends_on: dayFrom(5), kind: 'party' }), (e) => e.status === 400)
    await assert.rejects(events.updateEvent(user, trip.id, { scout_days: 10 }), (e) => e.status === 400)
    const move = async (day) => {
      await db('events').where({ id: trip.id }).update({ starts_on: day, ends_on: day })
      await db('event_members').where({ event_id: trip.id }).update({ last_scout_sent_on: null })
    }

    // The report: targets seen in the last three days, newest first; the ones quiet for two weeks.
    const feed = [
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'South Fork, Cave Creek Canyon', obsDt: `${dayFrom(-1)} 07:10`, subId: 'S1', obsValid: true, obsReviewed: false },
      { speciesCode: 'mexchi', comName: 'Mexican Chickadee', locName: 'Rustler Park', obsDt: `${dayFrom(-6)} 09:00`, subId: 'S2', obsValid: true, obsReviewed: false },
      { speciesCode: 'acowoo', comName: 'Acorn Woodpecker', locName: 'Portal', obsDt: `${dayFrom(0)} 08:00`, subId: 'S3', obsValid: true }
    ]
    const report = scoutReport(birds.map(([c]) => c), feed, dayFrom(0))
    assert.deepEqual(report.seen.map((o) => o.speciesCode), ['eletro'])
    assert.deepEqual([...report.unreported].sort(), ['flaowl', 'monqua'])
    assert.ok(!report.unreported.includes('mexchi'), 'seen within two weeks is not unreported')

    // The run: one push and one email, once a day; the friend's event in the same county shares the call.
    const friendPlace = await placeRow(other, 'Arizona trip')
    await db('place_targets').insert({ place_id: friendPlace.id, species_code: 'eletro' })
    await eventAt(other, friendPlace, { starts_on: dayFrom(10), ends_on: dayFrom(11), kind: 'trip', scout: true, scout_days: 14 })
    const pushes = []
    const mails = []
    const calls = []
    const run = () => runScouting({
      push: async (userId, payload) => { pushes.push({ userId, ...payload }); return { sent: 1 } },
      send: async (m) => { mails.push(m) },
      fetchFeed: async (key) => { calls.push(key); return feed }
    })
    const first = await run()
    assert.deepEqual(calls, ['county:US-AZ-003'], 'one call for both events')
    const mine = pushes.filter((p) => p.userId === id)
    assert.equal(mine.length, 1)
    assert.equal(mine[0].title, '🔭 Scouting Chiricahuas · 5 days to go', 'solo: no group')
    assert.match(mine[0].data.url, new RegExp(`/events/${trip.id}#scouting$`))
    assert.match(mine[0].body, /Elegant Trogon · South Fork, Cave Creek Canyon/)
    const mail = mails.find((m) => m.to === 'scout@example.com')
    // Reported yesterday at 07:10: new in the last 24 hours only before 07:10 today.
    assert.match(mail.subject, /^Chiricahuas: (1 of 4 targets around|Elegant Trogon new today) · 5 days to go$/)
    assert.match(mail.text, /Bird of the day: Elegant Trogon\nSouth Fork, Cave Creek Canyon · /)
    assert.match(mail.text, /Where they’re being seen:\n- South Fork, Cave Creek Canyon \(yesterday\)\n   Elegant Trogon\n   Checklist on eBird: https:\/\/ebird.org\/checklist\/S1/)
    assert.match(mail.text, /Still missing \(nothing in the last 2 weeks\): .*Flammulated Owl/)
    assert.match(mail.html, /Turn off trip emails/)
    assert.match(mail.text, new RegExp(`/events/${trip.id}\\b`))
    assert.match(mail.text, /\/unsubscribe\//)
    assert.equal(first.reports, 2)
    await run()
    assert.equal(pushes.filter((p) => p.userId === id).length, 1, 'once a day')

    // The day before the event: the final report. Not on the day itself, and not before the window.
    pushes.length = 0
    await move(dayFrom(1))
    await run()
    assert.equal(pushes.find((p) => p.userId === id)?.title, '🔭 Final scouting report: Chiricahuas tomorrow')
    pushes.length = 0
    await move(dayFrom(0))
    await run()
    assert.equal(pushes.filter((p) => p.userId === id).length, 0, 'not on the day')
    await move(dayFrom(25))
    await run()
    assert.equal(pushes.filter((p) => p.userId === id).length, 0, 'not before scout_from')

    // Trip emails off: the push still comes, no email. No targets: nothing at all.
    await move(dayFrom(3))
    await db('users').where({ id }).update({ trip_emails_enabled: false })
    mails.length = 0
    await run()
    assert.equal(pushes.filter((p) => p.userId === id).length, 1)
    assert.equal(mails.filter((m) => m.to === 'scout@example.com').length, 0)
    await db('event_targets').where({ event_id: trip.id }).del()
    await move(dayFrom(3))
    pushes.length = 0
    await run()
    assert.equal(pushes.filter((p) => p.userId === id).length, 0, 'no targets and no likely lifers on file: no report')

    // Which feed: the whole state, a circle round the place's spot, or the county.
    assert.equal((await feedFor({ location: 'US-AZ-003', range_mi: -1 })).key, 'state:US-AZ')
    assert.equal((await feedFor({ location: 'US-AZ-003', range_mi: 30, home_lat: 31.88, home_lng: -109.21 })).key, 'geo:31.88,-109.21,48')
    assert.equal((await feedFor({ location: 'US-AZ-003', range_mi: 0 })).key, 'county:US-AZ-003')

    // The email's wording when nothing turned up.
    const quiet = scoutingMessage({ ...user, email: 'scout@example.com' }, { place: 'Chiricahuas', daysToGo: 1, final: true, seen: [], unreported: ['Montezuma Quail'] })
    assert.equal(quiet.subject, 'Chiricahuas: no targets reported yet · tomorrow')
    assert.match(quiet.text, /None of your target birds were reported there in the last 3 days\./)
  } finally {
    await db('events').whereIn('owner_id', [id, other]).del()
    await db('places').whereIn('user_id', [id, other]).del()
    await db('users').whereIn('id', [id, other]).del()
  }
})

test('group events: a solo event opened to a group, joined by link, run by anyone in it, seen by anyone with the view link', async () => {
  const events = require('../lib/events')
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const birds = [['eletro', 'Elegant Trogon'], ['mexchi', 'Mexican Chickadee'], ['monqua', 'Montezuma Quail']]
  await db('birds').insert(birds.map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const person = async (email) => (await db('users').insert({ email, password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('*'))[0]
  const matt = await person('group-matt@example.com')
  const sam = await person('group-sam@example.com')
  const extra = []
  try {
    const [place] = await db('places').insert({ user_id: matt.id, name: 'Chiricahuas', state: 'AZ', location: 'US-AZ-003', range_mi: 30 }).returning('*')
    await db('place_targets').insert(birds.map(([code]) => ({ place_id: place.id, species_code: code })))
    const solo = await events.createEvent(matt, { place_id: place.id, starts_on: dayFrom(5), ends_on: dayFrom(5), kind: 'bigday' })
    assert.deepEqual([solo.name, solo.location, solo.range_mi, solo.starts_on, solo.kind, solo.scout, solo.scout_days, solo.role, solo.display_name, solo.invite_url, solo.view_url],
      ['Chiricahuas', 'US-AZ-003', 30, dayFrom(5), 'bigday', true, 21, 'organizer', null, null, null])
    assert.deepEqual(solo.targets.map((t) => t.code), ['eletro', 'mexchi', 'monqua'])

    // Inviting: Matt chooses the name the group will see, and gets the links.
    await assert.rejects(events.startInvite(matt, solo.id, { display_name: '  ' }), (e) => e.status === 400)
    const made = await events.startInvite(matt, solo.id, { display_name: 'Matt' })
    assert.equal(made.display_name, 'Matt')
    assert.match(made.invite_url, /\/events\/join\/[\w-]{16,}$/)
    assert.match(made.view_url, /\/events\/view\/[\w-]{16,}$/)
    const event = await db('events').where({ id: made.id }).first()

    // Sam joins by the invite link under a name the group sees; joining again just renames.
    await assert.rejects(events.joinEvent(sam, { token: 'nope-nope-nope-nope', display_name: 'Sam' }), (e) => e.status === 404)
    await assert.rejects(events.joinEvent(sam, { token: event.invite_token, display_name: 'x'.repeat(41) }), (e) => e.status === 400)
    await events.joinEvent(sam, { token: event.invite_token, display_name: 'Sammy' })
    const joined = await events.joinEvent(sam, { token: event.invite_token, display_name: 'Sam' })
    assert.deepEqual(joined.members.map((m) => [m.display_name, m.role, m.you]), [['Matt', 'organizer', false], ['Sam', 'member', true]])
    assert.ok(!JSON.stringify(joined).includes('@example.com'), 'no emails, ever')

    // Lifers are each member's own: Sam has seen the trogon, Matt hasn't.
    await db('seen_birds').insert({ user_id: sam.id, species_code: 'eletro' })
    const listed = (await events.listEvents(matt)).find((e) => e.id === made.id)
    assert.deepEqual(listed.targets.find((t) => t.code === 'eletro').lifer_for, ['Matt'])
    assert.deepEqual(listed.targets.find((t) => t.code === 'mexchi').lifer_for, ['Matt', 'Sam'])
    assert.equal((await events.listEvents(sam)).find((e) => e.id === made.id).targets.find((t) => t.code === 'eletro').lifer_for_you, false)

    // Anyone in the group runs it: name, targets (who added each is kept), the tally (once per bird).
    const renamed = await events.updateEvent(sam, made.id, { name: 'Chiricahua Big Day', scout_days: 14 })
    assert.deepEqual([renamed.name, renamed.scout_days], ['Chiricahua Big Day', 14])
    await events.setEventTargets(sam, made.id, ['eletro', 'mexchi', 'flaowl'])
    const added = await db('event_targets').where({ event_id: made.id }).orderBy('species_code')
    assert.deepEqual(added.map((t) => [t.species_code, t.added_by]), [['eletro', matt.id], ['flaowl', sam.id], ['mexchi', matt.id]])
    await assert.rejects(events.setEventTargets(sam, made.id, Array.from({ length: 51 }, (_, i) => `bird${i}`)), (e) => e.status === 400)
    await events.addTally(sam, made.id, 'eletro')
    const tallied = await events.addTally(matt, made.id, 'eletro')
    assert.deepEqual(tallied.tally.map((t) => [t.code, t.added_by_name, t.added_by_you]), [['eletro', 'Sam', false]])
    assert.equal((await events.removeTally(matt, made.id, 'eletro')).tally.length, 0)
    await events.addTally(matt, made.id, 'mexchi')

    // Only the organizer ends it or makes a new invite link; the old link stops working.
    await assert.rejects(events.endEvent(sam, made.id), (e) => e.status === 403)
    await assert.rejects(events.rotateInvite(sam, made.id), (e) => e.status === 403)
    await events.rotateInvite(matt, made.id)
    const outsider = await person('group-outsider@example.com')
    extra.push(outsider.id)
    await assert.rejects(events.joinEvent(outsider, { token: event.invite_token, display_name: 'Pat' }), (e) => e.status === 404)
    await assert.rejects(events.updateEvent(outsider, made.id, { name: 'Mine now' }), (e) => e.status === 404, 'not a member: no such event')

    // A group holds ten.
    const fresh = await db('events').where({ id: made.id }).first()
    for (let i = 0; i < 8; i++) {
      const p = await person(`group-fill-${i}@example.com`)
      extra.push(p.id)
      await events.joinEvent(p, { token: fresh.invite_token, display_name: `Birder ${i}` })
    }
    await assert.rejects(events.joinEvent(outsider, { token: fresh.invite_token, display_name: 'Pat' }), (e) => e.status === 400)

    // The two open links, through the API with no sign-in: the preview (what, never who) and the view (plan and tally, no names).
    const ask = async (query) => { const res = fakeRes(); await saved(fakeReq({ query }), res); return res }
    const preview = await ask({ kind: 'event-preview', token: fresh.invite_token })
    assert.equal(preview.statusCode, 200)
    assert.deepEqual([preview.body.name, preview.body.kind, preview.body.members], ['Chiricahua Big Day', 'bigday', 10])
    const view = await ask({ kind: 'event-view', token: fresh.view_token })
    assert.equal(view.statusCode, 200)
    assert.deepEqual(view.body.tally.map((t) => t.comName), ['Mexican Chickadee'])
    assert.equal(view.body.count, 1)
    assert.ok(view.body.targets.some((t) => t.comName === 'Elegant Trogon'))
    assert.ok(!/Matt|Sam|Birder|@/.test(JSON.stringify(view.body)), 'no names on the view link')
    assert.equal((await ask({ kind: 'event-view', token: 'not-a-real-token-x' })).statusCode, 404)
    assert.equal((await ask({ kind: 'events' })).statusCode, 401, 'the rest needs signing in')

    // Leaving: the organizer's role passes to the longest-standing member; the last one out ends it.
    await events.leaveEvent(matt, made.id)
    assert.equal((await events.organizerOf(made.id)).user_id, sam.id)
    for (const id of [sam.id, ...extra]) {
      if (await db('event_members').where({ event_id: made.id, user_id: id }).first()) await events.leaveEvent({ id }, made.id)
    }
    assert.equal(await db('events').where({ id: made.id }).first(), undefined, 'the last one out ends it')
  } finally {
    await db('users').whereIn('id', [matt.id, sam.id, ...extra]).del()
  }
})

test('on the day a group event is an active place for every member (its targets alert there), and each member scouts it beforehand', async () => {
  const ebird = require('../lib/ebird')
  const places = require('../lib/places')
  const { runPushAlerts } = require('../lib/pushAlerts')
  const { runScouting } = require('../lib/scouting')
  const originals = { recent: ebird.recentObservations, notable: ebird.notableObservations, subregions: ebird.subregions, info: ebird.regionInfo }
  ebird.subregions = async () => [{ code: 'US-ZV-009', name: 'Cochise' }, { code: 'US-ZV-002', name: 'Home' }]
  ebird.notableObservations = async () => []
  ebird.regionInfo = async () => { throw new Error('no center') }
  await db('birds').insert({ speciesCode: 'eletro', comName: 'Elegant Trogon', sciName: 'Trogon elegans', category: 'species' }).onConflict('speciesCode').ignore()
  const sighting = { speciesCode: 'eletro', comName: 'Elegant Trogon', locId: 'LCC1', locName: 'Cave Creek Canyon', obsDt: `${dayFrom(0)} 07:00`, lat: 31.9, lng: -109.2, subId: 'SEV1', obsValid: true }
  ebird.recentObservations = async (region) => (region === 'US-ZV-009' ? [sighting] : [])
  const person = async (email) => (await db('users').insert({ email, password_hash: 'x', location: 'US-ZV-002', state: 'ZV', email_confirmed: true, push_watchlist_enabled: true, push_notable_enabled: false, range_mi: 0 }).returning('*'))[0]
  const a = await person('event-day-a@example.com')
  const b = await person('event-day-b@example.com')
  for (const u of [a, b]) await db('push_subscriptions').insert({ user_id: u.id, endpoint: `https://push.example/${u.id}`, p256dh: 'k', auth: 'a' })
  try {
    const [event] = await db('events').insert({ owner_id: a.id, name: 'Chiricahua Big Day', state: 'ZV', location: 'US-ZV-009', range_mi: 0, starts_on: dayFrom(0), ends_on: dayFrom(0), kind: 'bigday', scout: true, scout_days: 21, invite_token: 'invite-token-day-0001', view_token: 'view-token-day-00001' }).returning('*')
    await db('event_members').insert([{ event_id: event.id, user_id: a.id, display_name: 'A', role: 'organizer' }, { event_id: event.id, user_id: b.id, display_name: 'B', role: 'member' }])
    await db('event_targets').insert({ event_id: event.id, species_code: 'eletro', added_by: a.id })

    // /me says where the group is, and it isn't a saved place.
    assert.deepEqual([(await places.activeEventOf(a))?.id, await places.activePlaceOf(a)], [event.id, null])
    // Both members hear about the group's target bird, saying where.
    const sent = []
    await runPushAlerts({ send: async (userId, payload) => { sent.push({ userId, ...payload }); return { sent: 1, gone: 0 } } })
    for (const u of [a, b]) assert.match(sent.filter((s) => s.userId === u.id).map((s) => `${s.title} ${s.body}`).join('\n'), /Elegant Trogon.*Cave Creek Canyon|Cave Creek Canyon.*Elegant Trogon/s)

    // Before the day, each member gets their own scouting report, once a day, from one shared feed.
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(4), ends_on: dayFrom(4) })
    const pushes = []
    const calls = []
    const run = () => runScouting({
      push: async (userId, payload) => { pushes.push({ userId, ...payload }); return { sent: 1 } },
      send: async () => {},
      fetchFeed: async (key) => { calls.push(key); return [{ ...sighting, obsDt: `${dayFrom(-1)} 07:00` }] }
    })
    await run()
    assert.deepEqual(calls, ['county:US-ZV-009'])
    for (const u of [a, b]) assert.equal(pushes.filter((p) => p.userId === u.id)[0]?.title, '🔭 Scouting Chiricahua Big Day with your group · 4 days to go')
    await run()
    assert.equal(pushes.length, 2, 'once a day each')
  } finally {
    Object.assign(ebird, { recentObservations: originals.recent, notableObservations: originals.notable, subregions: originals.subregions, regionInfo: originals.info })
    await db('users').whereIn('id', [a.id, b.id]).del()
  }
})

test('likely lifers: up to 50 when asked, for a place or an event; and they stand in for scouting when no targets were picked, for each member', async () => {
  const places = require('../lib/places')
  const events = require('../lib/events')
  const seasonality = require('../lib/seasonality')
  const { runScouting } = require('../lib/scouting')
  const area = 'US-ZU-009'
  const tripDay = dayFrom(5)
  const days = seasonality.daysBetween(seasonality.addDays(seasonality.yearAgo(tripDay), -6), seasonality.addDays(seasonality.yearAgo(tripDay), 6))
  await db('region_days').insert(days.map((day) => ({ region: area, day, species_count: 1, has_locations: true }))).onConflict(['region', 'day']).ignore()
  const species = Array.from({ length: 20 }, (_, i) => `lik${String(i).padStart(3, '0')}`)
  await db('region_species_days').insert(species.flatMap((code, i) => days.slice(0, 13 - (i % 10)).map((day) => ({ region: area, day, speciesCode: code })))).onConflict(['region', 'day', 'speciesCode']).ignore()
  await db('taxonomy_ref').insert(species.map((code, i) => ({ species_code: code, sci_name: `Avis ${i}`, com_name: `Likely Bird ${i}`, category: 'species' }))).onConflict('species_code').ignore()
  const [{ id }] = await db('users').insert({ email: 'likely@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const [{ id: friend }] = await db('users').insert({ email: 'likely-friend@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  await db('seen_birds').insert({ user_id: friend, species_code: species[0] })
  try {
    const user = await db('users').where({ id }).first()
    const [place] = await db('places').insert({ user_id: id, name: 'Zu canyon', state: 'ZU', location: area, range_mi: 0 }).returning('*')
    // The limit: 15 by default, up to 50 when asked, nothing outside 1-50.
    assert.equal((await places.suggestTargets(user, place.id, { from: tripDay, to: tripDay })).suggestions.length, 15)
    assert.equal((await places.suggestTargets(user, place.id, { from: tripDay, to: tripDay, limit: '50' })).suggestions.length, 20, 'every likely lifer, up to 50')
    await assert.rejects(places.suggestTargets(user, place.id, { from: tripDay, to: tripDay, limit: 51 }), (e) => e.status === 400)
    await assert.rejects(places.suggestTargets(user, place.id, { from: tripDay, to: tripDay, limit: 0 }), (e) => e.status === 400)

    // A scouting event on your own with no targets: likely lifers stand in, and the report says so.
    const solo = await eventAt(id, place, { starts_on: tripDay, ends_on: tripDay, kind: 'bigday', scout: true, scout_days: 7 })
    const feed = [{ speciesCode: species[0], comName: 'Likely Bird 0', locName: 'Zu Spring', obsDt: `${dayFrom(-1)} 07:00`, subId: 'SL1', obsValid: true }]
    const pushes = []
    const mails = []
    const run = () => runScouting({
      push: async (userId, payload) => { pushes.push({ userId, ...payload }); return { sent: 1 } },
      send: async (m) => { mails.push(m) },
      fetchFeed: async () => feed
    })
    await run()
    const push = pushes.find((p) => p.userId === id)
    assert.ok(push, 'a report goes out though no targets were picked')
    assert.match(push.body, /^No targets picked yet, so here are likely lifers for your dates: Likely Bird 0 · Zu Spring/)
    const mail = mails.find((m) => m.to === 'likely@example.com')
    assert.match(mail.text, /You haven’t picked target birds yet, so these are likely lifers for your dates\./)
    assert.match(mail.text, new RegExp(`Pick target birds: .*/events/${solo.id}\\b`))
    assert.match(mail.text, /\d+ of \d+ likely lifers reported in the last 3 days/)

    // A group event with no targets: each member's own likely lifers.
    await db('events').where({ id: solo.id }).del()
    const [{ id: eventId }] = await db('events').insert({ owner_id: id, name: 'Zu Big Day', state: 'ZU', location: area, range_mi: 0, starts_on: tripDay, ends_on: tripDay, kind: 'bigday', scout: true, scout_days: 7, invite_token: 'likelyinvitetoken01', view_token: 'likelyviewtoken0001' }).returning('id')
    await db('event_members').insert([{ event_id: eventId, user_id: id, display_name: 'Matt', role: 'organizer' }, { event_id: eventId, user_id: friend, display_name: 'Jo', role: 'member' }])
    pushes.length = 0
    mails.length = 0
    await run()
    const mine = mails.find((m) => m.to === 'likely@example.com')
    const theirs = mails.find((m) => m.to === 'likely-friend@example.com')
    assert.match(mine.text, /Bird of the day: Likely Bird 0\nZu Spring/, 'not seen by me: a likely lifer')
    assert.match(theirs.text, /\n0 of \d+ likely lifers reported/, 'already on Jo\'s life list: not one of hers')
    assert.ok(!theirs.text.includes('Bird of the day') && !theirs.text.includes('Where they’re being seen'))
    assert.match(theirs.text, /What’s being seen there this week:\n.*Zu Spring/, 'though it is about, with the rest')
    assert.match(theirs.text, new RegExp(`Pick target birds: .*/events/${eventId}\\b`))
    // The event's own suggestions: each member's likely lifers for its dates.
    assert.equal((await events.suggestForEvent(user, eventId, { limit: '50' })).suggestions.length, 20)
    const jo = await db('users').where({ id: friend }).first()
    assert.equal((await events.suggestForEvent(jo, eventId, { limit: '50', scope: 'place' })).suggestions.length, 19, 'Jo\'s own; no place, so the life list')
    await assert.rejects(events.suggestForEvent(jo, eventId, { limit: 51 }), (e) => e.status === 400)
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('seen_birds').where({ user_id: friend }).del()
    await db('region_species_days').where({ region: area }).del()
    await db('region_days').where({ region: area }).del()
    await db('users').whereIn('id', [id, friend]).del()
  }
})

test('events are kept: each member archives their own, a past one says how it went, only the organizer deletes it', async () => {
  const events = require('../lib/events')
  const fs = require('fs')
  const person = async (email) => (await db('users').insert({ email, password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('*'))[0]
  const a = await person('kept-a@example.com')
  const b = await person('kept-b@example.com')
  try {
    // Fifty days gone and still listed: nothing prunes ended events any more.
    const old = await eventAt(a.id, { name: 'Old Big Day', state: 'GA', location: 'US-GA-139', range_mi: 0 }, { starts_on: dayFrom(-50), ends_on: dayFrom(-50), kind: 'bigday' })
    await db('event_members').where({ event_id: old.id }).update({ display_name: 'A' })
    await db('event_members').insert({ event_id: old.id, user_id: b.id, display_name: 'B', role: 'member' })
    await db('event_targets').insert([{ event_id: old.id, species_code: 'eletro', added_by: a.id }, { event_id: old.id, species_code: 'mexchi', added_by: a.id }])
    await db('event_tally').insert([{ event_id: old.id, species_code: 'eletro', added_by: b.id }, { event_id: old.id, species_code: 'acowoo', added_by: a.id }])
    const [listed] = await events.listEvents(a)
    assert.deepEqual([listed.id, listed.past, listed.active, listed.archived, listed.recap], [old.id, true, false, false, { species: 2, targets_got: 1, targets_total: 2 }])
    assert.doesNotMatch(fs.readFileSync(require.resolve('../lib/retention'), 'utf8'), /prune(Events|Trips)/)

    // Archiving is each member's own; a name can change along with it.
    assert.equal((await events.updateMembership(a, old.id, { archived: true })).archived, true)
    assert.equal((await events.listEvents(a))[0].archived, true, 'still listed, marked')
    assert.equal((await events.listEvents(b))[0].archived, false)
    await assert.rejects(events.updateMembership(a, old.id, { archived: 'yes' }), (e) => e.status === 400)
    await assert.rejects(events.updateMembership(a, old.id, { display_name: '' }), (e) => e.status === 400)
    const back = await events.updateMembership(a, old.id, { archived: false, display_name: 'Ann' })
    assert.deepEqual([back.archived, back.display_name, back.members.map((m) => m.display_name)], [false, 'Ann', ['Ann', 'B']])

    // A member leaves; only the organizer deletes it, for everyone.
    await assert.rejects(events.endEvent(b, old.id), (e) => e.status === 403)
    await events.leaveEvent(b, old.id)
    assert.deepEqual(await events.listEvents(b), [])
    await events.endEvent(a, old.id)
    assert.equal(await db('events').where({ id: old.id }).first(), undefined)
  } finally {
    await db('events').whereIn('owner_id', [a.id, b.id]).del()
    await db('users').whereIn('id', [a.id, b.id]).del()
  }
})

test('the event route: the same members-only rule as scouting, every report this week, the event\'s spot as the start, a routed plan kept an hour and a failed one not', async () => {
  const { eventRoute } = require('../lib/eventRoute')
  await db('birds').insert([['eletro', 'Elegant Trogon'], ['whewoo', 'White-eared Hummingbird']].map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const [{ id }] = await db('users').insert({ email: 'route@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const [{ id: stranger }] = await db('users').insert({ email: 'route-stranger@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  try {
    const user = await db('users').where({ id }).first()
    const [place] = await db('places').insert({ user_id: id, name: 'Chiricahuas', state: 'AZ', location: 'US-AZ-099', range_mi: 0 }).returning('*')
    await db('place_targets').insert(['eletro', 'whewoo'].map((code) => ({ place_id: place.id, species_code: code })))
    const event = await eventAt(id, place, { starts_on: dayFrom(10), ends_on: dayFrom(10), kind: 'bigday', scout: true, scout_days: 21 })
    // The feed: each species' newest report only (the trogon at a yard by Ramsey Canyon).
    const feed = [
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'A yard', locId: 'P1', lat: 31.4501, lng: -110.3001, obsDt: `${dayFrom(-1)} 07:10`, subId: 'S1', locationPrivate: true },
      { speciesCode: 'whewoo', comName: 'White-eared Hummingbird', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-3)} 09:00`, subId: 'S3', locationPrivate: false }
    ]
    // Each species' own feed: the hummingbird also at Miller Canyon, and a report too old to count.
    const species = {
      eletro: [feed[0], { ...feed[0], locId: 'L9', locName: 'Old spot', lat: 31.3, lng: -110.1, obsDt: `${dayFrom(-12)} 08:00`, locationPrivate: false }],
      whewoo: [feed[1], { ...feed[1], locId: 'L2', locName: 'Miller Canyon', lat: 31.42, lng: -110.27, obsDt: `${dayFrom(-2)} 08:00` }]
    }
    const fetchFeed = async () => feed
    let speciesCalls = 0
    const fetchSpecies = async (key, code) => { speciesCalls += 1; assert.equal(key, 'county:US-AZ-099'); return species[code] }
    let tables = 0
    const table = async (points) => { tables += 1; const f = (k) => points.map((a) => points.map((b) => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * k)); return { minutes: f(100), miles: f(70) } }
    const drive = async (points) => ({ legs: points.slice(1).map(() => ({ minutes: 12.4, miles: 6.6 })), minutes: 12.4 * (points.length - 1), miles: 6.6 * (points.length - 1), geometry: points.map((p) => [p.lat, p.lng]) })
    const failing = async () => { throw new Error('OSRM down') }
    const tools = { fetchFeed, fetchSpecies, table, drive }

    // Exactly as scouting: not a member, or no such event, is a 404.
    for (const [who, eventId] of [[{ id: stranger }, event.id], [user, 'nope']]) {
      const events = require('../lib/events')
      await assert.rejects(events.eventScouting(who, eventId, { fetchFeed }), (e) => e.status === 404)
      await assert.rejects(eventRoute(who, eventId, tools), (e) => e.status === 404)
    }
    assert.equal(tables + speciesCalls, 0)

    // No from, no event spot: the start is the first stop. The yard folds into Ramsey Canyon: both birds, one stop.
    const plan = await eventRoute(user, event.id, tools)
    assert.equal(plan.from, null)
    assert.deepEqual(plan.stops.map((s) => [s.n, s.locId, s.new_birds.map((b) => b.code).sort(), s.leg_min, s.private, s.merged]),
      [[1, 'L1', ['eletro', 'whewoo'], 0, false, [{ locId: 'P1', locName: 'A yard' }]]])
    assert.deepEqual([plan.extras, plan.covered, plan.covered_with_extras, plan.reported, plan.skipped, plan.routed], [[], 2, 2, 2, 1, true])
    assert.equal(speciesCalls, 2)

    // The event's own spot is the start (rounded), and the first leg counts.
    await db('events').where({ id: event.id }).update({ home_lat: 31.4049, home_lng: -110.2551 })
    const fromSpot = await eventRoute(user, event.id, tools)
    assert.deepEqual(fromSpot.from, { lat: 31.4, lng: -110.26 })
    assert.deepEqual(fromSpot.stops.map((s) => [s.locId, s.leg_min, s.leg_mi]), [['L1', 12, 7]])
    // A from given wins, rounded; the same rounded start again is kept, not routed again; species feeds kept too.
    const before = tables
    const asked = await eventRoute(user, event.id, { ...tools, from: '31.5049,-110.3449' })
    assert.deepEqual(asked.from, { lat: 31.5, lng: -110.34 })
    await eventRoute(user, event.id, { ...tools, from: '31.4951,-110.3351' })
    assert.equal(tables, before + 1)
    assert.equal(speciesCalls, 2)
    // A start that fails to route: the straight-line plan, not kept.
    const down = await eventRoute(user, event.id, { ...tools, from: '31.6,-110.4', table: failing })
    assert.equal(down.routed, false)
    const back = await eventRoute(user, event.id, { ...tools, from: '31.6,-110.4' })
    assert.equal(back.routed, true)
  } finally {
    await db('events').where({ owner_id: id }).del()
    await db('places').where({ user_id: id }).del()
    await db('users').whereIn('id', [id, stranger]).del()
  }
})

test('the group\'s saved route: members only, versioned saves (a stale one is a 409 with who changed it), its start the suggestion\'s, its stops on the view link without the start', async () => {
  const saved = require('../api/saved')
  const { eventRoute } = require('../lib/eventRoute')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  await db('birds').insert([['eletro', 'Elegant Trogon'], ['whewoo', 'White-eared Hummingbird']].map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const person = async (email) => (await db('users').insert({ email, password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('*'))[0]
  const matt = await person('plan-matt@example.com')
  const routing = require('../lib/routing')
  const realDrive = routing.drive
  const recentObservations = ebird.recentObservations
  const sam = await person('plan-sam@example.com')
  const stranger = await person('plan-stranger@example.com')
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (method, query, body) => { const res = fakeRes(); await saved(fakeReq({ method, headers: { cookie }, query, body }), res); return res }
  }
  try {
    const [place] = await db('places').insert({ user_id: matt.id, name: 'Huachucas', state: 'AZ', location: 'US-AZ-019', range_mi: 0 }).returning('*')
    await db('place_targets').insert(['eletro', 'whewoo'].map((code) => ({ place_id: place.id, species_code: code })))
    const event = await eventAt(matt.id, place, { starts_on: dayFrom(10), ends_on: dayFrom(10), kind: 'bigday', scout: true, home_lat: 31.4049, home_lng: -110.2551 })
    await db('event_members').where({ event_id: event.id, user_id: matt.id }).update({ display_name: 'Matt' })
    await db('event_members').insert({ event_id: event.id, user_id: sam.id, display_name: 'Sam', role: 'member' })
    const id = String(event.id)
    const q = { kind: 'event-route-plan', id }
    const mattCall = as(matt)
    const samCall = as(sam)
    const strangerCall = as(stranger)
    const view = async () => { const res = fakeRes(); await saved(fakeReq({ query: { kind: 'event-view', token: event.view_token } }), res); return res.body }
    // The area's feed (both targets at Ramsey Canyon this week) and OSRM: stand-ins, 10 minutes and 5 miles a leg.
    await db('nearby_cache').where('key', 'like', 'api:%').del()
    ebird.recentObservations = async () => [
      { speciesCode: 'whewoo', comName: 'White-eared Hummingbird', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-1)} 09:00`, subId: 'S3', locationPrivate: false, obsValid: true },
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-2)} 09:00`, subId: 'S4', locationPrivate: false, obsValid: true }
    ]
    let roads = 'up'
    routing.drive = async (points) => (roads === 'down' ? null : { legs: points.slice(1).map(() => ({ minutes: 10, miles: 5 })), minutes: 10 * (points.length - 1), miles: 5 * (points.length - 1), geometry: [] })

    // Nothing saved: the suggestion stands, and the view link has no route.
    const none = await mattCall('GET', q)
    assert.deepEqual([none.statusCode, none.body], [200, { start: null, stops: null, version: 0, position: null }])
    assert.equal((await view()).route, null)

    // Not a member, or no such event: 404, as scouting.
    const good = { start: { name: 'Our motel', lat: 31.52491, lng: -110.35512 }, stops: [{ locId: 'L1', name: 'Ramsey Canyon', lat: 31.4501234, lng: -110.3000049 }, { locId: null, name: '12 Main St', lat: 31.5, lng: -110.2, stay_min: 44.6 }], version: 0 }
    for (const [method, body] of [['GET'], ['PUT', good], ['DELETE']]) {
      assert.equal((await strangerCall(method, { ...q, version: '0' }, body)).statusCode, 404)
      assert.equal((await mattCall(method, { ...q, id: '999999', version: '0' }, body)).statusCode, 404)
    }

    // Checked: a list of up to 8 stops, each with finite lat/lng, a name up to 200 characters and an eBird locId or null; a start likewise or null; a version.
    const stop = good.stops[0]
    for (const bad of [
      { ...good, stops: 'L1' }, { ...good, stops: Array(9).fill(stop) }, { ...good, stops: [{ ...stop, lat: '31.4' }] }, { ...good, stops: [{ ...stop, lng: Infinity }] },
      { ...good, stops: [{ ...stop, lat: 91 }] }, { ...good, stops: [{ ...stop, name: 'x'.repeat(201) }] }, { ...good, stops: [{ ...stop, name: 7 }] },
      { ...good, stops: [{ ...stop, locId: 'X1' }] }, { ...good, stops: [{ ...stop, locId: 'L1x' }] }, { ...good, start: { name: 'Home', lat: 31 } },
      { ...good, start: 'home' }, { ...good, version: -1 }, { ...good, version: undefined }, { ...good, stops: [{ ...stop, stay_min: 481 }] }, { ...good, stops: [{ ...stop, stay_min: '30' }] }
    ]) assert.equal((await mattCall('PUT', q, bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80))
    assert.equal((await mattCall('GET', q)).body.version, 0)

    // Saved at version 1: stops to 5 decimals, the start to 2 (no one's doorstep), who saved it by the name they go by.
    const first = await mattCall('PUT', q, good)
    assert.equal(first.statusCode, 200)
    assert.deepEqual(first.body.start, { name: 'Our motel', lat: 31.52, lng: -110.36 })
    // Each stop with its stay (the group's, to the minute; null: the suggestion), its targets this week and the suggested stay; the drives and totals.
    assert.deepEqual(first.body.stops, [
      { locId: 'L1', name: 'Ramsey Canyon', lat: 31.45012, lng: -110.3, stay_min: null, targets_here: 2, suggested_stay_min: 30 },
      { locId: null, name: '12 Main St', lat: 31.5, lng: -110.2, stay_min: 45, targets_here: 0, suggested_stay_min: 15 }
    ])
    assert.deepEqual([first.body.legs, first.body.totals, first.body.routed], [[{ min: 10, mi: 5 }, { min: 10, mi: 5 }], { drive_min: 20, stay_min: 75, total_min: 95 }, true])
    const stored = (await db('event_routes').where({ event_id: event.id }).first()).stops
    assert.deepEqual(stored.map((s) => s.stay_min), [undefined, 45], 'only a stay the group set is stored')
    assert.deepEqual([first.body.version, first.body.updated_by_name, first.body.updated_by_you, Boolean(first.body.updated_at)], [1, 'Matt', true, true])
    const seen = await samCall('GET', q)
    assert.deepEqual([seen.body.stops, seen.body.version, seen.body.updated_by_name, seen.body.updated_by_you], [first.body.stops, 1, 'Matt', false])
    assert.deepEqual([seen.body.legs, seen.body.totals], [first.body.legs, first.body.totals], 'a GET answers as the PUT did')
    // OSRM down: no legs, the total the stays alone.
    roads = 'down'
    const unrouted = (await samCall('GET', q)).body
    assert.deepEqual([unrouted.routed, unrouted.legs, unrouted.totals], [false, null, { drive_min: null, stay_min: 75, total_min: 75 }])
    roads = 'up'
    assert.doesNotMatch(JSON.stringify(seen.body), /@/, 'never an email')

    // Sam changes it (version 2); Matt's save from version 1, or as if none were saved, is a 409 with the route as it is, by Sam.
    const second = await samCall('PUT', q, { start: null, stops: [stop], version: 1 })
    assert.deepEqual([second.statusCode, second.body.version, second.body.start, second.body.updated_by_name], [200, 2, null, 'Sam'])
    assert.deepEqual([second.body.legs, second.body.totals], [[null], { drive_min: 0, stay_min: 30, total_min: 30 }], 'no start: no drive into the first stop')
    for (const version of [1, 0, 7]) {
      const stale = await mattCall('PUT', q, { ...good, version })
      assert.equal(stale.statusCode, 409)
      assert.ok(stale.body.error)
      assert.deepEqual([stale.body.current.version, stale.body.current.updated_by_name, stale.body.current.updated_by_you, stale.body.current.stops.length], [2, 'Sam', false, 1])
      assert.deepEqual(stale.body.current.totals, second.body.totals, 'the current route as GET gives it')
    }
    const third = await mattCall('PUT', q, { ...good, version: 2 })
    assert.deepEqual([third.statusCode, third.body.version, third.body.updated_by_name, third.body.stops[1].stay_min], [200, 3, 'Matt', 45])

    // The view link: the stops as saved, never the start.
    const shown = await view()
    assert.deepEqual(shown.route, { start: null, stops: stored })
    assert.doesNotMatch(JSON.stringify(shown), /Our motel/)

    // The suggestion starts at the saved start (before the event's spot); a from given still wins.
    const feed = [{ speciesCode: 'whewoo', comName: 'White-eared Hummingbird', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-1)} 09:00`, subId: 'S3', locationPrivate: false },
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-1)} 09:00`, subId: 'S3', locationPrivate: false }]
    let tables = 0
    const table = async (points) => { tables += 1; const f = (k) => points.map((a) => points.map((b) => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * k)); return { minutes: f(100), miles: f(70) } }
    const drive = async (points) => ({ legs: points.slice(1).map(() => ({ minutes: 10, miles: 5 })), minutes: 10 * (points.length - 1), miles: 5 * (points.length - 1), geometry: points.map((p) => [p.lat, p.lng]) })
    // Each species' feed: failing every time, or only the first time per species.
    let speciesCalls = 0
    const down = async () => { speciesCalls += 1; throw new Error('eBird 503') }
    const tried = new Set()
    const flaky = async (key, code) => { speciesCalls += 1; if (!tried.has(code)) { tried.add(code); throw new Error('eBird 503') } return feed.filter((r) => r.speciesCode === code) }
    const tools = { fetchFeed: async () => feed, table, drive, retryMs: 0 }

    // A feed failing twice: asked once more each, then the plan says it's incomplete and isn't kept.
    const partial = await eventRoute(matt, event.id, { ...tools, fetchSpecies: down })
    assert.deepEqual([partial.from, partial.incomplete, partial.routed, speciesCalls], [{ lat: 31.52, lng: -110.36 }, true, true, 4])
    await eventRoute(matt, event.id, { ...tools, fetchSpecies: down })
    assert.equal(tables, 2, 'an incomplete plan is not kept')
    // Failing once: the retry gets it; complete, and kept.
    speciesCalls = 0
    const whole = await eventRoute(matt, event.id, { ...tools, fetchSpecies: flaky })
    assert.deepEqual([whole.incomplete, speciesCalls, tables], [undefined, 4, 3])
    assert.equal((await eventRoute(matt, event.id, { ...tools, fetchSpecies: flaky })).incomplete, undefined)
    assert.equal(tables, 3, 'a complete plan is kept')
    const asked = await eventRoute(matt, event.id, { ...tools, fetchSpecies: flaky, from: '31.6,-110.5' })
    assert.deepEqual(asked.from, { lat: 31.6, lng: -110.5 })

    // Cleared, by its version under the same rule: back to the suggestion and the event's spot.
    assert.equal((await samCall('DELETE', q)).statusCode, 400)
    const staleDelete = await samCall('DELETE', { ...q, version: '2' })
    assert.deepEqual([staleDelete.statusCode, staleDelete.body.current.version], [409, 3])
    const cleared = await samCall('DELETE', { ...q, version: '3' })
    assert.deepEqual([cleared.statusCode, cleared.body], [200, { start: null, stops: null, version: 0, position: null }])
    assert.deepEqual((await mattCall('GET', q)).body, { start: null, stops: null, version: 0, position: null })
    assert.equal((await view()).route, null)
    assert.deepEqual((await eventRoute(matt, event.id, { ...tools, fetchSpecies: flaky })).from, { lat: 31.4, lng: -110.26 })
    // Saving again starts over at version 1; the route goes with the event.
    assert.equal((await samCall('PUT', q, good)).body.version, 1)
    await db('events').where({ id: event.id }).del()
    assert.equal((await db('event_routes').where({ event_id: event.id })).length, 0)
  } finally {
    await db('events').where({ owner_id: matt.id }).del()
    await db('places').where({ user_id: matt.id }).del()
    await db('users').whereIn('id', [matt.id, sam.id, stranger.id]).del()
    ebird.recentObservations = recentObservations
    routing.drive = realDrive
  }
})

test('the migration: every trip becomes a solo event at its place, with its dates, scouting, notes sent and target birds; the trips go', async () => {
  const migration = require('../db/migrations/20261119090000_events_standalone')
  const { dayOf } = require('../lib/places')
  const [user] = await db('users').insert({ email: 'migrate-trips@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('*')
  try {
    await migration.down(db)
    const [place] = await db('places').insert({ user_id: user.id, name: 'Chiricahuas', state: 'AZ', location: 'US-AZ-003', range_mi: 15, home_lat: 31.9, home_lng: -109.2 }).returning('*')
    await db('place_targets').insert([{ place_id: place.id, species_code: 'eletro' }, { place_id: place.id, species_code: 'mexchi' }])
    const sent = new Date('2026-11-01T12:00:00Z')
    await db('trips').insert({ place_id: place.id, starts_on: dayFrom(5), ends_on: dayFrom(5), kind: 'bigday', scout: true, scout_days: 14, last_scout_sent_on: dayFrom(0), started_notice_at: sent })
    await db('trips').insert({ place_id: place.id, starts_on: dayFrom(30), ends_on: dayFrom(32) })
    await migration.up(db)

    assert.equal(Number((await db('trips').count('* as n').first()).n), 0, 'the trips go')
    const made = await db('events').where({ owner_id: user.id }).orderBy('starts_on')
    assert.deepEqual(made.map((e) => [e.place_id, e.name, e.state, e.location, e.range_mi, Number(e.home_lat), dayOf(e.starts_on), dayOf(e.ends_on), e.kind, e.scout, e.scout_days]), [
      [place.id, 'Chiricahuas', 'AZ', 'US-AZ-003', 15, 31.9, dayFrom(5), dayFrom(5), 'bigday', true, 14],
      [place.id, 'Chiricahuas', 'AZ', 'US-AZ-003', 15, 31.9, dayFrom(30), dayFrom(32), 'trip', false, 21]
    ])
    assert.notEqual(made[0].invite_token, made[1].invite_token)
    // In the events' order (by date): the migration reads the trips in no set order, so their event ids needn't follow it.
    const order = made.map((e) => e.id)
    const members = (await db('event_members').whereIn('event_id', order)).sort((x, y) => order.indexOf(x.event_id) - order.indexOf(y.event_id))
    assert.deepEqual(members.map((m) => [m.user_id, m.role, m.display_name, m.last_scout_sent_on && dayOf(m.last_scout_sent_on), m.started_notice_at?.toISOString() ?? null, m.archived_at]), [
      [user.id, 'organizer', null, dayFrom(0), sent.toISOString(), null],
      [user.id, 'organizer', null, null, null, null]
    ])
    const targets = await db('event_targets').where({ event_id: made[0].id }).orderBy('species_code')
    assert.deepEqual(targets.map((t) => [t.species_code, t.added_by]), [['eletro', user.id], ['mexchi', user.id]])
  } finally {
    // Never leave the schema rolled back for the tests after this one.
    if (!(await db.schema.hasColumn('events', 'place_id'))) await migration.up(db)
    await db('events').where({ owner_id: user.id }).del()
    await db('users').where({ id: user.id }).del()
  }
})

test('the event page\'s scouting: members only, last week\'s reports of the targets and the ones quiet two weeks, likely lifers when none, the area asked once an hour', async () => {
  const events = require('../lib/events')
  const scouting = require('../lib/scouting')
  const birds = [['eletro', 'Elegant Trogon'], ['mexchi', 'Mexican Chickadee'], ['monqua', 'Montezuma Quail'], ['whewoo', 'White-eared Hummingbird']]
  await db('birds').insert(birds.map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const [{ id }] = await db('users').insert({ email: 'scout-view@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const [{ id: stranger }] = await db('users').insert({ email: 'scout-view-stranger@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('id')
  const likelyFor = scouting.likelyFor
  try {
    const user = await db('users').where({ id }).first()
    const [place] = await db('places').insert({ user_id: id, name: 'Huachucas', state: 'AZ', location: 'US-AZ-023', range_mi: 0 }).returning('*')
    await db('place_targets').insert(['eletro', 'mexchi', 'monqua', 'whewoo'].map((code) => ({ place_id: place.id, species_code: code })))
    const event = await eventAt(id, place, { starts_on: dayFrom(10), ends_on: dayFrom(10), kind: 'bigday', scout: true, scout_days: 21 })
    const feed = [
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-1)} 07:10`, subId: 'S1', userDisplayName: 'Jane Birder', obsValid: true, obsReviewed: true, hasRichMedia: true },
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Miller Canyon', locId: 'L2', lat: 31.42, lng: -110.27, obsDt: `${dayFrom(-4)} 08:00`, subId: 'S2', userDisplayName: 'Joe Birder', obsValid: true, obsReviewed: false },
      { speciesCode: 'whewoo', comName: 'White-eared Hummingbird', locName: 'Beatty\'s', locId: 'L3', lat: 31.4, lng: -110.25, obsDt: `${dayFrom(-3)} 09:00`, subId: 'S3', userDisplayName: 'Jane Birder', obsValid: true, obsReviewed: false },
      { speciesCode: 'mexchi', comName: 'Mexican Chickadee', locName: 'Carr Canyon', locId: 'L4', lat: 31.43, lng: -110.29, obsDt: `${dayFrom(-10)} 09:00`, subId: 'S4', obsValid: true, obsReviewed: false },
      { speciesCode: 'acowoo', comName: 'Acorn Woodpecker', locName: 'Sierra Vista', locId: 'L5', lat: 31.5, lng: -110.3, obsDt: `${dayFrom(0)} 08:00`, subId: 'S5', obsValid: true }
    ]
    let calls = 0
    const fetchFeed = async (key) => { calls += 1; assert.equal(key, 'county:US-AZ-023'); return feed }

    // Members only.
    await assert.rejects(events.eventScouting({ id: stranger }, event.id, { fetchFeed }), (e) => e.status === 404)
    await assert.rejects(events.eventScouting(user, 'nope', { fetchFeed }), (e) => e.status === 404)

    // Targets: each one's latest report in the last 7 days, newest first; none in 14 days is unreported.
    const view = await events.eventScouting(user, event.id, { fetchFeed })
    assert.equal(view.days_to_go, 10)
    assert.deepEqual(view.window, { from: dayFrom(-11), to: dayFrom(10) })
    assert.equal(view.using, 'targets')
    assert.deepEqual(view.reported.map((r) => [r.code, r.locName, r.subId]), [['eletro', 'Ramsey Canyon', 'S1'], ['whewoo', 'Beatty\'s', 'S3']])
    assert.deepEqual(view.reported[0], { code: 'eletro', speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-1)} 07:10`, birders: 1, confirmed: true, media: 'photo', subId: 'S1' })
    assert.equal(view.reported[1].confirmed, null, 'an ordinary report has nothing to confirm')
    assert.deepEqual(view.unreported, [{ code: 'monqua', speciesCode: 'monqua', comName: 'Montezuma Quail' }])
    assert.ok(!view.reported.some((r) => r.code === 'mexchi') && !view.unreported.some((r) => r.code === 'mexchi'), '10 days ago: neither last week nor quiet')
    assert.ok(!JSON.stringify(view).includes('Birder'), 'no observer names')

    // Asked again within the hour: the area's feed is not fetched again.
    await events.eventScouting(user, event.id, { fetchFeed })
    assert.equal(calls, 1)

    // No targets: the person's likely lifers for the dates stand in.
    await db('event_targets').where({ event_id: event.id }).del()
    scouting.likelyFor = async () => ['monqua', 'whewoo']
    const standIn = await events.eventScouting(user, event.id, { fetchFeed })
    assert.equal(standIn.using, 'likely_lifers')
    assert.deepEqual(standIn.reported.map((r) => r.code), ['whewoo'])
    assert.deepEqual(standIn.unreported.map((r) => r.code), ['monqua'])
    assert.equal(calls, 1)

    // Past: empty lists, no countdown, nothing fetched.
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(-3), ends_on: dayFrom(-2) })
    const past = await events.eventScouting(user, event.id, { fetchFeed: async () => { throw new Error('a past event asks nothing') } })
    assert.deepEqual([past.days_to_go, past.reported, past.unreported], [null, [], []])
  } finally {
    scouting.likelyFor = likelyFor
    await db('events').where({ owner_id: id }).del()
    await db('places').where({ user_id: id }).del()
    await db('users').whereIn('id', [id, stranger]).del()
  }
})

test('the event page\'s scouting today: what\'s new, the bird of the day and the headline as the morning push and email say them; every target where it stands, lifers marked', async () => {
  const events = require('../lib/events')
  const scouting = require('../lib/scouting')
  const abaCodes = require('../lib/abaCodes')
  const { emailScoutingNow } = require('../lib/scoutEmail')
  await db('birds').insert([
    { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', sciName: 'Turdus rufopalliatus', birdImg: 'https://example.org/robin.jpg' },
    ...[['eletro', 'Elegant Trogon'], ['mexchi', 'Mexican Chickadee'], ['monqua', 'Montezuma Quail'], ['whewoo', 'White-eared Hummingbird']].map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))
  ]).onConflict('speciesCode').merge(['birdImg'])
  // The ABA codes the alerts use: by scientific name, else the English name.
  await db('aba_codes').insert([['Turdus rufopalliatus', 'Rufous-backed Robin', 3], ['Trogon elegans', 'Elegant Trogon', 2], ['Basilinna leucotis', 'White-eared Hummingbird', 3],
    ['Poecile sclateri', 'Mexican Chickadee', 3], ['Cyrtonyx montezumae', 'Montezuma Quail', 2]].map(([sci_name, com_name, code]) => ({ sci_name, com_name, code, version: 'test' }))).onConflict('sci_name').ignore()
  abaCodes.forgetCodes()
  const [{ id }] = await db('users').insert({ email: 'scout-today@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true, trip_emails_enabled: true, timezone: 'UTC' }).returning('id')
  const likelyFor = scouting.likelyFor
  const d = dayFrom
  // Noon today, UTC (the person's zone and the event's).
  const now = new Date(`${d(0)}T12:00:00Z`)
  // The page's hour-kept copy of the area's feed (lib/apiGuard shared): fresh for this test, and gone after it.
  const kept = `api:${require('crypto').createHash('sha1').update('scout-view:county:US-AZ-019').digest('hex')}`
  try {
    const user = await db('users').where({ id }).first()
    const [place] = await db('places').insert({ user_id: id, name: 'Huachucas', state: 'AZ', location: 'US-AZ-019', range_mi: 0 }).returning('*')
    await db('place_targets').insert(['eletro', 'mexchi', 'monqua', 'rubrob', 'whewoo'].map((code) => ({ place_id: place.id, species_code: code })))
    const event = await eventAt(id, place, { starts_on: d(10), ends_on: d(10), kind: 'bigday', scout: true, scout_days: 21 })
    const feed = [
      { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', sciName: 'Turdus rufopalliatus', locName: 'Beatty Ranch', locId: 'L1', lat: 31.4, lng: -110.25, obsDt: `${d(0)} 07:30`, subId: 'S1', obsValid: true, obsReviewed: true, hasRichMedia: true },
      { speciesCode: 'eletro', comName: 'Elegant Trogon', sciName: 'Trogon elegans', locName: 'Ramsey Canyon', locId: 'L2', lat: 31.45, lng: -110.3, obsDt: `${d(0)} 09:00`, subId: 'S2', obsValid: true, obsReviewed: false },
      { speciesCode: 'eletro', comName: 'Elegant Trogon', sciName: 'Trogon elegans', locName: 'Miller Canyon', locId: 'L3', lat: 31.42, lng: -110.27, obsDt: `${d(-2)} 08:00`, subId: 'S3', obsValid: true, obsReviewed: false },
      { speciesCode: 'whewoo', comName: 'White-eared Hummingbird', sciName: 'Basilinna leucotis', locName: 'Carr Canyon', locId: 'L4', lat: 31.43, lng: -110.29, obsDt: `${d(-3)} 09:00`, subId: 'S4', obsValid: true, obsReviewed: false },
      { speciesCode: 'mexchi', comName: 'Mexican Chickadee', sciName: 'Poecile sclateri', locName: 'Rustler Park', locId: 'L5', lat: 31.9, lng: -109.28, obsDt: `${d(-10)} 09:00`, subId: 'S5', obsValid: true, obsReviewed: false }
    ]
    let calls = 0
    const fetchFeed = async (key) => { calls += 1; assert.equal(key, 'county:US-AZ-019'); return feed }
    await db('nearby_cache').where({ key: kept }).del()

    // The morning report, for the same feed: one push and one email.
    const pushes = []
    const mails = []
    await scouting.runScouting({ now, fetchFeed, push: async (userId, payload) => { if (userId === id) pushes.push(payload); return { sent: 1 } }, send: async (m) => { if (m.to === user.email) mails.push(m) } })
    assert.equal(mails.length, 1)
    const daily = mails[0]
    assert.match(pushes[0].data.url, new RegExp(`/events/${event.id}#scouting$`), 'the push opens the scouting card')
    assert.match(daily.text, new RegExp(`Open the event: \\S+/events/${event.id}#scouting\n`), 'so does the email')
    assert.match(daily.html, new RegExp(`href="[^"]+/events/${event.id}#scouting"`))

    const view = await events.eventScouting(user, event.id, { fetchFeed, now, locale: 'en' })
    // The headline is the email's subject.
    assert.equal(view.headline, 'Huachucas: Elegant Trogon and 1 more new today · 10 days to go')
    assert.equal(view.headline, daily.subject)
    // What's new: the email's list (its bird of the day shown above it, not again), rarest first here.
    assert.equal(daily.text.match(/^New: (.*)$/m)[1], 'Elegant Trogon')
    assert.deepEqual(view.fresh.map((f) => f.comName).sort(), [...daily.text.match(/^New: (.*)$/m)[1].split(', '), view.bird_of_day.comName].sort())
    assert.deepEqual(view.fresh, [
      { code: 'rubrob', speciesCode: 'rubrob', comName: 'Rufous-backed Robin', locName: 'Beatty Ranch', locId: 'L1', obsDt: `${d(0)} 07:30`, aba: 3, flagged: true },
      { code: 'eletro', speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L2', obsDt: `${d(0)} 09:00`, aba: 2, flagged: false }
    ])
    // The bird of the day: the email's.
    assert.match(daily.text, /Bird of the day: Rufous-backed Robin \(ABA Code 3\)\nBeatty Ranch · /)
    const { evidence, ...hero } = view.bird_of_day
    assert.deepEqual(hero, { code: 'rubrob', speciesCode: 'rubrob', comName: 'Rufous-backed Robin', locName: 'Beatty Ranch', obsDt: `${d(0)} 07:30`, aba: 3, photo: 'https://example.org/robin.jpg' })
    assert.ok(evidence && daily.text.includes(evidence), 'the reviewer line the email shows')
    // Asked for now from the page, the email says the same (its subject says when it was asked).
    const asked = []
    await db('nearby_cache').where({ key: `scout-email:${event.id}:${id}` }).del()
    assert.equal((await emailScoutingNow(user, event.id, { now, fetchFeed, send: async (m) => { asked.push(m) } })).status, 200)
    assert.match(asked[0].text, /^New: Elegant Trogon$/m)
    assert.match(asked[0].text, /Bird of the day: Rufous-backed Robin \(ABA Code 3\)/)

    // Every target: around (last 7 days), quiet (in between), missing (nothing in 14). Too short a life list: no lifers marked.
    assert.deepEqual(view.targets, [
      { code: 'eletro', speciesCode: 'eletro', comName: 'Elegant Trogon', status: 'around', last_obs_dt: `${d(0)} 09:00`, last_loc_name: 'Ramsey Canyon', aba: 2, lifer: false },
      { code: 'rubrob', speciesCode: 'rubrob', comName: 'Rufous-backed Robin', status: 'around', last_obs_dt: `${d(0)} 07:30`, last_loc_name: 'Beatty Ranch', aba: 3, lifer: false },
      { code: 'whewoo', speciesCode: 'whewoo', comName: 'White-eared Hummingbird', status: 'around', last_obs_dt: `${d(-3)} 09:00`, last_loc_name: 'Carr Canyon', aba: 3, lifer: false },
      { code: 'mexchi', speciesCode: 'mexchi', comName: 'Mexican Chickadee', status: 'quiet', last_obs_dt: `${d(-10)} 09:00`, last_loc_name: 'Rustler Park', aba: 3, lifer: false },
      { code: 'monqua', speciesCode: 'monqua', comName: 'Montezuma Quail', status: 'missing', last_obs_dt: null, last_loc_name: null, aba: 2, lifer: false }
    ])
    // The old lists stay as they were.
    assert.deepEqual(view.reported.map((r) => r.code), ['eletro', 'rubrob', 'whewoo'])
    assert.deepEqual(view.unreported.map((r) => r.code), ['monqua'])

    // A life list of 10 or more: the targets not on it are lifers.
    const short = ['eletro', 'acowoo', 'mallar3']
    await db('seen_birds').insert(short.map((species_code) => ({ user_id: id, species_code })))
    assert.ok((await events.eventScouting(user, event.id, { fetchFeed, now })).targets.every((t) => !t.lifer), 'under 10 birds: none marked, as lifer alerts')
    await db('seen_birds').insert(Array.from({ length: 8 }, (_, i) => ({ user_id: id, species_code: `filler${i}` })))
    const listed = await events.eventScouting(user, event.id, { fetchFeed, now })
    assert.deepEqual(listed.targets.map((t) => [t.code, t.lifer]), [['eletro', false], ['rubrob', true], ['whewoo', true], ['mexchi', true], ['monqua', true]])

    // No targets picked: the likely lifers, and the headline says so.
    await db('event_targets').where({ event_id: event.id }).del()
    scouting.likelyFor = async () => ['monqua', 'mexchi']
    const standIn = await events.eventScouting(user, event.id, { fetchFeed, now })
    assert.equal(standIn.using, 'likely_lifers')
    assert.deepEqual(standIn.targets.map((t) => [t.code, t.status]), [['mexchi', 'quiet'], ['monqua', 'missing']])
    assert.deepEqual([standIn.fresh, standIn.bird_of_day], [[], null])
    assert.equal(standIn.headline, 'Huachucas: no likely lifers reported yet · 10 days to go')
    assert.equal(calls, 2, 'one for the morning run, one for the page: kept an hour, however often it\'s asked')

    // Past: nothing.
    await db('events').where({ id: event.id }).update({ starts_on: d(-3), ends_on: d(-2) })
    const past = await events.eventScouting(user, event.id, { fetchFeed: async () => { throw new Error('a past event asks nothing') }, now })
    assert.deepEqual([past.fresh, past.bird_of_day, past.headline, past.targets], [[], null, null, []])
  } finally {
    scouting.likelyFor = likelyFor
    await db('aba_codes').where({ version: 'test' }).del()
    abaCodes.forgetCodes()
    await db('nearby_cache').where({ key: kept }).del()
    await db('events').where({ owner_id: id }).del()
    await db('places').where({ user_id: id }).del()
    await db('seen_birds').where({ user_id: id }).del()
    await db('users').where({ id }).del()
  }
})

test('"Email me the scouting report now": members only, a confirmed address, before the event ends, 3 an hour; targets, likely lifers or what else is about, and the group\'s route', async () => {
  const saved = require('../api/saved')
  const scouting = require('../lib/scouting')
  const mailer = require('../lib/mailer')
  const routePlan = require('../lib/eventRoutePlan')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const birds = [['eletro', 'Elegant Trogon'], ['monqua', 'Montezuma Quail'], ['whewoo', 'White-eared Hummingbird'], ['acowoo', 'Acorn Woodpecker'], ['brrspa', 'Rufous-winged Sparrow'], ['flaowl', 'Flammulated Owl']]
  await db('birds').insert(birds.map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  const person = async (email, fields = {}) => (await db('users').insert({ email, password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true, timezone: 'UTC', ...fields }).returning('*'))[0]
  const pat = await person('pat-scout@example.com', { trip_emails_enabled: false })
  const stranger = await person('scout-email-stranger@example.com')
  const unconfirmed = await person('scout-email-unconfirmed@example.com', { email_confirmed: false })
  const friend = await person('scout-email-friend@example.com')
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (id) => { const res = fakeRes(); await saved(fakeReq({ method: 'POST', headers: { cookie }, query: { kind: 'event-scouting-email', id: String(id) } }), res); return res }
  }
  const feed = [
    { speciesCode: 'eletro', comName: 'Elegant Trogon', sciName: 'Elegant Trogon', locName: 'Ramsey Canyon', locId: 'L1', lat: 31.45, lng: -110.3, obsDt: `${dayFrom(-2)} 07:10`, subId: 'S1', obsValid: true, obsReviewed: false },
    { speciesCode: 'whewoo', comName: 'White-eared Hummingbird', sciName: 'White-eared Hummingbird', locName: 'Beatty Ranch', locId: 'L3', lat: 31.4, lng: -110.25, obsDt: `${dayFrom(-3)} 09:00`, subId: 'S3', obsValid: true, obsReviewed: true },
    { speciesCode: 'acowoo', comName: 'Acorn Woodpecker', sciName: 'Acorn Woodpecker', locName: 'Sierra Vista', locId: 'L5', lat: 31.5, lng: -110.3, obsDt: `${dayFrom(-1)} 08:00`, subId: 'S5', obsValid: true },
    { speciesCode: 'acowoo', comName: 'Acorn Woodpecker', sciName: 'Acorn Woodpecker', locName: 'Carr Canyon', locId: 'L4', lat: 31.43, lng: -110.29, obsDt: `${dayFrom(-4)} 08:00`, subId: 'S6', obsValid: true },
    { speciesCode: 'brrspa', comName: 'Rufous-winged Sparrow', sciName: 'Rufous-winged Sparrow', locName: 'San Pedro House', locId: 'L6', lat: 31.55, lng: -110.14, obsDt: `${dayFrom(-5)} 07:00`, subId: 'S7', obsValid: true },
    { speciesCode: 'monqua', comName: 'Montezuma Quail', sciName: 'Montezuma Quail', locName: 'Miller Canyon', locId: 'L2', lat: 31.42, lng: -110.27, obsDt: `${dayFrom(-10)} 07:00`, subId: 'S8', obsValid: true },
    { speciesCode: 'duck1', comName: 'duck sp.', locName: 'Pond', locId: 'L7', lat: 31.5, lng: -110.2, obsDt: `${dayFrom(-1)} 07:00`, subId: 'S9', obsValid: true }
  ]
  const recentObservations = ebird.recentObservations
  const likelyFor = scouting.likelyFor
  const sendMail = mailer.sendMail
  const routing = require('../lib/routing')
  const realDrive = routing.drive
  // OSRM stand-in: 10 minutes and 5 miles a leg.
  routing.drive = async (points) => ({ legs: points.slice(1).map(() => ({ minutes: 10, miles: 5 })), minutes: 10 * (points.length - 1), miles: 5 * (points.length - 1), geometry: [] })
  let calls = 0
  ebird.recentObservations = async (region) => { calls += 1; assert.equal(region, 'US-AZ-003'); return feed }
  const mails = []
  mailer.sendMail = async (m) => { mails.push(m); return {} }
  const [place] = await db('places').insert({ user_id: pat.id, name: 'Chiricahuas', state: 'AZ', location: 'US-AZ-003', range_mi: 0 }).returning('*')
  await db('place_targets').insert(['eletro', 'monqua', 'flaowl'].map((code) => ({ place_id: place.id, species_code: code })))
  const event = await eventAt(pat.id, { ...place, range_mi: 0 }, { starts_on: dayFrom(10), ends_on: dayFrom(10), kind: 'bigday', scout: true })
  await db('event_members').insert({ event_id: event.id, user_id: unconfirmed.id, role: 'member' })
  await db('event_members').where({ event_id: event.id, user_id: pat.id }).update({ last_scout_sent_on: dayFrom(-1) })
  const key = `scout-email:${event.id}:${pat.id}`
  const resetLimit = () => db('nearby_cache').where({ key }).del()
  const patCall = as(pat)
  const last = () => mails[mails.length - 1]
  try {
    await db('nearby_cache').where('key', 'like', 'api:%').del()

    // Not a member, or no such event: the 404 every event call gives. Unconfirmed: 409.
    assert.equal((await as(stranger)(event.id)).statusCode, 404)
    assert.equal((await patCall(999999)).statusCode, 404)
    const notConfirmed = await as(unconfirmed)(event.id)
    assert.deepEqual([notConfirmed.statusCode, notConfirmed.body], [409, { error: 'confirm_email' }])
    assert.equal(mails.length, 0)
    await db('event_members').where({ event_id: event.id, user_id: unconfirmed.id }).del()

    // A member, with trip emails off: sent to them alone, the address masked; their targets of the last 7 days.
    const ok = await patCall(event.id)
    assert.deepEqual([ok.statusCode, ok.body], [200, { sent: true, to: 'p•••@example.com' }])
    assert.equal(mails.length, 1)
    assert.equal(last().to, 'pat-scout@example.com')
    assert.match(last().subject, /^Scouting report for Chiricahuas \(as of \d{1,2}:\d{2} [AP]M\)$/)
    assert.match(last().text, /^Chiricahuas · 10 days to go\n1 of 3 targets reported this week\n/)
    assert.match(last().text, /Where they’re being seen:\n1\. Ramsey Canyon \(2 days ago\)\n   Elegant Trogon\n/)
    assert.match(last().text, /Still missing \(nothing in the last 2 weeks\): Flammulated Owl\n/)
    assert.ok(!last().text.includes('Montezuma Quail'), 'reported 10 days ago: neither this week nor quiet')
    assert.ok(!last().text.includes('What’s being seen there this week'), 'targets reported: no fallback list')
    assert.match(last().text, new RegExp(`Your route:\nNo route saved yet\. Plan your route: \\S+/events/${event.id}#route`))
    assert.ok(!last().text.includes('Meeting point'), 'no saved route, no stops')
    assert.ok(!last().text.includes('/unsubscribe/') && !last().html.includes('Turn off trip emails'), 'asked for: not a trip email to turn off')
    // The morning report is left as it was.
    const member = await db('event_members').where({ event_id: event.id, user_id: pat.id }).first()
    assert.equal(require('../lib/places').dayOf(member.last_scout_sent_on), dayFrom(-1))

    // A saved route: its stops, numbered, and where to meet; a group says so.
    await db('event_members').insert({ event_id: event.id, user_id: friend.id, role: 'member' })
    const plan = await routePlan.putPlan(pat, event.id, { start: { name: 'Our motel', lat: 31.9, lng: -109.2 }, stops: [{ locId: 'L1', name: 'Ramsey Canyon', lat: 31.45, lng: -110.3 }, { locId: null, name: 'Carr Canyon', lat: 31.43, lng: -110.29 }], version: 0 })
    assert.ok(plan.ok)
    assert.equal((await patCall(event.id)).statusCode, 200)
    // As the app shows it (the same routeDetails): Ramsey Canyon has 1 target this week (Elegant Trogon), Carr Canyon is a typed point.
    assert.match(last().text, /Your group’s route:\nMeeting point: Our motel\n↓ 10 min drive · 5 mi\n1\. Ramsey Canyon · 20 min there \(suggested, 1 target\)\n↓ 10 min drive · 5 mi\n2\. Carr Canyon · 15 min there \(suggested\)\nDriving 20 min · At stops 35 min · Total 55 min\n/)
    assert.ok(!last().text.includes('Plan your route'))
    assert.match(last().text, /^Chiricahuas · 10 days to go\nWith your group\n/)
    assert.match(last().html, /Plan the route/)

    // No targets: likely lifers stand in.
    await db('event_targets').where({ event_id: event.id }).del()
    scouting.likelyFor = async () => ['whewoo', 'monqua']
    assert.equal((await patCall(event.id)).statusCode, 200)
    assert.match(last().text, /You haven’t picked target birds yet, so these are likely lifers for your dates\./)
    assert.match(last().text, /1 of 2 likely lifers reported this week/)
    assert.match(last().text, /Bird of the day: White-eared Hummingbird\nBeatty Ranch · .*\nConfirmed by eBird reviewer/)

    // The 4th within the hour: 429, with how long to wait.
    const tooMany = await patCall(event.id)
    assert.equal(tooMany.statusCode, 429)
    assert.equal(tooMany.body.error, 'too_many')
    assert.ok(tooMany.body.retry_after_min >= 1 && tooMany.body.retry_after_min <= 60, String(tooMany.body.retry_after_min))
    assert.equal(mails.length, 3)

    // No targets and no likely lifers: what's being seen there this week, rarest first, then the most reported; and an invitation to pick targets.
    await resetLimit()
    scouting.likelyFor = async () => []
    assert.equal((await patCall(event.id)).statusCode, 200)
    const text = last().text
    assert.ok(!text.includes('None of your target birds'), 'no targets: nothing to say of them')
    assert.ok(!text.includes('targets reported'), 'no targets: no bar')
    const list = text.split('What’s being seen there this week:\n')[1].split('\n\n')[0]
    assert.deepEqual(list.split('\n').filter((l) => /^\d\./.test(l)), ['1. Beatty Ranch (3 days ago)', '2. Sierra Vista (yesterday)', '3. Ramsey Canyon (2 days ago)', '4. San Pedro House (5 days ago)'])
    assert.match(list, /1\. Beatty Ranch \(3 days ago\)\n   White-eared Hummingbird \(rare there\)\n   Checklist on eBird: https:\/\/ebird.org\/checklist\/S3/)
    assert.match(list, /2\. Sierra Vista \(yesterday\)\n   Acorn Woodpecker\n/, 'its newest report')
    assert.ok(!text.includes('Montezuma Quail') && !text.includes('duck sp.'), 'older than a week, or not one species: left out')
    assert.match(text, new RegExp(`Pick the birds you’re after and this report will follow them\\. \\S+/events/${event.id}\\b`))

    // Targets picked but none reported this week: said so, and what else is about.
    await db('event_targets').insert({ event_id: event.id, species_code: 'monqua', added_by: pat.id })
    assert.equal((await patCall(event.id)).statusCode, 200)
    assert.match(last().text, /None of your target birds were reported there in the last 7 days\./)
    assert.match(last().text, /What’s being seen there this week:\n1\. Beatty Ranch/)
    assert.match(last().text, /0 of 1 target reported this week/)
    assert.ok(!last().text.includes('Pick the birds you’re after'))

    // The day's mail used up: 503, and the try doesn't count against them.
    await resetLimit()
    mailer.sendMail = async () => { const e = new Error('cap'); e.code = 'MAIL_CAP'; throw e }
    const capped = await patCall(event.id)
    assert.deepEqual([capped.statusCode, capped.body], [503, { error: 'mail_cap' }])
    const row = await db('nearby_cache').where({ key }).first()
    assert.deepEqual(row.detail, [])
    mailer.sendMail = async (m) => { mails.push(m); return {} }

    // On the day itself it still goes, worded for the day; the day before is the final report. Once it's over: 400.
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(0), ends_on: dayFrom(0) })
    assert.equal((await patCall(event.id)).statusCode, 200)
    assert.match(last().text, /^Chiricahuas · today\n/)
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(1), ends_on: dayFrom(1) })
    assert.equal((await patCall(event.id)).statusCode, 200)
    assert.match(last().text, /^Chiricahuas · tomorrow\n/)
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(-3), ends_on: dayFrom(-1) })
    const over = await patCall(event.id)
    assert.deepEqual([over.statusCode, over.body], [400, { error: 'event_over' }])

    // The area's feed came from eBird once, shared for the hour; the morning report is still to come.
    assert.equal(calls, 1)
    assert.equal(require('../lib/places').dayOf((await db('event_members').where({ event_id: event.id, user_id: pat.id }).first()).last_scout_sent_on), dayFrom(-1))
  } finally {
    ebird.recentObservations = recentObservations
    scouting.likelyFor = likelyFor
    mailer.sendMail = sendMail
    routing.drive = realDrive
    await db('nearby_cache').where('key', 'like', 'scout-email:%').del()
    await db('events').where({ owner_id: pat.id }).del()
    await db('places').where({ user_id: pat.id }).del()
    await db('users').whereIn('id', [pat.id, stranger.id, unconfirmed.id, friend.id]).del()
  }
})

test('rare birds still to see: notable pushes and the uncommon-sightings email skip life birds unless watched, by the place\'s list when it says so, never on a short list', async () => {
  const { runPushAlerts } = require('../lib/pushAlerts')
  const { DIGESTS } = require('../lib/digests')
  const places = require('../lib/places')
  const region = 'US-ZN-001'
  const area = 'US-ZN-009'
  const keep = { recent: ebird.recentObservations, notable: ebird.notableObservations, subregions: ebird.subregions, info: ebird.regionInfo }
  ebird.subregions = async () => [{ code: area, name: 'Far County' }]
  ebird.regionInfo = async () => { throw new Error('no center') }
  const base = { password_hash: 'x', location: region, state: 'ZN', push_notable_enabled: true, push_watchlist_enabled: false, range_mi: 0, push_quiet_start: null, push_quiet_end: null, email_confirmed: true }
  const [{ id: skip }] = await db('users').insert({ ...base, email: 'skip-seen@example.com', notable_skip_seen: true }).returning('id')
  const [{ id: all }] = await db('users').insert({ ...base, email: 'skip-seen-off@example.com' }).returning('id')
  const ids = [skip, all]
  await db('push_subscriptions').insert(ids.map((id) => ({ user_id: id, endpoint: `https://push.example/skip-${id}`, p256dh: 'k', auth: 'a' })))
  const names = { nsrail: 'Seen Rail', nskite: 'New Kite', nswren: 'Starred Wren' }
  for (const [speciesCode, comName] of Object.entries(names)) {
    await db('birds').insert({ speciesCode, comName, sciName: `${comName} sci`, category: 'species' }).onConflict('speciesCode').ignore()
  }
  // Both have seen the rail and the wren (and nine more); the skipping account has starred the wren.
  const nine = Array.from({ length: 9 }, (_, i) => `ns${i}zz`)
  for (const id of ids) await db('seen_birds').insert([...nine, 'nsrail', 'nswren'].map((species_code) => ({ user_id: id, species_code, first_seen: '2020-01-01', source: 'tap' })))
  await db('saved_birds').insert({ user_id: skip, speciesCode: 'nswren', bird_id: (await db('birds').where({ speciesCode: 'nswren' }).first('id')).id })
  const obs = (speciesCode, subId) => ({ speciesCode, comName: names[speciesCode], locId: `L${subId}`, locName: 'Marsh', obsDt: '2026-11-03 08:00', lat: 34.3, lng: -83.8, subId, userDisplayName: 'Ann', obsReviewed: true, obsValid: true })
  let feeds = { [region]: [obs('nsrail', 'R1'), obs('nskite', 'K1'), obs('nswren', 'W1')] }
  ebird.recentObservations = async () => []
  ebird.notableObservations = async (r) => feeds[r] || []
  const sent = []
  const send = async (userId, payload) => { sent.push([userId, `${payload.title} ${payload.body}`]); return { sent: 1, gone: 0 } }
  const heard = (userId) => Object.values(names).filter((name) => sent.some(([u, text]) => u === userId && text.includes(name))).sort()
  const reset = async () => { sent.length = 0; await db('push_log').whereIn('user_id', ids).del() }
  try {
    // On: the rail (seen) is left out; the kite (new) and the starred wren (seen, but watched) come.
    await runPushAlerts({ send })
    assert.deepEqual(heard(skip), ['New Kite', 'Starred Wren'])
    assert.deepEqual(heard(all), ['New Kite', 'Seen Rail', 'Starred Wren'], 'off: every rare bird, as before')

    // The email likewise; and when every rare bird is one they've seen, no email that day.
    const skipUser = await db('users').where({ id: skip }).first()
    const allUser = await db('users').where({ id: all }).first()
    assert.deepEqual((await DIGESTS.rare.select(skipUser, feeds[region], { preview: true })).map((o) => o.speciesCode).sort(), ['nskite', 'nswren'])
    assert.equal((await DIGESTS.rare.select(allUser, feeds[region], { preview: true })).length, 3)
    feeds = { [region]: [obs('nsrail', 'R2')] }
    const mailed = []
    const kind = 'rare-skip-seen-test'
    const run = await runDigest({ ...DIGESTS.rare, kind, send: async (user, rows) => { if (ids.includes(user.id)) mailed.push([user.id, rows.map((o) => o.speciesCode)]) } })
    assert.deepEqual(mailed, [[all, ['nsrail']]], 'nothing left for the skipping account: no email, as on a quiet day')
    assert.equal(await db('digest_log').where({ kind, user_id: skip }).first(), undefined)
    assert.ok(run.summary.some((s) => s.userId === all))
    await db('digest_log').where({ kind }).del()

    // A life list under ten birds can't be trusted: nothing is left out.
    await reset()
    feeds = { [region]: [obs('nsrail', 'R3')] }
    await db('seen_birds').where({ user_id: skip }).whereIn('species_code', nine.slice(0, 2)).del()
    await runPushAlerts({ send })
    assert.deepEqual(heard(skip), ['Seen Rail'], 'short life list: no filtering')
    await db('seen_birds').insert(nine.slice(0, 2).map((species_code) => ({ user_id: skip, species_code, first_seen: '2020-01-01', source: 'tap' })))

    // At a place whose lifers count against its own list: that list decides (once it has ten birds).
    await reset()
    await db('users').where({ id: skip }).update({ keep_home_alerts: false })
    const user = await db('users').where({ id: skip }).first()
    const place = await places.createPlace(user, { name: 'Far trip', state: 'ZN', location: area, range_mi: 0, lifers_scope: 'place' })
    await db('users').where({ id: skip }).update({ active_place_id: place.id })
    // Ten birds there, the kite among them; the rail is on the life list but not on the place's.
    await places.setPlaceSeen(user, place.id, [...nine, 'nskite'])
    feeds = { [area]: [obs('nsrail', 'R4'), obs('nskite', 'K4')] }
    await runPushAlerts({ send })
    assert.deepEqual(heard(skip), ['Seen Rail'], 'the place\'s own list: the rail is new there, the kite is not')
    // Under ten on the place's list: the life list decides again.
    await reset()
    await places.setPlaceSeen(user, place.id, ['nskite'])
    feeds = { [area]: [obs('nsrail', 'R5'), obs('nskite', 'K5')] }
    await runPushAlerts({ send })
    assert.deepEqual(heard(skip), ['New Kite'], 'a short place list falls back to the life list')
    // The email at the place is judged the same way.
    const visitor = places.atPlace(await db('users').where({ id: skip }).first(), await places.activePlacesFor([await db('users').where({ id: skip }).first()]).then((m) => m.get(skip)))
    assert.deepEqual((await DIGESTS.rare.select(visitor, feeds[area], { preview: true })).map((o) => o.speciesCode), ['nskite'])
  } finally {
    Object.assign(ebird, { recentObservations: keep.recent, notableObservations: keep.notable, subregions: keep.subregions, regionInfo: keep.info })
    await db('nearby_cache').where('key', 'like', 'areas:%').del()
    await db('users').whereIn('id', ids).update({ active_place_id: null })
    await db('places').whereIn('user_id', ids).del()
    await db('push_log').whereIn('user_id', ids).del()
    await db('digest_log').whereIn('user_id', ids).del()
    await db('saved_birds').whereIn('user_id', ids).del()
    await db('seen_birds').whereIn('user_id', ids).del()
    await db('push_subscriptions').whereIn('user_id', ids).del()
    await db('users').whereIn('id', ids).del()
  }
})

test('rare birds still to see: PATCH /api/user takes notable_skip_seen (true or false only) and the user carries it', async () => {
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const user = await db('users').where({ id: userId }).first()
  assert.equal(user.notable_skip_seen, false, 'off by default')
  const session = fakeRes(); createSession(session, user)
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const patch = async (body) => { const res = fakeRes(); await userApi(fakeReq({ method: 'PATCH', headers: { cookie }, body }), res); return res }
  assert.equal((await patch({ notable_skip_seen: 'yes' })).statusCode, 400)
  const on = await patch({ notable_skip_seen: true })
  assert.deepEqual([on.statusCode, on.body.notable_skip_seen], [200, true])
  assert.equal((await db('users').where({ id: userId }).first()).notable_skip_seen, true)
  const off = await patch({ notable_skip_seen: false })
  assert.equal(off.body.notable_skip_seen, false)
})

test('the notable_skip_seen migration goes down and up again', async () => {
  const name = '20261121090000_notable_skip_seen.js'
  try {
    await db.migrate.down({ name })
    assert.equal(await db.schema.hasColumn('users', 'notable_skip_seen'), false)
  } finally {
    await db.migrate.up({ name })
  }
  assert.equal(await db.schema.hasColumn('users', 'notable_skip_seen'), true)
  assert.equal((await db('users').where({ id: userId }).first()).notable_skip_seen, false)
})

// --- event day (the Big Day dry run) ---------------------------------------------------------------

test('the event-day migration: down and up again, filling an Arizona event\'s zone; the tally keeps its rows', async () => {
  const name = '20261122090000_event_day.js'
  const [{ id: uid }] = await db('users').insert({ email: 'tz-migration@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('id')
  try {
    await db.migrate.down({ name })
    assert.equal(await db.schema.hasColumn('events', 'timezone'), false)
    assert.equal(await db.schema.hasTable('event_tally_marks'), false)
    assert.equal(await db.schema.hasColumn('event_tally', 'client_id'), false)
    const [az] = await db('events').insert({ owner_id: uid, name: 'Cochise Big Day', state: 'AZ', location: 'US-AZ-003', starts_on: '2026-11-10', ends_on: '2026-11-10', kind: 'bigday', invite_token: 'tz-mig-invite-000001', view_token: 'tz-mig-view-00000001' }).returning('*')
    const [nowhere] = await db('events').insert({ owner_id: uid, name: 'Somewhere', state: 'ZV', location: 'US-ZV-009', starts_on: '2026-11-10', ends_on: '2026-11-10', invite_token: 'tz-mig-invite-000002', view_token: 'tz-mig-view-00000002' }).returning('*')
    await db('event_tally').insert({ event_id: az.id, species_code: 'eletro', added_by: uid, added_at: '2026-11-10T14:00:00Z' })

    await db.migrate.up({ name })
    const zones = Object.fromEntries((await db('events').whereIn('id', [az.id, nowhere.id]).select('id', 'timezone')).map((e) => [e.id, e.timezone]))
    assert.deepEqual([zones[az.id], zones[nowhere.id]], ['America/Phoenix', null], 'filled from the area; null where it can\'t say')
    const row = await db('event_tally').where({ event_id: az.id }).first()
    assert.ok(Number.isInteger(row.id))
    assert.equal(new Date(row.observed_at).toISOString(), '2026-11-10T14:00:00.000Z', 'an older row was seen when it was added')
    assert.deepEqual([row.client_id, row.lat, row.lng, row.stop_index, row.removed_at], [null, null, null, null, null])
    assert.equal(await db.schema.hasTable('event_tally_marks'), true)

    // Down again drops removed rows (as removal used to) and keeps the rest; up again is clean.
    await db('event_tally').insert({ event_id: az.id, species_code: 'mexchi', added_by: uid, removed_at: db.fn.now() })
    await db.migrate.down({ name })
    assert.deepEqual(await db('event_tally').where({ event_id: az.id }).pluck('species_code'), ['eletro'])
    await db.migrate.up({ name })
  } finally {
    await db.migrate.latest()
    await db('events').where({ owner_id: uid }).del()
    await db('users').where({ id: uid }).del()
  }
})

/** A Big Day in Cochise County, AZ on Nov 10, with members whose accounts are in Phoenix, New York, UTC and no zone yet. */
const cochiseBigDay = async (prefix) => {
  const events = require('../lib/events')
  // Nothing here may reach eBird: Arizona's counties, as eBird lists them.
  const ebirdApi = require('../lib/ebird')
  const original = ebirdApi.subregions
  ebirdApi.subregions = async () => [{ code: 'US-AZ-003', name: 'Cochise' }, { code: 'US-AZ-019', name: 'Pima' }, { code: 'US-TX-141', name: 'El Paso' }]
  const restore = async () => { ebirdApi.subregions = original; await db('nearby_cache').where('key', 'like', 'areas:%').del() }
  const person = async (key, timezone) => (await db('users').insert({ email: `${prefix}-${key}@example.com`, password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true, timezone }).returning('*'))[0]
  const people = { matt: await person('matt', 'America/Phoenix'), sam: await person('sam', 'America/New_York'), utc: await person('utc', 'UTC'), kim: await person('kim', null) }
  const made = await events.createEvent(people.matt, { name: 'Cochise Big Day', state: 'AZ', location: 'US-AZ-003', starts_on: '2026-11-10', kind: 'bigday' }, new Date('2026-11-03T18:00:00Z'))
  await db('event_members').where({ event_id: made.id, user_id: people.matt.id }).update({ display_name: 'Matt' })
  await db('event_members').insert([['sam', 'Sam'], ['utc', 'Uma'], ['kim', 'Kim']].map(([key, display_name]) => ({ event_id: made.id, user_id: people[key].id, display_name, role: 'member' })))
  const event = await db('events').where({ id: made.id }).first()
  return { events, people, event, made, restore, ids: Object.values(people).map((p) => p.id) }
}

test('the event\'s day is Arizona\'s for every member: active at 10 PM and 11:59 PM Phoenix time whatever their account says, then over; the banner and the view link agree', async () => {
  const places = require('../lib/places')
  const { events, people, event, made, restore, ids } = await cochiseBigDay('tz-day')
  try {
    assert.equal(made.timezone, 'America/Phoenix', 'stored on create, from its area')
    assert.equal(event.timezone, 'America/Phoenix')
    const at = { '10 PM': '2026-11-11T05:00:00Z', '11:59 PM': '2026-11-11T06:59:00Z' }
    for (const [time, iso] of Object.entries(at)) {
      const now = new Date(iso)
      for (const key of ['matt', 'sam', 'utc', 'kim']) {
        const mine = (await events.listEvents(people[key], now)).find((e) => e.id === event.id)
        assert.deepEqual([mine.timezone, mine.active, mine.past, mine.tally_open], ['America/Phoenix', true, false, true], `${key} at ${time} Phoenix`)
        // The "Big Day today" banner (/me activeEvent) is the same rule.
        assert.equal((await places.activeEventOf(people[key], now))?.id, event.id, `${key}'s banner at ${time}`)
      }
      const view = await events.viewEvent(event.view_token, 'en', now)
      assert.deepEqual([view.active, view.tally_open, view.timezone], [true, true, 'America/Phoenix'], `view link at ${time}`)
    }
    // Past midnight in Phoenix it's over for all of them alike; late entries until 3 AM.
    const after = new Date('2026-11-11T07:30:00Z')
    for (const key of ['matt', 'sam', 'utc', 'kim']) {
      const mine = (await events.listEvents(people[key], after)).find((e) => e.id === event.id)
      assert.deepEqual([mine.active, mine.past, mine.tally_open], [false, true, true], key)
      assert.equal(await places.activeEventOf(people[key], after), null)
    }
    assert.equal((await events.viewEvent(event.view_token, 'en', after)).active, false)
    // Days to go in scouting count Arizona's days too: at 8 PM on the 8th there, two to go for New York's Sam (in NY it's the 9th).
    const scouted = await events.scoutingFor(people.sam, event.id, { now: new Date('2026-11-09T03:00:00Z'), fetchFeed: async () => [] })
    assert.equal(scouted.view.days_to_go, 2)
    // A member's own quiet hours still go by their own zone.
    const { inQuietHours } = require('../lib/quietHours')
    assert.equal(inQuietHours({ ...people.sam, push_quiet_start: 22, push_quiet_end: 6 }, new Date('2026-11-11T04:00:00Z')), true, '11 PM in New York')
    assert.equal(inQuietHours({ ...people.matt, push_quiet_start: 22, push_quiet_end: 6 }, new Date('2026-11-11T04:00:00Z')), false, '9 PM in Phoenix')
    // A change of area takes a new zone.
    const moved = await events.updateEvent(people.sam, event.id, { state: 'TX', location: 'US-TX-141' }, new Date('2026-11-03T18:00:00Z'))
    assert.equal(moved.timezone, 'America/Denver')
    assert.equal((await db('events').where({ id: event.id }).first()).timezone, 'America/Denver')
  } finally {
    await restore()
    await db('events').where({ id: event.id }).del()
    await db('users').whereIn('id', ids).del()
  }
})

test('the tally: a repeated client_id is the same add; the first finder is kept, two members adding at once included; when and where it was seen, and the stop', async () => {
  // Sighting times: n minutes after a moment 12 hours ago (an add is never in the future).
  const base = Math.floor((Date.now() - 12 * 3600_000) / 1000) * 1000
  const T = (n) => new Date(base + n * 60_000).toISOString()
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const { events, people, event, restore, ids } = await cochiseBigDay('tz-tally')
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (method, query, body) => { const res = fakeRes(); await saved(fakeReq({ method, headers: { cookie }, query: { id: String(event.id), ...query }, body }), res); return res }
  }
  const uuid = () => require('crypto').randomUUID()
  try {
    await db('event_routes').insert({ event_id: event.id, stops: JSON.stringify([{ locId: 'L1', name: 'Cave Creek Canyon', lat: 31.88, lng: -109.17 }, { locId: 'L2', name: 'Portal', lat: 31.913, lng: -109.141 }]), updated_by: people.matt.id })
    const matt = as(people.matt)
    const sam = as(people.sam)

    // An add with its client_id, the sighting's time and spot: rounded to 3 decimals, at the nearest stop.
    const trogon = uuid()
    const first = await matt('POST', { kind: 'event-tally' }, { species_code: 'eletro', client_id: trogon, observed_at: T(65), lat: 31.88123, lng: -109.17456 })
    assert.equal(first.statusCode, 200)
    const entry = first.body.entry
    assert.deepEqual([entry.code, entry.client_id, entry.added_by_name, entry.added_by_you, entry.observed_at instanceof Date ? entry.observed_at.toISOString() : entry.observed_at, entry.lat, entry.lng, entry.stop_index, entry.stop_name, entry.marked_by_me],
      ['eletro', trogon, 'Matt', true, T(65), 31.881, -109.175, 0, 'Cave Creek Canyon', false])
    assert.deepEqual(first.body.tally.map((t) => t.id), [entry.id])

    // The same add again (a retry after a lost answer), even with other details: nothing changes, the row comes back, 200.
    const again = await matt('POST', { kind: 'event-tally' }, { species_code: 'eletro', client_id: trogon, observed_at: T(180), lat: 31.9, lng: -109.2 })
    assert.equal(again.statusCode, 200)
    assert.deepEqual(again.body.entry, entry)
    assert.equal(await db('event_tally').where({ event_id: event.id }).count('* as n').first().then((r) => Number(r.n)), 1)

    // Someone else adds it later: still Matt's, still 7:05.
    const later = await sam('POST', { kind: 'event-tally' }, { species_code: 'eletro', client_id: uuid(), observed_at: T(120) })
    assert.deepEqual([later.body.entry.id, later.body.entry.added_by_name, later.body.entry.added_by_you, String(later.body.entry.observed_at.toISOString?.() ?? later.body.entry.observed_at)], [entry.id, 'Matt', false, T(65)])

    // Sam syncs a sighting from before Matt's (offline in a canyon): Sam found it first, with Sam's spot (no stop near).
    const quail = uuid()
    await matt('POST', { kind: 'event-tally' }, { species_code: 'monqua', client_id: uuid(), observed_at: T(180), lat: 31.881, lng: -109.17 })
    const earlier = await sam('POST', { kind: 'event-tally' }, { species_code: 'monqua', client_id: quail, observed_at: T(30), lat: 31.95, lng: -109.25 })
    assert.deepEqual([earlier.body.entry.added_by_name, earlier.body.entry.observed_at.toISOString(), earlier.body.entry.lat, earlier.body.entry.stop_index, earlier.body.entry.stop_name], ['Sam', T(30), 31.95, null, null])

    // Two members adding the same bird at once, seen at the same minute: one row, the first one in kept as finder.
    for (let round = 0; round < 5; round++) {
      const code = `mexch${round}`
      const tapped = T(240)
      const results = await Promise.all([
        events.addTally(people.matt, event.id, { species_code: code, client_id: uuid(), observed_at: tapped }),
        events.addTally(people.sam, event.id, { species_code: code, client_id: uuid(), observed_at: tapped })
      ])
      const rows = await db('event_tally').where({ event_id: event.id, species_code: code })
      assert.equal(rows.length, 1)
      const finder = rows[0].added_by
      assert.ok([people.matt.id, people.sam.id].includes(finder))
      // The one that inserted is the one whose client_id is on the row; both answers name that finder.
      assert.equal((await db('event_tally').where({ id: rows[0].id }).first()).client_id !== null, true)
      for (const r of results) assert.equal(r.entry.added_by_name, finder === people.matt.id ? 'Matt' : 'Sam')
    }
    // ...and seen at different times, racing: the earlier sighting wins whichever lands first.
    for (let round = 0; round < 5; round++) {
      const code = `acowo${round}`
      await Promise.all([
        events.addTally(people.sam, event.id, { species_code: code, client_id: uuid(), observed_at: T(245) }),
        events.addTally(people.matt, event.id, { species_code: code, client_id: uuid(), observed_at: T(241) })
      ])
      const row = await db('event_tally').where({ event_id: event.id, species_code: code }).first()
      assert.deepEqual([row.added_by, new Date(row.observed_at).toISOString()], [people.matt.id, T(241)])
    }

    // A client_id used for a different bird is still the add already made.
    const mixed = await sam('POST', { kind: 'event-tally' }, { species_code: 'flaowl', client_id: quail })
    assert.equal(mixed.body.entry.code, 'monqua')
    assert.equal(await db('event_tally').where({ event_id: event.id, species_code: 'flaowl' }).first(), undefined)

    // Bad input, in the member's language; never an email in the payload.
    assert.equal((await matt('POST', { kind: 'event-tally' }, { species_code: 'eletro', client_id: 'nope' })).statusCode, 400)
    const french = await matt('POST', { kind: 'event-tally', locale: 'fr-CA' }, { species_code: 'eletro', observed_at: 'soon' })
    assert.deepEqual([french.statusCode, french.body.error], [400, 'observed_at doit être une date et une heure'])
    assert.equal((await matt('POST', { kind: 'event-tally' }, { species_code: 'eletro', lat: 31.9 })).statusCode, 400)
    assert.ok(!JSON.stringify(later.body).includes('@example.com'))
    // A bare code still works (older apps).
    assert.equal((await events.addTally(people.kim, event.id, 'brrspa')).tally.find((t) => t.code === 'brrspa').added_by_name, 'Kim')
  } finally {
    await restore()
    await db('events').where({ id: event.id }).del()
    await db('users').whereIn('id', ids).del()
  }
})

test('removing a bird keeps it for undo; undo or adding it again brings back who found it and when; the log shows it all in the order seen', async () => {
  // Sighting times: n minutes after a moment 12 hours ago (an add is never in the future).
  const base = Math.floor((Date.now() - 12 * 3600_000) / 1000) * 1000
  const T = (n) => new Date(base + n * 60_000).toISOString()
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const { events, people, event, restore, ids } = await cochiseBigDay('tz-undo')
  const outsider = (await db('users').insert({ email: 'tz-undo-outsider@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('*'))[0]
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (method, query, body) => { const res = fakeRes(); await saved(fakeReq({ method, headers: { cookie }, query: { id: String(event.id), ...query }, body }), res); return res }
  }
  await db('birds').insert([['eletro', 'Elegant Trogon'], ['monqua', 'Montezuma Quail'], ['mexchi', 'Mexican Chickadee']].map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
  try {
    await db('event_routes').insert({ event_id: event.id, stops: JSON.stringify([{ locId: 'L1', name: 'Cave Creek Canyon', lat: 31.88, lng: -109.17 }]), updated_by: people.matt.id })
    const sam = as(people.sam)
    await events.addTally(people.matt, event.id, { species_code: 'eletro', observed_at: T(65), lat: 31.88, lng: -109.17 })
    await events.addTally(people.sam, event.id, { species_code: 'mexchi', observed_at: T(150) })
    // Kim's chickadee-less morning quail synced last but seen first.
    await events.addTally(people.kim, event.id, { species_code: 'monqua', observed_at: T(10) })

    // Sam removes Matt's trogon: off the tally, but kept.
    const removed = await sam('DELETE', { kind: 'event-tally', code: 'eletro' })
    assert.deepEqual(removed.body.tally.map((t) => t.code).sort(), ['mexchi', 'monqua'])
    const row = await db('event_tally').where({ event_id: event.id, species_code: 'eletro' }).first()
    assert.equal(row.removed_by, people.sam.id)
    assert.ok(row.removed_at)
    assert.equal((await events.viewEvent(event.view_token)).tally.some((t) => t.code === 'eletro'), false, 'off the view link too')
    assert.equal((await events.listEvents(people.matt)).find((e) => e.id === event.id).recap.species, 2)

    // Undo, ten minutes on (and any time after): back as it was.
    await db('event_tally').where({ id: row.id }).update({ removed_at: new Date(Date.now() - 11 * 60_000) })
    const undone = await sam('POST', { kind: 'event-tally-undo' }, { species_code: 'eletro' })
    assert.equal(undone.statusCode, 200)
    assert.deepEqual([undone.body.entry.id, undone.body.entry.added_by_name, undone.body.entry.observed_at.toISOString(), undone.body.entry.stop_name], [row.id, 'Matt', T(65), 'Cave Creek Canyon'])
    assert.equal((await sam('POST', { kind: 'event-tally-undo' }, { species_code: 'eletro' })).statusCode, 200, 'undoing twice is harmless')
    const never = await sam('POST', { kind: 'event-tally-undo', locale: 'es-MX' }, { species_code: 'flaowl' })
    assert.deepEqual([never.statusCode, never.body.error], [404, 'Esa ave no está en el conteo'])

    // Removed again, then re-added by Sam an hour later: Matt's find and time come back, not Sam's.
    await events.removeTally(people.sam, event.id, 'eletro')
    const readded = await events.addTally(people.sam, event.id, { species_code: 'eletro', observed_at: T(180) })
    assert.deepEqual([readded.entry.id, readded.entry.added_by_name, readded.entry.observed_at.toISOString()], [row.id, 'Matt', T(65)])

    // The log: everything put on the tally, removed too, in the order seen, by the names chosen.
    await events.removeTally(people.matt, event.id, 'mexchi')
    const log = await sam('GET', { kind: 'event-log' })
    assert.equal(log.statusCode, 200)
    assert.deepEqual(log.body.map((l) => [l.speciesCode, l.comName, l.by_name, l.observed_at.toISOString(), l.stop_index, l.stop_name, l.removed]), [
      ['monqua', 'Montezuma Quail', 'Kim', T(10), null, null, false],
      ['eletro', 'Elegant Trogon', 'Matt', T(65), 0, 'Cave Creek Canyon', false],
      ['mexchi', 'Mexican Chickadee', 'Sam', T(150), null, null, true]
    ])
    assert.ok(log.body.every((l) => Number.isInteger(l.id)))
    assert.ok(!JSON.stringify(log.body).includes('@example.com'), 'names, never emails')
    assert.equal((await as(outsider)('GET', { kind: 'event-log' })).statusCode, 404, 'members only')
    assert.equal((await as(outsider)('POST', { kind: 'event-tally-undo' }, { species_code: 'mexchi' })).statusCode, 404)
  } finally {
    await restore()
    await db('events').where({ id: event.id }).del()
    await db('users').whereIn('id', [...ids, outsider.id]).del()
  }
})

test('"On my eBird checklist": each member ticks birds for themselves; members only, birds on this event\'s tally only', async () => {
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const { events, people, event, restore, ids } = await cochiseBigDay('tz-marks')
  const outsider = (await db('users').insert({ email: 'tz-marks-outsider@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('*'))[0]
  const as = (user, eventId = event.id) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (method, query, body) => { const res = fakeRes(); await saved(fakeReq({ method, headers: { cookie }, query: { id: String(eventId), ...query }, body }), res); return res }
  }
  const other = await events.createEvent(outsider, { name: 'Elsewhere', state: 'AZ', location: 'US-AZ-019', starts_on: '2026-11-10', kind: 'bigday' }, new Date('2026-11-03T18:00:00Z'))
  try {
    const trogon = (await events.addTally(people.matt, event.id, { species_code: 'eletro' })).entry
    const quail = (await events.addTally(people.sam, event.id, { species_code: 'monqua' })).entry
    const elsewhere = (await events.addTally(outsider, other.id, { species_code: 'eletro' })).entry
    const sam = as(people.sam)

    const marked = await sam('POST', { kind: 'event-tally-mark' }, { tally_id: trogon.id })
    assert.equal(marked.statusCode, 200)
    const mark = (body, id) => body.tally.find((t) => t.id === id).marked_by_me
    assert.deepEqual([mark(marked.body, trogon.id), mark(marked.body, quail.id)], [true, false])
    assert.equal((await sam('POST', { kind: 'event-tally-mark' }, { tally_id: trogon.id })).statusCode, 200, 'twice is once')
    assert.equal(await db('event_tally_marks').where({ tally_id: trogon.id }).count('* as n').first().then((r) => Number(r.n)), 1)
    // Sam's ticks are Sam's: Matt sees none.
    const forMatt = (await events.listEvents(people.matt)).find((e) => e.id === event.id)
    assert.deepEqual(forMatt.tally.map((t) => t.marked_by_me), [false, false])
    await events.markTally(people.matt, event.id, quail.id)
    const forSam = (await events.listEvents(people.sam)).find((e) => e.id === event.id)
    assert.deepEqual([mark(forSam, trogon.id), mark(forSam, quail.id)], [true, false])

    // Unticked.
    const unmarked = await sam('DELETE', { kind: 'event-tally-mark', tally_id: String(trogon.id) })
    assert.deepEqual([unmarked.statusCode, mark(unmarked.body, trogon.id)], [200, false])

    // Not a member: no such event. Another event's bird, or a removed one: not on this tally.
    assert.equal((await as(outsider)('POST', { kind: 'event-tally-mark' }, { tally_id: trogon.id })).statusCode, 404)
    assert.equal((await as(outsider)('DELETE', { kind: 'event-tally-mark', tally_id: String(trogon.id) })).statusCode, 404)
    assert.equal((await sam('POST', { kind: 'event-tally-mark' }, { tally_id: elsewhere.id })).statusCode, 404)
    assert.equal((await sam('POST', { kind: 'event-tally-mark' }, { tally_id: 'x' })).statusCode, 404)
    await events.removeTally(people.matt, event.id, 'monqua')
    assert.equal((await sam('POST', { kind: 'event-tally-mark' }, { tally_id: quail.id })).statusCode, 404)
    // A mark stays with the bird through undo.
    const back = await events.undoRemoveTally(people.matt, event.id, 'monqua')
    assert.equal(back.entry.marked_by_me, true)
  } finally {
    await restore()
    await db('events').whereIn('id', [event.id, other.id]).del()
    await db('users').whereIn('id', [...ids, outsider.id]).del()
  }
})

test('the group\'s route: a meeting time on the start, and where the group is, shared by everyone (latest tap wins, never a version bump)', async () => {
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const routing = require('../lib/routing')
  const realDrive = routing.drive
  const recentObservations = ebird.recentObservations
  ebird.recentObservations = async () => []
  routing.drive = async (points) => ({ legs: points.slice(1).map(() => ({ minutes: 10, miles: 5 })), minutes: 10, miles: 5, geometry: [] })
  const person = async (email) => (await db('users').insert({ email, password_hash: 'x', location: 'US-AZ-003', state: 'AZ', email_confirmed: true }).returning('*'))[0]
  const matt = await person('position-matt@example.com')
  const sam = await person('position-sam@example.com')
  const stranger = await person('position-stranger@example.com')
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (method, query, body) => { const res = fakeRes(); await saved(fakeReq({ method, headers: { cookie }, query, body }), res); return res }
  }
  try {
    const event = await eventAt(matt.id, { id: null, name: 'Big Day', state: 'AZ', location: 'US-AZ-003' }, { starts_on: dayFrom(0), ends_on: dayFrom(0), kind: 'bigday', timezone: 'America/Phoenix' })
    await db('event_members').where({ event_id: event.id, user_id: matt.id }).update({ display_name: 'Matt' })
    await db('event_members').insert({ event_id: event.id, user_id: sam.id, display_name: 'Sam', role: 'member' })
    const id = String(event.id)
    const plan = { kind: 'event-route-plan', id }
    const here = { kind: 'event-route-position', id }
    const mattCall = as(matt)
    const samCall = as(sam)
    const stops = [1, 2, 3].map((n) => ({ locId: `L${n}`, name: `Stop ${n}`, lat: 31.4 + n / 100, lng: -110.3 }))
    const start = { name: 'Sierra Vista Motel', lat: 31.55, lng: -110.3 }

    // No route saved: nowhere to be.
    assert.equal((await mattCall('POST', here, { stop: 0 })).statusCode, 409)

    // The meeting time: 'HH:MM' 24-hour, kept in the start; null or absent is none; anything else a 400.
    for (const time of ['5:15', '24:00', '05:60', '0515', 515, '05:15 AM', true]) {
      assert.equal((await mattCall('PUT', plan, { start: { ...start, time }, stops, version: 0 })).statusCode, 400, String(time))
    }
    const timed = await mattCall('PUT', plan, { start: { ...start, time: '05:15' }, stops, version: 0 })
    assert.deepEqual([timed.statusCode, timed.body.start, timed.body.position], [200, { ...start, lat: 31.55, lng: -110.3, time: '05:15' }, null])
    assert.equal((await samCall('GET', plan)).body.start.time, '05:15', 'a GET gives it back')
    const untimed = await mattCall('PUT', plan, { start: { ...start, time: null }, stops, version: 1 })
    assert.deepEqual([untimed.body.start, untimed.body.version], [{ ...start, lat: 31.55, lng: -110.3 }, 2])
    const v3 = await mattCall('PUT', plan, { start: { ...start, time: '05:15' }, stops, version: 2 })
    assert.equal(v3.body.version, 3)

    // Members only: 404 to anyone else, or no such event.
    assert.equal((await as(stranger)('POST', here, { stop: 0 })).statusCode, 404)
    assert.equal((await mattCall('POST', { ...here, id: '999999' }, { stop: 0 })).statusCode, 404)
    // Checked: an index on the route (-1 the meeting point) or null; a time.
    for (const body of [{ stop: 3 }, { stop: -2 }, { stop: 1.5 }, { stop: '1' }, { stop: 0, at: 'yesterday' }, { stop: 0, at: 12 }]) {
      assert.equal((await mattCall('POST', here, body)).statusCode, 400, JSON.stringify(body))
    }

    // Sam taps "We're here" at stop 2 (index 1): everyone sees it, by name, and the version stays.
    const t = (min) => new Date(Date.now() - min * 60_000).toISOString()
    const tenAgo = t(10)
    const tap = await samCall('POST', here, { stop: 1, at: tenAgo })
    assert.deepEqual([tap.statusCode, tap.body], [200, { position: { stop: 1, at: tenAgo, by_name: 'Sam', by_you: true }, applied: true }])
    const seen = (await mattCall('GET', plan)).body
    assert.deepEqual([seen.position.stop, seen.position.by_name, seen.position.by_you, seen.version], [1, 'Sam', false, 3])
    assert.doesNotMatch(JSON.stringify(seen.position), /@/, 'never an email')

    // Matt's phone was offline: his earlier tap (stop 1, 20 minutes ago) syncs now and changes nothing.
    const late = await mattCall('POST', here, { stop: 0, at: t(20) })
    assert.deepEqual([late.statusCode, late.body.applied, late.body.position.stop, late.body.position.by_name], [200, false, 1, 'Sam'])
    // A newer one wins; at the meeting point is -1.
    const newer = await mattCall('POST', here, { stop: -1, at: t(5) })
    assert.deepEqual([newer.body.applied, newer.body.position.stop, newer.body.position.by_you], [true, -1, true])
    const next = await mattCall('POST', here, { stop: 2, at: t(1) })
    assert.deepEqual([next.body.applied, next.body.position.stop], [true, 2])

    // A tap from the future is taken as now: a later real tap still wins over it.
    const before = Date.now()
    const future = await samCall('POST', here, { stop: 1, at: new Date(Date.now() + 3_600_000).toISOString() })
    const at = Date.parse(future.body.position.at)
    assert.ok(future.body.applied && at >= before - 1000 && at <= Date.now(), 'clamped to now')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await mattCall('POST', here, { stop: 0 })).body.position.stop, 0, 'no at: now')

    // None of it touched the version: an edit from version 3 still saves.
    assert.equal((await db('event_routes').where({ event_id: event.id }).first()).version, 3)
    // The stops change so the index is past the end: no position; one still on it stays.
    await mattCall('POST', here, { stop: 2, at: new Date().toISOString() })
    const shorter = await samCall('PUT', plan, { start: { ...start, time: '05:15' }, stops: stops.slice(0, 2), version: 3 })
    assert.deepEqual([shorter.statusCode, shorter.body.version, shorter.body.position], [200, 4, null])
    assert.equal((await mattCall('GET', plan)).body.position, null)
    assert.equal((await mattCall('POST', here, { stop: 2 })).statusCode, 400, 'not on the route now')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await mattCall('POST', here, { stop: 1 })).body.position.stop, 1)
    // No start: the meeting point is gone too.
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await mattCall('POST', here, { stop: -1 })).body.position.stop, -1)
    const noStart = await mattCall('PUT', plan, { start: null, stops: stops.slice(0, 2), version: 4 })
    assert.deepEqual([noStart.statusCode, noStart.body.version, noStart.body.position], [200, 5, null])
    assert.equal((await mattCall('POST', here, { stop: -1 })).statusCode, 400, 'no meeting point without a start')

    // Cleared with null, by the same rule (an older clear changes nothing).
    assert.equal((await mattCall('PUT', plan, { start, stops, version: 5 })).body.version, 6)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal((await mattCall('POST', here, { stop: 0 })).body.position.stop, 0)
    assert.deepEqual((await samCall('POST', here, { stop: null, at: t(30) })).body, { position: { stop: 0, at: (await mattCall('GET', plan)).body.position.at, by_name: 'Matt', by_you: false }, applied: false })
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual((await samCall('POST', here, { stop: null })).body, { position: null, applied: true })
    assert.equal((await mattCall('GET', plan)).body.position, null)
  } finally {
    await db('events').where({ owner_id: matt.id }).del()
    await db('users').whereIn('id', [matt.id, sam.id, stranger.id]).del()
    ebird.recentObservations = recentObservations
    routing.drive = realDrive
  }
})

test('the route position migration: adds the columns, and takes them away again', async () => {
  const migration = require('../db/migrations/20261123090000_event_route_position')
  const columns = async () => Object.keys(await db('event_routes').columnInfo()).filter((c) => c.startsWith('current_stop')).sort()
  assert.deepEqual(await columns(), ['current_stop', 'current_stop_at', 'current_stop_by'])
  await migration.down(db)
  try {
    assert.deepEqual(await columns(), [])
  } finally {
    await migration.up(db)
  }
  assert.deepEqual(await columns(), ['current_stop', 'current_stop_at', 'current_stop_by'])
  // Whoever tapped it can go: the position stays, by no one.
  const [owner] = await db('users').insert({ email: 'position-owner@example.com', password_hash: 'x', location: 'US-AZ-003', state: 'AZ' }).returning('*')
  const [tapper] = await db('users').insert({ email: 'position-tapper@example.com', password_hash: 'x', location: 'US-AZ-003', state: 'AZ' }).returning('*')
  try {
    const event = await eventAt(owner.id, { id: null, name: 'Big Day', state: 'AZ', location: 'US-AZ-003' }, { starts_on: dayFrom(1), ends_on: dayFrom(1) })
    await db('event_routes').insert({ event_id: event.id, stops: '[]', current_stop: 0, current_stop_at: new Date(), current_stop_by: tapper.id })
    await db('users').where({ id: tapper.id }).del()
    const row = await db('event_routes').where({ event_id: event.id }).first()
    assert.deepEqual([row.current_stop, row.current_stop_by], [0, null])
  } finally {
    await db('events').where({ owner_id: owner.id }).del()
    await db('users').whereIn('id', [owner.id, tapper.id]).del()
  }
})

test('invite links: the link needs a session, a signup from it credits the inviter, and HQ counts invites without emails', async () => {
  const auth = require('../api/auth/[action]')
  const userApi = require('../api/user')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const { adminStats, adminSection } = require('../lib/adminStats')
  const before = (await adminStats()).totals.invites

  const anon = fakeRes()
  await userApi(fakeReq({ method: 'GET', query: { kind: 'invite-link' } }), anon)
  assert.equal(anon.statusCode, 401)

  const [inviter] = await db('users').insert({ email: 'inviter@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA' }).returning('*')
  const session = fakeRes(); createSession(session, inviter)
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const link = fakeRes()
  await userApi(fakeReq({ method: 'GET', headers: { cookie }, query: { kind: 'invite-link' } }), link)
  assert.equal(link.statusCode, 200)
  assert.equal(link.body.url, `https://bird-alert.vercel.app/?ref=invite-${link.body.code}`)
  assert.doesNotMatch(link.body.url, /inviter|example\.com/, 'no email in the link')
  const odd = fakeRes()
  await userApi(fakeReq({ method: 'GET', headers: { cookie }, query: { kind: 'nope' } }), odd)
  assert.equal(odd.statusCode, 400)

  const signUp = async (email, invite) => {
    const res = fakeRes()
    await auth(fakeReq({ method: 'POST', query: { action: 'signup' }, body: { email, password: 'longenough1', source: { landing: 'home', invite } } }), res)
    assert.equal(res.statusCode, 201)
    assert.equal(JSON.stringify(res.body).includes('inviter'), false, 'the new person is not told who invited them')
    return (await db('users').where({ email }).first('id', 'signup_source'))
  }
  const friend = await signUp('invited-1@example.com', `invite-${link.body.code}`)
  assert.deepEqual(friend.signup_source, { landing: 'home', invite: true, inviter: inviter.id })
  await signUp('invited-2@example.com', `invite-${link.body.code}`)
  const forged = await signUp('invited-forged@example.com', `invite-${inviter.id.toString(36)}-aaaaaa`)
  assert.deepEqual(forged.signup_source, { landing: 'home', invite: true })
  // A real code for an account that's since gone credits no one.
  const [{ id: goneId }] = await db('users').insert({ email: 'gone-inviter@example.com', password_hash: 'x' }).returning('id')
  const goneCode = require('../lib/invites').inviteCode(goneId)
  await db('users').where({ id: goneId }).del()
  const orphan = await signUp('invited-orphan@example.com', `invite-${goneCode}`)
  assert.deepEqual(orphan.signup_source, { landing: 'home', invite: true })

  const s = await adminStats()
  assert.deepEqual(s.totals.invites, { signups: before.signups + 4, inviters: before.inviters + 1 })
  assert.equal(s.signups.find((u) => u.id === friend.id).source, 'invite')
  const { html, text } = adminSection(s)
  assert.match(html, /<strong>Invites:<\/strong> \d+ signups from invite links, by \d+ (person|people) inviting/)
  assert.match(html, new RegExp(`#${friend.id} no county · from invite`))
  assert.match(text, /Invites: \d+ signups from invite links, \d+ inviters/)
  assert.doesNotMatch(html + text, /@example\.com/, 'no emails in the HQ email')
  await db('users').whereIn('email', ['inviter@example.com', 'invited-1@example.com', 'invited-2@example.com', 'invited-forged@example.com', 'invited-orphan@example.com']).del()
})

/**
 * A finished Big Day for the recap tests: the Cochise group (cochiseBigDay) on `day`, a saved route
 * of two public hotspots around a personal spot, four birds on the tally (and one taken off), Matt's
 * life list from before, and the scouting email's bird of the day before. OSRM, eBird's feed and the
 * area's centre are stood in for. `restore` puts them back and clears up.
 */
const recapDay = async (prefix, day = '2026-11-10') => {
  const events = require('../lib/events')
  const routing = require('../lib/routing')
  const range = require('../lib/range')
  const abaCodes = require('../lib/abaCodes')
  const base = await cochiseBigDay(prefix)
  const { event, people } = base
  await db('events').where({ id: event.id }).update({ starts_on: day, ends_on: day })
  const at = (hhmm) => wallClock(day, hhmm)
  await db('birds').insert([['grhowl', 'Great Horned Owl'], ['arwoo', 'Arizona Woodpecker'], ['rubrob', 'Rufous-backed Robin', 'Turdus rufopalliatus'], ['eletro', 'Elegant Trogon'],
    ['lewwoo', 'Lewis\'s Woodpecker'], ['monqua', 'Montezuma Quail'], ['cacwre', 'Cactus Wren']].map(([speciesCode, comName, sciName]) => ({ speciesCode, comName, sciName: sciName || comName }))).onConflict('speciesCode').ignore()
  await db('aba_codes').insert({ sci_name: 'Turdus rufopalliatus', com_name: 'Rufous-backed Robin', code: 3, version: 'test' }).onConflict('sci_name').ignore()
  abaCodes.forgetCodes()
  await db('hotspot_ref').insert([['L1', 'Cave Creek Canyon', 31.88, -109.17], ['L3', 'Portal', 31.913, -109.141]].map(([loc_id, name, lat, lng]) => ({ loc_id, state: 'US-AZ', name, lat, lng }))).onConflict('loc_id').ignore()
  await db('event_routes').insert({ event_id: event.id, updated_by: people.matt.id, stops: JSON.stringify([
    { locId: 'L1', name: 'Cave Creek Canyon', lat: 31.88, lng: -109.17 }, { locId: null, name: 'Aunt May’s yard', lat: 31.5, lng: -110.2, stay_min: 30 }, { locId: 'L3', name: 'Portal', lat: 31.913, lng: -109.141 }]) })
  await db('event_targets').insert(['eletro', 'monqua'].map((species_code) => ({ event_id: event.id, species_code, added_by: people.matt.id })))
  const tally = await db('event_tally').insert([
    { species_code: 'grhowl', observed_at: at('05:41'), stop_index: null, added_by: people.matt.id },
    { species_code: 'arwoo', observed_at: at('07:12'), stop_index: 0, added_by: people.sam.id },
    { species_code: 'rubrob', observed_at: at('08:47'), stop_index: 1, added_by: people.matt.id },
    { species_code: 'eletro', observed_at: at('13:52'), stop_index: 2, added_by: people.matt.id },
    { species_code: 'lewwoo', observed_at: at('14:00'), stop_index: 2, added_by: people.matt.id, removed_at: at('14:05'), removed_by: people.matt.id }
  ].map((r) => ({ event_id: event.id, ...r }))).returning(['id', 'species_code'])
  await db('event_tally_marks').insert({ event_id: event.id, user_id: people.sam.id, tally_id: tally.find((t) => t.species_code === 'grhowl').id })
  // Matt's list: 12 birds before, and the woodpecker tapped "Seen it" on the day (a lifer all the same). Sam's is too short to judge by.
  await db('seen_birds').insert([...['grhowl', ...Array.from({ length: 11 }, (_, i) => `xbird${i}`)].map((code) => ({ species_code: code, first_seen: '2026-01-01' })),
    { species_code: 'arwoo', first_seen: day }].map((r) => ({ user_id: people.matt.id, ...r })))
  await db('seen_birds').insert({ user_id: people.sam.id, species_code: 'grhowl', first_seen: '2026-01-01' })
  // What the scouting emails named: the trogon (the bird of the day) at Portal, the robin at a
  // personal spot, the woodpecker the day before; the owl only after the day, so it doesn't count.
  const before = (n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
  const spot = (code, loc, locName) => ({ code, loc, locName })
  await db('event_scout_birds').insert([
    { day: before(-2), species_code: 'monqua', species: JSON.stringify([spot('monqua', 'L9', 'Miller Canyon'), spot('arwoo', 'L1', 'Cave Creek Canyon')]) },
    { day: before(-1), species_code: 'eletro', species: JSON.stringify([spot('eletro', 'L3', 'Portal'), spot('rubrob', 'L77', 'Aunt May’s feeder')]) },
    { day: before(1), species_code: 'grhowl', species: JSON.stringify([spot('grhowl', 'L1', 'Cave Creek Canyon')]) }
  ].map((r) => ({ event_id: event.id, ...r })))
  const stubs = { scoutFeed: events.scoutFeed, drive: routing.drive, regionCenter: range.regionCenter }
  events.scoutFeed = async () => ({ records: [
    { speciesCode: 'monqua', comName: 'Montezuma Quail', obsDt: `${day} 07:00` },
    { speciesCode: 'cacwre', comName: 'Cactus Wren', obsDt: `${day} 09:00` },
    { speciesCode: 'eletro', comName: 'Elegant Trogon', obsDt: `${day} 10:00` },
    { speciesCode: 'duck1', comName: 'duck sp.', obsDt: `${day} 10:00` }
  ] })
  routing.drive = async (points) => ({ legs: points.slice(1).map(() => ({ minutes: 30, miles: 20.4 })), geometry: points.map((p) => [p.lat, p.lng]) })
  range.regionCenter = async () => ({ lat: 31.88123, lng: -109.75123 })
  const restore = async () => {
    Object.assign(events, { scoutFeed: stubs.scoutFeed })
    routing.drive = stubs.drive
    range.regionCenter = stubs.regionCenter
    await db('aba_codes').where({ version: 'test' }).del()
    abaCodes.forgetCodes()
    await db('hotspot_ref').whereIn('loc_id', ['L1', 'L3']).del()
    await db('events').where({ id: event.id }).del()
    await db('seen_birds').whereIn('user_id', base.ids).del()
    await db('users').whereIn('id', base.ids).del()
    await base.restore()
  }
  return { ...base, tally, restore }
}

// A wall-clock time on `day` in Phoenix (no daylight saving: UTC-7).
const wallClock = (day, hhmm) => new Date(`${day}T${hhmm}:00-07:00`)

test('the recap: members see it all once the tally closes, anyone with the share code sees it without names or personal spots', async () => {
  const saved = require('../api/saved')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const { recapCode } = require('../lib/eventRecap')
  // Two days ago (UTC days): the tally closed yesterday at 3 AM in Phoenix, so fixes are open until tomorrow.
  const { people, event, restore } = await recapDay('recap-view', dayFrom(-2))
  const [outsider] = await db('users').insert({ email: 'recap-view-outsider@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true }).returning('*')
  const as = (user) => {
    const session = fakeRes(); createSession(session, user)
    const cookie = String(session.headers['set-cookie']).split(';')[0]
    return async (query) => { const res = fakeRes(); await saved(fakeReq({ headers: { cookie }, query: { kind: 'event-recap', ...query } }), res); return res }
  }
  const anyone = async (query) => { const res = fakeRes(); await saved(fakeReq({ query: { kind: 'event-recap', ...query } }), res); return res }
  try {
    const res = await as(people.matt)({ event: String(event.id) })
    assert.equal(res.statusCode, 200)
    const r = res.body
    assert.deepEqual([r.audience, r.status, r.shareCode], ['members', 'open', recapCode(event.id)])
    assert.equal(r.fixesUntil, new Date(Date.parse(`${dayFrom(-1)}T10:00:00Z`) + 48 * 3_600_000).toISOString())
    assert.deepEqual(r.event, { id: event.id, name: 'Cochise Big Day', kind: 'big_day', area: 'Cochise County, AZ', startsOn: dayFrom(-2), endsOn: dayFrom(-2), timezone: 'America/Phoenix', lat: 31.88, lng: -109.75 })
    assert.deepEqual(r.members.map((m) => [m.name, m.organizer]), [['Matt', true], ['Sam', false], ['Uma', false], ['Kim', false]])
    assert.equal(r.members[0].id, people.matt.id)
    assert.deepEqual({ ...r.totals, firstBird: r.totals.firstBird.speciesCode, lastBird: r.totals.lastBird.speciesCode }, {
      species: 4, stops: 3, miles: 41, fieldMinutes: 491, firstBird: 'grhowl', lastBird: 'eletro', bestStop: { index: 0, name: 'Cave Creek Canyon', species: 1 }, bestHour: { start: '05:00', added: 1 }
    })
    assert.deepEqual(r.timeline.map((t) => [t.n, t.comName, t.place, t.lifer, t.liferFor]), [
      [1, 'Great Horned Owl', null, false, []], [2, 'Arizona Woodpecker', 'Cave Creek Canyon', true, ['Matt']],
      [3, 'Rufous-backed Robin', 'Aunt May’s yard', true, ['Matt']], [4, 'Elegant Trogon', 'Portal', true, ['Matt']]
    ], 'the bird taken off isn\'t there; a bird tapped "Seen it" on the day is still a lifer')
    assert.equal(r.timeline[1].at, wallClock(dayFrom(-2), '07:12').toISOString())
    assert.deepEqual(r.lifers.map((l) => [l.speciesCode, l.who, l.number, l.place]), [['arwoo', 'Matt', 13, 'Cave Creek Canyon'], ['rubrob', 'Matt', 14, 'Aunt May’s yard'], ['eletro', 'Matt', 15, 'Portal']])
    assert.deepEqual(r.highlights.rarest, { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', aba: 3, at: wallClock(dayFrom(-2), '08:47').toISOString(), place: 'Aunt May’s yard' })
    // The scouting card: of the birds the emails named, the trogon, a lifer and a bird of the day (the robin is the rarest, with its own card).
    assert.deepEqual(r.highlights.scoutingCalled, {
      reports: 2,
      star: {
        speciesCode: 'eletro', comName: 'Elegant Trogon', at: wallClock(dayFrom(-2), '13:52').toISOString(), place: 'Portal', why: 'lifer', aba: null, liferFor: ['Matt'],
        firstScouted: dayFrom(-3), timesScouted: 1, scoutedAt: 'Portal', birdOfTheDay: true
      },
      others: [
        { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', at: wallClock(dayFrom(-2), '08:47').toISOString(), place: 'Aunt May’s yard', firstScouted: dayFrom(-3), timesScouted: 1, lifer: true, aba: 3 },
        { speciesCode: 'arwoo', comName: 'Arizona Woodpecker', at: wallClock(dayFrom(-2), '07:12').toISOString(), place: 'Cave Creek Canyon', firstScouted: dayFrom(-4), timesScouted: 1, lifer: true, aba: null }
      ],
      othersTotal: 2
    })
    assert.deepEqual(r.targets, { total: 2, found: 1, missed: ['Montezuma Quail'] })
    assert.deepEqual(r.stops.map((s) => [s.index, s.name, s.species, s.added, s.stayMin]), [[0, 'Cave Creek Canyon', 1, 1, null], [1, 'Aunt May’s yard', 1, 1, 30], [2, 'Portal', 1, 1, null]])
    assert.deepEqual(r.route, { miles: 41, line: [[31.88, -109.17], [31.5, -110.2], [31.913, -109.141]] })
    assert.deepEqual(r.byMember, [{ name: 'Matt', count: 3, only: ['Rufous-backed Robin', 'Elegant Trogon'] }, { name: 'Sam', count: 2, only: ['Arizona Woodpecker'] }, { name: 'Uma', count: 0, only: [] }, { name: 'Kim', count: 0, only: [] }])
    assert.equal(r.together, 0)
    assert.deepEqual(r.candidates.map((c) => c.speciesCode), ['monqua', 'cacwre'], 'the target missed, then the area\'s birds, never what\'s on the tally or a spuh')
    assert.doesNotMatch(JSON.stringify(r), /"_/, 'nothing internal leaves')

    // In the reader's language: the timeline, and the plain lists of names too.
    require('../lib/birdNames').forget()
    await db('taxonomy_names').insert([['eletro', 'Trogon élégant'], ['monqua', 'Colin de Montezuma']].map(([species_code, com_name]) => ({ locale: 'fr_CA', species_code, com_name })))
    const french = (await as(people.matt)({ event: String(event.id), locale: 'fr-CA' })).body
    assert.equal(french.timeline[3].comName, 'Trogon élégant')
    assert.deepEqual([french.targets.missed, french.byMember[0].only], [['Colin de Montezuma'], ['Rufous-backed Robin', 'Trogon élégant']])
    assert.equal(french.timeline[3].comNameEn, undefined, 'the shape as agreed')
    await db('taxonomy_names').where({ locale: 'fr_CA' }).del()
    require('../lib/birdNames').forget()

    // The public view, by the share code, signed in or not.
    const pub = await anyone({ share: r.shareCode })
    assert.equal(pub.statusCode, 200)
    const p = pub.body
    assert.deepEqual(Object.keys(p), ['audience', 'status', 'fixesUntil', 'event', 'totals', 'timeline', 'lifers', 'highlights', 'targets', 'stops', 'route'])
    assert.equal(p.audience, 'public')
    assert.deepEqual([p.event.lat, p.event.lng], [31.88, -109.75])
    assert.deepEqual(p.stops.map((s) => s.name), ['Cave Creek Canyon', 'Portal'])
    assert.deepEqual(p.route, { miles: 41, line: [[31.88, -109.17], [31.913, -109.141]] })
    assert.deepEqual(p.timeline.map((t) => [t.place, t.stopIndex, t.liferFor]), [[null, null, null], ['Cave Creek Canyon', 0, null], [null, null, null], ['Portal', 2, null]])
    assert.deepEqual(p.lifers.map((l) => [l.who, l.place]), [[null, 'Cave Creek Canyon'], [null, null], [null, 'Portal']])
    assert.equal(p.highlights.rarest.place, null)
    assert.deepEqual([p.highlights.scoutingCalled.star.liferFor, p.highlights.scoutingCalled.star.scoutedAt, p.highlights.scoutingCalled.star.place], [null, 'Portal', 'Portal'], 'a public hotspot stays')
    assert.deepEqual(p.highlights.scoutingCalled.others.map((o) => [o.speciesCode, o.place]), [['rubrob', null], ['arwoo', 'Cave Creek Canyon']])
    for (const word of ['Matt', 'Sam', 'Uma', 'Kim', 'Aunt May', 'example.com']) assert.equal(JSON.stringify(p).includes(word), false, word)

    // Who can see what.
    assert.equal((await anyone({ share: `${event.id.toString(36)}-aaaaaa` })).statusCode, 404, 'a forged code')
    assert.equal((await anyone({ share: 'nonsense' })).statusCode, 404)
    assert.equal((await anyone({ event: String(event.id) })).statusCode, 401, 'the members\' view needs signing in')
    assert.equal((await as(outsider)({ event: String(event.id) })).statusCode, 404, 'members only')
    assert.equal((await as(people.sam)({ id: String(event.id) })).statusCode, 200, 'id= works too')
    // Before the tally closes there's no recap.
    await db('events').where({ id: event.id }).update({ starts_on: dayFrom(0), ends_on: dayFrom(0) })
    const live = await as(people.matt)({ event: String(event.id) })
    assert.deepEqual([live.statusCode, live.body], [409, { error: 'not_ended' }])
    assert.equal((await anyone({ share: r.shareCode })).statusCode, 409)
  } finally {
    await db('users').where({ id: outsider.id }).del()
    await restore()
  }
})

test('the recap seals after the fix window: frozen against later life list changes; the tally takes fixes until then and refuses them after; the morning run seals', async () => {
  const recap = require('../lib/eventRecap')
  const { events, people, event, tally, restore } = await recapDay('recap-seal')
  const open = new Date('2026-11-12T00:00:00Z')
  const sealedAt = new Date('2026-11-13T10:00:00Z')
  const uuid = () => require('crypto').randomUUID()
  try {
    // While open: fixes go through, and the recap is worked out live.
    const wren = uuid()
    await events.addTally(people.sam, event.id, { species_code: 'cacwre', client_id: wren, observed_at: '2026-11-10T20:00:00Z' }, open)
    await events.removeTally(people.sam, event.id, 'cacwre', open)
    await events.undoRemoveTally(people.sam, event.id, 'cacwre', open)
    const live = await recap.memberRecap(people.matt, event.id, { now: open })
    assert.deepEqual([live.status, live.totals.species], ['open', 5])
    assert.equal(await db('event_recaps').where({ event_id: event.id }).first(), undefined, 'nothing frozen while open')

    // After: refused, plainly, in the reader's language too; the ticks are each member's own and stay open; a repeated add is the add already made.
    const refused = await events.addTally(people.matt, event.id, { species_code: 'monqua' }, sealedAt).catch((e) => e)
    assert.deepEqual([refused.status, refused.message], [409, 'The recap is final, so the tally can’t change now'])
    assert.equal(require('../lib/i18n').translateError('fr-CA', refused.message), 'Le bilan est final, donc le décompte ne peut plus changer')
    assert.equal((await events.removeTally(people.matt, event.id, 'grhowl', sealedAt).catch((e) => e)).status, 409)
    assert.equal((await events.undoRemoveTally(people.matt, event.id, 'lewwoo', sealedAt).catch((e) => e)).status, 409)
    assert.equal((await events.addTally(people.sam, event.id, { species_code: 'cacwre', client_id: wren }, sealedAt)).entry.code, 'cacwre')
    const owl = tally.find((t) => t.species_code === 'grhowl').id
    assert.equal((await events.markTally(people.matt, event.id, owl, sealedAt)).tally.find((t) => t.id === owl).marked_by_me, true)

    // The first read after seals it; a life list changed since leaves it as it was.
    const sealed = await recap.memberRecap(people.matt, event.id, { now: sealedAt })
    assert.deepEqual([sealed.status, sealed.totals.species, sealed.candidates], ['sealed', 5, []])
    assert.ok(await db('event_recaps').where({ event_id: event.id }).first())
    await db('seen_birds').insert(['rubrob', 'eletro', 'cacwre'].map((code) => ({ user_id: people.matt.id, species_code: code, first_seen: '2025-05-01' }))).onConflict(['user_id', 'species_code']).ignore()
    await db('event_tally').where({ event_id: event.id, species_code: 'grhowl' }).update({ removed_at: sealedAt })
    const later = await recap.memberRecap(people.matt, event.id, { now: new Date('2026-12-01T00:00:00Z') })
    assert.deepEqual(later.lifers.map((l) => l.speciesCode), sealed.lifers.map((l) => l.speciesCode))
    assert.deepEqual(later.lifers.map((l) => l.speciesCode), ['arwoo', 'rubrob', 'cacwre', 'eletro'])
    assert.equal(later.totals.species, 5, 'the frozen tally')
    // The public view comes from the same frozen copy.
    const pub = await recap.publicRecap(recap.recapCode(event.id), { now: new Date('2026-12-01T00:00:00Z') })
    assert.deepEqual([pub.status, pub.totals.species, pub.lifers.length, pub.stops.length], ['sealed', 5, 4, 2])

    // The morning run freezes what no one opened.
    await db('event_recaps').where({ event_id: event.id }).del()
    await recap.sealDue({ now: new Date('2026-11-12T12:00:00Z') })
    assert.equal(await db('event_recaps').where({ event_id: event.id }).first(), undefined, 'still open')
    assert.ok(await recap.sealDue({ now: new Date('2026-11-14T12:00:00Z') }) >= 1)
    assert.ok(await db('event_recaps').where({ event_id: event.id }).first())
  } finally {
    await restore()
  }
})

test('"your recap is ready": once to each member on the first run after the tally closes, in their language, and only with birds on the tally', async () => {
  const { recapMessage } = require('../lib/mailer')
  const { events, people, event, restore } = await recapDay('recap-mail')
  const sent = []
  const sendRecap = async (user, vars) => { sent.push({ user, vars }) }
  const send = async () => {}
  const run = (iso) => events.runEventNotices({ send, sendRecap, now: new Date(iso) })
  const ours = () => sent.filter((s) => s.vars.event.id === event.id)
  try {
    await db('users').where({ id: people.sam.id }).update({ locale: 'es-MX' })
    await db('users').where({ id: people.kim.id }).update({ trip_emails_enabled: false })
    assert.equal((await run('2026-11-11T09:59:00Z')).recaps, 0, 'the tally is still open')
    assert.equal(ours().length, 0)

    // An empty tally waits: nothing is claimed.
    const rows = await db('event_tally').where({ event_id: event.id }).whereNull('removed_at').select('id')
    await db('event_tally').whereIn('id', rows.map((r) => r.id)).update({ removed_at: new Date('2026-11-10T23:00:00Z') })
    await run('2026-11-11T13:00:00Z')
    assert.equal(ours().length, 0)
    assert.equal(await db('event_members').where({ event_id: event.id }).whereNotNull('recap_notice_at').first(), undefined)
    await db('event_tally').whereIn('id', rows.map((r) => r.id)).update({ removed_at: null })

    await run('2026-11-11T14:00:00Z')
    assert.deepEqual(ours().map((s) => s.user.id).sort(), [people.matt.id, people.sam.id, people.utc.id].sort(), 'not to someone with trip emails off')
    await run('2026-11-11T15:00:00Z')
    await run('2026-11-12T14:00:00Z')
    assert.equal(ours().length, 3, 'once each')

    // Each in their own words, with their own lifers.
    const forMatt = ours().find((s) => s.user.id === people.matt.id)
    const mail = recapMessage(forMatt.user, forMatt.vars)
    assert.equal(mail.subject, 'Your recap is ready: Cochise Big Day: 4 species in Cochise County')
    assert.match(mail.text, /Hi Matt,/)
    assert.match(mail.text, /You picked up 3 lifers, starting with Arizona Woodpecker at Cave Creek Canyon, 7:12 AM and ending with Elegant Trogon at Portal, 1:52 PM\./)
    assert.match(mail.text, /The scouting called it: Elegant Trogon/)
    assert.match(mail.text, /Fixes are open until Friday, November 13\./)
    assert.ok(mail.headers['List-Unsubscribe'])
    const forSam = ours().find((s) => s.user.id === people.sam.id)
    const spanish = recapMessage(forSam.user, forSam.vars)
    assert.match(spanish.subject, /^Tu resumen está listo: Cochise Big Day: 4 especies en /)
    assert.match(spanish.text, /Hola, Sam:/)

    // Past the fix window, a member who joins late gets none.
    await db('event_members').where({ event_id: event.id, user_id: people.kim.id }).update({ recap_notice_at: null })
    await db('users').where({ id: people.kim.id }).update({ trip_emails_enabled: true })
    await run('2026-11-13T14:00:00Z')
    assert.equal(ours().length, 3)
  } finally {
    await restore()
  }
})

test('the scouting emails keep their bird of the day and every bird they named, the morning\'s and the one asked for merged into the day\'s row, for the recap', async () => {
  const scouting = require('../lib/scouting')
  const [{ id: owner }] = await db('users').insert({ email: 'scout-pick@example.com', password_hash: 'x', location: 'US-AZ-003', state: 'AZ', email_confirmed: true, timezone: 'UTC' }).returning('id')
  const now = new Date(`${dayFrom(0)}T15:00:00Z`)
  try {
    const [{ id }] = await db('events').insert({ owner_id: owner, name: 'Scouted', state: 'AZ', location: 'US-AZ-003', range_mi: 0, starts_on: dayFrom(3), ends_on: dayFrom(3), kind: 'bigday', scout: true, scout_days: 7, timezone: 'UTC', invite_token: `inv-${Date.now()}-scoutpick`, view_token: `view-${Date.now()}-scoutpick` }).returning('id')
    await db('event_members').insert({ event_id: id, user_id: owner, role: 'organizer' })
    await db('event_targets').insert(['rubrob', 'eletro'].map((species_code) => ({ event_id: id, species_code })))
    const records = [
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Cave Creek', locId: 'L1', obsDt: `${dayFrom(0)} 07:00`, lat: 31.88, lng: -109.17 },
      { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', locName: 'San Pedro House', locId: 'L2', obsDt: `${dayFrom(-1)} 09:00`, lat: 31.55, lng: -110.14, obsReviewed: true, obsValid: true }
    ]
    await scouting.runScouting({ now, fetchFeed: async () => records, send: async () => {}, push: async () => ({ sent: false }), drive: async () => null })
    const picks = await db('event_scout_birds').where({ event_id: id }).select('day', 'species_code', 'species')
    assert.deepEqual(picks.map((p) => [require('../lib/places').dayOf(p.day), p.species_code]), [[dayFrom(0), 'rubrob']], 'the rarer one, as the email led with it')
    assert.deepEqual(picks[0].species, [{ code: 'rubrob', loc: 'L2', locName: 'San Pedro House' }, { code: 'eletro', loc: 'L1', locName: 'Cave Creek' }], 'every bird it named, where it placed it')

    // "Email me the scouting report now", later the same day, from a fresher feed: what it adds goes into the same row, the bird of the day stays.
    const { emailScoutingNow } = require('../lib/scoutEmail')
    const kept = `api:${require('crypto').createHash('sha1').update('scout-view:county:US-AZ-003').digest('hex')}`
    await db('nearby_cache').whereIn('key', [kept, `scout-email:${id}:${owner}`]).del()
    const fresher = [
      ...records,
      { speciesCode: 'eletro', comName: 'Elegant Trogon', locName: 'Portal', locId: 'L3', obsDt: `${dayFrom(0)} 14:00`, lat: 31.91, lng: -109.14 },
      { speciesCode: 'cacwre', comName: 'Cactus Wren', locName: 'Willcox Twin Lakes', locId: 'L4', obsDt: `${dayFrom(0)} 13:00`, lat: 32.25, lng: -109.85 }
    ]
    // Its targets now: the trogon and the wren, so its bird of the day (the newest, neither coded) isn't the morning's.
    await db('birds').insert([['cacwre', 'Cactus Wren'], ['verfly', 'Vermilion Flycatcher']].map(([speciesCode, comName]) => ({ speciesCode, comName, sciName: comName }))).onConflict('speciesCode').ignore()
    await db('event_targets').where({ event_id: id, species_code: 'rubrob' }).del()
    await db('event_targets').insert({ event_id: id, species_code: 'cacwre' })
    const user = await db('users').where({ id: owner }).first()
    const sent = []
    assert.equal((await emailScoutingNow(user, id, { now: new Date(`${dayFrom(0)}T16:00:00Z`), fetchFeed: async () => fresher, send: async (m) => { sent.push(m) }, drive: async () => null })).status, 200)
    assert.equal(sent.length, 1)
    const merged = await db('event_scout_birds').where({ event_id: id }).select('day', 'species_code', 'species')
    assert.equal(merged.length, 1, 'one row a day')
    assert.equal(merged[0].species_code, 'rubrob', 'the morning\'s bird of the day stays')
    assert.deepEqual(merged[0].species.map((b) => b.code).sort(), ['cacwre', 'eletro', 'rubrob'], 'the wren it added, alongside the morning\'s')
    assert.deepEqual(merged[0].species.find((b) => b.code === 'eletro'), { code: 'eletro', loc: 'L1', locName: 'Cave Creek' }, 'a bird named before keeps its first spot')

    // Asked for with nothing kept yet that day, it makes the row; with none of the targets about, no bird of the day, and what else is about this week named.
    await db('event_scout_birds').where({ event_id: id }).del()
    await db('nearby_cache').where({ key: kept }).del()
    const quiet = [{ speciesCode: 'verfly', comName: 'Vermilion Flycatcher', locName: 'Willcox Twin Lakes', locId: 'L4', obsDt: `${dayFrom(0)} 13:00`, lat: 32.25, lng: -109.85 }]
    assert.equal((await emailScoutingNow(user, id, { now: new Date(`${dayFrom(0)}T16:05:00Z`), fetchFeed: async () => quiet, send: async () => {}, drive: async () => null })).status, 200)
    const asked = await db('event_scout_birds').where({ event_id: id }).select('species_code', 'species')
    assert.deepEqual(asked.map((a) => [a.species_code, a.species]), [[null, [{ code: 'verfly', loc: 'L4', locName: 'Willcox Twin Lakes' }]]])

    // Keeping it never fails the email: with the table gone missing, the email still goes.
    const errorsBefore = Number((await db('error_log').where('where', 'like', 'scouting record%').count('* as n').first()).n)
    await db.schema.renameTable('event_scout_birds', 'event_scout_birds_away')
    try {
      await db('nearby_cache').where({ key: kept }).del()
      const failing = []
      assert.equal((await emailScoutingNow(user, id, { now: new Date(`${dayFrom(0)}T16:10:00Z`), fetchFeed: async () => quiet, send: async (m) => { failing.push(m) }, drive: async () => null })).status, 200)
      assert.equal(failing.length, 1)
    } finally {
      await db.schema.renameTable('event_scout_birds_away', 'event_scout_birds')
    }
    assert.equal(Number((await db('error_log').where('where', 'like', 'scouting record%').count('* as n').first()).n), errorsBefore + 1, 'reported')
    await db('nearby_cache').whereIn('key', [kept, `scout-email:${id}:${owner}`]).del()
  } finally {
    await db('events').where({ owner_id: owner }).del()
    await db('users').where({ id: owner }).del()
  }
})

test('a device that subscribes again replaces its old subscriptions, and a check marks the live one seen', async () => {
  const { saveSubscription, subscriptionStatus, resetColumnCheck } = require('../lib/pushSubscriptions')
  resetColumnCheck()
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  const [{ id: me }] = await db('users').insert({ email: 'push-dedupe@example.com', password_hash: 'x', email_confirmed: true }).returning('id')
  const [{ id: other }] = await db('users').insert({ email: 'push-dedupe-other@example.com', password_hash: 'x', email_confirmed: true }).returning('id')
  const sub = (endpoint, ua) => ({ endpoint, p256dh: 'k', auth: 'a', user_agent: ua })
  const endpoints = async (userId) => (await db('push_subscriptions').where({ user_id: userId }).orderBy('id')).map((row) => row.endpoint)
  const old = new Date(Date.now() - 10 * 86_400_000)

  // Before device ids: two dead iPhone endpoints, two Macs with the same browser, another person's iPhone.
  await db('push_subscriptions').insert([
    { ...sub('https://web.push.apple.com/dead1', iphone), user_id: me, created_at: old, last_seen_at: old },
    { ...sub('https://web.push.apple.com/dead2', iphone), user_id: me, created_at: old, last_seen_at: old },
    { ...sub('https://fcm.googleapis.com/mac-a', mac), user_id: me, created_at: new Date(), last_seen_at: new Date() },
    { ...sub('https://web.push.apple.com/someone-else', iphone), user_id: other, created_at: old, last_seen_at: old }
  ])
  // Mac A opens the app: its row is marked seen and given its device id.
  const a = await subscriptionStatus(me, { endpoint: 'https://fcm.googleapis.com/mac-a', deviceId: 'mac-a-device-0001', userAgent: mac })
  assert.equal(a.subscribed, true)
  assert.equal((await db('push_subscriptions').where({ endpoint: 'https://fcm.googleapis.com/mac-a' }).first()).device_id, 'mac-a-device-0001')

  // The iPhone lost its subscription: the server still knows this kind of device had alerts on.
  const lost = await subscriptionStatus(me, { deviceId: 'iphone-device-0001', userAgent: iphone })
  assert.deepEqual([lost.subscribed, lost.knownDevice], [false, true])
  assert.equal((await subscriptionStatus(other, { deviceId: 'x-device-00001', userAgent: mac })).knownDevice, false)

  // It subscribes again: the dead endpoints go, the Mac and the other person stay.
  assert.equal(await saveSubscription(me, sub('https://web.push.apple.com/live1', iphone), { deviceId: 'iphone-device-0001' }), 2)
  assert.deepEqual(await endpoints(me), ['https://fcm.googleapis.com/mac-a', 'https://web.push.apple.com/live1'])
  assert.deepEqual(await endpoints(other), ['https://web.push.apple.com/someone-else'])

  // A second Mac with an identical browser keeps Mac A's row (it has a device id now).
  await saveSubscription(me, sub('https://fcm.googleapis.com/mac-b', mac), { deviceId: 'mac-b-device-0001' })
  assert.equal((await endpoints(me)).length, 3)

  // Again on the iPhone: one live row per device, with last_seen_at refreshed on the upsert.
  await db('push_subscriptions').where({ endpoint: 'https://web.push.apple.com/live1' }).update({ last_seen_at: old })
  await saveSubscription(me, sub('https://web.push.apple.com/live1', iphone), { deviceId: 'iphone-device-0001' })
  const live = await db('push_subscriptions').where({ endpoint: 'https://web.push.apple.com/live1' }).first()
  assert.ok(Date.now() - new Date(live.last_seen_at).getTime() < 60_000, 'the upsert refreshes last_seen_at')
  await saveSubscription(me, sub('https://web.push.apple.com/live2', iphone), { deviceId: 'iphone-device-0001' })
  assert.deepEqual((await endpoints(me)).filter((e) => e.includes('apple')), ['https://web.push.apple.com/live2'])

  // The service worker renews a subscription with no device id: the old endpoint goes, its device id carries over.
  assert.equal(await saveSubscription(me, sub('https://web.push.apple.com/live3', iphone), { oldEndpoint: 'https://web.push.apple.com/live2' }), 1)
  assert.equal((await db('push_subscriptions').where({ endpoint: 'https://web.push.apple.com/live3' }).first()).device_id, 'iphone-device-0001')

  // A stale row is marked seen when the app checks it.
  await db('push_subscriptions').where({ endpoint: 'https://fcm.googleapis.com/mac-b' }).update({ last_seen_at: old })
  await subscriptionStatus(me, { endpoint: 'https://fcm.googleapis.com/mac-b', deviceId: 'mac-b-device-0001', userAgent: mac })
  const seen = await db('push_subscriptions').where({ endpoint: 'https://fcm.googleapis.com/mac-b' }).first()
  assert.ok(Date.now() - new Date(seen.last_seen_at).getTime() < 60_000)
  await db('users').whereIn('id', [me, other]).del()
})

test('the notification trace keeps each device\'s events', async () => {
  const handler = require('../api/push/[action].js')
  const { fakeReq, fakeRes } = require('./helpers')
  const { createSession } = require('../lib/auth')
  const user = await db('users').where({ id: userId }).first()
  const session = fakeRes(); createSession(session, user)
  const cookie = String(session.headers['set-cookie']).split(';')[0]
  const post = async (detail, ua) => {
    const res = fakeRes()
    await handler(fakeReq({ method: 'POST', query: { action: 'trace' }, headers: { cookie, 'user-agent': ua }, body: detail }), res)
    assert.equal(res.statusCode, 204)
  }
  await post({ event: 'app-load', device: 'iphone-device-0001' }, 'iPhone')
  for (let i = 0; i < 35; i += 1) await post({ event: 'push', ua: 'Macintosh Chrome/142' }, 'Macintosh Chrome/142')
  const { events } = (await db('job_runs').where({ kind: `sw-trace:${userId}` }).first()).detail
  assert.equal(events.filter((e) => e.event === 'app-load').length, 1)
  assert.equal(events.filter((e) => e.event === 'push').length, 30)
})
