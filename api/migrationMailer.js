const { route } = require('../lib/http')
const db = require('../lib/db')
const ebird = require('../lib/ebird')
const { assertCronCaller, runDigest } = require('../lib/digest')
const { migrationReport } = require('../lib/seasonality')
const { sendMigrationEmail } = require('../lib/mailer')

const regionNames = new Map()
const regionName = async (region) => {
  if (regionNames.has(region)) return regionNames.get(region)
  const state = /^US-([A-Z]{2})-/.exec(region)?.[1]
  let name = null
  if (state) {
    try { name = (await ebird.subregions(state)).find((r) => r.code === region)?.name || null } catch { name = null }
  }
  regionNames.set(region, name)
  return name
}

// GET /api/migrationMailer (weekly, GitHub Actions) -> the week's arrivals, departures and expected species per region
module.exports = route(['GET'], async (req, res) => {
  assertCronCaller(req)
  const reports = new Map()
  const result = await runDigest({
    kind: 'migration',
    preference: 'migration_email_enabled',
    fetchSightings: async (region) => {
      const report = await migrationReport(region)
      reports.set(region, report)
      // runDigest thinks in sightings; each species appears in one section only, so this keeps it honest.
      return [...report.arrived, ...report.departed, ...report.coming]
    },
    select: async (_user, items) => items,
    send: async (user, _items) => sendMigrationEmail(user, reports.get(user.location), await regionName(user.location))
  })
  res.status(200).json(result)
})
