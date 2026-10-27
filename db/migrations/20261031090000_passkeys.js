/** Passkeys: Face ID, Touch ID, Windows Hello or a phone, in place of typing a password. */
exports.up = async function (knex) {
  await knex.schema.createTable('passkeys', (table) => {
    table.string('id', 512).primary() // the credential id, base64url
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE').index()
    table.text('public_key').notNullable() // base64url
    table.bigInteger('counter').notNullable().defaultTo(0)
    table.jsonb('transports')
    table.string('rp_id', 255).notNullable()
    table.string('name', 80)
    table.boolean('backed_up').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('last_used_at', { useTz: true })
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('passkeys')
}
