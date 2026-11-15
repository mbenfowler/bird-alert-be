const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { inQuietHours } = require('./quietHours')
const { reviewNotification } = require('./notifications')
const { withEvidence, nearby } = require('./evidence')
const { langFor } = require('./i18n')
const { inLanguage } = require('./birdNames')

/**
 * Following up on rare birds people were told of before eBird's reviewers had looked, whatever
 * their code, and however they were told: a push, the morning email, or the HQ desk's alert.
 *
 * Each such report is kept once (rare_reports) with what was known when it went out. Every hour,
 * each county with a report still open is asked for its notable reports of the last 30 days (one
 * call per county), and the bird at that spot is judged, not the one checklist: any report of it
 * there confirmed by a reviewer confirms it (lib/evidence). Still awaiting review, it waits. Gone
 * from eBird altogether, and still gone a few hours later (eBird's feeds sometimes drop a report for
 * a while), it was withdrawn or not accepted. Open after FOLLOW_DAYS, it's left unsettled.
 *
 * Who hears: a confirmation goes by push to those told by push while the bird may still be there
 * (CHASE_DAYS), after their quiet hours; the morning email lists both endings since it last wrote
 * (updatesFor); the HQ desk's owner gets a confirmation with fresh drafts, and a note when one is
 * gone, so it isn't posted. Kept for a while after, rare_reports is also how we learn which reports
 * hold up (photo, birders, a description, the code, the state).
 */
const FOLLOW_DAYS = 14
const CHASE_DAYS = 3
// A report missing from the feed this long is gone, not a hiccup in eBird's feeds.
const GONE_AFTER_HOURS = 6
// Reports older than CHASE_DAYS are checked on hours divisible by this.
const SLOW_EVERY_HOURS = 6
// The morning email lists what settled in this many days and hasn't been mailed.
const MAIL_DAYS = 30
const KEEP_DAYS = 180
// Checklists read for their notes per call, and the time that may take.
const NOTES_PER_CALL = 12
const NOTES_BUDGET_MS = 8000

const keyOf = (o) => `${o.speciesCode}:${o.subId}`

/**
 * Remembers that `userId` was told of these reports by `via` ('push' or 'email'); only reports
 * still awaiting review are followed. `region` is where the alert looked, for reports without a county.
 */
const follow = async (userId, via, reports, region = null) => {
  const open = reports.filter((o) => o.evidence && !o.evidence.confirmed && o.subId && o.speciesCode)
  if (!open.length) return []
  const ids = await trackReports(open, region)
  if (userId) {
    await db('report_follows').insert(ids.map((reportId) => ({ report_id: reportId, user_id: userId, via })))
      .onConflict(['report_id', 'user_id', 'via']).ignore()
  }
  return ids
}

/** rare_reports rows for these reports (made the first time), their ids in the same order. */
const trackReports = async (reports, region = null) => {
  const rows = reports.map((o) => ({
    species_code: o.speciesCode,
    sub_id: o.subId,
    loc_id: o.locId || null,
    loc_name: o.locName ? String(o.locName).slice(0, 200) : null,
    region: o.subnational2Code || o.away?.region || region || o.subnational1Code,
    aba: Number.isInteger(o.aba) ? o.aba : null,
    obs_dt: o.obsDt ? String(o.obsDt).slice(0, 16) : null,
    lat: Number.isFinite(o.lat) ? o.lat : null,
    lng: Number.isFinite(o.lng) ? o.lng : null,
    media: Boolean(o.evidence?.media),
    birders: o.evidence?.birders || 1,
    described: typeof o.evidence?.described === 'boolean' ? o.evidence.described : null
  })).filter((r) => r.region)
  if (!rows.length) return []
  const saved = await db('rare_reports').insert(rows).onConflict(['species_code', 'sub_id'])
    .merge({ aba: db.raw('coalesce(rare_reports.aba, excluded.aba)'), described: db.raw('coalesce(rare_reports.described, excluded.described)') })
    .returning(['id', 'species_code', 'sub_id'])
  const byKey = new Map(saved.map((r) => [`${r.species_code}:${r.sub_id}`, r.id]))
  return rows.map((r) => byKey.get(`${r.species_code}:${r.sub_id}`)).filter(Boolean)
}

/**
 * Pure: how a report stands in its county's notable feed (`feed`, with evidence): 'confirmed' when
 * the bird there is, 'open' while it or another report of it near the spot is still listed, 'missing' otherwise.
 */
