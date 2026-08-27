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

function RedRain() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener("resize", resize);
    const ctx = canvas.getContext("2d");
    const W = () => canvas.width, H = () => canvas.height;
    const COL_W = 52;
    let cols = Math.ceil(W() / COL_W);
    let drops = Array.from({ length: cols }, () => -rand(1, 20));
    let vals = Array.from({ length: cols }, () => fmt(rand(1000, 999999)));
    const draw = () => {
      ctx.fillStyle = "rgba(10,0,0,0.07)";
      ctx.fillRect(0, 0, W(), H());
      cols = Math.ceil(W() / COL_W);
      while (drops.length < cols) { drops.push(-rand(1, 20)); vals.push(fmt(rand(1000, 999999))); }
      ctx.font = "10px 'Courier New', monospace";
      drops.forEach((y, i) => {
        const py = y * 16;
        ctx.globalAlpha = Math.max(0, 0.45 - (i % 3) * 0.08);
        ctx.fillStyle = i % 4 === 0 ? "#ef4444" : "#b91c1c";
        ctx.fillText(vals[i], i * COL_W + 4, py);
        if (py > H() + 20 && Math.random() > 0.97) {
          drops[i] = -rand(1, 15);
          vals[i] = fmt(rand(100, 999999));
        }
        drops[i] += 0.38;
      });
      ctx.globalAlpha = 1;
    };
    const id = setInterval(draw, 42);
    return () => { clearInterval(id); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
}

