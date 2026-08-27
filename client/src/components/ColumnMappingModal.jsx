import { useState } from "react";
import { X as XIcon } from "lucide-react";

const TYPE_LABELS = {
  "bills": "Bills Import",
  "invoices": "Invoices Import",
  "credit-notes": "Credit Notes Import",
  "credit-note-refunds": "Credit Note Refunds Import",
  "bill-payments": "Bill Payments Import",
  "invoice-payments": "Invoice Payments Import",
  "manual-journals": "Manual Journals Import",
  "spend-money": "Spend Money Import",
  "receive-money": "Receive Money Import",
  "spend-overpayments": "Spend Overpayments Import",
  "receive-overpayments": "Receive Overpayments Import",
  "spend-alloc": "Spend Overpayment Allocations",
  "receive-alloc": "Receive Overpayment Allocations",
  "accounts": "Chart of Accounts Import",
  "items": "Items / Products Import",
  "customers": "Customers Import",
  "vendors": "Vendors / Suppliers Import",
  "tracking-categories": "Tracking Categories Import",
  "purchase-orders": "Purchase Orders Import",
  "quotes": "Quotes / Estimates Import",
  "update-status": "Bulk Status Update",
};

function ConfidenceBadge({ score }) {
  if (score >= 80) {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 11, fontWeight: 700, padding: "3px 9px",
        background: "rgba(34,197,94,0.12)", color: "#22c55e",
        borderRadius: 20, border: "1px solid rgba(34,197,94,0.3)",
        whiteSpace: "nowrap",
      }}>
        ✓ {score}%
      </span>
    );
  }
  if (score >= 50) {
    return (
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 3,
        fontSize: 11, fontWeight: 700, padding: "3px 9px",
        background: "rgba(245,158,11,0.12)", color: "#f59e0b",
        borderRadius: 20, border: "1px solid rgba(245,158,11,0.3)",
        whiteSpace: "nowrap",
      }}>
        ~ {score}%
      </span>
    );
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 3,
      fontSize: 11, fontWeight: 700, padding: "3px 9px",
      background: "rgba(239,68,68,0.12)", color: "#ef4444",
      borderRadius: 20, border: "1px solid rgba(239,68,68,0.3)",
      whiteSpace: "nowrap",
    }}>
      ? {score}%
    </span>
  );
}

