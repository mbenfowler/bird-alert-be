/**
 * Pure: the browser's note of what brought a visitor in, cut down to what's safe to keep. Anything
 * that doesn't look right is dropped rather than rejected, so a signup never fails over it.
 */
const LANDINGS = new Set(['home', 'share-sighting', 'share-route', 'login', 'other'])

const cleanSignupSource = (input) => {
  if (!input || typeof input !== 'object') return null
  const out = {}
  const host = String(input.ref || '').toLowerCase()
  if (/^[a-z0-9.-]{1,60}$/.test(host) && host.includes('.')) out.ref = host.replace(/^www\./, '')
  const utm = String(input.utm || '').toLowerCase()
  if (/^[a-z0-9_-]{1,40}$/.test(utm)) out.utm = utm
  if (/^[A-Za-z0-9]{10}$/.test(String(input.share || ''))) out.share = String(input.share)
  if (LANDINGS.has(input.landing)) out.landing = input.landing
  return Object.keys(out).length ? out : null
}

/** One word for a source, for counting: the utm tag, else the referring site, else "direct". */
const sourceLabel = (s) => {
  if (!s) return 'unknown'
  if (s.utm) return s.utm
  const ref = s.ref || ''
  if (/(^|\.)instagram\.com$/.test(ref)) return 'instagram'
  if (ref === 't.co' || /(^|\.)(x|twitter)\.com$/.test(ref)) return 'x'
  if (/(^|\.)facebook\.com$/.test(ref) || ref === 'fb.me') return 'facebook'
  if (/(^|\.)google\.[a-z.]+$/.test(ref)) return 'google'
  if (ref) return ref
  return s.share ? 'share link' : 'direct'
}

module.exports = { cleanSignupSource, sourceLabel }
