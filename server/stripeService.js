import Stripe from "stripe";

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-04-10" })
  : null;

export function isConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
}

// Map planId_billing → env var holding the Stripe Price ID
const PRICE_KEY_MAP = {
  starter_mo: "STRIPE_PRICE_STARTER_MO",
  starter_yr: "STRIPE_PRICE_STARTER_YR",
  pro_mo:     "STRIPE_PRICE_PRO_MO",
  pro_yr:     "STRIPE_PRICE_PRO_YR",
};

function getPriceId(planId, billing) {
  const envKey = PRICE_KEY_MAP[`${planId}_${billing}`];
  if (!envKey) return null;
  return process.env[envKey] || null;
}

export async function createCheckoutSession({ userEmail, planId, billing, successUrl, cancelUrl }) {
  if (!stripe) throw new Error("Stripe not configured");
  const priceId = getPriceId(planId, billing);
  if (!priceId) throw new Error(`No Stripe price ID configured for plan=${planId} billing=${billing}. Set ${PRICE_KEY_MAP[`${planId}_${billing}`]} in .env`);

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer_email: userEmail,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    subscription_data: {
      metadata: { planId, billing, userEmail },
    },
    metadata: { planId, billing, userEmail },
    allow_promotion_codes: true,
  });

  return session;
}

export async function createPortalSession(customerId, returnUrl) {
  if (!stripe) throw new Error("Stripe not configured");
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return session;
}

export function constructWebhookEvent(rawBody, signature) {
  if (!stripe) throw new Error("Stripe not configured");
  return stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

// Map Stripe Price ID back to planId for webhook processing
export function planIdFromPriceId(priceId) {
  for (const [key, envKey] of Object.entries(PRICE_KEY_MAP)) {
    if (process.env[envKey] === priceId) {
      return key.split("_")[0]; // "starter" or "pro"
    }
  }
  return null;
}
