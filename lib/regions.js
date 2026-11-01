/**
 * Where people bird. Users keep a state or province code and an eBird region code for their county
 * or its equivalent. The US, Canada and Mexico came first and keep bare state codes ('GA', 'ON',
 * 'JAL'): US and Canadian codes are two letters and none is shared, Mexican ones are three, so the
 * code alone says the country. Every other country keeps eBird's full code for its province, with
 * the country in front ('ZA-WC', 'GB-ENG'), since bare codes would clash (NL is Newfoundland and
 * KwaZulu-Natal). The county is eBird's subnational2 region ('US-GA-139', 'CA-ON-TO', 'MX-JAL-039',
 * 'ZA-WC-21', 'GB-ENG-LND'); where eBird has none for a province, the province itself is the area
 * ('AU-ACT', 'CR-A'). The lists themselves come from eBird (lib/areas.js), so any country it
 * covers works without a change here.
 */
const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])

// eBird's codes for Mexico's 32 states; Mexico City is DIF, not the newer ISO code CMX.
const MX_STATES = new Set(['AGU', 'BCN', 'BCS', 'CAM', 'CHP', 'CHH', 'DIF', 'COA', 'COL', 'DUR', 'MEX', 'GUA', 'GRO', 'HID', 'JAL', 'MIC',
  'MOR', 'NAY', 'NLE', 'OAX', 'PUE', 'QUE', 'ROO', 'SLP', 'SIN', 'SON', 'TAB', 'TAM', 'TLA', 'VER', 'YUC', 'ZAC'])

// eBird's codes for South Africa's nine provinces (KwaZulu-Natal is NL), kept as 'ZA-WC' and so on.
const ZA_PROVINCES = new Set(['EC', 'FS', 'GT', 'NL', 'LP', 'MP', 'NW', 'NC', 'WC'])

/** The countries the HQ desk scans each morning for rarities. People can bird anywhere eBird covers. */
const COUNTRIES = ['US', 'CA', 'MX', 'ZA']

/** The countries whose states are kept bare ('GA', 'ON', 'JAL'); every other keeps eBird's full code. */
const BARE = new Set(['US', 'CA', 'MX'])

/** eBird's code for a province or state, country first: 'GB-ENG', 'ZA-WC', 'AU-NSW', 'JP-23', 'AR-B'. */
const SUBNATIONAL1 = /^[A-Z]{2}-[A-Z0-9]{1,3}$/

/** The country of a kept state code: 'CA' for 'ON', 'MX' for 'JAL', 'ZA' for 'ZA-WC', 'GB' for 'GB-ENG', else 'US'. */
const countryOf = (state) => {
  const s = String(state || '').toUpperCase()
  return SUBNATIONAL1.test(s) ? s.slice(0, 2) : PROVINCES.has(s) ? 'CA' : MX_STATES.has(s) ? 'MX' : 'US'
}

/** eBird's code for a kept state: 'GA' -> 'US-GA', 'ON' -> 'CA-ON', 'JAL' -> 'MX-JAL'; 'ZA-WC' and 'GB-ENG' already are. */
const subnational1 = (state) => {
  const s = String(state || '').toUpperCase()
  return SUBNATIONAL1.test(s) ? s : `${countryOf(s)}-${s}`
}

/** The state code kept for an eBird province code: bare for the US, Canada and Mexico ('US-GA' -> 'GA'), else as is. */
const keptState = (code) => {
  const c = String(code || '').toUpperCase()
  return BARE.has(c.slice(0, 2)) ? c.slice(3) : c
}

/**
 * A county-level region: 'US-GA-139', 'CA-ON-TO', 'MX-JAL-039', 'ZA-WC-21', or any other country's
 * eBird subnational2 ('GB-ENG-LND', 'BR-AC-001', 'DE-BW-UL2'), or a province standing in for one
 * where eBird has no counties ('AU-ACT'). A US, Canadian, Mexican or South African province alone is
 * never a county. Captures the state.
 */
const COUNTY_REGION = /^(?:US-([A-Z]{2})-\d{3}|CA-([A-Z]{2})-[A-Z0-9]{1,5}|MX-([A-Z]{3})-\d{3}|ZA-([A-Z]{2})-\d{2}|(?!(?:US|CA|MX|ZA)-)([A-Z]{2})-([A-Z0-9]{1,3})(?:-[A-Z0-9]{1,5})?)$/

/** The kept state of a county-level region code, or null when it isn't one. */
const stateOfRegion = (region) => {
  const m = COUNTY_REGION.exec(String(region || ''))
  if (!m) return null
  if (m[2]) return PROVINCES.has(m[2]) ? m[2] : null
  if (m[3]) return MX_STATES.has(m[3]) ? m[3] : null
  if (m[4]) return ZA_PROVINCES.has(m[4]) ? `ZA-${m[4]}` : null
  if (m[5]) return `${m[5]}-${m[6]}`
  return m[1]
}

// The word people use for the area, where it isn't "area".
const COUNTY_WORDS = { US: 'county', MX: 'municipality', ZA: 'municipality', GB: 'county', IE: 'county' }

/** The word for a county in that state's country, for prose: county, municipality, or area. */
const countyWord = (state) => COUNTY_WORDS[countryOf(state)] || 'area'

module.exports = { COUNTRIES, BARE, PROVINCES, MX_STATES, ZA_PROVINCES, SUBNATIONAL1, countryOf, subnational1, keptState, COUNTY_REGION, stateOfRegion, countyWord }
