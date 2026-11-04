const crypto = require('crypto')
const { appUrl } = require('./appUrl')

/**
 * "Invite a birding friend" links: https://bird-alert.vercel.app/?ref=invite-<code>, where <code> is
 * the inviter's id in base 36, a dash, and six base-36 characters of an HMAC of that id. The id alone
 * names no one (no email in it), and the HMAC means codes can't be guessed or walked through. Nothing
 * is stored: a code is checked by working it out again. INVITE_SECRET, when set, keeps codes apart from
 * the session secret (and alive if that's ever rotated); otherwise SESSION_SECRET signs them.
 */
const PREFIX = 'invite-'
const secret = () => process.env.INVITE_SECRET || process.env.SESSION_SECRET

const tag = (id) => BigInt('0x' + crypto.createHmac('sha256', secret()).update(`invite:${id}`).digest('hex')).toString(36).slice(0, 6).padStart(6, '0')

/** Pure: the code for a user id. */
const inviteCode = (id) => {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('inviteCode needs a user id')
  return `${id.toString(36)}-${tag(id)}`
}

/** The link a person shares, and its code. */
const inviteLink = (id) => {
  const code = inviteCode(id)
  return { url: appUrl(`/?ref=${PREFIX}${code}`), code }
}

/**
 * Pure: what a ?ref= value says. null when it isn't an invite at all; { inviter } when the code checks
 * out; { inviter: null } for an invite-shaped value whose code is forged, garbled or missing, so the
 * signup still counts as from an invite, with no one credited.
 */
const readInvite = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw.startsWith(PREFIX) || raw.length > 60) return null
  const m = /^([0-9a-z]{1,11})-([0-9a-z]{6})$/.exec(raw.slice(PREFIX.length))
  if (!m) return { inviter: null }
  const id = parseInt(m[1], 36)
  if (!Number.isSafeInteger(id) || id <= 0 || id.toString(36) !== m[1]) return { inviter: null }
  const ok = crypto.timingSafeEqual(Buffer.from(tag(id)), Buffer.from(m[2]))
  return { inviter: ok ? id : null }
}

module.exports = { inviteCode, inviteLink, readInvite, INVITE_PREFIX: PREFIX }
