#!/usr/bin/env node
/**
 * One-off: fetches again every history day stored before locations were kept, so each species'
 * report gains where and when. Paced for eBird; safe to re-run (days with locations are skipped).
 *
 *   node scripts/backfill-locations.js            # every region with a user
 *   node scripts/backfill-locations.js US-GA-139  # just this one
 */
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { backfillLocations } = require('../lib/seasonality')
const { userRegions } = require('../lib/checklists')

const main = async () => {
  const regions = process.argv.slice(2).length ? process.argv.slice(2) : await userRegions()
  for (const region of regions) {
    const started = Date.now()
    const { fetched, remaining, failed } = await backfillLocations(region, { pause: 600 })
    console.log(`${region}: refetched ${fetched} days in ${Math.round((Date.now() - started) / 1000)}s, ${remaining} remaining${failed ? `, ${failed} failed (run again)` : ''}`)
  }
}

main().then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
