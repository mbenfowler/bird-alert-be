const db = require('./db')
const { withCredits, isFresh } = require('./finderCredit')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')
const { createSystemShare } = require('./shares')
const { sendMail, layout } = require('./mailer')
const { sendToUser } = require('./push')
const { formatObsDt } = require('./notifications')
const { appUrl } = require('./appUrl')
const { allCodes, abaCode, CODE_WORDS } = require('./abaCodes')
const { sixOf } = require('./megaPost')
const { pickRarities, drafts, shareInput, facebookHtml, isWholeSpecies, isRejected, countyText, countryOfState, escapeHtml } = require('./hqDesk')

/**
 * The HQ desk's instant alert: once an hour, every report of a bird the ABA Checklist calls Code 4,
 * 5 or 6 (not every year, a few records ever, gone from the ABA Area) goes straight to the owner, by
 * push and email, with the morning desk's share link and drafted post, so a one-day bird can be
 * posted while it's there. A Code 6 says what eBird makes of the birds (exoticCategory): native
 * ones would be a rediscovery, introduced ones a feral or escaped population. A Code 6 reported only
 * from a private place gets a heads-up with no place and no post.
 *
 * Only the US and Canada: the ABA Area, so a Mexican bird has no code. eBird's API says nothing of a
 * state's first record, so that can't be a trigger. Two calls an hour (one per country).
 */
const ALERT_DAYS = 7
const POST_CODES = new Set([4, 5, 6])
const COUNTRIES = ['US', 'CA']

/** The last day's notable reports in the US and Canada; a country eBird can't serve this hour is left out. */
const recentNotable = async () => {
  const results = await Promise.allSettled(COUNTRIES.map((country) => ebird.countryNotable(country, 1)))
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(`HQ alerts: notable for ${COUNTRIES[i]} failed:`, r.reason?.message) })
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
}

/**
 * Pure: the reports worth telling the owner about now. `post` are Codes 4-6 from their first report,
 * awaiting review or confirmed (never rejected), each with its best public place; `extinct` are Code 6
 * reports with no public place, one per bird per state, with no place named (it may be someone's
 * yard) and no post.
 */
const findAlerts = (records, codeOf) => {
  const covered = records.filter((o) => COUNTRIES.includes(countryOfState(o.subnational1Code)))
  const post = pickRarities(covered, { max: 50, codeOf, lone: true, pending: true, six: true }).filter((p) => POST_CODES.has(p.aba))
  const posted = new Set(post.map((p) => `${p.speciesCode}|${p.state}`))
  const extinct = new Map()
  for (const o of covered) {
    if (!isWholeSpecies(o.comName) || isRejected(o) || !o.subnational1Code) continue
    if (codeOf({ sciName: o.sciName, comName: o.comName }) !== 6) continue
    const key = `${o.speciesCode}|${o.subnational1Code}`
    if (posted.has(key)) continue
    const seen = extinct.get(key)
    if (!seen || o.obsDt > seen.obsDt) {
      extinct.set(key, { speciesCode: o.speciesCode, comName: o.comName, state: o.subnational1Code, stateName: o.subnational1Name, county: o.subnational2Name, obsDt: o.obsDt, subId: o.subId, aba: 6, checklists: (seen?.checklists ?? 0) + 1 })
    } else seen.checklists += 1
  }
  return { post, extinct: [...extinct.values()] }
}

/**
 * Where an alert goes: the email to the address the HQ desk mails, the push to the devices of the
 * owner's Bird Alert account. That account can sign in with another address than the desk mails,
 * so HQ_PUSH_EMAIL names it (kept in the environment, not in this public code); without it, the
 * desk's own address is tried.
 */
const ownerAccount = async () => {
  const to = process.env.FEEDBACK_TO || process.env.APP_EMAIL || null
  const login = process.env.HQ_PUSH_EMAIL || to
  const user = login ? await db('users').whereRaw('lower(email) = ?', [String(login).trim().toLowerCase()]).first('id') : null
  return { to, user: user || null }
}

/**
 * What eBird makes of a Code 6 bird in its state: its exoticCategory (N naturalized, P provisional,
 * X escaped) on this report, else on any recent one; null for a native bird or when eBird can't say.
 * The notable feed doesn't carry it; the species' recent feed does.
 */
const exoticOf = async (p) => {
  const rows = await ebird.speciesObservations(p.state, p.speciesCode, ALERT_DAYS, { provisional: true }).catch(() => [])
  const list = Array.isArray(rows) ? rows : []
  const mine = list.find((o) => o.subId === p.place.subId && o.exoticCategory) || list.find((o) => o.exoticCategory)
  return mine ? mine.exoticCategory : null
}

const SIX_NOTE = { N: 'introduced, established', P: 'exotic, provisional', X: 'escaped birds' }
/** The push title's code: "ABA Code 4"; a Code 6 says which kind ("possible rediscovery", "exotic, provisional"). */
const codeTitle = (p) => (p.aba !== 6 ? `ABA Code ${p.aba}` : `ABA Code 6 (${SIX_NOTE[p.exotic] || 'possible rediscovery'})`)

