const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TIPS, tipsFor, withTips } = require('../lib/tips')

test('every tip has habitat, look and time, and codes look like eBird codes', () => {
  const codes = Object.keys(TIPS)
  assert.ok(codes.length >= 440, `only ${codes.length} tips`)
  for (const code of codes) {
    assert.match(code, /^[a-z0-9]{3,12}$/, code)
    const tip = TIPS[code]
    assert.deepEqual(Object.keys(tip).sort(), ['habitat', 'look', 'time'], code)
    for (const key of ['habitat', 'look', 'time']) assert.ok(tip[key].trim().length > 3, `${code}.${key}`)
    assert.ok(tip.look.length <= 400, `${code} look too long`)
  }
})

test('birds carry their tips, null when unknown', () => {
  const [goose, unknown] = withTips([{ speciesCode: 'cangoo', comName: 'Canada Goose' }, { speciesCode: 'zzzzz', comName: 'Nothing' }])
  assert.equal(goose.tips.time, 'Any time')
  assert.match(goose.tips.habitat, /Lakes/)
  assert.equal(unknown.tips, null)
  assert.equal(tipsFor('norcar').time, 'Any time')
})
