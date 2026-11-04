const { t, formatObsDt, formatClock, formatDistance, langFor, colon } = require('./i18n')
const { isShown } = require('./abaCodes')

/**
 * The scouting email, daily (lib/scouting runScouting) and asked for now (lib/scoutEmail): the
 * designed alert layout, as the digests have, top to bottom:
 *   the countdown and how many targets are about (a bar), a bird of the day, what else is new since
 *   yesterday (less the bird of the day), one map with a numbered pin per place, the places (most targets first), what's still
 *   missing, the group's route, what else is about when none of theirs is, and the buttons.
 * Every part shows only when it has something to say. The plain text mirrors it, section by section.
 * Built from the report alone: no lookups here.
 *
 * `seen` rows: { code, bird, where, locId, lat, lng, obsDt, date, subId, flagged, evidence (a line or ''), aba, birdImg }.
 * `thisWeek` (or null): what else is about, rows { code, bird, where, locId, lat, lng, obsDt, subId, notable }.
 * `route`: the group's saved route ({ start, stops }, with lib/eventRoutePlan routeDetails' legs, totals and
 * routed for an itinerary) or null. `requested`: { asOf } when asked for now.
 */
const MAX_PLACES = 5

const mailer = () => require('./mailer')
const h = (value) => mailer().escapeHtml(value)

/** "2026-11-03 09:14", the person's own wall clock (UTC when the zone is unknown): eBird's obsDt is a wall clock too. */
const wallClock = (now, timezone) => {
  const format = (timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)
  try { return format(timezone || 'UTC') } catch { return format('UTC') }
}
const minusDay = (wall) => new Date(Date.parse(`${wall.replace(' ', 'T')}:00Z`) - 86_400_000).toISOString().slice(0, 16).replace('T', ' ')
// A report with no time of day counts as noon.
const asWall = (obsDt) => (String(obsDt).length > 10 ? String(obsDt).slice(0, 16) : `${String(obsDt).slice(0, 10)} 12:00`)
const daysAgo = (obsDt, today) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${String(obsDt).slice(0, 10)}T00:00:00Z`)) / 86_400_000)

/** "today", "yesterday", "3 days ago". */
const freshness = (obsDt, today, locale) => {
  const n = Math.max(0, daysAgo(obsDt, today))
  return n === 0 ? t(locale, 'mail.scout.today') : n === 1 ? t(locale, 'mail.scout.yesterday') : t(locale, 'mail.scout.daysAgo', { count: n })
}

/** Pure: targets whose newest report is within the 24 hours before `wall`, newest first. */
const freshOf = (seen, wall) => {
  const since = minusDay(wall)
  return seen.filter((s) => asWall(s.obsDt) > since && asWall(s.obsDt) <= wall).sort((a, b) => String(b.obsDt).localeCompare(String(a.obsDt)))
}

/** Sort order, rarest first: an ABA code of 3-5 (higher first), then flagged by eBird, then the newest. */
const rarerFirst = (a, b) =>
  ((isShown(b.aba) ? b.aba : 0) - (isShown(a.aba) ? a.aba : 0)) || (Number(Boolean(b.flagged)) - Number(Boolean(a.flagged))) ||
  String(b.obsDt).localeCompare(String(a.obsDt))

/** Pure: the bird of the day: the rarest reported (ABA code 3-5, then flagged by eBird), the newest of equals. */
const birdOfTheDay = (seen) => [...seen].sort(rarerFirst)[0] || null

/** A bird to pick out: rare there (eBird flagged the report) or an ABA code of 3-5. */
const rareRow = (b) => Boolean(b.notable || b.flagged || isShown(b.aba))

/**
 * Pure: rows grouped by place (its eBird location, else its name), as the event page groups them:
 * most birds first, then the newest (what else is about: places with a rare bird first). Each place's newest checklist is the one linked.
 */
const placesOf = (rows, { rareFirst = false } = {}) => {
  const by = new Map()
  for (const r of rows) {
    const key = r.locId || r.where
    if (!by.has(key)) by.set(key, { key, where: r.where, lat: r.lat, lng: r.lng, latest: r, birds: [] })
    const p = by.get(key)
    p.birds.push(r)
    if (String(r.obsDt) > String(p.latest.obsDt)) p.latest = r
  }
  return [...by.values()]
    .map((p) => ({ ...p, obsDt: p.latest.obsDt, subId: p.latest.subId || null }))
    .sort((a, b) => (rareFirst ? Number(b.birds.some(rareRow)) - Number(a.birds.some(rareRow)) : 0) ||
      (b.birds.length - a.birds.length) || String(b.obsDt).localeCompare(String(a.obsDt)))
}

/** The top places, numbered for the map (a place with no coordinates gets no pin). */
const pinned = (places) => {
  let n = 0
  return places.slice(0, MAX_PLACES).map((p) => ({ ...p, pin: Number.isFinite(p.lat) && Number.isFinite(p.lng) && n < mailer().MAX_PINS ? String(++n) : null }))
}

const checklistHref = (subId) => (subId ? `https://ebird.org/checklist/${encodeURIComponent(subId)}` : null)

