#!/usr/bin/env node
/**
 * The track record: per region and band, how often a predicted chance came true (the bird on a
 * checklist at the place within a week), over the last 60 days, plus what is still waiting to be graded.
 *
 *   node scripts/grades.js              # every region with a user
 *   node scripts/grades.js US-GA-139    # just this one
 */
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { accuracy, MIN_GRADED } = require('../lib/grading')
const { userRegions } = require('../lib/checklists')

const RANGES = { High: '60%+', Good: '40-59%', Fair: '20-39%', 'Long shot': '<20%' }

const main = async () => {
  const regions = process.argv.slice(2).length ? process.argv.slice(2) : await userRegions()
  for (const region of regions) {
    const grades = await accuracy(region)
    const waiting = await db('place_predictions').where({ region }).whereNull('graded_at').count('* as n').first()
    console.log(`\n${region}  (${waiting.n} predictions waiting for their week)`)
    if (!Object.keys(grades).length) { console.log('  nothing graded yet'); continue }
    for (const band of Object.keys(RANGES)) {
      const g = grades[band]
      if (!g) continue
      const verdict = g.enough ? '' : `  (under ${MIN_GRADED}, not shown in the app)`
      console.log(`  ${band.padEnd(9)} ${RANGES[band].padEnd(7)} came true ${String(g.rate).padStart(3)}%  ${g.hits}/${g.n}${verdict}`)
    }
  }
}

main().then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
