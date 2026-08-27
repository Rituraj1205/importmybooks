import Razorpay from "razorpay";
import crypto from "crypto";

let _rzp = null;
function getRzp() {
  if (!_rzp && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    _rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  }
  return _rzp;
}

// Amounts in smallest unit of each currency (paise for INR, cents for others)
// Razorpay International supports: INR, USD, GBP, EUR, AUD, SGD, AED, HKD, CAD, MYR
// ZAR is NOT supported — falls back to USD
const CURRENCY_AMOUNTS = {
  INR: {
    starter_mo:      329900,   // ₹3,299
    starter_yr:      3299000,  // ₹32,990
    professional_mo: 849900,   // ₹8,499
    professional_yr: 8499000,  // ₹84,990
    growth_mo:       1499900,  // ₹14,999
    growth_yr:       14999000, // ₹1,49,990
  },
  USD: {
    starter_mo:      3900,     // $39
    starter_yr:      39000,    // $390
    professional_mo: 9900,     // $99
    professional_yr: 99000,    // $990
    growth_mo:       17900,    // $179
    growth_yr:       179000,   // $1,790
  },
  GBP: {
    starter_mo:      3200,     // £32
    starter_yr:      32000,    // £320
    professional_mo: 8400,     // £84
    professional_yr: 84000,    // £840
    growth_mo:       14900,    // £149
    growth_yr:       149000,   // £1,490
  },
  EUR: {
    starter_mo:      3600,     // €36
    starter_yr:      36000,    // €360
    professional_mo: 9200,     // €92
    professional_yr: 92000,    // €920
    growth_mo:       16900,    // €169
    growth_yr:       169000,   // €1,690
  },
  AUD: {
    starter_mo:      5900,     // A$59
    starter_yr:      59000,    // A$590
    professional_mo: 14900,    // A$149
    professional_yr: 149000,   // A$1,490
    growth_mo:       24900,    // A$249
    growth_yr:       249000,   // A$2,490
  },
};

// ZAR not supported by Razorpay International — map to USD
const CURRENCY_FALLBACK = { ZAR: "USD" };

// Currencies where Razorpay charges in smallest unit ÷ 100 display (standard)
// All above are standard (100 smallest units = 1 major unit)

const PLAN_LABELS = {
  starter:      "PRISM Starter",
  professional: "PRISM Professional",
  pro:          "PRISM Professional",
  growth:       "PRISM Growth",
};

const DAYS = {
  mo: 31,
  yr: 366,
};

// Normalize "pro" → "professional"
export function normalizePlanId(planId) {
  return planId === "pro" ? "professional" : planId;
}

// Which currencies we accept via Razorpay
export const SUPPORTED_CURRENCIES = Object.keys(CURRENCY_AMOUNTS);

export function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export function getKeyId() {
  return process.env.RAZORPAY_KEY_ID || "";
}

export async function createOrder(planId, billing, currency = "INR") {
  const rzp = getRzp();
  if (!rzp) throw new Error("Razorpay not configured — add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to .env");

  const normalizedPlan = normalizePlanId(planId);
  const effectiveCurrency = CURRENCY_FALLBACK[currency] || currency;
  const currencyTable = CURRENCY_AMOUNTS[effectiveCurrency] || CURRENCY_AMOUNTS.INR;

  const key = `${normalizedPlan}_${billing}`;
  const amount = currencyTable[key];
  if (!amount) throw new Error(`Unknown plan/billing combination: ${normalizedPlan}/${billing}`);

  const planLabel = PLAN_LABELS[normalizedPlan] || normalizedPlan;
  const billingLabel = billing === "yr" ? "Annual" : "Monthly";
  const label = `${planLabel} — ${billingLabel}`;

  const order = await rzp.orders.create({
    amount,
    currency: effectiveCurrency,
    receipt: `prism_${normalizedPlan}_${billing}_${Date.now()}`,
    notes: { planId: normalizedPlan, billing, currency: effectiveCurrency },
  });

  return {
    orderId: order.id,
    amount,
    currency: effectiveCurrency,
    label,
    days: DAYS[billing] || 31,
    planId: normalizedPlan,
  };
}

// Verify Razorpay payment signature (HMAC SHA256)
export function verifyPayment(orderId, paymentId, signature) {
  const body = `${orderId}|${paymentId}`;
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest("hex");
  return expected === signature;
}

export function getPlanDays(planId, billing) {
  return DAYS[billing] || 31;
}