/** The heading: "Big Day 2027 · 6 days to go", "· tomorrow", "· today", "· under way". */
const when = (locale, daysToGo) => daysToGo > 1 ? t(locale, 'mail.scout.countdown', { count: daysToGo })
  : daysToGo === 1 ? t(locale, 'mail.scout.tomorrow') : daysToGo === 0 ? t(locale, 'mail.scout.today') : t(locale, 'mail.scout.underway')

const subjectOf = (locale, { place, daysToGo, requested, fresh, seen, targetCount, standIn }) => {
  if (requested) return t(locale, 'mail.scout.requestedSubject', { place, time: requested.asOf })
  const vars = { place, when: when(locale, daysToGo) }
  if (fresh.length) return t(locale, fresh.length === 1 ? 'mail.scout.subjectFresh' : 'mail.scout.subjectFreshMore', { ...vars, bird: fresh[0].bird, count: fresh.length - 1 })
  if (!seen.length) return t(locale, standIn ? 'mail.scout.subjectNoneLifers' : 'mail.scout.subjectNone', vars)
  return t(locale, standIn ? 'mail.scout.subjectAroundLifers' : 'mail.scout.subjectAround', { ...vars, seen: seen.length, count: targetCount })
}

/**
 * Pure: what the daily scouting push, email and the event page all say about a report (lib/scouting
 * reportLines' `seen` rows): `fresh`, the targets new in the 24 hours before now on the reader's
 * clock (newest first); `hero`, the bird of the day; `subject`, the email's subject line (the
 * headline: "Big Day 2027: Rufous-backed Robin new today · 6 days to go"). One place, so the three never disagree.
 */
const scoutSummary = ({ locale, timezone = null, now = new Date(), place, daysToGo, seen = [], targetCount, standIn = false, requested = null }) => {
  const wall = wallClock(now, timezone)
  const fresh = freshOf(seen, wall)
  return { wall, fresh, hero: birdOfTheDay(seen), subject: subjectOf(locale, { place, daysToGo, requested, fresh, seen, targetCount, standIn }) }
}

// HTML pieces, inline styles only, tables for anything laid side by side (Gmail and Outlook).
const SUB = 'margin:22px 0 8px;font-size:17px;'
const subheading = (text) => `<h2 style="${SUB}">${h(text)}</h2>`
const buttonAlt = (href, label) =>
  `<a href="${href}" style="display:inline-block;margin:6px 8px 0 0;padding:9px 14px;border:2px solid #111;border-radius:999px;background:#fff;color:#111;font-weight:bold;font-size:14px;text-decoration:none;">${h(label)}</a>`
const abaBadge = (aba, locale) => isShown(aba)
  ? ` <span style="display:inline-block;margin-left:6px;padding:1px 8px;border:2px solid #111;border-radius:999px;background:#ffd700;font-size:12px;font-weight:bold;vertical-align:2px;">${h(t(locale, 'mail.abaCode', { code: aba }))}</span>`
  : ''

