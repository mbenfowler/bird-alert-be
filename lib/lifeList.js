const db = require('./db')
const ebird = require('./ebird')
const { HttpError } = require('./http')

/**
 * The life list. People tap "Seen it" on a bird, and an experienced birder can start the list
 * from eBird's life list export (eBird offers no way to read it for them). The export is matched
 * by scientific name against eBird's taxonomy, so names that changed between years still land.
 * What a life list leaves out, this leaves out: slashes, spuhs and hybrids can't say which
 * species was seen, and escapees eBird marks not countable (a park's Muscovy Duck) don't count.
 */
const TAXONOMY_DAYS = 90
const MAX_CSV_BYTES = 3_000_000
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** Rows of a CSV, quoted fields and doubled quotes included. */
const parseCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1 } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((f) => f.trim()))
}

/** "13 Oct 2026" (eBird's export) or "2026-10-13" to an ISO day; anything else is null. */
const parseDay = (value) => {
  const text = String(value || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const m = text.match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/)
  if (!m || !MONTHS[m[2].toLowerCase()]) return null
  return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

/** The export's rows as { comName, sciName, category, countable, exotic, day }. Header names, not positions. */
const exportRows = (text) => {
  const [header, ...rows] = parseCsv(String(text).replace(/^﻿/, ''))
  if (!header) throw new HttpError(400, 'The file is empty')
  const col = (name) => header.findIndex((h) => h.trim().toLowerCase() === name)
  const at = { com: col('common name'), sci: col('scientific name'), cat: col('category'), countable: col('countable'), exotic: col('exotic'), date: col('date'), loc: col('locid'), region: col('s/p') }
  if (at.sci < 0 && at.com < 0) throw new HttpError(400, 'That doesn’t look like an eBird life list export (no Common Name or Scientific Name column)')
  return rows.map((r) => ({
    comName: at.com >= 0 ? (r[at.com] || '').trim() : '',
    sciName: at.sci >= 0 ? (r[at.sci] || '').trim() : '',
    category: at.cat >= 0 ? (r[at.cat] || '').trim().toLowerCase() : 'species',
    countable: at.countable >= 0 ? (r[at.countable] || '').trim() !== '0' : true,
    exotic: at.exotic >= 0 ? (r[at.exotic] || '').trim().toUpperCase() : '',
    day: at.date >= 0 ? parseDay(r[at.date]) : null,
    locId: at.loc >= 0 && /^L\d{1,12}$/.test((r[at.loc] || '').trim()) ? r[at.loc].trim() : null,
    region: at.region >= 0 && /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test((r[at.region] || '').trim()) ? r[at.region].trim() : null
  }))
}

/** eBird's taxonomy on hand, refreshed every three months. */
const ensureTaxonomy = async () => {
  const row = await db('taxonomy_ref').min('fetched_at as at').count('* as n').first()
  if (Number(row?.n) > 0 && Date.now() - new Date(row.at).getTime() < TAXONOMY_DAYS * 86400000) return
  const taxa = await ebird.fullTaxonomy()
  const rows = taxa.filter((t) => t.speciesCode && t.sciName).map((t) => ({ species_code: t.speciesCode, sci_name: t.sciName, com_name: t.comName || t.sciName, category: t.category || 'species', report_as: t.reportAs || null, fetched_at: new Date() }))
  for (let i = 0; i < rows.length; i += 1000) await db('taxonomy_ref').insert(rows.slice(i, i + 1000)).onConflict('species_code').merge()
}

const SLASH_REASON = 'one of two species (often an old sighting from before eBird split it), so it’s yours to say which'
const SKIP_REASON = {
  slash: SLASH_REASON,
  spuh: 'not identified to species',
  hybrid: 'a hybrid',
  intergrade: 'an intergrade',
  domestic: 'a domestic type'
}

/** "Tringa semipalmata/inornata" names the species "Tringa semipalmata" and "Tringa inornata". */
const slashParts = (sciName) => {
  const [genus, rest] = String(sciName || '').split(/ (.+)/)
  if (!rest || !rest.includes('/')) return []
  return rest.split('/').map((epithet) => (epithet.includes(' ') ? epithet : `${genus} ${epithet}`).trim())
}

/**
 * What an export would put on the life list: the species codes with their first-seen day, and each
 * row left out with why. Pure but for `lookup(sciNames, comNames)`, which answers the taxonomy rows.
 */
const planImport = async (rows, lookup) => {
  const considered = rows.filter((r) => r.sciName || r.comName)
  const sciNames = considered.flatMap((r) => [r.sciName, ...slashParts(r.sciName)]).filter(Boolean)
  const taxa = await lookup(sciNames, considered.map((r) => r.comName).filter(Boolean))
  const bySci = new Map(taxa.map((t) => [t.sci_name.toLowerCase(), t]))
  const byCom = new Map(taxa.map((t) => [t.com_name.toLowerCase(), t]))
  const species = new Map()
  const skipped = []
  for (const r of considered) {
    const name = r.comName || r.sciName
    let taxon = bySci.get(r.sciName.toLowerCase()) || byCom.get(r.comName.toLowerCase())
    // One-or-the-other rows (a slash, or a sighting from before a split) offer the species to choose from.
    if (r.category === 'slash' || taxon?.category === 'slash') {
      const choices = slashParts(r.sciName).map((sci) => bySci.get(sci.toLowerCase())).filter((t) => t && t.category === 'species').map((t) => ({ speciesCode: t.species_code, comName: t.com_name }))
      // Where and when, so local reports can be asked which of the two it likely was.
      const where = r.day && (r.locId || r.region) ? { locId: r.locId, region: r.region, day: r.day } : null
      skipped.push({ name, reason: SLASH_REASON, ...(choices.length >= 2 ? { choices, ...(where ? { where } : {}) } : {}) })
      continue
    }
    if (SKIP_REASON[r.category]) { skipped.push({ name, reason: SKIP_REASON[r.category] }); continue }
    if (!r.countable) { skipped.push({ name, reason: r.exotic === 'X' ? 'an escapee eBird doesn’t count' : 'not countable on eBird', ...(taxon?.category === 'species' ? { choices: [{ speciesCode: taxon.species_code, comName: taxon.com_name }] } : {}) }); continue }
    // A subspecies group or form counts as its species.
    if (taxon && taxon.category !== 'species' && taxon.report_as) taxon = taxa.find((t) => t.species_code === taxon.report_as) || { species_code: taxon.report_as, category: 'species' }
    if (!taxon || taxon.category !== 'species') { skipped.push({ name, reason: 'not found in eBird’s current taxonomy' }); continue }
    const prior = species.get(taxon.species_code)
    if (!prior || (r.day && (!prior.day || r.day < prior.day))) species.set(taxon.species_code, { speciesCode: taxon.species_code, day: r.day || prior?.day || null })
  }
  return { species: [...species.values()], skipped }
}

const taxonomyLookup = async (sciNames, comNames) => {
  await ensureTaxonomy()
  const sci = [...new Set(sciNames.map((s) => s.toLowerCase()))]
  const com = [...new Set(comNames.map((s) => s.toLowerCase()))]
  const rows = await db('taxonomy_ref').whereRaw('lower(sci_name) = any(?)', [sci]).orWhereRaw('lower(com_name) = any(?)', [com])
  // Subspecies groups point at their species; fetch those too.
  const parents = [...new Set(rows.filter((r) => r.report_as).map((r) => r.report_as))].filter((code) => !rows.some((r) => r.species_code === code))
  return parents.length ? [...rows, ...await db('taxonomy_ref').whereIn('species_code', parents)] : rows
}

/** Starts or adds to the life list from an eBird export. Never removes anything. */
const importLifeList = async (userId, csv) => {
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(400, 'csv is required')
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) throw new HttpError(413, 'That file is too large')
  const { species, skipped } = await planImport(exportRows(csv), taxonomyLookup)
  const before = new Set(await db('seen_birds').where({ user_id: userId }).pluck('species_code'))
  if (species.length) {
    await db('seen_birds').insert(species.map((s) => ({ user_id: userId, species_code: s.speciesCode, first_seen: s.day, source: 'import' })))
      .onConflict(['user_id', 'species_code'])
      .merge({ first_seen: db.raw('least(seen_birds.first_seen, excluded.first_seen)') })
  }
  const added = species.filter((s) => !before.has(s.speciesCode)).length
  return { added, already: species.length - added, skipped, total: before.size + added }
}

/** The life list with each bird's name and place in the taxonomy (from our birds, else eBird's taxonomy), so it can be sorted and searched whole. */
const seenList = (userId) => db('seen_birds as s').where('s.user_id', userId)
  .leftJoin('birds as b', 'b.speciesCode', 's.species_code')
  .leftJoin('taxonomy_ref as t', 't.species_code', 's.species_code')
  .orderBy('s.species_code')
  .select('s.species_code as speciesCode', db.raw('to_char(s.first_seen, \'YYYY-MM-DD\') as "firstSeen"'), 's.source',
    db.raw('coalesce(b."comName", t.com_name) as "comName"'), db.raw('b."taxonOrder" as "taxonOrder"'))

const markSeen = (userId, speciesCode) => db('seen_birds').insert({ user_id: userId, species_code: speciesCode, first_seen: new Date().toISOString().slice(0, 10), source: 'tap' }).onConflict(['user_id', 'species_code']).ignore()
const unmarkSeen = (userId, speciesCode) => db('seen_birds').where({ user_id: userId, species_code: speciesCode }).del()

module.exports = { slashParts, parseCsv, parseDay, exportRows, planImport, importLifeList, seenList, markSeen, unmarkSeen }
