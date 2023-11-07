const { configDotenv } = require("dotenv");
configDotenv();
const environment = process.env.NODE_ENV || 'development';
const configuration = require('../knexfile')[environment];
const db = require('knex')(configuration);

module.exports = async (req, res) => {
  try {
    await seedFunction(db); // Replace with your actual seeding code.
    res.status(200).json({ message: 'Database seeded successfully.' });
  } catch (error) {
    console.error('Seed Error:', error);
    res.status(500).json({ error });
  }
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
const seedFunction = async (knex) => {
  // Deletes ALL existing entries
  try {
    await knex('saved_birds').del()
    await knex('birds').del()
    await knex('users').del()

    const [userID] = await knex('users').insert({
      username: '',
      password: '',
      email: 'robinware456@gmail.com',
      phone: '555-555-5555',
      location: 'US-GA-139',
      state: ''
    }, 'id')

    const [birdID] = await knex('birds').insert({
      comName: 'Snow Goose',
      sciName: 'Anser caerulescens',
      speciesCode: 'snogoo',
      category: 'species',
      order: 'Anseriformes',
      familyCode: 'anatid1',
      familyComName: 'Ducks, Geese, and Waterfowl',
      familySciName: 'Anatidae',
      wikiURL: 'https://en.wikipedia.org/?curid=199013',
      taxonOrder: 256
    }, ['id', 'speciesCode'])

    return knex('saved_birds').insert({
      speciesCode: birdID.speciesCode,
      user_id: userID.id,
      bird_id: birdID.id
    })
  } catch (error) {
    console.log(`Error seeding data: ${error}`)
  }
};
