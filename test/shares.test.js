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
  assert.match(html, /addEventListener\('error'/, 'a page whose code fails to load reloads itself once')
  const route = previewFor({ kind: 'route', regionName: 'Hall', stops: [{ name: 'Lake Lanier--Longwood Park', lat: 34.3, lng: -83.8 }, { name: 'Chicopee Lake', lat: 34.25, lng: -83.85 }], drive: { minutes: 42, miles: 20.4 } })
  assert.match(previewFor({ ...sighting, id: 'abc123defg' }).image, /\/api\/map\?card=abc123defg$/, 'a sighting with a photo gets its own card')
  assert.equal(route.title, 'A birding route in Hall: 2 stops')
  assert.match(route.description, /^Longwood Park → Chicopee Lake · 42 min, 20.4 mi\./)
  assert.match(route.image, /\/api\/map\?pins=34\.3000%2C-83\.8000%2C1%3B/)
})

test('share ids are short and unambiguous', () => {
  const id = newId()
  assert.match(id, /^[A-Za-z2-9]{10}$/)
  assert.ok(!/[0O1lI]/.test(id))
})

test('bird photos are asked for at card size where the host can resize them', () => {
  const { cardImage } = require('../lib/shares')
  const card = new URL(cardImage('https://images.unsplash.com/photo-1623798275980-c6dbd4c4d9f0?q=75&fm=jpg&w=400&fit=max'))
  assert.deepEqual([card.searchParams.get('w'), card.searchParams.get('h'), card.searchParams.get('fit')], ['1200', '630', 'crop'])
  assert.equal(cardImage('https://upload.wikimedia.org/a/bird.jpg'), 'https://upload.wikimedia.org/a/bird.jpg')
})

test('share cards only fetch photos from the hosts our birds come from', async () => {
  const { renderCard } = require('../lib/shareCard')
  await assert.rejects(renderCard('https://evil.example/x.jpg'), /not allowed/)
  await assert.rejects(renderCard('http://images.unsplash.com/x.jpg'), /not allowed/)
})

test('a recap link previews its count, lifers, stops, miles and area, with its own card', () => {
  const recap = { kind: 'recap', code: '2n-abc123', status: 'sealed', name: 'Big Day 2027', eventKind: 'big_day', area: 'Cochise County, AZ', species: 92, lifers: 7, stops: 6, miles: 186 }
  const p = previewFor(recap)
  assert.equal(p.title, 'Big Day 2027 recap: 92 species')
  assert.equal(p.description, '7 lifers · 6 stops · 186 miles · Cochise County, AZ')
  assert.match(p.image, /\/api\/map\?recap=2n-abc123&v=[0-9a-f]{8}$/)
  assert.notEqual(previewFor({ ...recap, species: 93 }).image, p.image, 'the picture moves when the count does')
  assert.equal(previewFor({ ...recap, species: 1, lifers: 1, stops: 1, miles: null, area: null }).description, '1 lifer · 1 stop')
  assert.equal(previewFor({ ...recap, lifers: 0 }).description, '6 stops · 186 miles · Cochise County, AZ')
  const html = injectMeta('<html><head><title>Bird Alert!</title></head></html>', recap, 'https://bird-alert.vercel.app/recap/2n-abc123')
  assert.match(html, /<title>Big Day 2027 recap: 92 species · Bird Alert!<\/title>/)
  assert.match(html, /property="og:url" content="https:\/\/bird-alert.vercel.app\/recap\/2n-abc123"/)
})

test('a recap preview takes only the public view’s words: no names, no personal spots', async () => {
  const eventRecap = require('../lib/eventRecap')
  const { recapShare } = require('../lib/shares')
  const real = eventRecap.publicRecap
  eventRecap.publicRecap = async () => ({
    audience: 'public',
    status: 'open',
    event: { name: 'Big Day', kind: 'big_day', area: 'Hall County, GA', lat: 34.3, lng: -83.8 },
    totals: { species: 40, stops: 3, miles: 21.6, bestStop: { name: 'Home feeder' } },
    lifers: [{ comName: 'Painted Bunting', who: null }],
    members: [{ name: 'Matt' }],
    stops: [{ name: 'Chicopee Lake' }]
  })
  try {
    const r = await recapShare(' 2N-ABC123 ')
    assert.deepEqual(r, { kind: 'recap', code: '2n-abc123', status: 'open', name: 'Big Day', eventKind: 'big_day', area: 'Hall County, GA', species: 40, lifers: 1, stops: 3, miles: 22 })
  } finally { eventRecap.publicRecap = real }
})

test('a recap page with a bad code, the demo, or an event not over is the plain app page', async () => {
  const eventRecap = require('../lib/eventRecap')
  const { sharePage } = require('../lib/shares')
  const { HttpError } = require('../lib/http')
  const shell = '<html><head><title>Bird Alert!</title><meta property="og:title" content="Bird Alert!" /></head><body></body></html>'
  const realFetch = global.fetch
  const real = eventRecap.publicRecap
  global.fetch = async () => ({ ok: true, text: async () => shell })
  try {
    for (const error of [new HttpError(404, 'This link is invalid or has expired'), new HttpError(409, 'not_ended'), new Error('db down')]) {
      eventRecap.publicRecap = async () => { throw error }
      assert.equal(await sharePage({ kind: 'recap', id: 'demo' }, { headers: {} }), shell)
    }
    eventRecap.publicRecap = async () => ({ status: 'sealed', event: { name: 'Big Day', kind: 'big_day', area: 'Hall County, GA' }, totals: { species: 40, stops: 3, miles: null }, lifers: [] })
    const html = await sharePage({ kind: 'recap', id: '2n-abc123' }, { headers: { 'x-forwarded-host': 'bird-alert.vercel.app' } })
    assert.match(html, /property="og:title" content="Big Day recap: 40 species"/)
    assert.match(html, /<link rel="canonical" href="https:\/\/bird-alert.vercel.app\/recap\/2n-abc123" \/>/)
    assert.equal((html.match(/og:title/g) || []).length, 1)
  } finally { global.fetch = realFetch; eventRecap.publicRecap = real }
})

test('a recap card is a 1200x630 picture, its words folded to what the bitmap font has', async () => {
  const { renderRecapCard, ascii, fitText } = require('../lib/shareCard')
  const { Jimp } = require('jimp')
  assert.equal(ascii('Día — Doña “Ana”'), 'Dia - Dona "Ana"')
  const jpeg = await renderRecapCard({ name: 'A very long Big Day name that keeps going and going past the edge of the card', eventKind: 'trip', area: 'Doña Ana County, NM', species: 192, lifers: 1, stops: 6, miles: null })
  const image = await Jimp.read(jpeg)
  assert.deepEqual([image.bitmap.width, image.bitmap.height], [1200, 630])
  assert.equal(typeof fitText, 'function')
})
