import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const LP_CURRENCIES = [
  { code: "INR", sym: "₹",  flag: "🇮🇳", label: "INR" },
  { code: "GBP", sym: "£",  flag: "🇬🇧", label: "GBP" },
  { code: "USD", sym: "$",  flag: "🇺🇸", label: "USD" },
  { code: "AUD", sym: "A$", flag: "🇦🇺", label: "AUD" },
  { code: "EUR", sym: "€",  flag: "🇮🇪", label: "EUR" },
  { code: "ZAR", sym: "R",  flag: "🇿🇦", label: "ZAR" },
];

const LP_PRICES = {
  INR: { starter: { mo: "3,299",  yr: "32,990"   }, pro: { mo: "8,499",  yr: "84,990"   }, growth: { mo: "14,999", yr: "1,49,990" } },
  GBP: { starter: { mo: "32",    yr: "320"    },    pro: { mo: "84",    yr: "840"    },    growth: { mo: "149",   yr: "1,490"  } },
  USD: { starter: { mo: "39",    yr: "390"    },    pro: { mo: "99",    yr: "990"    },    growth: { mo: "179",   yr: "1,790"  } },
  AUD: { starter: { mo: "59",    yr: "590"    },    pro: { mo: "149",   yr: "1,490"  },    growth: { mo: "249",   yr: "2,490"  } },
  EUR: { starter: { mo: "36",    yr: "360"    },    pro: { mo: "92",    yr: "920"    },    growth: { mo: "169",   yr: "1,690"  } },
  ZAR: { starter: { mo: "699",   yr: "6,990"  },    pro: { mo: "1,799", yr: "17,990" },    growth: { mo: "2,999", yr: "29,990" } },
};

function detectLPCurrency() {
  try {
    const lang = (navigator.language || "").toLowerCase();
    const tz   = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
    if (lang.startsWith("en-gb") || tz === "europe/london")      return "GBP";
    if (lang.startsWith("en-au") || tz.startsWith("australia/")) return "AUD";
    if (lang.startsWith("en-nz") || tz === "pacific/auckland")   return "AUD";
    if (lang.startsWith("en-za") || tz === "africa/johannesburg") return "ZAR";
    if (lang.startsWith("en-in") || tz === "asia/kolkata")       return "INR";
    if (lang.startsWith("en-ie") || tz === "europe/dublin")      return "EUR";
    if (tz.startsWith("europe/") || /^(fr|de|es|it|nl|pt|pl|cs|sk|ro|hu)/.test(lang)) return "EUR";
    return "USD";
  } catch { return "INR"; }
}

const LP_FAQS = [
  { q: "What file formats does ImportMyBooks support for importing?", a: "ImportMyBooks accepts CSV files for importing. Open the CSV template in Excel or Google Sheets to fill your data, then save as CSV before uploading. Our parser handles multi-line records (e.g. bills with multiple line items) using a row-per-line format." },
  { q: "Is there a free trial? Can I test before buying?", a: "Yes — the Testing plan is completely free. It gives you 100 rows of imports across core types, so you can connect a Xero Demo Company and try a real import before committing to any paid plan. No credit card required." },
  { q: "How does duplicate detection work?", a: "Before importing, ImportMyBooks fetches your existing records from Xero and builds a set of unique identifiers (invoice numbers, reference fields, contact names, etc.). Each row in your CSV is checked against this set — if a match is found, that row is skipped and flagged in the error report." },
  { q: "Can I use ImportMyBooks with multiple Xero organisations?", a: "Yes. Starter supports 1 org, Professional supports 5 orgs, Growth supports 15 orgs, and Enterprise is unlimited. You can connect multiple organisations and switch between them from the org selector — no separate logins needed." },
  { q: "Is my Xero data secure? Does ImportMyBooks store my data?", a: "ImportMyBooks connects to Xero using official OAuth 2.0 — your Xero credentials are never shared with us. The data in your CSV is sent directly to Xero's API and is not permanently stored on our servers. Import history metadata (counts, types, timestamps) is stored to power your audit log." },
  { q: "What happens if an import fails halfway through?", a: "Partial import means failed rows are skipped and successful rows are created in Xero. Each failed row is collected into a downloadable error CSV with the reason for each failure. On Professional+ plans, Import Resume lets you continue an interrupted import from exactly where it stopped." },
  { q: "What is Auto Allocation and when would I use it?", a: "Auto Allocation is our smart matching engine that automatically applies credit notes, overpayments, and prepayments against outstanding invoices in Xero. It groups credits and invoices by contact and currency, then allocates oldest invoice first. Available on Professional and above plans." },
  { q: "Can I cancel my plan anytime?", a: "Yes — monthly plans can be cancelled at any time and you retain access until the end of the billing period. Annual plans are non-refundable but can be cancelled to prevent renewal. There are no cancellation fees." },
];

const LP_IMPORT_TYPES = [
  { icon: "📄", name: "Invoices", desc: "Sales invoices, DRAFT or AUTHORISED", plan: "starter" },
  { icon: "📋", name: "Bills", desc: "Purchase bills with line items", plan: "starter" },
  { icon: "💰", name: "Spend Money", desc: "Bank spend transactions", plan: "starter" },
  { icon: "💵", name: "Receive Money", desc: "Bank receive transactions", plan: "starter" },
  { icon: "🤝", name: "Contacts", desc: "Customers & suppliers in bulk", plan: "starter" },
  { icon: "🔄", name: "Tracking Categories", desc: "Xero tracking options & groups", plan: "starter" },
  { icon: "📝", name: "Credit Notes", desc: "Sales and purchase credit notes", plan: "pro" },
  { icon: "📦", name: "Items", desc: "Inventory & non-inventory items", plan: "pro" },
  { icon: "📑", name: "Quotes", desc: "Xero quotes and estimates", plan: "pro" },
  { icon: "🛒", name: "Purchase Orders", desc: "Approved purchase orders", plan: "pro" },
  { icon: "📓", name: "Manual Journals", desc: "Debit/credit journal entries", plan: "pro" },
  { icon: "💳", name: "Bill Payments", desc: "Link payments to existing bills", plan: "pro" },
  { icon: "🧾", name: "Invoice Payments", desc: "Link payments to invoices", plan: "pro" },
  { icon: "↩️", name: "Credit Refunds", desc: "Refund credit notes to contacts", plan: "pro" },
  { icon: "🏦", name: "Bank Transfers", desc: "Inter-account bank transfers", plan: "pro" },
  { icon: "💸", name: "Overpayments", desc: "Customer & supplier overpayments", plan: "growth" },
];

