import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });
import express from "express";
import cors from "cors";
import ExcelJS from "exceljs";

const app = express();
app.use(express.json());
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
    credentials: false,
  })
);

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

const stateStore = new Map();
const sessionStore = new Map();
let latestSession = null;
const SESSION_FILE = path.join(__dirname, "sessions.json");
const USERS_FILE = path.join(__dirname, "users.json");
const USER_SESSIONS_FILE = path.join(__dirname, "user_sessions.json");
const SETTINGS_FILE = path.join(__dirname, "settings.json");
const ADMIN_SESSIONS_FILE = path.join(__dirname, "admin_sessions.json");
const userStore = new Map();
const userSessionStore = new Map();
const adminSessionStore = new Map();
const ADMIN_EMAIL = "rituraj@gmail.com";
const settingsStore = {
  maxUsers: Number.parseInt(process.env.MAX_USERS || "7", 10) || 7,
  adminPasswordHash: null,
  adminPasswordSalt: null,
  allowedTypes: [],
  deniedTypes: [],
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
          userStore.set(normalized, { ...user, disabled: Boolean(user.disabled) });
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

loadUsers();
loadUserSessions();
loadSettings();
loadAdminSessions();

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
          ? template.mapRows(records, raw)
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
    unitdp: 4,
    paged: true,
  },
  "Receive Overpayment": {
    path: "/BankTransactions",
    collectionKey: "BankTransactions",
    type: "RECEIVE-OVERPAYMENT",
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

function buildAuthUrl(state, codeChallenge) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
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

app.post("/api/user/signup", (req, res) => {
  try {
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
    };
    userStore.set(normalized, user);
    saveUsers();
    const token = createUserSession(user);
    return res.json({
      token,
      user: { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email) },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/user/login", (req, res) => {
  try {
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
    const token = createUserSession(user);
    return res.json({
      token,
      user: { id: user.id, email: user.email, isAdmin: isAdminEmail(user.email) },
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
    user: {
      id: userData.user.id,
      email: userData.user.email,
      isAdmin: isAdminEmail(userData.user.email),
    },
  });
});

app.post("/api/user/logout", (req, res) => {
  const token = req.header("x-user-token");
  if (token && userSessionStore.has(token)) {
    userSessionStore.delete(token);
    saveUserSessions();
  }
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
  const users = Array.from(userStore.values()).map((user) => ({
    id: user.id,
    email: user.email,
    createdAt: user.createdAt || null,
    disabled: Boolean(user.disabled),
  }));
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
  return res.json({
    id: target.id,
    email: target.email,
    disabled: target.disabled,
  });
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

async function exchangeToken(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
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

async function refreshToken(refreshTokenValue) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshTokenValue,
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
    throw new Error(`Refresh failed: ${res.status} ${text}`);
  }

  return res.json();
}

async function getAccessToken(session) {
  if (!session.expires_at || Date.now() < session.expires_at - 60000) {
    return session.access_token;
  }

  if (!session.refresh_token) {
    throw new Error("Session expired. Please reconnect.");
  }

  const refreshed = await refreshToken(session.refresh_token);
  session.access_token = refreshed.access_token;
  session.refresh_token = refreshed.refresh_token || session.refresh_token;
  session.expires_at = Date.now() + refreshed.expires_in * 1000;
  return session.access_token;
}

async function forceRefreshSession(session) {
  if (!session.refresh_token) {
    throw new Error("Session expired. Please reconnect.");
  }
  const refreshed = await refreshToken(session.refresh_token);
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

async function fetchWithRetry(url, headers) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < 200) {
      const retryAfter = res.headers.get("Retry-After");
      let waitMs = 15000;
      if (retryAfter) {
        const seconds = Number.parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) {
          waitMs = seconds * 1000;
        }
      } else {
        waitMs = Math.min(180000, Math.pow(2, attempt) * 1000);
        if (waitMs < 15000) waitMs = 15000;
      }
      await delay(waitMs);
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Xero API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    return {
      data,
      rate: {
        day: res.headers.get("X-DayLimit-Remaining"),
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

function mapBankTransactionRows(records, { lineAmountTypeLabel }) {
  const rows = [];
  records.forEach((txn) => {
    const contactName = txn.Contact?.Name || "";
    const bankAccountCode = txn.BankAccount?.Code || "";
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

function mapOverpaymentRows(records) {
  const rows = [];
  records.forEach((txn) => {
    const contactName = txn.Contact?.Name || "";
    const bankAccountCode = txn.BankAccount?.Code || "";
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
    mapRows: (records) =>
      mapBankTransactionRows(records, { lineAmountTypeLabel: "Line Amount Type" }),
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
    mapRows: (records) =>
      mapBankTransactionRows(records, {
        lineAmountTypeLabel: "Inclusive/Exclusive",
      }),
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
    mapRows: (records) => mapOverpaymentRows(records),
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
    mapRows: (records) => mapOverpaymentRows(records),
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
      return await fetchWithRetry(url, buildHeaders());
    } catch (err) {
      if (err.message && err.message.includes("Xero API error 401") && session) {
        currentAccessToken = await forceRefreshSession(session);
        return fetchWithRetry(url, buildHeaders());
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

app.get("/api/auth/start", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  stateStore.set(state, { verifier, createdAt: Date.now() });
  const authUrl = buildAuthUrl(state, challenge);
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

    const token = await exchangeToken(code, stateData.verifier);
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
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
  if (Date.now() - latestSession.createdAt > 10 * 60 * 1000) {
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
    const token = await exchangeToken(code, stateData.verifier);
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
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

    const token = await exchangeToken(code, stateData.verifier);
    stateStore.delete(state);

    const sessionId = crypto.randomBytes(16).toString("hex");
    sessionStore.set(sessionId, {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000,
    });
    latestSession = { sessionId, createdAt: Date.now() };
    saveSessions();

    res.json({ sessionId });
  } catch (err) {
    console.error("Manual auth error:", err);
    res.status(500).json({ error: err.message });
  }
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

    const rows = template
      ? template.mapRows(records, raw)
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
