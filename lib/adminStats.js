const db = require('./db')
const { sourceLabel } = require('./signupSource')

const DB_LIMIT_BYTES = 512 * 1024 * 1024 // Neon's free plan
const MAIL_CAP = 450 // lib/mailer.js's daily cap for the Gmail account
const HOUR = 3_600_000
// How stale each background job may get before the email flags it: the hourly ones get a missed
// run's grace, the daily ones a few hours, the weekly migration email a day.
const JOBS = [
  { kind: 'push', label: 'Push alerts (hourly)', within: 2.5 * HOUR },
  { kind: 'checklist-sync:%', label: 'Checklist sync (hourly)', within: 2.5 * HOUR },
  { kind: 'watchlist', label: 'Watch-list digest (daily)', within: 28 * HOUR },
  { kind: 'rare', label: 'Uncommon-sightings email (daily)', within: 28 * HOUR },
  { kind: 'retention', label: 'Storage cleanup (daily)', within: 28 * HOUR },
  { kind: 'migration', label: 'Migration email (weekly)', within: 8 * 24 * HOUR }
]

const n = (v) => Number(v || 0)

/** Where a throttled hourly sync is logged in error_log, so the numbers can count it. */
const EBIRD_THROTTLED = 'eBird throttled the checklist sync'
const DAILY_DETAILS = 24 * 200 // lib/checklists.js HOURLY_DETAILS, a day of it
// lib/whereToGo's line between a new area still gathering checklists and an established one.
const GATHERING_BELOW = 20

/** The app's last 24 hours, for the admin section of the morning HQ email. */
const adminStats = async ({ now = new Date() } = {}) => {
  const since = new Date(now.getTime() - 24 * HOUR)
  const week = new Date(now.getTime() - 7 * 24 * HOUR)
  const [signups, totals, topStates, topCounties, pushes, emails, mail, errors, runs, size, reach, ebird, spread, feedback] = await Promise.all([
    db('users').where('created_at', '>=', since).orderBy('created_at').select('id', 'location', 'state', 'email_confirmed', 'signup_source', 'created_at'),
    db('users').first(
      db.raw('count(*) as users'), db.raw('count(*) filter (where email_confirmed) as confirmed'),
      db.raw("count(distinct location) filter (where location <> '') as counties"), db.raw("count(distinct state) filter (where state <> '') as states"),
      db.raw('count(*) filter (where last_seen_at >= ?) as seen_day', [since]), db.raw('count(*) filter (where last_seen_at >= ?) as seen_week', [week])),
    db('users').whereNot('state', '').whereNotNull('state').groupBy('state').select('state').count('* as users')
      .select(db.raw('count(*) filter (where last_seen_at >= ?) as seen', [since])).orderBy('users', 'desc').limit(5),
    db('users').whereNot('location', '').whereNotNull('location').groupBy('location').select('location').count('* as users')
      .select(db.raw('count(*) filter (where last_seen_at >= ?) as seen', [since])).orderBy('users', 'desc').limit(5),
    db('push_log').where('created_at', '>=', since).count('* as n').first(),
    db('digest_log').where('created_at', '>=', since).groupBy('kind').select('kind').count('* as n'),
    db('mail_counts').orderBy('day', 'desc').first('day', 'sent'),
    db('error_log').where('at', '>=', since).groupBy('where').select('where').count('* as n').orderBy('n', 'desc').limit(5),
    db('job_runs').select('kind', 'ran_at'),
    db.raw('select pg_database_size(current_database()) as bytes'),
    // Is it reaching people: devices that can take a push, and watch-list emails sent as the no-device fallback.
    db.raw(`select (select count(distinct user_id) from push_subscriptions) as devices,
      (select count(*) from users where last_seen_at is not null and last_seen_at::date > created_at::date) as returned,
      (select count(*) from digest_log d join users u on u.id = d.user_id where d.kind = 'watchlist' and d.created_at >= ? and coalesce(u.alert_digest_email_enabled, false) = false) as fallback`, [since]),
    // eBird: what the day fetched in full, how often it was throttled, and areas still filling in.
    db.raw(`select (select count(*) from checklists where detail_fetched_at >= ?) as details,
      (select count(*) from error_log where "where" = ? and at >= ?) as throttled,
      (select count(*) from (select u.location from users u where u.location <> '' group by u.location
        having (select count(*) from checklists c where c.region = u.location and c.detail_fetched_at is not null and c.obs_day >= ?) < ?) g) as gathering`,
      [since, EBIRD_THROTTLED, since, new Date(now.getTime() - 14 * 24 * HOUR).toISOString().slice(0, 10), GATHERING_BELOW]),
    db.raw('select count(*) filter (where created_at >= ?) as today, count(*) as total, coalesce(sum(views), 0) as views from shares', [since]),
    db('feedback').where('created_at', '>=', since).orderBy('created_at').select('kind', 'message')
  ])
  const jobs = JOBS.map(({ kind, label, within }) => {
    const matching = runs.filter((r) => (kind.endsWith('%') ? r.kind.startsWith(kind.slice(0, -1)) : r.kind === kind))
    const last = matching.length ? Math.max(...matching.map((r) => new Date(r.ran_at).getTime())) : null
    return { label, last: last ? new Date(last) : null, late: !last || now.getTime() - last > within }
  })
  return {
    signups: signups.map((u) => ({ id: u.id, location: u.location, state: u.state, confirmed: Boolean(u.email_confirmed), source: sourceLabel(u.signup_source), at: u.created_at })),
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, n(v)])),
    topStates: topStates.map((r) => ({ state: r.state, users: n(r.users), seen: n(r.seen) })),
    topCounties: topCounties.map((r) => ({ location: r.location, users: n(r.users), seen: n(r.seen) })),
    pushes: n(pushes?.n),
    emails: Object.fromEntries(emails.map((r) => [r.kind, n(r.n)])),
    mailToday: mail ? { day: mail.day, sent: n(mail.sent), cap: MAIL_CAP } : null,
    errors: errors.map((r) => ({ where: r.where, n: n(r.n) })),
    jobs,
    db: { bytes: n(size.rows[0].bytes), limit: DB_LIMIT_BYTES },
    reach: { devices: n(reach.rows[0].devices), returned: n(reach.rows[0].returned), fallback: n(reach.rows[0].fallback) },
    ebird: { details: n(ebird.rows[0].details), budget: DAILY_DETAILS, throttled: n(ebird.rows[0].throttled), gathering: n(ebird.rows[0].gathering) },
    shares: { today: n(spread.rows[0].today), total: n(spread.rows[0].total), views: n(spread.rows[0].views) },
    feedback: feedback.map((f) => ({ kind: f.kind, line: String(f.message || '').split('\n')[0].slice(0, 140) }))
  }
}

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`
const ago = (date, now) => {
  if (!date) return 'never'
  const h = (now - date) / HOUR
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`
}

