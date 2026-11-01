const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const i18n = require('../lib/i18n')
const en = require('../locales/en')

const lookup = (key) => key.split('.').reduce((node, part) => (node == null ? node : node[part]), en)

// Keys built at run time, which the scan below can't see.
const DYNAMIC = [
  ...['confirm', 'reminder', 'reset'].flatMap((kind) => [`mail.${kind}.body`, `mail.${kind}.ignore`, `mail.${kind}.subject`]),
  ...['photo', 'audio', 'video'].map((media) => `evidence.${media}`),
  ...['county', 'municipality', 'area'].map((word) => `places.${word}`)
]

const sources = () => {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  walk(path.join(__dirname, '..', 'lib'))
  walk(path.join(__dirname, '..', 'api'))
  return files
}

test('every key the code asks for exists in the English catalog', () => {
  const used = new Set(DYNAMIC)
  for (const file of sources()) {
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bt\([^,()]+, '([a-zA-Z.]+)'/g)) used.add(match[1])
    // The migration email's shorthand: m('key') is mail.migration.key.
    if (file.endsWith('mailer.js')) for (const match of text.matchAll(/\bm\('([a-zA-Z]+)'/g)) used.add(`mail.migration.${match[1]}`)
  }
  assert.ok(used.size > 60, `found ${used.size} keys`)
  const missing = [...used].filter((key) => lookup(key) === undefined)
  assert.deepEqual(missing, [])
})

test('t fills values, picks plurals, and falls back to English for a language or key it lacks', () => {
  assert.equal(i18n.t('en', 'push.watched', { bird: 'Painted Bunting' }), '⭐ Painted Bunting spotted nearby!')
  assert.equal(i18n.t('en', 'evidence.birders', { count: 1 }), '1 birder')
  assert.equal(i18n.t('en', 'evidence.birders', { count: 4 }), '4 birders')
  assert.equal(i18n.t('es-MX', 'push.nearby'), 'nearby', 'no Spanish catalog yet: English')
  assert.equal(i18n.t(null, 'push.nearby'), 'nearby')
  assert.equal(i18n.t('en', 'no.such.key'), 'no.such.key')
})

test('locales: only offered ones, in BCP-47, and eBird\'s own code for their bird names', () => {
  assert.equal(i18n.normalizeLocale('es_mx'), 'es-MX')
  assert.equal(i18n.normalizeLocale('FR-ca'), 'fr-CA')
  assert.equal(i18n.normalizeLocale('de'), null)
  assert.equal(i18n.normalizeLocale(''), null)
  assert.equal(i18n.ebirdLocale('es-MX'), 'es_MX')
  assert.equal(i18n.ebirdLocale('fr-CA'), 'fr_CA')
  assert.equal(i18n.ebirdLocale(null), 'en')
  assert.deepEqual(i18n.UI_LOCALES, ['en'])
})

test('dates and distances read the way they always have in English, and naturally in other languages', () => {
  assert.equal(i18n.formatObsDt('2026-10-22 12:50'), 'Oct 22, 12:50 PM')
  assert.equal(i18n.formatObsDt('2026-10-22 09:05', 'en'), 'Oct 22, 9:05 AM')
  assert.equal(i18n.formatObsDt('2026-10-22'), 'Oct 22')
  assert.equal(i18n.formatObsDt('not a date'), 'not a date')
  assert.notEqual(i18n.formatObsDt('2026-10-22 12:50', 'es-MX'), 'Oct 22, 12:50 PM')
  assert.equal(i18n.formatLongDate('2026-10-15'), 'October 15')
  assert.equal(i18n.formatDistance(12, 'mi', 'en'), '12 mi')
  assert.equal(i18n.formatDistance(12, 'km', 'en'), '19 km')
  assert.equal(i18n.unitForCountry('US'), 'mi')
  assert.equal(i18n.unitForCountry('CA'), 'km')
})

test('errors people see are translated by their English text; anything else passes through', () => {
  for (const [source, text] of Object.entries(en.errors)) assert.equal(source, text, 'English is its own source')
  assert.equal(i18n.translateError('fr-CA', 'Please log in'), 'Please log in', 'no French catalog yet')
  assert.equal(i18n.translateError('en', 'range_mi must be one of 0, 15, 30'), 'range_mi must be one of 0, 15, 30')
  assert.equal(i18n.requestLocale({ query: { locale: 'es-MX' } }), 'es-MX')
  assert.equal(i18n.requestLocale({ query: {}, headers: { 'x-locale': 'fr-CA' } }), 'fr-CA')
  assert.equal(i18n.requestLocale({ query: {}, headers: {} }), null)
})
