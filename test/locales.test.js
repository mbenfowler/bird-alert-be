const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const en = require('../locales/en')

/**
 * Every translation has every English key, and no others, with the same {values} and HTML tags.
 * English added after a translation was made fails here by name, ready to translate. A plural is
 * a leaf ({ one, other }); a language may add the forms its own plural rules have (many).
 */
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])
const isPlural = (node) => node && typeof node === 'object' && Object.keys(node).length > 0 && Object.keys(node).every((k) => PLURAL_FORMS.has(k))

const flatten = (node, prefix = '', out = {}) => {
  for (const [key, value] of Object.entries(node)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string' || isPlural(value)) out[name] = value
    else flatten(value, name, out)
  }
  return out
}

const dir = path.join(__dirname, '..', 'locales')
const languages = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== 'en.js').map((f) => f.replace(/\.js$/, ''))
const english = flatten(en)
const texts = (value) => (typeof value === 'string' ? [value] : Object.values(value))
const vars = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort()
const tags = (text) => [...text.matchAll(/<\/?([a-z]+)\b/gi)].map((m) => m[0].toLowerCase()).sort()

test('the translations are the ones the app offers', () => {
  assert.deepEqual(languages.sort(), ['es-MX', 'fr-CA'])
})

for (const lang of languages) {
  const words = flatten(require(path.join(dir, `${lang}.js`)))

  test(`${lang} has every English key (any listed are new in English and need translating)`, () => {
    const missing = Object.keys(english).filter((key) => !(key in words))
    assert.deepEqual(missing, [], `${lang} is missing ${missing.length} key(s)`)
  })

  test(`${lang} has no keys English lacks`, () => {
    assert.deepEqual(Object.keys(words).filter((key) => !(key in english)), [])
  })

  test(`${lang} keeps every {value} and tag, and every plural form English has`, () => {
    const wrong = []
    for (const [key, value] of Object.entries(words)) {
      const from = english[key]
      if (from === undefined) continue
      if (typeof from !== typeof value) { wrong.push(`${key}: plural in one, not the other`); continue }
      if (typeof from === 'object') {
        const forms = Object.keys(from).filter((form) => !(form in value))
        if (forms.length) wrong.push(`${key}: no ${forms.join(', ')}`)
      }
      const want = vars(texts(from).join(' '))
      for (const [form, text] of typeof value === 'string' ? [['', value]] : Object.entries(value)) {
        const source = typeof from === 'string' ? from : from[form] ?? from.other
        // A one form may write the number out where English shows {count}.
        const have = vars(text)
        const ok = form === 'one'
          ? have.every((v) => want.includes(v)) && vars(source).filter((v) => v !== 'count').every((v) => have.includes(v))
          : JSON.stringify(have) === JSON.stringify(vars(source))
        if (!ok || JSON.stringify(tags(text)) !== JSON.stringify(tags(source))) wrong.push(`${key}${form ? `.${form}` : ''}: ${JSON.stringify(text)}`)
      }
    }
    assert.deepEqual(wrong, [])
  })

  test(`${lang} errors are keyed by the English the code throws`, () => {
    const catalog = require(path.join(dir, `${lang}.js`))
    assert.deepEqual(Object.keys(catalog.errors).sort(), Object.keys(en.errors).sort())
  })

  test(`${lang} share card stays plain ASCII (the card's bitmap font has nothing else)`, () => {
    const catalog = require(path.join(dir, `${lang}.js`))
    for (const text of Object.values(catalog.card)) assert.match(text, /^[\x20-\x7e\u00b7]*$/, text)
  })
}
