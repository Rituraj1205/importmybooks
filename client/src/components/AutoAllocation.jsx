import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = (() => {
  const path = window.location.pathname;
  if (path.startsWith("/xero-data-extraction/")) return "/xero-data-extraction/api";
  return "/api";
})();

const MATCH_META = {
  exact:           { label: "Exact",           color: "#22c55e", dark: "#16a34a", bg: "rgba(34,197,94,0.10)",   dot: "#22c55e" },
  partial_credit:  { label: "Partial (Credit)", color: "#3b82f6", dark: "#2563eb", bg: "rgba(59,130,246,0.10)", dot: "#3b82f6" },
  partial_invoice: { label: "Partial (Invoice)",color: "#f59e0b", dark: "#d97706", bg: "rgba(245,158,11,0.10)", dot: "#f59e0b" },
  partial:         { label: "Partial",           color: "#f59e0b", dark: "#d97706", bg: "rgba(245,158,11,0.10)", dot: "#f59e0b" },
  no_match:        { label: "No Match",          color: "#ef4444", dark: "#dc2626", bg: "rgba(239,68,68,0.10)",  dot: "#ef4444" },
};

function fmt(n, currency) {
  if (!Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "GBP", minimumFractionDigits: 2 }).format(n);
  } catch {
    return `${currency || "GBP"} ${Number(n).toFixed(2)}`;
  }
}

function MatchBadge({ matchType }) {
  const m = MATCH_META[matchType] || MATCH_META.partial;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: m.bg, color: m.color, letterSpacing: "0.01em", whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.dot, display: "inline-block", flexShrink: 0 }} />
      {m.label}
    </span>
  );
}

function StatCard({ label, value, sub, color, icon }) {
  return (
    <div className="aa-stat-card" style={{ "--card-accent": color }}>
      <div className="aa-stat-icon">{icon}</div>
      <div className="aa-stat-label">{label}</div>
      <div className="aa-stat-value">{value}</div>
      {sub && <div className="aa-stat-sub">{sub}</div>}
    </div>
  );
}

