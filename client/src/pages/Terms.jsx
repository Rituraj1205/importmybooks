import { ArrowLeft, FileText } from "lucide-react";

const LAST_UPDATED = "1 August 2026";
const COMPANY = "ImportMyBooks";
const PRODUCT = "ImportMyBooks";
const CONTACT_EMAIL = "support@importmybooks.com";

export default function Terms({ onBack }) {
  return (
    <div className="legal-page">
      <div className="legal-page__header">
        <button className="legal-back-btn" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="legal-page__title-row">
          <FileText size={20} style={{ color: "var(--accent)" }} />
          <h1>Terms of Service</h1>
        </div>
        <p className="legal-page__meta">Last updated: {LAST_UPDATED} · {COMPANY}</p>
      </div>

      <div className="legal-page__body">
        <section className="legal-section">
          <h2>1. Acceptance of Terms</h2>
          <p>
            By accessing or using <strong>{PRODUCT}</strong> ("the Service"), operated by <strong>{COMPANY}</strong>,
            you agree to be bound by these Terms of Service. If you do not agree, do not use the Service.
          </p>
        </section>

        <section className="legal-section">
          <h2>2. Description of Service</h2>
          <p>
            {PRODUCT} is a data import and management tool that connects to Xero via the official Xero API. It enables
            authorised users to upload CSV/Excel files and create or modify records in their Xero organisation, including
            bills, invoices, credit notes, payments, journals, and more.
          </p>
          <p>
            The Service acts as a middleware between your spreadsheet data and the Xero API. {COMPANY} does not store
            your Xero financial data — data passes through the Service in transit and is not retained after the
            import operation completes.
          </p>
        </section>

        <section className="legal-section">
          <h2>3. Eligibility &amp; Account Registration</h2>
          <ul>
            <li>You must be at least 18 years old to use the Service.</li>
            <li>You must provide a valid email address and keep your password secure.</li>
            <li>You are responsible for all activity that occurs under your account.</li>
            <li>Accounts are non-transferable. You may not share login credentials.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>4. Xero Integration &amp; API Usage</h2>
          <p>
            The Service integrates with Xero via OAuth 2.0. By connecting your Xero organisation, you authorise
            {COMPANY} to access and write data to your Xero account on your behalf. You may revoke this access
            at any time through Xero Settings → Connected Apps.
          </p>
          <p>
            Use of the Xero API through the Service is subject to{" "}
            <span style={{ color: "var(--accent)" }}>Xero's own terms and usage policies</span>. {COMPANY} is
            not responsible for any API rate limits, changes to Xero's API, or data rejections by Xero.
          </p>
        </section>

        <section className="legal-section">
          <h2>5. Acceptable Use</h2>
          <p>You agree <strong>not</strong> to:</p>
          <ul>
            <li>Use the Service to upload fraudulent, false, or misleading financial data.</li>
            <li>Attempt to reverse-engineer, decompile, or extract the source code of the Service.</li>
            <li>Use automated bots or scripts to access the Service beyond its intended functionality.</li>
            <li>Share your account credentials with unauthorised persons.</li>
            <li>Use the Service in any way that violates applicable laws or accounting regulations.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>6. Data Accuracy &amp; Your Responsibility</h2>
          <p>
            {PRODUCT} imports data exactly as provided in your CSV/Excel files. <strong>You are solely
            responsible</strong> for the accuracy, completeness, and compliance of the data you upload.
            {COMPANY} is not liable for incorrect entries, duplicates, or compliance issues arising from
            data you import.
          </p>
          <p>
            We strongly recommend testing imports in a Xero demo company before running on a live organisation,
            and keeping backups of all source files.
          </p>
        </section>

        <section className="legal-section">
          <h2>7. Limitation of Liability</h2>
          <p>
            To the maximum extent permitted by law, {COMPANY} shall not be liable for any indirect, incidental,
            special, consequential, or punitive damages — including but not limited to loss of profits, data
            corruption, or accounting errors — arising from your use of the Service.
          </p>
          <p>
            Our total liability to you for any claim arising under these terms shall not exceed the amount you
            paid for the Service in the three (3) months preceding the claim.
          </p>
        </section>

        <section className="legal-section">
          <h2>8. Subscription &amp; Payment</h2>
          <ul>
            <li>Subscriptions are billed monthly or annually as selected at sign-up.</li>
            <li>Fees are non-refundable except as required by applicable law.</li>
            <li>We reserve the right to change pricing with 30 days' notice to your registered email.</li>
            <li>Failure to pay may result in account suspension.</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>9. Termination</h2>
          <p>
            You may cancel your account at any time from your account settings. We reserve the right to
            suspend or terminate your access for violations of these Terms, with or without notice.
          </p>
          <p>
            Upon termination, your right to use the Service ceases immediately. Import history and account
            data may be deleted within 30 days of termination.
          </p>
        </section>

        <section className="legal-section">
          <h2>10. Changes to Terms</h2>
          <p>
            We may update these Terms from time to time. We will notify you by email and by a prominent notice
            within the Service at least 14 days before changes take effect. Continued use of the Service after
            that date constitutes acceptance of the updated Terms.
          </p>
        </section>

        <section className="legal-section">
          <h2>11. Governing Law</h2>
          <p>
            These Terms are governed by the laws of India. Any disputes shall be subject to the exclusive
            jurisdiction of the courts located in India.
          </p>
        </section>

        <section className="legal-section">
          <h2>12. Contact Us</h2>
          <p>
            Questions about these Terms? Email us at{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--accent)" }}>{CONTACT_EMAIL}</a>.
          </p>
        </section>
      </div>
    </div>
  );
}
