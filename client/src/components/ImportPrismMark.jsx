/**
 * ImportMyBooks sidebar mark — animated SVG.
 * Shows data (dashed line) entering an open book from the left,
 * settling into organised rows on the right page.
 * Concept: "Raw data in → Clean books out"
 */
export default function ImportPrismMark({ size = 36 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="imb-book" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"   stopColor="#2dd4bf" />
          <stop offset="100%" stopColor="#0d9488" />
        </linearGradient>
      </defs>

      {/* Soft glow */}
      <circle cx="18" cy="20" r="12" fill="rgba(45,212,191,0.06)" />

      {/* Open book — left page */}
      <path
        d="M18 28C18 28 8 25 5 26V11C8 10 18 13 18 13"
        stroke="url(#imb-book)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Open book — right page */}
      <path
        d="M18 28C18 28 28 25 31 26V11C28 10 18 13 18 13"
        stroke="url(#imb-book)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Spine */}
      <line x1="18" y1="13" x2="18" y2="28" stroke="#2dd4bf" strokeWidth="1.1" strokeLinecap="round" />

      {/* Animated data lines on left page */}
      <line x1="9" y1="17" x2="15" y2="17" stroke="rgba(45,212,191,0.5)" strokeWidth="0.9" strokeLinecap="round">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.4s" repeatCount="indefinite" />
      </line>
      <line x1="9" y1="20" x2="14" y2="20" stroke="rgba(45,212,191,0.5)" strokeWidth="0.9" strokeLinecap="round">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.4s" begin="0.2s" repeatCount="indefinite" />
      </line>
      <line x1="9" y1="23" x2="15" y2="23" stroke="rgba(45,212,191,0.5)" strokeWidth="0.9" strokeLinecap="round">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.4s" begin="0.4s" repeatCount="indefinite" />
      </line>

      {/* Animated data lines on right page */}
      <line x1="21" y1="17" x2="27" y2="17" stroke="rgba(45,212,191,0.5)" strokeWidth="0.9" strokeLinecap="round">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.4s" begin="0.1s" repeatCount="indefinite" />
      </line>
      <line x1="21" y1="20" x2="26" y2="20" stroke="rgba(45,212,191,0.5)" strokeWidth="0.9" strokeLinecap="round">
        <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.4s" begin="0.3s" repeatCount="indefinite" />
      </line>

      {/* Import arrow — flowing in from left */}
      <line
        x1="0" y1="19" x2="4" y2="19"
        stroke="rgba(245,158,11,0.9)"
        strokeWidth="1.1"
        strokeDasharray="2,1.5"
        strokeLinecap="round"
      >
        <animate attributeName="stroke-dashoffset" from="0" to="-7" dur="0.75s" repeatCount="indefinite" />
      </line>
      {/* Arrow head */}
      <path d="M3 17.5 L5 19 L3 20.5" stroke="#f59e0b" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}
