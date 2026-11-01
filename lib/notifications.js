const { appUrl } = require('./appUrl')
const { stateOfRegion } = require('./regions')
const { evidenceLine } = require('./evidence')
const { t, formatObsDt, formatDistance } = require('./i18n')

/**
 * Every notification is written for its reader: `lang` is { locale, unit } (the person's language
 * and 'mi' or 'km'), English and miles when it's left out. Bird names arrive already in the
 * reader's language (lib/birdNames), so the words here only frame them.
 */
const ENGLISH = { locale: null, unit: 'mi' }

/** Best-effort timestamp for the notification (region-local time read as UTC; close enough for ordering). */
const obsTimestamp = (obsDt) => {
  const time = Date.parse(String(obsDt || '').replace(' ', 'T') + 'Z')
  return Number.isFinite(time) ? time : Date.now()
}

/** Spring arrivals get a sprout, autumn ones a leaf. */
const seasonEmoji = (obsDt) => {
  const month = Number(String(obsDt || '').slice(5, 7))
  return month >= 2 && month <= 6 ? '🌱' : '🍂'
}

const mapImageUrl = (lat, lng) => appUrl(`/api/map?lat=${lat.toFixed(4)}&lng=${lng.toFixed(4)}&zoom=14`)

/** `?region=US-ME-003` for a link, or nothing when the county isn't a well-formed eBird county code. */
const regionQuery = (region) => stateOfRegion(region) ? `?region=${region}` : ''

/** "12 mi away in Hall" (or km, in the reader's words) for a sighting past the county line. */
const awayText = (away, { locale, unit }) => {
  const distance = formatDistance(away.miles, unit, locale)
  return away.county ? t(locale, 'distance.awayIn', { distance, county: away.county }) : t(locale, 'distance.away', { distance })
}

/**
 * One rich notification for one sighting. Android and desktop show the photo (icon), the map
 * (image) and the action buttons; iPhone shows title and body only, so those carry the essentials.
 */
