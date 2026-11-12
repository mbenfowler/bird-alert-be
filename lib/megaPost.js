/**
 * Posts for the megas: ABA Code 4, 5 and 6 birds, the ones worth stopping a feed for. Two drafts from
 * one pick, an X post (short, under X's 280) and a Facebook one (a few plain sentences), each with
 * how rare the code means, the evidence, the dates it was seen at the place, and, when eBird marks
 * the place private or restricted, a clear note not to go without permission (and no invitation
 * to go). Facts come only from the data: the code's meaning, the reports; nothing about the bird
 * itself is made up.
 */
const RARITY = {
  5: 'Only a handful of ABA records ever.',
  4: 'Not even seen every year in the ABA Area.'
}
// The same, inside a sentence: "The Mottled Owl has ..."
const RARITY_CLAUSE = {
  5: 'has only a handful of records ever in the ABA Area',
  4: "isn't seen every year in the ABA Area"
}

/**
 * Code 6 (no native birds left in the ABA Area) says what eBird makes of the birds: native ones would
 * be a rediscovery; introduced ones (eBird's exotic status: N naturalized, P provisional, X escaped)
 * are a feral or escaped population, worth posting but never passed off as a rediscovery.
 */
const SIX = {
  native: { line: 'Believed gone from the ABA Area: a rediscovery if it holds up.', clause: 'is believed extinct or gone from the ABA Area' },
  N: { line: 'eBird: introduced, established. No native birds left in the ABA Area.', clause: 'has no native birds left in the ABA Area, and eBird counts these as an established introduced population' },
  P: { line: 'eBird: Exotic, Provisional (feral). No native birds left in the ABA Area.', clause: 'has no native birds left in the ABA Area, and eBird marks these as a provisional exotic population (feral birds)' },
  X: { line: 'eBird: escaped birds. No native birds left in the ABA Area.', clause: 'has no native birds left in the ABA Area, and eBird marks these as escaped birds' }
}
const sixOf = (pick) => SIX[pick.exotic] || SIX.native
const rarityLine = (pick) => (pick.aba === 6 ? sixOf(pick).line : RARITY[pick.aba])
const rarityClause = (pick) => (pick.aba === 6 ? sixOf(pick).clause : RARITY_CLAUSE[pick.aba])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const isMega = (aba) => aba === 4 || aba === 5 || aba === 6

/** eBird marks such places in their names: "Santa Margarita Ranch (restricted access)", "(private)". */
const isRestricted = (locName) => /restricted access|\(private/i.test(String(locName || ''))

/** The place as a person would say it: eBird's "--" as a dash, and the access note left to its own line. */
const placeName = (locName) => String(locName || '').replace(/\s*\((?:[^)]*restricted access[^)]*|private[^)]*)\)?/gi, '').replace(/--/g, ' – ').replace(/\s+/g, ' ').trim()

