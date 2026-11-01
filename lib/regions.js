/**
 * The countries the app covers. Users keep a state or province code ('GA', 'ON', 'JAL', 'ZA-WC')
 * and an eBird region code for their county or its equivalent: a census division in Canada, a
 * municipality in Mexico or South Africa ('US-GA-139', 'CA-ON-TO', 'MX-JAL-039', 'ZA-WC-21'). US and
 * Canadian codes are two letters and none is shared; Mexican ones are three, so the code alone says
 * the country. South Africa's provinces are two letters that clash (NL is Newfoundland and
 * KwaZulu-Natal, NC North Carolina and the Northern Cape), so they keep eBird's country prefix.
 */
const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])

// eBird's codes for Mexico's 32 states; Mexico City is DIF, not the newer ISO code CMX.
const MX_STATES = new Set(['AGU', 'BCN', 'BCS', 'CAM', 'CHP', 'CHH', 'DIF', 'COA', 'COL', 'DUR', 'MEX', 'GUA', 'GRO', 'HID', 'JAL', 'MIC',
  'MOR', 'NAY', 'NLE', 'OAX', 'PUE', 'QUE', 'ROO', 'SLP', 'SIN', 'SON', 'TAB', 'TAM', 'TLA', 'VER', 'YUC', 'ZAC'])

// eBird's codes for South Africa's nine provinces (KwaZulu-Natal is NL), kept as 'ZA-WC' and so on.
const ZA_PROVINCES = new Set(['EC', 'FS', 'GT', 'NL', 'LP', 'MP', 'NW', 'NC', 'WC'])
const isZaProvince = (s) => /^ZA-[A-Z]{2}$/.test(s) && ZA_PROVINCES.has(s.slice(3))

/** Every country the app covers, as eBird codes them. A new country goes here first. */
const COUNTRIES = ['US', 'CA', 'MX', 'ZA']

/** 'CA' for a Canadian province or territory, 'MX' for a Mexican state, 'ZA' for a South African province, else 'US'. */
const countryOf = (state) => {
  const s = String(state || '').toUpperCase()
  return isZaProvince(s) ? 'ZA' : PROVINCES.has(s) ? 'CA' : MX_STATES.has(s) ? 'MX' : 'US'
}

/** eBird's code for a state or province: 'GA' -> 'US-GA', 'ON' -> 'CA-ON', 'JAL' -> 'MX-JAL'; 'ZA-WC' already is one. */
const subnational1 = (state) => {
  const s = String(state || '').toUpperCase()
  return isZaProvince(s) ? s : `${countryOf(s)}-${s}`
}

/** A county-level region in any of them: 'US-GA-139', 'CA-ON-TO', 'MX-JAL-039' or 'ZA-WC-21'. Captures the state. */
const COUNTY_REGION = /^(?:US-([A-Z]{2})-\d{3}|CA-([A-Z]{2})-[A-Z0-9]{1,5}|MX-([A-Z]{3})-\d{3}|ZA-([A-Z]{2})-\d{2})$/

/** The state or province of a county-level region code, or null when it isn't one. */
const stateOfRegion = (region) => {
  const m = COUNTY_REGION.exec(String(region || ''))
  if (!m) return null
  if (m[2]) return PROVINCES.has(m[2]) ? m[2] : null
  if (m[3]) return MX_STATES.has(m[3]) ? m[3] : null
  if (m[4]) return ZA_PROVINCES.has(m[4]) ? `ZA-${m[4]}` : null
  return m[1]
}

/** The word for a county in that state's country, for prose: county, area or municipality. */
const countyWord = (state) => ({ US: 'county', CA: 'area', MX: 'municipality', ZA: 'municipality' })[countryOf(state)]

module.exports = { COUNTRIES, PROVINCES, MX_STATES, ZA_PROVINCES, countryOf, subnational1, COUNTY_REGION, stateOfRegion, countyWord }
