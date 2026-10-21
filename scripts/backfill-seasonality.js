#!/usr/bin/env node
/**
 * One-off: fills a year of seasonality history for every region users have chosen (or the regions
 * given as arguments), paced so eBird is not hammered. Safe to re-run; fetched days are skipped.
 *
 *   node scripts/backfill-seasonality.js            # every region with a user
 *   node scripts/backfill-seasonality.js US-GA-139  # just this one
 */
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { backfill } = require('../lib/seasonality')

const main = async () => {
  const regions = process.argv.slice(2).length
    ? process.argv.slice(2)
    : await db('users').whereNot('location', '').whereNotNull('location').distinct('location').pluck('location')
  for (const region of regions) {
    const started = Date.now()
    const { fetched, remaining, failed } = await backfill(region, { pause: 200 })
    console.log(`${region}: fetched ${fetched} days in ${Math.round((Date.now() - started) / 1000)}s, ${remaining} remaining${failed ? `, ${failed} failed (run again)` : ''}`)
  }
}

main().then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
