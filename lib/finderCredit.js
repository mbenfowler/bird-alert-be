const ebird = require('./ebird')
const { metresBetween } = require('./hotspots')
const { addDays } = require('./seasonality')

/**
 * Credit for whoever found a rarity, for the HQ desk's drafts (Matt posts them himself; names are
 * never put on public pages, cards, pushes or the API). The desk sees only a day or two of reports,
 * where the first name is often a chaser's, so the finder is looked up in the state's last 30 days of
 * notable reports: the earliest report of the bird at that place. A first report on the very edge of
 * those 30 days may not be the first at all (the bird has been there longer than we can see), so it
 * says "reported by" rather than "found by" (the wording is megaPost's creditText).
 */
const LOOKBACK_DAYS = 30
const NEAR_M = 1000
const PARALLEL = 3

// eBird's checklist ids grow with time: "S9" was filed before "S10".
const bySubId = (a, b) => String(a).length - String(b).length || String(a).localeCompare(String(b))

const atPlace = (pick) => (o) => o.speciesCode === pick.speciesCode &&
  ((pick.place.locId && o.locId === pick.place.locId) ||
    (Number.isFinite(pick.place.lat) && Number.isFinite(o.lat) && metresBetween(pick.place, o) <= NEAR_M))

/**
 * Pure: who first reported the pick's bird at its place in `records` (a state's notable reports),
 * and how many others reported it there. Null when the records hold no report of it there.
 */
const firstReport = (records, pick, asOf) => {
  const here = records.filter(atPlace(pick))
  if (!here.length) return null
  const first = [...here].sort((a, b) => String(a.obsDt).localeCompare(String(b.obsDt)) || bySubId(a.subId, b.subId))[0]
  const names = new Set(here.map((o) => o.userDisplayName).filter(Boolean))
  const name = first.userDisplayName || null
  const firstDay = String(first.obsDt).slice(0, 10)
  return {
    name,
    others: Math.max(0, names.size - (name ? 1 : 0)),
    observers: Math.max(names.size, 1),
    firstDay,
    // On the first day the lookback reaches, the bird may have been there before it.
    verified: firstDay > addDays(asOf, -(LOOKBACK_DAYS - 1))
  }
}

/**
 * Each pick with its `credit`, from one 30-day notable call per state (a few at a time). A state
 * eBird can't serve leaves its picks without credit; nothing here ever fails the run.
 */
const withCredits = async (picks, { asOf, fetch = (state) => ebird.notableObservations(state, LOOKBACK_DAYS) } = {}) => {
  const states = [...new Set(picks.map((p) => p.state).filter(Boolean))]
  const byState = new Map()
  for (let i = 0; i < states.length; i += PARALLEL) {
    const batch = states.slice(i, i + PARALLEL)
    const results = await Promise.allSettled(batch.map((st) => fetch(st)))
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) byState.set(batch[j], r.value)
      else console.error(`HQ finder credit for ${batch[j]} failed:`, r.reason?.message)
    })
  }
  return picks.map((p) => {
    const records = byState.get(p.state)
    const credit = records ? firstReport(records, p, asOf) : null
    return credit ? { ...p, credit } : p
  })
}

module.exports = { withCredits, firstReport, LOOKBACK_DAYS }
