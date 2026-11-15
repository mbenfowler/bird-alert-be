#!/bin/zsh
# How the rare birds we alerted on turned out (lib/reportFollows): confirmed, gone from eBird, or still
# unreviewed after two weeks, by what was known when they went out. Counts only. Read-only.
set -e
cd "${0:A:h}/../.."
tmp=$(mktemp)
npx vercel env pull --environment=production --yes "$tmp" </dev/null >/dev/null 2>&1
set -a; . "$tmp"; set +a
rm -f "$tmp"
export NODE_ENV=production SESSION_SECRET=dummy-local-secret-for-read-only-checks-0123456789
PGOPTIONS='-c default_transaction_read_only=on' node -e "
const knex = require('knex')({ client: 'pg', connection: process.env.PROD_PG_URL })
const one = async (sql) => (await knex.raw(sql)).rows
const split = (label, expr) => one(\`select \${expr} as \"\${label}\", count(*) n,
  round(100.0 * count(*) filter (where outcome = 'confirmed') / count(*)) confirmed_pct,
  round(100.0 * count(*) filter (where outcome = 'gone') / count(*)) gone_pct,
  round(100.0 * count(*) filter (where outcome = 'expired') / count(*)) unreviewed_pct
  from rare_reports where outcome <> 'pending' group by 1 order by 1\`)
;(async () => {
  console.log('Reports by outcome (pending = still being followed):')
  console.table(await one(\"select outcome, count(*) n, round(avg(extract(epoch from settled_at - created_at) / 3600)) avg_hours from rare_reports group by 1 order by 1\"))
  console.log('Settled reports, by what was known when they went out:')
  console.table(await split('aba code', \"coalesce(aba::text, '?')\"))
  console.table(await split('photo/audio', 'media'))
  console.table(await split('birders', \"case when birders >= 2 then '2+' else '1' end\"))
  console.table(await split('described', \"coalesce(described::text, 'unknown')\"))
  console.table(await split('state', \"split_part(region, '-', 1) || '-' || split_part(region, '-', 2)\"))
  await knex.destroy()
})().catch((e) => { console.error(e.message); process.exit(1) })
"
