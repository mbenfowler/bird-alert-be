#!/bin/zsh
# User numbers and today's errors. Counts only, no emails or names. Read-only.
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
;(async () => {
  console.log('Users:')
  console.table(await one(\`select count(*)::int as total,
    count(*) filter (where email_confirmed)::int as confirmed,
    count(*) filter (where created_at > now() - interval '24 hours')::int as new_24h,
    count(*) filter (where created_at > now() - interval '7 days')::int as new_7d,
    count(*) filter (where last_seen_at > now() - interval '24 hours')::int as active_24h,
    count(*) filter (where last_seen_at > now() - interval '7 days')::int as active_7d,
    count(*) filter (where last_installed)::int as installed_app from users\`))
  console.log('Signups by day, last 10 days:')
  console.table(await one(\`select created_at::date as day, count(*)::int as signups from users where created_at > now() - interval '10 days' group by 1 order by 1 desc\`))
  console.log('Last device, active in 7 days:')
  console.table(await one(\`select coalesce(last_platform, 'unknown') as platform, count(*)::int as n from users where last_seen_at > now() - interval '7 days' group by 1 order by 2 desc\`))
  console.log('Errors in the last 24 hours, grouped:')
  console.table(await one(\`select regexp_replace(\"where\", '[0-9]+', 'N') as where_, left(regexp_replace(message, '[^ ]+@[^ ]+', '<email>', 'g'), 160) as message,
    count(*)::int as n, max(at) as last from error_log where at > now() - interval '24 hours' group by 1, 2 order by n desc limit 12\`))
  console.log('Mail sent by kind, last 2 days:')
  console.table(await one(\`select kind, sent_on::date as day, count(*)::int as sends from digest_log where sent_on >= current_date - 1 group by 1, 2 order by 2 desc, 1\`))
  await knex.destroy()
})().catch((e) => { console.error(e.message); process.exit(1) })
"
