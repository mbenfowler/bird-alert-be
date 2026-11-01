const db = require('./db')
const { stateOfRegion } = require('./regions')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')
const { migrationReport } = require('./seasonality')
const { withAba, rarestFirst } = require('./abaCodes')
const { rangeFeeds, homeOf, beyondCounty } = require('./range')
const { withEvidence, withoutEscapees, hasProof } = require('./evidence')
const { notHeld } = require('./pushLog')

// Range lookups shared across one digest run (a fresh set every ten minutes), so a county's
// people cost one eBird call between them.
let lookups = null
let lookupsAt = 0
const rangeLookups = () => {
  if (!lookups || Date.now() - lookupsAt > 10 * 60_000) { lookups = rangeFeeds(); lookupsAt = Date.now() }
  return lookups
}
const { sendAlertDigestEmail, sendRareSightingsEmail, sendMigrationEmail } = require('./mailer')
const { inLanguage } = require('./birdNames')

// What went to this person's devices; a sighting held back for proof ('held') hasn't.
const pushedKeys = async (userId) =>
  new Set((await db('push_log').where('user_id', userId).where(notHeld).select('speciesCode', 'sub_id')).map((r) => `${r.speciesCode}:${r.sub_id}`))

const withBirds = async (sightings) => {
  const birds = await findOrCreateBirds(sightings.map((s) => s.speciesCode)).catch(() => [])
  return new Map(birds.map((b) => [b.speciesCode, b]))
}

const regionNames = new Map()
const regionName = async (region) => {
  if (regionNames.has(region)) return regionNames.get(region)
  const state = stateOfRegion(region)
  let name = null
  if (state) {
    try { name = (await ebird.subregions(state)).find((r) => r.code === region)?.name || null } catch { name = null }
  }
  regionNames.set(region, name)
  return name
}

const migrationReports = new Map()

/**
 * The three email digests, each as the pieces runDigest and previewDigest need: which users want
 * it, how to fetch a region's material, how to narrow it to one user, and how to send it. A preview
 * skips the "already pushed to your phone" exclusion so there is something to look at.
 */
const DIGESTS = {
  watchlist: {
    // Those who chose the email, and those who asked for watch-list alerts but have no device
    // subscribed to push (most often an iPhone that never added the app to its home screen):
    // without the email, their alerts reach nobody.
    preference: (q) => q.where((who) => who
      .where('alert_digest_email_enabled', true)
      .orWhere((fallback) => fallback
        .where('push_watchlist_enabled', true)
        .where('watchlist_email_fallback', true)
        .whereNotExists(db('push_subscriptions as p').whereRaw('p.user_id = users.id')))),
    fetchSightings: (region) => ebird.recentObservations(region, 1),
    select: async (user, sightings, { preview = false } = {}) => {
      const saved = new Set(await db('saved_birds').where('user_id', user.id).pluck('speciesCode'))
      const pushed = preview ? new Set() : await pushedKeys(user.id)
      // Anything already pushed to this user's devices is old news by morning.
      return sightings.filter((obs) => saved.has(obs.speciesCode) && !pushed.has(`${obs.speciesCode}:${obs.subId}`))
    },
    send: async (user, sightings) => sendAlertDigestEmail(user, sightings.map(await inLanguage(user.locale)), await withBirds(sightings))
  },
  rare: {
    preference: 'rare_sightings_email_enabled',
    // With the evidence as it stands when the email goes out; escapees eBird marks are left out.
    fetchSightings: async (region) => {
      const [notable, recent] = await Promise.all([ebird.notableObservations(region, 1), ebird.recentObservations(region, 1).catch(() => [])])
      return withoutEscapees(withEvidence(notable), recent)
    },
    select: async (user, sightings, { preview = false } = {}) => {
      const pushed = preview ? new Set() : await pushedKeys(user.id)
      // The person's range adds rare birds past the county line, species the county didn't report.
      const home = user.range_mi > 0 ? await homeOf(user).catch(() => null) : null
      const beyond = home ? beyondCounty(await rangeLookups().notable(user, home), sightings) : []
      // The rarest in the whole ABA Area (by its Checklist code) lead the email.
      // Strict alerts: only reports with proof (a reviewer's OK, a photo, or a second birder).
      const shown = [...sightings, ...beyond].filter((obs) => !pushed.has(`${obs.speciesCode}:${obs.subId}`) && (!user.rare_alerts_need_proof || hasProof(obs)))
      return rarestFirst(await withAba(shown, { region: user.location }))
    },
    send: async (user, sightings) => sendRareSightingsEmail(user, sightings.map(await inLanguage(user.locale)), await withBirds(sightings))
  },
  migration: {
    preference: 'migration_email_enabled',
    fetchSightings: async (region) => {
      const report = await migrationReport(region)
      migrationReports.set(region, report)
      // runDigest thinks in sightings; each species appears in one section only, so this keeps it honest.
      return [...report.arrived, ...report.departed, ...report.coming]
    },
    select: async (_user, items) => items,
    send: async (user) => {
      // Birds named in the reader's language; the report itself is shared by everyone in the region.
      const named = await inLanguage(user.locale)
      const report = migrationReports.get(user.location)
      const inTheirWords = { arrived: report.arrived.map(named), departed: report.departed.map(named), coming: report.coming.map(named) }
      return sendMigrationEmail(user, inTheirWords, await regionName(user.location))
    }
  }
}

module.exports = { DIGESTS }