const standing = (report, feed) => {
  const spot = { locId: report.loc_id, lat: report.lat, lng: report.lng }
  const own = feed.find((o) => o.speciesCode === report.species_code && o.subId === report.sub_id)
  const near = feed.filter((o) => o.speciesCode === report.species_code && nearby(spot, o))
  if (own?.evidence?.confirmed || near.some((o) => o.obsReviewed && o.obsValid)) return 'confirmed'
  // eBird marked it reviewed and not valid: not accepted, unless another report of it there stands.
  const refused = own && own.obsReviewed && own.obsValid === false
  if (own && !refused) return 'open'
  return near.some((o) => !(o.obsReviewed && o.obsValid === false)) ? 'open' : 'missing'
}

/** Settles open reports against eBird: confirmed, gone, or out of time. Returns counts. */
const checkReports = async ({ now = new Date(), deadline = Infinity, feedFor = (region) => ebird.notableObservations(region, 30) } = {}) => {
  const result = { open: 0, confirmed: 0, gone: 0, expired: 0 }
  const since = new Date(now.getTime() - FOLLOW_DAYS * 86_400_000)
  result.expired = await db('rare_reports').where({ outcome: 'pending' }).where('created_at', '<=', since)
    .update({ outcome: 'expired', settled_at: now })
  const open = await db('rare_reports').where({ outcome: 'pending' })
  result.open = open.length
  const byRegion = new Map()
  for (const r of open) byRegion.set(r.region, [...(byRegion.get(r.region) || []), r])
  const chasing = new Date(now.getTime() - CHASE_DAYS * 86_400_000)
  for (const [region, reports] of byRegion) {
    if (Date.now() > deadline) break
    // Past the days a bird may be chased, a county is asked every few hours: the email can wait.
    if (now.getUTCHours() % SLOW_EVERY_HOURS !== 0 && reports.every((r) => new Date(r.created_at) <= chasing)) continue
    let feed
    try {
      feed = withEvidence(await feedFor(region))
    } catch (error) {
      // Can't tell this hour; ask again next hour rather than guess.
      console.error(`Report check for ${region} failed:`, error.message)
      continue
    }
    for (const report of reports) {
      const now_ = standing(report, feed)
      if (now_ === 'confirmed') {
        await db('rare_reports').where({ id: report.id }).update({ outcome: 'confirmed', settled_at: now, missing_since: null })
        result.confirmed += 1
      } else if (now_ === 'open') {
        if (report.missing_since) await db('rare_reports').where({ id: report.id }).update({ missing_since: null })
      } else if (!report.missing_since) {
        await db('rare_reports').where({ id: report.id }).update({ missing_since: now })
      } else if (now - new Date(report.missing_since) >= GONE_AFTER_HOURS * 3_600_000) {
        await db('rare_reports').where({ id: report.id }).update({ outcome: 'gone', settled_at: now })
        result.gone += 1
      }
    }
  }
  return result
}

/** Pushes "now confirmed" to those told by push while the bird may still be there, after their quiet hours. */
const pushConfirmations = async ({ send = sendToUser, now = new Date() } = {}) => {
  const rows = await db('report_follows as f').join('rare_reports as r', 'r.id', 'f.report_id')
    .where({ 'f.via': 'push', 'r.outcome': 'confirmed' }).whereNull('f.pushed_at')
    .where('f.told_at', '>', new Date(now.getTime() - CHASE_DAYS * 86_400_000))
    .select('f.id as follow_id', 'f.user_id', 'r.*')
  if (!rows.length) return { sent: 0 }
  const users = new Map((await db('users').whereIn('id', [...new Set(rows.map((r) => r.user_id))])).map((u) => [u.id, u]))
  const names = new Map((await db('taxonomy_ref').whereIn('species_code', [...new Set(rows.map((r) => r.species_code))]).select('species_code', 'com_name')).map((t) => [t.species_code, t.com_name]))
  let sent = 0
  for (const row of rows) {
    const user = users.get(row.user_id)
    if (!user || inQuietHours(user, now)) continue
    const named = await inLanguage(user.locale)
    const report = named({ speciesCode: row.species_code, comName: names.get(row.species_code) || row.species_code, subId: row.sub_id, locName: row.loc_name, obsDt: row.obs_dt, aba: row.aba, region: row.region })
    const r = await send(user.id, reviewNotification(report, langFor(user)))
    sent += r.sent
    await db('report_follows').where({ id: row.follow_id }).update({ pushed_at: now })
  }
  return { sent }
}

