const ebird = require('./ebird')
const { HttpError } = require('./http')

/**
 * "Is it still there?" for one bird at one place. The report feed lags behind checklists (a
 * rarity's reports wait for review), so after the last listed report we open the newest
 * checklists filed at the place and look for the bird on each. Then an honest chance: the bird
 * fades with time at its persistence class's pace, and every checklist that missed it counts
 * against it in proportion to how often it's seen when it is there.
 */
const MAX_LOOKS = 8
const HALF_LIFE_HOURS = { rare: 48, passage: 96, seasonal: 240, resident: 504 }
const DEFAULT_DETECTION = 0.6
const cache = new Map()
const CACHE_MS = 10 * 60 * 1000

/** eBird times are the place's local clock; the server runs on UTC, so shift by the place's rough zone. */
const toTime = (dt, offsetHours = 0) => Date.parse(String(dt || '').replace(' ', 'T') + 'Z') - offsetHours * 3600000
const zoneOf = (lng) => (Number.isFinite(lng) ? Math.round(lng / 15) : 0)
/** A checklist's start as "2026-10-27 14:57", the way reports date themselves. */
const listDt = (l) => (l.isoObsDate ? String(l.isoObsDate).replace('T', ' ').slice(0, 16) : null)

/** Pure: from the last report and what each later checklist said, the chance it's still there. */
const assess = ({ lastSeen, looks, now = Date.now(), halfLifeHours = HALF_LIFE_HOURS.rare, offsetHours = 0 }) => {
  const found = looks.filter((l) => l.found)
  const latest = [lastSeen, ...found.map((l) => l.obsDt)].filter(Boolean).sort().at(-1) || null
  const misses = looks.filter((l) => !l.found && l.obsDt > (latest || '')).length
  const hours = latest ? Math.max(0, (now - toTime(latest, offsetHours)) / 3600000) : null
  // How readily it's found when it's there: only checklists up to the newest find can say (a miss after
  // that might mean it left), pulled toward a middling default until there are a few of them.
  const known = looks.filter((l) => l.obsDt <= (latest || ''))
  const d = Math.min(0.95, Math.max(0.3, (known.filter((l) => l.found).length + 2 * DEFAULT_DETECTION) / (known.length + 2)))
  const prior = hours === null ? 0 : Math.pow(0.5, hours / halfLifeHours)
  const missFactor = Math.pow(1 - d, misses)
  const present = prior === 0 ? 0 : (prior * missFactor) / (prior * missFactor + (1 - prior))
  const verdict = latest === null ? 'unknown'
    : misses === 0 && hours < 24 ? 'fresh'
      : present >= 0.6 ? 'likely' : present >= 0.3 ? 'maybe' : 'gone'
  return {
    lastSeen: latest,
    hoursAgo: hours === null ? null : Math.round(hours),
    checkedSince: looks.filter((l) => l.obsDt > (lastSeen || '')).length,
    foundSince: found.filter((l) => l.obsDt > (lastSeen || '')).length,
    missesSince: misses,
    stillThere: Math.round(present * 100),
    chance: Math.round(present * d * 100),
    verdict
  }
}

const chase = async ({ locId, code, cls }) => {
  if (!/^L\d{1,12}$/.test(String(locId || ''))) throw new HttpError(400, 'Invalid location')
  const speciesCode = ebird.assertSpecies(String(code || ''))
  const halfLifeHours = HALF_LIFE_HOURS[cls] || HALF_LIFE_HOURS.rare
  const key = `${locId}|${speciesCode}|${halfLifeHours}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result

  const [reports, lists] = await Promise.all([
    ebird.speciesObservations(locId, speciesCode, 14).catch(() => []),
    ebird.recentChecklists(locId, 40).catch(() => [])
  ])
  const lastSeen = reports.map((o) => o.obsDt).filter(Boolean).sort().at(-1) || null
  const later = lists.map((l) => ({ subId: l.subId || l.subID, obsDt: listDt(l) }))
    .filter((l) => l.subId && l.obsDt && (!lastSeen || l.obsDt > lastSeen))
    .sort((a, b) => b.obsDt.localeCompare(a.obsDt))
    .slice(0, MAX_LOOKS)
  const looks = []
  for (const l of later) {
    try {
      const view = await ebird.checklistView(l.subId)
      looks.push({ obsDt: l.obsDt, found: (view.obs || []).some((o) => o.speciesCode === speciesCode) })
    } catch { /* a checklist that won't open just isn't counted */ }
  }
  const result = { locId, speciesCode, checklistsAtPlace: lists.length, ...assess({ lastSeen, looks, halfLifeHours, offsetHours: zoneOf(Number(reports[0]?.lng ?? lists[0]?.loc?.lng)) }) }
  cache.set(key, { at: Date.now(), result })
  return result
}

module.exports = { chase, assess, HALF_LIFE_HOURS }
