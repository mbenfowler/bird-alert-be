const db = require('./db')

/** Remembers when a background job last ran and what it did. */
const recordRun = (kind, detail) =>
  db('job_runs').insert({ kind, ran_at: db.fn.now(), detail }).onConflict('kind').merge({ ran_at: db.fn.now(), detail })

const lastRun = (kind) => db('job_runs').where({ kind }).first()

module.exports = { recordRun, lastRun }
