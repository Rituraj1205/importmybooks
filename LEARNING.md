# Xero Tool Learning Guide (Hinglish)

Ye file aapko project ka end-to-end flow samjhati hai: kya use hua hai, code kaise likha gaya hai, aur pieces kaise judte hain.

## 1) High-Level Architecture

- **Frontend**: React (client/)
- **Backend**: Node + Express (server/)
- **Xero OAuth**: PKCE flow (client secret ki zarurat nahi)
- **Exports**: Excel/CSV/JSON server par generate hote hain, phir download hote hain
- **Storage**: Local file system + JSON files (sessions, users, jobs)

## 1.1) Kaam Ka Overall Flow (Short)

1) User app me login karta hai (app account).
2) User Xero se connect karta hai (OAuth PKCE).
3) Tenants list aati hai (orgs).
4) User types + date range select karta hai.
5) Export jobs start hote hain.
6) Server Xero API se data pull karta hai.
7) Files server par save hoti hain (user/tenant wise).
8) UI me status update hota hai, download buttons active ho jate hain.

## 2) Folder Structure (Main)

- `client/`
  - React UI, filters, login, export status, download buttons
- `server/`
  - Express API, Xero token handling, exports, job queue, file storage
- `.env`
  - Xero client id, redirect uri, scopes, port

## 3) Authentication Flow (Xero OAuth PKCE)

### Flow Summary
1) UI se **Connect to Xero**.
2) Backend `/api/auth/start` call karta hai -> `state`, `verifier`, `challenge` banta hai.
3) Xero login hota hai -> callback me `code` + `state`.
4) Backend `/auth/callback` ya `/api/auth/callback` me code exchange hota hai -> tokens milte hain.
5) Tokens server me store hote hain (session).
6) UI sessionId use karke exports ke liye API call karta hai.

### Logic Kya Hai (Simple)
- **state** -> security ke liye, CSRF attack se bachata hai.
- **verifier + challenge** -> PKCE ka core, bina client secret ke secure auth.
- **access token** -> Xero APIs call karne ke liye.
- **refresh token** -> access token expire ho jaaye to naya token mil jata hai.

### Where in code
- `server/index.js`
  - `buildAuthUrl`, `exchangeToken`, `getAccessToken`, `refreshToken`
  - `app.get("/api/auth/start")`
  - `app.get("/auth/callback")`
  - `app.post("/api/auth/callback")`

## 4) User Login (App Users)

Yeh project me Xero login ke sath **app user login** bhi hai.

### Flow
1) User signup -> `/api/user/signup`
2) User login -> `/api/user/login`
3) Server token return karta hai -> UI localStorage me rakhta hai
4) Downloads aur export history user ke token se secured hai

### Logic Kya Hai
- Password directly save nahi hota. **pbkdf2 hashing** use hua hai.
- Login ke baad **user session token** banta hai.
- Har download request me token check hota hai (auth guard).

### Storage
- `server/users.json` -> users list (hashed password)
- `server/user_sessions.json` -> active user sessions

### Where in code
- `server/index.js`
  - `createUser`, `verifyPassword`, `createUserSession`
  - `app.post("/api/user/signup")`
  - `app.post("/api/user/login")`
  - `app.get("/api/user/me")`
  - `app.post("/api/user/logout")`

## 5) Export Pipeline (Jobs + Files)

### Kya hota hai
Export ka kaam background job me hota hai:
- UI `POST /api/export/start` karta hai
- Server job create karta hai
- Job queue process hota hai
- Files (Excel/CSV/JSON) server par save hoti hain
- UI `GET /api/export/status` poll karta hai
- Ready hone par download links active ho jate hain

### Logic Kya Hai
- Har export ek **job** hai (status: queued -> running -> ready/error).
- Background queue se rate limit break nahi hota.
- Job ka output server par save hota hai (browser refresh ke baad bhi).

### Jobs Storage
`server/exports/jobs.json` me jobs save hote hain.

### File Storage (per user, per tenant)
```
server/exports/<userId>/<tenantName>/<jobId>_<type>_<timestamp>.<ext>
```

### Retention
30 days ke baad old files clean ho jati hain.

### Where in code
- `server/index.js`
  - `processQueue`, `processJob`
  - `app.post("/api/export/start")`
  - `app.get("/api/export/status")`
  - `app.get("/api/export/jobs")`
  - `app.get("/api/export/download/:jobId")`

## 6) Xero API Data Fetch

### Flow
- `fetchAllRecords` Xero API ko call karta hai
- Pagination handle hota hai (page=1..n)
- Rate limit headers read hote hain
- 401 aane par refresh token retry hota hai
- Data return hota hai (records + raw JSON)

### Logic Kya Hai
- **429** aaye to `Retry-After` wait (rate limit safe).
- **401** aaye to refresh token se auto recover.
- **paged endpoints** me loop chalta hai until no records.

### Where in code
- `server/index.js`
  - `fetchWithRetry` (429 handling)
  - `fetchAllRecords` (pagination + refresh)

## 7) Export Formats

### JSON
Raw Xero response format me file save hoti hai (SummarizeErrors, Quotes[] etc).

### Excel/CSV
Data map hota hai (flatten) aur columns set hote hain.
Quotes ke liye specific mapping rakha gaya hai (Xero Explorer format).

### Logic Kya Hai
- JSON = **as-is** response (raw).
- Excel/CSV = **flattened rows** so that line items repeat per row.

