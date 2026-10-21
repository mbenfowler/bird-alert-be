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
  for (const table of ['digest_log', 'push_log', 'push_subscriptions', 'saved_birds', 'auth_throttle', 'season_firsts', 'region_species_days', 'region_days', 'job_runs', 'users', 'birds']) await db(table).del()
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
  ebird.recentObservations = async () => [{ speciesCode: 'cangoo', comName: 'Canada Goose', locName: 'Lake', obsDt: '2026-10-20 08:00', lat: 34.2, lng: -83.9, subId: 'S77' }]
  try {
    await db('push_subscriptions').insert({ user_id: userId, endpoint: 'https://push.example/dev1', p256dh: 'k', auth: 'a' })
    await db('saved_birds').insert({ user_id: userId, speciesCode: 'cangoo', bird_id: (await db('birds').insert({ speciesCode: 'cangoo', comName: 'Canada Goose', sciName: 'Branta canadensis' }).returning('id'))[0].id })
    await db('users').where({ id: userId }).update({ push_watchlist_enabled: true, push_quiet_start: null, push_quiet_end: null })
    const sent = []
    const send = async (id, payload) => { sent.push(payload.title); return { sent: 1, gone: 0 } }

    const first = await runPushAlerts({ send })
    assert.equal(first.notified, 1)
    assert.deepEqual(sent, ['⭐ Canada Goose spotted nearby!'])
    assert.equal(Number((await db('push_log').where({ user_id: userId, sub_id: 'S77' }).count('* as n').first()).n), 1)

    const second = await runPushAlerts({ send })
    assert.equal(second.notified, 0, 'same observation must not be pushed twice')
    assert.equal(sent.length, 1)
  } finally {
    ebird.recentObservations = original
  }
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
    const first = await seasonality.backfill(region)
    assert.equal(first.remaining, 0)
    assert.equal(fetched.length, 491)
    assert.deepEqual(await seasonality.backfill(region), { fetched: 0, remaining: 0 }, 'fetched days are never asked for again')

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
