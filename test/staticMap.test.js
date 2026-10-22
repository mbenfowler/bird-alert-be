const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Jimp, JimpMime } = require('jimp')
const { renderMap, fitZoom, mergePins } = require('../lib/staticMap')

test('fitZoom picks the closest zoom that keeps every pin inside the frame', () => {
  const close = [{ lat: 34.2695, lng: -83.9014 }, { lat: 34.2700, lng: -83.9000 }]
  const spread = [{ lat: 34.2695, lng: -83.9014 }, { lat: 34.40, lng: -83.70 }]
  assert.equal(fitZoom(close, 640, 360), 15)
  const z = fitZoom(spread, 640, 360)
  assert.ok(z < 15 && z >= 3, `zoomed out to ${z}`)
  assert.equal(fitZoom([{ lat: 10, lng: 10 }, { lat: -10, lng: -170 }], 640, 360), 3, 'never below the floor')
})

test('pins that would overlap on screen merge into one pin whose label lists them', () => {
  const pins = [{ lat: 34.2695, lng: -83.9014, label: '1' }, { lat: 34.2696, lng: -83.9013, label: '2' }, { lat: 34.3, lng: -83.8, label: '3' }]
  assert.deepEqual(mergePins(pins, 13).map((p) => p.label), ['1,2', '3'], 'a street apart at zoom 13 is one pin')
  assert.deepEqual(mergePins(pins, 18).map((p) => p.label), ['1', '2', '3'], 'zoomed right in they separate')
})

test('a multi-pin map renders as a JPEG of the requested size with the tiles it needs', async () => {
  const tile = await new Jimp({ width: 256, height: 256, color: 0xddeeffff }).getBuffer(JimpMime.png)
  const asked = []
  const originalFetch = global.fetch
  global.fetch = async (url) => { asked.push(url); return { ok: true, arrayBuffer: async () => tile.buffer.slice(tile.byteOffset, tile.byteOffset + tile.byteLength) } }
  try {
    const jpeg = await renderMap({ pins: [{ lat: 34.2695, lng: -83.9014, label: '1' }, { lat: 34.31, lng: -83.81, label: '2' }], width: 320, height: 200 })
    const image = await Jimp.read(jpeg)
    assert.equal(image.bitmap.width, 320)
    assert.equal(image.bitmap.height, 200)
    assert.ok(asked.length >= 2 && asked.every((u) => /tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png/.test(u)))
    // A pin's red is somewhere on the canvas.
    let red = 0
    image.scan(0, 0, 320, 200, (x, y, idx) => { const [r, g, b] = [image.bitmap.data[idx], image.bitmap.data[idx + 1], image.bitmap.data[idx + 2]]; if (r > 180 && g < 90 && b < 90) red += 1 })
    assert.ok(red > 200, `pins drawn (${red} red pixels)`)
  } finally {
    global.fetch = originalFetch
  }
})
