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
  for (const table of ['taxonomy_names', 'hq_alerts', 'hotspot_weeks', 'hq_picks', 'feedback', 'passkeys', 'shares', 'seen_birds', 'taxonomy_ref', 'user_routes', 'hotspot_ref', 'mail_counts', 'error_log', 'drive_cache', 'nearby_cache', 'place_predictions', 'checklist_species', 'checklists', 'bird_sounds', 'digest_log', 'push_handoff', 'push_log', 'push_subscriptions', 'saved_birds', 'auth_throttle', 'season_firsts', 'region_species_days', 'region_days', 'job_runs', 'users', 'birds']) await db(table).del()
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
  const second = await dailyPass('US-GA-139', { where, asOf: '2026-10-08' })
  assert.deepEqual(second, { region: 'US-GA-139', skipped: true })
  assert.equal(whereCalls, first.species)
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
    assert.match(mails[0].html, /🚨 A Code 4 mega in California: YELLOW-BROWED WARBLER/)
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

test('languages: bird names come from eBird in the reader\'s language, the words stay English until a catalog exists, and distances follow the country', async () => {
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

    // A push to someone reading Spanish in Mexico: the bird in Spanish, the words English (no catalog yet), km.
    const reader = { locale: 'es-MX', state: 'SON' }
    const inSpanish = await birdNames.inLanguage(reader.locale)
    const push = sightingNotification(inSpanish({ kind: 'notable', speciesCode: 'vermfl', comName: 'Vermilion Flycatcher', subId: 'S1', locName: 'Río', obsDt: '2026-10-30 08:00', lat: 32, lng: -110, away: { miles: 12, county: 'Pima' } }), {}, langFor(reader))
    assert.equal(push.title, '❗ Notable: Mosquero Cardenal reported 19 km away')
    assert.match(push.body, /^Río · 19 km away in Pima · /)

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
