import { useEffect, useRef, useState } from "react";

const ACCOUNTS = [
  "Accounts Receivable", "Cash & Bank", "Sales Revenue", "GST Payable",
  "Trade Payables", "Capital A/c", "Retained Earnings", "Bank Charges",
  "Inventory Control", "Tax Expense A/c", "Depreciation", "Debtors Control",
  "Creditors Control", "Office Expenses", "Purchases A/c", "Loan Payable",
  "Fixed Assets", "Prepaid Expenses", "Accrued Liabilities", "Share Capital",
];

const fmt = n => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rand = (a, b) => Math.random() * (b - a) + a;
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const TYPE_CONFIG = {
  import:  { label: "POSTING ENTRIES",   color: "#22c55e", glow: "rgba(34,197,94,0.5)",   icon: "⬆", badge: "rgba(34,197,94,0.12)",  borderBadge: "rgba(34,197,94,0.3)"  },
  void:    { label: "VOIDING JOURNALS",  color: "#ef4444", glow: "rgba(239,68,68,0.5)",   icon: "⊘", badge: "rgba(239,68,68,0.12)",  borderBadge: "rgba(239,68,68,0.3)"  },
  delete:  { label: "DELETING RECORDS",  color: "#f97316", glow: "rgba(249,115,22,0.5)",  icon: "✕", badge: "rgba(249,115,22,0.12)", borderBadge: "rgba(249,115,22,0.3)" },
  export:  { label: "EXPORTING DATA",    color: "#6366f1", glow: "rgba(99,102,241,0.5)",  icon: "⬇", badge: "rgba(99,102,241,0.12)", borderBadge: "rgba(99,102,241,0.3)" },
  undo:    { label: "REVERSING ENTRIES", color: "#f59e0b", glow: "rgba(245,158,11,0.5)",  icon: "↺", badge: "rgba(245,158,11,0.12)", borderBadge: "rgba(245,158,11,0.3)" },
};

function NumberRain({ color }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener("resize", resize);
    const ctx = canvas.getContext("2d");
    const W = () => canvas.width, H = () => canvas.height;
    const COL_W = 55;
    let cols = Math.ceil(W() / COL_W);
    let drops = Array.from({ length: cols }, () => -rand(1, 20));
    let vals  = Array.from({ length: cols }, () => fmt(rand(1000, 999999)));

    const draw = () => {
      ctx.fillStyle = "rgba(0,0,0,0.055)";
      ctx.fillRect(0, 0, W(), H());
      cols = Math.ceil(W() / COL_W);
      while (drops.length < cols) { drops.push(-rand(1, 20)); vals.push(fmt(rand(1000, 999999))); }
      ctx.font = "10px 'Courier New', monospace";
      drops.forEach((y, i) => {
        const py = y * 16;
        ctx.globalAlpha = Math.max(0, 0.55 - (i % 3) * 0.1);
        ctx.fillStyle = color;
        ctx.fillText(vals[i], i * COL_W + 4, py);
        if (py > H() + 20 && Math.random() > 0.97) {
          drops[i] = -rand(1, 15);
          vals[i] = fmt(rand(100, 999999));
        }
        drops[i] += 0.4;
      });
      ctx.globalAlpha = 1;
    };
    const id = setInterval(draw, 40);
    return () => { clearInterval(id); window.removeEventListener("resize", resize); };
  }, [color]);

  return (
    <canvas
      ref={ref}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

function ProgressRing({ pct, color, glow, size = 130 }) {
  const r = (size / 2) - 10;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(pct, 100) / 100);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)", filter: `drop-shadow(0 0 10px ${glow})` }}>
      <defs>
        <linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} />
        </linearGradient>
      </defs>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={9} />
      <circle
        cx={size/2} cy={size/2} r={r}
        fill="none" stroke="url(#pg)" strokeWidth={9}
        strokeDasharray={circ} strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.6s cubic-bezier(0.4,0,0.2,1)" }}
      />
    </svg>
  );
}

function SpinningLedger({ color }) {
  return (
    <div style={{
      width: 38, height: 38,
      animation: "spin3d 3s linear infinite",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: 26,
      filter: `drop-shadow(0 0 8px ${color})`,
    }}>
      📒
    </div>
  );
}