function StampDoc() {
  const [phase, setPhase] = useState("idle");
  const [doc, setDoc] = useState({ dr: pick(ACCOUNTS), cr: pick(ACCOUNTS), amount: fmt(rand(5000, 500000)), ref: `JNL-${Math.floor(rand(1000,9999))}` });

  useEffect(() => {
    const cycle = () => {
      const dr = pick(ACCOUNTS);
      let cr = pick(ACCOUNTS);
      while (cr === dr) cr = pick(ACCOUNTS);
      setDoc({ dr, cr, amount: fmt(rand(5000, 500000)), ref: `JNL-${Math.floor(rand(1000,9999))}` });
      setPhase("enter");
      setTimeout(() => setPhase("stamp"), 750);
      setTimeout(() => setPhase("stamped"), 1200);
      setTimeout(() => setPhase("exit"), 2400);
      setTimeout(() => setPhase("idle"), 2900);
    };
    cycle();
    const t = setInterval(cycle, 3400);
    return () => clearInterval(t);
  }, []);

  const docStyle = {
    position: "relative",
    background: "rgba(18,3,3,0.95)",
    border: "1px solid rgba(239,68,68,0.18)",
    borderRadius: 8,
    padding: "14px 16px 16px",
    width: 196,
    transition: "all 0.4s cubic-bezier(0.4,0,0.2,1)",
    opacity: phase === "idle" ? 0 : phase === "exit" ? 0 : 1,
    transform:
      phase === "idle"    ? "translateY(30px) scale(0.95)" :
      phase === "enter"   ? "translateY(0) scale(1)" :
      phase === "stamp"   ? "translateY(0) scale(1)" :
      phase === "stamped" ? "translateY(0) scale(1)" :
                            "translateY(-28px) scale(0.9)",
    boxShadow: phase === "stamped" ? "0 0 30px rgba(239,68,68,0.25)" : "none",
  };

  const lineStyle = (struck) => ({
    position: "relative",
    overflow: "hidden",
    color: struck ? "rgba(239,68,68,0.45)" : "rgba(255,255,255,0.65)",
    transition: "color 0.3s ease",
  });

  const strike = phase === "stamped";

  return (
    <div style={{ width: 196, height: 190, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={docStyle}>
        {/* Doc header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
          <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 2, color: "rgba(239,68,68,0.55)", textTransform: "uppercase", fontFamily: "monospace" }}>Manual Journal</span>
          <span style={{ fontSize: 8, color: "rgba(255,255,255,0.2)", fontFamily: "monospace" }}>{doc.ref}</span>
        </div>

        {/* Lines */}
        <div style={{ fontFamily: "'Courier New', monospace", fontSize: 9, lineHeight: 1.9 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 68px", gap: 3 }}>
            <div style={lineStyle(true)}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{doc.dr}</span>
              {strike && <div style={{ position: "absolute", top: "50%", left: 0, height: 1, background: "#ef4444", animation: "slideStrike 0.35s ease forwards" }} />}
            </div>
            <div style={{ textAlign: "right", ...lineStyle(true) }}>
              <span>{doc.amount}</span>
              {strike && <div style={{ position: "absolute", top: "50%", left: 0, height: 1, background: "#ef4444", animation: "slideStrike 0.35s ease 0.05s forwards" }} />}
            </div>

            <div style={{ paddingLeft: 14, ...lineStyle(true) }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{doc.cr}</span>
              {strike && <div style={{ position: "absolute", top: "50%", left: 0, height: 1, background: "#ef4444", animation: "slideStrike 0.35s ease 0.1s forwards" }} />}
            </div>
            <div style={{ textAlign: "right", ...lineStyle(true) }}>
              <span>{doc.amount}</span>
              {strike && <div style={{ position: "absolute", top: "50%", left: 0, height: 1, background: "#ef4444", animation: "slideStrike 0.35s ease 0.15s forwards" }} />}
            </div>
          </div>
        </div>

        {/* VOID stamp */}
        {phase !== "idle" && phase !== "enter" && (
          <div style={{
            position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
            pointerEvents: "none", borderRadius: 8,
          }}>
            <div style={{
              border: "3.5px solid #ef4444",
              borderRadius: 5,
              padding: "5px 14px",
              color: "#ef4444",
              fontSize: 30,
              fontWeight: 900,
              letterSpacing: 7,
              fontFamily: "'Georgia', serif",
              transform: "rotate(-22deg)",
              textShadow: "0 0 18px rgba(239,68,68,0.9)",
              boxShadow: "0 0 18px rgba(239,68,68,0.35), inset 0 0 12px rgba(239,68,68,0.08)",
              background: "rgba(239,68,68,0.04)",
              animation: phase === "stamp" ? "stampCrash 0.38s cubic-bezier(0.36,0.07,0.19,0.97) both" : "none",
              opacity: 0.88,
            }}>
              VOID
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProgressRing({ pct, size = 120 }) {
  const r = size / 2 - 10;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.min(pct, 100) / 100);
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)", filter: "drop-shadow(0 0 12px rgba(239,68,68,0.55))" }}>
      <defs>
        <linearGradient id="vring" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
      </defs>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={9} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="url(#vring)" strokeWidth={9}
        strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.65s cubic-bezier(0.4,0,0.2,1)" }} />
    </svg>
  );
}

export default function VoidLoader({ message, processed = 0, total = 0, failed = 0 }) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  return (
    <>
      <style>{`
        @keyframes stampCrash {
          0%   { transform: rotate(-22deg) translateY(-70px) scale(1.6); opacity: 0; }
          55%  { transform: rotate(-22deg) translateY(5px) scale(0.93); opacity: 0.88; }
          72%  { transform: rotate(-22deg) translateY(-3px) scale(1.03); }
          100% { transform: rotate(-22deg) translateY(0) scale(1); opacity: 0.88; }
        }
        @keyframes slideStrike {
          from { width: 0%; }
          to   { width: 100%; }
        }
        @keyframes voidCardPulse {
          0%, 100% { box-shadow: 0 0 50px rgba(239,68,68,0.12), 0 0 0 1px rgba(239,68,68,0.08); }
          50%       { box-shadow: 0 0 100px rgba(239,68,68,0.25), 0 0 0 1px rgba(239,68,68,0.18); }
        }
        @keyframes floatVoid {
          0%   { opacity: 0; transform: translateY(0) rotate(0deg) scale(0.8); }
          20%  { opacity: 0.65; transform: translateY(-10px) scale(1); }
          100% { opacity: 0; transform: translateY(-80px) rotate(120deg) scale(0.6); }
        }
        @keyframes voidSpin {
          from { transform: rotateY(0deg); }
          to   { transform: rotateY(360deg); }
        }
        @keyframes voidPulseGlow {
          0%, 100% { text-shadow: 0 0 14px #ef4444, 0 0 30px rgba(239,68,68,0.4); }
          50%       { text-shadow: 0 0 28px #ef4444, 0 0 60px rgba(239,68,68,0.7), 0 0 100px rgba(239,68,68,0.2); }
        }
        @keyframes voidTopLine {
          0%, 100% { opacity: 0.5; }
          50%       { opacity: 1; }
        }
        @keyframes voidDot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.35; transform: scale(0.65); }
        }
      `}</style>

      <div style={{
        position: "fixed", inset: 0, zIndex: 99999,
        background: "rgba(8,1,1,0.93)",
        backdropFilter: "blur(16px) saturate(200%)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <RedRain />

        {/* Floating void symbols */}
        {["⊘","✕","⊗","✖","⊘","✕"].map((sym, i) => (
          <div key={i} style={{
            position: "absolute",
            left: `${8 + i * 15}%`,
            bottom: "6%",
            color: "#ef4444",
            fontSize: 11 + (i % 3) * 5,
            opacity: 0,
            animation: `floatVoid ${2.8 + i * 0.4}s ease-in-out ${i * 0.55}s infinite`,
            pointerEvents: "none", zIndex: 1,
          }}>{sym}</div>
        ))}

        {/* Main card */}
        <div style={{
          position: "relative", zIndex: 2,
          background: "rgba(10,2,2,0.98)",
          border: "1px solid rgba(239,68,68,0.14)",
          borderRadius: 22,
          padding: "28px 34px 26px",
          width: 460,
          animation: "voidCardPulse 3.5s ease-in-out infinite",
        }}>
          {/* Top animated glow line */}
          <div style={{
            position: "absolute", top: 0, left: "18%", right: "18%", height: 1,
            background: "linear-gradient(90deg, transparent, rgba(239,68,68,0.8), transparent)",
            borderRadius: 1, animation: "voidTopLine 2s ease-in-out infinite",
          }} />

          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "rgba(239,68,68,0.09)", border: "1px solid rgba(239,68,68,0.22)", borderRadius: 20, padding: "5px 15px" }}>
              <span style={{ color: "#ef4444", fontSize: 14, animation: "voidPulseGlow 2s ease infinite" }}>⊘</span>
              <span style={{ color: "#ef4444", fontSize: 10, fontWeight: 800, letterSpacing: 2.5, textTransform: "uppercase" }}>Voiding Journals</span>
            </div>
            <div style={{ fontSize: 24, animation: "voidSpin 4s linear infinite", filter: "drop-shadow(0 0 10px rgba(239,68,68,0.7))" }}>📕</div>
          </div>

          {/* Body */}
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            {/* Stamp animation */}
            <StampDoc />

            {/* Stats */}
            <div style={{ flex: 1 }}>
              {/* Ring */}
              <div style={{ position: "relative", width: 120, height: 120, marginBottom: 12 }}>
                <ProgressRing pct={pct} size={120} />
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 26, fontWeight: 900, color: "#ef4444", fontFamily: "'Courier New', monospace", lineHeight: 1, animation: "voidPulseGlow 2s ease infinite" }}>
                    {pct}%
                  </span>
                </div>
              </div>

              <div style={{ fontSize: 30, fontWeight: 800, color: "#fff", fontFamily: "'Courier New', monospace", lineHeight: 1, letterSpacing: -1 }}>
                {processed.toLocaleString()}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.28)", fontFamily: "'Courier New', monospace", marginTop: 3 }}>
                of {total.toLocaleString()} voided
              </div>

              {failed > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444", fontFamily: "'Courier New', monospace" }}>
                  {failed} failed
                </div>
              )}

              {/* Progress bar */}
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "rgba(255,255,255,0.22)", fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 5 }}>
                  <span>Progress</span>
                  <span style={{ color: "#ef4444" }}>{pct}%</span>
                </div>
                <div style={{ height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, borderRadius: 4, background: "linear-gradient(90deg, #b91c1c, #ef4444)", boxShadow: "0 0 10px rgba(239,68,68,0.8)", transition: "width 0.65s cubic-bezier(0.4,0,0.2,1)" }} />
                </div>
              </div>

              {message && (
                <div style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,0.28)", fontFamily: "'Courier New', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {message}
                </div>
              )}
            </div>
          </div>

          {/* Bottom live status bar */}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#ef4444", display: "inline-block", animation: "voidDot 1.2s ease infinite" }} />
            <span style={{ fontSize: 9, fontFamily: "'Courier New', monospace", color: "rgba(255,255,255,0.22)", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase" }}>
              Xero API — Voiding in progress
            </span>
            <div style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.04)" }} />
            <span style={{ fontSize: 9, fontFamily: "'Courier New', monospace", color: "rgba(239,68,68,0.45)", fontWeight: 700 }}>
              {total - processed > 0 ? `${(total - processed).toLocaleString()} remaining` : "Finishing..."}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
