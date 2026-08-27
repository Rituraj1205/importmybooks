import { useState, useEffect } from "react";
import { User, CreditCard, BarChart2, ArrowLeft, Check, AlertCircle, RefreshCw, Eye, EyeOff } from "lucide-react";

const resolveApiBase = () => {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  const path = window.location.pathname || "/";
  if (path.startsWith("/xero-data-extraction/")) return "/xero-data-extraction/api";
  return "/api";
};
const API_BASE = resolveApiBase();

const PLAN_META = {
  starter:      { label: "Starter",      color: "#9ca3af", border: "rgba(156,163,175,0.3)",  icon: "⚡", gradient: "rgba(156,163,175,0.1), rgba(156,163,175,0.02)" },
  professional: { label: "Professional", color: "#818cf8", border: "rgba(99,102,241,0.4)",   icon: "💎", gradient: "rgba(99,102,241,0.12), rgba(99,102,241,0.02)" },
  growth:       { label: "Growth",       color: "#2dd4bf", border: "rgba(45,212,191,0.4)",   icon: "🚀", gradient: "rgba(45,212,191,0.12), rgba(45,212,191,0.02)" },
  enterprise:   { label: "Enterprise",   color: "#a78bfa", border: "rgba(167,139,250,0.4)",  icon: "🏢", gradient: "rgba(167,139,250,0.12), rgba(167,139,250,0.02)" },
  testing:      { label: "Free Testing", color: "#34d399", border: "rgba(52,211,153,0.35)",  icon: "🧪", gradient: "rgba(52,211,153,0.1), rgba(52,211,153,0.02)" },
  team:         { label: "Team Member",  color: "#38bdf8", border: "rgba(56,189,248,0.35)",  icon: "👥", gradient: "rgba(56,189,248,0.1), rgba(56,189,248,0.02)" },
  none:         { label: "No Plan",      color: "#6b7280", border: "rgba(107,114,128,0.25)", icon: "📦", gradient: "rgba(107,114,128,0.06), rgba(107,114,128,0.01)" },
};

const PLAN_FEATURES = {
  starter:      ["1 Xero organisation", "500 records per import", "All 15+ import types", "Delete Centre", "Update Centre", "Email support"],
  professional: ["5 Xero organisations", "Unlimited records per import", "All 15+ import types", "Auto-allocation", "Delete & Update Centre", "Priority email support"],
  growth:       ["15 Xero organisations", "Unlimited records per import", "Role-based access (RBAC)", "Team member accounts", "Auto-allocation", "Dedicated account manager"],
  enterprise:   ["Unlimited organisations", "Custom record limits", "Full RBAC + audit logs", "Team member accounts", "API access", "SLA-backed support"],
  testing:      ["1 Xero organisation", "100 rows total across all imports", "All import types available", "Admin-approved access"],
  team:         ["Permissions set by your organisation admin", "Organisation(s) assigned by admin", "Contact your admin to modify access"],
  none:         ["No active plan — upgrade to start importing"],
};

const PLAN_ORDER = ["starter", "professional", "growth", "enterprise"];

