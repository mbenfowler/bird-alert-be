#!/usr/bin/env node
// Fills in birdImg for stored birds that have none, using Nuthatch then Wikipedia.
// Usage: node scripts/backfill-images.js            (DEV_PG_URL)
//        NODE_ENV=production PROD_PG_URL=... node scripts/backfill-images.js
require('dotenv').config()
const db = require('../lib/db')
const { lookupImage } = require('../lib/enrich')

const CONCURRENCY = 4

const main = async () => {
  // Older rows stored the literal string 'undefined' when a lookup found nothing.
  await db('birds').where('birdImg', 'undefined').update({ birdImg: null })
  await db('birds').where('wikiURL', 'undefined').update({ wikiURL: null })
  const birds = await db('birds').whereNull('birdImg').select('id', 'comName', 'sciName', 'speciesCode', 'category')
  console.log(`${birds.length} birds without an image`)
  let found = 0
  for (let i = 0; i < birds.length; i += CONCURRENCY) {
    await Promise.all(birds.slice(i, i + CONCURRENCY).map(async (bird) => {
      const image = await lookupImage(bird)
      if (!image) return
      await db('birds').where({ id: bird.id }).update({ birdImg: image, updated_at: new Date() })
      found += 1
      console.log(`  ${bird.speciesCode} ${bird.comName}: ${image.slice(0, 70)}`)
    }))
  }
  console.log(`done: ${found} of ${birds.length} filled in`)
  await db.destroy()
}

main().catch((error) => { console.error(error); process.exit(1) })
