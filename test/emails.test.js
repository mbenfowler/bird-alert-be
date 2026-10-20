const { test } = require('node:test')
const assert = require('node:assert/strict')
const { layout, sightingCards } = require('../lib/mailer')

const sighting = { speciesCode: 'snogoo', comName: 'Snow <Goose>', locName: 'Lake Lanier', obsDt: '2026-10-20 13:49', howMany: 3, lat: 34.2695, lng: -83.9014, subId: 'S123' }

test('sighting cards carry photo, map, place, time and both links, with HTML escaped', () => {
  const html = sightingCards([sighting], new Map([['snogoo', { birdImg: 'https://img/snogoo.jpg' }]]))
  assert.match(html, /Snow &lt;Goose&gt;/)
  assert.match(html, /https:\/\/img\/snogoo\.jpg/)
  assert.match(html, /\/api\/map\?lat=34\.2695&lng=-83\.9014/)
  assert.match(html, /Lake Lanier &middot; Oct 20, 1:49 PM &middot; 3 seen/)
  assert.match(html, /ebird\.org\/checklist\/S123/)
  assert.match(html, /google\.com\/maps\/search/)
})

test('maps are limited to the first few cards and the list is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...sighting, speciesCode: `b${i}`, comName: `Bird ${i}`, subId: `S${i}` }))
  const html = sightingCards(many)
  assert.equal((html.match(/\/api\/map\?/g) || []).length, 8)
  assert.equal((html.match(/View on eBird/g) || []).length, 25)
  assert.match(html, /and 5 more/)
})

test('the shell has the header, the body and footer links', () => {
  const html = layout({ heading: 'Hello', intro: 'Intro', body: '<p>Body</p>', footerLinks: [{ href: 'https://x/u', label: 'Unsubscribe' }] })
  assert.match(html, /Bird <span[^>]*>Alert!<\/span>/)
  assert.match(html, /<h1[^>]*>Hello<\/h1>/)
  assert.match(html, /href="https:\/\/x\/u"/)
})
