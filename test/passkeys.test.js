const { test } = require('node:test')
const assert = require('node:assert/strict')
const { deviceName, siteOf } = require('../lib/passkeys')

test('passkeys belong to this app’s own sites only', () => {
  assert.deepEqual(siteOf({ headers: { origin: 'https://bird-alert.vercel.app' } }), { origin: 'https://bird-alert.vercel.app', rpID: 'bird-alert.vercel.app' })
  assert.equal(siteOf({ headers: { origin: 'https://bird-alert-git-feat-x-mben.vercel.app' } }).rpID, 'bird-alert-git-feat-x-mben.vercel.app')
  assert.equal(siteOf({ headers: { origin: 'http://localhost:3000' } }).rpID, 'localhost')
  for (const origin of ['https://evil.example', 'https://bird-alert.vercel.app.evil.example', '', 'not a url']) {
    assert.throws(() => siteOf({ headers: { origin } }), /Unknown origin/)
  }
})

test('a passkey is named after the device it was made on', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'iPhone')
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'Mac')
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15)'), 'Android phone')
  assert.equal(deviceName(''), 'This device')
})