const CSS = `
.lp-root{font-family:'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;background:#fff;color:#0C1E35;line-height:1.6;-webkit-font-smoothing:antialiased;min-height:100vh}
.lp-root *,.lp-root *::before,.lp-root *::after{box-sizing:border-box}
.lp-root a{text-decoration:none;color:inherit}
.lp-root button{font-family:inherit;cursor:pointer}

/* NAV */
.lp-nav{position:fixed;top:0;left:0;right:0;z-index:200;background:rgba(12,32,64,0.97);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid rgba(45,212,191,0.1);padding:0 6vw;display:flex;align-items:center;justify-content:space-between;height:66px}
.lp-nav-logo{font-size:19px;font-weight:900;letter-spacing:-.6px;color:#fff;flex-shrink:0}
.lp-nav-logo .lp-t{color:#2DD4BF}
.lp-nav-links{display:flex;gap:28px;list-style:none;margin:0;padding:0}
.lp-nav-links a{font-size:13.5px;font-weight:500;color:rgba(255,255,255,0.58);transition:color .2s;cursor:pointer}
.lp-nav-links a:hover{color:#2DD4BF}
.lp-nav-right{display:flex;align-items:center;gap:10px}
.lp-btn-login{font-size:13.5px;font-weight:600;color:rgba(255,255,255,0.5);background:none;border:none;cursor:pointer;transition:color .2s;padding:8px 12px}
.lp-btn-login:hover{color:#fff}
.lp-btn-p{display:inline-flex;align-items:center;gap:5px;padding:9px 20px;background:#2DD4BF;color:#071929;font-size:13.5px;font-weight:700;border-radius:8px;border:none;cursor:pointer;transition:all .2s;white-space:nowrap}
.lp-btn-p:hover{background:#24bfac;transform:translateY(-1px);box-shadow:0 4px 16px rgba(45,212,191,0.4)}
.lp-btn-g{display:inline-flex;align-items:center;gap:5px;padding:9px 20px;background:transparent;color:rgba(255,255,255,0.72);font-size:13.5px;font-weight:600;border-radius:8px;border:1.5px solid rgba(255,255,255,0.18);cursor:pointer;transition:all .2s;white-space:nowrap}
.lp-btn-g:hover{border-color:rgba(45,212,191,0.5);color:#2DD4BF}
.lp-ham{display:none;flex-direction:column;gap:5px;cursor:pointer;padding:8px;background:none;border:none}
.lp-ham span{width:22px;height:2px;background:rgba(255,255,255,0.7);border-radius:2px;display:block}

/* MOBILE MENU */
.lp-mob-menu{position:fixed;top:66px;left:0;right:0;background:rgba(7,17,31,0.98);padding:20px 6vw 28px;z-index:199;border-bottom:1px solid rgba(45,212,191,0.12);display:flex;flex-direction:column;gap:4px}
.lp-mob-menu a{display:block;padding:12px 0;font-size:15px;font-weight:600;color:rgba(255,255,255,0.65);border-bottom:1px solid rgba(255,255,255,0.06);transition:color .2s;cursor:pointer}
.lp-mob-menu a:hover{color:#2DD4BF}
.lp-mob-btns{display:flex;gap:10px;margin-top:12px}

/* HERO */
.lp-hero{min-height:100vh;background:#0C2040;display:flex;align-items:center;position:relative;overflow:hidden;padding:120px 6vw 80px}
.lp-hero::before{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent,transparent 59px,rgba(45,212,191,0.04) 60px),repeating-linear-gradient(90deg,transparent,transparent 59px,rgba(45,212,191,0.04) 60px);z-index:0}
.lp-hero::after{content:"";position:absolute;top:-60px;right:-80px;width:700px;height:700px;border-radius:50%;background:radial-gradient(circle,rgba(45,212,191,0.14) 0%,rgba(13,148,136,0.04) 40%,transparent 70%);z-index:0}
.lp-hero-inner{position:relative;z-index:1;max-width:1200px;margin:0 auto;width:100%;display:grid;grid-template-columns:1.1fr 0.9fr;gap:60px;align-items:center}
.lp-kicker{display:inline-flex;align-items:center;gap:8px;padding:5px 16px;background:rgba(45,212,191,0.1);border:1px solid rgba(45,212,191,0.25);border-radius:100px;font-size:11.5px;font-weight:700;color:#2DD4BF;letter-spacing:.07em;text-transform:uppercase;margin-bottom:22px}
.lp-hero h1{font-size:clamp(38px,5.2vw,68px);font-weight:900;color:#fff;line-height:1.04;letter-spacing:-2.5px;margin-bottom:20px;text-wrap:balance}
.lp-hero h1 .lp-acc{color:#2DD4BF}
.lp-hero-sub{font-size:17px;color:rgba(255,255,255,0.48);line-height:1.78;max-width:460px;margin-bottom:34px}
.lp-hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:30px}
.lp-hero-chips{display:flex;flex-wrap:wrap;gap:9px}
.lp-hchip{font-size:12.5px;font-weight:600;color:rgba(255,255,255,0.48);display:flex;align-items:center;gap:5px}
.lp-hchip::before{content:"✓";color:#2DD4BF;font-weight:900}
.lp-hero-cards{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.lp-hc{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);border-radius:14px;padding:22px 18px;transition:border-color .3s;animation:lpFloat 7s ease-in-out infinite}
.lp-hc:nth-child(2){animation-delay:1.75s}.lp-hc:nth-child(3){animation-delay:3.5s}.lp-hc:nth-child(4){animation-delay:5.25s}
.lp-hc:hover{border-color:rgba(45,212,191,0.3)}.lp-hc--f{border-color:rgba(45,212,191,0.25)!important;background:rgba(45,212,191,0.07)!important}
@keyframes lpFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.lp-hc-num{font-size:32px;font-weight:900;color:#2DD4BF;letter-spacing:-1.5px;line-height:1;margin-bottom:6px}
.lp-hc-title{font-size:14px;font-weight:700;color:#fff;margin-bottom:4px}
.lp-hc-desc{font-size:11.5px;color:rgba(255,255,255,0.3);line-height:1.5}

/* STATS BAR */
.lp-stats-bar{background:#142D52;border-top:1px solid rgba(45,212,191,0.08);border-bottom:1px solid rgba(45,212,191,0.08);padding:0 6vw;display:flex;justify-content:center;overflow-x:auto}
.lp-si{flex:1;min-width:140px;text-align:center;padding:22px 24px;border-right:1px solid rgba(255,255,255,0.07)}
.lp-si:last-child{border-right:none}
.lp-si-val{font-size:28px;font-weight:900;color:#2DD4BF;letter-spacing:-1px;line-height:1;margin-bottom:5px}
.lp-si-label{font-size:11.5px;font-weight:500;color:rgba(255,255,255,0.38);letter-spacing:.02em}

/* TRUST STRIP */
.lp-trust{background:#fff;border-bottom:1px solid rgba(0,0,0,0.08);padding:18px 6vw;display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:24px 40px}
.lp-trust p{font-size:13px;font-weight:600;color:#527090}
.lp-xbadge{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:800;color:#13b5ea}
.lp-xd{width:30px;height:30px;border-radius:50%;background:#13b5ea;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;font-weight:900}
.lp-sep{width:1px;height:24px;background:rgba(0,0,0,0.08)}

/* SECTIONS */
.lp-sec{padding:96px 6vw}
.lp-sh{text-align:center;max-width:660px;margin:0 auto 60px}
.lp-sh-k{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#0D9488;margin-bottom:12px}
.lp-sh h2{font-size:clamp(28px,3.8vw,44px);font-weight:800;color:#0C1E35;letter-spacing:-1px;line-height:1.1;margin-bottom:14px;text-wrap:balance}
.lp-sh p{font-size:15.5px;color:#527090;line-height:1.72}

/* HOW IT WORKS */
.lp-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:22px;max-width:1000px;margin:0 auto;position:relative}
.lp-steps::before{content:"";position:absolute;top:38px;left:calc(16.6% + 22px);right:calc(16.6% + 22px);height:2px;background:linear-gradient(90deg,#2DD4BF,#0D9488);opacity:.22}
.lp-step{background:#F2F7FF;border:1px solid rgba(0,0,0,0.08);border-radius:18px;padding:34px 26px 28px;text-align:center;transition:box-shadow .3s,transform .3s}
.lp-step:hover{box-shadow:0 8px 28px rgba(13,148,136,0.1);transform:translateY(-4px)}
.lp-sn{width:52px;height:52px;border-radius:50%;background:#0C2040;color:#2DD4BF;font-size:20px;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;position:relative;z-index:1;box-shadow:0 0 0 6px #fff,0 0 0 8px rgba(0,0,0,0.06)}
.lp-step h3{font-size:17px;font-weight:700;color:#0C1E35;margin-bottom:10px;letter-spacing:-.3px}
.lp-step p{font-size:14px;color:#527090;line-height:1.65}

/* WHY */
.lp-why{background:#0C2040;position:relative;overflow:hidden}
.lp-why::before{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent,transparent 39px,rgba(45,212,191,0.03) 40px),repeating-linear-gradient(90deg,transparent,transparent 39px,rgba(45,212,191,0.03) 40px)}
.lp-why-inner{position:relative;z-index:1;max-width:1200px;margin:0 auto}
.lp-why .lp-sh h2{color:#fff}
.lp-why .lp-sh p{color:rgba(255,255,255,0.45)}
.lp-why .lp-sh-k{color:#2DD4BF}
.lp-why-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px;max-width:1100px;margin:0 auto}
.lp-wc{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px 22px;transition:border-color .3s,background .3s}
.lp-wc:hover{border-color:rgba(45,212,191,0.28);background:rgba(45,212,191,0.05)}
.lp-wc-icon{font-size:28px;margin-bottom:14px;display:block}
.lp-wc h3{font-size:16px;font-weight:700;color:#fff;margin-bottom:8px;letter-spacing:-.2px}
.lp-wc p{font-size:13.5px;color:rgba(255,255,255,0.42);line-height:1.62}

/* FEATURE SECTIONS */
.lp-fs{padding:96px 6vw}
.lp-fs--light{background:#F2F7FF}
.lp-fs--white{background:#fff}
.lp-fs--dark{background:#0C2040;color:#fff}
.lp-fi{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:68px;align-items:center}
.lp-fi--r{direction:rtl}.lp-fi--r>*{direction:ltr}
.lp-ftag{display:inline-flex;align-items:center;gap:6px;padding:4px 13px;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;margin-bottom:16px}
.lp-ftag--t{background:rgba(45,212,191,0.12);color:#2DD4BF;border:1px solid rgba(45,212,191,0.25)}
.lp-ftag--w{background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.15)}
.lp-ft h2{font-size:clamp(24px,3.3vw,38px);font-weight:800;line-height:1.1;letter-spacing:-1px;margin-bottom:16px;text-wrap:balance}
.lp-ft .lp-ftsub{font-size:15.5px;line-height:1.75;margin-bottom:26px;color:#527090}
.lp-fs--dark .lp-ft .lp-ftsub{color:rgba(255,255,255,0.48)}
.lp-fs--dark .lp-ft h2{color:#fff}
.lp-fl{list-style:none;display:flex;flex-direction:column;gap:11px;margin-bottom:30px;padding:0}
.lp-fl li{display:flex;align-items:flex-start;gap:10px;font-size:14.5px;font-weight:500}
.lp-fl li::before{content:"→";color:#2DD4BF;font-weight:900;flex-shrink:0;margin-top:2px}
.lp-fs--dark .lp-fl li{color:rgba(255,255,255,0.68)}

/* VIDEO MOCK */
.lp-vm{border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.15);position:relative;background:#090F1E;aspect-ratio:16/9;cursor:pointer}
.lp-fs--dark .lp-vm{box-shadow:0 20px 60px rgba(0,0,0,0.5),0 0 0 1px rgba(45,212,191,0.12)}
.lp-vm-bg{position:absolute;inset:0;background-image:radial-gradient(rgba(45,212,191,0.07) 1px,transparent 1px);background-size:24px 24px}
.lp-vm-glow{position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(45,212,191,0.07) 0%,transparent 65%)}
.lp-vm-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px}
.lp-vm-play{width:68px;height:68px;border-radius:50%;background:#2DD4BF;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .25s;box-shadow:0 0 0 14px rgba(45,212,191,0.1),0 8px 24px rgba(45,212,191,0.35);flex-shrink:0}
.lp-vm:hover .lp-vm-play{transform:scale(1.1);box-shadow:0 0 0 18px rgba(45,212,191,0.08),0 12px 32px rgba(45,212,191,0.45)}
.lp-vm-play svg{width:24px;height:24px;fill:#071929;margin-left:4px}
.lp-vm-label{font-size:15px;font-weight:600;color:rgba(255,255,255,0.78);text-align:center;padding:0 28px;line-height:1.4}
.lp-vm-badge{font-size:12px;font-weight:600;color:rgba(255,255,255,0.28);letter-spacing:.04em}
.lp-vm-bottom{position:absolute;bottom:0;left:0;right:0;padding:10px 16px;background:linear-gradient(to top,rgba(0,0,0,0.72) 0%,transparent 100%);display:flex;align-items:center;gap:10px}
.lp-vm-prog{flex:1;height:3px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden}
.lp-vm-bar{height:100%;background:#2DD4BF;border-radius:2px}
.lp-vm-time{font-size:11px;color:rgba(255,255,255,0.38);font-variant-numeric:tabular-nums;flex-shrink:0}
.lp-vm-embed{position:absolute;inset:0}
.lp-vm-embed iframe{width:100%;height:100%;border:none}

/* FORMAT BADGES */
.lp-format-badges{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0}
.lp-fbadge{display:flex;flex-direction:column;align-items:center;gap:2px;padding:12px 20px;border-radius:12px;border:1.5px solid;min-width:80px;text-align:center}
.lp-fbadge span{font-size:14px;font-weight:800;letter-spacing:-.2px}
.lp-fbadge small{font-size:10.5px;font-weight:500;opacity:.7}
.lp-fbadge--excel{background:rgba(34,197,94,0.07);border-color:rgba(34,197,94,0.25);color:#16a34a}
.lp-fbadge--csv{background:rgba(45,212,191,0.07);border-color:rgba(45,212,191,0.25);color:#0D9488}
.lp-fbadge--json{background:rgba(245,158,11,0.07);border-color:rgba(245,158,11,0.25);color:#d97706}

/* EXT TYPES */
.lp-ext-wrap{max-width:1200px;margin:56px auto 0;padding-top:48px;border-top:1px solid rgba(0,0,0,0.08)}
.lp-ext-label{font-size:12px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#527090;margin-bottom:20px;text-align:center}
.lp-ext-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.lp-ext-cat{background:#F2F7FF;border:1px solid rgba(0,0,0,0.08);border-radius:14px;padding:18px 16px}
.lp-ext-cat-title{font-size:13px;font-weight:700;color:#0C1E35;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(0,0,0,0.08)}
.lp-ext-items{display:flex;flex-direction:column;gap:7px}
.lp-ext-items span{font-size:13px;color:#527090;display:flex;align-items:center;gap:6px}
.lp-ext-items span::before{content:"↓";color:#2DD4BF;font-weight:800;font-size:11px;flex-shrink:0}

/* IMPORT TYPES */
.lp-tg{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:13px;max-width:1200px;margin:0 auto}
.lp-tc{background:#fff;border:1px solid rgba(0,0,0,0.08);border-radius:12px;padding:20px 16px;text-align:center;transition:all .2s;position:relative}
.lp-tc:hover{border-color:rgba(13,148,136,0.3);box-shadow:0 4px 18px rgba(13,148,136,0.08);transform:translateY(-2px)}
.lp-tc-icon{font-size:28px;margin-bottom:10px;display:block}
.lp-tc-name{font-size:13px;font-weight:700;color:#0C1E35;line-height:1.3}
.lp-tc-desc{font-size:11px;color:#527090;margin-top:3px;line-height:1.4}
.lp-tc-badge{display:inline-block;margin-top:8px;font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 8px;border-radius:100px;white-space:nowrap}
.lp-tc-badge--s{background:rgba(45,212,191,0.1);color:#0D9488;border:1px solid rgba(45,212,191,0.25)}
.lp-tc-badge--p{background:rgba(129,140,248,0.1);color:#6366f1;border:1px solid rgba(129,140,248,0.25)}
.lp-tc-badge--g{background:rgba(251,191,36,0.1);color:#b45309;border:1px solid rgba(251,191,36,0.3)}
/* TYPE LEGEND */
.lp-type-legend{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:14px;margin-bottom:28px}
.lp-type-legend span{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#527090}
.lp-type-legend-dot{width:8px;height:8px;border-radius:50%}

/* PRICING */
.lp-pricing-ctrl{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:14px;margin-bottom:44px}
.lp-bill-tog{display:flex;align-items:center;gap:0;background:#F2F7FF;border:1.5px solid rgba(0,0,0,0.08);border-radius:12px;padding:5px}
.lp-bill-btn{padding:9px 22px;border-radius:8px;border:none;font-size:14px;font-weight:700;cursor:pointer;color:#527090;background:transparent;transition:all .2s;display:flex;align-items:center;gap:8px}
.lp-bill-btn.lp-active{background:#fff;color:#0C1E35;box-shadow:0 2px 8px rgba(0,0,0,0.09)}
.lp-save-badge{background:#2DD4BF;color:#071929;font-size:10.5px;font-weight:800;padding:2px 8px;border-radius:100px;letter-spacing:.03em}
.lp-curr-tog{display:flex;align-items:center;flex-wrap:wrap;gap:4px;background:#F2F7FF;border:1.5px solid rgba(0,0,0,0.08);border-radius:12px;padding:5px}
.lp-curr-btn{padding:6px 12px;border-radius:8px;border:none;font-size:12px;font-weight:700;cursor:pointer;color:#527090;background:transparent;transition:all .2s;white-space:nowrap}
.lp-curr-btn.lp-active{background:#0C2040;color:#2DD4BF;box-shadow:0 2px 8px rgba(0,0,0,0.12)}

/* PLAN CARDS */
.lp-pg{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;max-width:1300px;margin:0 auto 48px}
.lp-pc{background:#F2F7FF;border:1.5px solid rgba(0,0,0,0.08);border-radius:20px;padding:26px 18px;position:relative;transition:all .25s;display:flex;flex-direction:column}
.lp-pc:hover{box-shadow:0 10px 36px rgba(0,0,0,0.07);transform:translateY(-3px)}
.lp-pc--f{background:#0C2040;border-color:#2DD4BF;box-shadow:0 16px 48px rgba(12,32,64,0.22),0 0 0 1.5px #2DD4BF}
.lp-pp{position:absolute;top:-12px;left:50%;transform:translateX(-50%);background:#2DD4BF;color:#071929;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:3px 14px;border-radius:100px;white-space:nowrap}
.lp-plan-tier{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#527090;margin-bottom:10px}
.lp-pc--f .lp-plan-tier{color:rgba(255,255,255,0.4)}
.lp-plan-price-wrap{margin-bottom:6px;display:flex;align-items:baseline;gap:4px}
.lp-plan-price-main{font-size:30px;font-weight:900;color:#0C1E35;letter-spacing:-1.5px;line-height:1;font-variant-numeric:tabular-nums}
.lp-pc--f .lp-plan-price-main{color:#2DD4BF}
.lp-plan-price-period{font-size:13px;color:#527090;font-weight:500}
.lp-pc--f .lp-plan-price-period{color:rgba(255,255,255,0.38)}
.lp-plan-billing-note{font-size:11px;color:#527090;margin-bottom:16px;min-height:16px}
.lp-pc--f .lp-plan-billing-note{color:rgba(255,255,255,0.35)}
.lp-plan-div{height:1px;background:rgba(0,0,0,0.08);margin-bottom:16px}
.lp-pc--f .lp-plan-div{background:rgba(255,255,255,0.1)}
.lp-pf{list-style:none;display:flex;flex-direction:column;gap:8px;margin-bottom:20px;flex:1;padding:0}
.lp-pf li{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;color:#0C1E35}
.lp-pc--f .lp-pf li{color:rgba(255,255,255,0.7)}
.lp-pf li::before{content:"✓";color:#2DD4BF;font-weight:800;flex-shrink:0;margin-top:1px}
.lp-pb{width:100%;padding:11px;border-radius:10px;font-size:13.5px;font-weight:700;cursor:pointer;border:none;transition:all .2s;margin-top:auto}
.lp-pb--o{background:transparent;border:1.5px solid rgba(0,0,0,0.08);color:#0C1E35}.lp-pb--o:hover{border-color:#0D9488;color:#0D9488}
.lp-pb--t{background:#2DD4BF;color:#071929}.lp-pb--t:hover{background:#24bfac;box-shadow:0 4px 16px rgba(45,212,191,0.35)}

/* COMPARISON TABLE */
.lp-comp-wrap{max-width:1300px;margin:0 auto;overflow-x:auto;border-radius:16px;border:1.5px solid rgba(0,0,0,0.08);box-shadow:0 4px 24px rgba(0,0,0,0.05)}
.lp-comp-table{width:100%;border-collapse:collapse;font-size:13px}
.lp-comp-table th{background:#0C2040;color:rgba(255,255,255,0.55);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:14px 14px;text-align:center;border-right:1px solid rgba(255,255,255,0.07)}
.lp-comp-table th:first-child{text-align:left;color:rgba(255,255,255,0.38);width:30%}
.lp-comp-table th.lp-th-f{color:#2DD4BF}
.lp-comp-table th:last-child{border-right:none}
.lp-comp-table td{padding:11px 14px;border-bottom:1px solid rgba(0,0,0,0.08);border-right:1px solid rgba(0,0,0,0.08);text-align:center;color:#527090}
.lp-comp-table td:first-child{text-align:left;font-weight:600;color:#0C1E35;background:#fff}
.lp-comp-table td:last-child{border-right:none}
.lp-comp-table tr:last-child td{border-bottom:none}
.lp-comp-table tr:nth-child(even) td{background:#F2F7FF}
.lp-comp-table tr:nth-child(even) td:first-child{background:#F2F7FF}
.lp-comp-table td.lp-td-f{background:rgba(12,32,64,0.03)!important}
.lp-comp-table tr:nth-child(even) td.lp-td-f{background:rgba(12,32,64,0.05)!important}
.lp-ck{color:#2DD4BF;font-size:15px;font-weight:900}
.lp-cx{color:#CBD5E1;font-size:15px}
.lp-comp-table .lp-cat-row td{background:#E8F0FD!important;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#527090;padding:9px 14px}

/* FAQ */
.lp-faq-list{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.lp-faq-item{background:#fff;border:1.5px solid rgba(0,0,0,0.08);border-radius:14px;overflow:hidden;transition:border-color .25s}
.lp-faq-item.lp-open{border-color:rgba(45,212,191,0.3)}
.lp-faq-q{width:100%;text-align:left;background:none;border:none;padding:20px 24px;font-size:15px;font-weight:700;color:#0C1E35;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:16px;line-height:1.4}
.lp-faq-icon{width:24px;height:24px;border-radius:50%;background:#F2F7FF;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:16px;font-weight:900;color:#527090;transition:all .3s;line-height:1}
.lp-faq-item.lp-open .lp-faq-icon{background:#2DD4BF;color:#071929;transform:rotate(45deg)}
.lp-faq-a{max-height:0;overflow:hidden;transition:max-height .35s ease,padding .3s}
.lp-faq-a-inner{padding:0 24px 20px;font-size:14.5px;color:#527090;line-height:1.72}
.lp-faq-item.lp-open .lp-faq-a{max-height:300px}

/* CTA */
.lp-cta{background:#0C2040;text-align:center;position:relative;overflow:hidden}
.lp-cta::before{content:"";position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,transparent,transparent 39px,rgba(45,212,191,0.03) 40px),repeating-linear-gradient(90deg,transparent,transparent 39px,rgba(45,212,191,0.03) 40px)}
.lp-cta-inner{position:relative;z-index:1;max-width:640px;margin:0 auto}
.lp-cta h2{font-size:clamp(28px,4.2vw,52px);font-weight:900;color:#fff;letter-spacing:-2px;margin-bottom:16px;text-wrap:balance}
.lp-cta p{font-size:16px;color:rgba(255,255,255,0.42);margin-bottom:36px;line-height:1.72}
.lp-cta-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:12px}
.lp-cta-note{margin-top:20px;font-size:12.5px;color:rgba(255,255,255,0.28)}

/* FOOTER */
.lp-footer{background:#07111F;border-top:1px solid rgba(255,255,255,0.05);padding:64px 6vw 32px}
.lp-ft-top{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:48px;margin-bottom:48px;max-width:1200px;margin-left:auto;margin-right:auto}
.lp-fl-logo{font-size:19px;font-weight:900;color:#fff;letter-spacing:-.5px;margin-bottom:12px}
.lp-fl-logo .lp-t{color:#2DD4BF}
.lp-fl-tagline{font-size:13px;color:rgba(255,255,255,0.28);line-height:1.72;max-width:280px;margin-bottom:20px}
.lp-fl-email{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:#2DD4BF;border:1px solid rgba(45,212,191,0.2);border-radius:8px;padding:8px 14px;transition:border-color .2s;text-decoration:none}
.lp-fl-email:hover{border-color:#2DD4BF}
.lp-fc h4{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:rgba(255,255,255,0.28);margin-bottom:16px}
.lp-fc ul{list-style:none;display:flex;flex-direction:column;gap:10px;padding:0;margin:0}
.lp-fc a{font-size:13px;color:rgba(255,255,255,0.42);transition:color .2s;cursor:pointer}.lp-fc a:hover{color:#2DD4BF}
.lp-ft-bottom{border-top:1px solid rgba(255,255,255,0.06);padding-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;max-width:1200px;margin:0 auto}
.lp-ft-copy{font-size:12px;color:rgba(255,255,255,0.2)}
.lp-ft-legal{display:flex;gap:20px}
.lp-ft-legal a{font-size:12px;color:rgba(255,255,255,0.2);transition:color .2s}.lp-ft-legal a:hover{color:rgba(255,255,255,0.5)}

/* SCROLL ANIMATION */
.lp-fu{opacity:0;transform:translateY(28px);transition:opacity .65s ease,transform .65s ease}
.lp-fu.lp-vis{opacity:1;transform:translateY(0)}
@media(prefers-reduced-motion:reduce){.lp-fu{opacity:1;transform:none}.lp-hc{animation:none}}

/* RESPONSIVE */
@media(max-width:1100px){.lp-pg{grid-template-columns:repeat(3,1fr)}}
@media(max-width:1000px){
  .lp-hero-inner,.lp-fi{grid-template-columns:1fr}
  .lp-hero-cards{display:none}
  .lp-fi--r{direction:ltr}
  .lp-steps{grid-template-columns:1fr}.lp-steps::before{display:none}
  .lp-pg{grid-template-columns:1fr 1fr}
  .lp-why-grid{grid-template-columns:1fr 1fr}
  .lp-ft-top{grid-template-columns:1fr 1fr}
  .lp-nav-links,.lp-btn-login{display:none}
  .lp-ham{display:flex}
}
@media(max-width:700px){.lp-ext-grid{grid-template-columns:1fr 1fr}}
@media(max-width:640px){
  .lp-pg{grid-template-columns:1fr}
  .lp-ft-top{grid-template-columns:1fr}
  .lp-stats-bar{flex-wrap:wrap}
  .lp-si{border-right:none;border-bottom:1px solid rgba(255,255,255,0.07);min-width:50%}
  .lp-tg{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}
  .lp-why-grid{grid-template-columns:1fr}
  .lp-comp-wrap{margin:0 -2vw}
  .lp-ext-grid{grid-template-columns:1fr}
}
`;

