const db = require('./db')

/**
 * ABA Checklist codes (with the ABA's permission; credit "ABA Checklist" wherever a code shows).
 * Looked up by scientific name, then by English name for the few the eBird and AOS taxonomies
 * spell differently. A species not on the list has no code.
 */
// Plain words, not the ABA's own labels (Rare, Casual, Accidental): read cold, "casual" sounds
// commoner than "rare" when it's the rarer of the two.
const CODE_WORDS = { 1: 'regular', 2: 'regular', 3: 'a few each year', 4: 'not every year', 5: 'a few records ever', 6: 'extinct or extirpated' }
/**
 * HQ desk score added for national rarity. A county oddity with a modest crowd (a Downy Woodpecker
 * notable in Arizona) scores about 13-15 on the chase alone, and a Code 3 on two unreviewed
 * checklists about 7 (3 for the chase, 4 for being notable in one state). So 8 lifts a Code 3 past a
 * Code 1-2 bird with a similar chase, and the 2 off codes 1-2 settles the close ones; a Code 1 that a
 * whole state is chasing can still lead a quiet Code 3. Codes 4 and 5 add more.
 */
const CODE_BONUS = { 1: -2, 2: -2, 3: 8, 4: 12, 5: 16 }

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

/** Codes the app shows: 3 (a few each year), 4 (not every year), 5 (a few records ever). 1-2 just mean regular, and 6 can't be seen. */
const isShown = (code) => code >= 3 && code <= 5

/**
 * Each item (with sciName and comName) plus its `aba` code, or null; the list as given if the codes can't be read.
 * The ABA Area is the US and Canada, so in a Mexican region every code is null: a bird the ABA calls
 * rare may be common there.
 */
const withAba = async (items, { region } = {}) => {
  if (!Array.isArray(items) || !items.length) return items
  if (/^MX(-|$)/.test(String(region || ''))) return items.map((item) => ({ ...item, aba: null }))
  const codes = await allCodes()
  return items.map((item) => ({ ...item, aba: abaCode(codes, item) }))
}

/** Pure: the shown codes first, rarest first; otherwise the order is kept. */
const rarestFirst = (items) => items.map((item, i) => [item, i]).sort(([a, i], [b, j]) => (isShown(b.aba) ? b.aba : 0) - (isShown(a.aba) ? a.aba : 0) || i - j).map(([item]) => item)

module.exports = { parseChecklist, allCodes, abaCode, withAba, rarestFirst, isShown, CODE_WORDS, CODE_BONUS }
