import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "logs");
const ERROR_LOG = path.join(LOG_DIR, "error.log");
const ACCESS_LOG = path.join(LOG_DIR, "access.log");

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function timestamp() {
  return new Date().toISOString();
}

function writeLine(file, line) {
  try {
    fs.appendFileSync(file, line + "\n", "utf8");
  } catch {
    // never crash the app due to logging failure
  }
}

function rotateLogs() {
  try {
    for (const logFile of [ERROR_LOG, ACCESS_LOG]) {
      if (!fs.existsSync(logFile)) continue;
      const stat = fs.statSync(logFile);
      if (stat.size > 10 * 1024 * 1024) { // 10 MB
        const rotated = logFile.replace(".log", `_${Date.now()}.log`);
        fs.renameSync(logFile, rotated);
        // keep only last 5 rotated files
        const dir = path.dirname(logFile);
        const base = path.basename(logFile, ".log");
        const old = fs.readdirSync(dir)
          .filter(f => f.startsWith(base + "_") && f.endsWith(".log"))
          .sort()
          .slice(0, -4);
        old.forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch {} });
      }
    }
  } catch {}
}

// Rotate on startup and every 6 hours
rotateLogs();
setInterval(rotateLogs, 6 * 60 * 60 * 1000);

export function logError(context, err, extra = {}) {
  const entry = {
    ts: timestamp(),
    context,
    message: err?.message || String(err),
    stack: err?.stack?.split("\n").slice(0, 5).join(" | "),
    ...extra,
  };
  writeLine(ERROR_LOG, JSON.stringify(entry));
}

export function logAccess(method, url, status, ms, userEmail = "") {
  const entry = `${timestamp()} ${method} ${url} ${status} ${ms}ms ${userEmail}`;
  writeLine(ACCESS_LOG, entry);
}

export function logInfo(context, message, extra = {}) {
  const entry = { ts: timestamp(), context, message, ...extra };
  writeLine(ACCESS_LOG, JSON.stringify(entry));
}

// Override console.error to also write to log file
const _origError = console.error.bind(console);
console.error = (...args) => {
  _origError(...args);
  const msg = args.map(a => (a instanceof Error ? a.stack : String(a))).join(" ");
  writeLine(ERROR_LOG, JSON.stringify({ ts: timestamp(), context: "console.error", message: msg }));
};
