const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cleanRoute, previewFor, injectMeta, newId } = require('../lib/shares')

test('a shared route keeps stops and the drive, and never a start', () => {
  const route = cleanRoute({
    regionName: 'Hall',
    start: { name: '12 My Street', lat: 34.3, lng: -83.8 },
    stops: [{ name: 'Chicopee Lake', lat: 34.2512345678, lng: -83.85, locId: 'L123', birds: ['Pine Warbler 72%', 42, ''] }, { name: '  Elachee  ', lat: 34.26, lng: -83.86, locId: 'drop table' }],
    drive: { minutes: 41.6, miles: 20.44, legs: [{ minutes: 5, miles: 2 }], geometry: [[34.25, -83.85], [34.26, -83.86]] }
  })
  assert.equal(route.start, undefined)
  assert.deepEqual(route.stops.map((s) => [s.name, s.lat, s.locId]), [['Chicopee Lake', 34.25123, 'L123'], ['Elachee', 34.26, null]])
  assert.deepEqual(route.stops[0].birds, ['Pine Warbler 72%'])
  assert.deepEqual([route.drive.minutes, route.drive.miles], [42, 20.4])
  assert.throws(() => cleanRoute({ stops: [] }), /1 to 8 stops/)
  assert.throws(() => cleanRoute({ stops: [{ name: 'x', lat: 95, lng: 0 }] }), /Invalid point/)
})

test('a preview card says what was shared, and is escaped into the page head', () => {
  const sighting = { kind: 'sighting', comName: 'Painted Bunting', locName: 'Chicopee "Lake" <b>', lat: 34.25, lng: -83.85, obsDt: '2026-10-27 08:10', howMany: 2, regionName: 'Hall', birdImg: 'https://img.example/pb.jpg' }
  const p = previewFor(sighting)
  assert.equal(p.title, 'Painted Bunting reported at Chicopee "Lake" <b>')
  assert.match(p.description, /^2 seen on Oct 27 in Hall\./)
  const shell = '<html><head><meta charset="utf-8" /><meta name="description" content="old" /><title>Bird Alert!</title></head><body></body></html>'
  const html = injectMeta(shell, sighting, 'https://bird-alert.vercel.app/share/s/abc')
  assert.match(html, /<title>Painted Bunting reported at Chicopee &quot;Lake&quot; &lt;b&gt; · Bird Alert!<\/title>/)
  assert.match(html, /property="og:image" content="https:\/\/img.example\/pb.jpg"/)
  assert.equal((html.match(/name="description"/g) || []).length, 1, 'the old description is replaced')
  assert.ok(!html.includes('<b>'))
  const route = previewFor({ kind: 'route', regionName: 'Hall', stops: [{ name: 'Lake Lanier--Longwood Park', lat: 34.3, lng: -83.8 }, { name: 'Chicopee Lake', lat: 34.25, lng: -83.85 }], drive: { minutes: 42, miles: 20.4 } })
  assert.equal(route.title, 'A birding route in Hall: 2 stops')
  assert.match(route.description, /^Longwood Park → Chicopee Lake · 42 min, 20.4 mi\./)
  assert.match(route.image, /\/api\/map\?pins=34\.3000%2C-83\.8000%2C1%3B/)
})

test('share ids are short and unambiguous', () => {
  const id = newId()
  assert.match(id, /^[A-Za-z2-9]{10}$/)
  assert.ok(!/[0O1lI]/.test(id))
})