/** The email's opening line, from the code (and, for a Code 6, what eBird makes of the birds). */
const intro = (p) => {
  if (p.aba !== 6) return `${CODE_WORDS[p.aba][0].toUpperCase()}${CODE_WORDS[p.aba].slice(1)} in the ABA Area. Just reported; check the checklist, then post while it’s there.`
  if (!p.exotic) return 'Believed extinct or gone from the ABA Area: a rediscovery if it holds up. Unconfirmed, so read the checklist closely before posting.'
  return `${sixOf(p).line} Just reported; check the checklist, then post while it’s there.`
}

const status = (p) => (p.confirmed ? `confirmed on ${p.confirmed} of ${p.checklists}` : `${p.checklists} ${p.checklists === 1 ? 'checklist' : 'checklists'}, awaiting review`)

const postPush = (p, url, photo) => ({
  title: `🚨 ${codeTitle(p)}: ${p.comName} in ${p.stateName}`,
  body: [`${p.place.locName.replace(/--/g, ' – ')}${countyText(p, true)}`, formatObsDt(p.place.obsDt), status(p)].join(' · '),
  icon: photo || appUrl('/images/bird.png'),
  badge: appUrl('/images/bird.png'),
  tag: `hq-${p.speciesCode}-${p.state}`,
  requireInteraction: true,
  data: { kind: 'hq', url, ebirdUrl: `https://ebird.org/checklist/${encodeURIComponent(p.place.subId)}` }
})

const extinctPush = (e) => ({
  title: `🚨 ABA Code 6: ${e.comName} reported in ${e.stateName}`,
  body: `Gone from the ABA Area (extinct or extirpated). Reported from a private place: a rediscovery, an escaped bird or a mistake; check the checklist. ${formatObsDt(e.obsDt)}`,
  icon: appUrl('/images/bird.png'),
  badge: appUrl('/images/bird.png'),
  tag: `hq-${e.speciesCode}-${e.state}`,
  data: { kind: 'hq', url: `https://ebird.org/checklist/${encodeURIComponent(e.subId)}`, ebirdUrl: `https://ebird.org/checklist/${encodeURIComponent(e.subId)}` }
})

const button = (href, label) => `<a href="${escapeHtml(href)}" style="display:inline-block;padding:8px 18px;border:2px solid #111;border-radius:999px;background:#ffd700;color:#111;font-weight:700;text-decoration:none;margin:0 6px 6px 0">${escapeHtml(label)}</a>`

