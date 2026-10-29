#!/usr/bin/env node
// Re-checks every species' photo and Wikipedia link: each bird gets its own article's lead photo,
// and only when the article names the bird (lib/enrich namesBird). A bird whose article can't be
// confirmed loses its photo; the app shows its no-photo picture rather than a wrong bird.
// Two steps, so a person reviews before anything is written:
//   node scripts/refresh-photos.js --report photos.json   (reads only; writes the planned changes)
//   node scripts/refresh-photos.js --apply photos.json    (writes exactly those changes)
// Prefix with NODE_ENV=production PROD_PG_URL=... to run against production.
require('dotenv').config({ quiet: true })
const fs = require('fs')
const db = require('../lib/db')
const { fetchWiki, isSpecies } = require('../lib/enrich')

const PAUSE_MS = 250
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const report = async (file) => {
  const birds = (await db('birds').select('id', 'speciesCode', 'comName', 'sciName', 'category', 'birdImg', 'wikiURL').orderBy('taxonOrder')).filter(isSpecies)
  console.log(`${birds.length} species to check`)
  const changes = []
  for (const [i, bird] of birds.entries()) {
    let wiki = await fetchWiki(bird)
    await sleep(PAUSE_MS)
    // A miss may be a passing network error; one retry before the photo is dropped.
    if (!wiki.wikiURL) { await sleep(2000); wiki = await fetchWiki(bird) }
    const to = { birdImg: wiki.wikiImage, wikiURL: wiki.wikiURL }
    if (to.birdImg !== bird.birdImg || to.wikiURL !== bird.wikiURL) {
      changes.push({ id: bird.id, speciesCode: bird.speciesCode, comName: bird.comName, from: { birdImg: bird.birdImg, wikiURL: bird.wikiURL }, to })
    }
    if ((i + 1) % 100 === 0) console.log(`  ${i + 1} checked, ${changes.length} to change`)
  }
  // After the changes, no two species should share a photo; any that do are listed for a look.
  const finalImg = new Map(birds.map((b) => [b.id, b.birdImg]))
  for (const c of changes) finalImg.set(c.id, c.to.birdImg)
  const byImg = new Map()
  for (const b of birds) { const img = finalImg.get(b.id); if (img) byImg.set(img, [...(byImg.get(img) || []), b.comName]) }
  const shared = [...byImg].filter(([, names]) => names.length > 1).map(([img, names]) => ({ img, names }))
  fs.writeFileSync(file, JSON.stringify({ checked: birds.length, changes, shared }, null, 2))
  const dropped = changes.filter((c) => c.from.birdImg && !c.to.birdImg).length
  console.log(`done: ${changes.length} changes (${dropped} photos dropped for want of a confirmed article), ${shared.length} photos still shared; written to ${file}`)
}

const apply = async (file) => {
  const { changes } = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const c of changes) await db('birds').where({ id: c.id, speciesCode: c.speciesCode }).update({ ...c.to, updated_at: new Date() })
  console.log(`applied ${changes.length} changes`)
}

const [flag, file] = process.argv.slice(2)
const run = flag === '--report' && file ? report(file) : flag === '--apply' && file ? apply(file) : Promise.reject(new Error('usage: --report <file> | --apply <file>'))
run.then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
