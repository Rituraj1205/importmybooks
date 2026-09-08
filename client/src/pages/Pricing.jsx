import { useState } from "react";
import {
  ArrowLeft, Check, Zap, Building2, TrendingUp, Users,
  Shield, Globe, Clock, Loader2, ChevronDown, FlaskConical,
} from "lucide-react";

const CONTACT_EMAIL = "support@importmybooks.com";

const CURRENCIES = [
  { code: "INR", symbol: "₹",  flag: "🇮🇳", label: "India (INR)" },
  { code: "GBP", symbol: "£",  flag: "🇬🇧", label: "UK (GBP)" },
  { code: "USD", symbol: "$",  flag: "🇺🇸", label: "US (USD)" },
  { code: "AUD", symbol: "A$", flag: "🇦🇺", label: "Australia (AUD)" },
  { code: "EUR", symbol: "€",  flag: "🇮🇪", label: "Europe (EUR)" },
  { code: "ZAR", symbol: "R",  flag: "🇿🇦", label: "South Africa (ZAR)" },
];

const PRICES = {
  INR: { starter: { mo: "3,299",  yr: "32,990"   }, pro: { mo: "8,499",  yr: "84,990"   }, growth: { mo: "14,999", yr: "1,49,990" } },
  GBP: { starter: { mo: "32",    yr: "320"    }, pro: { mo: "84",    yr: "840"    }, growth: { mo: "149",   yr: "1,490"  } },
  USD: { starter: { mo: "39",    yr: "390"    }, pro: { mo: "99",    yr: "990"    }, growth: { mo: "179",   yr: "1,790"  } },
  AUD: { starter: { mo: "59",    yr: "590"    }, pro: { mo: "149",   yr: "1,490"  }, growth: { mo: "249",   yr: "2,490"  } },
  EUR: { starter: { mo: "36",    yr: "360"    }, pro: { mo: "92",    yr: "920"    }, growth: { mo: "169",   yr: "1,690"  } },
  ZAR: { starter: { mo: "699",   yr: "6,990"  }, pro: { mo: "1,799", yr: "17,990" }, growth: { mo: "2,999", yr: "29,990" } },
};

