const db = require('./db')
const { stateOfRegion } = require('./regions')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')
const { migrationReport } = require('./seasonality')
const { withAba, rarestFirst } = require('./abaCodes')
const { sendAlertDigestEmail, sendRareSightingsEmail, sendMigrationEmail } = require('./mailer')

const pushedKeys = async (userId) =>
  new Set((await db('push_log').where('user_id', userId).select('speciesCode', 'sub_id')).map((r) => `${r.speciesCode}:${r.sub_id}`))

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
    send: async (user, sightings) => sendAlertDigestEmail(user, sightings, await withBirds(sightings))
  },
  rare: {
    preference: 'rare_sightings_email_enabled',
    fetchSightings: (region) => ebird.notableObservations(region, 1),
    select: async (user, sightings, { preview = false } = {}) => {
      const pushed = preview ? new Set() : await pushedKeys(user.id)
      // The rarest in the whole ABA Area (by its Checklist code) lead the email.
      return rarestFirst(await withAba(sightings.filter((obs) => !pushed.has(`${obs.speciesCode}:${obs.subId}`)), { region: user.location }))
    },
    send: async (user, sightings) => sendRareSightingsEmail(user, sightings, await withBirds(sightings))
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
    send: async (user) => sendMigrationEmail(user, migrationReports.get(user.location), await regionName(user.location))
  }
}

module.exports = { DIGESTS }
