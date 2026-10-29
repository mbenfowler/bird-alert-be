/**
 * The three countries the app covers. Users keep a state or province code ('GA', 'ON', 'JAL') and
 * an eBird region code for their county or its equivalent: a census division in Canada, a
 * municipality in Mexico ('US-GA-139', 'CA-ON-TO', 'MX-JAL-039'). US and Canadian codes are two
 * letters and none is shared; Mexican ones are three, so the code alone says the country.
 */
const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])

// eBird's codes for Mexico's 32 states; Mexico City is DIF, not the newer ISO code CMX.
const MX_STATES = new Set(['AGU', 'BCN', 'BCS', 'CAM', 'CHP', 'CHH', 'DIF', 'COA', 'COL', 'DUR', 'MEX', 'GUA', 'GRO', 'HID', 'JAL', 'MIC',
  'MOR', 'NAY', 'NLE', 'OAX', 'PUE', 'QUE', 'ROO', 'SLP', 'SIN', 'SON', 'TAB', 'TAM', 'TLA', 'VER', 'YUC', 'ZAC'])

/** Every country the app covers, as eBird codes them. A new country goes here first. */
const COUNTRIES = ['US', 'CA', 'MX']

/** 'CA' for a Canadian province or territory, 'MX' for a Mexican state, else 'US'. */
const countryOf = (state) => {
  const s = String(state || '').toUpperCase()
  return PROVINCES.has(s) ? 'CA' : MX_STATES.has(s) ? 'MX' : 'US'
}

/** eBird's code for a state or province: 'GA' -> 'US-GA', 'ON' -> 'CA-ON', 'JAL' -> 'MX-JAL'. */
const subnational1 = (state) => {
  const s = String(state || '').toUpperCase()
  return `${countryOf(s)}-${s}`
}

/** A county-level region in any of the three: 'US-GA-139', 'CA-ON-TO' or 'MX-JAL-039'. Captures the state. */
const COUNTY_REGION = /^(?:US-([A-Z]{2})-\d{3}|CA-([A-Z]{2})-[A-Z0-9]{1,5}|MX-([A-Z]{3})-\d{3})$/

/** The state or province of a county-level region code, or null when it isn't one. */
const stateOfRegion = (region) => {
  const m = COUNTY_REGION.exec(String(region || ''))
  if (!m) return null
  if (m[2]) return PROVINCES.has(m[2]) ? m[2] : null
  if (m[3]) return MX_STATES.has(m[3]) ? m[3] : null
  return m[1]
}

/** The word for a county in that state's country, for prose: county, area or municipality. */
const countyWord = (state) => ({ US: 'county', CA: 'area', MX: 'municipality' })[countryOf(state)]

module.exports = { COUNTRIES, PROVINCES, MX_STATES, countryOf, subnational1, COUNTY_REGION, stateOfRegion, countyWord }
