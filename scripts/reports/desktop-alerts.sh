#!/bin/zsh
# Why the desktop never sounds a rare-bird alert: the owner's push settings, subscriptions, what
# was sent lately, and what each device's worker and page reported. No emails or endpoints. Read-only.
set -e
cd "${0:A:h}/../.."
# Your own account: OWNER_EMAIL, or the one line in scripts/reports/.owner (not committed; the repo is public).
export OWNER_LOOKUP="${OWNER_EMAIL:-$(cat scripts/reports/.owner 2>/dev/null)}"
[[ -n $OWNER_LOOKUP ]] || { echo "Put your account email in scripts/reports/.owner (or set OWNER_EMAIL)" >&2; exit 1 }
tmp=$(mktemp)
npx vercel env pull --environment=production --yes "$tmp" </dev/null >/dev/null 2>&1
set -a; . "$tmp"; set +a
rm -f "$tmp"
export NODE_ENV=production SESSION_SECRET=dummy-local-secret-for-read-only-checks-0123456789
PGOPTIONS='-c default_transaction_read_only=on' node -e "
const knex = require('knex')({ client: 'pg', connection: process.env.PROD_PG_URL })
const one = async (sql, b = []) => (await knex.raw(sql, b)).rows
;(async () => {
  const owner = (await one('select * from users where lower(email) = lower(?)', [process.env.OWNER_LOOKUP]))[0]
  if (!owner) { console.log('Owner account not found'); return knex.destroy() }
  const pick = Object.fromEntries(Object.entries(owner).filter(([k]) => /^push_|rare_alerts|keep_home|timezone|quiet/.test(k)))
  console.log('Push settings:', JSON.stringify(pick))
  console.log('Subscriptions:')
  console.table(await one(\"select split_part(split_part(endpoint, '//', 2), '/', 1) as service, origin, left(device_id, 8) as device, created_at, last_seen_at, left(user_agent, 50) as ua from push_subscriptions where user_id = ? order by created_at\", [owner.id]))
  console.log('Push log, last 14 days, by kind:')
  console.table(await one(\"select kind, coalesce(review_state, '-') as state, count(*)::int as n, max(created_at) as last from push_log where user_id = ? and created_at > now() - interval '14 days' group by 1, 2 order by 1, 2\", [owner.id]))
  console.log('Latest 12 sent:')
  console.table(await one(\"select created_at, kind, \\\"speciesCode\\\" as code, coalesce(review_state, '-') as state from push_log where user_id = ? order by created_at desc limit 12\", [owner.id]))
  const trace = (await one('select detail from job_runs where kind = ?', ['sw-trace:' + owner.id]))[0]
  const events = trace?.detail?.events || []
  console.log('Trace events by device (newest last):')
  console.table(events.filter((e) => !/iPhone|iPad/.test(e.ua || '')).slice(-25).map((e) => ({ at: e.at, dev: e.dev, event: e.event, v: e.version || e.bundle, title: (e.title || e.target || e.result || '').slice(0, 34), wins: (e.windows || []).map((w) => (w.visibility || '?')[0] + (w.focused ? 'F' : '')).join(','), ua: /Mac/.test(e.ua || '') ? 'mac' : (e.ua || '').slice(0, 12) })))
  await knex.destroy()
})().catch((e) => { console.error(e.message); process.exit(1) })
"