/** "Oct 31"; "Oct 24 and Oct 31"; "Oct 20, Oct 24 and Oct 31". */
const dateList = (days) => {
  const words = [...new Set(days)].sort().map((d) => { const [, m, day] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${day}` })
  return words.length <= 1 ? (words[0] || '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

const tag = (name) => String(name || '').normalize('NFD').replace(/[^A-Za-z]/g, '')
const isUS = (pick) => String(pick.state || '').startsWith('US-')
const countyShort = (pick) => (!pick.place.county ? '' : isUS(pick) ? `, ${pick.place.county} Co.` : `, ${pick.place.county}`)
const countyLong = (pick) => (!pick.place.county ? '' : isUS(pick) ? ` in ${pick.place.county} County` : ` in ${pick.place.county}`)
const daysOf = (pick) => pick.place.days?.length ? pick.place.days : [String(pick.place.obsDt || pick.latest || '').slice(0, 10)].filter(Boolean)

/**
 * X's count: a link is always 23, an emoji (anything outside the basic plane, and a few symbols)
 * counts 2. Close enough to keep a draft from being refused.
 */
const xLength = (text, url) => {
  const body = url ? text.split(url).join('x'.repeat(23)) : text
  let n = 0
  for (const ch of body) n += ch.codePointAt(0) > 0xffff || /[☀-➿]/.test(ch) ? 2 : 1
  return n
}

const evidenceText = (pick) => [
  pick.confirmed ? '✅ Confirmed by eBird reviewers' : '⏳ Not yet reviewed by eBird',
  // The credit, when there is one, already counts them.
  pick.observers > 1 && !creditText(pick) ? `${pick.observers} observers` : null,
  pick.place.media ? '📷 photo' : null
].filter(Boolean).join(' · ')

/** The X post: under 280 by X's count; the rarity line goes first when it's long, then the hashtags. */
const xDraft = (pick, url) => {
  const restricted = isRestricted(pick.place.locName)
  const seen = (name) => `Seen ${dateList(daysOf(pick))} at ${name}${countyShort(pick)}${restricted ? ' (private, by arrangement only 🙏)' : ''}`
  const head = `🚨 ABA CODE ${pick.aba} · ${pick.comName.toUpperCase()} in ${pick.stateName}!`
  const tags = (mega) => `#birding #rarebird #${tag(pick.stateName)}birds${mega ? ' #Megararity' : ''}`
  const credit = creditText(pick)
  const build = ({ rarity = true, hashtags = true, mega = true, credited = true, name = placeName(pick.place.locName) } = {}) => {
    const place = `${seen(name)}${credited && credit ? ` · ${credit}` : ''}`
    return [head, rarity ? `${rarityLine(pick)} ${place}` : place, evidenceText(pick), url, hashtags ? tags(mega) : null].filter(Boolean).join('\n')
  }
  // Too long: #Megararity goes first, then the rarity line, then the hashtags, then the credit. A
  // Code 6 keeps its line (what eBird makes of the birds is the news), so the others go first.
  const keep = pick.aba === 6
  for (const opts of [{}, { mega: false }, { mega: false, rarity: keep }, { rarity: keep, hashtags: false }, { rarity: keep, hashtags: false, credited: false }]) {
    const text = build(opts)
    if (xLength(text, url) <= 280) return text
  }
  // A very long place name: shorten the name only, never the link or the access note.
  let name = placeName(pick.place.locName)
  while (name.length > 8 && xLength(build({ rarity: keep, hashtags: false, credited: false, name }), url) > 280) name = `${name.slice(0, -2).trimEnd()}…`
  return build({ rarity: keep, hashtags: false, credited: false, name })
}

/** The Facebook post: a few plain sentences, the access note on its own, then the link. */
const facebookDraft = (pick, url) => {
  const restricted = isRestricted(pick.place.locName)
  const credit = creditSentence(pick)
  const backing = [
    pick.observers > 1 && !credit ? `by ${pick.observers} observers` : null,
    pick.confirmed ? "confirmed by eBird's reviewers" : 'not yet reviewed by eBird'
  ].filter(Boolean).join(', and ')
  const story = `The ${pick.comName} ${rarityClause(pick)}, and one has been reported at ${placeName(pick.place.locName)}${countyLong(pick)} on ${dateList(daysOf(pick))}, ${backing}.`
  return [
    pick.aba === 6 ? `🚨 ABA Code 6 in ${pick.stateName}: ${pick.comName.toUpperCase()}` : `🚨 An ABA Code ${pick.aba} rarity in ${pick.stateName}: ${pick.comName.toUpperCase()}`,
    '',
    credit ? `${story} ${credit}` : story,
    ...(restricted ? ['', "Please note: it's on private land with restricted access, visits by arrangement only. Please don't go without permission."] : []),
    '',
    `Details and map: ${url}`
  ].join('\n')
}

const isPrivate = (pick) => Boolean(pick.place.locationPrivate) || isRestricted(pick.place.locName)
const others = (n) => `${n} ${n === 1 ? 'other' : 'others'}`

/**
 * Who found it, for a draft (finderCredit puts `credit` on the pick): "found by Jane Smith (and 3
 * others)" when the first report is within what we can see; "reported by …" when the bird may have
 * been there longer; a private or restricted place never names anyone. Null when there's nothing to say.
 */
const creditText = (pick, { short = false } = {}) => {
  const c = pick.credit
  if (!c) return null
  if (isPrivate(pick) || !c.name) return c.observers > 1 ? `reported by ${c.observers} observers` : null
  if (c.verified) return `found by ${c.name}${!short && c.others ? ` (and ${others(c.others)})` : ''}`
  return `reported by ${c.name}${!short && c.others ? ` and ${others(c.others)}` : ''}`
}

/** The same as a sentence, for the Facebook draft. */
const creditSentence = (pick) => {
  const c = pick.credit
  if (!c) return null
  if (isPrivate(pick) || !c.name) return c.observers > 1 ? `Reported by ${c.observers} observers.` : null
  if (c.verified) return `First reported by ${c.name} on ${dateList([c.firstDay])}${c.others ? `, with ${others(c.others)} since` : ''}.`
  return `Reported by ${c.name}${c.others ? ` and ${others(c.others)}` : ''}.`
}

/**
 * Drafts for a bird that's been around a while (the HQ desk's "Still around"): an update, not news.
 * "present since" comes from the 30-day history behind the finder credit; the rules for names and
 * private places are the same as for a new find.
 */
const stillDrafts = (pick, url) => {
  const c = pick.credit || {}
  const restricted = isRestricted(pick.place.locName)
  const code = pick.aba >= 3 && pick.aba <= 5 ? pick.aba : null
  const since = c.firstDay ? dateList([c.firstDay]) : null
  const last = c.lastDay ? dateList([c.lastDay]) : null
  const count = c.checklists || pick.checklists
  const span = [since ? `since ${since}` : null, last && last !== since ? `last seen ${last}` : null, count ? `${count} ${count === 1 ? 'checklist' : 'checklists'}` : null].filter(Boolean).join(', ')
  const head = `👀 Still being seen: ${pick.comName.toUpperCase()} in ${pick.stateName}${code ? ` · ABA Code ${code}` : ''}`
  const tags = `#birding #rarebird #${tag(pick.stateName)}birds`
  const credit = creditText(pick)
  const build = ({ hashtags = true, credited = true, spanned = true, name = placeName(pick.place.locName) } = {}) => [
    head,
    `📍 ${name}${countyShort(pick)}${restricted ? ' (private, by arrangement only 🙏)' : ''}${spanned && span ? ` · ${span}` : ''}${credited && credit ? ` · ${credit}` : ''}`,
    pick.confirmed ? '✅ Confirmed by eBird reviewers' : null,
    url,
    hashtags ? tags : null
  ].filter(Boolean).join('\n')
  // Too long: the hashtags go first, then the credit, then the dates; the link and access note never.
  let x = null
  for (const opts of [{}, { hashtags: false }, { hashtags: false, credited: false }, { hashtags: false, credited: false, spanned: false }]) {
    const text = build(opts)
    if (xLength(text, url) <= 280) { x = text; break }
  }
  if (!x) {
    let name = placeName(pick.place.locName)
    while (name.length > 8 && xLength(build({ hashtags: false, credited: false, spanned: false, name }), url) > 280) name = `${name.slice(0, -2).trimEnd()}…`
    x = build({ hashtags: false, credited: false, spanned: false, name })
  }
  const sentence = credit ? creditSentence(pick) : null
  const story = `It has been reported at ${placeName(pick.place.locName)}${countyLong(pick)}${since ? ` since ${since}` : ''}${last && last !== since ? `, most recently on ${last}` : ''}${count ? `, on ${count} ${count === 1 ? 'checklist' : 'checklists'}` : ''}${pick.confirmed ? ", confirmed by eBird's reviewers" : ''}.`
  const fb = [
    `👀 Still being seen in ${pick.stateName}: ${pick.comName.toUpperCase()}${code ? ` (ABA Code ${code})` : ''}`,
    '',
    sentence ? `${story} ${sentence}` : story,
    ...(restricted ? ['', "Please note: it's on private land with restricted access, visits by arrangement only. Please don't go without permission."] : []),
    '',
    `Details and map: ${url}`
  ].join('\n')
  return { draft: x, fbDraft: fb }
}

const FACEBOOK_SHARE = (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`

module.exports = { isMega, sixOf, isRestricted, placeName, dateList, xLength, xDraft, facebookDraft, stillDrafts, creditText, creditSentence, FACEBOOK_SHARE, RARITY }
