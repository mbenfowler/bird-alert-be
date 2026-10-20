const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeEmail, assertValidEmail, assertValidPassword, sanitizeUser } = require('../lib/users')

test('emails are trimmed and lowercased', () => {
  assert.equal(normalizeEmail('  Bird@Example.COM '), 'bird@example.com')
  assert.equal(normalizeEmail(undefined), '')
})

test('email validation', () => {
  assert.equal(assertValidEmail('a@b.co'), 'a@b.co')
  assert.throws(() => assertValidEmail('1234'), /valid email/)
  assert.throws(() => assertValidEmail('a@b'), /valid email/)
})

test('passwords need eight characters', () => {
  assert.equal(assertValidPassword('12345678'), '12345678')
  assert.throws(() => assertValidPassword('1234'), /at least 8/)
  assert.throws(() => assertValidPassword(12345678), /at least 8/)
})

test('sanitizeUser strips the hash and never returns a password', () => {
  assert.deepEqual(sanitizeUser({ id: 1, email: 'a@b.co', password_hash: 'x', password: 'y' }), { id: 1, email: 'a@b.co' })
  assert.equal(sanitizeUser(null), null)
})