### Where in code
- `server/index.js`
  - `exportTemplates` (columns + mapRows)
  - `mapQuoteRows`, `mapInvoiceRows`, etc
  - `processJob` (file generation)

## 8) Frontend UI Flow

### Major Components/Sections
- Login / Signup screen
- Connection card (Xero Connect)
- Filters (tenant, date, types)
- Export status table
- Download buttons (Excel/CSV/JSON)
- Folder history view (user-wise)

### State Handling
React state ke through:
- selected types
- date range
- tenant
- export jobs list
- logged-in user

### Logic Kya Hai
- UI **polls** job status.
- UI tenant-wise grouping dikhata hai.
- Download buttons active tab hote hain jab status `READY`.

### Where in code
- `client/src/App.jsx`
  - API calls, UI rendering, download buttons
  - Job polling
  - Tenant grouping UI
- `client/src/styles.css`
  - UI theme, cards, buttons, tables

## 9) Rate Limits (Xero)

Project rate limits respect karta hai:
- 429 aane par Retry-After wait
- Concurrency limited via job queue

### Logic Kya Hai
- Export slow ho sakta hai but **fail nahi hoga**.
- Job queue se concurrency control.

### Where in code
- `server/index.js`
  - `fetchWithRetry` + `delay`

## 10) Typical Dev Workflow

1) `.env` configure
2) `server` + `client` install
3) `node index.js` + `npm run dev`
4) UI se connect karo
5) Types select karo
6) Export start -> status check -> download

## 11) Kaha kya likha jata hai (Quick Map)

- Xero OAuth changes -> `server/index.js`
- New export type add -> `typeConfigs` + `exportTemplates`
- Excel/CSV format change -> `mapRows` function
- UI layout change -> `client/src/App.jsx` + `client/src/styles.css`
- Auth issues -> `users.json` / `user_sessions.json`

## 12) Feature/Function Summary (Direct Mapping)

- **Connect to Xero** -> `/api/auth/start`, `/auth/callback`
- **Tenants list** -> `/api/tenants`
- **Export start** -> `/api/export/start`
- **Status polling** -> `/api/export/status`
- **Download file** -> `/api/export/download/:jobId`
- **User login** -> `/api/user/login`, `/api/user/signup`
- **File retention** -> `pruneOldJobs()`
- **Rate limit handling** -> `fetchWithRetry()`

## 13) Common Debug Points

- Download error: user session invalid -> logout/login again
- 401 from Xero -> token refresh flow
- No records -> date filter/tenant mismatch
- CSV format mismatch -> `mapRows` and `columns` check

---

## 14) ASCII Flow Diagrams

### 14.1 OAuth Flow (PKCE)
```
UI (React)        Backend (Express)                 Xero
   |                    |                            |
   | Connect click      |                            |
   |------------------->| /api/auth/start           |
   |                    | state+verifier+challenge  |
   |                    | builds authUrl            |
   |<-------------------| authUrl                   |
   | open authUrl        |                           |
   |----------------------------------------------->|
   |                    |                            | Login + consent
   |                    |                            | redirect with code
   |<-----------------------------------------------|
   | callback hit        | /auth/callback            |
   |------------------->| exchange code for tokens  |
   |                    | store session             |
   |<-------------------| sessionId                 |
```

### 14.2 Export Job Flow
```
UI -> POST /api/export/start
   -> Server creates job (queued)
   -> processQueue picks job (running)
   -> fetch Xero data (paged)
   -> generate files (xlsx/csv/json)
   -> job status = ready
UI polls GET /api/export/status -> shows READY + download buttons
```

## 15) Code Snippets (Core Logic)

### 15.1 OAuth Start (server)
```js
app.get("/api/auth/start", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = createCodeVerifier();
  const challenge = createCodeChallenge(verifier);
  stateStore.set(state, { verifier, createdAt: Date.now() });
  const authUrl = buildAuthUrl(state, challenge);
  res.json({ authUrl });
});
```

### 15.2 Token Exchange (server)
```js
async function exchangeToken(code, verifier) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: process.env.XERO_REDIRECT_URI,
    client_id: process.env.XERO_CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return res.json();
}
```

### 15.3 Fetch with Retry (rate limits)
```js
async function fetchWithRetry(url, headers) {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < 200) {
      const retryAfter = res.headers.get("Retry-After");
      let waitMs = 15000;
      if (retryAfter) {
        const seconds = Number.parseInt(retryAfter, 10);
        if (!Number.isNaN(seconds)) waitMs = seconds * 1000;
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
```

