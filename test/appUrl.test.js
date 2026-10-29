const { test } = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')

// The base is read once at load, so each case loads the module fresh in its own process.
const linkWith = (value) => execFileSync(process.execPath, ['-e', "process.stdout.write(require('./lib/appUrl').appUrl('/reset/x'))"], { env: { ...process.env, APP_BASE_URL: value } }).toString()

test('email links fall back to the app when the configured address is a placeholder', () => {
  assert.equal(linkWith('[SENSITIVE]'), 'https://bird-alert.vercel.app/reset/x', 'Vercel hands this out for protected values')
  assert.equal(linkWith(''), 'https://bird-alert.vercel.app/reset/x')
  assert.equal(linkWith('http://localhost:3000/'), 'http://localhost:3000/reset/x')
})
