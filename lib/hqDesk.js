const db = require('./db')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')
const { createSystemShare } = require('./shares')
const { sendMail, layout } = require('./mailer')
const { today, addDays } = require('./seasonality')
const { signToken, verifyToken } = require('./tokens')
const { appUrl } = require('./appUrl')
const { postToX, whoAmI } = require('./xPoster')
const { chase } = require('./chase')
const { allCodes, abaCode, CODE_BONUS, CODE_WORDS } = require('./abaCodes')
const { COUNTRIES } = require('./regions')
const { adminStats, adminSection } = require('./adminStats')

/**
 * The HQ desk: each morning, the best rarities in every country the app covers, ready to post. eBird calls a sighting
 * notable when it is rare for its county, so the national feed is mostly local oddities. The
 * headliners show up differently: many separate checklists in one state as birders go and chase
 * the bird, reviewers confirming it, and the bird being notable in only a state or two. Ranked
 * that way, with drafts and share links, it lands in the owner's inbox; a person still posts.
 */
const MAX_PICKS = 8
const REPEAT_DAYS = 5
// "Still there?" for each candidate before it's pitched: a few checklists each, four birds at a time,
// and never more than this long in all (the whole run has 60 seconds).
const CHASE_LOOKS = 4
const CHASE_PARALLEL = 4
const CHASE_BUDGET_MS = 20_000
// Two quiet checklists can miss a skulker that's still there; a bird is left out from the third.
const GONE_AFTER_MISSES = 3
const isGone = (p) => p.still?.verdict === 'gone' && p.still.missesSince >= GONE_AFTER_MISSES

const isWholeSpecies = (name) => !/[()/]| x | sp\.$|Domestic/.test(name || '')

/** A report eBird's reviewers turned down; one awaiting review (valid false, not yet reviewed) is not. */
const isRejected = (o) => o.obsValid === false && o.obsReviewed === true

/**
 * Pure: notable records to ranked picks, one per bird per state, each with its best public place.
 * `lone` counts a bird from its first report (the instant alert), where the morning desk wants a
 * chase or a confirmation; `pending` keeps reports still awaiting review, which is how a true rarity
 * looks for its first day or two. Code 6 (extinct or extirpated) is never a pick: the instant
 * heads-up covers it, with no post.
 */
