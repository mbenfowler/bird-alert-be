const { test } = require('node:test')
const assert = require('node:assert/strict')
const { signToken, verifyToken, passwordVersion } = require('../lib/tokens')

test('a token only verifies for the purpose it was signed with', () => {
  const token = signToken('reset', { sub: 7 }, '1h')
  assert.equal(verifyToken(token, 'reset').sub, 7)
  assert.throws(() => verifyToken(token, 'session'), /invalid or has expired/)
  assert.throws(() => verifyToken(token, 'confirm'), /invalid or has expired/)
})

test('garbage and expired tokens are rejected with a 400', () => {
  assert.throws(() => verifyToken('not-a-token', 'reset'), (error) => error.status === 400)
  const expired = signToken('reset', { sub: 1 }, -10)
  assert.throws(() => verifyToken(expired, 'reset'), (error) => error.status === 400)
})

test('passwordVersion changes with the hash and is short', () => {
  const a = passwordVersion('$2b$10$aaaa')
  const b = passwordVersion('$2b$10$bbbb')
  assert.notEqual(a, b)
  assert.equal(a.length, 16)
  assert.equal(a, passwordVersion('$2b$10$aaaa'))
})
