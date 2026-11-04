const { countryOf, subnational1 } = require('./regions')

/**
 * The time zone of a place on the map, from its area (the kept state and eBird county code) and,
 * where a state is split between zones, its spot (lat/lng) when one is known. An event's day (is it
 * on, is it over, is the tally still open) is judged in its own zone, not each member's: a group
 * birding in Arizona all lose the day at midnight in Phoenix, wherever their accounts say they live.
 * Null when the area alone can't say (a country spanning zones, with no rule here): callers then
 * fall back to the person's own zone, as before.
 */

// One zone for most of each US state; the splits are handled below.
const US = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico'
}

// Counties on the other side of their state's zone line, by eBird code.
const COUNTIES = {
  'US-TX-141': 'America/Denver', 'US-TX-229': 'America/Denver', // El Paso, Hudspeth
  'US-OR-045': 'America/Boise', // Malheur
  'US-KS-071': 'America/Denver', 'US-KS-075': 'America/Denver', 'US-KS-181': 'America/Denver', 'US-KS-199': 'America/Denver',
  // The Florida panhandle west of the Apalachicola.
  ...Object.fromEntries(['033', '113', '091', '131', '059', '133', '005', '063', '013', '045'].map((c) => [`US-FL-${c}`, 'America/Chicago'])),
  // The Idaho panhandle.
  ...Object.fromEntries(['009', '017', '021', '035', '049', '055', '057', '061', '069', '079'].map((c) => [`US-ID-${c}`, 'America/Los_Angeles']))
}

// Where only the spot can say: west of `lng` is `west`, else the state's own zone.
const BY_LNG = {
  KY: { lng: -86.0, west: 'America/Chicago' },
  TN: { lng: -85.0, east: 'America/New_York' },
  NE: { lng: -101.3, west: 'America/Denver' },
  SD: { lng: -100.6, west: 'America/Denver' },
  ND: { lng: -101.0, west: 'America/Denver' },
  AK: { lng: -169.0, west: 'America/Adak' },
  ON: { lng: -90.0, west: 'America/Winnipeg' }
}

const CA = {
  AB: 'America/Edmonton', BC: 'America/Vancouver', MB: 'America/Winnipeg', NB: 'America/Moncton', NL: 'America/St_Johns',
  NS: 'America/Halifax', NT: 'America/Yellowknife', NU: 'America/Iqaluit', ON: 'America/Toronto', PE: 'America/Halifax',
  QC: 'America/Toronto', SK: 'America/Regina', YT: 'America/Whitehorse'
}

const MX = {
  BCN: 'America/Tijuana', BCS: 'America/Mazatlan', SON: 'America/Hermosillo', SIN: 'America/Mazatlan', NAY: 'America/Mazatlan',
  CHH: 'America/Chihuahua', ROO: 'America/Cancun', COA: 'America/Monterrey', NLE: 'America/Monterrey', TAM: 'America/Monterrey'
}

// eBird provinces with their own zone, in countries that have more than one.
const PROVINCES = {
  'AU-NSW': 'Australia/Sydney', 'AU-ACT': 'Australia/Sydney', 'AU-VIC': 'Australia/Melbourne', 'AU-QLD': 'Australia/Brisbane',
  'AU-SA': 'Australia/Adelaide', 'AU-WA': 'Australia/Perth', 'AU-TAS': 'Australia/Hobart', 'AU-NT': 'Australia/Darwin'
}

// Countries in one zone (or near enough for a day's birding).
const COUNTRIES = {
  ZA: 'Africa/Johannesburg', GB: 'Europe/London', IE: 'Europe/Dublin', FR: 'Europe/Paris', DE: 'Europe/Berlin', ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon', IT: 'Europe/Rome', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich', AT: 'Europe/Vienna',
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', DK: 'Europe/Copenhagen', FI: 'Europe/Helsinki', PL: 'Europe/Warsaw', GR: 'Europe/Athens',
  IS: 'Atlantic/Reykjavik', CR: 'America/Costa_Rica', PA: 'America/Panama', GT: 'America/Guatemala', BZ: 'America/Belize',
  CO: 'America/Bogota', EC: 'America/Guayaquil', PE: 'America/Lima', CL: 'America/Santiago', AR: 'America/Argentina/Buenos_Aires',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', IN: 'Asia/Kolkata', NZ: 'Pacific/Auckland', KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam',
  UG: 'Africa/Kampala', NA: 'Africa/Windhoek', BW: 'Africa/Gaborone', IL: 'Asia/Jerusalem', TH: 'Asia/Bangkok', SG: 'Asia/Singapore',
  PH: 'Asia/Manila', TW: 'Asia/Taipei', CN: 'Asia/Shanghai'
}

/** The zone for an area and spot: { state, location, home_lat?, home_lng? } (an event or a place), or null. */
const zoneForArea = ({ state, location, home_lat: lat = null, home_lng: lng = null } = {}) => {
  const s = String(state || '').toUpperCase()
  if (!s) return null
  if (COUNTIES[location]) return COUNTIES[location]
  const country = countryOf(s)
  const own = country === 'US' ? US[s] : country === 'CA' ? CA[s] : country === 'MX' ? (MX[s] || 'America/Mexico_City') : (PROVINCES[subnational1(s)] || COUNTRIES[country] || null)
  const split = (country === 'US' || country === 'CA') ? BY_LNG[s] : null
  if (own && split && Number.isFinite(lng) && lat !== null) {
    if (split.west && lng < split.lng) return split.west
    if (split.east && lng > split.lng) return split.east
  }
  return own || null
}

/** The zone an event's days are judged in: its own (stored, else from its area), else the person's, else UTC. */
const eventZone = (event, fallback = null) => event?.timezone || zoneForArea(event || {}) || fallback || 'UTC'

/** Minutes `zone` is ahead of UTC at the instant `ms` (an unknown zone: 0, as UTC). */
const offsetAt = (ms, zone) => {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
    return (Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(ms / 1000) * 1000) / 60_000
  } catch {
    return 0
  }
}

/**
 * Pure: the instant a wall-clock time ('YYYY-MM-DD', hour) is in `zone`, as a Date. Checked a second
 * time at the answer, so a day the clocks change still lands on the right hour.
 */
const wallTime = (day, hour, zone) => {
  const wall = Date.parse(`${day}T00:00:00Z`) + hour * 3_600_000
  const first = wall - offsetAt(wall, zone) * 60_000
  return new Date(wall - offsetAt(first, zone) * 60_000)
}

module.exports = { zoneForArea, eventZone, wallTime, offsetAt, ZONES: { US, CA, MX, PROVINCES, COUNTRIES, COUNTIES, BY_LNG } }
