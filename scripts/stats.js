#!/usr/bin/env node
/**
 * How the app is doing, from our own tables (Vercel Web Analytics has the page views): accounts,
 * who set a county and turned on alerts, watch lists, life lists, passkeys, routes and shares.
 *
 *   node scripts/stats.js            # the last 7 and 30 days, and all time
 *   NODE_ENV=production PROD_PG_URL=... node scripts/stats.js
 */
require('dotenv').config({ quiet: true })
const db = require('../lib/db')

const since = (days) => db.raw(`now() - interval '${Number(days)} days'`)
const count = async (query) => Number((await query.count('* as n').first()).n)
const span = async (table, column = 'created_at', where = (q) => q) => ({
  week: await count(where(db(table)).where(column, '>', since(7))),
  month: await count(where(db(table)).where(column, '>', since(30))),
  all: await count(where(db(table)))
})
const row = (label, s) => console.log(`  ${label.padEnd(34)} ${String(s.week).padStart(6)} ${String(s.month).padStart(7)} ${String(s.all).padStart(8)}`)

const main = async () => {
  console.log(`\n  ${''.padEnd(34)} ${'7 days'.padStart(6)} ${'30 days'.padStart(7)} ${'all time'.padStart(8)}`)
  row('New accounts', await span('users'))
  row('  with a county', await span('users', 'created_at', (q) => q.whereNot('location', '')))
  row('  with email confirmed', await span('users', 'created_at', (q) => q.where('email_confirmed', true)))
  row('  finished setup', await span('users', 'created_at', (q) => q.whereNotNull('onboarded_at')))
  row('Push devices added', await span('push_subscriptions'))
  row('Watch-list birds added', await span('saved_birds'))
  row('Life-list birds added', await span('seen_birds'))
  row('  of them by eBird import', await span('seen_birds', 'created_at', (q) => q.where('source', 'import')))
  row('Passkeys added', await span('passkeys'))
  row('Routes edited and saved', await span('user_routes', 'updated_at'))
  row('Shares made', await span('shares'))
  row('  routes', await span('shares', 'created_at', (q) => q.where('kind', 'route')))
  row('  sightings', await span('shares', 'created_at', (q) => q.where('kind', 'sighting')))
  const opens = await db('shares').sum({ n: 'views' }).first()
  const top = await db('shares').orderBy('views', 'desc').limit(3).select('id', 'kind', 'views', db.raw("payload->>'comName' as bird"), db.raw("payload->>'regionName' as region"))
  console.log(`\n  Share links opened, all time: ${Number(opens.n || 0)}`)
  for (const s of top.filter((t) => t.views > 0)) console.log(`    ${s.views} opens · ${s.kind}${s.bird ? ` (${s.bird})` : ''}${s.region ? ` in ${s.region}` : ''} · /share/${s.kind === 'route' ? 'r' : 's'}/${s.id}`)
  const active = await count(db('users').where('updated_at', '>', since(30)))
  console.log(`  Accounts changed in the last 30 days: ${active}\n`)
}

main().then(() => db.destroy()).catch((error) => { console.error(error); process.exit(1) })
