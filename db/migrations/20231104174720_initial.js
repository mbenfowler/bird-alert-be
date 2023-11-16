/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema
    .createTable('users', (table) => {
      table.increments('id').primary();
      table.string('username');
      table.string('password');
      table.string('email').unique();
      table.string('phone');
      table.string('location');
      table.string('state');
      table.timestamps(true, true);
    })
    .createTable('birds', (table) => {
      table.increments('id').primary();
      table.string('comName');
      table.string('sciName');
      table.string('speciesCode').unique();
      table.string('category');
      table.string('order');
      table.string('familyCode');
      table.string('familyComName');
      table.string('familySciName');
      table.string('birdImg');
      table.string('wikiURL');
      table.integer('taxonOrder');
      table.timestamps(true, true);
    })
    .createTable('saved_birds', (table) => {
      table.increments('id').primary();
      table.string('speciesCode').unsigned();
      table.integer('user_id').unsigned();
      table.integer('bird_id').unsigned();
      table.foreign('speciesCode').references('birds.speciesCode');
      table.foreign('user_id').references('users.id');
      table.foreign('bird_id').references('birds.id');
      table.unique(['user_id', 'bird_id']);
      table.timestamps(true, true);
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema
    .dropTable('saved_birds')
    .dropTable('birds')
    .dropTable('users')
};
