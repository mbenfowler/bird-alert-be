const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pick, parseLength, licenseName, score } = require('../lib/sounds')

const rec = (over = {}) => ({ id: '1', file: 'https://xeno-canto.org/1/download', 'file-name': 'XC1.mp3', type: 'call', q: 'A', length: '0:15', cnt: 'United States', rec: 'Someone', lic: 'https://creativecommons.org/licenses/by-nc-sa/4.0/', ...over })

test('length parses m:ss and h:mm:ss', () => {
  assert.equal(parseLength('0:47'), 47)
  assert.equal(parseLength('1:02'), 62)
  assert.equal(parseLength('1:00:05'), 3605)
  assert.equal(parseLength(''), 0)
  assert.equal(parseLength('abc'), 0)
})

test('license name comes from the Creative Commons URL', () => {
  assert.equal(licenseName('https://creativecommons.org/licenses/by-nc-sa/4.0/'), 'CC BY-NC-SA 4.0')
  assert.equal(licenseName('https://creativecommons.org/licenses/by/4.0/'), 'CC BY 4.0')
  assert.equal(licenseName(null), 'CC')
})

test('a song beats a call, a short clean mp3 beats a long wav, and nearby beats far', () => {
  assert.ok(score(rec({ id: 's', type: 'song' })) > score(rec({ id: 'c', type: 'call' })))
  assert.ok(score(rec({ 'file-name': 'a.mp3', length: '0:15' })) > score(rec({ 'file-name': 'a.wav', length: '1:20' })))
  assert.ok(score(rec({ cnt: 'United States' })) > score(rec({ cnt: 'Sweden' })))
  assert.ok(score(rec({ q: 'A' })) > score(rec({ q: 'B' })))
})

test('pick returns the best usable recording and ignores unusable ones', () => {
  const best = pick([
    rec({ id: 'long', type: 'song', length: '3:00' }),
    rec({ id: 'tiny', type: 'song', length: '0:02' }),
    rec({ id: 'nofile', type: 'song', file: '' }),
    rec({ id: 'callus', type: 'call', cnt: 'United States' }),
    rec({ id: 'songfar', type: 'song', cnt: 'Sweden', 'file-name': 'x.wav' }),
    rec({ id: 'songus', type: 'song', cnt: 'United States' })
  ])
  assert.equal(best.id, 'songus')
  assert.equal(pick([]), null)
  assert.equal(pick([rec({ length: '0:01' })]), null)
})
