#!/usr/bin/env node
/**
 * Read-only backtest of the where-to-find odds. For each past day with 14 days of checklists behind
 * it, every model variant's chance at each place is scored against what came next: by default
 * whether any opened checklist there in the following 7 days had the bird (the track record's own
 * test), or with PER_VISIT=1 just the next checklist there (what "the chance a visit finds it"
 * promises). Prints the Brier score (lower is better) and, per band, what was said vs what happened.
 *
 *   PER_VISIT=1 node scripts/backtest-odds.js          (needs the database env, e.g. from vercel env pull)
 */
const db = require('../lib/db')
const { whereToFindMany } = require('../lib/hotspots')
const { addDays } = require('../lib/seasonality')

const VARIANTS = {
  old: { misses: false, detailedEffort: false },
  detailedOnly: { misses: false, detailedEffort: true },
  missesOnly: { misses: true, detailedEffort: false },
  both: { misses: true, detailedEffort: true },
  missesMovers: { misses: true, detailedEffort: true, missesFor: ['rare', 'passage'] }
}
const band = (c) => c >= 60 ? 'High' : c >= 40 ? 'Good' : c >= 20 ? 'Fair' : 'Long shot'

;(async () => {
  const lastDay = addDays(new Date().toISOString().slice(0, 10), -8)
  const regions = await db('checklists').whereNotNull('detail_fetched_at').groupBy('region').select('region').min({ from: 'obs_day' })
  const scores = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, { n: 0, brier: 0, bands: {} }]))
  let days = 0
  const changed = []
  for (const { region, from } of regions) {
    // Start once there are 14 days of checklists behind the day being scored.
    for (let d = addDays(from.toISOString().slice(0, 10), 14); d <= lastDay; d = addDays(d, 1)) {
      const codes = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereBetween('c.obs_day', [addDays(d, -30), d]).distinct('cs.species_code').pluck('cs.species_code')
      if (!codes.length) continue
      days += 1
      const later = await db('checklists').where({ region }).whereNotNull('detail_fetched_at').whereBetween('obs_day', [addDays(d, 1), addDays(d, 7)]).orderBy('obs_day').orderBy('obs_time').select('loc_id', 'sub_id')
      // PER_VISIT: only the first opened checklist at each place after the day counts, the "one visit" the chance is about.
      const firstAt = new Map()
      for (const r of later) if (!firstAt.has(r.loc_id)) firstAt.set(r.loc_id, r.sub_id)
      const firstHits = new Set((await db('checklist_species').whereIn('sub_id', [...firstAt.values()]).select('sub_id', 'species_code')).map((r) => `${r.species_code}|${r.sub_id}`))
      const visitedLocs = new Set(later.map((r) => r.loc_id))
      const hitRows = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereNotNull('c.detail_fetched_at').whereBetween('c.obs_day', [addDays(d, 1), addDays(d, 7)]).select('cs.species_code', 'c.loc_id')
      const hits = new Set(hitRows.map((r) => `${r.species_code}|${r.loc_id}`))
      const results = {}
      for (const [name, model] of Object.entries(VARIANTS)) results[name] = await whereToFindMany(region, codes, { asOf: d, model })
      for (let i = 0; i < codes.length; i++) {
        const byLoc = (name) => new Map(results[name][i].places.map((p) => [p.locId, p]))
        const maps = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, byLoc(k)]))
        for (const [locId, oldPlace] of maps.old) {
          if (!visitedLocs.has(locId)) continue
          const outcome = process.env.PER_VISIT ? (firstHits.has(`${codes[i]}|${firstAt.get(locId)}`) ? 1 : 0) : (hits.has(`${codes[i]}|${locId}`) ? 1 : 0)
          for (const name of Object.keys(VARIANTS)) {
            const p = maps[name].get(locId)
            if (!p) continue
            const s = scores[name]
            s.n += 1
            s.brier += (p.chance / 100 - outcome) ** 2
            const b = (s.bands[band(p.chance)] ||= { n: 0, hits: 0, sum: 0 })
            b.n += 1; b.hits += outcome; b.sum += p.chance
          }
          const np = maps.both.get(locId)
          if (np && np.chance !== oldPlace.chance) changed.push({ outcome, old: oldPlace.chance, now: np.chance, misses: np.missesSince, cls: results.both[i].class })
        }
      }
    }
  }
  console.log(`scored days: ${days}`)
  for (const [name, s] of Object.entries(scores)) {
    console.log(`${name.padEnd(13)} n=${s.n} brier=${(s.brier / s.n).toFixed(4)}  ` + ['High', 'Good', 'Fair', 'Long shot'].map((b) => s.bands[b] ? `${b}: said ${Math.round(s.bands[b].sum / s.bands[b].n)}% got ${Math.round(100 * s.bands[b].hits / s.bands[b].n)}% (${s.bands[b].n})` : `${b}: -`).join(' | '))
  }
  const down = changed.filter((c) => c.now < c.old)
  const up = changed.filter((c) => c.now > c.old)
  const rate = (xs) => xs.length ? Math.round(100 * xs.filter((c) => c.outcome).length / xs.length) : null
  const avg = (xs, k) => xs.length ? Math.round(xs.reduce((a, c) => a + c[k], 0) / xs.length) : null
  console.log(`changed: ${changed.length} (down ${down.length}: old avg ${avg(down, 'old')}% -> new ${avg(down, 'now')}%, actually found ${rate(down)}% | up ${up.length}: old ${avg(up, 'old')}% -> new ${avg(up, 'now')}%, found ${rate(up)}%)`)
  const withMisses = changed.filter((c) => c.misses > 0)
  console.log(`with misses since: ${withMisses.length}, old avg ${avg(withMisses, 'old')}% -> new ${avg(withMisses, 'now')}%, found ${rate(withMisses)}%`)
  for (const cls of ['resident', 'seasonal', 'passage', 'rare']) {
    const xs = changed.filter((c) => c.cls === cls)
    const sq = (k) => xs.reduce((a, c) => a + (c[k] / 100 - c.outcome) ** 2, 0) / (xs.length || 1)
    console.log(`  ${cls.padEnd(9)} changed ${xs.length}: old ${avg(xs, 'old')}% -> new ${avg(xs, 'now')}%, found ${rate(xs)}%, brier on these old ${sq('old').toFixed(3)} new ${sq('now').toFixed(3)}`)
  }
  process.exit(0)
})().catch((e) => { console.error('FAILED', e); process.exit(1) })
