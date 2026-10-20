const { test } = require('node:test')
const assert = require('node:assert/strict')
const { inQuietHours, isValidTimezone } = require('../lib/quietHours')

const at = (isoUtc) => new Date(isoUtc)
const ny = { push_quiet_start: 22, push_quiet_end: 6, timezone: 'America/New_York' }

test('quiet hours wrap midnight in the user zone', () => {
  // 03:00 UTC on 20 Oct = 23:00 the previous evening in New York (EDT): quiet.
  assert.equal(inQuietHours(ny, at('2026-10-20T03:00:00Z')), true)
  // 14:00 UTC = 10:00 New York: not quiet.
  assert.equal(inQuietHours(ny, at('2026-10-20T14:00:00Z')), false)
  // 09:30 UTC = 05:30 New York: still quiet; 10:30 UTC = 06:30: over.
  assert.equal(inQuietHours(ny, at('2026-10-20T09:30:00Z')), true)
  assert.equal(inQuietHours(ny, at('2026-10-20T10:30:00Z')), false)
})

test('a daytime window that does not wrap works too', () => {
  const u = { push_quiet_start: 9, push_quiet_end: 17, timezone: 'UTC' }
  assert.equal(inQuietHours(u, at('2026-10-20T12:00:00Z')), true)
  assert.equal(inQuietHours(u, at('2026-10-20T20:00:00Z')), false)
})

test('missing bounds or zone means never quiet', () => {
  assert.equal(inQuietHours({ ...ny, timezone: null }, at('2026-10-20T03:00:00Z')), false)
  assert.equal(inQuietHours({ ...ny, push_quiet_start: null }, at('2026-10-20T03:00:00Z')), false)
  assert.equal(inQuietHours({ ...ny, push_quiet_start: 6, push_quiet_end: 6 }, at('2026-10-20T03:00:00Z')), false)
})

test('time zone names are validated', () => {
  assert.equal(isValidTimezone('America/New_York'), true)
  assert.equal(isValidTimezone('Mars/Olympus'), false)
  assert.equal(isValidTimezone(42), false)
})
