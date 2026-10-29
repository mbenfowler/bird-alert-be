// Only a real https address counts: a value pulled from Vercel outside Vercel can be a placeholder
// like "[SENSITIVE]", and every link in an email would break.
const configured = String(process.env.APP_BASE_URL || '')
const APP_BASE_URL = (/^https?:\/\/[^\s/[\]]+/.test(configured) ? configured : 'https://bird-alert.vercel.app').replace(/\/$/, '')

/** Absolute URL into the front end, for links in emails and notifications. */
const appUrl = (path) => `${APP_BASE_URL}${path}`

module.exports = { appUrl, APP_BASE_URL }