### 15.4 Paged Records Fetch (server)
```js
async function fetchAllRecords({ accessToken, tenantId, type, from, to, session }) {
  const config = typeConfigs[type];
  const where = buildWhere(from, to, config);
  const baseUrl = new URL(`https://api.xero.com/api.xro/2.0${config.path}`);
  if (where) baseUrl.searchParams.set("where", where);

  const all = [];
  let currentAccessToken = accessToken;
  const buildHeaders = () => ({
    Authorization: `Bearer ${currentAccessToken}`,
    "xero-tenant-id": tenantId,
    Accept: "application/json",
  });

  const fetchWithAuthRetry = async (url) => {
    try {
      return await fetchWithRetry(url, buildHeaders());
    } catch (err) {
      if (String(err.message).includes("401") && session) {
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
      const records = payload.data[config.collectionKey] || [];
      if (!records.length) break;
      all.push(...records);
      page += 1;
      await delay(1000);
    }
  } else {
    const payload = await fetchWithAuthRetry(baseUrl.toString());
    const records = payload.data[config.collectionKey] || [];
    all.push(...records);
  }

  return { records: all };
}
```

### 15.5 Export Job Processing (server)
```js
async function processJob(job) {
  job.status = "running";
  saveJobs();

  const session = sessionStore.get(job.sessionId);
  const accessToken = await getAccessToken(session);
  const result = await fetchAllRecords({
    accessToken,
    tenantId: job.tenantId,
    type: job.type,
    from: job.from,
    to: job.to,
    session,
  });

  const records = result.records || [];
  if (!records.length) {
    job.status = "no_records";
    saveJobs();
    return;
  }

  const rows = exportTemplates[job.type].mapRows(records);
  // Excel/CSV/JSON generation here
  job.status = "ready";
  saveJobs();
}
```

### 15.6 Quotes Mapping (server)
```js
function mapQuoteRows(records) {
  const rows = [];
  records.forEach((quote) => {
    const contact = quote.Contact || {};
    const base = {
      QuoteID: quote.QuoteID || "",
      QuoteNumber: quote.QuoteNumber || "",
      ContactID: contact.ContactID || "",
      ContactName: contact.Name || "",
      FirstName: contact.FirstName || "",
      LastName: contact.LastName || "",
      EmailAddress: contact.EmailAddress || "",
      Date: quote.Date || "",
      DateString: quote.DateString || "",
      Status: quote.Status || "",
      CurrencyCode: quote.CurrencyCode || "",
      SubTotal: quote.SubTotal ?? "",
      TotalTax: quote.TotalTax ?? "",
      Total: quote.Total ?? "",
    };

    const lineItems = Array.isArray(quote.LineItems) ? quote.LineItems : [];
    if (!lineItems.length) {
      rows.push({ ...base, LineItemID: "", Description: "" });
      return;
    }

    lineItems.forEach((line) => {
      rows.push({
        ...base,
        LineItemID: line.LineItemID || "",
        Description: line.Description || "",
        UnitAmount: line.UnitAmount ?? "",
      });
    });
  });
  return rows;
}
```

### 15.7 Export Templates (server)
```js
const exportTemplates = {
  Quotes: {
    columns: [
      { header: "QuoteID", key: "QuoteID" },
      { header: "QuoteNumber", key: "QuoteNumber" },
      { header: "Name", key: "ContactName" },
      { header: "LineItemID", key: "LineItemID" },
      { header: "Description", key: "Description" },
    ],
    mapRows: (records) => mapQuoteRows(records),
  },
};
```

### 15.8 Frontend Export Start (client)
```js
await fetch("/api/export/start", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-session-id": sessionId,
    "x-user-token": userToken,
  },
  body: JSON.stringify({
    type,
    tenantId,
    from,
    to,
    format: "all",
  }),
});
```

## 16) Example API Calls (Manual Testing)

### 16.1 Start Export (curl)
```bash
curl -X POST http://localhost:3001/api/export/start ^
  -H "Content-Type: application/json" ^
  -H "x-session-id: <SESSION_ID>" ^
  -H "x-user-token: <USER_TOKEN>" ^
  -d "{\"type\":\"Quotes\",\"tenantId\":\"<TENANT_ID>\",\"from\":\"2024-01-01\",\"to\":\"2024-12-31\",\"format\":\"all\"}"
```

### 16.2 Check Status
```bash
curl "http://localhost:3001/api/export/status?jobId=<JOB_ID>" ^
  -H "x-user-token: <USER_TOKEN>"
