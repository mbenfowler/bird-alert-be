#!/usr/bin/env node
/**
 * Fetches the regions' recent checklists in full, more per run than the hourly job allows itself.
 * Safe to re-run; checklists already fetched in full are skipped.
 *
 *   node scripts/sync-checklists.js                 # every region with a user, up to 300 checklists each
 *   node scripts/sync-checklists.js US-GA-139 500   # one region, up to 500
 */
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { syncChecklists, userRegions } = require('../lib/checklists')

const main = async () => {
  const [regionArg, limitArg] = process.argv.slice(2)
  const regions = regionArg ? [regionArg] : await userRegions()
  const detailLimit = Number.parseInt(limitArg || '300', 10)
  for (const region of regions) {
    const started = Date.now()
    const result = await syncChecklists(region, { detailLimit, pause: 400 })
    console.log(`${region}: ${result.listed} listed, ${result.added} new, ${result.detailed} fetched in full (${result.failed} failed), ${result.pending} still pending, ${Math.round((Date.now() - started) / 1000)}s`)
  }
}

main().then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
