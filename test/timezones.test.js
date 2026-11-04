const { test } = require('node:test')
const assert = require('node:assert/strict')
const { zoneForArea, eventZone, ZONES } = require('../lib/timezones')
const { isValidTimezone } = require('../lib/quietHours')
const events = require('../lib/events')

test('an area\'s zone: its state, the county or spot where a state is split, null where the area alone can\'t say', () => {
  const all = [...Object.values(ZONES.US), ...Object.values(ZONES.CA), ...Object.values(ZONES.MX), ...Object.values(ZONES.PROVINCES),
    ...Object.values(ZONES.COUNTRIES), ...Object.values(ZONES.COUNTIES), ...Object.values(ZONES.BY_LNG).map((r) => r.west || r.east)]
  assert.deepEqual(all.filter((z) => !isValidTimezone(z)), [], 'every zone is a real one')
  assert.equal(zoneForArea({ state: 'AZ', location: 'US-AZ-003' }), 'America/Phoenix')
  assert.equal(zoneForArea({ state: 'TX', location: 'US-TX-141' }), 'America/Denver', 'El Paso')
  assert.equal(zoneForArea({ state: 'TX', location: 'US-TX-061' }), 'America/Chicago')
  assert.equal(zoneForArea({ state: 'KY', location: 'US-KY-145', home_lat: 37.08, home_lng: -88.6 }), 'America/Chicago', 'west Kentucky by its spot')
  assert.equal(zoneForArea({ state: 'KY', location: 'US-KY-145' }), 'America/New_York', 'no spot: the state\'s own')
  assert.equal(zoneForArea({ state: 'SON', location: 'MX-SON-030' }), 'America/Hermosillo')
  assert.equal(zoneForArea({ state: 'JAL', location: 'MX-JAL-039' }), 'America/Mexico_City')
  assert.equal(zoneForArea({ state: 'ON', location: 'CA-ON-TO' }), 'America/Toronto')
  assert.equal(zoneForArea({ state: 'GB-ENG', location: 'GB-ENG-LND' }), 'Europe/London')
  assert.equal(zoneForArea({ state: 'AU-WA', location: 'AU-WA' }), 'Australia/Perth')
  assert.equal(zoneForArea({ state: 'BR-AM', location: 'BR-AM-001' }), null)
  assert.equal(zoneForArea({ state: 'ZV', location: 'US-ZV-009' }), null)
  assert.equal(eventZone({ timezone: 'America/Phoenix', state: 'GA' }), 'America/Phoenix', 'stored wins')
  assert.equal(eventZone({ state: 'AZ', location: 'US-AZ-003' }, 'America/New_York'), 'America/Phoenix', 'from its area when not stored')
  assert.equal(eventZone({ state: 'BR-AM', location: 'BR-AM-001' }, 'America/Manaus'), 'America/Manaus', 'else the person\'s')
  assert.equal(eventZone({ state: 'BR-AM' }, null), 'UTC')
})

test('an event\'s day in its own zone: on to midnight there, the tally open to 3 AM, whatever zone the member\'s account has', () => {
  const bigDay = { state: 'AZ', location: 'US-AZ-003', timezone: 'America/Phoenix', starts_on: '2026-11-10', ends_on: '2026-11-10' }
  // Phoenix is UTC-7 all year (no daylight saving).
  const at = { '5 PM': '2026-11-11T00:00:00Z', '10 PM': '2026-11-11T05:00:00Z', '11:59 PM': '2026-11-11T06:59:00Z', '12:30 AM next': '2026-11-11T07:30:00Z', '3 AM next': '2026-11-11T10:00:00Z' }
  for (const zone of ['America/New_York', 'UTC', null]) {
    for (const time of ['5 PM', '10 PM', '11:59 PM']) {
      const clock = events.eventClock(bigDay, zone, new Date(at[time]))
      assert.deepEqual([clock.zone, clock.today, clock.active, clock.past, clock.tally_open], ['America/Phoenix', '2026-11-10', true, false, true], `${time} Phoenix, account ${zone}`)
    }
    const late = events.eventClock(bigDay, zone, new Date(at['12:30 AM next']))
    assert.deepEqual([late.active, late.past, late.tally_open], [false, true, true], 'after midnight: over, but late entries still go in')
    const closed = events.eventClock(bigDay, zone, new Date(at['3 AM next']))
    assert.deepEqual([closed.active, closed.past, closed.tally_open], [false, true, false])
  }
  // The morning of: open from local midnight, not UTC's.
  assert.equal(events.eventClock(bigDay, 'UTC', new Date('2026-11-10T06:59:00Z')).active, false, '11:59 PM on the 9th in Phoenix')
  assert.equal(events.eventClock(bigDay, 'UTC', new Date('2026-11-10T07:00:00Z')).active, true)
})

test('a tally add as the app sends it: a UUID, a time not in the future, a spot both or neither; the nearest stop within 2 km', () => {
  const now = new Date('2026-11-10T15:00:00Z')
  const id = '0b7c7c56-3c5e-4f7a-9a51-1d7c1b1f3f00'
  assert.deepEqual(events.cleanEntry('eletro', now), { species: 'eletro', clientId: null, observedAt: now, spot: null })
  const full = events.cleanEntry({ species_code: 'eletro', client_id: id.toUpperCase(), observed_at: '2026-11-10T14:00:00Z', lat: 31.88123, lng: -109.17456 }, now)
  assert.deepEqual([full.clientId, full.observedAt.toISOString(), full.spot], [id, '2026-11-10T14:00:00.000Z', { lat: 31.88123, lng: -109.17456 }])
  assert.equal(events.cleanEntry({ species_code: 'eletro', observed_at: '2026-11-10T18:00:00Z' }, now).observedAt, now, 'a fast phone: now')
  for (const bad of [{ client_id: 'abc' }, { observed_at: 'yesterday-ish' }, { lat: 31.9 }, { lat: 'x', lng: 1 }, { lat: 91, lng: 0 }]) {
    assert.throws(() => events.cleanEntry({ species_code: 'eletro', ...bad }, now), (e) => e.status === 400, JSON.stringify(bad))
  }
  const stops = [{ name: 'Cave Creek', lat: 31.88, lng: -109.17 }, { name: 'Portal', lat: 31.913, lng: -109.141 }]
  assert.equal(events.nearestStop(stops, { lat: 31.881, lng: -109.175 }), 0)
  assert.equal(events.nearestStop(stops, { lat: 31.91, lng: -109.14 }), 1)
  assert.equal(events.nearestStop(stops, { lat: 31.95, lng: -109.25 }), null, 'over 2 km from both')
  assert.equal(events.nearestStop([], { lat: 31.88, lng: -109.17 }), null)
  assert.equal(events.nearestStop(stops, null), null)
})
