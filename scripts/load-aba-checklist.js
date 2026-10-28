#!/usr/bin/env node
/**
 * Loads the ABA Checklist's codes into `aba_codes` from the CSV the ABA publishes (download it
 * from https://www.aba.org/aba-checklist/ and unzip). The ABA allows the app to use the codes,
 * credited; the checklist itself is theirs, so keep the file out of this repository.
 *
 *   node scripts/load-aba-checklist.js ~/Downloads/ABA_Checklist-8.19.csv
 */
const fs = require('fs')
const db = require('../lib/db')
const { parseChecklist } = require('../lib/abaCodes')

/** A small CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
const readCsv = (text) => {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

const main = async () => {
  const file = process.argv[2]
  if (!file) throw new Error('Usage: node scripts/load-aba-checklist.js <ABA_Checklist.csv>')
  const text = fs.readFileSync(file, 'utf8')
  const version = (/Version ([\d.]+)/.exec(text) || [])[1]
  if (!version) throw new Error('This does not look like the ABA Checklist CSV (no "Version" line)')
  const species = parseChecklist(readCsv(text))
  if (species.length < 1000) throw new Error(`Only ${species.length} species read; expected about 1,160`)
  await db.transaction(async (trx) => {
    await trx('aba_codes').del()
    for (let i = 0; i < species.length; i += 200) {
      await trx('aba_codes').insert(species.slice(i, i + 200).map((s) => ({ sci_name: s.sciName, com_name: s.comName, code: s.code, version })))
        .onConflict('sci_name').merge()
    }
  })
  const byCode = {}
  for (const s of species) byCode[s.code] = (byCode[s.code] || 0) + 1
  console.log(`Loaded ABA Checklist ${version}: ${species.length} species`, byCode)
}

main().then(() => db.destroy()).catch((error) => { console.error(error.message); process.exit(1) })
