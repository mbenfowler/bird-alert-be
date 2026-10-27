const db = require('./db')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')
const { createSystemShare } = require('./shares')
const { sendMail, layout } = require('./mailer')
const { today, addDays } = require('./seasonality')

/**
 * The HQ desk: each morning, the country's best rarities, ready to post. eBird calls a sighting
 * notable when it is rare for its county, so the national feed is mostly local oddities. The
 * headliners show up differently: many separate checklists in one state as birders go and chase
 * the bird, reviewers confirming it, and the bird being notable in only a state or two. Ranked
 * that way, with drafts and share links, it lands in the owner's inbox; a person still posts.
 */
const MAX_PICKS = 8
const REPEAT_DAYS = 5

const isWholeSpecies = (name) => !/[()/]| x | sp\.$|Domestic/.test(name || '')

/** Pure: notable records to ranked picks, one per bird per state, each with its best public place. */
const pickRarities = (records, { max = MAX_PICKS } = {}) => {
  const statesFor = new Map()
  for (const o of records) {
    if (!statesFor.has(o.speciesCode)) statesFor.set(o.speciesCode, new Set())
    statesFor.get(o.speciesCode).add(o.subnational1Code)
  }
  const groups = new Map()
  for (const o of records) {
    if (!isWholeSpecies(o.comName) || o.obsValid === false || !o.subnational1Code) continue
    const key = `${o.speciesCode}|${o.subnational1Code}`
    const g = groups.get(key) || { speciesCode: o.speciesCode, comName: o.comName, sciName: o.sciName, state: o.subnational1Code, stateName: o.subnational1Name, subs: new Set(), confirmed: new Set(), observers: new Set(), places: new Map(), latest: null }
    g.subs.add(o.subId)
    if (o.obsReviewed && o.obsValid) g.confirmed.add(o.subId)
    if (o.userDisplayName) g.observers.add(o.userDisplayName)
    // Only public places are ever named; someone's yard counts toward the chase but is never posted.
    if (!o.locationPrivate) {
      const p = g.places.get(o.locId) || { locId: o.locId, locName: o.locName, county: o.subnational2Name, lat: o.lat, lng: o.lng, subs: new Set(), latest: null }
      p.subs.add(o.subId)
      if (!p.latest || o.obsDt > p.latest.obsDt) p.latest = { obsDt: o.obsDt, subId: o.subId, howMany: o.howMany ?? null }
      g.places.set(o.locId, p)
    }
    if (!g.latest || o.obsDt > g.latest) g.latest = o.obsDt
    groups.set(key, g)
  }
  const picks = []
  for (const g of groups.values()) {
    const checklists = g.subs.size
    const confirmed = g.confirmed.size
    const states = statesFor.get(g.speciesCode)?.size ?? 1
    if (!g.places.size) continue
    // One report is enough only when it's confirmed and the bird is rare beyond a state or two.
    if (checklists < 2 && !(confirmed && states <= 2)) continue
    const place = [...g.places.values()].sort((a, b) => b.subs.size - a.subs.size || (b.latest.obsDt).localeCompare(a.latest.obsDt))[0]
    // A bird notable in many states at once is an irruption (finches, scoters on the move), news but not a rarity.
    const spread = states <= 2 ? 4 : states <= 4 ? 1 : states >= 8 ? -4 : 0
    const score = Math.round((2 * Math.log2(1 + checklists) + (confirmed ? 3 : 0) + spread + (g.observers.size >= 3 ? 1 : 0)) * 10) / 10
    picks.push({
      speciesCode: g.speciesCode, comName: g.comName, sciName: g.sciName, state: g.state, stateName: g.stateName,
      checklists, confirmed, observers: g.observers.size, states, score, latest: g.latest,
      place: { locId: place.locId, locName: place.locName, county: place.county, lat: place.lat, lng: place.lng, obsDt: place.latest.obsDt, subId: place.latest.subId, howMany: place.latest.howMany }
    })
  }
  return picks.sort((a, b) => b.score - a.score || b.checklists - a.checklists).slice(0, max)
}