```

### 16.3 Download File
```bash
curl -L "http://localhost:3001/api/export/download/<JOB_ID>?format=excel&userToken=<USER_TOKEN>" -o quotes.xlsx
```

## 17) How To Extend (Khud Changes Kaise Karein)

### 17.1 New Export Type Add Karna
1) `typeConfigs` me new entry add karein.
2) `exportTemplates` me columns + mapRows add karein.
3) UI list me type add karein (client).

Example:
```js
typeConfigs["Bank Transactions"] = {
  path: "/BankTransactions",
  collectionKey: "BankTransactions",
  paged: true,
};
```

### 17.2 CSV/Excel Format Change Karna
1) `exportTemplates.Quotes.columns` edit karein.
2) `mapQuoteRows` me keys set karein (same keys as columns).
3) Export run karke verify karein.

### 17.3 UI me Naya Filter Add Karna
1) `client/src/App.jsx` me state add karein.
2) UI form control add karein.
3) Export request body me naya field bhejein.
4) Backend me us field ko read karein.

### 17.4 Download Auth Issue Fix
1) App me logout/login.
2) Check `user_sessions.json` me token.
3) Download request me `x-user-token` header ya query param sure karein.


old app.jsx

diff --git a/d:/XeroTool 2.0/xero-tool-react-node/client/src/App.jsx b/d:/XeroTool 2.0/xero-tool-react-node/client/src/App.jsx
deleted file mode 100644
--- a/d:/XeroTool 2.0/xero-tool-react-node/client/src/App.jsx
+++ /dev/null
@@ -1,858 +0,0 @@
-﻿ import { useEffect, useMemo, useState } from "react";
-
-   const API_BASE = "http://localhost:3001/api";
-
   function App() {
-  const [user, setUser] = useState(null);
-  const [userToken, setUserToken] = useState("");
-  const [authMode, setAuthMode] = useState("login");
-  const [authEmail, setAuthEmail] = useState("");
-  const [authPassword, setAuthPassword] = useState("");
-  const [authError, setAuthError] = useState("");
-  const [authLoading, setAuthLoading] = useState(false);
-  const [sessionId, setSessionId] = useState("");
-  const [authUrl, setAuthUrl] = useState("");
-  const [types, setTypes] = useState([]);
-  const [tenants, setTenants] = useState([]);
-  const [selectedTenant, setSelectedTenant] = useState("");
-  const [selectedTypes, setSelectedTypes] = useState([]);
-  const [fromDate, setFromDate] = useState("");
-  const [toDate, setToDate] = useState("");
-  const [status, setStatus] = useState("");
-  const [isLoading, setIsLoading] = useState(false);
-  const [isCheckingSession, setIsCheckingSession] = useState(false);
-  const [lastAuthUrl, setLastAuthUrl] = useState("");
-  const [lastCallbackUrl, setLastCallbackUrl] = useState("");
-  const [exportResults, setExportResults] = useState([]);
-  const [showAllTenants, setShowAllTenants] = useState(true);
-  const [groupByTenant, setGroupByTenant] = useState(true);
-  const [openTenants, setOpenTenants] = useState({});
-
-  const isConnected = Boolean(sessionId);
-  const selectedTenantName =
-    tenants.find((tenant) => tenant.tenantId === selectedTenant)?.tenantName || "";
-
-  const sessionHeader = useMemo(() => {
-    if (!sessionId) return {};
-    return { "x-session-id": sessionId };
-  }, [sessionId]);
-
-  const userHeader = useMemo(() => {
-    if (!userToken) return {};
-    return { "x-user-token": userToken };
-  }, [userToken]);
-
-  const authHeaders = useMemo(
-    () => ({ ...sessionHeader, ...userHeader }),
-    [sessionHeader, userHeader]
-  );
-
-  const groupedTypes = useMemo(() => {
-    const categories = [
-      {
-        key: "Sales",
-        match: (type) =>
-          type.startsWith("Invoice ") ||
-          type.startsWith("Invoice CreditNotes") ||
-          type === "Quotes" ||
-          type === "Receive" ||
-          type === "Invoice Payment" ||
-          type === "CreditNoteRefund Invoice",
-      },
-      {
-        key: "Purchases",
-        match: (type) =>
-          type.startsWith("Bill ") ||
-          type.startsWith("Supplier CreditNotes") ||
-          type === "Purchase Orders" ||
-          type === "Spend" ||
-          type === "Bill Payment" ||
-          type === "CreditNoteRefund Bill" ||
-          type === "Prepayments" ||
-          type === "Debit Notes",
-      },
-      {
-        key: "Banking",
-        match: (type) =>
-          type === "Transfer" ||
-          type === "Spend Overpayment" ||
-          type === "Receive Overpayment" ||
-          type === "Manual Journals",
-      },
-      {
-        key: "Contacts",
-        match: (type) => type === "Contacts",
-      },
-      {
-        key: "Inventory",
-        match: (type) => type === "Inventory",
-      },
-      {
-        key: "Accounts",
-        match: (type) => type === "Chart of Accounts",
-      },
-      {
-        key: "Tracking",
-        match: (type) => type === "Tracking Category" || type === "Classes",
-      },
-    ];
-
-    const groups = categories.map((category) => ({
-      label: category.key,
-      types: [],
-      match: category.match,
-    }));
-    const misc = { label: "Other", types: [] };
-
-    types.forEach((type) => {
-      const group = groups.find((item) => item.match(type));
-      if (group) {
-        group.types.push(type);
-      } else {
-        misc.types.push(type);
-      }
-    });
-
-    const result = groups.filter((group) => group.types.length);
-    if (misc.types.length) {
-      result.push(misc);
-    }
-    return result;
-  }, [types]);
-
-  const exportSummary = useMemo(() => {
-    if (!selectedTenantName) {
-      return { downloaded: 0, noRecords: 0, errors: 0 };
-    }
-    const scopedResults = exportResults.filter((result) => {
-      if (showAllTenants) return true;
-      return result.tenantName === selectedTenantName;
-    });
-    const summary = {
-      downloaded: 0,
-      noRecords: 0,
-      errors: 0,
-    };
-    scopedResults.forEach((result) => {
-      if (result.status === "Ready") summary.downloaded += 1;
-      if (result.status === "No records") summary.noRecords += 1;
-      if (result.status === "Error") summary.errors += 1;
-    });
-    return summary;
-  }, [exportResults, selectedTenantName, showAllTenants]);
-
-  useEffect(() => {
-    const storedToken = localStorage.getItem("xero_user_token") || "";
-    if (!storedToken) return;
-    setUserToken(storedToken);
-    fetch(`${API_BASE}/user/me`, {
-      headers: { "x-user-token": storedToken },
-    })
-      .then((res) => res.json())
-      .then((data) => {
-        if (data.user) {
-          setUser(data.user);
-        }
-      })
-      .catch(() => {
-        localStorage.removeItem("xero_user_token");
-        setUserToken("");
-      });
-  }, []);
-
-  useEffect(() => {
-    if (!user?.id) return;
-    const stored = localStorage.getItem(`xero_export_results_${user.id}`);
-    if (stored) {
-      try {
-        const parsed = JSON.parse(stored);
-        if (Array.isArray(parsed)) {
-          setExportResults(parsed);
-        }
-      } catch {
-        // ignore invalid storage data
-      }
-    }
-  }, [user?.id]);
-
-  useEffect(() => {
-    if (!user?.id) return;
-    localStorage.setItem(
-      `xero_export_results_${user.id}`,
-      JSON.stringify(exportResults)
-    );
-  }, [exportResults, user?.id]);
-
-  const handleAuthSubmit = async () => {
-    setAuthLoading(true);
-    setAuthError("");
-    try {
-      const endpoint = authMode === "signup" ? "signup" : "login";
-      const res = await fetch(`${API_BASE}/user/${endpoint}`, {
-        method: "POST",
-        headers: { "Content-Type": "application/json" },
-        body: JSON.stringify({ email: authEmail, password: authPassword }),
-      });
-      const data = await res.json();
-      if (!res.ok) {
-        throw new Error(data.error || "Auth failed");
-      }
-      localStorage.setItem("xero_user_token", data.token);
-      setUserToken(data.token);
-      setUser(data.user);
-      setAuthEmail("");
-      setAuthPassword("");
-    } catch (err) {
-      setAuthError(err.message);
-    } finally {
-      setAuthLoading(false);
-    }
-  };
-
-  const handleLogout = async () => {
-    try {
-      await fetch(`${API_BASE}/user/logout`, {
-        method: "POST",
-        headers: userHeader,
-      });
-    } catch {
-      // ignore logout errors
-    }
-    localStorage.removeItem("xero_user_token");
-    setUserToken("");
-    setUser(null);
-  };
-
-  const buildDetail = (count, rateInfo, status, error) => {
-    if (status === "Error") {
-      return error || "Export failed";
-    }
-    const rateParts = [];
-    if (rateInfo?.day) rateParts.push(`day ${rateInfo.day}`);
-    if (rateInfo?.minute) rateParts.push(`min ${rateInfo.minute}`);
-    if (rateInfo?.appMinute) rateParts.push(`app ${rateInfo.appMinute}`);
-    const rateDetail = rateParts.length
-      ? `Remaining: ${rateParts.join(" / ")}`
-      : "";
-    if (status === "Queued") return "Queued";
-    if (status === "In progress") return "Working...";
-    const base = `Count: ${count ?? 0}`;
-    return rateDetail ? `${base} | ${rateDetail}` : base;
-  };
-
-  const mapJobToResult = (job, userTokenValue) => {
-    const statusMap = {
-      queued: "Queued",
-      running: "In progress",
-      ready: "Ready",
-      no_records: "No records",
-      error: "Error",
-    };
-    const status = statusMap[job.status] || "In progress";
-    const detail = buildDetail(job.count, job.rate, status, job.error);
-    const baseDownload = `${API_BASE}/export/download/${job.jobId}`;
-    return {
-      runId: job.jobId,
-      jobId: job.jobId,
-      type: job.type,
-      tenantName: job.tenantName || null,
-      folderPath: job.folderPath || null,
-      status,
-      detail,
-      excelUrl:
-        status === "Ready"
-          ? `${baseDownload}?format=excel&userToken=${userTokenValue}`
-          : null,
-      csvUrl:
-        status === "Ready"
-          ? `${baseDownload}?format=csv&userToken=${userTokenValue}`
-          : null,
-      jsonUrl:
-        status === "Ready"
-          ? `${baseDownload}?format=json&userToken=${userTokenValue}`
-          : null,
-    };
-  };
-
-  const folderSummary = useMemo(() => {
-    const seen = new Map();
-    exportResults.forEach((item) => {
-      if (!item.folderPath) return;
-      const key = item.folderPath;
-      if (!seen.has(key)) {
-        seen.set(key, {
-          folderPath: item.folderPath,
-          tenantName: item.tenantName || "Unknown",
-        });
-      }
-    });
-    return Array.from(seen.values());
-  }, [exportResults]);
-
-  const groupedResults = useMemo(() => {
-    const groups = new Map();
-    exportResults.forEach((item) => {
-      const key = item.tenantName || "Unknown tenant";
-      if (!groups.has(key)) {
-        groups.set(key, []);
-      }
-      groups.get(key).push(item);
-    });
-    return Array.from(groups.entries()).map(([tenant, items]) => ({
-      tenant,
-      items,
-    }));
-  }, [exportResults]);
-
-  useEffect(() => {
-    fetch(`${API_BASE}/types`)
-      .then((res) => res.json())
-      .then((data) => setTypes(data.types || []))
-      .catch(() => setTypes([]));
-  }, []);
-
-  useEffect(() => {
-    const storedAuthUrl = localStorage.getItem("xero_last_auth_url") || "";
-    const storedCallbackUrl = localStorage.getItem("xero_last_callback_url") || "";
-    setLastAuthUrl(storedAuthUrl);
-    setLastCallbackUrl(storedCallbackUrl);
-
-    const params = new URLSearchParams(window.location.search);
-    const sessionFromRedirect = params.get("sessionId");
-    if (sessionFromRedirect) {
-      localStorage.setItem("xero_session", sessionFromRedirect);
-      setSessionId(sessionFromRedirect);
-      setStatus("Connected. Fetch tenants...");
-      window.history.replaceState({}, document.title, "/");
-      return;
-    }
-    const code = params.get("code");
-    const state = params.get("state");
-    if (!code || !state) return;
-
-    setStatus("Exchanging code for token...");
-    fetch(`${API_BASE}/auth/callback`, {
-      method: "POST",
-      headers: { "Content-Type": "application/json" },
-      body: JSON.stringify({ code, state }),
-    })
-      .then((res) => res.json())
-      .then((data) => {
-        if (data.sessionId) {
-          localStorage.setItem("xero_session", data.sessionId);
-          setSessionId(data.sessionId);
-          setStatus("Connected. Fetch tenants...");
-          window.history.replaceState({}, document.title, "/");
-        } else {
-          setStatus(data.error || "Auth failed");
-        }
-      })
-      .catch((err) => setStatus(err.message));
-  }, []);
-
-  useEffect(() => {
-    if (!sessionId) {
-      const stored = localStorage.getItem("xero_session");
-      if (stored) {
-        setStatus("Previous session found. Click 'Use Latest Session' or Connect.");
-      }
-    }
-  }, [sessionId]);
-
-  useEffect(() => {
-    if (!sessionId) {
-      return;
-    }
-    fetch(`${API_BASE}/tenants`, { headers: sessionHeader })
-      .then((res) => res.json())
-      .then((data) => {
-        const list = data.tenants || [];
-        setTenants(list);
-        if (!list.length) {
-          setSelectedTenant("");
-        }
-        if (data.error) {
-          setStatus(data.error);
-          if (data.error.includes("Session")) {
-            localStorage.removeItem("xero_session");
-            setSessionId("");
-          }
-        }
-      })
-      .catch((err) => setStatus(err.message));
-  }, [sessionId, sessionHeader]);
-
-  useEffect(() => {
-    if (!userToken) {
-      return;
-    }
-    fetch(`${API_BASE}/export/jobs`, {
-      headers: userHeader,
-    })
-      .then((res) => res.json())
-      .then((data) => {
-        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
-        if (!jobs.length) return;
-        const mapped = jobs.map((job) => mapJobToResult(job, userToken));
-        setExportResults((prev) => {
-          const existing = new Set(prev.map((item) => item.jobId));
-          const merged = [...prev];
-          mapped.forEach((item) => {
-            if (!existing.has(item.jobId)) {
-              merged.push(item);
-            }
-          });
-          return merged;
-        });
-      })
-      .catch(() => {
-        // ignore restore errors
-      });
-  }, [userToken, userHeader]);
-
-  const handleConnect = async () => {
-    const res = await fetch(`${API_BASE}/auth/start`);
-    const data = await res.json();
-    if (data.authUrl) {
-      localStorage.setItem("xero_last_auth_url", data.authUrl);
-      setLastAuthUrl(data.authUrl);
-      setAuthUrl(data.authUrl);
-      window.location.href = data.authUrl;
-    }
-  };
-
-  useEffect(() => {
-    const pending = exportResults.filter(
-      (item) =>
-        item.jobId &&
-        (item.status === "Queued" ||
-          item.status === "In progress" ||
-          (item.status === "Ready" && !item.excelUrl))
-    );
-    if (!pending.length || !sessionId) {
-      return;
-    }
-    const interval = setInterval(async () => {
-      for (const item of pending) {
-        try {
-          const res = await fetch(`${API_BASE}/export/status?jobId=${item.jobId}`, {
-            headers: authHeaders,
-          });
-          if (!res.ok) {
-            continue;
-          }
-          const data = await res.json();
-          const statusMap = {
-            queued: "Queued",
-            running: "In progress",
-            ready: "Ready",
-            no_records: "No records",
-            error: "Error",
-          };
-          const status = statusMap[data.status] || "In progress";
-          const detail = buildDetail(data.count, data.rate, status, data.error);
-          const baseDownload = `${API_BASE}/export/download/${item.jobId}`;
-          const excelUrl = `${baseDownload}?format=excel&userToken=${userToken}`;
-          const csvUrl = `${baseDownload}?format=csv&userToken=${userToken}`;
-          const jsonUrl = `${baseDownload}?format=json&userToken=${userToken}`;
-
-          setExportResults((prev) =>
-            prev.map((entry) =>
-              entry.jobId === item.jobId
-                ? {
-                    ...entry,
-                    status,
-                    detail,
-                    tenantName: data.tenantName || entry.tenantName,
-                    folderPath: data.folderPath || entry.folderPath,
-                    excelUrl: status === "Ready" ? excelUrl : entry.excelUrl,
-                    csvUrl: status === "Ready" ? csvUrl : entry.csvUrl,
-                    jsonUrl: status === "Ready" ? jsonUrl : entry.jsonUrl,
-                  }
-                : entry
-            )
-          );
-        } catch {
-          // ignore polling errors
-        }
-      }
-    }, 3000);
-    return (
-    <div className="app-shell">
-      <header className="topbar">
-        <div className="brand">
-          <span className="brand-dot" />
-          <span>Xero Tool</span>
-        </div>
-        <div className="topbar-actions">
-          <button className="btn ghost" onClick={handleUseLatestSession}>
-            Use Latest Session
-          </button>
-          <button className="btn primary" onClick={handleConnect}>
-            Connect to Xero
-          </button>
-          <button className="btn ghost" onClick={handleLogout}>
-            Logout
-          </button>
-        </div>
-      </header>
-
-      <section className="hero-grid">
-        <div className="hero-card">
-          <p className="kicker">Xero Data Extraction</p>
-          <h1>Precision exports, premium workflow.</h1>
-          <p className="sub">
-            Curated controls for date ranges, tenants, and data types. Export to
-            Excel, CSV, or JSON with confidence.
-          </p>
-          <div className="hero-status">
-            <span>{isConnected ? "Connected" : "Not connected"}</span>
-            {selectedTenantName ? <span>{selectedTenantName}</span> : null}
-            {user?.email ? <span>{user.email}</span> : null}
-          </div>
-        </div>
-        <div className="hero-metrics">
-          <div className="stat-card">
-            <p className="stat-label">Connection</p>
-            <p className="stat-value">{isConnected ? "Active" : "Idle"}</p>
-            <p className="stat-sub">
-              {selectedTenantName || "No tenant selected"}
-            </p>
-          </div>
-          <div className="stat-card">
-            <p className="stat-label">Types Selected</p>
-            <p className="stat-value">{selectedTypes.length}</p>
-            <p className="stat-sub">Total available: {types.length}</p>
-          </div>
-          <div className="stat-card">
-            <p className="stat-label">Exports Ready</p>
-            <p className="stat-value">{exportSummary.downloaded}</p>
-            <p className="stat-sub">
-              No records: {exportSummary.noRecords} | Errors: {exportSummary.errors}
-            </p>
-          </div>
-        </div>
-      </section>
-
-      <section className="workspace">
-        <div className="panel filters-panel">
-          <div className="panel-header">
-            <div>
-              <h2>Filters</h2>
-              <p>Scope your export before starting a run.</p>
-            </div>
-            <div className="panel-actions">
-              <button
-                className="btn ghost"
-                onClick={() => {
-                  setSelectedTenant("");
-                  setStatus("Pick another tenant to switch.");
-                }}
-                disabled={!sessionId}
-              >
-                Switch Tenant
-              </button>
-              <button
-                className="btn ghost"
-                onClick={() => {
-                  localStorage.removeItem("xero_session");
-                  setSessionId("");
-                  setTenants([]);
-                  setSelectedTenant("");
-                  setStatus("Disconnected");
-                }}
-              >
-                Disconnect
-              </button>
-            </div>
-          </div>
-          <div className="grid">
-            <label className="field">
-              <span>From</span>
-              <input
-                type="date"
-                value={fromDate}
-                onChange={(e) => setFromDate(e.target.value)}
-              />
-            </label>
-            <label className="field">
-              <span>To</span>
-              <input
-                type="date"
-                value={toDate}
-                onChange={(e) => setToDate(e.target.value)}
-              />
-            </label>
-            <label className="field">
-              <span>Tenant</span>
-              <select
-                value={selectedTenant}
-                onChange={(e) => setSelectedTenant(e.target.value)}
-              >
-                <option value="">Select tenant</option>
-                {tenants.map((tenant) => (
-                  <option key={tenant.tenantId} value={tenant.tenantId}>
-                    {tenant.tenantName}
-                  </option>
-                ))}
-              </select>
-            </label>
-          </div>
-        </div>
-
-        <div className="panel types-panel">
-          <div className="panel-header">
-            <div>
-              <h2>Data Types</h2>
-              <p>Choose what you want to extract.</p>
-            </div>
-            <div className="type-meta">{selectedTypes.length} selected</div>
-          </div>
-          <div className="type-list">
-            <div className="type-toolbar">
-              <label className="type-item">
-                <input
-                  type="checkbox"
-                  checked={selectedTypes.length === types.length && types.length > 0}
-                  onChange={(e) => handleToggleAllTypes(e.target.checked)}
-                />
-                Select all
-              </label>
-            </div>
-            <div className="type-groups">
-              {groupedTypes.map((group) => {
-                const groupAllSelected = group.types.every((type) =>
-                  selectedTypes.includes(type)
-                );
-                return (
-                  <div className="type-group" key={group.label}>
-                    <div className="type-group__header">
-                      <div className="type-group__title">{group.label}</div>
-                      <label className="type-item type-item--muted">
-                        <input
-                          type="checkbox"
-                          checked={groupAllSelected}
-                          onChange={(e) =>
-                            handleToggleGroup(group.types, e.target.checked)
-                          }
-                        />
-                        Select group
-                      </label>
-                    </div>
-                    <div className="type-group__list">
-                      {group.types.map((type) => (
-                        <label className="type-item" key={type}>
-                          <input
-                            type="checkbox"
-                            checked={selectedTypes.includes(type)}
-                            onChange={(e) =>
-                              handleToggleType(type, e.target.checked)
-                            }
-                          />
-                          {type}
-                        </label>
-                      ))}
-                    </div>
-                  </div>
-                );
-              })}
-            </div>
-          </div>
-          <div className="actions actions--sticky">
-            <button
-              className="btn primary"
-              onClick={handleExport}
-              disabled={
-                isLoading || !sessionId || !selectedTenant || !selectedTypes.length
-              }
-            >
-              {isLoading ? "Exporting..." : "Download Files"}
-            </button>
-          </div>
-        </div>
-      </section>
-
-      {folderSummary.length ? (
-        <section className="panel folder-panel">
-          <div className="panel-header">
-            <div>
-              <h2>Export Folders</h2>
-              <p>Open these folders to access files by tenant.</p>
-            </div>
-          </div>
-          <div className="folder-list">
-            {folderSummary.map((folder) => (
-              <div className="folder-item" key={folder.folderPath}>
-                <div className="folder-item__title">{folder.tenantName}</div>
-                <div className="folder-item__path">{folder.folderPath}</div>
-              </div>
-            ))}
-          </div>
-        </section>
-      ) : null}
-
-      <section className="panel results-panel">
-        <div className="panel-header">
-          <div>
-            <h2>Export Results</h2>
-            <p>Track what is ready and download instantly.</p>
-          </div>
-          {exportResults.length && selectedTenantName ? (
-            <div className="export-filter">
-              <label className="type-item">
-                <input
-                  type="checkbox"
-                  checked={showAllTenants}
-                  onChange={(e) => setShowAllTenants(e.target.checked)}
-                />
-                Show all tenants
-              </label>
-              {!showAllTenants && selectedTenantName ? (
-                <span className="export-filter__note">
-                  Showing: {selectedTenantName}
-                </span>
-              ) : null}
-              {showAllTenants ? (
-                <label className="type-item">
-                  <input
-                    type="checkbox"
-                    checked={groupByTenant}
-                    onChange={(e) => setGroupByTenant(e.target.checked)}
-                  />
-                  Group by tenant
-                </label>
-              ) : null}
-            </div>
-          ) : null}
-        </div>
-
-        <div className="status-banner">{status}</div>
-
-        {exportResults.length ? (
-          showAllTenants && groupByTenant ? (
-            <div className="tenant-groups">
-              {groupedResults.map((group) => (
-                <div className="tenant-group" key={group.tenant}>
-                  <button
-                    className="tenant-group__header"
-                    onClick={() =>
-                      setOpenTenants((prev) => ({
-                        ...prev,
-                        [group.tenant]: !prev[group.tenant],
-                      }))
-                    }
-                  >
-                    <h3>{group.tenant}</h3>
-                    <span>{group.items.length} exports</span>
-                  </button>
-                  {openTenants[group.tenant] ? (
-                    <div className="export-results export-results--table">
-                      <div className="export-results__header">
-                        <span>Type</span>
-                        <span>Status</span>
-                        <span>Detail</span>
-                        <span>Downloads</span>
-                      </div>
-                      {group.items.map((result) => (
-                        <div
-                          className="export-result export-result--row"
-                          key={`${result.runId || "run"}-${result.type}`}
-                        >
-                          <div className="export-result__type">{result.type}</div>
-                          <div
-                            className={`export-result__status export-result__status--${result.status
-                              .toLowerCase()
-                              .replace(/\s+/g, "-")}`}
-                          >
-                            {result.status}
-                          </div>
-                          <div className="export-result__detail">
-                            {result.detail || "-"}
-                          </div>
-                          <div className="export-result__download">
-                            {result.status === "Ready" ? (
-                              <>
-                                <a className="btn btn--excel" href={result.excelUrl}>
-                                  Excel
-                                </a>
-                                <a className="btn btn--csv" href={result.csvUrl}>
-                                  CSV
-                                </a>
-                                <a className="btn btn--json" href={result.jsonUrl}>
-                                  JSON
-                                </a>
-                              </>
-                            ) : (
-                              <span className="export-result__muted">-</span>
-                            )}
-                          </div>
-                        </div>
-                      ))}
-                    </div>
-                  ) : null}
-                </div>
-              ))}
-            </div>
-          ) : (
-            <div className="export-results export-results--table">
-              <div className="export-results__header">
-                <span>Type</span>
-                <span>Tenant</span>
-                <span>Status</span>
-                <span>Detail</span>
-                <span>Downloads</span>
-              </div>
-              {exportResults
-                .filter((result) => {
-                  if (!selectedTenantName) return false;
-                  if (showAllTenants) return true;
-                  return result.tenantName === selectedTenantName;
-                })
-                .map((result) => (
-                  <div
-                    className="export-result export-result--row"
-                    key={`${result.runId || "run"}-${result.type}`}
-                  >
-                    <div className="export-result__type">{result.type}</div>
-                    <div className="export-result__tenant">
-                      {result.tenantName || "-"}
-                    </div>
-                    <div
-                      className={`export-result__status export-result__status--${result.status
-                        .toLowerCase()
-                        .replace(/\s+/g, "-")}`}
-                    >
-                      {result.status}
-                    </div>
-                    <div className="export-result__detail">
-                      {result.detail || "-"}
-                    </div>
-                    <div className="export-result__download">
-                      {result.status === "Ready" ? (
-                        <>
-                          <a className="btn btn--excel" href={result.excelUrl}>
-                            Excel
-                          </a>
-                          <a className="btn btn--csv" href={result.csvUrl}>
-                            CSV
-                          </a>
-                          <a className="btn btn--json" href={result.jsonUrl}>
-                            JSON
-                          </a>
-                        </>
-                      ) : (
-                        <span className="export-result__muted">-</span>
-                      )}
-                    </div>
-                  </div>
-                ))}
-            </div>
-          )
-        ) : null}
-      </section>
-    </div>
-  );
-}
-
-export default App;
-
