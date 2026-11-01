const db = require('./db')
const ebird = require('./ebird')
const { ebirdLocale } = require('./i18n')

/**
 * Bird names in the reader's language, from eBird's own translations. A language is fetched
 * whole (one call, about 18,600 names) the first time someone needs it, kept in taxonomy_names,
 * and refreshed after a month; each server instance also keeps it in memory for the hour. English
 * needs nothing: eBird's feeds already speak it.
 */
const REFRESH_DAYS = 30
const MEMORY_MS = 60 * 60 * 1000
const CHUNK = 2000

const memory = new Map()
const filling = new Map()

const fill = async (code) => {
  const taxa = await ebird.fullTaxonomy(code)
  const rows = taxa.filter((x) => x.speciesCode && x.comName).map((x) => ({ locale: code, species_code: x.speciesCode, com_name: x.comName, fetched_at: new Date() }))
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db('taxonomy_names').insert(rows.slice(i, i + CHUNK)).onConflict(['locale', 'species_code']).merge(['com_name', 'fetched_at'])
  }
  return new Map(rows.map((r) => [r.species_code, r.com_name]))
}

const load = async (code) => {
  const stale = await db('taxonomy_names').where({ locale: code }).min('fetched_at as oldest').count('* as n').first()
  const fresh = Number(stale?.n) > 0 && Date.now() - new Date(stale.oldest).getTime() < REFRESH_DAYS * 86_400_000
  if (fresh) {
    const rows = await db('taxonomy_names').where({ locale: code }).select('species_code', 'com_name')
    return new Map(rows.map((r) => [r.species_code, r.com_name]))
  }
  try {
    return await fill(code)
  } catch (error) {
    // eBird unreachable: last month's names beat English, and English beats nothing.
    console.error(`Bird names for ${code} couldn't be refreshed:`, error.message)
    const rows = await db('taxonomy_names').where({ locale: code }).select('species_code', 'com_name')
    return new Map(rows.map((r) => [r.species_code, r.com_name]))
  }
}

/** speciesCode -> common name in the locale; null for English (no translation needed). */
const namesFor = async (locale) => {
  const code = ebirdLocale(locale)
  if (code === 'en') return null
  const held = memory.get(code)
  if (held && Date.now() - held.at < MEMORY_MS) return held.names
  if (!filling.has(code)) {
    filling.set(code, load(code).then((names) => {
      memory.set(code, { names, at: Date.now() })
      return names
    }).finally(() => filling.delete(code)))
  }
  return filling.get(code)
}

/**
 * Every bird in `data` (any depth: lists, places with birds, a single sighting) named in the
 * locale: comName becomes the translated name and comNameEn keeps eBird's English. Untouched for
 * English, and for a bird eBird hasn't translated.
 */
const localize = async (data, locale) => {
  const names = await namesFor(locale).catch((error) => {
    console.error('Bird names unavailable:', error.message)
    return null
  })
  if (!names || !names.size) return data
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object' || value instanceof Date) return value
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = walk(item)
    if (typeof value.speciesCode === 'string' && typeof value.comName === 'string') {
      const name = names.get(value.speciesCode)
      if (name && name !== value.comName) {
        out.comName = name
        out.comNameEn = value.comName
      }
    }
    return out
  }
  return walk(data)
}

/**
 * A function that names one sighting in the locale (a copy, comName translated, comNameEn kept),
 * for the per-person loops that write pushes and emails. Identity for English, or when names
 * can't be had.
 */
const inLanguage = async (locale) => {
  const names = await namesFor(locale).catch((error) => {
    console.error('Bird names unavailable:', error.message)
    return null
  })
  if (!names || !names.size) return (obs) => obs
  return (obs) => {
    const name = obs && names.get(obs.speciesCode)
    return name && name !== obs.comName ? { ...obs, comName: name, comNameEn: obs.comName } : obs
  }
}

/** For tests: forget what's held in memory. */
const forget = () => memory.clear()

module.exports = { namesFor, localize, inLanguage, forget }