export default function AutoAllocation({ userToken, tenantId, sessionId, onBack }) {
  const [mode, setMode] = useState("all");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [analyzeResult, setAnalyzeResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [filterMatch, setFilterMatch] = useState("all");
  const [filterContact, setFilterContact] = useState("");
  const [filterCurrency, setFilterCurrency] = useState("all");
  const [executing, setExecuting] = useState(false);
  const [execStatus, setExecStatus] = useState(null);
  const [showNoMatch, setShowNoMatch] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const pollRef = useRef(null);

  // Fix Allocation Dates state
  const [showFixDates, setShowFixDates] = useState(false);
  const [fixFile, setFixFile] = useState(null);
  const [fixRows, setFixRows] = useState([]);
  const [fixParseError, setFixParseError] = useState("");
  const [fixStatus, setFixStatus] = useState(null);
  const [fixRunning, setFixRunning] = useState(false);
  const fixPollRef = useRef(null);

  // Remove Allocations state
  const [showRemoveAlloc, setShowRemoveAlloc] = useState(false);
  const [removeMode, setRemoveMode] = useState("all");
  const [removeFromDate, setRemoveFromDate] = useState("");
  const [removeToDate, setRemoveToDate] = useState("");
  const [filterBy, setFilterBy] = useState("cn_date");
  const [cnNumber, setCnNumber] = useState("");
  const [removeStatus, setRemoveStatus] = useState(null);
  const [removeRunning, setRemoveRunning] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const removePollRef = useRef(null);
  // Scan (dry-run) state
  const [scanStatus, setScanStatus] = useState(null); // null | { status, phase, processed, total, scanCount, scanBreakdown }
  const [scanRunning, setScanRunning] = useState(false);
  const [scanError, setScanError] = useState("");
  const scanPollRef = useRef(null);
  // Track which params the scan was run for (to detect stale scan)
  const [scanParams, setScanParams] = useState(null);

  const [showRemovePayments, setShowRemovePayments] = useState(false);
  const [removePaymentsStatus, setRemovePaymentsStatus] = useState(null);
  const [removePaymentsRunning, setRemovePaymentsRunning] = useState(false);
  const [removePaymentsError, setRemovePaymentsError] = useState("");
  const removePaymentsPollRef = useRef(null);

  const SOURCE_MODES = ["spend-overpayments","receive-overpayments","spend-prepayments","receive-prepayments"];
  const isSourceMode = SOURCE_MODES.includes(mode);
  const isPrepayMode = mode === "spend-prepayments" || mode === "receive-prepayments";
  const isReceiveMode = mode === "receive-overpayments" || mode === "receive-prepayments";
  const isAllMode = mode === "all";
  const sourceLabel = isAllMode ? "Source" : isPrepayMode ? "Prepayment" : isSourceMode ? "Overpayment" : "Credit Note";
  const targetLabel = isAllMode ? "Invoice / Bill" : isReceiveMode ? "Invoice" : isSourceMode ? "Bill" : "Invoice / Bill";

  useEffect(() => () => { clearInterval(pollRef.current); clearInterval(fixPollRef.current); clearInterval(removePollRef.current); clearInterval(removePaymentsPollRef.current); clearInterval(scanPollRef.current); }, []);

  const authHeaders = { "x-user-token": userToken, "x-session-id": sessionId, "x-tenant-id": tenantId, "Content-Type": "application/json" };

  const showConfirm = (message, onConfirm) => setConfirmDialog({ message, onConfirm });

  const downloadSampleCsv = () => {
    const csv = [
      ["Source Reference", "Invoice/Bill Number", "Amount", "Correct Date"],
      ["AP-7", "INV-1001", "50.30", "05/08/2026"],
      ["AP-12", "BILL-2345", "120.00", "10/08/2026"],
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: "fix-dates-sample.csv" }).click();
    URL.revokeObjectURL(url);
  };

  // Fix dates CSV parser
  const parseFixDatesCsv = (text) => {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { rows: [], error: "File is empty." };
    // Detect header
    const firstLower = lines[0].toLowerCase();
    const hasHeader = firstLower.includes("source") || firstLower.includes("reference") || firstLower.includes("invoice") || firstLower.includes("date");
    const dataLines = hasHeader ? lines.slice(1) : lines;
    if (!dataLines.length) return { rows: [], error: "No data rows found." };
    const rows = [];
    for (const line of dataLines) {
      if (!line.trim()) continue;
      const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
      if (cols.length < 4) continue;
      const [sourceRef, invoiceRef, amount, rawDate] = cols;
      if (!sourceRef || !invoiceRef || !rawDate) continue;
      // Parse date: DD/MM/YYYY → YYYY-MM-DD
      let correctDate = rawDate;
      const dmyMatch = rawDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (dmyMatch) correctDate = `${dmyMatch[3]}-${dmyMatch[2].padStart(2,"0")}-${dmyMatch[1].padStart(2,"0")}`;
      rows.push({ sourceRef: sourceRef.trim(), invoiceRef: invoiceRef.trim(), amount: parseFloat(amount) || 0, correctDate });
    }
    if (!rows.length) return { rows: [], error: "No valid rows found. Check format." };
    return { rows, error: null };
  };

  const handleFixFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFixFile(file);
    setFixParseError("");
    setFixRows([]);
    setFixStatus(null);
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "xlsx" || ext === "xls") {
      setFixParseError("Excel file detected (.xlsx / .xls). Please save it as CSV first: File → Save As → CSV (Comma delimited), then upload again.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { rows, error } = parseFixDatesCsv(ev.target.result);
      if (error) { setFixParseError(error); return; }
      setFixRows(rows);
    };
    reader.readAsText(file);
  };

  const handleStartFix = () => {
    if (!fixRows.length || !tenantId) return;
    showConfirm(
      `Fix dates for ${fixRows.length} allocation${fixRows.length !== 1 ? "s" : ""} in Xero?\n\nThis will delete and re-create each allocation with the correct date. This action cannot be undone.`,
      async () => {
        setFixRunning(true);
        setFixStatus(null);
        clearInterval(fixPollRef.current);
        try {
          const res = await fetch(`${API_BASE}/fix-allocation-dates/start`, {
            method: "POST", headers: authHeaders,
            body: JSON.stringify({ tenantId, sessionId, rows: fixRows }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "Failed to start.");
          fixPollRef.current = setInterval(async () => {
            try {
              const sr = await fetch(`${API_BASE}/fix-allocation-dates/status?jobId=${data.jobId}`, { headers: { "x-user-token": userToken } });
              if (sr.status === 401) {
                clearInterval(fixPollRef.current);
                setFixRunning(false);
                setFixParseError("Session expired. Please log out and log in again to continue.");
                return;
              }
              const sd = await sr.json();
              if (sd.ok) {
                setFixStatus(sd);
                if (["completed", "completed_with_errors", "error"].includes(sd.status)) {
                  clearInterval(fixPollRef.current);
                  setFixRunning(false);
                }
              }
            } catch (_) {}
          }, 1500);
        } catch (err) {
          setFixParseError(err.message);
          setFixRunning(false);
        }
      }
    );
  };

  const downloadFixReport = () => {
    const results = fixStatus?.results || [];
    if (!results.length) return;
    const csv = [
      ["Source Ref", "Invoice/Bill Ref", "Amount", "Status", "Message"],
      ...results.map(r => [r.sourceRef, r.invoiceRef, r.amount, r.status, (r.message || "").replace(/,/g, ";")])
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `fix-dates-report-${new Date().toISOString().slice(0,10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const downloadFixRemaining = () => {
    const results = fixStatus?.results || [];
    const remaining = results.filter(r => r.status === "error");
    if (!remaining.length) return;
    // Same format as input CSV — can be directly re-uploaded
    const csv = [
      ["Source Reference", "Invoice/Bill Number", "Amount", "Correct Date"],
      ...remaining.map(r => [r.sourceRef, r.invoiceRef, r.amount, r.correctDate || ""])
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `fix-dates-remaining-${new Date().toISOString().slice(0,10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const handleScanAllocations = async () => {
    if (!tenantId || scanRunning || removeRunning) return;
    clearInterval(scanPollRef.current);
    setScanRunning(true);
    setScanStatus(null);
    setScanError("");
    setScanParams({ mode: removeMode, fromDate: removeFromDate, toDate: removeToDate, filterBy });
    try {
      const res = await fetch(`${API_BASE}/remove-allocations/scan`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ tenantId, sessionId, mode: removeMode, fromDate: removeFromDate || undefined, toDate: removeToDate || undefined, filterBy, cnNumber: cnNumber || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to start scan.");
      scanPollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`${API_BASE}/remove-allocations/status?jobId=${data.jobId}`, { headers: { "x-user-token": userToken } });
          const sd = await sr.json();
          if (sd.ok) {
            setScanStatus(sd);
            if (["scan_complete", "completed", "error"].includes(sd.status)) {
              clearInterval(scanPollRef.current);
              setScanRunning(false);
            }
          }
        } catch (_) {}
      }, 1500);
    } catch (err) {
      setScanError(err.message);
      setScanRunning(false);
    }
  };

  const handleStartRemove = async () => {
    if (!tenantId || removeRunning) return;
    setRemoveRunning(true);
    setRemoveStatus(null);
    setRemoveError("");
    clearInterval(removePollRef.current);
    try {
      const res = await fetch(`${API_BASE}/remove-allocations/start`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ tenantId, sessionId, mode: removeMode, fromDate: removeFromDate || undefined, toDate: removeToDate || undefined, filterBy, cnNumber: cnNumber || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Failed to start.");
      removePollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`${API_BASE}/remove-allocations/status?jobId=${data.jobId}`, { headers: { "x-user-token": userToken } });
          if (sr.status === 401) {
            clearInterval(removePollRef.current);
            setRemoveRunning(false);
            setRemoveError("Session expired. Please log out and log in again.");
            return;
          }
          const sd = await sr.json();
          if (sd.ok) {
            setRemoveStatus(sd);
            if (["completed", "completed_with_errors", "error"].includes(sd.status)) {
              clearInterval(removePollRef.current);
              setRemoveRunning(false);
            }
          }
        } catch (_) {}
      }, 1500);
    } catch (err) {
      setRemoveError(err.message);
      setRemoveRunning(false);
    }
  };

  const downloadRemoveReport = () => {
    const results = removeStatus?.results || [];
    if (!results.length) return;
    const csv = [
      ["Type", "Source Ref", "Allocation ID", "Status", "Message"],
      ...results.map(r => [r.type, r.sourceRef, r.allocationId, r.status, (r.message || "").replace(/,/g, ";")])
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `remove-allocations-${new Date().toISOString().slice(0,10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const handleStartRemovePayments = () => {
    if (!tenantId) return;
    showConfirm(
      `Remove ALL payments from paid invoices?\n\nThis will permanently void all payments on sales invoices — they will return to "Awaiting Payment" status. This cannot be undone.`,
      async () => {
        setRemovePaymentsRunning(true);
        setRemovePaymentsStatus(null);
        setRemovePaymentsError("");
        clearInterval(removePaymentsPollRef.current);
        try {
          const res = await fetch(`${API_BASE}/remove-invoice-payments/start`, {
            method: "POST", headers: authHeaders,
            body: JSON.stringify({ tenantId, sessionId }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "Failed to start.");
          removePaymentsPollRef.current = setInterval(async () => {
            try {
              const sr = await fetch(`${API_BASE}/remove-invoice-payments/status?jobId=${data.jobId}`, { headers: { "x-user-token": userToken } });
              if (sr.status === 401) { clearInterval(removePaymentsPollRef.current); setRemovePaymentsRunning(false); setRemovePaymentsError("Session expired."); return; }
              const sd = await sr.json();
              if (sd.ok) {
                setRemovePaymentsStatus(sd);
                if (["completed", "completed_with_errors", "error"].includes(sd.status)) {
                  clearInterval(removePaymentsPollRef.current);
                  setRemovePaymentsRunning(false);
                }
              }
            } catch (_) {}
          }, 1500);
        } catch (err) {
          setRemovePaymentsError(err.message);
          setRemovePaymentsRunning(false);
        }
      }
    );
  };

  const downloadRemovePaymentsReport = () => {
    const results = removePaymentsStatus?.results || [];
    if (!results.length) return;
    const csv = [
      ["Invoice Number", "Payment ID", "Payment Type", "Status", "Message"],
      ...results.map(r => [r.invoiceNumber, r.paymentId, r.paymentType || "", r.status, (r.message || "").replace(/,/g, ";")])
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `remove-invoice-payments-${new Date().toISOString().slice(0,10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const handleAnalyze = useCallback(async () => {
    if (!tenantId) { setAnalyzeError("Select a Xero organisation in the Import tool first."); return; }
    setAnalyzing(true);
    setAnalyzeError("");
    setAnalyzeResult(null);
    setSelected(new Set());
    setExecStatus(null);
    try {
      const res = await fetch(`${API_BASE}/auto-allocation/analyze`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ tenantId, sessionId, mode, fromDate: fromDate || undefined, toDate: toDate || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Analysis failed.");
      setAnalyzeResult(data);
      setSelected(new Set(data.suggestions.map((_, i) => i)));
    } catch (err) {
      setAnalyzeError(err.message);
    } finally {
      setAnalyzing(false);
    }
  }, [tenantId, sessionId, mode, fromDate, toDate]);

  const suggestions = analyzeResult?.suggestions || [];
  const noMatch = analyzeResult?.noMatchCredits || [];
  const currencies = [...new Set(suggestions.map(s => s.currency))].sort();

  const visible = suggestions.filter(s => {
    if (filterMatch !== "all") {
      if (filterMatch === "partial") {
        if (!["partial", "partial_credit", "partial_invoice"].includes(s.matchType)) return false;
      } else {
        if (s.matchType !== filterMatch) return false;
      }
    }
    if (filterCurrency !== "all" && s.currency !== filterCurrency) return false;
    if (filterContact && !s.contactName.toLowerCase().includes(filterContact.toLowerCase())) return false;
    return true;
  });
  const visibleOriginalIds = visible.map(s => suggestions.indexOf(s));
  const allVisibleSelected = visibleOriginalIds.length > 0 && visibleOriginalIds.every(i => selected.has(i));

  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleOriginalIds.forEach(i => next.delete(i));
      else visibleOriginalIds.forEach(i => next.add(i));
      return next;
    });
  };
  const toggleRow = idx => setSelected(prev => { const next = new Set(prev); next.has(idx) ? next.delete(idx) : next.add(idx); return next; });
  const selectedSuggestions = suggestions.filter((_, i) => selected.has(i));

  const handleExecute = useCallback(() => {
    if (!selectedSuggestions.length) return;
    showConfirm(
      `Apply ${selectedSuggestions.length} allocation${selectedSuggestions.length !== 1 ? "s" : ""} in Xero?\n\nThis will write allocations directly to your Xero account. This action cannot be undone.`,
      async () => {
        setExecuting(true);
        setExecStatus(null);
        clearInterval(pollRef.current);
        try {
          const res = await fetch(`${API_BASE}/auto-allocation/execute/start`, {
            method: "POST", headers: authHeaders,
            body: JSON.stringify({ tenantId, sessionId, suggestions: selectedSuggestions }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.error || "Failed to start.");
          pollRef.current = setInterval(async () => {
            try {
              const sr = await fetch(`${API_BASE}/auto-allocation/execute/status?jobId=${data.jobId}`, { headers: { "x-user-token": userToken } });
              if (sr.status === 401) {
                clearInterval(pollRef.current);
                setExecuting(false);
                setAnalyzeError("Session expired. Please log out and log in again to continue.");
                return;
              }
              const sd = await sr.json();
              if (sd.ok) {
                setExecStatus(sd);
                if (["completed", "completed_with_errors", "error"].includes(sd.status)) {
                  clearInterval(pollRef.current);
                  setExecuting(false);
                }
              }
            } catch (_) {}
          }, 1200);
        } catch (err) {
          setAnalyzeError(err.message);
          setExecuting(false);
        }
      }
    );
  }, [selectedSuggestions, tenantId, sessionId, userToken]);

  const downloadAudit = () => {
    const results = execStatus?.results || [];
    if (!results.length) return;
    const csv = [
      ["Contact", isSourceMode ? `${sourceLabel} Ref` : "Credit Note", isSourceMode ? targetLabel : "Invoice", "Amount", "Currency", "Match Type", "Status", "Date", "Message"],
      ...results.map(r => [r.contactName, r.creditNoteNumber, r.invoiceNumber, r.amount, r.currency, r.matchType, r.status, r.date, (r.message || "").replace(/,/g, ";")])
    ].map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    Object.assign(document.createElement("a"), { href: url, download: `allocation-audit-${new Date().toISOString().slice(0, 10)}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  const isDone = execStatus && ["completed", "completed_with_errors", "error"].includes(execStatus.status);
  const pct = execStatus ? Math.round((execStatus.processed / Math.max(1, execStatus.total)) * 100) : 0;

  return (
    <div className="aa-root">

      {/* ── Confirm Dialog ── */}
      {confirmDialog && (
        <div className="aa-confirm-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="aa-confirm-box" onClick={e => e.stopPropagation()}>
            <div className="aa-confirm-icon">⚠</div>
            <div className="aa-confirm-message">
              {confirmDialog.message.split("\n\n").map((para, i) => (
                <p key={i} style={{ margin: i === 0 ? 0 : "10px 0 0" }}>{para}</p>
              ))}
            </div>
            <div className="aa-confirm-actions">
              <button className="aa-confirm-cancel" onClick={() => setConfirmDialog(null)}>Cancel</button>
              <button className="aa-confirm-ok" onClick={() => { const fn = confirmDialog.onConfirm; setConfirmDialog(null); fn(); }}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <header className="aa-header">
        <div className="aa-header-inner">
          <div className="aa-header-left">
            {onBack && (
              <button className="aa-back-btn" onClick={onBack}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                Back
              </button>
            )}
            <div className="aa-header-icon">⇌</div>
            <div>
              <div className="aa-header-title">
                Smart Auto Allocation
                <span className="aa-header-badge">Smart Matching</span>
              </div>
              <div className="aa-header-sub">Group by contact &amp; currency · Oldest invoice first · Exact match priority</div>
            </div>
          </div>
        </div>
      </header>

      <div className="aa-body">

        {/* ── Control bar ── */}
        <div className="aa-control-bar">
          {/* Primary: Analyse Everything */}
          <div className="aa-all-wrap">
            <button
              className={`aa-all-btn${mode === "all" ? " aa-all-btn--active" : ""}`}
              onClick={() => { setMode("all"); setAnalyzeResult(null); setExecStatus(null); }}
            >
              <span className="aa-all-icon">⊛</span>
              <div>
                <div className="aa-all-title">Analyse Everything</div>
                <div className="aa-all-sub">Credit Notes · Overpayments · Prepayments — all at once</div>
              </div>
            </button>
          </div>

          <div className="aa-control-sep" />

          {/* Advanced toggle */}
          <div className="aa-control-section">
            <button className="aa-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
              {showAdvanced ? "▲" : "▼"} Specific type only
            </button>
            {showAdvanced && (
              <div className="aa-advanced-grid">
                <div className="aa-adv-group">
                  <div className="aa-adv-label">Credit Notes</div>
                  <div className="aa-seg">
                    {[{value:"both",label:"Both",icon:"⇅"},{value:"sales",label:"Sales",icon:"↑"},{value:"purchase",label:"Purchase",icon:"↓"}].map(opt => (
                      <button key={opt.value} className={`aa-seg-btn${mode===opt.value?" aa-seg-btn--active":""}`}
                        onClick={()=>{setMode(opt.value);setAnalyzeResult(null);setExecStatus(null);}}>
                        <span className="aa-seg-icon">{opt.icon}</span>{opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="aa-adv-group">
                  <div className="aa-adv-label">Overpayments</div>
                  <div className="aa-seg">
                    {[{value:"spend-overpayments",label:"Spend→Bills",icon:"⊖"},{value:"receive-overpayments",label:"Receive→Inv",icon:"⊕"}].map(opt => (
                      <button key={opt.value} className={`aa-seg-btn${mode===opt.value?" aa-seg-btn--active":""}`}
                        onClick={()=>{setMode(opt.value);setAnalyzeResult(null);setExecStatus(null);}}>
                        <span className="aa-seg-icon">{opt.icon}</span>{opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="aa-adv-group">
                  <div className="aa-adv-label">Prepayments</div>
                  <div className="aa-seg">
                    {[{value:"spend-prepayments",label:"Spend→Bills",icon:"◁"},{value:"receive-prepayments",label:"Receive→Inv",icon:"▷"}].map(opt => (
                      <button key={opt.value} className={`aa-seg-btn${mode===opt.value?" aa-seg-btn--active":""}`}
                        onClick={()=>{setMode(opt.value);setAnalyzeResult(null);setExecStatus(null);}}>
                        <span className="aa-seg-icon">{opt.icon}</span>{opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="aa-control-spacer" />

          {/* Date range */}
          <div className="aa-control-section">
            <div className="aa-control-label">Date range (optional)</div>
            <div className="aa-date-range">
              <input type="date" className="aa-date-input" value={fromDate}
                onChange={e => { setFromDate(e.target.value); setAnalyzeResult(null); setExecStatus(null); }}
                disabled={analyzing || executing} title="From date" />
              <span className="aa-date-sep">–</span>
              <input type="date" className="aa-date-input" value={toDate}
                onChange={e => { setToDate(e.target.value); setAnalyzeResult(null); setExecStatus(null); }}
                disabled={analyzing || executing} title="To date" />
              {(fromDate || toDate) && (
                <button className="aa-date-clear" onClick={() => { setFromDate(""); setToDate(""); setAnalyzeResult(null); setExecStatus(null); }} title="Clear dates">×</button>
              )}
            </div>
          </div>

          <button
            className={`aa-analyse-btn${analyzing ? " aa-analyse-btn--loading" : ""}`}
            onClick={handleAnalyze}
            disabled={analyzing || executing}
          >
            {analyzing
              ? <><span className="aa-spin">◌</span> Scanning Xero…</>
              : <><span>⬡</span> {analyzeResult ? "Re-Analyse" : (mode === "all" ? "Analyse Everything" : "Analyse Now")}</>
            }
          </button>
        </div>

        {/* ── Error ── */}
        {analyzeError && (
          <div className="aa-error">
            <span>⚠</span> {analyzeError}
            <button className="aa-error-close" onClick={() => setAnalyzeError("")}>×</button>
          </div>
        )}

        {/* ── Scanning state ── */}
        {analyzing && (
          <div className="aa-scanning">
            <div className="aa-scanning-rings">
              <div className="aa-ring aa-ring-1" />
              <div className="aa-ring aa-ring-2" />
              <div className="aa-ring aa-ring-3" />
              <div className="aa-scanning-icon">⇌</div>
            </div>
            <div className="aa-scanning-title">Scanning Xero…</div>
            <div className="aa-scanning-sub">{isAllMode ? "Fetching credit notes, overpayments & prepayments — all types together" : isSourceMode ? `Fetching all ${sourceLabel.toLowerCase()}s & outstanding ${targetLabel.toLowerCase()}s` : "Fetching all credit notes & outstanding invoices"}</div>
            <div className="aa-scanning-steps">
              <div className="aa-step aa-step--active">● {isAllMode ? "Fetching all credit notes, overpayments & prepayments" : isSourceMode ? `Fetching ${sourceLabel.toLowerCase()}s` : "Fetching credit notes"}</div>
              <div className="aa-step">● Fetching invoices &amp; bills</div>
              <div className="aa-step">● Running matching engine</div>
            </div>
          </div>
        )}

        {/* ── Results ── */}
        {analyzeResult && !analyzing && (
          <>
            {/* Stats */}
            <div className="aa-stats-row">
              <StatCard label={isAllMode ? "Total Sources" : isSourceMode ? `${sourceLabel}s` : "Credit Notes"} value={analyzeResult.totalCreditNotes} sub={isAllMode ? "credit notes + overpayments + prepayments" : "with remaining credit"} color="#3b82f6" icon="◈" />
              <StatCard label={isAllMode ? "Bills & Invoices" : `${targetLabel}s Found`} value={analyzeResult.totalInvoices} sub="outstanding &amp; authorised" color="#8b5cf6" icon="◉" />
              <StatCard label="Exact Matches" value={analyzeResult.stats.exact} sub={`${sourceLabel.toLowerCase()} = ${targetLabel.toLowerCase()} precisely`} color="#22c55e" icon="⬤" />
              <StatCard label="Partial Matches" value={analyzeResult.stats.partial} sub="split or over/under" color="#f59e0b" icon="◑" />
              <StatCard label="No Match" value={analyzeResult.stats.noMatch} sub={`no outstanding ${targetLabel.toLowerCase()}s`} color="#ef4444" icon="○" />
              <StatCard
                label="Total to Allocate"
                value={fmt(analyzeResult.stats.totalAmount, suggestions[0]?.currency)}
                sub={`${suggestions.length} allocation${suggestions.length !== 1 ? "s" : ""} suggested`}
                color="var(--accent)"
                icon="∑"
              />
            </div>

            {/* Progress panel */}
            {(executing || execStatus) && (
              <div className={`aa-progress-panel${isDone ? (execStatus?.errors > 0 ? " aa-progress-panel--warn" : " aa-progress-panel--done") : ""}`}>
                <div className="aa-progress-header">
                  <div className="aa-progress-title">
                    {isDone
                      ? execStatus?.errors > 0 ? "⚠ Completed with errors" : "✓ All allocations applied"
                      : <><span className="aa-spin">◌</span> Applying allocations in Xero…</>
                    }
                  </div>
                  <div className="aa-progress-count">
                    <span style={{ fontWeight: 700, color: "var(--ink)" }}>{execStatus?.processed ?? 0}</span>
                    <span style={{ color: "var(--muted)" }}> / {execStatus?.total ?? selectedSuggestions.length}</span>
                  </div>
                </div>
                <div className="aa-progress-track">
                  <div
                    className={`aa-progress-fill${!isDone ? " aa-progress-fill--shimmer" : ""}`}
                    style={{
                      width: `${pct}%`,
                      background: isDone && execStatus?.errors > 0 ? "#f59e0b" : isDone ? "#22c55e" : "linear-gradient(90deg,var(--accent),var(--accent-blue))",
                    }}
                  />
                </div>
                {execStatus?.currentItem && !isDone && (
                  <div className="aa-progress-current">↪ {execStatus.currentItem}</div>
                )}
                {isDone && (
                  <div className="aa-progress-footer">
                    <div className="aa-progress-results">
                      <span className="aa-tag aa-tag--success">✓ {execStatus.created} allocated</span>
                      {execStatus.errors > 0 && <span className="aa-tag aa-tag--error">✗ {execStatus.errors} errors</span>}
                    </div>
                    <button className="aa-audit-btn" onClick={downloadAudit}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download Audit Report
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Table */}
            {suggestions.length > 0 && (
              <div className="aa-table-card">
                {/* Filter bar */}
                <div className="aa-filters">
                  <div className="aa-filter-search-wrap">
                    <svg className="aa-filter-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <input
                      className="aa-filter-input aa-filter-search"
                      placeholder="Search contact…"
                      value={filterContact}
                      onChange={e => setFilterContact(e.target.value)}
                    />
                    {filterContact && <button className="aa-filter-clear" onClick={() => setFilterContact("")}>×</button>}
                  </div>

                  <select className="aa-filter-select" value={filterMatch} onChange={e => setFilterMatch(e.target.value)}>
                    <option value="all">All match types</option>
                    <option value="exact">Exact only</option>
                    <option value="partial">All Partial</option>
                    <option value="partial_credit">Partial — Credit side</option>
                    <option value="partial_invoice">Partial — Invoice side</option>
                  </select>

                  {currencies.length > 1 && (
                    <select className="aa-filter-select" value={filterCurrency} onChange={e => setFilterCurrency(e.target.value)}>
                      <option value="all">All currencies</option>
                      {currencies.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}

                  <div className="aa-filter-info">
                    <span>{visible.length} shown</span>
                    <span className="aa-filter-dot">·</span>
                    <strong>{selected.size} selected</strong>
                  </div>
                </div>

                {/* Table */}
                <div className="aa-table-wrap">
                  <table className="aa-table">
                    <thead>
                      <tr>
                        <th className="aa-th aa-th--check">
                          <input type="checkbox" className="aa-checkbox" checked={allVisibleSelected} onChange={toggleAll} />
                        </th>
                        <th className="aa-th">Contact</th>
                        {isAllMode && <th className="aa-th">Type</th>}
                        <th className="aa-th">{isSourceMode ? `${sourceLabel} Ref` : "Credit Note"}</th>
                        <th className="aa-th aa-th--arrow" />
                        <th className="aa-th">{targetLabel}</th>
                        <th className="aa-th">Date</th>
                        <th className="aa-th aa-th--right">Amount</th>
                        <th className="aa-th">Match</th>
                        <th className="aa-th">CCY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((s, vi) => {
                        const origIdx = suggestions.indexOf(s);
                        const isSel = selected.has(origIdx);
                        return (
                          <tr
                            key={`${s.creditNoteId}-${s.invoiceId}-${vi}`}
                            className={`aa-tr${isSel ? " aa-tr--selected" : ""}`}
                            onClick={() => toggleRow(origIdx)}
                          >
                            <td className="aa-td aa-td--check">
                              <input type="checkbox" className="aa-checkbox" checked={isSel} onChange={() => toggleRow(origIdx)} onClick={e => e.stopPropagation()} />
                            </td>
                            <td className="aa-td aa-td--contact" title={s.contactName}>{s.contactName}</td>
                            {isAllMode && <td className="aa-td aa-td--type"><span className={`aa-type-chip aa-type-chip--${s.type || 'cn'}`}>{s.type === "spend-overpayment" ? "Overpay↓" : s.type === "receive-overpayment" ? "Overpay↑" : s.type === "spend-prepayment" ? "Prepay↓" : s.type === "receive-prepayment" ? "Prepay↑" : "Cr. Note"}</span></td>}
                            <td className="aa-td aa-td--mono aa-td--cn">{s.creditNoteNumber}</td>
                            <td className="aa-td aa-td--arrow-cell">
                              <span className="aa-arrow">→</span>
                            </td>
                            <td className="aa-td aa-td--mono">{s.invoiceNumber}</td>
                            <td className="aa-td aa-td--date">{s.invoiceDate || "—"}</td>
                            <td className="aa-td aa-td--amount">{fmt(s.amount, s.currency)}</td>
                            <td className="aa-td"><MatchBadge matchType={s.matchType} /></td>
                            <td className="aa-td aa-td--ccy">{s.currency}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {visible.length === 0 && (
                    <div className="aa-table-empty">No suggestions match the current filters.</div>
                  )}
                </div>
              </div>
            )}

            {/* No Match accordion */}
            {noMatch.length > 0 && (
              <div className="aa-nomatch-card">
                <button className="aa-nomatch-toggle" onClick={() => setShowNoMatch(v => !v)}>
                  <div className="aa-nomatch-toggle-left">
                    <span className="aa-nomatch-dot" />
                    <strong>{noMatch.length}</strong> {isSourceMode ? `${sourceLabel.toLowerCase()}${noMatch.length === 1 ? "" : "s"} with no outstanding ${targetLabel.toLowerCase()}s` : `credit ${noMatch.length === 1 ? "note" : "notes"} with no outstanding invoices`}
                  </div>
                  <span className="aa-nomatch-chevron">{showNoMatch ? "▲" : "▼"}</span>
                </button>
                {showNoMatch && (
                  <div className="aa-nomatch-grid">
                    {noMatch.map((nm, i) => (
                      <div key={i} className="aa-nomatch-item">
                        <div className="aa-nomatch-contact">{nm.contactName || "—"}</div>
                        <div className="aa-nomatch-ref">{nm.creditNoteNumber}</div>
                        <div className="aa-nomatch-amount">{fmt(nm.availableCredit, nm.currency)} available</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ── Empty state ── */}
        {!analyzeResult && !analyzing && !analyzeError && (
          <div className="aa-empty">
            <div className="aa-empty-glow" />
            <div className="aa-empty-icon">⇌</div>
            <div className="aa-empty-title">Smart Auto Allocation</div>
            <div className="aa-empty-desc">
              {isAllMode
                ? "All in one go — matches credit notes, overpayments, and prepayments against outstanding bills and invoices, then allocates them automatically."
                : isSourceMode
                  ? `Automatically match ${sourceLabel.toLowerCase()}s to outstanding ${targetLabel.toLowerCase()}s. The engine groups by contact & currency, then allocates oldest ${targetLabel.toLowerCase()}s first.`
                  : "Automatically match credit notes to outstanding invoices. The engine groups by contact & currency, then allocates oldest invoices first."
              }
            </div>
            <div className="aa-legend">
              <div className="aa-legend-item"><span style={{ color: "#22c55e" }}>⬤</span><span><b>Exact</b> — credit = invoice amount</span></div>
              <div className="aa-legend-item"><span style={{ color: "#3b82f6" }}>◑</span><span><b>Partial</b> — credit fills part of invoice</span></div>
              <div className="aa-legend-item"><span style={{ color: "#ef4444" }}>○</span><span><b>No Match</b> — no outstanding invoices</span></div>
            </div>
            <button
              className={`aa-analyse-btn aa-analyse-btn--hero${!tenantId ? " aa-analyse-btn--disabled" : ""}`}
              onClick={handleAnalyze}
              disabled={!tenantId}
            >
              {tenantId ? <><span>⬡</span> Start Analysis</> : "Connect to Xero first"}
            </button>
          </div>
        )}

        {/* ── Utilities ── */}
        <div className="aa-utilities-section">
          <div className="aa-utilities-header">
            <span className="aa-utilities-icon">⚙</span>
            <span className="aa-utilities-label">Utilities</span>
            <span className="aa-utilities-desc">Tools for correcting data after allocation</span>
          </div>
          {/* ── Remove Allocations Panel ── */}
          <div className="aa-fix-dates-panel" style={{ marginTop: 10 }}>
            <button className="aa-fix-dates-toggle" onClick={() => setShowRemoveAlloc(v => !v)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Remove Allocations
              <span className="aa-utilities-badge">Destructive</span>
              <span className="aa-fix-dates-chevron" style={{ marginLeft: "auto" }}>{showRemoveAlloc ? "▲" : "▼"}</span>
            </button>
            {showRemoveAlloc && (
              <div className="aa-fix-dates-body">
                <div className="aa-fix-dates-info" style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                  <strong style={{ color: "#ef4444" }}>⚠ Warning:</strong> This permanently removes allocations from Xero. Invoices will return to outstanding status. Use only if you need to clear allocations before re-running Auto Allocation.
                </div>

                {/* Mode selector */}
                <div style={{ marginBottom: 14 }}>
                  <div className="aa-control-label" style={{ marginBottom: 8 }}>Which allocations should be removed?</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {[
                      { value: "invoices", label: "Invoices only",  icon: "↑", sub: "Sales credit notes · Receive overpayments · Receive prepayments", color: "#3b82f6" },
                      { value: "bills",    label: "Bills only",     icon: "↓", sub: "Purchase credit notes · Spend overpayments · Spend prepayments",  color: "#f59e0b" },
                      { value: "all",      label: "Everything",     icon: "⊛", sub: "Invoices + Bills — all types",                                  color: "#ef4444" },
                    ].map(opt => {
                      const active = removeMode === opt.value;
                      return (
                        <button
                          key={opt.value}
                          onClick={() => { setRemoveMode(opt.value); setRemoveStatus(null); setRemoveError(""); setScanStatus(null); setScanError(""); }}
                          disabled={removeRunning}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                            padding: "10px 16px", borderRadius: 10,
                            border: `2px solid ${active ? opt.color + "99" : "var(--border)"}`,
                            background: active ? opt.color + "14" : "var(--panel-elev)",
                            color: active ? opt.color : "var(--muted)",
                            cursor: removeRunning ? "not-allowed" : "pointer", transition: "all 0.15s", textAlign: "left", minWidth: 170,
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 700 }}>{opt.icon} {opt.label}</span>
                          <span style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.4 }}>{opt.sub}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Date Range — filters credit notes by their creation date */}
                <div style={{ marginBottom: 14 }}>
                  <div className="aa-control-label" style={{ marginBottom: 4 }}>Credit Note Date Range</div>
                  <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>Tool will find all credit notes created in this range and remove their allocations automatically.</div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--muted)" }}>From Date</label>
                      <input type="date" value={removeFromDate} onChange={e => { setRemoveFromDate(e.target.value); setScanStatus(null); setScanError(""); }} disabled={removeRunning || scanRunning}
                        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-elev)", color: "var(--text)", fontSize: 13 }} />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <label style={{ fontSize: 11, color: "var(--muted)" }}>To Date</label>
                      <input type="date" value={removeToDate} onChange={e => { setRemoveToDate(e.target.value); setScanStatus(null); setScanError(""); }} disabled={removeRunning || scanRunning}
                        style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-elev)", color: "var(--text)", fontSize: 13 }} />
                    </div>
                    {(removeFromDate || removeToDate) && (
                      <button onClick={() => { setRemoveFromDate(""); setRemoveToDate(""); setScanStatus(null); setScanError(""); }} disabled={removeRunning || scanRunning}
                        style={{ marginTop: 18, padding: "6px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer" }}>
                        Clear
                      </button>
                    )}
                  </div>
                </div>

                {/* Stale scan warning */}
                {scanStatus?.status === "scan_complete" && !removeRunning && !removeStatus && scanParams && (
                  scanParams.fromDate !== removeFromDate || scanParams.toDate !== removeToDate || scanParams.mode !== removeMode
                ) && (
                  <div style={{ marginBottom: 10, padding: "8px 12px", borderRadius: 8, background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.3)", fontSize: 12, color: "#f59e0b", display: "flex", alignItems: "center", gap: 8 }}>
                    ⚠ Date/mode changed — scan results are stale. Re-scan to get updated count.
                  </div>
                )}

                {/* Step 1: Count / Scan */}
                {!removeRunning && !removeStatus && (
                  <div className="aa-fix-dates-row">
                    <button
                      className={`aa-fix-start-btn${scanRunning || !tenantId ? " aa-fix-start-btn--disabled" : ""}`}
                      onClick={handleScanAllocations}
                      disabled={scanRunning || !tenantId}
                      style={{ background: scanRunning ? undefined : "linear-gradient(135deg,#6366f1,#4f46e5)", boxShadow: scanRunning ? "none" : "0 4px 12px rgba(99,102,241,0.35)" }}
                    >
                      {scanRunning ? <><span className="aa-spin">◌</span> Scanning…</> : scanStatus?.status === "scan_complete" ? "Re-scan" : "Count Allocations"}
                    </button>
                    {!tenantId && <span style={{ fontSize: 12, color: "var(--muted)" }}>Connect to Xero first</span>}
                  </div>
                )}

                {/* Scan progress */}
                {scanRunning && (
                  <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: 8, background: "var(--panel-elev)", border: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: "var(--muted)" }}>{scanStatus?.phase || "Scanning…"}</span>
                      {scanStatus?.total > 0 && (
                        <span style={{ fontSize: 11, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
                          {scanStatus.processed}/{scanStatus.total} · ~{scanStatus.total - scanStatus.processed} API calls left
                        </span>
                      )}
                    </div>
                    <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                      {scanStatus?.total > 0
                        ? <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg,#6366f1,#4f46e5)", width: `${Math.round((scanStatus.processed / scanStatus.total) * 100)}%`, transition: "width 0.3s" }} />
                        : <div style={{ height: "100%", borderRadius: 2, background: "linear-gradient(90deg,#6366f1,#4f46e5)", width: "30%", animation: "aa-indeterminate 1.4s ease-in-out infinite" }} />
                      }
                    </div>
                    {scanStatus?.total > 0 && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "#f59e0b" }}>
                        ⚡ Fetching {scanStatus.total} invoice detail{scanStatus.total !== 1 ? "s" : ""} from Xero…
                      </div>
                    )}
                  </div>
                )}

                {scanError && <div className="aa-fix-error" style={{ marginTop: 8 }}>⚠ {scanError}</div>}

                {/* Scan result + confirm */}
                {!removeRunning && !removeStatus && scanStatus?.status === "scan_complete" && (
                  <div style={{ marginTop: 10, padding: "14px 16px", borderRadius: 10, background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.25)" }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#ef4444", marginBottom: 6 }}>
                      Found {scanStatus.scanCount} allocation{scanStatus.scanCount !== 1 ? "s" : ""} to remove
                    </div>
                    {scanStatus.scanBreakdown && (
                      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12, display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {scanStatus.scanBreakdown.creditNotes > 0 && <span>CN Allocations: <b style={{ color: "var(--text)" }}>{scanStatus.scanBreakdown.creditNotes}</b></span>}
                        {scanStatus.scanBreakdown.overpayments > 0 && <span>Overpayment Allocations: <b style={{ color: "var(--text)" }}>{scanStatus.scanBreakdown.overpayments}</b></span>}
                        {scanStatus.scanBreakdown.prepayments > 0 && <span>Prepayment Allocations: <b style={{ color: "var(--text)" }}>{scanStatus.scanBreakdown.prepayments}</b></span>}
                        {scanStatus.scanCount === 0 && <span style={{ color: "var(--muted)" }}>Nothing to remove with current filters.</span>}
                      </div>
                    )}
                    {scanStatus.scanCount > 0 && (
                      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                        <button
                          className="aa-fix-start-btn"
                          onClick={handleStartRemove}
                          style={{ background: "linear-gradient(135deg,#ef4444,#dc2626)", boxShadow: "0 4px 12px rgba(239,68,68,0.35)" }}
                        >
                          Confirm &amp; Remove {scanStatus.scanCount}
                        </button>
                        <button onClick={() => { setScanStatus(null); setScanError(""); }}
                          style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer" }}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {scanStatus.scanCount === 0 && (
                      <button onClick={() => { setScanStatus(null); setScanError(""); }}
                        style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 12, cursor: "pointer" }}>
                        OK
                      </button>
                    )}
                  </div>
                )}

                {removeError && <div className="aa-fix-error" style={{ marginTop: 8 }}>⚠ {removeError}</div>}

                {/* Delete progress */}
                {removeStatus && (() => {
                  const done = ["completed", "completed_with_errors", "error"].includes(removeStatus.status);
                  const pct = Math.round((removeStatus.processed / Math.max(1, removeStatus.total)) * 100);
                  return (
                    <div className={`aa-fix-progress${done ? " aa-fix-progress--done" : ""}`} style={{ marginTop: 10, ...(done && removeStatus.errors === 0 ? { borderColor: "#22c55e" } : done && removeStatus.errors > 0 && removeStatus.deleted === 0 ? { borderColor: "#ef4444" } : done ? { borderColor: "#f59e0b" } : {}) }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          {removeStatus.status === "completed" ? "✓ Done — all allocations removed" :
                           removeStatus.status === "completed_with_errors" ? "⚠ Done with some errors" :
                           removeStatus.status === "error" ? `✗ ${removeStatus.error || "Error"}` :
                           removeStatus.phase || "Running…"}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{removeStatus.processed}/{removeStatus.total}</span>
                      </div>
                      <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                        <div style={{
                          height: "100%", borderRadius: 2, transition: "width 0.3s", width: `${pct}%`,
                          background: done && removeStatus.errors > 0 && removeStatus.deleted === 0 ? "#ef4444" : done && removeStatus.errors > 0 ? "#f59e0b" : done ? "#22c55e" : "linear-gradient(90deg,#ef4444,#dc2626)",
                        }} />
                      </div>
                      {removeStatus.currentItem && !done && (
                        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>↪ {removeStatus.currentItem}</div>
                      )}
                      <div style={{ fontSize: 11, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        {removeStatus.deleted > 0 && <span style={{ color: "#22c55e" }}>✓ {removeStatus.deleted} removed</span>}
                        {removeStatus.errors > 0 && <span style={{ color: "#ef4444" }}>✗ {removeStatus.errors} errors</span>}
                        {done && <button onClick={() => { setRemoveStatus(null); setScanStatus(null); }} style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 11, cursor: "pointer" }}>Reset</button>}
                        {done && removeStatus.results?.length > 0 && (
                          <button className="aa-audit-btn" onClick={downloadRemoveReport}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download Report
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          {/* ── Remove Invoice Payments Panel ── */}
          <div className="aa-fix-dates-panel" style={{ marginTop: 10 }}>
            <button className="aa-fix-dates-toggle" onClick={() => setShowRemovePayments(v => !v)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
              Remove Invoice Payments
              <span className="aa-utilities-badge">Destructive</span>
              <span className="aa-fix-dates-chevron" style={{ marginLeft: "auto" }}>{showRemovePayments ? "▲" : "▼"}</span>
            </button>
            {showRemovePayments && (
              <div className="aa-fix-dates-body">
                <div className="aa-fix-dates-info" style={{ background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
                  <strong style={{ color: "#ef4444" }}>⚠ Warning:</strong> This will void all payments on sales invoices. Invoices will return to <strong>"Awaiting Payment"</strong> status. Bank reconciliation links will also be removed. Only use this if payments were applied incorrectly and need to be re-applied.
                </div>
                <div className="aa-fix-dates-row">
                  <button
                    className={`aa-fix-start-btn${removePaymentsRunning || !tenantId ? " aa-fix-start-btn--disabled" : ""}`}
                    onClick={handleStartRemovePayments}
                    disabled={removePaymentsRunning || !tenantId}
                    style={{ background: removePaymentsRunning ? undefined : "linear-gradient(135deg,#ef4444,#dc2626)", boxShadow: removePaymentsRunning ? "none" : "0 4px 12px rgba(239,68,68,0.35)" }}
                  >
                    {removePaymentsRunning ? <><span className="aa-spin">◌</span> Removing…</> : "Remove Invoice Payments"}
                  </button>
                  {!tenantId && <span style={{ fontSize: 12, color: "var(--muted)" }}>Connect to Xero first</span>}
                </div>

                {removePaymentsError && <div className="aa-fix-error">⚠ {removePaymentsError}</div>}

                {removePaymentsStatus && (() => {
                  const done = ["completed", "completed_with_errors", "error"].includes(removePaymentsStatus.status);
                  const pct = Math.round((removePaymentsStatus.processed / Math.max(1, removePaymentsStatus.total)) * 100);
                  return (
                    <div className={`aa-fix-progress${done ? " aa-fix-progress--done" : ""}`} style={done && removePaymentsStatus.errors === 0 ? { borderColor: "#22c55e" } : done && removePaymentsStatus.errors > 0 && removePaymentsStatus.deleted === 0 ? { borderColor: "#ef4444" } : done ? { borderColor: "#f59e0b" } : {}}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          {removePaymentsStatus.status === "completed" ? "✓ Done — all payments removed" :
                           removePaymentsStatus.status === "completed_with_errors" ? "⚠ Done with some errors" :
                           removePaymentsStatus.status === "error" ? `✗ ${removePaymentsStatus.error || "Error"}` :
                           removePaymentsStatus.phase || "Running…"}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{removePaymentsStatus.processed}/{removePaymentsStatus.total}</span>
                      </div>
                      <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                        <div style={{
                          height: "100%", borderRadius: 2, transition: "width 0.3s",
                          width: `${pct}%`,
                          background: done && removePaymentsStatus.errors > 0 && removePaymentsStatus.deleted === 0 ? "#ef4444" : done && removePaymentsStatus.errors > 0 ? "#f59e0b" : done ? "#22c55e" : "linear-gradient(90deg,#ef4444,#dc2626)",
                        }} />
                      </div>
                      {removePaymentsStatus.currentItem && !done && (
                        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>↪ {removePaymentsStatus.currentItem}</div>
                      )}
                      <div style={{ fontSize: 11, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        {removePaymentsStatus.deleted > 0 && <span style={{ color: "#22c55e" }}>✓ {removePaymentsStatus.deleted} removed</span>}
                        {removePaymentsStatus.errors > 0 && <span style={{ color: "#ef4444" }}>✗ {removePaymentsStatus.errors} errors</span>}
                        {done && removePaymentsStatus.results?.length > 0 && (
                          <button className="aa-audit-btn" style={{ marginLeft: "auto" }} onClick={downloadRemovePaymentsReport}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download Report
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          {/* ── Fix Allocation Dates Panel ── */}
          <div className="aa-fix-dates-panel" style={{ marginTop: 10 }}>
            <button className="aa-fix-dates-toggle" onClick={() => setShowFixDates(v => !v)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              Fix Allocation Dates
              <span className="aa-utilities-badge" style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6", borderColor: "rgba(59,130,246,0.25)" }}>CSV Upload</span>
              <span className="aa-fix-dates-chevron" style={{ marginLeft: "auto" }}>{showFixDates ? "▲" : "▼"}</span>
            </button>
            {showFixDates && (
              <div className="aa-fix-dates-body">
                <div className="aa-fix-dates-info">
                  Upload a CSV to re-create allocations with corrected dates. Each row must have: <strong>Source Reference, Invoice/Bill Number, Amount, Correct Date</strong> (DD/MM/YYYY). The old allocation is deleted and a new one is created — this cannot be undone.
                </div>
                <div className="aa-fix-dates-row" style={{ marginBottom: 10 }}>
                  <button className="aa-audit-btn" onClick={downloadSampleCsv}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Download Sample CSV
                  </button>
                </div>
                <div className="aa-fix-dates-row" style={{ marginBottom: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                    <span style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-elev)", fontSize: 12, fontWeight: 600, color: "var(--text)", cursor: "pointer", whiteSpace: "nowrap" }}>
                      Choose CSV File
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {fixFile ? fixFile.name : "No file selected"}
                    </span>
                    <input type="file" accept=".csv" onChange={handleFixFileChange} style={{ display: "none" }} />
                  </label>
                </div>
                {fixParseError && <div className="aa-fix-error">⚠ {fixParseError}</div>}
                {fixRows.length > 0 && !fixStatus && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>{fixRows.length} row{fixRows.length !== 1 ? "s" : ""} ready</span>
                    <button
                      className={`aa-fix-start-btn${fixRunning || !tenantId ? " aa-fix-start-btn--disabled" : ""}`}
                      onClick={handleStartFix}
                      disabled={fixRunning || !tenantId}
                    >
                      {fixRunning ? <><span className="aa-spin">◌</span> Running…</> : `Fix ${fixRows.length} Date${fixRows.length !== 1 ? "s" : ""}`}
                    </button>
                    {!tenantId && <span style={{ fontSize: 12, color: "var(--muted)" }}>Connect to Xero first</span>}
                  </div>
                )}
                {fixStatus && (() => {
                  const done = ["completed", "completed_with_errors", "error"].includes(fixStatus.status);
                  const pct = Math.round((fixStatus.processed / Math.max(1, fixStatus.total)) * 100);
                  return (
                    <div className={`aa-fix-progress${done ? " aa-fix-progress--done" : ""}`} style={{ marginTop: 10, ...(done && fixStatus.errors === 0 ? { borderColor: "#22c55e" } : done && fixStatus.errors > 0 && fixStatus.fixed === 0 ? { borderColor: "#ef4444" } : done ? { borderColor: "#f59e0b" } : {}) }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, fontWeight: 600 }}>
                          {fixStatus.status === "completed" ? "✓ Done — all dates fixed" :
                           fixStatus.status === "completed_with_errors" ? "⚠ Done with some errors" :
                           fixStatus.status === "error" ? `✗ ${fixStatus.error || "Error"}` :
                           fixStatus.phase || "Running…"}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>{fixStatus.processed}/{fixStatus.total}</span>
                      </div>
                      <div style={{ height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden", marginBottom: 6 }}>
                        <div style={{
                          height: "100%", borderRadius: 2, transition: "width 0.3s", width: `${pct}%`,
                          background: done && fixStatus.errors > 0 && fixStatus.fixed === 0 ? "#ef4444" : done && fixStatus.errors > 0 ? "#f59e0b" : done ? "#22c55e" : "linear-gradient(90deg,#3b82f6,#2563eb)",
                        }} />
                      </div>
                      <div style={{ fontSize: 11, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        {fixStatus.fixed > 0 && <span style={{ color: "#22c55e" }}>✓ {fixStatus.fixed} fixed</span>}
                        {fixStatus.errors > 0 && <span style={{ color: "#ef4444" }}>✗ {fixStatus.errors} errors</span>}
                        {done && <button onClick={() => { setFixStatus(null); setFixRows([]); setFixFile(null); setFixParseError(""); }} style={{ marginLeft: "auto", padding: "4px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--muted)", fontSize: 11, cursor: "pointer" }}>Reset</button>}
                        {done && fixStatus.results?.length > 0 && (
                          <button className="aa-audit-btn" onClick={downloadFixReport}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download Report
                          </button>
                        )}
                        {done && fixStatus.results?.filter(r => r.status === "error").length > 0 && (
                          <button className="aa-audit-btn" onClick={downloadFixRemaining}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                            Download Remaining
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          </div>
        </div>
      </div>

      {/* ── Sticky footer ── */}
      {analyzeResult && !analyzing && suggestions.length > 0 && (
        <div className="aa-footer">
          <div className="aa-footer-inner">
            {!isDone ? (
              <>
                <div className="aa-footer-info">
                  {selected.size > 0
                    ? <><strong>{selected.size}</strong> allocation{selected.size !== 1 ? "s" : ""} selected · {fmt(selectedSuggestions.reduce((s, r) => s + r.amount, 0), selectedSuggestions[0]?.currency)} total</>
                    : <span style={{ color: "var(--muted)" }}>Select rows above to execute</span>
                  }
                </div>
                <div className="aa-footer-actions">
                  <button
                    className={`aa-execute-btn${selected.size === 0 || executing ? " aa-execute-btn--disabled" : ""}`}
                    onClick={handleExecute}
                    disabled={selected.size === 0 || executing}
                  >
                    {executing
                      ? <><span className="aa-spin">◌</span> Executing…</>
                      : <><span>✓</span> Apply {selected.size > 0 ? selected.size : ""} Allocation{selected.size !== 1 ? "s" : ""}</>
                    }
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="aa-footer-info">
                  <span style={{ color: "#22c55e", fontWeight: 600 }}>✓ {execStatus.created} applied</span>
                  {execStatus.errors > 0 && <span style={{ color: "#ef4444", fontWeight: 600, marginLeft: 12 }}>✗ {execStatus.errors} errors</span>}
                </div>
                <button className="aa-re-analyse-btn" onClick={handleAnalyze}>⬡ Re-Analyse (check remaining)</button>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        /* ── Root ── */
        .aa-root { min-height:100vh; background:var(--bg); font-family:Inter,system-ui,sans-serif; display:flex; flex-direction:column; }

        /* ── Header ── */
        .aa-header { background:var(--panel); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:50; box-shadow:0 1px 0 var(--border),0 4px 24px rgba(0,0,0,0.06); }
        .aa-header-inner { max-width:1400px; margin:0 auto; padding:0 28px; height:64px; display:flex; align-items:center; }
        .aa-header-left { display:flex; align-items:center; gap:14px; }
        .aa-back-btn { display:flex; align-items:center; gap:5px; padding:6px 12px; border:1px solid var(--border); border-radius:8px; background:none; color:var(--muted); font-size:12px; cursor:pointer; transition:all 0.15s; }
        .aa-back-btn:hover { color:var(--ink); border-color:var(--border-2); background:var(--panel-elev); }
        .aa-header-icon { font-size:22px; width:40px; height:40px; background:linear-gradient(135deg,var(--accent),var(--accent-blue)); border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff; flex-shrink:0; box-shadow:0 4px 12px rgba(13,148,136,0.3); }
        .aa-header-title { font-size:16px; font-weight:700; color:var(--ink); display:flex; align-items:center; gap:8px; line-height:1; }
        .aa-header-badge { font-size:9px; font-weight:800; letter-spacing:0.1em; text-transform:uppercase; padding:3px 8px; border-radius:99px; background:linear-gradient(90deg,var(--accent),var(--accent-blue)); color:#fff; }
        .aa-header-sub { font-size:12px; color:var(--muted); margin-top:3px; }

        /* ── Body ── */
        .aa-body { flex:1; max-width:1400px; width:100%; margin:0 auto; padding:22px 28px 120px; box-sizing:border-box; }

        /* ── Control bar ── */
        .aa-control-bar { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px 20px; margin-bottom:18px; display:flex; align-items:flex-start; gap:16px; flex-wrap:wrap; box-shadow:var(--shadow-card); }
        .aa-control-sep { width:1px; height:40px; background:var(--border); flex-shrink:0; align-self:center; }
        .aa-all-wrap { flex-shrink:0; }
        .aa-all-btn { display:flex; align-items:center; gap:12px; padding:10px 18px; border-radius:10px; border:2px solid var(--border); background:var(--panel-elev); color:var(--ink); cursor:pointer; transition:all 0.15s; text-align:left; }
        .aa-all-btn:hover { border-color:var(--accent); }
        .aa-all-btn--active { border-color:var(--accent); background:rgba(13,148,136,0.08); }
        .aa-all-icon { font-size:22px; color:var(--accent); flex-shrink:0; }
        .aa-all-title { font-size:13px; font-weight:700; color:var(--ink); }
        .aa-all-sub { font-size:11px; color:var(--muted); margin-top:2px; }
        .aa-advanced-toggle { background:none; border:none; color:var(--muted); font-size:11px; cursor:pointer; padding:4px 0; display:flex; align-items:center; gap:4px; }
        .aa-advanced-toggle:hover { color:var(--ink); }
        .aa-advanced-grid { display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; }
        .aa-adv-group { display:flex; flex-direction:column; gap:5px; }
        .aa-adv-label { font-size:10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:0.06em; }
        .aa-td--type { white-space:nowrap; }
        .aa-type-chip { font-size:10px; font-weight:700; padding:2px 7px; border-radius:6px; background:rgba(59,130,246,0.12); color:#3b82f6; letter-spacing:0.02em; }
        .aa-control-section { display:flex; flex-direction:column; gap:6px; }
        .aa-control-label { font-size:11px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:0.06em; }
        .aa-control-spacer { flex:1; }
        .aa-seg { display:flex; gap:0; background:var(--bg); border:1px solid var(--border); border-radius:10px; padding:3px; }
        .aa-seg-btn { display:flex; align-items:center; gap:6px; padding:6px 14px; border:none; border-radius:8px; background:none; color:var(--muted); font-size:13px; font-weight:500; cursor:pointer; transition:all 0.15s; }
        .aa-seg-btn:hover { color:var(--ink); }
        .aa-seg-btn--active { background:var(--panel); color:var(--accent); font-weight:700; box-shadow:0 1px 4px rgba(0,0,0,0.1); }
        .aa-seg-icon { font-size:11px; opacity:0.7; }
        .aa-date-range { display:flex; align-items:center; gap:6px; }
        .aa-date-input { padding:6px 10px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--ink); font-size:12px; outline:none; transition:border-color 0.15s; cursor:pointer; }
        .aa-date-input:focus { border-color:var(--accent); }
        .aa-date-input:disabled { opacity:0.5; cursor:not-allowed; }
        .aa-date-sep { color:var(--muted); font-size:13px; }
        .aa-date-clear { background:none; border:none; color:var(--muted); cursor:pointer; font-size:17px; line-height:1; padding:0 3px; transition:color 0.15s; }
        .aa-date-clear:hover { color:#ef4444; }
        .aa-analyse-btn { display:flex; align-items:center; gap:8px; padding:10px 22px; border:none; border-radius:10px; font-size:13px; font-weight:700; cursor:pointer; transition:all 0.15s; background:linear-gradient(135deg,var(--accent),var(--accent-blue)); color:#fff; box-shadow:0 4px 14px rgba(13,148,136,0.3); white-space:nowrap; }
        .aa-analyse-btn:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 6px 20px rgba(13,148,136,0.4); }
        .aa-analyse-btn--loading { background:var(--border); box-shadow:none; color:var(--muted); cursor:wait; }
        .aa-analyse-btn--hero { padding:13px 30px; font-size:15px; margin-top:24px; }
        .aa-analyse-btn--disabled { background:var(--border); box-shadow:none; color:var(--muted); cursor:not-allowed; }
        .aa-spin { display:inline-block; animation:aa-spin 0.9s linear infinite; }

        /* ── Error ── */
        .aa-error { display:flex; align-items:center; gap:10px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.25); border-radius:10px; padding:12px 16px; color:#ef4444; font-size:13px; margin-bottom:16px; }
        .aa-error-close { margin-left:auto; background:none; border:none; color:#ef4444; cursor:pointer; font-size:18px; line-height:1; padding:0 4px; }

        /* ── Scanning ── */
        .aa-scanning { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); padding:60px 24px 48px; text-align:center; margin-bottom:20px; box-shadow:var(--shadow-card); }
        .aa-scanning-rings { position:relative; width:80px; height:80px; margin:0 auto 24px; }
        .aa-ring { position:absolute; inset:0; border-radius:50%; border:2px solid; animation:aa-ring 1.4s ease-in-out infinite; }
        .aa-ring-1 { border-color:rgba(13,148,136,0.5); animation-delay:0s; }
        .aa-ring-2 { inset:12px; border-color:rgba(59,130,246,0.4); animation-delay:0.2s; }
        .aa-ring-3 { inset:24px; border-color:rgba(139,92,246,0.3); animation-delay:0.4s; }
        .aa-scanning-icon { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:24px; }
        .aa-scanning-title { font-size:16px; font-weight:700; color:var(--ink); margin-bottom:6px; }
        .aa-scanning-sub { font-size:13px; color:var(--muted); max-width:400px; margin:0 auto 20px; line-height:1.6; }
        .aa-scanning-steps { display:flex; gap:20px; justify-content:center; flex-wrap:wrap; }
        .aa-step { font-size:12px; color:var(--muted-2); }
        .aa-step--active { color:var(--accent); font-weight:600; animation:aa-pulse 1.2s ease-in-out infinite; }

        /* ── Stats ── */
        .aa-stats-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }
        .aa-stat-card { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px 18px 14px; box-shadow:var(--shadow-card); position:relative; overflow:hidden; cursor:default; transition:transform 0.18s,box-shadow 0.18s; }
        .aa-stat-card:hover { transform:translateY(-2px); box-shadow:var(--shadow-hover); }
        .aa-stat-card::before { content:""; position:absolute; top:0; right:0; width:60px; height:60px; background:radial-gradient(circle at 100% 0%,color-mix(in srgb,var(--card-accent) 15%,transparent),transparent 70%); pointer-events:none; }
        .aa-stat-icon { font-size:18px; color:var(--card-accent); margin-bottom:8px; opacity:0.8; }
        .aa-stat-label { font-size:10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:0.07em; margin-bottom:4px; }
        .aa-stat-value { font-size:24px; font-weight:800; color:var(--ink); line-height:1; font-variant-numeric:tabular-nums; }
        .aa-stat-sub { font-size:11px; color:var(--muted); margin-top:4px; }

        /* ── Progress panel ── */
        .aa-progress-panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); padding:18px 20px; margin-bottom:18px; box-shadow:var(--shadow-card); }
        .aa-progress-panel--done { border-color:rgba(34,197,94,0.3); background:rgba(34,197,94,0.04); }
        .aa-progress-panel--warn { border-color:rgba(245,158,11,0.3); background:rgba(245,158,11,0.04); }
        .aa-progress-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
        .aa-progress-title { font-size:14px; font-weight:600; color:var(--ink); display:flex; align-items:center; gap:8px; }
        .aa-progress-count { font-size:13px; font-variant-numeric:tabular-nums; }
        .aa-progress-track { height:8px; background:var(--border); border-radius:99px; overflow:hidden; }
        .aa-progress-fill { height:100%; border-radius:99px; transition:width 0.5s ease; min-width:4px; }
        .aa-progress-fill--shimmer { background-size:200% 100%; animation:aa-shimmer 1.5s linear infinite; }
        .aa-progress-current { font-size:12px; color:var(--muted); margin-top:7px; font-family:monospace; }
        .aa-progress-footer { display:flex; align-items:center; gap:10px; margin-top:12px; flex-wrap:wrap; }
        .aa-progress-results { display:flex; gap:8px; }
        .aa-tag { display:inline-flex; align-items:center; padding:3px 10px; border-radius:20px; font-size:12px; font-weight:700; }
        .aa-tag--success { background:rgba(34,197,94,0.1); color:#22c55e; }
        .aa-tag--error { background:rgba(239,68,68,0.1); color:#ef4444; }
        .aa-audit-btn { margin-left:auto; display:flex; align-items:center; gap:6px; padding:7px 14px; border:1px solid var(--border); border-radius:8px; background:var(--panel-elev); color:var(--ink); font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .aa-audit-btn:hover { border-color:var(--accent); color:var(--accent); }

        /* ── Table card ── */
        .aa-table-card { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); overflow:hidden; margin-bottom:16px; box-shadow:var(--shadow-card); }
        .aa-filters { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel-elev); }
        .aa-filter-search-wrap { position:relative; display:flex; align-items:center; }
        .aa-filter-search-icon { position:absolute; left:10px; color:var(--muted); pointer-events:none; }
        .aa-filter-input { padding:7px 12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--ink); font-size:13px; outline:none; transition:border-color 0.15s; }
        .aa-filter-input:focus { border-color:var(--accent); }
        .aa-filter-search { padding-left:30px; width:190px; }
        .aa-filter-clear { position:absolute; right:8px; background:none; border:none; color:var(--muted); cursor:pointer; font-size:16px; line-height:1; }
        .aa-filter-select { padding:7px 12px; border:1px solid var(--border); border-radius:8px; background:var(--bg); color:var(--ink); font-size:13px; cursor:pointer; }
        .aa-filter-info { margin-left:auto; font-size:13px; color:var(--muted); display:flex; gap:6px; align-items:center; }
        .aa-filter-dot { opacity:0.4; }
        .aa-table-wrap { overflow-x:auto; overflow-y:auto; max-height:calc(100vh - 320px); }
        .aa-table { width:100%; border-collapse:collapse; font-size:13px; }
        .aa-th { padding:10px 14px; text-align:left; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.07em; white-space:nowrap; background:var(--panel-elev); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:2; }
        .aa-th--check { width:44px; }
        .aa-th--arrow { width:28px; padding:0; }
        .aa-th--right { text-align:right; }
        .aa-tr { border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.1s; }
        .aa-tr:last-child { border-bottom:none; }
        .aa-tr:hover { background:var(--panel-elev); }
        .aa-tr--selected { background:var(--accent-soft) !important; }
        .aa-td { padding:11px 14px; color:var(--ink); vertical-align:middle; }
        .aa-td--check { width:44px; }
        .aa-td--contact { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
        .aa-td--mono { font-family:monospace; font-size:12px; }
        .aa-td--cn { color:var(--accent); font-weight:700; }
        .aa-td--arrow-cell { padding:0 4px; text-align:center; }
        .aa-arrow { color:var(--muted-2); font-size:14px; }
        .aa-td--date { color:var(--muted); font-size:12px; white-space:nowrap; }
        .aa-td--amount { text-align:right; font-weight:700; font-variant-numeric:tabular-nums; }
        .aa-td--ccy { font-size:11px; font-weight:700; color:var(--muted); letter-spacing:0.05em; }
        .aa-checkbox { cursor:pointer; accent-color:var(--accent); width:15px; height:15px; }
        .aa-table-empty { padding:40px 24px; text-align:center; color:var(--muted); font-size:14px; }

        /* ── No match ── */
        .aa-nomatch-card { background:var(--panel); border:1px solid rgba(239,68,68,0.2); border-radius:var(--radius-lg); overflow:hidden; margin-bottom:16px; }
        .aa-nomatch-toggle { width:100%; display:flex; align-items:center; justify-content:space-between; padding:14px 18px; background:rgba(239,68,68,0.04); border:none; cursor:pointer; font-size:13px; color:var(--ink); }
        .aa-nomatch-toggle:hover { background:rgba(239,68,68,0.08); }
        .aa-nomatch-toggle-left { display:flex; align-items:center; gap:10px; }
        .aa-nomatch-dot { width:8px; height:8px; border-radius:50%; background:#ef4444; flex-shrink:0; }
        .aa-nomatch-chevron { font-size:10px; color:var(--muted); }
        .aa-nomatch-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:10px; padding:14px 18px; background:var(--panel); }
        .aa-nomatch-item { padding:10px 14px; border-radius:10px; background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.15); }
        .aa-nomatch-contact { font-size:12px; font-weight:600; color:var(--ink); margin-bottom:3px; }
        .aa-nomatch-ref { font-size:11px; font-family:monospace; color:#ef4444; margin-bottom:3px; }
        .aa-nomatch-amount { font-size:11px; color:var(--muted); }

        /* ── Utilities section ── */
        .aa-utilities-section { margin-top:28px; }
        .aa-utilities-header { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
        .aa-utilities-icon { font-size:13px; color:var(--muted); opacity:0.7; }
        .aa-utilities-label { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; }
        .aa-utilities-desc { font-size:11px; color:var(--muted-2); margin-left:4px; }

        /* ── Fix Allocation Dates ── */
        .aa-fix-dates-panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); overflow:hidden; box-shadow:var(--shadow-card); }
        .aa-fix-dates-toggle { width:100%; display:flex; align-items:center; gap:10px; padding:14px 20px; background:none; border:none; cursor:pointer; font-size:13px; font-weight:600; color:var(--muted); text-align:left; transition:background 0.15s; }
        .aa-fix-dates-toggle:hover { background:var(--panel-elev); color:var(--ink); }
        .aa-fix-dates-chevron { margin-left:auto; font-size:11px; opacity:0.5; }
        .aa-utilities-badge { margin-left:auto; font-size:9px; font-weight:700; letter-spacing:0.07em; text-transform:uppercase; padding:2px 7px; border-radius:6px; background:var(--panel-elev); border:1px solid var(--border); color:var(--muted); }
        .aa-fix-dates-chevron { margin-left:6px; font-size:11px; opacity:0.5; }
        .aa-fix-dates-body { padding:16px 20px 20px; border-top:1px solid var(--border); }
        .aa-fix-dates-info { font-size:12px; color:var(--muted); margin-bottom:14px; line-height:1.7; }
        .aa-fix-dates-info code { background:var(--panel-elev); padding:1px 5px; border-radius:4px; font-size:11px; }
        .aa-fix-dates-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px; }
        .aa-fix-file-btn { display:flex; align-items:center; gap:7px; padding:8px 16px; border:1px solid var(--border); border-radius:8px; background:var(--panel-elev); color:var(--ink); font-size:12px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .aa-fix-file-btn:hover { border-color:var(--accent); color:var(--accent); }
        .aa-fix-count { font-size:12px; color:var(--accent); font-weight:600; }
        .aa-fix-start-btn { padding:8px 20px; border-radius:8px; background:var(--accent); color:#fff; border:none; font-size:12px; font-weight:700; cursor:pointer; transition:all 0.15s; }
        .aa-fix-start-btn:hover:not(.aa-fix-start-btn--disabled) { opacity:0.88; }
        .aa-fix-start-btn--disabled { opacity:0.4; cursor:not-allowed; }
        .aa-fix-error { font-size:12px; color:#ef4444; margin-top:8px; background:rgba(239,68,68,0.06); border:1px solid rgba(239,68,68,0.2); border-radius:6px; padding:8px 12px; line-height:1.5; }
        .aa-fix-progress { padding:12px 14px; background:var(--panel-elev); border-radius:8px; border:1px solid var(--border); margin-top:10px; }
        .aa-fix-progress--done { border-color:var(--accent); }

        /* ── Empty state ── */
        .aa-empty { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius-lg); padding:72px 32px 56px; text-align:center; position:relative; overflow:hidden; box-shadow:var(--shadow-card); }
        .aa-empty-glow { position:absolute; top:-60px; left:50%; transform:translateX(-50%); width:300px; height:300px; background:radial-gradient(circle,rgba(13,148,136,0.08) 0%,transparent 70%); pointer-events:none; }
        .aa-empty-icon { font-size:56px; margin-bottom:16px; opacity:0.15; }
        .aa-empty-title { font-size:22px; font-weight:800; color:var(--ink); margin-bottom:10px; }
        .aa-empty-desc { font-size:14px; color:var(--muted); max-width:460px; margin:0 auto 24px; line-height:1.8; }
        .aa-legend { display:flex; gap:28px; justify-content:center; flex-wrap:wrap; margin-bottom:4px; }
        .aa-legend-item { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); }
        .aa-legend-item b { color:var(--ink); }

        /* ── Sticky footer ── */
        .aa-footer { position:fixed; bottom:0; left:0; right:0; background:var(--panel); border-top:1px solid var(--border); box-shadow:0 -4px 24px rgba(0,0,0,0.08); z-index:40; }
        .aa-footer-inner { max-width:1400px; margin:0 auto; padding:12px 28px; display:flex; align-items:center; gap:16px; }
        .aa-footer-info { font-size:13px; color:var(--ink); flex:1; }
        .aa-footer-actions { display:flex; gap:10px; }
        .aa-execute-btn { display:flex; align-items:center; gap:8px; padding:10px 24px; border:none; border-radius:10px; font-size:14px; font-weight:700; cursor:pointer; background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff; box-shadow:0 4px 14px rgba(34,197,94,0.35); transition:all 0.15s; white-space:nowrap; }
        .aa-execute-btn:hover:not(.aa-execute-btn--disabled) { transform:translateY(-1px); box-shadow:0 6px 20px rgba(34,197,94,0.45); }
        .aa-execute-btn--disabled { background:var(--border); color:var(--muted); box-shadow:none; cursor:not-allowed; transform:none !important; }
        .aa-re-analyse-btn { display:flex; align-items:center; gap:6px; padding:9px 18px; border:1px solid var(--border); border-radius:9px; background:var(--panel-elev); color:var(--ink); font-size:13px; font-weight:600; cursor:pointer; transition:all 0.15s; white-space:nowrap; }
        .aa-re-analyse-btn:hover { border-color:var(--accent); color:var(--accent); }

        /* ── Sample CSV button ── */
        .aa-sample-btn { display:inline-flex; align-items:center; gap:5px; padding:5px 10px; border:1px dashed var(--border); border-radius:6px; background:none; color:var(--muted); font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap; flex-shrink:0; transition:all 0.15s; }
        .aa-sample-btn:hover { border-color:var(--accent); color:var(--accent); }

        /* ── Confirm dialog ── */
        .aa-confirm-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:200; display:flex; align-items:center; justify-content:center; padding:20px; backdrop-filter:blur(2px); }
        .aa-confirm-box { background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:28px 28px 24px; max-width:420px; width:100%; box-shadow:0 20px 60px rgba(0,0,0,0.25); }
        .aa-confirm-icon { font-size:28px; margin-bottom:14px; color:#f59e0b; }
        .aa-confirm-message { font-size:14px; color:var(--ink); line-height:1.65; margin-bottom:22px; }
        .aa-confirm-message p:first-child { font-weight:600; }
        .aa-confirm-actions { display:flex; gap:10px; justify-content:flex-end; }
        .aa-confirm-cancel { padding:9px 20px; border:1px solid var(--border); border-radius:9px; background:var(--panel-elev); color:var(--ink); font-size:13px; font-weight:600; cursor:pointer; transition:all 0.15s; }
        .aa-confirm-cancel:hover { border-color:var(--border-2); }
        .aa-confirm-ok { padding:9px 22px; border:none; border-radius:9px; background:linear-gradient(135deg,#22c55e,#16a34a); color:#fff; font-size:13px; font-weight:700; cursor:pointer; box-shadow:0 4px 12px rgba(34,197,94,0.3); transition:all 0.15s; }
        .aa-confirm-ok:hover { transform:translateY(-1px); box-shadow:0 6px 16px rgba(34,197,94,0.4); }

        /* ── Animations ── */
        @keyframes aa-spin { to { transform:rotate(360deg); } }
        @keyframes aa-pulse { 0%,100% { opacity:0.7; } 50% { opacity:1; } }
        @keyframes aa-ring { 0%,100% { opacity:0.3; transform:scale(0.95); } 50% { opacity:0.8; transform:scale(1.05); } }
        @keyframes aa-shimmer { 0% { background-position:200% 0; } 100% { background-position:-200% 0; } }
      `}</style>
    </div>
  );
}
