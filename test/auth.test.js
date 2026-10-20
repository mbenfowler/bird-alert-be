const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hashPassword, verifyPassword, createSession, clearSession } = require('../lib/auth')
const { fakeRes } = require('./helpers')

test('hashes verify only against the right password', async () => {
  const hash = await hashPassword('correct horse')
  assert.ok(hash.startsWith('$2'))
  assert.equal(await verifyPassword('correct horse', hash), true)
  assert.equal(await verifyPassword('wrong', hash), false)
  assert.equal(await verifyPassword('anything', null), false)
})

test('session cookie is HttpOnly, SameSite=Lax, scoped to /, and clearable', () => {
  const res = fakeRes()
  createSession(res, { id: 1, password_hash: '$2b$10$x' })
  const cookie = res.headers['set-cookie']
  assert.match(cookie, /^bird_alert_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/)

  const cleared = fakeRes()
  clearSession(cleared)
  assert.match(cleared.headers['set-cookie'], /^bird_alert_session=; .*Max-Age=0/)
})