const sightingNotification = (sighting, bird = {}, lang = ENGLISH) => {
  const { locale } = lang
  const notable = sighting.kind === 'notable'
  const season = sighting.kind === 'season'
  const lifer = sighting.kind === 'lifer'
  const count = Number(sighting.howMany)
  // Past the county line: how far, and where, so it reads as a trip someone could make.
  const away = sighting.away ? awayText(sighting.away, lang) : null
  const parts = [sighting.locName, away, formatObsDt(sighting.obsDt, locale)]
  if (Number.isFinite(count) && count > 1) parts.push(t(locale, 'push.seen', { count }))
  if (season) parts.push(sighting.lastSeenOn ? t(locale, 'push.firstSince', { date: formatObsDt(sighting.lastSeenOn, locale) }) : t(locale, 'push.firstInYear'))
  // A rare-bird report says what stands behind it: confirmed or not yet, a photo, how many birders.
  if (sighting.evidence) parts.push(evidenceLine(sighting.evidence, locale))
  const where = sighting.away ? t(locale, 'distance.away', { distance: formatDistance(sighting.away.miles, lang.unit, locale) }) : t(locale, 'push.nearby')
  const name = sighting.comName
  const title = lifer ? t(locale, 'push.lifer', { bird: name, where })
    : season ? t(locale, 'push.season', { emoji: seasonEmoji(sighting.obsDt), bird: name })
    : notable ? (sighting.aba >= 3 && sighting.aba <= 5 ? t(locale, 'push.abaCode', { code: sighting.aba, bird: name, where }) : t(locale, 'push.notable', { bird: name, where }))
    : t(locale, 'push.watched', { bird: name })
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
      { action: 'map', title: t(locale, 'push.actions.map') },
      { action: 'ebird', title: t(locale, 'push.actions.ebird') }
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
const reviewNotification = (report, lang = ENGLISH) => {
  const { locale } = lang
  return {
    title: t(locale, 'push.reviewTitle', { bird: report.comName }),
    body: [report.locName, formatObsDt(report.obsDt, locale), report.aba >= 3 && report.aba <= 5 ? t(locale, 'push.abaCodeShort', { code: report.aba }) : null].filter(Boolean).join(' · '),
    icon: appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    tag: `review-${report.speciesCode}-${report.subId}`,
    timestamp: Date.now(),
    actions: [{ action: 'ebird', title: t(locale, 'push.actions.ebird') }],
    data: {
      kind: 'review',
      speciesCode: report.speciesCode,
      ebirdUrl: `https://ebird.org/checklist/${encodeURIComponent(report.subId)}`,
      url: appUrl(`/sighting/${encodeURIComponent(report.speciesCode)}/${encodeURIComponent(report.subId)}${regionQuery(report.region)}`)
    }
  }
}

// A watch-list notification names at most this many birds; the rest are counted.
const MAX_LINES = 6

/**
 * Every watch-list sighting from one run in a single notification: a line per bird with where and
 * when, no map image. Tapping opens a page with all of them pinned on one map. Notable and
 * first-of-season birds keep their own rich notification so the maps app is one tap away.
 */
const watchlistNotification = (sightings, birdByCode = new Map(), region = null, lang = ENGLISH) => {
  const { locale } = lang
  const lines = sightings.slice(0, MAX_LINES).map((s) => [s.comName, s.locName, formatObsDt(s.obsDt, locale)].filter(Boolean).join(' · '))
  if (sightings.length > MAX_LINES) lines.push(t(locale, 'push.andMore', { count: sightings.length - MAX_LINES }))
  const one = sightings.length === 1
  // iPhone shows a line or two of the body, so the names come first; the details follow for the rest.
  if (!one) lines.unshift(sightings.map((s) => s.comName).join(', '))
  const bird = one ? birdByCode.get(sightings[0].speciesCode) : undefined
  const refs = sightings.map((s) => `${s.speciesCode}:${s.subId}`).join(',')
  return {
    title: one ? t(locale, 'push.watched', { bird: sightings[0].comName }) : t(locale, 'push.watchedMany', { count: sightings.length }),
    body: lines.join('\n'),
    icon: (bird && bird.birdImg) || appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    tag: `watchlist-${Date.now()}`,
    timestamp: Math.max(...sightings.map((s) => obsTimestamp(s.obsDt))),
    vibrate: [100, 50, 100],
    actions: [{ action: 'app', title: t(locale, 'push.actions.app') }],
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
const testNotification = (recent, savedCodes, birdByCode = new Map(), lang = ENGLISH) => {
  const mine = recent.filter((obs) => savedCodes.has(obs.speciesCode))
  const sample = (mine.length ? mine : recent).slice(0, TEST_BIRDS).map((obs) => ({ ...obs, kind: 'watchlist' }))
  if (!sample.length) return null
  const notification = watchlistNotification(sample, birdByCode, null, lang)
  return { ...notification, title: t(lang.locale, 'push.test', { title: notification.title }), tag: 'bird-alert-test' }
}

/** When a run finds more than we want to show one by one, the rest arrive as a single summary. */
const summaryNotification = (sightings, lang = ENGLISH) => {
  const { locale } = lang
  const names = sightings.slice(0, 3).map((s) => s.comName).join(', ')
  const more = sightings.length > 3 ? t(locale, 'push.summaryMore', { count: sightings.length - 3 }) : ''
  return {
    title: t(locale, 'push.summaryTitle', { count: sightings.length }),
    body: t(locale, 'push.summaryBody', { names, more }),
    icon: appUrl('/images/bird.png'),
    badge: appUrl('/images/bird.png'),
    tag: 'sightings-summary',
    actions: [{ action: 'app', title: t(locale, 'push.actions.app') }],
    data: { kind: 'summary', url: appUrl('/map') }
  }
}

module.exports = { sightingNotification, watchlistNotification, testNotification, summaryNotification, reviewNotification, formatObsDt, mapImageUrl, ENGLISH }
