#!/usr/bin/env node
// Re-resolves every species' Wikipedia article by scientific name and refreshes Wikipedia-sourced
// images. Rows with a Nuthatch (Unsplash/Flickr) image keep it; rows with no image or a Wikipedia
// image get the current thumbnail.
// Usage: node scripts/refresh-wiki.js            (DEV_PG_URL)
//        NODE_ENV=production PROD_PG_URL=... node scripts/refresh-wiki.js
require('dotenv').config({ quiet: true })
const db = require('../lib/db')
const { fetchWiki, isSpecies } = require('../lib/enrich')

const PAUSE_MS = 250
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isWikiImage = (url) => !url || /wikimedia\.org/.test(url)

const main = async () => {
  const birds = (await db('birds').select('id', 'speciesCode', 'comName', 'sciName', 'category', 'birdImg', 'wikiURL')).filter(isSpecies)
  console.log(`${birds.length} species to check`)
  let links = 0, images = 0, missing = 0
  for (const bird of birds) {
    const wiki = await fetchWiki(bird)
    await sleep(PAUSE_MS)
    if (!wiki.wikiURL) { missing += 1; continue }
    const changes = {}
    if (wiki.wikiURL !== bird.wikiURL) changes.wikiURL = wiki.wikiURL
    if (isWikiImage(bird.birdImg) && wiki.wikiImage && wiki.wikiImage !== bird.birdImg) changes.birdImg = wiki.wikiImage
    if (!Object.keys(changes).length) continue
    await db('birds').where({ id: bird.id }).update({ ...changes, updated_at: new Date() })
    if (changes.wikiURL) links += 1
    if (changes.birdImg) images += 1
  }
  console.log(`done: ${links} article links changed, ${images} images refreshed, ${missing} species with no article found`)
  await db.destroy()
}

main().catch((error) => { console.error(error); process.exit(1) })
