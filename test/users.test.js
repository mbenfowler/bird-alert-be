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

test('only plain email addresses are accepted', () => {
  const { assertValidEmail } = require('../lib/users')
  for (const ok of ['matt@example.com', 'first.last+birds@sub.example.co.uk', "o'brien@example.ie"]) assert.equal(assertValidEmail(ok), ok)
  for (const bad of ['"a;b"@example.com', 'a(b)@example.com', 'a<b>@example.com', 'a,b@example.com', 'a:b@example.com', 'a\\b@example.com', 'x@[1.2.3.4]', 'no-at.example.com', 'a b@example.com']) {
    assert.throws(() => assertValidEmail(bad), /valid email/, bad)
  }
})

test('what brought someone in is cut down to safe pieces, and never sent back to the app', () => {
  const { cleanSignupSource, sourceLabel } = require('../lib/signupSource')
  const { sanitizeUser } = require('../lib/users')
  assert.deepEqual(cleanSignupSource({ ref: 'WWW.Instagram.com', utm: 'Instagram', share: 'jHwrtfGDai', landing: 'share-sighting' }), { ref: 'instagram.com', utm: 'instagram', share: 'jHwrtfGDai', landing: 'share-sighting' })
  assert.deepEqual(cleanSignupSource({ ref: 'https://evil.example/path?x=1', utm: 'x; drop table', share: '../../etc', landing: '/reset/abc' }), null, 'anything odd is dropped')
  assert.equal(cleanSignupSource('nope'), null)
  assert.equal(sourceLabel({ ref: 'l.instagram.com' }), 'instagram')
  assert.equal(sourceLabel({ ref: 't.co', share: 'jHwrtfGDai' }), 'x')
  assert.equal(sourceLabel({ utm: 'instagram', ref: 't.co' }), 'instagram', 'a tag wins over the referrer')
  assert.equal(sourceLabel({ share: 'jHwrtfGDai' }), 'share link')
  assert.equal(sourceLabel({ landing: 'home' }), 'direct')
  assert.equal(sourceLabel(null), 'unknown')
  assert.equal(sanitizeUser({ id: 1, email: 'a@b.co', password_hash: 'x', signup_source: { ref: 't.co' } }).signup_source, undefined)
})
