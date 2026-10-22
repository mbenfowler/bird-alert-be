const { test } = require('node:test')
const assert = require('node:assert/strict')

// Every send function must reach the transport. A missing helper here once broke every email in
// production while the message builders' tests stayed green, so the whole path is exercised.
const sent = []
process.env.APP_EMAIL = 'birdalert.test@example.com'
process.env.APP_PW = 'app-password'
process.env.FORCE_SEND_MAIL = 'true'
require('nodemailer').createTransport = () => ({ sendMail: async (message) => { sent.push(message); return { accepted: [message.to] } } })
const mailer = require('../lib/mailer')

const user = { id: 7, email: 'birder@example.com', password: 'hash', location: 'US-GA-139' }
const sighting = { speciesCode: 'snogoo', comName: 'Snow Goose', locName: 'Lake Lanier', obsDt: '2026-10-20 13:49', howMany: 3, lat: 34.2695, lng: -83.9014, subId: 'S1' }
const report = { arrived: [{ speciesCode: 'yerwar', comName: 'Yellow-rumped Warbler', daysThisWeek: 3, firstSeen: '2026-10-14' }], departed: [], coming: [] }

test('every email goes out through the transport with the sender, recipient and subject set', async () => {
  const results = await Promise.all([
    mailer.sendConfirmationEmail(user),
    mailer.sendPasswordResetEmail(user),
    mailer.sendAlertDigestEmail(user, [sighting], new Map()),
    mailer.sendRareSightingsEmail(user, [sighting], new Map()),
    mailer.sendMigrationEmail(user, report, 'Hall')
  ])
  assert.equal(results.length, 5)
  assert.equal(sent.length, 5)
  for (const message of sent) {
    assert.match(message.from, /birdalert\.test@example\.com/)
    assert.equal(message.to, user.email)
    assert.ok(message.subject, 'subject')
    assert.ok(message.html.includes('<!doctype html>'), 'html body')
    assert.ok(message.text, 'text body')
  }
  assert.ok(sent.some((m) => m.subject.includes('Snow Goose')))
})

test('outside production without FORCE_SEND_MAIL a send is simulated, not attempted', async () => {
  process.env.FORCE_SEND_MAIL = 'false'
  const before = sent.length
  const result = await mailer.sendMail({ to: user.email, subject: 'Hello', text: 'hi', html: '<p>hi</p>' })
  assert.deepEqual(result, { accepted: [user.email], simulated: true })
  assert.equal(sent.length, before)
})
