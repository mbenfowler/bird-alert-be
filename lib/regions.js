/**
 * The two countries the app covers. Users keep a two-letter state or province ('GA', 'ON') and an
 * eBird region code for their county or, in Canada, census division ('US-GA-139', 'CA-ON-TO').
 * No province code is also a state code, so the two letters say which country they mean.
 */
const PROVINCES = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'])

/** 'CA' for a Canadian province or territory, else 'US'. */
const countryOf = (state) => (PROVINCES.has(String(state || '').toUpperCase()) ? 'CA' : 'US')

/** eBird's code for a state or province: 'GA' -> 'US-GA', 'ON' -> 'CA-ON'. */
const subnational1 = (state) => {
  const s = String(state || '').toUpperCase()
  return `${countryOf(s)}-${s}`
}

/** A county-level region in either country: 'US-GA-139' or 'CA-ON-TO'. Captures the state. */
const COUNTY_REGION = /^(?:US-([A-Z]{2})-\d{3}|CA-([A-Z]{2})-[A-Z0-9]{1,5})$/

/** The state or province of a county-level region code, or null when it isn't one. */
const stateOfRegion = (region) => {
  const m = COUNTY_REGION.exec(String(region || ''))
  if (!m) return null
  const state = m[1] || m[2]
  return m[2] && !PROVINCES.has(state) ? null : state
}

module.exports = { PROVINCES, countryOf, subnational1, COUNTY_REGION, stateOfRegion }
