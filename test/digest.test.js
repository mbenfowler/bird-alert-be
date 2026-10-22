const { test } = require('node:test')
const assert = require('node:assert/strict')
const { previewDigest, newestPerSpecies } = require('../lib/digest')

const user = { id: 1, location: 'US-GA-139', email_confirmed: true }
const definition = (overrides = {}) => {
  const sent = []
  return {
    sent,
    fetchSightings: async () => [{ speciesCode: 'a', subId: 'S2' }, { speciesCode: 'a', subId: 'S1' }, { speciesCode: 'b', subId: 'S3' }],
    select: async (_user, sightings, options) => { assert.deepEqual(options, { preview: true }); return sightings },
    send: async (_user, sightings) => { sent.push(sightings.length) },
    ...overrides
  }
}

test('a preview sends the digest at once, newest report per species, flagged as a preview', async () => {
  const d = definition()
  assert.deepEqual(await previewDigest(user, d), { sent: true, items: 2 })
  assert.deepEqual(d.sent, [2])
})

test('a preview says why when there is nothing to send', async () => {
  assert.deepEqual(await previewDigest(user, definition({ select: async () => [] })), { sent: false, reason: 'nothing' })
  assert.deepEqual(await previewDigest({ ...user, email_confirmed: false }, definition()), { sent: false, reason: 'unconfirmed' })
  assert.deepEqual(await previewDigest({ ...user, location: '' }, definition()), { sent: false, reason: 'location' })
})

test('newestPerSpecies keeps the first record of each species', () => {
  assert.deepEqual(newestPerSpecies([{ speciesCode: 'a', subId: 'S2' }, { speciesCode: 'b', subId: 'S3' }, { speciesCode: 'a', subId: 'S1' }]).map((o) => o.subId), ['S2', 'S3'])
})
