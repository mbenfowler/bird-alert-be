/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */

const birdsData = require('../data/birdsData')

exports.seed = async function(knex) {
  try {
    const insertOperations = birdsData.map(bird => knex('birds').insert(bird, ['id', 'speciesCode']))
    // Execute all insert operations concurrently
    await Promise.all(insertOperations);
  } catch (error) {
    console.log(`Error seeding birds data: ${error}`)
  }
};
