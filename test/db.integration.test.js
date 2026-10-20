// Runs against a real Postgres (TEST_PG_URL). Covers the pieces that only make sense with a database.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')

const db = require('../lib/db')
const { assertNotThrottled, recordAttempt, clearAttempts } = require('../lib/throttle')
const { runDigest } = require('../lib/digest')

let userId
before(async () => {
  await db.migrate.latest()
  await db('digest_log').del()
  await db('saved_birds').del()
  await db('auth_throttle').del()
  await db('users').del()
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
