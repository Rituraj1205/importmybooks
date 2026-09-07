import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });
import express from "express";
import compression from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import nodemailer from "nodemailer";
import ExcelJS from "exceljs";
import { rateLimit } from "express-rate-limit";
import { logError, logAccess } from "./logger.js";
import { isConfigured as razorpayConfigured, getKeyId as razorpayGetKeyId, createOrder as razorpayCreateOrder, verifyPayment as razorpayVerifyPayment, getPlanDays as razorpayGetPlanDays, normalizePlanId as razorpayNormalizePlan } from "./razorpayService.js";
import { sendWelcomeEmail, sendPlanApprovedEmail, sendPaymentReceivedEmail, sendForgotPasswordEmail, sendPasswordResetEmail, sendPlanExpiryWarningEmail, sendPlanExpiredEmail, sendPlanRenewedEmail, sendPlanCancelledEmail } from "./emailService.js";

const app = express();
app.use(compression());
// Capture raw body for Stripe webhook signature verification before JSON parsing
app.use(express.json({
  limit: "150mb",
  verify: (req, _res, buf) => {
    if (req.path === "/api/stripe/webhook") req.rawBody = buf;
  },
}));
const defaultAllowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
];
const envAllowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...defaultAllowedOrigins, ...envAllowedOrigins]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    exposedHeaders: ["Content-Disposition"],
    credentials: true,
  })
);

app.use(cookieParser());

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: "too_many_requests", message: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300,
  message: { error: "too_many_requests", message: "Rate limit exceeded. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // skip polling routes — they're called every 1.5s during imports
    const p = req.path || "";
    return p.includes("/status") || p.includes("/progress");
  },
});
app.use("/api/user/login", authLimiter);
app.use("/api/user/signup", authLimiter);
app.use("/api", apiLimiter);

// ── Access logging ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    if (res.statusCode >= 400) {
      const email = req.headers["x-user-token"] ? "[user]" : "";
      logAccess(req.method, req.path, res.statusCode, Date.now() - start, email);
    }
  });
  next();
});

// If no x-user-token header, fall back to httpOnly cookie (cookie-based auth)
app.use((req, _res, next) => {
  if (!req.header("x-user-token") && req.cookies?.userToken) {
    req.headers["x-user-token"] = req.cookies.userToken;
  }
  next();
});

// Maintenance mode middleware — blocks all /api routes except admin + user auth
app.use((req, res, next) => {
  if (!settingsStore.maintenanceMode) return next();
  const path2 = req.path || "";
  if (path2.startsWith("/api/admin") || path2.startsWith("/api/user/login") || path2.startsWith("/api/user/signup") || path2 === "/api/user/broadcast") return next();
  return res.status(503).json({ error: "maintenance", message: settingsStore.maintenanceBanner || "Server is under maintenance. Please try again later." });
});

// ── RBAC route guard ─────────────────────────────────────────────────────────
// Enforces that the logged-in user has the appropriate permission before any
// import / export / delete operation reaches its handler.
// Admin (ADMIN_EMAIL) always passes regardless of stored permissions.
const RBAC_RULES = [
  // All import start/append/finalize routes — needs "import" permission
  { test: (p) => p.startsWith("/api/import/") && !p.startsWith("/api/import/errors/download") && !p.startsWith("/api/import/cancel") && !p.startsWith("/api/import/undo") && !p.match(/\/api\/import\/(bills|invoices|credit-notes|spend-money|receive-money|manual-journals|bank-transfers|bill-payments|invoice-payments|credit-note-refunds|accounts|items|customers|vendors|tracking-categories|purchase-orders|quotes|overpayment|overpayment-allocation|credit-note-allocation|exchange-rate-update)\/status/), permission: "import" },
  // Export routes
  { test: (p) => p.startsWith("/api/export/start") || p.startsWith("/api/export/download"), permission: "export" },
  { test: (p) => p.startsWith("/api/export") && (p.endsWith("/start") || p.endsWith("/download")), permission: "export" },
  // Delete / void routes
  { test: (p) => p.startsWith("/api/delete/") || p.startsWith("/api/invoice/bulk-delete") || p.startsWith("/api/bill/bulk-delete") || p.startsWith("/api/billpayment/bulk-delete") || p.startsWith("/api/import/undo"), permission: "delete" },
];

app.use((req, res, next) => {
  const p = req.path || "";
  for (const rule of RBAC_RULES) {
    if (!rule.test(p)) continue;
    const token = req.header("x-user-token");
    const userData = getUserFromToken(token);
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    if (isAdminEmail(userData.user.email)) return next();
    if (!(userData.user.permissions || ["import"]).includes(rule.permission)) {
      return res.status(403).json({ error: `Permission denied. Your account does not have '${rule.permission}' access. Contact admin.` });
    }
    return next();
  }
  next();
});

const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.XERO_CLIENT_ID;
const REDIRECT_URI = process.env.XERO_REDIRECT_URI;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const SCOPES =
  process.env.XERO_SCOPES ||
  "openid profile email accounting.transactions accounting.settings accounting.contacts offline_access";

if (!CLIENT_ID || !REDIRECT_URI) {
  console.warn("Missing XERO_CLIENT_ID or XERO_REDIRECT_URI env vars.");
}
console.log(`[STARTUP] XERO_CLIENT_ID loaded: ${CLIENT_ID ? CLIENT_ID.slice(0,8) + "..." + CLIENT_ID.slice(-4) : "MISSING"}`);

const stateStore = new Map();
const sessionStore = new Map();
let latestSession = null;
const SESSION_FILE = path.join(__dirname, "sessions.json");
const API_USAGE_FILE = path.join(__dirname, "api_usage.json");
const USERS_FILE = path.join(__dirname, "users.json");
const USER_SESSIONS_FILE = path.join(__dirname, "user_sessions.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ADMIN_SESSIONS_FILE = path.join(__dirname, "admin_sessions.json");
const IMPORT_HISTORY_FILE = path.join(__dirname, "import_history.json");
let importHistoryStore = [];
const IMPORT_HISTORY_MAX = 500;

function loadImportHistory() {
  if (!fs.existsSync(IMPORT_HISTORY_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(IMPORT_HISTORY_FILE, "utf-8"));
    if (Array.isArray(data)) importHistoryStore = data;
  } catch (err) {
    console.error("Failed to load import_history.json:", err.message);
  }
}

function saveImportHistory() {
  try {
    fs.writeFileSync(IMPORT_HISTORY_FILE, JSON.stringify(importHistoryStore, null, 2));
  } catch (err) {
    console.error("Failed to save import_history.json:", err.message);
  }
}

const JOB_CHECKPOINTS_DIR = path.join(__dirname, "job_checkpoints");
if (!fs.existsSync(JOB_CHECKPOINTS_DIR)) {
  try { fs.mkdirSync(JOB_CHECKPOINTS_DIR); } catch (_) {}
}

function writeJobCheckpoint(job, type) {
  try {
    const checkpoint = {
      id: job.id, type, status: job.status,
      processed: job.processed, total: job.total,
      created: job.created, errors: job.errors, skipped: job.skipped || 0,
      tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail,
      startedAt: job.startedAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt || null,
      error: job.error || null,
    };
    fs.writeFileSync(path.join(JOB_CHECKPOINTS_DIR, `${job.id}.json`), JSON.stringify(checkpoint));
  } catch (_) {}
}

function loadJobCheckpoints() {
  try {
    const files = fs.readdirSync(JOB_CHECKPOINTS_DIR).filter(f => f.endsWith(".json"));
    const checkpoints = [];
    for (const file of files) {
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(JOB_CHECKPOINTS_DIR, file), "utf8"));
        if (cp.status === "running") {
          cp.status = "interrupted";
          cp.error = "Server restarted during import. Some records may have been created before the restart.";
          fs.writeFileSync(path.join(JOB_CHECKPOINTS_DIR, file), JSON.stringify(cp));
        }
        checkpoints.push(cp);
      } catch (_) {}
    }
    return checkpoints;
  } catch (_) { return []; }
}

function extractJobNote(req) {
  return String(req.body?.note || req.header("x-import-note") || "").slice(0, 500).trim();
}

async function sendImportCompletionEmail(entry) {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost || !entry.userEmail) return;
  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(process.env.SMTP_PORT || "587", 10),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const statusLabel = entry.status === "completed" ? "✅ Completed" : entry.status === "completed_with_errors" ? "⚠️ Completed with Errors" : `⚠️ ${entry.status}`;
    const typeLabels = { bills: "Purchase Bills", invoices: "Sales Invoices", "credit-notes": "Credit Notes", "spend-money": "Spend Money", "receive-money": "Receive Money", "bill-payments": "Bill Payments", "invoice-payments": "Invoice Payments", "manual-journals": "Manual Journals", accounts: "Chart of Accounts", items: "Inventory Items", "purchase-orders": "Purchase Orders", quotes: "Quotes" };
    const typeName = typeLabels[entry.importType] || entry.importType;
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: entry.userEmail,
      subject: `Xero Import ${statusLabel} — ${typeName}`,
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:8px"><h2 style="margin:0 0 16px;font-size:18px">Import ${statusLabel}</h2><table style="width:100%;border-collapse:collapse;font-size:14px"><tr><td style="padding:6px 0;color:#64748b">Type</td><td style="padding:6px 0;font-weight:600">${typeName}</td></tr><tr><td style="padding:6px 0;color:#64748b">Total rows</td><td style="padding:6px 0">${entry.total}</td></tr><tr><td style="padding:6px 0;color:#64748b">Created</td><td style="padding:6px 0;color:#16a34a;font-weight:600">${entry.created}</td></tr><tr><td style="padding:6px 0;color:#64748b">Errors</td><td style="padding:6px 0;color:${entry.errors > 0 ? "#dc2626" : "#64748b"};font-weight:${entry.errors > 0 ? 600 : 400}">${entry.errors}</td></tr></table>${entry.note ? `<p style="margin:16px 0 0;font-size:13px;color:#64748b">Note: ${entry.note}</p>` : ""}</div>`,
    });
    console.log(`[Email] Import completion email sent to ${entry.userEmail}`);
  } catch (err) {
    console.error(`[Email] Failed to send import completion email: ${err.message}`);
  }
}

function recordImportHistory({ importType, tenantId, orgName, userId, userEmail, total, created, errors, status, jobId, createdIds, note }) {
  const entry = {
    id: crypto.randomBytes(8).toString("hex"),
    importType,
    tenantId,
    orgName: orgName || "",
    userId,
    userEmail,
    total: total || 0,
    created: created || 0,
    errors: errors || 0,
    status,
    jobId,
    createdIds: createdIds || [],
    note: (note || "").slice(0, 500),
    date: Date.now(),
  };
  importHistoryStore.unshift(entry);
  if (importHistoryStore.length > IMPORT_HISTORY_MAX) importHistoryStore = importHistoryStore.slice(0, IMPORT_HISTORY_MAX);
  saveImportHistory();
  // Track cumulative rows for testing plan
  if (userId && created > 0) {
    const u = Array.from(userStore.values()).find(v => v.id === userId);
    if (u && u.plan === "testing") {
      u.testingRowsUsed = (u.testingRowsUsed || 0) + created;
      userStore.set(u.email, u);
      saveUsers();
    }
  }
  sendImportCompletionEmail(entry).catch(() => {});
  return entry;
}

loadImportHistory();

const AUDIT_LOG_FILE = path.join(__dirname, "audit_log.json");
let auditLogStore = [];
const AUDIT_LOG_MAX = 2000;

function loadAuditLog() {
  if (!fs.existsSync(AUDIT_LOG_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(AUDIT_LOG_FILE, "utf-8"));
    if (Array.isArray(data)) auditLogStore = data;
  } catch (_) {}
}

function saveAuditLog() {
  try { fs.writeFileSync(AUDIT_LOG_FILE, JSON.stringify(auditLogStore, null, 2)); } catch (_) {}
}

function recordAuditLog(adminEmail, action, targetEmail, details) {
  auditLogStore.unshift({ id: crypto.randomBytes(6).toString("hex"), at: Date.now(), admin: adminEmail || "admin", action, target: targetEmail || "", details: details || "" });
  if (auditLogStore.length > AUDIT_LOG_MAX) auditLogStore = auditLogStore.slice(0, AUDIT_LOG_MAX);
  saveAuditLog();
}

loadAuditLog();

const userStore = new Map();
const userSessionStore = new Map();
const adminSessionStore = new Map();
const bulkDeleteJobStore = new Map();
const bulkVoidJobStore = new Map();
const quoteDeleteJobStore = new Map();
const poDeleteJobStore = new Map();
const spendReceiveDeleteJobStore = new Map();
const bankTransferDeleteJobStore = new Map();
const contactArchiveJobStore = new Map();
const accountsImportJobStore = new Map();
const billsImportJobStore = new Map();
const invoicesImportJobStore = new Map();
const creditNotesImportJobStore = new Map();
const overpaymentImportJobStore = new Map();
const overpaymentAllocationJobStore = new Map();
const creditNoteAllocationJobStore = new Map();
const spendMoneyImportJobStore = new Map();
const receiveMoneyImportJobStore = new Map();
const itemsImportJobStore = new Map();
const customersImportJobStore = new Map();
const vendorsImportJobStore = new Map();
const trackingCategoryImportJobStore = new Map();
const billPaymentImportJobStore = new Map();
const invoicePaymentImportJobStore = new Map();
const creditNoteRefundImportJobStore = new Map();
const manualJournalImportJobStore = new Map();
const journalFixJobStore = new Map();
const undoJobStore = new Map();
const opDupVoidJobStore = new Map();
const exchangeRateUpdateJobStore = new Map();
const bankTransferImportJobStore = new Map();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();

// ── Login rate limiter (in-memory, no external package) ─────────────────────
// Tracks failed login attempts per IP. After 10 failures in 15 minutes the IP
// is blocked. The window resets automatically after 15 minutes.
const _loginAttemptStore = new Map(); // ip -> { fails, resetAt }
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOGIN_MAX_FAILS = 10;

function checkLoginRateLimit(ip) {
  const now = Date.now();
  let entry = _loginAttemptStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { fails: 0, resetAt: now + LOGIN_RATE_WINDOW_MS };
  }
  entry.fails += 1;
  _loginAttemptStore.set(ip, entry);
  return entry.fails <= LOGIN_MAX_FAILS;
}

function resetLoginRateLimit(ip) {
  _loginAttemptStore.delete(ip);
}

// Cleanup old entries every 30 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _loginAttemptStore) {
    if (now > entry.resetAt) _loginAttemptStore.delete(ip);
  }
}, 30 * 60 * 1000);

const settingsStore = {
  maxUsers: Number.parseInt(process.env.MAX_USERS || "7", 10) || 7,
  adminPasswordHash: null,
  adminPasswordSalt: null,
  allowedTypes: [],
  deniedTypes: [],
  maintenanceMode: false,
  maintenanceBanner: "",
  broadcastMessage: "",
  landingVideos: { video1: "", video2: "", video3: "" },
};

function loadSessions() {
  if (!fs.existsSync(SESSION_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && data.sessions) {
      Object.entries(data.sessions).forEach(([key, value]) => {
        sessionStore.set(key, value);
      });
    }
    if (data && data.latestSession) {
      latestSession = data.latestSession;
    }
  } catch (err) {
    console.error("Failed to load sessions:", err);
  }
}

function saveSessions() {
  try {
    const sessionsObj = Object.fromEntries(sessionStore.entries());
    const payload = { sessions: sessionsObj, latestSession };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("Failed to save sessions:", err);
  }
}

loadSessions();

// ── Xero API usage tracker ──────────────────────────────────────────────────
// Counts every real Xero API request, broken down by feature/resource, reset
// daily at UTC midnight (matches Xero's own day-limit reset). Purely for
// visibility into the shared 5,000-calls/day quota — does not affect requests.
function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

let apiUsageStore = { date: todayUtcKey(), byFeature: {}, history: {} };

function loadApiUsage() {
  if (!fs.existsSync(API_USAGE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(API_USAGE_FILE, "utf-8"));
    if (data && typeof data === "object") {
      apiUsageStore = { date: data.date || todayUtcKey(), byFeature: data.byFeature || {}, history: data.history || {} };
    }
  } catch (err) {
    console.error("Failed to load api_usage.json:", err);
  }
}

function saveApiUsage() {
  try {
    fs.writeFileSync(API_USAGE_FILE, JSON.stringify(apiUsageStore, null, 2));
  } catch (err) {
    console.error("Failed to save api_usage.json:", err);
  }
}

let _apiSaveTimer = null;
function scheduleApiUsageSave() {
  if (_apiSaveTimer) return;
  _apiSaveTimer = setTimeout(() => {
    _apiSaveTimer = null;
    saveApiUsage();
  }, 5000);
}

function recordApiUsage(feature) {
  const key = todayUtcKey();
  if (apiUsageStore.date !== key) {
    apiUsageStore.history[apiUsageStore.date] = apiUsageStore.byFeature;
    const historyKeys = Object.keys(apiUsageStore.history).sort();
    while (historyKeys.length > 30) {
      delete apiUsageStore.history[historyKeys.shift()];
    }
    apiUsageStore = { date: key, byFeature: {}, history: apiUsageStore.history };
  }
  const label = feature || "Other";
  apiUsageStore.byFeature[label] = (apiUsageStore.byFeature[label] || 0) + 1;
  scheduleApiUsageSave();
}

process.on("SIGTERM", () => { if (_apiSaveTimer) { clearTimeout(_apiSaveTimer); saveApiUsage(); } process.exit(0); });
process.on("SIGINT",  () => { if (_apiSaveTimer) { clearTimeout(_apiSaveTimer); saveApiUsage(); } process.exit(0); });

function deriveApiFeatureFromUrl(url, method) {
  try {
    const u = new URL(url);
    if (u.hostname === "api.xero.com" && u.pathname.startsWith("/api.xro/2.0/")) {
      const resource = u.pathname.slice("/api.xro/2.0/".length).split("/")[0] || "Unknown";
      return `${(method || "GET").toUpperCase()} ${resource}`;
    }
    if (u.hostname === "api.xero.com" && u.pathname.startsWith("/connections")) {
      return "Connections";
    }
    if (u.hostname === "identity.xero.com") {
      return "OAuth Token Refresh";
    }
    return `${(method || "GET").toUpperCase()} ${u.hostname}${u.pathname}`;
  } catch {
    return "Unknown";
  }
}

loadApiUsage();

function hashPassword(password, salt) {
  const iterations = 120000;
  const keylen = 64;
  const digest = "sha256";
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
  return hash.toString("base64");
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(USERS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.users)) {
      data.users.forEach((user) => {
        if (user && user.id && user.email) {
          const normalized = String(user.email).trim().toLowerCase();
          const loaded = { ...user, disabled: Boolean(user.disabled) };
          if (!Array.isArray(loaded.permissions)) loaded.permissions = ["import"];
          userStore.set(normalized, loaded);
        }
      });
    }
  } catch (err) {
    console.error("Failed to load users:", err);
  }
}

function saveUsers() {
  try {
    const users = Array.from(userStore.values());
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2));
  } catch (err) {
    console.error("Failed to save users:", err);
  }
}

function loadUserSessions() {
  if (!fs.existsSync(USER_SESSIONS_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(USER_SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) {
      data.sessions.forEach((session) => {
        if (session && session.token && session.userId) {
          userSessionStore.set(session.token, session);
        }
      });
    }
  } catch (err) {
    console.error("Failed to load user sessions:", err);
  }
}

function saveUserSessions() {
  try {
    const sessions = Array.from(userSessionStore.values());
    fs.writeFileSync(USER_SESSIONS_FILE, JSON.stringify({ sessions }, null, 2));
  } catch (err) {
    console.error("Failed to save user sessions:", err);
  }
}

function loadAdminSessions() {
  if (!fs.existsSync(ADMIN_SESSIONS_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(ADMIN_SESSIONS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.sessions)) {
      data.sessions.forEach((session) => {
        if (session && session.token && session.email) {
          adminSessionStore.set(session.token, session);
        }
      });
    }
  } catch (err) {
    console.error("Failed to load admin sessions:", err);
  }
}

function saveAdminSessions() {
  try {
    const sessions = Array.from(adminSessionStore.values());
    fs.writeFileSync(ADMIN_SESSIONS_FILE, JSON.stringify({ sessions }, null, 2));
  } catch (err) {
    console.error("Failed to save admin sessions:", err);
  }
}

function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (data && Number.isFinite(data.maxUsers)) {
      settingsStore.maxUsers = Math.max(1, Math.floor(data.maxUsers));
    }
    if (data && data.adminPasswordHash && data.adminPasswordSalt) {
      settingsStore.adminPasswordHash = data.adminPasswordHash;
      settingsStore.adminPasswordSalt = data.adminPasswordSalt;
    }
    if (data && Array.isArray(data.allowedTypes)) {
      settingsStore.allowedTypes = data.allowedTypes;
    }
    if (data && Array.isArray(data.deniedTypes)) {
      settingsStore.deniedTypes = data.deniedTypes;
    }
    if (data && typeof data.maintenanceMode === "boolean") settingsStore.maintenanceMode = data.maintenanceMode;
    if (data && typeof data.maintenanceBanner === "string") settingsStore.maintenanceBanner = data.maintenanceBanner;
    if (data && typeof data.broadcastMessage === "string") settingsStore.broadcastMessage = data.broadcastMessage;
    if (data && data.landingVideos && typeof data.landingVideos === "object") {
      settingsStore.landingVideos = {
        video1: String(data.landingVideos.video1 || ""),
        video2: String(data.landingVideos.video2 || ""),
        video3: String(data.landingVideos.video3 || ""),
      };
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsStore, null, 2));
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

function isAdminEmail(email) {
  if (!email) return false;
  return String(email).toLowerCase() === ADMIN_EMAIL;
}

function isTypeAllowed(type) {
  if (!type) return false;
  const allowed = Array.isArray(settingsStore.allowedTypes)
    ? settingsStore.allowedTypes
    : [];
  const denied = Array.isArray(settingsStore.deniedTypes)
    ? settingsStore.deniedTypes
    : [];
  if (allowed.length) {
    return allowed.includes(type);
  }
  return true;
}

function createAdminSession(email) {
  const token = crypto.randomBytes(24).toString("hex");
  const payload = { token, email, createdAt: Date.now() };
  adminSessionStore.set(token, payload);
  saveAdminSessions();
  return token;
}

function getAdminFromToken(token) {
  if (!token) return null;
  const session = adminSessionStore.get(token);
  if (!session) return null;
  if (!isAdminEmail(session.email)) return null;
  return session;
}

function createUserSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  const payload = {
    token,
    userId: user.id,
    email: user.email,
    createdAt: Date.now(),
  };
  userSessionStore.set(token, payload);
  saveUserSessions();
  return token;
}

function getUserFromToken(token) {
  if (!token) return null;
  const session = userSessionStore.get(token);
  if (!session) return null;
  const user = Array.from(userStore.values()).find((u) => u.id === session.userId);
  if (!user) return null;
  if (user.disabled) return null;
  return { user, session };
}

// ── Plan Configuration ──────────────────────────────────────────────────────
// All types available to every paid plan — plan differentiates on features (delete, allocation, team), not import types
const ALL_PAID_IMPORT_TYPES = [
  "bills", "invoices", "credit-notes", "credit-note-refunds",
  "spend-money", "receive-money", "bill-payments", "invoice-payments",
  "manual-journals", "spend-overpayments", "receive-overpayments",
  "spend-alloc", "receive-alloc",
  "accounts", "items", "customers", "vendors", "tracking-categories",
  "purchase-orders", "quotes",
];

const PLAN_CONFIG = {
  starter: {
    maxRowsPerImport: null,
    maxOrgs: 1,
    dailyApiCalls: 1000,
    allowedImportTypes: ALL_PAID_IMPORT_TYPES,
    exportAccess: false,
    deleteAccess: false,
    autoAllocationAccess: false,
    manualJournalsAccess: true,
    paymentImportAccess: true,
    overpaymentAccess: true,
    purchaseOrdersAccess: true,
    quotesAccess: true,
  },
  professional: {
    maxRowsPerImport: null,
    maxOrgs: 5,
    dailyApiCalls: 5000,
    allowedImportTypes: ALL_PAID_IMPORT_TYPES,
    exportAccess: true,
    deleteAccess: true,
    autoAllocationAccess: true,
    manualJournalsAccess: true,
    paymentImportAccess: true,
    overpaymentAccess: true,
    purchaseOrdersAccess: true,
    quotesAccess: true,
  },
  growth: {
    maxRowsPerImport: null,
    maxOrgs: 15,
    dailyApiCalls: 15000,
    allowedImportTypes: ALL_PAID_IMPORT_TYPES,
    exportAccess: true,
    deleteAccess: true,
    autoAllocationAccess: true,
    manualJournalsAccess: true,
    paymentImportAccess: true,
    overpaymentAccess: true,
    purchaseOrdersAccess: true,
    quotesAccess: true,
  },
  enterprise: {
    maxRowsPerImport: null,
    maxOrgs: null,
    dailyApiCalls: null,
    allowedImportTypes: ALL_PAID_IMPORT_TYPES,
    exportAccess: true,
    deleteAccess: true,
    autoAllocationAccess: true,
    manualJournalsAccess: true,
    paymentImportAccess: true,
    overpaymentAccess: true,
    purchaseOrdersAccess: true,
    quotesAccess: true,
  },
  testing: {
    maxRowsPerImport: null,
    maxTotalRows: 100,
    maxOrgs: 1,
    dailyApiCalls: 200,
    allowedImportTypes: ["bills", "invoices", "spend-money", "receive-money", "accounts", "customers", "vendors"],
    exportAccess: false,
    deleteAccess: false,
    autoAllocationAccess: false,
    manualJournalsAccess: false,
    paymentImportAccess: false,
    overpaymentAccess: false,
    purchaseOrdersAccess: false,
    quotesAccess: false,
  },
  none: {
    maxRowsPerImport: 0,
    maxTotalRows: 0,
    maxOrgs: 0,
    dailyApiCalls: 0,
    allowedImportTypes: [],
    exportAccess: false,
    deleteAccess: false,
    autoAllocationAccess: false,
    manualJournalsAccess: false,
    paymentImportAccess: false,
    overpaymentAccess: false,
    purchaseOrdersAccess: false,
    quotesAccess: false,
  },
};

// Merge base plan limits with any per-user custom overrides
function getUserPlanLimits(user) {
  // Admin always gets unlimited rows
  if (user.email === ADMIN_EMAIL) {
    const base = PLAN_CONFIG[user.plan] || PLAN_CONFIG.enterprise;
    return { ...base, maxRowsPerImport: null, maxOrgs: null };
  }
  const base = PLAN_CONFIG[user.plan] || PLAN_CONFIG.starter;
  if (!user.customLimits || typeof user.customLimits !== "object") return base;
  const merged = { ...base };
  const c = user.customLimits;
  if (typeof c.maxRowsPerImport === "number" || c.maxRowsPerImport === null) merged.maxRowsPerImport = c.maxRowsPerImport;
  if (typeof c.maxOrgs === "number" || c.maxOrgs === null) merged.maxOrgs = c.maxOrgs;
  if (Array.isArray(c.allowedImportTypes)) merged.allowedImportTypes = c.allowedImportTypes;
  if (typeof c.exportAccess === "boolean") merged.exportAccess = c.exportAccess;
  if (typeof c.deleteAccess === "boolean") merged.deleteAccess = c.deleteAccess;
  if (typeof c.autoAllocationAccess === "boolean") merged.autoAllocationAccess = c.autoAllocationAccess;
  if (typeof c.manualJournalsAccess === "boolean") merged.manualJournalsAccess = c.manualJournalsAccess;
  if (typeof c.paymentImportAccess === "boolean") merged.paymentImportAccess = c.paymentImportAccess;
  if (typeof c.overpaymentAccess === "boolean") merged.overpaymentAccess = c.overpaymentAccess;
  if (typeof c.purchaseOrdersAccess === "boolean") merged.purchaseOrdersAccess = c.purchaseOrdersAccess;
  if (typeof c.quotesAccess === "boolean") merged.quotesAccess = c.quotesAccess;
  return merged;
}

// Helper: check if import type is allowed and rows within limit
function checkImportAccess(user, importTypeKey, rowCount) {
  if (!user.plan || user.plan === "none") {
    return { allowed: false, error: "No active plan. Please request Testing access or upgrade to a paid plan from your dashboard." };
  }
  if (user.planStatus && user.planStatus !== "active") {
    return { allowed: false, error: "Your plan is pending admin approval. You will be notified once access is granted." };
  }
  // Team members: no expiry check, no row limits — permissions controlled by admin checkboxes
  if (user.plan === "team") return { allowed: true };
  if (user.plan !== "testing" && user.planExpiry) {
    const expiry = new Date(user.planExpiry);
    if (!isNaN(expiry) && expiry < new Date()) {
      return { allowed: false, error: `Your ${user.plan} plan expired on ${user.planExpiry}. Please renew from the Pricing page.` };
    }
  }
  // Testing plan: enforce total rows limit (100 rows across ALL imports)
  if (user.plan === "testing") {
    const used = user.testingRowsUsed || 0;
    const remaining = 100 - used;
    if (remaining <= 0) {
      return { allowed: false, error: `Testing plan limit reached. You have used all 100 testing rows. Contact admin to upgrade.` };
    }
    if (rowCount > remaining) {
      return { allowed: false, error: `Testing plan: only ${remaining} row${remaining === 1 ? "" : "s"} remaining out of 100 total. Your file has ${rowCount.toLocaleString()} rows. Please reduce your file or contact admin to upgrade.` };
    }
  }
  const limits = getUserPlanLimits(user);
  if (!limits.allowedImportTypes.includes(importTypeKey)) {
    const planLabel = (user.plan || "starter").charAt(0).toUpperCase() + (user.plan || "starter").slice(1);
    return { allowed: false, error: `Your ${planLabel} plan does not include ${importTypeKey} imports. Please upgrade to access this feature.` };
  }
  if (limits.maxRowsPerImport !== null && rowCount > limits.maxRowsPerImport) {
    const planLabel = (user.plan || "starter").charAt(0).toUpperCase() + (user.plan || "starter").slice(1);
    return { allowed: false, error: `Your ${planLabel} plan allows a maximum of ${limits.maxRowsPerImport.toLocaleString()} rows per import. Your file has ${rowCount.toLocaleString()} rows. Please upgrade to import more rows.` };
  }
  return { allowed: true };
}

loadUsers();
loadUserSessions();
loadSettings();
loadAdminSessions();
const _interruptedCheckpoints = loadJobCheckpoints();

const EXPORT_DIR = path.join(__dirname, "exports");
const JOBS_FILE = path.join(EXPORT_DIR, "jobs.json");
const EXPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const jobStore = new Map();
const jobQueue = [];
let activeJobs = 0;
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const MAX_CONCURRENT_JOBS = parsePositiveInt(
  process.env.MAX_CONCURRENT_EXPORT_JOBS,
  3
);
const MAX_CONCURRENT_JOBS_PER_USER = parsePositiveInt(
  process.env.MAX_CONCURRENT_EXPORT_JOBS_PER_USER,
  1
);
const MAX_CONCURRENT_BULK_DELETE = parsePositiveInt(
  process.env.MAX_CONCURRENT_BULK_DELETE,
  4
);
const activeJobsByUser = new Map();

function getJobOwnerKey(job) {
  if (!job) return "unknown";
  return job.userId || job.userEmail || "unknown";
}

function ensureExportDir(folder = EXPORT_DIR) {
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }
}

function sanitizeFolderName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-z0-9-_]+/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "unknown";
}

function formatTimestamp(dateValue) {
  const now = dateValue ? new Date(dateValue) : new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

function saveJobs() {
  try {
    ensureExportDir();
    const jobs = Array.from(jobStore.values());
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs }, null, 2));
  } catch (err) {
    console.error("Failed to save jobs:", err);
  }
}

function loadJobs() {
  ensureExportDir();
  if (!fs.existsSync(JOBS_FILE)) {
    return;
  }
  try {
    const raw = fs.readFileSync(JOBS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    jobs.forEach((job) => {
      if (job.status === "running") {
        job.status = "queued";
      }
      jobStore.set(job.id, job);
      if (job.status === "queued") {
        jobQueue.push(job.id);
      }
    });
  } catch (err) {
    console.error("Failed to load jobs:", err);
  }
}

function removeJobFiles(job) {
  if (!job?.files) return;
  Object.values(job.files).forEach((file) => {
    if (file?.path && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // ignore delete errors
      }
    }
  });
}

function pruneOldJobs() {
  const cutoff = Date.now() - EXPORT_RETENTION_MS;
  const toDelete = [];
  jobStore.forEach((job) => {
    if (job.createdAt && job.createdAt < cutoff) {
      toDelete.push(job);
    }
  });
  toDelete.forEach((job) => {
    removeJobFiles(job);
    jobStore.delete(job.id);
  });
  if (toDelete.length) {
    saveJobs();
  }
}

async function processJob(job) {
  job.status = "running";
  job.startedAt = job.startedAt || Date.now();
  job.progress = {
    page: 0,
    pageCount: null,
    count: 0,
    totalCount: null,
  };
  job.updatedAt = Date.now();
  saveJobs();
  try {
    const session = sessionStore.get(job.sessionId);
    if (!session) {
      throw new Error("Session expired. Please reconnect.");
    }
    const accessToken = await getAccessToken(session);
    const config = typeConfigs[job.type];
    if (!config) {
      throw new Error(`Unsupported type: ${job.type}`);
    }

    const safeName = job.type.replace(/[^a-z0-9]+/gi, "_");
    const timestamp = formatTimestamp(job.createdAt);
    const files = {};
    const template = exportTemplates[job.type] || null;

    const userFolder = sanitizeFolderName(job.userId || "unknown");
    const tenantFolder = sanitizeFolderName(
      job.tenantName || job.tenantId || "tenant"
    );
    const targetDir = path.join(EXPORT_DIR, userFolder, tenantFolder);
    ensureExportDir(targetDir);
    job.folderPath = targetDir;

    const buildPath = (ext) =>
      path.join(targetDir, `${job.id}_${safeName}_${timestamp}.${ext}`);

    const wantExcel = job.format === "all" || job.format === "excel";
    const wantCsv = job.format === "all" || job.format === "csv";
    const wantJson = job.format === "all" || job.format === "json";

    let columns = null;
    let csvStream = null;
    let excelWorkbook = null;
    let excelSheet = null;
    let jsonStream = null;
    let jsonWritten = 0;
    let jsonHeaderMode = null;

    const csvPath = buildPath("csv");
    const excelPath = buildPath("xlsx");
    const jsonPath = buildPath("json");

    const escapeCsv = (value) => {
      const text = value === undefined || value === null ? "" : String(value);
      if (text.includes('"') || text.includes(",") || text.includes("\n")) {
        return `"${text.replace(/"/g, '""')}"`;
      }
      return text;
    };

    const initColumns = (rows) => {
      if (columns || !rows.length) return;
      const rawColumns = template
        ? template.columns
        : Array.from(
            rows.reduce((set, row) => {
              Object.keys(row).forEach((key) => set.add(key));
              return set;
            }, new Set())
          );
      columns = normalizeColumns(rawColumns);

      if (wantCsv) {
        csvStream = fs.createWriteStream(csvPath, { encoding: "utf-8" });
        csvStream.write(
          `${columns.map((col) => escapeCsv(col.header)).join(",")}\n`
        );
        files.csv = {
          filename: `${safeName}_${timestamp}.csv`,
          path: csvPath,
        };
      }

      if (wantExcel) {
        excelWorkbook = new ExcelJS.stream.xlsx.WorkbookWriter({
          filename: excelPath,
        });
        excelSheet = excelWorkbook.addWorksheet("data");
        excelSheet.columns = columns.map((col) => ({
          header: col.header,
          key: col.key,
        }));
        files.excel = {
          filename: `${safeName}_${timestamp}.xlsx`,
          path: excelPath,
        };
      }
    };

    const writeRows = (rows) => {
      if (!rows.length) return;
      initColumns(rows);
      if (!columns) return;

      const normalizeRowValue = (value) => {
        if (typeof value !== "string") return value;
        if (!value.includes("/Date(")) return value;
        const formatted = formatXeroDate(value);
        return formatted || value;
      };

      if (wantCsv && csvStream) {
        rows.forEach((row) => {
          const line = columns
            .map((col) => escapeCsv(normalizeRowValue(row[col.key])))
            .join(",");
          csvStream.write(`${line}\n`);
        });
      }

      if (wantExcel && excelSheet) {
        rows.forEach((row) => {
          const normalized = {};
          columns.forEach((col) => {
            const value = normalizeRowValue(row[col.key]);
            normalized[col.key] =
              value === undefined || value === null ? "" : value;
          });
          excelSheet.addRow(normalized).commit();
        });
      }
    };

    const ensureJsonStarted = (raw) => {
      if (!wantJson || jsonStream) return;
      jsonStream = fs.createWriteStream(jsonPath, { encoding: "utf-8" });
      const header = buildRawHeader(raw, config.collectionKey);
      if (header) {
        jsonHeaderMode = "raw";
        jsonStream.write(header);
      } else {
        jsonHeaderMode = "simple";
        jsonStream.write(
          `{"type":${JSON.stringify(job.type)},"records":[`
        );
      }
      files.json = {
        filename: `${safeName}_${timestamp}.json`,
        path: jsonPath,
      };
    };

    const writeJsonRecords = (records, raw) => {
      if (!wantJson || !records.length) return;
      ensureJsonStarted(raw);
      records.forEach((record) => {
        if (jsonWritten > 0) {
          jsonStream.write(",");
        }
        jsonStream.write(JSON.stringify(record));
        jsonWritten += 1;
      });
    };

    const exportContext = await buildExportContext({
      accessToken,
      tenantId: job.tenantId,
      type: job.type,
      session,
    });

    const result = await fetchPagedRecords({
      accessToken,
      tenantId: job.tenantId,
      type: job.type,
      from: job.from,
      to: job.to,
      session,
      onPage: async (records, raw, meta) => {
        if (!records.length) return;
        const rows = template
          ? template.mapRows(records, raw, exportContext)
          : records.flatMap((record) => expandLineItems(record));
        writeRows(rows);
        writeJsonRecords(records, raw);
        job.progress = {
          page: meta?.page ?? job.progress?.page ?? 0,
          pageCount: meta?.pageCount ?? job.progress?.pageCount ?? null,
          count: (job.progress?.count ?? 0) + records.length,
          totalCount: meta?.itemCount ?? job.progress?.totalCount ?? null,
        };
        job.updatedAt = Date.now();
        saveJobs();
      },
    });

    job.count = result.count || 0;
    job.rate = result.rate || {};

    if (!job.count) {
      if (csvStream) {
        await new Promise((resolve) => csvStream.end(resolve));
      }
      if (excelSheet) {
        excelSheet.commit();
      }
      if (excelWorkbook) {
        await excelWorkbook.commit();
      }
      if (jsonStream) {
        jsonStream.write(jsonHeaderMode === "simple" ? "]}" : "]}");
        await new Promise((resolve) => jsonStream.end(resolve));
      }
      job.status = "no_records";
      job.updatedAt = Date.now();
      saveJobs();
      return;
    }

    if (csvStream) {
      await new Promise((resolve) => csvStream.end(resolve));
    }
    if (excelSheet) {
      excelSheet.commit();
    }
    if (excelWorkbook) {
      await excelWorkbook.commit();
    }
    if (jsonStream) {
      if (jsonHeaderMode === "simple") {
        jsonStream.write(`],"count":${job.count}}`);
      } else {
        jsonStream.write("]}");
      }
      await new Promise((resolve) => jsonStream.end(resolve));
    }

    job.files = files;
    job.status = "ready";
    job.updatedAt = Date.now();
    saveJobs();
  } catch (err) {
    job.status = "error";
    job.error = err.message || "Export failed";
    job.updatedAt = Date.now();
    saveJobs();
  }
}

function processQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS) {
    const nextIndex = jobQueue.findIndex((jobId) => {
      const queuedJob = jobStore.get(jobId);
      if (!queuedJob || queuedJob.status !== "queued") return false;
      const ownerKey = getJobOwnerKey(queuedJob);
      const ownerActive = activeJobsByUser.get(ownerKey) || 0;
      return ownerActive < MAX_CONCURRENT_JOBS_PER_USER;
    });
    if (nextIndex === -1) return;

    const [jobId] = jobQueue.splice(nextIndex, 1);
    const job = jobStore.get(jobId);
    if (!job || job.status !== "queued") continue;

    const ownerKey = getJobOwnerKey(job);
    const ownerActive = activeJobsByUser.get(ownerKey) || 0;
    activeJobs += 1;
    activeJobsByUser.set(ownerKey, ownerActive + 1);

    processJob(job)
      .catch((err) => console.error("Job processing failed:", err))
      .finally(() => {
        activeJobs -= 1;
        const activeForOwner = activeJobsByUser.get(ownerKey) || 0;
        if (activeForOwner <= 1) {
          activeJobsByUser.delete(ownerKey);
        } else {
          activeJobsByUser.set(ownerKey, activeForOwner - 1);
        }
        processQueue();
      });
  }
}

function enqueueJob(job) {
  jobQueue.push(job.id);
  processQueue();
}

const typeConfigs = {
  "Invoice PAID": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCREC",
    status: "PAID",
    unitdp: 4,
    paged: true,
  },
  "Invoice AUTHORISED": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCREC",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Invoice DRAFT": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCREC",
    status: "DRAFT",
    unitdp: 4,
    paged: true,
  },
  "Bill PAID": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCPAY",
    status: "PAID",
    unitdp: 4,
    paged: true,
  },
  "Bill AUTHORISED": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCPAY",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Bill DRAFT": {
    path: "/Invoices",
    collectionKey: "Invoices",
    type: "ACCPAY",
    status: "DRAFT",
    unitdp: 4,
    paged: true,
  },
  "Invoice CreditNotes AUTHORISED": {
    path: "/CreditNotes",
    collectionKey: "CreditNotes",
    type: "ACCRECCREDIT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Invoice CreditNotes PAID": {
    path: "/CreditNotes",
    collectionKey: "CreditNotes",
    type: "ACCRECCREDIT",
    status: "PAID",
    unitdp: 4,
    paged: true,
  },
  "Supplier CreditNotes AUTHORISED": {
    path: "/CreditNotes",
    collectionKey: "CreditNotes",
    type: "ACCPAYCREDIT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Supplier CreditNotes PAID": {
    path: "/CreditNotes",
    collectionKey: "CreditNotes",
    type: "ACCPAYCREDIT",
    status: "PAID",
    unitdp: 4,
    paged: true,
  },
  Spend: {
    path: "/BankTransactions",
    collectionKey: "BankTransactions",
    type: "SPEND",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  Receive: {
    path: "/BankTransactions",
    collectionKey: "BankTransactions",
    type: "RECEIVE",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  Transfer: {
    path: "/BankTransfers",
    collectionKey: "BankTransfers",
    unitdp: null,
    paged: false,
  },
  "Bill Payment": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "ACCPAYPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Invoice Payment": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "ACCRECPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "CreditNoteRefund Invoice": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "ARCREDITPAYMENT",
    unitdp: 4,
    paged: true,
  },
  "CreditNoteRefund Bill": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "APCREDITPAYMENT",
    unitdp: 4,
    paged: true,
  },
  "Overpayment Refund AP": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "APOVERPAYMENTPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Overpayment Refund AR": {
    path: "/Payments",
    collectionKey: "Payments",
    paymentType: "AROVERPAYMENTPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Overpayment Refunds": {
    path: "/Payments",
    collectionKey: "Payments",
    where: "Overpayment!=null",
    unitdp: 4,
    paged: true,
  },
  "Spend Overpayment": {
    path: "/BankTransactions",
    collectionKey: "BankTransactions",
    type: "SPEND-OVERPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Receive Overpayment": {
    path: "/BankTransactions",
    collectionKey: "BankTransactions",
    type: "RECEIVE-OVERPAYMENT",
    status: "AUTHORISED",
    unitdp: 4,
    paged: true,
  },
  "Manual Journals": {
    path: "/ManualJournals",
    collectionKey: "ManualJournals",
    paged: true,
  },
  Quotes: {
    path: "/Quotes",
    collectionKey: "Quotes",
    paged: true,
  },
  "Purchase Orders": {
    path: "/PurchaseOrders",
    collectionKey: "PurchaseOrders",
    paged: true,
  },
  Prepayments: {
    path: "/Prepayments",
    collectionKey: "Prepayments",
    paged: true,
  },
  "Debit Notes": {
    path: "/CreditNotes",
    collectionKey: "CreditNotes",
    type: "ACCPAYCREDIT",
    paged: true,
  },
  "Tracking Category": {
    path: "/TrackingCategories",
    collectionKey: "TrackingCategories",
    paged: false,
    allowDateFilter: false,
  },
  Classes: {
    path: "/TrackingCategories",
    collectionKey: "TrackingCategories",
    paged: false,
    allowDateFilter: false,
  },
  Contacts: {
    path: "/Contacts",
    collectionKey: "Contacts",
    paged: true,
    allowDateFilter: false,
  },
  Inventory: {
    path: "/Items",
    collectionKey: "Items",
    paged: true,
    allowDateFilter: false,
  },
  Items: {
    path: "/Items",
    collectionKey: "Items",
    paged: true,
    allowDateFilter: false,
  },
  "Chart of Accounts": {
    path: "/Accounts",
    collectionKey: "Accounts",
    paged: false,
    allowDateFilter: false,
  },
};

function createCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function createCodeChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function buildAccountCodeIndex(records) {
  const index = new Map();
  const list = Array.isArray(records) ? records : [];
  list.forEach((account) => {
    if (!account?.AccountID || !account?.Code) {
      return;
    }
    index.set(account.AccountID, account.Code);
  });
  return index;
}

function needsBankAccountCodeFallback(type) {
  return (
    type === "Spend" ||
    type === "Receive" ||
    type === "Spend Overpayment" ||
    type === "Receive Overpayment"
  );
}

function resolveBankAccountCode(bankAccount, context = {}) {
  if (bankAccount?.Code) {
    return bankAccount.Code;
  }
  if (!bankAccount?.AccountID) {
    return "";
  }
  return context.accountCodeIndex?.get(bankAccount.AccountID) || "";
}

function buildAuthUrl(state, codeChallenge, clientId) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId || CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login",
  });
  return `https://login.xero.com/identity/connect/authorize?${params.toString()}`;
}

function getSession(sessionId) {
  const session = sessionStore.get(sessionId);
  if (!session) {
    throw new Error("Session not found. Please connect again.");
  }
  return session;
}

function getSessionCandidates(sessionId) {
  const seen = new Set();
  const candidates = [];
  const addCandidate = (candidateId) => {
    if (!candidateId || seen.has(candidateId) || !sessionStore.has(candidateId)) return;
    seen.add(candidateId);
    candidates.push({ sessionId: candidateId, session: getSession(candidateId) });
  };
  // Primary session first
  addCandidate(sessionId);
  // Same user's other sessions (e.g. reconnected after expiry)
  const primarySession = sessionId ? sessionStore.get(sessionId) : null;
  const userId = primarySession?.userId;
  if (userId) {
    for (const [id, sess] of sessionStore.entries()) {
      if (sess.userId === userId) addCandidate(id);
    }
  } else {
    addCandidate(latestSession?.sessionId);
  }
  return candidates;
}

function userHasActiveSession(userId) {
  if (!userId) return false;
  for (const session of sessionStore.values()) {
    if (session.userId === userId) return true;
  }
  return false;
}

async function runWithCandidateSessions(sessionId, runner) {
  const candidates = getSessionCandidates(sessionId);
  if (!candidates.length) throw new Error("Missing session. Connect again.");

  // Prefer non-exhausted sessions first, fall back to exhausted ones if needed
  const sorted = [...candidates].sort((a, b) => (a.session.dayExhausted ? 1 : 0) - (b.session.dayExhausted ? 1 : 0));

  let lastError = null;
  let dayLimitWaitMs = 0;
  let dayLimitHits = 0;

  for (const candidate of sorted) {
    const clientLabel = (candidate.session.clientId || "default").slice(0, 8) + "...";

    if (candidate.session.dayExhausted) {
      dayLimitHits++;
      lastError = new DayLimitError("Session exhausted");
      continue;
    }

    let accessToken = await getAccessToken(candidate.session);
    try {
      const result = await runner({
        accessToken,
        session: candidate.session,
        sessionId: candidate.sessionId,
      });
      candidate.session.dayUsed = (candidate.session.dayUsed || 0) + 1;
      return { ...result, resolvedSessionId: candidate.sessionId };
    } catch (err) {
      if (err instanceof DayLimitError || err.code === "DAY_LIMIT") {
        console.log(`[DayLimit] Client ${clientLabel} hit day limit → switching to next session...`);
        candidate.session.dayExhausted = true;
        candidate.session.dayExhaustedAt = Date.now();
        candidate.session.dayUsed = (candidate.session.dayUsed || 0) + 1;
        dayLimitWaitMs = Math.max(dayLimitWaitMs, err.waitMs || 0);
        dayLimitHits++;
        lastError = err;
        saveSessions();
        continue;
      }
      if (err.message && err.message.includes("Xero API error 401")) {
        try {
          accessToken = await forceRefreshSession(candidate.session);
          const retryResult = await runner({
            accessToken,
            session: candidate.session,
            sessionId: candidate.sessionId,
          });
          candidate.session.dayUsed = (candidate.session.dayUsed || 0) + 1;
          return { ...retryResult, resolvedSessionId: candidate.sessionId };
        } catch (refreshErr) {
          lastError = refreshErr;
          continue;
        }
      }
      throw err;
    }
  }

  // All sessions hit day limit → auto-wait for reset then retry
  if (dayLimitHits === sorted.length && dayLimitWaitMs > 0) {
    const waitMin = Math.round(dayLimitWaitMs / 60000);
    console.log(`[DayLimit] ALL ${sorted.length} session(s) exhausted. Waiting ${waitMin} min for midnight UTC reset...`);
    let elapsed = 0;
    const CHUNK = 30 * 60 * 1000;
    while (elapsed < dayLimitWaitMs) {
      const sleep = Math.min(CHUNK, dayLimitWaitMs - elapsed);
      await delay(sleep);
      elapsed += sleep;
      const rem = Math.round((dayLimitWaitMs - elapsed) / 60000);
      if (rem > 0) console.log(`[DayLimit] Reset in ${rem} min...`);
    }
    // Reset all exhausted flags
    for (const c of sorted) {
      c.session.dayExhausted = false;
      c.session.dayExhaustedAt = null;
      c.session.dayUsed = 0;
    }
    saveSessions();
    console.log(`[DayLimit] All sessions reset. Resuming with session 1...`);
    const first = sorted[0];
    const token = await getAccessToken(first.session);
    const result = await runner({ accessToken: token, session: first.session, sessionId: first.sessionId });
    first.session.dayUsed = (first.session.dayUsed || 0) + 1;
    return { ...result, resolvedSessionId: first.sessionId };
  }

  throw lastError || new Error("Request failed. Please reconnect to Xero.");
}

async function fetchPaymentById({ accessToken, tenantId, paymentId }) {
  const requestUrl = `https://api.xero.com/api.xro/2.0/Payments/${encodeURIComponent(
    paymentId
  )}`;
  const response = await fetchWithRetry(requestUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });
  const payments = Array.isArray(response.data?.Payments) ? response.data.Payments : [];
  return {
    response,
    payment: payments[0] || null,
  };
}

function normalizeHeaderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function parseBooleanCell(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return undefined;
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value "${value}". Use Yes/No or True/False.`);
}

function buildAccountFromImportRow(row) {
  const account = {
    Code: String(row.code || "").trim(),
    Name: String(row.name || "").trim(),
    Type: String(row.type || "").trim().toUpperCase(),
  };
  const optionalStrings = {
    BankAccountNumber: row.bankAccountNumber,
    BankAccountType: row.bankAccountType,
    Description: row.description,
    TaxType: row.tax,
    CurrencyCode: row.currencyCode,
  };
  Object.entries(optionalStrings).forEach(([key, value]) => {
    const normalized = String(value || "").trim();
    if (normalized) account[key] = normalized;
  });
  const optionalBooleans = {
    AddToWatchlist: row.showOnDashboard,
    EnablePaymentsToAccount: row.enablePaymentsToAccount,
    ShowInExpenseClaims: row.expenseClaims,
  };
  Object.entries(optionalBooleans).forEach(([key, value]) => {
    const parsed = parseBooleanCell(value);
    if (parsed !== undefined) account[key] = parsed;
  });
  return account;
}

function buildAccountsImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentAccountCode: job.currentAccountCode || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsAccountsImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

function buildItemFromImportRow(row) {
  if (!row.code) throw new Error(`Row ${row.rowNumber}: Code is required.`);
  if (!row.name) throw new Error(`Row ${row.rowNumber}: Name is required.`);
  const item = {
    Code: String(row.code).trim(),
    Name: String(row.name).trim(),
  };
  if (row.description) item.Description = String(row.description).trim();
  if (row.purchaseDescription) item.PurchaseDescription = String(row.purchaseDescription).trim();
  const isSold = parseBooleanCell(row.isSold);
  if (isSold !== undefined) item.IsSold = isSold;
  const isPurchased = parseBooleanCell(row.isPurchased);
  if (isPurchased !== undefined) item.IsPurchased = isPurchased;
  // cogsAccountCode from CSV is the Inventory Asset Account (INVENTORY type in Xero).
  // For tracked inventory items, set InventoryAccountCode (top-level) and IsTrackedAsInventory.
  // The PurchaseDetails.COGSAccountCode must be a DIRECTCOSTS account — use purchaseAccountCode.
  if (row.cogsAccountCode) {
    item.IsTrackedAsInventory = true;
    item.InventoryAssetAccountCode = String(row.cogsAccountCode).trim();
  }
  const hasSales = row.salesUnitPrice || row.salesAccountCode || row.salesTaxType;
  if (hasSales) {
    item.SalesDetails = {};
    if (row.salesUnitPrice) item.SalesDetails.UnitPrice = parseFloat(row.salesUnitPrice) || 0;
    if (row.salesAccountCode) item.SalesDetails.AccountCode = String(row.salesAccountCode).trim();
    if (row.salesTaxType) item.SalesDetails.TaxType = String(row.salesTaxType).trim().toUpperCase();
  }
  const hasPurchase = row.purchaseUnitPrice || row.purchaseAccountCode || row.purchaseTaxType || row.cogsAccountCode;
  if (hasPurchase) {
    item.PurchaseDetails = {};
    if (row.purchaseUnitPrice) item.PurchaseDetails.UnitPrice = parseFloat(row.purchaseUnitPrice) || 0;
    if (row.purchaseAccountCode) item.PurchaseDetails.AccountCode = String(row.purchaseAccountCode).trim();
    if (row.purchaseTaxType) item.PurchaseDetails.TaxType = String(row.purchaseTaxType).trim().toUpperCase();
    // For tracked inventory: COGSAccountCode = the DIRECTCOSTS purchase account (not the inventory asset account)
    if (row.cogsAccountCode && row.purchaseAccountCode) {
      item.PurchaseDetails.COGSAccountCode = String(row.purchaseAccountCode).trim();
    }
  }
  return item;
}

function buildItemsImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentItemCode: job.currentItemCode || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsItemsImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function createItemInXero({ tenantId, requestedSessionId, row }) {
  const item = buildItemFromImportRow(row);
  const requestUrl = "https://api.xero.com/api.xro/2.0/Items?summarizeErrors=false";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Items: [item] }),
    });
    return { response };
  });
  const createdItem = result.response.data?.Items?.[0] || {};
  const validationErrors = Array.isArray(createdItem.ValidationErrors)
    ? createdItem.ValidationErrors
    : [];
  if (createdItem.StatusAttributeString === "ERROR" || validationErrors.length) {
    throw new Error(
      validationErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this item."
    );
  }
  return { item: createdItem, sessionId: result.resolvedSessionId };
}

async function processItemsImportJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 100;
  for (let i = 0; i < job.rows.length; i += BATCH_SIZE) {
    if (job.cancelRequested) break;
    const batch = job.rows.slice(i, i + BATCH_SIZE);
    job.currentRowNumber = batch[0]?.rowNumber;
    job.currentItemCode = batch[0]?.code || "";
    job.updatedAt = Date.now();
    try {
      const items = batch.map(row => buildItemFromImportRow(row));
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Items?summarizeErrors=false", {
          method: "PUT",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
          body: JSON.stringify({ Items: items }),
        });
        return { response };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroItems = result.response.data?.Items || [];
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xi = xeroItems[j] || {};
        const valErrors = Array.isArray(xi.ValidationErrors) ? xi.ValidationErrors : [];
        if (xi.StatusAttributeString === "ERROR" || valErrors.length > 0) {
          const msg = valErrors.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this item.";
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, code: row.code, name: row.name, status: "error", message: msg });
        } else {
          job.created += 1;
          job.results.push({ rowNumber: row.rowNumber, code: row.code, name: row.name, status: "created", message: "Item created/updated successfully." });
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const row of batch) {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, code: row.code, name: row.name, status: "error", message: err.message });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  }
  job.currentRowNumber = null;
  job.currentItemCode = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const itemHistEntry = recordImportHistory({ importType: "items", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: [], note: job.note || "" });
  job.historyId = itemHistEntry.id;
}

function buildContactFromImportRow(row) {
  if (!row.name) throw new Error(`Row ${row.rowNumber}: Name is required.`);
  const contact = {
    Name: String(row.name).trim(),
    IsCustomer: true,
  };
  if (row.firstName) contact.FirstName = String(row.firstName).trim();
  if (row.lastName) contact.LastName = String(row.lastName).trim();
  if (row.emailAddress) contact.EmailAddress = String(row.emailAddress).trim();
  if (row.accountNumber) { const an = String(row.accountNumber).trim(); if (an.length <= 50) contact.AccountNumber = an; }
  if (row.taxNumber) contact.TaxNumber = String(row.taxNumber).trim();
  if (row.website) contact.Website = String(row.website).trim();
  if (row.phone) {
    contact.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: String(row.phone).trim() }];
  }
  const hasAddress = row.addressLine1 || row.city || row.region || row.postalCode || row.country;
  if (hasAddress) {
    contact.Addresses = [{
      AddressType: "STREET",
      ...(row.addressLine1 ? { AddressLine1: String(row.addressLine1).trim() } : {}),
      ...(row.addressLine2 ? { AddressLine2: String(row.addressLine2).trim() } : {}),
      ...(row.city ? { City: String(row.city).trim() } : {}),
      ...(row.region ? { Region: String(row.region).trim() } : {}),
      ...(row.postalCode ? { PostalCode: String(row.postalCode).trim() } : {}),
      ...(row.country ? { Country: String(row.country).trim() } : {}),
    }];
  }
  return contact;
}

function buildCustomersImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentContactName: job.currentContactName || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsCustomersImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function createContactInXero({ tenantId, requestedSessionId, row }) {
  const contact = buildContactFromImportRow(row);
  const requestUrl = "https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Contacts: [contact] }),
    });
    return { response };
  });
  const createdContact = result.response.data?.Contacts?.[0] || {};
  const validationErrors = Array.isArray(createdContact.ValidationErrors)
    ? createdContact.ValidationErrors
    : [];
  if (createdContact.StatusAttributeString === "ERROR" || validationErrors.length) {
    throw new Error(
      validationErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this contact."
    );
  }
  return { contact: createdContact, sessionId: result.resolvedSessionId };
}

async function processCustomersImportJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 100;

  const putContactsBatch = async (contacts) => {
    const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
      const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
        body: JSON.stringify({ Contacts: contacts }),
      });
      return { response };
    });
    if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
    return result.response.data?.Contacts || [];
  };

  const isAccountNumberError = (msgs) => msgs.some(m => /account.?number/i.test(m));

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE) {
    if (job.cancelRequested) break;
    const batch = job.rows.slice(i, i + BATCH_SIZE);
    job.currentRowNumber = batch[0]?.rowNumber;
    job.currentContactName = batch[0]?.name || "";
    job.updatedAt = Date.now();
    try {
      const contacts = batch.map(row => buildContactFromImportRow(row));
      const xeroContacts = await putContactsBatch(contacts);
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xc = xeroContacts[j] || {};
        const valErrors = Array.isArray(xc.ValidationErrors) ? xc.ValidationErrors : [];
        const errMsgs = valErrors.map(e => e.Message || e.Description).filter(Boolean);
        if ((xc.StatusAttributeString === "ERROR" || valErrors.length > 0) && isAccountNumberError(errMsgs)) {
          try {
            const contactNoAccNum = { ...contacts[j] };
            delete contactNoAccNum.AccountNumber;
            const retryResult = await putContactsBatch([contactNoAccNum]);
            const rxc = retryResult[0] || {};
            const retryErrors = Array.isArray(rxc.ValidationErrors) ? rxc.ValidationErrors : [];
            if (rxc.StatusAttributeString === "ERROR" || retryErrors.length > 0) {
              const retryMsg = retryErrors.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this customer.";
              job.errors += 1;
              job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: retryMsg });
            } else {
              job.created += 1;
              job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "created", message: "Customer saved (AccountNumber skipped — already in use or too long)." });
            }
          } catch (retryErr) {
            job.errors += 1;
            job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: retryErr.message });
          }
        } else if (xc.StatusAttributeString === "ERROR" || valErrors.length > 0) {
          const msg = errMsgs.join("; ") || "Xero rejected this customer.";
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: msg });
        } else {
          job.created += 1;
          job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "created", message: "Customer created/updated successfully." });
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const row of batch) {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: err.message });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  }
  job.currentRowNumber = null;
  job.currentContactName = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

function buildVendorFromImportRow(row) {
  if (!row.name) throw new Error(`Row ${row.rowNumber}: Name is required.`);
  const contact = {
    Name: String(row.name).trim(),
    IsSupplier: true,
  };
  if (row.firstName) contact.FirstName = String(row.firstName).trim();
  if (row.lastName) contact.LastName = String(row.lastName).trim();
  if (row.emailAddress) contact.EmailAddress = String(row.emailAddress).trim();
  if (row.accountNumber) { const an = String(row.accountNumber).trim(); if (an.length <= 50) contact.AccountNumber = an; }
  if (row.taxNumber) contact.TaxNumber = String(row.taxNumber).trim();
  if (row.website) contact.Website = String(row.website).trim();
  if (row.phone) {
    contact.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: String(row.phone).trim() }];
  }
  const hasAddress = row.addressLine1 || row.city || row.region || row.postalCode || row.country;
  if (hasAddress) {
    contact.Addresses = [{
      AddressType: "STREET",
      ...(row.addressLine1 ? { AddressLine1: String(row.addressLine1).trim() } : {}),
      ...(row.addressLine2 ? { AddressLine2: String(row.addressLine2).trim() } : {}),
      ...(row.city ? { City: String(row.city).trim() } : {}),
      ...(row.region ? { Region: String(row.region).trim() } : {}),
      ...(row.postalCode ? { PostalCode: String(row.postalCode).trim() } : {}),
      ...(row.country ? { Country: String(row.country).trim() } : {}),
    }];
  }
  return contact;
}

function buildVendorsImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentContactName: job.currentContactName || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsVendorsImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function createVendorInXero({ tenantId, requestedSessionId, row }) {
  const contact = buildVendorFromImportRow(row);
  const requestUrl = "https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Contacts: [contact] }),
    });
    return { response };
  });
  const createdContact = result.response.data?.Contacts?.[0] || {};
  const validationErrors = Array.isArray(createdContact.ValidationErrors)
    ? createdContact.ValidationErrors
    : [];
  if (createdContact.StatusAttributeString === "ERROR" || validationErrors.length) {
    throw new Error(
      validationErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this vendor."
    );
  }
  return { contact: createdContact, sessionId: result.resolvedSessionId };
}

async function processVendorsImportJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 100;

  const putContactsBatch = async (contacts) => {
    const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
      const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false", {
        method: "PUT",
        headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
        body: JSON.stringify({ Contacts: contacts }),
      });
      return { response };
    });
    if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
    return result.response.data?.Contacts || [];
  };

  const isAccountNumberError = (msgs) => msgs.some(m => /account.?number/i.test(m));

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE) {
    if (job.cancelRequested) break;
    const batch = job.rows.slice(i, i + BATCH_SIZE);
    job.currentRowNumber = batch[0]?.rowNumber;
    job.currentContactName = batch[0]?.name || "";
    job.updatedAt = Date.now();
    try {
      const contacts = batch.map(row => buildVendorFromImportRow(row));
      const xeroContacts = await putContactsBatch(contacts);
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xc = xeroContacts[j] || {};
        const valErrors = Array.isArray(xc.ValidationErrors) ? xc.ValidationErrors : [];
        const errMsgs = valErrors.map(e => e.Message || e.Description).filter(Boolean);
        if ((xc.StatusAttributeString === "ERROR" || valErrors.length > 0) && isAccountNumberError(errMsgs)) {
          // Retry this single contact without AccountNumber
          try {
            const contactNoAccNum = { ...contacts[j] };
            delete contactNoAccNum.AccountNumber;
            const retryResult = await putContactsBatch([contactNoAccNum]);
            const rxc = retryResult[0] || {};
            const retryErrors = Array.isArray(rxc.ValidationErrors) ? rxc.ValidationErrors : [];
            if (rxc.StatusAttributeString === "ERROR" || retryErrors.length > 0) {
              const retryMsg = retryErrors.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this vendor.";
              job.errors += 1;
              job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: retryMsg });
            } else {
              job.created += 1;
              job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "created", message: "Vendor saved (AccountNumber skipped — already in use or too long)." });
            }
          } catch (retryErr) {
            job.errors += 1;
            job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: retryErr.message });
          }
        } else if (xc.StatusAttributeString === "ERROR" || valErrors.length > 0) {
          const msg = errMsgs.join("; ") || "Xero rejected this vendor.";
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: msg });
        } else {
          job.created += 1;
          job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "created", message: "Vendor created/updated successfully." });
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const row of batch) {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, name: row.name, email: row.emailAddress || "", status: "error", message: err.message });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  }
  job.currentRowNumber = null;
  job.currentContactName = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

function buildTrackingCategoryImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentCategoryName: job.currentCategoryName || "",
    currentOptionName: job.currentOptionName || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsTrackingCategoryImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function fetchAllTrackingCategories({ tenantId, requestedSessionId }) {
  const requestUrl = "https://api.xero.com/api.xro/2.0/TrackingCategories?includeArchived=false";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    return { response };
  });
  return { categories: result.response.data?.TrackingCategories || [], sessionId: result.resolvedSessionId };
}

async function createTrackingCategoryInXero({ tenantId, requestedSessionId, categoryName }) {
  const requestUrl = "https://api.xero.com/api.xro/2.0/TrackingCategories";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Name: categoryName, Status: "ACTIVE" }),
    });
    return { response };
  });
  const category = result.response.data?.TrackingCategories?.[0] || {};
  const validationErrors = Array.isArray(category.ValidationErrors) ? category.ValidationErrors : [];
  if (category.StatusAttributeString === "ERROR" || validationErrors.length) {
    throw new Error(
      validationErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this tracking category."
    );
  }
  if (!category.TrackingCategoryID) {
    throw new Error("Xero did not return a TrackingCategoryID.");
  }
  return { trackingCategoryId: category.TrackingCategoryID, sessionId: result.resolvedSessionId };
}

async function addTrackingOptionInXero({ tenantId, requestedSessionId, trackingCategoryId, optionName }) {
  const requestUrl = `https://api.xero.com/api.xro/2.0/TrackingCategories/${trackingCategoryId}/Options`;
  const body = { Options: [{ Name: optionName }] };
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify(body),
    });
    return { response };
  });
  const option = result.response.data?.Options?.[0] || {};
  const validationErrors = Array.isArray(option.ValidationErrors) ? option.ValidationErrors : [];
  if (option.StatusAttributeString === "ERROR" || validationErrors.length) {
    throw new Error(
      validationErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this tracking option."
    );
  }
  return { option, sessionId: result.resolvedSessionId };
}

async function processTrackingCategoryImportJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  // categoryIdMap: lowercase name → trackingCategoryId
  const categoryIdMap = new Map();
  // existingOptionsMap: trackingCategoryId → Set of lowercase option names already in Xero
  const existingOptionsMap = new Map();

  // Pre-load all existing categories (and their options) from Xero to avoid duplicate errors
  try {
    const fetchResult = await fetchAllTrackingCategories({
      tenantId: job.tenantId,
      requestedSessionId: job.sessionId,
    });
    job.sessionId = fetchResult.sessionId || job.sessionId;
    for (const cat of fetchResult.categories) {
      if (!cat.TrackingCategoryID) continue;
      categoryIdMap.set(String(cat.Name || "").trim().toLowerCase(), cat.TrackingCategoryID);
      const optionNames = new Set(
        (Array.isArray(cat.Options) ? cat.Options : [])
          .map((o) => String(o.Name || "").trim().toLowerCase())
      );
      existingOptionsMap.set(cat.TrackingCategoryID, optionNames);
    }
  } catch (_) {
    // If fetch fails, proceed without pre-population — individual rows will surface errors
  }

  for (const row of job.rows) {
    if (job.cancelRequested) break;
    job.currentRowNumber = row.rowNumber;
    job.currentCategoryName = row.categoryName;
    job.currentOptionName = row.optionName;
    job.updatedAt = Date.now();
    try {
      const catKey = row.categoryName.toLowerCase();
      let trackingCategoryId = categoryIdMap.get(catKey);
      if (!trackingCategoryId) {
        const catResult = await createTrackingCategoryInXero({
          tenantId: job.tenantId,
          requestedSessionId: job.sessionId,
          categoryName: row.categoryName,
        });
        trackingCategoryId = catResult.trackingCategoryId;
        categoryIdMap.set(catKey, trackingCategoryId);
        existingOptionsMap.set(trackingCategoryId, new Set());
        job.sessionId = catResult.sessionId || job.sessionId;
      }

      // Skip if option already exists in Xero
      const existingOptions = existingOptionsMap.get(trackingCategoryId) || new Set();
      if (existingOptions.has(row.optionName.toLowerCase())) {
        job.results.push({
          rowNumber: row.rowNumber,
          categoryName: row.categoryName,
          optionName: row.optionName,
          status: "skipped",
          message: "Tracking option already exists in Xero.",
        });
        job.processed += 1;
        job.updatedAt = Date.now();
        continue;
      }

      const optResult = await addTrackingOptionInXero({
        tenantId: job.tenantId,
        requestedSessionId: job.sessionId,
        trackingCategoryId,
        optionName: row.optionName,
      });
      job.sessionId = optResult.sessionId || job.sessionId;
      existingOptions.add(row.optionName.toLowerCase());
      existingOptionsMap.set(trackingCategoryId, existingOptions);
      job.created += 1;
      job.results.push({
        rowNumber: row.rowNumber,
        categoryName: row.categoryName,
        optionName: row.optionName,
        status: "created",
        message: "Tracking option created successfully.",
      });
    } catch (err) {
      job.errors += 1;
      job.results.push({
        rowNumber: row.rowNumber,
        categoryName: row.categoryName,
        optionName: row.optionName,
        status: "error",
        message: err.message,
      });
    }
    job.processed += 1;
    job.updatedAt = Date.now();
  }
  job.currentRowNumber = null;
  job.currentCategoryName = "";
  job.currentOptionName = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

async function createAccountInXero({ tenantId, requestedSessionId, row }) {
  const account = buildAccountFromImportRow(row);
  const requestUrl =
    "https://api.xero.com/api.xro/2.0/Accounts?summarizeErrors=false";
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Accounts: [account] }),
    });
    return { response };
  });
  const createdAccount = result.response.data?.Accounts?.[0] || {};
  const validationErrors = Array.isArray(createdAccount.ValidationErrors)
    ? createdAccount.ValidationErrors
    : [];
  if (createdAccount.StatusAttributeString === "ERROR" || validationErrors.length) {
    const reason = validationErrors
      .map((e) => e.Message || e.Description)
      .filter(Boolean)
      .join("; ");
    throw new Error(reason || "Xero rejected this account.");
  }
  return {
    account: createdAccount,
    sessionId: result.resolvedSessionId,
  };
}

async function processAccountsImportJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  for (const row of job.rows) {
    if (job.cancelRequested) break;
    job.currentRowNumber = row.rowNumber;
    job.currentAccountCode = row.code || "";
    job.updatedAt = Date.now();
    try {
      const result = await createAccountInXero({
        tenantId: job.tenantId,
        requestedSessionId: job.sessionId,
        row,
      });
      job.sessionId = result.sessionId || job.sessionId;
      job.created += 1;
      job.results.push({
        rowNumber: row.rowNumber,
        code: row.code,
        name: row.name,
        status: "created",
        message: "Account created successfully.",
      });
    } catch (err) {
      job.errors += 1;
      job.results.push({
        rowNumber: row.rowNumber,
        code: row.code,
        name: row.name,
        status: "error",
        message: err.message,
      });
    }
    job.processed += 1;
    job.updatedAt = Date.now();
  }
  job.currentRowNumber = null;
  job.currentAccountCode = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

function parseSimpleDelimited(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes("\t")
    ? "\t"
    : lines[0].includes(";")
      ? ";"
      : ",";
  return lines.map((line) => line.split(delimiter).map((cell) => cell.trim()));
}

async function extractPaymentIdsFromUpload({
  filename,
  contentBase64,
  columnName = "payment id",
}) {
  const buffer = Buffer.from(contentBase64, "base64");
  const ext = path.extname(String(filename || "")).toLowerCase();
  const normalizedTarget = normalizeHeaderName(columnName);
  let rows = [];

  if (ext === ".csv" || ext === ".txt") {
    rows = parseSimpleDelimited(buffer.toString("utf-8"));
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error("Sheet is empty.");
    }
    worksheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((value) => (value == null ? "" : String(value).trim())));
    });
  }

  if (!rows.length) {
    throw new Error("No rows found in uploaded sheet.");
  }

  const headers = rows[0].map((header) => normalizeHeaderName(header));
  // Accept Payment_ID (new export), payment id, paymentid — all variations
  const candidateNames = [normalizedTarget, "payment_id", "paymentid", "payment id"];
  let columnIndex = -1;
  for (const name of candidateNames) {
    columnIndex = headers.findIndex((h) => h === name);
    if (columnIndex !== -1) break;
  }
  if (columnIndex === -1) {
    throw new Error(`Column "Payment_ID" not found in sheet. Export Bill Payments from this tool and use that file.`);
  }

  const extractedRows = rows
    .slice(1)
    .map((row, index) => ({
      rowNumber: index + 2,
      paymentId: String(row[columnIndex] || "").trim(),
    }));

  return extractedRows;
}

async function deletePaymentInXero({ tenantId, paymentId, requestedSessionId }) {
  const requestUrl = `https://api.xero.com/api.xro/2.0/Payments/${encodeURIComponent(paymentId)}`;

  try {
    const deleteResult = await runWithCandidateSessions(
      requestedSessionId,
      async ({ accessToken }) => {
        const response = await fetchWithRetry(requestUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
          },
          body: JSON.stringify({ Status: "DELETED" }),
        });
        return { response };
      }
    );

    return {
      ok: true,
      status: 200,
      paymentId,
      tenantId,
      sessionId: deleteResult.resolvedSessionId,
      data: deleteResult.response.data,
      rate: deleteResult.response.rate || null,
    };
  } catch (err) {
    const raw = String(err.message || "");

    // 404 — payment not found
    if (/Xero API error 404/.test(raw)) {
      return { ok: false, code: "NOT_FOUND", status: 404, message: "Payment not found for selected tenant.", sessionId: requestedSessionId };
    }

    // 400 — validation error (includes already-deleted case)
    const match = raw.match(/^Xero API error 400:\s*(.*)$/s);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        const validationMessage =
          parsed?.Elements?.[0]?.ValidationErrors?.[0]?.Message ||
          parsed?.Message ||
          "Validation failed in Xero.";
        const alreadyDeleted = /already been deleted/i.test(validationMessage);
        return {
          ok: false,
          code: alreadyDeleted ? "ALREADY_DELETED" : "VALIDATION_FAILED",
          status: 409,
          message: validationMessage,
          sessionId: requestedSessionId,
          xero: parsed,
        };
      } catch {
        // ignore parse error
      }
    }

    throw err;
  }
}

function buildBulkDeleteStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  const allResults = Array.isArray(job.results) ? job.results : [];
  const countsByStatus = allResults.reduce((acc, item) => {
    const key = item?.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    const elapsed = Date.now() - job.startedAt;
    etaMs = Math.max(0, Math.round((elapsed / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename || "",
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    deleted: job.deleted || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentPaymentId: job.currentPaymentId || "",
    currentRowNumber: job.currentRowNumber || null,
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    countsByStatus,
    results: allResults.slice(-200),
    error: job.error || "",
  };
}

function ownsBulkDeleteJob(job, userData) {
  if (!job || !userData) return false;
  return (
    job.userId === userData.user.id ||
    (job.userEmail && job.userEmail === userData.user.email)
  );
}

async function processBulkDeleteJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(MAX_CONCURRENT_BULK_DELETE, job.rows.length));

  const runRow = async (row) => {
    job.currentRowNumber = row.rowNumber;
    job.currentPaymentId = row.paymentId || "";
    job.updatedAt = Date.now();

    if (!row.paymentId) {
      job.results.push({ rowNumber: row.rowNumber, paymentId: "", ok: false, code: "NO_PAYMENT_ID", status: "no_id", message: "No payment ID found in this row." });
      job.processed += 1;
      job.skipped += 1;
      job.updatedAt = Date.now();
      return;
    }

    try {
      const outcome = await deletePaymentInXero({ tenantId: job.tenantId, paymentId: row.paymentId, requestedSessionId: job.sessionId || null });
      job.sessionId = outcome.sessionId || job.sessionId;
      const statusMap = { NOT_FOUND: "not_found", ALREADY_DELETED: "already_deleted", VALIDATION_FAILED: "validation_failed" };
      job.results.push({
        rowNumber: row.rowNumber,
        paymentId: row.paymentId,
        ok: outcome.ok,
        code: outcome.code || null,
        status: outcome.ok ? "deleted" : statusMap[outcome.code] || "skipped",
        message: outcome.ok ? "Deleted successfully." : outcome.message,
      });
      if (outcome.ok) { job.deleted += 1; } else { job.skipped += 1; }
    } catch (err) {
      job.results.push({ rowNumber: row.rowNumber, paymentId: row.paymentId, ok: false, status: "error", message: err.message });
      job.errors += 1;
    }

    job.processed += 1;
    job.updatedAt = Date.now();
  };

  const worker = async () => {
    while (nextIndex < job.rows.length) {
      const idx = nextIndex++;
      await runRow(job.rows[idx]);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  job.currentPaymentId = "";
  job.currentRowNumber = null;
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  job.status = "completed";
}

async function extractInvoiceCreditTargetsFromUpload({ filename, contentBase64 }) {
  const buffer = Buffer.from(contentBase64, "base64");
  const ext = path.extname(String(filename || "")).toLowerCase();
  let rows = [];

  if (ext === ".csv" || ext === ".txt") {
    rows = parseSimpleDelimited(buffer.toString("utf-8"));
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      throw new Error("Sheet is empty.");
    }
    worksheet.eachRow((row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((value) => (value == null ? "" : String(value).trim())));
    });
  }

  if (!rows.length) {
    throw new Error("No rows found in uploaded sheet.");
  }

  const headers = rows[0].map((header) => normalizeHeaderName(header));
  const idCandidates = ["id", "invoiceid", "creditnoteid", "invoice_id", "creditnote_id", "documentid", "transactionid", "txnid"];
  const numberCandidates = ["number", "invoicenumber", "creditnotenumber", "invoice_number", "creditnote_number", "documentnumber", "reference", "tranid", "transno", "transactionno", "tranno", "invoiceno", "billno"];

  let idIndex = -1;
  for (const name of idCandidates) {
    idIndex = headers.findIndex((h) => h === name);
    if (idIndex !== -1) break;
  }
  let numberIndex = -1;
  for (const name of numberCandidates) {
    numberIndex = headers.findIndex((h) => h === name);
    if (numberIndex !== -1) break;
  }

  console.log(`[BulkDelete] Sheet headers (normalized): ${JSON.stringify(headers)}`);
  console.log(`[BulkDelete] idIndex=${idIndex} (matched: ${idIndex>=0?headers[idIndex]:"none"}), numberIndex=${numberIndex} (matched: ${numberIndex>=0?headers[numberIndex]:"none"})`);

  if (idIndex === -1 && numberIndex === -1) {
    throw new Error(`Column "ID" or "Number" not found in sheet. Use the template — one column for ID, one for Number, fill in either per row.`);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const extractedRows = rows
    .slice(1)
    .map((row, index) => {
      let idValue = idIndex !== -1 ? String(row[idIndex] || "").trim() : "";
      let numberValue = numberIndex !== -1 ? String(row[numberIndex] || "").trim() : "";
      if (idValue && !UUID_RE.test(idValue)) {
        console.log(`[BulkDelete] Row ${index+2}: idValue "${idValue}" is not UUID → moving to numberValue`);
        if (!numberValue) numberValue = idValue;
        idValue = "";
      }
      return { rowNumber: index + 2, idValue, numberValue };
    });
  console.log(`[BulkDelete] Sample rows: ${JSON.stringify(extractedRows.slice(0,3))}`);

  return extractedRows;
}

// Process rows in chunks so each chunk's lookups + action can be done as ONE
// Xero API call each, instead of one call per row.
//
// NOTE: a where=A=="x"||A=="y"||... OR-chain looks like it should work but
// Xero rejects it for high-volume orgs with a HighVolumeException ("not
// filtering efficiently") — confirmed via a live test. Xero's own bulk
// convenience params (IDs=, InvoiceNumbers=, CreditNoteNumbers=) are the
// endorsed efficient way to fetch a specific set of records, so we use those.
const VOID_BATCH_SIZE = 20;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const VOID_BULK_PARAM_NAMES = {
  Invoices: { InvoiceID: "IDs", InvoiceNumber: "InvoiceNumbers" },
  CreditNotes: { CreditNoteID: "IDs", CreditNoteNumber: "CreditNoteNumbers" },
};

async function batchFetchDocsByField({ accessToken, tenantId, endpoint, fieldName, values, feature }) {
  if (!values.length) return [];
  const paramName = VOID_BULK_PARAM_NAMES[endpoint][fieldName];
  // Use individual encodeURIComponent per value, join with literal comma — Xero requires literal commas as separator
  const url = `https://api.xero.com/api.xro/2.0/${endpoint}?${paramName}=${values.map(v => encodeURIComponent(v)).join(",")}`;
  console.log(`[Xero Lookup] ${endpoint} by ${fieldName}: ${values.join(", ")} → ${url}`);
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
    },
    feature,
  });
  return endpoint === "Invoices" ? (res.data?.Invoices || []) : (res.data?.CreditNotes || []);
}

// Resolves a whole chunk of rows (by ID or by Number) in at most 4 Xero calls
// total (Invoices-by-ID, CreditNotes-by-ID, Invoices-by-Number, CreditNotes-by-Number)
// instead of up to 2 calls PER ROW.
async function resolveDocsForChunk({ accessToken, tenantId, chunkRows }) {
  const resolved = new Map(); // rowNumber -> { kind, record } | null

  const idRows = chunkRows.filter((r) => r.idValue);
  const numberRows = chunkRows.filter((r) => !r.idValue && r.numberValue);

  if (idRows.length) {
    const ids = idRows.map((r) => r.idValue);
    const invoices = await batchFetchDocsByField({ accessToken, tenantId, endpoint: "Invoices", fieldName: "InvoiceID", values: ids, feature: "Void/Delete - Lookup" });
    const invoiceById = new Map(invoices.map((inv) => [String(inv.InvoiceID || "").toLowerCase(), inv]));
    const missingIds = ids.filter((id) => !invoiceById.has(String(id).toLowerCase()));
    let creditNoteById = new Map();
    if (missingIds.length) {
      try {
        const creditNotes = await batchFetchDocsByField({ accessToken, tenantId, endpoint: "CreditNotes", fieldName: "CreditNoteID", values: missingIds, feature: "Void/Delete - Lookup" });
        creditNoteById = new Map(creditNotes.map((cn) => [String(cn.CreditNoteID || "").toLowerCase(), cn]));
      } catch (err) {
        console.warn(`[Xero CreditNote Lookup] Failed for IDs ${missingIds.join(",")} — skipping: ${err.message}`);
      }
    }
    idRows.forEach((r) => {
      const key = String(r.idValue).toLowerCase();
      if (invoiceById.has(key)) resolved.set(r.rowNumber, { kind: "invoice", record: invoiceById.get(key) });
      else if (creditNoteById.has(key)) resolved.set(r.rowNumber, { kind: "creditnote", record: creditNoteById.get(key) });
      else resolved.set(r.rowNumber, null);
    });
  }

  if (numberRows.length) {
    const numbers = numberRows.map((r) => r.numberValue);
    const invoices = await batchFetchDocsByField({ accessToken, tenantId, endpoint: "Invoices", fieldName: "InvoiceNumber", values: numbers, feature: "Void/Delete - Lookup" });
    const invoiceByNumber = new Map(invoices.map((inv) => [String(inv.InvoiceNumber || "").toLowerCase(), inv]));
    const missingNumbers = numbers.filter((n) => !invoiceByNumber.has(String(n).toLowerCase()));
    const creditNoteByNumber = new Map();
    if (missingNumbers.length) {
      try {
        const creditNotes = await batchFetchDocsByField({ accessToken, tenantId, endpoint: "CreditNotes", fieldName: "CreditNoteNumber", values: missingNumbers, feature: "Void/Delete - Lookup" });
        creditNotes.forEach((cn) => {
          if (cn.CreditNoteNumber) creditNoteByNumber.set(String(cn.CreditNoteNumber).toLowerCase(), cn);
        });
      } catch (err) {
        console.warn(`[Xero CreditNote Lookup] Batch failed (${err.message}), falling back to individual lookups`);
        for (const num of missingNumbers) {
          try {
            const cnRes = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/CreditNotes?CreditNoteNumber=${encodeURIComponent(num)}`, {
              method: "GET",
              headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
              feature: "Void/Delete - Lookup",
            });
            const cn = cnRes.data?.CreditNotes?.[0];
            if (cn) creditNoteByNumber.set(String(cn.CreditNoteNumber || "").toLowerCase(), cn);
          } catch (e) {
            console.warn(`[Xero CreditNote Lookup] Failed for ${num}: ${e.message}`);
          }
        }
      }
    }
    numberRows.forEach((r) => {
      const key = String(r.numberValue).toLowerCase();
      if (invoiceByNumber.has(key)) resolved.set(r.rowNumber, { kind: "invoice", record: invoiceByNumber.get(key) });
      else if (creditNoteByNumber.has(key)) resolved.set(r.rowNumber, { kind: "creditnote", record: creditNoteByNumber.get(key) });
      else resolved.set(r.rowNumber, null);
    });
  }

  return resolved;
}

// Pure decision logic — no API calls. Decides DELETED vs VOIDED vs a skip reason.
function decideVoidAction({ kind, record, allowedTypes, oppositeLabel }) {
  const type = record.Type || "";
  if (!allowedTypes.includes(type)) {
    return {
      code: "WRONG_DOC_TYPE",
      message: `This is a ${oppositeLabel} (Type: ${type}), not handled by this delete. Use the ${oppositeLabel} delete feature instead.`,
    };
  }
  const status = record.Status || "";
  if (status === "VOIDED" || status === "DELETED") {
    return { code: status === "VOIDED" ? "ALREADY_VOIDED" : "ALREADY_DELETED", message: `Already ${status}.` };
  }
  const amountPaidOrCredited =
    kind === "invoice"
      ? Number(record.AmountPaid || record.AmountCredited || 0)
      : Number((record.Allocations || []).reduce((sum, a) => sum + Number(a.Amount || 0), 0));
  if (amountPaidOrCredited > 0) {
    return {
      code: "HAS_PAYMENTS",
      message: `Cannot void — this ${kind === "invoice" ? "invoice/bill" : "credit note"} has payments or allocations applied. Remove those first in Xero.`,
    };
  }
  const newStatus = (status === "DRAFT" || status === "SUBMITTED") ? "DELETED" : "VOIDED";
  const id = kind === "invoice" ? record.InvoiceID : record.CreditNoteID;
  return { code: "ACTIONABLE", newStatus, id };
}

// Submits up to VOID_BATCH_SIZE Status changes (same kind + same newStatus) in ONE
// Xero API call, same batched-array pattern already used by the import features.
async function submitVoidActionBatch({ accessToken, tenantId, kind, newStatus, ids }) {
  const endpoint = kind === "invoice" ? "Invoices" : "CreditNotes";
  const idField = kind === "invoice" ? "InvoiceID" : "CreditNoteID";
  const payloads = ids.map((id) => ({ [idField]: id, Status: newStatus }));
  const idempotencyKey = crypto.randomBytes(16).toString("hex");
  const res = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/${endpoint}?summarizeErrors=false`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "xero-tenant-id": tenantId,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ [endpoint]: payloads }),
    feature: "Void/Delete - Action",
  });
  const items = endpoint === "Invoices" ? (res.data?.Invoices || []) : (res.data?.CreditNotes || []);
  const byId = new Map();
  items.forEach((item) => {
    const id = kind === "invoice" ? item.InvoiceID : item.CreditNoteID;
    if (id) byId.set(String(id).toLowerCase(), item);
  });
  return byId;
}

function buildBulkVoidStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  const allResults = Array.isArray(job.results) ? job.results : [];
  const countsByStatus = allResults.reduce((acc, item) => {
    const key = item?.status || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    const elapsed = Date.now() - job.startedAt;
    etaMs = Math.max(0, Math.round((elapsed / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename || "",
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    voided: job.voided || 0,
    deleted: job.deleted || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    countsByStatus,
    results: allResults.slice(-200),
    error: job.error || "",
  };
}

async function processBulkVoidJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  const usableRows = [];
  job.rows.forEach((row) => {
    if (!row.idValue && !row.numberValue) {
      job.results.push({ rowNumber: row.rowNumber, idValue: "", numberValue: "", ok: false, code: "NO_ID_OR_NUMBER", status: "no_id", message: "No ID or Number found in this row." });
      job.processed += 1;
      job.skipped += 1;
    } else {
      usableRows.push(row);
    }
  });
  job.updatedAt = Date.now();

  const chunks = chunkArray(usableRows, VOID_BATCH_SIZE);

  for (const chunkRows of chunks) {
    if (job.cancelRequested) {
      chunkRows.forEach((row) => {
        job.results.push({ rowNumber: row.rowNumber, idValue: row.idValue, numberValue: row.numberValue, ok: false, status: "cancelled", message: "Cancelled by user before this row was checked." });
        job.skipped += 1;
        job.processed += 1;
      });
      continue;
    }

    job.currentRowNumber = chunkRows[0]?.rowNumber || null;
    job.updatedAt = Date.now();

    try {
      // 1) Resolve every row in this chunk to an Invoice/CreditNote record — at most
      //    4 Xero calls for the whole chunk (not one lookup call per row).
      const lookupResult = await runWithCandidateSessions(job.sessionId, ({ accessToken }) =>
        resolveDocsForChunk({ accessToken, tenantId: job.tenantId, chunkRows }).then((resolved) => ({ resolved }))
      );
      if (lookupResult.resolvedSessionId) job.sessionId = lookupResult.resolvedSessionId;
      const resolved = lookupResult.resolved;

      // 2) Decide DELETED/VOIDED/skip per row — pure JS, zero API calls.
      const decisions = new Map();
      chunkRows.forEach((row) => {
        const found = resolved.get(row.rowNumber);
        if (!found) {
          decisions.set(row.rowNumber, { code: "NOT_FOUND", message: "No invoice, bill or credit note found for this ID/Number." });
          return;
        }
        const decision = decideVoidAction({ kind: found.kind, record: found.record, allowedTypes: job.allowedTypes, oppositeLabel: job.oppositeLabel });
        decisions.set(row.rowNumber, { ...decision, kind: found.kind });
      });

      // 3) Group actionable rows by (kind + newStatus) so each group is ONE batched POST.
      const actionGroups = new Map();
      decisions.forEach((decision, rowNumber) => {
        if (decision.code !== "ACTIONABLE") return;
        const key = `${decision.kind}|${decision.newStatus}`;
        if (!actionGroups.has(key)) actionGroups.set(key, { kind: decision.kind, newStatus: decision.newStatus, ids: [] });
        actionGroups.get(key).ids.push(decision.id);
      });

      const actionResultsByKey = new Map();
      if (actionGroups.size) {
        const actionResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const perGroup = [];
          for (const group of actionGroups.values()) {
            const byId = await submitVoidActionBatch({ accessToken, tenantId: job.tenantId, kind: group.kind, newStatus: group.newStatus, ids: group.ids });
            perGroup.push({ kind: group.kind, byId });
          }
          return { perGroup };
        });
        if (actionResult.resolvedSessionId) job.sessionId = actionResult.resolvedSessionId;
        actionResult.perGroup.forEach(({ kind, byId }) => {
          byId.forEach((item, idKey) => actionResultsByKey.set(`${kind}|${idKey}`, item));
        });
      }

      // 4) Record a result per original row.
      const statusMap = {
        NOT_FOUND: "not_found",
        WRONG_DOC_TYPE: "wrong_doc_type",
        ALREADY_VOIDED: "already_voided",
        ALREADY_DELETED: "already_deleted",
        HAS_PAYMENTS: "has_payments",
      };
      chunkRows.forEach((row) => {
        const decision = decisions.get(row.rowNumber);
        if (decision.code === "ACTIONABLE") {
          const xeroItem = actionResultsByKey.get(`${decision.kind}|${String(decision.id).toLowerCase()}`);
          const errors = Array.isArray(xeroItem?.ValidationErrors) ? xeroItem.ValidationErrors : [];
          if (!xeroItem || xeroItem.StatusAttributeString === "ERROR" || errors.length) {
            const msg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this change.";
            job.results.push({ rowNumber: row.rowNumber, idValue: row.idValue, numberValue: row.numberValue, ok: false, status: "error", message: msg });
            job.errors += 1;
          } else {
            job.results.push({
              rowNumber: row.rowNumber,
              idValue: row.idValue,
              numberValue: row.numberValue,
              ok: true,
              code: null,
              status: decision.newStatus === "DELETED" ? "deleted" : "voided",
              message: `${decision.newStatus === "DELETED" ? "Deleted" : "Voided"} successfully (${decision.kind}).`,
            });
            if (decision.newStatus === "DELETED") job.deleted += 1; else job.voided += 1;
          }
        } else {
          job.results.push({
            rowNumber: row.rowNumber,
            idValue: row.idValue,
            numberValue: row.numberValue,
            ok: false,
            code: decision.code,
            status: statusMap[decision.code] || "skipped",
            message: decision.message,
          });
          job.skipped += 1;
        }
        job.processed += 1;
      });
    } catch (err) {
      chunkRows.forEach((row) => {
        job.results.push({ rowNumber: row.rowNumber, idValue: row.idValue, numberValue: row.numberValue, ok: false, status: "error", message: err.message });
        job.errors += 1;
        job.processed += 1;
      });
    }

    job.updatedAt = Date.now();
    await delay(50);
  }

  job.currentRowNumber = null;
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

// ─── Generic Delete Centre — Quote / PO / Spend&Receive / BankTransfer / Contact ──────

async function extractSimpleIdentifiersFromUpload({ filename, contentBase64, headerAliases }) {
  const buffer = Buffer.from(contentBase64, "base64");
  const ext = path.extname(String(filename || "")).toLowerCase();
  let rows = [];
  if (ext === ".csv" || ext === ".txt") {
    rows = parseSimpleDelimited(buffer.toString("utf-8"));
  } else {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.worksheets[0];
    if (!worksheet) throw new Error("Sheet is empty.");
    worksheet.eachRow(row => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map(v => (v == null ? "" : String(v).trim())));
    });
  }
  if (!rows.length) throw new Error("No rows found in uploaded sheet.");
  const headers = rows[0].map(h => normalizeHeaderName(h));
  let colIdx = -1, isId = false;
  for (const alias of headerAliases) {
    const idx = headers.findIndex(h => h === normalizeHeaderName(alias.header));
    if (idx >= 0) { colIdx = idx; isId = !!alias.isId; break; }
  }
  if (colIdx < 0) throw new Error(`Required column not found. Expected one of: ${headerAliases.map(a=>a.header).join(", ")}.`);
  return rows.slice(1).map((row, i) => ({
    rowNumber: i + 2,
    identifier: String(row[colIdx] || "").trim(),
    isId,
  })).filter(r => r.identifier);
}

function buildSimpleDeleteStatus(job) {
  const total = job.total || 0, processed = job.processed || 0;
  const remaining = Math.max(0, total - processed);
  const allResults = Array.isArray(job.results) ? job.results : [];
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt)
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  return {
    jobId: job.id, filename: job.filename || "", tenantId: job.tenantId,
    status: job.status, total, processed, remaining,
    deleted: job.deleted || 0, skipped: job.skipped || 0, errors: job.errors || 0,
    etaMs, createdAt: job.createdAt, startedAt: job.startedAt,
    updatedAt: job.updatedAt, finishedAt: job.finishedAt,
    results: allResults.slice(-200), error: job.error || "",
  };
}

function ownsSimpleDeleteJob(job, userData) {
  if (!job || !userData) return false;
  return job.userId === userData.user.id || (job.userEmail && job.userEmail === userData.user.email);
}

function makeSimpleDeleteRouteHandlers(jobStore, processFn) {
  const start = async (req, res) => {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session." });
    const tenantId = String(req.header("x-tenant-id") || req.body?.tenantId || "").trim();
    const { filename, contentBase64, headerAliases, sessionId } = req.body || {};
    if (!tenantId || !contentBase64 || !filename) return res.status(400).json({ error: "tenantId, filename and contentBase64 required." });
    let rows;
    try {
      rows = await extractSimpleIdentifiersFromUpload({ filename, contentBase64, headerAliases: headerAliases || [] });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!rows.length) return res.status(400).json({ error: "No data rows found in file." });
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id, userEmail: userData.user.email,
      tenantId, sessionId: sessionId || latestSession?.sessionId || null, filename,
      rows, total: rows.length, processed: 0, deleted: 0, skipped: 0, errors: 0,
      results: [], status: "pending", error: "",
      createdAt: Date.now(), startedAt: null, updatedAt: Date.now(), finishedAt: null,
      cancelRequested: false,
    };
    jobStore.set(job.id, job);
    processFn(job).catch(err => { job.status = "failed"; job.error = err.message; job.finishedAt = Date.now(); job.updatedAt = Date.now(); });
    return res.json({ jobId: job.id, ...buildSimpleDeleteStatus(job) });
  };
  const status = (req, res) => {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session." });
    const job = jobStore.get(req.query.jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });
    if (!ownsSimpleDeleteJob(job, userData)) return res.status(403).json({ error: "Access denied." });
    return res.json(buildSimpleDeleteStatus(job));
  };
  const cancel = (req, res) => {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session." });
    const job = jobStore.get(req.body?.jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });
    if (!ownsSimpleDeleteJob(job, userData)) return res.status(403).json({ error: "Access denied." });
    job.cancelRequested = true;
    return res.json({ ok: true });
  };
  const results = (req, res) => {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session." });
    const job = jobStore.get(req.query.jobId);
    if (!job) return res.status(404).json({ error: "Job not found." });
    if (!ownsSimpleDeleteJob(job, userData)) return res.status(403).json({ error: "Access denied." });
    const lines = ["Row,Identifier,Status,Message"];
    (job.results || []).forEach(r => {
      lines.push([r.rowNumber, csvEscape(r.identifier), r.status, csvEscape(r.message)].map(csvEscape).join(","));
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="delete_results_${Date.now()}.csv"`);
    return res.send(lines.join("\r\n"));
  };
  return { start, status, cancel, results };
}

// ── Quote Delete ─────────────────────────────────────────────────────────────
async function processQuoteDeleteJob(job) {
  job.status = "running"; job.startedAt = Date.now(); job.updatedAt = Date.now();
  const resolvedMap = new Map();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, job.rows.length) }, async () => {
    while (idx < job.rows.length) {
      const row = job.rows[idx++];
      if (!row.identifier) continue;
      try {
        const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const w = encodeURIComponent(`QuoteNumber=="${row.identifier}"`);
          const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Quotes?where=${w}`, {
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
            feature: "Quote Delete - Lookup",
          });
          return { data: r.data };
        });
        if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
        const exact = (lr.data?.Quotes || []).find(q => String(q.QuoteNumber || "").toLowerCase() === String(row.identifier).toLowerCase());
        if (exact) resolvedMap.set(String(row.identifier).toLowerCase(), { id: exact.QuoteID, status: exact.Status });
      } catch (e) { /* not found */ }
    }
  }));
  const toDelete = [];
  job.rows.forEach(row => {
    if (!row.identifier) {
      job.results.push({ rowNumber: row.rowNumber, identifier: "", status: "skipped", message: "No Quote Number in this row." });
      job.skipped++; job.processed++; return;
    }
    const found = resolvedMap.get(String(row.identifier).toLowerCase());
    if (!found) {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "not_found", message: `Quote "${row.identifier}" not found in Xero.` });
      job.skipped++; job.processed++; return;
    }
    if (found.status === "DELETED") {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "already_deleted", message: `Quote "${row.identifier}" is already deleted.` });
      job.skipped++; job.processed++; return;
    }
    toDelete.push({ rowNumber: row.rowNumber, identifier: row.identifier, id: found.id });
  });
  job.updatedAt = Date.now();
  for (const chunk of chunkArray(toDelete, 50)) {
    if (job.cancelRequested) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "cancelled", message: "Cancelled." }); job.skipped++; job.processed++; });
      continue;
    }
    try {
      const dr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Quotes?summarizeErrors=false`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
          body: JSON.stringify({ Quotes: chunk.map(r => ({ QuoteID: r.id, Status: "DELETED" })) }),
          feature: "Quote Delete - Action",
        });
        return { data: r.data };
      });
      if (dr.resolvedSessionId) job.sessionId = dr.resolvedSessionId;
      const byId = new Map((dr.data?.Quotes || []).map(q => [String(q.QuoteID || "").toLowerCase(), q]));
      chunk.forEach(r => {
        const q = byId.get(String(r.id).toLowerCase());
        const errs = (q?.ValidationErrors || []).map(e => e.Message).filter(Boolean);
        if (!q || q.StatusAttributeString === "ERROR" || errs.length) {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: errs.join("; ") || "Xero rejected this delete." });
          job.errors++;
        } else {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "deleted", message: "Deleted successfully." });
          job.deleted++;
        }
        job.processed++;
      });
    } catch (err) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: err.message }); job.errors++; job.processed++; });
    }
    job.updatedAt = Date.now(); await delay(100);
  }
  job.finishedAt = Date.now(); job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

// ── Purchase Order Delete ──────────────────────────────────────────────────
async function processPODeleteJob(job) {
  job.status = "running"; job.startedAt = Date.now(); job.updatedAt = Date.now();
  const allNums = job.rows.map(r => r.identifier).filter(Boolean);
  const resolvedMap = new Map();
  for (const chunk of chunkArray(allNums, 100)) {
    try {
      const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/PurchaseOrders?PurchaseOrderNumbers=${encodeURIComponent(chunk.join(","))}`, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
          feature: "PO Delete - Lookup",
        });
        return { data: r.data };
      });
      if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
      (lr.data?.PurchaseOrders || []).forEach(po => {
        if (po.PurchaseOrderNumber) resolvedMap.set(String(po.PurchaseOrderNumber).toLowerCase(), { id: po.PurchaseOrderID, status: po.Status });
      });
    } catch (e) { /* continue */ }
    job.updatedAt = Date.now(); await delay(50);
  }
  const toDelete = [];
  job.rows.forEach(row => {
    if (!row.identifier) {
      job.results.push({ rowNumber: row.rowNumber, identifier: "", status: "skipped", message: "No PO Number in this row." });
      job.skipped++; job.processed++; return;
    }
    const found = resolvedMap.get(String(row.identifier).toLowerCase());
    if (!found) {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "not_found", message: `PO "${row.identifier}" not found in Xero.` });
      job.skipped++; job.processed++; return;
    }
    if (found.status === "DELETED") {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "already_deleted", message: `PO "${row.identifier}" is already deleted.` });
      job.skipped++; job.processed++; return;
    }
    if (!["DRAFT", "SUBMITTED"].includes(found.status)) {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "skipped", message: `PO "${row.identifier}" is ${found.status} — only DRAFT and SUBMITTED POs can be deleted. Use Bulk Status Update to change it to DRAFT first.` });
      job.skipped++; job.processed++; return;
    }
    toDelete.push({ rowNumber: row.rowNumber, identifier: row.identifier, id: found.id });
  });
  job.updatedAt = Date.now();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, toDelete.length) }, async () => {
    while (idx < toDelete.length) {
      const r = toDelete[idx++];
      if (job.cancelRequested) {
        job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "cancelled", message: "Cancelled." }); job.skipped++; job.processed++; continue;
      }
      try {
        const dr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/PurchaseOrders/${encodeURIComponent(r.id)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
            body: JSON.stringify({ PurchaseOrderID: r.id, Status: "DELETED" }),
            feature: "PO Delete - Action",
          });
          return { data: res.data };
        });
        if (dr.resolvedSessionId) job.sessionId = dr.resolvedSessionId;
        const po = (dr.data?.PurchaseOrders || [])[0];
        const errs = (po?.ValidationErrors || []).map(e => e.Message).filter(Boolean);
        if (!po || po.StatusAttributeString === "ERROR" || errs.length) {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: errs.join("; ") || "Xero rejected this delete." });
          job.errors++;
        } else {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "deleted", message: "Deleted successfully." });
          job.deleted++;
        }
      } catch (err) {
        job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: err.message }); job.errors++;
      }
      job.processed++; job.updatedAt = Date.now(); await delay(50);
    }
  }));
  job.finishedAt = Date.now(); job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

// ── Spend / Receive Money Delete ──────────────────────────────────────────
async function processSpendReceiveDeleteJob(job) {
  job.status = "running"; job.startedAt = Date.now(); job.updatedAt = Date.now();
  const allRefs = job.rows.map(r => r.identifier).filter(Boolean);
  const resolvedMap = new Map();
  for (const chunk of chunkArray(allRefs, 100)) {
    try {
      const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const refs = chunk.map(ref => encodeURIComponent(ref)).join(",");
        const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/BankTransactions?References=${refs}`, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
          feature: "SpendReceive Delete - Lookup",
        });
        return { data: r.data };
      });
      if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
      (lr.data?.BankTransactions || []).forEach(bt => {
        if (!bt.Reference) return;
        const key = String(bt.Reference).toLowerCase();
        if (!resolvedMap.has(key)) resolvedMap.set(key, []);
        resolvedMap.get(key).push({ id: bt.BankTransactionID, status: bt.Status, type: bt.Type });
      });
    } catch (e) { /* continue */ }
    job.updatedAt = Date.now(); await delay(50);
  }
  const toDelete = [];
  job.rows.forEach(row => {
    if (!row.identifier) {
      job.results.push({ rowNumber: row.rowNumber, identifier: "", status: "skipped", message: "No Reference in this row." });
      job.skipped++; job.processed++; return;
    }
    const all = resolvedMap.get(String(row.identifier).toLowerCase()) || [];
    const deletable = all.filter(bt => ["SPEND", "RECEIVE"].includes(bt.type) && bt.status !== "DELETED");
    if (!deletable.length) {
      const alreadyDel = all.some(bt => bt.status === "DELETED");
      const nonSupport = all.some(bt => !["SPEND", "RECEIVE"].includes(bt.type));
      const msg = alreadyDel ? `Already deleted.` : nonSupport ? `This is an Overpayment or Prepayment — cannot be deleted via API.` : `No Spend/Receive Money transaction found with Reference "${row.identifier}".`;
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: alreadyDel ? "already_deleted" : "not_found", message: msg });
      job.skipped++; job.processed++; return;
    }
    deletable.forEach(bt => toDelete.push({ rowNumber: row.rowNumber, identifier: row.identifier, id: bt.id, type: bt.type }));
  });
  job.updatedAt = Date.now();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, toDelete.length) }, async () => {
    while (idx < toDelete.length) {
      const r = toDelete[idx++];
      if (job.cancelRequested) {
        job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "cancelled", message: "Cancelled." }); job.skipped++; job.processed++; continue;
      }
      try {
        const dr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/BankTransactions/${encodeURIComponent(r.id)}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
            body: JSON.stringify({ BankTransactionID: r.id, Status: "DELETED" }),
            feature: "SpendReceive Delete - Action",
          });
          return { data: res.data };
        });
        if (dr.resolvedSessionId) job.sessionId = dr.resolvedSessionId;
        const bt = (dr.data?.BankTransactions || [])[0];
        const errs = (bt?.ValidationErrors || []).map(e => e.Message).filter(Boolean);
        if (!bt || bt.StatusAttributeString === "ERROR" || errs.length) {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: errs.join("; ") || "Xero rejected this delete." });
          job.errors++;
        } else {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "deleted", message: `${r.type} transaction deleted successfully.` });
          job.deleted++;
        }
      } catch (err) {
        job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: err.message }); job.errors++;
      }
      job.processed++; job.updatedAt = Date.now(); await delay(50);
    }
  }));
  job.finishedAt = Date.now(); job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

// ── Bank Transfer Delete ──────────────────────────────────────────────────
async function processBankTransferDeleteJob(job) {
  job.status = "running"; job.startedAt = Date.now(); job.updatedAt = Date.now();
  const resolvedMap = new Map();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, job.rows.length) }, async () => {
    while (idx < job.rows.length) {
      const row = job.rows[idx++];
      if (!row.identifier) continue;
      try {
        const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const w = encodeURIComponent(`Reference=="${row.identifier}"`);
          const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/BankTransfers?where=${w}`, {
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
            feature: "BankTransfer Delete - Lookup",
          });
          return { data: r.data };
        });
        if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
        const active = (lr.data?.BankTransfers || []).find(t =>
          t.Status !== "DELETED" && String(t.Reference || "").toLowerCase() === String(row.identifier).toLowerCase()
        );
        if (active) resolvedMap.set(String(row.identifier).toLowerCase(), { id: active.BankTransferID, fromReconciled: active.FromIsReconciled === "true" || active.FromIsReconciled === true, toReconciled: active.ToIsReconciled === "true" || active.ToIsReconciled === true });
      } catch (e) { /* not found */ }
    }
  }));
  const toDelete = [];
  job.rows.forEach(row => {
    if (!row.identifier) {
      job.results.push({ rowNumber: row.rowNumber, identifier: "", status: "skipped", message: "No Reference in this row." });
      job.skipped++; job.processed++; return;
    }
    const found = resolvedMap.get(String(row.identifier).toLowerCase());
    if (!found) {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "not_found", message: `Bank Transfer with Reference "${row.identifier}" not found in Xero.` });
      job.skipped++; job.processed++; return;
    }
    toDelete.push({ rowNumber: row.rowNumber, identifier: row.identifier, id: found.id, isReconciled: found.fromReconciled || found.toReconciled });
  });
  job.updatedAt = Date.now();
  for (const chunk of chunkArray(toDelete, 50)) {
    if (job.cancelRequested) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "cancelled", message: "Cancelled." }); job.skipped++; job.processed++; });
      continue;
    }
    try {
      const dr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/BankTransfers`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
          body: JSON.stringify({ BankTransfers: chunk.map(r => ({ BankTransferID: r.id, Status: "DELETED" })) }),
          feature: "BankTransfer Delete - Action",
        });
        return { data: r.data };
      });
      if (dr.resolvedSessionId) job.sessionId = dr.resolvedSessionId;
      const byId = new Map((dr.data?.BankTransfers || []).map(t => [String(t.BankTransferID || "").toLowerCase(), t]));
      chunk.forEach(r => {
        const t = byId.get(String(r.id).toLowerCase());
        const errs = (t?.ValidationErrors || []).map(e => e.Message).filter(Boolean);
        if (!t || t.StatusAttributeString === "ERROR" || errs.length) {
          const msg = errs.join("; ") || (r.isReconciled ? "This bank transfer is reconciled — unreconcile it in Xero first, then delete." : "Xero rejected this delete.");
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: msg });
          job.errors++;
        } else {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "deleted", message: "Bank Transfer deleted successfully." });
          job.deleted++;
        }
        job.processed++;
      });
    } catch (err) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: err.message }); job.errors++; job.processed++; });
    }
    job.updatedAt = Date.now(); await delay(100);
  }
  job.finishedAt = Date.now(); job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

// ── Contact Archive ───────────────────────────────────────────────────────
async function processContactArchiveJob(job) {
  job.status = "running"; job.startedAt = Date.now(); job.updatedAt = Date.now();
  const resolvedMap = new Map();
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(3, job.rows.length) }, async () => {
    while (idx < job.rows.length) {
      const row = job.rows[idx++];
      if (!row.identifier) continue;
      try {
        const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          let url;
          if (row.isId) {
            url = `https://api.xero.com/api.xro/2.0/Contacts/${encodeURIComponent(row.identifier)}?summaryOnly=true`;
          } else {
            url = `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${row.identifier.replace(/"/g, '\\"')}"`)}&summaryOnly=true`;
          }
          const r = await fetchWithRetry(url, {
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
            feature: "Contact Archive - Lookup",
          });
          return { data: r.data };
        });
        if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
        const contacts = lr.data?.Contacts || [];
        const exact = contacts.find(c => row.isId
          ? String(c.ContactID || "").toLowerCase() === String(row.identifier).toLowerCase()
          : String(c.Name || "").toLowerCase() === String(row.identifier).toLowerCase()
        );
        if (exact) resolvedMap.set(String(row.identifier).toLowerCase(), { id: exact.ContactID, status: exact.ContactStatus, name: exact.Name });
      } catch (e) { /* not found */ }
    }
  }));
  const toArchive = [];
  job.rows.forEach(row => {
    if (!row.identifier) {
      job.results.push({ rowNumber: row.rowNumber, identifier: "", status: "skipped", message: "No Contact Name/ID in this row." });
      job.skipped++; job.processed++; return;
    }
    const found = resolvedMap.get(String(row.identifier).toLowerCase());
    if (!found) {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "not_found", message: `Contact "${row.identifier}" not found in Xero.` });
      job.skipped++; job.processed++; return;
    }
    if (found.status === "ARCHIVED") {
      job.results.push({ rowNumber: row.rowNumber, identifier: row.identifier, status: "already_archived", message: `Contact "${found.name}" is already archived.` });
      job.skipped++; job.processed++; return;
    }
    toArchive.push({ rowNumber: row.rowNumber, identifier: row.identifier, id: found.id, name: found.name });
  });
  job.updatedAt = Date.now();
  for (const chunk of chunkArray(toArchive, 50)) {
    if (job.cancelRequested) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "cancelled", message: "Cancelled." }); job.skipped++; job.processed++; });
      continue;
    }
    try {
      const dr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const r = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
          body: JSON.stringify({ Contacts: chunk.map(r => ({ ContactID: r.id, ContactStatus: "ARCHIVED" })) }),
          feature: "Contact Archive - Action",
        });
        return { data: r.data };
      });
      if (dr.resolvedSessionId) job.sessionId = dr.resolvedSessionId;
      const byId = new Map((dr.data?.Contacts || []).map(c => [String(c.ContactID || "").toLowerCase(), c]));
      chunk.forEach(r => {
        const c = byId.get(String(r.id).toLowerCase());
        const errs = (c?.ValidationErrors || []).map(e => e.Message).filter(Boolean);
        if (!c || c.StatusAttributeString === "ERROR" || errs.length) {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: errs.join("; ") || "Xero rejected this archive." });
          job.errors++;
        } else {
          job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "archived", message: `Contact "${r.name}" archived successfully.` });
          job.deleted++;
        }
        job.processed++;
      });
    } catch (err) {
      chunk.forEach(r => { job.results.push({ rowNumber: r.rowNumber, identifier: r.identifier, status: "error", message: err.message }); job.errors++; job.processed++; });
    }
    job.updatedAt = Date.now(); await delay(100);
  }
  job.finishedAt = Date.now(); job.updatedAt = Date.now();
  job.status = job.cancelRequested ? "cancelled" : "completed";
}

app.post("/api/user/signup", (req, res) => {
  try {
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: "Too many requests. Please wait 15 minutes before trying again." });
    }
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const normalized = String(email).trim().toLowerCase();
    if (userStore.has(normalized)) {
      return res.status(409).json({ error: "User already exists" });
    }
    if (userStore.size >= settingsStore.maxUsers) {
      return res.status(403).json({
        error: "User limit reached. Please contact admin to increase limit.",
      });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    const user = {
      id: crypto.randomBytes(12).toString("hex"),
      email: normalized,
      hash,
      salt,
      createdAt: Date.now(),
      disabled: false,
      plan: "starter",
      role: "importer",
      permissions: ["import"],
      note: "",
    };
    userStore.set(normalized, user);
    saveUsers();
    const token = createUserSession(user);
    return res.json({
      token,
      user: { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email), role: user.role || "importer", permissions: isAdminEmail(user.email) ? ["import","export","delete","allocation"] : (user.permissions || ["import"]) },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/user/login", (req, res) => {
  try {
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    if (!checkLoginRateLimit(clientIp)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes before trying again." });
    }
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const normalized = String(email).trim().toLowerCase();
    const user = userStore.get(normalized);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    if (user.disabled) {
      return res.status(403).json({ error: "User is disabled. Contact admin." });
    }
    const hash = hashPassword(password, user.salt);
    if (hash !== user.hash) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    resetLoginRateLimit(clientIp);
    user.lastLoginAt = Date.now();
    if (!user.loginHistory) user.loginHistory = [];
    user.loginHistory.unshift({ at: Date.now(), ip: req.ip || "" });
    if (user.loginHistory.length > 20) user.loginHistory = user.loginHistory.slice(0, 20);
    userStore.set(normalized, user);
    saveUsers();
    const token = createUserSession(user);
    res.cookie("userToken", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 24 * 60 * 60 * 1000 });
    return res.json({
      token,
      user: { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email), role: isAdminEmail(user.email) ? "admin" : (user.role || "importer"), permissions: isAdminEmail(user.email) ? ["import","export","delete","allocation"] : (user.permissions || ["import"]), planStatus: user.planStatus || "active", plan: user.plan || "none", planStartAt: user.planStartAt || null, planExpiry: user.planExpiry || null, testingRowsUsed: user.testingRowsUsed || 0, pendingApprovalNotification: user.pendingApprovalNotification || false },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/user/me", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  return res.json({
    token,
    user: {
      id: userData.user.id,
      email: userData.user.email,
      isAdmin: isAdminEmail(userData.user.email),
      role: isAdminEmail(userData.user.email) ? "admin" : (userData.user.role || "importer"),
      permissions: isAdminEmail(userData.user.email) ? ["import","export","delete","allocation"] : (userData.user.permissions || ["import"]),
      planStatus: userData.user.planStatus || "active",
      plan: userData.user.plan || "none",
      planStartAt: userData.user.planStartAt || null,
      planExpiry: userData.user.planExpiry || null,
      testingRowsUsed: userData.user.testingRowsUsed || 0,
      pendingApprovalNotification: userData.user.pendingApprovalNotification || false,
    },
  });
});

app.get("/api/user/plan-info", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const limits = getUserPlanLimits(userData.user);
  return res.json({
    plan: userData.user.plan || "starter",
    hasCustomLimits: !!(userData.user.customLimits && Object.keys(userData.user.customLimits).length > 0),
    limits,
  });
});

app.get("/api/user/billing", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const user = userData.user;
  const userHistory = importHistoryStore.filter(h => h.userId === user.id);
  return res.json({
    plan: user.plan || "none",
    planStatus: user.planStatus || "active",
    planStartAt: user.planStartAt || null,
    planExpiry: user.planExpiry || null,
    lastPaymentId: user.lastPaymentId || null,
    lastOrderId: user.lastOrderId || null,
    planPaidAt: user.planPaidAt || null,
    customLimits: user.customLimits || null,
    importCount: userHistory.length,
    totalImported: userHistory.reduce((sum, h) => sum + (h.created || 0), 0),
    createdAt: user.createdAt || null,
  });
});

app.post("/api/user/change-password", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both current and new password are required." });
  if (newPassword.length < 8) return res.status(400).json({ error: "New password must be at least 8 characters." });
  const user = userData.user;
  if (hashPassword(currentPassword, user.salt) !== user.hash) return res.status(401).json({ error: "Current password is incorrect." });
  const salt = crypto.randomBytes(16).toString("hex");
  user.salt = salt;
  user.hash = hashPassword(newPassword, salt);
  userStore.set(user.email, user);
  saveUsers();
  return res.json({ ok: true });
});

app.post("/api/user/logout", async (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  // Auto-revoke all Xero sessions for this user on logout
  if (userData) {
    const userId = userData.user.id;
    for (const [sid, sess] of sessionStore.entries()) {
      if (sess.userId !== userId) continue;
      try {
        const accessToken = await getAccessToken(sess);
        const connectionsResp = await fetch("https://api.xero.com/connections", {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (connectionsResp.ok) {
          const connections = await connectionsResp.json();
          await Promise.all(connections.map(c =>
            fetch(`https://api.xero.com/connections/${c.id}`, {
              method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
            }).catch(() => {})
          ));
        }
      } catch (_) {}
      if (sess.refresh_token) {
        const clientId = sess.clientId || CLIENT_ID;
        try {
          await fetch("https://identity.xero.com/connect/revocation", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: sess.refresh_token, client_id: clientId }),
          });
        } catch (_) {}
      }
      sessionStore.delete(sid);
      if (latestSession?.sessionId === sid) latestSession = null;
    }
    saveSessions();
    console.log(`[Logout] Revoked Xero sessions for user ${userData.user.email}`);
  }
  if (token && userSessionStore.has(token)) {
    userSessionStore.delete(token);
    saveUserSessions();
  }
  res.clearCookie("userToken", { sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  return res.json({ ok: true });
});

app.post("/api/admin/login", (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }
    const normalized = String(email).trim().toLowerCase();
    if (!isAdminEmail(normalized)) {
      return res.status(401).json({ error: "Invalid admin credentials" });
    }
    if (!settingsStore.adminPasswordHash || !settingsStore.adminPasswordSalt) {
      const salt = crypto.randomBytes(16).toString("hex");
      const hash = hashPassword(password, salt);
      settingsStore.adminPasswordSalt = salt;
      settingsStore.adminPasswordHash = hash;
      saveSettings();
    } else {
      const hash = hashPassword(password, settingsStore.adminPasswordSalt);
      if (hash !== settingsStore.adminPasswordHash) {
        return res.status(401).json({ error: "Invalid admin credentials" });
      }
    }
    const token = createAdminSession(normalized);
    return res.json({ token, admin: { email: normalized } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/admin/me", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  return res.json({ admin: { email: adminSession.email } });
});

app.post("/api/admin/logout", (req, res) => {
  const token = req.header("x-admin-token");
  if (token && adminSessionStore.has(token)) {
    adminSessionStore.delete(token);
    saveAdminSessions();
  }
  return res.json({ ok: true });
});

app.get("/api/admin/settings", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  return res.json({
    maxUsers: settingsStore.maxUsers,
    currentUsers: userStore.size,
    allowedTypes: settingsStore.allowedTypes || [],
    deniedTypes: settingsStore.deniedTypes || [],
  });
});

app.post("/api/admin/settings", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  const { maxUsers, allowedTypes, deniedTypes } = req.body || {};
  const parsed = Number.parseInt(maxUsers, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 10000) {
    return res.status(400).json({ error: "Invalid maxUsers value" });
  }
  if (allowedTypes && !Array.isArray(allowedTypes)) {
    return res.status(400).json({ error: "allowedTypes must be an array" });
  }
  if (deniedTypes && !Array.isArray(deniedTypes)) {
    return res.status(400).json({ error: "deniedTypes must be an array" });
  }
  settingsStore.maxUsers = parsed;
  const allTypes = new Set(Object.keys(typeConfigs));
  if (Array.isArray(allowedTypes)) {
    settingsStore.allowedTypes = allowedTypes.filter((type) => allTypes.has(type));
    settingsStore.deniedTypes = [];
  }
  saveSettings();
  return res.json({
    maxUsers: settingsStore.maxUsers,
    currentUsers: userStore.size,
    allowedTypes: settingsStore.allowedTypes || [],
    deniedTypes: settingsStore.deniedTypes || [],
  });
});

app.get("/api/admin/types", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  return res.json({ types: Object.keys(typeConfigs) });
});

app.get("/api/admin/users", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  const users = Array.from(userStore.values()).map((user) => {
    const userHistory = importHistoryStore.filter((h) => h.userId === user.id);
    return {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt || null,
      disabled: Boolean(user.disabled),
      plan: user.plan || "starter",
      role: isAdminEmail(user.email) ? "admin" : (user.role || "importer"),
      permissions: isAdminEmail(user.email) ? ["import","export","delete","allocation"] : (user.permissions || ["import"]),
      customLimits: user.customLimits || null,
      note: user.note || "",
      lastLoginAt: user.lastLoginAt || null,
      planStatus: user.planStatus || "active",
      planPaidAt: user.planPaidAt || null,
      planStartAt: user.planStartAt || null,
      planExpiry: user.planExpiry || null,
      testingRowsUsed: user.testingRowsUsed || 0,
      importCount: userHistory.length,
      totalImported: userHistory.reduce((sum, h) => sum + (h.created || 0), 0),
    };
  });
  return res.json({ users });
});

app.post("/api/admin/users/:id/toggle", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }
  const { id } = req.params;
  const { disabled } = req.body || {};
  const target = Array.from(userStore.values()).find((user) => user.id === id);
  if (!target) {
    return res.status(404).json({ error: "User not found" });
  }
  target.disabled = Boolean(disabled);
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, disabled ? "disable-user" : "enable-user", target.email, "");
  return res.json({
    id: target.id,
    email: target.email,
    disabled: target.disabled,
  });
});

app.post("/api/admin/users/:id/set-plan", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { plan, durationDays } = req.body || {};
  const VALID_PLANS = ["starter", "professional", "enterprise", "growth"];
  if (!VALID_PLANS.includes(plan)) return res.status(400).json({ error: "Invalid plan." });
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const days = parseInt(durationDays, 10) || 30;
  const now = new Date();
  const expiry = new Date(now.getTime() + days * 86400000);
  target.plan = plan;
  target.planStatus = "active";
  target.planStartAt = now.toISOString();
  target.planExpiry = expiry.toISOString();
  target.customLimits = null;
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "set-plan", target.email, `${plan} for ${days} days, expires ${expiry.toISOString().slice(0,10)}`);
  return res.json({ id: target.id, email: target.email, plan: target.plan, planStartAt: target.planStartAt, planExpiry: target.planExpiry });
});

app.post("/api/admin/users/:id/renew-plan", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { days } = req.body || {};
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const renewDays = parseInt(days, 10) || 30;
  const baseDate = (target.planExpiry && new Date(target.planExpiry) > new Date()) ? new Date(target.planExpiry) : new Date();
  const newExpiry = new Date(baseDate.getTime() + renewDays * 86400000);
  target.planExpiry = newExpiry.toISOString();
  target.planStatus = "active";
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "renew-plan", target.email, `+${renewDays} days, new expiry ${newExpiry.toISOString().slice(0,10)}`);
  sendPlanRenewedEmail(target.email, target.plan, renewDays, newExpiry.toISOString().slice(0,10)).catch(() => {});
  return res.json({ ok: true, plan: target.plan, planExpiry: target.planExpiry });
});

app.post("/api/admin/users/:id/cancel-plan", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const oldPlan = target.plan;
  target.plan = "none";
  target.planStatus = "cancelled";
  target.planExpiry = null;
  target.planStartAt = null;
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "cancel-plan", target.email, `was ${oldPlan}`);
  sendPlanCancelledEmail(target.email, oldPlan).catch(() => {});
  return res.json({ ok: true, plan: "none", planStatus: "cancelled" });
});

app.post("/api/admin/users/:id/set-custom-limits", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { customLimits } = req.body || {};
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (customLimits === null || customLimits === undefined) {
    target.customLimits = null;
  } else {
    const cl = {};
    if (typeof customLimits.maxRowsPerImport === "number" && customLimits.maxRowsPerImport > 0) cl.maxRowsPerImport = Math.floor(customLimits.maxRowsPerImport);
    if (customLimits.maxOrgs === null) cl.maxOrgs = null;
    else if (typeof customLimits.maxOrgs === "number" && customLimits.maxOrgs > 0) cl.maxOrgs = Math.floor(customLimits.maxOrgs);
    if (Array.isArray(customLimits.allowedImportTypes)) cl.allowedImportTypes = customLimits.allowedImportTypes.filter((t) => typeof t === "string");
    const boolFields = ["exportAccess", "deleteAccess", "autoAllocationAccess", "manualJournalsAccess", "paymentImportAccess", "overpaymentAccess", "purchaseOrdersAccess", "quotesAccess"];
    for (const f of boolFields) {
      if (typeof customLimits[f] === "boolean") cl[f] = customLimits[f];
    }
    target.customLimits = Object.keys(cl).length > 0 ? cl : null;
  }
  userStore.set(target.email, target);
  saveUsers();
  return res.json({ ok: true, customLimits: target.customLimits });
});

app.post("/api/admin/users/:id/reset-password", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(newPassword, salt);
  target.salt = salt;
  target.hash = hash;
  userStore.set(target.email, target);
  saveUsers();
  for (const [sessionToken, session] of userSessionStore.entries()) {
    if (session.userId === id) userSessionStore.delete(sessionToken);
  }
  saveUserSessions();
  recordAuditLog(adminSession.email, "reset-password", target.email, "Sessions invalidated");
  return res.json({ ok: true });
});

app.post("/api/admin/users/:id/set-note", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { note } = req.body || {};
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  target.note = String(note || "").slice(0, 500);
  userStore.set(target.email, target);
  saveUsers();
  return res.json({ ok: true });
});

app.post("/api/admin/users/:id/set-role", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { role } = req.body || {};
  const validRoles = ["admin", "importer", "viewer"];
  if (!validRoles.includes(role)) return res.status(400).json({ error: "Invalid role. Must be admin, importer, or viewer." });
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  target.role = role;
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "set-role", target.email, `role=${role}`);
  return res.json({ ok: true, role });
});

app.post("/api/admin/users/:id/set-permissions", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { permissions } = req.body || {};
  const validPerms = ["import", "export", "delete", "allocation"];
  if (!Array.isArray(permissions) || permissions.some(p => !validPerms.includes(p)))
    return res.status(400).json({ error: "Invalid permissions. Valid: import, export, delete, allocation." });
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (isAdminEmail(target.email)) return res.status(400).json({ error: "Cannot change admin permissions." });
  target.permissions = permissions;
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "set-permissions", target.email, `permissions=${permissions.join(",")}`);
  return res.json({ ok: true, permissions });
});

app.post("/api/admin/users/:id/set-team", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { remove } = req.body || {};
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  if (remove) {
    target.plan = "testing";
    target.role = "importer";
    target.planStatus = "pending";
  } else {
    target.plan = "team";
    target.role = "team";
    target.planStatus = "active";
    if (!target.permissions || target.permissions.length === 0) target.permissions = ["import"];
  }
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, remove ? "remove-team" : "set-team", target.email, `plan=${target.plan} role=${target.role}`);
  return res.json({ ok: true, plan: target.plan, role: target.role, planStatus: target.planStatus });
});

app.post("/api/admin/users/:id/approve-testing", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const { plan, durationDays } = req.body || {};
  target.planStatus = "active";
  target.pendingApprovalNotification = true;
  if (plan) {
    const VALID_PLANS = ["starter", "professional", "enterprise", "growth", "testing"];
    if (VALID_PLANS.includes(plan)) target.plan = plan;
    const days = parseInt(durationDays, 10) || 30;
    const now = new Date();
    target.planStartAt = now.toISOString();
    target.planExpiry = new Date(now.getTime() + days * 86400000).toISOString();
    target.customLimits = null;
  }
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "approve-plan", target.email, `plan=${target.plan} planStatus=active durationDays=${durationDays||"default"}`);
  sendPlanApprovedEmail(target.email, target.plan || "testing").catch(() => {});
  return res.json({ ok: true, email: target.email, plan: target.plan, planExpiry: target.planExpiry || null });
});

app.delete("/api/admin/users/:id", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  for (const [sessionToken, session] of userSessionStore.entries()) {
    if (session.userId === id) userSessionStore.delete(sessionToken);
  }
  const deletedEmail = target.email;
  userStore.delete(target.email);
  saveUsers();
  saveUserSessions();
  recordAuditLog(adminSession.email, "delete-user", deletedEmail, "");
  return res.json({ ok: true });
});

// ── Per-user Xero Client ID ──────────────────────────────────────────────────
app.post("/api/admin/users/:id/set-xero-client", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const { xeroClientId } = req.body || {};
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  target.xeroClientId = xeroClientId ? String(xeroClientId).trim() : null;
  userStore.set(target.email, target);
  saveUsers();
  recordAuditLog(adminSession.email, "set-xero-client", target.email, xeroClientId ? `ClientID: ${String(xeroClientId).trim().slice(0,8)}...` : "Cleared");
  return res.json({ ok: true, xeroClientId: target.xeroClientId });
});

// ── Login history ────────────────────────────────────────────────────────────
app.get("/api/admin/users/:id/login-history", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  return res.json({ loginHistory: target.loginHistory || [] });
});

// ── Xero connections (sessions) per user + revoke ────────────────────────────
app.get("/api/admin/users/:id/xero-connections", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  const connections = [];
  for (const [sid, sess] of sessionStore.entries()) {
    if (sess.userId === id) {
      connections.push({
        sessionId: sid,
        expiresAt: sess.expires_at || null,
        connectedAt: sess.connectedAt || null,
        tenantsUpdatedAt: sess.tenantsUpdatedAt || null,
        tenants: Array.isArray(sess.tenants) ? sess.tenants : [],
        clientId: sess.clientId || null,
      });
    }
  }
  return res.json({ connections });
});

app.delete("/api/admin/users/:id/revoke-xero", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { id } = req.params;
  const target = Array.from(userStore.values()).find((u) => u.id === id);
  if (!target) return res.status(404).json({ error: "User not found" });
  let count = 0;
  for (const [sid, sess] of sessionStore.entries()) {
    if (sess.userId === id) { sessionStore.delete(sid); count++; }
  }
  saveSessions();
  recordAuditLog(adminSession.email, "revoke-xero", target.email, `Revoked ${count} Xero session(s)`);
  return res.json({ ok: true, revoked: count });
});

// ── Global Xero sessions view (all users) ───────────────────────────────────
app.get("/api/admin/xero-all-sessions", (req, res) => {
  const token = req.header("x-admin-token");
  if (!getAdminFromToken(token)) return res.status(401).json({ error: "Invalid admin session" });
  const result = [];
  for (const [sid, sess] of sessionStore.entries()) {
    const user = sess.userId ? Array.from(userStore.values()).find(u => u.id === sess.userId) : null;
    result.push({
      sessionId: sid,
      userEmail: user?.email || "unknown",
      clientId: sess.clientId || null,
      connectedAt: sess.connectedAt || null,
      expiresAt: sess.expires_at || null,
      dayExhausted: sess.dayExhausted || false,
      tenants: Array.isArray(sess.tenants) ? sess.tenants.map(t => ({ id: t.tenantId, name: t.tenantName || t.orgName })) : [],
    });
  }
  result.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
  return res.json({ ok: true, sessions: result });
});

app.post("/api/admin/xero-all-sessions/:sessionId/disconnect", async (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { sessionId } = req.params;
  const sess = sessionStore.get(sessionId);
  if (!sess) return res.status(404).json({ error: "Session not found" });
  // Step 1: DELETE connections from Xero (frees uncertified app slot)
  try {
    const accessToken = await getAccessToken(sess);
    const connectionsResp = await fetch("https://api.xero.com/connections", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (connectionsResp.ok) {
      const connections = await connectionsResp.json();
      await Promise.all(connections.map(c =>
        fetch(`https://api.xero.com/connections/${c.id}`, {
          method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` },
        }).catch(() => {})
      ));
      console.log(`[Admin Disconnect] Deleted ${connections.length} Xero connection(s) for session ${sessionId.slice(0,8)}...`);
    }
  } catch (err) {
    console.log(`[Admin Disconnect] Token refresh/connection delete failed: ${err.message}`);
  }
  // Step 2: Revoke refresh token
  if (sess.refresh_token) {
    const clientId = sess.clientId || CLIENT_ID;
    try {
      await fetch("https://identity.xero.com/connect/revocation", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: sess.refresh_token, client_id: clientId }),
      });
    } catch (_) {}
  }
  sessionStore.delete(sessionId);
  if (latestSession?.sessionId === sessionId) latestSession = null;
  saveSessions();
  const user = sess.userId ? Array.from(userStore.values()).find(u => u.id === sess.userId) : null;
  recordAuditLog(adminSession.email, "admin-xero-disconnect", user?.email || "unknown", `Session ${sessionId.slice(0,8)}...`);
  return res.json({ ok: true });
});

// ── Bulk user actions ────────────────────────────────────────────────────────
app.post("/api/admin/users/bulk-action", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { action, userIds } = req.body || {};
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: "userIds required" });
  const VALID_ACTIONS = ["enable", "disable", "delete"];
  if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: "Invalid action" });
  let affected = 0;
  for (const id of userIds) {
    const target = Array.from(userStore.values()).find((u) => u.id === id);
    if (!target) continue;
    if (action === "enable") { target.disabled = false; userStore.set(target.email, target); affected++; }
    else if (action === "disable") { target.disabled = true; userStore.set(target.email, target); affected++; }
    else if (action === "delete") {
      for (const [st, sess] of userSessionStore.entries()) { if (sess.userId === id) userSessionStore.delete(st); }
      userStore.delete(target.email); affected++;
    }
  }
  saveUsers();
  saveUserSessions();
  recordAuditLog(adminSession.email, `bulk-${action}`, "", `${affected} user(s)`);
  return res.json({ ok: true, affected });
});

// ── User list CSV export ─────────────────────────────────────────────────────
app.get("/api/admin/users/export-csv", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const rows = [["Email", "Plan", "Status", "Imports", "Last Login", "Joined", "Note"]];
  for (const user of userStore.values()) {
    const hist = importHistoryStore.filter((h) => h.userId === user.id);
    rows.push([
      user.email,
      user.plan || "starter",
      user.disabled ? "Disabled" : "Active",
      hist.length,
      user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : "",
      user.createdAt ? new Date(user.createdAt).toISOString() : "",
      (user.note || "").replace(/"/g, '""'),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="users_${new Date().toISOString().slice(0,10)}.csv"`);
  return res.send(csv);
});

// ── Live: active user sessions ───────────────────────────────────────────────
app.get("/api/admin/live/sessions", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const usersById = new Map(Array.from(userStore.values()).map((u) => [u.id, u]));
  const sessions = Array.from(userSessionStore.values()).map((s) => {
    const u = usersById.get(s.userId);
    return { sessionId: s.token || "", email: u ? u.email : s.email || "", userId: s.userId, loginAt: s.createdAt || null, plan: u ? (u.plan || "starter") : "" };
  });
  return res.json({ sessions });
});

// ── Live: active import jobs across all stores ───────────────────────────────
app.get("/api/admin/live/jobs", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const usersById = new Map(Array.from(userStore.values()).map((u) => [u.id, u.email]));
  const allStores = [
    billsImportJobStore, invoicesImportJobStore, creditNotesImportJobStore,
    overpaymentImportJobStore, spendMoneyImportJobStore, receiveMoneyImportJobStore,
    billPaymentImportJobStore, invoicePaymentImportJobStore, creditNoteRefundImportJobStore,
    manualJournalImportJobStore, itemsImportJobStore, customersImportJobStore,
    vendorsImportJobStore, accountsImportJobStore, trackingCategoryImportJobStore,
    bankTransferImportJobStore, bulkDeleteJobStore, bulkVoidJobStore,
  ];
  const jobs = [];
  for (const store of allStores) {
    for (const job of store.values()) {
      if (!["running", "queued", "pending"].includes(job.status)) continue;
      jobs.push({
        jobId: job.id, status: job.status, type: job.type || "",
        userEmail: usersById.get(job.userId) || job.userEmail || "",
        tenantName: job.tenantName || "", total: job.total || 0, processed: job.processed || 0,
        errors: job.errors || 0, startedAt: job.startedAt || null,
      });
    }
  }
  return res.json({ jobs });
});

// ── Server health ────────────────────────────────────────────────────────────
const SERVER_START_TIME = Date.now();
app.get("/api/admin/health", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const mem = process.memoryUsage();
  return res.json({
    uptime: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
    uptimeMs: Date.now() - SERVER_START_TIME,
    memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss, external: mem.external },
    node: process.version,
    platform: process.platform,
    totalUsers: userStore.size,
    activeSessions: userSessionStore.size,
    xeroSessions: sessionStore.size,
    importHistoryCount: importHistoryStore.length,
    auditLogCount: auditLogStore.length,
  });
});

// ── Landing page public settings ────────────────────────────────────────────
app.get("/api/landing/settings", (req, res) => {
  return res.json({ landingVideos: settingsStore.landingVideos });
});

app.post("/api/admin/landing/videos", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { video1, video2, video3 } = req.body || {};
  const clean = (v) => String(v || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 20);
  settingsStore.landingVideos = { video1: clean(video1), video2: clean(video2), video3: clean(video3) };
  saveSettings();
  return res.json({ landingVideos: settingsStore.landingVideos });
});

// ── Maintenance mode ─────────────────────────────────────────────────────────
app.get("/api/admin/maintenance", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  return res.json({ maintenanceMode: settingsStore.maintenanceMode, maintenanceBanner: settingsStore.maintenanceBanner });
});

app.post("/api/admin/maintenance", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { maintenanceMode, maintenanceBanner } = req.body || {};
  if (typeof maintenanceMode === "boolean") settingsStore.maintenanceMode = maintenanceMode;
  if (typeof maintenanceBanner === "string") settingsStore.maintenanceBanner = maintenanceBanner.slice(0, 500);
  saveSettings();
  recordAuditLog(adminSession.email, maintenanceMode ? "maintenance-on" : "maintenance-off", "", settingsStore.maintenanceBanner);
  return res.json({ maintenanceMode: settingsStore.maintenanceMode, maintenanceBanner: settingsStore.maintenanceBanner });
});

// ── Broadcast message ────────────────────────────────────────────────────────
app.get("/api/admin/broadcast", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  return res.json({ broadcastMessage: settingsStore.broadcastMessage });
});

app.post("/api/admin/broadcast", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const { broadcastMessage } = req.body || {};
  settingsStore.broadcastMessage = typeof broadcastMessage === "string" ? broadcastMessage.slice(0, 500) : "";
  saveSettings();
  recordAuditLog(adminSession.email, "set-broadcast", "", settingsStore.broadcastMessage ? "Set message" : "Cleared");
  return res.json({ broadcastMessage: settingsStore.broadcastMessage });
});

app.get("/api/user/broadcast", (req, res) => {
  return res.json({ broadcastMessage: settingsStore.broadcastMessage || "" });
});

// ── All Xero sessions for logged-in user ──────────────────────────────────────
app.get("/api/user/sessions", async (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const userId = userData.user.id;
  const now = Date.now();

  // Collect all sessions for this user
  const rawSessions = [];
  for (const [sid, sess] of sessionStore.entries()) {
    if (sess.userId === userId) {
      rawSessions.push({ sessionId: sid, sess });
    }
  }

  // For sessions with no cached tenants, fetch from Xero now (in parallel)
  // Skip sessions connected more than 60 days ago (Xero refresh tokens expire in 60 days)
  const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
  await Promise.all(
    rawSessions
      .filter(({ sess }) => !sess.tenants || sess.tenants.length === 0)
      .filter(({ sess }) => (sess.connectedAt || sess.expires_at || 0) > now - sixtyDaysMs)
      .map(async ({ sess }) => {
        try {
          const accessToken = await getAccessToken(sess); // auto-refreshes if needed
          const resp = await fetch("https://api.xero.com/connections", {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          });
          if (resp.ok) {
            const tenants = await resp.json();
            sess.tenants = tenants.map(t => ({
              tenantId: t.tenantId,
              tenantName: t.tenantName,
              orgName: t.tenantName,
            }));
            sess.tenantsUpdatedAt = Date.now();
          }
        } catch (_) {}
      })
  );
  saveSessions();

  const sessions = rawSessions.map(({ sessionId: sid, sess }) => ({
    sessionId: sid,
    connectedAt: sess.connectedAt || null,
    expiresAt: sess.expires_at || null,
    isExpired: (sess.expires_at || 0) < now,
    tenants: (sess.tenants || []).map(t => ({
      tenantId: t.tenantId,
      tenantName: t.tenantName || t.orgName || "Unknown",
    })),
  }));

  sessions.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0));
  return res.json({ sessions });
});

// ── User Dashboard Stats ──────────────────────────────────────────────────────
app.get("/api/user/dashboard", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Not logged in" });

  const userId = userData.user.id;
  const now = Date.now();
  const dayMs = 86400000;

  const userHistory = importHistoryStore.filter(h => h.userId === userId);

  // All-time stats
  const allTimeCount = userHistory.length;
  const allTimeCreated = userHistory.reduce((s, h) => s + (h.created || 0), 0);
  const allTimeErrors = userHistory.reduce((s, h) => s + (h.errors || 0), 0);
  const successCount = userHistory.filter(h => h.status === "completed" && (h.errors || 0) === 0).length;
  const successRate = allTimeCount > 0 ? Math.round(successCount / allTimeCount * 100) : 100;

  // This month
  const thisMonthStart = new Date(); thisMonthStart.setDate(1); thisMonthStart.setHours(0,0,0,0);
  const monthHistory = userHistory.filter(h => (h.date||0) >= thisMonthStart.getTime());
  const thisMonthCount = monthHistory.length;
  const thisMonthCreated = monthHistory.reduce((s, h) => s + (h.created || 0), 0);

  // Last 30 days trend
  const trend30 = [];
  for (let i = 29; i >= 0; i--) {
    const ds = new Date(now - i * dayMs); ds.setHours(0,0,0,0);
    const de = ds.getTime() + dayMs;
    const slice = userHistory.filter(h => (h.date||0) >= ds.getTime() && (h.date||0) < de);
    trend30.push({
      date: `${ds.getDate()}/${ds.getMonth()+1}`,
      count: slice.length,
      created: slice.reduce((s, h) => s + (h.created||0), 0),
    });
  }

  // Activity heatmap — 53 weeks × 7 days
  const heatmapDays = 371;
  const heatmapStart = new Date(now - heatmapDays * dayMs); heatmapStart.setHours(0,0,0,0);
  const today = new Date(); today.setHours(23,59,59,999);
  const dayMap = {};
  userHistory.forEach(h => {
    if ((h.date||0) >= heatmapStart.getTime()) {
      const d = new Date(h.date||0);
      const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      dayMap[k] = (dayMap[k] || 0) + 1;
    }
  });
  const weeks = [];
  const startDay = new Date(heatmapStart);
  startDay.setDate(startDay.getDate() - startDay.getDay()); // rewind to Sunday
  for (let w = 0; w < 53; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(startDay.getTime() + (w * 7 + d) * dayMs);
      const k = `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
      week.push({ date: k, count: (day > today || day < heatmapStart) ? -1 : (dayMap[k] || 0) });
    }
    weeks.push(week);
  }

  // Top import types
  const typeMap = {};
  userHistory.forEach(h => { if (h.importType) typeMap[h.importType] = (typeMap[h.importType] || 0) + 1; });
  const topTypes = Object.entries(typeMap).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([type,count])=>({type,count}));

  // Streak (consecutive days with ≥1 import up to today)
  let streak = 0;
  const sd = new Date(); sd.setHours(0,0,0,0);
  for (let i = 0; i < 365; i++) {
    const k = `${sd.getFullYear()}-${String(sd.getMonth()+1).padStart(2,'0')}-${String(sd.getDate()).padStart(2,'0')}`;
    if (dayMap[k]) { streak++; sd.setDate(sd.getDate()-1); } else break;
  }

  // Recent imports
  const recentImports = userHistory.slice(0, 15).map(h => ({
    id: h.id, importType: h.importType || "unknown", orgName: h.orgName || "",
    total: h.total||0, created: h.created||0, errors: h.errors||0, status: h.status||"unknown", date: h.date||0,
  }));

  // Connected Xero sessions for this user
  const connectedSessions = [];
  for (const [sid, sess] of sessionStore.entries()) {
    if (sess.userId === userId) {
      connectedSessions.push({
        sessionId: sid,
        connectedAt: sess.connectedAt || null,
        expiresAt: sess.expires_at || null,
        tenants: (sess.tenants||[]).map(t=>({ tenantId: t.tenantId, name: t.tenantName||t.orgName||"Unknown" })),
        isExpired: (sess.expires_at||0) < now,
      });
    }
  }

  return res.json({
    allTime: { count: allTimeCount, created: allTimeCreated, errors: allTimeErrors, successRate },
    thisMonth: { count: thisMonthCount, created: thisMonthCreated },
    trend30,
    heatmap: weeks,
    topTypes,
    recentImports,
    connectedSessions,
    streak,
    lastImportAt: userHistory.length > 0 ? (userHistory[0].date||null) : null,
    userName: userData.user.email.split("@")[0],
    userEmail: userData.user.email,
    plan: userData.user.plan || "starter",
  });
});

// ── Audit log ────────────────────────────────────────────────────────────────
app.get("/api/admin/audit-log", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "50", 10)));
  const total = auditLogStore.length;
  const items = auditLogStore.slice((page - 1) * limit, page * limit);
  return res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
});

app.get("/api/admin/import-history", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });
  const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
  const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit || "25", 10)));
  const filterUser = String(req.query.user || "").trim().toLowerCase();
  const filterType = String(req.query.type || "").trim();
  let history = importHistoryStore.slice();
  if (filterUser) history = history.filter((h) => (h.userEmail || "").toLowerCase().includes(filterUser));
  if (filterType) history = history.filter((h) => h.importType === filterType);
  const total = history.length;
  const items = history.slice((page - 1) * limit, page * limit);
  return res.json({ items, total, page, limit, pages: Math.ceil(total / limit) });
});

app.post("/api/admin/exports/clear-all", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }

  let removedFiles = 0;
  jobStore.forEach((job) => {
    if (job?.files) {
      Object.values(job.files).forEach((file) => {
        if (file?.path && fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
            removedFiles += 1;
          } catch {
            // ignore delete errors
          }
        }
      });
    }
  });

  jobStore.clear();
  jobQueue.length = 0;
  activeJobs = 0;
  saveJobs();

  if (fs.existsSync(EXPORT_DIR)) {
    try {
      fs.rmSync(EXPORT_DIR, { recursive: true, force: true });
    } catch {
      // ignore delete errors
    }
  }

  return res.json({ ok: true, removedFiles });
});

function buildDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function buildMonthKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

app.get("/api/admin/api-usage", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }

  const today = {
    date: apiUsageStore.date,
    byFeature: apiUsageStore.byFeature,
    total: Object.values(apiUsageStore.byFeature).reduce((a, b) => a + b, 0),
  };
  const history = Object.entries(apiUsageStore.history)
    .map(([date, byFeature]) => ({
      date,
      byFeature,
      total: Object.values(byFeature).reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return res.json({ today, history, dailyLimit: 5000 });
});

app.get("/api/admin/auto-allocation/jobs", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) return res.status(401).json({ error: "Invalid admin session" });

  const usersById = new Map(Array.from(userStore.values()).map(u => [u.id, u.email]));
  const allJobs = [
    ...Array.from(autoAllocationJobStore.values()).map(j => ({ ...j, jobType: "allocation" })),
    ...Array.from(fixAllocationDatesJobStore.values()).map(j => ({ ...j, jobType: "fix-dates" })),
  ]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, 100)
    .map(j => ({
      jobId: j.id,
      jobType: j.jobType,
      userEmail: usersById.get(j.userId) || "(unknown)",
      tenantId: j.tenantId,
      status: j.status,
      total: j.total || 0,
      processed: j.processed || 0,
      created: j.created || 0,
      errors: j.errors || 0,
      phase: j.phase || "",
      createdAt: j.createdAt || null,
      finishedAt: j.finishedAt || null,
    }));

  return res.json({ ok: true, jobs: allJobs });
});

app.get("/api/admin/analytics", (req, res) => {
  const token = req.header("x-admin-token");
  const adminSession = getAdminFromToken(token);
  if (!adminSession) {
    return res.status(401).json({ error: "Invalid admin session" });
  }

  const rangeDays = clampNumber(req.query.days, 7, 365, 30);
  const tenantFilter = String(req.query.tenant || "").trim().toLowerCase();
  const userFilter = String(req.query.user || "").trim().toLowerCase();
  const now = new Date();
  const bucketStart = new Date(now);
  bucketStart.setHours(0, 0, 0, 0);
  bucketStart.setDate(bucketStart.getDate() - (rangeDays - 1));

  const buckets = [];
  for (let i = 0; i < rangeDays; i += 1) {
    const day = new Date(bucketStart);
    day.setDate(bucketStart.getDate() + i);
    const key = buildDateKey(day);
    buckets.push({ date: key, count: 0 });
  }
  const bucketMap = new Map(buckets.map((item) => [item.date, item]));

  const jobs = Array.from(jobStore.values());
  const users = Array.from(userStore.values());
  const usersById = new Map(users.map((user) => [user.id, user.email]));
  const monthBuckets = new Map();
  const monthTenants = new Map();
  const monthUserCounts = new Map();
  const allTenants = new Set();
  const allUsers = new Set();

  const totals = {
    users: users.length,
    activeUsers: users.filter((user) => !user.disabled).length,
    disabledUsers: users.filter((user) => user.disabled).length,
    exports: jobs.length,
    exportsReady: 0,
    exportsError: 0,
    exportsNoRecords: 0,
    exportsQueued: 0,
    exportsRunning: 0,
  };

  const tenantCounts = new Map();
  const userCounts = new Map();
  const tenantUserCounts = new Map();
  const userStatusCounts = new Map();
  const userTenants = new Map();
  const recentActivity = [];
  const statusCounts = new Map();
  let latestExportAt = null;
  let durationTotal = 0;
  let durationCount = 0;

  jobs.forEach((job) => {
    const status = job.status || "unknown";
    const tenantKey = job.tenantName || job.tenantId || "Unknown tenant";
    const userKey = job.userId || job.userEmail || "unknown";
    const userEmail = usersById.get(userKey) || userKey;
    allTenants.add(tenantKey);
    allUsers.add(userEmail);

    if (tenantFilter) {
      const tenantMatch =
        tenantKey.toLowerCase().includes(tenantFilter) ||
        String(job.tenantId || "").toLowerCase().includes(tenantFilter);
      if (!tenantMatch) return;
    }
    if (userFilter) {
      const userMatch =
        userEmail.toLowerCase().includes(userFilter) ||
        String(job.userId || "").toLowerCase().includes(userFilter);
      if (!userMatch) return;
    }

    statusCounts.set(status, (statusCounts.get(status) || 0) + 1);

    if (status === "ready") totals.exportsReady += 1;
    if (status === "error") totals.exportsError += 1;
    if (status === "no_records") totals.exportsNoRecords += 1;
    if (status === "queued") totals.exportsQueued += 1;
    if (status === "running") totals.exportsRunning += 1;

    if (job.createdAt && (!latestExportAt || job.createdAt > latestExportAt)) {
      latestExportAt = job.createdAt;
    }

    const dateKey = buildDateKey(job.createdAt);
    if (dateKey && bucketMap.has(dateKey)) {
      bucketMap.get(dateKey).count += 1;
    }

    const monthKey = buildMonthKey(job.createdAt);
    if (monthKey) {
      monthBuckets.set(monthKey, (monthBuckets.get(monthKey) || 0) + 1);
      if (!monthTenants.has(monthKey)) {
        monthTenants.set(monthKey, new Set());
      }
      monthTenants.get(monthKey).add(tenantKey);
      if (!monthUserCounts.has(monthKey)) {
        monthUserCounts.set(monthKey, new Map());
      }
      const userBucketForMonth = monthUserCounts.get(monthKey);
      userBucketForMonth.set(userKey, (userBucketForMonth.get(userKey) || 0) + 1);
    }

    tenantCounts.set(tenantKey, (tenantCounts.get(tenantKey) || 0) + 1);
    userCounts.set(userKey, (userCounts.get(userKey) || 0) + 1);
    if (!userStatusCounts.has(userKey)) {
      userStatusCounts.set(userKey, new Map());
    }
    const userStatusBucket = userStatusCounts.get(userKey);
    userStatusBucket.set(status, (userStatusBucket.get(status) || 0) + 1);
    if (!userTenants.has(userKey)) {
      userTenants.set(userKey, new Map());
    }
    const tenantBucket = userTenants.get(userKey);
    tenantBucket.set(tenantKey, (tenantBucket.get(tenantKey) || 0) + 1);
    if (!tenantUserCounts.has(tenantKey)) {
      tenantUserCounts.set(tenantKey, new Map());
    }
    const userBucket = tenantUserCounts.get(tenantKey);
    userBucket.set(userKey, (userBucket.get(userKey) || 0) + 1);
    recentActivity.push({
      jobId: job.id,
      userId: userKey,
      email: userEmail,
      tenant: tenantKey,
      type: job.type || "-",
      status,
      createdAt: job.createdAt || null,
      count: job.count || 0,
    });

    if (status === "ready" && job.startedAt && job.updatedAt) {
      const duration = job.updatedAt - job.startedAt;
      if (Number.isFinite(duration) && duration > 0) {
        durationTotal += duration;
        durationCount += 1;
      }
    }
  });

  const processed = totals.exportsReady + totals.exportsError + totals.exportsNoRecords;
  const successRate = processed
    ? Math.round((totals.exportsReady / processed) * 100)
    : 0;
  const errorRate = processed
    ? Math.round((totals.exportsError / processed) * 100)
    : 0;
  const noRecordsRate = processed
    ? Math.round((totals.exportsNoRecords / processed) * 100)
    : 0;

  const topTenants = Array.from(tenantCounts.entries())
    .map(([tenant, count]) => ({ tenant, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const topUsers = Array.from(userCounts.entries())
    .map(([userId, count]) => ({
      userId,
      count,
      email: usersById.get(userId) || userId,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const monthLabels = [];
  const monthCursor = new Date(bucketStart);
  monthCursor.setDate(1);
  const endMonth = new Date(now);
  endMonth.setDate(1);
  while (monthCursor <= endMonth) {
    monthLabels.push(buildMonthKey(monthCursor));
    monthCursor.setMonth(monthCursor.getMonth() + 1);
  }

  const monthlyTenantCounts = monthLabels.map((month) => ({
    month,
    exportCount: monthBuckets.get(month) || 0,
    tenantCount: monthTenants.get(month) ? monthTenants.get(month).size : 0,
  }));

  const monthlyUserCounts = monthLabels.map((month) => {
    const userBucket = monthUserCounts.get(month) || new Map();
    return {
      month,
      users: topUsers.map((user) => ({
        userId: user.userId,
        email: user.email,
        count: userBucket.get(user.userId) || 0,
      })),
    };
  });

  const userStatusBreakdown = Array.from(userStatusCounts.entries())
    .map(([userId, statuses]) => ({
      userId,
      email: usersById.get(userId) || userId,
      statuses: Object.fromEntries(statuses.entries()),
      total: Object.values(Object.fromEntries(statuses.entries())).reduce(
        (sum, value) => sum + value,
        0
      ),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  const topUserTenants = Array.from(userTenants.entries())
    .map(([userId, tenants]) => ({
      userId,
      email: usersById.get(userId) || userId,
      tenants: Array.from(tenants.entries())
        .map(([tenant, count]) => ({ tenant, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 4),
    }))
    .sort(
      (a, b) =>
        b.tenants.reduce((sum, item) => sum + item.count, 0) -
        a.tenants.reduce((sum, item) => sum + item.count, 0)
    )
    .slice(0, 6);

  const statusBreakdown = [
    { key: "ready", label: "Ready", count: totals.exportsReady },
    { key: "running", label: "Running", count: totals.exportsRunning },
    { key: "queued", label: "Queued", count: totals.exportsQueued },
    { key: "no_records", label: "No records", count: totals.exportsNoRecords },
    { key: "error", label: "Error", count: totals.exportsError },
  ];

  const matrixTenants = topTenants.map((item) => item.tenant);
  const matrixUsers = topUsers.map((item) => ({
    userId: item.userId,
    email: item.email,
  }));
  const tenantUserMatrix = matrixTenants.map((tenant) => {
    const userBucket = tenantUserCounts.get(tenant) || new Map();
    return {
      tenant,
      total: tenantCounts.get(tenant) || 0,
      users: matrixUsers.map((user) => ({
        userId: user.userId,
        email: user.email,
        count: userBucket.get(user.userId) || 0,
      })),
    };
  });

  return res.json({
    rangeDays,
    filters: {
      tenant: tenantFilter || "",
      user: userFilter || "",
    },
    lists: {
      tenants: Array.from(allTenants).sort(),
      users: Array.from(allUsers).sort(),
    },
    totals,
    statusCounts: Object.fromEntries(statusCounts.entries()),
    volumeByDay: buckets,
    topTenants,
    topUsers,
    statusBreakdown,
    tenantUserMatrix,
    userStatusBreakdown,
    topUserTenants,
    monthlyTenantCounts,
    monthlyUserCounts,
    recentActivity: recentActivity
      .filter((item) => item.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12),
    avgDurationMs: durationCount ? Math.round(durationTotal / durationCount) : 0,
    successRate: {
      readyPct: successRate,
      errorPct: errorRate,
      noRecordsPct: noRecordsRate,
    },
    latestExportAt,
  });
});

class DayLimitError extends Error {
  constructor(msg, waitMs) {
    super(msg);
    this.name = "DayLimitError";
    this.code = "DAY_LIMIT";
    this.waitMs = waitMs || 0;
  }
}

async function exchangeToken(code, verifier, clientId) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId || CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function refreshToken(refreshTokenValue, clientId) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId || CLIENT_ID,
    refresh_token: refreshTokenValue,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Token refresh timed out. Reconnect to Xero and try again.");
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }

  return res.json();
}

// Per-session refresh lock: prevents race condition where two concurrent
// requests both try to refresh the same token → "invalid_grant: consumed"
const _refreshLocks = new Map();

async function getAccessToken(session) {
  if (!session.expires_at || Date.now() < session.expires_at - 60000) {
    return session.access_token;
  }

  if (!session.refresh_token) {
    throw new Error("Session expired. Please reconnect.");
  }

  // If a refresh is already in flight for this session, wait for it to finish
  // instead of firing a second refresh with the same (now-consumed) token.
  const lockKey = session.refresh_token;
  if (_refreshLocks.has(lockKey)) {
    await _refreshLocks.get(lockKey);
    return session.access_token;
  }

  const refreshPromise = (async () => {
    const refreshed = await refreshToken(session.refresh_token, session.clientId);
    session.access_token = refreshed.access_token;
    session.refresh_token = refreshed.refresh_token || session.refresh_token;
    session.expires_at = Date.now() + refreshed.expires_in * 1000;
    saveSessions();
  })();

  _refreshLocks.set(lockKey, refreshPromise.catch(() => {}));
  try {
    await refreshPromise;
  } finally {
    _refreshLocks.delete(lockKey);
  }

  return session.access_token;
}

async function forceRefreshSession(session) {
  if (!session.refresh_token) {
    throw new Error("Session expired. Please reconnect.");
  }
  const refreshed = await refreshToken(session.refresh_token, session.clientId);
  session.access_token = refreshed.access_token;
  session.refresh_token = refreshed.refresh_token || session.refresh_token;
  session.expires_at = Date.now() + refreshed.expires_in * 1000;
  saveSessions();
  return session.access_token;
}

function buildWhere(fromDate, toDate, config) {
  const clauses = [];
  if (config.allowDateFilter !== false) {
    if (fromDate) {
      const [fy, fm, fd] = fromDate.split("-");
      clauses.push(`Date >= DateTime(${fy},${fm},${fd})`);
    }
    if (toDate) {
      const [ty, tm, td] = toDate.split("-");
      clauses.push(`Date <= DateTime(${ty},${tm},${td})`);
    }
  }
  if (config.type) {
    clauses.push(`Type=="${config.type}"`);
  }
  if (config.status) {
    clauses.push(`Status=="${config.status}"`);
  }
  if (config.paymentType) {
    clauses.push(`PaymentType=="${config.paymentType}"`);
  }
  if (config.where) {
    clauses.push(config.where);
  }
  return clauses.length ? clauses.join(" && ") : "";
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _globalDayRemaining = null;

// Token-bucket: caps all outbound Xero calls to 50/minute globally.
// Node.js is single-threaded so array ops here are safe against races;
// the while loop re-checks after each await so late-arriving callers
// don't sneak through.
const xeroMinuteThrottle = (() => {
  const MAX = 57;
  const WINDOW = 60_000;
  const ts = [];
  return async function acquireSlot() {
    while (true) {
      const now = Date.now();
      while (ts.length && ts[0] <= now - WINDOW) ts.shift();
      if (ts.length < MAX) { ts.push(now); return; }
      await delay(ts[0] + WINDOW - now + 50);
    }
  };
})();

async function fetchWithRetry(url, options = {}) {
  const { feature, timeoutMs, waitForDailyReset, ...fetchOptions } = options;
  let attempt = 0;
  let timeoutAttempt = 0;
  const MAX_TIMEOUT_RETRIES = 2;
  const REQUEST_TIMEOUT_MS = timeoutMs || 60000;
  recordApiUsage(feature || deriveApiFeatureFromUrl(url, fetchOptions.method));
  while (true) {
    await xeroMinuteThrottle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        if (timeoutAttempt < MAX_TIMEOUT_RETRIES) {
          timeoutAttempt += 1;
          const waitMs = timeoutAttempt * 10000;
          console.log(`[Xero Timeout] Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Retry ${timeoutAttempt}/${MAX_TIMEOUT_RETRIES} in ${waitMs / 1000}s...`);
          await delay(waitMs);
          continue;
        }
        throw new Error(`Xero API request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds (retried ${MAX_TIMEOUT_RETRIES} times). Xero may be slow — please retry later.`);
      }
      throw err;
    }
    clearTimeout(timer);
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const rateProblem = res.headers.get("X-Rate-Limit-Problem") || "unknown";
      if (rateProblem === "day") {
        const resetInSeconds = retryAfter ? Number.parseInt(retryAfter, 10) : null;
        const waitMs = resetInSeconds && resetInSeconds > 0
          ? (resetInSeconds + 120) * 1000
          : (() => { const m = new Date(); m.setUTCHours(24, 0, 5, 0); return Math.max(m.getTime() - Date.now(), 60000); })();
        const waitMin = Math.round(waitMs / 60000);
        _globalDayRemaining = 0;
        console.log(`[Xero Daily Limit] Session limit hit. Throwing DayLimitError (${waitMin} min to reset). Multi-app failover will handle.`);
        throw new DayLimitError(`Xero daily API limit reached. Resets in ~${waitMin} min at midnight UTC.`, waitMs);
      }
      if (attempt < 15) {
        let waitMs = 5000;
        if (retryAfter) {
          const seconds = Number.parseInt(retryAfter, 10);
          if (!Number.isNaN(seconds) && seconds > 0) {
            waitMs = seconds * 1000 + 2000;
          }
        } else {
          waitMs = Math.min(120000, Math.pow(2, attempt) * 2000);
          if (waitMs < 5000) waitMs = 5000;
        }
        console.log(`[Xero 429] Rate limit hit (${rateProblem}). Retry-After: ${retryAfter || "none"}. Waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1})...`);
        _xeroRateLimitInfo.active = true;
        _xeroRateLimitInfo.reason = rateProblem;
        _xeroRateLimitInfo.waitUntil = Date.now() + waitMs;
        await delay(waitMs);
        _xeroRateLimitInfo.active = false;
        attempt += 1;
        continue;
      }
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      if (attempt < 3) {
        const waitMs = [5000, 15000, 30000][attempt];
        console.log(`[Xero ${res.status}] Transient server error. Retry ${attempt + 1}/3 in ${waitMs / 1000}s...`);
        await delay(waitMs);
        attempt += 1;
        continue;
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Xero API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    const dayRemaining = res.headers.get("X-DayLimit-Remaining");
    if (dayRemaining !== null && dayRemaining !== undefined) {
      _globalDayRemaining = parseInt(dayRemaining, 10);
      // Update per-session tracking if session ref passed via options
      if (options._sessionRef) {
        options._sessionRef.dayRemaining = _globalDayRemaining;
        if (_globalDayRemaining > 0 && options._sessionRef.dayExhausted) {
          options._sessionRef.dayExhausted = false;
          options._sessionRef.dayExhaustedAt = null;
        }
      }
    }
    const method = (options.method || "GET").toUpperCase();
    const shortUrl = url.replace("https://api.xero.com/api.xro/2.0", "");
    console.log(`[Xero API] ${method} ${shortUrl} | Day remaining: ${dayRemaining ?? "?"}`);
    return {
      data,
      rate: {
        day: dayRemaining,
        minute: res.headers.get("X-MinLimit-Remaining"),
        appMinute: res.headers.get("X-AppMinLimit-Remaining"),
        problem: res.headers.get("X-Rate-Limit-Problem"),
      },
    };
  }
}

function flattenObject(obj, prefix = "") {
  const out = {};
  Object.entries(obj || {}).forEach(([key, value]) => {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.length && typeof value[0] === "object") {
        out[newKey] = JSON.stringify(value);
      } else {
        out[newKey] = value.join(", ");
      }
    } else if (value && typeof value === "object") {
      Object.assign(out, flattenObject(value, newKey));
    } else {
      out[newKey] = value;
    }
  });
  return out;
}

function normalizeColumns(columns) {
  return (columns || []).map((col) => {
    if (typeof col === "string") {
      return { header: col, key: col };
    }
    const header = col.header || col.key || "";
    const key = col.key || col.header || "";
    return { header, key };
  });
}

function formatXeroDate(rawValue, stringValue) {
  const candidate = stringValue || rawValue;
  if (!candidate) return "";
  const toLocalDate = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    const match = trimmed.match(/^\/Date\((\d+)([+-]\d+)?\)\/$/);
    if (match) {
      const millis = Number(match[1]);
      if (!Number.isNaN(millis)) {
        return toLocalDate(millis);
      }
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      return trimmed.slice(0, 10);
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return toLocalDate(parsed);
    }
    return trimmed;
  }
  const parsed = new Date(candidate);
  if (!Number.isNaN(parsed.getTime())) {
    return toLocalDate(parsed);
  }
  return String(candidate);
}

function expandLineItems(record) {
  const lineItems = record.LineItems || record.LineItem || [];
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return [flattenObject(record)];
  }

  const base = { ...record };
  delete base.LineItems;
  delete base.LineItem;
  const baseFlat = flattenObject(base);

  return lineItems.map((item) => {
    const itemFlat = flattenObject(item, "LineItem");
    return { ...baseFlat, ...itemFlat };
  });
}

function mapTransferRows(records) {
  return records.map((item) => ({
    BankTransferID: item.BankTransferID || "",
    Date: item.DateString || item.Date || "",
    FromBankAccName: item.FromBankAccount?.Name || "",
    ToBankAccName: item.ToBankAccount?.Name || "",
    Amount: item.Amount ?? "",
    CurrencyRate: item.CurrencyRate ?? "",
  }));
}

function getTrackingValues(lineItem) {
  const tracking = Array.isArray(lineItem?.Tracking) ? lineItem.Tracking : [];
  const first = tracking[0] || {};
  const second = tracking[1] || {};
  return {
    TrackingName1: first.Name || "",
    TrackingOption1: first.Option || "",
    TrackingName2: second.Name || "",
    TrackingOption2: second.Option || "",
  };
}

function getTrackingFlat(lineItem) {
  const tracking = Array.isArray(lineItem?.Tracking) ? lineItem.Tracking : [];
  const first = tracking[0] || {};
  return {
    TrackingCategoryID: first.TrackingCategoryID || "",
    TrackingOptionID: first.TrackingOptionID || "",
    TrackingName: first.Name || "",
    TrackingOption: first.Option || "",
  };
}

function mapInvoiceRows(records, { includeInvoiceId }) {
  const rows = [];
  records.forEach((invoice) => {
    const contactName = invoice.Contact?.Name || "";
    const base = {
      ContactName: contactName,
      InvoiceNumber: invoice.InvoiceNumber || "",
      Status: invoice.Status || "",
      LineAmountTypes: invoice.LineAmountTypes || "",
      Reference: invoice.Reference || "",
      InvoiceDate: formatXeroDate(invoice.Date, invoice.DateString),
      DueDate: formatXeroDate(invoice.DueDate, invoice.DueDateString),
      SubTotal: invoice.SubTotal ?? "",
      TotalTax: invoice.TotalTax ?? "",
      Total: invoice.Total ?? "",
      Currency: invoice.CurrencyCode || "",
      CurrencyRate: invoice.CurrencyRate ?? "",
      InvoiceID: includeInvoiceId ? invoice.InvoiceID || "" : undefined,
    };

    const lineItems = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        InventoryItemCode: "",
        Description: "",
        Quantity: "",
        UnitAmount: "",
        Discount: "",
        AccountCode: "",
        TaxType: "",
        TaxAmount: "",
        LineAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        InventoryItemCode: line.ItemCode || "",
        Description: line.Description || "",
        Quantity: line.Quantity ?? "",
        UnitAmount: line.UnitAmount ?? "",
        Discount: line.DiscountRate ?? line.DiscountAmount ?? "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        TaxAmount: line.TaxAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapBillRows(records, { includeInvoiceId }) {
  const rows = [];
  records.forEach((invoice) => {
    const contactName = invoice.Contact?.Name || "";
    const base = {
      ContactName: contactName,
      InvoiceNumber: invoice.InvoiceNumber || "",
      Status: invoice.Status || "",
      LineAmountTypes: invoice.LineAmountTypes || "",
      InvoiceDate: formatXeroDate(invoice.Date, invoice.DateString),
      DueDate: formatXeroDate(invoice.DueDate, invoice.DueDateString),
      SubTotal: invoice.SubTotal ?? "",
      TotalTax: invoice.TotalTax ?? "",
      Total: invoice.Total ?? "",
      Currency: invoice.CurrencyCode || "",
      CurrencyRate: invoice.CurrencyRate ?? "",
      InvoiceID: includeInvoiceId ? invoice.InvoiceID || "" : undefined,
    };

    const lineItems = Array.isArray(invoice.LineItems) ? invoice.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        InventoryItemCode: "",
        Description: "",
        Quantity: "",
        UnitAmount: "",
        AccountCode: "",
        TaxType: "",
        TaxAmount: "",
        LineAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        InventoryItemCode: line.ItemCode || "",
        Description: line.Description || "",
        Quantity: line.Quantity ?? "",
        UnitAmount: line.UnitAmount ?? "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        TaxAmount: line.TaxAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapQuoteRows(records) {
  const rows = [];
  records.forEach((quote) => {
    const contact = quote.Contact || {};
    const base = {
      QuoteID: quote.QuoteID || "",
      QuoteNumber: quote.QuoteNumber || "",
      Contact: "",
      ContactID: contact.ContactID || "",
      ContactName: contact.Name || "",
      FirstName: contact.FirstName || "",
      LastName: contact.LastName || "",
      EmailAddress: contact.EmailAddress || "",
      LineItems: "",
      Date: formatXeroDate(quote.Date, quote.DateString),
      DateString: quote.DateString || "",
      Status: quote.Status || "",
      CurrencyRate: quote.CurrencyRate ?? "",
      CurrencyCode: quote.CurrencyCode || "",
      SubTotal: quote.SubTotal ?? "",
      TotalTax: quote.TotalTax ?? "",
      Total: quote.Total ?? "",
      TotalDiscount: quote.TotalDiscount ?? "",
      BrandingThemeID: quote.BrandingThemeID || "",
      UpdatedDateUTC: quote.UpdatedDateUTC || "",
      LineAmountTypes: quote.LineAmountTypes || "",
      Reference: quote.Reference || "",
      Title: quote.Title || "",
      ExpiryDate: formatXeroDate(quote.ExpiryDate, quote.ExpiryDateString),
      ExpiryDateString: quote.ExpiryDateString || "",
    };

    const lineItems = Array.isArray(quote.LineItems) ? quote.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        LineItemID: "",
        Description: "",
        UnitAmount: "",
        DiscountAmount: "",
        LineAmount: "",
        Quantity: "",
        TaxAmount: "",
        AccountCode: "",
        TaxType: "",
        Tracking: "",
        TrackingCategoryID: "",
        TrackingOptionID: "",
        TrackingName: "",
        TrackingOption: "",
        DiscountRate: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingFlat(line);
      rows.push({
        ...base,
        LineItemID: line.LineItemID || "",
        Description: line.Description || "",
        UnitAmount: line.UnitAmount ?? "",
        DiscountAmount: line.DiscountAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        Quantity: line.Quantity ?? "",
        TaxAmount: line.TaxAmount ?? "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        Tracking: "",
        ...tracking,
        DiscountRate: line.DiscountRate ?? "",
      });
    });
  });
  return rows;
}

function mapPurchaseOrderRows(records) {
  const rows = [];
  records.forEach((order) => {
    const contactName = order.Contact?.Name || "";
    const base = {
      ContactName: contactName,
      PurchaseOrderNumber: order.PurchaseOrderNumber || "",
      Status: order.Status || "",
      OrderDate: order.Date || "",
      DeliveryDate: order.DeliveryDate || "",
      LineAmountTypes: order.LineAmountTypes || "",
      SubTotal: order.SubTotal ?? "",
      TotalTax: order.TotalTax ?? "",
      Total: order.Total ?? "",
      Currency: order.CurrencyCode || "",
      CurrencyRate: order.CurrencyRate ?? "",
      PurchaseOrderID: order.PurchaseOrderID || "",
    };

    const lineItems = Array.isArray(order.LineItems) ? order.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        InventoryItemCode: "",
        Description: "",
        Quantity: "",
        UnitAmount: "",
        Discount: "",
        AccountCode: "",
        TaxType: "",
        TaxAmount: "",
        LineAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        InventoryItemCode: line.ItemCode || "",
        Description: line.Description || "",
        Quantity: line.Quantity ?? "",
        UnitAmount: line.UnitAmount ?? "",
        Discount: line.DiscountRate ?? line.DiscountAmount ?? "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        TaxAmount: line.TaxAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapPrepaymentRows(records) {
  const rows = [];
  records.forEach((prepayment) => {
    const contactName = prepayment.Contact?.Name || "";
    const base = {
      ContactName: contactName,
      PrepaymentID: prepayment.PrepaymentID || "",
      Type: prepayment.Type || "",
      Status: prepayment.Status || "",
      Date: prepayment.Date || "",
      Reference: prepayment.Reference || "",
      LineAmountTypes: prepayment.LineAmountTypes || "",
      SubTotal: prepayment.SubTotal ?? "",
      TotalTax: prepayment.TotalTax ?? "",
      Total: prepayment.Total ?? "",
      Currency: prepayment.CurrencyCode || "",
      CurrencyRate: prepayment.CurrencyRate ?? "",
    };

    const lineItems = Array.isArray(prepayment.LineItems)
      ? prepayment.LineItems
      : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        InventoryItemCode: "",
        Description: "",
        Quantity: "",
        UnitAmount: "",
        AccountCode: "",
        TaxType: "",
        TaxAmount: "",
        LineAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        InventoryItemCode: line.ItemCode || "",
        Description: line.Description || "",
        Quantity: line.Quantity ?? "",
        UnitAmount: line.UnitAmount ?? "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        TaxAmount: line.TaxAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapTrackingCategoryRows(records) {
  const rows = [];
  records.forEach((category) => {
    const options = Array.isArray(category.Options) ? category.Options : [];
    if (!options.length) {
      rows.push({
        TrackingCategoryID: category.TrackingCategoryID || "",
        TrackingCategoryName: category.Name || "",
        Status: category.Status || "",
        TrackingOptionID: "",
        TrackingOptionName: "",
        TrackingOptionStatus: "",
      });
      return;
    }
    options.forEach((option) => {
      rows.push({
        TrackingCategoryID: category.TrackingCategoryID || "",
        TrackingCategoryName: category.Name || "",
        Status: category.Status || "",
        TrackingOptionID: option.TrackingOptionID || "",
        TrackingOptionName: option.Name || "",
        TrackingOptionStatus: option.Status || "",
      });
    });
  });
  return rows;
}

function mapCreditNoteRows(records, { includeReference, includeDiscount, includeId }) {
  const rows = [];
  records.forEach((credit) => {
    const contactName = credit.Contact?.Name || "";
    const base = {
      ContactName: contactName,
      CreditNoteNumber: credit.CreditNoteNumber || "",
      Reference: includeReference ? credit.Reference || "" : undefined,
      CNDate: credit.Date || "",
      Total: credit.Total ?? "",
      SubTotal: credit.SubTotal ?? "",
      TotalTax: credit.TotalTax ?? "",
      Status: credit.Status || "",
      LineAmountTypes: credit.LineAmountTypes || "",
      Currency: credit.CurrencyCode || "",
      CurrencyRate: credit.CurrencyRate ?? "",
      Id: includeId ? credit.CreditNoteID || "" : undefined,
    };

    const lineItems = Array.isArray(credit.LineItems) ? credit.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        InventoryItemCode: "",
        Description: "",
        UnitAmount: "",
        TaxType: "",
        TaxAmount: "",
        LineAmount: "",
        AccountCode: "",
        Quantity: "",
        Discount: includeDiscount ? "" : undefined,
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        InventoryItemCode: line.ItemCode || "",
        Description: line.Description || "",
        UnitAmount: line.UnitAmount ?? "",
        TaxType: line.TaxType || "",
        TaxAmount: line.TaxAmount ?? "",
        LineAmount: line.LineAmount ?? "",
        AccountCode: line.AccountCode || "",
        Quantity: line.Quantity ?? "",
        Discount: includeDiscount ? line.DiscountRate ?? line.DiscountAmount ?? "" : undefined,
        ...tracking,
      });
    });
  });
  return rows;
}

function mapBankTransactionRows(records, { lineAmountTypeLabel }, context = {}) {
  const rows = [];
  records.forEach((txn) => {
    const contactName = txn.Contact?.Name || "";
    const bankAccountCode = resolveBankAccountCode(txn.BankAccount, context);
    const base = {
      Date: formatXeroDate(txn.Date, txn.DateString),
      ContactName: contactName,
      Reference: txn.Reference || "",
      Type: txn.Type || "",
      BankAccountCode: bankAccountCode,
      CurrencyRate: txn.CurrencyRate ?? "",
      [lineAmountTypeLabel]: txn.LineAmountTypes || "",
      BankTransactionID: txn.BankTransactionID || "",
    };

    const lineItems = Array.isArray(txn.LineItems) ? txn.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        LineAmount: "",
        Description: "",
        AccountCode: "",
        TaxType: "",
        InventoryItemCode: "",
        TaxAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        LineAmount: line.LineAmount ?? "",
        Description: line.Description || "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        InventoryItemCode: line.ItemCode || "",
        TaxAmount: line.TaxAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapOverpaymentRows(records, context = {}) {
  const rows = [];
  records.forEach((txn) => {
    const contactName = txn.Contact?.Name || "";
    const bankAccountCode = resolveBankAccountCode(txn.BankAccount, context);
    const base = {
      Date: formatXeroDate(txn.Date, txn.DateString),
      ContactName: contactName,
      Reference: txn.Reference || "",
      Type: txn.Type || "",
      BankAccountCode: bankAccountCode,
      CurrencyRate: txn.CurrencyRate ?? "",
      Currency: txn.CurrencyCode || "",
      Status: txn.Status || "",
      OverpaymentID: txn.OverpaymentID || "",
    };

    const lineItems = Array.isArray(txn.LineItems) ? txn.LineItems : [];
    if (!lineItems.length) {
      rows.push({
        ...base,
        LineAmount: "",
        Description: "",
        AccountCode: "",
        InventoryItemCode: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lineItems.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        LineAmount: line.LineAmount ?? "",
        Description: line.Description || "",
        AccountCode: line.AccountCode || "",
        InventoryItemCode: line.ItemCode || "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapPaymentRows(records, { includeContact, includeInvoiceId }) {
  return records.map((payment) => ({
    Date: formatXeroDate(payment.Date, payment.DateString),
    InvoiceNumber:
      payment.Invoice?.InvoiceNumber ||
      payment.CreditNote?.CreditNoteNumber ||
      "",
    Amount: payment.Amount ?? "",
    AccountCode: payment.Account?.Code || "",
    Reference: payment.Reference || "",
    CurrencyRate: payment.CurrencyRate ?? "",
    ContactName: includeContact ? payment.Contact?.Name || "" : undefined,
    Invoice_ID: includeInvoiceId ? payment.Invoice?.InvoiceID || "" : undefined,
    Bill_ID: includeInvoiceId ? payment.Invoice?.InvoiceID || "" : undefined,
    Payment_ID: payment.PaymentID || "",
  }));
}

function mapOverpaymentRefundRows(records) {
  return records.map((payment) => ({
    Date: formatXeroDate(payment.Date, payment.DateString),
    Amount: payment.Amount ?? "",
    AccountCode: payment.Account?.Code || "",
    Reference: payment.Reference || "",
    CurrencyRate: payment.CurrencyRate ?? "",
    ContactName:
      payment.Contact?.Name ||
      payment.Invoice?.Contact?.Name ||
      payment.Overpayment?.Contact?.Name ||
      "",
    OverpaymentID: payment.Overpayment?.OverpaymentID || "",
    PaymentID: payment.PaymentID || "",
    Status: payment.Status || "",
  }));
}

function mapOverpaymentPaymentRows(records) {
  return records.map((payment) => ({
    Date: formatXeroDate(payment.Date, payment.DateString),
    Amount: payment.Amount ?? "",
    AccountCode: payment.Account?.Code || "",
    Reference: payment.Reference || "",
    CurrencyRate: payment.CurrencyRate ?? "",
    ContactName:
      payment.Contact?.Name ||
      payment.Invoice?.Contact?.Name ||
      payment.Overpayment?.Contact?.Name ||
      "",
  }));
}

function mapManualJournalRows(records) {
  const rows = [];
  records.forEach((journal) => {
    const base = {
      "MJ ID": journal.ManualJournalID || "",
      Narration: journal.Narration || "",
      Date: formatXeroDate(journal.Date, journal.DateString),
      LineAmountType: journal.LineAmountTypes || "",
      Status: journal.Status || "",
      CurrencyRate: journal.CurrencyRate ?? "",
    };

    const lines = Array.isArray(journal.JournalLines)
      ? journal.JournalLines
      : [];
    if (!lines.length) {
      rows.push({
        ...base,
        Description: "",
        AccountCode: "",
        TaxType: "",
        LineAmount: "",
        TrackingName1: "",
        TrackingOption1: "",
        TrackingName2: "",
        TrackingOption2: "",
      });
      return;
    }

    lines.forEach((line) => {
      const tracking = getTrackingValues(line);
      rows.push({
        ...base,
        Description: line.Description || "",
        AccountCode: line.AccountCode || "",
        TaxType: line.TaxType || "",
        LineAmount: line.LineAmount ?? "",
        ...tracking,
      });
    });
  });
  return rows;
}

function mapItemRows(records, meta = {}) {
  const root = meta || {};
  const base = {
    Id: root.Id || root.id || "",
    Status: root.Status || root.status || "",
    ProviderName: root.ProviderName || root.providerName || "",
    DateTimeUTC: root.DateTimeUTC || root.dateTimeUTC || "",
    Items: "",
  };

  return records.map((item) => ({
    ...base,
    ItemID: item.ItemID || "",
    Code: item.Code || "",
    Description: item.Description || "",
    PurchaseDescription: item.PurchaseDescription || "",
    UpdatedDateUTC: item.UpdatedDateUTC || "",
    PurchaseDetails: "",
    PurchaseUnitPrice: item.PurchaseDetails?.UnitPrice ?? "",
    PurchaseAccountCode: item.PurchaseDetails?.AccountCode || "",
    PurchaseTaxType: item.PurchaseDetails?.TaxType || "",
    COGSAccountCode: item.PurchaseDetails?.COGSAccountCode || "",
    SalesDetails: "",
    SalesUnitPrice: item.SalesDetails?.UnitPrice ?? "",
    SalesAccountCode: item.SalesDetails?.AccountCode || "",
    SalesTaxType: item.SalesDetails?.TaxType || "",
    Name: item.Name || "",
    IsTrackedAsInventory: item.IsTrackedAsInventory ?? "",
    IsSold: item.IsSold ?? "",
    IsPurchased: item.IsPurchased ?? "",
    InventoryAssetAccountCode: item.InventoryAssetAccountCode || "",
    TotalCostPool: item.TotalCostPool ?? "",
    QuantityOnHand: item.QuantityOnHand ?? "",
  }));
}

function mapContactRows(records) {
  return records.map((contact) => {
    const addresses = Array.isArray(contact.Addresses) ? contact.Addresses : [];
    const street = addresses.find((a) => a.AddressType === "STREET") || {};
    const pobox = addresses.find((a) => a.AddressType === "POBOX") || {};

    const phones = Array.isArray(contact.Phones) ? contact.Phones : [];
    const ddi = phones.find((p) => p.PhoneType === "DDI") || {};
    const def = phones.find((p) => p.PhoneType === "DEFAULT") || {};
    const fax = phones.find((p) => p.PhoneType === "FAX") || {};
    const mobile = phones.find((p) => p.PhoneType === "MOBILE") || {};

    const paymentTerms = contact.PaymentTerms || {};
    const contactPersons = Array.isArray(contact.ContactPersons)
      ? contact.ContactPersons
      : [];

    const balances = contact.Balances || {};
    const ar = balances.AccountsReceivable || {};
    const ap = balances.AccountsPayable || {};

    const person = (index) => contactPersons[index] || {};

    return {
      ContactName: contact.Name || "",
      AccountNumber: contact.AccountNumber || "",
      EmailAddress: contact.EmailAddress || "",
      FirstName: contact.FirstName || "",
      LastName: contact.LastName || "",
      POAddressType: pobox.AddressType || "",
      POAttentionTo: pobox.AttentionTo || "",
      POAddressLine1: pobox.AddressLine1 || "",
      POAddressLine2: pobox.AddressLine2 || "",
      POAddressLine3: pobox.AddressLine3 || "",
      POAddressLine4: pobox.AddressLine4 || "",
      POCity: pobox.City || "",
      PORegion: pobox.Region || "",
      POPostalCode: pobox.PostalCode || "",
      POCountry: pobox.Country || "",
      SAAddressType: street.AddressType || "",
      SAAttentionTo: street.AttentionTo || "",
      SAAddressLine1: street.AddressLine1 || "",
      SAAddressLine2: street.AddressLine2 || "",
      SAAddressLine3: street.AddressLine3 || "",
      SAAddressLine4: street.AddressLine4 || "",
      SACity: street.City || "",
      SARegion: street.Region || "",
      SAPostalCode: street.PostalCode || "",
      SACountry: street.Country || "",
      DPhoneType: def.PhoneType || "",
      DPhoneCountryCode: def.PhoneCountryCode || "",
      DPhoneAreaCode: def.PhoneAreaCode || "",
      DPhoneNumber: def.PhoneNumber || "",
      FPhoneType: fax.PhoneType || "",
      FPhoneCountryCode: fax.PhoneCountryCode || "",
      FPhoneAreaCode: fax.PhoneAreaCode || "",
      FPhoneNumber: fax.PhoneNumber || "",
      MPhoneType: mobile.PhoneType || "",
      MPhoneCountryCode: mobile.PhoneCountryCode || "",
      MPhoneAreaCode: mobile.PhoneAreaCode || "",
      MPhoneNumber: mobile.PhoneNumber || "",
      DDPhoneType: ddi.PhoneType || "",
      DDPhoneCountryCode: ddi.PhoneCountryCode || "",
      DDPhoneAreaCode: ddi.PhoneAreaCode || "",
      DDPhoneNumber: ddi.PhoneNumber || "",
      BankAccountNumber: contact.BankAccountDetails || "",
      BankAccountName: contact.BankAccountName || "",
      TaxNumber: contact.TaxNumber || "",
      AccountsReceivableTaxType: contact.AccountsReceivableTaxType || "",
      AccountsPayableTaxType: contact.AccountsPayableTaxType || "",
      Website: contact.Website || "",
      DueDateBillDay: paymentTerms.Bills?.Day ?? "",
      DueDateBillType: paymentTerms.Bills?.Type || "",
      DueDateSalesDay: paymentTerms.Sales?.Day ?? "",
      DueDateSalesType: paymentTerms.Sales?.Type || "",
      SalesAccountCode: contact.SalesDefaultAccountCode || "",
      PurchasesAccountCode: contact.PurchasesDefaultAccountCode || "",
      Person1FirstName: person(0).FirstName || "",
      Person1LastName: person(0).LastName || "",
      Person1Email: person(0).EmailAddress || "",
      Person2FirstName: person(1).FirstName || "",
      Person2LastName: person(1).LastName || "",
      Person2Email: person(1).EmailAddress || "",
      Person3FirstName: person(2).FirstName || "",
      Person3LastName: person(2).LastName || "",
      Person3Email: person(2).EmailAddress || "",
      Person4FirstName: person(3).FirstName || "",
      Person4LastName: person(3).LastName || "",
      Person4Email: person(3).EmailAddress || "",
      Person5FirstName: person(4).FirstName || "",
      Person5LastName: person(4).LastName || "",
      Person5Email: person(4).EmailAddress || "",
      AROutstanding: ar.Outstanding ?? "",
      AROverdue: ar.Overdue ?? "",
      APOutstanding: ap.Outstanding ?? "",
      APOverdue: ap.Overdue ?? "",
    };
  });
}

const exportTemplates = {
  "Invoice PAID": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "Reference",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "Discount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "InvoiceID",
    ],
    mapRows: (records) => mapInvoiceRows(records, { includeInvoiceId: true }),
  },
  "Invoice AUTHORISED": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "Reference",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "Discount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) => mapInvoiceRows(records, { includeInvoiceId: false }),
  },
  "Invoice DRAFT": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "Reference",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "Discount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) => mapInvoiceRows(records, { includeInvoiceId: false }),
  },
  "Bill PAID": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "InvoiceID",
    ],
    mapRows: (records) => mapBillRows(records, { includeInvoiceId: true }),
  },
  "Bill AUTHORISED": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "InvoiceID",
    ],
    mapRows: (records) => mapBillRows(records, { includeInvoiceId: true }),
  },
  "Bill DRAFT": {
    columns: [
      "ContactName",
      "InvoiceNumber",
      "Status",
      "LineAmountTypes",
      "InvoiceDate",
      "DueDate",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) => mapBillRows(records, { includeInvoiceId: false }),
  },
  "Invoice CreditNotes AUTHORISED": {
    columns: [
      "ContactName",
      "CreditNoteNumber",
      "Reference",
      "CNDate",
      "Total",
      "SubTotal",
      "TotalTax",
      "Status",
      "LineAmountTypes",
      "InventoryItemCode",
      "Description",
      "UnitAmount",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "AccountCode",
      "Quantity",
      "Discount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) =>
      mapCreditNoteRows(records, {
        includeReference: true,
        includeDiscount: true,
        includeId: false,
      }),
  },
  "Invoice CreditNotes PAID": {
    columns: [
      "ContactName",
      "CreditNoteNumber",
      "Reference",
      "CNDate",
      "Total",
      "SubTotal",
      "TotalTax",
      "Status",
      "LineAmountTypes",
      "InventoryItemCode",
      "Description",
      "UnitAmount",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "AccountCode",
      "Quantity",
      "Discount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) =>
      mapCreditNoteRows(records, {
        includeReference: true,
        includeDiscount: true,
        includeId: false,
      }),
  },
  "Supplier CreditNotes AUTHORISED": {
    columns: [
      "ContactName",
      "CreditNoteNumber",
      "CNDate",
      "Total",
      "SubTotal",
      "TotalTax",
      "Status",
      "LineAmountTypes",
      "InventoryItemCode",
      "Description",
      "UnitAmount",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "AccountCode",
      "Quantity",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "Id",
    ],
    mapRows: (records) =>
      mapCreditNoteRows(records, {
        includeReference: false,
        includeDiscount: false,
        includeId: true,
      }),
  },
  "Supplier CreditNotes PAID": {
    columns: [
      "ContactName",
      "CreditNoteNumber",
      "CNDate",
      "Total",
      "SubTotal",
      "TotalTax",
      "Status",
      "LineAmountTypes",
      "InventoryItemCode",
      "Description",
      "UnitAmount",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "AccountCode",
      "Quantity",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "Id",
    ],
    mapRows: (records) =>
      mapCreditNoteRows(records, {
        includeReference: false,
        includeDiscount: false,
        includeId: true,
      }),
  },
  Spend: {
    columns: [
      "Date",
      "LineAmount",
      "Description",
      "ContactName",
      "Reference",
      "Type",
      "AccountCode",
      "TaxType",
      "BankAccountCode",
      "InventoryItemCode",
      "CurrencyRate",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Line Amount Type",
      "TaxAmount",
      "BankTransactionID",
    ],
    mapRows: (records, raw, context) =>
      mapBankTransactionRows(
        records,
        { lineAmountTypeLabel: "Line Amount Type" },
        context
      ),
  },
  Receive: {
    columns: [
      "Date",
      "LineAmount",
      "Description",
      "ContactName",
      "Reference",
      "Type",
      "AccountCode",
      "TaxType",
      "BankAccountCode",
      "InventoryItemCode",
      "CurrencyRate",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Inclusive/Exclusive",
      "TaxAmount",
      "BankTransactionID",
    ],
    mapRows: (records, raw, context) =>
      mapBankTransactionRows(records, {
        lineAmountTypeLabel: "Inclusive/Exclusive",
      }, context),
  },
  Transfer: {
    columns: [
      "BankTransferID",
      "Date",
      "FromBankAccName",
      "ToBankAccName",
      "Amount",
      "CurrencyRate",
    ],
    mapRows: (records) => mapTransferRows(records),
  },
  "Bill Payment": {
    columns: [
      "Date",
      "InvoiceNumber",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
      "ContactName",
      "Bill_ID",
      "Payment_ID",
    ],
    mapRows: (records) =>
      mapPaymentRows(records, { includeContact: true, includeInvoiceId: true }).map(
        (row) => ({
          Date: row.Date,
          InvoiceNumber: row.InvoiceNumber,
          Amount: row.Amount,
          AccountCode: row.AccountCode,
          Reference: row.Reference,
          CurrencyRate: row.CurrencyRate,
          ContactName: row.ContactName,
          Bill_ID: row.Bill_ID,
          Payment_ID: row.Payment_ID,
        })
      ),
  },
  "Invoice Payment": {
    columns: [
      "Date",
      "InvoiceNumber",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
      "ContactName",
      "Invoice_ID",
      "Payment_ID",
    ],
    mapRows: (records) =>
      mapPaymentRows(records, { includeContact: true, includeInvoiceId: true }).map(
        (row) => ({
          Date: row.Date,
          InvoiceNumber: row.InvoiceNumber,
          Amount: row.Amount,
          AccountCode: row.AccountCode,
          Reference: row.Reference,
          CurrencyRate: row.CurrencyRate,
          ContactName: row.ContactName,
          Invoice_ID: row.Invoice_ID,
          Payment_ID: row.Payment_ID,
        })
      ),
  },
  "CreditNoteRefund Invoice": {
    columns: [
      "Date",
      "InvoiceNumber",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
    ],
    mapRows: (records) =>
      mapPaymentRows(records, { includeContact: false, includeInvoiceId: false }).map(
        (row) => ({
          Date: row.Date,
          InvoiceNumber: row.InvoiceNumber,
          Amount: row.Amount,
          AccountCode: row.AccountCode,
          Reference: row.Reference,
          CurrencyRate: row.CurrencyRate,
        })
      ),
  },
  "CreditNoteRefund Bill": {
    columns: [
      "Date",
      "InvoiceNumber",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
    ],
    mapRows: (records) =>
      mapPaymentRows(records, { includeContact: false, includeInvoiceId: false }).map(
        (row) => ({
          Date: row.Date,
          InvoiceNumber: row.InvoiceNumber,
          Amount: row.Amount,
          AccountCode: row.AccountCode,
          Reference: row.Reference,
          CurrencyRate: row.CurrencyRate,
        })
      ),
  },
  "Overpayment Refund AP": {
    columns: [
      "Date",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
      "ContactName",
    ],
    mapRows: (records) => mapOverpaymentPaymentRows(records),
  },
  "Overpayment Refund AR": {
    columns: [
      "Date",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
      "ContactName",
    ],
    mapRows: (records) => mapOverpaymentPaymentRows(records),
  },
  "Overpayment Refunds": {
    columns: [
      "Date",
      "Amount",
      "AccountCode",
      "Reference",
      "CurrencyRate",
      "ContactName",
      "OverpaymentID",
      "PaymentID",
      "Status",
    ],
    mapRows: (records) => mapOverpaymentRefundRows(records),
  },
  "Spend Overpayment": {
    columns: [
      "Date",
      "LineAmount",
      "Description",
      "ContactName",
      "Reference",
      "Type",
      "AccountCode",
      "BankAccountCode",
      "InventoryItemCode",
      "CurrencyRate",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "Status",
      "OverpaymentID",
    ],
    mapRows: (records, raw, context) => mapOverpaymentRows(records, context),
  },
  "Receive Overpayment": {
    columns: [
      "Date",
      "LineAmount",
      "Description",
      "ContactName",
      "Reference",
      "Type",
      "AccountCode",
      "BankAccountCode",
      "InventoryItemCode",
      "CurrencyRate",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "Status",
      "OverpaymentID",
    ],
    mapRows: (records, raw, context) => mapOverpaymentRows(records, context),
  },
  "Manual Journals": {
    columns: [
      "MJ ID",
      "Narration",
      "Date",
      "Description",
      "AccountCode",
      "TaxType",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "LineAmountType",
      "Status",
      "CurrencyRate",
    ],
    mapRows: (records) => mapManualJournalRows(records),
  },
  Items: {
    columns: [
      { header: "Id", key: "Id" },
      { header: "Status", key: "Status" },
      { header: "ProviderName", key: "ProviderName" },
      { header: "DateTimeUTC", key: "DateTimeUTC" },
      { header: "Items", key: "Items" },
      { header: "ItemID", key: "ItemID" },
      { header: "Code", key: "Code" },
      { header: "Description", key: "Description" },
      { header: "PurchaseDescription", key: "PurchaseDescription" },
      { header: "UpdatedDateUTC", key: "UpdatedDateUTC" },
      { header: "PurchaseDetails", key: "PurchaseDetails" },
      { header: "UnitPrice", key: "PurchaseUnitPrice" },
      { header: "AccountCode", key: "PurchaseAccountCode" },
      { header: "TaxType", key: "PurchaseTaxType" },
      { header: "COGSAccountCode", key: "COGSAccountCode" },
      { header: "SalesDetails", key: "SalesDetails" },
      { header: "UnitPrice", key: "SalesUnitPrice" },
      { header: "AccountCode", key: "SalesAccountCode" },
      { header: "TaxType", key: "SalesTaxType" },
      { header: "Name", key: "Name" },
      { header: "IsTrackedAsInventory", key: "IsTrackedAsInventory" },
      { header: "IsSold", key: "IsSold" },
      { header: "IsPurchased", key: "IsPurchased" },
      { header: "InventoryAssetAccountCode", key: "InventoryAssetAccountCode" },
      { header: "TotalCostPool", key: "TotalCostPool" },
      { header: "QuantityOnHand", key: "QuantityOnHand" },
    ],
    mapRows: (records, meta) => mapItemRows(records, meta),
  },
  Inventory: {
    columns: [
      { header: "Id", key: "Id" },
      { header: "Status", key: "Status" },
      { header: "ProviderName", key: "ProviderName" },
      { header: "DateTimeUTC", key: "DateTimeUTC" },
      { header: "Items", key: "Items" },
      { header: "ItemID", key: "ItemID" },
      { header: "Code", key: "Code" },
      { header: "Description", key: "Description" },
      { header: "PurchaseDescription", key: "PurchaseDescription" },
      { header: "UpdatedDateUTC", key: "UpdatedDateUTC" },
      { header: "PurchaseDetails", key: "PurchaseDetails" },
      { header: "UnitPrice", key: "PurchaseUnitPrice" },
      { header: "AccountCode", key: "PurchaseAccountCode" },
      { header: "TaxType", key: "PurchaseTaxType" },
      { header: "COGSAccountCode", key: "COGSAccountCode" },
      { header: "SalesDetails", key: "SalesDetails" },
      { header: "UnitPrice", key: "SalesUnitPrice" },
      { header: "AccountCode", key: "SalesAccountCode" },
      { header: "TaxType", key: "SalesTaxType" },
      { header: "Name", key: "Name" },
      { header: "IsTrackedAsInventory", key: "IsTrackedAsInventory" },
      { header: "IsSold", key: "IsSold" },
      { header: "IsPurchased", key: "IsPurchased" },
      { header: "InventoryAssetAccountCode", key: "InventoryAssetAccountCode" },
      { header: "TotalCostPool", key: "TotalCostPool" },
      { header: "QuantityOnHand", key: "QuantityOnHand" },
    ],
    mapRows: (records, meta) => mapItemRows(records, meta),
  },
  Quotes: {
    columns: [
      { header: "QuoteID", key: "QuoteID" },
      { header: "QuoteNumber", key: "QuoteNumber" },
      { header: "Contact", key: "Contact" },
      { header: "ContactID", key: "ContactID" },
      { header: "Name", key: "ContactName" },
      { header: "FirstName", key: "FirstName" },
      { header: "LastName", key: "LastName" },
      { header: "EmailAddress", key: "EmailAddress" },
      { header: "LineItems", key: "LineItems" },
      { header: "LineItemID", key: "LineItemID" },
      { header: "Description", key: "Description" },
      { header: "UnitAmount", key: "UnitAmount" },
      { header: "DiscountAmount", key: "DiscountAmount" },
      { header: "LineAmount", key: "LineAmount" },
      { header: "Quantity", key: "Quantity" },
      { header: "TaxAmount", key: "TaxAmount" },
      { header: "AccountCode", key: "AccountCode" },
      { header: "TaxType", key: "TaxType" },
      { header: "Tracking", key: "Tracking" },
      { header: "TrackingCategoryID", key: "TrackingCategoryID" },
      { header: "TrackingOptionID", key: "TrackingOptionID" },
      { header: "Name", key: "TrackingName" },
      { header: "Option", key: "TrackingOption" },
      { header: "DiscountRate", key: "DiscountRate" },
      { header: "Date", key: "Date" },
      { header: "DateString", key: "DateString" },
      { header: "Status", key: "Status" },
      { header: "CurrencyRate", key: "CurrencyRate" },
      { header: "CurrencyCode", key: "CurrencyCode" },
      { header: "SubTotal", key: "SubTotal" },
      { header: "TotalTax", key: "TotalTax" },
      { header: "Total", key: "Total" },
      { header: "TotalDiscount", key: "TotalDiscount" },
      { header: "BrandingThemeID", key: "BrandingThemeID" },
      { header: "UpdatedDateUTC", key: "UpdatedDateUTC" },
      { header: "LineAmountTypes", key: "LineAmountTypes" },
      { header: "Reference", key: "Reference" },
      { header: "Title", key: "Title" },
      { header: "ExpiryDate", key: "ExpiryDate" },
      { header: "ExpiryDateString", key: "ExpiryDateString" },
    ],
    mapRows: (records) => mapQuoteRows(records),
  },
  "Purchase Orders": {
    columns: [
      "ContactName",
      "PurchaseOrderNumber",
      "Status",
      "OrderDate",
      "DeliveryDate",
      "LineAmountTypes",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "Discount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "PurchaseOrderID",
    ],
    mapRows: (records) => mapPurchaseOrderRows(records),
  },
  Prepayments: {
    columns: [
      "ContactName",
      "PrepaymentID",
      "Type",
      "Status",
      "Date",
      "Reference",
      "LineAmountTypes",
      "SubTotal",
      "TotalTax",
      "Total",
      "InventoryItemCode",
      "Description",
      "Quantity",
      "UnitAmount",
      "AccountCode",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
    ],
    mapRows: (records) => mapPrepaymentRows(records),
  },
  "Debit Notes": {
    columns: [
      "ContactName",
      "CreditNoteNumber",
      "Reference",
      "CNDate",
      "Total",
      "SubTotal",
      "TotalTax",
      "Status",
      "LineAmountTypes",
      "InventoryItemCode",
      "Description",
      "UnitAmount",
      "TaxType",
      "TaxAmount",
      "LineAmount",
      "AccountCode",
      "Quantity",
      "TrackingName1",
      "TrackingOption1",
      "TrackingName2",
      "TrackingOption2",
      "Currency",
      "CurrencyRate",
      "Id",
    ],
    mapRows: (records) =>
      mapCreditNoteRows(records, {
        includeReference: true,
        includeDiscount: false,
        includeId: true,
      }),
  },
  "Tracking Category": {
    columns: [
      "TrackingCategoryID",
      "TrackingCategoryName",
      "Status",
      "TrackingOptionID",
      "TrackingOptionName",
      "TrackingOptionStatus",
    ],
    mapRows: (records) => mapTrackingCategoryRows(records),
  },
  Classes: {
    columns: [
      "TrackingCategoryID",
      "TrackingCategoryName",
      "Status",
      "TrackingOptionID",
      "TrackingOptionName",
      "TrackingOptionStatus",
    ],
    mapRows: (records) => mapTrackingCategoryRows(records),
  },
  Contacts: {
    columns: [
      "ContactName",
      "AccountNumber",
      "EmailAddress",
      "FirstName",
      "LastName",
      "POAddressType",
      "POAttentionTo",
      "POAddressLine1",
      "POAddressLine2",
      "POAddressLine3",
      "POAddressLine4",
      "POCity",
      "PORegion",
      "POPostalCode",
      "POCountry",
      "SAAddressType",
      "SAAttentionTo",
      "SAAddressLine1",
      "SAAddressLine2",
      "SAAddressLine3",
      "SAAddressLine4",
      "SACity",
      "SARegion",
      "SAPostalCode",
      "SACountry",
      "DPhoneType",
      "DPhoneCountryCode",
      "DPhoneAreaCode",
      "DPhoneNumber",
      "FPhoneType",
      "FPhoneCountryCode",
      "FPhoneAreaCode",
      "FPhoneNumber",
      "MPhoneType",
      "MPhoneCountryCode",
      "MPhoneAreaCode",
      "MPhoneNumber",
      "DDPhoneType",
      "DDPhoneCountryCode",
      "DDPhoneAreaCode",
      "DDPhoneNumber",
      "BankAccountNumber",
      "BankAccountName",
      "TaxNumber",
      "AccountsReceivableTaxType",
      "AccountsPayableTaxType",
      "Website",
      "DueDateBillDay",
      "DueDateBillType",
      "DueDateSalesDay",
      "DueDateSalesType",
      "SalesAccountCode",
      "PurchasesAccountCode",
      "Person1FirstName",
      "Person1LastName",
      "Person1Email",
      "Person2FirstName",
      "Person2LastName",
      "Person2Email",
      "Person3FirstName",
      "Person3LastName",
      "Person3Email",
      "Person4FirstName",
      "Person4LastName",
      "Person4Email",
      "Person5FirstName",
      "Person5LastName",
      "Person5Email",
      "AROutstanding",
      "AROverdue",
      "APOutstanding",
      "APOverdue",
    ],
    mapRows: (records) => mapContactRows(records),
  },
};

loadJobs();
pruneOldJobs();
processQueue();


function buildRawHeader(raw, collectionKey) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const entries = Object.entries(raw).filter(([key]) => key !== collectionKey);
  if (!entries.length) {
    return null;
  }
  const parts = entries.map(
    ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`
  );
  return `{${parts.join(",")},${JSON.stringify(collectionKey)}:[`;
}

async function fetchPagedRecords({
  accessToken,
  tenantId,
  type,
  from,
  to,
  session,
  onPage,
}) {
  const config = typeConfigs[type];
  if (!config) {
    throw new Error(`Unsupported type: ${type}`);
  }

  const where = buildWhere(from, to, config);
  const baseUrl = new URL(`https://api.xero.com/api.xro/2.0${config.path}`);
  if (config.unitdp) {
    baseUrl.searchParams.set("unitdp", String(config.unitdp));
  }
  if (where) {
    baseUrl.searchParams.set("where", where);
  }

  let count = 0;
  let lastRate = null;
  let firstRaw = null;
  let currentAccessToken = accessToken;
  let previousPageSignature = null;

  const buildHeaders = () => ({
    Authorization: `Bearer ${currentAccessToken}`,
    "xero-tenant-id": tenantId,
    Accept: "application/json",
  });

  const fetchWithAuthRetry = async (url) => {
    try {
      return await fetchWithRetry(url, { headers: buildHeaders() });
    } catch (err) {
      if (err.message && err.message.includes("Xero API error 401") && session) {
        currentAccessToken = await forceRefreshSession(session);
        return fetchWithRetry(url, { headers: buildHeaders() });
      }
      throw err;
    }
  };

  if (config.paged) {
    let page = 1;
    while (true) {
      const url = new URL(baseUrl.toString());
      url.searchParams.set("page", String(page));
      const payload = await fetchWithAuthRetry(url.toString());
      if (!firstRaw) firstRaw = payload.data;
      lastRate = payload.rate || lastRate;
      const pagination = payload.data?.pagination || {};
      const pageCount = pagination.pageCount || null;
      const itemCount = pagination.itemCount || null;
      const records = payload.data[config.collectionKey] || [];
      if (records.length) {
        const first = records[0] || {};
        const signature = `${records.length}:${JSON.stringify(first)}`;
        if (signature === previousPageSignature) {
          break;
        }
        previousPageSignature = signature;
      }
      if (!records.length) break;
      if (onPage) {
        await onPage(records, payload.data, {
          page,
          pageCount,
          itemCount,
        });
      }
      count += records.length;
      page += 1;
      await delay(1000);
    }
  } else {
    const payload = await fetchWithAuthRetry(baseUrl.toString());
    if (!firstRaw) firstRaw = payload.data;
    lastRate = payload.rate || lastRate;
    const records = payload.data[config.collectionKey] || [];
    if (records.length && onPage) {
      await onPage(records, payload.data, {
        page: 1,
        pageCount: 1,
        itemCount: records.length,
      });
    }
    count += records.length;
  }

  return { count, rate: lastRate, firstRaw };
}

async function fetchAllRecords({ accessToken, tenantId, type, from, to, session }) {
  const config = typeConfigs[type];
  if (!config) {
    throw new Error(`Unsupported type: ${type}`);
  }

  const all = [];
  let raw = null;
  const result = await fetchPagedRecords({
    accessToken,
    tenantId,
    type,
    from,
    to,
    session,
    onPage: async (records, payload) => {
      if (!raw) raw = payload;
      if (records.length) {
        all.push(...records);
      }
    },
  });

  let mergedRaw = null;
  if (raw) {
    mergedRaw = JSON.parse(JSON.stringify(raw));
    mergedRaw[config.collectionKey] = all;
  }

  return { records: all, rate: result.rate, raw: mergedRaw };
}

async function buildExportContext({ accessToken, tenantId, type, session }) {
  if (!needsBankAccountCodeFallback(type)) {
    return {};
  }

  const { records } = await fetchAllRecords({
    accessToken,
    tenantId,
    type: "Chart of Accounts",
    session,
  });

  return {
    accountCodeIndex: buildAccountCodeIndex(records),
  };
}

app.get("/api/auth/start", (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  // Auto-clear any existing sessions for this user so Reconnect always works
  if (userData) {
    for (const [sid, sess] of sessionStore.entries()) {
      if (sess.userId === userData.user.id) {
        sessionStore.delete(sid);
        if (latestSession?.sessionId === sid) latestSession = null;
      }
    }
    saveSessions();
  }
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  const perUserClientId = userData?.user?.xeroClientId || null;
  stateStore.set(state, { verifier, createdAt: Date.now(), userId: userData?.user?.id || null, clientId: perUserClientId });
  const authUrl = buildAuthUrl(state, challenge, perUserClientId);
  res.json({ authUrl });
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing code or state");
    }
    const stateData = stateStore.get(state);
    if (!stateData) {
      return res.status(400).send("Invalid state");
    }

    const callbackClientId = stateData.clientId || null;
    const callbackUserId = stateData.userId || null;
    const token = await exchangeToken(code, stateData.verifier, callbackClientId);
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      userId: callbackUserId,
      clientId: callbackClientId,
      connectedAt: Date.now(),
      dayUsed: 0,
      dayExhausted: false,
    });
    latestSession = { sessionId, createdAt: Date.now() };
    saveSessions();

    const redirectTarget = new URL(FRONTEND_URL);
    redirectTarget.searchParams.set("sessionId", sessionId);
    res.redirect(redirectTarget.toString());
  } catch (err) {
    console.error("Backend callback error:", err);
    res.status(500).send("Auth failed");
  }
});

app.get("/api/session/latest", (req, res) => {
  if (!latestSession) {
    return res.status(404).json({ error: "No recent session found" });
  }
  if (Date.now() - latestSession.createdAt > 24 * 60 * 60 * 1000) {
    latestSession = null;
    return res.status(404).json({ error: "Session expired" });
  }
  return res.json({ sessionId: latestSession.sessionId });
});

app.post("/api/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.body;
    if (!code || !state) {
      return res.status(400).json({ error: "Missing code or state" });
    }
    const stateData = stateStore.get(state);
    if (!stateData) {
      return res.status(400).json({ error: "Invalid state" });
    }
    const callbackClientId = stateData.clientId || null;
    const callbackUserId = stateData.userId || null;
    const token = await exchangeToken(code, stateData.verifier, callbackClientId);
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      userId: callbackUserId,
      clientId: callbackClientId,
      connectedAt: Date.now(),
      dayUsed: 0,
      dayExhausted: false,
    });
    latestSession = { sessionId, createdAt: Date.now() };
    saveSessions();

    res.json({ sessionId });
  } catch (err) {
    console.error("Auth callback error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/manual", async (req, res) => {
  try {
    const { callbackUrl } = req.body;
    if (!callbackUrl) {
      return res.status(400).json({ error: "Missing callbackUrl" });
    }

    const parsed = new URL(callbackUrl);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      return res.status(400).json({ error: "Missing code or state in URL" });
    }

    const stateData = stateStore.get(state);
    if (!stateData) {
      return res.status(400).json({ error: "State expired. Click Connect again." });
    }

    const callbackClientId = stateData.clientId || null;
    const token = await exchangeToken(code, stateData.verifier, callbackClientId);
    const callbackUserId = stateData.userId || null;
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
      userId: callbackUserId,
      clientId: callbackClientId,
      connectedAt: Date.now(),
    });
    latestSession = { sessionId, createdAt: Date.now() };
    saveSessions();

    res.json({ sessionId });
  } catch (err) {
    console.error("Manual auth error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/import/errors/download", async (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) return res.status(401).json({ error: "Not logged in" });

  const { jobId, type } = req.query;
  if (!jobId || !type) return res.status(400).json({ error: "Missing jobId or type" });

  const storeMap = {
    bills: billsImportJobStore,
    invoices: invoicesImportJobStore,
    "credit-notes": creditNotesImportJobStore,
    "spend-money": spendMoneyImportJobStore,
    "receive-money": receiveMoneyImportJobStore,
    "spend-op": overpaymentImportJobStore,
    "receive-op": overpaymentImportJobStore,
    "spend-allocation": overpaymentAllocationJobStore,
    "receive-allocation": overpaymentAllocationJobStore,
    "manual-journals": manualJournalImportJobStore,
    "bill-payments": billPaymentImportJobStore,
    "invoice-payments": invoicePaymentImportJobStore,
    "credit-note-refunds": creditNoteRefundImportJobStore,
    accounts: accountsImportJobStore,
    items: itemsImportJobStore,
    customers: customersImportJobStore,
    vendors: vendorsImportJobStore,
    "tracking-categories": trackingCategoryImportJobStore,
    "purchase-orders": purchaseOrdersImportJobStore,
    quotes: quotesImportJobStore,
    "cn-allocation": creditNoteAllocationJobStore,
    "dn-allocation": creditNoteAllocationJobStore,
    "exchange-rate-update": exchangeRateUpdateJobStore,
    "bank-transfers": bankTransferImportJobStore,
  };

  const store = storeMap[type];
  if (!store) return res.status(400).json({ error: "Unknown import type" });

  const job = store.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });

  const filterMode = req.query.filter || "errors"; // "errors" or "success"
  const errors = filterMode === "success"
    ? (job.results || []).filter((r) => r.status === "created" || r.status === "skipped" || r.status === "warning" || r.status === "partial")
    : (job.results || []).filter((r) => r.status === "error");
  if (!errors.length) return res.status(404).json({ error: filterMode === "success" ? "No completed rows found in this import" : "No errors found in this import" });

  // Template column definitions: [CSV header, job row field name]
  const SHARED_LINE_COLS = [
    ["Line Description", "description"],
    ["Quantity", "quantity"],
    ["Unit Amount", "unitAmount"],
    ["Account Code", "accountCode"],
    ["Tax Type", "taxType"],
    ["Tax Amount", "taxAmount"],
    ["Tracking Name 1", "trackingName1"],
    ["Tracking Option 1", "trackingOption1"],
    ["Tracking Name 2", "trackingName2"],
    ["Tracking Option 2", "trackingOption2"],
  ];
  const TYPE_COLS = {
    bills: [["Bill Number","billNumber"],["Contact Name","contactName"],["Bill Date","billDate"],["Due Date","dueDate"],["Reference","reference"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],...SHARED_LINE_COLS,["Status","status"]],
    invoices: [["Invoice Number","invoiceNumber"],["Contact Name","contactName"],["Invoice Date","invoiceDate"],["Due Date","dueDate"],["Reference","reference"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],...SHARED_LINE_COLS,["Status","status"]],
    "credit-notes": [["Credit Note Number","creditNoteNumber"],["Contact Name","contactName"],["Credit Note Date","creditNoteDate"],["Reference","reference"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],...SHARED_LINE_COLS,["Status","status"]],
    "spend-money": [["Reference","reference"],["Contact Name","contactName"],["Date","date"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],["Bank Account Code","bankAccountCode"],...SHARED_LINE_COLS],
    "receive-money": [["Reference","reference"],["Contact Name","contactName"],["Date","date"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],["Bank Account Code","bankAccountCode"],...SHARED_LINE_COLS],
    "spend-op": [["Reference","reference"],["Contact Name","contactName"],["Date","date"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],["Bank Account Code","bankAccountCode"],...SHARED_LINE_COLS],
    "receive-op": [["Reference","reference"],["Contact Name","contactName"],["Date","date"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],["Bank Account Code","bankAccountCode"],...SHARED_LINE_COLS],
    "bill-payments": [["Invoice Number","invoiceNumber"],["Contact Name","contactName"],["Bank Account Code","bankAccountCode"],["Date","date"],["Amount","amount"],["Reference","reference"],["Currency Rate","currencyRate"]],
    "invoice-payments": [["Invoice Number","invoiceNumber"],["Bank Account Code","bankAccountCode"],["Date","date"],["Amount","amount"],["Reference","reference"],["Currency Rate","currencyRate"]],
    "credit-note-refunds": [["Credit Note Number","creditNoteNumber"],["Bank Account Code","bankAccountCode"],["Date","date"],["Amount","amount"],["Reference","reference"],["Currency Rate","currencyRate"]],
    "spend-allocation": [["Overpayment Reference","overpaymentReference"],["Bill Number","invoiceNumber"],["Contact Name","contactName"],["Amount","amount"],["Date","date"]],
    "receive-allocation": [["Overpayment Reference","overpaymentReference"],["Invoice Number","invoiceNumber"],["Contact Name","contactName"],["Amount","amount"],["Date","date"]],
    "purchase-orders": [["PO Number","poNumber"],["Contact Name","contactName"],["Date","date"],["Delivery Date","deliveryDate"],["Reference","reference"],["Attention To","attentionTo"],["Telephone","telephone"],["Delivery Instructions","deliveryInstructions"],["Currency Code","currencyCode"],["Exchange Rate","exchangeRate"],["Line Description","description"],["Quantity","quantity"],["Unit Amount","unitAmount"],["Account Code","accountCode"],["Item Code","itemCode"],["Tax Type","taxType"],["Tax Amount","taxAmount"],["Tracking Name 1","trackingName1"],["Tracking Option 1","trackingOption1"],["Tracking Name 2","trackingName2"],["Tracking Option 2","trackingOption2"],["Status","status"]],
    "cn-allocation": [["Credit Note Number","creditNoteReference"],["Invoice Number","invoiceNumber"],["Contact Name","contactName"],["Amount","amount"],["Date","date"]],
    "dn-allocation": [["Credit Note Number","creditNoteReference"],["Bill Number","invoiceNumber"],["Contact Name","contactName"],["Amount","amount"],["Date","date"]],
    "exchange-rate-update": [["Invoice Number","invoiceNumber"]],
    "bank-transfers": [["From Account Code","fromAccountCode"],["To Account Code","toAccountCode"],["Amount","amount"],["Date","date"],["Reference","reference"],["Exchange Rate","exchangeRate"]],
  };

  // Extract flat rows from job (handle grouped and flat structures)
  function getJobRowMap(job, t) {
    const map = new Map();
    const addRows = (rows) => (rows || []).forEach((r) => { if (!map.has(r.rowNumber)) map.set(r.rowNumber, r); });
    if (t === "bills") { (job.billGroups || []).forEach((g) => addRows(g.rows)); (job.billCreditNoteGroups || []).forEach((g) => addRows(g.rows)); }
    else if (t === "invoices") { (job.invoiceGroups || []).forEach((g) => addRows(g.rows)); (job.creditNoteGroups || []).forEach((g) => addRows(g.rows)); }
    else if (t === "credit-notes") (job.creditNoteGroups || []).forEach((g) => addRows(g.rows));
    else if (t === "manual-journals") (job.journalGroups || job.groups || []).forEach((g) => addRows(g.rows || g.lines || []));
    else if (t === "purchase-orders") (job.poGroups || []).forEach((g) => addRows(g.rows));
    else if (t === "quotes") (job.quoteGroups || []).forEach((g) => addRows(g.rows));
    else if (t === "spend-op" || t === "receive-op") (job.groups || []).forEach((g) => addRows(g.rows));
    else addRows(job.rows);
    return map;
  }

  const cols = TYPE_COLS[type];

  try {
    if (cols) {
      const isSuccess = filterMode === "success";
      const rowMap = getJobRowMap(job, type);
      // Success sheet: original cols + Status column (for reference only)
      // Error sheet: original cols ONLY — no Error_Message, so file is directly reimportable
      const headers = isSuccess ? [...cols.map(([h]) => h), "Status"] : [...cols.map(([h]) => h), "Error_Message"];
      const csvEscape = (v) => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [headers.map(csvEscape).join(",")];
      for (const row of errors) {
        const origRow = rowMap.get(row.rowNumber);
        if (isSuccess) {
          const cells = [...cols.map(([, f]) => {
            if (f === "amount" && row.amount != null) return csvEscape(row.amount);
            return csvEscape(origRow?.[f] ?? row[f] ?? "");
          }), csvEscape(row.status || "")];
          lines.push(cells.join(","));
        } else {
          const cells = [...cols.map(([, f]) => csvEscape(origRow?.[f] ?? "")), csvEscape(row.message || "")];
          lines.push(cells.join(","));
        }
      }
      const csv = lines.join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      const filename = isSuccess
        ? `success_completed_${type}_${Date.now()}.csv`
        : `errors_reimport_${type}_${Date.now()}.csv`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(csv);
    }

    // Fallback: generic XLSX for types without a column mapping
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Import Errors");
    const sample = errors[0];
    const keys = Object.keys(sample).filter((k) => k !== "status");
    sheet.columns = keys.map((k) => ({ header: k.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()), key: k, width: 22 }));
    sheet.getRow(1).font = { bold: true };
    errors.forEach((err) => { const row = {}; keys.forEach((k) => { row[k] = err[k] ?? ""; }); sheet.addRow(row); });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="import-errors-${type}-${Date.now()}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error download failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/import/history", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const search = (req.query.search || "").toLowerCase().trim();
  const typeFilter = (req.query.importType || "").trim();
  const statusFilter = (req.query.status || "").trim();

  let filtered = importHistoryStore.slice();
  if (typeFilter) filtered = filtered.filter(h => h.importType === typeFilter);
  if (statusFilter) filtered = filtered.filter(h => h.status === statusFilter);
  if (search) filtered = filtered.filter(h =>
    [h.importType, h.orgName, h.userEmail, h.note].some(s => (s || "").toLowerCase().includes(search))
  );

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, pages);
  const startIdx = (safePage - 1) * limit;

  return res.json({
    history: filtered.slice(startIdx, startIdx + limit),
    total,
    page: safePage,
    limit,
    pages,
  });
});

app.get("/api/import/history/export", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  let filtered = importHistoryStore.slice();
  const typeFilter = (req.query.importType || "").trim();
  const statusFilter = (req.query.status || "").trim();
  const search = (req.query.search || "").toLowerCase().trim();
  if (typeFilter) filtered = filtered.filter(h => h.importType === typeFilter);
  if (statusFilter) filtered = filtered.filter(h => h.status === statusFilter);
  if (search) filtered = filtered.filter(h =>
    [h.importType, h.orgName, h.userEmail, h.note].some(s => (s || "").toLowerCase().includes(search))
  );
  const cols = ["date", "importType", "orgName", "userEmail", "total", "created", "errors", "status", "note"];
  const headers = ["Date", "Import Type", "Organisation", "User Email", "Total", "Created", "Errors", "Status", "Note"];
  const esc = v => { const s = String(v ?? ""); return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [headers.join(",")];
  filtered.forEach(h => {
    lines.push(cols.map(c => {
      if (c === "date") return esc(h[c] ? new Date(h[c]).toLocaleString() : "");
      return esc(h[c] ?? "");
    }).join(","));
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="import-history-${Date.now()}.csv"`);
  return res.send(lines.join("\n"));
});

app.get("/api/quota", (req, res) => {
  return res.json({ dayRemaining: _globalDayRemaining, dayTotal: 5000 });
});

async function processUndoJob(job) {
  const { createdIds, importType, tenantId, sessionId } = job;
  const UNDO_BATCH = 5;
  const voidableTypes = ["bills", "invoices", "credit-notes"];
  const deletableTypes = ["spend-money", "receive-money", "bill-payments", "invoice-payments", "credit-note-refunds", "manual-journals", "purchase-orders", "quotes"];
  job.total = createdIds.length;
  job.done = 0;
  job.failed = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const fetchWithRetry = async (url, opts, retries = 4) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(url, opts);
      if (res.status !== 429) return res;
      const wait = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s, 16s
      await sleep(wait);
    }
    return fetch(url, opts);
  };

  let resolvedSessionId = sessionId;
  const getToken = async () => {
    const candidates = getSessionCandidates(resolvedSessionId);
    if (!candidates.length) throw new Error("No Xero session. Reconnect to Xero first.");
    for (const c of candidates) {
      try {
        const token = await getAccessToken(c.session);
        resolvedSessionId = c.sessionId;
        return token;
      } catch (_) {}
    }
    throw new Error("Could not get Xero access token. Please reconnect.");
  };

  try {
    if (voidableTypes.includes(importType)) {
      const accessToken = await getToken();
      for (let i = 0; i < createdIds.length; i += UNDO_BATCH) {
        const batch = createdIds.slice(i, i + UNDO_BATCH);
        await Promise.all(batch.map(async (id) => {
          try {
            const r = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${id}`, {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "xero-tenant-id": tenantId },
              body: JSON.stringify({ Invoices: [{ InvoiceID: id, Status: "VOIDED" }] }),
            });
            if (r.ok) job.done++; else job.failed++;
          } catch (_) { job.failed++; }
        }));
        job.message = `Deleted ${job.done} of ${job.total}...`;
      }
    } else if (importType === "manual-journals") {
      // POSTED manual journals cannot be deleted — must be voided via status update
      if (!job.lastErrors) job.lastErrors = [];
      for (let i = 0; i < createdIds.length; i += UNDO_BATCH) {
        const accessToken = await getToken(); // refresh token per batch
        const batch = createdIds.slice(i, i + UNDO_BATCH);
        await Promise.all(batch.map(async (id) => {
          try {
            // Try VOID first (works for POSTED journals)
            const rVoid = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/ManualJournals/${id}`, {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "xero-tenant-id": tenantId },
              body: JSON.stringify({ ManualJournals: [{ ManualJournalID: id, Status: "VOIDED" }] }),
            });
            if (rVoid.ok) {
              const body = await rVoid.json().catch(() => ({}));
              const mj = (body.ManualJournals || [])[0];
              // Verify the journal is actually VOIDED in the response body
              if (mj && (mj.Status === "VOIDED" || mj.Status === "DELETED")) { job.done++; return; }
              // Xero returned 200 but validation error in body — capture it
              const errMsg = (mj?.ValidationErrors || [])[0]?.Message || body.Detail || "HTTP 200 but not VOIDED";
              if (job.lastErrors.length < 20) job.lastErrors.push(`[${id.slice(0,8)}] ${errMsg}`);
              // Fall through to DELETE attempt for DRAFT journals
            } else {
              const errBody = await rVoid.text().catch(() => "");
              if (job.lastErrors.length < 20) job.lastErrors.push(`[${id.slice(0,8)}] HTTP ${rVoid.status}: ${errBody.slice(0, 150)}`);
            }
            // Fallback: DELETE (works for DRAFT journals)
            const accessToken2 = await getToken();
            const rDel = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/ManualJournals/${id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken2}`, "xero-tenant-id": tenantId },
            });
            if (rDel.ok || rDel.status === 404) job.done++; else job.failed++;
          } catch (e) { job.failed++; if (job.lastErrors.length < 20) job.lastErrors.push(`[${id.slice(0,8)}] Exception: ${e.message}`); }
        }));
        job.message = `Voided ${job.done} of ${job.total}...`;
      }
    } else if (deletableTypes.includes(importType)) {
      const resourceMap = { "spend-money": "BankTransactions", "receive-money": "BankTransactions", "bill-payments": "Payments", "invoice-payments": "Payments", "credit-note-refunds": "Payments", "purchase-orders": "PurchaseOrders", "quotes": "Quotes" };
      const resource = resourceMap[importType] || "BankTransactions";
      const accessToken = await getToken();
      for (let i = 0; i < createdIds.length; i += UNDO_BATCH) {
        const batch = createdIds.slice(i, i + UNDO_BATCH);
        await Promise.all(batch.map(async (id) => {
          try {
            const r = await fetch(`https://api.xero.com/api.xro/2.0/${resource}/${id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId },
            });
            if (r.ok || r.status === 404) job.done++; else job.failed++;
          } catch (_) { job.failed++; }
        }));
        job.message = `Deleted ${job.done} of ${job.total}...`;
      }
    }

    const histEntry = importHistoryStore.find(h => h.id === job.historyId || h.jobId === job.historyId);
    // Only mark as undone if at least some records were removed
    if (histEntry && job.done > 0) { histEntry.undone = true; histEntry.undoneAt = Date.now(); saveImportHistory(); }
    job.status = "done";
    job.message = `Undo complete: ${job.done} voided/deleted, ${job.failed} failed.`;
  } catch (err) {
    job.status = "error";
    job.message = err.message;
    console.error("Undo job error:", err);
  }
}

app.post("/api/import/undo", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const { historyId, tenantId } = req.body || {};
    if (!historyId || !tenantId) return res.status(400).json({ error: "historyId and tenantId required." });
    const entry = importHistoryStore.find(h => h.id === historyId || h.jobId === historyId);
    if (!entry) return res.status(404).json({ error: "Import history entry not found." });
    const { createdIds, importType } = entry;
    if (!createdIds || createdIds.length === 0) return res.status(400).json({ error: "No created IDs stored for this import — undo not available." });
    const sessionId = req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId;
    if (!sessionId) return res.status(400).json({ error: "No Xero session. Reconnect to Xero first." });

    const jobId = `undo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { jobId, historyId, createdIds, importType, tenantId, sessionId, status: "running", total: createdIds.length, done: 0, failed: 0, message: "Starting undo..." };
    undoJobStore.set(jobId, job);
    processUndoJob(job).catch(err => { job.status = "error"; job.message = err.message; });
    return res.json({ ok: true, jobId, total: createdIds.length });
  } catch (err) {
    console.error("Undo import error:", err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/import/undo/status", (req, res) => {
  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  const job = undoJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ ok: true, status: job.status, total: job.total, done: job.done, failed: job.failed, message: job.message, lastErrors: job.lastErrors || [] });
});

// ─── Manual Journal Void by Reference ───────────────────────────────────────
const mjVoidByRefJobStore = new Map();

async function processMJVoidByRefJob(job) {
  const { references, tenantId, sessionId } = job;

  // Deduplicate and clean references
  const uniqueRefs = [...new Set(references.map(r => String(r).trim()).filter(Boolean))];
  job.total = uniqueRefs.length;
  job.originalTotal = references.length;
  job.found = 0;
  job.voided = 0;
  job.failed = 0;
  job.notFound = 0;
  job.processed = 0;
  job.lastErrors = [];

  let resolvedSessionId = sessionId;
  let _tokenRefreshPromise = null;

  const getToken = async () => {
    if (_tokenRefreshPromise) return _tokenRefreshPromise;
    _tokenRefreshPromise = (async () => {
      const candidates = getSessionCandidates(resolvedSessionId);
      if (!candidates.length) throw new Error("No Xero session. Reconnect to Xero first.");
      for (const c of candidates) {
        try { const t = await getAccessToken(c.session); resolvedSessionId = c.sessionId; return t; } catch (_) {}
      }
      throw new Error("Could not get Xero access token.");
    })().finally(() => { _tokenRefreshPromise = null; });
    return _tokenRefreshPromise;
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const fetchWithRetry = async (url, opts, retries = 3) => {
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(url, opts);
      if (res.status === 429) {
        const wait = Math.pow(2, attempt + 1) * 2000;
        await sleep(wait);
        continue;
      }
      return res;
    }
    return fetch(url, opts);
  };

  const voidOneRef = async (ref) => {
    try {
      const token = await getToken();
      const encoded = encodeURIComponent(`Narration="${ref.replace(/"/g, '\\"')}"`);
      const searchRes = await fetchWithRetry(
        `https://api.xero.com/api.xro/2.0/ManualJournals?where=${encoded}`,
        { headers: { Authorization: `Bearer ${token}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
      );
      if (!searchRes.ok) {
        const errText = await searchRes.text().catch(() => "");
        job.failed++;
        if (job.lastErrors.length < 10) job.lastErrors.push(`[Search ${ref}] HTTP ${searchRes.status}: ${errText.slice(0, 200)}`);
        return;
      }
      const searchData = await searchRes.json();
      const journals = searchData.ManualJournals || [];
      if (journals.length === 0) { job.notFound++; return; }

      for (const mj of journals) {
        const mjId = mj.ManualJournalID;
        const status = mj.Status;
        if (status === "VOIDED") { job.voided++; job.found++; continue; }

        const t2 = await getToken();
        if (status === "DRAFT") {
          const delRes = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/ManualJournals/${mjId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${t2}`, "xero-tenant-id": tenantId },
          });
          if (delRes.ok || delRes.status === 404) { job.voided++; } else {
            const errText = await delRes.text().catch(() => "");
            job.failed++;
            if (job.lastErrors.length < 10) job.lastErrors.push(`[Delete ${ref}] HTTP ${delRes.status}: ${errText.slice(0, 200)}`);
          }
        } else {
          const voidRes = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/ManualJournals/${mjId}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${t2}`, "Content-Type": "application/json", "xero-tenant-id": tenantId },
            body: JSON.stringify({ ManualJournals: [{ ManualJournalID: mjId, Status: "VOIDED" }] }),
          });
          if (voidRes.ok) { job.voided++; } else {
            const errData = await voidRes.json().catch(() => ({}));
            job.failed++;
            const errMsg = errData?.Elements?.[0]?.ValidationErrors?.[0]?.Message || errData?.Detail || `HTTP ${voidRes.status}`;
            if (job.lastErrors.length < 10) job.lastErrors.push(`[Void ${ref}] ${errMsg}`);
          }
        }
        job.found++;
      }
    } catch (err) {
      job.failed++;
      if (job.lastErrors.length < 10) job.lastErrors.push(`[Exception ${ref}] ${err.message}`);
    } finally {
      job.processed++;
      job.message = `Processing ${job.processed} of ${job.total}${job.originalTotal !== job.total ? ` (${job.originalTotal - job.total} duplicates removed)` : ""}: "${ref}"...`;
    }
  };

  try {
    await getToken();

    // Process 5 references concurrently
    const CONCURRENCY = 5;
    let idx = 0;
    const runWorker = async () => {
      while (idx < uniqueRefs.length) {
        const ref = uniqueRefs[idx++];
        await voidOneRef(ref);
      }
    };
    const workers = Array.from({ length: Math.min(CONCURRENCY, uniqueRefs.length) }, () => runWorker());
    await Promise.all(workers);

    job.status = "done";
    job.message = `Done: ${job.voided} voided, ${job.notFound} not found, ${job.failed} failed.${job.originalTotal !== job.total ? ` (${job.originalTotal - job.total} duplicate refs skipped)` : ""}`;
  } catch (err) {
    job.status = "error";
    job.message = err.message;
    console.error("MJ void by ref error:", err);
  }
}

app.post("/api/delete/manual-journals-by-ref", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const { references, tenantId } = req.body || {};
    if (!Array.isArray(references) || references.length === 0) return res.status(400).json({ error: "references array required" });
    if (!tenantId) return res.status(400).json({ error: "tenantId required" });
    const sessionId = req.header("x-session-id") || latestSession?.sessionId;
    if (!sessionId) return res.status(400).json({ error: "No Xero session. Reconnect first." });

    const jobId = `mjvoid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { jobId, references, tenantId, sessionId, status: "running", total: references.length, originalTotal: references.length, found: 0, voided: 0, failed: 0, notFound: 0, processed: 0, lastErrors: [], message: "Starting..." };
    mjVoidByRefJobStore.set(jobId, job);
    processMJVoidByRefJob(job).catch(err => { job.status = "error"; job.message = err.message; });
    return res.json({ ok: true, jobId, total: references.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/delete/manual-journals-by-ref/status", (req, res) => {
  const { jobId } = req.query;
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  const job = mjVoidByRefJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ ok: true, status: job.status, total: job.total, originalTotal: job.originalTotal, processed: job.processed, found: job.found, voided: job.voided, notFound: job.notFound, failed: job.failed, message: job.message, lastErrors: job.lastErrors || [] });
});

// ─── Overpayment Duplicate Finder ───────────────────────────────────────────
app.get("/api/delete/overpayment-duplicates/scan", async (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const tenantId = String(req.query.tenantId || "").trim();
  const opType = req.query.type === "RECEIVE" ? "RECEIVE-OVERPAYMENT" : "SPEND-OVERPAYMENT";
  if (!tenantId) return res.status(400).json({ error: "tenantId required" });
  const sessionId = req.header("x-session-id") || userData.sessionId;
  const allTxns = [];
  const MAX_PAGES = 20;
  try {
    // Fetch all bank accounts first, then query each for overpayments (Type filter alone is unreliable)
    const baResult = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
      const { data } = await fetchWithRetry(
        `https://api.xero.com/api.xro/2.0/Accounts?where=${encodeURIComponent('Type=="BANK"&&Status=="ACTIVE"')}`,
        { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
      );
      return { accounts: data?.Accounts || [] };
    });
    const bankCodes = (baResult.accounts || []).map(a => String(a.Code || "").trim()).filter(Boolean);
    for (const bankCode of bankCodes) {
      let page = 1;
      while (page <= MAX_PAGES) {
        const where = encodeURIComponent(`BankAccount.Code=="${bankCode}"&&Type=="${opType}"&&Status=="AUTHORISED"`);
        let txns = [];
        try {
          const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}&pageSize=1000`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
            );
            return { transactions: data?.BankTransactions || [] };
          });
          txns = (result.transactions || []).filter(t => t.Type === opType);
          txns.forEach(t => allTxns.push(t));
          if (result.transactions.length < 1000) break;
        } catch (_) { break; }
        page++;
      }
    }
    const byRef = {};
    for (const t of allTxns) {
      const ref = String(t.Reference || "").trim();
      if (!ref) continue;
      if (!byRef[ref]) byRef[ref] = [];
      byRef[ref].push({
        bankTransactionId: t.BankTransactionID,
        reference: ref,
        contact: t.Contact?.Name || "-",
        date: t.Date ? t.Date.replace(/\/Date\((\d+)\+\d+\)\//, (_, ms) => new Date(Number(ms)).toISOString().slice(0, 10)) : "-",
        total: t.Total,
        bankAccount: t.BankAccount?.Name || "-",
        updatedDate: t.UpdatedDateUTC || "",
      });
    }
    const duplicates = Object.entries(byRef)
      .filter(([, entries]) => entries.length > 1)
      .map(([reference, entries]) => ({
        reference,
        count: entries.length,
        entries: entries.sort((a, b) => (a.updatedDate || "").localeCompare(b.updatedDate || "")),
      }))
      .sort((a, b) => String(a.reference).localeCompare(String(b.reference), undefined, { numeric: true }));
    res.json({ ok: true, duplicates, totalDuplicateGroups: duplicates.length, totalScanned: allTxns.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/delete/overpayment-duplicates/void", async (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const { tenantId, groups, bankTransactionIds } = req.body;
  // Support both new groups format and legacy flat list
  const voidGroups = groups || (Array.isArray(bankTransactionIds) ? bankTransactionIds.map(id => ({ keep: null, extras: [id] })) : null);
  if (!tenantId || !voidGroups || voidGroups.length === 0) {
    return res.status(400).json({ error: "tenantId and groups required" });
  }
  const totalExtras = voidGroups.reduce((s, g) => s + g.extras.length, 0);
  const sessionId = req.header("x-session-id") || userData.sessionId;
  const jobId = crypto.randomBytes(12).toString("hex");
  const job = { id: jobId, total: totalExtras, done: 0, errors: 0, results: [], status: "running" };
  opDupVoidJobStore.set(jobId, job);

  const tryVoidOne = async (id) => {
    const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
      const { data } = await fetchWithRetry(
        "https://api.xero.com/api.xro/2.0/BankTransactions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
          },
          body: JSON.stringify({ BankTransactions: [{ BankTransactionID: id, Status: "DELETED" }] }),
        }
      );
      return { transactions: data?.BankTransactions || [] };
    });
    const txn = (result.transactions || [])[0];
    const valErrors = txn?.ValidationErrors || [];
    const isTypeError = valErrors.some(e => (e.Message || "").includes("Type field is not valid"));
    if (txn?.StatusAttributeString === "ERROR" || valErrors.length > 0) {
      const msg = valErrors.map(e => e.Message).filter(Boolean).join("; ") || "Xero validation error";
      return { ok: false, isTypeError, message: msg };
    }
    return { ok: true };
  };

  (async () => {
    for (const group of voidGroups) {
      const { keep, extras } = group;
      let groupVoided = false;
      for (const extraId of extras) {
        try {
          const r = await tryVoidOne(extraId);
          if (r.ok) {
            job.results.push({ id: extraId, status: "deleted" });
            job.done++;
            groupVoided = true;
          } else if (r.isTypeError && keep && !groupVoided) {
            // Extra is APOVERPAYMENTSOURCEPAYMENT (system-generated, can't void).
            // Swap: void the "keep" entry (our SPEND-OVERPAYMENT import) instead.
            try {
              const r2 = await tryVoidOne(keep);
              if (r2.ok) {
                job.results.push({ id: keep, status: "deleted", note: "swapped" });
                job.results.push({ id: extraId, status: "skipped", note: "system-generated APOVERPAYMENTSOURCEPAYMENT kept" });
                job.done++;
                groupVoided = true;
              } else {
                job.results.push({ id: extraId, status: "error", message: r.message });
                job.results.push({ id: keep, status: "error", message: r2.message });
                job.errors++;
              }
            } catch (err2) {
              job.results.push({ id: extraId, status: "error", message: r.message });
              job.results.push({ id: keep, status: "error", message: String(err2.message || "Swap failed") });
              job.errors++;
            }
          } else {
            job.results.push({ id: extraId, status: "error", message: r.message });
            job.errors++;
          }
        } catch (err) {
          job.results.push({ id: extraId, status: "error", message: String(err.message || "Failed") });
          job.errors++;
        }
      }
    }
    job.status = job.errors > 0 ? "completed_with_errors" : "completed";
  })();

  res.json({ ok: true, jobId, total: totalExtras });
});

app.get("/api/delete/overpayment-duplicates/void/:jobId", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = opDupVoidJobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true, status: job.status, total: job.total, done: job.done, errors: job.errors, deleted: job.done, results: job.results });
});

app.post("/api/xero/disconnect", async (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) return res.status(401).json({ error: "Not logged in" });

  const sessionId = req.header("x-session-id") || req.body?.sessionId;
  if (!sessionId) return res.status(400).json({ error: "No sessionId provided" });

  const sess = sessionStore.get(sessionId);
  if (sess) {
    if (sess.userId && sess.userId !== userData.user.id) {
      return res.status(403).json({ error: "Not your session" });
    }
    // Step 1: Delete each Xero connection via DELETE /connections/{id}
    // (this removes it from Xero's "Already connected" list)
    try {
      const accessToken = await getAccessToken(sess);
      const connectionsResp = await fetch("https://api.xero.com/connections", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (connectionsResp.ok) {
        const connections = await connectionsResp.json();
        await Promise.all(
          connections.map(c =>
            fetch(`https://api.xero.com/connections/${c.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${accessToken}` },
            }).catch(() => {})
          )
        );
      }
    } catch (_) {}
    // Step 2: Revoke the refresh token to invalidate the entire OAuth session
    if (sess.refresh_token) {
      try {
        await fetch("https://identity.xero.com/connect/revocation", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: sess.refresh_token, client_id: CLIENT_ID }),
        });
      } catch (_) {}
    }
    sessionStore.delete(sessionId);
    if (latestSession?.sessionId === sessionId) latestSession = null;
    saveSessions();
  }
  return res.json({ ok: true });
});

app.get("/api/tenants", async (req, res) => {
  try {
    const sessionId = req.header("x-session-id");
    let session = null;
    if (sessionId && sessionStore.has(sessionId)) {
      session = getSession(sessionId);
    } else if (latestSession && sessionStore.has(latestSession.sessionId)) {
      session = getSession(latestSession.sessionId);
    } else {
      return res.status(401).json({ error: "Missing session. Connect again." });
    }
    const accessToken = await getAccessToken(session);

    const resp = await fetch("https://api.xero.com/connections", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(500).json({ error: text });
    }

    const tenants = await resp.json();
    // Cache tenant list on the session so admin can see which orgs this user connected
    if (session) {
      session.tenants = tenants.map(t => ({ tenantId: t.tenantId, tenantName: t.tenantName, orgName: t.tenantName }));
      session.tenantsUpdatedAt = Date.now();
      saveSessions();
    }
    res.json({ tenants });
  } catch (err) {
    console.error("Tenants error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/types", (req, res) => {
  const types = Object.keys(typeConfigs).filter((type) => isTypeAllowed(type));
  res.json({ types });
});

app.get("/api/tax-rates", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const tenantId = String(req.query.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }
    const requestedSessionId = req.header("x-session-id") || req.query.sessionId;
    const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
      const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/TaxRates", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      });
      return { response };
    });
    const taxRates = Array.isArray(result.response.data?.TaxRates)
      ? result.response.data.TaxRates
      : [];
    return res.json({
      taxRates: taxRates.map((rate) => ({
        name: rate.Name || "",
        taxType: rate.TaxType || "",
        displayTaxRate: rate.DisplayTaxRate ?? rate.EffectiveRate ?? "",
        effectiveRate: rate.EffectiveRate ?? rate.DisplayTaxRate ?? "",
        status: rate.Status || "",
        canApplyToExpenses: Boolean(rate.CanApplyToExpenses),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/accounts/chart", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const tenantId = String(req.query.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }
    const requestedSessionId = req.header("x-session-id") || req.query.sessionId;
    const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
      const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Accounts?where=Status%3D%3D%22ACTIVE%22", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
          Accept: "application/json",
        },
      });
      return { response };
    });
    const accounts = Array.isArray(result.response.data?.Accounts) ? result.response.data.Accounts : [];
    const mapped = accounts
      .map((a) => ({
        code: a.Code || "",
        name: a.Name || "",
        type: a.Type || "",
        class: a.Class || "",
        systemAccount: a.SystemAccount || "",
      }))
      .filter((a) => a.code)
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    return res.json({ accounts: mapped });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/import/accounts/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Select a Xero organisation before importing." });
    }
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ error: "No account rows found in the CSV file." });
    }
    const planCheckAccounts = checkImportAccess(userData.user, "accounts", rows.length);
    if (!planCheckAccounts.allowed) return res.status(403).json({ error: planCheckAccounts.error, planError: true });
    if (rows.length > 500) {
      return res.status(400).json({ error: "Import a maximum of 500 accounts per CSV file." });
    }
    const normalizedRows = rows.map((row, index) => ({
      rowNumber: Number(row.rowNumber) || index + 2,
      code: String(row.code || "").trim(),
      name: String(row.name || "").trim(),
      bankAccountNumber: String(row.bankAccountNumber || "").trim(),
      bankAccountType: String(row.bankAccountType || "").trim(),
      type: String(row.type || "").trim(),
      description: String(row.description || "").trim(),
      tax: String(row.tax || "").trim(),
      showOnDashboard: String(row.showOnDashboard || "").trim(),
      enablePaymentsToAccount: String(row.enablePaymentsToAccount || "").trim(),
      expenseClaims: String(row.expenseClaims || "").trim(),
      currencyCode: String(row.currencyCode || "").trim(),
    }));
    const invalidRow = normalizedRows.find((row) => !row.code || !row.name || !row.type);
    if (invalidRow) {
      return res.status(400).json({
        error: `Row ${invalidRow.rowNumber}: Code, Name, and Type are required.`,
      });
    }
    normalizedRows.forEach((row) => buildAccountFromImportRow(row));
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "chart-of-accounts.csv"),
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentAccountCode: "",
      results: [],
      rows: normalizedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    accountsImportJobStore.set(job.id, job);
    setTimeout(() => {
      processAccountsImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildAccountsImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/accounts/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  const jobId = String(req.query.jobId || "").trim();
  const job = accountsImportJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Accounts import job not found" });
  }
  if (!ownsAccountsImportJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json({ ok: true, ...buildAccountsImportStatus(job) });
});

function normalizeItemRow(row, index, offset) {
  return {
    rowNumber: Number(row.rowNumber) || (offset || 0) + index + 2,
    code: String(row.code || "").trim(),
    name: String(row.name || "").trim(),
    description: String(row.description || "").trim(),
    purchaseDescription: String(row.purchaseDescription || "").trim(),
    isSold: String(row.isSold || "").trim(),
    isPurchased: String(row.isPurchased || "").trim(),
    salesUnitPrice: String(row.salesUnitPrice || "").trim(),
    salesAccountCode: String(row.salesAccountCode || "").trim(),
    salesTaxType: String(row.salesTaxType || "").trim(),
    purchaseUnitPrice: String(row.purchaseUnitPrice || "").trim(),
    purchaseAccountCode: String(row.purchaseAccountCode || "").trim(),
    purchaseTaxType: String(row.purchaseTaxType || "").trim(),
    cogsAccountCode: String(row.cogsAccountCode || "").trim(),
  };
}

app.post("/api/import/items/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No item rows found in the CSV file." });
    const chunkMode = Boolean(req.body?.chunkMode);
    const totalRows = Number(req.body?.totalRows) || rows.length;
    const planCheckItems = checkImportAccess(userData.user, "items", totalRows);
    if (!planCheckItems.allowed) return res.status(403).json({ error: planCheckItems.error, planError: true });
    if (totalRows > 500000) return res.status(400).json({ error: "Import a maximum of 500000 items per CSV file." });
    const normalizedRows = rows.map((row, i) => normalizeItemRow(row, i, 0));
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "items.csv"),
      status: chunkMode ? "collecting" : "queued",
      total: chunkMode ? totalRows : normalizedRows.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentItemCode: "",
      results: [],
      rows: normalizedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    itemsImportJobStore.set(job.id, job);
    if (!chunkMode) {
      const invalidRow = normalizedRows.find((row) => !row.code || !row.name);
      if (invalidRow) {
        itemsImportJobStore.delete(job.id);
        return res.status(400).json({ error: `Row ${invalidRow.rowNumber}: Code and Name are required.` });
      }
      setTimeout(() => {
        processItemsImportJob(job).catch((err) => {
          job.status = "error";
          job.error = err.message;
          job.finishedAt = Date.now();
          job.updatedAt = Date.now();
        });
      }, 0);
    }
    return res.json({ ok: true, jobId: job.id, status: job.status, total: job.total });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/import/items/append/:jobId", (req, res) => {
  try {
    const job = itemsImportJobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "collecting") return res.status(400).json({ error: "Job is not in collecting state" });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const offset = job.rows.length;
    job.rows.push(...rows.map((row, i) => normalizeItemRow(row, i, offset)));
    job.updatedAt = Date.now();
    return res.json({ ok: true, jobId: job.id, received: job.rows.length });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post("/api/import/items/finalize/:jobId", (req, res) => {
  try {
    const job = itemsImportJobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "collecting") return res.status(400).json({ error: "Job is not in collecting state" });
    const invalidRow = job.rows.find((row) => !row.code || !row.name);
    if (invalidRow) {
      itemsImportJobStore.delete(job.id);
      return res.status(400).json({ error: `Row ${invalidRow.rowNumber}: Code and Name are required.` });
    }
    job.total = job.rows.length;
    job.status = "queued";
    job.updatedAt = Date.now();
    setTimeout(() => {
      processItemsImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildItemsImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/items/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = itemsImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Items import job not found" });
  if (!ownsItemsImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildItemsImportStatus(job) });
});

app.post("/api/import/customers/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No customer rows found in the CSV file." });
    const planCheckCust = checkImportAccess(userData.user, "customers", rows.length);
    if (!planCheckCust.allowed) return res.status(403).json({ error: planCheckCust.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Import a maximum of 50000 customers per CSV file." });
    const normalizedRows = rows.map((row, index) => ({
      rowNumber: Number(row.rowNumber) || index + 2,
      name: String(row.name || "").trim(),
      firstName: String(row.firstName || "").trim(),
      lastName: String(row.lastName || "").trim(),
      emailAddress: String(row.emailAddress || "").trim(),
      accountNumber: String(row.accountNumber || "").trim(),
      taxNumber: String(row.taxNumber || "").trim(),
      website: String(row.website || "").trim(),
      phone: String(row.phone || "").trim(),
      addressLine1: String(row.addressLine1 || "").trim(),
      addressLine2: String(row.addressLine2 || "").trim(),
      city: String(row.city || "").trim(),
      region: String(row.region || "").trim(),
      postalCode: String(row.postalCode || "").trim(),
      country: String(row.country || "").trim(),
    }));
    const invalidRow = normalizedRows.find((row) => !row.name);
    if (invalidRow) {
      return res.status(400).json({ error: `Row ${invalidRow.rowNumber}: Name is required.` });
    }
    normalizedRows.forEach((row) => buildContactFromImportRow(row));
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "customers.csv"),
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentContactName: "",
      results: [],
      rows: normalizedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    customersImportJobStore.set(job.id, job);
    setTimeout(() => {
      processCustomersImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildCustomersImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/customers/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = customersImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Customers import job not found" });
  if (!ownsCustomersImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildCustomersImportStatus(job) });
});

app.post("/api/import/vendors/start", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = req.header("x-tenant-id") || req.body?.tenantId;
    if (!tenantId) return res.status(400).json({ error: "Tenant ID is required." });
    const rawRows = req.body?.rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return res.status(400).json({ error: "No rows provided." });
    }
    const planCheckVend = checkImportAccess(userData.user, "vendors", rawRows.length);
    if (!planCheckVend.allowed) return res.status(403).json({ error: planCheckVend.error, planError: true });
    if (rawRows.length > 50000) {
      return res.status(400).json({ error: "Maximum 50000 rows per import." });
    }
    const normalizedRows = rawRows.map((row, idx) => ({
      rowNumber: row.rowNumber || idx + 2,
      name: String(row.name || "").trim(),
      firstName: String(row.firstName || "").trim(),
      lastName: String(row.lastName || "").trim(),
      emailAddress: String(row.emailAddress || "").trim(),
      accountNumber: String(row.accountNumber || "").trim(),
      taxNumber: String(row.taxNumber || "").trim(),
      website: String(row.website || "").trim(),
      phone: String(row.phone || "").trim(),
      addressLine1: String(row.addressLine1 || "").trim(),
      addressLine2: String(row.addressLine2 || "").trim(),
      city: String(row.city || "").trim(),
      region: String(row.region || "").trim(),
      postalCode: String(row.postalCode || "").trim(),
      country: String(row.country || "").trim(),
    }));
    const invalidRow = normalizedRows.find((row) => !row.name);
    if (invalidRow) {
      return res.status(400).json({ error: `Row ${invalidRow.rowNumber}: Name is required.` });
    }
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "vendors.csv"),
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentContactName: "",
      results: [],
      rows: normalizedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    vendorsImportJobStore.set(job.id, job);
    setTimeout(() => {
      processVendorsImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildVendorsImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/vendors/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = vendorsImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Vendors import job not found" });
  if (!ownsVendorsImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildVendorsImportStatus(job) });
});

app.post("/api/import/tracking-categories/start", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = req.header("x-tenant-id") || req.body?.tenantId;
    if (!tenantId) return res.status(400).json({ error: "Tenant ID is required." });
    const rawRows = req.body?.rows;
    if (!Array.isArray(rawRows) || rawRows.length === 0) {
      return res.status(400).json({ error: "No rows provided." });
    }
    const planCheckTC = checkImportAccess(userData.user, "tracking-categories", rawRows.length);
    if (!planCheckTC.allowed) return res.status(403).json({ error: planCheckTC.error, planError: true });
    if (rawRows.length > 2000) {
      return res.status(400).json({ error: "Maximum 2000 rows per import." });
    }
    const normalizedRows = rawRows.map((row, idx) => ({
      rowNumber: row.rowNumber || idx + 2,
      categoryName: String(row.categoryName || "").trim(),
      optionName: String(row.optionName || "").trim(),
      status: String(row.status || "").trim().toUpperCase() || "ACTIVE",
    }));
    const invalidRow = normalizedRows.find((row) => !row.categoryName || !row.optionName);
    if (invalidRow) {
      return res.status(400).json({ error: `Row ${invalidRow.rowNumber}: Category Name and Option Name are required.` });
    }
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "tracking-categories.csv"),
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentCategoryName: "",
      currentOptionName: "",
      results: [],
      rows: normalizedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    trackingCategoryImportJobStore.set(job.id, job);
    setTimeout(() => {
      processTrackingCategoryImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildTrackingCategoryImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/tracking-categories/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = trackingCategoryImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Tracking categories import job not found" });
  if (!ownsTrackingCategoryImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildTrackingCategoryImportStatus(job) });
});

// ── Global Xero rate-limit tracker ───────────────────────────────────────────
const _xeroRateLimitInfo = { active: false, reason: "", waitUntil: 0 };
function getGlobalRateLimitInfo() {
  if (_xeroRateLimitInfo.active && _xeroRateLimitInfo.waitUntil > Date.now()) {
    return { active: true, reason: _xeroRateLimitInfo.reason, waitUntil: _xeroRateLimitInfo.waitUntil, remainingSecs: Math.ceil((_xeroRateLimitInfo.waitUntil - Date.now()) / 1000) };
  }
  return null;
}
// Inject rateLimited field into all /api/import/*/status responses automatically
app.use((req, res, next) => {
  if (/\/api\/import\/.+\/status/.test(req.path)) {
    const _origJson = res.json.bind(res);
    res.json = (body) => {
      if (body && body.ok) body.rateLimited = getGlobalRateLimitInfo();
      return _origJson(body);
    };
  }
  next();
});

function buildBillsImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    warnings: job.warnings || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentBillNumber: job.currentBillNumber || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
    historyId: job.historyId || "",
    apiCalls: job.apiCalls || { batch: 0, fallback: 0 },
  };
}

function ownsBillsImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

// Set to true when importing MM/DD/YYYY format CSVs (US style)
let _forceMDY = false;

function parseDateForXero(value, forceMDY = _forceMDY) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const toYMD = (y, m, d) => {
    const year = String(y).length === 2 ? 2000 + Number(y) : Number(y);
    const yr = Number(year);
    const mo = Number(m);
    const dy = Number(d);
    if (yr < 1900 || yr > 2100 || mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    return `${yr}-${String(mo).padStart(2, "0")}-${String(dy).padStart(2, "0")}`;
  };

  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  // Excel serial number (integer 1–100000, covers dates 1900–2173)
  if (/^\d+$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial > 0 && serial < 100000) {
      // Excel epoch: Dec 30, 1899 = day 0 (with the off-by-one leap year bug)
      const msFromEpoch = (serial - 25569) * 86400000;
      const d = new Date(msFromEpoch);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }

  // X/Y/YYYY — auto-detect DD/MM vs MM/DD
  // Rule: if first part > 12 → must be day (DD/MM); if second part > 12 → must be month (MM/DD)
  // If both ≤ 12 → use forceMDY preference (passed per-job), default DD/MM
  let r = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (r) {
    const a = Number(r[1]), b = Number(r[2]);
    if (a > 12) return toYMD(r[3], r[2], r[1]); // a can't be month → DD/MM
    if (b > 12) return toYMD(r[3], r[1], r[2]); // b can't be month → MM/DD
    return forceMDY ? toYMD(r[3], r[1], r[2]) : toYMD(r[3], r[2], r[1]); // use preference
  }

  // X.Y.YYYY — same logic
  r = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (r) {
    const a = Number(r[1]), b = Number(r[2]);
    if (a > 12) return toYMD(r[3], r[2], r[1]);
    if (b > 12) return toYMD(r[3], r[1], r[2]);
    return forceMDY ? toYMD(r[3], r[1], r[2]) : toYMD(r[3], r[2], r[1]);
  }

  // X-Y-YYYY — same logic (but skip if looks like YYYY-MM-DD already caught above)
  r = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
  if (r) {
    const a = Number(r[1]), b = Number(r[2]);
    if (a > 12) return toYMD(r[3], r[2], r[1]);
    if (b > 12) return toYMD(r[3], r[1], r[2]);
    return forceMDY ? toYMD(r[3], r[1], r[2]) : toYMD(r[3], r[2], r[1]);
  }

  // YYYY/MM/DD
  r = trimmed.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (r) return toYMD(r[1], r[2], r[3]);

  // "01-Apr-20" or "01-Apr-2020" (DD-MMM-YY or DD-MMM-YYYY)
  r = trimmed.match(/^(\d{1,2})-([A-Za-z]{3,})-(\d{2,4})$/);
  if (r) {
    const mon = MONTHS[r[2].toLowerCase().slice(0, 3)];
    if (mon) return toYMD(r[3], mon, r[1]);
  }

  // "30 Apr 2025" or "30 Apr 25"
  r = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{2,4})$/);
  if (r) {
    const mon = MONTHS[r[2].toLowerCase().slice(0, 3)];
    if (mon) return toYMD(r[3], mon, r[1]);
  }

  // "Apr 30, 2025" or "April 30 2025"
  r = trimmed.match(/^([A-Za-z]{3,})\s+(\d{1,2})[,\s]+(\d{2,4})$/);
  if (r) {
    const mon = MONTHS[r[1].toLowerCase().slice(0, 3)];
    if (mon) return toYMD(r[3], mon, r[2]);
  }

  // Strip time from datetime strings like "2026-08-05 00:00:00" or "2026-08-05T00:00:00"
  const dtMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})[T\s]/);
  if (dtMatch) return dtMatch[1];

  // Last resort: JS Date parser — use UTC methods to avoid IST timezone offset
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) {
    const yr = d.getUTCFullYear();
    if (yr >= 1900 && yr <= 2100) {
      return `${yr}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    }
  }

  return null;
}

function isSkippedTaxType(normalized) {
  return ["novat", "notvat", "novax", "na", "n/a", "nil", "nocharge", "notaxable", "notax", "notapplicable"].includes(normalized);
}

// If the sheet gives an explicit Tax Amount, use it exactly — don't let Xero recalculate
// it from the Tax Type rate. If Tax Amount is blank, fall back to Tax Type so Xero
// calculates tax itself. UnitAmount/LineAmount are untouched either way.
// Exception: never send TaxAmount=0 when a real TaxType is also set — Xero will treat
// 0 as an override and create a negative "Adjustments to Tax" entry instead of
// calculating the correct tax. Zero here almost always means "column was left blank."
function applyTaxToLineItem(lineItem, row, { negate = false, abs = false } = {}) {
  const taxType = String(row.taxType || "").trim();
  const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
  if (taxType && !isSkippedTaxType(normalizedTax)) {
    lineItem.TaxType = taxType;
  }

  const taxAmountRaw = String(row.taxAmount ?? "").trim();
  const taxAmountNum = Number(taxAmountRaw);
  if (taxAmountRaw !== "" && Number.isFinite(taxAmountNum)) {
    const finalAmount = abs ? Math.abs(taxAmountNum) : (negate ? -taxAmountNum : taxAmountNum);
    // Skip explicit zero when TaxType is present — let Xero calculate the correct tax.
    // Sending TaxAmount=0 with a real TaxType causes Xero to show a negative adjustment.
    if (finalAmount !== 0 || !lineItem.TaxType) {
      lineItem.TaxAmount = finalAmount;
    }
  }
}

function buildBillPayloadFromRows(billNumber, rows, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SUBMITTED", "AUTHORISED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const invoice = {
    Type: "ACCPAY",
    Contact: { Name: String(firstRow.contactName || "").trim() },
    Status: finalStatus,
    LineItems: [],
  };
  if (billNumber) invoice.InvoiceNumber = String(billNumber).trim();
  const billDate = parseDateForXero(firstRow.billDate, forceMDY);
  if (billDate) invoice.Date = billDate;
  const dueDate = parseDateForXero(firstRow.dueDate, forceMDY);
  if (dueDate) invoice.DueDate = dueDate;
  if (firstRow.reference) invoice.Reference = String(firstRow.reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) invoice.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) invoice.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qtyRaw = String(row.quantity || "").trim();
    const qty = Number(qtyRaw);
    if (qtyRaw && Number.isFinite(qty)) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    applyTaxToLineItem(lineItem, row);
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1) {
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    }
    if (row.trackingName2 && row.trackingOption2) {
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    }
    if (tracking.length) lineItem.Tracking = tracking;
    invoice.LineItems.push(lineItem);
  });
  return invoice;
}

function buildBillCreditNotePayloadFromRows(creditNoteNumber, rows, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SUBMITTED", "AUTHORISED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const creditNote = {
    Type: "ACCPAYCREDIT",
    Contact: { Name: String(firstRow.contactName || "").trim() },
    Status: finalStatus,
    LineItems: [],
  };
  if (creditNoteNumber) creditNote.CreditNoteNumber = String(creditNoteNumber).trim();
  const date = parseDateForXero(firstRow.billDate, forceMDY);
  if (date) creditNote.Date = date;
  if (firstRow.reference) creditNote.Reference = String(firstRow.reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) creditNote.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) creditNote.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qtyRaw = String(row.quantity || "").trim();
    const qty = Number(qtyRaw);
    if (qtyRaw && Number.isFinite(qty)) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = -unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    applyTaxToLineItem(lineItem, row, { negate: true });
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1)
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    if (row.trackingName2 && row.trackingOption2)
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    if (tracking.length) lineItem.Tracking = tracking;
    creditNote.LineItems.push(lineItem);
  });
  return creditNote;
}

async function submitBillCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload }) {
  const requestUrl = "https://api.xero.com/api.xro/2.0/CreditNotes?summarizeErrors=false";
  const idempotencyKey = crypto.randomBytes(16).toString("hex");
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ CreditNotes: [creditNotePayload] }),
    });
    return { response };
  });
  const created = result.response.data?.CreditNotes?.[0] || {};
  const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
  return { created, errors, resolvedSessionId: result.resolvedSessionId };
}

async function createBillCreditNoteInXero({ tenantId, requestedSessionId, creditNoteNumber, rows }) {
  const creditNote = buildBillCreditNotePayloadFromRows(creditNoteNumber, rows);
  let { created, errors, resolvedSessionId } = await submitBillCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload: creditNote });
  if ((created.StatusAttributeString === "ERROR" || errors.length) && isTaxTypeError(errors)) {
    const noTax = { ...creditNote, LineItems: creditNote.LineItems.map(({ TaxType, TaxAmount, ...rest }) => rest) };
    ({ created, errors, resolvedSessionId } = await submitBillCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload: noTax }));
  }
  if (created.StatusAttributeString === "ERROR" || errors.length) {
    throw new Error(errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this bill credit note.");
  }
  return { creditNote: created, sessionId: resolvedSessionId };
}

async function fetchTaxRatesForImport({ tenantId, requestedSessionId }) {
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry("https://api.xero.com/api.xro/2.0/TaxRates", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
    });
    return { response };
  });
  const rates = Array.isArray(result.response.data?.TaxRates) ? result.response.data.TaxRates : [];
  // Build name→code map (lowercase display name → TaxType code)
  const nameToCode = new Map();
  for (const r of rates) {
    if (r.TaxType && r.Name) nameToCode.set(String(r.Name).trim().toLowerCase(), String(r.TaxType).trim());
  }
  return { nameToCode, sessionId: result.resolvedSessionId };
}

const NO_TAX_SYNONYMS = new Set(["no tax", "notax", "none", "n/a", "not applicable", "tax exempt", "exempt"]);

function resolveTaxType(taxType, nameToCode) {
  const raw = String(taxType || "").trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  const mapped = nameToCode.get(lower);
  if (mapped) return mapped;
  // Common "no tax" phrasing that doesn't match any configured rate name by exact text —
  // "NONE" is Xero's universal code for this and works regardless of org-specific rate names.
  if (NO_TAX_SYNONYMS.has(lower)) return "NONE";
  return raw;
}

function isTaxTypeError(errors) {
  return errors.some((e) =>
    (e.Message || e.Description || "").toLowerCase().includes("taxtype")
  );
}

function isDuplicateError(errors) {
  return errors.some((e) => {
    const msg = (e.Message || e.Description || "").toLowerCase();
    return msg.includes("already exists") || msg.includes("duplicate");
  });
}

function isLockedStatusError(errors) {
  return errors.some((e) => {
    const msg = (e.Message || e.Description || "").toLowerCase();
    return msg.includes("not of valid status for modification");
  });
}

async function submitInvoiceToXero({ tenantId, requestedSessionId, invoicePayload }) {
  const requestUrl = "https://api.xero.com/api.xro/2.0/Invoices?summarizeErrors=false";
  const idempotencyKey = crypto.randomBytes(16).toString("hex");
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ Invoices: [invoicePayload] }),
    });
    return { response };
  });
  const created = result.response.data?.Invoices?.[0] || {};
  const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
  return { created, errors, resolvedSessionId: result.resolvedSessionId };
}

async function createBillInXero({ tenantId, requestedSessionId, billNumber, rows }) {
  const invoice = buildBillPayloadFromRows(billNumber, rows);

  let { created, errors, resolvedSessionId } = await submitInvoiceToXero({
    tenantId,
    requestedSessionId,
    invoicePayload: invoice,
  });

  let taxTypeStripped = false;
  if ((created.StatusAttributeString === "ERROR" || errors.length) && isTaxTypeError(errors)) {
    const invoiceNoTax = {
      ...invoice,
      LineItems: invoice.LineItems.map(({ TaxType, TaxAmount, ...rest }) => rest),
    };
    ({ created, errors, resolvedSessionId } = await submitInvoiceToXero({
      tenantId,
      requestedSessionId,
      invoicePayload: invoiceNoTax,
    }));
    taxTypeStripped = true;
  }

  if (created.StatusAttributeString === "ERROR" || errors.length) {
    throw new Error(
      errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this bill."
    );
  }
  return { invoice: created, sessionId: resolvedSessionId, taxTypeStripped };
}

// Returns a Map of lowercased document numbers → Xero ID for existing docs
async function fetchExistingDocIds(job, numbers, resource) {
  const idMap = new Map();
  if (!numbers.length) return idMap;
  const BATCH = 100;
  const configs = {
    "Invoices-ACCPAY": { key: "Invoices",       numField: "InvoiceNumber",       idField: "InvoiceID",       url: (b) => `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${b.map(encodeURIComponent).join(",")}&Type=ACCPAY` },
    "Invoices-ACCREC": { key: "Invoices",       numField: "InvoiceNumber",       idField: "InvoiceID",       url: (b) => `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${b.map(encodeURIComponent).join(",")}&Type=ACCREC` },
    "CreditNotes":     { key: "CreditNotes",    numField: "CreditNoteNumber",    idField: "CreditNoteID",    url: (b) => `https://api.xero.com/api.xro/2.0/CreditNotes?CreditNoteNumbers=${b.map(encodeURIComponent).join(",")}` },
    "PurchaseOrders":  { key: "PurchaseOrders", numField: "PurchaseOrderNumber", idField: "PurchaseOrderID", url: (b) => `https://api.xero.com/api.xro/2.0/PurchaseOrders?PurchaseOrderNumbers=${b.map(encodeURIComponent).join(",")}` },
    "Quotes":          { key: "Quotes",         numField: "QuoteNumber",         idField: "QuoteID",         url: (b) => `https://api.xero.com/api.xro/2.0/Quotes?where=${encodeURIComponent(b.map(n => `QuoteNumber=="${String(n).replace(/"/g, "")}"`).join("||"))}` },
  };
  const cfg = configs[resource];
  if (!cfg) return idMap;
  for (let i = 0; i < numbers.length; i += BATCH) {
    const batch = numbers.slice(i, i + BATCH).filter(Boolean);
    if (!batch.length) continue;
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(cfg.url(batch), {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
        });
        return { items: data?.[cfg.key] || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const item of (r.items || [])) {
        const num = item[cfg.numField];
        const id = item[cfg.idField];
        if (num && id) idMap.set(String(num).toLowerCase(), id);
      }
    } catch (_) {}
  }
  return idMap;
}

// Returns a Set of lowercased document numbers that already exist in Xero
async function fetchExistingDocNumbers(job, numbers, resource, invoiceType) {
  const existing = new Set();
  if (!numbers.length) return existing;
  const BATCH = 100;
  for (let i = 0; i < numbers.length; i += BATCH) {
    const batch = numbers.slice(i, i + BATCH).filter(Boolean);
    if (!batch.length) continue;
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        let url;
        if (resource === "Invoices") {
          url = `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${batch.map(encodeURIComponent).join(",")}${invoiceType ? `&Type=${invoiceType}` : ""}`;
        } else if (resource === "PurchaseOrders") {
          url = `https://api.xero.com/api.xro/2.0/PurchaseOrders?PurchaseOrderNumbers=${batch.map(encodeURIComponent).join(",")}`;
        } else if (resource === "Quotes") {
          const whereClause = batch.map(n => `QuoteNumber=="${String(n).replace(/"/g, "")}"`).join("||");
          url = `https://api.xero.com/api.xro/2.0/Quotes?where=${encodeURIComponent(whereClause)}`;
        }
        const { data } = await fetchWithRetry(url, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
        });
        const fieldMap = { Invoices: "InvoiceNumber", PurchaseOrders: "PurchaseOrderNumber", Quotes: "QuoteNumber" };
        const items = data?.[resource] || [];
        return { items, field: fieldMap[resource] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      console.log(`[DupCheck] Xero returned ${(r.items||[]).length} items for batch of ${batch.length} numbers (resource=${resource}, type=${invoiceType||"n/a"})`);
      for (const item of (r.items || [])) {
        const num = item[r.field];
        const status = (item.Status || "").toUpperCase();
        const excluded = status === "VOIDED" || status === "DELETED" || status === "DRAFT";
        console.log(`[DupCheck]   "${num}" status="${status}" → ${excluded ? "IGNORED (excluded status)" : "MARKED AS EXISTING → will SKIP"}`);
        // Exclude VOIDED, DELETED, and DRAFT — Xero API returns all statuses but user only sees AUTHORISED
        // bills in the main Bills view. DRAFT bills from failed imports should be re-importable.
        if (num && !excluded) {
          existing.add(String(num).toLowerCase());
        }
      }
    } catch (err) {
      console.log(`[DupCheck] ERROR in batch: ${err.message}`);
    }
  }
  return existing;
}

async function processBillsImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  writeJobCheckpoint(job, "bills");
  const BATCH_SIZE = 50;

  // Pre-fetch tax rates to resolve display names (e.g. "20% (VAT on Expenses)" → "INPUT2")
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) { /* proceed without resolution */ }

  const resolveTax = (rows) => rows.map((r) => ({ ...r, taxType: resolveTaxType(r.taxType, taxNameToCode) }));

  const CONCURRENCY = 2;

  // Pre-flight: scan Xero for DELETED/VOIDED bill numbers before batching
  const deletedOrVoidedSet = new Set();
  const existingBillIdMap = new Map(); // billNumber.lower → InvoiceID (used in updateMode)
  {
    const _allNums = [...new Set([
      ...(job.billGroups || []).map(g => g.billNumber),
      ...(job.billCreditNoteGroups || []).map(g => g.billNumber),
    ].filter(Boolean))];
    if (_allNums.length && !job.cancelRequested) {
      try {
        const PRE_BATCH = 100;
        for (let pi = 0; pi < _allNums.length && !job.cancelRequested; pi += PRE_BATCH) {
          const pBatch = _allNums.slice(pi, pi + PRE_BATCH);
          const pr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${pBatch.map(encodeURIComponent).join(",")}&Type=ACCPAY`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
            );
            return { invoices: data?.Invoices || [] };
          });
          if (pr.resolvedSessionId) job.sessionId = pr.resolvedSessionId;
          for (const inv of (pr.invoices || [])) {
            const st = (inv.Status || "").toUpperCase();
            if (st === "VOIDED") {
              deletedOrVoidedSet.add(String(inv.InvoiceNumber || "").toLowerCase());
              console.log(`[PreFlight] "${inv.InvoiceNumber}" is VOIDED in Xero → pre-erroring with restore hint`);
            } else if (st === "DELETED") {
              console.log(`[PreFlight] "${inv.InvoiceNumber}" is DELETED in Xero → will attempt creation (Xero may allow reuse)`);
            }
            if (inv.InvoiceID && inv.InvoiceNumber) {
              existingBillIdMap.set(String(inv.InvoiceNumber).toLowerCase(), inv.InvoiceID);
            }
          }
        }
      } catch (pErr) {
        console.log(`[PreFlight] Skipped deleted/voided scan: ${pErr.message}`);
      }
    }
  }

  const _preErrorBillGroup = (group, docType) => {
    job.errors += 1;
    group.rows.forEach(row => job.results.push({
      rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "",
      docType, status: "error",
      message: `Bill "${group.billNumber}" is deleted or voided in Xero — the same bill number cannot be reused. To fix: in Xero go to Bills to Pay → find this bill in Deleted/Voided view → click Restore → then re-import.`,
    }));
    job.processed += 1;
  };

  // Pass 1: bill groups (positive total) → /Invoices as ACCPAY
  const billGroups = (() => {
    const active = [];
    for (const g of (job.billGroups || [])) {
      if (deletedOrVoidedSet.has((g.billNumber || "").toLowerCase())) _preErrorBillGroup(g, "Bill");
      else active.push(g);
    }
    return active;
  })();
  const runBillBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => {
        const p = buildBillPayloadFromRows(g.billNumber, resolveTax(g.rows), job.forceMDY || false);
        if (job.updateMode) { const xid = existingBillIdMap.get((g.billNumber || "").toLowerCase()); if (xid) p.InvoiceID = xid; }
        return p;
      });
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|bills|" + batch.map(g => g.billNumber).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Invoices?summarizeErrors=false", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": job.tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": batchIdempotencyKey,
          },
          body: JSON.stringify({ Invoices: payloads }),
        });
        return { invoices: data?.Invoices || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (job.apiCalls) job.apiCalls.batch += 1;
      const xeroInvoices = result.invoices || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xi = xeroInvoices[j] || {};
        const errors = Array.isArray(xi.ValidationErrors) ? xi.ValidationErrors : [];
        const warnings = Array.isArray(xi.Warnings) ? xi.Warnings : [];
        if (xi.StatusAttributeString === "WARNING") {
          job.created += 1;
          const warnMsg = warnings.map(w => w.Message).filter(Boolean).join("; ") || "Some fields could not be changed on this AUTHORISED bill.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: "updated", message: `Bill updated (AUTHORISED — some fields restricted): ${warnMsg}`, invoiceId: xi?.InvoiceID || "" }));
        } else if ((xi.StatusAttributeString === "ERROR" || errors.length) && isDuplicateError(errors)) {
          if (job.updateMode) {
            job.errors += 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: "error", message: `Bill "${group.billNumber}" could not be updated — check that the bill number exists in Xero and is not in a locked period.` }));
          } else {
            job.skipped = (job.skipped || 0) + 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: "skipped", message: `Bill "${group.billNumber}" already exists in Xero — skipped.` }));
          }
        } else if (xi.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const rawMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this bill.";
          const msg = isLockedStatusError(errors)
            ? `Bill "${group.billNumber}" was previously deleted or voided in Xero — the same bill number cannot be reused. Please use a different bill number in your CSV.`
            : rawMsg;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: "error", message: msg }));
        } else {
          job.created += 1;
          const successMsg = job.updateMode ? "Bill updated successfully." : "Bill created successfully.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: job.updateMode ? "updated" : "created", message: successMsg, invoiceId: xi?.InvoiceID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < billGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = billGroups[i]?.rows[0]?.rowNumber || null;
    job.currentBillNumber = billGroups[i]?.billNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch bills ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, billGroups.length)}/${job.total} (2 concurrent)`);
    const bPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= billGroups.length) break;
      bPromises.push(runBillBatch(billGroups.slice(start, Math.min(start + BATCH_SIZE, billGroups.length))));
    }
    await Promise.all(bPromises);
  }

  // Pass 2: bill credit note groups (negative total) → /CreditNotes as ACCPAYCREDIT
  const billCreditNoteGroups = (() => {
    const active = [];
    for (const g of (job.billCreditNoteGroups || [])) {
      if (deletedOrVoidedSet.has((g.billNumber || "").toLowerCase())) _preErrorBillGroup(g, "Bill Credit Note");
      else active.push(g);
    }
    return active;
  })();
  const runBillCNBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => buildBillCreditNotePayloadFromRows(g.billNumber, resolveTax(g.rows), job.forceMDY || false));
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|bill-cn|" + batch.map(g => g.billNumber).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/CreditNotes?summarizeErrors=false", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": job.tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": batchIdempotencyKey,
          },
          body: JSON.stringify({ CreditNotes: payloads }),
        });
        return { creditNotes: data?.CreditNotes || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (job.apiCalls) job.apiCalls.batch += 1;
      const xeroNotes = result.creditNotes || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xn = xeroNotes[j] || {};
        const errors = Array.isArray(xn.ValidationErrors) ? xn.ValidationErrors : [];
        if (xn.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const rawMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this bill credit note.";
          const msg = isLockedStatusError(errors)
            ? `Bill Credit Note "${group.billNumber}" was previously deleted or voided in Xero — the same number cannot be reused. Please use a different number in your CSV.`
            : rawMsg;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill Credit Note", status: "error", message: msg }));
        } else {
          job.created += 1;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill Credit Note", status: "created", message: "Bill Credit Note created successfully.", invoiceId: xn?.CreditNoteID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, billNumber: group.billNumber, contactName: row.contactName || "", docType: "Bill Credit Note", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < billCreditNoteGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = billCreditNoteGroups[i]?.rows[0]?.rowNumber || null;
    job.currentBillNumber = billCreditNoteGroups[i]?.billNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch bill-credit-notes ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, billCreditNoteGroups.length)}/${job.total} (2 concurrent)`);
    const cnPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= billCreditNoteGroups.length) break;
      cnPromises.push(runBillCNBatch(billCreditNoteGroups.slice(start, Math.min(start + BATCH_SIZE, billCreditNoteGroups.length))));
    }
    await Promise.all(cnPromises);
  }

  job.currentRowNumber = null;
  job.currentBillNumber = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const createdIds = [...new Set(job.results.filter(r => r.invoiceId).map(r => r.invoiceId))];
  const histEntry = recordImportHistory({ importType: "bills", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds, note: job.note || "" });
  job.historyId = histEntry.id;
  writeJobCheckpoint(job, "bills");
}

app.post("/api/import/bills/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Select a Xero organisation before importing." });
    }
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ error: "No bill rows found in the CSV file." });
    }
    const planCheck = checkImportAccess(userData.user, "bills", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    if (rows.length > 200000) {
      return res.status(400).json({ error: "Import a maximum of 200000 bill line rows per CSV file." });
    }
    const billGroupMap = new Map();
    rows.forEach((row, index) => {
      const normalizedRow = {
        rowNumber: Number(row.rowNumber) || index + 2,
        billNumber: String(row.billNumber || "").trim(),
        contactName: String(row.contactName || "").trim(),
        billDate: String(row.billDate || "").trim(),
        dueDate: String(row.dueDate || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        exchangeRate: String(row.exchangeRate || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
        status: String(row.status || "DRAFT").trim(),
      };
      if (!billGroupMap.has(normalizedRow.billNumber)) {
        billGroupMap.set(normalizedRow.billNumber, []);
      }
      billGroupMap.get(normalizedRow.billNumber).push(normalizedRow);
    });
    const billGroups = [];
    const billCreditNoteGroups = [];
    billGroupMap.forEach((groupRows, billNumber) => {
      // auto-detect: sum all (qty * unitAmount) — negative total = Bill Credit Note (ACCPAYCREDIT)
      const total = groupRows.reduce((sum, r) => {
        const qty = Number(r.quantity) || 1;
        const amt = Number(r.unitAmount) || 0;
        return sum + qty * amt;
      }, 0);
      if (total < 0) {
        billCreditNoteGroups.push({ billNumber, rows: groupRows });
      } else {
        billGroups.push({ billNumber, rows: groupRows });
      }
    });
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "purchase-bills.csv"),
      status: "queued",
      total: billGroups.length + billCreditNoteGroups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentBillNumber: "",
      results: [],
      billGroups,
      billCreditNoteGroups,
      skipDuplicateCheck: req.body?.skipDuplicateCheck === true,
      updateMode: req.body?.updateMode === true,
      note: extractJobNote(req),
      apiCalls: { batch: 0, fallback: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    billsImportJobStore.set(job.id, job);
    setTimeout(() => {
      processBillsImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildBillsImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/bills/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  const jobId = String(req.query.jobId || "").trim();
  const job = billsImportJobStore.get(jobId);
  if (!job) {
    const cp = _interruptedCheckpoints.find(c => c.id === jobId);
    if (cp) return res.json({ ok: true, status: cp.status, processed: cp.processed, total: cp.total, created: cp.created, errors: cp.errors, skipped: cp.skipped, error: cp.error, interrupted: true });
    return res.status(404).json({ error: "Bills import job not found" });
  }
  if (!ownsBillsImportJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json({ ok: true, ...buildBillsImportStatus(job) });
});

// ── Sales Invoice Import ──────────────────────────────────────────────────────

function buildInvoicesImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    warnings: job.warnings || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentInvoiceNumber: job.currentInvoiceNumber || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
    historyId: job.historyId || "",
    apiCalls: job.apiCalls || { batch: 0, fallback: 0 },
  };
}

function ownsInvoicesImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

function buildInvoicePayloadFromRows(invoiceNumber, rows, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SUBMITTED", "AUTHORISED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const invoice = {
    Type: "ACCREC",
    Contact: { Name: String(firstRow.contactName || "").trim() },
    Status: finalStatus,
    LineItems: [],
  };
  if (invoiceNumber) invoice.InvoiceNumber = String(invoiceNumber).trim();
  const invoiceDate = parseDateForXero(firstRow.invoiceDate, forceMDY);
  if (invoiceDate) invoice.Date = invoiceDate;
  const dueDate = parseDateForXero(firstRow.dueDate, forceMDY);
  if (dueDate) invoice.DueDate = dueDate;
  if (firstRow.reference) invoice.Reference = String(firstRow.reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) invoice.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) invoice.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qtyRaw = String(row.quantity || "").trim();
    const qty = Number(qtyRaw);
    if (qtyRaw && Number.isFinite(qty)) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    applyTaxToLineItem(lineItem, row);
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1) {
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    }
    if (row.trackingName2 && row.trackingOption2) {
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    }
    if (tracking.length) lineItem.Tracking = tracking;
    invoice.LineItems.push(lineItem);
  });
  return invoice;
}

async function createInvoiceInXero({ tenantId, requestedSessionId, invoiceNumber, rows }) {
  const invoice = buildInvoicePayloadFromRows(invoiceNumber, rows);
  let { created, errors, resolvedSessionId } = await submitInvoiceToXero({
    tenantId,
    requestedSessionId,
    invoicePayload: invoice,
  });
  let taxTypeStripped = false;
  if ((created.StatusAttributeString === "ERROR" || errors.length) && isTaxTypeError(errors)) {
    const invoiceNoTax = {
      ...invoice,
      LineItems: invoice.LineItems.map(({ TaxType, TaxAmount, ...rest }) => rest),
    };
    ({ created, errors, resolvedSessionId } = await submitInvoiceToXero({
      tenantId,
      requestedSessionId,
      invoicePayload: invoiceNoTax,
    }));
    taxTypeStripped = true;
  }
  if (created.StatusAttributeString === "ERROR" || errors.length) {
    throw new Error(
      errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this invoice."
    );
  }
  return { invoice: created, sessionId: resolvedSessionId, taxTypeStripped };
}

async function processInvoicesImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  writeJobCheckpoint(job, "invoices");
  const BATCH_SIZE = 50;

  // Pre-fetch tax rates to resolve display names (e.g. "20% (VAT on Income)" → "OUTPUT2")
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) { /* proceed without resolution */ }

  const resolveTax = (rows) => rows.map((r) => ({ ...r, taxType: resolveTaxType(r.taxType, taxNameToCode) }));

  const CONCURRENCY = 2;

  // Pre-flight: scan Xero for VOIDED/DELETED invoice numbers before batching
  const _invDeletedOrVoidedSet = new Set();
  const _invExistingIdMap = new Map(); // invoiceNumber.lower → InvoiceID (used in updateMode)
  {
    const _allInvNums = [...new Set([
      ...(job.invoiceGroups || []).map(g => g.invoiceNumber),
      ...(job.creditNoteGroups || []).map(g => g.creditNoteNumber),
    ].filter(Boolean))];
    if (_allInvNums.length && !job.cancelRequested) {
      try {
        const PRE_BATCH = 100;
        for (let pi = 0; pi < _allInvNums.length && !job.cancelRequested; pi += PRE_BATCH) {
          const pBatch = _allInvNums.slice(pi, pi + PRE_BATCH);
          const pr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${pBatch.map(encodeURIComponent).join(",")}&Type=ACCREC`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
            );
            return { invoices: data?.Invoices || [] };
          });
          if (pr.resolvedSessionId) job.sessionId = pr.resolvedSessionId;
          for (const inv of (pr.invoices || [])) {
            const st = (inv.Status || "").toUpperCase();
            if (st === "VOIDED") {
              _invDeletedOrVoidedSet.add(String(inv.InvoiceNumber || "").toLowerCase());
              console.log(`[PreFlight-INV] "${inv.InvoiceNumber}" is VOIDED → pre-erroring (number locked)`);
            }
            // DELETED invoices: Xero allows reusing the number — skip pre-error, let API attempt proceed
            if (inv.InvoiceID && inv.InvoiceNumber) {
              _invExistingIdMap.set(String(inv.InvoiceNumber).toLowerCase(), inv.InvoiceID);
            }
          }
        }
      } catch (pErr) {
        console.log(`[PreFlight-INV] Skipped deleted/voided scan: ${pErr.message}`);
      }
    }
  }

  const _preErrorInvGroup = (group, num, docType) => {
    job.errors += 1;
    group.rows.forEach(row => job.results.push({
      rowNumber: row.rowNumber, invoiceNumber: num, contactName: row.contactName || "",
      docType, status: "error",
      message: `Invoice "${num}" is voided in Xero — the same number cannot be reused. To fix: in Xero go to Sales → Invoices → view Voided → find it → click Restore → then re-import.`,
    }));
    job.processed += 1;
  };

  // Pass 1: invoice groups → /Invoices
  const invoiceGroups = (() => {
    const active = [];
    for (const g of (job.invoiceGroups || [])) {
      if (_invDeletedOrVoidedSet.has((g.invoiceNumber || "").toLowerCase())) _preErrorInvGroup(g, g.invoiceNumber, "Invoice");
      else active.push(g);
    }
    return active;
  })();
  const runInvoiceBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => {
        const p = buildInvoicePayloadFromRows(g.invoiceNumber, resolveTax(g.rows), job.forceMDY || false);
        if (job.updateMode) { const xid = _invExistingIdMap.get((g.invoiceNumber || "").toLowerCase()); if (xid) p.InvoiceID = xid; }
        return p;
      });
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|invoices|" + batch.map(g => g.invoiceNumber).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Invoices?summarizeErrors=false", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ Invoices: payloads }),
        });
        return { invoices: data?.Invoices || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (job.apiCalls) job.apiCalls.batch += 1;
      const xeroInvoices = result.invoices || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xi = xeroInvoices[j] || {};
        const errors = Array.isArray(xi.ValidationErrors) ? xi.ValidationErrors : [];
        const warnings = Array.isArray(xi.Warnings) ? xi.Warnings : [];
        if (xi.StatusAttributeString === "WARNING") {
          job.created += 1;
          const warnMsg = warnings.map(w => w.Message).filter(Boolean).join("; ") || "Some fields could not be changed on this AUTHORISED invoice.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: "updated", message: `Invoice updated (AUTHORISED — some fields restricted): ${warnMsg}`, invoiceId: xi?.InvoiceID || "" }));
        } else if ((xi.StatusAttributeString === "ERROR" || errors.length) && isDuplicateError(errors)) {
          if (job.updateMode) {
            job.errors += 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: "error", message: `Invoice "${group.invoiceNumber}" could not be updated — check that the invoice number exists in Xero and is not in a locked period.` }));
          } else {
            job.skipped = (job.skipped || 0) + 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: "skipped", message: `Invoice "${group.invoiceNumber}" already exists in Xero — skipped.` }));
          }
        } else if (xi.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const rawMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this invoice.";
          const msg = isLockedStatusError(errors)
            ? `Invoice "${group.invoiceNumber}" was previously deleted or voided in Xero — the same invoice number cannot be reused. Please use a different invoice number in your CSV.`
            : rawMsg;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: "error", message: msg }));
        } else {
          job.created += 1;
          const successMsg = job.updateMode ? "Invoice updated successfully." : "Invoice created successfully.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: job.updateMode ? "updated" : "created", message: successMsg, invoiceId: xi?.InvoiceID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.invoiceNumber, contactName: row.contactName || "", docType: "Invoice", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < invoiceGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = invoiceGroups[i]?.rows[0]?.rowNumber || null;
    job.currentInvoiceNumber = invoiceGroups[i]?.invoiceNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch invoices ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, invoiceGroups.length)}/${invoiceGroups.length} (2 concurrent)`);
    const iPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= invoiceGroups.length) break;
      iPromises.push(runInvoiceBatch(invoiceGroups.slice(start, Math.min(start + BATCH_SIZE, invoiceGroups.length))));
    }
    await Promise.all(iPromises);
  }

  // Pass 2: credit note groups → /CreditNotes
  const creditNoteGroups = (() => {
    const active = [];
    for (const g of (job.creditNoteGroups || [])) {
      if (_invDeletedOrVoidedSet.has((g.creditNoteNumber || "").toLowerCase())) _preErrorInvGroup(g, g.creditNoteNumber, "Credit Note");
      else active.push(g);
    }
    return active;
  })();
  const runInvoiceCNBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => buildCreditNotePayloadFromRows(g.creditNoteNumber, resolveTax(g.rows), job.forceMDY || false));
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|invoice-cn|" + batch.map(g => g.creditNoteNumber).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/CreditNotes?summarizeErrors=false", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ CreditNotes: payloads }),
        });
        return { creditNotes: data?.CreditNotes || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (job.apiCalls) job.apiCalls.batch += 1;
      const xeroNotes = result.creditNotes || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xn = xeroNotes[j] || {};
        const errors = Array.isArray(xn.ValidationErrors) ? xn.ValidationErrors : [];
        if ((xn.StatusAttributeString === "ERROR" || errors.length) && isDuplicateError(errors)) {
          job.skipped = (job.skipped || 0) + 1;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.creditNoteNumber, contactName: row.contactName || "", docType: "Credit Note", status: "skipped", message: `Credit Note "${group.creditNoteNumber}" already exists in Xero — skipped.` }));
        } else if (xn.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const rawMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this credit note.";
          const msg = isLockedStatusError(errors)
            ? `Credit Note "${group.creditNoteNumber}" was previously deleted or voided in Xero — the same number cannot be reused. Please use a different number in your CSV.`
            : rawMsg;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.creditNoteNumber, contactName: row.contactName || "", docType: "Credit Note", status: "error", message: msg }));
        } else {
          job.created += 1;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.creditNoteNumber, contactName: row.contactName || "", docType: "Credit Note", status: "created", message: "Credit Note created successfully.", invoiceId: xn?.CreditNoteID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, invoiceNumber: group.creditNoteNumber, contactName: row.contactName || "", docType: "Credit Note", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < creditNoteGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = creditNoteGroups[i]?.rows[0]?.rowNumber || null;
    job.currentInvoiceNumber = creditNoteGroups[i]?.creditNoteNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch credit-notes ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, creditNoteGroups.length)}/${creditNoteGroups.length} (2 concurrent)`);
    const cnPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= creditNoteGroups.length) break;
      cnPromises.push(runInvoiceCNBatch(creditNoteGroups.slice(start, Math.min(start + BATCH_SIZE, creditNoteGroups.length))));
    }
    await Promise.all(cnPromises);
  }

  job.currentRowNumber = null;
  job.currentInvoiceNumber = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const invCreatedIds = [...new Set(job.results.filter(r => r.invoiceId).map(r => r.invoiceId))];
  const invHistEntry = recordImportHistory({ importType: "invoices", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: invCreatedIds, note: job.note || "" });
  job.historyId = invHistEntry.id;
  writeJobCheckpoint(job, "invoices");
}

app.post("/api/reconcile/invoices", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows provided." });
    const requestedSessionId = req.header("x-session-id") || req.body?.sessionId;

    // Group exactly like the real Invoices import: same key, same invoice-vs-credit-note auto-detect.
    const groupMap = new Map();
    rows.forEach((row) => {
      const key = String(row.invoiceNumber || "").trim();
      if (!key) return;
      if (!groupMap.has(key)) groupMap.set(key, { lineCount: 0, total: 0 });
      const g = groupMap.get(key);
      const qty = Number(row.quantity) || 1;
      const amt = Number(row.unitAmount) || 0;
      g.lineCount += 1;
      g.total += qty * amt;
    });
    const expectedInvoices = new Map();
    const expectedCreditNotes = new Map();
    groupMap.forEach((g, number) => {
      if (g.total < 0) expectedCreditNotes.set(number, g);
      else expectedInvoices.set(number, g);
    });

    let sessionId = requestedSessionId;
    async function fetchAllPages(path, typeWhere) {
      const map = new Map();
      let page = 1;
      while (true) {
        const where = typeWhere ? `&where=${encodeURIComponent(typeWhere)}` : "";
        const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
          const response = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/${path}?page=${page}&pageSize=1000${where}`,
            { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
          );
          return { response };
        });
        if (result.resolvedSessionId) sessionId = result.resolvedSessionId;
        const collectionKey = path === "CreditNotes" ? "CreditNotes" : "Invoices";
        const records = result.response.data?.[collectionKey] || [];
        if (!records.length) break;
        for (const rec of records) {
          const num = String(rec.InvoiceNumber || rec.CreditNoteNumber || "").trim();
          if (!num) continue;
          map.set(num, {
            lineCount: Array.isArray(rec.LineItems) ? rec.LineItems.length : 0,
            total: rec.Total ?? rec.SubTotal ?? 0,
            status: rec.Status,
            id: rec.InvoiceID || rec.CreditNoteID,
          });
        }
        if (records.length < 1000) break;
        page++;
        await delay(350);
      }
      return map;
    }

    const actualInvoices = expectedInvoices.size ? await fetchAllPages("Invoices", 'Type=="ACCREC"') : new Map();
    const actualCreditNotes = expectedCreditNotes.size ? await fetchAllPages("CreditNotes", 'Type=="ACCRECCREDIT"') : new Map();

    const round2 = (n) => Math.round(n * 100) / 100;
    const mismatches = [];
    const compare = (expectedMap, actualMap, docType) => {
      expectedMap.forEach((expected, number) => {
        const actual = actualMap.get(number);
        if (!actual) {
          mismatches.push({ number, docType, status: "missing", expectedLines: expected.lineCount, expectedTotal: round2(expected.total), actualLines: 0, actualTotal: null });
          return;
        }
        const totalDiff = Math.abs(Math.abs(expected.total) - Math.abs(actual.total));
        if (actual.lineCount !== expected.lineCount || totalDiff > 0.05) {
          mismatches.push({ number, docType, status: "incomplete", expectedLines: expected.lineCount, expectedTotal: round2(expected.total), actualLines: actual.lineCount, actualTotal: actual.total, xeroStatus: actual.status, id: actual.id });
        }
      });
    };
    compare(expectedInvoices, actualInvoices, "Invoice");
    compare(expectedCreditNotes, actualCreditNotes, "Credit Note");

    return res.json({
      ok: true,
      totalChecked: expectedInvoices.size + expectedCreditNotes.size,
      mismatchCount: mismatches.length,
      mismatches,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/import/invoices/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheck = checkImportAccess(userData.user, "invoices", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    const groupMap = new Map();
    rows.forEach((row, index) => {
      const normalizedRow = {
        rowNumber: Number(row.rowNumber) || index + 2,
        invoiceNumber: String(row.invoiceNumber || "").trim(),
        contactName: String(row.contactName || "").trim(),
        invoiceDate: String(row.invoiceDate || "").trim(),
        creditNoteDate: String(row.invoiceDate || "").trim(),
        dueDate: String(row.dueDate || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        exchangeRate: String(row.exchangeRate || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
        status: String(row.status || "DRAFT").trim(),
      };
      const key = normalizedRow.invoiceNumber;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(normalizedRow);
    });
    const invoiceGroups = [];
    const creditNoteGroups = [];
    groupMap.forEach((groupRows, number) => {
      // auto-detect: sum all (qty * unitAmount) — negative total = Credit Note
      const total = groupRows.reduce((sum, r) => {
        const qty = Number(r.quantity) || 1;
        const amt = Number(r.unitAmount) || 0;
        return sum + qty * amt;
      }, 0);
      if (total < 0) {
        creditNoteGroups.push({ creditNoteNumber: number, rows: groupRows });
      } else {
        invoiceGroups.push({ invoiceNumber: number, rows: groupRows });
      }
    });
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "invoices.csv"),
      status: "queued",
      total: invoiceGroups.length + creditNoteGroups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentInvoiceNumber: "",
      results: [],
      invoiceGroups,
      creditNoteGroups,
      skipDuplicateCheck: req.body?.skipDuplicateCheck === true,
      updateMode: req.body?.updateMode === true,
      note: extractJobNote(req),
      apiCalls: { batch: 0, fallback: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    invoicesImportJobStore.set(job.id, job);
    setTimeout(() => {
      processInvoicesImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildInvoicesImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/invoices/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = invoicesImportJobStore.get(jobId);
  if (!job) {
    const cp = _interruptedCheckpoints.find(c => c.id === jobId);
    if (cp) return res.json({ ok: true, status: cp.status, processed: cp.processed, total: cp.total, created: cp.created, errors: cp.errors, skipped: cp.skipped, error: cp.error, interrupted: true });
    return res.status(404).json({ error: "Invoices import job not found" });
  }
  if (!ownsInvoicesImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildInvoicesImportStatus(job) });
});

// ── Credit Notes Import ─────────────────────────────────────────────────────

function buildCreditNotesImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    warnings: job.warnings || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentCreditNoteNumber: job.currentCreditNoteNumber || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

function ownsCreditNotesImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

function buildCreditNotePayloadFromRows(creditNoteNumber, rows, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SUBMITTED", "AUTHORISED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const creditNote = {
    Type: "ACCRECCREDIT",
    Contact: { Name: String(firstRow.contactName || "").trim() },
    Status: finalStatus,
    LineItems: [],
  };
  if (creditNoteNumber) creditNote.CreditNoteNumber = String(creditNoteNumber).trim();
  const date = parseDateForXero(firstRow.creditNoteDate, forceMDY);
  if (date) creditNote.Date = date;
  if (firstRow.reference) creditNote.Reference = String(firstRow.reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) creditNote.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) creditNote.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qtyRaw = String(row.quantity || "").trim();
    const qty = Number(qtyRaw);
    if (qtyRaw && Number.isFinite(qty)) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = -unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    applyTaxToLineItem(lineItem, row, { negate: true });
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1)
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    if (row.trackingName2 && row.trackingOption2)
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    if (tracking.length) lineItem.Tracking = tracking;
    creditNote.LineItems.push(lineItem);
  });
  return creditNote;
}

async function submitCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload }) {
  const requestUrl = "https://api.xero.com/api.xro/2.0/CreditNotes?summarizeErrors=false";
  const idempotencyKey = crypto.randomBytes(16).toString("hex");
  const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const response = await fetchWithRetry(requestUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ CreditNotes: [creditNotePayload] }),
    });
    return { response };
  });
  const created = result.response.data?.CreditNotes?.[0] || {};
  const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
  return { created, errors, resolvedSessionId: result.resolvedSessionId };
}

async function createCreditNoteInXero({ tenantId, requestedSessionId, creditNoteNumber, rows }) {
  const creditNote = buildCreditNotePayloadFromRows(creditNoteNumber, rows);
  let { created, errors, resolvedSessionId } = await submitCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload: creditNote });
  let taxTypeStripped = false;
  if ((created.StatusAttributeString === "ERROR" || errors.length) && isTaxTypeError(errors)) {
    const noTax = { ...creditNote, LineItems: creditNote.LineItems.map(({ TaxType, TaxAmount, ...rest }) => rest) };
    ({ created, errors, resolvedSessionId } = await submitCreditNoteToXero({ tenantId, requestedSessionId, creditNotePayload: noTax }));
    taxTypeStripped = true;
  }
  if (created.StatusAttributeString === "ERROR" || errors.length) {
    throw new Error(errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this credit note.");
  }
  return { creditNote: created, sessionId: resolvedSessionId, taxTypeStripped };
}

async function processCreditNotesImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  writeJobCheckpoint(job, "credit-notes");
  const BATCH_SIZE = 50;

  // Pre-fetch tax rates to resolve display names (e.g. "20% (VAT on Income)" → "OUTPUT2")
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) { /* proceed without resolution */ }

  const resolveTax = (rows) => rows.map((r) => ({ ...r, taxType: resolveTaxType(r.taxType, taxNameToCode) }));

  // In updateMode: pre-fetch CreditNoteIDs so we can inject them into POST payloads
  const existingCnIdMap = new Map();
  if (job.updateMode) {
    const allNums = (job.creditNoteGroups || []).map(g => g.creditNoteNumber).filter(Boolean);
    if (allNums.length) {
      const fetched = await fetchExistingDocIds(job, allNums, "CreditNotes");
      for (const [k, v] of fetched) existingCnIdMap.set(k, v);
    }
  }

  const CONCURRENCY = 2;
  const runCreditNoteBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => {
        const p = buildCreditNotePayloadFromRows(g.creditNoteNumber, resolveTax(g.rows), job.forceMDY || false);
        if (job.updateMode) { const xid = existingCnIdMap.get((g.creditNoteNumber || "").toLowerCase()); if (xid) p.CreditNoteID = xid; }
        return p;
      });
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|cn|" + batch.map(g => g.creditNoteNumber).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/CreditNotes?summarizeErrors=false", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ CreditNotes: payloads }),
        });
        return { creditNotes: data?.CreditNotes || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroNotes = result.creditNotes || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xn = xeroNotes[j] || {};
        const errors = Array.isArray(xn.ValidationErrors) ? xn.ValidationErrors : [];
        const warnings = Array.isArray(xn.Warnings) ? xn.Warnings : [];
        if (xn.StatusAttributeString === "WARNING") {
          job.created += 1;
          const warnMsg = warnings.map(w => w.Message).filter(Boolean).join("; ") || "Some fields could not be changed on this AUTHORISED credit note.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: "updated", message: `Credit Note updated (AUTHORISED — some fields restricted): ${warnMsg}`, creditNoteId: xn?.CreditNoteID || "" }));
        } else if ((xn.StatusAttributeString === "ERROR" || errors.length) && isDuplicateError(errors)) {
          if (job.updateMode) {
            job.errors += 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: "error", message: `Credit Note "${group.creditNoteNumber}" could not be updated — check that it exists in Xero and is not in a locked period.` }));
          } else {
            job.skipped = (job.skipped || 0) + 1;
            group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: "skipped", message: `Credit Note "${group.creditNoteNumber}" already exists in Xero — skipped.` }));
          }
        } else if (xn.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const rawMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this credit note.";
          const msg = isLockedStatusError(errors)
            ? `Credit Note "${group.creditNoteNumber}" was previously deleted or voided in Xero — the same credit note number cannot be reused. Please use a different number in your CSV.`
            : rawMsg;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: "error", message: msg }));
        } else {
          job.created += 1;
          const successMsg = job.updateMode ? "Credit Note updated successfully." : "Credit Note created successfully.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: job.updateMode ? "updated" : "created", message: successMsg, creditNoteId: xn?.CreditNoteID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, creditNoteNumber: group.creditNoteNumber, contactName: row.contactName || "", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < job.creditNoteGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = job.creditNoteGroups[i]?.rows[0]?.rowNumber || null;
    job.currentCreditNoteNumber = job.creditNoteGroups[i]?.creditNoteNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch credit-notes ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, job.creditNoteGroups.length)}/${job.total} (2 concurrent)`);
    const cnPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.creditNoteGroups.length) break;
      cnPromises.push(runCreditNoteBatch(job.creditNoteGroups.slice(start, Math.min(start + BATCH_SIZE, job.creditNoteGroups.length))));
    }
    await Promise.all(cnPromises);
  }
  job.currentRowNumber = null;
  job.currentCreditNoteNumber = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const cnCreatedIds = [...new Set(job.results.filter(r => r.creditNoteId).map(r => r.creditNoteId))];
  const cnHistEntry = recordImportHistory({ importType: "credit-notes", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: cnCreatedIds, note: job.note || "" });
  job.historyId = cnHistEntry.id;
  writeJobCheckpoint(job, "credit-notes");
}

app.post("/api/import/credit-notes/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No credit note rows found in the CSV file." });
    const planCheck = checkImportAccess(userData.user, "credit-notes", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    const groupMap = new Map();
    rows.forEach((row, index) => {
      const r = {
        rowNumber: Number(row.rowNumber) || index + 2,
        creditNoteNumber: String(row.creditNoteNumber || "").trim(),
        contactName: String(row.contactName || "").trim(),
        creditNoteDate: String(row.creditNoteDate || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        exchangeRate: String(row.exchangeRate || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
        status: String(row.status || "DRAFT").trim(),
      };
      if (!groupMap.has(r.creditNoteNumber)) groupMap.set(r.creditNoteNumber, []);
      groupMap.get(r.creditNoteNumber).push(r);
    });
    const creditNoteGroups = Array.from(groupMap.entries()).map(([creditNoteNumber, groupRows]) => ({ creditNoteNumber, rows: groupRows }));
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "credit-notes.csv"),
      status: "queued",
      total: creditNoteGroups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentCreditNoteNumber: "",
      results: [],
      creditNoteGroups,
      note: extractJobNote(req),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    job.updateMode = req.body?.updateMode === true;
    creditNotesImportJobStore.set(job.id, job);
    setTimeout(() => {
      processCreditNotesImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildCreditNotesImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/credit-notes/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = creditNotesImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Credit notes import job not found" });
  if (!ownsCreditNotesImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildCreditNotesImportStatus(job) });
});

function buildOverpaymentImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  const allResults = job.results || [];
  const skippedResults = allResults.filter(r => r.status === "skipped");
  const nonSkippedResults = allResults.filter(r => r.status !== "skipped");
  // Always include all skipped records + last 200 of other records
  const results = [...skippedResults, ...nonSkippedResults.slice(-200)];
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    overpaymentType: job.overpaymentType,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    warnings: job.warnings || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentReference: job.currentReference || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results,
    error: job.error || "",
  };
}

function ownsOverpaymentImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

function buildOverpaymentPayloadFromRows(reference, rows, overpaymentType) {
  const xeroType = overpaymentType === "RECEIVE" ? "RECEIVE-OVERPAYMENT" : "SPEND-OVERPAYMENT";
  const firstRow = rows[0];
  const bankTxn = {
    Type: xeroType,
    Contact: { Name: String(firstRow.contactName || "").trim() },
    BankAccount: { Code: String(firstRow.bankAccountCode || "").trim() },
    LineItems: [],
  };
  const txnDate = parseDateForXero(firstRow.date);
  if (txnDate) bankTxn.Date = txnDate;
  if (reference) bankTxn.Reference = String(reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) bankTxn.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) bankTxn.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qtyRaw = String(row.quantity || "").trim();
    const qty = Number(qtyRaw);
    if (qtyRaw && Number.isFinite(qty)) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    const taxType = String(row.taxType || "").trim();
    const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
    if (taxType && !isSkippedTaxType(normalizedTax)) {
      lineItem.TaxType = taxType;
    }
    // TaxAmount is intentionally not sent — Xero calculates it from TaxType + UnitAmount.
    // Passing our own figure risks a 1-cent rounding mismatch that Xero rejects outright.
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1) {
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    }
    if (row.trackingName2 && row.trackingOption2) {
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    }
    if (tracking.length) lineItem.Tracking = tracking;
    bankTxn.LineItems.push(lineItem);
  });
  return bankTxn;
}

async function createOverpaymentInXero({ tenantId, requestedSessionId, reference, rows, overpaymentType }) {
  const payload = buildOverpaymentPayloadFromRows(reference, rows, overpaymentType);
  const requestUrl = "https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false";

  const submitTxn = async (txnPayload) => {
    const result = await runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
      const response = await fetchWithRetry(requestUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
        },
        body: JSON.stringify({ BankTransactions: [txnPayload] }),
      });
      return { response };
    });
    const created = result.response.data?.BankTransactions?.[0] || {};
    const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
    return { created, errors, resolvedSessionId: result.resolvedSessionId };
  };

  let { created, errors, resolvedSessionId } = await submitTxn(payload);

  let taxTypeStripped = false;
  if ((created.StatusAttributeString === "ERROR" || errors.length) && isTaxTypeError(errors)) {
    const payloadNoTax = {
      ...payload,
      LineItems: payload.LineItems.map(({ TaxType, TaxAmount, ...rest }) => rest),
    };
    ({ created, errors, resolvedSessionId } = await submitTxn(payloadNoTax));
    taxTypeStripped = true;
  }

  if (created.StatusAttributeString === "ERROR" || errors.length) {
    throw new Error(
      errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
        "Xero rejected this overpayment."
    );
  }
  return { transaction: created, sessionId: resolvedSessionId, taxTypeStripped };
}

async function fetchExistingOverpaymentReferences(job) {
  const xeroType = job.overpaymentType === "RECEIVE" ? "RECEIVE-OVERPAYMENT" : "SPEND-OVERPAYMENT";
  const existingRefs = new Set();
  const importRefs = new Set(
    (job.groups || []).map(g => String(g.reference || "").trim()).filter(Boolean)
  );
  if (!importRefs.size) return existingRefs;
  try {
    // Single paginated stream across all banks — no per-bank overhead.
    // Exit early once all import refs are matched (avoids scanning unnecessary pages).
    const where = encodeURIComponent(`Type=="${xeroType}"&&Status=="AUTHORISED"`);
    for (let page = 1; page <= 200; page++) {
      let txns = [];
      try {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}&pageSize=1000`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { transactions: data?.BankTransactions || [] };
        });
        if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        txns = result.transactions || [];
      } catch (_) { break; }
      txns
        .filter(t => t.Reference && importRefs.has(String(t.Reference).trim()))
        .forEach(t => existingRefs.add(String(t.Reference).trim()));
      // Stop as soon as every import ref has been found — no need to read further
      if (existingRefs.size >= importRefs.size) break;
      if (txns.length < 1000) break;
    }
  } catch (_) { /* proceed without skip check */ }
  return existingRefs;
}

async function processOverpaymentImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  if (job.skipDuplicateCheck) {
    try {
      const existingRefs = await fetchExistingOverpaymentReferences(job);
      if (existingRefs.size > 0) {
        const before = job.groups.length;
        const skippedGroups = job.groups.filter(g => existingRefs.has(String(g.reference).trim()));
        job.groups = job.groups.filter(g => !existingRefs.has(String(g.reference).trim()));
        const skipped = before - job.groups.length;
        job.skipped = (job.skipped || 0) + skipped;
        job.total = job.groups.length;
        skippedGroups.forEach(g => {
          g.rows.forEach(row => job.results.push({
            rowNumber: row.rowNumber,
            reference: g.reference,
            contactName: row.contactName || "",
            status: "skipped",
            message: "Already exists in Xero — skipped.",
          }));
        });
        job.updatedAt = Date.now();
      }
    } catch (_) { /* proceed without skip check if it fails */ }
  }

  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;
  const runOverpaymentBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => buildOverpaymentPayloadFromRows(g.reference, g.rows, job.overpaymentType));
      const batchIdempotencyKey = crypto.randomBytes(16).toString("hex");
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false", {
          method: "PUT",
          timeoutMs: 120000,
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ BankTransactions: payloads }),
        });
        return { transactions: data?.BankTransactions || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroTxns = result.transactions || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xt = xeroTxns[j] || {};
        const errors = Array.isArray(xt.ValidationErrors) ? xt.ValidationErrors : [];
        if (xt.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const msg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this overpayment.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, reference: group.reference, contactName: row.contactName || "", status: "error", message: msg }));
          job.processed += 1;
        } else if (!xt.BankTransactionID) {
          // Xero returned no BankTransactionID — treat as error, not silent false success
          job.errors += 1;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, reference: group.reference, contactName: row.contactName || "", status: "error", message: "Xero did not confirm creation (no BankTransactionID returned). Please retry." }));
          job.processed += 1;
        } else {
          job.created += 1;
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, reference: group.reference, contactName: row.contactName || "", status: "created", message: "Overpayment created successfully.", transactionId: xt.BankTransactionID }));
          job.processed += 1;
        }
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, reference: group.reference, contactName: row.contactName || "", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < job.groups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = job.groups[i]?.rows[0]?.rowNumber || null;
    job.currentReference = job.groups[i]?.reference || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch overpayments ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, job.groups.length)}/${job.total} (${CONCURRENCY} concurrent)`);
    const ovPromises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.groups.length) break;
      ovPromises.push(runOverpaymentBatch(job.groups.slice(start, Math.min(start + BATCH_SIZE, job.groups.length))));
    }
    await Promise.all(ovPromises);
  }
  job.currentRowNumber = null;
  job.currentReference = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/overpayment/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Select a Xero organisation before importing." });
    }
    const overpaymentType = String(req.body?.overpaymentType || "SPEND").trim().toUpperCase();
    if (!["SPEND", "RECEIVE"].includes(overpaymentType)) {
      return res.status(400).json({ error: "overpaymentType must be SPEND or RECEIVE." });
    }
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ error: "No rows found in the CSV file." });
    }
    const opTypeKey = overpaymentType === "SPEND" ? "spend-overpayments" : "receive-overpayments";
    const planCheckOP = checkImportAccess(userData.user, opTypeKey, rows.length);
    if (!planCheckOP.allowed) return res.status(403).json({ error: planCheckOP.error, planError: true });
    if (rows.length > 50000) {
      return res.status(400).json({ error: "Import a maximum of 50000 rows per CSV file." });
    }
    const groupMap = new Map();
    rows.forEach((row, index) => {
      const normalized = {
        rowNumber: Number(row.rowNumber) || index + 2,
        reference: String(row.reference || "").trim(),
        contactName: String(row.contactName || "").trim(),
        date: String(row.date || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        exchangeRate: String(row.exchangeRate || "").trim(),
        bankAccountCode: String(row.bankAccountCode || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
      };
      const groupKey = normalized.reference || `row_${normalized.rowNumber}`;
      if (!groupMap.has(groupKey)) groupMap.set(groupKey, []);
      groupMap.get(groupKey).push(normalized);
    });
    const groups = Array.from(groupMap.entries()).map(([reference, groupRows]) => ({
      reference,
      rows: groupRows,
    }));
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      overpaymentType,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "overpayment.csv"),
      status: "queued",
      total: groups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      currentReference: "",
      results: [],
      groups,
      skipDuplicateCheck: req.body?.skipDuplicateCheck === true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    overpaymentImportJobStore.set(job.id, job);
    setTimeout(() => {
      processOverpaymentImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildOverpaymentImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/overpayment/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  const jobId = String(req.query.jobId || "").trim();
  const job = overpaymentImportJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Overpayment import job not found" });
  }
  if (!ownsOverpaymentImportJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json({ ok: true, ...buildOverpaymentImportStatus(job) });
});

// ── Overpayment Allocation ────────────────────────────────────────────────

function buildAllocationStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
  const rate = processed > 0 ? elapsed / processed : 0;
  const remaining = total - processed;
  const etaMs = rate > 0 && remaining > 0 ? Math.round(rate * remaining) : null;
  return {
    jobId: job.id,
    status: job.status,
    total,
    processed,
    created: job.created || 0,
    skipped: job.skipped || 0,
    warnings: job.warnings || 0,
    errors: job.errors || 0,
    remaining,
    currentReference: job.currentReference || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
    apiCalls: job.apiCalls || { batch: 0, fallback: 0 },
  };
}

function ownsAllocationJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function findOverpaymentByReference(tenantId, requestedSessionId, reference) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const encoded = encodeURIComponent(`Reference=="${reference}"`);
    const url = `https://api.xero.com/api.xro/2.0/Overpayments?where=${encoded}`;
    const { data } = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    const ops = data.Overpayments || [];
    if (!ops.length) return { overpayment: null };
    return { overpayment: ops[0] };
  });
}

async function findOutstandingInvoicesForContact(tenantId, requestedSessionId, contactId, invoiceType) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const url = `https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${encodeURIComponent(contactId)}&Statuses=AUTHORISED,PARTIAL&order=Date%20ASC`;
    const { data } = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    const all = data.Invoices || [];
    const outstanding = all
      .filter((inv) => inv.Type === invoiceType && Number(inv.AmountDue) > 0)
      .sort((a, b) => new Date(a.Date) - new Date(b.Date));
    return { invoices: outstanding };
  });
}

async function findInvoiceByNumber(tenantId, requestedSessionId, invoiceNumber) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const encoded = encodeURIComponent(`InvoiceNumber=="${invoiceNumber}"`);
    const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encoded}&Statuses=AUTHORISED,PARTIAL`;
    const { data } = await fetchWithRetry(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
      },
    });
    const invoices = data?.Invoices || [];
    return { invoice: invoices[0] || null };
  });
}

async function createOverpaymentAllocationInXero({ tenantId, requestedSessionId, overpaymentId, allocations, date }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const url = `https://api.xero.com/api.xro/2.0/Overpayments/${overpaymentId}/Allocations`;
    const body = {
      Allocations: allocations.map(a => ({ Invoice: { InvoiceID: a.invoiceId }, Amount: a.amount, Date: date })),
    };
    const { data } = await fetchWithRetry(url, {
      method: "PUT",
      waitForDailyReset: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify(body),
    });
    return { allocation: data?.Overpayments?.[0] || null };
  });
}

async function createPrepaymentAllocationInXero({ tenantId, requestedSessionId, prepaymentId, allocations, date }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const url = `https://api.xero.com/api.xro/2.0/Prepayments/${prepaymentId}/Allocations`;
    const body = {
      Allocations: allocations.map(a => ({ Invoice: { InvoiceID: a.invoiceId }, Amount: a.amount, Date: date })),
    };
    const { data } = await fetchWithRetry(url, {
      method: "PUT",
      waitForDailyReset: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify(body),
    });
    return { allocation: data?.Prepayments?.[0] || null };
  });
}

async function processAllocationJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  const CONCURRENCY = 5;
  const xeroType = job.allocationType === "RECEIVE" ? "RECEIVE-OVERPAYMENT" : "SPEND-OVERPAYMENT";

  // Phase 1: Fetch ALL overpayments — no WHERE filter (WHERE clause unreliable for this org)
  // Sort by UpdatedDateUTC DESC so recently-imported overpayments appear first, enabling early exit
  const overpaymentMap = new Map();
  const neededRefs = new Set(job.rows.map(r => r.overpaymentReference).filter(Boolean));
  let phase1Error = null;
  let phase1BudgetStopped = false; // true if Phase 1 was cut short due to API budget
  const allInvoiceNums = [...new Set(job.rows.filter(r => r.invoiceNumber).map(r => String(r.invoiceNumber).trim()))];
  let xeroLimitRemaining = null;
  try {
    for (let page = 1; page <= 500; page++) {
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const res = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/Overpayments?page=${page}&pageSize=1000&order=UpdatedDateUTC+DESC`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { overpayments: res.data?.Overpayments || [], dayRemaining: res.rate?.day };
      });
      if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
      const ops = result?.overpayments || [];
      ops.filter(op => op.Reference && neededRefs.has(String(op.Reference).trim()))
         .forEach(op => overpaymentMap.set(String(op.Reference).trim(), op));
      if (overpaymentMap.size >= neededRefs.size) break;
      if (ops.length < 1000) break;
      // Stop Phase 1 early if remaining calls won't cover Phase 2 + Phase 3 (based on refs found so far)
      if (xeroLimitRemaining !== null) {
        const estPhase2 = Math.ceil(allInvoiceNums.length / 100);
        const estPhase3 = overpaymentMap.size; // 1 API call per allocation row (individual PUT)
        if (xeroLimitRemaining < estPhase2 + estPhase3 + 50) {
          console.warn(`[Phase 1 BUDGET STOP] page ${page}, ${xeroLimitRemaining} remaining < ${estPhase2 + estPhase3 + 50} needed — stopping with ${overpaymentMap.size}/${neededRefs.size} refs found`);
          phase1BudgetStopped = true;
          break;
        }
      }
    }
  } catch (err) {
    phase1Error = err?.message || String(err);
    phase1BudgetStopped = true; // treat errors as incomplete scan too
    console.error("[Phase 1 ERROR]", phase1Error);
  }

  // After Phase 1 — check remaining limit vs estimated need
  if (xeroLimitRemaining !== null) {
    const estPhase2 = Math.ceil(allInvoiceNums.length / 100);
    const estPhase3 = job.rows.length; // 1 API call per allocation row (individual PUT)
    const estNeeded = estPhase2 + estPhase3;
    console.log(`[API Limit] After Phase 1: ${xeroLimitRemaining} remaining, ~${estNeeded} more needed (Phase2: ${estPhase2}, Phase3: ${estPhase3})`);
    if (xeroLimitRemaining < estNeeded + 50) {
      const warnMsg = `API LIMIT WARNING — Only ${xeroLimitRemaining} Xero API calls remaining but ~${estNeeded} needed. Some rows may fail. Use a fresh Client ID to continue.`;
      console.warn("[API LIMIT]", warnMsg);
      job.results.push({ rowNumber: 0, overpaymentReference: "API_LIMIT_WARNING", allocatedTo: "", amount: "", status: "error", message: warnMsg });
    }
  }

  // If Phase 1 found nothing, add diagnostic info to results
  if (overpaymentMap.size === 0) {
    const diagMsg = phase1Error
      ? `DIAGNOSTIC — Phase 1 failed: ${phase1Error}`
      : `DIAGNOSTIC — Phase 1 returned 0 overpayments. TenantId: ${job.tenantId}, SessionId: ${job.sessionId?.slice(0,8)}...`;
    console.error("[Phase 1 DIAGNOSTIC]", diagMsg);
    job.results.push({ rowNumber: 0, overpaymentReference: "DIAGNOSTIC", allocatedTo: "", amount: "", status: "error", message: diagMsg });
  }

  // Phase 2: Resolve InvoiceNumber → InvoiceID — only for rows where overpayment was found
  const invoiceIdMap = new Map(); // "invoicenum|contactid" → InvoiceID, also "invoicenum" → InvoiceID fallback
  const invoiceAmountDueMap = new Map(); // InvoiceID → AmountDue (to cap allocation and avoid Xero rejection)
  const foundRefs = new Set(overpaymentMap.keys());
  const relevantInvoiceNums = [...new Set(job.rows.filter(r => r.invoiceNumber && foundRefs.has(r.overpaymentReference)).map(r => String(r.invoiceNumber).trim()))];
  // Override allInvoiceNums to only relevant ones for Phase 2
  allInvoiceNums.length = 0; relevantInvoiceNums.forEach(n => allInvoiceNums.push(n));
  if (allInvoiceNums.length > 0) {
    const INV_BATCH = 100;
    for (let i = 0; i < allInvoiceNums.length; i += INV_BATCH) {
      const batch = allInvoiceNums.slice(i, i + INV_BATCH);
      try {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${encodeURIComponent(batch.join(","))}&Statuses=AUTHORISED,PARTIAL`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { invoices: res.data?.Invoices || [], dayRemaining: res.rate?.day, resolvedSessionId: null };
        });
        if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
        for (const inv of result?.invoices || []) {
          const numKey = String(inv.InvoiceNumber || "").trim().toLowerCase();
          const contactId = inv.Contact?.ContactID || "";
          if (numKey && inv.InvoiceID) {
            invoiceIdMap.set(`${numKey}|${contactId}`, inv.InvoiceID);
            invoiceIdMap.set(numKey, inv.InvoiceID);
            invoiceAmountDueMap.set(inv.InvoiceID, Number(inv.AmountDue) || 0);
          }
        }
      } catch (err) {
        console.error("[Phase 2 ERROR] batch", i, err?.message);
      }
    }
  }

  // Phase 3: Batch allocations via POST /Payments (50 per call)
  // Rows without invoiceNumber fall back to individual PUT /Overpayments/{id}/Allocations
  const BATCH_SIZE = 50;

  const resolveRowForBatch = (row) => {
    const op = overpaymentMap.get(row.overpaymentReference);
    if (!op) {
      if (phase1BudgetStopped) return { error: `API quota exhausted during scan — "${row.overpaymentReference}" was not reached. Retry after quota resets (midnight UTC / 5:30 AM IST).` };
      return { error: `Overpayment with reference "${row.overpaymentReference}" not found in Xero.` };
    }
    const remainingCredit = Number(op.RemainingCredit) || 0;
    if (remainingCredit <= 0) return { skip: `Overpayment "${row.overpaymentReference}" is fully allocated (Remaining Credit = 0) — skipped.` };
    const existingAllocs = op.Allocations || [];
    const alreadyByNum = existingAllocs.some(a => String(a.Invoice?.InvoiceNumber || "").trim().toLowerCase() === row.invoiceNumber.trim().toLowerCase());
    if (alreadyByNum) return { skip: `Already allocated: "${row.overpaymentReference}" → "${row.invoiceNumber}" (skipped duplicate).` };
    const contactId = op.Contact?.ContactID || "";
    const numKey = row.invoiceNumber.trim().toLowerCase();
    const invoiceId = invoiceIdMap.get(`${numKey}|${contactId}`) || invoiceIdMap.get(numKey);
    if (!invoiceId) return { error: `Invoice "${row.invoiceNumber}" not found in Xero (must be AUTHORISED status).` };
    const invoiceAmountDue = invoiceAmountDueMap.get(invoiceId);
    let amountToAllocate = row.amount ? Number(row.amount) : remainingCredit;
    if (!Number.isFinite(amountToAllocate) || amountToAllocate <= 0) return { error: `Invalid amount: ${row.amount}` };
    if (amountToAllocate > remainingCredit + 0.01) return { error: `Amount ${amountToAllocate} exceeds remaining credit ${remainingCredit} for "${row.overpaymentReference}".` };
    amountToAllocate = Math.min(amountToAllocate, remainingCredit);
    // Cap by invoice's AmountDue to avoid Xero "amount is greater than amount outstanding" rejection
    if (invoiceAmountDue !== undefined && invoiceAmountDue > 0) {
      amountToAllocate = Math.min(amountToAllocate, invoiceAmountDue);
    }
    const date = parseDateForXero(row.date) || new Date().toISOString().slice(0, 10);
    op.RemainingCredit = Math.max(0, remainingCredit - amountToAllocate);
    return { allocationData: { overpaymentId: op.OverpaymentID, invoiceId, amount: amountToAllocate, date }, finalAmount: amountToAllocate };
  };

  // Fallback: rows without invoiceNumber — auto-find outstanding invoices (individual call)
  const processRowFallback = async (row) => {
    job.currentReference = row.overpaymentReference || "";
    job.updatedAt = Date.now();
    try {
      const op = overpaymentMap.get(row.overpaymentReference);
      if (!op) throw new Error(phase1BudgetStopped ? `API quota exhausted during scan — "${row.overpaymentReference}" was not reached. Retry after quota resets (midnight UTC / 5:30 AM IST).` : `Overpayment with reference "${row.overpaymentReference}" not found in Xero.`);
      const invoiceType = String(op.Type || "").includes("RECEIVE") ? "ACCREC" : "ACCPAY";
      const contactId = op.Contact?.ContactID;
      if (!contactId) throw new Error(`Overpayment "${row.overpaymentReference}" has no contact linked.`);
      const remainingCredit = Number(op.RemainingCredit) || 0;
      if (remainingCredit <= 0) { job.skipped += 1; job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "skipped", message: `Overpayment "${row.overpaymentReference}" is fully allocated — skipped.` }); job.processed += 1; return; }
      const invResult = await findOutstandingInvoicesForContact(job.tenantId, job.sessionId, contactId, invoiceType);
      if (invResult?.sessionId) job.sessionId = invResult.sessionId;
      job.apiCalls.fallback += 1;
      const invoices = invResult?.invoices || [];
      if (!invoices.length) throw new Error(`No outstanding ${invoiceType === "ACCPAY" ? "bills" : "invoices"} found for contact of overpayment "${row.overpaymentReference}".`);
      let amountToAllocate = row.amount ? Number(row.amount) : remainingCredit;
      if (!Number.isFinite(amountToAllocate) || amountToAllocate <= 0) throw new Error(`Invalid amount: ${row.amount}`);
      const date = parseDateForXero(row.date) || new Date().toISOString().slice(0, 10);
      let remaining = amountToAllocate;
      const allocatedTo = [];
      for (const inv of invoices) {
        if (remaining <= 0) break;
        const amountDue = Number(inv.AmountDue) || 0;
        if (amountDue <= 0) continue;
        const allocAmount = Math.min(remaining, amountDue);
        const allocResult = await createOverpaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, overpaymentId: op.OverpaymentID, allocations: [{ invoiceId: inv.InvoiceID, amount: allocAmount }], date });
        if (allocResult?.sessionId) job.sessionId = allocResult.sessionId;
        allocatedTo.push(`${inv.InvoiceNumber || inv.InvoiceID} (${allocAmount})`);
        remaining -= allocAmount;
        op.RemainingCredit = Math.max(0, (Number(op.RemainingCredit) || 0) - allocAmount);
      }
      if (allocatedTo.length === 0) throw new Error(`No invoices could be allocated for overpayment "${row.overpaymentReference}".`);
      const totalAllocated = amountToAllocate - remaining;
      job.created += 1;
      job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: allocatedTo.join(", "), amount: totalAllocated, status: remaining > 0 ? "partial" : "created", message: remaining > 0 ? `Partially allocated ${totalAllocated} from "${row.overpaymentReference}" to: ${allocatedTo.join(", ")}. ${remaining} could not be allocated.` : `Allocated ${totalAllocated} from "${row.overpaymentReference}" to: ${allocatedTo.join(", ")}.` });
    } catch (err) {
      job.errors += 1;
      job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: err.message });
    }
    job.processed += 1;
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE) {
    if (job.cancelRequested) break;
    const batch = job.rows.slice(i, i + BATCH_SIZE);
    job.currentReference = batch[0]?.overpaymentReference || "";
    job.updatedAt = Date.now();

    for (const row of batch) {
      if (!row.invoiceNumber) {
        await processRowFallback(row);
        continue;
      }
      const resolved = resolveRowForBatch(row);
      if (resolved.error) {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: resolved.error });
        job.processed += 1;
      } else if (resolved.skip) {
        job.skipped += 1;
        job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber, amount: row.amount || "", status: "skipped", message: resolved.skip });
        job.processed += 1;
      } else {
        const { allocationData, finalAmount } = resolved;
        try {
          const allocResult = await createOverpaymentAllocationInXero({
            tenantId: job.tenantId,
            requestedSessionId: job.sessionId,
            overpaymentId: allocationData.overpaymentId,
            allocations: [{ invoiceId: allocationData.invoiceId, amount: allocationData.amount }],
            date: allocationData.date,
          });
          if (allocResult?.sessionId) job.sessionId = allocResult.sessionId;
          job.apiCalls.batch += 1;
          job.created += 1;
          job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber, amount: finalAmount, status: "created", message: `Allocated ${finalAmount} from "${row.overpaymentReference}" to: ${row.invoiceNumber}.` });
        } catch (err) {
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, overpaymentReference: row.overpaymentReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: err.message });
        }
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  }

  job.currentReference = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/overpayment-allocation/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const allocTypeStr = String(req.body?.allocationType || "spend").toLowerCase();
    const allocKey = allocTypeStr === "receive" ? "receive-alloc" : "spend-alloc";
    const planCheckAlloc = checkImportAccess(userData.user, allocKey, rows.length);
    if (!planCheckAlloc.allowed) return res.status(403).json({ error: planCheckAlloc.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    console.log("[DEBUG] First 3 rows from client:", JSON.stringify(rows.slice(0, 3).map(r => ({ overpaymentReference: r.overpaymentReference, invoiceNumber: r.invoiceNumber }))));
    const normalizedRows = rows.map((row, i) => ({
      rowNumber: Number(row.rowNumber) || i + 2,
      overpaymentReference: String(row.overpaymentReference || "").trim(),
      invoiceNumber: String(row.invoiceNumber || "").trim(),
      contactName: String(row.contactName || "").trim(),
      amount: String(row.amount || "").trim(),
      date: String(row.date || "").trim(),
    })).filter((r) => r.overpaymentReference && r.overpaymentReference !== "API_LIMIT_WARNING");
    const badAmountRows = normalizedRows.filter((r) => r.amount && (Number.isNaN(Number(r.amount)) || Number(r.amount) <= 0));
    if (badAmountRows.length) {
      return res.status(400).json({ error: `Rows ${badAmountRows.map((r) => r.rowNumber).join(", ")} have invalid Amount values.` });
    }
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId,
      sessionId,
      allocationType: allocTypeStr === "receive" ? "RECEIVE" : "SPEND",
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      errors: 0,
      currentReference: "",
      rows: normalizedRows,
      results: [],
      skipped: 0,
      apiCalls: { batch: 0, fallback: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    overpaymentAllocationJobStore.set(job.id, job);
    setTimeout(() => {
      processAllocationJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildAllocationStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/overpayment-allocation/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = overpaymentAllocationJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Allocation job not found" });
  if (!ownsAllocationJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildAllocationStatus(job) });
});

// ─── Spend Money Import ───────────────────────────────────────────────────────

function buildSpendMoneyImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentRef: job.currentRef || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (() => { const all = job.results || []; const sk = all.filter(r => r.status === "skipped"); const other = all.filter(r => r.status !== "skipped"); return [...sk, ...other.slice(-200)]; })(),
    error: job.error || "",
    historyId: job.historyId || "",
  };
}

function ownsSpendMoneyImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function createSpendMoneyInXero({ tenantId, requestedSessionId, row }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const txDate = parseDateForXero(row.date);
    const lineItem = { Description: String(row.description || "").trim() };
    const qty = Number(row.quantity || "");
    if (Number.isFinite(qty) && qty !== 0) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    const taxType = String(row.taxType || "").trim();
    const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
    if (taxType && !isSkippedTaxType(normalizedTax)) lineItem.TaxType = taxType;
    // TaxAmount is intentionally not sent — Xero calculates it from TaxType + UnitAmount.
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1) tracking.push({ Name: row.trackingName1.trim(), Option: row.trackingOption1.trim() });
    if (row.trackingName2 && row.trackingOption2) tracking.push({ Name: row.trackingName2.trim(), Option: row.trackingOption2.trim() });
    if (tracking.length) lineItem.Tracking = tracking;

    const payload = {
      Type: "SPEND",
      Contact: { Name: String(row.contactName || "").trim() },
      BankAccount: { Code: String(row.bankAccountCode || "").trim() },
      Date: txDate || new Date().toISOString().slice(0, 10),
      LineAmountTypes: "Exclusive",
      LineItems: [lineItem],
    };
    if (row.reference) payload.Reference = String(row.reference).trim();
    const cc = String(row.currencyCode || "").trim().toUpperCase();
    if (cc) payload.CurrencyCode = cc;
    const exRate = Number(row.exchangeRate || "");
    if (Number.isFinite(exRate) && exRate > 0) payload.CurrencyRate = exRate;

    const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ BankTransactions: [payload] }),
    });
    const created = data?.BankTransactions?.[0] || {};
    const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
    if (created.StatusAttributeString === "ERROR" || errors.length) {
      throw new Error(errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this transaction.");
    }
    return { transaction: created };
  });
}

async function fetchExistingBankTxnRefs(job, bankCode, refsToCheck) {
  const refs = new Set();
  if (!refsToCheck || refsToCheck.length === 0) return refs;
  const refsLower = new Set(refsToCheck.map(r => String(r).toLowerCase()));
  // Scan recent pages of the account — stop as soon as we've seen all import refs or no pages left.
  // Max 3 pages (300 txns) to keep it fast; covers most practical duplicate scenarios.
  const MAX_PAGES = 3;
  const where = encodeURIComponent(`BankAccount.Code=="${bankCode}"&&Status!="DELETED"`);
  for (let page = 1; page <= MAX_PAGES; page++) {
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/BankTransactions?where=${where}&page=${page}&pageSize=1000`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { txns: data?.BankTransactions || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const t of r.txns) {
        if (t.Reference) {
          const refLow = String(t.Reference).toLowerCase();
          if (refsLower.has(refLow)) refs.add(refLow);
        }
      }
      if ((r.txns || []).length < 1000) break;
    } catch (_) { break; }
  }
  return refs;
}

async function processSpendMoneyImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  // Pre-fetch tax rates to resolve display names (e.g. "Tax Exempt" → the org's actual TaxType code)
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) { /* proceed without resolution */ }

  // Pre-check: skip rows whose reference already exists in Xero
  if (!job.skipDuplicateCheck) {
    try {
      const uniqueBankCodes = [...new Set(job.rows.map((r) => r.bankAccountCode).filter(Boolean))];
      const existingRefs = new Set();
      for (const bankCode of uniqueBankCodes) {
        const refsForBank = [...new Set(job.rows.filter(r => r.bankAccountCode === bankCode && r.reference).map(r => String(r.reference)))];
        const refs = await fetchExistingBankTxnRefs(job, bankCode, refsForBank);
        for (const ref of refs) existingRefs.add(`${bankCode.toLowerCase()}:${ref}`);
      }
      const before = job.rows.length;
      job.rows = job.rows.filter((row) => {
        if (!row.reference) return true;
        return !existingRefs.has(`${String(row.bankAccountCode || "").toLowerCase()}:${row.reference.toLowerCase()}`);
      });
      const skipped = before - job.rows.length;
      if (skipped > 0) {
        console.log(`[Import ${job.id}] Skipped ${skipped} row(s) already in Xero.`);
        job.processed += skipped;
        job.total = job.total;
      }
    } catch (preErr) {
      console.log(`[Import ${job.id}] Pre-check skipped: ${preErr.message}`);
    }
  } else {
    console.log(`[Import ${job.id}] Duplicate check skipped by user.`);
  }

  // Group rows by bankAccountCode+reference so same-reference rows become one transaction with multiple line items
  const spendGroupMap = new Map();
  for (const row of job.rows) {
    const key = row.reference
      ? `${String(row.bankAccountCode).toLowerCase()}|${row.reference.toLowerCase()}`
      : `noref_${row.rowNumber}`;
    if (!spendGroupMap.has(key)) spendGroupMap.set(key, []);
    spendGroupMap.get(key).push(row);
  }
  const spendGroups = [...spendGroupMap.values()];

  const BATCH_SIZE = 100;
  const CONCURRENCY = 3;
  const runSpendBatch = async (batchGroups) => {
    try {
      const payloads = batchGroups.map((groupRows) => {
        const firstRow = groupRows[0];
        const txDate = parseDateForXero(firstRow.date);
        const lineItems = groupRows.map((row) => {
          const lineItem = { Description: String(row.description || "").trim() };
          const qty = Number(row.quantity || "");
          if (Number.isFinite(qty) && qty !== 0) lineItem.Quantity = qty;
          const unitAmtRaw = String(row.unitAmount || "").trim();
          const unitAmt = Number(unitAmtRaw);
          if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
          if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
          const taxType = String(row.taxType || "").trim();
          const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
          if (taxType && !isSkippedTaxType(normalizedTax) && taxNameToCode.size > 0) lineItem.TaxType = resolveTaxType(taxType, taxNameToCode);
          // TaxAmount is intentionally not sent — Xero calculates it from TaxType + UnitAmount.
          // Passing our own figure risks a 1-cent rounding mismatch that Xero rejects outright.
          const tracking = [];
          if (row.trackingName1 && row.trackingOption1) tracking.push({ Name: row.trackingName1.trim(), Option: row.trackingOption1.trim() });
          if (row.trackingName2 && row.trackingOption2) tracking.push({ Name: row.trackingName2.trim(), Option: row.trackingOption2.trim() });
          if (tracking.length) lineItem.Tracking = tracking;
          return lineItem;
        });
        const payload = { Type: "SPEND", IsReconciled: true, Contact: { Name: String(firstRow.contactName || "").trim() }, BankAccount: { Code: String(firstRow.bankAccountCode || "").trim() }, Date: txDate || new Date().toISOString().slice(0, 10), LineAmountTypes: "Exclusive", LineItems: lineItems };
        if (firstRow.reference) payload.Reference = String(firstRow.reference).trim();
        const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
        if (cc) payload.CurrencyCode = cc;
        const exRate = Number(firstRow.exchangeRate || "");
        if (Number.isFinite(exRate) && exRate > 0) payload.CurrencyRate = exRate;
        return payload;
      });
      const batchIdempotencyKey = crypto.randomBytes(16).toString("hex");
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false", {
          method: "PUT",
          timeoutMs: 90000,
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ BankTransactions: payloads }),
        });
        return { transactions: data?.BankTransactions || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroTxns = result.transactions || [];
      for (let j = 0; j < batchGroups.length; j++) {
        const groupRows = batchGroups[j];
        const xt = xeroTxns[j] || {};
        const errors = Array.isArray(xt.ValidationErrors) ? xt.ValidationErrors : [];
        if (xt.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const errMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this transaction.";
          for (const row of groupRows) {
            job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "error", message: errMsg });
            job.processed += 1;
          }
        } else {
          job.created += 1;
          for (const row of groupRows) {
            job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "created", message: "Spend Money transaction created successfully.", transactionId: xt?.BankTransactionID || "" });
            job.processed += 1;
          }
        }
      }
    } catch (err) {
      for (const groupRows of batchGroups) {
        for (const row of groupRows) {
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "error", message: err.message });
          job.processed += 1;
        }
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < spendGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = spendGroups[i]?.[0]?.rowNumber || null;
    job.currentRef = spendGroups[i]?.[0]?.reference || spendGroups[i]?.[0]?.contactName || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch spend-money groups ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, spendGroups.length)}/${spendGroups.length} (2 concurrent)`);
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= spendGroups.length) break;
      promises.push(runSpendBatch(spendGroups.slice(start, Math.min(start + BATCH_SIZE, spendGroups.length))));
    }
    await Promise.all(promises);
  }
  job.currentRowNumber = null;
  job.currentRef = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const smCreatedIds = [...new Set(job.results.filter(r => r.transactionId).map(r => r.transactionId))];
  const smHistEntry = recordImportHistory({ importType: "spend-money", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: smCreatedIds, note: job.note || "" });
  job.historyId = smHistEntry.id;
}

app.post("/api/import/spend-money/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheck = checkImportAccess(userData.user, "spend-money", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const filename = String(req.body?.filename || "spend_money.csv").trim();

    const normalizedRows = rows.map((row, i) => ({
      rowNumber: Number(row.rowNumber) || i + 2,
      bankAccountCode: String(row.bankAccountCode || "").trim(),
      contactName: String(row.contactName || "").trim(),
      date: String(row.date || "").trim(),
      reference: String(row.reference || "").trim(),
      currencyCode: String(row.currencyCode || "").trim(),
      exchangeRate: String(row.exchangeRate || "").trim(),
      description: String(row.description || "").trim(),
      quantity: String(row.quantity || "").trim(),
      unitAmount: String(row.unitAmount || "").trim(),
      accountCode: String(row.accountCode || "").trim(),
      taxType: String(row.taxType || "").trim(),
      taxAmount: String(row.taxAmount || "").trim(),
      trackingName1: String(row.trackingName1 || "").trim(),
      trackingOption1: String(row.trackingOption1 || "").trim(),
      trackingName2: String(row.trackingName2 || "").trim(),
      trackingOption2: String(row.trackingOption2 || "").trim(),
    }));

    const validationErrors = [];
    normalizedRows.forEach((row) => {
      if (!row.bankAccountCode) validationErrors.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.contactName) validationErrors.push(`Row ${row.rowNumber}: Contact Name is required.`);
      if (!row.date) validationErrors.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.description) validationErrors.push(`Row ${row.rowNumber}: Line Description is required.`);
    });
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join(" | ") });

    const skipDuplicateCheck = req.body?.skipDuplicateCheck === true;
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId,
      sessionId,
      filename,
      skipDuplicateCheck,
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      errors: 0,
      currentRowNumber: null,
      currentRef: "",
      rows: normalizedRows,
      results: [],
      note: extractJobNote(req),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    spendMoneyImportJobStore.set(job.id, job);
    setTimeout(() => {
      processSpendMoneyImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildSpendMoneyImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/spend-money/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = spendMoneyImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Spend money import job not found" });
  if (!ownsSpendMoneyImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildSpendMoneyImportStatus(job) });
});

// ─── Receive Money Import ─────────────────────────────────────────────────────

function buildReceiveMoneyImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id, filename: job.filename, tenantId: job.tenantId, status: job.status,
    total, processed, remaining, created: job.created || 0, errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null, currentRef: job.currentRef || "", etaMs,
    createdAt: job.createdAt || null, startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null, finishedAt: job.finishedAt || null,
    results: (() => { const all = job.results || []; const sk = all.filter(r => r.status === "skipped"); const other = all.filter(r => r.status !== "skipped"); return [...sk, ...other.slice(-200)]; })(),
    error: job.error || "",
    historyId: job.historyId || "",
  };
}

function ownsReceiveMoneyImportJob(job, userData) {
  return Boolean(job && userData && job.userId === userData.user.id);
}

async function createReceiveMoneyInXero({ tenantId, requestedSessionId, row }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const txDate = parseDateForXero(row.date);
    const lineItem = { Description: String(row.description || "").trim() };
    const qty = Number(row.quantity || "");
    if (Number.isFinite(qty) && qty !== 0) lineItem.Quantity = qty;
    const unitAmtRaw = String(row.unitAmount || "").trim();
    const unitAmt = Number(unitAmtRaw);
    if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    const taxType = String(row.taxType || "").trim();
    const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
    if (taxType && !isSkippedTaxType(normalizedTax)) lineItem.TaxType = taxType;
    // TaxAmount is intentionally not sent — Xero calculates it from TaxType + UnitAmount.
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1) tracking.push({ Name: row.trackingName1.trim(), Option: row.trackingOption1.trim() });
    if (row.trackingName2 && row.trackingOption2) tracking.push({ Name: row.trackingName2.trim(), Option: row.trackingOption2.trim() });
    if (tracking.length) lineItem.Tracking = tracking;

    const payload = {
      Type: "RECEIVE",
      Contact: { Name: String(row.contactName || "").trim() },
      BankAccount: { Code: String(row.bankAccountCode || "").trim() },
      Date: txDate || new Date().toISOString().slice(0, 10),
      LineAmountTypes: "Exclusive",
      LineItems: [lineItem],
    };
    if (row.reference) payload.Reference = String(row.reference).trim();
    const cc = String(row.currencyCode || "").trim().toUpperCase();
    if (cc) payload.CurrencyCode = cc;
    const exRate = Number(row.exchangeRate || "");
    if (Number.isFinite(exRate) && exRate > 0) payload.CurrencyRate = exRate;

    const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ BankTransactions: [payload] }),
    });
    const created = data?.BankTransactions?.[0] || {};
    const errors = Array.isArray(created.ValidationErrors) ? created.ValidationErrors : [];
    if (created.StatusAttributeString === "ERROR" || errors.length) {
      throw new Error(errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this transaction.");
    }
    return { transaction: created };
  });
}

async function processReceiveMoneyImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  // Pre-fetch tax rates to resolve display names (e.g. "Tax Exempt" → the org's actual TaxType code)
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) { /* proceed without resolution */ }

  // Pre-check: skip rows whose reference already exists in Xero
  if (!job.skipDuplicateCheck) {
    try {
      const uniqueBankCodes = [...new Set(job.rows.map((r) => r.bankAccountCode).filter(Boolean))];
      const existingRefs = new Set();
      for (const bankCode of uniqueBankCodes) {
        const refsForBank = [...new Set(job.rows.filter(r => r.bankAccountCode === bankCode && r.reference).map(r => String(r.reference)))];
        const refs = await fetchExistingBankTxnRefs(job, bankCode, refsForBank);
        for (const ref of refs) existingRefs.add(`${bankCode.toLowerCase()}:${ref}`);
      }
      const before = job.rows.length;
      job.rows = job.rows.filter((row) => {
        if (!row.reference) return true;
        return !existingRefs.has(`${String(row.bankAccountCode || "").toLowerCase()}:${row.reference.toLowerCase()}`);
      });
      const skipped = before - job.rows.length;
      if (skipped > 0) console.log(`[Import ${job.id}] Skipped ${skipped} row(s) already in Xero.`);
    } catch (preErr) {
      console.log(`[Import ${job.id}] Pre-check skipped: ${preErr.message}`);
    }
  } else {
    console.log(`[Import ${job.id}] Duplicate check skipped by user.`);
  }

  // Group rows by bankAccountCode+reference so same-reference rows become one transaction with multiple line items
  const recvGroupMap = new Map();
  for (const row of job.rows) {
    const key = row.reference
      ? `${String(row.bankAccountCode).toLowerCase()}|${row.reference.toLowerCase()}`
      : `noref_${row.rowNumber}`;
    if (!recvGroupMap.has(key)) recvGroupMap.set(key, []);
    recvGroupMap.get(key).push(row);
  }
  const recvGroups = [...recvGroupMap.values()];

  const BATCH_SIZE = 100;
  const CONCURRENCY = 3;
  const runRecvBatch = async (batchGroups) => {
    try {
      const payloads = batchGroups.map((groupRows) => {
        const firstRow = groupRows[0];
        const txDate = parseDateForXero(firstRow.date);
        const lineItems = groupRows.map((row) => {
          const lineItem = { Description: String(row.description || "").trim() };
          const qty = Number(row.quantity || "");
          if (Number.isFinite(qty) && qty !== 0) lineItem.Quantity = qty;
          const unitAmtRaw = String(row.unitAmount || "").trim();
          const unitAmt = Number(unitAmtRaw);
          if (unitAmtRaw && Number.isFinite(unitAmt)) lineItem.UnitAmount = unitAmt;
          if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
          const taxType = String(row.taxType || "").trim();
          const normalizedTax = taxType.toLowerCase().replace(/\s+/g, "");
          if (taxType && !isSkippedTaxType(normalizedTax) && taxNameToCode.size > 0) lineItem.TaxType = resolveTaxType(taxType, taxNameToCode);
          // TaxAmount is intentionally not sent — Xero calculates it from TaxType + UnitAmount.
          // Passing our own figure risks a 1-cent rounding mismatch that Xero rejects outright.
          const tracking = [];
          if (row.trackingName1 && row.trackingOption1) tracking.push({ Name: row.trackingName1.trim(), Option: row.trackingOption1.trim() });
          if (row.trackingName2 && row.trackingOption2) tracking.push({ Name: row.trackingName2.trim(), Option: row.trackingOption2.trim() });
          if (tracking.length) lineItem.Tracking = tracking;
          return lineItem;
        });
        const payload = { Type: "RECEIVE", IsReconciled: true, Contact: { Name: String(firstRow.contactName || "").trim() }, BankAccount: { Code: String(firstRow.bankAccountCode || "").trim() }, Date: txDate || new Date().toISOString().slice(0, 10), LineAmountTypes: "Exclusive", LineItems: lineItems };
        if (firstRow.reference) payload.Reference = String(firstRow.reference).trim();
        const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
        if (cc) payload.CurrencyCode = cc;
        const exRate = Number(firstRow.exchangeRate || "");
        if (Number.isFinite(exRate) && exRate > 0) payload.CurrencyRate = exRate;
        return payload;
      });
      const batchIdempotencyKey = crypto.randomBytes(16).toString("hex");
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransactions?summarizeErrors=false", {
          method: "PUT",
          timeoutMs: 90000,
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ BankTransactions: payloads }),
        });
        return { transactions: data?.BankTransactions || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroTxns = result.transactions || [];
      for (let j = 0; j < batchGroups.length; j++) {
        const groupRows = batchGroups[j];
        const xt = xeroTxns[j] || {};
        const errors = Array.isArray(xt.ValidationErrors) ? xt.ValidationErrors : [];
        if (xt.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const errMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this transaction.";
          for (const row of groupRows) {
            job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "error", message: errMsg });
            job.processed += 1;
          }
        } else {
          job.created += 1;
          for (const row of groupRows) {
            job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "created", message: "Receive Money transaction created successfully.", transactionId: xt?.BankTransactionID || "" });
            job.processed += 1;
          }
        }
      }
    } catch (err) {
      for (const groupRows of batchGroups) {
        for (const row of groupRows) {
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, reference: row.reference || "", contactName: row.contactName || "", status: "error", message: err.message });
          job.processed += 1;
        }
      }
    }
    job.updatedAt = Date.now();
  };
  for (let i = 0; i < recvGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = recvGroups[i]?.[0]?.rowNumber || null;
    job.currentRef = recvGroups[i]?.[0]?.reference || recvGroups[i]?.[0]?.contactName || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch receive-money groups ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, recvGroups.length)}/${recvGroups.length} (2 concurrent)`);
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= recvGroups.length) break;
      promises.push(runRecvBatch(recvGroups.slice(start, Math.min(start + BATCH_SIZE, recvGroups.length))));
    }
    await Promise.all(promises);
  }
  job.currentRowNumber = null;
  job.currentRef = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const rmCreatedIds = [...new Set(job.results.filter(r => r.transactionId).map(r => r.transactionId))];
  const rmHistEntry = recordImportHistory({ importType: "receive-money", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: rmCreatedIds, note: job.note || "" });
  job.historyId = rmHistEntry.id;
}

app.post("/api/import/receive-money/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheck = checkImportAccess(userData.user, "receive-money", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const filename = String(req.body?.filename || "receive_money.csv").trim();

    const normalizedRows = rows.map((row, i) => ({
      rowNumber: Number(row.rowNumber) || i + 2,
      bankAccountCode: String(row.bankAccountCode || "").trim(),
      contactName: String(row.contactName || "").trim(),
      date: String(row.date || "").trim(),
      reference: String(row.reference || "").trim(),
      currencyCode: String(row.currencyCode || "").trim(),
      exchangeRate: String(row.exchangeRate || "").trim(),
      description: String(row.description || "").trim(),
      quantity: String(row.quantity || "").trim(),
      unitAmount: String(row.unitAmount || "").trim(),
      accountCode: String(row.accountCode || "").trim(),
      taxType: String(row.taxType || "").trim(),
      taxAmount: String(row.taxAmount || "").trim(),
      trackingName1: String(row.trackingName1 || "").trim(),
      trackingOption1: String(row.trackingOption1 || "").trim(),
      trackingName2: String(row.trackingName2 || "").trim(),
      trackingOption2: String(row.trackingOption2 || "").trim(),
    }));

    const validationErrors = [];
    normalizedRows.forEach((row) => {
      if (!row.bankAccountCode) validationErrors.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.contactName) validationErrors.push(`Row ${row.rowNumber}: Contact Name is required.`);
      if (!row.date) validationErrors.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.description) validationErrors.push(`Row ${row.rowNumber}: Line Description is required.`);
    });
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join(" | ") });

    const skipDuplicateCheck = req.body?.skipDuplicateCheck === true;
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id, tenantId, sessionId, filename, skipDuplicateCheck,
      status: "queued", total: normalizedRows.length, processed: 0, created: 0, errors: 0,
      currentRowNumber: null, currentRef: "", rows: normalizedRows, results: [],
      note: extractJobNote(req),
      createdAt: Date.now(), updatedAt: Date.now(), startedAt: null, finishedAt: null, error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    receiveMoneyImportJobStore.set(job.id, job);
    setTimeout(() => {
      processReceiveMoneyImportJob(job).catch((err) => {
        job.status = "error"; job.error = err.message;
        job.finishedAt = Date.now(); job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildReceiveMoneyImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/receive-money/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = receiveMoneyImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Receive money import job not found" });
  if (!ownsReceiveMoneyImportJob(job, userData)) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildReceiveMoneyImportStatus(job) });
});

// ── Bill Payment Import ───────────────────────────────────────────────────────

async function createPaymentInXero({ tenantId, requestedSessionId, row, paymentType }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const txDate = parseDateForXero(row.date);
    const payload = {
      Invoice: {},
      Account: { Code: String(row.bankAccountCode || "").trim() },
      Date: txDate || new Date().toISOString().slice(0, 10),
      Amount: Number(row.amount) || 0,
    };
    // Prefer InvoiceNumber lookup; fallback to InvoiceID
    if (row.invoiceNumber) {
      payload.Invoice.InvoiceNumber = String(row.invoiceNumber).trim();
    } else if (row.invoiceId) {
      payload.Invoice.InvoiceID = String(row.invoiceId).trim();
    }
    if (row.reference) payload.Reference = String(row.reference).trim();
    const rate = Number(row.currencyRate || "");
    if (Number.isFinite(rate) && rate > 0) payload.CurrencyRate = rate;

    const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Payments?summarizeErrors=false", {
      method: "POST",
      timeoutMs: 90000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Payments: [payload] }),
    });
    const created = Array.isArray(data?.Payments) ? data.Payments[0] : {};
    const errors = Array.isArray(created?.ValidationErrors) ? created.ValidationErrors : [];
    if (created?.StatusAttributeString === "ERROR" || errors.length) {
      throw new Error(errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this payment.");
    }
    return { payment: created };
  });
}

async function createPaymentsBatchInXero({ tenantId, requestedSessionId, rows }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const payments = rows.map((row) => {
      const txDate = parseDateForXero(row.date);
      const payload = {
        Invoice: {},
        Account: { Code: String(row.bankAccountCode || "").trim() },
        Date: txDate || new Date().toISOString().slice(0, 10),
        Amount: Number(row.amount) || 0,
      };
      if (row.invoiceNumber) {
        payload.Invoice.InvoiceNumber = String(row.invoiceNumber).trim();
      } else if (row.invoiceId) {
        payload.Invoice.InvoiceID = String(row.invoiceId).trim();
      }
      if (row.reference) payload.Reference = String(row.reference).trim();
      const rate = Number(row.currencyRate || "");
      if (Number.isFinite(rate) && rate > 0) payload.CurrencyRate = rate;
      return payload;
    });
    const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Payments?summarizeErrors=false", {
      method: "POST",
      timeoutMs: 90000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Payments: payments }),
    });
    return { payments: data?.Payments || [] };
  });
}

async function createCreditNoteRefundsBatchInXero({ tenantId, requestedSessionId, rows }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const payments = rows.map((row) => {
      const txDate = parseDateForXero(row.date);
      const payload = {
        CreditNote: { CreditNoteNumber: String(row.creditNoteNumber || "").trim() },
        Account: { Code: String(row.bankAccountCode || "").trim() },
        Date: txDate || new Date().toISOString().slice(0, 10),
        Amount: Number(row.amount) || 0,
      };
      if (row.reference) payload.Reference = String(row.reference).trim();
      const rate = Number(row.currencyRate || "");
      if (Number.isFinite(rate) && rate > 0) payload.CurrencyRate = rate;
      return payload;
    });
    const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Payments?summarizeErrors=false", {
      method: "POST",
      timeoutMs: 90000,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify({ Payments: payments }),
    });
    return { payments: data?.Payments || [] };
  });
}

function buildPaymentImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  const allResults = Array.isArray(job.results) ? job.results : [];
  return {
    jobId: job.id, filename: job.filename, tenantId: job.tenantId,
    status: job.status, total, processed, remaining,
    created: job.created || 0, errors: job.errors || 0,
    currentRowNumber: job.currentRowNumber || null,
    currentRef: job.currentRef || "",
    results: allResults.slice(-200),
    etaMs, error: job.error || "",
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    historyId: job.historyId || "",
  };
}

function parseXeroDateToYMD(xeroDate) {
  if (!xeroDate) return null;
  const m = String(xeroDate).match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (m) return new Date(parseInt(m[1], 10)).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(xeroDate))) return String(xeroDate).slice(0, 10);
  return null;
}

async function findBillByContactAmountDate(job, row) {
  const contactName = String(row.contactName || "").trim();
  if (!contactName) return { error: "No Contact Name provided for fallback lookup." };
  const targetAmount = Number(row.amount);
  const targetDate = parseDateForXero(row.date);
  if (!targetDate || !Number.isFinite(targetAmount) || targetAmount <= 0) {
    return { error: "Invalid amount or date for fallback lookup." };
  }
  try {
    const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
      const safeContact = contactName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const where = `Type=="ACCPAY"&&Status=="AUTHORISED"&&Contact.Name=="${safeContact}"`;
      const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(where)}`;
      const { data } = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" },
      });
      return { invoices: data?.Invoices || [], resolvedSessionId: null };
    });
    if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
    const matches = (r.invoices || []).filter(inv => {
      const invAmount = Number(inv.AmountDue);
      const invDate = parseXeroDateToYMD(inv.Date);
      return Math.abs(invAmount - targetAmount) < 0.005 && invDate === targetDate;
    });
    if (matches.length === 1) return { invoiceId: matches[0].InvoiceID };
    if (matches.length === 0) return { error: "Could not uniquely match by amount+date — no matching bills found for this contact." };
    return { error: `Could not uniquely match by amount+date — ${matches.length} matching bills found for this contact.` };
  } catch (err) {
    return { error: `Fallback lookup failed: ${err.message}` };
  }
}

async function processPaymentImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = job.batchSize || 100;
  const CONCURRENCY = 3;

  const runPaymentBatch = async (batch) => {
    const fallbackRows = [];
    try {
      const result = await createPaymentsBatchInXero({
        tenantId: job.tenantId,
        requestedSessionId: job.sessionId,
        rows: batch,
      });
      if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroPayments = Array.isArray(result.payments) ? result.payments : [];
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xp = xeroPayments[j] || {};
        const errors = Array.isArray(xp?.ValidationErrors) ? xp.ValidationErrors : [];
        if (xp?.StatusAttributeString === "ERROR" || errors.length) {
          const errMsg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this payment.";
          const isNotFound = /not found|does not exist|cannot be found/i.test(errMsg);
          if (isNotFound && row.contactName && job.paymentType === "ACCPAYPAYMENT") {
            fallbackRows.push(row);
          } else {
            job.errors += 1;
            job.results.push({
              rowNumber: row.rowNumber,
              invoiceNumber: row.invoiceNumber || "",
              reference: row.reference || "",
              amount: row.amount || "",
              status: "error",
              message: errMsg,
            });
            job.processed += 1;
          }
        } else {
          job.created += 1;
          job.results.push({
            rowNumber: row.rowNumber,
            invoiceNumber: row.invoiceNumber || "",
            reference: row.reference || "",
            amount: row.amount || "",
            status: "created",
            message: "Payment created successfully.",
            paymentId: xp?.PaymentID || "",
          });
          job.processed += 1;
        }
      }
    } catch (err) {
      for (const row of batch) {
        job.errors += 1;
        job.results.push({
          rowNumber: row.rowNumber,
          invoiceNumber: row.invoiceNumber || "",
          reference: row.reference || "",
          amount: row.amount || "",
          status: "error",
          message: err.message,
        });
        job.processed += 1;
      }
    }
    // Fallback: for bill-payment rows where invoice number not found, try contact+amount+date match
    for (const row of fallbackRows) {
      const fallback = await findBillByContactAmountDate(job, row);
      if (fallback.invoiceId) {
        try {
          const retryResult = await createPaymentsBatchInXero({
            tenantId: job.tenantId,
            requestedSessionId: job.sessionId,
            rows: [{ ...row, invoiceNumber: null, invoiceId: fallback.invoiceId }],
          });
          if (retryResult?.resolvedSessionId) job.sessionId = retryResult.resolvedSessionId;
          const xp = Array.isArray(retryResult.payments) ? retryResult.payments[0] : {};
          const retryErrors = Array.isArray(xp?.ValidationErrors) ? xp.ValidationErrors : [];
          if (xp?.StatusAttributeString === "ERROR" || retryErrors.length) {
            const msg = retryErrors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this payment.";
            job.errors += 1;
            job.results.push({ rowNumber: row.rowNumber, invoiceNumber: row.invoiceNumber || "", reference: row.reference || "", amount: row.amount || "", status: "error", message: `Fallback matched bill but payment failed: ${msg}` });
          } else {
            job.created += 1;
            job.results.push({ rowNumber: row.rowNumber, invoiceNumber: row.invoiceNumber || "", reference: row.reference || "", amount: row.amount || "", status: "created", message: "Payment created via fallback (matched by contact + amount + date).", paymentId: xp?.PaymentID || "" });
          }
        } catch (retryErr) {
          job.errors += 1;
          job.results.push({ rowNumber: row.rowNumber, invoiceNumber: row.invoiceNumber || "", reference: row.reference || "", amount: row.amount || "", status: "error", message: `Fallback retry failed: ${retryErr.message}` });
        }
      } else {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, invoiceNumber: row.invoiceNumber || "", reference: row.reference || "", amount: row.amount || "", status: "error", message: fallback.error });
      }
      job.processed += 1;
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = job.rows[i]?.rowNumber || null;
    job.currentRef = job.rows[i]?.invoiceNumber || job.rows[i]?.reference || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch rows ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, job.rows.length)}/${job.total} (2 concurrent)`);
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.rows.length) break;
      promises.push(runPaymentBatch(job.rows.slice(start, Math.min(start + BATCH_SIZE, job.rows.length))));
    }
    await Promise.all(promises);
  }
  job.currentRowNumber = null;
  job.currentRef = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const pmtCreatedIds = [...new Set(job.results.filter(r => r.paymentId).map(r => r.paymentId))];
  const pmtType = job.paymentType === "ACCPAYPAYMENT" ? "bill-payments" : job.paymentType === "ACCRECPAYMENT" ? "invoice-payments" : "payments";
  const pmtHistEntry = recordImportHistory({ importType: pmtType, tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: pmtCreatedIds, note: job.note || "" });
  job.historyId = pmtHistEntry.id;
}

function startPaymentImportJob({ req, res, jobStore, paymentType, label, batchSize = 50 }) {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: `No rows found in the CSV file.` });
    const pmtTypeKey = paymentType === "ACCPAYPAYMENT" ? "bill-payments" : "invoice-payments";
    const planCheckPmt = checkImportAccess(userData.user, pmtTypeKey, rows.length);
    if (!planCheckPmt.allowed) return res.status(403).json({ error: planCheckPmt.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const filename = String(req.body?.filename || `${label.toLowerCase().replace(/\s+/g, "_")}.csv`).trim();

    const normalizedRows = rows.map((row, i) => {
      const rawInv = String(row.invoiceNumber || "").trim();
      return {
        rowNumber: Number(row.rowNumber) || i + 2,
        invoiceNumber: /^\d+$/.test(rawInv) ? String(parseInt(rawInv, 10)) : rawInv,
        invoiceId: String(row.invoiceId || "").trim(),
        bankAccountCode: String(row.bankAccountCode || "").trim(),
        date: String(row.date || "").trim(),
        amount: String(row.amount || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyRate: String(row.currencyRate || "").trim(),
      };
    });

    const validationErrors = [];
    normalizedRows.forEach((row) => {
      if (!row.invoiceNumber && !row.invoiceId) validationErrors.push(`Row ${row.rowNumber}: Invoice Number (or Invoice ID) is required.`);
      if (!row.bankAccountCode) validationErrors.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.date) validationErrors.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.amount || isNaN(Number(row.amount))) validationErrors.push(`Row ${row.rowNumber}: Amount is required and must be a number.`);
    });
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join(" | ") });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id, tenantId, sessionId, filename, paymentType, batchSize,
      status: "queued", total: normalizedRows.length, processed: 0, created: 0, errors: 0,
      currentRowNumber: null, currentRef: "", rows: normalizedRows, results: [],
      note: extractJobNote(req),
      createdAt: Date.now(), updatedAt: Date.now(), startedAt: null, finishedAt: null, error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    jobStore.set(job.id, job);
    setTimeout(() => {
      processPaymentImportJob(job).catch((err) => {
        job.status = "error"; job.error = err.message;
        job.finishedAt = Date.now(); job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildPaymentImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

app.post("/api/import/bill-payments/start", (req, res) => {
  startPaymentImportJob({ req, res, jobStore: billPaymentImportJobStore, paymentType: "ACCPAYPAYMENT", label: "Bill Payment" });
});

app.get("/api/import/bill-payments/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = billPaymentImportJobStore.get(String(req.query.jobId || "").trim());
  if (!job) return res.status(404).json({ error: "Bill payment import job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildPaymentImportStatus(job) });
});

app.post("/api/import/invoice-payments/start", (req, res) => {
  startPaymentImportJob({ req, res, jobStore: invoicePaymentImportJobStore, paymentType: "ACCRECPAYMENT", label: "Invoice Payment" });
});

app.get("/api/import/invoice-payments/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = invoicePaymentImportJobStore.get(String(req.query.jobId || "").trim());
  if (!job) return res.status(404).json({ error: "Invoice payment import job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildPaymentImportStatus(job) });
});

// ── Xero Pre-Validation ─────────────────────────────────────────────────────
// Quick pre-check: do these invoice numbers / contacts exist in Xero?
app.post("/api/precheck/invoices", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || "").trim();
    if (!tenantId) return res.status(400).json({ error: "tenantId required" });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim() || null;
    const invoiceNumbers = Array.isArray(req.body?.invoiceNumbers) ? req.body.invoiceNumbers.filter(Boolean) : [];
    const statuses = String(req.body?.statuses || "AUTHORISED,PARTIAL,DRAFT").trim();
    if (!invoiceNumbers.length) return res.status(400).json({ error: "invoiceNumbers required" });
    if (invoiceNumbers.length > 500) return res.status(400).json({ error: "Maximum 500 invoice numbers per pre-check." });

    const found = new Map();
    const BATCH = 50;
    for (let i = 0; i < invoiceNumbers.length; i += BATCH) {
      const batch = invoiceNumbers.slice(i, i + BATCH);
      const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
        const response = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${batch.map(encodeURIComponent).join(",")}&Statuses=${statuses}`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
        );
        return { invoices: response.data?.Invoices || [] };
      });
      recordApiUsage("Pre-Validation");
      for (const inv of result?.invoices || []) {
        const num = String(inv.InvoiceNumber || "").trim();
        if (num) found.set(num.toLowerCase(), { invoiceNumber: num, type: inv.Type, status: inv.Status, amountDue: inv.AmountDue, contact: inv.Contact?.Name || "" });
      }
    }
    const notFound = invoiceNumbers.filter(n => !found.has(String(n).trim().toLowerCase()));
    const foundList = invoiceNumbers.filter(n => found.has(String(n).trim().toLowerCase())).map(n => found.get(String(n).trim().toLowerCase()));
    return res.json({ ok: true, total: invoiceNumbers.length, found: foundList.length, notFound: notFound.length, notFoundList: notFound.slice(0, 50), foundList: foundList.slice(0, 50) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/precheck/contacts", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || "").trim();
    if (!tenantId) return res.status(400).json({ error: "tenantId required" });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim() || null;
    const contactNames = [...new Set((Array.isArray(req.body?.contactNames) ? req.body.contactNames : []).filter(Boolean))];
    if (!contactNames.length) return res.status(400).json({ error: "contactNames required" });
    if (contactNames.length > 200) return res.status(400).json({ error: "Maximum 200 contacts per pre-check." });

    const found = new Set();
    const BATCH = 50;
    for (let i = 0; i < contactNames.length; i += BATCH) {
      const batch = contactNames.slice(i, i + BATCH);
      try {
        const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
          const response = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`IsSupplier=true OR IsCustomer=true`)}&summaryOnly=true&SearchTerm=${encodeURIComponent(batch[0])}`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
          );
          return { contacts: response.data?.Contacts || [] };
        });
        recordApiUsage("Pre-Validation");
        for (const c of result?.contacts || []) {
          found.add(String(c.Name || "").trim().toLowerCase());
        }
      } catch (_) {}
    }
    const notFound = contactNames.filter(n => !found.has(String(n).trim().toLowerCase()));
    return res.json({ ok: true, total: contactNames.length, found: contactNames.length - notFound.length, notFound: notFound.length, notFoundList: notFound.slice(0, 50) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Credit Note Refunds Import ───────────────────────────────────────────────

function buildCreditNoteRefundImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    status: job.status,
    total,
    processed,
    created: job.created || 0,
    errors: job.errors || 0,
    remaining,
    etaMs,
    currentRef: job.currentRef || "",
    currentRowNumber: job.currentRowNumber || null,
    results: job.results || [],
    error: job.error || "",
  };
}

async function processCreditNoteRefundsImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 100;
  const CONCURRENCY = 3;

  const runRefundBatch = async (batch) => {
    try {
      const result = await createCreditNoteRefundsBatchInXero({
        tenantId: job.tenantId,
        requestedSessionId: job.sessionId,
        rows: batch,
      });
      if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroPayments = Array.isArray(result.payments) ? result.payments : [];
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xp = xeroPayments[j] || {};
        const errors = Array.isArray(xp?.ValidationErrors) ? xp.ValidationErrors : [];
        if (xp?.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          job.results.push({
            rowNumber: row.rowNumber,
            creditNoteNumber: row.creditNoteNumber || "",
            amount: row.amount || "",
            status: "error",
            message: errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this refund.",
          });
        } else {
          job.created += 1;
          job.results.push({
            rowNumber: row.rowNumber,
            creditNoteNumber: row.creditNoteNumber || "",
            amount: row.amount || "",
            status: "created",
            message: "Refund created successfully.",
            paymentId: xp?.PaymentID || "",
          });
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const row of batch) {
        job.errors += 1;
        job.results.push({
          rowNumber: row.rowNumber,
          creditNoteNumber: row.creditNoteNumber || "",
          amount: row.amount || "",
          status: "error",
          message: err.message,
        });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRowNumber = job.rows[i]?.rowNumber || null;
    job.currentRef = job.rows[i]?.creditNoteNumber || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch credit-note-refunds ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, job.rows.length)}/${job.total} (2 concurrent)`);
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.rows.length) break;
      promises.push(runRefundBatch(job.rows.slice(start, Math.min(start + BATCH_SIZE, job.rows.length))));
    }
    await Promise.all(promises);
  }
  job.currentRowNumber = null;
  job.currentRef = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/credit-note-refunds/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheck = checkImportAccess(userData.user, "credit-note-refunds", rows.length);
    if (!planCheck.allowed) return res.status(403).json({ error: planCheck.error, planError: true });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const filename = String(req.body?.filename || "credit_note_refunds.csv").trim();

    const normalizedRows = rows.map((row, i) => {
      const rawCN = String(row.creditNoteNumber || "").trim();
      return {
        rowNumber: Number(row.rowNumber) || i + 2,
        creditNoteNumber: /^\d+$/.test(rawCN) ? String(parseInt(rawCN, 10)) : rawCN,
        bankAccountCode: String(row.bankAccountCode || "").trim(),
        date: String(row.date || "").trim(),
        amount: String(row.amount || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyRate: String(row.currencyRate || "").trim(),
      };
    });

    const validationErrors = [];
    normalizedRows.forEach((row) => {
      if (!row.creditNoteNumber) validationErrors.push(`Row ${row.rowNumber}: Credit Note Number is required.`);
      if (!row.bankAccountCode) validationErrors.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.date) validationErrors.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.amount || isNaN(Number(row.amount))) validationErrors.push(`Row ${row.rowNumber}: Amount is required and must be a number.`);
    });
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join(" | ") });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id, tenantId, sessionId, filename,
      status: "queued", total: normalizedRows.length, processed: 0, created: 0, errors: 0,
      currentRowNumber: null, currentRef: "", rows: normalizedRows, results: [],
      note: extractJobNote(req),
      createdAt: Date.now(), updatedAt: Date.now(), startedAt: null, finishedAt: null, error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    creditNoteRefundImportJobStore.set(job.id, job);
    setTimeout(() => {
      processCreditNoteRefundsImportJob(job).catch((err) => {
        job.status = "error"; job.error = err.message;
        job.finishedAt = Date.now(); job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildCreditNoteRefundImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/credit-note-refunds/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = creditNoteRefundImportJobStore.get(String(req.query.jobId || "").trim());
  if (!job) return res.status(404).json({ error: "Credit note refund import job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildCreditNoteRefundImportStatus(job) });
});

// ── Manual Journal Import ────────────────────────────────────────────────────

async function createManualJournalInXero({ tenantId, requestedSessionId, journal }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const txDate = parseDateForXero(journal.date);
    const journalLines = (journal.lines || []).map((line) => {
      const lineAmount = (Number(line.debit) || 0) - (Number(line.credit) || 0);
      const obj = {
        LineAmount: lineAmount,
        AccountCode: String(line.accountCode || "").trim(),
      };
      if (line.description) obj.Description = String(line.description).trim();
      if (line.taxType) obj.TaxType = String(line.taxType).trim().toUpperCase();
      const tracking = [];
      if (line.trackingName1 && line.trackingOption1) tracking.push({ Name: String(line.trackingName1).trim(), Option: String(line.trackingOption1).trim() });
      if (line.trackingName2 && line.trackingOption2) tracking.push({ Name: String(line.trackingName2).trim(), Option: String(line.trackingOption2).trim() });
      if (tracking.length) obj.Tracking = tracking;
      return obj;
    });
    const payload = {
      Narration: String(journal.narration || journal.reference || "").trim(),
      Date: txDate || new Date().toISOString().slice(0, 10),
      LineAmountTypes: "Exclusive",
      JournalLines: journalLines,
    };
    const { data } = await fetchWithRetry(
      "https://api.xero.com/api.xro/2.0/ManualJournals?summarizeErrors=false",
      {
        method: "POST",
        timeoutMs: 180000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "xero-tenant-id": tenantId,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
        },
        body: JSON.stringify({ ManualJournals: [payload] }),
      }
    );
    const created = Array.isArray(data?.ManualJournals) ? data.ManualJournals[0] : {};
    const errors = Array.isArray(created?.ValidationErrors) ? created.ValidationErrors : [];
    if (created?.StatusAttributeString === "ERROR" || errors.length) {
      throw new Error(
        errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") ||
          "Xero rejected this journal."
      );
    }
    return { journal: created };
  });
}

function buildManualJournalImportStatus(job) {
  const total = job.total || 0;
  const processed = job.processed || 0;
  const etaMs =
    job.startedAt && processed > 0
      ? Math.round(((Date.now() - job.startedAt) / processed) * (total - processed))
      : null;
  return {
    jobId: job.id, filename: job.filename, tenantId: job.tenantId,
    status: job.status, total, processed,
    created: job.created || 0, errors: job.errors || 0,
    currentRef: job.currentRef || "",
    results: Array.isArray(job.results) ? job.results : [],
    etaMs, error: job.error || "",
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    historyId: job.historyId || "",
  };
}

async function processManualJournalImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;

  // Pre-fetch tax rates to resolve display names (e.g. "Tax Exempt" → the org's actual TaxType code)
  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
    console.log(`[Import ${job.id}] Tax rates resolved: ${taxNameToCode.size} rate(s) loaded.`);
  } catch (err) {
    console.error(`[Import ${job.id}] Tax rate lookup failed, TaxType will be skipped on all lines: ${err.message}`);
  }

  const buildPayload = (journal) => {
    const txDate = parseDateForXero(journal.date);
    const journalLines = (journal.lines || []).map((line, _li) => {
      const lineAmount = (line.debit || line.credit)
        ? (Number(line.debit) || 0) - (Number(line.credit) || 0)
        : (Number(line.amount) || 0);
      const accountCode = String(line.accountCode || "").trim();
      if (!accountCode) throw new Error(`Journal "${journal.narration || journal.reference}": Line ${_li + 1} is missing Account Code — check your CSV column mapping.`);
      const obj = { LineAmount: lineAmount, AccountCode: accountCode };
      if (line.description) obj.Description = String(line.description).trim();
      // If tax-rate lookup failed (empty map), sending the raw display name is guaranteed to be
      // rejected by Xero — skip TaxType entirely rather than wasting a doomed first attempt.
      if (line.taxType && taxNameToCode.size > 0) obj.TaxType = resolveTaxType(line.taxType, taxNameToCode);
      const tracking = [];
      if (line.trackingName1 && line.trackingOption1) tracking.push({ Name: String(line.trackingName1).trim(), Option: String(line.trackingOption1).trim() });
      if (line.trackingName2 && line.trackingOption2) tracking.push({ Name: String(line.trackingName2).trim(), Option: String(line.trackingOption2).trim() });
      if (tracking.length) obj.Tracking = tracking;
      return obj;
    });
    return { Narration: String(journal.narration || journal.reference || "").trim(), Date: txDate || new Date().toISOString().slice(0, 10), LineAmountTypes: "Exclusive", JournalLines: journalLines };
  };

  const runJournalBatch = async (batch) => {
    try {
      const payloads = batch.map(buildPayload);
      const batchIdempotencyKey = crypto.createHash("sha256").update(job.id + "|journals|" + batch.map(j => j.reference || j.narration || String(j.rowNumber)).join(",")).digest("hex").slice(0, 32);
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const payloadDebug = payloads.map(p => ({ Narration: p.Narration, lines: p.JournalLines.map(l => ({ ac: l.AccountCode, amt: l.LineAmount })) }));
        console.log(`[Import ${job.id}] Sending to Xero:`, JSON.stringify(payloadDebug));
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/ManualJournals?summarizeErrors=false", {
          method: "POST",
          timeoutMs: 180000,
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": batchIdempotencyKey },
          body: JSON.stringify({ ManualJournals: payloads }),
        });
        const journals = data?.ManualJournals || [];
        journals.forEach((j, ji) => {
          const lineDebug = (j.JournalLines || []).map(l => ({ ac: l.AccountCode, amt: l.LineAmount, err: (l.ValidationErrors||[]).map(e=>e.Message) }));
          console.log(`[Import] Xero response journal ${ji+1}: status=${j.StatusAttributeString} lines=${JSON.stringify(lineDebug)} errors=${JSON.stringify(j.ValidationErrors||[])}`);
        });
        return { journals };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroJournals = result.journals || [];
      for (let j = 0; j < batch.length; j++) {
        const journal = batch[j];
        const xj = xeroJournals[j] || {};
        const errors = Array.isArray(xj.ValidationErrors) ? xj.ValidationErrors : [];
        if (xj.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          job.results.push({ rowNumber: journal.rowNumber, reference: journal.reference || "", narration: journal.narration || "", linesCount: Array.isArray(journal.lines) ? journal.lines.length : 0, status: "error", message: errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this journal." });
        } else {
          job.created += 1;
          job.results.push({ rowNumber: journal.rowNumber, reference: journal.reference || "", narration: journal.narration || "", linesCount: Array.isArray(journal.lines) ? journal.lines.length : 0, status: "created", message: "Journal created successfully.", journalId: xj?.ManualJournalID || "" });
        }
        job.processed += 1;
      }
    } catch (err) {
      const isTimeout = err.message && err.message.includes("timed out");
      for (const journal of batch) {
        if (isTimeout) {
          // Timeout: Xero may have created the journal despite the timeout — check before marking as error
          try {
            const narration = String(journal.narration || journal.reference || "").trim().replace(/"/g, '\\"');
            const checkResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
              const { data } = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/ManualJournals?where=${encodeURIComponent(`Narration=="${narration}"`)}`,
                { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
              );
              return { journals: data?.ManualJournals || [] };
            });
            if (checkResult.resolvedSessionId) job.sessionId = checkResult.resolvedSessionId;
            const found = (checkResult.journals || []).find(j => String(j.Narration || "").trim() === String(journal.narration || journal.reference || "").trim());
            if (found) {
              job.created += 1;
              job.results.push({ rowNumber: journal.rowNumber, reference: journal.reference || "", narration: journal.narration || "", linesCount: Array.isArray(journal.lines) ? journal.lines.length : 0, status: "created", message: "Journal created successfully (confirmed after timeout).", journalId: found.ManualJournalID || "" });
              job.processed += 1;
              continue;
            }
          } catch (_) {}
        }
        job.errors += 1;
        job.results.push({ rowNumber: journal.rowNumber, reference: journal.reference || "", narration: journal.narration || "", linesCount: Array.isArray(journal.lines) ? journal.lines.length : 0, status: "error", message: err.message });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRef = job.rows[i]?.reference || job.rows[i]?.narration || "";
    job.updatedAt = Date.now();
    console.log(`[Import ${job.id}] Batch manual-journals ${i + 1}-${Math.min(i + BATCH_SIZE * CONCURRENCY, job.rows.length)}/${job.total} (4 concurrent)`);
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.rows.length) break;
      promises.push(runJournalBatch(job.rows.slice(start, Math.min(start + BATCH_SIZE, job.rows.length))));
    }
    await Promise.all(promises);
  }

  job.currentRef = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const mjCreatedIds = [...new Set(job.results.filter(r => r.journalId).map(r => r.journalId))];
  const mjHistEntry = recordImportHistory({ importType: "manual-journals", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds: mjCreatedIds, note: job.note || "" });
  job.historyId = mjHistEntry.id;
}

function startManualJournalImportJob(req, res) {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const journals = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!journals.length) return res.status(400).json({ error: "No journals found in the CSV file." });
    const planCheckMJ = checkImportAccess(userData.user, "manual-journals", journals.length);
    if (!planCheckMJ.allowed) return res.status(403).json({ error: planCheckMJ.error, planError: true });
    if (journals.length > 50000) return res.status(400).json({ error: "Maximum 50000 journals per import." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const filename = String(req.body?.filename || "manual_journals.csv").trim();

    const validationErrors = [];
    journals.forEach((journal, i) => {
      const num = journal.rowNumber || (i + 1);
      const ref = journal.reference || `#${num}`;
      if (!journal.reference && !journal.narration) validationErrors.push(`Journal ${num}: Journal Reference or Narration is required.`);
      if (!journal.date) validationErrors.push(`Journal "${ref}": Date is required.`);
      if (!Array.isArray(journal.lines) || journal.lines.length < 2)
        validationErrors.push(`Journal "${ref}": At least 2 journal lines required.`);
      if (Array.isArray(journal.lines)) {
        journal.lines.forEach((line, li) => {
          if (!line.accountCode) validationErrors.push(`Journal "${ref}", line ${li + 1}: Account Code is required.`);
        });
        const totalDebit = journal.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
        const totalCredit = journal.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
        if (Math.abs(totalDebit - totalCredit) > 0.01)
          validationErrors.push(`Journal "${ref}": Not balanced — Debit ${totalDebit.toFixed(2)} ≠ Credit ${totalCredit.toFixed(2)}.`);
      }
    });
    if (validationErrors.length) return res.status(400).json({ error: validationErrors.join(" | ") });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id, tenantId, sessionId, filename,
      status: "queued", total: journals.length, processed: 0, created: 0, errors: 0,
      currentRef: "", rows: journals, results: [],
      note: extractJobNote(req),
      createdAt: Date.now(), updatedAt: Date.now(), startedAt: null, finishedAt: null, error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    manualJournalImportJobStore.set(job.id, job);
    setTimeout(() => {
      processManualJournalImportJob(job).catch((err) => {
        job.status = "error"; job.error = err.message;
        job.finishedAt = Date.now(); job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildManualJournalImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

app.post("/api/import/manual-journals/start", (req, res) => {
  startManualJournalImportJob(req, res);
});

app.get("/api/import/manual-journals/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = manualJournalImportJobStore.get(String(req.query.jobId || "").trim());
  if (!job) return res.status(404).json({ error: "Manual journal import job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildManualJournalImportStatus(job) });
});

// ── Manual Journal Date Fix ───────────────────────────────────────────────────

async function processJournalFixJob(job) {
  try {
    const [fy, fm, fd] = job.dateFrom.split("-").map(Number);
    const [ty, tm, td] = job.dateTo.split("-").map(Number);
    const whereClause = `Date>=DateTime(${fy},${fm},${fd})&&Date<=DateTime(${ty},${tm},${td})`;

    // Fetch all journals in range (paginated, 100 per page)
    let page = 1;
    const allJournals = [];
    while (true) {
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/ManualJournals?where=${encodeURIComponent(whereClause)}&page=${page}&pageSize=1000`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { journals: data?.ManualJournals || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const journals = result.journals || [];
      allJournals.push(...journals);
      if (journals.length < 1000) break;
      page++;
    }

    job.total = allJournals.length;
    job.message = `Found ${allJournals.length} journal(s). Updating dates...`;

    const shiftDate = (dateStr, days) => {
      const d = new Date(dateStr + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    for (const j of allJournals) {
      job.fetched = (job.fetched || 0) + 1;
      if (j.Status === "POSTED") { job.skipped++; continue; }
      const oldDate = j.DateString || "";
      if (!oldDate) { job.failed++; continue; }
      const newDate = shiftDate(oldDate, job.shiftDays);
      const simplifiedLines = (j.JournalLines || []).map(line => {
        const obj = { LineAmount: line.LineAmount, AccountCode: line.AccountCode };
        if (line.Description) obj.Description = line.Description;
        if (line.TaxType) obj.TaxType = line.TaxType;
        if (line.Tracking && line.Tracking.length) obj.Tracking = line.Tracking.map(t => ({ Name: t.Name, Option: t.Option }));
        return obj;
      });
      try {
        await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/ManualJournals/${j.ManualJournalID}`,
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" },
              body: JSON.stringify({ Date: newDate, Narration: j.Narration || "", LineAmountTypes: j.LineAmountTypes || "Exclusive", JournalLines: simplifiedLines }),
            }
          );
          return { ok: true };
        });
        job.updated++;
      } catch (err) {
        job.failed++;
        if (job.errors.length < 10) job.errors.push(`${j.ManualJournalID}: ${err.message}`);
      }
    }

    job.status = job.failed > 0 ? "completed_with_errors" : "completed";
    job.message = `Updated ${job.updated} of ${job.total} journal(s).${job.skipped > 0 ? ` ${job.skipped} POSTED (skipped).` : ""}${job.failed > 0 ? ` ${job.failed} failed.` : ""}`;
    job.finishedAt = Date.now();
  } catch (err) {
    job.status = "error";
    job.message = err.message;
    job.finishedAt = Date.now();
  }
}

app.post("/api/import/manual-journals/fix-dates", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation." });
    const dateFrom = String(req.body?.dateFrom || "").trim();
    const dateTo = String(req.body?.dateTo || "").trim();
    const shiftDays = Number(req.body?.shiftDays);
    if (!dateFrom || !dateTo) return res.status(400).json({ error: "Date range is required." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo))
      return res.status(400).json({ error: "Date format must be YYYY-MM-DD." });
    if (!Number.isInteger(shiftDays) || shiftDays === 0 || Math.abs(shiftDays) > 30)
      return res.status(400).json({ error: "Shift must be a non-zero integer between -30 and 30." });
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId, sessionId, dateFrom, dateTo, shiftDays,
      status: "running",
      total: 0, fetched: 0, updated: 0, skipped: 0, failed: 0,
      errors: [],
      createdAt: Date.now(), finishedAt: null, message: "Fetching journals from Xero...",
    };
    journalFixJobStore.set(job.id, job);
    processJournalFixJob(job).catch((err) => {
      job.status = "error"; job.message = err.message; job.finishedAt = Date.now();
    });
    return res.json({ ok: true, jobId: job.id });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/manual-journals/fix-dates/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const job = journalFixJobStore.get(String(req.query.jobId || "").trim());
  if (!job) return res.status(404).json({ error: "Fix job not found" });
  if (job.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, status: job.status, total: job.total, updated: job.updated, skipped: job.skipped, failed: job.failed, message: job.message, errors: job.errors });
});

// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/billpayment/:paymentId", async (req, res) => {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }

    const paymentId = String(req.params.paymentId || "").trim();
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

    const tenantId = String(
      req.header("x-tenant-id") ||
        req.query.tenantId ||
        req.body?.tenantId ||
        ""
    ).trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }

    const requestedSessionId = req.header("x-session-id") || req.body?.sessionId;
    const result = await runWithCandidateSessions(
      requestedSessionId,
      async ({ accessToken }) =>
        fetchPaymentById({
          accessToken,
          tenantId,
          paymentId,
        })
    );

    if (!result.payment) {
      return res.status(404).json({
        error: "Payment not found",
        paymentId,
        tenantId,
        sessionId: result.resolvedSessionId,
      });
    }

    return res.json({
      ok: true,
      paymentId,
      tenantId,
      sessionId: result.resolvedSessionId,
      payment: result.payment,
      rate: result.response?.rate || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/billpayment/bulk-delete", async (req, res) => {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }

    const tenantId = String(
      req.header("x-tenant-id") ||
        req.body?.tenantId ||
        req.query.tenantId ||
        ""
    ).trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }

    const filename = String(req.body?.filename || "").trim();
    const contentBase64 = String(req.body?.contentBase64 || "").trim();
    const columnName = String(req.body?.columnName || "payment id").trim();
    if (!filename || !contentBase64) {
      return res.status(400).json({ error: "Missing uploaded sheet data" });
    }

    const requestedSessionId = req.header("x-session-id") || req.body?.sessionId;
    const uploadedRows = await extractPaymentIdsFromUpload({
      filename,
      contentBase64,
      columnName,
    });

    if (!uploadedRows.length) {
      return res.status(400).json({ error: "No data rows found in sheet." });
    }

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: requestedSessionId || latestSession?.sessionId || null,
      filename,
      status: "queued",
      total: uploadedRows.length,
      processed: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      currentPaymentId: "",
      currentRowNumber: null,
      results: [],
      rows: uploadedRows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };

    bulkDeleteJobStore.set(job.id, job);
    setTimeout(() => {
      processBulkDeleteJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);

    return res.json({
      ok: true,
      ...buildBulkDeleteStatus(job),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/billpayment/bulk-delete/status", (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }

  const jobId = String(req.query.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  const job = bulkDeleteJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Bulk delete job not found" });
  }
  if (!ownsBulkDeleteJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return res.json({
    ok: true,
    ...buildBulkDeleteStatus(job),
  });
});

function startBulkVoidJob({ req, res, allowedTypes, oppositeLabel }) {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }

    const tenantId = String(
      req.header("x-tenant-id") || req.body?.tenantId || req.query.tenantId || ""
    ).trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }

    const filename = String(req.body?.filename || "").trim();
    const contentBase64 = String(req.body?.contentBase64 || "").trim();
    if (!filename || !contentBase64) {
      return res.status(400).json({ error: "Missing uploaded sheet data" });
    }

    const requestedSessionId = req.header("x-session-id") || req.body?.sessionId;

    return extractInvoiceCreditTargetsFromUpload({ filename, contentBase64 })
      .then((uploadedRows) => {
        if (!uploadedRows.length) {
          return res.status(400).json({ error: "No data rows found in sheet." });
        }

        const job = {
          id: crypto.randomBytes(12).toString("hex"),
          userId: userData.user.id,
          userEmail: userData.user.email,
          tenantId,
          sessionId: requestedSessionId || latestSession?.sessionId || null,
          filename,
          allowedTypes,
          oppositeLabel,
          status: "queued",
          total: uploadedRows.length,
          processed: 0,
          voided: 0,
          deleted: 0,
          skipped: 0,
          errors: 0,
          currentRowNumber: null,
          results: [],
          rows: uploadedRows,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          error: "",
          cancelRequested: false,
        };

        bulkVoidJobStore.set(job.id, job);
        setTimeout(() => {
          processBulkVoidJob(job).catch((err) => {
            job.status = "error";
            job.error = err.message;
            job.finishedAt = Date.now();
            job.updatedAt = Date.now();
          });
        }, 0);

        return res.json({ ok: true, ...buildBulkVoidStatus(job) });
      })
      .catch((err) => res.status(500).json({ error: err.message }));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function cancelBulkVoidJob({ req, res }) {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }

  const jobId = String(req.body?.jobId || req.query.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  const job = bulkVoidJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Bulk delete job not found" });
  }
  if (!ownsBulkDeleteJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (job.status === "completed" || job.status === "cancelled" || job.status === "error") {
    return res.json({ ok: true, ...buildBulkVoidStatus(job) });
  }

  job.cancelRequested = true;
  job.updatedAt = Date.now();
  return res.json({ ok: true, ...buildBulkVoidStatus(job) });
}

function getBulkVoidStatus({ req, res }) {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }

  const jobId = String(req.query.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  const job = bulkVoidJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Bulk delete job not found" });
  }
  if (!ownsBulkDeleteJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  return res.json({ ok: true, ...buildBulkVoidStatus(job) });
}

function downloadBulkVoidResultsCsv({ req, res }) {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }

  const jobId = String(req.query.jobId || "").trim();
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }

  const job = bulkVoidJobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Bulk delete job not found" });
  }
  if (!ownsBulkDeleteJob(job, userData)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const statusFilter = String(req.query.status || "").trim().toLowerCase();
  const allResults = Array.isArray(job.results) ? job.results : [];
  const rows = statusFilter ? allResults.filter((r) => r.status === statusFilter) : allResults;
  if (!rows.length) {
    return res.status(404).json({ error: statusFilter ? `No "${statusFilter}" rows found in this job.` : "No results found in this job." });
  }

  const csvEscape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ["Row", "ID", "Number", "Status", "Message"];
  const lines = [headers.join(",")];
  rows.forEach((r) => {
    lines.push([r.rowNumber, csvEscape(r.idValue), csvEscape(r.numberValue), r.status, csvEscape(r.message)].map(csvEscape).join(","));
  });

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="void_results_${statusFilter || "all"}_${Date.now()}.csv"`);
  return res.send(lines.join("\r\n"));
}

// Deletes/voids Invoices (ACCREC) and Sales Credit Notes (ACCRECCREDIT) from an uploaded sheet of IDs/Numbers.
app.post("/api/invoice/bulk-delete", (req, res) =>
  startBulkVoidJob({ req, res, allowedTypes: ["ACCREC", "ACCRECCREDIT"], oppositeLabel: "Bill" })
);

app.get("/api/invoice/bulk-delete/status", (req, res) => getBulkVoidStatus({ req, res }));
app.get("/api/invoice/bulk-delete/results", (req, res) => downloadBulkVoidResultsCsv({ req, res }));
app.post("/api/invoice/bulk-delete/cancel", (req, res) => cancelBulkVoidJob({ req, res }));

// Deletes/voids Bills (ACCPAY) and Bill Credit Notes (ACCPAYCREDIT) from an uploaded sheet of IDs/Numbers.
app.post("/api/bill/bulk-delete", (req, res) =>
  startBulkVoidJob({ req, res, allowedTypes: ["ACCPAY", "ACCPAYCREDIT"], oppositeLabel: "Invoice" })
);

app.get("/api/bill/bulk-delete/status", (req, res) => getBulkVoidStatus({ req, res }));
app.get("/api/bill/bulk-delete/results", (req, res) => downloadBulkVoidResultsCsv({ req, res }));
app.post("/api/bill/bulk-delete/cancel", (req, res) => cancelBulkVoidJob({ req, res }));

// ─── Batch Delete by Filter (no CSV upload needed) ───────────────────────────
app.get("/api/delete/by-filter/scan", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const tenantId = String(req.query.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Missing tenantId" });
    const type = String(req.query.type || "").trim();
    const statusFilter = String(req.query.status || "").trim();
    const fromDate = String(req.query.from || "").trim();
    const toDate = String(req.query.to || "").trim();
    if (!type) return res.status(400).json({ error: "Missing type parameter" });
    const sessionId = req.header("x-session-id") || latestSession?.sessionId;

    let xeroType, xeroEndpoint, idField, numberField, dateField;
    if (type === "invoices") {
      xeroType = "ACCREC"; xeroEndpoint = "Invoices"; idField = "InvoiceID"; numberField = "InvoiceNumber"; dateField = "Date";
    } else if (type === "bills") {
      xeroType = "ACCPAY"; xeroEndpoint = "Invoices"; idField = "InvoiceID"; numberField = "InvoiceNumber"; dateField = "Date";
    } else if (type === "credit-notes") {
      xeroEndpoint = "CreditNotes"; idField = "CreditNoteID"; numberField = "CreditNoteNumber"; dateField = "Date";
    } else if (type === "purchase-orders") {
      xeroEndpoint = "PurchaseOrders"; idField = "PurchaseOrderID"; numberField = "PurchaseOrderNumber"; dateField = "Date";
    } else if (type === "quotes") {
      xeroEndpoint = "Quotes"; idField = "QuoteID"; numberField = "QuoteNumber"; dateField = "Date";
    } else {
      return res.status(400).json({ error: `Unknown type: ${type}` });
    }

    const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
      const authHeaders = { Authorization: `Bearer ${accessToken}`, "Xero-Tenant-Id": tenantId, Accept: "application/json" };
      const conditions = [];
      if (xeroType) conditions.push(`Type=="${xeroType}"`);
      if (statusFilter) conditions.push(`Status=="${statusFilter}"`);
      if (fromDate) {
        const [y, m, d] = fromDate.split("-");
        conditions.push(`${dateField}>=DateTime(${y},${parseInt(m, 10)},${parseInt(d, 10)})`);
      }
      if (toDate) {
        const [y, m, d] = toDate.split("-");
        conditions.push(`${dateField}<=DateTime(${y},${parseInt(m, 10)},${parseInt(d, 10)})`);
      }
      const where = conditions.join("&&");
      const records = [];
      let page = 1;
      while (true) {
        let url = `https://api.xero.com/api.xro/2.0/${xeroEndpoint}?page=${page}&pageSize=1000`;
        if (where) url += `&where=${encodeURIComponent(where)}`;
        const { data } = await fetchWithRetry(url, { waitForDailyReset: true, headers: authHeaders });
        const list = data[xeroEndpoint] || [];
        for (const item of list) {
          records.push({ id: item[idField], number: item[numberField] || "", status: item.Status, date: item.Date || item.DateString });
        }
        if (list.length < 1000) break;
        page++;
      }
      return { records };
    });

    return res.json({ ok: true, count: result.records.length, records: result.records });
  } catch (err) {
    console.error("[FilterDelete scan]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/delete/by-filter/start", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Missing tenantId" });
    const type = String(req.body?.type || "").trim();
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    if (!records.length) return res.status(400).json({ error: "No records provided" });

    let allowedTypes, oppositeLabel;
    if (type === "invoices") { allowedTypes = ["ACCREC", "ACCRECCREDIT"]; oppositeLabel = "Bill"; }
    else if (type === "bills") { allowedTypes = ["ACCPAY", "ACCPAYCREDIT"]; oppositeLabel = "Invoice"; }
    else if (type === "credit-notes") { allowedTypes = ["ACCRECCREDIT", "ACCPAYCREDIT"]; oppositeLabel = "Invoice"; }
    else { allowedTypes = ["ACCREC", "ACCRECCREDIT", "ACCPAY", "ACCPAYCREDIT"]; oppositeLabel = ""; }

    const sessionId = req.header("x-session-id") || latestSession?.sessionId || null;
    const rows = records.map((r, i) => ({ rowNumber: i + 1, idValue: r.id || "", numberValue: r.number || "" }));

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId,
      filename: `filter-delete-${type}-${Date.now()}`,
      allowedTypes,
      oppositeLabel,
      status: "queued",
      total: rows.length,
      processed: 0,
      voided: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
      currentRowNumber: null,
      results: [],
      rows,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
      cancelRequested: false,
    };
    bulkVoidJobStore.set(job.id, job);
    setTimeout(() => {
      processBulkVoidJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, ...buildBulkVoidStatus(job) });
  } catch (err) {
    console.error("[FilterDelete start]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/delete/by-filter/status", (req, res) => getBulkVoidStatus({ req, res }));

// ─── New Delete Centre Routes — Quote / PO / Spend&Receive / BankTransfer / Contact ───

const _quoteDeleteHandlers = makeSimpleDeleteRouteHandlers(quoteDeleteJobStore, processQuoteDeleteJob);
app.post("/api/delete/quotes", (req, res) => {
  req.body = { ...req.body, headerAliases: [{ header: "Quote Number", isId: false }, { header: "QuoteNumber", isId: false }, { header: "Number", isId: false }] };
  return _quoteDeleteHandlers.start(req, res);
});
app.get("/api/delete/quotes/status", _quoteDeleteHandlers.status);
app.get("/api/delete/quotes/results", _quoteDeleteHandlers.results);
app.post("/api/delete/quotes/cancel", _quoteDeleteHandlers.cancel);

const _poDeleteHandlers = makeSimpleDeleteRouteHandlers(poDeleteJobStore, processPODeleteJob);
app.post("/api/delete/purchase-orders", (req, res) => {
  req.body = { ...req.body, headerAliases: [{ header: "Purchase Order Number", isId: false }, { header: "PurchaseOrderNumber", isId: false }, { header: "PO Number", isId: false }, { header: "Number", isId: false }] };
  return _poDeleteHandlers.start(req, res);
});
app.get("/api/delete/purchase-orders/status", _poDeleteHandlers.status);
app.get("/api/delete/purchase-orders/results", _poDeleteHandlers.results);
app.post("/api/delete/purchase-orders/cancel", _poDeleteHandlers.cancel);

const _spendReceiveDeleteHandlers = makeSimpleDeleteRouteHandlers(spendReceiveDeleteJobStore, processSpendReceiveDeleteJob);
app.post("/api/delete/spend-receive", (req, res) => {
  req.body = { ...req.body, headerAliases: [{ header: "Reference", isId: false }, { header: "Narration", isId: false }, { header: "Description", isId: false }] };
  return _spendReceiveDeleteHandlers.start(req, res);
});
app.get("/api/delete/spend-receive/status", _spendReceiveDeleteHandlers.status);
app.get("/api/delete/spend-receive/results", _spendReceiveDeleteHandlers.results);
app.post("/api/delete/spend-receive/cancel", _spendReceiveDeleteHandlers.cancel);

const _bankTransferDeleteHandlers = makeSimpleDeleteRouteHandlers(bankTransferDeleteJobStore, processBankTransferDeleteJob);
app.post("/api/delete/bank-transfers", (req, res) => {
  req.body = { ...req.body, headerAliases: [{ header: "Reference", isId: false }, { header: "Bank Transfer Reference", isId: false }] };
  return _bankTransferDeleteHandlers.start(req, res);
});
app.get("/api/delete/bank-transfers/status", _bankTransferDeleteHandlers.status);
app.get("/api/delete/bank-transfers/results", _bankTransferDeleteHandlers.results);
app.post("/api/delete/bank-transfers/cancel", _bankTransferDeleteHandlers.cancel);

const _contactArchiveHandlers = makeSimpleDeleteRouteHandlers(contactArchiveJobStore, processContactArchiveJob);
app.post("/api/delete/contacts/archive", (req, res) => {
  req.body = { ...req.body, headerAliases: [{ header: "Contact Name", isId: false }, { header: "Name", isId: false }, { header: "Contact ID", isId: true }, { header: "ContactID", isId: true }] };
  return _contactArchiveHandlers.start(req, res);
});
app.get("/api/delete/contacts/archive/status", _contactArchiveHandlers.status);
app.get("/api/delete/contacts/archive/results", _contactArchiveHandlers.results);
app.post("/api/delete/contacts/archive/cancel", _contactArchiveHandlers.cancel);

// ─── Bank Transfer Import ─────────────────────────────────────────────────────

async function processBankTransferImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;

  const runBatch = async (batch) => {
    try {
      const transfers = batch.map(row => {
        const payload = {
          FromBankAccount: { Code: String(row.fromAccountCode || "").trim() },
          ToBankAccount:   { Code: String(row.toAccountCode   || "").trim() },
          Amount: parseFloat(row.amount) || 0,
          Date: parseDateForXero(row.date) || row.date,
        };
        if (row.reference) payload.Reference = String(row.reference).trim();
        const rate = parseFloat(row.exchangeRate);
        if (rate && !isNaN(rate) && rate !== 1) payload.CurrencyRate = rate;
        return payload;
      });

      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/BankTransfers?SummarizeErrors=false", {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": job.tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
          },
          body: JSON.stringify({ BankTransfers: transfers }),
        });
        return { transfers: data?.BankTransfers || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;

      const xeroTransfers = result.transfers || [];
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const xt = xeroTransfers[j] || {};
        const errs = Array.isArray(xt.ValidationErrors) ? xt.ValidationErrors : [];
        if (xt.StatusAttributeString === "ERROR" || errs.length) {
          const msg = errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this transfer.";
          job.results.push({ rowNumber: row.rowNumber, fromAccountCode: row.fromAccountCode, toAccountCode: row.toAccountCode, amount: row.amount, date: row.date, status: "error", message: msg });
          job.errors++;
        } else {
          job.results.push({ rowNumber: row.rowNumber, fromAccountCode: row.fromAccountCode, toAccountCode: row.toAccountCode, amount: row.amount, date: row.date, status: "created", message: "Bank transfer created successfully.", transferId: xt.BankTransferID || "" });
          job.created++;
        }
        job.processed++;
      }
    } catch (err) {
      for (const row of batch) {
        job.results.push({ rowNumber: row.rowNumber, fromAccountCode: row.fromAccountCode, toAccountCode: row.toAccountCode, amount: row.amount, date: row.date, status: "error", message: err.message });
        job.errors++;
        job.processed++;
      }
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < job.rows.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentRef = `Row ${job.rows[i]?.rowNumber || i + 2}`;
    job.updatedAt = Date.now();
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= job.rows.length) break;
      promises.push(runBatch(job.rows.slice(start, Math.min(start + BATCH_SIZE, job.rows.length))));
    }
    await Promise.all(promises);
  }

  job.status = job.errors > 0 && job.created === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/bank-transfers/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in CSV." });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50,000 records per import." });

    const normalised = rows.map((r, i) => ({
      rowNumber:       Number(r.rowNumber) || i + 2,
      fromAccountCode: String(r.fromAccountCode || "").trim(),
      toAccountCode:   String(r.toAccountCode   || "").trim(),
      amount:          String(r.amount           || "").trim(),
      date:            String(r.date             || "").trim(),
      reference:       String(r.reference        || "").trim(),
      exchangeRate:    String(r.exchangeRate      || "").trim(),
    })).filter(r => r.fromAccountCode && r.toAccountCode && r.amount && r.date);

    if (!normalised.length) return res.status(400).json({ error: "No valid rows. Ensure From Account Code, To Account Code, Amount and Date are filled." });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "bank-transfers.csv"),
      status: "queued",
      total: normalised.length,
      processed: 0,
      created: 0,
      errors: 0,
      results: [],
      rows: normalised,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
      currentRef: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    bankTransferImportJobStore.set(job.id, job);
    setTimeout(() => {
      processBankTransferImportJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, total: job.total, status: job.status });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/bank-transfers/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const jobId = String(req.query.jobId || "").trim();
  const job = bankTransferImportJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true, jobId: job.id, status: job.status, total: job.total,
    processed: job.processed, created: job.created, errors: job.errors,
    results: job.results.slice(-50), error: job.error || "", currentRef: job.currentRef || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed))
      : null,
  });
});

// ─── Exchange Rate Update ────────────────────────────────────────────────────

async function processExchangeRateUpdateJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  const allRows = job.rows.filter(r => r.invoiceNumber);
  job.total = allRows.length;

  // Detect credit notes: CM prefix, CR prefix, or -Credit suffix
  const isCreditNote = num => {
    const u = String(num).toUpperCase();
    return u.startsWith("CM") || u.startsWith("CR") || u.endsWith("-CREDIT");
  };
  const invRows = allRows.filter(r => !isCreditNote(r.invoiceNumber));
  const cmRows  = allRows.filter(r =>  isCreditNote(r.invoiceNumber));

  const docMap = new Map(); // number.lower → { ID, type: "invoice"|"creditnote", CurrencyRate }
  const FETCH_BATCH = 50;

  // Phase 1a: Fetch invoices/bills
  for (let i = 0; i < invRows.length; i += FETCH_BATCH) {
    const batch = invRows.slice(i, i + FETCH_BATCH).map(r => r.invoiceNumber);
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const url = `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${batch.map(encodeURIComponent).join(",")}`;
        const { data } = await fetchWithRetry(url, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
        });
        return { items: data?.Invoices || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const inv of (r.items || [])) {
        if (inv.InvoiceNumber) {
          docMap.set(String(inv.InvoiceNumber).toLowerCase(), { ID: inv.InvoiceID, type: "invoice", CurrencyRate: parseFloat(inv.CurrencyRate) || 0 });
        }
      }
    } catch (_) {}
  }

  // Phase 1b: Fetch credit notes
  for (let i = 0; i < cmRows.length; i += FETCH_BATCH) {
    const batch = cmRows.slice(i, i + FETCH_BATCH).map(r => r.invoiceNumber);
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const url = `https://api.xero.com/api.xro/2.0/CreditNotes?CreditNoteNumbers=${batch.map(encodeURIComponent).join(",")}`;
        const { data } = await fetchWithRetry(url, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
        });
        return { items: data?.CreditNotes || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const cn of (r.items || [])) {
        if (cn.CreditNoteNumber) {
          docMap.set(String(cn.CreditNoteNumber).toLowerCase(), { ID: cn.CreditNoteID, type: "creditnote", CurrencyRate: parseFloat(cn.CurrencyRate) || 0 });
        }
      }
    } catch (_) {}
  }

  // Phase 1c: Retry unfound numbers individually (handles special chars like "(2)", "/" etc.)
  const allFoundKeys = new Set(docMap.keys());
  const unfoundInvNums = invRows.map(r => r.invoiceNumber).filter(n => !allFoundKeys.has(String(n).toLowerCase()));
  const unfoundCmNums  = cmRows.map(r => r.invoiceNumber).filter(n => !allFoundKeys.has(String(n).toLowerCase()));

  for (const num of unfoundInvNums) {
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(num)}`, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
        });
        return { items: data?.Invoices || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const inv of (r.items || [])) {
        if (inv.InvoiceNumber) docMap.set(String(inv.InvoiceNumber).toLowerCase(), { ID: inv.InvoiceID, type: "invoice", CurrencyRate: parseFloat(inv.CurrencyRate) || 0 });
      }
    } catch (_) {}
  }
  for (const num of unfoundCmNums) {
    try {
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/CreditNotes/${encodeURIComponent(num)}`, {
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
        });
        return { items: data?.CreditNotes || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      for (const cn of (r.items || [])) {
        if (cn.CreditNoteNumber) docMap.set(String(cn.CreditNoteNumber).toLowerCase(), { ID: cn.CreditNoteID, type: "creditnote", CurrencyRate: parseFloat(cn.CurrencyRate) || 0 });
      }
    } catch (_) {}
  }

  // Phase 1d: Retry still-unfound numbers as Bills (ACCPAY) — handles bill numbers in the CSV
  const stillUnfoundAfter1c = [...allRows].filter(r => !docMap.has(String(r.invoiceNumber || "").toLowerCase()));
  if (stillUnfoundAfter1c.length) {
    const billNums = stillUnfoundAfter1c.map(r => r.invoiceNumber).filter(Boolean);
    for (let i = 0; i < billNums.length; i += FETCH_BATCH) {
      const batch = billNums.slice(i, i + FETCH_BATCH);
      try {
        const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${batch.map(encodeURIComponent).join(",")}&Type=ACCPAY`, {
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
          });
          return { items: data?.Invoices || [] };
        });
        if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
        for (const inv of (r.items || [])) {
          if (inv.InvoiceNumber) docMap.set(String(inv.InvoiceNumber).toLowerCase(), { ID: inv.InvoiceID, type: "invoice", CurrencyRate: parseFloat(inv.CurrencyRate) || 0 });
        }
      } catch (_) {}
    }
  }

  // Phase 2: Update — split into invoice batches and credit note batches
  const UPDATE_BATCH = 50;
  const CONCURRENCY = 3;

  const pendingInvBatches = [];
  const pendingCnBatches  = [];
  let curInv = [], curCn = [];

  for (const row of allRows) {
    const num = String(row.invoiceNumber || "").trim();
    const doc = docMap.get(num.toLowerCase());
    if (!doc) {
      job.results.push({ rowNumber: row.rowNumber, invoiceNumber: num, status: "error", message: `"${num}" not found in Xero.` });
      job.errors++; job.processed++;
      continue;
    }
    const providedRate = parseFloat(row.exchangeRate);
    const newRate = (providedRate && !isNaN(providedRate))
      ? Math.round(providedRate * 1000000) / 1000000
      : (doc.CurrencyRate ? Math.round((1 / doc.CurrencyRate) * 1000000) / 1000000 : null);
    if (!newRate) {
      job.results.push({ rowNumber: row.rowNumber, invoiceNumber: num, status: "error", message: `"${num}" has no exchange rate to calculate from.` });
      job.errors++; job.processed++;
      continue;
    }
    const item = { row, doc, num, newRate };
    if (doc.type === "creditnote") {
      curCn.push(item);
      if (curCn.length >= UPDATE_BATCH) { pendingCnBatches.push(curCn); curCn = []; }
    } else {
      curInv.push(item);
      if (curInv.length >= UPDATE_BATCH) { pendingInvBatches.push(curInv); curInv = []; }
    }
  }
  if (curInv.length) pendingInvBatches.push(curInv);
  if (curCn.length)  pendingCnBatches.push(curCn);

  const notFound = allRows.filter(r => !docMap.has(String(r.invoiceNumber || "").trim().toLowerCase())).length;
  const noRate   = allRows.filter(r => {
    const doc = docMap.get(String(r.invoiceNumber || "").trim().toLowerCase());
    if (!doc) return false;
    const pr = parseFloat(r.exchangeRate);
    return !(pr && !isNaN(pr)) && !doc.CurrencyRate;
  }).length;
  console.log(`[ExchangeRate] Phase 2 summary — total: ${allRows.length}, found: ${docMap.size}, not-found: ${notFound}, no-rate: ${noRate}, inv-batches: ${pendingInvBatches.length}, cn-batches: ${pendingCnBatches.length}`);

  const runUpdateBatch = async (batch, endpoint, idField, itemsKey) => {
    try {
      const payloads = batch.map(({ doc, newRate }) => ({ [idField]: doc.ID, CurrencyRate: newRate }));
      const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/${endpoint}?SummarizeErrors=false`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ [itemsKey]: payloads }),
        });
        return { items: data?.[itemsKey] || [] };
      });
      if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
      const xeroItems = r.items || [];
      for (let j = 0; j < batch.length; j++) {
        const { row, num, newRate } = batch[j];
        const xi = xeroItems[j] || {};
        const errs = Array.isArray(xi.ValidationErrors) ? xi.ValidationErrors : [];
        if (xi.StatusAttributeString === "ERROR" || errs.length) {
          const msg = errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this update.";
          job.results.push({ rowNumber: row.rowNumber, invoiceNumber: num, status: "error", message: msg });
          job.errors++;
        } else {
          // Verify Xero actually applied the rate — it silently ignores updates on AUTHORISED invoices
          const returnedRate = Math.round((parseFloat(xi.CurrencyRate) || 0) * 1000000) / 1000000;
          const rateApplied = Math.abs(returnedRate - newRate) < 0.000005;
          if (!rateApplied) {
            job.results.push({
              rowNumber: row.rowNumber, invoiceNumber: num, status: "error",
              message: `Rate not applied by Xero (returned: ${returnedRate}, expected: ${newRate}). This usually means the invoice is AUTHORISED and has payments or allocations — Xero does not allow exchange rate changes in this state.`,
            });
            job.errors++;
          } else {
            job.results.push({ rowNumber: row.rowNumber, invoiceNumber: num, newRate, status: "updated", message: `Exchange rate updated to ${newRate}.` });
            job.created++;
          }
        }
        job.processed++;
      }
    } catch (err) {
      for (const { row, num } of batch) {
        job.results.push({ rowNumber: row.rowNumber, invoiceNumber: num, status: "error", message: err.message });
        job.errors++; job.processed++;
      }
    }
    job.updatedAt = Date.now();
  };

  // Process invoice batches
  for (let i = 0; i < pendingInvBatches.length; i += CONCURRENCY) {
    if (job.cancelRequested) break;
    await Promise.all(pendingInvBatches.slice(i, i + CONCURRENCY).map(b => runUpdateBatch(b, "Invoices", "InvoiceID", "Invoices")));
  }
  // Process credit note batches
  for (let i = 0; i < pendingCnBatches.length; i += CONCURRENCY) {
    if (job.cancelRequested) break;
    await Promise.all(pendingCnBatches.slice(i, i + CONCURRENCY).map(b => runUpdateBatch(b, "CreditNotes", "CreditNoteID", "CreditNotes")));
  }

  job.status = job.cancelRequested ? "cancelled" : (job.errors > 0 && job.created === 0 ? "error" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/exchange-rate-update/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in CSV." });
    if (rows.length > 10000) return res.status(400).json({ error: "Maximum 10,000 records per update." });

    const normalised = rows.map((r, i) => ({
      rowNumber: Number(r.rowNumber) || i + 2,
      invoiceNumber: String(r.invoiceNumber || "").trim(),
      exchangeRate: r.exchangeRate || "",
    })).filter(r => r.invoiceNumber);

    if (!normalised.length) return res.status(400).json({ error: "No valid rows found. Ensure Invoice Number column is filled." });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "exchange-rate-update.csv"),
      status: "queued",
      total: normalised.length,
      processed: 0,
      created: 0,
      errors: 0,
      results: [],
      rows: normalised,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    exchangeRateUpdateJobStore.set(job.id, job);
    setTimeout(() => {
      processExchangeRateUpdateJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, total: job.total, status: job.status });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/exchange-rate-update/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const jobId = String(req.query.jobId || "").trim();
  const job = exchangeRateUpdateJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    created: job.created,
    errors: job.errors,
    results: job.results.slice(-50),
    error: job.error || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed))
      : null,
  });
});

app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "Uploaded file is too large. Use a smaller sheet or split it into parts.",
    });
  }
  if (err) {
    return res.status(500).json({ error: err.message || "Server error" });
  }
  return next();
});

app.delete("/api/billpayment/:paymentId", async (req, res) => {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }

    const paymentId = String(req.params.paymentId || "").trim();
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

    const tenantId = String(
      req.header("x-tenant-id") ||
        req.query.tenantId ||
        req.body?.tenantId ||
        ""
    ).trim();
    if (!tenantId) {
      return res.status(400).json({ error: "Missing tenantId" });
    }

    const requestedSessionId = req.header("x-session-id") || req.body?.sessionId;
    const deleteResult = await deletePaymentInXero({
      tenantId,
      paymentId,
      requestedSessionId,
    });

    if (!deleteResult.ok) {
      return res.status(deleteResult.status || 409).json({
        error: deleteResult.message,
        paymentId,
        tenantId,
        sessionId: deleteResult.sessionId,
        payment: deleteResult.payment || null,
        xero: deleteResult.xero || null,
      });
    }

    return res.json({
      ok: true,
      paymentId,
      tenantId,
      sessionId: deleteResult.sessionId,
      data: deleteResult.data,
      rate: deleteResult.rate || null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/export/start", async (req, res) => {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }

    const sessionId = req.header("x-session-id") || req.body.sessionId;
    let session = null;
    if (sessionId && sessionStore.has(sessionId)) {
      session = getSession(sessionId);
    } else if (latestSession && sessionStore.has(latestSession.sessionId)) {
      session = getSession(latestSession.sessionId);
    } else {
      return res.status(401).json({ error: "Missing session. Connect again." });
    }

    const { type, from, to, tenantId, tenantName, format } = req.body || {};
    if (!type || !tenantId) {
      return res.status(400).json({ error: "Missing type or tenantId" });
    }
    if (!isTypeAllowed(type)) {
      return res.status(403).json({ error: "Type not allowed. Contact admin." });
    }

    const hasActiveOtherTenantJob = Array.from(jobStore.values()).some((job) => {
      const isOwner =
        job.userId === userData.user.id ||
        (job.userEmail && job.userEmail === userData.user.email);
      if (!isOwner) return false;
      const isActive = job.status === "queued" || job.status === "running";
      if (!isActive) return false;
      return job.tenantId && job.tenantId !== tenantId;
    });
    if (hasActiveOtherTenantJob) {
      return res.status(409).json({
        error:
          "You already have an active export for another tenant. Wait for it to finish or clear history.",
      });
    }

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      sessionId,
      tenantId,
      tenantName: tenantName || null,
      type,
      from: from || null,
      to: to || null,
      format: format || "all",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    jobStore.set(job.id, job);
    saveJobs();
    enqueueJob(job);

    return res.json({ jobId: job.id, status: job.status });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/export/status", (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  const jobId = req.query.jobId;
  if (!jobId) {
    return res.status(400).json({ error: "Missing jobId" });
  }
  const job = jobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  if (
    (job.userId && job.userId !== userData.user.id) ||
    (!job.userId && job.userEmail && job.userEmail !== userData.user.email)
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return res.json({
    jobId: job.id,
    status: job.status,
    count: job.count || 0,
    rate: job.rate || null,
    error: job.error || null,
    files: job.files ? Object.keys(job.files) : [],
    tenantName: job.tenantName || null,
    folderPath: job.folderPath || null,
    progress: job.progress || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
  });
});

app.get("/api/export/jobs", (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  const tenantId = req.query.tenantId || null;
  const jobs = Array.from(jobStore.values())
    .filter(
      (job) =>
        job.userId === userData.user.id ||
        (job.userEmail && job.userEmail === userData.user.email)
    )
    .filter((job) => (tenantId ? job.tenantId === tenantId : true))
    .sort((a, b) => b.createdAt - a.createdAt);

  return res.json({
    jobs: jobs.map((job) => ({
      jobId: job.id,
      type: job.type,
      status: job.status,
      count: job.count || 0,
      rate: job.rate || null,
      error: job.error || null,
      tenantId: job.tenantId,
      tenantName: job.tenantName || null,
      folderPath: job.folderPath || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt || null,
      progress: job.progress || null,
    })),
  });
});

app.post("/api/export/retry", (req, res) => {
  try {
    const userToken = req.header("x-user-token");
    const userData = getUserFromToken(userToken);
    if (!userData) {
      return res.status(401).json({ error: "Invalid user session" });
    }
    const { jobId } = req.body || {};
    if (!jobId) {
      return res.status(400).json({ error: "Missing jobId" });
    }
    const job = jobStore.get(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    if (
      (job.userId && job.userId !== userData.user.id) ||
      (!job.userId && job.userEmail && job.userEmail !== userData.user.email)
    ) {
      return res.status(403).json({ error: "Forbidden" });
    }
    let sessionId = job.sessionId;
    if (!sessionId || !sessionStore.has(sessionId)) {
      if (latestSession && sessionStore.has(latestSession.sessionId)) {
        sessionId = latestSession.sessionId;
      } else {
        return res.status(401).json({ error: "Missing session. Connect again." });
      }
    }

    const retryJob = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      sessionId,
      tenantId: job.tenantId,
      tenantName: job.tenantName || null,
      type: job.type,
      from: job.from || null,
      to: job.to || null,
      format: job.format || "all",
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    jobStore.set(retryJob.id, retryJob);
    saveJobs();
    enqueueJob(retryJob);

    return res.json({
      jobId: retryJob.id,
      status: retryJob.status,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/export/jobs/clear", (req, res) => {
  const userToken = req.header("x-user-token");
  const userData = getUserFromToken(userToken);
  if (!userData) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  let removed = 0;
  const removedIds = new Set();
  jobStore.forEach((job, jobId) => {
    const isOwner =
      job.userId === userData.user.id ||
      (job.userEmail && job.userEmail === userData.user.email);
    if (isOwner) {
      removeJobFiles(job);
      jobStore.delete(jobId);
      removed += 1;
      removedIds.add(jobId);
    }
  });
  if (removedIds.size) {
    for (let index = jobQueue.length - 1; index >= 0; index -= 1) {
      if (removedIds.has(jobQueue[index])) {
        jobQueue.splice(index, 1);
      }
    }
    const userFolder = path.join(
      EXPORT_DIR,
      sanitizeFolderName(userData.user.id)
    );
    if (fs.existsSync(userFolder)) {
      try {
        fs.rmSync(userFolder, { recursive: true, force: true });
      } catch {
        // ignore delete errors
      }
    }
  }
  saveJobs();
  return res.json({ removed });
});

app.get("/api/export/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = jobStore.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  const userToken = req.header("x-user-token") || req.query.userToken;
  const userData = getUserFromToken(userToken);
  if (
    !userData ||
    (job.userId && userData.user.id !== job.userId) ||
    (!job.userId && job.userEmail && userData.user.email !== job.userEmail)
  ) {
    return res.status(401).json({ error: "Invalid user session" });
  }
  if (job.status !== "ready") {
    return res.status(409).json({ error: "Export not ready" });
  }
  const format = String(req.query.format || "excel").toLowerCase();
  const file = job.files ? job.files[format] : null;
  if (!file) {
    return res.status(400).json({ error: "File not available" });
  }
  return res.download(file.path, file.filename);
});

app.get("/api/export", async (req, res) => {
  try {
    const sessionId = req.header("x-session-id") || req.query.sessionId;
    let session = null;
    if (sessionId && sessionStore.has(sessionId)) {
      session = getSession(sessionId);
    } else if (latestSession && sessionStore.has(latestSession.sessionId)) {
      session = getSession(latestSession.sessionId);
    } else {
      return res.status(401).json({ error: "Missing session. Connect again." });
    }
    const accessToken = await getAccessToken(session);

    const { type, from, to, tenantId } = req.query;
    if (!type || !tenantId) {
      return res.status(400).json({ error: "Missing type or tenantId" });
    }
    if (!isTypeAllowed(type)) {
      return res.status(403).json({ error: "Type not allowed. Contact admin." });
    }
    const format = String(req.query.format || "excel").toLowerCase();

      const result = await fetchAllRecords({
        accessToken,
        tenantId,
        type,
        from,
        to,
        session,
      });
      const records = result.records || [];
      const raw = result.raw || null;
      const rate = result.rate || {};

    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
      2,
      "0"
    )}${String(now.getDate()).padStart(2, "0")}_${String(
      now.getHours()
    ).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(
      now.getSeconds()
    ).padStart(2, "0")}`;
    const template = exportTemplates[type] || null;
    const safeName = type.replace(/[^a-z0-9]+/gi, "_");

    if (format === "meta") {
      return res.json({
        type,
        count: records.length,
        rate,
      });
    }

    if (!records.length) {
      return res.status(404).json({ error: "No records found" });
    }

      if (format === "json") {
        const filename = `${safeName}_${timestamp}.json`;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        const payload = JSON.stringify(
          raw
            ? raw
            : {
                type,
                count: records.length,
                records,
              },
          null,
          2
        );
        return res.send(payload);
      }

    if (format !== "excel" && format !== "csv") {
      return res.status(400).json({ error: "Unsupported format" });
    }

    const exportContext = await buildExportContext({
      accessToken,
      tenantId,
      type,
      session,
    });

    const rows = template
      ? template.mapRows(records, raw, exportContext)
      : records.flatMap((record) => expandLineItems(record));
    const rawColumns = template
      ? template.columns
      : Array.from(
          rows.reduce((set, row) => {
            Object.keys(row).forEach((key) => set.add(key));
            return set;
          }, new Set())
        );
    const columns = normalizeColumns(rawColumns);

    if (format === "csv") {
      const filename = `${safeName}_${timestamp}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      const escapeCsv = (value) => {
        const text = value === undefined || value === null ? "" : String(value);
        if (text.includes('"') || text.includes(",") || text.includes("\n")) {
          return `"${text.replace(/"/g, '""')}"`;
        }
        return text;
      };

      res.write(
        `${columns.map((col) => escapeCsv(col.header)).join(",")}\n`
      );
      rows.forEach((row) => {
        const line = columns
          .map((col) => escapeCsv(row[col.key]))
          .join(",");
        res.write(`${line}\n`);
      });
      return res.end();
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("data");
    sheet.columns = columns.map((col) => ({
      header: col.header,
      key: col.key,
    }));
    rows.forEach((row) => {
      const normalized = {};
      columns.forEach((col) => {
        const value = row[col.key];
        normalized[col.key] = value === undefined || value === null ? "" : value;
      });
      sheet.addRow(normalized);
    });

    const filename = `${safeName}_${timestamp}.xlsx`;

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Purchase Orders Import ──────────────────────────────────────────────────

const purchaseOrdersImportJobStore = new Map();

function buildPurchaseOrderPayloadFromRows(poNumber, rows, contactIdMap, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SUBMITTED", "AUTHORISED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const contactName = String(firstRow.contactName || "").trim();
  const contactId = contactIdMap?.get(contactName.toLowerCase());
  const po = {
    Contact: contactId ? { ContactID: contactId } : { Name: contactName },
    Status: finalStatus,
    LineItems: [],
  };
  if (poNumber) po.PurchaseOrderNumber = String(poNumber).trim();
  const date = parseDateForXero(firstRow.date, forceMDY);
  if (date) po.Date = date;
  const deliveryDate = parseDateForXero(firstRow.deliveryDate, forceMDY);
  if (deliveryDate) po.DeliveryDate = deliveryDate;
  if (firstRow.reference) po.Reference = String(firstRow.reference).trim();
  if (firstRow.attentionTo) po.AttentionTo = String(firstRow.attentionTo).trim();
  if (firstRow.telephone) po.Telephone = String(firstRow.telephone).trim();
  if (firstRow.deliveryInstructions) po.DeliveryInstructions = String(firstRow.deliveryInstructions).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) po.CurrencyCode = cc;
  const exRate = Number(firstRow.exchangeRate || "");
  if (Number.isFinite(exRate) && exRate > 0) po.CurrencyRate = exRate;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qty = Number(String(row.quantity || "").trim());
    if (!Number.isNaN(qty) && String(row.quantity || "").trim()) lineItem.Quantity = qty;
    const unitAmt = Number(String(row.unitAmount || "").trim());
    if (!Number.isNaN(unitAmt) && String(row.unitAmount || "").trim()) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    if (row.itemCode) lineItem.ItemCode = String(row.itemCode).trim();
    applyTaxToLineItem(lineItem, row);
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1)
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    if (row.trackingName2 && row.trackingOption2)
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    if (tracking.length) lineItem.Tracking = tracking;
    po.LineItems.push(lineItem);
  });
  return po;
}

function buildPurchaseOrdersImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentPoNumber: job.currentPoNumber || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
    historyId: job.historyId || "",
  };
}

async function processPurchaseOrdersImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;

  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) {}

  const resolveTax = (rows) => rows.map((r) => ({ ...r, taxType: resolveTaxType(r.taxType, taxNameToCode) }));

  if (job.skipDuplicateCheck) {
    try {
      const allNums = (job.poGroups || []).map(g => g.poNumber);
      const existing = await fetchExistingDocNumbers(job, allNums, "PurchaseOrders");
      if (existing.size > 0) {
        const before = (job.poGroups || []).length;
        job.poGroups = (job.poGroups || []).filter(g => !existing.has(String(g.poNumber).toLowerCase()));
        const skipped = before - job.poGroups.length;
        job.skipped = (job.skipped || 0) + skipped;
        job.total = job.poGroups.length;
      }
    } catch (_) {}
  }

  const poGroups = job.poGroups || [];

  // Xero PO API requires ContactID — Name lookup not supported unlike Invoices
  // POST /Contacts with each unique name: Xero returns ContactID for both new and existing contacts
  const contactIdMap = new Map(); // name.toLowerCase() → ContactID
  const allContactNames = [...new Set(poGroups.map(g => String(g.rows[0]?.contactName || "").trim()).filter(Boolean))];
  console.log(`[PO Import] Resolving ContactIDs for ${allContactNames.length} unique contact(s)...`);
  if (allContactNames.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < allContactNames.length; i += CHUNK) {
      const chunk = allContactNames.slice(i, i + CHUNK);
      try {
        const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            "https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
              body: JSON.stringify({ Contacts: chunk.map(name => ({ Name: name })) }),
            }
          );
          return { contacts: data?.Contacts || [] };
        });
        if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
        (r.contacts || []).forEach(c => {
          if (c.Name && c.ContactID) contactIdMap.set(c.Name.trim().toLowerCase(), c.ContactID);
        });
        console.log(`[PO Import] ContactID resolved for ${contactIdMap.size}/${allContactNames.length} contacts so far`);
      } catch (err) {
        console.error(`[PO Import] Contact lookup failed:`, err?.message);
      }
    }
  }

  // In updateMode: pre-fetch PurchaseOrderIDs so we can inject them into POST payloads
  const existingPoIdMap = new Map();
  if (job.updateMode) {
    const allNums = (job.poGroups || []).map(g => g.poNumber).filter(Boolean);
    if (allNums.length) {
      const fetched = await fetchExistingDocIds(job, allNums, "PurchaseOrders");
      for (const [k, v] of fetched) existingPoIdMap.set(k, v);
    }
  }

  const runBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => {
        const p = buildPurchaseOrderPayloadFromRows(g.poNumber, resolveTax(g.rows), contactIdMap, job.forceMDY || false);
        if (job.updateMode) { const xid = existingPoIdMap.get((g.poNumber || "").toLowerCase()); if (xid) p.PurchaseOrderID = xid; }
        return p;
      });
      const idempotencyKey = crypto.randomBytes(16).toString("hex");
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/PurchaseOrders?summarizeErrors=false", {
          method: "POST",
          timeoutMs: 90000,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": job.tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ PurchaseOrders: payloads }),
        });
        return { purchaseOrders: data?.PurchaseOrders || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroPos = result.purchaseOrders || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xpo = xeroPos[j] || {};
        const errors = Array.isArray(xpo.ValidationErrors) ? xpo.ValidationErrors : [];
        const warnings = Array.isArray(xpo.Warnings) ? xpo.Warnings : [];
        if (xpo.StatusAttributeString === "WARNING") {
          job.created += 1;
          const warnMsg = warnings.map(w => w.Message).filter(Boolean).join("; ") || "Some fields could not be changed on this AUTHORISED purchase order.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, poNumber: group.poNumber, contactName: row.contactName || "", status: "updated", message: `Purchase Order updated (AUTHORISED — some fields restricted): ${warnMsg}`, poId: xpo.PurchaseOrderID || "" }));
        } else if (xpo.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const msg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this purchase order.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, poNumber: group.poNumber, contactName: row.contactName || "", status: "error", message: msg }));
        } else {
          job.created += 1;
          const successMsg = job.updateMode ? "Purchase Order updated successfully." : "Purchase Order created successfully.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, poNumber: group.poNumber, contactName: row.contactName || "", status: job.updateMode ? "updated" : "created", message: successMsg, poId: xpo.PurchaseOrderID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, poNumber: group.poNumber, contactName: row.contactName || "", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < poGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentPoNumber = poGroups[i]?.poNumber || "";
    job.updatedAt = Date.now();
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= poGroups.length) break;
      promises.push(runBatch(poGroups.slice(start, Math.min(start + BATCH_SIZE, poGroups.length))));
    }
    await Promise.all(promises);
  }

  job.currentPoNumber = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const createdIds = [...new Set(job.results.filter((r) => r.poId).map((r) => r.poId))];
  const histEntry = recordImportHistory({ importType: "purchase-orders", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds, note: job.note || "" });
  job.historyId = histEntry.id;
}

app.post("/api/import/purchase-orders/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheckPO = checkImportAccess(userData.user, "purchase-orders", rows.length);
    if (!planCheckPO.allowed) return res.status(403).json({ error: planCheckPO.error, planError: true });
    const groupMap = new Map();
    rows.forEach((row, index) => {
      const nr = {
        rowNumber: Number(row.rowNumber) || index + 2,
        poNumber: String(row.poNumber || "").trim(),
        contactName: String(row.contactName || "").trim(),
        date: String(row.date || "").trim(),
        deliveryDate: String(row.deliveryDate || "").trim(),
        reference: String(row.reference || "").trim(),
        attentionTo: String(row.attentionTo || "").trim(),
        telephone: String(row.telephone || "").trim(),
        deliveryInstructions: String(row.deliveryInstructions || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        exchangeRate: String(row.exchangeRate || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        itemCode: String(row.itemCode || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
        status: String(row.status || "DRAFT").trim(),
      };
      const key = nr.poNumber || `row_${nr.rowNumber}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(nr);
    });
    const poGroups = [];
    groupMap.forEach((groupRows, poNumber) => poGroups.push({ poNumber, rows: groupRows }));

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "purchase-orders.csv"),
      status: "queued",
      total: poGroups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentPoNumber: "",
      results: [],
      poGroups,
      skipDuplicateCheck: req.body?.skipDuplicateCheck === true,
      updateMode: req.body?.updateMode === true,
      note: extractJobNote(req),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    purchaseOrdersImportJobStore.set(job.id, job);
    setTimeout(() => {
      processPurchaseOrdersImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildPurchaseOrdersImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/purchase-orders/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = purchaseOrdersImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Purchase Orders import job not found" });
  if (job.userId !== userData.user.id && !userData.user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildPurchaseOrdersImportStatus(job) });
});

// ── Quotes Import ──────────────────────────────────────────────────────────

const quotesImportJobStore = new Map();

function buildQuotePayloadFromRows(quoteNumber, rows, contactIdMap, forceMDY = _forceMDY) {
  const firstRow = rows[0];
  const rawStatus = String(firstRow.status || "DRAFT").trim().toUpperCase();
  const finalStatus = ["DRAFT", "SENT", "DECLINED", "ACCEPTED"].includes(rawStatus) ? rawStatus : "DRAFT";
  const contactName = String(firstRow.contactName || "").trim();
  const contactId = contactIdMap?.get(contactName.toLowerCase());
  const quote = {
    Contact: contactId ? { ContactID: contactId } : { Name: contactName },
    Status: finalStatus,
    LineItems: [],
  };
  if (quoteNumber) quote.QuoteNumber = String(quoteNumber).trim();
  const date = parseDateForXero(firstRow.date, forceMDY);
  if (date) quote.Date = date;
  const expiryDate = parseDateForXero(firstRow.expiryDate, forceMDY);
  if (expiryDate) quote.ExpiryDate = expiryDate;
  if (firstRow.title) quote.Title = String(firstRow.title).trim();
  if (firstRow.summary) quote.Summary = String(firstRow.summary).trim();
  if (firstRow.terms) quote.Terms = String(firstRow.terms).trim();
  if (firstRow.reference) quote.Reference = String(firstRow.reference).trim();
  const cc = String(firstRow.currencyCode || "").trim().toUpperCase();
  if (cc) quote.CurrencyCode = cc;
  const lineAmtType = String(firstRow.lineAmountTypes || "").trim().toUpperCase();
  if (["EXCLUSIVE", "INCLUSIVE", "NOTAX"].includes(lineAmtType)) quote.LineAmountTypes = lineAmtType;
  rows.forEach((row) => {
    const lineItem = { Description: String(row.description || "").trim() };
    const qty = Number(String(row.quantity || "").trim());
    if (!Number.isNaN(qty) && String(row.quantity || "").trim()) lineItem.Quantity = qty;
    const unitAmt = Number(String(row.unitAmount || "").trim());
    if (!Number.isNaN(unitAmt) && String(row.unitAmount || "").trim()) lineItem.UnitAmount = unitAmt;
    if (row.accountCode) lineItem.AccountCode = String(row.accountCode).trim();
    if (row.itemCode) lineItem.ItemCode = String(row.itemCode).trim();
    const discount = Number(String(row.discountRate || "").trim());
    if (!Number.isNaN(discount) && String(row.discountRate || "").trim()) lineItem.DiscountRate = discount;
    applyTaxToLineItem(lineItem, row);
    const tracking = [];
    if (row.trackingName1 && row.trackingOption1)
      tracking.push({ Name: String(row.trackingName1).trim(), Option: String(row.trackingOption1).trim() });
    if (row.trackingName2 && row.trackingOption2)
      tracking.push({ Name: String(row.trackingName2).trim(), Option: String(row.trackingOption2).trim() });
    if (tracking.length) lineItem.Tracking = tracking;
    quote.LineItems.push(lineItem);
  });
  return quote;
}

function buildQuotesImportStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const remaining = Math.max(0, total - processed);
  let etaMs = null;
  if (job.status === "running" && processed > 0 && job.startedAt) {
    etaMs = Math.max(0, Math.round(((Date.now() - job.startedAt) / processed) * remaining));
  }
  return {
    jobId: job.id,
    filename: job.filename,
    tenantId: job.tenantId,
    status: job.status,
    total,
    processed,
    remaining,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    currentQuoteNumber: job.currentQuoteNumber || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
    historyId: job.historyId || "",
  };
}

async function processQuotesImportJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH_SIZE = 50;
  const CONCURRENCY = 3;

  let taxNameToCode = new Map();
  try {
    const tr = await fetchTaxRatesForImport({ tenantId: job.tenantId, requestedSessionId: job.sessionId });
    taxNameToCode = tr.nameToCode;
    if (tr.sessionId) job.sessionId = tr.sessionId;
  } catch (_) {}

  const resolveTax = (rows) => rows.map((r) => ({ ...r, taxType: resolveTaxType(r.taxType, taxNameToCode) }));

  if (job.skipDuplicateCheck) {
    try {
      const allNums = (job.quoteGroups || []).map(g => g.quoteNumber);
      const existing = await fetchExistingDocNumbers(job, allNums, "Quotes");
      if (existing.size > 0) {
        const before = (job.quoteGroups || []).length;
        job.quoteGroups = (job.quoteGroups || []).filter(g => !existing.has(String(g.quoteNumber).toLowerCase()));
        const skipped = before - job.quoteGroups.length;
        job.skipped = (job.skipped || 0) + skipped;
        job.total = job.quoteGroups.length;
      }
    } catch (_) {}
  }

  const quoteGroups = job.quoteGroups || [];

  // Xero Quotes API requires ContactID — Name lookup not supported unlike Invoices
  const contactIdMap = new Map();
  const allContactNames = [...new Set(quoteGroups.map(g => String(g.rows[0]?.contactName || "").trim()).filter(Boolean))];
  console.log(`[Quotes Import] Resolving ContactIDs for ${allContactNames.length} unique contact(s)...`);
  if (allContactNames.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < allContactNames.length; i += CHUNK) {
      const chunk = allContactNames.slice(i, i + CHUNK);
      try {
        const r = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            "https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": crypto.randomBytes(16).toString("hex") },
              body: JSON.stringify({ Contacts: chunk.map(name => ({ Name: name })) }),
            }
          );
          return { contacts: data?.Contacts || [] };
        });
        if (r.resolvedSessionId) job.sessionId = r.resolvedSessionId;
        (r.contacts || []).forEach(c => {
          if (c.Name && c.ContactID) contactIdMap.set(c.Name.trim().toLowerCase(), c.ContactID);
        });
        console.log(`[Quotes Import] ContactID resolved for ${contactIdMap.size}/${allContactNames.length} contacts so far`);
      } catch (err) {
        console.error(`[Quotes Import] Contact lookup failed:`, err?.message);
      }
    }
  }

  // In updateMode: pre-fetch QuoteIDs so we can inject them into POST payloads
  const existingQuoteIdMap = new Map();
  if (job.updateMode) {
    const allNums = (job.quoteGroups || []).map(g => g.quoteNumber).filter(Boolean);
    if (allNums.length) {
      const fetched = await fetchExistingDocIds(job, allNums, "Quotes");
      for (const [k, v] of fetched) existingQuoteIdMap.set(k, v);
    }
  }

  const runBatch = async (batch) => {
    try {
      const payloads = batch.map((g) => {
        const p = buildQuotePayloadFromRows(g.quoteNumber, resolveTax(g.rows), contactIdMap, job.forceMDY || false);
        if (job.updateMode) { const xid = existingQuoteIdMap.get((g.quoteNumber || "").toLowerCase()); if (xid) p.QuoteID = xid; }
        return p;
      });
      const idempotencyKey = crypto.randomBytes(16).toString("hex");
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Quotes?summarizeErrors=false", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "xero-tenant-id": job.tenantId,
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ Quotes: payloads }),
        });
        return { quotes: data?.Quotes || [] };
      });
      if (result.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      const xeroQuotes = result.quotes || [];
      for (let j = 0; j < batch.length; j++) {
        const group = batch[j];
        const xq = xeroQuotes[j] || {};
        const errors = Array.isArray(xq.ValidationErrors) ? xq.ValidationErrors : [];
        const warnings = Array.isArray(xq.Warnings) ? xq.Warnings : [];
        if (xq.StatusAttributeString === "WARNING") {
          job.created += 1;
          const warnMsg = warnings.map(w => w.Message).filter(Boolean).join("; ") || "Some fields could not be changed on this AUTHORISED quote.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, quoteNumber: group.quoteNumber, contactName: row.contactName || "", status: "updated", message: `Quote updated (some fields restricted): ${warnMsg}`, quoteId: xq.QuoteID || "" }));
        } else if (xq.StatusAttributeString === "ERROR" || errors.length) {
          job.errors += 1;
          const msg = errors.map((e) => e.Message || e.Description).filter(Boolean).join("; ") || "Xero rejected this quote.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, quoteNumber: group.quoteNumber, contactName: row.contactName || "", status: "error", message: msg }));
        } else {
          job.created += 1;
          const successMsg = job.updateMode ? "Quote updated successfully." : "Quote created successfully.";
          group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, quoteNumber: group.quoteNumber, contactName: row.contactName || "", status: job.updateMode ? "updated" : "created", message: successMsg, quoteId: xq.QuoteID || "" }));
        }
        job.processed += 1;
      }
    } catch (err) {
      for (const group of batch) {
        job.errors += 1;
        group.rows.forEach((row) => job.results.push({ rowNumber: row.rowNumber, quoteNumber: group.quoteNumber, contactName: row.contactName || "", status: "error", message: err.message }));
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  };

  for (let i = 0; i < quoteGroups.length; i += BATCH_SIZE * CONCURRENCY) {
    if (job.cancelRequested) break;
    job.currentQuoteNumber = quoteGroups[i]?.quoteNumber || "";
    job.updatedAt = Date.now();
    const promises = [];
    for (let c = 0; c < CONCURRENCY; c++) {
      const start = i + c * BATCH_SIZE;
      if (start >= quoteGroups.length) break;
      promises.push(runBatch(quoteGroups.slice(start, Math.min(start + BATCH_SIZE, quoteGroups.length))));
    }
    await Promise.all(promises);
  }

  job.currentQuoteNumber = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  const createdIds = [...new Set(job.results.filter((r) => r.quoteId).map((r) => r.quoteId))];
  const histEntry = recordImportHistory({ importType: "quotes", tenantId: job.tenantId, userId: job.userId, userEmail: job.userEmail, total: job.total, created: job.created, errors: job.errors, status: job.status, jobId: job.id, createdIds, note: job.note || "" });
  job.historyId = histEntry.id;
}

app.post("/api/import/quotes/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    const planCheckQuotes = checkImportAccess(userData.user, "quotes", rows.length);
    if (!planCheckQuotes.allowed) return res.status(403).json({ error: planCheckQuotes.error, planError: true });
    if (rows.length > 10000) return res.status(400).json({ error: "Import a maximum of 10,000 line rows per file." });

    const groupMap = new Map();
    rows.forEach((row, index) => {
      const nr = {
        rowNumber: Number(row.rowNumber) || index + 2,
        quoteNumber: String(row.quoteNumber || "").trim(),
        contactName: String(row.contactName || "").trim(),
        date: String(row.date || "").trim(),
        expiryDate: String(row.expiryDate || "").trim(),
        title: String(row.title || "").trim(),
        summary: String(row.summary || "").trim(),
        terms: String(row.terms || "").trim(),
        reference: String(row.reference || "").trim(),
        currencyCode: String(row.currencyCode || "").trim(),
        lineAmountTypes: String(row.lineAmountTypes || "").trim(),
        description: String(row.description || "").trim(),
        quantity: String(row.quantity || "").trim(),
        unitAmount: String(row.unitAmount || "").trim(),
        accountCode: String(row.accountCode || "").trim(),
        itemCode: String(row.itemCode || "").trim(),
        discountRate: String(row.discountRate || "").trim(),
        taxType: String(row.taxType || "").trim(),
        taxAmount: String(row.taxAmount || "").trim(),
        trackingName1: String(row.trackingName1 || "").trim(),
        trackingOption1: String(row.trackingOption1 || "").trim(),
        trackingName2: String(row.trackingName2 || "").trim(),
        trackingOption2: String(row.trackingOption2 || "").trim(),
        status: String(row.status || "DRAFT").trim(),
      };
      const key = nr.quoteNumber || `row_${nr.rowNumber}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(nr);
    });
    const quoteGroups = [];
    groupMap.forEach((groupRows, quoteNumber) => quoteGroups.push({ quoteNumber, rows: groupRows }));

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "quotes.csv"),
      status: "queued",
      total: quoteGroups.length,
      processed: 0,
      created: 0,
      skipped: 0,
      errors: 0,
      currentQuoteNumber: "",
      results: [],
      quoteGroups,
      skipDuplicateCheck: req.body?.skipDuplicateCheck === true,
      updateMode: req.body?.updateMode === true,
      note: extractJobNote(req),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    quotesImportJobStore.set(job.id, job);
    setTimeout(() => {
      processQuotesImportJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildQuotesImportStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/quotes/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = quotesImportJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Quotes import job not found" });
  if (job.userId !== userData.user.id && !userData.user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildQuotesImportStatus(job) });
});

// ── Credit Note Allocation ────────────────────────────────────────────────────

function buildCreditNoteAllocationStatus(job) {
  const processed = job.processed || 0;
  const total = job.total || 0;
  const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
  const rate = processed > 0 ? elapsed / processed : 0;
  const remaining = total - processed;
  const etaMs = rate > 0 && remaining > 0 ? Math.round(rate * remaining) : null;
  return {
    jobId: job.id,
    status: job.status,
    total,
    processed,
    created: job.created || 0,
    skipped: job.skipped || 0,
    errors: job.errors || 0,
    remaining,
    currentReference: job.currentReference || "",
    etaMs,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    updatedAt: job.updatedAt || null,
    finishedAt: job.finishedAt || null,
    results: (job.results || []).slice(-200),
    error: job.error || "",
  };
}

async function createCreditNoteAllocationInXero({ tenantId, requestedSessionId, creditNoteId, allocations, date }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    const url = `https://api.xero.com/api.xro/2.0/CreditNotes/${creditNoteId}/Allocations`;
    const body = { Allocations: allocations.map(a => ({ Invoice: { InvoiceID: a.invoiceId }, Amount: a.amount, Date: a.date || date })) };
    const { data } = await fetchWithRetry(url, {
      method: "PUT",
      waitForDailyReset: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
      },
      body: JSON.stringify(body),
    });
    return { allocation: data?.CreditNotes?.[0] || null };
  });
}

async function processCreditNoteAllocationJob(job) {
  _forceMDY = job.forceMDY || false;
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();

  // DEBIT = ACCPAY credit notes → bills; CREDIT = ACCREC credit notes → invoices
  const xeroType = job.allocationType === "DEBIT" ? "ACCPAYCREDIT" : "ACCRECCREDIT";
  const invoiceXeroType = job.allocationType === "DEBIT" ? "ACCPAY" : "ACCREC";

  // Phase 1: Fetch needed credit notes directly by reference number (no full-scan)
  const creditNoteMap = new Map();
  const neededRefs = [...new Set(job.rows.map(r => r.creditNoteReference).filter(Boolean))];
  let phase1Error = null;
  let phase1BudgetStopped = false;
  let xeroLimitRemaining = null;
  // Small batch size to avoid URL length limit with long/complex reference numbers
  const CN_BATCH = 20;

  for (let i = 0; i < neededRefs.length; i += CN_BATCH) {
    if (job.cancelRequested) break;
    const batch = neededRefs.slice(i, i + CN_BATCH);
    try {
      const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const res = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/CreditNotes?CreditNoteNumbers=${encodeURIComponent(batch.join(","))}`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { creditNotes: res.data?.CreditNotes || [], dayRemaining: res.rate?.day };
      });
      if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
      if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
      const cns = result?.creditNotes || [];
      cns.forEach(cn => {
        if (cn.CreditNoteNumber) creditNoteMap.set(String(cn.CreditNoteNumber).trim(), cn);
      });
    } catch (err) {
      phase1Error = err?.message || String(err);
      console.error("[CN Alloc Phase 1 ERROR] batch", i, phase1Error);
    }
  }

  if (creditNoteMap.size === 0) {
    const diagMsg = phase1Error
      ? `DIAGNOSTIC — Phase 1 failed: ${phase1Error}`
      : `DIAGNOSTIC — Phase 1 returned 0 credit notes of type ${xeroType}. TenantId: ${job.tenantId}`;
    console.error("[CN Alloc DIAGNOSTIC]", diagMsg);
    job.results.push({ rowNumber: 0, creditNoteReference: "DIAGNOSTIC", allocatedTo: "", amount: "", status: "error", message: diagMsg });
  }

  // Phase 2: Resolve invoiceNumber → InvoiceID
  const invoiceIdMap = new Map();
  const invoiceAmountDueMap = new Map();
  const foundRefs = new Set(creditNoteMap.keys());
  const allInvoiceNums = [...new Set(
    job.rows.filter(r => r.invoiceNumber && foundRefs.has(r.creditNoteReference)).map(r => String(r.invoiceNumber).trim())
  )];

  if (allInvoiceNums.length > 0) {
    const INV_BATCH = 100;
    for (let i = 0; i < allInvoiceNums.length; i += INV_BATCH) {
      const batch = allInvoiceNums.slice(i, i + INV_BATCH);
      try {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${encodeURIComponent(batch.join(","))}&Statuses=AUTHORISED`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { invoices: res.data?.Invoices || [] };
        });
        if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        for (const inv of result?.invoices || []) {
          const numKey = String(inv.InvoiceNumber || "").trim().toLowerCase();
          const contactId = inv.Contact?.ContactID || "";
          if (numKey && inv.InvoiceID) {
            invoiceIdMap.set(`${numKey}|${contactId}`, inv.InvoiceID);
            invoiceIdMap.set(numKey, inv.InvoiceID);
            invoiceAmountDueMap.set(inv.InvoiceID, Number(inv.AmountDue) || 0);
          }
        }
      } catch (err) {
        console.error("[CN Alloc Phase 2 ERROR] batch", i, err?.message);
      }
    }

    // DEBIT type fallback: fetch all ACCPAY bills per unique supplier contact, match Reference locally.
    // More reliable than where-clause Reference search (covers AUTHORISED + PARTIAL status, no URL limits).
    if (job.allocationType === "DEBIT") {
      const notFoundSet = new Set(allInvoiceNums.filter(n => !invoiceIdMap.has(n.toLowerCase())).map(n => n.toLowerCase()));
      if (notFoundSet.size > 0) {
        // Collect unique contact IDs from credit notes whose bills are still not found
        const contactsToFetch = new Map(); // contactId → true
        for (const row of job.rows) {
          if (!row.invoiceNumber) continue;
          if (!notFoundSet.has(String(row.invoiceNumber).trim().toLowerCase())) continue;
          const cn = creditNoteMap.get(row.creditNoteReference);
          if (cn?.Contact?.ContactID) contactsToFetch.set(cn.Contact.ContactID, true);
        }
        // One API call per unique supplier — fetch all their ACCPAY bills (AUTHORISED + PARTIAL)
        for (const contactId of contactsToFetch.keys()) {
          if (job.cancelRequested) break;
          try {
            const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/Invoices?ContactIDs=${encodeURIComponent(contactId)}&Statuses=AUTHORISED,PARTIAL`,
                { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
              );
              return { invoices: res.data?.Invoices || [], dayRemaining: res.rate?.day };
            });
            if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
            if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
            for (const inv of result?.invoices || []) {
              if (inv.Type !== "ACCPAY") continue;
              const refKey = String(inv.Reference || "").trim().toLowerCase();
              const numKey = String(inv.InvoiceNumber || "").trim().toLowerCase();
              const invContactId = inv.Contact?.ContactID || "";
              if (inv.InvoiceID) {
                if (refKey) {
                  invoiceIdMap.set(`${refKey}|${invContactId}`, inv.InvoiceID);
                  invoiceIdMap.set(refKey, inv.InvoiceID);
                }
                if (numKey) {
                  invoiceIdMap.set(`${numKey}|${invContactId}`, inv.InvoiceID);
                  invoiceIdMap.set(numKey, inv.InvoiceID);
                }
                invoiceAmountDueMap.set(inv.InvoiceID, Number(inv.AmountDue) || 0);
              }
            }
          } catch (err) {
            console.error("[CN Alloc Phase 2 DEBIT contact fallback]", contactId, err?.message);
          }
        }
      }
    }
  }

  // Phase 3: Process allocations row by row
  const resolveRow = (row) => {
    const cn = creditNoteMap.get(row.creditNoteReference);
    if (!cn) {
      if (phase1BudgetStopped) return { error: `API quota exhausted during scan — "${row.creditNoteReference}" was not reached. Retry after quota resets.` };
      return { error: `Credit note "${row.creditNoteReference}" not found in Xero.` };
    }
    const remainingCredit = Number(cn.RemainingCredit) || 0;
    if (remainingCredit <= 0) return { skip: `Credit note "${row.creditNoteReference}" is fully allocated (Remaining Credit = 0) — skipped.` };
    const existingAllocs = cn.Allocations || [];
    const alreadyByNum = row.invoiceNumber && existingAllocs.some(a =>
      String(a.Invoice?.InvoiceNumber || "").trim().toLowerCase() === row.invoiceNumber.trim().toLowerCase()
    );
    if (alreadyByNum) return { skip: `Already allocated: "${row.creditNoteReference}" → "${row.invoiceNumber}" (skipped duplicate).` };
    const contactId = cn.Contact?.ContactID || "";
    const numKey = row.invoiceNumber.trim().toLowerCase();
    const invoiceId = invoiceIdMap.get(`${numKey}|${contactId}`) || invoiceIdMap.get(numKey);
    if (!invoiceId) return { error: `Invoice/Bill "${row.invoiceNumber}" not found in Xero (must be AUTHORISED).` };
    const invoiceAmountDue = invoiceAmountDueMap.get(invoiceId);
    let amountToAllocate = row.amount ? Number(row.amount) : remainingCredit;
    if (!Number.isFinite(amountToAllocate) || amountToAllocate <= 0) return { error: `Invalid amount: ${row.amount}` };
    if (amountToAllocate > remainingCredit + 0.01) return { error: `Amount ${amountToAllocate} exceeds remaining credit ${remainingCredit} for "${row.creditNoteReference}".` };
    amountToAllocate = Math.min(amountToAllocate, remainingCredit);
    if (invoiceAmountDue !== undefined && invoiceAmountDue > 0) amountToAllocate = Math.min(amountToAllocate, invoiceAmountDue);
    const date = parseDateForXero(row.date) || new Date().toISOString().slice(0, 10);
    cn.RemainingCredit = Math.max(0, remainingCredit - amountToAllocate);
    return { creditNoteId: cn.CreditNoteID, invoiceId, amount: amountToAllocate, date, finalAmount: amountToAllocate };
  };

  const processRowFallback = async (row) => {
    job.currentReference = row.creditNoteReference || "";
    job.updatedAt = Date.now();
    try {
      const cn = creditNoteMap.get(row.creditNoteReference);
      if (!cn) throw new Error(phase1BudgetStopped
        ? `API quota exhausted — "${row.creditNoteReference}" was not reached.`
        : `Credit note "${row.creditNoteReference}" not found in Xero.`);
      const contactId = cn.Contact?.ContactID;
      if (!contactId) throw new Error(`Credit note "${row.creditNoteReference}" has no contact linked.`);
      const remainingCredit = Number(cn.RemainingCredit) || 0;
      if (remainingCredit <= 0) {
        job.skipped += 1;
        job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: "", amount: row.amount || "", status: "skipped", message: `Credit note "${row.creditNoteReference}" is fully allocated — skipped.` });
        job.processed += 1;
        return;
      }
      const invResult = await findOutstandingInvoicesForContact(job.tenantId, job.sessionId, contactId, invoiceXeroType);
      if (invResult?.sessionId) job.sessionId = invResult.sessionId;
      const invoices = invResult?.invoices || [];
      if (!invoices.length) throw new Error(`No outstanding ${job.allocationType === "DEBIT" ? "bills" : "invoices"} found for contact of "${row.creditNoteReference}".`);
      let amountToAllocate = row.amount ? Number(row.amount) : remainingCredit;
      if (!Number.isFinite(amountToAllocate) || amountToAllocate <= 0) throw new Error(`Invalid amount: ${row.amount}`);
      const date = parseDateForXero(row.date) || new Date().toISOString().slice(0, 10);
      let remaining = amountToAllocate;
      const allocatedTo = [];
      for (const inv of invoices) {
        if (remaining <= 0) break;
        const amountDue = Number(inv.AmountDue) || 0;
        if (amountDue <= 0) continue;
        const allocAmount = Math.min(remaining, amountDue);
        const allocResult = await createCreditNoteAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, creditNoteId: cn.CreditNoteID, allocations: [{ invoiceId: inv.InvoiceID, amount: allocAmount }], date });
        if (allocResult?.sessionId) job.sessionId = allocResult.sessionId;
        allocatedTo.push(`${inv.InvoiceNumber || inv.InvoiceID} (${allocAmount})`);
        remaining -= allocAmount;
        cn.RemainingCredit = Math.max(0, (Number(cn.RemainingCredit) || 0) - allocAmount);
      }
      if (allocatedTo.length === 0) throw new Error(`No invoices could be allocated for credit note "${row.creditNoteReference}".`);
      const totalAllocated = amountToAllocate - remaining;
      job.created += 1;
      job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: allocatedTo.join(", "), amount: totalAllocated, status: remaining > 0 ? "partial" : "created", message: remaining > 0 ? `Partially allocated ${totalAllocated} from "${row.creditNoteReference}" to: ${allocatedTo.join(", ")}.` : `Allocated ${totalAllocated} from "${row.creditNoteReference}" to: ${allocatedTo.join(", ")}.` });
    } catch (err) {
      job.errors += 1;
      job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: err.message });
    }
    job.processed += 1;
    job.updatedAt = Date.now();
  };

  // Phase 3: resolve all rows first (no API calls), then batch by credit note ID
  const pendingBatches = new Map(); // creditNoteId → [{ row, resolved }]

  for (const row of job.rows) {
    if (job.cancelRequested) break;
    job.currentReference = row.creditNoteReference || "";
    job.updatedAt = Date.now();
    if (!row.invoiceNumber) {
      await processRowFallback(row);
      continue;
    }
    const resolved = resolveRow(row);
    if (resolved.error) {
      job.errors += 1;
      job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: resolved.error });
      job.processed += 1;
    } else if (resolved.skip) {
      job.skipped += 1;
      job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "skipped", message: resolved.skip });
      job.processed += 1;
    } else {
      if (!pendingBatches.has(resolved.creditNoteId)) pendingBatches.set(resolved.creditNoteId, []);
      pendingBatches.get(resolved.creditNoteId).push({ row, resolved });
    }
    job.updatedAt = Date.now();
  }

  // One API call per unique credit note — batches all its allocations together
  for (const [creditNoteId, items] of pendingBatches) {
    if (job.cancelRequested) break;
    job.currentReference = items[0]?.row.creditNoteReference || "";
    job.updatedAt = Date.now();
    try {
      const allocResult = await createCreditNoteAllocationInXero({
        tenantId: job.tenantId,
        requestedSessionId: job.sessionId,
        creditNoteId,
        allocations: items.map(({ resolved }) => ({ invoiceId: resolved.invoiceId, amount: resolved.amount, date: resolved.date })),
        date: items[0].resolved.date,
      });
      if (allocResult?.sessionId) job.sessionId = allocResult.sessionId;
      for (const { row, resolved } of items) {
        job.created += 1;
        job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: row.invoiceNumber, amount: resolved.finalAmount, status: "created", message: `Allocated ${resolved.finalAmount} from "${row.creditNoteReference}" to: ${row.invoiceNumber}.` });
        job.processed += 1;
      }
    } catch (err) {
      for (const { row } of items) {
        job.errors += 1;
        job.results.push({ rowNumber: row.rowNumber, creditNoteReference: row.creditNoteReference, allocatedTo: row.invoiceNumber || "", amount: row.amount || "", status: "error", message: err.message });
        job.processed += 1;
      }
    }
    job.updatedAt = Date.now();
  }

  job.currentReference = "";
  job.status = job.cancelRequested ? "cancelled" : (job.errors ? "completed_with_errors" : "completed");
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/import/credit-note-allocation/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation before importing." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in the CSV file." });
    if (rows.length > 50000) return res.status(400).json({ error: "Maximum 50000 rows per import." });
    const allocTypeStr = String(req.body?.allocationType || "credit").toLowerCase();
    const sessionId = String(req.body?.sessionId || req.header("x-session-id") || "").trim();
    const normalizedRows = rows.map((row, i) => ({
      rowNumber: Number(row.rowNumber) || i + 2,
      creditNoteReference: String(row.creditNoteReference || "").trim(),
      invoiceNumber: String(row.invoiceNumber || "").trim(),
      contactName: String(row.contactName || "").trim(),
      amount: String(row.amount || "").trim(),
      date: String(row.date || "").trim(),
    })).filter(r => r.creditNoteReference);
    if (!normalizedRows.length) return res.status(400).json({ error: "No valid rows found (Credit Note Number is required)." });
    const badAmountRows = normalizedRows.filter(r => r.amount && (Number.isNaN(Number(r.amount)) || Number(r.amount) <= 0));
    if (badAmountRows.length) return res.status(400).json({ error: `Rows ${badAmountRows.map(r => r.rowNumber).join(", ")} have invalid Amount values.` });
    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId,
      sessionId,
      allocationType: allocTypeStr === "debit" ? "DEBIT" : "CREDIT",
      status: "queued",
      total: normalizedRows.length,
      processed: 0,
      created: 0,
      errors: 0,
      skipped: 0,
      currentReference: "",
      rows: normalizedRows,
      results: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    job.forceMDY = req.body?.dateFormat === 'MM/DD/YYYY';
    creditNoteAllocationJobStore.set(job.id, job);
    setTimeout(() => {
      processCreditNoteAllocationJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, ...buildCreditNoteAllocationStatus(job) });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/import/credit-note-allocation/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = creditNoteAllocationJobStore.get(jobId);
  if (!job) return res.status(404).json({ error: "Credit note allocation job not found" });
  if (job.userId !== userData.user.id && !userData.user.isAdmin) return res.status(403).json({ error: "Forbidden" });
  return res.json({ ok: true, ...buildCreditNoteAllocationStatus(job) });
});

// ── Auto-Create Missing Contacts ────────────────────────────────────────────

app.post("/api/contacts/ensure", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "tenantId required" });
    const names = Array.isArray(req.body?.names) ? req.body.names.map((n) => String(n || "").trim()).filter(Boolean) : [];
    if (!names.length) return res.json({ ok: true, created: [], alreadyExist: [] });

    const sessionId = req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null;

    // Fetch existing contacts by name (up to 100 at a time via WHERE clause)
    const existingNames = new Set();
    const CHUNK = 50;
    for (let i = 0; i < names.length; i += CHUNK) {
      const chunk = names.slice(i, i + CHUNK);
      const whereClause = chunk.map((n) => `Name=="${n.replace(/"/g, '\\"')}"`).join(" OR ");
      try {
        const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(whereClause)}&includeArchived=false`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
          );
          return { contacts: data?.Contacts || [] };
        });
        (result.contacts || []).forEach((c) => { if (c.Name) existingNames.add(c.Name.trim()); });
      } catch (_) {}
    }

    const toCreate = [...new Set(names)].filter((n) => !existingNames.has(n));
    const created = [];
    const failed = [];

    // Create missing contacts in batches of 100
    for (let i = 0; i < toCreate.length; i += 100) {
      const chunk = toCreate.slice(i, i + 100);
      try {
        const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Contacts?summarizeErrors=false", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "xero-tenant-id": tenantId,
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomBytes(16).toString("hex"),
            },
            body: JSON.stringify({ Contacts: chunk.map((name) => ({ Name: name })) }),
          });
          return { contacts: data?.Contacts || [] };
        });
        (result.contacts || []).forEach((c, idx) => {
          const errors = Array.isArray(c.ValidationErrors) ? c.ValidationErrors : [];
          if (c.StatusAttributeString === "ERROR" || errors.length) {
            failed.push({ name: chunk[idx], message: errors.map((e) => e.Message).filter(Boolean).join("; ") || "Failed to create contact" });
          } else {
            created.push({ name: c.Name, contactId: c.ContactID });
          }
        });
      } catch (err) {
        chunk.forEach((name) => failed.push({ name, message: err.message }));
      }
    }

    return res.json({ ok: true, created, alreadyExist: [...existingNames].filter((n) => names.includes(n)), failed });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Bulk Update Status ────────────────────────────────────────────────────────
// Allows approving (DRAFT→AUTHORISED) or voiding existing invoices/bills by number

const updateStatusJobStore = new Map();

async function processUpdateStatusJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const BATCH = 20;
  const CONCURRENCY = 3;

  // Group: for each row, look up invoice by number then patch status
  const rows = job.rows || [];
  const chunks = [];
  for (let i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));

  for (const chunk of chunks) {
    if (job.cancelRequested) break;
    const batchFns = chunk.map((row) => async () => {
      const { number, newStatus, docType } = row;
      try {
        let foundId = null;
        let docLabel = docType;

        if (docType === "CREDITNOTE") {
          // Credit Note lookup + patch
          const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/CreditNotes?CreditNoteNumbers=${encodeURIComponent(number)}`, { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } });
            return { items: data?.CreditNotes || [] };
          });
          if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
          foundId = lr.items[0]?.CreditNoteID;
          if (!foundId) { job.errors++; job.results.push({ number, docType, status: "error", message: `Credit Note "${number}" not found in Xero.` }); job.processed++; return; }
          const pr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/CreditNotes/${foundId}?summarizeErrors=false`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ CreditNotes: [{ CreditNoteID: foundId, Status: newStatus }] }) });
            return { updated: data?.CreditNotes?.[0] };
          });
          if (pr.resolvedSessionId) job.sessionId = pr.resolvedSessionId;
          const errs = Array.isArray(pr.updated?.ValidationErrors) ? pr.updated.ValidationErrors : [];
          if (pr.updated?.StatusAttributeString === "ERROR" || errs.length) { job.errors++; job.results.push({ number, docType, status: "error", message: errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Update failed." }); }
          else { job.created++; job.results.push({ number, docType, status: "ok", message: `Credit Note updated to ${newStatus}`, creditNoteId: foundId }); }
          job.processed++; return;

        } else if (docType === "QUOTE") {
          // Quote lookup + patch
          const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Quotes?where=${encodeURIComponent(`QuoteNumber=="${number.replace(/"/g, "")}"`)}&page=1`, { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } });
            return { items: data?.Quotes || [] };
          });
          if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
          foundId = lr.items[0]?.QuoteID;
          if (!foundId) { job.errors++; job.results.push({ number, docType, status: "error", message: `Quote "${number}" not found in Xero.` }); job.processed++; return; }
          const pr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Quotes/${foundId}`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ Quotes: [{ QuoteID: foundId, Status: newStatus }] }) });
            return { updated: data?.Quotes?.[0] };
          });
          if (pr.resolvedSessionId) job.sessionId = pr.resolvedSessionId;
          const errs = Array.isArray(pr.updated?.ValidationErrors) ? pr.updated.ValidationErrors : [];
          if (pr.updated?.StatusAttributeString === "ERROR" || errs.length) { job.errors++; job.results.push({ number, docType, status: "error", message: errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Update failed." }); }
          else { job.created++; job.results.push({ number, docType, status: "ok", message: `Quote updated to ${newStatus}`, quoteId: foundId }); }
          job.processed++; return;

        } else if (docType === "PO" || docType === "PURCHASEORDER") {
          // Purchase Order lookup + patch
          const lr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/PurchaseOrders?PurchaseOrderNumbers=${encodeURIComponent(number)}`, { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } });
            return { items: data?.PurchaseOrders || [] };
          });
          if (lr.resolvedSessionId) job.sessionId = lr.resolvedSessionId;
          foundId = lr.items[0]?.PurchaseOrderID;
          if (!foundId) { job.errors++; job.results.push({ number, docType, status: "error", message: `Purchase Order "${number}" not found in Xero.` }); job.processed++; return; }
          const pr = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const { data } = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/PurchaseOrders/${foundId}?summarizeErrors=false`, { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ PurchaseOrders: [{ PurchaseOrderID: foundId, Status: newStatus }] }) });
            return { updated: data?.PurchaseOrders?.[0] };
          });
          if (pr.resolvedSessionId) job.sessionId = pr.resolvedSessionId;
          const errs = Array.isArray(pr.updated?.ValidationErrors) ? pr.updated.ValidationErrors : [];
          if (pr.updated?.StatusAttributeString === "ERROR" || errs.length) { job.errors++; job.results.push({ number, docType, status: "error", message: errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Update failed." }); }
          else { job.created++; job.results.push({ number, docType, status: "ok", message: `Purchase Order updated to ${newStatus}`, poId: foundId }); }
          job.processed++; return;

        } else {
        // Invoice or Bill lookup + patch
        const type = docType === "BILL" ? "ACCPAY" : "ACCREC";
        const lookupResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const { data } = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Invoices?InvoiceNumbers=${encodeURIComponent(number)}&Type=${type}`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { invoices: data?.Invoices || [] };
        });
        if (lookupResult.resolvedSessionId) job.sessionId = lookupResult.resolvedSessionId;
        const found = lookupResult.invoices[0];
        if (!found || !found.InvoiceID) {
          job.errors++;
          job.results.push({ number, docType, status: "error", message: `${docType === "BILL" ? "Bill" : "Invoice"} "${number}" not found in Xero.` });
          job.processed++;
          return;
        }
        const invoiceId = found.InvoiceID;
        const patchResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const body = { Invoices: [{ InvoiceID: invoiceId, Status: newStatus }] };
          const { data } = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}?summarizeErrors=false`,
            { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) }
          );
          return { updated: data?.Invoices?.[0] };
        });
        if (patchResult.resolvedSessionId) job.sessionId = patchResult.resolvedSessionId;
        const updated = patchResult.updated || {};
        const errs = Array.isArray(updated.ValidationErrors) ? updated.ValidationErrors : [];
        if (updated.StatusAttributeString === "ERROR" || errs.length) {
          job.errors++;
          const msg = errs.map(e => e.Message || e.Description).filter(Boolean).join("; ") || "Update failed.";
          job.results.push({ number, docType, status: "error", message: msg });
        } else {
          job.created++;
          job.results.push({ number, docType, status: "ok", message: `Updated to ${newStatus}`, invoiceId });
        }
        job.processed++;
        } // end Invoice/Bill branch
      } catch (err) {
        job.errors++;
        job.results.push({ number, docType, status: "error", message: err.message });
        job.processed++;
      }
      job.updatedAt = Date.now();
    });

    // Run batch with concurrency
    const running = [];
    for (const fn of batchFns) {
      const p = fn().then(() => running.splice(running.indexOf(p), 1));
      running.push(p);
      if (running.length >= CONCURRENCY) await Promise.race(running);
    }
    await Promise.all(running);
  }

  const createdIds = job.results.filter(r => r.invoiceId).map(r => r.invoiceId);
  recordImportHistory({
    importType: "update-status",
    tenantId: job.tenantId,
    orgName: job.orgName || "",
    userId: job.userId,
    userEmail: job.userEmail,
    total: job.total,
    created: job.created,
    errors: job.errors,
    status: job.errors > 0 && job.created === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed",
    jobId: job.id,
    createdIds,
    note: job.note || "",
  });

  job.status = job.errors > 0 && job.created === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/update/status/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows found in CSV." });
    if (rows.length > 5000) return res.status(400).json({ error: "Maximum 5000 records per update." });

    const normalised = rows.map((r, i) => ({
      rowNumber: Number(r.rowNumber) || i + 2,
      number: String(r.number || r.invoiceNumber || r.billNumber || "").trim(),
      newStatus: String(r.newStatus || r.status || "").trim().toUpperCase(),
      docType: String(r.docType || r.type || "INVOICE").trim().toUpperCase(),
    })).filter(r => r.number && r.newStatus);

    if (!normalised.length) return res.status(400).json({ error: "No valid rows found. Ensure Number and New Status columns are filled." });

    const validStatuses = ["DRAFT", "SUBMITTED", "AUTHORISED", "VOIDED", "DELETED", "SENT", "ACCEPTED", "DECLINED", "BILLED"];
    const invalidRows = normalised.filter(r => !validStatuses.includes(r.newStatus));
    if (invalidRows.length) return res.status(400).json({ error: `Invalid status values: ${[...new Set(invalidRows.map(r => r.newStatus))].join(", ")}. Use: DRAFT, AUTHORISED, VOIDED (invoices/bills/credit notes), SENT/ACCEPTED/DECLINED (quotes), SUBMITTED/BILLED (purchase orders)` });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      userEmail: userData.user.email,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      filename: String(req.body?.filename || "update-status.csv"),
      status: "queued",
      total: normalised.length,
      processed: 0,
      created: 0,
      errors: 0,
      results: [],
      rows: normalised,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    updateStatusJobStore.set(job.id, job);
    setTimeout(() => {
      processUpdateStatusJob(job).catch((err) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, total: job.total, status: job.status });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/update/status/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const jobId = String(req.query.jobId || "").trim();
  const job = updateStatusJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    created: job.created,
    errors: job.errors,
    results: job.results.slice(-50),
    error: job.error || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed))
      : null,
  });
});

// ── Smart Auto Allocation ─────────────────────────────────────────────────────

const autoAllocationJobStore = new Map();
const fixAllocationDatesJobStore = new Map();
const removeAllocationsJobStore = new Map();
const removeInvoicePaymentsJobStore = new Map();

// Purge completed/errored jobs older than 2 hours to prevent memory leaks
setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const cutoff = Date.now() - TWO_HOURS;
  for (const [id, job] of autoAllocationJobStore) {
    const done = ["completed", "completed_with_errors", "error"].includes(job.status);
    if (done && job.finishedAt && job.finishedAt < cutoff) autoAllocationJobStore.delete(id);
  }
  for (const [id, job] of fixAllocationDatesJobStore) {
    const done = ["completed", "completed_with_errors", "error"].includes(job.status);
    if (done && job.finishedAt && job.finishedAt < cutoff) fixAllocationDatesJobStore.delete(id);
  }
  for (const [id, job] of removeAllocationsJobStore) {
    const done = ["completed", "completed_with_errors", "error"].includes(job.status);
    if (done && job.finishedAt && job.finishedAt < cutoff) removeAllocationsJobStore.delete(id);
  }
  for (const [id, job] of removeInvoicePaymentsJobStore) {
    const done = ["completed", "completed_with_errors", "error"].includes(job.status);
    if (done && job.finishedAt && job.finishedAt < cutoff) removeInvoicePaymentsJobStore.delete(id);
  }
}, 30 * 60 * 1000); // runs every 30 minutes

function xeroDateToMs(dateStr) {
  if (!dateStr) return 0;
  const match = String(dateStr).match(/\/Date\((\d+)/);
  if (match) return parseInt(match[1], 10);
  const parsed = Date.parse(dateStr);
  return isNaN(parsed) ? 0 : parsed;
}

function runSmartMatchingEngine(creditNotes, invoices) {
  const suggestions = [];
  const noMatchCredits = [];

  // Build invoice map: contactId|currency → invoice list with mutable remainingDue
  const invMap = new Map();
  for (const inv of invoices) {
    const contactId = inv.Contact?.ContactID || "";
    const currency = (inv.CurrencyCode || "GBP").toUpperCase();
    const key = `${contactId}|${currency}`;
    if (!invMap.has(key)) invMap.set(key, []);
    invMap.get(key).push({
      InvoiceID: inv.InvoiceID,
      InvoiceNumber: inv.InvoiceNumber || inv.InvoiceID,
      AmountDue: Number(inv.AmountDue) || 0,
      Date: inv.Date || "",
      dateMs: xeroDateToMs(inv.Date),
      Type: inv.Type,
      remainingDue: Number(inv.AmountDue) || 0,
    });
  }
  for (const invList of invMap.values()) {
    invList.sort((a, b) => a.dateMs - b.dateMs); // oldest first
  }

  // Sort credit notes: largest RemainingCredit first
  const sorted = [...creditNotes].sort((a, b) => (Number(b.RemainingCredit) || 0) - (Number(a.RemainingCredit) || 0));

  for (const cn of sorted) {
    const contactId = cn.Contact?.ContactID || "";
    const currency = (cn.CurrencyCode || "GBP").toUpperCase();
    const key = `${contactId}|${currency}`;
    let remaining = Number(cn.RemainingCredit) || 0;
    if (remaining < 0.005) continue;

    const invList = invMap.get(key) || [];
    const available = invList.filter(inv => inv.remainingDue > 0.005);

    if (!available.length) {
      noMatchCredits.push({
        contactId,
        contactName: cn.Contact?.Name || "",
        creditNoteId: cn.CreditNoteID,
        creditNoteNumber: cn.CreditNoteNumber || "",
        availableCredit: Number(cn.RemainingCredit) || 0,
        currency,
        type: cn.Type,
      });
      continue;
    }

    const originalRemaining = remaining;
    for (const inv of available) {
      if (remaining < 0.005) break;
      const alloc = Math.round(Math.min(remaining, inv.remainingDue) * 100) / 100;
      if (alloc < 0.005) continue;

      const exactCN = Math.abs(alloc - originalRemaining) < 0.005;
      const exactInv = Math.abs(alloc - inv.AmountDue) < 0.005;
      let matchType = "partial";
      if (exactCN && exactInv) matchType = "exact";
      else if (exactCN) matchType = "partial_credit";
      else if (exactInv) matchType = "partial_invoice";

      suggestions.push({
        contactId,
        contactName: cn.Contact?.Name || "",
        creditNoteId: cn.CreditNoteID,
        creditNoteNumber: cn.CreditNoteNumber || "",
        creditNoteTotal: Number(cn.SubTotal) || 0,
        invoiceId: inv.InvoiceID,
        invoiceNumber: inv.InvoiceNumber,
        invoiceDate: formatXeroDate(inv.dateMs ? `/Date(${inv.dateMs})/` : inv.Date, ""),
        amount: alloc,
        currency,
        matchType,
        cnType: cn.Type,
        invType: inv.Type,
      });

      inv.remainingDue = Math.max(0, inv.remainingDue - alloc);
      remaining = Math.max(0, remaining - alloc);
    }
  }

  return { suggestions, noMatchCredits };
}

// Generic matching engine for overpayments and prepayments → invoices/bills
// sourceType: "spend-overpayment"|"receive-overpayment"|"spend-prepayment"|"receive-prepayment"
// sourceIdField: "OverpaymentID" or "PrepaymentID"
function runSourceMatchingEngine(sources, invoices, sourceType, sourceIdField) {
  const suggestions = [];
  const noMatchSources = [];

  const invMap = new Map();
  for (const inv of invoices) {
    const contactId = inv.Contact?.ContactID || "";
    const currency = (inv.CurrencyCode || "USD").toUpperCase();
    const key = `${contactId}|${currency}`;
    if (!invMap.has(key)) invMap.set(key, []);
    invMap.get(key).push({
      InvoiceID: inv.InvoiceID,
      InvoiceNumber: inv.InvoiceNumber || inv.InvoiceID,
      AmountDue: Number(inv.AmountDue) || 0,
      dateMs: xeroDateToMs(inv.Date),
      Date: inv.Date || "",
      remainingDue: Number(inv.AmountDue) || 0,
    });
  }
  for (const invList of invMap.values()) {
    invList.sort((a, b) => a.dateMs - b.dateMs);
  }

  const sorted = [...sources].sort((a, b) => (Number(b.RemainingCredit) || 0) - (Number(a.RemainingCredit) || 0));

  for (const src of sorted) {
    const contactId = src.Contact?.ContactID || "";
    const currency = (src.CurrencyCode || "USD").toUpperCase();
    const key = `${contactId}|${currency}`;
    let remaining = Number(src.RemainingCredit) || 0;
    if (remaining < 0.005) continue;

    const invList = invMap.get(key) || [];
    const available = invList.filter(inv => inv.remainingDue > 0.005);

    if (!available.length) {
      noMatchSources.push({
        contactId,
        contactName: src.Contact?.Name || "",
        sourceId: src[sourceIdField],
        creditNoteNumber: src.Reference || src[sourceIdField],
        availableCredit: Number(src.RemainingCredit) || 0,
        currency,
      });
      continue;
    }

    const originalRemaining = remaining;
    for (const inv of available) {
      if (remaining < 0.005) break;
      const alloc = Math.round(Math.min(remaining, inv.remainingDue) * 100) / 100;
      if (alloc < 0.005) continue;

      const exactSrc = Math.abs(alloc - originalRemaining) < 0.005;
      const exactInv = Math.abs(alloc - inv.AmountDue) < 0.005;
      let matchType = "partial";
      if (exactSrc && exactInv) matchType = "exact";
      else if (exactSrc) matchType = "partial_credit";
      else if (exactInv) matchType = "partial_invoice";

      suggestions.push({
        type: sourceType,
        sourceId: src[sourceIdField],
        contactId,
        contactName: src.Contact?.Name || "",
        creditNoteNumber: src.Reference || src[sourceIdField],
        invoiceId: inv.InvoiceID,
        invoiceNumber: inv.InvoiceNumber,
        invoiceDate: formatXeroDate(inv.dateMs ? `/Date(${inv.dateMs})/` : inv.Date, ""),
        amount: alloc,
        currency,
        matchType,
      });

      inv.remainingDue = Math.max(0, inv.remainingDue - alloc);
      remaining = Math.max(0, remaining - alloc);
    }
  }

  return { suggestions, noMatchSources };
}

app.post("/api/auto-allocation/analyze", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const mode = String(req.body?.mode || "both").toLowerCase();
    const sessionId = req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null;
    const fromDate = req.body?.fromDate ? String(req.body.fromDate).trim() : null;
    const toDate = req.body?.toDate ? String(req.body.toDate).trim() : null;

    const toXeroDT = (d) => { const [y, m, day] = d.split("-").map(Number); return `DateTime(${y},${m},${day})`; };
    let xeroLimitRemaining = null;

    // ── Overpayments & Prepayments modes ────────────────────────────────────
    const SOURCE_MODES = {
      "spend-overpayments":    { api: "Overpayments", xeroType: "SPEND",             sourceIdField: "OverpaymentID", invType: "ACCPAY", sourceType: "spend-overpayment"    },
      "receive-overpayments":  { api: "Overpayments", xeroType: "RECEIVE",           sourceIdField: "OverpaymentID", invType: "ACCREC", sourceType: "receive-overpayment"  },
      "spend-prepayments":     { api: "Prepayments",  xeroType: "SPEND-PREPAYMENT",  sourceIdField: "PrepaymentID",  invType: "ACCPAY", sourceType: "spend-prepayment"     },
      "receive-prepayments":   { api: "Prepayments",  xeroType: "RECEIVE-PREPAYMENT",sourceIdField: "PrepaymentID",  invType: "ACCREC", sourceType: "receive-prepayment"   },
    };

    if (SOURCE_MODES[mode]) {
      const cfg = SOURCE_MODES[mode];
      const sources = [];
      const fromMs = fromDate ? new Date(fromDate).getTime() : null;
      const toMs   = toDate   ? new Date(toDate + "T23:59:59").getTime() : null;
      for (let page = 1; page <= 1000; page++) {
        let result;
        try {
          result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
            const res = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/${cfg.api}?page=${page}&pageSize=1000`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
            );
            return { items: res.data?.[cfg.api] || [], dayRemaining: res.rate?.day };
          });
        } catch (err) {
          if (String(err.message).includes("404")) break;
          throw err;
        }
        const items = (result?.items || []).filter(s => {
          // Handle both "SPEND" and "SPEND-OVERPAYMENT" — compound types match exactly, simple types match as prefix
          const typeStr = String(s.Type || "").toUpperCase();
          const expectedStr = cfg.xeroType.toUpperCase();
          const typeMatch = expectedStr.includes("-") ? typeStr === expectedStr : (typeStr === expectedStr || typeStr.startsWith(expectedStr + "-"));
          if (!typeMatch) return false;
          if (Number(s.RemainingCredit) <= 0) return false;
          if (s.Status !== "AUTHORISED") return false;
          if (fromMs || toMs) { const ms = xeroDateToMs(s.Date); if (fromMs && ms < fromMs) return false; if (toMs && ms > toMs) return false; }
          return true;
        });
        sources.push(...items);
        if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
        if ((result?.items || []).length < 1000) break;
      }

      const invoices = [];
      const srcContactIds = [...new Set(sources.map(s => s.Contact?.ContactID).filter(Boolean))];
      if (srcContactIds.length > 0) {
        const CONTACT_BATCH = 100;
        for (let ci = 0; ci < srcContactIds.length; ci += CONTACT_BATCH) {
          const contactBatch = srcContactIds.slice(ci, ci + CONTACT_BATCH);
          for (let page = 1; page <= 1000; page++) {
            let result;
            try {
              result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
                const res = await fetchWithRetry(
                  `https://api.xero.com/api.xro/2.0/Invoices?page=${page}&pageSize=1000&ContactIDs=${contactBatch.join(",")}&Statuses=AUTHORISED`,
                  { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
                );
                return { items: res.data?.Invoices || [], dayRemaining: res.rate?.day };
              });
            } catch (err) {
              if (String(err.message).includes("404")) break;
              throw err;
            }
            const items = (result?.items || []).filter(inv => inv.Type === cfg.invType && Number(inv.AmountDue) > 0);
            invoices.push(...items);
            if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
            if ((result?.items || []).length < 1000) break;
          }
        }
      }

      const { suggestions, noMatchSources } = runSourceMatchingEngine(sources, invoices, cfg.sourceType, cfg.sourceIdField);
      const exactCount = suggestions.filter(s => s.matchType === "exact").length;
      const partialCount = suggestions.filter(s => s.matchType !== "exact").length;
      const totalAmount = suggestions.reduce((sum, s) => sum + s.amount, 0);

      return res.json({
        ok: true,
        mode,
        totalCreditNotes: sources.length,
        totalInvoices: invoices.length,
        suggestions,
        noMatchCredits: noMatchSources,
        stats: { exact: exactCount, partial: partialCount, noMatch: noMatchSources.length, totalAmount },
      });
    }

    // ── ALL mode — fetch every type and combine ──────────────────────────────
    if (mode === "all") {
      const fromMs = fromDate ? new Date(fromDate).getTime() : null;
      const toMs   = toDate   ? new Date(toDate + "T23:59:59").getTime() : null;
      const df = (fromDate ? ` && Date>=${toXeroDT(fromDate)}` : "") + (toDate ? ` && Date<=${toXeroDT(toDate)}` : "");

      // Credit notes support WHERE; overpayments/prepayments do not — fetch all, filter in code
      const fetchCNPages = async (cnType) => {
        const items = [];
        for (let page = 1; page <= 1000; page++) {
          let result;
          try {
            result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/CreditNotes?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${cnType}" && Status=="AUTHORISED" && RemainingCredit>0${df}`)}`,
                { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
              );
              return { items: res.data?.CreditNotes || [], dayRemaining: res.rate?.day };
            });
          } catch (err) {
            if (String(err.message).includes("404")) break;
            throw err;
          }
          items.push(...(result?.items || []));
          if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
          if ((result?.items || []).length < 1000) break;
        }
        return items;
      };

      // Fetch all overpayments/prepayments without type filter — split in code
      // (Xero /Overpayments API may return Type as "SPEND", "RECEIVE", "SPEND-OVERPAYMENT", etc.)
      const fetchSourcePages = async (api) => {
        const items = [];
        for (let page = 1; page <= 1000; page++) {
          let result;
          try {
            result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/${api}?page=${page}&pageSize=1000`,
                { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
              );
              return { items: res.data?.[api] || [], dayRemaining: res.rate?.day };
            });
          } catch (err) {
            // Xero returns 404 when page exceeds total — treat as end of data
            if (String(err.message).includes("404")) break;
            throw err;
          }
          const batch = (result?.items || []).filter(x => {
            if (Number(x.RemainingCredit) <= 0) return false;
            if (fromMs || toMs) { const ms = xeroDateToMs(x.Date); if (fromMs && ms < fromMs) return false; if (toMs && ms > toMs) return false; }
            return true;
          });
          items.push(...batch);
          if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
          if ((result?.items || []).length < 1000) break;
        }
        return items;
      };

      // Sequential to avoid rate limits (overpayments = 3000+ records = many pages)
      const cnPurchase = await fetchCNPages("ACCPAYCREDIT");
      const cnSales    = await fetchCNPages("ACCRECCREDIT");
      const allOPs     = await fetchSourcePages("Overpayments");
      const allPPs     = await fetchSourcePages("Prepayments");

      // Split by type using includes() to handle both "SPEND" and "SPEND-OVERPAYMENT"
      const spendOPs   = allOPs.filter(x => String(x.Type || "").toUpperCase().includes("SPEND") && !String(x.Type || "").toUpperCase().includes("RECEIVE"));
      const receiveOPs = allOPs.filter(x => String(x.Type || "").toUpperCase().includes("RECEIVE"));
      const spendPPs   = allPPs.filter(x => String(x.Type || "").toUpperCase().includes("SPEND") && !String(x.Type || "").toUpperCase().includes("RECEIVE"));
      const receivePPs = allPPs.filter(x => String(x.Type || "").toUpperCase().includes("RECEIVE"));

      console.log(`[All Mode] CN:${cnPurchase.length+cnSales.length} SpendOP:${spendOPs.length} RcvOP:${receiveOPs.length} SpendPP:${spendPPs.length} RcvPP:${receivePPs.length}`);
      // Fetch ALL outstanding bills/invoices using WHERE clause (ContactIDs filter doesn't work for ACCPAY)
      const fetchInvPages = async (invType) => {
        const items = [];
        for (let page = 1; page <= 1000; page++) {
          let result;
          try {
            result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
              const where = encodeURIComponent(`Type=="${invType}" && Status=="AUTHORISED" && AmountDue>0${df}`);
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/Invoices?page=${page}&pageSize=1000&where=${where}`,
                { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
              );
              return { items: res.data?.Invoices || [], dayRemaining: res.rate?.day };
            });
          } catch (err) {
            if (String(err.message).includes("404")) break;
            throw err;
          }
          const validItems = (result?.items || []).filter(inv => Number(inv.AmountDue) > 0);
          items.push(...validItems);
          if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
          if ((result?.items || []).length < 1000) break;
        }
        return items;
      };

      const accpay = await fetchInvPages("ACCPAY");
      const accrec = await fetchInvPages("ACCREC");
      console.log(`[All Mode] ACCPAY bills: ${accpay.length} | ACCREC invoices: ${accrec.length}`);

      const copyInvs = (invs) => invs.map(inv => ({ ...inv }));

      const { suggestions: cnSugg,     noMatchCredits: cnNoMatch }  = runSmartMatchingEngine([...cnPurchase, ...cnSales], copyInvs([...accpay, ...accrec]));
      const { suggestions: spOpSugg,   noMatchSources: spOpNoMatch } = runSourceMatchingEngine(spendOPs,   copyInvs(accpay), "spend-overpayment",   "OverpaymentID");
      const { suggestions: rcOpSugg,   noMatchSources: rcOpNoMatch } = runSourceMatchingEngine(receiveOPs, copyInvs(accrec), "receive-overpayment", "OverpaymentID");
      const { suggestions: spPpSugg,   noMatchSources: spPpNoMatch } = runSourceMatchingEngine(spendPPs,   copyInvs(accpay), "spend-prepayment",    "PrepaymentID");
      const { suggestions: rcPpSugg,   noMatchSources: rcPpNoMatch } = runSourceMatchingEngine(receivePPs, copyInvs(accrec), "receive-prepayment",  "PrepaymentID");

      const allSugg = [...cnSugg, ...spOpSugg, ...rcOpSugg, ...spPpSugg, ...rcPpSugg];
      const allNoMatch = [...cnNoMatch, ...spOpNoMatch, ...rcOpNoMatch, ...spPpNoMatch, ...rcPpNoMatch];
      const totalSources = cnPurchase.length + cnSales.length + spendOPs.length + receiveOPs.length + spendPPs.length + receivePPs.length;

      return res.json({
        ok: true,
        mode: "all",
        totalCreditNotes: totalSources,
        totalInvoices: accpay.length + accrec.length,
        suggestions: allSugg,
        noMatchCredits: allNoMatch,
        stats: {
          exact: allSugg.filter(s => s.matchType === "exact").length,
          partial: allSugg.filter(s => s.matchType !== "exact").length,
          noMatch: allNoMatch.length,
          totalAmount: allSugg.reduce((sum, s) => sum + s.amount, 0),
        },
      });
    }

    // ── Credit Notes mode (default) ──────────────────────────────────────────
    // Date filter applies to credit notes only — invoices are fetched by contact ID (no date restriction)
    const dateFilter = (fromDate ? ` && Date>=${toXeroDT(fromDate)}` : "") + (toDate ? ` && Date<=${toXeroDT(toDate)}` : "");

    const cnTypes = mode === "sales" ? ["ACCRECCREDIT"] : mode === "purchase" ? ["ACCPAYCREDIT"] : ["ACCRECCREDIT", "ACCPAYCREDIT"];

    // Phase 1: Fetch credit notes sequentially (avoids 429 rate limit hits)
    const creditNotes = [];
    for (const cnType of cnTypes) {
      for (let page = 1; page <= 1000; page++) {
        const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/CreditNotes?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${cnType}" && Status=="AUTHORISED" && RemainingCredit>0${dateFilter}`)}`,
            { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
          );
          return { items: res.data?.CreditNotes || [], dayRemaining: res.rate?.day };
        });
        const items = result?.items || [];
        creditNotes.push(...items);
        if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
        if (items.length < 1000) break;
      }
    }

    // Phase 2: Fetch invoices ONLY for contacts that have credit notes (contact-based = ~5-20 calls vs ~900)
    const invoices = [];
    const cnContactIds = [...new Set(creditNotes.map(cn => cn.Contact?.ContactID).filter(Boolean))];
    if (cnContactIds.length > 0) {
      const invTypes = mode === "sales" ? ["ACCREC"] : mode === "purchase" ? ["ACCPAY"] : ["ACCREC", "ACCPAY"];
      const CONTACT_BATCH = 100;
      for (let ci = 0; ci < cnContactIds.length; ci += CONTACT_BATCH) {
        const contactBatch = cnContactIds.slice(ci, ci + CONTACT_BATCH);
        for (let page = 1; page <= 1000; page++) {
          const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
            const res = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/Invoices?page=${page}&pageSize=1000&ContactIDs=${contactBatch.join(",")}&Statuses=AUTHORISED`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" } }
            );
            return { items: res.data?.Invoices || [], dayRemaining: res.rate?.day };
          });
          // Filter by type and AmountDue in code (can't combine ContactIDs with where clause in Xero API)
          const items = (result?.items || []).filter(inv => invTypes.includes(inv.Type) && Number(inv.AmountDue) > 0);
          invoices.push(...items);
          if (result?.dayRemaining != null) xeroLimitRemaining = parseInt(result.dayRemaining, 10);
          if ((result?.items || []).length < 1000) break;
        }
      }
    }

    const { suggestions, noMatchCredits } = runSmartMatchingEngine(creditNotes, invoices);
    const exactCount = suggestions.filter(s => s.matchType === "exact").length;
    const partialCount = suggestions.filter(s => s.matchType !== "exact").length;
    const totalAmount = suggestions.reduce((sum, s) => sum + s.amount, 0);

    return res.json({
      ok: true,
      totalCreditNotes: creditNotes.length,
      totalInvoices: invoices.length,
      suggestions,
      noMatchCredits,
      stats: { exact: exactCount, partial: partialCount, noMatch: noMatchCredits.length, totalAmount },
    });
  } catch (err) {
    console.error("[Auto Allocation Analyze]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

async function processAutoAllocationJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const CONCURRENCY = 3;
  const today = new Date().toISOString().slice(0, 10);

  // Group suggestions by source — one API call per source (overpayment/credit note)
  const sourceGroups = new Map();
  for (const s of job.suggestions) {
    const sType = s.type || "";
    const sourceKey = sType ? `${sType}|${s.sourceId}` : `cn|${s.creditNoteId}`;
    if (!sourceGroups.has(sourceKey)) sourceGroups.set(sourceKey, []);
    sourceGroups.get(sourceKey).push(s);
  }
  const groups = [...sourceGroups.values()];
  console.log(`[AutoAlloc] ${job.suggestions.length} allocations → ${groups.length} API calls (batched by source)`);

  const chunks = [];
  for (let i = 0; i < groups.length; i += 10) chunks.push(groups.slice(i, i + 10));

  for (const chunk of chunks) {
    const fns = chunk.map(groupItems => async () => {
      const first = groupItems[0];
      const sType = first.type || "";
      const label = first.creditNoteNumber || first.sourceId;
      job.currentItem = `${label} → ${groupItems.length} invoice(s)`;
      job.updatedAt = Date.now();
      try {
        const allocations = groupItems.map(s => ({ invoiceId: s.invoiceId, amount: s.amount }));
        let allocResult;
        if (sType === "spend-prepayment" || sType === "receive-prepayment") {
          allocResult = await createPrepaymentAllocationInXero({
            tenantId: job.tenantId, requestedSessionId: job.sessionId,
            prepaymentId: first.sourceId, allocations, date: today,
          });
        } else if (sType === "spend-overpayment" || sType === "receive-overpayment") {
          allocResult = await createOverpaymentAllocationInXero({
            tenantId: job.tenantId, requestedSessionId: job.sessionId,
            overpaymentId: first.sourceId, allocations, date: today,
          });
        } else {
          allocResult = await createCreditNoteAllocationInXero({
            tenantId: job.tenantId, requestedSessionId: job.sessionId,
            creditNoteId: first.creditNoteId, allocations, date: today,
          });
        }
        if (allocResult?.resolvedSessionId) job.sessionId = allocResult.resolvedSessionId;
        // Count all suggestions in this group as created
        job.created += groupItems.length;
        for (const s of groupItems) {
          job.results.push({
            contactName: s.contactName,
            creditNoteNumber: s.creditNoteNumber,
            invoiceNumber: s.invoiceNumber,
            amount: s.amount,
            currency: s.currency,
            matchType: s.matchType,
            status: "allocated",
            date: today,
            message: `Allocated ${s.currency} ${s.amount} from "${s.creditNoteNumber}" to "${s.invoiceNumber}".`,
          });
        }
      } catch (err) {
        job.errors += groupItems.length;
        for (const s of groupItems) {
          job.results.push({
            contactName: s.contactName,
            creditNoteNumber: s.creditNoteNumber,
            invoiceNumber: s.invoiceNumber,
            amount: s.amount,
            currency: s.currency,
            matchType: s.matchType,
            status: "error",
            date: today,
            message: err.message,
          });
        }
      }
      job.processed += groupItems.length;
      job.updatedAt = Date.now();
    });

    const running = [];
    for (const fn of fns) {
      const p = fn().then(() => running.splice(running.indexOf(p), 1));
      running.push(p);
      if (running.length >= CONCURRENCY) await Promise.race(running);
    }
    await Promise.all(running);
  }

  job.currentItem = "";
  job.status = job.errors > 0 && job.created === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/auto-allocation/execute/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
    if (!suggestions.length) return res.status(400).json({ error: "No allocations selected to execute." });
    if (suggestions.length > 50000) return res.status(400).json({ error: "Maximum 50000 allocations per run." });
    const activeJob = Array.from(autoAllocationJobStore.values()).find(
      j => j.userId === userData.user.id && j.tenantId === tenantId && ["queued", "running"].includes(j.status)
    );
    if (activeJob) return res.status(409).json({ error: "An allocation job is already running for this organisation. Please wait for it to complete.", jobId: activeJob.id });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      status: "queued",
      total: suggestions.length,
      processed: 0,
      created: 0,
      errors: 0,
      currentItem: "",
      suggestions,
      results: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    autoAllocationJobStore.set(job.id, job);
    setTimeout(() => {
      processAutoAllocationJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, total: job.total, status: job.status });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/auto-allocation/execute/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = autoAllocationJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    total: job.total,
    processed: job.processed,
    created: job.created,
    errors: job.errors,
    currentItem: job.currentItem || "",
    results: job.results,
    error: job.error || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.max(0, Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed)))
      : null,
  });
});

// ── Fix Allocation Dates ──────────────────────────────────────────────────────

async function deleteOverpaymentAllocationInXero({ tenantId, requestedSessionId, overpaymentId, allocationId }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Overpayments/${overpaymentId}/Allocations/${allocationId}`, {
      method: "DELETE",
      waitForDailyReset: true,
      headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
    });
    return { ok: true };
  });
}

async function deleteCreditNoteAllocationInXero({ tenantId, requestedSessionId, creditNoteId, allocationId }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    await fetchWithRetry(`https://api.xero.com/api.xro/2.0/CreditNotes/${creditNoteId}/Allocations/${allocationId}`, {
      method: "DELETE",
      waitForDailyReset: true,
      headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
    });
    return { ok: true };
  });
}

async function deletePrepaymentAllocationInXero({ tenantId, requestedSessionId, prepaymentId, allocationId }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Prepayments/${prepaymentId}/Allocations/${allocationId}`, {
      method: "DELETE",
      waitForDailyReset: true,
      headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" },
    });
    return { ok: true };
  });
}

async function deleteInvoicePaymentInXero({ tenantId, requestedSessionId, paymentId }) {
  return runWithCandidateSessions(requestedSessionId, async ({ accessToken }) => {
    await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Payments/${paymentId}`, {
      method: "POST",
      waitForDailyReset: true,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ PaymentID: paymentId, Status: "DELETED" }),
    });
    return { ok: true };
  });
}

async function processFixAllocationDatesJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const CONCURRENCY = 3;

  // Phase 1: Build source reference maps (overpayments + credit notes + prepayments)
  job.phase = "Building source map from Xero…";
  const sourceMap = new Map(); // ref → { id, type: 'overpayment'|'creditnote'|'prepayment' }
  const neededRefs = new Set(job.rows.map(r => String(r.sourceRef || "").trim()).filter(Boolean));

  try {
    // Overpayments
    for (const opType of ["SPEND-OVERPAYMENT", "RECEIVE-OVERPAYMENT"]) {
      for (let page = 1; page <= 500; page++) {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Overpayments?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${opType}"`)}`,
            { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { items: res.data?.Overpayments || [] };
        });
        if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        const items = result?.items || [];
        items.filter(op => op.Reference && neededRefs.has(String(op.Reference).trim()))
             .forEach(op => sourceMap.set(String(op.Reference).trim(), { id: op.OverpaymentID, type: "overpayment" }));
        if (items.length < 1000) break;
      }
    }
    // Prepayments
    for (const ppType of ["SPEND-PREPAYMENT", "RECEIVE-PREPAYMENT"]) {
      for (let page = 1; page <= 500; page++) {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/Prepayments?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${ppType}"`)}`,
            { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { items: res.data?.Prepayments || [] };
        });
        if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        const items = result?.items || [];
        items.filter(pp => pp.Reference && neededRefs.has(String(pp.Reference).trim()))
             .forEach(pp => sourceMap.set(String(pp.Reference).trim(), { id: pp.PrepaymentID, type: "prepayment" }));
        if (items.length < 1000) break;
      }
    }
    // Credit Notes
    for (const cnType of ["ACCPAYCREDIT", "ACCRECCREDIT"]) {
      for (let page = 1; page <= 500; page++) {
        const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          const res = await fetchWithRetry(
            `https://api.xero.com/api.xro/2.0/CreditNotes?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${cnType}"`)}`,
            { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
          );
          return { items: res.data?.CreditNotes || [] };
        });
        if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
        const items = result?.items || [];
        items.filter(cn => cn.CreditNoteNumber && neededRefs.has(String(cn.CreditNoteNumber).trim()))
             .forEach(cn => sourceMap.set(String(cn.CreditNoteNumber).trim(), { id: cn.CreditNoteID, type: "creditnote" }));
        if (sourceMap.size >= neededRefs.size) break;
        if (items.length < 1000) break;
      }
    }
  } catch (err) {
    job.status = "error";
    job.error = "Phase 1 (source lookup) failed: " + err.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    return;
  }

  // Phase 2: Group rows by source
  job.phase = "Fixing dates…";
  const sourceGroups = new Map();
  for (const row of job.rows) {
    const ref = String(row.sourceRef || "").trim();
    const src = sourceMap.get(ref);
    if (!src) {
      job.errors++;
      job.processed++;
      job.results.push({ sourceRef: ref, invoiceRef: row.invoiceRef, amount: row.amount, status: "error", message: "Source not found in Xero" });
      continue;
    }
    if (!sourceGroups.has(ref)) sourceGroups.set(ref, []);
    sourceGroups.get(ref).push({ ...row, sourceId: src.id, sourceType: src.type });
  }

  const groups = [...sourceGroups.entries()];
  const chunks = [];
  for (let i = 0; i < groups.length; i += 10) chunks.push(groups.slice(i, i + 10));

  for (const chunk of chunks) {
    const fns = chunk.map(([sourceRef, rowItems]) => async () => {
      job.currentItem = sourceRef;
      job.updatedAt = Date.now();
      const first = rowItems[0];
      try {
        // GET source to find AllocationIDs
        const detail = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
          let url;
          if (first.sourceType === "overpayment") url = `https://api.xero.com/api.xro/2.0/Overpayments/${first.sourceId}`;
          else if (first.sourceType === "prepayment") url = `https://api.xero.com/api.xro/2.0/Prepayments/${first.sourceId}`;
          else url = `https://api.xero.com/api.xro/2.0/CreditNotes/${first.sourceId}`;
          const res = await fetchWithRetry(url, {
            headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" }
          });
          let item = null;
          if (first.sourceType === "overpayment") item = res.data?.Overpayments?.[0] || null;
          else if (first.sourceType === "prepayment") item = res.data?.Prepayments?.[0] || null;
          else item = res.data?.CreditNotes?.[0] || null;
          return { item };
        });
        if (detail?.resolvedSessionId) job.sessionId = detail.resolvedSessionId;
        const existingAllocs = detail?.item?.Allocations || [];

        // Process each row in this source group
        const successAllocs = []; // collect for batched PUT
        for (const row of rowItems) {
          const invRef = String(row.invoiceRef || "").trim();
          const amt = Number(row.amount);
          // Match allocation by invoice number + amount
          const match = existingAllocs.find(a =>
            String(a.Invoice?.InvoiceNumber || "").trim() === invRef &&
            Math.abs(Number(a.Amount) - amt) < 0.005
          );
          if (!match) {
            job.errors++;
            job.processed++;
            job.results.push({ sourceRef, invoiceRef: invRef, amount: row.amount, correctDate: row.correctDate, status: "error", message: "Allocation not found (may already be fixed)" });
            job.updatedAt = Date.now();
            continue;
          }
          // Skip if date is already correct
          if (match.Date) {
            const existingMs = xeroDateToMs(match.Date);
            if (existingMs) {
              const existingDate = new Date(existingMs).toISOString().slice(0, 10);
              if (existingDate === row.correctDate) {
                job.results.push({ sourceRef, invoiceRef: invRef, amount: row.amount, correctDate: row.correctDate, status: "skipped", message: "Date already correct, skipped" });
                job.processed++;
                job.updatedAt = Date.now();
                continue;
              }
            }
          }
          try {
            // DELETE old allocation
            if (first.sourceType === "overpayment") {
              await deleteOverpaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, overpaymentId: first.sourceId, allocationId: match.AllocationID });
            } else if (first.sourceType === "prepayment") {
              await deletePrepaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, prepaymentId: first.sourceId, allocationId: match.AllocationID });
            } else {
              await deleteCreditNoteAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, creditNoteId: first.sourceId, allocationId: match.AllocationID });
            }
            successAllocs.push({ invoiceId: match.Invoice?.InvoiceID, amount: amt, correctDate: row.correctDate, invoiceRef: invRef });
          } catch (delErr) {
            job.errors++;
            job.processed++;
            job.results.push({ sourceRef, invoiceRef: invRef, amount: row.amount, correctDate: row.correctDate, status: "error", message: "Delete failed: " + delErr.message });
            job.updatedAt = Date.now();
          }
        }

        // PUT new allocations per unique date (batch by correct date)
        const byDate = new Map();
        for (const a of successAllocs) {
          if (!byDate.has(a.correctDate)) byDate.set(a.correctDate, []);
          byDate.get(a.correctDate).push(a);
        }
        for (const [date, allocs] of byDate) {
          try {
            const allocations = allocs.map(a => ({ invoiceId: a.invoiceId, amount: a.amount }));
            if (first.sourceType === "overpayment") {
              await createOverpaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, overpaymentId: first.sourceId, allocations, date });
            } else if (first.sourceType === "prepayment") {
              await createPrepaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, prepaymentId: first.sourceId, allocations, date });
            } else {
              await createCreditNoteAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, creditNoteId: first.sourceId, allocations, date });
            }
            for (const a of allocs) {
              job.created++;
              job.processed++;
              job.results.push({ sourceRef, invoiceRef: a.invoiceRef, amount: a.amount, status: "fixed", message: `Date updated to ${date}` });
              job.updatedAt = Date.now();
            }
          } catch (putErr) {
            for (const a of allocs) {
              job.errors++;
              job.processed++;
              job.results.push({ sourceRef, invoiceRef: a.invoiceRef, amount: a.amount, correctDate: a.correctDate, status: "error", message: "Re-create failed: " + putErr.message });
              job.updatedAt = Date.now();
            }
          }
        }
      } catch (grpErr) {
        for (const row of rowItems) {
          job.errors++;
          job.processed++;
          job.results.push({ sourceRef, invoiceRef: row.invoiceRef, amount: row.amount, correctDate: row.correctDate, status: "error", message: grpErr.message });
          job.updatedAt = Date.now();
        }
      }
    });

    const running = [];
    for (const fn of fns) {
      const p = fn().then(() => running.splice(running.indexOf(p), 1));
      running.push(p);
      if (running.length >= CONCURRENCY) await Promise.race(running);
    }
    await Promise.all(running);
  }

  job.currentItem = "";
  job.phase = "";
  job.status = job.errors > 0 && job.created === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
}

app.post("/api/fix-allocation-dates/start", (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Invalid user session" });
    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    if (!tenantId) return res.status(400).json({ error: "Select a Xero organisation first." });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: "No rows provided." });
    const activeJob = Array.from(fixAllocationDatesJobStore.values()).find(
      j => j.userId === userData.user.id && j.tenantId === tenantId && ["queued", "running"].includes(j.status)
    );
    if (activeJob) return res.status(409).json({ error: "A fix-dates job is already running for this organisation. Please wait for it to complete.", jobId: activeJob.id });

    const job = {
      id: crypto.randomBytes(12).toString("hex"),
      userId: userData.user.id,
      tenantId,
      sessionId: req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null,
      status: "queued",
      phase: "Queued",
      total: rows.length,
      processed: 0,
      created: 0,
      errors: 0,
      currentItem: "",
      rows,
      results: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      error: "",
    };
    fixAllocationDatesJobStore.set(job.id, job);
    setTimeout(() => {
      processFixAllocationDatesJob(job).catch(err => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = Date.now();
        job.updatedAt = Date.now();
      });
    }, 0);
    return res.json({ ok: true, jobId: job.id, total: job.total });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get("/api/fix-allocation-dates/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = fixAllocationDatesJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true, jobId: job.id, status: job.status, phase: job.phase || "",
    total: job.total, processed: job.processed, created: job.created, errors: job.errors,
    currentItem: job.currentItem || "", results: (job.results || []).slice(-200), error: job.error || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.max(0, Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed)))
      : null,
  });
});

// ── Remove Allocations ────────────────────────────────────────────────────────

async function processRemoveAllocationsJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const CONCURRENCY = 5;
  const dateKey = `${job.fromDate || 'all'}-${job.toDate || 'all'}-${job.filterBy || 'cn_date'}-${job.cnNumber || ''}`;
  const CHECKPOINT_FILE = path.join(JOB_CHECKPOINTS_DIR, `remove-allocs-${job.tenantId}-${job.mode}-${dateKey}.json`);

  // Build Xero DateTime() filter strings from ISO dates (YYYY-MM-DD)
  const toXeroDT = (iso) => { const [y,m,d] = iso.split("-"); return `DateTime(${y},${m},${d})`; };
  const dateWhere = (job.fromDate ? `&&Date>=${toXeroDT(job.fromDate)}` : "") + (job.toDate ? `&&Date<=${toXeroDT(job.toDate)}` : "");
  // Parse Xero date — handles both ISO ("2024-03-15") and OData ("/Date(1234567890000+0000)/") formats
  const parseXeroDateMs = (val) => {
    if (!val) return null;
    const odata = /\/Date\((\d+)[+-]\d+\)\//.exec(val);
    if (odata) return parseInt(odata[1], 10);
    const ms = new Date(val).getTime();
    return isNaN(ms) ? null : ms;
  };

  // Delete list: { type, sourceId, allocationId, sourceRef } — built directly from list scan
  let toDelete = [];
  const completedAllocIds = new Set();

  try {
    const mode = job.mode; // 'all' | 'invoices' | 'bills'
    const includeInvoiceSide = mode === "all" || mode === "invoices";
    const includeBillSide    = mode === "all" || mode === "bills";

    // ── Load checkpoint if exists ─────────────────────────────────────────
    let skipToPhase3 = false;
    try {
      if (fs.existsSync(CHECKPOINT_FILE)) {
        const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
        if (cp.tenantId === job.tenantId && cp.mode === job.mode && (cp.fromDate || null) === (job.fromDate || null) && (cp.toDate || null) === (job.toDate || null) && (cp.filterBy || "cn_date") === (job.filterBy || "cn_date") && Array.isArray(cp.toDelete)) {
          toDelete = cp.toDelete;
          (cp.completedAllocIds || []).forEach(id => completedAllocIds.add(id));
          skipToPhase3 = true;
          job.phase = `Resuming — ${toDelete.length - completedAllocIds.size} allocations remaining…`;
          job.updatedAt = Date.now();
        }
      }
    } catch (_) {}

    // ── Phase 1: Scan ─────────────────────────────────────────────────────────
    if (!skipToPhase3 && job.filterBy === "cn_number") {
      // ── Credit Note Number mode: find CN by number, get its allocations directly ──
      const cnNum = (job.cnNumber || "").trim();
      if (!cnNum) throw new Error("Credit note number is required for cn_number mode.");
      job.phase = `Looking up credit note ${cnNum}…`;
      job.updatedAt = Date.now();
      console.log(`[RemoveAllocs] cn_number mode: looking up "${cnNum}"`);
      const cnSearchResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const res = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/CreditNotes?where=${encodeURIComponent(`CreditNoteNumber=="${cnNum}"`)}`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { items: res.data?.CreditNotes || [] };
      });
      if (cnSearchResult?.resolvedSessionId) job.sessionId = cnSearchResult.resolvedSessionId;
      const cnList = cnSearchResult?.items || [];
      if (cnList.length === 0) throw new Error(`Credit note "${cnNum}" not found in Xero.`);
      const cnId = cnList[0].CreditNoteID;
      const cnRef = cnList[0].CreditNoteNumber || cnNum;
      job.phase = `Fetching allocations for ${cnRef}…`;
      job.updatedAt = Date.now();
      const cnDetailResult = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
        const res = await fetchWithRetry(
          `https://api.xero.com/api.xro/2.0/CreditNotes/${cnId}`,
          { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
        );
        return { item: res.data?.CreditNotes?.[0] || null };
      });
      if (cnDetailResult?.resolvedSessionId) job.sessionId = cnDetailResult.resolvedSessionId;
      const cn = cnDetailResult?.item;
      if (!cn) throw new Error(`Could not fetch details for credit note "${cnNum}".`);
      for (const alloc of (cn.Allocations || [])) {
        if (alloc.AllocationID) {
          toDelete.push({ type: "creditnote", sourceId: cnId, allocationId: alloc.AllocationID, sourceRef: cnRef });
        }
      }
      console.log(`[RemoveAllocs] cn_number: found ${toDelete.length} allocations on ${cnRef}`);

    } else if (!skipToPhase3 && (job.filterBy === "invoice_date" || job.filterBy === "paid_date")) {
      const isPaidDateMode = job.filterBy === "paid_date";
      const fromMs = job.fromDate ? new Date(job.fromDate).getTime() : null;
      const toMs   = job.toDate   ? new Date(job.toDate + "T23:59:59").getTime() : null;

      console.log(`[RemoveAllocs] mode=${job.mode} filterBy=${job.filterBy} from=${job.fromDate||'all'} to=${job.toDate||'all'} dryRun=${!!job.dryRun}`);

      const invoiceIds = [];

      if (isPaidDateMode && (job.fromDate || job.toDate)) {
        // Phase 0: Use Payments endpoint — only fetch invoices that had payments in the date range
        // For 1 day this might be 20-100 invoices instead of scanning all 6769
        const pmtDateWhere = (job.fromDate ? `Date>=${toXeroDT(job.fromDate)}` : "") +
                             (job.toDate ? `${job.fromDate ? "&&" : ""}Date<=${toXeroDT(job.toDate)}` : "");
        console.log(`[RemoveAllocs] Phase0 Payments WHERE: ${pmtDateWhere}`);
        const seenInvIds = new Set();
        for (let page = 1; page <= 1000; page++) {
          job.phase = `Scanning payments page ${page}…`;
          job.updatedAt = Date.now();
          const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const res = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/Payments?page=${page}&pageSize=1000&where=${encodeURIComponent(pmtDateWhere)}`,
              { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
            );
            return { items: res.data?.Payments || [] };
          });
          if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
          const pmts = result?.items || [];
          for (const pmt of pmts) {
            const invId = pmt.Invoice?.InvoiceID;
            const invType = pmt.Invoice?.Type;
            if (!invId || seenInvIds.has(invId)) continue;
            if (invType === "ACCREC" && !includeInvoiceSide) continue;
            if (invType === "ACCPAY" && !includeBillSide) continue;
            seenInvIds.add(invId);
            invoiceIds.push({ id: invId, ref: pmt.Invoice?.InvoiceNumber || invId });
          }
          console.log(`[RemoveAllocs] Phase0 page ${page}: ${pmts.length} payments, ${seenInvIds.size} unique invoices so far`);
          if (pmts.length < 1000) break;
        }
        console.log(`[RemoveAllocs] Phase0 DONE — ${invoiceIds.length} unique invoices had payments in date range`);

      } else {
        // invoice_date mode OR paid_date with no date filter: scan invoices with WHERE clause
        const invTypes = [];
        if (includeInvoiceSide) invTypes.push("ACCREC");
        if (includeBillSide)    invTypes.push("ACCPAY");
        const invDateWhere = isPaidDateMode ? "" :
          (job.fromDate ? `&&Date>=${toXeroDT(job.fromDate)}` : "") + (job.toDate ? `&&Date<=${toXeroDT(job.toDate)}` : "");
        const statuses = isPaidDateMode ? ["PAID"] : ["PAID", "AUTHORISED"];
        for (const invType of invTypes) {
          for (const invStatus of statuses) {
            const extraFilter = invStatus === "AUTHORISED" ? `&&AmountPaid>0.0` : "";
            const whereClause = `Type=="${invType}"&&Status=="${invStatus}"${extraFilter}${invDateWhere}`;
            console.log(`[RemoveAllocs] Phase1 LIST: ${invType} ${invStatus} where="${whereClause}"`);
            let pageTotal = 0;
            for (let page = 1; page <= 1000; page++) {
              job.phase = `Scanning ${invType === "ACCREC" ? "invoices" : "bills"} (${invStatus}) page ${page}…`;
              job.updatedAt = Date.now();
              const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
                const res = await fetchWithRetry(
                  `https://api.xero.com/api.xro/2.0/Invoices?page=${page}&pageSize=1000&where=${encodeURIComponent(whereClause)}`,
                  { headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
                );
                return { items: res.data?.Invoices || [] };
              });
              if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
              const list = result?.items || [];
              pageTotal += list.length;
              for (const inv of list) {
                invoiceIds.push({ id: inv.InvoiceID, ref: inv.InvoiceNumber || inv.InvoiceID, amountCredited: inv.AmountCredited || 0 });
              }
              console.log(`[RemoveAllocs] Page ${page}: got ${list.length}, running total: ${invoiceIds.length}`);
              if (list.length < 1000) break;
            }
            console.log(`[RemoveAllocs] ${invType} ${invStatus}: ${pageTotal} fetched`);
          }
        }
      }

      // For no-date fallback: filter to invoices with credit notes applied
      const invoicesForPhase2 = (isPaidDateMode && (job.fromDate || job.toDate))
        ? invoiceIds
        : invoiceIds.filter(inv => (inv.amountCredited || 0) > 0);
      console.log(`[RemoveAllocs] ${invoiceIds.length} candidates → ${invoicesForPhase2.length} for Phase2 individual GETs`);

      if (invoicesForPhase2.length > 0) {
        const totalInvs = invoicesForPhase2.length;
        job.phase = `Found ${totalInvs} invoice${totalInvs !== 1 ? "s" : ""} with credit notes — fetching details…`;
        job.total = totalInvs;
        job.processed = 0;
        job.updatedAt = Date.now();

        const phase2Fns = invoicesForPhase2.map((inv, idx) => async () => {
          try {
            const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/Invoices/${inv.id}`,
                { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
              );
              return { item: res.data?.Invoices?.[0] || null };
            });
            if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
            const full = result?.item;
            if (!full) return;
            if (isPaidDateMode && (fromMs || toMs)) {
              const paidMs = parseXeroDateMs(full.FullyPaidOnDate);
              if (!paidMs || (fromMs && paidMs < fromMs) || (toMs && paidMs > toMs)) return;
            }
            const ref = inv.ref;
            if (idx === 0) console.log(`[RemoveAllocs] Phase2 sample: inv=${full.InvoiceNumber} FullyPaidOnDate="${full.FullyPaidOnDate}" CreditNotes=${(full.CreditNotes||[]).length}`);
            for (const cn of (full.CreditNotes || [])) {
              if (cn.AllocationID) toDelete.push({ type: "creditnote", sourceId: cn.CreditNoteID, allocationId: cn.AllocationID, sourceRef: ref });
            }
            for (const op of (full.Overpayments || [])) {
              if (op.AllocationID) toDelete.push({ type: "overpayment", sourceId: op.OverpaymentID, allocationId: op.AllocationID, sourceRef: ref });
            }
            for (const pp of (full.Prepayments || [])) {
              if (pp.AllocationID) toDelete.push({ type: "prepayment", sourceId: pp.PrepaymentID, allocationId: pp.AllocationID, sourceRef: ref });
            }
          } catch (err) {
            console.log(`[RemoveAllocs] Phase2 inv ${inv.ref} ERROR: ${err.message}`);
          }
          job.processed++;
          if (job.processed % 50 === 0 || job.processed === totalInvs)
            console.log(`[RemoveAllocs] Phase2 progress: ${job.processed}/${totalInvs}, allocs found: ${toDelete.length}`);
          job.phase = `Fetching invoice ${job.processed}/${totalInvs}… (${toDelete.length} allocations found)`;
          job.updatedAt = Date.now();
        });

        const p2Running = [];
        for (const fn of phase2Fns) {
          const p = fn().then(() => p2Running.splice(p2Running.indexOf(p), 1));
          p2Running.push(p);
          if (p2Running.length >= 5) await Promise.race(p2Running);
        }
        await Promise.all(p2Running);
        console.log(`[RemoveAllocs] Phase2 DONE — total allocations found: ${toDelete.length}`);
      }

      if (!job.dryRun) {
        try {
          fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ tenantId: job.tenantId, mode: job.mode, fromDate: job.fromDate || null, toDate: job.toDate || null, filterBy: job.filterBy, toDelete, completedAllocIds: [], savedAt: Date.now() }));
        } catch (_) {}
      }

    } else if (!skipToPhase3) {
      // Phase 1a: Credit notes
      if (includeInvoiceSide || includeBillSide) {
        job.phase = "Scanning credit notes…";
        job.updatedAt = Date.now();
        const cnTypes = [];
        if (includeInvoiceSide) cnTypes.push("ACCRECCREDIT");
        if (includeBillSide)    cnTypes.push("ACCPAYCREDIT");
        for (const cnType of cnTypes) {
          for (const cnStatus of ["AUTHORISED", "PAID"]) {
            const whereClause = `Type=="${cnType}"&&Status=="${cnStatus}"${dateWhere}`;
            console.log(`[RemoveAllocs] CN scan: ${cnType} ${cnStatus} where="${whereClause}"`);
            for (let page = 1; page <= 500; page++) {
              job.phase = `Scanning credit notes page ${page}… (${toDelete.length} allocations found)`;
              job.updatedAt = Date.now();
              const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
                const res = await fetchWithRetry(
                  `https://api.xero.com/api.xro/2.0/CreditNotes?page=${page}&pageSize=1000&where=${encodeURIComponent(whereClause)}`,
                  { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
                );
                return { items: res.data?.CreditNotes || [] };
              });
              if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
              const list = result?.items || [];
              if (page === 1) console.log(`[RemoveAllocs] CN page1: ${list.length} credit notes, sample Allocations=${JSON.stringify(list[0]?.Allocations?.slice(0,1)||[])}`);
              for (const cn of list) {
                for (const alloc of (cn.Allocations || [])) {
                  if (alloc.AllocationID) {
                    toDelete.push({ type: "creditnote", sourceId: cn.CreditNoteID, allocationId: alloc.AllocationID, sourceRef: cn.CreditNoteNumber || cn.CreditNoteID });
                  }
                }
              }
              console.log(`[RemoveAllocs] CN page ${page}: ${list.length} CNs, allocations so far: ${toDelete.length}`);
              if (list.length < 1000) break;
            }
          }
        }
      }

      // Phase 1b: Overpayments
      if (includeInvoiceSide || includeBillSide) {
        job.phase = "Scanning overpayments…";
        job.updatedAt = Date.now();
        const opTypes = [];
        if (includeInvoiceSide) opTypes.push("RECEIVE-OVERPAYMENT");
        if (includeBillSide)    opTypes.push("SPEND-OVERPAYMENT");
        for (const opType of opTypes) {
          for (let page = 1; page <= 500; page++) {
            const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/Overpayments?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${opType}"${dateWhere}`)}`,
                { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
              );
              return { items: res.data?.Overpayments || [] };
            });
            if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
            const list = result?.items || [];
            for (const op of list) {
              for (const alloc of (op.Allocations || [])) {
                if (alloc.AllocationID) {
                  toDelete.push({ type: "overpayment", sourceId: op.OverpaymentID, allocationId: alloc.AllocationID, sourceRef: op.Reference || op.OverpaymentID });
                }
              }
            }
            if (list.length < 1000) break;
          }
        }
      }

      // Phase 1c: Prepayments
      if (includeInvoiceSide || includeBillSide) {
        job.phase = "Scanning prepayments…";
        job.updatedAt = Date.now();
        const ppTypes = [];
        if (includeInvoiceSide) ppTypes.push("RECEIVE-PREPAYMENT");
        if (includeBillSide)    ppTypes.push("SPEND-PREPAYMENT");
        for (const ppType of ppTypes) {
          for (let page = 1; page <= 500; page++) {
            const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
              const res = await fetchWithRetry(
                `https://api.xero.com/api.xro/2.0/Prepayments?page=${page}&pageSize=1000&where=${encodeURIComponent(`Type=="${ppType}"${dateWhere}`)}`,
                { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
              );
              return { items: res.data?.Prepayments || [] };
            });
            if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
            const list = result?.items || [];
            for (const pp of list) {
              for (const alloc of (pp.Allocations || [])) {
                if (alloc.AllocationID) {
                  toDelete.push({ type: "prepayment", sourceId: pp.PrepaymentID, allocationId: alloc.AllocationID, sourceRef: pp.Reference || pp.PrepaymentID });
                }
              }
            }
            if (list.length < 1000) break;
          }
        }
      }

      // Dedup: remove duplicate allocationIds before saving/deleting
      const seenAllocIds = new Set();
      toDelete = toDelete.filter(item => {
        if (seenAllocIds.has(item.allocationId)) return false;
        seenAllocIds.add(item.allocationId);
        return true;
      });

      // Save checkpoint so confirm/restart skips re-scan (skip for dryRun)
      if (!job.dryRun) {
        try {
          fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ tenantId: job.tenantId, mode: job.mode, filterBy: job.filterBy || "cn_date", fromDate: job.fromDate || null, toDate: job.toDate || null, toDelete, completedAllocIds: [], savedAt: Date.now() }));
        } catch (_) {}
      }
    }

    // ── dryRun: scan only — return count to UI for user confirmation ──────
    if (job.dryRun) {
      const cnCount = toDelete.filter(x => x.type === "creditnote").length;
      const opCount = toDelete.filter(x => x.type === "overpayment").length;
      const ppCount = toDelete.filter(x => x.type === "prepayment").length;
      job.status = "scan_complete";
      job.phase = "";
      job.scanCount = toDelete.length;
      job.scanBreakdown = { creditNotes: cnCount, overpayments: opCount, prepayments: ppCount };
      job.finishedAt = Date.now();
      job.updatedAt = Date.now();
      return;
    }

    job.total = toDelete.length;
    job.processed = completedAllocIds.size;
    job.deleted = completedAllocIds.size;
    job.updatedAt = Date.now();

    if (toDelete.length === 0) {
      job.phase = "";
      job.status = "completed";
      job.finishedAt = Date.now();
      job.updatedAt = Date.now();
      try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
      return;
    }

    const remaining = toDelete.filter(item => !completedAllocIds.has(item.allocationId));
    job.phase = `Deleting ${remaining.length} allocation${remaining.length !== 1 ? "s" : ""}…`;
    job.updatedAt = Date.now();

    let cpDirty = false;
    const saveAllocCheckpoint = () => {
      if (!cpDirty) return;
      try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ tenantId: job.tenantId, mode: job.mode, toDelete, completedAllocIds: [...completedAllocIds], savedAt: Date.now() }));
        cpDirty = false;
      } catch (_) {}
    };

    // ── Phase 3: Delete with concurrency ──────────────────────────────────
    const fns = remaining.map(item => async () => {
      try {
        job.currentItem = item.sourceRef;
        if (item.type === "creditnote") {
          await deleteCreditNoteAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, creditNoteId: item.sourceId, allocationId: item.allocationId });
        } else if (item.type === "overpayment") {
          await deleteOverpaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, overpaymentId: item.sourceId, allocationId: item.allocationId });
        } else {
          await deletePrepaymentAllocationInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, prepaymentId: item.sourceId, allocationId: item.allocationId });
        }
        job.deleted++;
        job.processed++;
        completedAllocIds.add(item.allocationId);
        cpDirty = true;
        job.results.push({ type: item.type, sourceRef: item.sourceRef, allocationId: item.allocationId, status: "deleted" });
      } catch (err) {
        job.errors++;
        job.processed++;
        job.results.push({ type: item.type, sourceRef: item.sourceRef, allocationId: item.allocationId, status: "error", message: err.message });
      }
      job.updatedAt = Date.now();
      if (job.processed % 50 === 0) saveAllocCheckpoint();
    });

    const running = [];
    for (const fn of fns) {
      const p = fn().then(() => running.splice(running.indexOf(p), 1));
      running.push(p);
      if (running.length >= CONCURRENCY) await Promise.race(running);
    }
    await Promise.all(running);
    saveAllocCheckpoint();

  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    return;
  }

  job.currentItem = "";
  job.phase = "";
  job.status = job.errors > 0 && job.deleted === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  if (job.status === "completed") {
    try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
  }
}

app.post("/api/remove-allocations/start", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const { tenantId, sessionId, mode = "all", fromDate, toDate, filterBy = "cn_date" } = req.body || {};
  if (!tenantId || !sessionId) return res.status(400).json({ error: "tenantId and sessionId required" });
  const validModes = ["all", "invoices", "bills"];
  if (!validModes.includes(mode)) return res.status(400).json({ error: "Invalid mode. Use: all, invoices, bills" });

  const jobId = crypto.randomBytes(12).toString("hex");
  const job = {
    id: jobId,
    userId: userData.user.id,
    tenantId,
    sessionId,
    mode,
    fromDate: fromDate || null,
    toDate: toDate || null,
    filterBy: filterBy || "cn_date",
    status: "queued",
    phase: "Starting…",
    total: 0,
    processed: 0,
    deleted: 0,
    errors: 0,
    results: [],
    currentItem: "",
    error: "",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    updatedAt: Date.now(),
  };
  removeAllocationsJobStore.set(jobId, job);
  processRemoveAllocationsJob(job).catch(err => {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  });
  return res.json({ ok: true, jobId });
});

app.get("/api/remove-allocations/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = removeAllocationsJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true, jobId: job.id, status: job.status, phase: job.phase || "",
    total: job.total, processed: job.processed, deleted: job.deleted, errors: job.errors,
    currentItem: job.currentItem || "", results: (job.results || []).slice(-200), error: job.error || "",
    scanCount: job.scanCount ?? null, scanBreakdown: job.scanBreakdown ?? null,
    etaMs: job.startedAt && job.processed > 0
      ? Math.max(0, Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed)))
      : null,
  });
});

app.post("/api/remove-allocations/scan", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const { tenantId, sessionId, mode = "all", fromDate, toDate, filterBy = "cn_date" } = req.body || {};
  if (!tenantId || !sessionId) return res.status(400).json({ error: "tenantId and sessionId required" });
  const validModes = ["all", "invoices", "bills"];
  if (!validModes.includes(mode)) return res.status(400).json({ error: "Invalid mode" });

  const jobId = crypto.randomBytes(12).toString("hex");
  const job = {
    id: jobId, userId: userData.user.id, tenantId, sessionId, mode,
    fromDate: fromDate || null, toDate: toDate || null, filterBy: filterBy || "cn_date",
    dryRun: true,
    status: "queued", phase: "Starting scan…",
    total: 0, processed: 0, deleted: 0, errors: 0,
    results: [], currentItem: "", error: "",
    scanCount: null, scanBreakdown: null,
    createdAt: Date.now(), startedAt: null, finishedAt: null, updatedAt: Date.now(),
  };
  removeAllocationsJobStore.set(jobId, job);
  processRemoveAllocationsJob(job).catch(err => {
    job.status = "error"; job.error = err.message; job.finishedAt = Date.now(); job.updatedAt = Date.now();
  });
  return res.json({ ok: true, jobId });
});

// ── Remove Invoice Payments ───────────────────────────────────────────────────

async function processRemoveInvoicePaymentsJob(job) {
  job.status = "running";
  job.startedAt = Date.now();
  job.updatedAt = Date.now();
  const CONCURRENCY = 10;
  const CHECKPOINT_FILE = path.join(JOB_CHECKPOINTS_DIR, `remove-inv-payments-${job.tenantId}.json`);

  let toDelete = []; // { paymentId, invoiceNumber, paymentType }
  const completedIds = new Set();

  try {
    // ── Load checkpoint if exists (resume after daily limit / server restart) ──
    let fromCheckpoint = false;
    try {
      if (fs.existsSync(CHECKPOINT_FILE)) {
        const cp = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
        if (cp.tenantId === job.tenantId && Array.isArray(cp.payments) && cp.payments.length > 0) {
          toDelete = cp.payments;
          (cp.completedIds || []).forEach(id => completedIds.add(id));
          fromCheckpoint = true;
          job.phase = `Resuming from checkpoint — ${toDelete.length - completedIds.size} remaining…`;
          job.updatedAt = Date.now();
        }
      }
    } catch (_) {}

    // ── Phase 1: Scan payments (skip if resuming from checkpoint) ──────────
    if (!fromCheckpoint) {
      const paymentTypes = ["ACCRECPAYMENT", "ARCREDITPAYMENT", "AROVERPAYMENTPAYMENT", "ARPREPAYMENTPAYMENT"];

      for (const pmtType of paymentTypes) {
        job.phase = `Scanning ${pmtType} payments…`;
        job.updatedAt = Date.now();

        for (let page = 1; page <= 500; page++) {
          const result = await runWithCandidateSessions(job.sessionId, async ({ accessToken }) => {
            const res = await fetchWithRetry(
              `https://api.xero.com/api.xro/2.0/Payments?page=${page}&pageSize=1000&where=${encodeURIComponent(`PaymentType=="${pmtType}"&&Status=="AUTHORISED"`)}`,
              { waitForDailyReset: true, headers: { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": job.tenantId, Accept: "application/json" } }
            );
            return { items: res.data?.Payments || [] };
          });
          if (result?.resolvedSessionId) job.sessionId = result.resolvedSessionId;
          const list = result?.items || [];
          for (const pmt of list) {
            if (pmt.PaymentID) {
              toDelete.push({
                paymentId: pmt.PaymentID,
                invoiceNumber: pmt.Invoice?.InvoiceNumber || pmt.Invoice?.InvoiceID || pmt.PaymentID,
                paymentType: pmtType,
              });
            }
          }
          if (list.length < 1000) break;
        }
      }

      // Save checkpoint after scan so restart skips re-scan
      try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ tenantId: job.tenantId, payments: toDelete, completedIds: [], savedAt: Date.now() }));
      } catch (_) {}
    }

    job.total = toDelete.length;
    job.processed = completedIds.size;
    job.deleted = completedIds.size;
    job.updatedAt = Date.now();

    if (toDelete.length === 0) {
      job.phase = "";
      job.status = "completed";
      job.finishedAt = Date.now();
      job.updatedAt = Date.now();
      try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
      return;
    }

    const remaining = toDelete.filter(item => !completedIds.has(item.paymentId));
    job.phase = `Found ${toDelete.length} payment${toDelete.length !== 1 ? "s" : ""} — deleting ${remaining.length} remaining…`;
    job.updatedAt = Date.now();

    // ── Phase 2: Delete with concurrency ─────────────────────────────────
    let checkpointDirty = false;
    const saveCheckpoint = () => {
      if (!checkpointDirty) return;
      try {
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({ tenantId: job.tenantId, payments: toDelete, completedIds: [...completedIds], savedAt: Date.now() }));
        checkpointDirty = false;
      } catch (_) {}
    };

    const fns = remaining.map(item => async () => {
      try {
        job.currentItem = item.invoiceNumber;
        await deleteInvoicePaymentInXero({ tenantId: job.tenantId, requestedSessionId: job.sessionId, paymentId: item.paymentId });
        job.deleted++;
        job.processed++;
        completedIds.add(item.paymentId);
        checkpointDirty = true;
        job.results.push({ invoiceNumber: item.invoiceNumber, paymentId: item.paymentId, paymentType: item.paymentType, status: "deleted" });
      } catch (err) {
        job.errors++;
        job.processed++;
        const msg = err.message || "";
        const reason = msg.includes("reconcil") ? "reconciled" : msg.includes("locked") ? "locked_period" : "error";
        job.results.push({ invoiceNumber: item.invoiceNumber, paymentId: item.paymentId, paymentType: item.paymentType, status: reason, message: msg.slice(0, 200) });
      }
      job.updatedAt = Date.now();
      // Save checkpoint every 50 completions
      if (job.processed % 50 === 0) saveCheckpoint();
    });

    const running = [];
    for (const fn of fns) {
      const p = fn().then(() => running.splice(running.indexOf(p), 1));
      running.push(p);
      if (running.length >= CONCURRENCY) await Promise.race(running);
    }
    await Promise.all(running);
    saveCheckpoint();

  } catch (err) {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
    return;
  }

  job.currentItem = "";
  job.phase = "";
  job.status = job.errors > 0 && job.deleted === 0 ? "error" : job.errors > 0 ? "completed_with_errors" : "completed";
  job.finishedAt = Date.now();
  job.updatedAt = Date.now();
  // Clean up checkpoint on full completion
  if (job.status === "completed") {
    try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
  }
}

app.post("/api/remove-invoice-payments/start", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const { tenantId, sessionId } = req.body || {};
  if (!tenantId || !sessionId) return res.status(400).json({ error: "tenantId and sessionId required" });

  const jobId = crypto.randomBytes(12).toString("hex");
  const job = {
    id: jobId,
    userId: userData.user.id,
    tenantId,
    sessionId,
    status: "queued",
    phase: "Starting…",
    total: 0,
    processed: 0,
    deleted: 0,
    errors: 0,
    results: [],
    currentItem: "",
    error: "",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    updatedAt: Date.now(),
  };
  removeInvoicePaymentsJobStore.set(jobId, job);
  processRemoveInvoicePaymentsJob(job).catch(err => {
    job.status = "error";
    job.error = err.message;
    job.finishedAt = Date.now();
    job.updatedAt = Date.now();
  });
  return res.json({ ok: true, jobId });
});

app.get("/api/remove-invoice-payments/status", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const jobId = String(req.query.jobId || "").trim();
  const job = removeInvoicePaymentsJobStore.get(jobId);
  if (!job || job.userId !== userData.user.id) return res.status(404).json({ error: "Job not found" });
  return res.json({
    ok: true, jobId: job.id, status: job.status, phase: job.phase || "",
    total: job.total, processed: job.processed, deleted: job.deleted, errors: job.errors,
    currentItem: job.currentItem || "", results: (job.results || []).slice(-200), error: job.error || "",
    etaMs: job.startedAt && job.processed > 0
      ? Math.max(0, Math.round(((Date.now() - job.startedAt) / job.processed) * (job.total - job.processed)))
      : null,
  });
});

// ── Generic import cancel ─────────────────────────────────────────────────────
// Purge all import/delete job stores every 2 hours — prevent unbounded memory growth
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  const allImportStores = [
    bulkDeleteJobStore, bulkVoidJobStore, quoteDeleteJobStore, poDeleteJobStore,
    spendReceiveDeleteJobStore, bankTransferDeleteJobStore, contactArchiveJobStore,
    accountsImportJobStore, billsImportJobStore, invoicesImportJobStore,
    creditNotesImportJobStore, overpaymentImportJobStore, overpaymentAllocationJobStore,
    creditNoteAllocationJobStore, spendMoneyImportJobStore, receiveMoneyImportJobStore,
    itemsImportJobStore, customersImportJobStore, vendorsImportJobStore,
    trackingCategoryImportJobStore, billPaymentImportJobStore, invoicePaymentImportJobStore,
    creditNoteRefundImportJobStore, manualJournalImportJobStore, journalFixJobStore,
    undoJobStore, opDupVoidJobStore, exchangeRateUpdateJobStore, bankTransferImportJobStore,
    purchaseOrdersImportJobStore, quotesImportJobStore, updateStatusJobStore,
  ];
  for (const store of allImportStores) {
    for (const [id, job] of store) {
      const done = ["completed", "completed_with_errors", "error", "cancelled"].includes(job.status);
      if (done && job.finishedAt && job.finishedAt < cutoff) {
        // Free large row arrays before deleting
        if (job.rows) job.rows = [];
        if (job.results) job.results = [];
        store.delete(id);
      }
    }
  }
}, 30 * 60 * 1000);

const IMPORT_JOB_STORE_MAP = new Map([
  ["accounts", accountsImportJobStore],
  ["bills", billsImportJobStore],
  ["invoices", invoicesImportJobStore],
  ["credit-notes", creditNotesImportJobStore],
  ["spend-op", overpaymentImportJobStore],
  ["cn-alloc", creditNoteAllocationJobStore],
  ["dn-alloc", overpaymentAllocationJobStore],
  ["update-status", updateStatusJobStore],
  ["bank-transfers", bankTransferImportJobStore],
  ["exchange-rate-update", exchangeRateUpdateJobStore],
  ["items", itemsImportJobStore],
  ["customers", customersImportJobStore],
  ["vendors", vendorsImportJobStore],
  ["tracking-categories", trackingCategoryImportJobStore],
  ["bill-payments", billPaymentImportJobStore],
  ["invoice-payments", invoicePaymentImportJobStore],
  ["credit-note-refunds", creditNoteRefundImportJobStore],
  ["manual-journals", manualJournalImportJobStore],
  ["spend-money", spendMoneyImportJobStore],
  ["receive-money", receiveMoneyImportJobStore],
  ["purchase-orders", purchaseOrdersImportJobStore],
  ["quotes", quotesImportJobStore],
]);

app.post("/api/import/cancel", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const { jobId, type } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  // Search all stores if no type given, or the specific store if type given
  const storesToSearch = type ? [IMPORT_JOB_STORE_MAP.get(type)].filter(Boolean) : [...IMPORT_JOB_STORE_MAP.values()];
  let found = null;
  for (const store of storesToSearch) {
    const job = store.get(jobId);
    if (job) { found = job; break; }
  }
  if (!found) return res.status(404).json({ error: "Job not found" });
  if (found.userId && found.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
  if (found.status === "completed" || found.status === "completed_with_errors" || found.status === "cancelled" || found.status === "error") {
    return res.json({ ok: true, status: found.status, message: "Job already finished" });
  }
  found.cancelRequested = true;
  found.updatedAt = Date.now();
  return res.json({ ok: true, status: "cancelling" });
});

// ── Xero Pre-Validation ───────────────────────────────────────────────────────
// Checks whether contact names and/or account codes from a CSV actually exist
// in the connected Xero org before the user starts a large import.
// Accepts up to 50 unique contact names + 50 unique account codes.
// Returns { contacts: { found, missing }, accounts: { found, missing } }
app.post("/api/xero/prevalidate", async (req, res) => {
  try {
    const userData = getUserFromToken(req.header("x-user-token"));
    if (!userData) return res.status(401).json({ error: "Not logged in" });

    const tenantId = String(req.body?.tenantId || req.header("x-tenant-id") || "").trim();
    const sessionId = req.header("x-session-id") || req.body?.sessionId || latestSession?.sessionId || null;
    if (!tenantId) return res.status(400).json({ error: "tenantId is required" });

    const contactNames = (Array.isArray(req.body?.contactNames) ? req.body.contactNames : [])
      .map(n => String(n || "").trim()).filter(Boolean).slice(0, 50);
    const accountCodes = (Array.isArray(req.body?.accountCodes) ? req.body.accountCodes : [])
      .map(c => String(c || "").trim()).filter(Boolean).slice(0, 50);

    if (!contactNames.length && !accountCodes.length) {
      return res.status(400).json({ error: "Provide at least one contactNames or accountCodes to validate." });
    }

    const result = await runWithCandidateSessions(sessionId, async ({ accessToken }) => {
      const headers = { Authorization: `Bearer ${accessToken}`, "xero-tenant-id": tenantId, Accept: "application/json" };

      const contactResult = { found: [], missing: [] };
      const accountResult = { found: [], missing: [] };

      // ── Contacts ────────────────────────────────────────────────────────────
      if (contactNames.length) {
        // Build a WHERE clause: Name=="A" OR Name=="B" ... (Xero supports compound OR)
        const whereClause = contactNames.map(n => `Name=="${n.replace(/"/g, '\\"')}"`).join(" OR ");
        const url = `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(whereClause)}&summaryOnly=true`;
        let xeroContacts = [];
        try {
          const r = await fetchWithRetry(url, { method: "GET", headers, feature: "Pre-Validation" });
          xeroContacts = r.data?.Contacts || [];
        } catch (err) {
          // If WHERE clause is too long/complex, fall back to individual lookups
          for (const name of contactNames) {
            try {
              const r2 = await fetchWithRetry(`https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name=="${name.replace(/"/g, '\\"')}"`)}&summaryOnly=true`, { method: "GET", headers, feature: "Pre-Validation" });
              xeroContacts.push(...(r2.data?.Contacts || []));
            } catch (_) {}
          }
        }
        const foundNames = new Set(xeroContacts.map(c => String(c.Name || "").toLowerCase()));
        for (const name of contactNames) {
          if (foundNames.has(name.toLowerCase())) contactResult.found.push(name);
          else contactResult.missing.push(name);
        }
      }

      // ── Account codes ───────────────────────────────────────────────────────
      if (accountCodes.length) {
        let accounts = [];
        try {
          const r = await fetchWithRetry("https://api.xero.com/api.xro/2.0/Accounts", { method: "GET", headers, feature: "Pre-Validation" });
          accounts = r.data?.Accounts || [];
        } catch (_) {}
        const foundCodes = new Set(accounts.map(a => String(a.Code || "").toLowerCase()));
        for (const code of accountCodes) {
          if (foundCodes.has(code.toLowerCase())) accountResult.found.push(code);
          else accountResult.missing.push(code);
        }
      }

      return { contacts: contactResult, accounts: accountResult };
    });

    return res.json(result.result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Import checkpoints (resume) ───────────────────────────────────────────────
// Returns all persisted job checkpoints visible to the current user.
// Admin sees all; regular users see only their own interrupted jobs.
app.get("/api/import/checkpoints", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const isAdmin = isAdminEmail(userData.user.email);
  const checkpoints = loadJobCheckpoints().filter(cp => {
    if (isAdmin) return true;
    return cp.userId === userData.user.id;
  });
  // Sort newest first
  checkpoints.sort((a, b) => (b.created || 0) - (a.created || 0));
  return res.json({ checkpoints });
});

// Delete (dismiss) a single checkpoint
app.delete("/api/import/checkpoints/:jobId", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Not logged in" });
  const isAdmin = isAdminEmail(userData.user.email);
  const { jobId } = req.params;
  const filePath = path.join(JOB_CHECKPOINTS_DIR, `${jobId}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Checkpoint not found" });
  try {
    const cp = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isAdmin && cp.userId !== userData.user.id) return res.status(403).json({ error: "Forbidden" });
    fs.unlinkSync(filePath);
    return res.json({ ok: true });
  } catch (_) {
    return res.status(500).json({ error: "Failed to delete checkpoint" });
  }
});

// ── Free Account Signup (No Plan — user picks plan inside app) ────────────────

app.post("/api/user/signup-free", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });
    const normalized = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return res.status(400).json({ error: "Invalid email address." });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    if (userStore.has(normalized)) return res.status(409).json({ error: "An account with this email already exists. Try logging in." });
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = hashPassword(password, salt);
    const newUser = {
      id: crypto.randomUUID(),
      email: normalized,
      hash,
      salt,
      plan: "none",
      planStatus: "active",
      role: "importer",
      permissions: ["import"],
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    userStore.set(normalized, newUser);
    saveUsers();
    const token = createUserSession(newUser);
    recordAuditLog("system", "signup-free", normalized, "plan=none");
    sendWelcomeEmail(normalized, "importer").catch(() => {});
    return res.json({
      token,
      user: { id: newUser.id, email: newUser.email, isAdmin: false, role: "importer", permissions: ["import"], planStatus: "active", plan: "none", testingRowsUsed: 0, pendingApprovalNotification: false },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Request testing plan from within the app (authenticated)
app.post("/api/user/request-testing", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid session" });
  const user = userData.user;
  if (user.plan === "testing" && user.planStatus === "pending") return res.status(400).json({ error: "Testing plan request already pending." });
  if (user.plan === "testing" && user.planStatus === "active") return res.status(400).json({ error: "Testing plan already active." });
  user.plan = "testing";
  user.planStatus = "pending";
  user.testingRowsUsed = 0;
  userStore.set(user.email, user);
  saveUsers();
  recordAuditLog("system", "request-testing", user.email, "planStatus=pending");
  return res.json({ ok: true });
});

// Request team member access from within the app (authenticated)
app.post("/api/user/request-team", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid session" });
  const user = userData.user;
  if (user.plan === "team" && user.planStatus === "pending") return res.status(400).json({ error: "Team access request already pending." });
  if (user.plan === "team" && user.planStatus === "active") return res.status(400).json({ error: "Team access already active." });
  user.plan = "team";
  user.role = "team";
  user.planStatus = "pending";
  userStore.set(user.email, user);
  saveUsers();
  recordAuditLog("system", "request-team", user.email, "planStatus=pending");
  return res.json({ ok: true });
});

// POST /api/user/forgot-password — generate temp password and email it
app.post("/api/user/forgot-password", async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: "Email is required." });
  const normalized = String(email).trim().toLowerCase();
  const user = userStore.get(normalized);
  if (!user) {
    // Don't reveal if account exists — return success regardless
    return res.json({ ok: true });
  }
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const tempPassword = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const salt = crypto.randomBytes(16).toString("hex");
  user.hash = hashPassword(tempPassword, salt);
  user.salt = salt;
  userStore.set(normalized, user);
  saveUsers();
  recordAuditLog("system", "forgot-password", normalized, "temp password issued");
  await sendForgotPasswordEmail(normalized, tempPassword);
  return res.json({ ok: true });
});

// Dismiss approval notification
app.post("/api/user/dismiss-notification", (req, res) => {
  const token = req.header("x-user-token");
  const userData = getUserFromToken(token);
  if (!userData) return res.status(401).json({ error: "Invalid session" });
  userData.user.pendingApprovalNotification = false;
  userStore.set(userData.user.email, userData.user);
  saveUsers();
  return res.json({ ok: true });
});

// ── Public Signup + Payment Route ─────────────────────────────────────────────

// POST /api/razorpay/create-signup-order — no auth, for new user signup flow
app.post("/api/razorpay/create-signup-order", async (req, res) => {
  if (!razorpayConfigured()) return res.status(503).json({ error: "Payments not configured. Contact support." });
  const { email, planId, billing, currency } = req.body || {};
  if (!email || !String(email).includes("@")) return res.status(400).json({ error: "Valid email required." });
  if (!["starter", "pro", "professional", "growth"].includes(planId)) return res.status(400).json({ error: "Invalid plan." });
  if (!["mo", "yr"].includes(billing)) return res.status(400).json({ error: "Invalid billing period." });

  const normalized = String(email).trim().toLowerCase();
  if (userStore.has(normalized)) return res.status(400).json({ error: "An account with this email already exists. Please login instead." });

  try {
    const orderData = await razorpayCreateOrder(planId, billing, currency || "INR");
    res.json({ ...orderData, keyId: razorpayGetKeyId() });
  } catch (err) {
    logError("razorpay-signup-order", err, { email, planId, billing });
    res.status(500).json({ error: err.message || "Failed to create order." });
  }
});

// POST /api/user/signup-with-payment — verify payment, create account, return session
app.post("/api/user/signup-with-payment", async (req, res) => {
  const { email, password, planId, billing, orderId, paymentId, signature } = req.body || {};
  if (!email || !password || !planId || !billing || !orderId || !paymentId || !signature) {
    return res.status(400).json({ error: "Missing required fields." });
  }
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (!["starter", "pro", "professional", "growth"].includes(planId)) return res.status(400).json({ error: "Invalid plan." });

  const valid = razorpayVerifyPayment(orderId, paymentId, signature);
  if (!valid) {
    logError("signup-verify-fail", new Error("Signature mismatch"), { orderId, paymentId, email });
    return res.status(400).json({ error: "Payment verification failed. Contact support with Payment ID: " + paymentId });
  }

  const normalized = String(email).trim().toLowerCase();
  if (userStore.has(normalized)) return res.status(409).json({ error: "Account already exists with this email. Please login." });

  const normalizedPlan = razorpayNormalizePlan(planId);
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const days = razorpayGetPlanDays(planId, billing);
  const planConfig = PLAN_CONFIG[normalizedPlan] || PLAN_CONFIG.starter;
  const permissions = ["import",
    ...(planConfig.exportAccess ? ["export"] : []),
    ...(planConfig.deleteAccess ? ["delete"] : []),
    ...(planConfig.autoAllocationAccess ? ["allocation"] : []),
  ];
  const now = new Date();
  const newUser = {
    id: crypto.randomBytes(12).toString("hex"),
    email: normalized,
    hash,
    salt,
    plan: normalizedPlan,
    planStatus: "active",
    planStartAt: now.toISOString(),
    planExpiry: new Date(now.getTime() + days * 86400000).toISOString(),
    lastPaymentId: paymentId,
    lastOrderId: orderId,
    planPaidAt: now.toISOString(),
    role: "importer",
    permissions,
    disabled: false,
    note: "",
    createdAt: Date.now(),
  };

  userStore.set(normalized, newUser);
  saveUsers();
  const token = createUserSession(newUser);
  recordAuditLog("system", "signup-payment", normalized, `plan=${normalizedPlan} billing=${billing} days=${days} paymentId=${paymentId}`);
  sendPaymentReceivedEmail(normalized, normalizedPlan, newUser.planExpiry).catch(() => {});
  console.log(`[SIGNUP] New paid user: ${normalized} → ${normalizedPlan} (${days} days, expires ${newUser.planExpiry})`);

  res.json({
    token,
    user: { id: newUser.id, email: newUser.email, isAdmin: false, role: "importer", permissions, plan: normalizedPlan },
  });
});

// ── Razorpay Routes ───────────────────────────────────────────────────────────

// POST /api/razorpay/create-order — create Razorpay order, return to frontend
app.post("/api/razorpay/create-order", async (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  if (!razorpayConfigured()) return res.status(503).json({ error: "Payments not yet configured. Contact support." });

  const { planId, billing, currency } = req.body || {};
  if (!["starter", "pro", "professional", "growth"].includes(planId)) return res.status(400).json({ error: "Invalid plan" });
  if (!["mo", "yr"].includes(billing)) return res.status(400).json({ error: "Invalid billing period" });

  try {
    const user = userData.user;
    const orderData = await razorpayCreateOrder(planId, billing, currency || "INR");
    res.json({
      ...orderData,
      keyId: razorpayGetKeyId(),
      userEmail: user.email,
      userName: user.name || user.email,
      billing,
    });
  } catch (err) {
    logError("razorpay-create-order", err, { email: userData.user.email, planId, billing });
    res.status(500).json({ error: err.message || "Failed to create payment order" });
  }
});

// POST /api/razorpay/verify-payment — verify signature, activate plan immediately
app.post("/api/razorpay/verify-payment", async (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });

  const { orderId, paymentId, signature, planId, billing } = req.body || {};
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: "Missing payment details" });
  if (!["starter", "pro", "professional", "growth"].includes(planId)) return res.status(400).json({ error: "Invalid plan" });

  const valid = razorpayVerifyPayment(orderId, paymentId, signature);
  if (!valid) {
    logError("razorpay-verify-fail", new Error("Signature mismatch"), { orderId, paymentId });
    return res.status(400).json({ error: "Payment verification failed. Contact support." });
  }

  const user = userData.user;
  const normalized = String(user.email).trim().toLowerCase();
  const u = userStore.get(normalized);
  if (u) {
    const normalizedPlan = razorpayNormalizePlan(planId);
    const days = razorpayGetPlanDays(planId, billing);
    const now = new Date();
    u.plan = normalizedPlan;
    u.planStatus = "active";
    u.planStartAt = now.toISOString();
    u.planExpiry = new Date(now.getTime() + days * 86400000).toISOString();
    u.lastPaymentId = paymentId;
    u.lastOrderId = orderId;
    u.planPaidAt = now.toISOString();
    u.customLimits = null;
    userStore.set(normalized, u);
    saveUsers();
    recordAuditLog("system", "payment-activated", normalized, `plan=${normalizedPlan} billing=${billing} days=${days} paymentId=${paymentId}`);
    console.log(`[Razorpay] Payment verified & plan activated: ${user.email} → ${normalizedPlan} (${days} days, expires ${u.planExpiry})`);
    sendPaymentReceivedEmail(normalized, normalizedPlan, u.planExpiry).catch(() => {});
  }

  res.json({ success: true, plan: u?.plan, expiry: u?.planExpiry, planStatus: "active" });
});

// GET /api/user/plan — get current user's plan info
app.get("/api/user/plan", (req, res) => {
  const userData = getUserFromToken(req.header("x-user-token"));
  if (!userData) return res.status(401).json({ error: "Invalid user session" });
  const u = userData.user;
  res.json({
    plan: u.plan || "starter",
    planStatus: u.planStatus || null,
    planExpiry: u.planExpiry || null,
    hasActivePlan: u.planStatus === "active",
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logError("express-global", err, { method: req.method, path: req.path });
  res.status(500).json({ error: "internal_error", message: "An unexpected error occurred." });
});

// ── Unhandled promise / exception logging ─────────────────────────────────────
process.on("uncaughtException", (err) => {
  logError("uncaughtException", err);
  console.error("[FATAL] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  logError("unhandledRejection", reason instanceof Error ? reason : new Error(String(reason)));
  console.error("[FATAL] Unhandled Rejection:", reason);
});

// ── Plan expiry auto-check (runs every 6 hours) ─────────────────────────────
const EXPIRY_WARNING_DAYS = [7, 3, 1];
const _expiryEmailsSent = new Map(); // userId -> Set of "warning-7","warning-3","warning-1","expired"
setInterval(() => {
  const now = new Date();
  for (const user of userStore.values()) {
    if (!user.planExpiry || !user.plan || user.plan === "none" || user.plan === "testing" || user.plan === "team") continue;
    const expiry = new Date(user.planExpiry);
    if (isNaN(expiry)) continue;
    if (!_expiryEmailsSent.has(user.id)) _expiryEmailsSent.set(user.id, new Set());
    const sent = _expiryEmailsSent.get(user.id);
    const msLeft = expiry - now;
    const daysLeft = Math.ceil(msLeft / 86400000);
    if (msLeft <= 0) {
      if (!sent.has("expired")) {
        sent.add("expired");
        sendPlanExpiredEmail(user.email, user.plan).catch(() => {});
        console.log(`[Expiry] Plan expired for ${user.email}`);
      }
    } else {
      for (const d of EXPIRY_WARNING_DAYS) {
        if (daysLeft <= d && !sent.has(`warning-${d}`)) {
          sent.add(`warning-${d}`);
          sendPlanExpiryWarningEmail(user.email, user.plan, daysLeft, expiry.toISOString().slice(0,10)).catch(() => {});
          console.log(`[Expiry] Warning sent to ${user.email}: ${daysLeft} days left`);
        }
      }
    }
  }
}, 6 * 60 * 60 * 1000);

// Serve React frontend (production build)
const clientDistPath = path.join(__dirname, "..", "client", "dist");
if (fs.existsSync(clientDistPath)) {
  app.use(express.static(clientDistPath));
  // SPA catch-all — React Router handles client-side routes
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