export default function ColumnMappingModal({ state, onConfirm, onCancel }) {
  const { expectedHeaders, optionalHeaders = [], actualHeaders, suggestions, confidence = {}, importTypeKey } = state;
  const typeLabel = TYPE_LABELS[importTypeKey] || importTypeKey || "Import";

  const [mapping, setMapping] = useState(() => {
    const m = {};
    for (const h of [...expectedHeaders, ...optionalHeaders]) {
      m[h] = suggestions[h] || "";
    }
    return m;
  });
  const [saveMapping, setSaveMapping] = useState(true);

  const unmappedRequired = expectedHeaders.filter(h => !mapping[h]);
  const mappedRequired = expectedHeaders.filter(h => mapping[h]);
  const canConfirm = unmappedRequired.length === 0;
  const progressPct = expectedHeaders.length > 0
    ? Math.round((mappedRequired.length / expectedHeaders.length) * 100)
    : 100;

  const setField = (header, val) => setMapping(m => ({ ...m, [header]: val }));

  const FieldRow = ({ header, required, index }) => {
    const selected = mapping[header] || "";
    const score = selected ? (confidence[header] || 0) : 0;
    const isMissing = required && !selected;

    return (
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(140px, 1fr) minmax(180px, 1.6fr) 88px",
        alignItems: "center",
        gap: 12,
        padding: "9px 20px",
        background: index % 2 === 0 ? "transparent" : "rgba(255,255,255,0.018)",
        borderBottom: "1px solid var(--border)",
        transition: "background 0.15s",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
            background: required
              ? (isMissing ? "#ef4444" : selected && score >= 80 ? "#22c55e" : "#f59e0b")
              : "var(--muted)",
            opacity: required ? 1 : 0.4,
            boxShadow: required && !isMissing ? `0 0 6px ${score >= 80 ? "#22c55e66" : "#f59e0b66"}` : "none",
          }} />
          <span style={{
            fontSize: 13,
            color: required ? "var(--text)" : "var(--muted)",
            fontWeight: required ? 500 : 400,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {header}
            {required && (
              <span style={{ color: "#ef4444", marginLeft: 3, fontSize: 10, fontWeight: 700 }}>*</span>
            )}
          </span>
        </div>

        <select
          value={selected}
          onChange={e => setField(header, e.target.value)}
          style={{
            width: "100%", fontSize: 12.5, padding: "6px 10px",
            background: "var(--surface2)",
            border: `1.5px solid ${isMissing ? "rgba(239,68,68,0.6)" : "var(--border)"}`,
            borderRadius: 7,
            color: selected ? "var(--text)" : "var(--muted)",
            outline: "none", cursor: "pointer",
            transition: "border-color 0.2s",
          }}
        >
          <option value="">{required ? "— Select a column —" : "— Skip this field —"}</option>
          {actualHeaders.map(col => (
            <option key={col} value={col}>{col}</option>
          ))}
        </select>

        <div style={{ textAlign: "right" }}>
          {selected
            ? <ConfidenceBadge score={score} />
            : <span style={{ fontSize: 11, color: "var(--muted)", opacity: 0.4 }}>—</span>
          }
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.72)",
        backdropFilter: "blur(6px)",
        zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
      onClick={e => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        width: "100%", maxWidth: 700, maxHeight: "92vh",
        overflow: "hidden", display: "flex", flexDirection: "column",
        boxShadow: "0 40px 100px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.04)",
      }}>

        {/* ── Header ── */}
        <div style={{ padding: "20px 24px 0", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                background: "rgba(99,102,241,0.15)",
                border: "1px solid rgba(99,102,241,0.25)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 17,
              }}>
                ⇄
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>
                  Column Mapping
                </h3>
                <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                    letterSpacing: 0.8, color: "#6366f1",
                    background: "rgba(99,102,241,0.12)",
                    border: "1px solid rgba(99,102,241,0.2)",
                    padding: "2px 8px", borderRadius: 5,
                  }}>
                    {typeLabel}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--muted)" }}>
                    · Map your file columns to the expected fields
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={onCancel}
              style={{
                background: "var(--surface2)", border: "1px solid var(--border)",
                cursor: "pointer", color: "var(--muted)",
                width: 30, height: 30, borderRadius: 8,
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0, marginLeft: 12,
              }}
            >
              <XIcon size={14} />
            </button>
          </div>

          {/* Progress bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ height: 5, background: "var(--surface2)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${progressPct}%`,
                background: progressPct === 100 ? "#22c55e" : "#6366f1",
                borderRadius: 10,
                transition: "width 0.35s ease, background 0.35s ease",
              }} />
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between",
              marginTop: 6, fontSize: 11, color: "var(--muted)",
            }}>
              <span>{mappedRequired.length} of {expectedHeaders.length} required fields mapped</span>
              <span style={{
                fontWeight: 600,
                color: progressPct === 100 ? "#22c55e" : "var(--muted)",
              }}>
                {progressPct === 100 ? "✓ All mapped" : `${unmappedRequired.length} remaining`}
              </span>
            </div>
          </div>

          {/* Status banner */}
          {unmappedRequired.length > 0 ? (
            <div style={{
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.2)",
              borderRadius: 9, padding: "9px 14px",
              display: "flex", alignItems: "flex-start", gap: 8,
              fontSize: 12, color: "#ef4444", lineHeight: 1.55,
              marginBottom: 6,
            }}>
              <span style={{ flexShrink: 0, fontSize: 13 }}>⚠</span>
              <div>
                <strong>{unmappedRequired.length} required field{unmappedRequired.length > 1 ? "s" : ""} not mapped:</strong>{" "}
                <span style={{ opacity: 0.85 }}>{unmappedRequired.join(", ")}</span>
              </div>
            </div>
          ) : (
            <div style={{
              background: "rgba(34,197,94,0.07)",
              border: "1px solid rgba(34,197,94,0.2)",
              borderRadius: 9, padding: "9px 14px",
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 12, color: "#22c55e",
              marginBottom: 6,
            }}>
              <span style={{ flexShrink: 0 }}>✓</span>
              <span>
                <strong>All required fields mapped.</strong> Review below, then click <strong>Confirm Mapping →</strong>
              </span>
            </div>
          )}

          {/* Column header row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "minmax(140px, 1fr) minmax(180px, 1.6fr) 88px",
            gap: 12, padding: "8px 20px",
            background: "var(--surface2)",
            borderRadius: "8px 8px 0 0",
            border: "1px solid var(--border)",
            borderBottom: "none",
            marginTop: 10,
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.9, color: "var(--muted)" }}>
              Expected Field
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.9, color: "var(--muted)" }}>
              Your CSV Column
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.9, color: "var(--muted)", textAlign: "right" }}>
              Match
            </span>
          </div>
        </div>

        {/* ── Body (scrollable) ── */}
        <div style={{
          overflow: "auto", flexGrow: 1,
          borderLeft: "1px solid var(--border)",
          borderRight: "1px solid var(--border)",
          margin: "0 24px",
        }}>
          {expectedHeaders.map((h, i) => (
            <FieldRow key={h} header={h} required={true} index={i} />
          ))}

          {optionalHeaders.length > 0 && (
            <>
              <div style={{
                padding: "12px 20px 7px",
                borderTop: "2px solid var(--border)",
                display: "flex", alignItems: "center", gap: 8,
              }}>
                <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.9, color: "var(--muted)" }}>
                  Optional Fields
                </span>
                <span style={{
                  fontSize: 10, color: "var(--muted)", opacity: 0.5,
                  background: "var(--surface2)", padding: "1px 7px", borderRadius: 10,
                }}>
                  {optionalHeaders.length}
                </span>
                <span style={{ fontSize: 11, color: "var(--muted)", opacity: 0.55 }}>
                  — you can skip these
                </span>
              </div>
              {optionalHeaders.map((h, i) => (
                <FieldRow key={h} header={h} required={false} index={i} />
              ))}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{
          borderLeft: "1px solid var(--border)",
          borderRight: "1px solid var(--border)",
          borderBottom: "1px solid var(--border)",
          borderTop: "1px solid var(--border)",
          borderRadius: "0 0 8px 8px",
          margin: "0 24px",
          overflow: "hidden",
        }}>
          <label style={{
            display: "flex", alignItems: "center", gap: 9,
            padding: "11px 20px",
            cursor: "pointer", color: "var(--muted)",
            userSelect: "none", fontSize: 12.5,
            borderBottom: "1px solid var(--border)",
            background: "var(--surface2)",
          }}>
            <input
              type="checkbox"
              checked={saveMapping}
              onChange={e => setSaveMapping(e.target.checked)}
              style={{ width: 14, height: 14, cursor: "pointer", accentColor: "#6366f1" }}
            />
            Remember this mapping for <strong style={{ color: "var(--text)", marginLeft: 3 }}>{typeLabel}</strong>
          </label>
        </div>

        <div style={{
          padding: "14px 24px 18px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          flexShrink: 0,
        }}>
          <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>
            <span style={{ fontWeight: 600, color: "var(--text)" }}>{expectedHeaders.length}</span> required &nbsp;·&nbsp;
            {optionalHeaders.length} optional &nbsp;·&nbsp;
            {actualHeaders.length} columns in your file
          </p>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              className="btn ghost"
              onClick={onCancel}
              style={{ fontSize: 13, padding: "7px 18px" }}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => onConfirm(mapping, saveMapping)}
              disabled={!canConfirm}
              style={{
                fontSize: 13, padding: "7px 20px",
                opacity: canConfirm ? 1 : 0.4,
                cursor: canConfirm ? "pointer" : "not-allowed",
                display: "flex", alignItems: "center", gap: 7,
                transition: "opacity 0.2s",
              }}
            >
              Confirm Mapping →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
