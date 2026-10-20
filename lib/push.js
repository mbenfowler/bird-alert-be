const webpush = require('web-push')
const db = require('./db')

const configured = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
if (configured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:birdalert.info@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  )
}

const publicKey = () => process.env.VAPID_PUBLIC_KEY || null

/**
 * Sends one notification to one subscription. Returns 'sent', or 'gone' when the browser has
 * dropped the subscription (404/410), in which case the row is deleted.
 */
const sendToSubscription = async (subscription, payload) => {
  try {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 }
    )
    return 'sent'
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 410) {
      await db('push_subscriptions').where({ endpoint: subscription.endpoint }).del()
      return 'gone'
    }
    throw error
  }
}

/** Sends a payload to every subscription of a user; returns { sent, gone }. */
const sendToUser = async (userId, payload) => {
  const subscriptions = await db('push_subscriptions').where({ user_id: userId })
  const result = { sent: 0, gone: 0 }
  for (const subscription of subscriptions) {
    try {
      result[await sendToSubscription(subscription, payload)] += 1
    } catch (error) {
      console.error(`Push to subscription ${subscription.id} failed:`, error.message)
    }
  }
  return result
}

module.exports = { configured, publicKey, sendToUser }
