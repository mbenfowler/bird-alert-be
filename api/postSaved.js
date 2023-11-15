const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  try {
    const birdData = req.query
    const userEmail = req.query.email

    await db.transaction(async (trx) => {
      const existingBird = await trx('birds')
        .where('speciesCode', birdData.speciesCode)
        .first();

      const user = await trx('users')
        .where('email', userEmail)
        .first();

      if (existingBird) {
        await trx('saved_birds').insert({
          user_id: user.id,
          bird_id: existingBird.id,
          speciesCode: existingBird.speciesCode,
        });
        return existingBird;
      } else {
        const newBirdId = await insertBird(birdData, trx);
        await trx('saved_birds').insert({
          user_id,
          bird_id: newBirdId,
          speciesCode: birdData.speciesCode,
        });
        return birdData;
      }
    });

    res.status(201).json(birdData);
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ error: 'An error occurred' });
  }
};

const insertBird = async (birdData, trx) => {
  try {
    const [newBirdId] = await trx('birds')
      .insert({
        comName: birdData.comName,
        sciName: birdData.sciName,
        speciesCode: birdData.speciesCode,
        category: birdData.category,
        order: birdData.order,
        familyCode: birdData.familyCode,
        familyComName: birdData.familyComName,
        familySciName: birdData.familySciName,
        wikiURL: birdData.wikiURL,
        taxonOrder: birdData.taxonOrder
      }, 'id');
    return newBirdId.id;
  } catch (error) {
    console.error("Error inserting bird:", error);
    throw error;
  }
}