const pickRarities = (records, { max = MAX_PICKS, codeOf = () => null, lone = false, pending = false } = {}) => {
  const statesFor = new Map()
  for (const o of records) {
    if (!statesFor.has(o.speciesCode)) statesFor.set(o.speciesCode, new Set())
    statesFor.get(o.speciesCode).add(o.subnational1Code)
  }
  const groups = new Map()
  for (const o of records) {
    if (!isWholeSpecies(o.comName) || !o.subnational1Code || (pending ? isRejected(o) : o.obsValid === false)) continue
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
    if (!lone && checklists < 2 && !(confirmed && states <= 2)) continue
    const place = [...g.places.values()].sort((a, b) => b.subs.size - a.subs.size || (b.latest.obsDt).localeCompare(a.latest.obsDt))[0]
    // A bird notable in many states at once is an irruption (finches, scoters on the move), news but not a rarity.
    const spread = states <= 2 ? 4 : states <= 4 ? 1 : states >= 8 ? -4 : 0
    // Rare in the whole ABA Area (its Checklist code), not just in its county, ranks above a local oddity.
    const aba = codeOf(g)
    if (aba === 6) continue
    const score = Math.round((2 * Math.log2(1 + checklists) + (confirmed ? 3 : 0) + spread + (g.observers.size >= 3 ? 1 : 0) + (CODE_BONUS[aba] || 0)) * 10) / 10
    picks.push({
      speciesCode: g.speciesCode, comName: g.comName, sciName: g.sciName, state: g.state, stateName: g.stateName,
      checklists, confirmed, observers: g.observers.size, states, score, latest: g.latest, aba,
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
const tag = (name) => String(name || '').normalize('NFD').replace(/[^A-Za-z]/g, '')

/** The eBird state code's country: 'US-GA' -> 'US', 'CA-ON' -> 'CA', 'MX-JAL' -> 'MX'. */
const countryOfState = (code) => String(code || '').slice(0, 2)

/** "Hall County" in the US; elsewhere the area's name stands alone ("Toronto", "Zapopan"). */
const countyText = (pick, short = false) => (!pick.place.county ? '' : countryOfState(pick.state) === 'US' ? `, ${pick.place.county} ${short ? 'Co.' : 'County'}` : `, ${pick.place.county}`)

/** What a state is called in the pick's country, for "notable in only 2 states". */
const stateWord = (pick, n) => `${countryOfState(pick.state) === 'CA' ? 'province' : 'state'}${n === 1 ? '' : 's'}`

/** What the checklists filed at the place since the report say, for a post; null when they say nothing. */
const stillLine = (still) => {
  if (!still || !still.checkedSince) return null
  if (still.missesSince > 0 && still.foundSince === 0) return null
  return still.foundSince === still.checkedSince
    ? `👀 still there: on ${still.checkedSince === 1 ? 'the 1 checklist' : `all ${still.checkedSince} checklists`} since`
    : `👀 on ${still.foundSince} of ${still.checkedSince} checklists since`
}

/** A post under 280 characters: the bird, the place, how solid the report is, the link (which unfurls with the photo). */
const draftPost = (pick, url, asOf = today()) => {
  const lines = [
    `🚨 ${pick.comName} in ${pick.stateName}${pick.aba >= 3 ? ` · ABA Code ${pick.aba}` : ''}`,
    `📍 ${pick.place.locName.replace(/--/g, ' – ')}${countyText(pick, true)}`,
    `🗓 ${whenWords(pick.latest, asOf)} · ${pick.checklists} ${pick.checklists === 1 ? 'checklist' : 'checklists'}${pick.confirmed ? ', confirmed' : ''}`,
    stillLine(pick.still),
    url,
    `via eBird #birding #rarebird #${tag(pick.stateName)}birds`
  ]
  const kept = lines.filter(Boolean)
  let text = kept.join('\n')
  // Too long: the hashtags go first, then the "still there" line.
  if (text.length > 280) text = kept.slice(0, -1).join('\n')
  if (text.length > 280) text = kept.filter((l) => l !== stillLine(pick.still)).slice(0, -1).join('\n')
  // Still too long (a very long place name): shorten the place, never the link.
  if (text.length > 280) {
    const over = text.length - 280 + 1
    text = text.replace(lines[1], `${lines[1].slice(0, Math.max(8, lines[1].length - over))}…`)
  }
  return text
}

const STILL_WORDS = { fresh: 'yes, on the latest checklists', likely: 'likely', maybe: 'maybe', gone: 'probably gone', unknown: 'not reported here lately' }

/**
 * Runs "still there?" on candidates in order until the budget is spent; those it didn't reach keep
 * `still: null` and stay in. Each check is a handful of eBird calls, cached ten minutes.
 */
const checkStillThere = async (candidates, { check = chase, budgetMs = CHASE_BUDGET_MS } = {}) => {
  const stopAt = Date.now() + budgetMs
  const out = candidates.map((p) => ({ ...p, still: null }))
  let next = 0
  const worker = async () => {
    while (next < out.length && Date.now() < stopAt) {
      const p = out[next++]
      try { p.still = await check({ locId: p.place.locId, code: p.speciesCode, cls: 'rare', maxLooks: CHASE_LOOKS }) } catch { p.still = null }
    }
  }
  await Promise.all(Array.from({ length: CHASE_PARALLEL }, worker))
  return out
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// "Post on X" opens X's own composer with the draft filled in (free, and editable before it goes).
// Posting straight through X's API costs credits, so that button shows only when X_POSTING=api.
const pickHtml = (p, i) => `
  <div style="border:2px solid #111;border-radius:12px;padding:14px;margin:0 0 14px;background:#fff">
    <p style="margin:0;font-size:12px;color:#4f4f4f">#${i + 1} · score ${p.score}${p.aba ? ` · ABA Code ${p.aba} (${CODE_WORDS[p.aba]})` : ''}</p>
    <p style="margin:2px 0 4px;font-size:18px;font-weight:700">${p.photo ? `<img src="${escapeHtml(p.photo)}" alt="" width="56" height="56" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:8px">` : ''}${escapeHtml(p.comName)} · ${escapeHtml(p.stateName)}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#2b2b2b">${escapeHtml(p.place.locName)}${escapeHtml(countyText(p))} · ${p.checklists} checklists, ${p.observers} observers, ${p.confirmed ? `${p.confirmed} confirmed` : 'not yet reviewed'}${p.states <= 2 ? ` · notable in only ${p.states} ${stateWord(p, p.states)}` : ''}</p>
    ${p.still ? `<p style="margin:0 0 8px;font-size:14px;color:#2b2b2b"><strong>Still there?</strong> ${escapeHtml(STILL_WORDS[p.still.verdict] || '')}${p.still.checkedSince ? ` · ${p.still.foundSince} of ${p.still.checkedSince} checklists since had it` : ' · no checklists since'}</p>` : ''}
    <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f3f3;border-radius:8px;padding:10px;margin:0 0 8px">${escapeHtml(p.draft)}</pre>
    <p style="margin:0 0 10px"><a href="${escapeHtml(p.intentUrl)}" style="display:inline-block;padding:8px 18px;border:2px solid #111;border-radius:999px;background:#ffd700;color:#111;font-weight:700;text-decoration:none">Post on X</a>${process.env.X_POSTING === 'api' ? ` &nbsp; <a href="${escapeHtml(p.approveUrl)}" style="font-size:13px">Post automatically</a>` : ''}</p>
    <p style="margin:0;font-size:13px"><a href="${escapeHtml(p.url)}">Share page</a> · ${p.place.subId ? `<a href="https://ebird.org/checklist/${escapeHtml(p.place.subId)}">The checklist on eBird</a> · ` : ''}<a href="https://ebird.org/species/${escapeHtml(p.speciesCode)}/${escapeHtml(p.state)}">${escapeHtml(p.comName)} in ${escapeHtml(p.stateName)} on eBird</a></p>
  </div>`

/** The morning run: rank, skip birds pitched in the last few days, make share links, store, email the owner. Mondays add the week's top five. */
/** Every covered country's notable reports from the last two days; a country eBird can't serve today is left out, not fatal. */
const notableEverywhere = async () => {
  const results = await Promise.allSettled(COUNTRIES.map((country) => ebird.countryNotable(country, 2)))
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`HQ desk: notable for ${COUNTRIES[i]} failed:`, r.reason?.message) })
  if (results.every((r) => r.status === 'rejected')) throw results[0].reason
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}

const runHqDesk = async ({ asOf = today(), send = sendMail, records = null, force = false, check = chase, stats = adminStats } = {}) => {
  // GitHub runs scheduled jobs late or not at all, so a morning can see a manual run and then the
  // scheduled one; the second finds today's picks and sends nothing. `force` re-sends on purpose.
  if (!force && await db('hq_picks').where({ day: asOf }).first('id')) return { day: asOf, skipped: 'already sent today' }
  const all = records || await notableEverywhere()
  const recent = new Set((await db('hq_picks').where('day', '>=', addDays(asOf, -REPEAT_DAYS)).where('day', '<', asOf).select('species_code', 'state')).map((r) => `${r.species_code}|${r.state}`))
  const codes = await allCodes()
  // The ABA Area is the US and Canada; a Mexican bird has no code.
  const candidates = pickRarities(all, { max: MAX_PICKS * 3, codeOf: (g) => (countryOfState(g.state) === 'MX' ? null : abaCode(codes, g)) }).filter((p) => !recent.has(`${p.speciesCode}|${p.state}`)).slice(0, MAX_PICKS * 2)
  // A bird that has left isn't news: checklists filed since that missed it drop it from the day's picks.
  const checked = await checkStillThere(candidates, { check })
  const gone = checked.filter(isGone)
  const ranked = checked.filter((p) => !isGone(p)).slice(0, MAX_PICKS)
  const birds = new Map((await findOrCreateBirds(ranked.map((p) => p.speciesCode)).catch(() => [])).map((b) => [b.speciesCode, b]))
  const picks = []
  for (const p of ranked) {
    let url = null
    let shareId = null
    if (birds.has(p.speciesCode)) {
      try {
        const share = await createSystemShare({ speciesCode: p.speciesCode, locId: p.place.locId, locName: p.place.locName, lat: p.place.lat, lng: p.place.lng, obsDt: p.place.obsDt, howMany: p.place.howMany, subId: p.place.subId, regionName: p.stateName })
        url = share.url
        shareId = share.id
      } catch (error) { console.error(`HQ share for ${p.speciesCode}:`, error.message) }
    }
    url = url || `https://ebird.org/species/${p.speciesCode}/${p.state}`
    const pick = { ...p, url, photo: birds.get(p.speciesCode)?.birdImg || null, draft: draftPost(p, url, asOf) }
    const [saved] = await db('hq_picks').insert({ day: asOf, species_code: p.speciesCode, state: p.state, score: p.score, share_id: shareId, detail: JSON.stringify(pick) })
      .onConflict(['day', 'species_code', 'state']).merge().returning('id')
    // One-tap approval: a signed link to a confirmation page (scanners that open links never post), good for two days.
    pick.approveUrl = appUrl(`/api/mail/hq-post?token=${encodeURIComponent(signToken('hq-post', { pick: saved.id ?? saved }, 2 * 86400))}`)
    pick.intentUrl = `https://x.com/intent/post?text=${encodeURIComponent(pick.draft)}`
    picks.push(pick)
  }
  const monday = new Date(`${asOf}T12:00:00Z`).getUTCDay() === 1
  const week = monday ? (await db('hq_picks').where('day', '>=', addDays(asOf, -7)).where('day', '<', asOf).orderBy('score', 'desc').limit(5).select('detail')).map((r) => r.detail) : []

  const to = process.env.FEEDBACK_TO || process.env.APP_EMAIL
  // The app's own numbers ride along, so the email goes out even on a day without rarities.
  let admin = null
  try { admin = adminSection(await stats()) } catch (error) { console.error('HQ admin stats:', error.message) }
  if (to && (picks.length || admin)) {
    const subject = picks.length ? `HQ desk: ${picks.length} rarities for ${asOf}${monday && week.length ? ' + the week’s top 5' : ''}` : `HQ desk: no rarities for ${asOf}, app numbers inside`
    const left = gone.length ? `<p style="font-size:13px;color:#4f4f4f;margin:16px 0 0">Left out, probably gone: ${gone.map((g) => `${escapeHtml(g.comName)} in ${escapeHtml(g.stateName)} (${g.still.missesSince} ${g.still.missesSince === 1 ? 'checklist' : 'checklists'} since without it)`).join('; ')}.</p>` : ''
    const roundup = week.length ? `<h2 style="font-size:17px;margin:20px 0 8px">Mega Monday: the week’s top ${week.length}</h2><ol style="padding-left:20px">${week.map((w) => `<li>${escapeHtml(w.comName)} in ${escapeHtml(w.stateName)} (${w.checklists} checklists) · <a href="${escapeHtml(w.url)}">link</a></li>`).join('')}</ol>` : ''
    await send({
      to,
      subject,
      text: picks.map((p, i) => `#${i + 1} ${p.comName} (${p.stateName}) score ${p.score}\n${p.draft}\n`).join('\n') + (admin ? `\n\n${admin.text}` : ''),
      html: layout({ heading: 'Today’s rarities', intro: 'Ranked by how many birders chased it, whether reviewers confirmed it, how few states it’s notable in, and its ABA Checklist code. Copy a draft, check the checklist, post.', body: picks.map(pickHtml).join('') + left + roundup + (codes.bySci.size ? '<p style="font-size:12px;color:#4f4f4f;margin-top:16px">Rarity codes: ABA Checklist, used with permission of the American Birding Association.</p>' : '') + (admin ? admin.html : '') })
    })
  }
  return { day: asOf, considered: all.length, picks: picks.length, gone: gone.length, weekly: week.length }
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#d3d3d3;font-family:system-ui,-apple-system,sans-serif;color:#111;padding:24px 16px}main{max-width:520px;margin:0 auto;background:#fff;border:2px solid #111;border-radius:18px;box-shadow:6px 6px 0 #111;padding:22px}h1{font-size:22px;margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:16px/1.45 system-ui,-apple-system,sans-serif;background:#f3f3f3;border-radius:10px;padding:12px;margin:0 0 16px}button,a.btn{display:inline-block;padding:12px 22px;border:2px solid #111;border-radius:999px;background:#ffd700;color:#111;font:700 16px system-ui,sans-serif;text-decoration:none;cursor:pointer}p{line-height:1.45}img{border-radius:10px;width:72px;height:72px;object-fit:cover;float:right;margin-left:12px}</style></head><body><main>${body}</main></body></html>`

/** The approval page (GET) and the post itself (POST), for one pick from the morning email. */
const approvePost = async ({ method, token }) => {
  let claim = null
  try { claim = verifyToken(String(token || ''), 'hq-post') } catch { claim = null }
  if (!claim?.pick) return page('Link expired', '<h1>This link has expired</h1><p>Approval links last two days. Tomorrow’s email has fresh ones.</p>')
  const row = await db('hq_picks').where({ id: claim.pick }).first()
  if (!row) return page('Not found', '<h1>That pick is gone</h1>')
  const pick = row.detail
  const x = (id) => `https://x.com/BirdAlertHQ/status/${encodeURIComponent(id)}`
  if (row.posted_at) return page('Already posted', `<h1>Already posted ✓</h1><p>${escapeHtml(pick.comName)} in ${escapeHtml(pick.stateName)} went out ${new Date(row.posted_at).toLocaleString('en-US')}.</p>${row.post_id ? `<p><a class="btn" href="${x(row.post_id)}">See it on X</a></p>` : ''}`)
  if (method !== 'POST') {
    const who = await whoAmI()
    return page(`Post ${pick.comName}?`, `${pick.photo ? `<img src="${escapeHtml(pick.photo)}" alt="">` : ''}<h1>Post this to @BirdAlertHQ?</h1><pre>${escapeHtml(pick.draft)}</pre>
${who.ok ? `<p style="color:#0b5c2b;font-weight:600">Posting as @${escapeHtml(who.username)} ✓</p><form method="post" action="?token=${encodeURIComponent(token)}"><button type="submit">Post to @${escapeHtml(who.username)}</button></form>` : `<p><strong>Not connected to X.</strong> ${escapeHtml(who.reason)}</p>`}
<p><a href="${escapeHtml(pick.intentUrl || `https://x.com/intent/post?text=${encodeURIComponent(pick.draft)}`)}">Edit it first, in X</a></p>`)
  }
  // Claim the pick before posting, so a double tap can't post twice.
  const claimed = await db('hq_picks').where({ id: row.id }).whereNull('posted_at').update({ posted_at: db.fn.now() })
  if (!claimed) return page('Already posted', '<h1>Already posted ✓</h1>')
  try {
    const id = await postToX(pick.draft)
    await db('hq_picks').where({ id: row.id }).update({ post_id: id || null })
    return page('Posted', `<h1>Posted ✓</h1><p>${escapeHtml(pick.comName)} in ${escapeHtml(pick.stateName)} is live.</p>${id ? `<p><a class="btn" href="${x(id)}">See it on X</a></p>` : ''}`)
  } catch (error) {
    await db('hq_picks').where({ id: row.id }).update({ posted_at: null })
    return page('Not posted', `<h1>That didn’t post</h1><p>${escapeHtml(error.message)}</p><p>Nothing went out; you can try again.</p>`)
  }
}

module.exports = { notableEverywhere, pickRarities, draftPost, runHqDesk, isWholeSpecies, isRejected, approvePost, checkStillThere, stillLine, countyText, countryOfState, escapeHtml }
