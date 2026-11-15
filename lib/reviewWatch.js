const db = require('./db')
const ebird = require('./ebird')
const { sendToUser } = require('./push')
const { inQuietHours } = require('./quietHours')
const { sightingNotification } = require('./notifications')
const { follow } = require('./reportFollows')
const { withEvidence, hasProof } = require('./evidence')
const { withAba } = require('./abaCodes')
const { findOrCreateBirds } = require('./enrich')
const { langFor } = require('./i18n')
const { inLanguage } = require('./birdNames')

/**
 * Releases sightings held back for people who chose strict alerts ('held' in push_log): once a
 * report has proof (a reviewer's OK, a photo, or a second birder near it), it goes out as the alert
 * it would have been, its evidence line saying why. The hourly run catches that while the report
 * is in the day's feed; this covers proof that comes later in the week (one call per county with
 * anything held). Gone from the feed, a held report is dropped quietly. Following a report that went
 * out until it's confirmed is lib/reportFollows'.
 */
const FOLLOW_DAYS = 7

const runReviewChecks = async ({ send = sendToUser, deadline = Infinity } = {}) => {
  const rows = await db('push_log')
    .where('review_state', 'held')
    .whereNotNull('sighting_region')
    .where('created_at', '>', db.raw(`now() - interval '${FOLLOW_DAYS} days'`))
  const result = { dropped: 0, sent: 0, held: rows.length, released: 0 }
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
      if (!hasProof(report) || !user || inQuietHours(user)) continue
      const [obs] = await withAba([report], { region })
      const bird = (await findOrCreateBirds([report.speciesCode]).catch(() => []))[0]
      const named = await inLanguage(user.locale)
      const r = await send(row.user_id, sightingNotification(named({ ...obs, kind: row.kind, locName: row.loc_name || report.locName, region }), bird, langFor(user)))
      result.sent += r.sent
      await db('push_log').where({ id: row.id }).update({ review_state: 'released', aba: obs.aba ?? null, reviewed_at: db.fn.now() })
      // Sent now: like any alert, an unconfirmed one is then followed until it's settled.
      await follow(row.user_id, 'push', [obs], region)
      result.released += 1
    }
  }
  return result
}

module.exports = { runReviewChecks, FOLLOW_DAYS }
