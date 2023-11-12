/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function(knex) {
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
      birdImg: 'https://images.unsplash.com/photo-1542252223-c7f5b1142f93',
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
