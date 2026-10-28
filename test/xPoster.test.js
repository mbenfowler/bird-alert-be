const { test } = require('node:test')
const assert = require('node:assert/strict')
const { oauthHeader } = require('../lib/xPoster')

// X's own worked example of a signed request (developer docs, "Creating a signature").
test('OAuth 1.0a signatures match X’s published example', () => {
  const header = oauthHeader({
    method: 'POST',
    url: 'https://api.twitter.com/1.1/statuses/update.json',
    params: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
    consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
    tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    timestamp: 1318622958
  })
  assert.match(header, /oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"/)
  assert.match(header, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", /)
})

test('pasted keys lose stray spaces and quotes, and their shapes help spot a swap without showing them', () => {
  const { keys, keyShapes } = require('../lib/xPoster')
  process.env.X_API_KEY = '  abcdefghijklmnopqrstuvwxy \n'
  process.env.X_API_SECRET = '"' + 'S'.repeat(50) + '"'
  process.env.X_ACCESS_TOKEN = 'T'.repeat(50)
  process.env.X_ACCESS_SECRET = 'A'.repeat(45)
  try {
    assert.equal(keys().consumerKey, 'abcdefghijklmnopqrstuvwxy')
    assert.equal(keys().consumerSecret, 'S'.repeat(50))
    const shapes = keyShapes()
    assert.deepEqual([shapes.apiKey, shapes.apiSecret, shapes.accessToken, shapes.accessSecret], [25, 50, 50, 45])
    assert.deepEqual(shapes.padded, ['X_API_KEY', 'X_API_SECRET'])
    assert.equal(shapes.tokenLooksRight, false)
    process.env.X_ACCESS_TOKEN = '1850000000000000000-' + 'a'.repeat(30)
    assert.equal(keyShapes().tokenLooksRight, true)
  } finally { for (const k of ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET']) delete process.env[k] }
})