/**
 * The reports this person was told of that settled since the morning email last listed them,
 * newest first: { followIds, speciesCode, comName, locName, obsDt, aba, region, subId, outcome }.
 * Told by push or email alike; one line per report however often they were told.
 */
const updatesFor = async (user, { now = new Date() } = {}) => {
  const rows = await db('report_follows as f').join('rare_reports as r', 'r.id', 'f.report_id')
    .where('f.user_id', user.id).whereIn('r.outcome', ['confirmed', 'gone']).whereNull('f.mailed_on')
    .where('r.settled_at', '>', new Date(now.getTime() - MAIL_DAYS * 86_400_000))
    .orderBy('r.settled_at', 'desc')
    .select('f.id as follow_id', 'r.*')
  const byReport = new Map()
  for (const row of rows) {
    const seen = byReport.get(row.id)
    if (seen) { seen.followIds.push(row.follow_id); continue }
    byReport.set(row.id, { followIds: [row.follow_id], speciesCode: row.species_code, subId: row.sub_id, locName: row.loc_name, obsDt: row.obs_dt, aba: row.aba, region: row.region, outcome: row.outcome })
  }
  const updates = [...byReport.values()]
  if (!updates.length) return []
  const names = new Map((await db('taxonomy_ref').whereIn('species_code', updates.map((u) => u.speciesCode)).select('species_code', 'com_name')).map((t) => [t.species_code, t.com_name]))
  return updates.map((u) => ({ ...u, comName: names.get(u.speciesCode) || u.speciesCode }))
}

/** The morning email listed these; they aren't listed again. */
const markMailed = (updates, day = new Date().toISOString().slice(0, 10)) => {
  const ids = updates.flatMap((u) => u.followIds)
  return ids.length ? db('report_follows').whereIn('id', ids).update({ mailed_on: day }) : null
}

/**
 * Whether each report's observer wrote about the bird, from its checklist (cached per checklist):
 * the reports with `evidence.described` set where it's known. Only reports awaiting review are
 * looked at, a few checklists per call; the rest come back as they were.
 */
const withNotes = async (reports, { deadline = Date.now() + NOTES_BUDGET_MS, max = NOTES_PER_CALL, view = ebird.checklistView } = {}) => {
  const open = reports.filter((o) => o.evidence && !o.evidence.confirmed && o.subId)
  if (!open.length) return reports
  const subs = [...new Set(open.map((o) => o.subId))]
  const cached = new Map((await db('checklist_notes').whereIn('sub_id', subs)).map((r) => [r.sub_id, new Set(r.described)]))
  for (const subId of subs.filter((s) => !cached.has(s)).slice(0, max)) {
    if (Date.now() > deadline) break
    try {
      const c = await view(subId, { timeoutMs: Math.max(1000, Math.min(4000, deadline - Date.now())) })
      const described = (c.obs || []).filter((o) => String(o.comments || '').trim().length > 10).map((o) => o.speciesCode)
      await db('checklist_notes').insert({ sub_id: subId, described }).onConflict('sub_id').merge()
      cached.set(subId, new Set(described))
    } catch (error) {
      console.error(`Checklist notes for ${subId}:`, error.message)
    }
  }
  return reports.map((o) => (o.evidence && !o.evidence.confirmed && cached.has(o.subId) ? { ...o, evidence: { ...o.evidence, described: cached.get(o.subId).has(o.speciesCode) } } : o))
}

/** The hourly pass: settle open reports, push confirmations, tell the HQ desk's owner, tidy up. */
const runFollowUps = async ({ send = sendToUser, now = new Date(), deadline = Infinity, feedFor, hq = require('./hqAlerts').hqOutcomes } = {}) => {
  const checked = await checkReports({ now, deadline, feedFor })
  const pushed = await pushConfirmations({ send, now })
  const owner = await hq({ now }).catch((error) => { console.error('HQ follow-ups failed:', error.message); return null })
  await db('rare_reports').whereNot({ outcome: 'pending' }).where('settled_at', '<', new Date(now.getTime() - KEEP_DAYS * 86_400_000)).del()
  await db('checklist_notes').where('fetched_at', '<', new Date(now.getTime() - 60 * 86_400_000)).del()
  return { ...checked, pushed: pushed.sent, hq: owner }
}

module.exports = { follow, trackReports, standing, checkReports, pushConfirmations, updatesFor, markMailed, withNotes, runFollowUps, FOLLOW_DAYS, CHASE_DAYS, GONE_AFTER_HOURS }
