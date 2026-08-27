import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

export default function ConfirmModal({ title, message, confirmLabel = "Confirm", onConfirm, onCancel, danger = true }) {
  const cancelRef = useRef(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = e => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="cm-backdrop" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div className="cm-dialog" role="dialog" aria-modal="true" aria-labelledby="cm-title">
        <button className="cm-close" type="button" onClick={onCancel} aria-label="Close"><X size={16} /></button>
        <div className={`cm-icon ${danger ? "cm-icon--danger" : ""}`}>
          <AlertTriangle size={22} />
        </div>
        <h2 className="cm-title" id="cm-title">{title}</h2>
        <p className="cm-message">{message}</p>
        <div className="cm-actions">
          <button className="cm-btn cm-btn--cancel" type="button" ref={cancelRef} onClick={onCancel}>Cancel</button>
          <button className={`cm-btn ${danger ? "cm-btn--danger" : "cm-btn--confirm"}`} type="button" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
