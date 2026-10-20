const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://bird-alert.vercel.app').replace(/\/$/, '')

/** Absolute URL into the front end, for links in emails and notifications. */
const appUrl = (path) => `${APP_BASE_URL}${path}`

module.exports = { appUrl, APP_BASE_URL }
