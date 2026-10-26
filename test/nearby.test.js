const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalize } = require('../lib/nearby')

test('names are compared without eBird prefixes and punctuation', () => {
  assert.equal(normalize('Lake Lanier--Sardis Creek Park'), 'sardis creek park')
  assert.equal(normalize('Sardis Creek Park'), 'sardis creek park')
  assert.equal(normalize("Rusty's Yard"), 'rusty s yard')
})