function DaysProgress({ planExpiry, planStartAt, color }) {
  const now = Date.now();
  const expMs = new Date(planExpiry) - now;
  const daysLeft = Math.ceil(expMs / 86400000);
  const start = planStartAt ? new Date(planStartAt).getTime() : (new Date(planExpiry).getTime() - 30 * 86400000);
  const totalDays = Math.max(1, (new Date(planExpiry).getTime() - start) / 86400000);
  const pct = Math.max(0, Math.min(100, (daysLeft / totalDays) * 100));
  const isExpired = daysLeft <= 0;
  const isWarn = daysLeft <= 7 && daysLeft > 0;
  const barColor = isExpired ? "#ef4444" : isWarn ? "#f59e0b" : color;
  const expStr = new Date(planExpiry).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
        <span style={{ color: isExpired ? "#f87171" : isWarn ? "#f59e0b" : "rgba(255,255,255,0.5)", fontWeight: 600 }}>
          {isExpired ? "Expired" : `${daysLeft} day${daysLeft === 1 ? "" : "s"} remaining`}
        </span>
        <span style={{ color: "rgba(255,255,255,0.3)" }}>Expires {expStr}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: isExpired ? "100%" : `${pct}%`, background: barColor, borderRadius: 3, opacity: isExpired ? 0.4 : 1, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function PwField({ label, value, show, onChange, onToggleShow }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.38)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={onChange}
          placeholder="••••••••"
          style={{ width: "100%", boxSizing: "border-box", padding: "9px 40px 9px 13px", borderRadius: 8, border: "1.5px solid rgba(255,255,255,0.09)", background: "rgba(255,255,255,0.04)", color: "#e2e8f0", fontSize: 14, outline: "none", fontFamily: "inherit" }}
          onFocus={e => { e.target.style.borderColor = "rgba(45,212,191,0.5)"; }}
          onBlur={e => { e.target.style.borderColor = "rgba(255,255,255,0.09)"; }}
        />
        <button type="button" onClick={onToggleShow} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "rgba(255,255,255,0.28)", cursor: "pointer", display: "flex", padding: 0 }}>
          {show ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

export default function Account({ user, userToken, onBack, onNavigatePricing }) {
  const [tab, setTab] = useState("billing");
  const [billing, setBilling] = useState(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [pwForm, setPwForm] = useState({ current: "", newPw: "", confirm: "" });
  const [showPw, setShowPw] = useState({ current: false, newPw: false, confirm: false });
  const [pwLoading, setPwLoading] = useState(false);
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);

  useEffect(() => {
    if (!userToken) { setBillingLoading(false); return; }
    fetch(`${API_BASE}/user/billing`, { headers: { "x-user-token": userToken } })
      .then(r => r.json())
      .then(d => { if (d && !d.error) setBilling(d); })
      .catch(() => {})
      .finally(() => setBillingLoading(false));
  }, [userToken]);

  const plan = user?.plan || "none";
  const meta = PLAN_META[plan] || PLAN_META.none;
  const features = PLAN_FEATURES[plan] || PLAN_FEATURES.none;
  const planExpiry = user?.planExpiry || null;
  const planStatus = user?.planStatus || "active";
  const isExpired = planExpiry && new Date(planExpiry) < new Date();
  const isTeam = plan === "team";
  const isTesting = plan === "testing";
  const isNone = plan === "none" || !plan;
  const isPaid = !isTeam && !isTesting && !isNone;
  const planIdx = PLAN_ORDER.indexOf(plan);
  const canUpgrade = planIdx >= 0 && planIdx < PLAN_ORDER.length - 1;
  const hasCustomLimits = billing?.customLimits && Object.keys(billing.customLimits).length > 0;

  const fmtDate = d => d ? new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";

  const handleChangePw = async () => {
    setPwError("");
    const { current, newPw, confirm } = pwForm;
    if (!current || !newPw || !confirm) { setPwError("Please fill in all fields."); return; }
    if (newPw !== confirm) { setPwError("New passwords do not match."); return; }
    if (newPw.length < 8) { setPwError("New password must be at least 8 characters."); return; }
    setPwLoading(true);
    try {
      const r = await fetch(`${API_BASE}/user/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken },
        body: JSON.stringify({ currentPassword: current, newPassword: newPw }),
      });
      const d = await r.json();
      if (!r.ok) { setPwError(d.error || "Failed to change password."); return; }
      setPwSuccess(true);
      setPwForm({ current: "", newPw: "", confirm: "" });
      setTimeout(() => setPwSuccess(false), 5000);
    } catch { setPwError("Network error. Please try again."); }
    finally { setPwLoading(false); }
  };

  const cardStyle = { borderRadius: 12, border: "1px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.025)", padding: "20px 22px" };
  const sectionLabelStyle = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.3)", marginBottom: 14 };

  return (
    <div style={{ minHeight: "100vh", background: "#030b18", color: "#e2e8f0", fontFamily: "Inter, system-ui, -apple-system, sans-serif" }}>

      {/* Top bar */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "13px 24px", display: "flex", alignItems: "center", gap: 14, background: "rgba(255,255,255,0.015)", backdropFilter: "blur(8px)", position: "sticky", top: 0, zIndex: 10 }}>
        <button type="button" onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 13, fontWeight: 500, padding: 0 }}
          onMouseEnter={e => e.currentTarget.style.color = "rgba(255,255,255,0.75)"}
          onMouseLeave={e => e.currentTarget.style.color = "rgba(255,255,255,0.4)"}>
          <ArrowLeft size={14} /> Back
        </button>
        <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.1)" }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0" }}>Account & Billing</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "rgba(255,255,255,0.3)", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email}</span>
      </div>

      {/* Page body */}
      <div style={{ maxWidth: 740, margin: "0 auto", padding: "36px 24px 60px" }}>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, marginBottom: 32, borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          {[
            { id: "billing", label: "Plan & Billing", Icon: CreditCard },
            { id: "profile", label: "Profile",        Icon: User },
            { id: "usage",   label: "Usage",          Icon: BarChart2 },
          ].map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button key={id} type="button" onClick={() => setTab(id)} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "9px 18px",
                background: "none", border: "none", borderBottom: `2px solid ${active ? "#2dd4bf" : "transparent"}`,
                color: active ? "#2dd4bf" : "rgba(255,255,255,0.38)",
                fontSize: 13, fontWeight: active ? 700 : 500,
                cursor: "pointer", transition: "color 0.15s", marginBottom: -1,
              }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.color = "rgba(255,255,255,0.65)"; }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.color = "rgba(255,255,255,0.38)"; }}>
                <Icon size={13} />{label}
              </button>
            );
          })}
        </div>

        {/* ── BILLING TAB ── */}
        {tab === "billing" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Expired alert */}
            {isExpired && isPaid && (
              <div style={{ padding: "14px 18px", borderRadius: 10, background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.28)", display: "flex", alignItems: "center", gap: 12 }}>
                <AlertCircle size={17} color="#f87171" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#f87171" }}>Plan Expired</div>
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", marginTop: 2 }}>Your plan expired on {fmtDate(planExpiry)}. Renew to continue importing.</div>
                </div>
                <button type="button" onClick={onNavigatePricing} style={{ padding: "6px 16px", background: "rgba(239,68,68,0.14)", color: "#f87171", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
                  Renew →
                </button>
              </div>
            )}

            {/* Plan card */}
            <div style={{ borderRadius: 14, border: `1.5px solid ${meta.border}`, background: `linear-gradient(135deg, ${meta.gradient})`, padding: "22px 24px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: -20, right: -20, width: 160, height: 160, background: `radial-gradient(circle, ${meta.color}18, transparent 70%)`, pointerEvents: "none" }} />

              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.3)", marginBottom: 8 }}>Current Plan</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 26 }}>{meta.icon}</span>
                    <span style={{ fontSize: 22, fontWeight: 800, color: meta.color, letterSpacing: "-0.02em" }}>{meta.label}</span>
                  </div>
                  {billing?.planStartAt && !isTeam && !isTesting && !isNone && (
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginTop: 7 }}>Started {fmtDate(billing.planStartAt)}</div>
                  )}
                  {isTeam && (
                    <div style={{ fontSize: 13, color: "rgba(255,255,255,0.42)", marginTop: 10, lineHeight: 1.6, maxWidth: 340 }}>
                      Your access is managed by your organisation's administrator. Contact your admin to change permissions.
                    </div>
                  )}
                </div>

                {/* Status badges */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  {(() => {
                    if (isExpired) return <Badge label="Expired" color="#f87171" bg="rgba(239,68,68,0.14)" border="rgba(239,68,68,0.3)" />;
                    if (planStatus === "pending") return <Badge label="Pending" color="#f59e0b" bg="rgba(245,158,11,0.14)" border="rgba(245,158,11,0.3)" />;
                    if (isTeam) return <Badge label="Team" color="#38bdf8" bg="rgba(56,189,248,0.14)" border="rgba(56,189,248,0.3)" />;
                    if (isTesting) return <Badge label="Free" color="#34d399" bg="rgba(52,211,153,0.14)" border="rgba(52,211,153,0.3)" />;
                    if (isNone) return <Badge label="No Plan" color="#9ca3af" bg="rgba(156,163,175,0.12)" border="rgba(156,163,175,0.25)" />;
                    return <Badge label="Active" color="#2dd4bf" bg="rgba(45,212,191,0.14)" border="rgba(45,212,191,0.3)" />;
                  })()}
                  {hasCustomLimits && <Badge label="Custom Limits" color="#a78bfa" bg="rgba(167,139,250,0.14)" border="rgba(167,139,250,0.3)" />}
                </div>
              </div>

              {/* Testing rows */}
              {isTesting && (
                <div style={{ marginTop: 16, padding: "11px 14px", borderRadius: 9, background: "rgba(52,211,153,0.07)", border: "1px solid rgba(52,211,153,0.18)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}>
                    <span style={{ color: "rgba(255,255,255,0.45)" }}>Rows used</span>
                    <span style={{ color: "#34d399", fontWeight: 700 }}>{user?.testingRowsUsed || 0} / 100</span>
                  </div>
                  <div style={{ height: 5, borderRadius: 3, background: "rgba(255,255,255,0.07)" }}>
                    <div style={{ height: "100%", width: `${Math.min(100, ((user?.testingRowsUsed || 0) / 100) * 100)}%`, background: "#34d399", borderRadius: 3 }} />
                  </div>
                </div>
              )}

              {/* Days progress */}
              {!isTeam && !isTesting && !isNone && planExpiry && (
                <DaysProgress planExpiry={planExpiry} planStartAt={billing?.planStartAt || user?.planStartAt} color={meta.color} />
              )}

              {/* Action buttons */}
              {!isTeam && (
                <div style={{ marginTop: 20, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {(isNone || isTesting || isExpired) && (
                    <button type="button" onClick={onNavigatePricing} style={{ padding: "9px 24px", background: "#2dd4bf", color: "#071929", border: "none", borderRadius: 9, fontWeight: 800, fontSize: 13, cursor: "pointer" }}>
                      Get a Plan →
                    </button>
                  )}
                  {isPaid && !isExpired && canUpgrade && (
                    <button type="button" onClick={onNavigatePricing} style={{ padding: "9px 22px", background: `${meta.color}18`, color: meta.color, border: `1.5px solid ${meta.border}`, borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                      Upgrade Plan →
                    </button>
                  )}
                  {isPaid && (
                    <button type="button" onClick={onNavigatePricing} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 20px", background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.55)", border: "1.5px solid rgba(255,255,255,0.1)", borderRadius: 9, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                      <RefreshCw size={12} />Renew Plan
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* What's included */}
            <div style={cardStyle}>
              <div style={sectionLabelStyle}>What's Included</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "9px 20px" }}>
                {features.map((f, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "rgba(255,255,255,0.6)" }}>
                    <Check size={13} color={meta.color} style={{ flexShrink: 0, marginTop: 2 }} />
                    {f}
                  </div>
                ))}
              </div>
              {!isTeam && !isNone && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={{ fontSize: 12, color: "rgba(255,255,255,0.3)" }}>Need more?</span>
                  <button type="button" onClick={onNavigatePricing} style={{ background: "none", border: "none", color: "#2dd4bf", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0 }}>
                    Compare all plans →
                  </button>
                </div>
              )}
            </div>

            {/* Last payment */}
            {billing?.planPaidAt && billing?.lastPaymentId && !isTeam && (
              <div style={cardStyle}>
                <div style={sectionLabelStyle}>Last Payment</div>
                <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.32)", marginBottom: 4 }}>Date</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#e2e8f0" }}>{fmtDate(billing.planPaidAt)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.32)", marginBottom: 4 }}>Plan</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: meta.color }}>{meta.label}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 11, color: "rgba(255,255,255,0.32)", marginBottom: 4 }}>Payment ID</div>
                    <div style={{ fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.42)", wordBreak: "break-all" }}>{billing.lastPaymentId}</div>
                  </div>
                </div>
              </div>
            )}

            {/* No plan CTA */}
            {isNone && (
              <div style={{ borderRadius: 12, border: "1.5px dashed rgba(45,212,191,0.22)", padding: "32px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>🚀</div>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 8 }}>Ready to start importing?</div>
                <div style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, maxWidth: 360, margin: "0 auto 22px" }}>
                  Choose a plan to unlock bulk imports, multi-org support, and all 15+ ImportMyBooks import types.
                </div>
                <button type="button" onClick={onNavigatePricing} style={{ padding: "11px 32px", background: "#2dd4bf", color: "#071929", border: "none", borderRadius: 10, fontWeight: 800, fontSize: 14, cursor: "pointer" }}>
                  View Plans & Pricing →
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── PROFILE TAB ── */}
        {tab === "profile" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

            {/* Account details */}
            <div style={cardStyle}>
              <div style={sectionLabelStyle}>Account Details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.38)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Email address</label>
                  <div style={{ padding: "9px 13px", borderRadius: 8, border: "1.5px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)", fontSize: 14, color: "rgba(255,255,255,0.55)", display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1 }}>{user?.email}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "rgba(255,255,255,0.2)" }}>Verified</span>
                  </div>
                </div>
                {billing?.createdAt && (
                  <div>
                    <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "rgba(255,255,255,0.38)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>Member since</label>
                    <div style={{ padding: "9px 13px", borderRadius: 8, border: "1.5px solid rgba(255,255,255,0.07)", background: "rgba(255,255,255,0.03)", fontSize: 14, color: "rgba(255,255,255,0.55)" }}>
                      {fmtDate(billing.createdAt)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Change password */}
            <div style={cardStyle}>
              <div style={sectionLabelStyle}>Change Password</div>

              {pwSuccess && (
                <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, background: "rgba(52,211,153,0.09)", border: "1px solid rgba(52,211,153,0.28)", fontSize: 13, color: "#34d399", display: "flex", alignItems: "center", gap: 8 }}>
                  <Check size={14} />Password updated successfully.
                </div>
              )}

              <PwField label="Current password" value={pwForm.current} show={showPw.current}
                onChange={e => setPwForm(f => ({ ...f, current: e.target.value }))}
                onToggleShow={() => setShowPw(s => ({ ...s, current: !s.current }))} />
              <PwField label="New password" value={pwForm.newPw} show={showPw.newPw}
                onChange={e => setPwForm(f => ({ ...f, newPw: e.target.value }))}
                onToggleShow={() => setShowPw(s => ({ ...s, newPw: !s.newPw }))} />
              <PwField label="Confirm new password" value={pwForm.confirm} show={showPw.confirm}
                onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                onToggleShow={() => setShowPw(s => ({ ...s, confirm: !s.confirm }))} />

              {pwError && <div style={{ marginBottom: 12, fontSize: 12, color: "#f87171" }}>{pwError}</div>}

              <button type="button" onClick={handleChangePw} disabled={pwLoading} style={{ padding: "9px 22px", background: "rgba(45,212,191,0.1)", color: "#2dd4bf", border: "1.5px solid rgba(45,212,191,0.32)", borderRadius: 9, fontWeight: 700, fontSize: 13, cursor: pwLoading ? "not-allowed" : "pointer", opacity: pwLoading ? 0.6 : 1, fontFamily: "inherit" }}>
                {pwLoading ? "Updating…" : "Update Password"}
              </button>
            </div>
          </div>
        )}

        {/* ── USAGE TAB ── */}
        {tab === "usage" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 14 }}>
              {[
                { icon: "📥", label: "Total Imports", value: billingLoading ? null : (billing?.importCount ?? 0), sub: "All time" },
                { icon: "📊", label: "Records Imported", value: billingLoading ? null : (billing?.totalImported ?? 0), sub: "Across all imports", color: "#2dd4bf" },
              ].map((s, i) => (
                <div key={i} style={{ ...cardStyle, padding: "18px 20px" }}>
                  <div style={{ fontSize: 22, marginBottom: 10 }}>{s.icon}</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: "rgba(255,255,255,0.3)", marginBottom: 5 }}>{s.label}</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: s.color || "#818cf8", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
                    {s.value === null ? <span style={{ opacity: 0.3, fontSize: 20 }}>—</span> : (typeof s.value === "number" ? s.value.toLocaleString() : s.value)}
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", marginTop: 5 }}>{s.sub}</div>
                </div>
              ))}
              {isTesting && (
                <div style={{ ...cardStyle, padding: "18px 20px" }}>
                  <div style={{ fontSize: 22, marginBottom: 10 }}>🧪</div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: "rgba(255,255,255,0.3)", marginBottom: 5 }}>Testing Rows</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: "#34d399", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{user?.testingRowsUsed || 0}<span style={{ fontSize: 14, fontWeight: 500, color: "rgba(255,255,255,0.3)" }}> / 100</span></div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", marginTop: 5 }}>Free limit</div>
                </div>
              )}
            </div>

            <div style={cardStyle}>
              <div style={sectionLabelStyle}>Plan Limits</div>
              <div style={{ fontSize: 13, color: "rgba(255,255,255,0.45)", lineHeight: 1.7 }}>
                Your <strong style={{ color: meta.color }}>{meta.label}</strong> plan defines your usage limits.
                {hasCustomLimits && <span style={{ color: "#a78bfa" }}> Custom limits have been applied to your account by an administrator.</span>}
                {canUpgrade && !isTeam && (
                  <span> <button type="button" onClick={onNavigatePricing} style={{ background: "none", border: "none", color: "#2dd4bf", cursor: "pointer", fontSize: 13, fontWeight: 700, padding: 0, textDecoration: "underline" }}>Upgrade your plan</button> to increase limits.</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ label, color, bg, border }) {
  return (
    <span style={{ display: "inline-flex", padding: "3px 11px", borderRadius: 20, background: bg, border: `1px solid ${border}`, fontSize: 10.5, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}
