/**
 * Field craft per species: where it lives, how to find it, and the time of day that pays. Written
 * for the Southeast (Georgia, the Carolinas, Florida) and kept in data/species-tips.json; general
 * guidance, which is why pages show the birders' own checklist notes above it.
 */
const TIPS = require('../data/species-tips.json')

const tipsFor = (speciesCode) => TIPS[speciesCode] || null

/** Bird records with their tips attached (null when we have none for the species). */
const withTips = (birds) => birds.map((bird) => ({ ...bird, tips: tipsFor(bird.speciesCode) }))

module.exports = { tipsFor, withTips, TIPS }
