import { ArrowLeft, ShieldCheck } from "lucide-react";

const LAST_UPDATED = "1 August 2026";
const COMPANY = "ImportMyBooks";
const PRODUCT = "ImportMyBooks";
const CONTACT_EMAIL = "support@importmybooks.com";

export default function Privacy({ onBack }) {
  return (
    <div className="legal-page">
      <div className="legal-page__header">
        <button className="legal-back-btn" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="legal-page__title-row">
          <ShieldCheck size={20} style={{ color: "var(--accent-purple)" }} />
          <h1>Privacy Policy</h1>
        </div>
        <p className="legal-page__meta">Last updated: {LAST_UPDATED} · {COMPANY}</p>
      </div>

      <div className="legal-page__body">
        <section className="legal-section">
          <h2>1. Overview</h2>
          <p>
            <strong>{COMPANY}</strong> ("we", "us", "our") operates <strong>{PRODUCT}</strong>. This Privacy
            Policy explains what data we collect, how we use it, and the choices you have. We are committed to
            protecting your privacy and handling your data responsibly.
          </p>
        </section>

        <section className="legal-section">
          <h2>2. Data We Collect</h2>

          <h3>2.1 Account Data</h3>
          <ul>
            <li><strong>Email address</strong> — used for login and communication.</li>
            <li><strong>Password</strong> — stored as a bcrypt hash. We never store your plaintext password.</li>
            <li><strong>Role / permissions</strong> — which features your account can access.</li>
          </ul>

          <h3>2.2 Xero Connection Data</h3>
          <ul>
            <li><strong>OAuth access &amp; refresh tokens</strong> — stored server-side to maintain your Xero
            connection. These are encrypted at rest and never shared with third parties.</li>
            <li><strong>Tenant (organisation) ID &amp; name</strong> — to identify which Xero organisation
            you are connected to.</li>
          </ul>

          <h3>2.3 Import History</h3>
          <ul>
            <li>Records of past import jobs: type, date/time, number of records processed, success/error counts.</li>
            <li>We do <strong>not</strong> store your actual financial data (bill amounts, invoice numbers,
            contact names, etc.) — only the job metadata.</li>
          </ul>

          <h3>2.4 Usage Data</h3>
          <ul>
            <li>Server logs (IP address, request timestamps, HTTP status codes) retained for up to 30 days
            for security and debugging purposes.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>3. How We Use Your Data</h2>
          <ul>
            <li><strong>To provide the Service</strong> — authenticate you, connect to Xero on your behalf,
            and process import jobs.</li>
            <li><strong>To improve the Service</strong> — analyse usage patterns to fix bugs and add features.</li>
            <li><strong>To communicate with you</strong> — send account-related emails (password resets,
            subscription notices, important policy updates).</li>
            <li><strong>For security</strong> — detect and prevent fraudulent or abusive activity.</li>
          </ul>
          <p>We <strong>do not</strong> sell, rent, or share your personal data with third parties for marketing.</p>
        </section>

        <section className="legal-section">
          <h2>4. Your Xero Financial Data</h2>
          <p>
            When you run an import, your CSV/Excel data is processed in memory on our servers and sent directly
            to the Xero API. <strong>We do not retain your financial records</strong> (invoices, bills, amounts,
            contact details) after the import operation completes. The data is ephemeral — it exists only for
            the duration of the API call.
          </p>
          <p>
            Your data within Xero remains subject to <span style={{ color: "var(--accent)" }}>Xero's
            own Privacy Policy</span>.
          </p>
        </section>

        <section className="legal-section">
          <h2>5. Data Storage &amp; Security</h2>
          <ul>
            <li>Account data is stored on secured servers with restricted access.</li>
            <li>Passwords are hashed using bcrypt — irreversible even if the database were compromised.</li>
            <li>Xero OAuth tokens are stored server-side only and never exposed to the browser.</li>
            <li>All communication between your browser and our servers uses HTTPS/TLS encryption.</li>
          </ul>
          <p>
            No system is 100% secure. If you believe your account has been compromised, contact us immediately
            at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>.
          </p>
        </section>

        <section className="legal-section">
          <h2>6. Data Retention</h2>
          <ul>
            <li><strong>Account data</strong> — retained for the life of your account, plus 30 days after
            termination to allow recovery.</li>
            <li><strong>Import history</strong> — retained for 12 months, then automatically purged.</li>
            <li><strong>Server logs</strong> — retained for 30 days.</li>
            <li><strong>Xero tokens</strong> — deleted when you disconnect your Xero account or delete
            your account.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>7. Your Rights</h2>
          <p>You have the right to:</p>
          <ul>
            <li><strong>Access</strong> — request a copy of the personal data we hold about you.</li>
            <li><strong>Correction</strong> — ask us to correct inaccurate data.</li>
            <li><strong>Deletion</strong> — request deletion of your account and associated data.</li>
            <li><strong>Revoke Xero access</strong> — disconnect your Xero organisation at any time via
            Xero Settings → Connected Apps.</li>
          </ul>
          <p>
            To exercise these rights, email us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>.
            We will respond within 14 business days.
          </p>
        </section>

        <section className="legal-section">
          <h2>8. Cookies &amp; Local Storage</h2>
          <p>
            The Service uses a single <strong>httpOnly session cookie</strong> to maintain your login state.
            This cookie is essential for the Service to function and cannot be disabled. We do not use
            tracking cookies or third-party analytics cookies.
          </p>
          <p>
            We use <strong>localStorage</strong> in your browser to remember your column mapping preferences
            and UI settings (theme, selected import type). This data never leaves your device.
          </p>
        </section>

        <section className="legal-section">
          <h2>9. Third-Party Services</h2>
          <p>The Service integrates with:</p>
          <ul>
            <li><strong>Xero API</strong> — to read and write your accounting data. Subject to Xero's
            Privacy Policy.</li>
          </ul>
          <p>We do not integrate with any advertising, analytics, or tracking platforms.</p>
        </section>

        <section className="legal-section">
          <h2>10. UK Users — UK GDPR</h2>
          <p>
            If you are based in the United Kingdom, the processing of your personal data is governed by the
            <strong> UK General Data Protection Regulation (UK GDPR)</strong> and the Data Protection Act 2018.
          </p>
          <ul>
            <li>Our lawful basis for processing your data is <strong>contract performance</strong> (to provide the Service you signed up for) and <strong>legitimate interests</strong> (security and fraud prevention).</li>
            <li>You have the right to lodge a complaint with the <strong>Information Commissioner's Office (ICO)</strong> at ico.org.uk if you believe your data has been mishandled.</li>
            <li>We do not transfer your personal data outside the UK except where necessary to provide the Service (e.g., to Xero's servers). Where such transfers occur, we ensure appropriate safeguards are in place.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>11. EU / Ireland Users — GDPR</h2>
          <p>
            If you are based in the European Union or Ireland, the processing of your personal data is governed
            by the <strong>General Data Protection Regulation (EU GDPR 2016/679)</strong>.
          </p>
          <ul>
            <li>Our lawful basis for processing is <strong>contract performance</strong> and <strong>legitimate interests</strong>.</li>
            <li>You have the right to lodge a complaint with your national Data Protection Authority (e.g., the <strong>Data Protection Commission (DPC)</strong> in Ireland at dataprotection.ie).</li>
            <li>We only use essential cookies — no consent banner withdrawal affects core Service functionality.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>12. Australia Users — Privacy Act 1988</h2>
          <p>
            If you are based in Australia, your personal data is handled in accordance with the
            <strong> Privacy Act 1988 (Cth)</strong> and the Australian Privacy Principles (APPs).
          </p>
          <ul>
            <li>We collect and use your personal information only for the purpose of providing the Service, as described in this Policy.</li>
            <li>You have the right to access and correct personal information we hold about you by contacting us at <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>.</li>
            <li>You may lodge a complaint with the <strong>Office of the Australian Information Commissioner (OAIC)</strong> at oaic.gov.au if you believe your privacy rights have been breached.</li>
            <li>We do not disclose your personal information to overseas recipients except where necessary to provide the Service (e.g., Xero's servers), and only where appropriate safeguards are in place.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>13. South Africa Users — POPIA</h2>

          <p>
            If you are based in South Africa, your personal data is processed in accordance with the
            <strong> Protection of Personal Information Act, 2013 (POPIA)</strong>.
          </p>
          <ul>
            <li>We process your personal information only for the purpose of providing the Service (the "Purpose" as defined under POPIA).</li>
            <li>You have the right to access, correct, or request deletion of your personal information held by us.</li>
            <li>You may lodge a complaint with the <strong>Information Regulator of South Africa</strong> at inforegulator.org.za.</li>
            <li>We will not share your personal information with third parties without your consent, except as required by law.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>14. Changes to This Policy</h2>
          <p>
            We may update this Privacy Policy periodically. We will notify you by email and in-app notice
            at least 14 days before material changes take effect.
          </p>
        </section>

        <section className="legal-section">
          <h2>15. Contact</h2>
          <p>
            Privacy questions or requests: <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>
          </p>
          <p style={{ marginTop: 8 }}>
            <strong>{COMPANY}</strong><br />
            India
          </p>
        </section>
      </div>
    </div>
  );
}
