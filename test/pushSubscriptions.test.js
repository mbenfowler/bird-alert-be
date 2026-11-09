const { test } = require('node:test')
const assert = require('node:assert/strict')
const { familyOf, traceDeviceOf, appendTrace, TRACE_PER_DEVICE } = require('../lib/pushSubscriptions')

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

test('browser families tell an iPhone from each Mac browser', () => {
  assert.equal(familyOf(IPHONE), 'ios')
  assert.equal(familyOf(MAC_CHROME), 'desktop-chrome')
  assert.equal(familyOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15'), 'desktop-safari')
  assert.equal(familyOf(''), null)
})

test('a busy laptop cannot push a phone out of the notification trace', () => {
  let events = []
  const phone = traceDeviceOf({ device: 'phone-device-id-1' }, IPHONE)
  const laptop = traceDeviceOf({ ua: MAC_CHROME }, MAC_CHROME)
  assert.notEqual(phone, laptop)
  events = appendTrace(events, { event: 'push', dev: phone })
  for (let i = 0; i < 100; i += 1) events = appendTrace(events, { event: 'push', n: i, dev: laptop })
  assert.equal(events.filter((e) => e.dev === phone).length, 1, 'the phone keeps its event')
  assert.equal(events.filter((e) => e.dev === laptop).length, TRACE_PER_DEVICE)
  assert.equal(events.at(-1).n, 99, 'newest last')
  // Old traces without a device label still count as one device.
  assert.equal(appendTrace([{ event: 'old' }], { event: 'new', dev: phone }).length, 2)
})