function JournalTicker({ color }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const add = () => {
      const amount = fmt(rand(500, 150000));
      const dr = pick(ACCOUNTS);
      let cr = pick(ACCOUNTS);
      while (cr === dr) cr = pick(ACCOUNTS);
      setRows(prev => [{ id: Date.now(), dr, cr, amount }, ...prev].slice(0, 5));
    };
    add();
    const t = setInterval(add, 700);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6, marginBottom: 10,
        fontSize: 9, fontWeight: 700, letterSpacing: 2,
        color: "rgba(255,255,255,0.25)", textTransform: "uppercase",
      }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: color, display: "inline-block", animation: "pulse 1s ease infinite" }} />
        Live Journal Feed
      </div>
      <div style={{ fontFamily: "'Courier New', monospace", fontSize: 10.5, lineHeight: 1.7 }}>
        {rows.map((row, i) => (
          <div key={row.id} style={{
            opacity: i === 0 ? 1 : Math.max(0.2, 1 - i * 0.18),
            transition: "opacity 0.4s",
            animation: i === 0 ? "slideIn 0.3s ease" : undefined,
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px", gap: 4 }}>
              <span style={{ color: i === 0 ? color : "rgba(255,255,255,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.dr}
              </span>
              <span style={{ color: i === 0 ? color : "rgba(255,255,255,0.4)", textAlign: "right" }}>{row.amount}</span>
              <span style={{ color: "rgba(255,255,255,0.15)", textAlign: "right" }}>—</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px", gap: 4, marginBottom: 4 }}>
              <span style={{ color: "rgba(255,255,255,0.3)", paddingLeft: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.cr}
              </span>
              <span style={{ color: "rgba(255,255,255,0.15)", textAlign: "right" }}>—</span>
              <span style={{ color: i === 0 ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.3)", textAlign: "right" }}>{row.amount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function AccountingLoader({ message, processed = 0, total = 0, failed = 0, type = "import" }) {
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.import;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <>
      <style>{`
        @keyframes spin3d {
          0%   { transform: rotateY(0deg); }
          100% { transform: rotateY(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.4; transform: scale(0.7); }
        }
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes shimmer {
          0%   { background-position: -400px 0; }
          100% { background-position: 400px 0; }
        }
        @keyframes floatUp {
          0%   { opacity: 0; transform: translateY(0); }
          20%  { opacity: 0.7; }
          100% { opacity: 0; transform: translateY(-60px); }
        }
      `}</style>

      <div style={{
        position: "fixed", inset: 0, zIndex: 99999,
        background: "rgba(2,6,18,0.92)",
        backdropFilter: "blur(14px) saturate(180%)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {/* Number rain background */}
        <NumberRain color={cfg.color} />

        {/* Floating particles */}
        {["$","₹","€","#","%","∑"].map((sym, i) => (
          <div key={sym} style={{
            position: "absolute",
            left: `${15 + i * 14}%`,
            bottom: "10%",
            color: cfg.color,
            fontSize: 14,
            fontFamily: "monospace",
            fontWeight: 700,
            opacity: 0,
            animation: `floatUp ${2.5 + i * 0.4}s ease-in-out ${i * 0.6}s infinite`,
            pointerEvents: "none",
            zIndex: 1,
          }}>{sym}</div>
        ))}

        {/* Main card */}
        <div style={{
          position: "relative", zIndex: 2,
          background: "rgba(8,12,28,0.97)",
          border: `1px solid ${cfg.color}22`,
          borderRadius: 22,
          padding: "30px 36px 28px",
          width: 420,
          boxShadow: `0 0 80px ${cfg.glow}25, 0 0 0 1px ${cfg.color}15, inset 0 1px 0 rgba(255,255,255,0.04)`,
        }}>
          {/* Top glow line */}
          <div style={{
            position: "absolute", top: 0, left: "20%", right: "20%", height: 1,
            background: `linear-gradient(90deg, transparent, ${cfg.color}80, transparent)`,
            borderRadius: 1,
          }} />

          {/* Header: badge + ledger icon */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
            <div style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              background: cfg.badge,
              border: `1px solid ${cfg.borderBadge}`,
              borderRadius: 20, padding: "5px 14px",
            }}>
              <span style={{ color: cfg.color, fontSize: 13, fontWeight: 700 }}>{cfg.icon}</span>
              <span style={{ color: cfg.color, fontSize: 10, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase" }}>
                {cfg.label}
              </span>
            </div>
            <SpinningLedger color={cfg.color} />
          </div>

          {/* Progress ring + stats */}
          <div style={{ display: "flex", alignItems: "center", gap: 28, marginBottom: 4 }}>
            <div style={{ position: "relative", width: 130, height: 130, flexShrink: 0 }}>
              <ProgressRing pct={pct} color={cfg.color} glow={cfg.glow} size={130} />
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              }}>
                <span style={{
                  fontSize: 28, fontWeight: 900, color: cfg.color,
                  fontFamily: "'Courier New', monospace",
                  lineHeight: 1,
                  textShadow: `0 0 20px ${cfg.color}`,
                }}>
                  {pct}%
                </span>
              </div>
            </div>

            <div style={{ flex: 1 }}>
              <div style={{
                fontSize: 13, fontWeight: 400, color: "rgba(255,255,255,0.45)",
                fontFamily: "'Courier New', monospace", marginBottom: 6,
              }}>
                Records processed
              </div>
              <div style={{
                fontSize: 30, fontWeight: 800, color: "#fff",
                fontFamily: "'Courier New', monospace", lineHeight: 1,
                letterSpacing: -1,
              }}>
                {processed.toLocaleString()}
              </div>
              <div style={{
                fontSize: 12, color: "rgba(255,255,255,0.3)",
                fontFamily: "'Courier New', monospace", marginTop: 3,
              }}>
                of {total.toLocaleString()} total
              </div>

              {/* Mini debit/credit bar */}
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.25)", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 5 }}>
                  <span>Progress</span>
                  {failed > 0 && <span style={{ color: "#ef4444" }}>{failed} failed</span>}
                </div>
                <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{
                    height: "100%",
                    width: `${pct}%`,
                    borderRadius: 4,
                    background: `linear-gradient(90deg, ${cfg.color}99, ${cfg.color})`,
                    boxShadow: `0 0 8px ${cfg.color}`,
                    transition: "width 0.6s cubic-bezier(0.4,0,0.2,1)",
                    backgroundSize: "400px 100%",
                    backgroundImage: `linear-gradient(90deg, ${cfg.color}99, ${cfg.color}, ${cfg.color}cc, ${cfg.color})`,
                    animation: "shimmer 2s linear infinite",
                  }} />
                </div>
              </div>

              {/* Message */}
              {message && (
                <div style={{
                  marginTop: 10, fontSize: 10,
                  color: "rgba(255,255,255,0.3)",
                  fontFamily: "'Courier New', monospace",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  maxWidth: 200,
                }}>
                  {message}
                </div>
              )}
            </div>
          </div>

          {/* Live journal feed */}
          <JournalTicker color={cfg.color} />
        </div>
      </div>
    </>
  );
}
