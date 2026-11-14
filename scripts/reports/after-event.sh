#!/bin/zsh
# After an event or trip: which place the owner's account is set to, the event's dates, push devices,
# and what each device's load check reported. Read-only; no emails or endpoints printed.
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
  const pick = Object.fromEntries(Object.entries(owner).filter(([k]) => /active_place|location|^state\$|return_seen|keep_home|timezone/.test(k)))
  console.log('Account:', JSON.stringify(pick))
  console.log('Places:')
  console.table(await one('select id, name, location, starts_on, ends_on, created_at, updated_at from places where user_id = ? order by id', [owner.id]).catch(e => [{ err: e.message }]))
  console.log('Events:')
  console.table(await one('select e.id, e.name, e.kind, e.location, e.starts_on, e.ends_on from events e where e.id in (select event_id from event_members where user_id = ?) order by e.starts_on desc limit 5', [owner.id]).catch(e => [{ err: e.message }]))
  console.log('Subscriptions:')
  console.table(await one(\"select split_part(split_part(endpoint, '//', 2), '/', 1) as service, left(device_id, 8) as device, created_at, last_seen_at, left(user_agent, 40) as ua from push_subscriptions where user_id = ? order by created_at\", [owner.id]))
  const trace = (await one('select detail from job_runs where kind = ?', ['sw-trace:' + owner.id]))[0]
  const events = (trace?.detail?.events || []).filter(e => e.at > new Date(Date.now() - 2 * 86400e3).toISOString())
  console.log('Trace, last 2 days, not push deliveries:')
  console.table(events.filter(e => e.event !== 'push').slice(-30).map(e => ({ at: e.at, dev: e.dev, event: e.event, v: e.version || e.bundle, what: JSON.stringify(e.result ?? e.target ?? e.title ?? '').slice(0, 40), ua: /iPhone/.test(e.ua || '') ? 'iphone' : /Mac/.test(e.ua || '') ? 'mac' : (e.ua || '').slice(0, 12) })))
  await knex.destroy()
})().catch((e) => { console.error(e.message); process.exit(1) })
"
