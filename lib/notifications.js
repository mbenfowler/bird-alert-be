const { appUrl } = require('./appUrl')
const { stateOfRegion } = require('./regions')
const { evidenceLine } = require('./evidence')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** eBird's obsDt is 'YYYY-MM-DD HH:mm' in the region's local time; make it read naturally. */
const formatObsDt = (obsDt) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(obsDt || '')
  if (!match) return obsDt || ''
  const [, , month, day, hour, minute] = match
  const date = `${MONTHS[Number(month) - 1]} ${Number(day)}`
  if (hour === undefined) return date
  const h = Number(hour)
  const time = `${h % 12 || 12}:${minute} ${h < 12 ? 'AM' : 'PM'}`
  return `${date}, ${time}`
}

/** Best-effort timestamp for the notification (region-local time read as UTC; close enough for ordering). */
const obsTimestamp = (obsDt) => {
  const t = Date.parse(String(obsDt || '').replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : Date.now()
}

/** Spring arrivals get a sprout, autumn ones a leaf. */
const seasonEmoji = (obsDt) => {
  const month = Number(String(obsDt || '').slice(5, 7))
  return month >= 2 && month <= 6 ? '🌱' : '🍂'
}

const mapImageUrl = (lat, lng) => appUrl(`/api/map?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&zoom=14`)

/**
 * One rich notification for one sighting. Android and desktop show the photo (icon), the map
 * (image) and the action buttons; iPhone shows title and body only, so those carry the essentials.
 */
/** `?region=US-ME-003` for a link, or nothing when the county isn't a well-formed eBird county code. */
const regionQuery = (region) => stateOfRegion(region) ? `?region=${region}` : ''

/** "12 mi away in Fulton County", "in Division No. 11" (the whole state, no home to measure from), or null. */
const awayText = (away) => {
  if (!away) return null
  const far = Number.isFinite(away.miles) ? `${away.miles} mi away` : null
  const where = away.county ? `in ${away.county}` : null
  return [far, where].filter(Boolean).join(' ') || null
}

/** For a title: "12 mi away", else "in Fulton County", else "nearby". */
const awayShort = (away) => (away && Number.isFinite(away.miles) ? `${away.miles} mi away` : away && away.county ? `in ${away.county}` : 'nearby')

const sightingNotification = (sighting, bird = {}) => {
  const notable = sighting.kind === 'notable'
  const season = sighting.kind === 'season'
  const lifer = sighting.kind === 'lifer'
  const count = Number(sighting.howMany)
  // Past the county line: how far, and where, so it reads as a trip someone could make.
  const away = awayText(sighting.away)
  const parts = [sighting.locName, away, formatObsDt(sighting.obsDt)]
  if (Number.isFinite(count) && count > 1) parts.push(`${count} seen`)
  if (season) parts.push(sighting.lastSeenOn ? `first since ${formatObsDt(sighting.lastSeenOn)}` : 'first in over a year')
  // A rare-bird report says what stands behind it: confirmed or not yet, a photo, how many birders.
  if (sighting.evidence) parts.push(evidenceLine(sighting.evidence))
  const where = awayShort(sighting.away)
  const title = lifer ? `🎯 Lifer chance: ${sighting.comName} reported ${where}`
    : season ? `${seasonEmoji(sighting.obsDt)} First ${sighting.comName} of the season!`
    : notable ? (sighting.aba >= 3 && sighting.aba <= 5 ? `❗ ABA Code ${sighting.aba}: ${sighting.comName} reported ${where}` : `❗ Notable: ${sighting.comName} reported ${where}`) : `⭐ ${sighting.comName} spotted nearby!`
  return {
    title,
    body: parts.filter(Boolean).join(' · '),
    icon: bird.birdImg || appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    image: mapImageUrl(sighting.lat, sighting.lng),
    tag: `sighting-${sighting.speciesCode}-${sighting.subId}`,
    timestamp: obsTimestamp(sighting.obsDt),
    vibrate: [100, 50, 100],
    // The checklist is the actual report: observer, exact spot, often photos and notes.
    actions: [
      { action: 'map', title: 'Open map' },
      { action: 'ebird', title: 'View on eBird' }
    ],
    data: {
      kind: sighting.kind,
      speciesCode: sighting.speciesCode,
      comName: sighting.comName,
      lat: sighting.lat,
      lng: sighting.lng,
      locName: sighting.locName,
      ebirdUrl: sighting.subId ? `https://ebird.org/checklist/${encodeURIComponent(sighting.subId)}` : `https://ebird.org/species/${encodeURIComponent(sighting.speciesCode)}`,
      // A tap lands on the sighting itself: photo, place, every recent report of the species on a map.
      // The county rides along, so the page shows the right one whoever is signed in on that device.
      url: sighting.subId ? appUrl(`/sighting/${encodeURIComponent(sighting.speciesCode)}/${encodeURIComponent(sighting.subId)}${regionQuery(sighting.region)}`) : appUrl('/')
    }
  }
}

/**
 * The follow-up when a rare bird announced before review is confirmed by eBird's reviewers. Sent
 * once, only for ABA Code 3-5 birds; a rejected report gets no follow-up at all.
 */
const reviewNotification = (report) => ({
  title: `✅ Now confirmed by eBird: ${report.comName}`,
  body: [report.locName, formatObsDt(report.obsDt), report.aba >= 3 && report.aba <= 5 ? `ABA Code ${report.aba}` : null].filter(Boolean).join(' · '),
  icon: appUrl('/images/bird.png'),
  badge: appUrl('/images/bird.png'),
  tag: `review-${report.speciesCode}-${report.subId}`,
  timestamp: Date.now(),
  actions: [{ action: 'ebird', title: 'View on eBird' }],
  data: {
    kind: 'review',
    speciesCode: report.speciesCode,
    ebirdUrl: `https://ebird.org/checklist/${encodeURIComponent(report.subId)}`,
    url: appUrl(`/sighting/${encodeURIComponent(report.speciesCode)}/${encodeURIComponent(report.subId)}${regionQuery(report.region)}`)
  }
})

// A watch-list notification names at most this many birds; the rest are counted.
const MAX_LINES = 6

/**
 * Every watch-list sighting from one run in a single notification: a line per bird with where and
 * when, no map image. Tapping opens a page with all of them pinned on one map. Notable and
 * first-of-season birds keep their own rich notification so the maps app is one tap away.
 */
const watchlistNotification = (sightings, birdByCode = new Map(), region = null) => {
  // A bird past the county line says how far and where, as the rare-bird alerts do.
  const lines = sightings.slice(0, MAX_LINES).map((s) => [s.comName, s.locName, awayText(s.away), formatObsDt(s.obsDt)].filter(Boolean).join(' · '))
  if (sightings.length > MAX_LINES) lines.push(`and ${sightings.length - MAX_LINES} more`)
  const one = sightings.length === 1
  // iPhone shows a line or two of the body, so the names come first; the details follow for the rest.
  if (!one) lines.unshift(sightings.map((s) => s.comName).join(', '))
  const bird = one ? birdByCode.get(sightings[0].speciesCode) : undefined
  const refs = sightings.map((s) => `${s.speciesCode}:${s.subId}`).join(',')
  return {
    title: one ? `⭐ ${sightings[0].comName} spotted ${sightings[0].away ? awayShort(sightings[0].away) : 'nearby'}!` : `⭐ ${sightings.length} watch list birds spotted nearby`,
    body: lines.join('\n'),
    icon: (bird && bird.birdImg) || appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    tag: `watchlist-${Date.now()}`,
    timestamp: Math.max(...sightings.map((s) => obsTimestamp(s.obsDt))),
    vibrate: [100, 50, 100],
    actions: [{ action: 'app', title: 'Open app' }],
    // The page maps every one of these sightings and lists the details beneath.
    data: { kind: 'watchlist', speciesCodes: sightings.map((s) => s.speciesCode), url: appUrl(`/sightings?s=${encodeURIComponent(refs)}${regionQuery(region).replace('?', '&')}`) }
  }
}

// The test notification previews up to this many of the user's birds.
const TEST_BIRDS = 3

/**
 * What the "Send a test notification" button sends: the real watch-list batch built from the
 * user's own birds among the region's recent reports (or the newest few reports when none of
 * theirs are about), so the tap lands on the sightings page exactly as a real alert would.
 */
const testNotification = (recent, savedCodes, birdByCode = new Map()) => {
  const mine = recent.filter((obs) => savedCodes.has(obs.speciesCode))
  const sample = (mine.length ? mine : recent).slice(0, TEST_BIRDS).map((obs) => ({ ...obs, kind: 'watchlist' }))
  if (!sample.length) return null
  const notification = watchlistNotification(sample, birdByCode)
  return { ...notification, title: `Test: ${notification.title}`, tag: 'bird-alert-test' }
}

/** When a run finds more than we want to show one by one, the rest arrive as a single summary. */
const summaryNotification = (sightings) => {
  const names = sightings.slice(0, 3).map((s) => s.comName).join(', ')
  const more = sightings.length > 3 ? ` and ${sightings.length - 3} more` : ''
  return {
    title: `${sightings.length} more sightings nearby`,
    body: `${names}${more}.`,
    icon: appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    tag: 'sightings-summary',
    actions: [{ action: 'app', title: 'Open app' }],
    data: { kind: 'summary', url: appUrl('/map') }
  }
}

module.exports = { sightingNotification, watchlistNotification, testNotification, summaryNotification, reviewNotification, formatObsDt, mapImageUrl }
