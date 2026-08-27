import { useState, useEffect, useMemo, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";

const API = (() => {
  const p = window.location.pathname;
  if (p.startsWith("/xero-data-extraction/")) return "/xero-data-extraction/api";
  return "/api";
})();

const TYPE_LABELS = {
  bills: "Bills (AP)", invoices: "Invoices (AR)", "spend-money": "Spend Money",
  "receive-money": "Receive Money", "bill-payments": "Bill Payments",
  "invoice-payments": "Invoice Payments", "credit-notes": "Credit Notes (AR)",
  "supplier-credit-notes": "Credit Notes (AP)", "manual-journals": "Manual Journals",
  "purchase-orders": "Purchase Orders", quotes: "Quotes",
  "bank-transfers": "Bank Transfers", "spend-overpayments": "Spend Overpayments",
  "receive-overpayments": "Receive Overpayments", contacts: "Contacts",
  items: "Items", accounts: "Chart of Accounts",
  "tracking-categories": "Tracking Categories", "debit-notes": "Debit Notes",
  "invoice-credit-notes": "Credit Notes (AR)", "bill-credit-notes": "Credit Notes (AP)",
};

const PIE_COLORS = ["#2dd4bf", "#38bdf8", "#a78bfa", "#fbbf24", "#4ade80", "#f87171", "#fb923c", "#e879f9"];

function timeSince(ts) {
  if (!ts) return "Never";
  const d = Date.now() - ts;
  if (d < 60000) return "Just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  if (d < 172800000) return "Yesterday";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
}

function kpiNum(n) {
  if (n === undefined || n === null) return "—";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function getGreeting(name) {
  const h = new Date().getHours();
  const g = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  return `${g}, ${name}!`;
}

function StatusBadge({ status, errors }) {
  const cfg = errors > 0
    ? { label: "With Errors", bg: "rgba(245,158,11,0.15)", color: "#fbbf24" }
    : status === "completed"
      ? { label: "Completed", bg: "rgba(74,222,128,0.12)", color: "#4ade80" }
      : status === "interrupted"
        ? { label: "Interrupted", bg: "rgba(248,113,113,0.12)", color: "#f87171" }
        : { label: status || "Unknown", bg: "rgba(100,116,139,0.15)", color: "#94a3b8" };
  return (
    <span style={{
      display: "inline-block", padding: "2px 8px", borderRadius: 20,
      fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
      background: cfg.bg, color: cfg.color, whiteSpace: "nowrap",
    }}>{cfg.label}</span>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--panel, #fff)", border: "1px solid var(--border, #e2e8f0)",
      borderRadius: 8, padding: "8px 12px", fontSize: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
    }}>
      <div style={{ color: "var(--muted, #64748b)", marginBottom: 4, fontSize: 11 }}>{label}</div>
      {payload.map(p => (
        <div key={p.dataKey} style={{ color: p.stroke || p.fill, fontWeight: 600, marginBottom: 2 }}>
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  );
}

function HealthRing({ score, color }) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ - (score / 100) * circ;
  return (
    <svg width="72" height="72" viewBox="0 0 72 72">
      <circle cx="36" cy="36" r={r} fill="none" stroke="var(--border, #e2e8f0)" strokeWidth="5" />
      <circle
        cx="36" cy="36" r={r} fill="none"
        stroke={color} strokeWidth="5"
        strokeDasharray={`${circ} ${circ}`}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 36 36)"
        style={{ transition: "stroke-dashoffset 1s ease" }}
      />
      <text x="36" y="40" textAnchor="middle" fill={color} fontSize="14" fontWeight="800">{score}</text>
    </svg>
  );
}

export default function Dashboard({ userToken, onBack, onNavigateImport }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hmHover, setHmHover] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API}/user/dashboard`, { headers: { "x-user-token": userToken } });
      if (!r.ok) throw new Error((await r.json()).error || "Failed");
      setData(await r.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [userToken]);

  useEffect(() => { load(); }, [load]);

  const { healthScore, healthLabel, healthColor } = useMemo(() => {
    if (!data) return { healthScore: 0, healthLabel: "—", healthColor: "#94a3b8" };
    const sr = data.allTime.successRate || 0;
    const recency = data.lastImportAt
      ? Math.max(0, 100 - Math.floor((Date.now() - data.lastImportAt) / 86400000) * 3)
      : 0;
    const cons = Math.min(100, (data.streak || 0) * 15);
    const score = Math.min(100, Math.round(sr * 0.5 + recency * 0.35 + cons * 0.15));
    const label = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 55 ? "Fair" : "Needs Attention";
    const color = score >= 90 ? "#4ade80" : score >= 75 ? "#2dd4bf" : score >= 55 ? "#fbbf24" : "#f87171";
    return { healthScore: score, healthLabel: label, healthColor: color };
  }, [data]);

  const heatmapMax = useMemo(() =>
    Math.max(1, ...(data?.heatmap || []).flat().filter(c => c.count > 0).map(c => c.count))
  , [data]);

  if (loading) {
    return (
      <div className="dash-page">
        <div className="dash-load-center">
          <div className="dash-spinner" />
          <p style={{ color: "var(--muted)", fontSize: 14, marginTop: 14 }}>Loading your dashboard…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dash-page">
        <div className="dash-load-center">
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <p style={{ color: "var(--accent-2)", marginBottom: 16 }}>{error}</p>
          <button className="btn ghost btn-compact" onClick={load}>Retry</button>
          <button className="btn ghost btn-compact" style={{ marginLeft: 8 }} onClick={onBack}>← Back</button>
        </div>
      </div>
    );
  }

  const kpis = [
    {
      icon: "📥", label: "This Month", value: kpiNum(data.thisMonth.count),
      sub: `${kpiNum(data.thisMonth.created)} records`, color: "#2dd4bf",
    },
    {
      icon: "📊", label: "All Time", value: kpiNum(data.allTime.count),
      sub: `${kpiNum(data.allTime.created)} in Xero`, color: "#38bdf8",
    },
    {
      icon: "✅", label: "Success Rate", value: `${data.allTime.successRate}%`,
      sub: `${kpiNum(data.allTime.errors)} errors total`, color: "#4ade80",
    },
    {
      icon: "🔗", label: "Xero Orgs", value: kpiNum(data.connectedSessions.reduce((s, c) => s + (c.tenants?.length || 0), 0)),
      sub: `${data.connectedSessions.length} session${data.connectedSessions.length !== 1 ? "s" : ""}`, color: "#a78bfa",
    },
  ];

  const planLabel = { starter: "Starter", professional: "Professional", enterprise: "Enterprise" }[data.plan] || data.plan;
  const planColor = { starter: "#94a3b8", professional: "#38bdf8", enterprise: "#a78bfa" }[data.plan] || "#94a3b8";

  return (
    <div className="dash-page">
      {/* ── Top Bar ── */}
      <header className="dash-topbar">
        <button className="dash-back-btn" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Import
        </button>
        <div className="dash-topbar-center">
          <span className="dash-topbar-greeting">{getGreeting(data.userName)}</span>
          <span className="dash-plan-badge" style={{ background: `${planColor}20`, color: planColor, borderColor: `${planColor}40` }}>
            {planLabel}
          </span>
        </div>
        <button className="dash-refresh-btn" onClick={load} title="Refresh">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
            <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
            <path d="M8 16H3v5" />
          </svg>
        </button>
      </header>

      {/* ── Tab Nav ── */}
      <div className="dash-tab-nav">
        {[
          { key: "overview", label: "Overview" },
          { key: "activity", label: "Activity" },
          { key: "connections", label: "Connections" },
        ].map(({ key, label }) => (
          <button
            key={key} type="button"
            className={`dash-tab-btn${activeTab === key ? " dash-tab-btn--active" : ""}`}
            onClick={() => setActiveTab(key)}
          >{label}</button>
        ))}
      </div>

      <div className="dash-body">
        {activeTab === "overview" && (
          <>
            {/* ── Health + Streak Banner ── */}
            <div className="dash-health-bar">
              <div className="dash-health-left">
                <HealthRing score={healthScore} color={healthColor} />
                <div className="dash-health-text">
                  <div className="dash-health-label" style={{ color: healthColor }}>{healthLabel}</div>
                  <div className="dash-health-sub">Import Health Score</div>
                  <div className="dash-health-hint">Based on success rate, recency & consistency</div>
                </div>
              </div>
              <div className="dash-health-right">
                {data.streak > 0 && (
                  <div className="dash-streak">
                    <span className="dash-streak-flame">🔥</span>
                    <div>
                      <div className="dash-streak-num">{data.streak}</div>
                      <div className="dash-streak-label">Day Streak</div>
                    </div>
                  </div>
                )}
                <div className="dash-last-import">
                  <div className="dash-last-label">Last import</div>
                  <div className="dash-last-val">{timeSince(data.lastImportAt)}</div>
                </div>
              </div>
            </div>

            {/* ── KPI Cards ── */}
            <div className="dash-kpi-grid">
              {kpis.map(({ icon, label, value, sub, color }) => (
                <div key={label} className="dash-kpi-card" style={{ "--kc": color }}>
                  <div className="dash-kpi-icon">{icon}</div>
                  <div className="dash-kpi-val">{value}</div>
                  <div className="dash-kpi-label">{label}</div>
                  <div className="dash-kpi-sub">{sub}</div>
                  <div className="dash-kpi-glow" />
                </div>
              ))}
            </div>

            {/* ── Charts ── */}
            <div className="dash-charts-row">
              {/* Area Chart — 30-day trend */}
              <div className="dash-card dash-card--chart">
                <div className="dash-card-head">
                  <h3 className="dash-card-title">30-Day Activity</h3>
                  <span className="dash-card-chip">Imports &amp; records per day</span>
                </div>
                <div style={{ height: 210, marginTop: 8 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.trend30} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
                      <defs>
                        <linearGradient id="gCount" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#2dd4bf" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#2dd4bf" stopOpacity={0} />
                        </linearGradient>
                        <linearGradient id="gCreated" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#38bdf8" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e2e8f0)" vertical={false} strokeOpacity={0.5} />
                      <XAxis dataKey="date" tick={{ fill: "var(--muted, #64748b)", fontSize: 10 }} tickLine={false} axisLine={false} interval={6} />
                      <YAxis tick={{ fill: "var(--muted, #64748b)", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} width={28} />
                      <RTooltip content={<ChartTooltip />} />
                      <Area type="monotone" dataKey="count" name="Imports" stroke="#2dd4bf" fill="url(#gCount)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#2dd4bf" }} />
                      <Area type="monotone" dataKey="created" name="Records" stroke="#38bdf8" fill="url(#gCreated)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: "#38bdf8" }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="dash-chart-legend">
                  <span className="dash-legend-dot" style={{ background: "#2dd4bf" }} />Imports&nbsp;&nbsp;
                  <span className="dash-legend-dot" style={{ background: "#38bdf8" }} />Records Created
                </div>
              </div>

              {/* Donut — import types */}
              <div className="dash-card dash-card--donut">
                <div className="dash-card-head">
                  <h3 className="dash-card-title">Import Types</h3>
                  <span className="dash-card-chip">All time</span>
                </div>
                {data.topTypes.length === 0 ? (
                  <div className="dash-empty">No imports yet</div>
                ) : (
                  <div className="dash-donut-inner">
                    <ResponsiveContainer width={150} height={150}>
                      <PieChart>
                        <Pie
                          data={data.topTypes} cx="50%" cy="50%"
                          innerRadius={44} outerRadius={68}
                          dataKey="count" startAngle={90} endAngle={-270}
                          paddingAngle={2} strokeWidth={0}
                        >
                          {data.topTypes.map((_, i) => (
                            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                          ))}
                        </Pie>
                        <RTooltip
                          formatter={(v, _, p) => [v, TYPE_LABELS[p.payload.type] || p.payload.type]}
                          contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
                          itemStyle={{ color: "var(--ink)" }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="dash-type-legend">
                      {data.topTypes.map((t, i) => (
                        <div key={t.type} className="dash-type-row">
                          <span className="dash-type-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                          <span className="dash-type-name">{TYPE_LABELS[t.type] || t.type}</span>
                          <span className="dash-type-count">{t.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Recent Imports ── */}
            <div className="dash-card">
              <div className="dash-card-head">
                <h3 className="dash-card-title">Recent Imports</h3>
                <span className="dash-card-chip">Last {Math.min(15, data.recentImports.length)} jobs</span>
              </div>
              {data.recentImports.length === 0 ? (
                <div className="dash-empty">
                  No imports yet.
                  <button className="btn primary btn-compact" style={{ marginLeft: 12 }} onClick={onNavigateImport}>Start First Import</button>
                </div>
              ) : (
                <div className="dash-recent-table">
                  <div className="dash-recent-head">
                    <span>Type</span><span>Organisation</span><span>Total</span><span>Created</span><span>Status</span><span>When</span>
                  </div>
                  {data.recentImports.map(h => (
                    <div key={h.id} className="dash-recent-row">
                      <span className="dash-recent-type">{TYPE_LABELS[h.importType] || h.importType}</span>
                      <span className="dash-recent-org">{h.orgName || "—"}</span>
                      <span className="dash-recent-num">{h.total}</span>
                      <span className="dash-recent-num" style={{ color: "#4ade80" }}>+{h.created}</span>
                      <span><StatusBadge status={h.status} errors={h.errors} /></span>
                      <span className="dash-recent-time">{timeSince(h.date)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {activeTab === "activity" && (
          <>
            {/* ── Activity Heatmap ── */}
            <div className="dash-card">
              <div className="dash-card-head">
                <h3 className="dash-card-title">Import Activity</h3>
                <span className="dash-card-chip">Past year — GitHub-style heatmap</span>
              </div>
              <div className="dash-heatmap-container">
                <div className="dash-hm-day-labels">
                  {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d, i) => (
                    <div key={d} className="dash-hm-day-label" style={{ visibility: i % 2 === 1 ? "visible" : "hidden" }}>{d}</div>
                  ))}
                </div>
                <div className="dash-hm-scroll">
                  <div className="dash-heatmap-grid">
                    {data.heatmap.map((week, wi) =>
                      week.map((cell, di) => {
                        const lvl = cell.count < 0 ? "empty"
                          : cell.count === 0 ? "0"
                          : cell.count <= Math.ceil(heatmapMax * 0.25) ? "1"
                          : cell.count <= Math.ceil(heatmapMax * 0.5) ? "2"
                          : cell.count <= Math.ceil(heatmapMax * 0.75) ? "3"
                          : "4";
                        return (
                          <div
                            key={`${wi}-${di}`}
                            className={`dash-hm-cell dash-hm-lvl-${lvl}`}
                            onMouseEnter={() => cell.count >= 0 && setHmHover({ date: cell.date, count: cell.count })}
                            onMouseLeave={() => setHmHover(null)}
                            title={cell.count >= 0 ? `${cell.date}: ${cell.count} import${cell.count !== 1 ? "s" : ""}` : ""}
                          />
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
              {hmHover && (
                <div className="dash-hm-tooltip">
                  {hmHover.date}: <strong>{hmHover.count} import{hmHover.count !== 1 ? "s" : ""}</strong>
                </div>
              )}
              <div className="dash-hm-legend">
                <span style={{ color: "var(--muted)", fontSize: 11 }}>Less</span>
                {["0","1","2","3","4"].map(l => <div key={l} className={`dash-hm-cell dash-hm-lvl-${l}`} style={{ borderRadius: 3, cursor: "default" }} />)}
                <span style={{ color: "var(--muted)", fontSize: 11 }}>More</span>
              </div>
            </div>

            {/* ── Bar chart: top import types ── */}
            {data.topTypes.length > 0 && (
              <div className="dash-card">
                <div className="dash-card-head">
                  <h3 className="dash-card-title">Top Import Types</h3>
                  <span className="dash-card-chip">By volume</span>
                </div>
                <div style={{ height: 200, marginTop: 8 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={data.topTypes.map(t => ({ name: TYPE_LABELS[t.type] || t.type, count: t.count }))}
                      margin={{ top: 4, right: 8, bottom: 40, left: -18 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} strokeOpacity={0.5} />
                      <XAxis dataKey="name" tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} angle={-35} textAnchor="end" />
                      <YAxis tick={{ fill: "var(--muted)", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <RTooltip content={<ChartTooltip />} />
                      <Bar dataKey="count" name="Imports" radius={[4, 4, 0, 0]}>
                        {data.topTypes.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === "connections" && (
          <div className="dash-card">
            <div className="dash-card-head">
              <h3 className="dash-card-title">Xero Connections</h3>
              <span className="dash-card-chip">{data.connectedSessions.length} active session{data.connectedSessions.length !== 1 ? "s" : ""}</span>
            </div>
            {data.connectedSessions.length === 0 ? (
              <div className="dash-empty">
                Not connected to Xero.
                <button className="btn primary btn-compact" style={{ marginLeft: 12 }} onClick={onNavigateImport}>Connect Now</button>
              </div>
            ) : (
              <div className="dash-orgs-list">
                {data.connectedSessions.map(sess => (
                  <div key={sess.sessionId} className="dash-org-card">
                    <div className="dash-org-pulse" style={{ background: sess.isExpired ? "#f87171" : "#4ade80" }}>
                      {!sess.isExpired && <div className="dash-org-pulse-ring" />}
                    </div>
                    <div className="dash-org-body">
                      <div className="dash-org-name">
                        {sess.tenants?.length > 0
                          ? sess.tenants.map(t => t.name).join(" · ")
                          : "Unknown organisation"}
                      </div>
                      <div className="dash-org-meta">
                        <span className="dash-org-status" style={{ color: sess.isExpired ? "#f87171" : "#4ade80" }}>
                          {sess.isExpired ? "⚠ Expired" : "● Active"}
                        </span>
                        <span>·</span>
                        <span>Connected {timeSince(sess.connectedAt)}</span>
                        <span>·</span>
                        <span>{sess.tenants?.length || 0} org{(sess.tenants?.length || 0) !== 1 ? "s" : ""}</span>
                      </div>
                    </div>
                    {sess.isExpired && (
                      <button className="btn primary btn-compact" onClick={onNavigateImport}>Reconnect</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Footer ── */}
        <div className="dash-footer">
          <span>ImportMyBooks</span>
          <span>·</span>
          <span>{data.userEmail}</span>
          <span>·</span>
          <button type="button" className="dash-footer-link" onClick={onNavigateImport}>Go to Import →</button>
        </div>
      </div>
    </div>
  );
}