// Only show what makes each plan UNIQUE — common features listed below the cards
const PLANS = [
  {
    id: "starter",
    name: "Starter",
    tagline: "One client, full power",
    icon: Zap,
    accent: "#fbbf24",
    accentDim: "rgba(251,191,36,0.07)",
    accentBorder: "rgba(251,191,36,0.22)",
    orgs: "1 Xero org",
    highlights: [
      "All 17+ import types — no type restrictions",
      "1,000 API calls/day · auto-resets at midnight UTC",
      "Smart Import Guide for every import type",
      "Import History (3 months)",
      "Email support (48h)",
    ],
  },
  {
    id: "pro",
    name: "Professional",
    tagline: "Full control across your practice",
    icon: Building2,
    accent: "#818cf8",
    accentDim: "rgba(129,140,248,0.1)",
    accentBorder: "rgba(129,140,248,0.35)",
    orgs: "Up to 5 Xero orgs",
    popular: true,
    highlights: [
      "Everything in Starter",
      "Auto Allocation — Credit Notes ↔ Invoices & Overpayments in bulk",
      "Delete Centre — bulk void/delete across 9 record types",
      "Update Centre — status, exchange rates, update existing records",
      "Xero Pre-Validation — catch errors before they hit Xero",
      "Import History (12 months) · Priority 24h support",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    tagline: "Scale with your whole team",
    icon: TrendingUp,
    accent: "#2dd4bf",
    accentDim: "rgba(45,212,191,0.07)",
    accentBorder: "rgba(45,212,191,0.22)",
    orgs: "Up to 15 Xero orgs",
    highlights: [
      "Everything in Professional",
      "Multi-user access with RBAC — 4 roles per team member",
      "Partial import + Resume — skip errors & continue, never lose progress",
      "Auto-Fix — one-click correction of common import errors",
      "Admin dashboard with team import analytics",
      "Priority 12h support",
    ],
  },
];

// Listed ONCE here, not repeated on every plan card
const ALL_PLANS_INCLUDE = [
  { icon: "📥", label: "All 17+ import types" },
  { icon: "⚡", label: "1,000 API calls/day per org" },
  { icon: "∞",  label: "No row limit per import" },
  { icon: "📋", label: "Smart Import Guide" },
  { icon: "📄", label: "Error CSV download" },
  { icon: "🔗", label: "Xero Demo Company safe" },
];

const COMPARE = [
  { label: "Xero organisations",        values: ["1",        "Up to 5",    "Up to 15"] },
  { label: "Auto Allocation engine",    values: [false,      true,         true] },
  { label: "Delete + Update Centre",    values: [false,      true,         true] },
  { label: "Xero Pre-Validation",       values: [false,      true,         true] },
  { label: "Multi-user RBAC",           values: [false,      false,        true] },
  { label: "Partial import & Resume",   values: [false,      false,        true] },
  { label: "Import History",            values: ["3 months", "12 months",  "Unlimited"] },
  { label: "Support response",          values: ["48h email","24h priority","12h priority"] },
];

const FAQ = [
  {
    q: "How much data can I import per day? What is the API limit?",
    a: "Xero allows 1,000 API calls per day per organisation. ImportMyBooks batches multiple records into each call — so the real daily capacity is much higher: ~40,000 invoices or bills (50 per call), or ~80,000 contacts and items (100 per call). The quota resets at midnight UTC automatically. Professional (5 orgs) and Growth (15 orgs) plans multiply this across all your connected orgs.",
  },
  {
    q: "Which import types are included? Same on all plans?",
    a: "Yes — all 17+ import types are available on every paid plan. Types include: Invoices, Bills, Credit Notes, Debit Notes, Invoice & Bill Payments, Manual Journals, Bank Transfers, Purchase Orders, Quotes, Spend Money, Receive Money, Overpayments, Prepayments, Contacts, Items, and Chart of Accounts. What differs between plans is how many orgs you can connect and which power tools (Auto Allocation, Delete Centre, teams) you get.",
  },
  {
    q: "What is the free Testing plan?",
    a: "The Testing plan is completely free — import up to 100 rows into a Xero Demo Company, no credit card required. Sign up, then request Testing access from your dashboard. Admin approval is usually within 24 hours.",
  },
  {
    q: "Can I upgrade or switch plans anytime?",
    a: "Yes. Upgrades take effect immediately. All your import history and connected organisations are preserved across plan changes. Downgrades apply at the next billing cycle.",
  },
  {
    q: "Is my Xero data stored on your servers?",
    a: "No. Your financial data passes directly to the Xero API in transit and is never stored on ImportMyBooks servers. Xero OAuth tokens are encrypted at rest and never exposed to the browser.",
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "18px 0",
        cursor: "pointer",
      }}
      onClick={() => setOpen(v => !v)}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", lineHeight: 1.5 }}>{q}</div>
        <ChevronDown
          size={15}
          style={{
            flexShrink: 0, marginTop: 2, color: "var(--muted)",
            transition: "transform 0.2s",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </div>
      {open && (
        <div style={{ fontSize: 13.5, color: "var(--muted)", lineHeight: 1.72, marginTop: 10 }}>
          {a}
        </div>
      )}
    </div>
  );
}

export default function Pricing({ onBack, userToken }) {
  const [currency, setCurrency] = useState("INR");
  const [billing, setBilling] = useState("mo");
  const [loadingPlan, setLoadingPlan] = useState(null);
  const [showCompare, setShowCompare] = useState(false);

  const curr = CURRENCIES.find(c => c.code === currency);
  const sym = curr.symbol;

  const getPrice = (planId) => `${sym}${PRICES[currency][planId][billing]}`;
  const getAnnualSaving = (planId) => {
    if (billing === "yr") return `${sym}${PRICES[currency][planId].mo}/mo billed monthly`;
    return `Save 17% — ${sym}${PRICES[currency][planId].yr}/yr`;
  };

  function loadRazorpayScript() {
    return new Promise((resolve, reject) => {
      if (window.Razorpay) { resolve(); return; }
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load payment gateway. Check your internet connection."));
      document.body.appendChild(s);
    });
  }

  const handleCheckout = async (plan) => {
    if (plan.id === "enterprise") {
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=ImportMyBooks Enterprise Plan Enquiry`;
      return;
    }
    if (!userToken) {
      window.location.href = `/signup?plan=${plan.id}&billing=${billing}&currency=${currency}`;
      return;
    }
    const paymentCurrency = currency === "ZAR" ? "USD" : currency;
    setLoadingPlan(plan.id);
    try {
      await loadRazorpayScript();
      const res = await fetch("/api/razorpay/create-order", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken },
        body: JSON.stringify({ planId: plan.id, billing, currency: paymentCurrency }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create order");
      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: "ImportMyBooks",
        description: data.label,
        order_id: data.orderId,
        prefill: { email: data.userEmail, name: data.userName },
        theme: { color: plan.accent },
        handler: async (response) => {
          const verRes = await fetch("/api/razorpay/verify-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-user-token": userToken },
            body: JSON.stringify({
              orderId: response.razorpay_order_id,
              paymentId: response.razorpay_payment_id,
              signature: response.razorpay_signature,
              planId: plan.id,
              billing,
              currency: data.currency,
            }),
          });
          const verData = await verRes.json();
          if (verData.success) {
            window.location.href = "/pricing/success";
          } else {
            alert("Payment received but verification failed. Contact " + CONTACT_EMAIL + " with your payment ID: " + response.razorpay_payment_id);
          }
        },
        modal: { ondismiss: () => setLoadingPlan(null) },
      });
      rzp.open();
    } catch (err) {
      alert(err.message || "Something went wrong. Please try again.");
      setLoadingPlan(null);
    }
  };

  return (
    <div className="pricing-page">

      {/* ─── Back ─── */}
      <div style={{ maxWidth: 1080, margin: "0 auto 0", paddingBottom: 8 }}>
        <button className="legal-back-btn" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Back
        </button>
      </div>

      {/* ─── Hero ─── */}
      <div style={{ maxWidth: 680, margin: "0 auto 48px", textAlign: "center", padding: "0 20px" }}>
        <p className="pricing-eyebrow">Simple, honest pricing</p>
        <h1 style={{ fontSize: 34, fontWeight: 800, color: "var(--text)", lineHeight: 1.2, marginBottom: 14, letterSpacing: "-0.02em" }}>
          Import any Xero data.<br />No surprises.
        </h1>
        <p style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.65, marginBottom: 28 }}>
          All 17+ import types included on <strong style={{ color: "var(--text)" }}>every</strong> plan.
          Plans differ by how many Xero orgs you manage
          and which power tools you need.
        </p>

        {/* Trust badges */}
        <div style={{ display: "flex", gap: 20, justifyContent: "center", flexWrap: "wrap", marginBottom: 32 }}>
          {[
            { Icon: Shield, text: "Data never stored" },
            { Icon: Globe,  text: "All Xero regions" },
            { Icon: Clock,  text: "Setup in minutes" },
          ].map(({ Icon, text }) => (
            <div key={text} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)" }}>
              <Icon size={13} style={{ color: "var(--accent)" }} />
              {text}
            </div>
          ))}
        </div>

        {/* Controls row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          {/* Currency dropdown */}
          <div style={{ position: "relative" }}>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value)}
              style={{
                appearance: "none",
                background: "var(--panel)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                fontSize: 13,
                fontWeight: 600,
                padding: "7px 32px 7px 12px",
                borderRadius: 8,
                cursor: "pointer",
                outline: "none",
              }}
            >
              {CURRENCIES.map(c => (
                <option key={c.code} value={c.code}>{c.flag} {c.label}</option>
              ))}
            </select>
            <ChevronDown size={13} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} />
          </div>

          {/* Billing toggle */}
          <div className="pricing-billing-toggle">
            <button type="button"
              className={`pricing-billing-btn ${billing === "mo" ? "pricing-billing-btn--active" : ""}`}
              onClick={() => setBilling("mo")}>Monthly</button>
            <button type="button"
              className={`pricing-billing-btn ${billing === "yr" ? "pricing-billing-btn--active" : ""}`}
              onClick={() => setBilling("yr")}>
              Annual <span className="pricing-save-badge">Save 17%</span>
            </button>
          </div>
        </div>

        {currency === "ZAR" && (
          <p style={{ fontSize: 12, color: "#d97706", marginTop: 10, opacity: 0.85 }}>
            ⚠️ ZAR prices shown for reference — payments processed in USD
          </p>
        )}
      </div>

      {/* ─── 3 Plan cards ─── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: 20,
        maxWidth: 1040,
        margin: "0 auto 16px",
        padding: "0 20px",
        alignItems: "stretch",
      }}
        className="pricing-cards-grid"
      >
        {PLANS.map((plan) => {
          const Icon = plan.icon;
          const isLoading = loadingPlan === plan.id;
          return (
            <div
              key={plan.id}
              style={{
                background: plan.popular ? plan.accentDim : "var(--panel)",
                border: `1px solid ${plan.popular ? plan.accentBorder : "var(--border)"}`,
                borderRadius: 16,
                padding: "28px 26px",
                display: "flex",
                flexDirection: "column",
                position: "relative",
                boxShadow: plan.popular ? `0 0 0 1px ${plan.accentBorder}, 0 8px 32px rgba(0,0,0,0.18)` : "none",
                transition: "transform 0.15s, box-shadow 0.15s",
              }}
            >
              {/* Popular badge */}
              {plan.popular && (
                <div style={{
                  position: "absolute",
                  top: -12,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: plan.accent,
                  color: "#fff",
                  fontSize: 10.5,
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  textTransform: "uppercase",
                  padding: "4px 14px",
                  borderRadius: 20,
                  whiteSpace: "nowrap",
                }}>
                  Most Popular
                </div>
              )}

              {/* Header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 9,
                  background: plan.accentDim,
                  border: `1px solid ${plan.accentBorder}`,
                  display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <Icon size={16} style={{ color: plan.accent }} />
                </div>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{plan.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--muted)" }}>{plan.tagline}</div>
                </div>
              </div>

              {/* Org chip */}
              <div style={{
                display: "inline-flex", alignItems: "center",
                gap: 5, fontSize: 11.5, fontWeight: 700,
                color: plan.accent,
                background: plan.accentDim,
                border: `1px solid ${plan.accentBorder}`,
                borderRadius: 6,
                padding: "3px 9px",
                marginBottom: 18,
                alignSelf: "flex-start",
              }}>
                {plan.orgs}
              </div>

              {/* Price */}
              <div style={{ marginBottom: 4 }}>
                <span style={{ fontSize: 36, fontWeight: 800, color: plan.popular ? plan.accent : "var(--text)", letterSpacing: "-0.03em", lineHeight: 1 }}>
                  {getPrice(plan.id)}
                </span>
                <span style={{ fontSize: 14, color: "var(--muted)", marginLeft: 4 }}>
                  /{billing === "mo" ? "mo" : "yr"}
                </span>
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 22 }}>
                {getAnnualSaving(plan.id)}
              </div>

              {/* CTA */}
              <button
                type="button"
                disabled={isLoading}
                onClick={() => handleCheckout(plan)}
                style={{
                  width: "100%",
                  padding: "11px 0",
                  borderRadius: 9,
                  border: "none",
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  marginBottom: 24,
                  transition: "opacity 0.15s",
                  background: plan.popular ? plan.accent : "transparent",
                  color: plan.popular ? "#fff" : plan.accent,
                  outline: plan.popular ? "none" : `2px solid ${plan.accentBorder}`,
                  outlineOffset: -2,
                  opacity: isLoading ? 0.7 : 1,
                }}
              >
                {isLoading && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                Get Started →
              </button>

              {/* Divider */}
              <div style={{ height: 1, background: "var(--border)", marginBottom: 20 }} />

              {/* Highlights */}
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
                {plan.highlights.map(h => (
                  <li key={h} style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13, color: "var(--text)", lineHeight: 1.5 }}>
                    <Check size={13} style={{ color: plan.accent, flexShrink: 0, marginTop: 2 }} />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* ─── All plans include ─── */}
      <div style={{ maxWidth: 1040, margin: "0 auto 48px", padding: "0 20px" }}>
        <div style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: "22px 28px",
        }}>
          <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "1.5px", textTransform: "uppercase", color: "var(--muted)", marginBottom: 14 }}>
            Included in every paid plan
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {ALL_PLANS_INCLUDE.map(({ icon, label }) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: 7,
                fontSize: 12.5, fontWeight: 500, color: "var(--text)",
                background: "rgba(45,212,191,0.06)",
                border: "1px solid rgba(45,212,191,0.15)",
                borderRadius: 7, padding: "6px 12px",
              }}>
                <span style={{ fontSize: 14 }}>{icon}</span>
                {label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Enterprise banner ─── */}
      <div style={{ maxWidth: 1040, margin: "0 auto 52px", padding: "0 20px" }}>
        <div style={{
          background: "rgba(167,139,250,0.06)",
          border: "1px solid rgba(167,139,250,0.2)",
          borderRadius: 14,
          padding: "22px 32px",
          display: "flex",
          alignItems: "center",
          gap: 24,
          flexWrap: "wrap",
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: "rgba(167,139,250,0.12)",
            border: "1px solid rgba(167,139,250,0.25)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Users size={18} style={{ color: "#a78bfa" }} />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 3 }}>Enterprise</div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              Unlimited orgs · Dedicated account manager · SLA-backed support (4h) · Custom onboarding & integrations · Volume discounts
            </div>
          </div>
          <a
            href={`mailto:${CONTACT_EMAIL}?subject=ImportMyBooks Enterprise Plan Enquiry`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6,
              padding: "10px 22px", borderRadius: 9, flexShrink: 0,
              border: "1px solid rgba(167,139,250,0.35)",
              color: "#a78bfa", fontWeight: 700, fontSize: 13,
              textDecoration: "none", transition: "opacity 0.15s",
            }}
          >
            Contact Sales →
          </a>
        </div>
      </div>

      {/* ─── Free testing plan ─── */}
      <div style={{ maxWidth: 1040, margin: "0 auto 52px", padding: "0 20px" }}>
        <div className="pricing-testing-inner">
          <div style={{
            width: 52, height: 52, borderRadius: 13, flexShrink: 0,
            background: "rgba(52,211,153,0.1)", border: "1px solid rgba(52,211,153,0.28)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <FlaskConical size={22} style={{ color: "#34d399" }} />
          </div>
          <div className="pricing-testing-info">
            <div className="pricing-testing-name">
              Testing Plan
              <span className="pricing-testing-tag">FREE</span>
            </div>
            <div className="pricing-testing-desc">
              Try on a Xero Demo Company — no credit card required. Import up to 100 rows total. One-time admin approval (within 24h).
            </div>
            <div className="pricing-testing-pills">
              {["1 Xero org", "100 rows total", "Core import types", "No delete/export", "Admin approval"].map(f => (
                <span key={f} className="pricing-testing-pill">
                  <Check size={11} style={{ color: "#34d399" }} /> {f}
                </span>
              ))}
            </div>
          </div>
          <div className="pricing-testing-cta-col">
            <div className="pricing-testing-price">Free</div>
            <div className="pricing-testing-pricesub">No credit card</div>
            <button type="button" className="pricing-testing-btn"
              onClick={() => { window.location.href = "/signup"; }}>
              Create Account →
            </button>
          </div>
        </div>
      </div>

      {/* ─── Plan comparison (collapsible) ─── */}
      <div style={{ maxWidth: 1040, margin: "0 auto 52px", padding: "0 20px" }}>
        <button
          type="button"
          onClick={() => setShowCompare(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--muted)", fontSize: 13, fontWeight: 600, padding: 0, marginBottom: 16,
          }}
        >
          <ChevronDown size={14} style={{ transition: "transform 0.2s", transform: showCompare ? "rotate(180deg)" : "rotate(0deg)" }} />
          {showCompare ? "Hide" : "Show"} plan comparison
        </button>

        {showCompare && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ width: "34%", textAlign: "left", padding: "10px 14px", color: "var(--muted)", fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", borderBottom: "1px solid var(--border)" }}>Feature</th>
                  {PLANS.map(p => (
                    <th key={p.id} style={{ padding: "10px 14px", textAlign: "center", fontSize: 13, fontWeight: 700, color: p.popular ? p.accent : "var(--text)", borderBottom: "1px solid var(--border)" }}>
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE.map((row, ri) => (
                  <tr key={row.label} style={{ background: ri % 2 === 0 ? "transparent" : "rgba(255,255,255,0.012)" }}>
                    <td style={{ padding: "10px 14px", fontSize: 12.5, color: "var(--muted)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      {row.label}
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} style={{ padding: "10px 14px", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        {typeof v === "boolean"
                          ? (v
                              ? <Check size={14} style={{ color: PLANS[i].accent, margin: "0 auto", display: "block" }} />
                              : <span style={{ display: "block", width: 14, height: 2, background: "rgba(100,116,139,0.3)", borderRadius: 2, margin: "0 auto" }} />
                            )
                          : <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>{v}</span>
                        }
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Competitor note ─── */}
      <div className="pricing-compare-note">
        <p>
          <strong>Why ImportMyBooks?</strong> Most Xero import tools restrict which import types you get by plan.
          ImportMyBooks gives you <strong>all 17+ types on every plan</strong> — no upsell surprises.
          We're also the only tool with an <strong>Auto Allocation engine</strong>, a full <strong>Delete Centre</strong> (9 record types),
          and <strong>Update Centre</strong> with exchange rate correction.
        </p>
      </div>

      {/* ─── FAQ ─── */}
      <div style={{ maxWidth: 680, margin: "0 auto 64px", padding: "0 20px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", marginBottom: 4, textAlign: "center" }}>
          Common questions
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--muted)", textAlign: "center", marginBottom: 32 }}>
          Anything else? Email us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>
        </p>
        <div>
          {FAQ.map(item => <FaqItem key={item.q} q={item.q} a={item.a} />)}
        </div>
      </div>

      {/* ─── Final CTA ─── */}
      <div style={{
        maxWidth: 560, margin: "0 auto", padding: "0 20px",
        textAlign: "center",
      }}>
        <div style={{
          background: "var(--panel)", border: "1px solid var(--border)",
          borderRadius: 18, padding: "36px 32px",
        }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", marginBottom: 8, letterSpacing: "-0.01em" }}>
            Ready to import smarter?
          </div>
          <p style={{ fontSize: 13.5, color: "var(--muted)", marginBottom: 24, lineHeight: 1.6 }}>
            Start with the free Testing plan — no credit card, no commitment.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <button type="button" className="btn primary"
              onClick={() => { window.location.href = "/signup"; }}
              style={{ padding: "11px 28px", fontWeight: 700 }}>
              Start Free →
            </button>
            <a href={`mailto:${CONTACT_EMAIL}`}
              style={{
                display: "inline-flex", alignItems: "center",
                padding: "11px 20px", borderRadius: 8,
                border: "1px solid var(--border)", color: "var(--muted)",
                fontSize: 14, fontWeight: 600, textDecoration: "none",
              }}>
              Ask a question
            </a>
          </div>
        </div>
      </div>

    </div>
  );
}
