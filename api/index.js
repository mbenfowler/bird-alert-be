const express = require('express')
const cors = require('cors')
const app = express()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

app.set('port', process.env.PORT || 3001)
app.locals.title = 'Bird Alert'

app.use(cors({ origin: 'http://localhost:3000' , credentials :  true}))

app.use(express.json())

app.get('/', (req, res) => {
    res.send(`Welcome to ${app.locals.title} API!`)
})

app.get('/api/v1/user/:id', async (req, res) => {
  const userId = req.params.id;
  await db('users').where({id: userId}).first()
    .then(user => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})

app.patch('/api/v1/user', async (req, res) => {
  const user = req.body
  await db('users').where('id', 1).update({
    username: user.name,
    password: user.password,
    location: user.location,
    email: user.email,
    phone: user.phone,
    state: user.state,
    updated_at: new Date()
  })
    .then(() => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})

app.get('/api/v1/saved', async (req, res) => {
  await db('saved_birds').where('user_id', 1).select('bird_id')
    .then(birdIds => {
      const birdPromises = birdIds.map(birdId => {
        return db('birds').where('id', birdId.bird_id).first()
      })
      Promise.all(birdPromises)
        .then(birds => res.status(200).json(birds))
        .catch(error => res.status(500).json({ error }))
    })
    .catch(error => res.status(500).json({ error }))
})

app.post('/api/v1/saved', async (req, res) => {
  const birdData = req.body

  try {
    await db.transaction(async (trx) => {
      const existingBird = await trx('birds')
        .where('speciesCode', birdData.speciesCode)
        .first()

      if (existingBird) {
        await trx('saved_birds').insert({
          user_id: 1,
          bird_id: existingBird.id,
          speciesCode: existingBird.speciesCode
        });
        return existingBird
      } else {
        const newBirdId = await insertBird(birdData, trx)
        await trx('saved_birds').insert({
          user_id: 1,
          bird_id: newBirdId,
          speciesCode: birdData.speciesCode
        });
        return birdData;
      }
    })
    .catch(trx.rollback)

    res.status(201).json(birdData)
  } catch (error) {
    console.error("An error occurred:", error);
    res.status(500).json({ error: 'An error occurred' });
  }
});

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

app.delete('/api/v1/saved', (req, res) => {
  const bird = req.body
  db('birds').where('speciesCode', bird.speciesCode).first()
    .then(bird => {
      db('saved_birds').where('bird_id', bird.id).del()
        .then(() => res.status(200).json(bird))
        .catch(error => res.status(500).json({ error }))
    })
    .catch(error => res.status(500).json({ error }))
})

app.get('/api/v1/saved/:speciesCode', async (req, res) => {
  const speciesCode = req.params.speciesCode;
  const bird = await db('saved_birds')
    .where('speciesCode', speciesCode)
    .where('user_id', 1)
    .first()
  res.json(!!bird);
})

app.listen(app.get('port'), () => {
    console.log(`${app.locals.title} is running on http://localhost:${app.get('port')}.`)
})