function VideoBox({ label, badge, barWidth, barTime, ytId }) {
  const [playing, setPlaying] = useState(false);
  const hasVideo = ytId && !ytId.startsWith("YOUR_") && ytId.length > 0;
  const play = () => { if (hasVideo) setPlaying(true); };
  return (
    <div className="lp-vm" onClick={!playing && hasVideo ? play : undefined} style={{ cursor: hasVideo ? "pointer" : "default" }}>
      {!playing ? (
        <>
          <div className="lp-vm-bg" />
          <div className="lp-vm-glow" />
          <div className="lp-vm-center">
            {hasVideo ? (
              <button className="lp-vm-play" onClick={play}>
                <svg viewBox="0 0 24 24"><polygon points="6,3 20,12 6,21" /></svg>
              </button>
            ) : (
              <div style={{ width: 68, height: 68, borderRadius: "50%", background: "rgba(45,212,191,0.15)", border: "1.5px solid rgba(45,212,191,0.25)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>🎬</div>
            )}
            <div className="lp-vm-label">{label}</div>
            <div className="lp-vm-badge">{hasVideo ? badge : "▶ Video tutorial coming soon"}</div>
          </div>
          <div className="lp-vm-bottom">
            <div className="lp-vm-prog"><div className="lp-vm-bar" style={{ width: hasVideo ? barWidth : "0%" }} /></div>
            <span className="lp-vm-time">{hasVideo ? barTime : "–:–"}</span>
          </div>
        </>
      ) : (
        <div className="lp-vm-embed">
          <iframe
            src={`https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0`}
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            title={label}
          />
        </div>
      )}
    </div>
  );
}

export default function LandingPage({ onLogin }) {
  const navigate = useNavigate();
  const [openFaq, setOpenFaq] = useState(null);
  const [billing, setBilling] = useState("monthly");
  const [curr, setCurr] = useState(() => detectLPCurrency());
  const [mobOpen, setMobOpen] = useState(false);
  const [landingVideos, setLandingVideos] = useState({ video1: "", video2: "", video3: "" });

  useEffect(() => {
    fetch("/api/landing/settings").then(r => r.json()).then(d => { if (d.landingVideos) setLandingVideos(d.landingVideos); }).catch(() => {});
  }, []);

  useEffect(() => {
    const obs = new IntersectionObserver(
      (entries) => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add("lp-vis"); obs.unobserve(e.target); } }),
      { threshold: 0.07, rootMargin: "0px 0px -28px 0px" }
    );
    document.querySelectorAll(".lp-fu").forEach(el => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const scrollTo = (id) => {
    const el = document.getElementById("lp-" + id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
    setMobOpen(false);
  };

  const currMeta = LP_CURRENCIES.find(c => c.code === curr) || LP_CURRENCIES[0];
  const p = LP_PRICES[curr] || LP_PRICES.INR;
  const isAnnual = billing === "annual";
  const price = (plan) => isAnnual ? p[plan].yr : p[plan].mo;
  const priceSuffix = (plan) => isAnnual ? `/year` : `/mo`;
  const pricePrefix = currMeta.sym;

  const toggleFaq = (i) => setOpenFaq(prev => prev === i ? null : i);

  return (
    <div className="lp-root">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      {/* NAV */}
      <nav className="lp-nav">
        <div className="lp-nav-logo">Import<span className="lp-t">My</span>Books</div>
        <ul className="lp-nav-links">
          {[["features","Features"],["how-it-works","How it works"],["types","Import Types"],["pricing","Pricing"],["faq","FAQ"]].map(([id,label]) => (
            <li key={id}><a onClick={() => scrollTo(id)}>{label}</a></li>
          ))}
        </ul>
        <div className="lp-nav-right">
          <button className="lp-btn-login" onClick={onLogin}>Log in</button>
          <button className="lp-btn-p" onClick={() => navigate("/signup")}>Start free →</button>
          <button className="lp-ham" onClick={() => setMobOpen(v => !v)} aria-label="Menu">
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {mobOpen && (
        <div className="lp-mob-menu">
          {[["features","Features"],["how-it-works","How it works"],["types","Import Types"],["pricing","Pricing"],["faq","FAQ"]].map(([id,label]) => (
            <a key={id} onClick={() => scrollTo(id)}>{label}</a>
          ))}
          <div className="lp-mob-btns">
            <button className="lp-btn-p" style={{ flex: 1, justifyContent: "center" }} onClick={() => { navigate("/signup"); setMobOpen(false); }}>Start free →</button>
          </div>
        </div>
      )}

      {/* HERO */}
      <section className="lp-hero" id="lp-home">
        <div className="lp-hero-inner">
          <div className="lp-fu">
            <div className="lp-kicker">✦ The complete Xero import platform</div>
            <h1>Import anything<br />into <span className="lp-acc">Xero</span>,<br />in minutes.</h1>
            <p className="lp-hero-sub">Bulk import 15+ document types — bills, invoices, credit notes, overpayments and more. Auto-allocate payments. Extract data. One tool for your entire Xero workflow.</p>
            <div className="lp-hero-actions">
              <button className="lp-btn-p" style={{ fontSize: 15, padding: "13px 26px" }} onClick={() => navigate("/signup")}>Start for free →</button>
              <button className="lp-btn-g" style={{ fontSize: 15, padding: "13px 26px" }} onClick={() => scrollTo("features")}>See all features ↓</button>
            </div>
            <div className="lp-hero-chips">
              {["Xero Bulk Import","Auto Allocation","Data Extraction","Bulk Delete","Multi-org support"].map(c => (
                <span key={c} className="lp-hchip">{c}</span>
              ))}
            </div>
          </div>
          <div className="lp-hero-cards">
            <div className="lp-hc lp-hc--f lp-fu" style={{ transitionDelay: ".1s" }}><div className="lp-hc-num">15+</div><div className="lp-hc-title">Import Types</div><div className="lp-hc-desc">Bills, invoices, credit notes, overpayments, journals and more</div></div>
            <div className="lp-hc lp-fu" style={{ transitionDelay: ".2s" }}><div className="lp-hc-num">10k</div><div className="lp-hc-title">Records / run</div><div className="lp-hc-desc">Import thousands of rows in a single batch with live progress</div></div>
            <div className="lp-hc lp-fu" style={{ transitionDelay: ".3s" }}><div className="lp-hc-num">3</div><div className="lp-hc-title">Export formats</div><div className="lp-hc-desc">Download Xero data as Excel, CSV or JSON instantly</div></div>
            <div className="lp-hc lp-fu" style={{ transitionDelay: ".4s" }}><div className="lp-hc-num">∞</div><div className="lp-hc-title">Organisations</div><div className="lp-hc-desc">Connect all your Xero orgs and switch with one click</div></div>
          </div>
        </div>
      </section>

      {/* STATS */}
      <div className="lp-stats-bar">
        <div className="lp-si"><div className="lp-si-val">15+</div><div className="lp-si-label">Xero document types supported</div></div>
        <div className="lp-si"><div className="lp-si-val">57/min</div><div className="lp-si-label">API calls automatically managed</div></div>
        <div className="lp-si"><div className="lp-si-val">5,000</div><div className="lp-si-label">Daily Xero API calls available</div></div>
        <div className="lp-si"><div className="lp-si-val">100%</div><div className="lp-si-label">Official Xero OAuth 2.0 integration</div></div>
      </div>

      {/* TRUST */}
      <div className="lp-trust">
        <p>Securely integrated with</p>
        <div className="lp-xbadge"><div className="lp-xd">X</div>Xero OAuth 2.0</div>
        <div className="lp-sep" />
        <p>Your data flows directly to Xero — never stored on our servers</p>
        <div className="lp-sep" />
        <p>Used by CA firms, bookkeepers &amp; accountants across India</p>
      </div>

      {/* HOW IT WORKS */}
      <section className="lp-sec" id="lp-how-it-works" style={{ background: "#fff" }}>
        <div className="lp-sh lp-fu">
          <div className="lp-sh-k">How it works</div>
          <h2>Start importing into Xero in 3 steps</h2>
          <p>No technical setup needed. Connect your Xero organisation, upload a CSV file, and your records appear in Xero in minutes — with duplicate detection and live error reporting.</p>
        </div>
        <div className="lp-steps">
          <div className="lp-step lp-fu">
            <div className="lp-sn">1</div>
            <h3>Connect Xero</h3>
            <p>Securely link your Xero organisation in one click using official OAuth 2.0. Switch between multiple orgs without re-authenticating.</p>
          </div>
          <div className="lp-step lp-fu" style={{ transitionDelay: ".12s" }}>
            <div className="lp-sn">2</div>
            <h3>Upload your CSV</h3>
            <p>Use our ready-made templates or map your own columns. Multi-line records, tax codes, and contact names are all handled automatically.</p>
          </div>
          <div className="lp-step lp-fu" style={{ transitionDelay: ".24s" }}>
            <div className="lp-sn">3</div>
            <h3>Import &amp; review</h3>
            <p>Watch live progress. Download a CSV error report for any failed rows. Resume interrupted imports exactly where they stopped.</p>
          </div>
        </div>
      </section>

      {/* WHY */}
      <section className="lp-sec lp-why">
        <div className="lp-why-inner">
          <div className="lp-sh lp-fu">
            <div className="lp-sh-k">Why ImportMyBooks</div>
            <h2>Built specifically for Xero professionals</h2>
            <p>Not a generic CSV uploader — every feature is engineered around how Xero works, how accountants work, and what the Xero API actually supports.</p>
          </div>
          <div className="lp-why-grid">
            {[
              { icon: "🛡️", h: "Smart duplicate detection", p: "Before importing, we scan Xero for existing records by invoice number, reference, and contact. Zero double-ups — even after a failed run." },
              { icon: "⚡", h: "Rate-limit aware engine", p: "Xero allows 60 API calls/min. Our throttle runs at 57, with 3 concurrent workers — so you never hit the limit or lose data mid-import." },
              { icon: "🔄", h: "Import Resume", p: "If an import stops at row 843 out of 2,000 — resume from row 844. No starting over. Your partial progress is always saved." },
              { icon: "📋", h: "Full import audit trail", p: "Every import is logged with date, org, user, type, records and status. Add an import note for context. Export history as CSV anytime." },
            ].map((w, i) => (
              <div key={i} className="lp-wc lp-fu" style={{ transitionDelay: `${i * 0.08}s` }}>
                <span className="lp-wc-icon">{w.icon}</span>
                <h3>{w.h}</h3>
                <p>{w.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FEATURE 1: IMPORT */}
      <section className="lp-fs lp-fs--light" id="lp-features">
        <div className="lp-fi">
          <div className="lp-ft lp-fu">
            <div className="lp-ftag lp-ftag--t">↑ Xero Bulk Import</div>
            <h2>Bulk import any Xero document in minutes</h2>
            <p className="lp-ftsub">Stop entering data one record at a time. Import thousands of rows per run — with smart duplicate detection, line-item support, partial import, and a full error report for every failed row.</p>
            <ul className="lp-fl">
              <li>Bills, invoices, credit notes, quotes &amp; purchase orders</li>
              <li>Overpayments, spend &amp; receive money, bank transfers</li>
              <li>Contacts, inventory items &amp; manual journals</li>
              <li>Automatic duplicate detection — no double imports</li>
              <li>Partial import — failed rows skip, rest succeed</li>
              <li>Import Resume — pick up exactly where you stopped</li>
              <li>Import Notes — add a note to every import for audit trail</li>
            </ul>
            <button className="lp-btn-p" style={{ width: "fit-content" }} onClick={() => navigate("/signup")}>Start importing into Xero →</button>
          </div>
          <div className="lp-fu" style={{ transitionDelay: ".15s" }}>
            <VideoBox
              label="How to import bills & invoices into Xero"
              badge="▶ Watch tutorial · ~4 min"
              barWidth="32%"
              barTime="1:18 / 4:02"
              ytId={landingVideos.video1}
            />
          </div>
        </div>
      </section>

      {/* FEATURE 2: EXTRACTION */}
      <section className="lp-fs lp-fs--white">
        <div className="lp-fi lp-fi--r">
          <div className="lp-fu">
            <VideoBox
              label="How to extract & export your Xero data"
              badge="▶ Watch tutorial · ~3 min"
              barWidth="18%"
              barTime="0:35 / 3:14"
              ytId={landingVideos.video2}
            />
          </div>
          <div className="lp-ft lp-fu" style={{ transitionDelay: ".15s" }}>
            <div className="lp-ftag lp-ftag--t">↓ Xero Data Extraction</div>
            <h2>Get your Xero data out, exactly how you need it</h2>
            <p className="lp-ftsub">Need invoices for a spreadsheet? Contacts for a mail merge? ImportMyBooks pulls any Xero data type and delivers it instantly — no API, no code, no copying.</p>
            <ul className="lp-fl">
              <li>20+ data types: invoices, bills, contacts, journals and more</li>
              <li>Filter by date range — extract only the period you need</li>
              <li>Export from any connected Xero organisation</li>
              <li>Real-time progress — keep working while it runs in background</li>
              <li>Quick date presets — Last 7 days, 30 days, 90 days, 12 months</li>
            </ul>
            <div className="lp-format-badges">
              <div className="lp-fbadge lp-fbadge--excel"><span>Excel</span><small>.xlsx</small></div>
              <div className="lp-fbadge lp-fbadge--csv"><span>CSV</span><small>.csv</small></div>
              <div className="lp-fbadge lp-fbadge--json"><span>JSON</span><small>.json</small></div>
            </div>
            <button className="lp-btn-p" style={{ width: "fit-content" }} onClick={() => navigate("/signup")}>Extract Xero data →</button>
          </div>
        </div>

        <div className="lp-ext-wrap lp-fu">
          <p className="lp-ext-label">Everything you can extract from Xero</p>
          <div className="lp-ext-grid">
            <div className="lp-ext-cat">
              <div className="lp-ext-cat-title">📄 Sales</div>
              <div className="lp-ext-items">
                <span>Sales Invoices</span><span>Sales Credit Notes</span>
                <span>Quotes &amp; Estimates</span><span>Receive Money</span>
                <span>Invoice Payments</span><span>Credit Note Refunds</span>
              </div>
            </div>
            <div className="lp-ext-cat">
              <div className="lp-ext-cat-title">📋 Purchases</div>
              <div className="lp-ext-items">
                <span>Bills (Purchase Invoices)</span><span>Purchase Credit Notes</span>
                <span>Purchase Orders</span><span>Spend Money</span>
                <span>Bill Payments</span><span>Prepayments &amp; Debit Notes</span>
              </div>
            </div>
            <div className="lp-ext-cat">
              <div className="lp-ext-cat-title">🏦 Banking</div>
              <div className="lp-ext-items">
                <span>Bank Transfers</span><span>Overpayments (AR &amp; AP)</span>
                <span>Overpayment Refunds</span><span>Manual Journals</span>
                <span>Bank Statements</span>
              </div>
            </div>
            <div className="lp-ext-cat">
              <div className="lp-ext-cat-title">⚙️ Master Data</div>
              <div className="lp-ext-items">
                <span>Contacts (all fields)</span><span>Inventory Items</span>
                <span>Chart of Accounts</span><span>Tracking Categories</span>
                <span>Tax Rates</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURE 3: AUTO ALLOCATION */}
      <section className="lp-fs lp-fs--dark">
        <div className="lp-fi">
          <div className="lp-ft lp-fu">
            <div className="lp-ftag lp-ftag--w">⇌ Xero Auto Allocation</div>
            <h2>Automatically match payments to outstanding invoices</h2>
            <p className="lp-ftsub">Stop manually allocating credit notes and overpayments one by one. Our smart matching engine groups by contact and currency, then allocates oldest invoice first — automatically. Available on the Professional plan and above.</p>
            <ul className="lp-fl">
              <li>Match credit notes → outstanding sales invoices</li>
              <li>Match overpayments &amp; prepayments → invoices &amp; bills</li>
              <li>Smart grouping by contact + currency</li>
              <li>Full match preview — review every allocation before applying</li>
              <li>Oldest-invoice-first allocation priority</li>
              <li>Remove allocations or fix allocation dates in bulk</li>
            </ul>
            <button className="lp-btn-p" style={{ width: "fit-content" }} onClick={() => scrollTo("pricing")}>See Professional plan →</button>
          </div>
          <div className="lp-fu" style={{ transitionDelay: ".15s" }}>
            <VideoBox
              label="How Auto Allocation matches Xero payments to invoices"
              badge="▶ Watch tutorial · ~5 min"
              barWidth="52%"
              barTime="2:42 / 5:10"
              ytId={landingVideos.video3}
            />
          </div>
        </div>
      </section>

      {/* IMPORT TYPES */}
      <section className="lp-sec" id="lp-types" style={{ background: "#F2F7FF" }}>
        <div className="lp-sh lp-fu">
          <div className="lp-sh-k">All import types</div>
          <h2>Every Xero document type your workflow needs</h2>
          <p>From simple contact lists to complex multi-line manual journals — ImportMyBooks handles every Xero document type with one consistent, reliable import workflow.</p>
        </div>
        <div className="lp-type-legend lp-fu">
          <span><span className="lp-type-legend-dot" style={{ background: "#0D9488" }} />All Plans (incl. Starter)</span>
          <span><span className="lp-type-legend-dot" style={{ background: "#6366f1" }} />Professional &amp; above</span>
          <span><span className="lp-type-legend-dot" style={{ background: "#b45309" }} />Growth &amp; above</span>
        </div>
        <div className="lp-tg">
          {LP_IMPORT_TYPES.map((t, i) => {
            const badge = t.plan === "starter"
              ? { cls: "lp-tc-badge--s", label: "All Plans" }
              : t.plan === "pro"
              ? { cls: "lp-tc-badge--p", label: "Professional+" }
              : { cls: "lp-tc-badge--g", label: "Growth+" };
            return (
              <div key={t.name} className="lp-tc lp-fu" style={{ transitionDelay: `${i * 0.04}s` }}>
                <span className="lp-tc-icon">{t.icon}</span>
                <div className="lp-tc-name">{t.name}</div>
                <div className="lp-tc-desc">{t.desc}</div>
                <div className={`lp-tc-badge ${badge.cls}`}>{badge.label}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* PRICING */}
      <section className="lp-sec" id="lp-pricing" style={{ background: "#fff" }}>
        <div className="lp-sh lp-fu">
          <div className="lp-sh-k">Pricing</div>
          <h2>Start free. Scale as you grow.</h2>
          <p>From solo accountants testing the water to large CA firms with enterprise volumes — a plan for every stage. No hidden fees, cancel anytime.</p>
        </div>

        <div className="lp-pricing-ctrl lp-fu">
          <div className="lp-bill-tog">
            <button className={`lp-bill-btn${billing === "monthly" ? " lp-active" : ""}`} onClick={() => setBilling("monthly")}>Monthly</button>
            <button className={`lp-bill-btn${billing === "annual" ? " lp-active" : ""}`} onClick={() => setBilling("annual")}>Annual <span className="lp-save-badge">Save 17%</span></button>
          </div>
          <div className="lp-curr-tog">
            {LP_CURRENCIES.map(c => (
              <button key={c.code} className={`lp-curr-btn${curr === c.code ? " lp-active" : ""}`} onClick={() => setCurr(c.code)}>
                {c.flag} {c.label}
              </button>
            ))}
          </div>
        </div>

        {curr === "ZAR" && (
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <span style={{ fontSize: 12.5, color: "#d97706", background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 8, padding: "7px 16px", display: "inline-block" }}>
              ⚠️ ZAR prices shown for reference — payments are processed in USD via Razorpay
            </span>
          </div>
        )}
        <div className="lp-pg">
          {/* Testing */}
          <div className="lp-pc lp-fu">
            <div className="lp-plan-tier">Testing</div>
            <div className="lp-plan-price-wrap"><span className="lp-plan-price-main">Free</span></div>
            <div className="lp-plan-billing-note">forever · no credit card</div>
            <div className="lp-plan-div" />
            <ul className="lp-pf">
              <li>100 rows total (lifetime)</li>
              <li>1 Xero organisation</li>
              <li>Core import types</li>
              <li>Smart Import Guide &amp; templates</li>
              <li>Admin approval required</li>
            </ul>
            <button className="lp-pb lp-pb--o" onClick={() => navigate("/signup")}>Get started free</button>
          </div>
          {/* Starter */}
          <div className="lp-pc lp-fu" style={{ transitionDelay: ".08s" }}>
            <div className="lp-plan-tier">Starter</div>
            <div className="lp-plan-price-wrap">
              <span className="lp-plan-price-main">{pricePrefix}{price("starter")}</span>
              <span className="lp-plan-price-period">{priceSuffix("starter")}</span>
            </div>
            <div className="lp-plan-billing-note">{isAnnual ? "billed annually" : "billed monthly"}{curr === "ZAR" ? " · charged in USD" : ""}</div>
            <div className="lp-plan-div" />
            <ul className="lp-pf">
              <li>Up to 1,000 records per import</li>
              <li>1 Xero organisation</li>
              <li>Invoices &amp; Bills (AR + AP)</li>
              <li>Spend &amp; Receive Money</li>
              <li>Contacts &amp; Chart of Accounts</li>
              <li>Import History (3 months)</li>
              <li>Email support (48h)</li>
            </ul>
            <button className="lp-pb lp-pb--o" onClick={() => navigate("/signup")}>Get Started</button>
          </div>
          {/* Professional */}
          <div className="lp-pc lp-fu" style={{ transitionDelay: ".16s" }}>
            <div className="lp-pp">Most Popular</div>
            <div className="lp-plan-tier">Professional</div>
            <div className="lp-plan-price-wrap">
              <span className="lp-plan-price-main">{pricePrefix}{price("pro")}</span>
              <span className="lp-plan-price-period">{priceSuffix("pro")}</span>
            </div>
            <div className="lp-plan-billing-note">{isAnnual ? "billed annually" : "billed monthly"}</div>
            <div className="lp-plan-div" />
            <ul className="lp-pf">
              <li>Unlimited records per import</li>
              <li>Up to 5 Xero organisations</li>
              <li>All 17+ import types</li>
              <li>Auto Allocation engine</li>
              <li>Delete Centre (9 types)</li>
              <li>Update Centre &amp; Xero Pre-Validation</li>
              <li>Import History (12 months)</li>
              <li>Priority support (24h)</li>
            </ul>
            <button className="lp-pb lp-pb--o" onClick={() => navigate("/signup")}>Get Started</button>
          </div>
          {/* Growth */}
          <div className="lp-pc lp-pc--f lp-fu" style={{ transitionDelay: ".24s" }}>
            <div className="lp-plan-tier">Growth</div>
            <div className="lp-plan-price-wrap">
              <span className="lp-plan-price-main">{pricePrefix}{price("growth")}</span>
              <span className="lp-plan-price-period">{priceSuffix("growth")}</span>
            </div>
            <div className="lp-plan-billing-note">{isAnnual ? "billed annually" : "billed monthly"}</div>
            <div className="lp-plan-div" />
            <ul className="lp-pf">
              <li>Unlimited records per import</li>
              <li>Up to 15 Xero organisations</li>
              <li>Everything in Professional</li>
              <li>Multi-user RBAC (4 permission levels)</li>
              <li>Partial import &amp; Import Resume</li>
              <li>Import Notes &amp; full audit trail</li>
              <li>Priority support (12h)</li>
            </ul>
            <button className="lp-pb lp-pb--t" onClick={() => navigate("/signup")}>Choose Growth</button>
          </div>
          {/* Enterprise */}
          <div className="lp-pc lp-fu" style={{ transitionDelay: ".32s" }}>
            <div className="lp-plan-tier">Enterprise</div>
            <div className="lp-plan-price-wrap"><span className="lp-plan-price-main">Custom</span></div>
            <div className="lp-plan-billing-note">contact us for pricing</div>
            <div className="lp-plan-div" />
            <ul className="lp-pf">
              <li>Unlimited records &amp; organisations</li>
              <li>Everything in Growth</li>
              <li>Dedicated account manager</li>
              <li>Custom onboarding &amp; training</li>
              <li>SLA-backed support (4h)</li>
              <li>Volume pricing &amp; annual discounts</li>
            </ul>
            <button className="lp-pb lp-pb--o" onClick={() => window.location.href = "mailto:support@importmybooks.com?subject=Enterprise Enquiry"}>Contact Sales</button>
          </div>
        </div>

        {/* Comparison table */}
        <div className="lp-fu">
          <h3 style={{ textAlign: "center", fontSize: 16, fontWeight: 700, color: "#527090", marginBottom: 20, letterSpacing: ".02em" }}>Full feature comparison</h3>
          <div className="lp-comp-wrap">
            <table className="lp-comp-table">
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>Testing</th>
                  <th>Starter</th>
                  <th>Professional</th>
                  <th className="lp-th-f">Growth</th>
                  <th>Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Xero organisations",           vals: ["1", "1", "5", "15", "Unlimited"] },
                  { label: "Records per import",           vals: ["100 total", "1,000", "Up to 10,000", "Unlimited", "Unlimited"] },
                  { label: "Import types",                 vals: ["Core", "12", "All 17+", "All 17+", "All 17+"] },
                  { label: "Auto Allocation engine",       vals: [false, false, true, true, true] },
                  { label: "Delete Centre (9 types)",      vals: [false, false, true, true, true] },
                  { label: "Update Centre",                vals: [false, false, true, true, true] },
                  { label: "Xero Pre-Validation",          vals: [false, false, true, true, true] },
                  { label: "Multi-user RBAC",              vals: [false, false, false, true, true] },
                  { label: "Partial import & resume",      vals: [false, false, false, true, true] },
                  { label: "Import Notes & audit trail",   vals: [false, false, false, true, true] },
                  { label: "Dedicated account manager",    vals: [false, false, false, false, true] },
                  { label: "SLA guarantee",                vals: [false, false, false, false, "4h SLA"] },
                ].map((row, ri) => (
                  <tr key={ri}>
                    <td>{row.label}</td>
                    {row.vals.map((v, vi) => (
                      <td key={vi} className={vi === 3 ? "lp-td-f" : ""}>
                        {v === true ? <span className="lp-ck">✓</span>
                          : v === false ? <span className="lp-cx">—</span>
                          : v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* COMPETITOR COMPARISON */}
      <section className="lp-sec" style={{ background: "#F2F7FF", paddingTop: 48, paddingBottom: 48 }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div className="lp-sh lp-fu" style={{ marginBottom: 28 }}>
            <div className="lp-sh-k">How we compare</div>
            <h2 style={{ fontSize: "clamp(22px,3vw,34px)" }}>The most complete Xero import tool on the market</h2>
          </div>
          <div style={{ overflowX: "auto", borderRadius: 14, border: "1.5px solid rgba(0,0,0,0.08)", boxShadow: "0 4px 20px rgba(0,0,0,0.05)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ background: "#0C2040", color: "rgba(255,255,255,0.4)", fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", padding: "13px 16px", textAlign: "left", borderRight: "1px solid rgba(255,255,255,0.07)" }}>Feature</th>
                  {[["ImportMyBooks","#2DD4BF"],["SaaSant","rgba(255,255,255,0.45)"],["DataDear","rgba(255,255,255,0.45)"],["Simple Importer","rgba(255,255,255,0.45)"]].map(([n,c]) => (
                    <th key={n} style={{ background: "#0C2040", color: c, fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", padding: "13px 16px", textAlign: "center", borderRight: "1px solid rgba(255,255,255,0.07)" }}>{n}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Import types", "17+", "~8", "~6", "~5"],
                  ["Auto Allocation engine", true, false, false, false],
                  ["Delete Centre (9 types)", true, false, false, false],
                  ["Update Centre", true, false, false, false],
                  ["Overpayments & Prepayments", true, false, false, false],
                  ["Import Resume", true, false, false, false],
                  ["Partial import (skip errors)", true, false, false, false],
                  ["Xero Pre-Validation", true, false, false, false],
                  ["Multi-user RBAC", true, false, false, false],
                ].map((row, ri) => (
                  <tr key={ri}>
                    <td style={{ padding: "10px 16px", borderBottom: "1px solid rgba(0,0,0,0.07)", fontWeight: 600, color: "#0C1E35", background: ri % 2 === 0 ? "#fff" : "#F2F7FF" }}>{row[0]}</td>
                    {row.slice(1).map((v, vi) => (
                      <td key={vi} style={{ padding: "10px 16px", borderBottom: "1px solid rgba(0,0,0,0.07)", textAlign: "center", background: vi === 0 ? (ri % 2 === 0 ? "rgba(12,32,64,0.03)" : "rgba(12,32,64,0.05)") : (ri % 2 === 0 ? "#fff" : "#F2F7FF") }}>
                        {v === true ? <span style={{ color: "#2DD4BF", fontSize: 15, fontWeight: 900 }}>✓</span>
                          : v === false ? <span style={{ color: "#CBD5E1" }}>—</span>
                          : <span style={{ fontSize: 13, fontWeight: vi === 0 ? 700 : 400, color: vi === 0 ? "#0D9488" : "#527090" }}>{v}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="lp-sec" id="lp-faq" style={{ background: "#F2F7FF" }}>
        <div className="lp-sh lp-fu">
          <div className="lp-sh-k">Frequently asked questions</div>
          <h2>Everything you need to know</h2>
          <p>Can't find the answer? Email us at <a href="mailto:support@importmybooks.com" style={{ color: "#0D9488", fontWeight: 600 }}>support@importmybooks.com</a></p>
        </div>
        <div className="lp-faq-list">
          {LP_FAQS.map((f, i) => (
            <div key={i} className={`lp-faq-item lp-fu${openFaq === i ? " lp-open" : ""}`} style={{ transitionDelay: `${i * 0.04}s` }}>
              <button className="lp-faq-q" onClick={() => toggleFaq(i)}>
                {f.q}
                <span className="lp-faq-icon">+</span>
              </button>
              <div className="lp-faq-a"><div className="lp-faq-a-inner">{f.a}</div></div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="lp-sec lp-cta">
        <div className="lp-cta-inner lp-fu">
          <h2>Ready to import into Xero in minutes?</h2>
          <p>Start with the free Testing plan — connect a Xero Demo Company and run a real import before committing. No credit card required.</p>
          <div className="lp-cta-actions">
            <button className="lp-btn-p" style={{ fontSize: 15, padding: "14px 30px" }} onClick={() => navigate("/signup")}>Start for free →</button>
            <a href="mailto:support@importmybooks.com" className="lp-btn-g" style={{ fontSize: 15, padding: "14px 30px" }}>Talk to us</a>
          </div>
          <div className="lp-cta-note">✓ Free plan available &nbsp;&nbsp; ✓ No credit card needed &nbsp;&nbsp; ✓ Cancel anytime</div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="lp-footer">
        <div className="lp-ft-top">
          <div>
            <div className="lp-fl-logo">Import<span className="lp-t">My</span>Books</div>
            <div className="lp-fl-tagline">The complete Xero bulk import and management platform — built for accountants, bookkeepers and CA firms.</div>
            <a href="mailto:support@importmybooks.com" className="lp-fl-email">✉ support@importmybooks.com</a>
          </div>
          <div className="lp-fc">
            <h4>Product</h4>
            <ul>
              <li><a onClick={() => scrollTo("features")}>Xero Importing</a></li>
              <li><a onClick={() => scrollTo("features")}>Data Extraction</a></li>
              <li><a onClick={() => scrollTo("features")}>Auto Allocation</a></li>
              <li><a onClick={() => scrollTo("pricing")}>Pricing</a></li>
            </ul>
          </div>
          <div className="lp-fc">
            <h4>Import Types</h4>
            <ul>
              <li><a onClick={() => scrollTo("types")}>Bills &amp; Invoices</a></li>
              <li><a onClick={() => scrollTo("types")}>Credit Notes</a></li>
              <li><a onClick={() => scrollTo("types")}>Overpayments</a></li>
              <li><a onClick={() => scrollTo("types")}>Contacts &amp; Items</a></li>
              <li><a onClick={() => scrollTo("types")}>Manual Journals</a></li>
            </ul>
          </div>
          <div className="lp-fc">
            <h4>Company</h4>
            <ul>
              <li><a onClick={() => scrollTo("faq")}>FAQ</a></li>
              <li><a onClick={onLogin}>Log in</a></li>
              <li><a onClick={() => navigate("/signup")}>Sign up</a></li>
              <li><a onClick={() => navigate("/terms")}>Terms of Service</a></li>
              <li><a onClick={() => navigate("/privacy")}>Privacy Policy</a></li>
            </ul>
          </div>
        </div>
        <div className="lp-ft-bottom">
          <div className="lp-ft-copy">© 2026 ImportMyBooks. All rights reserved. Not affiliated with Xero Limited.</div>
          <div className="lp-ft-legal">
            <a onClick={() => navigate("/privacy")}>Privacy</a>
            <a onClick={() => navigate("/terms")}>Terms</a>
            <a href="mailto:support@importmybooks.com">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
