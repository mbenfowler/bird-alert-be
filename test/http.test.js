const { test } = require('node:test')
const assert = require('node:assert/strict')
const { route, HttpError, body } = require('../lib/http')
const { fakeReq, fakeRes } = require('./helpers')

test('route rejects methods that are not allowed', async () => {
  const res = fakeRes()
  await route(['POST'], async () => {})(fakeReq({ method: 'GET' }), res)
  assert.equal(res.statusCode, 405)
  assert.equal(res.headers.allow, 'POST')
})

test('route turns an HttpError into its status and message', async () => {
  const res = fakeRes()
  await route(['GET'], async () => { throw new HttpError(418, 'teapot') })(fakeReq(), res)
  assert.equal(res.statusCode, 418)
  assert.deepEqual(res.body, { error: 'teapot' })
})

test('route hides unexpected errors behind a 500', async () => {
  const res = fakeRes()
  const quiet = console.error
  console.error = () => {}
  try {
    await route(['GET'], async () => { throw new Error('db exploded with secrets') })(fakeReq(), res)
  } finally { console.error = quiet }
  assert.equal(res.statusCode, 500)
  assert.deepEqual(res.body, { error: 'Internal server error' })
})

test('body returns an object for missing or non-object bodies', () => {
  assert.deepEqual(body(fakeReq()), {})
  assert.deepEqual(body(fakeReq({ body: 'text' })), {})
  assert.deepEqual(body(fakeReq({ body: { a: 1 } })), { a: 1 })
})
