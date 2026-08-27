/**
 * ImportMyBooks — brand mark components.
 * IMBMark  → small book+arrow icon (sidebar, topbar)
 * IMBWordmark → full "ImportMyBooks" text mark
 * default export → combined logo lock-up for login hero
 */

export const IMB_TEAL = "#2dd4bf";
export const IMB_TEAL_DARK = "#0d9488";
export const IMB_AMBER = "#f59e0b";

/** Small book-with-import-arrow badge */
export function PrismMark({ size = 20, className = "" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Open book — left page */}
      <path
        d="M12 19C12 19 6 16.5 3 17V6C6 5.5 12 7.5 12 7.5"
        stroke={IMB_TEAL}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Open book — right page */}
      <path
        d="M12 19C12 19 18 16.5 21 17V6C18 5.5 12 7.5 12 7.5"
        stroke={IMB_TEAL}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Centre spine */}
      <line x1="12" y1="7.5" x2="12" y2="19" stroke={IMB_TEAL} strokeWidth="1.2" strokeLinecap="round" />
      {/* Import arrow — entering top of book */}
      <path
        d="M12 3.5 L12 6.5"
        stroke={IMB_AMBER}
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M10 5.2 L12 7 L14 5.2"
        stroke={IMB_AMBER}
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Full "ImportMyBooks" wordmark */
export function PrismWordmark({ size = 48, className = "" }) {
  const fs = size * 0.38;
  return (
    <span
      className={`prism-wordmark ${className}`}
      aria-label="ImportMyBooks"
      style={{
        fontSize: fs,
        display: "inline-flex",
        alignItems: "baseline",
        letterSpacing: "-0.02em",
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      <span style={{ color: "rgba(255,255,255,0.75)", fontWeight: 500 }}>Import</span>
      <span style={{ color: IMB_TEAL }}>My</span>
      <span style={{ color: "rgba(255,255,255,0.92)" }}>Books</span>
    </span>
  );
}

/** Combined hero lock-up: book icon + wordmark */
export default function PrismLogo({ size = 40 }) {
  return (
    <div className="prism-logo" style={{ display: "inline-flex", alignItems: "center", gap: size * 0.2, fontSize: size }}>
      <PrismMark size={size * 0.75} />
      <PrismWordmark size={size} />
    </div>
  );
}
