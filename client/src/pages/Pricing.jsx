import { useState } from "react";
import {
  ArrowLeft, Check, X, Zap, Building2, Users, Shield, Clock,
  Globe, Loader2, TrendingUp, FlaskConical, ChevronDown,
} from "lucide-react";

const CONTACT_EMAIL = "support@importmybooks.com";

const CURRENCIES = [
  { code: "INR", symbol: "₹",  flag: "🇮🇳", label: "India" },
  { code: "GBP", symbol: "£",  flag: "🇬🇧", label: "UK" },
  { code: "USD", symbol: "$",  flag: "🇺🇸", label: "US" },
  { code: "AUD", symbol: "A$", flag: "🇦🇺", label: "Australia" },
  { code: "EUR", symbol: "€",  flag: "🇮🇪", label: "EU" },
  { code: "ZAR", symbol: "R",  flag: "🇿🇦", label: "South Africa" },
];

const PRICES = {
  INR: {
    starter: { mo: "3,299",  yr: "32,990"   },
    pro:     { mo: "8,499",  yr: "84,990"   },
    growth:  { mo: "14,999", yr: "1,49,990" },
  },
  GBP: {
    starter: { mo: "32",    yr: "320"    },
    pro:     { mo: "84",    yr: "840"    },
    growth:  { mo: "149",   yr: "1,490"  },
  },
  USD: {
    starter: { mo: "39",    yr: "390"    },
    pro:     { mo: "99",    yr: "990"    },
    growth:  { mo: "179",   yr: "1,790"  },
  },
  AUD: {
    starter: { mo: "59",    yr: "590"    },
    pro:     { mo: "149",   yr: "1,490"  },
    growth:  { mo: "249",   yr: "2,490"  },
  },
  EUR: {
    starter: { mo: "36",    yr: "360"    },
    pro:     { mo: "92",    yr: "920"    },
    growth:  { mo: "169",   yr: "1,690"  },
  },
  ZAR: {
    starter: { mo: "699",   yr: "6,990"  },
    pro:     { mo: "1,799", yr: "17,990" },
    growth:  { mo: "2,999", yr: "29,990" },
  },
};

