const { Readable } = require('node:stream')

/** Minimal stand-ins for Vercel's req/res objects. */
const fakeReq = ({ method = 'GET', url = '/', headers = {}, query = {}, body } = {}) =>
  Object.assign(new Readable({ read() {} }), { method, url, headers, query, body })

const fakeRes = () => {
  const res = { statusCode: 200, headers: {}, body: undefined }
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (data) => { res.body = data; return res }
  res.send = (data) => { res.body = data; return res }
  res.end = () => res
  return res
}

/** Replaces global fetch for the duration of `fn`; `handler(url, init)` returns a Response. */
const withFetch = async (handler, fn) => {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => handler(String(url), init)
  try { return await fn() } finally { globalThis.fetch = original }
}

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

module.exports = { fakeReq, fakeRes, withFetch, jsonResponse }
