/**
 * push_log rows that stand for something sent. A rare sighting held back for someone who chose
 * strict alerts sits there as review_state 'held' until it has proof; it was never sent, so every
 * "already sent" check leaves it out (a knex where-callback).
 */
const notHeld = (q) => q.whereNull('review_state').orWhereNot('review_state', 'held')

module.exports = { notHeld }