const whenWords = (obsDt, asOf) => {
  const day = String(obsDt || '').slice(0, 10)
  if (day === asOf) return 'reported today'
  if (day === addDays(asOf, -1)) return 'reported yesterday'
  return `reported ${new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}
const tag = (name) => String(name || '').replace(/[^A-Za-z]/g, '')

/** A post under 280 characters: the bird, the place, how solid the report is, the link (which unfurls with the photo). */
const draftPost = (pick, url, asOf = today()) => {
  const lines = [
    `🚨 ${pick.comName} in ${pick.stateName}`,
    `📍 ${pick.place.locName.replace(/--/g, ' – ')}${pick.place.county ? `, ${pick.place.county} Co.` : ''}`,
    `🗓 ${whenWords(pick.latest, asOf)} · ${pick.checklists} ${pick.checklists === 1 ? 'checklist' : 'checklists'}${pick.confirmed ? ', confirmed' : ''}`,
    url,
    `via eBird #birding #rarebird #${tag(pick.stateName)}birds`
  ]
  let text = lines.join('\n')
  if (text.length > 280) text = lines.slice(0, 4).join('\n')
  return text
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const pickHtml = (p, i) => `
  <div style="border:2px solid #111;border-radius:12px;padding:14px;margin:0 0 14px;background:#fff">
    <p style="margin:0;font-size:12px;color:#4f4f4f">#${i + 1} · score ${p.score}</p>
    <p style="margin:2px 0 4px;font-size:18px;font-weight:700">${p.photo ? `<img src="${escapeHtml(p.photo)}" alt="" width="56" height="56" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:8px">` : ''}${escapeHtml(p.comName)} · ${escapeHtml(p.stateName)}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#2b2b2b">${escapeHtml(p.place.locName)}${p.place.county ? `, ${escapeHtml(p.place.county)} County` : ''} · ${p.checklists} checklists, ${p.observers} observers, ${p.confirmed ? `${p.confirmed} confirmed` : 'not yet reviewed'}${p.states <= 2 ? ' · notable in only ' + p.states + (p.states === 1 ? ' state' : ' states') : ''}</p>
    <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f3f3;border-radius:8px;padding:10px;margin:0 0 8px">${escapeHtml(p.draft)}</pre>
    <p style="margin:0;font-size:13px"><a href="${escapeHtml(p.url)}">Share page</a> · ${p.place.subId ? `<a href="https://ebird.org/checklist/${escapeHtml(p.place.subId)}">The checklist on eBird</a> · ` : ''}<a href="https://ebird.org/species/${escapeHtml(p.speciesCode)}/${escapeHtml(p.state)}">${escapeHtml(p.comName)} in ${escapeHtml(p.stateName)} on eBird</a></p>
  </div>`

/** The morning run: rank, skip birds pitched in the last few days, make share links, store, email the owner. Mondays add the week's top five. */
const runHqDesk = async ({ asOf = today(), send = sendMail, records = null } = {}) => {
  const all = records || await ebird.nationalNotable(2)
  const recent = new Set((await db('hq_picks').where('day', '>=', addDays(asOf, -REPEAT_DAYS)).where('day', '<', asOf).select('species_code', 'state')).map((r) => `${r.species_code}|${r.state}`))
  const ranked = pickRarities(all, { max: MAX_PICKS * 2 }).filter((p) => !recent.has(`${p.speciesCode}|${p.state}`)).slice(0, MAX_PICKS)
  const birds = new Map((await findOrCreateBirds(ranked.map((p) => p.speciesCode)).catch(() => [])).map((b) => [b.speciesCode, b]))
  const picks = []
  for (const p of ranked) {
    let url = null
    let shareId = null
    if (birds.has(p.speciesCode)) {
      try {
        const share = await createSystemShare({ speciesCode: p.speciesCode, locName: p.place.locName, lat: p.place.lat, lng: p.place.lng, obsDt: p.place.obsDt, howMany: p.place.howMany, subId: p.place.subId, regionName: p.stateName })
        url = share.url
        shareId = share.id
      } catch (error) { console.error(`HQ share for ${p.speciesCode}:`, error.message) }
    }
    url = url || `https://ebird.org/species/${p.speciesCode}/${p.state}`
    const pick = { ...p, url, photo: birds.get(p.speciesCode)?.birdImg || null, draft: draftPost(p, url, asOf) }
    picks.push(pick)
    await db('hq_picks').insert({ day: asOf, species_code: p.speciesCode, state: p.state, score: p.score, share_id: shareId, detail: JSON.stringify(pick) }).onConflict(['day', 'species_code', 'state']).merge()
  }
  const monday = new Date(`${asOf}T12:00:00Z`).getUTCDay() === 1
  const week = monday ? (await db('hq_picks').where('day', '>=', addDays(asOf, -7)).where('day', '<', asOf).orderBy('score', 'desc').limit(5).select('detail')).map((r) => r.detail) : []

  const to = process.env.FEEDBACK_TO || process.env.APP_EMAIL
  if (to && picks.length) {
    const subject = `HQ desk: ${picks.length} rarities for ${asOf}${monday && week.length ? ' + the week’s top 5' : ''}`
    const roundup = week.length ? `<h2 style="font-size:17px;margin:20px 0 8px">Mega Monday: the week’s top ${week.length}</h2><ol style="padding-left:20px">${week.map((w) => `<li>${escapeHtml(w.comName)} in ${escapeHtml(w.stateName)} (${w.checklists} checklists) · <a href="${escapeHtml(w.url)}">link</a></li>`).join('')}</ol>` : ''
    await send({
      to,
      subject,
      text: picks.map((p, i) => `#${i + 1} ${p.comName} (${p.stateName}) score ${p.score}\n${p.draft}\n`).join('\n'),
      html: layout({ heading: 'Today’s rarities', intro: 'Ranked by how many birders chased it, whether reviewers confirmed it, and how few states it’s notable in. Copy a draft, check the checklist, post.', body: picks.map(pickHtml).join('') + roundup })
    })
  }
  return { day: asOf, considered: all.length, picks: picks.length, weekly: week.length }
}

module.exports = { pickRarities, draftPost, runHqDesk, isWholeSpecies }
