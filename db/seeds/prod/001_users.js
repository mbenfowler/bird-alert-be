/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function(knex) {
  try {
    await knex('users').insert({
      username: '',
      password: '1234',
      email: 'robinware456@gmail.com',
      phone: '555-555-5555',
      location: '',
      state: ''
    }, 'id')
    await knex('users').insert({
      username: '',
      password: '1234',
      email: 'mbfowler@gmail.com',
      phone: '555-555-5556',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
    await knex('users').insert({
      username: '',
      password: '1234',
      email: 'joyce.fowler@bellsouth.net',
      phone: '',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
  } catch (error) {
    console.log(`Error seeding user data: ${error}`)
  }
};
