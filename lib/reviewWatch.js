const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { inQuietHours } = require('./quietHours')
const { reviewNotification, sightingNotification } = require('./notifications')
const { withEvidence, hasProof } = require('./evidence')
const { withAba } = require('./abaCodes')
const { findOrCreateBirds } = require('./enrich')
const { langFor } = require('./i18n')
const { inLanguage } = require('./birdNames')

/**
 * Following up on rare birds sent out before eBird's reviewers had looked. An ABA Code 3-5 bird
 * announced while unconfirmed is marked pending in push_log; each hourly run asks eBird for the
 * county's notable reports of the past week (one call per county with anything pending) and:
 * confirmed, everyone who got the alert hears so once; still unreviewed, it waits; gone from the
 * feed (rejected, or more than a week old), it's dropped quietly. Nobody is told a bird they
 * chased was rejected. Quiet hours hold the follow-up until they end.
 *
 * The same pass releases sightings held back for people who chose strict alerts ('held'): once a
 * report has proof (a reviewer's OK, a photo, or a second birder near it), it goes out as the alert
 * it would have been, its evidence line saying why. The hourly run catches that while the report
 * is in the day's feed; this covers proof that comes later in the week.
 */
const FOLLOW_DAYS = 7

const runReviewChecks = async ({ send = sendToUser, deadline = Infinity } = {}) => {
  const rows = await db('push_log')
    .where((q) => q.where((p) => p.where('review_state', 'pending').whereBetween('aba', [3, 5])).orWhere('review_state', 'held'))
    .whereNotNull('sighting_region')
    .where('created_at', '>', db.raw(`now() - interval '${FOLLOW_DAYS} days'`))
  const pendingCount = rows.filter((r) => r.review_state === 'pending').length
  const result = { pending: pendingCount, confirmed: 0, dropped: 0, sent: 0, held: rows.length - pendingCount, released: 0 }
  if (!rows.length) return result

  const byRegion = new Map()
  for (const row of rows) byRegion.set(row.sighting_region, [...(byRegion.get(row.sighting_region) || []), row])
  const users = new Map((await db('users').whereIn('id', [...new Set(rows.map((r) => r.user_id))])).map((u) => [u.id, u]))

  for (const [region, regionRows] of byRegion) {
    if (Date.now() > deadline) break
    let reports
    try {
      reports = withEvidence(await ebird.notableObservations(region, FOLLOW_DAYS))
    } catch (error) {
      // Can't tell this hour; ask again next hour rather than guess.
      console.error(`Review check for ${region} failed:`, error.message)
      continue
    }
    const byKey = new Map(reports.map((o) => [`${o.speciesCode}:${o.subId}`, o]))
    for (const row of regionRows) {
      const report = byKey.get(`${row.speciesCode}:${row.sub_id}`)
      if (!report) {
        await db('push_log').where({ id: row.id }).update({ review_state: 'dropped', reviewed_at: db.fn.now() })
        result.dropped += 1
        continue
      }
      const user = users.get(row.user_id)
      if (row.review_state === 'held') {
        if (!hasProof(report) || !user || inQuietHours(user)) continue
        const [obs] = await withAba([report], { region })
        const bird = (await findOrCreateBirds([report.speciesCode]).catch(() => []))[0]
        const named = await inLanguage(user.locale)
        const r = await send(row.user_id, sightingNotification(named({ ...obs, kind: row.kind, locName: row.loc_name || report.locName, region }), bird, langFor(user)))
        result.sent += r.sent
        // Sent now: like any alert, an unconfirmed Code 3-5 bird is then followed until it's confirmed.
        const followed = obs.aba >= 3 && obs.aba <= 5 && !report.evidence.confirmed
        await db('push_log').where({ id: row.id }).update({ review_state: followed ? 'pending' : 'released', aba: obs.aba ?? null, reviewed_at: db.fn.now() })
        result.released += 1
        continue
      }
      if (!(report.obsReviewed && report.obsValid)) continue
      if (!user || inQuietHours(user)) continue
      const named = await inLanguage(user.locale)
      const r = await send(row.user_id, reviewNotification(named({ ...report, aba: row.aba, region, locName: row.loc_name || report.locName }), langFor(user)))
      result.sent += r.sent
      await db('push_log').where({ id: row.id }).update({ review_state: 'confirmed', reviewed_at: db.fn.now() })
      result.confirmed += 1
    }
  }
  return result
}

module.exports = { runReviewChecks, FOLLOW_DAYS }
