/**
 * Posts for the megas: ABA Code 4 and 5 birds, the ones worth stopping a feed for. Two drafts from
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const isMega = (aba) => aba === 4 || aba === 5

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
    return [head, rarity ? `${RARITY[pick.aba]} ${place}` : place, evidenceText(pick), url, hashtags ? tags(mega) : null].filter(Boolean).join('\n')
  }
  // Too long: #Megararity goes first, then the rarity line, then the hashtags, then the credit.
  for (const opts of [{}, { mega: false }, { mega: false, rarity: false }, { rarity: false, hashtags: false }, { rarity: false, hashtags: false, credited: false }]) {
    const text = build(opts)
    if (xLength(text, url) <= 280) return text
  }
  // A very long place name: shorten the name only, never the link or the access note.
  let name = placeName(pick.place.locName)
  while (name.length > 8 && xLength(build({ rarity: false, hashtags: false, credited: false, name }), url) > 280) name = `${name.slice(0, -2).trimEnd()}…`
  return build({ rarity: false, hashtags: false, credited: false, name })
}

/** The Facebook post: a few plain sentences, the access note on its own, then the link. */
const facebookDraft = (pick, url) => {
  const restricted = isRestricted(pick.place.locName)
  const credit = creditSentence(pick)
  const backing = [
    pick.observers > 1 && !credit ? `by ${pick.observers} observers` : null,
    pick.confirmed ? "confirmed by eBird's reviewers" : 'not yet reviewed by eBird'
  ].filter(Boolean).join(', and ')
  const story = `The ${pick.comName} ${RARITY_CLAUSE[pick.aba]}, and one has been reported at ${placeName(pick.place.locName)}${countyLong(pick)} on ${dateList(daysOf(pick))}, ${backing}.`
  return [
    `🚨 An ABA Code ${pick.aba} rarity in ${pick.stateName}: ${pick.comName.toUpperCase()}`,
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

const FACEBOOK_SHARE = (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`

module.exports = { isMega, isRestricted, placeName, dateList, xLength, xDraft, facebookDraft, creditText, creditSentence, FACEBOOK_SHARE, RARITY }