const PAID_PLANS = [
  {
    id: "starter",
    name: "Starter",
    icon: Zap,
    accent: "#fbbf24",
    accentDim: "rgba(251,191,36,0.1)",
    accentBorder: "rgba(251,191,36,0.28)",
    tagline: "Solo accountants & small practices",
    badge: null,
    highlight: false,
    cta: "Get Started",
    features: [
      "1 Xero organisation",
      "Up to 500 records per import",
      "Invoices, Bills & Credit Notes (AR + AP)",
      "Quotes & Purchase Orders",
      "Invoice & Bill Payments",
      "Spend & Receive Money (Bank Transactions)",
      "Contacts (Customers & Vendors)",
      "Items / Products & Chart of Accounts",
      "Smart Import Guide + Template downloads",
      "Error CSV download after each import",
      "Import History (3 months)",
      "Email support (48h response)",
    ],
    notIncluded: [
      "Auto Allocation engine",
      "Delete Centre (9 delete types)",
      "Update Centre (bulk status, exchange rate)",
      "Manual Journals & Bank Transfers import",
      "Multi-user team access",
    ],
  },
  {
    id: "pro",
    name: "Professional",
    icon: Building2,
    accent: "#818cf8",
    accentDim: "rgba(129,140,248,0.1)",
    accentBorder: "rgba(129,140,248,0.38)",
    tagline: "CA firms managing multiple clients",
    badge: "Most Popular",
    badgeClass: "pricing-badge--pro",
    highlight: true,
    cardClass: "pricing-card--pro",
    cta: "Get Started",
    features: [
      "Up to 5 Xero organisations",
      "Unlimited records per import",
      "All 17+ import types (incl. Manual Journals, Bank Transfers, Overpayments)",
      "Auto Allocation — Credit Notes → Invoices, Debit Notes → Bills, Overpayments",
      "Delete Centre — 9 types: Invoice/Bill Void, Payment Delete, Quote Delete, PO Delete, Spend/Receive Delete, Bank Transfer Delete, Contact Archive",
      "Update Centre — Bulk Status Update, Exchange Rate Update, Update existing records",
      "Overpayment Duplicate Finder & Void",
      "Xero Pre-Validation (catch errors before import)",
      "Smart Import Guide with per-type rules & tips",
      "Import History (12 months)",
      "Priority support (24h response)",
    ],
    notIncluded: [
      "Multi-user team access & RBAC",
      "Partial import & resume support",
      "Admin dashboard & team analytics",
    ],
  },
  {
    id: "growth",
    name: "Growth",
    icon: TrendingUp,
    accent: "#2dd4bf",
    accentDim: "rgba(45,212,191,0.1)",
    accentBorder: "rgba(45,212,191,0.28)",
    tagline: "Scaling firms with growing teams",
    badge: "NEW",
    badgeClass: "pricing-badge--new",
    highlight: false,
    cta: "Get Started",
    features: [
      "Up to 15 Xero organisations",
      "Unlimited records per import",
      "Everything in Professional",
      "Multi-user access with RBAC (4 permission levels: import / export / delete / allocation)",
      "Partial import — skip errors, continue rest automatically",
      "Import Resume — continue interrupted jobs from where they stopped",
      "Auto-Fix — one-click correction of common import errors",
      "Import Notes & full audit trail per import",
      "Browser notifications (get alerted when large imports finish)",
      "Advanced admin dashboard with team analytics",
      "Priority support (12h response)",
    ],
    notIncluded: [
      "Dedicated account manager",
      "Custom SLA & onboarding",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    icon: Users,
    accent: "#a78bfa",
    accentDim: "rgba(167,139,250,0.1)",
    accentBorder: "rgba(167,139,250,0.28)",
    tagline: "Large firms & enterprise teams",
    badge: null,
    highlight: false,
    cta: "Contact Sales",
    features: [
      "Unlimited Xero organisations",
      "Unlimited records per import",
      "Everything in Growth",
      "Dedicated account manager",
      "Custom onboarding & team training session",
      "SLA-backed support (4h response guarantee)",
      "Custom API integrations on request",
      "Volume pricing & annual discounts",
    ],
    notIncluded: [],
  },
];

const COMPARE_ROWS = [
  { label: "Xero organisations",          values: ["1",    "5",        "15",       "Unlimited"] },
  { label: "Records per import",          values: ["500",  "Unlimited","Unlimited","Unlimited"] },
  { label: "Import types",                values: ["12",   "All 17+",  "All 17+",  "All 17+"]  },
  { label: "Auto Allocation engine",      values: [false,  true,       true,       true]        },
  { label: "Delete Centre (9 types)",     values: [false,  true,       true,       true]        },
  { label: "Update Centre",              values: [false,  true,       true,       true]        },
  { label: "Xero Pre-Validation",        values: [false,  true,       true,       true]        },
  { label: "Multi-user RBAC",            values: [false,  false,      true,       true]        },
  { label: "Partial import & resume",    values: [false,  false,      true,       true]        },
  { label: "Auto-Fix + Import Notes",    values: [false,  false,      true,       true]        },
  { label: "Admin dashboard",            values: [false,  false,      true,       true]        },
  { label: "Dedicated manager",          values: [false,  false,      false,      true]        },
];

const FAQ = [
  {
    q: "What is the Testing plan and how do I get it?",
    a: "The Testing plan is completely free and lets you import up to 100 rows total across all imports. Create an account, then request the Testing plan from within the app. An admin reviews and approves your request — you'll receive a notification in your dashboard once approved.",
  },
  {
    q: "Is there a free trial for paid plans?",
    a: "We don't offer a time-limited trial. The free Testing plan is the best way to evaluate ImportMyBooks — connect a Xero Demo Company and run real imports on practice data before committing to a paid plan.",
  },
  {
    q: "What is the Delete Centre and what can it delete?",
    a: "The Delete Centre lets you bulk-delete or void Xero records via CSV upload — no manual clicking. It supports 9 delete types: Invoice Void, Bill Void, Invoice Payment Delete, Bill Payment Delete, Manual Journal Void, Quote Delete, Purchase Order Delete, Spend/Receive Money Delete, Bank Transfer Delete, and Contact Archive. Each type gives real-time progress and a downloadable Results CSV.",
  },
  {
    q: "What does the Update Centre do?",
    a: "The Update Centre lets you update existing Xero records in bulk without deleting and re-importing. It includes: Bulk Status Update (change DRAFT → AUTHORISED, AUTHORISED → VOIDED, etc. for invoices, bills, quotes, POs), Exchange Rate Update (fix wrong currency rates on existing documents), and full record updates for invoices, bills, credit notes, quotes, purchase orders, contacts, and items.",
  },
  {
    q: "What is Auto Allocation?",
    a: "Auto Allocation automatically matches and applies Credit Notes to outstanding Invoices, Debit Notes to Bills, and Overpayments / Prepayments to invoices — all in bulk. It uses smart matching by contact name, amount, and date. This saves hours of manual allocation in Xero's UI, especially after large imports.",
  },
  {
    q: "Can I switch or upgrade plans anytime?",
    a: "Yes. Upgrades take effect immediately; downgrades apply at the next billing cycle. All your import history, connected organisations, and job data are preserved across plan changes.",
  },
  {
    q: "Is my Xero data safe?",
    a: "Your financial data is never stored on our servers — it passes directly to the Xero API in transit. Xero OAuth tokens are encrypted at rest and never exposed to the browser.",
  },
  {
    q: "What import types are included in 'All 17+'?",
    a: "Bills, Invoices, Credit Notes (AR & AP), Debit Notes, Invoice Payments, Bill Payments, Manual Journals, Bank Transfers, Purchase Orders, Quotes, Spend Money, Receive Money, Overpayments, Prepayments, Contacts (Customers & Vendors), Items / Products, and Chart of Accounts.",
  },
  {
    q: "What is Xero Pre-Validation?",
    a: "Pre-Validation runs a check against your live Xero data before submitting an import — it flags contacts that don't exist, duplicate invoice numbers, invalid account codes, and mismatched currencies. This prevents failed imports and partial data entry in Xero.",
  },
  {
    q: "What does Partial Import & Resume mean?",
    a: "Partial Import means if some rows fail (e.g. a wrong contact name on row 15), ImportMyBooks skips those rows and successfully imports the rest — instead of stopping everything. Import Resume means if your session disconnects mid-import (power cut, browser close), you can resume the job from where it stopped without re-importing already-completed rows.",
  },
  {
    q: "Do you support all Xero regions?",
    a: "Yes — ImportMyBooks works with any Xero organisation globally: India, UK, US, Australia, Ireland, South Africa, New Zealand, and more.",
  },
  {
    q: "What payment methods do you accept?",
    a: "Credit/debit cards (Visa, Mastercard, Amex) via Razorpay for monthly and annual plans. Bank transfer invoicing is available for Enterprise customers.",
  },
  {
    q: "What's the difference between Growth and Enterprise?",
    a: "Growth supports up to 15 Xero organisations with full RBAC, audit trails, partial imports, and Import Resume. Enterprise adds unlimited organisations, a dedicated account manager, custom onboarding, SLA-backed support (4h response), and bespoke integration work.",
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pricing-faq__item" style={{ cursor: "pointer" }} onClick={() => setOpen(v => !v)}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div className="pricing-faq__q" style={{ marginBottom: 0 }}>{q}</div>
        <ChevronDown
          size={14}
          style={{
            flexShrink: 0,
            marginTop: 1,
            color: "var(--muted)",
            transition: "transform 0.2s",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
          }}
        />
      </div>
      {open && <div className="pricing-faq__a" style={{ marginTop: 10 }}>{a}</div>}
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

  const getPrice = (planId) => {
    if (planId === "enterprise") return "Custom";
    return `${sym}${PRICES[currency][planId][billing]}`;
  };

  const getNote = (planId) => {
    if (planId === "enterprise") return "Annual billing · Volume discounts";
    if (billing === "mo") return `Save 17% — ${sym}${PRICES[currency][planId].yr}/yr`;
    return `${sym}${PRICES[currency][planId].mo}/mo billed monthly`;
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
    if (plan.id === "testing") { window.location.href = "/signup"; return; }
    if (plan.id === "enterprise") {
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=ImportMyBooks Enterprise Plan Enquiry`;
      return;
    }
    if (!userToken) {
      window.location.href = `/signup?plan=${plan.id}&billing=${billing}&currency=${currency}`;
      return;
    }

    // ZAR not supported by Razorpay International — process in USD
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

      {/* ─── Header ─── */}
      <div className="pricing-page__header">
        <button className="legal-back-btn" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="pricing-hero">
          <p className="pricing-eyebrow">Transparent Pricing · No Surprises</p>
          <h1>The most complete Xero import tool<br />on the market.</h1>
          <p className="pricing-sub">
            15+ import types · Auto Allocation · Bulk Delete · Multi-tenant command centre.
            Start free, scale as you grow.
          </p>

          {/* Trust badges */}
          <div className="pricing-trust-row">
            {[
              { Icon: Shield, label: "SOC 2 aligned",     sub: "Data never stored" },
              { Icon: Globe,  label: "Xero Certified",    sub: "Official API partner" },
              { Icon: Clock,  label: "Demo Company safe", sub: "Test on practice data" },
            ].map(({ Icon, label, sub }) => (
              <div key={label} className="pricing-trust-badge">
                <Icon size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
                <div>
                  <div className="pricing-trust-label">{label}</div>
                  <div className="pricing-trust-sub">{sub}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Controls */}
          <div className="pricing-controls">
            <div className="pricing-currency-selector">
              {CURRENCIES.map(c => (
                <button key={c.code} type="button"
                  className={`pricing-currency-btn ${currency === c.code ? "pricing-currency-btn--active" : ""}`}
                  onClick={() => setCurrency(c.code)} title={c.label}>
                  {c.flag} {c.code}
                </button>
              ))}
            </div>
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
        </div>
      </div>

      {/* ─── Testing plan banner ─── */}
      <p className="pricing-section-label">Free plan</p>
      <div className="pricing-testing-banner">
        <div className="pricing-testing-inner">
          {/* Icon */}
          <div style={{
            width: 52, height: 52, borderRadius: 13, flexShrink: 0,
            background: "rgba(52,211,153,0.1)",
            border: "1px solid rgba(52,211,153,0.28)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <FlaskConical size={22} style={{ color: "#34d399" }} />
          </div>

          {/* Info */}
          <div className="pricing-testing-info">
            <div className="pricing-testing-name">
              Testing Plan
              <span className="pricing-testing-tag">FREE</span>
            </div>
            <div className="pricing-testing-desc">
              Try ImportMyBooks with real Xero data — no credit card required. Import up to 100 rows total. Requires one-time admin approval.
            </div>
            <div className="pricing-testing-pills">
              {[
                "1 Xero organisation",
                "100 rows total",
                "Core import types",
                "No export / delete access",
                "Admin approval required",
              ].map(f => (
                <span key={f} className="pricing-testing-pill">
                  <Check size={11} style={{ color: "#34d399" }} /> {f}
                </span>
              ))}
            </div>
          </div>

          {/* CTA */}
          <div className="pricing-testing-cta-col">
            <div className="pricing-testing-price">Free</div>
            <div className="pricing-testing-pricesub">No credit card needed</div>
            <button type="button" className="pricing-testing-btn"
              onClick={() => { window.location.href = "/signup"; }}>
              Create Free Account →
            </button>
          </div>
        </div>
      </div>

      {/* ─── Paid plans grid ─── */}
      <p className="pricing-section-label">Paid plans</p>
      <div className="pricing-plans-grid">
        {PAID_PLANS.map((plan) => {
          const Icon = plan.icon;
          const price = getPrice(plan.id);
          const isEnterprise = plan.id === "enterprise";
          const isLoading = loadingPlan === plan.id;

          return (
            <div key={plan.id}
              className={`pricing-card ${plan.cardClass || ""}`}
              style={!plan.cardClass ? {
                borderColor: "var(--border)",
              } : undefined}
            >
              {/* Badge */}
              {plan.badge && (
                <div className={`pricing-badge ${plan.badgeClass || ""}`}>
                  {plan.badge}
                </div>
              )}

              {/* Plan header */}
              <div className="pricing-card__top">
                <div className="pricing-card__icon"
                  style={{ background: plan.accentDim, border: `1px solid ${plan.accentBorder}` }}>
                  <Icon size={17} style={{ color: plan.accent }} />
                </div>
                <div>
                  <div className="pricing-card__name">{plan.name}</div>
                  <div className="pricing-card__tagline">{plan.tagline}</div>
                </div>
              </div>

              {/* Price */}
              <div className="pricing-card__price">
                <span className="pricing-card__amount"
                  style={{ color: plan.highlight ? plan.accent : "var(--text)" }}>
                  {price}
                </span>
                {!isEnterprise && (
                  <span className="pricing-card__period">
                    /{billing === "mo" ? "mo" : "yr"}
                  </span>
                )}
              </div>
              <div className="pricing-card__annual">{getNote(plan.id)}</div>

              {/* CTA */}
              <button
                type="button"
                disabled={isLoading}
                onClick={() => handleCheckout(plan)}
                className={`btn pricing-card__cta ${plan.highlight ? "primary" : "ghost"}`}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  ...(plan.highlight ? {} : {
                    borderColor: plan.accentBorder,
                    color: plan.accent,
                  }),
                }}
              >
                {isLoading && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                {plan.cta}
              </button>

              <div className="pricing-card__divider" />

              {/* Features */}
              <ul className="pricing-feature-list">
                {plan.features.map(f => (
                  <li key={f} className="pricing-feature-item pricing-feature-item--yes">
                    <Check size={12} style={{ color: plan.accent, flexShrink: 0, marginTop: 1 }} />
                    {f}
                  </li>
                ))}
                {plan.notIncluded.map(f => (
                  <li key={f} className="pricing-feature-item pricing-feature-item--no">
                    <X size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      {/* ─── Feature comparison ─── */}
      <div className="pricing-compare">
        <button type="button"
          onClick={() => setShowCompare(v => !v)}
          style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--muted)", fontSize: 13, fontWeight: 600,
            padding: 0, marginBottom: 16,
          }}>
          <ChevronDown size={14} style={{
            transition: "transform 0.2s",
            transform: showCompare ? "rotate(180deg)" : "rotate(0deg)",
          }} />
          {showCompare ? "Hide" : "Show"} full feature comparison
        </button>

        {showCompare && (
          <div style={{ overflowX: "auto" }}>
            <table className="pricing-compare" style={{ maxWidth: "100%", margin: 0 }}>
              <thead>
                <tr>
                  <th style={{ width: "28%", textAlign: "left", padding: "10px 14px", color: "var(--muted)", fontSize: 12, fontWeight: 600, borderBottom: "1px solid var(--border)" }}>Feature</th>
                  {PAID_PLANS.map(p => (
                    <th key={p.id} style={{
                      padding: "10px 14px", textAlign: "center", fontSize: 12, fontWeight: 700,
                      color: p.highlight ? p.accent : "var(--muted)",
                      borderBottom: "1px solid var(--border)",
                    }}>
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map(row => (
                  <tr key={row.label}>
                    <td style={{ padding: "9px 14px", fontSize: 12, color: "var(--muted)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      {row.label}
                    </td>
                    {row.values.map((v, i) => (
                      <td key={i} style={{ padding: "9px 14px", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        {typeof v === "boolean"
                          ? (v
                            ? <Check size={13} style={{ color: PAID_PLANS[i].accent, margin: "0 auto", display: "block" }} />
                            : <X size={12} style={{ color: "rgba(100,116,139,0.35)", margin: "0 auto", display: "block" }} />)
                          : <span style={{ fontSize: 12, color: "var(--text)" }}>{v}</span>
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

      {/* ─── Competitive note ─── */}
      <div className="pricing-compare-note">
        <p>
          <strong>How ImportMyBooks compares:</strong> Most Xero import tools (SaaSant, DataDear, Simple Importer)
          cover 5–8 import types with basic delete. ImportMyBooks supports <strong>17+ import types</strong>,{" "}
          <strong>9 delete types</strong> (Quotes, POs, Spend/Receive Money, Bank Transfers, Contact Archive — none of which SaaSant supports),{" "}
          a full <strong>Update Centre</strong> with Exchange Rate correction, and the only{" "}
          <strong>Auto Allocation engine</strong> on the market — the complete AP/AR workflow in one tool.
        </p>
      </div>

      {/* ─── FAQ ─── */}
      <div className="pricing-faq">
        <h2 className="pricing-faq__title">Frequently Asked Questions</h2>
        <div className="pricing-faq__grid">
          {FAQ.map(item => <FaqItem key={item.q} q={item.q} a={item.a} />)}
        </div>
      </div>

      {/* ─── Contact CTA ─── */}
      <div className="pricing-contact-cta">
        <p>Questions before you sign up? We reply within a few hours.</p>
        <a href={`mailto:${CONTACT_EMAIL}`} className="btn primary" style={{ display: "inline-flex", gap: 8 }}>
          Email us → {CONTACT_EMAIL}
        </a>
      </div>

    </div>
  );
}
