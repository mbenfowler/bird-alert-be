/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function(knex) {
  try {
    const [user1ID, user2ID] = await knex('users').select('id');
    const birdsData = await knex('birds').select('id', 'speciesCode');

    const snogooID = birdsData.find(bird => bird.speciesCode === 'snogoo').id;
    await knex('saved_birds').insert({
      speciesCode: 'snogoo',
      user_id: user1ID.id,
      bird_id: snogooID
    });

    const savedBirdsUser2 = birdsData.map(bird => ({
      speciesCode: bird.speciesCode,
      user_id: user2ID.id,
      bird_id: bird.id
    }));

    await knex('saved_birds').insert(savedBirdsUser2);
  } catch (error) {
    console.log(`Error seeding data: ${error}`)
  }
};
