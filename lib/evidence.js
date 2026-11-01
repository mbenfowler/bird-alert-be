const { metresBetween } = require('./hotspots')

/**
 * What stands behind a rare-bird report, so a person can judge it before they drive: whether an
 * eBird reviewer has accepted it, whether anyone got a photo or recording, and how many different
 * birders reported it. It's about the bird at that spot, so it's read from every report of the
 * species there (same place, or within a kilometre), not the one checklist alone: a fresh report of
 * a bird reviewers confirmed yesterday is a confirmed bird. Nothing is dropped for being
 * unconfirmed; it just says so.
 */
const NEAR_M = 1000
const MEDIA = { P: 'photo', A: 'audio', V: 'video' }

const nearby = (a, b) => (a.locId && a.locId === b.locId) ||
  (Number.isFinite(a.lat) && Number.isFinite(b.lat) && metresBetween(a, b) <= NEAR_M)

/** Pure: each report with `evidence: { confirmed, media, birders }` from every report of its species near it. */
const withEvidence = (records) => records.map((o) => {
  const same = records.filter((r) => r.speciesCode === o.speciesCode && nearby(o, r))
  const own = MEDIA[o.evidence] || (o.hasRichMedia ? 'photo' : null)
  const media = own || same.map((r) => MEDIA[r.evidence] || (r.hasRichMedia ? 'photo' : null)).find(Boolean) || null
  // Names when eBird gives them (the full feed does); otherwise each checklist counts as a birder.
  const birders = new Set(same.map((r) => r.userDisplayName || r.subId)).size
  return { ...o, evidence: { confirmed: same.some((r) => r.obsReviewed && r.obsValid), media, birders } }
})

/**
 * Pure: the reports left once birds eBird itself marks as escaped captives are dropped. The notable
 * feed doesn't carry eBird's exotic status; the recent feed for the same area does (exoticCategory
 * 'X' is an escapee), so a species eBird marks X there is left out of the notable reports. Naturalized
 * ('N') and provisional ('P') birds stay. Nothing is judged by the place's name: wild rarities turn
 * up at zoos too.
 */
const withoutEscapees = (notable, recent) => {
  const escaped = new Set(recent.filter((o) => o.exoticCategory === 'X').map((o) => o.speciesCode))
  return escaped.size ? notable.filter((o) => !escaped.has(o.speciesCode)) : notable
}

/** "Confirmed by eBird reviewer · photo · 3 birders", or "Unconfirmed: not yet reviewed · 1 birder". */
const evidenceLine = (evidence) => {
  if (!evidence) return ''
  return [
    evidence.confirmed ? 'Confirmed by eBird reviewer' : 'Unconfirmed: not yet reviewed',
    evidence.media,
    evidence.birders ? `${evidence.birders} ${evidence.birders === 1 ? 'birder' : 'birders'}` : null
  ].filter(Boolean).join(' · ')
}

/**
 * Whether a report has proof enough for someone who chose strict rare-bird alerts: an eBird
 * reviewer's OK, a photo or recording, or a second birder. An ordinary report (no evidence: accepted
 * as it came in, nothing flagged) always passes.
 */
const hasProof = (obs) => !obs.evidence || obs.evidence.confirmed || Boolean(obs.evidence.media) || obs.evidence.birders >= 2

module.exports = { withEvidence, withoutEscapees, evidenceLine, hasProof, NEAR_M }