const bar = (count, total) => {
  const pct = total ? Math.round((count / total) * 100) : 0
  const cell = (width, color) => `<td${width ? ` width="${width}%"` : ''} style="height:12px;background:${color};font-size:0;line-height:0;">&nbsp;</td>`
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border:2px solid #111;border-radius:8px;margin:0 0 6px;"><tr>${
    pct >= 100 ? cell(null, '#ff6a00') : pct <= 0 ? cell(null, '#eeeeee') : cell(pct, '#ff6a00') + cell(null, '#eeeeee')}</tr></table>`
}

const chip = (name, rare) =>
  `<span style="display:inline-block;margin:0 4px 4px 0;padding:2px 9px;border:1px solid #111;border-radius:999px;background:${rare ? '#ffd700' : '#f1f1f1'};font-size:13px;">${h(name)}</span>`

const placeCard = (p, today, locale) => {
  const href = checklistHref(p.subId)
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 10px;border:2px solid #111;border-radius:12px;"><tr><td style="padding:10px 12px;">
    <div style="font-size:15px;">${mailer().pinBadge(p.pin)}<strong>${h(p.where)}</strong> <span style="color:#4f4f4f;">&middot; ${h(freshness(p.obsDt, today, locale))}</span></div>
    <div style="margin:8px 0 0;">${p.birds.map((b) => chip(b.bird, rareRow(b))).join('')}</div>
    ${href ? `<div style="margin:4px 0 0;font-size:13px;"><a href="${href}" style="color:#1a56db;">${h(t(locale, 'mail.scout.checklist'))}</a></div>` : ''}
  </td></tr></table>`
}