const postEmail = (p) => ({
  subject: `HQ alert: ${codeTitle(p)} ${p.comName} in ${p.stateName}`,
  text: `${p.comName} in ${p.stateName}, ${codeTitle(p)} (${CODE_WORDS[p.aba]}). ${intro(p)}\n${p.place.locName}${countyText(p)} · ${formatObsDt(p.place.obsDt)} · ${status(p)}\n\n${p.draft}${p.fbDraft ? `\n\nFor Facebook:\n${p.fbDraft}` : ''}\n\nChecklist: https://ebird.org/checklist/${p.place.subId}`,
  html: layout({
    heading: `${escapeHtml(codeTitle(p))}: ${escapeHtml(p.comName)} in ${escapeHtml(p.stateName)}`,
    intro: escapeHtml(intro(p)),
    body: `<p style="margin:0 0 8px;font-size:16px">${p.photo ? `<img src="${escapeHtml(p.photo)}" alt="" width="56" height="56" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:8px">` : ''}${escapeHtml(p.place.locName)}${escapeHtml(countyText(p))} · ${escapeHtml(formatObsDt(p.place.obsDt))}</p>
      <p style="margin:0 0 10px;font-size:14px;color:#2b2b2b">${escapeHtml(status(p))}${p.observers ? ` · ${p.observers} ${p.observers === 1 ? 'observer' : 'observers'}` : ''}</p>
      <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f3f3;border-radius:8px;padding:10px;margin:0 0 10px">${escapeHtml(p.draft)}</pre>
      <p style="margin:0 0 6px">${button(`https://x.com/intent/post?text=${encodeURIComponent(p.draft)}`, 'Post on X')}${button(`https://ebird.org/checklist/${p.place.subId}`, 'The checklist on eBird')}</p>${facebookHtml(p)}
      <p style="margin:0;font-size:13px"><a href="${escapeHtml(p.url)}">Share page</a> · <a href="https://ebird.org/species/${escapeHtml(p.speciesCode)}/${escapeHtml(p.state)}">${escapeHtml(p.comName)} in ${escapeHtml(p.stateName)} on eBird</a></p>
      <p style="font-size:12px;color:#4f4f4f;margin-top:16px">Rarity codes: ABA Checklist, used with permission of the American Birding Association.</p>`,
    ebird: true
  })
})

const extinctEmail = (e) => ({
  subject: `HQ alert: ABA Code 6 ${e.comName} reported in ${e.stateName}`,
  text: `ABA Code 6 (gone from the ABA Area): ${e.comName}, ${e.stateName}${e.county ? ` (${e.county})` : ''}, ${formatObsDt(e.obsDt)}.\nReported from a private place, so there's no place to post. A rediscovery, an escaped bird or a mistake: check the checklist.\nhttps://ebird.org/checklist/${e.subId}`,
  html: layout({
    heading: `ABA Code 6: ${escapeHtml(e.comName)} in ${escapeHtml(e.stateName)}`,
    intro: 'Gone from the ABA Area (extinct or extirpated). Reported from a private place, so there’s no place to post: a rediscovery, an escaped bird or a mistake. Check the checklist.',
    body: `<p style="margin:0 0 10px;font-size:15px">${escapeHtml(e.stateName)}${e.county ? `, ${escapeHtml(e.county)}` : ''} · ${escapeHtml(formatObsDt(e.obsDt))} · ${e.checklists} ${e.checklists === 1 ? 'checklist' : 'checklists'}</p>
      <p style="margin:0">${button(`https://ebird.org/checklist/${e.subId}`, 'The checklist on eBird')}</p>`,
    ebird: true
  })
})

/**
 * The hourly run. Each bird is told once per state a week (hq_alerts), and recorded before it's
 * sent, so a failing send can't repeat every hour. Returns counts only (the logs are public).
 */
// `credit` looks up who found each bird (one call per state); off when records are handed in (tests), unless asked.
// `exotic` asks eBird what it makes of a Code 6 bird; off when records are handed in, unless given.
const runHqAlerts = async ({ records = null, send = sendMail, push = sendToUser, now = new Date(), codes: given = null, credit = records ? null : withCredits, exotic = records ? null : exoticOf } = {}) => {
  const codes = given || await allCodes()
  if (!codes.bySci.size) return { skipped: 'no ABA codes on file' }
  const all = records || await recentNotable()
  const { post, extinct } = findAlerts(all, (g) => abaCode(codes, g))
  const since = new Date(now.getTime() - ALERT_DAYS * 86_400_000)
  const told = new Set((await db('hq_alerts').where('alerted_at', '>', since).select('species_code', 'state')).map((r) => `${r.species_code}|${r.state}`))
  const fresh = (x) => !told.has(`${x.speciesCode}|${x.state}`)
  // Only fresh finds ping: a bird first reported at its place more than a few days ago is still
  // around, not news (the morning desk's "Still around" has it). The 30-day history behind the
  // finder credit says which; with no history to go on, it counts as fresh.
  const asOf = now.toISOString().slice(0, 10)
  const unseen = post.filter(fresh)
  const credited = credit && unseen.length ? await credit(unseen, { asOf }).catch(() => unseen) : unseen
  const newPost = credited.filter(isFresh)
  const unseen6 = extinct.filter(fresh)
  const credited6 = credit && unseen6.length ? await credit(unseen6, { asOf }).catch(() => unseen6) : unseen6
  const newExtinct = credited6.filter(isFresh)
  const continuing = credited.length - newPost.length + credited6.length - newExtinct.length
  if (!newPost.length && !newExtinct.length) return { considered: all.length, post: 0, extinct: 0, continuing }

  const { to, user } = await ownerAccount()
  const deliver = async (pushPayload, mail) => {
    if (user) await push(user.id, pushPayload).catch((error) => console.error('HQ alert push failed:', error.message))
    if (to) await send({ to, ...mail }).catch((error) => console.error('HQ alert email failed:', error.message))
  }
  const birds = new Map((await findOrCreateBirds(newPost.map((p) => p.speciesCode)).catch(() => [])).map((b) => [b.speciesCode, b]))
  for (const p of newPost) {
    await db('hq_alerts').insert({ species_code: p.speciesCode, state: p.state, aba: p.aba, first_sub_id: p.place.subId, alerted_at: now })
    let url = `https://ebird.org/species/${p.speciesCode}/${p.state}`
    if (birds.has(p.speciesCode)) {
      try {
        url = (await createSystemShare(shareInput(p))).url
      } catch (error) { console.error(`HQ alert share for ${p.speciesCode}:`, error.message) }
    }
    const photo = birds.get(p.speciesCode)?.birdImg || null
    const kind = p.aba === 6 && exotic ? await exotic(p).catch(() => null) : null
    const alert = { ...p, exotic: kind, url, photo, ...drafts({ ...p, exotic: kind }, url, asOf) }
    await deliver(postPush(alert, url, photo), postEmail(alert))
  }
  for (const e of newExtinct) {
    await db('hq_alerts').insert({ species_code: e.speciesCode, state: e.state, aba: 6, first_sub_id: e.subId, alerted_at: now })
    await deliver(extinctPush(e), extinctEmail(e))
  }
  return { considered: all.length, post: newPost.length, extinct: newExtinct.length, continuing, pushed: Boolean(user), emailed: Boolean(to) }
}

module.exports = { runHqAlerts, findAlerts, recentNotable, ALERT_DAYS }
