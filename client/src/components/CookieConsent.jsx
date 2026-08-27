import { useState, useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";

const STORAGE_KEY = "prism_cookie_consent";

export default function CookieConsent({ onNavigate }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      const timer = setTimeout(() => setVisible(true), 800);
      return () => clearTimeout(timer);
    }
  }, []);

  const accept = () => {
    localStorage.setItem(STORAGE_KEY, "accepted");
    setVisible(false);
  };

  const decline = () => {
    localStorage.setItem(STORAGE_KEY, "declined");
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="cookie-banner" role="dialog" aria-label="Cookie consent">
      <div className="cookie-banner__inner">
        <div className="cookie-banner__icon">
          <ShieldCheck size={18} style={{ color: "#2dd4bf" }} />
        </div>
        <div className="cookie-banner__text">
          <strong>We use essential cookies only.</strong>{" "}
          This site uses a single session cookie to keep you logged in and localStorage for your preferences.
          No tracking or advertising cookies.{" "}
          <button type="button" className="cookie-link" onClick={() => onNavigate && onNavigate("/privacy")}>
            Privacy Policy
          </button>
        </div>
        <div className="cookie-banner__actions">
          <button type="button" className="btn ghost btn-compact cookie-decline-btn" onClick={decline}>
            Decline
          </button>
          <button type="button" className="btn primary btn-compact" onClick={accept}>
            Accept
          </button>
        </div>
        <button type="button" className="cookie-banner__close" onClick={accept} aria-label="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