const heroCard = (bird, locale) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:16px 0 0;border:2px solid #111;border-radius:12px;overflow:hidden;">
  ${bird.birdImg ? `<tr><td style="padding:0;"><img src="${h(bird.birdImg)}" width="520" alt="${h(bird.bird)}" style="display:block;width:100%;max-width:520px;height:auto;"></td></tr>` : ''}
  <tr><td style="padding:12px;">
    <div style="font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#b34a00;">${h(t(locale, 'mail.scout.birdOfTheDay'))}</div>
    <div style="margin:2px 0 0;font-size:20px;font-weight:bold;">${h(bird.bird)}${abaBadge(bird.aba, locale)}</div>
    <div style="margin:4px 0 0;font-size:14px;color:#4f4f4f;">${h(bird.where)} &middot; ${h(bird.date || formatObsDt(bird.obsDt, locale))}</div>
    ${bird.evidence ? `<div style="margin:4px 0 0;font-size:13px;color:#4f4f4f;">${h(bird.evidence)}</div>` : ''}
  </td></tr></table>`

/** "Meeting point: Sierra Vista Motel · 5:15 AM": the time, when the group set one, on the event's clock in the reader's way. */
const meetLine = (start, locale) => {
  const time = formatClock(start.time, locale)
  return time ? t(locale, 'mail.scout.routeMeetAt', { name: start.name, time }) : t(locale, 'mail.scout.routeMeet', { name: start.name })
}

const routeLines = (route, locale) => [
  ...(route.start?.name ? [meetLine(route.start, locale)] : []),
  ...route.stops.map((s, i) => t(locale, 'mail.scout.routeStop', { n: i + 1, name: s.name }))
]

const IT = 'mail.scout.itinerary.'

/** "45 min", "2 h", "1 h 49 min". */
const duration = (minutes, locale) => {
  const total = Math.max(0, Math.round(minutes || 0))
  const hours = Math.floor(total / 60)
  const m = total % 60
  return !hours ? t(locale, `${IT}minutes`, { m }) : !m ? t(locale, `${IT}hours`, { h: hours }) : t(locale, `${IT}hoursMinutes`, { h: hours, m })
}


/**
 * Pure: the saved route as an itinerary, one entry a line (distances in `unit`, the reader's: mi in the US, km elsewhere): { kind: 'meet'|'drive'|'stop'|'totals'|'noDrive', text }.
 * Each stop: the drive into it (when routed), then its name and the time there, marked suggested when
 * the group hasn't set it, with its targets. Then the day's totals.
 */
const itineraryLines = (route, locale, unit = 'mi') => {
  const lines = []
  if (route.start?.name) lines.push({ kind: 'meet', text: meetLine(route.start, locale) })
  route.stops.forEach((s, i) => {
    const leg = route.routed && route.legs ? route.legs[i] : null
    if (leg) lines.push({ kind: 'drive', text: t(locale, `${IT}drive`, { time: duration(leg.min, locale), distance: formatDistance(leg.mi, unit, locale) }) })
    const own = Number.isInteger(s.stay_min)
    const notes = [...(own ? [] : [t(locale, `${IT}suggested`)]), ...(s.targets_here ? [t(locale, `${IT}targets`, { count: s.targets_here })] : [])]
    const stop = t(locale, `${IT}stop`, { n: i + 1, name: s.name, time: duration(own ? s.stay_min : s.suggested_stay_min, locale) })
    lines.push({ kind: 'stop', text: notes.length ? `${stop} ${t(locale, `${IT}notes`, { notes: notes.join(', ') })}` : stop, name: s.name })
  })
  const { totals } = route
  lines.push({
    kind: 'totals',
    text: route.routed
      ? t(locale, `${IT}totals`, { drive: duration(totals.drive_min, locale), stay: duration(totals.stay_min, locale), total: duration(totals.total_min, locale) })
      : t(locale, `${IT}totalsNoDrive`, { stay: duration(totals.stay_min, locale) })
  })
  if (!route.routed) lines.push({ kind: 'noDrive', text: t(locale, `${IT}noDriveTimes`) })
  return lines
}

const isItinerary = (route) => Boolean(route && route.totals && Array.isArray(route.stops))

const itineraryHtml = (route, locale, unit) => itineraryLines(route, locale, unit).map(({ kind, text }) => {
  if (kind === 'drive') return `<div style="margin:2px 0 2px 12px;font-size:13px;color:#4f4f4f;">${h(text)}</div>`
  if (kind === 'stop') return `<div style="margin:0;padding:6px 10px;border:2px solid #111;border-radius:10px;font-size:15px;">${h(text)}</div>`
  if (kind === 'totals') return `<div style="margin:12px 0 0;padding:8px 12px;background:#fff4c2;border-left:4px solid #ffd700;font-size:14px;font-weight:bold;">${h(text)}</div>`
  if (kind === 'noDrive') return `<div style="margin:6px 0 0;font-size:13px;color:#4f4f4f;">${h(text)}</div>`
  return `<div style="margin:0 0 6px;font-size:15px;">${h(text)}</div>`
}).join('')

const routeHtml = (route, locale, unit) => (isItinerary(route) ? itineraryHtml(route, locale, unit)
  : `<p style="margin:0;font-size:15px;line-height:1.6;">${routeLines(route, locale).map(h).join('<br>')}</p>`)
const routeText = (route, locale, unit) => (isItinerary(route) ? itineraryLines(route, locale, unit).map((l) => l.text) : routeLines(route, locale)).join('\n')

/**
 * The message. `final` is accepted for older callers; the wording follows daysToGo (1 tomorrow, 0 today, below 0 under way).
 */
const scoutingMessage = (user, {
  eventId, place, daysToGo, seen = [], unreported = [], group = false, standIn = false, noTargets = false,
  targetCount = null, recentDays = 3, thisWeek = null, route = null, requested = null, now = new Date()
}) => {
  const m = mailer()
  const locale = user.locale
  // Drives in the reader's unit (the API's legs stay in miles).
  const { unit } = langFor(user)
  const total = targetCount ?? (seen.length + unreported.length)
  const { wall, fresh, hero, subject } = scoutSummary({ locale, timezone: user.timezone, now, place, daysToGo, seen, targetCount: total, standIn, requested })
  const today = wall.slice(0, 10)
  // Under the bird of the day: what else is new, without it again. The subject still counts them all.
  const freshShown = fresh.filter((s) => s.code !== hero?.code)
  const eventHref = m.appUrl(eventId ? `/events/${eventId}` : '/events')
  // "Open the event" lands on the scouting card.
  const scoutingHref = m.appUrl(eventId ? `/events/${eventId}#scouting` : '/events')
  const routeHref = m.appUrl(eventId ? `/events/${eventId}#route` : '/events')
  const saved = route?.stops?.length ? route : null
  const targetPlaces = pinned(placesOf(seen))
  const allTargetPlaces = placesOf(seen).length
  const fallbackAll = thisWeek ? placesOf(thisWeek, { rareFirst: true }) : []
  const fallback = pinned(fallbackAll)
  const moreFallback = fallbackAll.length - fallback.length
  const mapPlaces = targetPlaces.length ? targetPlaces : fallback
  const mapUrl = m.checklistMapUrl(mapPlaces)
  const windowWords = recentDays === 7 ? t(locale, 'mail.scout.progressWeek') : t(locale, 'mail.scout.progressDays', { count: recentDays })
  const count = t(locale, standIn ? 'mail.scout.progressLifers' : 'mail.scout.progressTargets', { seen: seen.length, count: total })
  const heading = `${place} · ${when(locale, daysToGo)}`
  const moreTargets = allTargetPlaces - targetPlaces.length
  const showBar = !noTargets && total > 0
  const noneSeen = !noTargets && !seen.length
  const missing = unreported.length ? t(locale, 'mail.scout.missing', { birds: unreported.join(', ') }) : ''

  const moreLine = (n) => (n > 0 ? `<p style="margin:4px 0 0;font-size:14px;"><a href="${eventHref}" style="color:#1a56db;">${h(t(locale, 'mail.scout.morePlaces', { count: n }))}</a></p>` : '')
  const moreText = (n) => (n > 0 ? [`${colon(locale, t(locale, 'mail.scout.morePlaces', { count: n }))} ${eventHref}`] : [])
  const html = [
    showBar ? `<p style="margin:4px 0 6px;font-size:15px;"><strong>${h(count)}</strong> ${h(windowWords)}</p>${bar(seen.length, total)}` : '',
    hero ? heroCard(hero, locale) : '',
    freshShown.length ? `<p style="margin:14px 0 0;padding:8px 12px;background:#fff4c2;border-left:4px solid #ffd700;font-size:15px;"><strong>${h(t(locale, 'mail.scout.freshLabel'))}</strong> ${h(freshShown.map((s) => s.bird).join(', '))}</p>` : '',
    standIn ? `<p style="margin:12px 0 0;font-size:14px;color:#4f4f4f;">${h(t(locale, 'mail.scout.standIn'))}</p>${m.button(eventHref, t(locale, 'mail.scout.pickTargetsButton'))}` : '',
    mapUrl ? `<a href="${eventHref}" style="display:block;margin:18px 0 0;"><img src="${mapUrl}" width="520" alt="${h(t(locale, 'mail.scout.mapAlt'))}" style="display:block;width:100%;max-width:520px;height:auto;border-radius:10px;border:1px solid #ccc;"></a>` : '',
    targetPlaces.length ? subheading(t(locale, 'mail.scout.placesHeading')) + targetPlaces.map((p) => placeCard(p, today, locale)).join('') +
      moreLine(moreTargets) : '',
    noneSeen ? `<p style="margin:14px 0 0;font-size:15px;">${h(t(locale, recentDays === 7 ? 'mail.scout.noneSeenWeek' : 'mail.scout.noneSeen'))}</p>` : '',
    missing ? `<p style="margin:16px 0 0;font-size:14px;color:#6b6b6b;">${h(missing)}</p>` : '',
    thisWeek ? subheading(t(locale, 'mail.scout.thisWeekHeading')) + (fallback.length
      ? fallback.map((p) => placeCard(p, today, locale)).join('') + moreLine(moreFallback)
      : `<p style="margin:0;font-size:15px;">${h(t(locale, 'mail.scout.thisWeekNone'))}</p>`) : '',
    noTargets ? `<p style="margin:12px 0 0;font-size:14px;">${h(t(locale, 'mail.scout.pickTargetsInvite'))}</p>${m.button(eventHref, t(locale, 'mail.scout.pickTargetsButton'))}` : '',
    saved ? subheading(t(locale, group ? 'mail.scout.groupRouteHeading' : 'mail.scout.routeHeading')) + routeHtml(saved, locale, unit)
      : subheading(t(locale, group ? 'mail.scout.groupRouteHeading' : 'mail.scout.routeHeading')) + `<p style="margin:0;font-size:14px;color:#4f4f4f;">${h(t(locale, 'mail.scout.noRoute'))}</p>${m.button(routeHref, t(locale, 'mail.scout.planRouteButton'))}`,
    `<div style="margin:22px 0 6px;">${m.button(scoutingHref, t(locale, 'mail.scout.openEvent'))}${saved ? buttonAlt(routeHref, t(locale, 'mail.scout.planTheRoute')) : ''}</div>`
  ].filter(Boolean).join('\n')

  const bullets = (places) => places.map((p) => [
    `${p.pin ? `${p.pin}. ` : '- '}${p.where} (${freshness(p.obsDt, today, locale)})`,
    `   ${p.birds.map((b) => rareRow(b) ? `${b.bird} (${t(locale, 'mail.scout.notable')})` : b.bird).join(', ')}`,
    ...(p.subId ? [`   ${colon(locale, t(locale, 'mail.scout.checklist'))} ${checklistHref(p.subId)}`] : [])
  ].join('\n')).join('\n')
  const text = [
    [heading, group ? t(locale, 'mail.scout.withGroup') : null, showBar ? `${count} ${windowWords}` : null].filter(Boolean).join('\n'),
    hero ? [`${colon(locale, t(locale, 'mail.scout.birdOfTheDay'))} ${hero.bird}${isShown(hero.aba) ? ` (${t(locale, 'mail.abaCode', { code: hero.aba })})` : ''}`,
      `${hero.where} · ${hero.date || formatObsDt(hero.obsDt, locale)}`, ...(hero.evidence ? [hero.evidence] : [])].join('\n') : null,
    freshShown.length ? `${t(locale, 'mail.scout.freshLabel')} ${freshShown.map((s) => s.bird).join(', ')}` : null,
    standIn ? `${t(locale, 'mail.scout.standIn')}\n${colon(locale, t(locale, 'mail.scout.pickTargetsButton'))} ${eventHref}` : null,
    targetPlaces.length ? [`${colon(locale, t(locale, 'mail.scout.placesHeading'))}`, bullets(targetPlaces), ...moreText(moreTargets)].join('\n') : null,
    noneSeen ? t(locale, recentDays === 7 ? 'mail.scout.noneSeenWeek' : 'mail.scout.noneSeen') : null,
    missing || null,
    thisWeek ? (fallback.length ? [`${colon(locale, t(locale, 'mail.scout.thisWeekHeading'))}`, bullets(fallback), ...moreText(moreFallback)].join('\n') : `${colon(locale, t(locale, 'mail.scout.thisWeekHeading'))}\n${t(locale, 'mail.scout.thisWeekNone')}`) : null,
    noTargets ? `${t(locale, 'mail.scout.pickTargetsInvite')} ${eventHref}` : null,
    `${colon(locale, t(locale, group ? 'mail.scout.groupRouteHeading' : 'mail.scout.routeHeading'))}\n${saved ? routeText(saved, locale, unit) : `${t(locale, 'mail.scout.noRoute')} ${colon(locale, t(locale, 'mail.scout.planRouteButton'))} ${routeHref}`}`,
    `${colon(locale, t(locale, 'mail.scout.openEvent'))} ${scoutingHref}`,
    ...(requested ? [] : [`${colon(locale, t(locale, 'mail.scout.unsubscribe'))} ${m.unsubscribeLink(user, 'trip_emails_enabled')}`]),
    t(locale, 'mail.ebirdCreditText')
  ].filter(Boolean).join('\n\n')

  return {
    to: user.email,
    bulk: true,
    // Asked for with the button, so no unsubscribe; the daily report has Gmail's one-click one.
    ...(requested ? {} : { headers: m.listUnsubscribe(user, 'trip_emails_enabled') }),
    subject,
    text,
    html: m.layout({
      locale,
      heading: h(heading),
      intro: group ? h(t(locale, 'mail.scout.withGroup')) : null,
      body: html,
      ebird: true,
      // Asked for, so not one of the trip emails to turn off.
      footerLinks: requested ? [] : [{ href: m.unsubscribeLink(user, 'trip_emails_enabled'), label: t(locale, 'mail.scout.unsubscribe') }]
    })
  }
}

module.exports = { scoutingMessage, scoutSummary, subjectOf, rarerFirst, itineraryLines, duration, birdOfTheDay, placesOf, freshOf, freshness, wallClock, MAX_PLACES }
