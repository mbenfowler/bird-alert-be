const db = require('./db')

/**
 * ABA Checklist codes (with the ABA's permission; credit "ABA Checklist" wherever a code shows).
 * Looked up by scientific name, then by English name for the few the eBird and AOS taxonomies
 * spell differently. A species not on the list has no code.
 */
const CODE_WORDS = { 1: 'regular', 2: 'regular', 3: 'rare', 4: 'casual', 5: 'accidental', 6: 'extinct or extirpated' }
/** HQ desk score added for national rarity; codes 1-2 add nothing, so a state rarity still ranks on its chase. */
const CODE_BONUS = { 3: 4, 4: 7, 5: 10 }

/** Pure: the checklist CSV's rows to { sciName, comName, code }, skipping family headers and notes. */
const parseChecklist = (rows) => {
  const out = []
  for (const r of rows) {
    const [, english, , sci, , code] = r
    if (!sci || !/^[1-6]$/.test(String(code || '').trim())) continue
    // "Erckel's Spurfowl (Francolin)": the AOS name in parentheses; "(extinct, 1858)" and the like are notes.
    const comName = String(english).replace(/\s*\([^)]*\)\s*$/, '').trim()
    out.push({ sciName: String(sci).trim(), comName, code: Number(String(code).trim()) })
  }
  return out
}

let cache = null
const CACHE_MS = 60 * 60 * 1000
/** Every code, by scientific name and by English name (lowercased), held an hour. */
const allCodes = async () => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache
  const rows = await db('aba_codes').select('sci_name', 'com_name', 'code').catch(() => [])
  cache = { at: Date.now(), bySci: new Map(rows.map((r) => [r.sci_name, r.code])), byName: new Map(rows.map((r) => [r.com_name.toLowerCase(), r.code])) }
  return cache
}

/** The code for a species, or null. */
const abaCode = (codes, { sciName, comName }) => codes.bySci.get(sciName) ?? codes.byName.get(String(comName || '').toLowerCase()) ?? null

module.exports = { parseChecklist, allCodes, abaCode, CODE_WORDS, CODE_BONUS }
