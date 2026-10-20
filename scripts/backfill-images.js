#!/usr/bin/env node
// Fills in birdImg for stored birds that have none, using Nuthatch then Wikipedia.
// Usage: node scripts/backfill-images.js            (DEV_PG_URL)
//        NODE_ENV=production PROD_PG_URL=... node scripts/backfill-images.js
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { lookupImage } = require('../lib/enrich')

// Wikipedia and Nuthatch rate-limit bursts; one lookup at a time with a short pause stays under it.
const PAUSE_MS = 250
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const main = async () => {
  // Older rows stored the literal string 'undefined' when a lookup found nothing.
  await db('birds').where('birdImg', 'undefined').update({ birdImg: null })
  await db('birds').where('wikiURL', 'undefined').update({ wikiURL: null })
  const birds = await db('birds').whereNull('birdImg').select('id', 'comName', 'sciName', 'speciesCode', 'category')
  console.log(`${birds.length} birds without an image`)
  let found = 0
  for (const bird of birds) {
    const image = await lookupImage(bird)
    await sleep(PAUSE_MS)
    if (!image) continue
    await db('birds').where({ id: bird.id }).update({ birdImg: image, updated_at: new Date() })
    found += 1
    console.log(`  ${bird.speciesCode} ${bird.comName}: ${image.slice(0, 70)}`)
  }
  console.log(`done: ${found} of ${birds.length} filled in`)
  await db.destroy()
}

main().catch((error) => { console.error(error); process.exit(1) })