/** Pure: the admin section's HTML and plain text, from adminStats. */
const adminSection = (s, { now = new Date() } = {}) => {
  const t = s.totals
  const p = (text) => `<p style="margin:0 0 6px;font-size:14px;color:#2b2b2b">${text}</p>`
  const late = s.jobs.filter((j) => j.late)
  const dbPct = Math.round((s.db.bytes / s.db.limit) * 100)
  const confirmedToday = s.signups.filter((u) => u.confirmed).length
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0)
  const red = (text) => `<span style="color:#b00020">${text}</span>`
  const lines = [
    `<h2 style="font-size:17px;margin:24px 0 8px;padding-top:16px;border-top:2px solid #111">App, last 24 hours</h2>`,
    p(`<strong>${s.signups.length} new ${s.signups.length === 1 ? 'signup' : 'signups'}</strong> · ${t.users} users (${t.confirmed} confirmed) in ${t.counties} counties, ${t.states} states`),
    ...s.signups.map((u) => p(`&nbsp;&nbsp;#${u.id} ${escapeHtml(u.location || 'no county')} · from ${escapeHtml(u.source)} · ${u.confirmed ? 'confirmed' : 'not confirmed yet'}`)),
    p(`<strong>Reaching people:</strong> ${confirmedToday} of ${s.signups.length} new ${s.signups.length === 1 ? 'signup' : 'signups'} confirmed · ${t.confirmed} of ${t.users} confirmed overall (${pct(t.confirmed, t.users)}%) · ${s.reach.devices} with push on a device · ${s.reach.fallback} watch-list ${s.reach.fallback === 1 ? 'email' : 'emails'} sent for want of a device`),
    p(`<strong>Coming back:</strong> ${t.seen_day} opened the app today, ${t.seen_week} this week · ${s.reach.returned} came back on a later day than they signed up`),
    s.topStates.length ? p(`<strong>Top states:</strong> ${s.topStates.map((r) => `${escapeHtml(r.state)} ${r.users}${r.seen ? ` (${r.seen} today)` : ''}`).join(', ')}`) : '',
    s.topCounties.length ? p(`<strong>Top counties:</strong> ${s.topCounties.map((r) => `${escapeHtml(r.location)} ${r.users}${r.seen ? ` (${r.seen} today)` : ''}`).join(', ')}`) : '',
    p(`<strong>Sent:</strong> ${s.pushes} pushes; emails ${Object.keys(s.emails).length ? Object.entries(s.emails).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(', ') : 'none'}${s.mailToday ? ` · Gmail ${s.mailToday.sent} of ${s.mailToday.cap} on ${String(s.mailToday.day).slice(0, 10)}${s.mailToday.sent >= 0.7 * s.mailToday.cap ? ' <span style="color:#b00020">⚠️ past 70% of the daily cap: time to look at a sending domain</span>' : ''}` : ''}`),
    p(`<strong>eBird:</strong> ${s.ebird.details} checklists fetched in full (budget ${s.ebird.budget.toLocaleString('en-US')} a day) · ${s.ebird.throttled ? red(`⚠️ throttled ${s.ebird.throttled} ${s.ebird.throttled === 1 ? 'time' : 'times'}`) : 'never throttled'} · ${s.ebird.gathering} ${s.ebird.gathering === 1 ? 'area' : 'areas'} still gathering checklists`),
    p(`<strong>Spreading:</strong> ${s.shares.today} ${s.shares.today === 1 ? 'share' : 'shares'} made today · ${s.shares.total} in all, viewed ${s.shares.views} times`),
    ...(s.feedback.length ? [p(`<strong>Feedback (${s.feedback.length}):</strong>`), ...s.feedback.map((f) => p(`&nbsp;&nbsp;${escapeHtml(f.kind)}: “${escapeHtml(f.line)}”`))] : []),
    p(`<strong>Errors:</strong> ${s.errors.length ? s.errors.map((e) => `${escapeHtml(e.where)} ×${e.n}`).join(', ') : 'none'}`),
    p(`<strong>Jobs:</strong> ${late.length ? `<span style="color:#b00020">⚠️ late: ${late.map((j) => `${escapeHtml(j.label)} (last ${ago(j.last, now)})`).join('; ')}</span>` : 'all on time'}`),
    p(`<strong>Database:</strong> ${mb(s.db.bytes)} of ${mb(s.db.limit)} (${dbPct}%)${dbPct >= 70 ? ' <span style="color:#b00020">⚠️ time to compact the history (option B)</span>' : ''}`)
  ]
  const text = [
    `App, last 24 hours: ${s.signups.length} new signups; ${t.users} users in ${t.counties} counties`,
    ...s.signups.map((u) => `  #${u.id} ${u.location || 'no county'} from ${u.source}${u.confirmed ? '' : ' (not confirmed)'}`),
    `Reaching people: ${confirmedToday} of ${s.signups.length} new confirmed; ${t.confirmed} of ${t.users} overall; ${s.reach.devices} push devices; ${s.reach.fallback} fallback emails`,
    `Coming back: ${t.seen_day} today, ${t.seen_week} this week; ${s.reach.returned} returned on a later day`,
    `eBird: ${s.ebird.details} fetched of ${s.ebird.budget}; throttled ${s.ebird.throttled}; ${s.ebird.gathering} areas gathering`,
    `Spreading: ${s.shares.today} shares today; ${s.shares.total} in all, ${s.shares.views} views`,
    ...s.feedback.map((f) => `Feedback ${f.kind}: ${f.line}`),
    `Sent: ${s.pushes} pushes; emails ${JSON.stringify(s.emails)}`,
    `Errors: ${s.errors.length ? s.errors.map((e) => `${e.where} x${e.n}`).join(', ') : 'none'}`,
    `Jobs: ${late.length ? 'LATE ' + late.map((j) => j.label).join('; ') : 'all on time'}`,
    `Database: ${mb(s.db.bytes)} of ${mb(s.db.limit)} (${dbPct}%)`
  ].join('\n')
  return { html: lines.filter(Boolean).join('\n'), text }
}

module.exports = { adminStats, adminSection, JOBS, EBIRD_THROTTLED }
