const en = require('../locales/en')

/**
 * The app's words, in the reader's language. Every user-facing line the server writes (pushes,
 * emails, the errors people see) comes from a catalog, keyed by name; English is the only catalog
 * so far, and any key or language without one falls back to English. Bird names are separate:
 * they come from eBird's own translations (lib/birdNames.js), so they localize even while the
 * rest of a language's catalog doesn't exist yet.
 *
 * A locale is BCP-47 ('en', 'es-MX', 'fr-CA'). One setting, users.locale, drives both the words
 * and the bird names.
 */
const CATALOGS = { en }

/** Languages with a catalog of the app's words. Others still get their bird names, in English text. */
const UI_LOCALES = Object.keys(CATALOGS)

/**
 * Locales a person can choose: the app's languages plus every language eBird names birds in that
 * we offer. BCP-47 here; eBird's own codes (es_MX, fr_CA) in NAME_LOCALES.
 */
const NAME_LOCALES = {
  en: { ebird: 'en', name: 'English' },
  'es-MX': { ebird: 'es_MX', name: 'Español (México)' },
  'fr-CA': { ebird: 'fr_CA', name: 'Français (Canada)' }
}
const SUPPORTED_LOCALES = Object.keys(NAME_LOCALES)

/** A locale we know, or null: 'es-mx' and 'es_MX' both become 'es-MX'. */
const normalizeLocale = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null
  const [lang, region] = value.trim().replace('_', '-').split('-')
  const tag = region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase()
  return SUPPORTED_LOCALES.includes(tag) ? tag : null
}

/** eBird's code for a locale's bird names ('en' when it has none of its own). */
const ebirdLocale = (locale) => NAME_LOCALES[normalizeLocale(locale) || 'en']?.ebird || 'en'

const catalogFor = (locale) => {
  const tag = normalizeLocale(locale) || 'en'
  return CATALOGS[tag] || CATALOGS[tag.split('-')[0]] || en
}

const lookup = (catalog, key) => key.split('.').reduce((node, part) => (node == null ? node : node[part]), catalog)

/** 'en' becomes 'en-US' for Intl, so dates and plurals read the way they always have. */
const intlLocale = (locale) => {
  const tag = normalizeLocale(locale) || 'en'
  return tag === 'en' ? 'en-US' : tag
}

// Some ICU versions put a narrow no-break space before AM/PM; pushes and emails read the same either way.
const plainSpaces = (text) => text.replace(/[\u202f\u00a0]/g, ' ')

const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])))

/**
 * The words for `key` in `locale`, with {vars} filled in. A key whose value is { one, other }
 * picks the plural form for vars.count. Missing in the locale: English. Missing in English too:
 * the key itself, which a test catches before it ever ships.
 */
const t = (locale, key, vars = {}) => {
  let value = lookup(catalogFor(locale), key)
  if (value === undefined) value = lookup(en, key)
  if (value === undefined) return key
  if (value && typeof value === 'object') {
    const form = new Intl.PluralRules(intlLocale(locale)).select(Number(vars.count ?? 0))
    value = value[form] ?? value.other
  }
  return fill(value, vars)
}

/**
 * A user-facing error message the code threw in English, in the reader's language. Errors are
 * keyed by their English text (catalog `errors`), so the code that throws them stays as it is.
 */
const translateError = (locale, message) => {
  const catalog = catalogFor(locale)
  return (catalog.errors && catalog.errors[message]) || message
}

const OBS_DT = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/

/**
 * eBird's obsDt ('YYYY-MM-DD HH:mm', the place's own clock), read naturally in the reader's
 * language: 'Oct 22, 12:50 PM' in English. Formatted as UTC so the wall time stays as reported.
 */
const formatObsDt = (obsDt, locale) => {
  const match = OBS_DT.exec(obsDt || '')
  if (!match) return obsDt || ''
  const [, year, month, day, hour, minute] = match
  const when = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour || 0), Number(minute || 0)))
  const tag = intlLocale(locale)
  const date = plainSpaces(new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(when))
  if (hour === undefined) return date
  const time = plainSpaces(new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(when))
  return t(locale, 'format.dateTime', { date, time })
}

/** A day ('YYYY-MM-DD…') as month and day in full: 'October 15'. */
const formatLongDate = (day, locale) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || '')
  if (!match) return ''
  const when = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return plainSpaces(new Intl.DateTimeFormat(intlLocale(locale), { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(when))
}

const formatNumber = (value, locale, options) => plainSpaces(new Intl.NumberFormat(intlLocale(locale), options).format(value))

/** Miles in the US, kilometres everywhere else (as the app shows them). */
const unitForCountry = (country) => (country === 'US' ? 'mi' : 'km')
const KM_PER_MILE = 1.609344

/** '12 mi' or '19 km', from a distance in miles. */
const formatDistance = (miles, unit, locale) => {
  const value = unit === 'km' ? Math.round(Number(miles) * KM_PER_MILE) : Math.round(Number(miles))
  return t(locale, unit === 'km' ? 'distance.km' : 'distance.mi', { n: formatNumber(value, locale) })
}

/** How to write to a person: their language, and miles in the US or kilometres elsewhere (by their area). */
const langFor = (user) => {
  const { countryOf } = require('./regions')
  return { locale: normalizeLocale(user?.locale), unit: unitForCountry(user?.state ? countryOf(user.state) : 'US') }
}

/** The locale a request asks for: ?locale=, else an X-Locale header (the app sends both ways). */
const requestLocale = (req) => normalizeLocale(req?.query?.locale) || normalizeLocale(req?.headers?.['x-locale']) || null

module.exports = {
  t, translateError, formatObsDt, formatLongDate, formatNumber, formatDistance, unitForCountry,
  normalizeLocale, ebirdLocale, intlLocale, requestLocale, langFor, SUPPORTED_LOCALES, UI_LOCALES, NAME_LOCALES, KM_PER_MILE, catalogs: CATALOGS
}
