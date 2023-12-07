/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function(knex) {
  try {
    await knex('saved_birds').del()
    await knex('birds').del()
    await knex('users').del()

    await require('./001_users').seed(knex);
    await require('./002_birds').seed(knex);
    await require('./003_saved_birds').seed(knex);
  } catch (error) {
    console.log(`Error seeding data: ${error}`)
  }
};
