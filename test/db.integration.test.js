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
  for (const table of ['hq_picks', 'feedback', 'passkeys', 'shares', 'seen_birds', 'taxonomy_ref', 'user_routes', 'hotspot_ref', 'mail_counts', 'error_log', 'drive_cache', 'nearby_cache', 'place_predictions', 'checklist_species', 'checklists', 'bird_sounds', 'digest_log', 'push_handoff', 'push_log', 'push_subscriptions', 'saved_birds', 'auth_throttle', 'season_firsts', 'region_species_days', 'region_days', 'job_runs', 'users', 'birds']) await db(table).del()
  // Nothing in here may reach eBird; the hourly job's history fetch is a no-op unless a test says otherwise.
  ebird.historicObservations = async () => []
  ;[{ id: userId }] = await db('users').insert({
    email: 'tester@example.com', password_hash: 'x', location: 'US-GA-139', state: 'GA', email_confirmed: true
  }).returning('id')
})
after(async () => { await db.destroy() })

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
    assert.ok(sent[0].data.url.endsWith('/sightings?s=' + encodeURIComponent('cangoo:S77,snogoo:S78')))
    assert.equal(Number((await db('push_log').where({ user_id: userId }).whereIn('sub_id', ['S77', 'S78']).count('* as n').first()).n), 2)

    const second = await runPushAlerts({ send })
    assert.equal(second.notified, 0, 'same observation must not be pushed twice')
    assert.equal(sent.length, 1)
  } finally {
    ebird.recentObservations = original
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
  await assert.rejects(createShare(userId, { kind: 'poem' }), (e) => e.status === 400)
  await db('shares').insert(Array.from({ length: 50 }, (_, i) => ({ id: `cap${String(i).padStart(4, '0')}`, kind: 'route', user_id: userId, payload: '{}' })))
  await assert.rejects(createShare(userId, { kind: 'route', stops: [{ name: 'x', lat: 1, lng: 1 }] }), (e) => e.status === 429)
})

test('signup can bring a county, /me renews the session, and passkey calls need a known origin', async () => {
  const auth = require('../api/auth/[action]')
  const { fakeReq, fakeRes } = require('./helpers')
  const signup = fakeRes()
  await auth(fakeReq({ method: 'POST', query: { action: 'signup' }, body: { email: 'county@example.com', password: 'longenough1', state: 'GA', location: 'US-GA-139' } }), signup)
  assert.equal(signup.statusCode, 201)
  assert.deepEqual([signup.body.state, signup.body.location, signup.body.hasPasskey], ['GA', 'US-GA-139', false])
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
    assert.equal(mails.length, 1, 'nothing to pitch, no email')
    const twoMisses = async () => ({ verdict: 'gone', checkedSince: 2, foundSince: 0, missesSince: 2 })
    assert.equal((await runHqDesk({ asOf: '2026-11-16', records: sparrows, check: twoMisses, send: async (m) => { mails.push(m); return {} } })).picks, 1)
    assert.match(mails.pop().html, /Still there\?<\/strong> probably gone · 0 of 2 checklists since had it/)
    // The next morning the same bird isn't pitched again.
    const second = await runHqDesk({ asOf: '2026-10-28', records, check: noCheck, send: async (m) => { mails.push(m); return {} } })
    assert.equal(second.picks, 0)
    assert.equal(mails.length, 1, 'nothing new, no email')
  } finally { delete process.env.FEEDBACK_TO }
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
