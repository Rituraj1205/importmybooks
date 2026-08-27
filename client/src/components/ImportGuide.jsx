import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const GUIDE_CONTENT = {
  bills: {
    icon: "📄",
    label: "Bills (Accounts Payable)",
    required: ["Bill Number", "Contact Name", "Bill Date", "Account Code", "Unit Amount"],
    optional: ["Due Date", "Reference", "Line Description", "Quantity", "Tax Type", "Currency Code", "Exchange Rate", "Status", "Tracking Name 1", "Tracking Option 1"],
    rules: [
      "Bill Number must be unique across your Xero organisation — duplicates are skipped automatically",
      "Contact Name must match an existing Xero supplier exactly — or enable 'Auto-create contacts'",
      "Bill Date column name must be exactly 'Bill Date' (not 'Date') — tool will ask to remap if different",
      "Account Code must exist in your Chart of Accounts — load it in Xero first if new",
      "Unit Amount is the line amount excluding tax — numbers only, no ₹ $ £ symbols or commas",
      "Tax Type must be a valid Xero tax code (e.g. INPUT2, NONE) — click 'Load Tax Rates' to see yours",
      "Multiple lines for the same bill? Use the same Bill Number on every line",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YYYY (e.g. 01-Apr-2020), DD-MMM-YY (e.g. 01-Apr-20)",
      "DELETED bill in Xero → number is FREE to reuse — re-importing the same bill number will work fine",
      "VOIDED bill in Xero → number is PERMANENTLY BLOCKED — same bill number can never be imported via API again. This happens when an Authorised bill is 'deleted' in Xero — Xero converts it to Voided (not deleted) automatically",
      "To check which bill numbers are blocked: Xero → Bills to Pay → Filter ▾ → enable 'Deleted & Voided' → any bill showing VOIDED status means that number is permanently blocked",
    ],
    mistakes: [
      { bad: "₹1,000 or $500.00", good: "1000 or 500", label: "Currency symbols / commas in amounts" },
      { bad: "Bill Reference (column name)", good: "Bill Number (correct column name)", label: "Wrong column header name" },
      { bad: "Date (column name)", good: "Bill Date (correct column name)", label: "Date column named incorrectly" },
      { bad: "'Acme Ltd ' (trailing space)", good: "'Acme Ltd'", label: "Extra spaces in contact name — use ✨ Auto-Fix" },
      { bad: "GST on Expenses (display name)", good: "INPUT2 (Xero tax code)", label: "Tax display name instead of code" },
      { bad: "Bill was Approved in Xero then 'deleted' → Xero secretly VOIDED it → same bill number now permanently blocked → error: 'Invoice not of valid status for modification'", good: "Never approve a bill you plan to delete. If voided accidentally, use a different bill number in your CSV, or enter the bill manually in Xero UI (UI allows it even when API blocks it)", label: "Voided bill number — cannot be re-imported via tool" },
    ],
    tips: [
      "Load Tax Rates from Xero first — so you can see the exact code needed for your region",
      "Use 🔍 Pre-check Contacts to verify all supplier names exist in Xero before importing",
      "Use ✨ Auto-Fix to strip currency symbols, commas and trim spaces automatically",
      "Enable 'Auto-create contacts' if suppliers don't exist in Xero yet",
      "Dry Run mode previews validation without creating anything in Xero",
      "Error 'Invoice not of valid status for modification'? Go to Xero → Bills to Pay → Filter 'Deleted & Voided' → if the bill shows VOIDED (not Deleted), the number is permanently blocked via API. Solution: use a different bill number in your CSV, or enter that specific bill manually in Xero",
      "DELETED vs VOIDED in Xero: DRAFT bills → Delete button → truly deleted → number reusable ✓. Authorised bills → 'Delete' converts to VOID → number permanently locked ✗",
      "Currency Code (optional column) — the currency must be enabled in Xero Settings → Currencies first. Foreign currencies not activated in Xero will be rejected",
      "Xero fiscal year lock — bills dated before your organisation's financial lock date will be rejected. Check Xero Settings → Financial Settings → Lock Date",
    ],
  },
  invoices: {
    icon: "🧾",
    label: "Invoices (Accounts Receivable)",
    required: ["Invoice Number", "Contact Name", "Invoice Date", "Account Code", "Unit Amount"],
    optional: ["Due Date", "Reference", "Line Description", "Quantity", "Tax Type", "Currency Code", "Exchange Rate", "Status", "Tracking Name 1", "Tracking Option 1"],
    rules: [
      "Invoice Number must be unique across your Xero organisation — duplicates are skipped",
      "Contact Name must match an existing Xero customer — or enable 'Auto-create contacts'",
      "Invoice Date column name must be exactly 'Invoice Date' — not 'Date'",
      "Account Code must be a valid income/revenue account from your Chart of Accounts",
      "Tax Type must be a valid Xero code (e.g. OUTPUT2, NONE) — load from Xero to confirm",
      "Unit Amount is the line amount excluding tax — numbers only, no currency symbols",
      "Multiple lines for the same invoice? Use the same Invoice Number on every line",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YYYY (e.g. 15-Jan-2024), DD-MMM-YY",
      "If all line amounts sum to a negative total, the tool automatically creates it as a Credit Note (AR) instead of an Invoice — this is by design",
      "DELETED invoice in Xero → number is FREE to reuse — re-importing will work fine",
      "VOIDED invoice in Xero → number is PERMANENTLY BLOCKED — same number can never be imported via API again. This happens when an Authorised invoice is 'deleted' in Xero — Xero converts it to Voided automatically",
      "Currency Code must be enabled in Xero Settings → Currencies first — foreign currencies not enabled will be rejected by Xero",
    ],
    mistakes: [
      { bad: "$500.00 or £1,200", good: "500 or 1200", label: "Currency symbols in amounts" },
      { bad: "Date (column name)", good: "Invoice Date (correct column name)", label: "Date column named incorrectly" },
      { bad: "Same invoice number for different invoices", good: "Unique Invoice Number per invoice", label: "Duplicate Invoice Numbers" },
      { bad: "Expense account code", good: "Income/revenue account code", label: "Wrong account type — must be income account" },
      { bad: "Invoice was Approved in Xero then 'deleted' → Xero secretly VOIDED it → same invoice number now permanently blocked → error: 'Invoice not of valid status for modification'", good: "Never approve an invoice you plan to delete. If voided accidentally, use a different invoice number, or enter it manually in Xero UI", label: "Voided invoice number — cannot be re-imported via tool" },
    ],
    tips: [
      "Use 🔍 Pre-check Contacts to verify all customer names exist before importing",
      "Enable 'Auto-create contacts' to automatically add new customers",
      "Multiple lines per invoice share the same Invoice Number — they merge into one invoice",
      "Load Tax Rates from Xero first to confirm valid codes for your region",
      "Error 'Invoice not of valid status for modification'? Go to Xero → Sales → Invoices → Filter 'Deleted & Voided' → if it shows VOIDED, the number is permanently blocked. Use a different invoice number or enter manually in Xero",
      "Negative line amounts? The tool will create a Credit Note instead of an Invoice — check your amounts if this is not intended",
    ],
  },
  "credit-notes": {
    icon: "📋",
    label: "Credit Notes",
    required: ["Credit Note Number", "Contact Name", "Credit Note Date", "Account Code", "Unit Amount"],
    optional: ["Reference", "Line Description", "Quantity", "Tax Type", "Currency Code", "Exchange Rate", "Status"],
    rules: [
      "Credit Note Number must be unique across Xero",
      "Credit Note Date column name must be exactly 'Credit Note Date' — not 'Date'",
      "Contact Name must match the customer in Xero exactly",
      "Unit Amount should be positive — do not enter negative amounts",
      "This import creates CUSTOMER (AR) credit notes only — for SUPPLIER (AP) credit notes / debit notes, use the Bills import with negative Unit Amount instead",
      "Multiple lines for the same credit note? Use the same Credit Note Number on every line",
      "VOIDED credit note number in Xero → permanently blocked — cannot be re-imported via API. Use a different number or enter manually in Xero",
      "Currency Code must be enabled in Xero Settings → Currencies before importing foreign-currency credit notes",
    ],
    mistakes: [
      { bad: "-500 (negative amount)", good: "500 (positive)", label: "Enter positive amounts only — tool handles the sign" },
      { bad: "Date (column name)", good: "Credit Note Date (correct column name)", label: "Date column named incorrectly" },
      { bad: "Currency symbols in amounts", good: "Numbers only — use ✨ Auto-Fix to clean", label: "Amount format" },
      { bad: "Using this import for supplier (AP) credit notes / debit notes", good: "Use Bills import with negative Unit Amount for AP credit notes", label: "Wrong import type for supplier credit notes" },
    ],
    tips: [
      "After importing credit notes, use the CN Allocation tab to apply them to invoices",
      "Use 🔍 Pre-check Contacts to verify all contact names exist in Xero first",
      "Dry Run shows exactly which credit notes will be created before any Xero changes",
      "Error 'not of valid status for modification'? The credit note number was previously voided in Xero. Use a different credit note number in your CSV",
    ],
  },
  "manual-journals": {
    icon: "📒",
    label: "Manual Journals",
    required: ["Journal Reference", "Date", "Account Code", "Debit", "Credit"],
    optional: ["Narration", "Line Description", "Tax Type", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"],
    rules: [
      "Every journal must have at least 2 lines sharing the same Journal Reference",
      "Total Debits must exactly equal Total Credits for each journal — it must balance",
      "Each line has either Debit OR Credit filled — never both on the same line",
      "Account Code must exist in your Chart of Accounts",
      "Narration is the journal description shown in Xero — optional but recommended",
      "Tax Type: use NONE if no tax applies, or leave blank",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, MM/DD/YYYY (use Convert button for US format)",
      "Xero fiscal year lock — if your organisation has a financial lock date set, journals dated before it will be rejected by Xero with 'The transaction date is in a locked period'. Ask your Xero admin to unlock, or use a date after the lock date",
    ],
    mistakes: [
      { bad: "Debits ≠ Credits (Dr 1000, Cr 900)", good: "Dr 1000 = Cr 1000 (must balance)", label: "Unbalanced journal — most common error" },
      { bad: "Both Debit and Credit filled on same line", good: "Only one per line — other stays blank", label: "Debit AND Credit on same row" },
      { bad: "Only 1 line per Journal Reference", good: "Minimum 2 lines per reference", label: "Single-line journal — won't balance" },
      { bad: "04/01/2026 intended as April 1 but read as Jan 4", good: "Use 🔄 Convert MM/DD → DD/MM button", label: "US date format confusion" },
      { bad: "Journal date before Xero financial lock date", good: "Use a date after the lock date — or ask Xero admin to unlock the period", label: "Xero period locked — journal rejected" },
    ],
    tips: [
      "US format dates (MM/DD/YYYY)? Use the 🔄 Convert MM/DD → DD/MM button before importing",
      "Journal date shifted by 1 day in Xero? Use 'Fix Journal Dates' to shift ±1 day in bulk",
      "Test with 5–10 journals first using Dry Run before running large batches",
      "Narration column = the journal title/memo shown in Xero reports",
      "Check Xero Settings → Financial Settings → Lock Date before importing old-period journals",
    ],
  },
  "spend-money": {
    icon: "💸",
    label: "Spend Money (Bank Payments)",
    required: ["Date", "Bank Account Code", "Account Code", "Unit Amount"],
    optional: ["Reference", "Contact Name", "Line Description", "Tax Type", "Currency Code", "Exchange Rate"],
    rules: [
      "Bank Account Code is the Xero code of the bank account money goes OUT from — not the name",
      "Account Code is the expense account being charged (e.g. office costs, rent) — not the bank",
      "Unit Amount must be positive — this records money leaving the bank",
      "Reference is used to detect duplicates — keep it unique per transaction",
      "Contact Name links to a Xero contact (creates/matches automatically)",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Main Bank (account name)", good: "090 or similar (account code)", label: "Bank account name instead of code" },
      { bad: "-500 (negative amount)", good: "500 (positive)", label: "Negative amount for spend" },
      { bad: "Income/revenue account code", good: "Expense account code", label: "Wrong account type — must be expense" },
      { bad: "₹1,000 or $500.00", good: "1000 or 500", label: "Currency symbols in Unit Amount — use ✨ Auto-Fix" },
    ],
    tips: [
      "Bank Account Code ≠ expense Account Code — both must be in your Chart of Accounts",
      "Use ✨ Auto-Fix to strip currency symbols from Unit Amount before importing",
      "Check bank account codes in Xero → Accounting → Chart of Accounts (filter by Type: Bank)",
    ],
  },
  "receive-money": {
    icon: "💰",
    label: "Receive Money (Bank Receipts)",
    required: ["Date", "Bank Account Code", "Account Code", "Unit Amount"],
    optional: ["Reference", "Contact Name", "Line Description", "Tax Type", "Currency Code", "Exchange Rate"],
    rules: [
      "Bank Account Code is the Xero code of the bank account money comes INTO",
      "Account Code is the income/revenue account being credited — not the bank account",
      "Unit Amount must be positive",
      "Reference is used to detect duplicates — keep it unique",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Main Bank (account name)", good: "090 or similar (account code)", label: "Bank account name instead of code" },
      { bad: "Expense account code", good: "Income/revenue account code", label: "Wrong account type for income" },
      { bad: "₹1,000 or $500.00", good: "1000 or 500", label: "Currency symbols — use ✨ Auto-Fix" },
    ],
    tips: [
      "Contact Name creates or matches a Xero contact automatically",
      "Use ✨ Auto-Fix to strip currency symbols from Unit Amount",
      "Check income account codes in Xero → Chart of Accounts (filter by Type: Revenue)",
    ],
  },
  "bank-transfers": {
    icon: "🏦",
    label: "Bank Transfers",
    required: ["Date", "Amount", "From Account Code", "To Account Code"],
    optional: ["Description", "Reference"],
    rules: [
      "From Account Code is the bank account code money leaves from",
      "To Account Code is the bank account code money arrives into",
      "Both must be actual bank account codes in your Xero Chart of Accounts",
      "Amount must be positive",
      "From and To must be two different bank accounts",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Main Bank (account name)", good: "090 or similar (account code)", label: "Account name instead of code" },
      { bad: "Same code in From and To", good: "Must be two different bank accounts", label: "From and To are the same" },
    ],
    tips: [
      "Bank account codes are usually 3–4 digit numbers — find them in Chart of Accounts → Bank accounts",
      "Re-running this import will create DUPLICATE transfers — Xero has no duplicate detection for bank transfers. Always verify in Xero before re-importing",
      "For multi-currency transfers, the currency must be enabled in Xero Settings → Currencies first",
    ],
  },
  "purchase-orders": {
    icon: "📦",
    label: "Purchase Orders",
    required: ["PO Number", "Contact Name", "Date", "Account Code", "Unit Amount"],
    optional: ["Delivery Date", "Line Description", "Quantity", "Tax Type", "Currency Code", "Reference"],
    rules: [
      "PO Number must be unique across Xero",
      "Contact Name must match the supplier in Xero — or enable 'Auto-create contacts'",
      "Multiple lines for the same PO? Use the same PO Number on all lines",
      "Unit Amount must be a number — no currency symbols",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Same PO number for two different orders", good: "Unique PO number per order", label: "Duplicate PO Numbers" },
      { bad: "₹1,000 or $500", good: "1000 or 500", label: "Currency symbols in Unit Amount" },
    ],
    tips: [
      "Use 🔍 Pre-check Contacts to verify all supplier names exist in Xero before importing",
      "Multiple lines per PO share the same PO Number — they merge into one PO in Xero",
    ],
  },
  quotes: {
    icon: "💬",
    label: "Quotes",
    required: ["Quote Number", "Contact Name", "Date", "Account Code", "Unit Amount"],
    optional: ["Expiry Date", "Line Description", "Quantity", "Tax Type", "Currency Code", "Reference"],
    rules: [
      "Quote Number must be unique across Xero",
      "Contact Name must match the customer in Xero — or enable 'Auto-create contacts'",
      "Multiple lines for the same quote? Use the same Quote Number on all lines",
      "Unit Amount must be a number — no currency symbols",
      "Expiry Date must be the same or after the Quote Date",
    ],
    mistakes: [
      { bad: "Expiry date before quote date", good: "Expiry date must be after or same as quote date", label: "Invalid expiry date" },
      { bad: "₹1,000 or $500", good: "1000 or 500", label: "Currency symbols in Unit Amount" },
    ],
    tips: [
      "Quotes import as DRAFT — you can approve them directly in Xero after import",
      "Use 🔍 Pre-check Contacts to verify all customer names exist in Xero",
      "Multiple lines per quote share the same Quote Number",
    ],
  },
  "bill-payments": {
    icon: "✅",
    label: "Bill Payments",
    required: ["Invoice Number", "Bank Account Code", "Date", "Amount"],
    optional: ["Contact Name", "Reference", "Currency Rate"],
    rules: [
      "Invoice Number column holds the Bill Number/Reference — must exactly match an existing bill in Xero",
      "Date is the payment date — must be on or after the bill date",
      "Amount cannot exceed the outstanding balance on the bill",
      "Bank Account Code must be a valid bank account code in Xero (not account name)",
      "The bill must be in AUTHORISED status — not DRAFT",
    ],
    mistakes: [
      { bad: "Bill Reference (column name)", good: "Invoice Number (correct column name for this import)", label: "Column name mismatch — must be 'Invoice Number'" },
      { bad: "Payment Date (column name)", good: "Date (correct column name)", label: "Date column should be named 'Date'" },
      { bad: "Bill doesn't exist or is DRAFT in Xero", good: "Import and authorise bills first, then payments", label: "Bill not found or wrong status" },
      { bad: "Amount > outstanding balance", good: "Amount ≤ remaining balance on bill", label: "Overpayment attempt" },
    ],
    tips: [
      "Always import and authorise all bills FIRST, then apply payments in a second step",
      "Use 🔍 Pre-check Invoices to verify all bill numbers exist in Xero before importing",
      "Partial payments are fully supported — just enter the partial amount",
      "Column 'Invoice Number' in this CSV = the bill's reference number (Xero calls bills 'ACCPAY invoices')",
      "Xero fiscal year lock — if your org has a lock date set, payment dates must fall after it. Payments to periods before the lock date will be rejected by Xero",
      "Payment date must be on or after the bill date — earlier payment dates are rejected by Xero",
    ],
  },
  "invoice-payments": {
    icon: "✅",
    label: "Invoice Payments",
    required: ["Invoice Number", "Bank Account Code", "Date", "Amount"],
    optional: ["Reference", "Currency Rate"],
    rules: [
      "Invoice Number must exactly match an existing invoice in Xero",
      "Date is the payment date — must be on or after the invoice date",
      "Amount cannot exceed the outstanding balance on the invoice",
      "Bank Account Code must be a valid bank account code in Xero",
      "The invoice must be in AUTHORISED status — not DRAFT",
    ],
    mistakes: [
      { bad: "Payment Date (column name)", good: "Date (correct column name)", label: "Date column should be named 'Date'" },
      { bad: "Invoice doesn't exist or is DRAFT", good: "Import and authorise invoices first", label: "Invoice not found or wrong status" },
      { bad: "Amount > outstanding balance", good: "Amount ≤ remaining balance", label: "Overpayment attempt" },
    ],
    tips: [
      "Always import all invoices FIRST, then apply payments in a separate step",
      "Use 🔍 Pre-check Invoices to verify all invoice numbers exist before importing",
      "Partial payments are fully supported",
      "Xero fiscal year lock — payment dates must fall after the lock date. Check Xero Settings → Financial Settings",
      "Payment date must be on or after the invoice date — earlier dates are rejected by Xero",
    ],
  },
  "credit-note-refunds": {
    icon: "↩️",
    label: "Credit Note Refunds",
    required: ["Credit Note Number", "Bank Account Code", "Date", "Amount"],
    optional: ["Reference", "Currency Rate"],
    rules: [
      "Credit Note Number must exactly match an existing credit note in Xero",
      "Date is the refund date — must be on or after the credit note date",
      "Amount cannot exceed the remaining balance on the credit note",
      "Bank Account Code must be a valid bank account code in Xero",
      "The credit note must be in AUTHORISED status",
    ],
    mistakes: [
      { bad: "Payment Date (column name)", good: "Date (correct column name)", label: "Date column should be named 'Date'" },
      { bad: "Credit note not yet in Xero", good: "Import credit notes first, then refunds", label: "Credit note not found" },
      { bad: "Amount > credit note balance", good: "Amount ≤ remaining credit balance", label: "Amount exceeds credit note balance" },
    ],
    tips: [
      "Import all credit notes FIRST, then apply refunds in a separate step",
      "Use 🔍 Pre-check Invoices to verify credit note numbers exist in Xero",
    ],
  },
  items: {
    icon: "🏷️",
    label: "Items (Products & Services)",
    required: ["Item Code", "Name"],
    optional: ["Description", "Purchase Price", "Purchase Account", "Sales Price", "Sales Account", "Tax Type", "Is Tracked"],
    rules: [
      "Item Code must be unique across Xero — duplicates will error",
      "Purchase Account and Sales Account must be valid account codes from Chart of Accounts",
      "For tracked inventory items, set 'Is Tracked' to TRUE",
      "Sales Account should be a revenue account; Purchase Account should be an expense/COGS account",
    ],
    mistakes: [
      { bad: "Duplicate item codes", good: "Each item must have a unique code", label: "Duplicate Item Codes" },
      { bad: "Account name (e.g. 'Cost of Sales')", good: "Account code (e.g. '310')", label: "Account name instead of code" },
    ],
    tips: [
      "Items appear in line-item dropdowns when creating invoices/bills in Xero",
      "Leave Purchase/Sales fields blank for simple service items with no default account",
      "Existing item codes in Xero will be skipped — update them directly in Xero instead",
    ],
  },
  customers: {
    icon: "👥",
    label: "Customers (Contacts)",
    required: ["Name"],
    optional: ["Email", "Phone", "Address Line 1", "City", "Country", "Postal Code", "Account Number"],
    rules: [
      "Contact Name must be unique — if it matches an existing Xero contact, it will be updated",
      "Email must be a valid format (e.g. name@company.com) if provided",
      "Country must be a 2-letter ISO code (IN, AU, NZ, GB, US, SG, etc.)",
      "Phone number should not include formatting like +91 (0) — plain digits work best",
    ],
    mistakes: [
      { bad: "India or New Zealand", good: "IN or NZ (ISO 2-letter code)", label: "Country full name instead of ISO code" },
      { bad: "name at company.com", good: "name@company.com", label: "Invalid email format" },
    ],
    tips: [
      "Customers and suppliers are both 'Contacts' in Xero — same import format",
      "If the name already exists in Xero, the import will update the existing contact's details",
      "You can import customers and suppliers together in one file using this format",
    ],
  },
  vendors: {
    icon: "🏢",
    label: "Suppliers (Vendors)",
    required: ["Name"],
    optional: ["Email", "Phone", "Address Line 1", "City", "Country", "Postal Code", "Account Number"],
    rules: [
      "Supplier Name must be unique — matching names update the existing Xero contact",
      "Email must be valid format if provided",
      "Country must be a 2-letter ISO code (IN, AU, NZ, GB, US, etc.)",
    ],
    mistakes: [
      { bad: "Australia or India", good: "AU or IN (ISO 2-letter code)", label: "Country full name instead of ISO code" },
      { bad: "name at supplier.com", good: "name@supplier.com", label: "Invalid email format" },
    ],
    tips: [
      "Customers and suppliers share the same Contacts list in Xero",
      "Existing contacts with matching names will be updated — not duplicated",
    ],
  },
  accounts: {
    icon: "📊",
    label: "Chart of Accounts",
    required: ["Code", "Name", "Type"],
    optional: ["Description", "Tax", "Bank Account Number", "Currency Code"],
    rules: [
      "Account Code must be unique — if it already exists in Xero, the row will error",
      "Type must be a valid Xero account type: BANK, REVENUE, DIRECTCOSTS, EXPENSE, EQUITY, LIABILITY, ASSET, etc.",
      "Tax code must be a valid Xero tax type code if provided",
      "BANK type accounts require Bank Account Number to function correctly in Xero",
    ],
    mistakes: [
      { bad: "Expense (invalid type)", good: "EXPENSE (valid Xero account type)", label: "Account type must be uppercase Xero keyword" },
      { bad: "Account code that already exists", good: "Only import codes that are new to Xero", label: "Duplicate account code — will error" },
    ],
    tips: [
      "Download the template to see all valid Xero account type keywords",
      "Existing accounts will error — update them directly in Xero instead of re-importing",
    ],
  },
  "tracking-categories": {
    icon: "🗂️",
    label: "Tracking Categories",
    required: ["Category Name", "Option Name"],
    optional: [],
    rules: [
      "Category Name must exactly match a tracking category already created in Xero Settings",
      "Option Name is the new tracking option/value you want to add to that category",
      "Duplicate options within the same category will be skipped",
      "The tracking category itself must be created in Xero first — this tool only adds options",
    ],
    mistakes: [
      { bad: "Creating a brand new tracking category via import", good: "Create the category in Xero Settings first", label: "Category must already exist in Xero" },
      { bad: "Category Name spelled differently or with extra spaces", good: "Must be exact match with Xero", label: "Category name mismatch" },
    ],
    tips: [
      "Go to Xero → Settings → Tracking Categories to create the category first",
      "Then import options here using the exact same category name spelling from Xero",
    ],
  },
  "spend-op": {
    icon: "💼",
    label: "Spend Overpayments",
    required: ["Date", "Bank Account Code", "Contact Name", "Unit Amount"],
    optional: ["Reference", "Line Description", "Currency Code"],
    rules: [
      "Unit Amount must be positive",
      "Bank Account Code is the Xero code of the bank account money leaves from",
      "Contact Name must match an existing contact in Xero",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Bank account name", good: "Bank account code (e.g. '090')", label: "Using account name instead of code" },
      { bad: "₹1,000 or $500", good: "1000 or 500", label: "Currency symbols in Unit Amount" },
    ],
    tips: [
      "Overpayments appear in the contact's transaction history in Xero",
      "They can be applied to future bills using Spend Allocation after import",
    ],
  },
  "receive-op": {
    icon: "💼",
    label: "Receive Overpayments",
    required: ["Date", "Bank Account Code", "Contact Name", "Unit Amount"],
    optional: ["Reference", "Line Description", "Currency Code"],
    rules: [
      "Unit Amount must be positive",
      "Bank Account Code is the Xero code of the receiving bank account",
      "Contact Name must match an existing contact in Xero",
      "Dates accepted: DD/MM/YYYY, YYYY-MM-DD, DD-MMM-YY, and more",
    ],
    mistakes: [
      { bad: "Bank account name", good: "Bank account code (e.g. '090')", label: "Using account name instead of code" },
      { bad: "₹1,000 or $500", good: "1000 or 500", label: "Currency symbols in Unit Amount" },
    ],
    tips: [
      "Overpayments can be applied to future invoices using Receive Allocation after import",
    ],
  },
  "spend-allocation": {
    icon: "⇌",
    label: "Spend Money Allocation",
    required: ["Overpayment Reference", "Bill Number", "Contact Name", "Amount"],
    optional: ["Date"],
    rules: [
      "Overpayment Reference must match an existing spend money / overpayment transaction in Xero",
      "Bill Number must match an existing bill in Xero",
      "Contact Name must be the same on both the overpayment and the bill",
      "Amount cannot exceed either transaction's remaining balance",
    ],
    mistakes: [
      { bad: "Reference (column name)", good: "Overpayment Reference (correct column name)", label: "Wrong column header name" },
      { bad: "Allocate To Reference (column name)", good: "Bill Number (correct column name)", label: "Wrong column header name" },
      { bad: "Transactions not yet in Xero", good: "Import spend money first, then allocate", label: "Transaction not found in Xero" },
    ],
    tips: [
      "Import the spend money transactions first, then use this to allocate them to bills",
      "Both documents must belong to the same Xero contact",
    ],
  },
  "receive-allocation": {
    icon: "⇌",
    label: "Receive Money Allocation",
    required: ["Overpayment Reference", "Invoice Number", "Contact Name", "Amount"],
    optional: ["Date"],
    rules: [
      "Overpayment Reference must match an existing receive money / overpayment transaction in Xero",
      "Invoice Number must match an existing invoice in Xero",
      "Contact Name must be the same on both the overpayment and the invoice",
      "Amount cannot exceed either transaction's remaining balance",
    ],
    mistakes: [
      { bad: "Reference (column name)", good: "Overpayment Reference (correct column name)", label: "Wrong column header name" },
      { bad: "Allocate To Reference (column name)", good: "Invoice Number (correct column name)", label: "Wrong column header name" },
      { bad: "Transactions not yet in Xero", good: "Import receive money first, then allocate", label: "Transaction not found in Xero" },
    ],
    tips: [
      "Import the receive money transactions first, then use this to allocate them to invoices",
    ],
  },
  "cn-allocation": {
    icon: "⇌",
    label: "Credit Note Allocation (to Invoices)",
    required: ["Credit Note Number", "Invoice Number", "Contact Name", "Amount"],
    optional: ["Date"],
    rules: [
      "Credit Note Number must match an existing AUTHORISED credit note in Xero",
      "Invoice Number must match an existing AUTHORISED invoice in Xero",
      "Contact Name must be the same on both the credit note and invoice",
      "Amount cannot exceed either document's remaining balance",
    ],
    mistakes: [
      { bad: "Credit note or invoice still DRAFT", good: "Both must be AUTHORISED in Xero", label: "Wrong status — must be AUTHORISED" },
      { bad: "Different contacts on credit note and invoice", good: "Must be the same contact on both", label: "Contact mismatch" },
    ],
    tips: [
      "Import and authorise credit notes and invoices first, then use this to apply the credit",
      "Amount column = how much of the credit note to apply to that invoice (can be partial)",
    ],
  },
  "dn-allocation": {
    icon: "⇌",
    label: "Debit Note Allocation (to Bills)",
    required: ["Credit Note Number", "Bill Number", "Contact Name", "Amount"],
    optional: ["Date"],
    rules: [
      "Credit Note Number (the debit note/AP credit note) must match an existing credit note in Xero",
      "Bill Number must match an existing AUTHORISED bill in Xero",
      "Contact Name (supplier) must be the same on both documents",
      "Amount cannot exceed either document's remaining balance",
    ],
    mistakes: [
      { bad: "Documents still DRAFT", good: "Both must be AUTHORISED in Xero before allocating", label: "Wrong status — must be AUTHORISED" },
      { bad: "Different suppliers on debit note and bill", good: "Must be the same supplier contact on both", label: "Supplier contact mismatch" },
    ],
    tips: [
      "Import debit notes (as AP credit notes) and bills first, then use this to allocate them",
    ],
  },
  "update-status": {
    icon: "✎",
    label: "Bulk Update Status",
    required: ["Number", "New Status", "Type"],
    optional: [],
    rules: [
      "Number must exactly match an invoice/bill/quote number in Xero",
      "New Status must be a valid Xero status: AUTHORISED, VOIDED, DELETED, SUBMITTED",
      "Type must match the document type: INVOICE, BILL, CREDITNOTE, QUOTE, PURCHASEORDER",
      "PAID status cannot be set here — apply payments via the payments import instead",
      "DRAFT invoices/bills can be set to AUTHORISED, VOIDED, or DELETED",
    ],
    mistakes: [
      { bad: "PAID (status via this tool)", good: "Use invoice-payments / bill-payments import instead", label: "Cannot set PAID status here" },
      { bad: "Document number doesn't match Xero exactly", good: "Number must be exact — case sensitive", label: "Number mismatch" },
      { bad: "invoice (lowercase type)", good: "INVOICE (uppercase)", label: "Type must be uppercase" },
    ],
    tips: [
      "Use VOIDED to void documents — this preserves the audit trail in Xero",
      "DELETED removes the document entirely — use VOIDED unless you specifically need deletion",
    ],
  },
  "exchange-rate-update": {
    icon: "💱",
    label: "Exchange Rate Update",
    required: ["Invoice Number", "New Rate"],
    optional: [],
    rules: [
      "Invoice Number must match an existing foreign-currency invoice or bill in Xero",
      "New Rate is the exchange rate to the base currency (e.g. 83.5 for USD to INR)",
      "Only applies to invoices/bills in a foreign currency — base currency documents will error",
    ],
    mistakes: [
      { bad: "Base currency invoice (e.g. INR invoice in an INR org)", good: "Only update foreign currency invoices", label: "Wrong currency — base currency not applicable" },
      { bad: "Rate as a percentage (e.g. 8350)", good: "Rate as a multiplier (e.g. 83.50)", label: "Exchange rate format" },
    ],
    tips: [
      "Exchange rates affect the base-currency value shown in Xero reports",
      "Use the current market rate or the rate on the transaction date",
    ],
  },
};

const STATE_CONFIG = {
  nofile: {
    color: "#64748b",
    bg: "rgba(100,116,139,0.08)",
    border: "rgba(100,116,139,0.25)",
    icon: "📂",
    text: "Upload a CSV to get started. Download the template first if you don't have one.",
  },
  errors: {
    color: "#f87171",
    bg: "rgba(248,113,113,0.08)",
    border: "rgba(248,113,113,0.3)",
    icon: "⚠️",
    textFn: n => `${n} validation error(s) found — check the Mistakes tab below to fix them.`,
  },
  valid: {
    color: "#34d399",
    bg: "rgba(52,211,153,0.08)",
    border: "rgba(52,211,153,0.3)",
    icon: "✅",
    textFn: n => `${n.toLocaleString()} row(s) validated successfully. Review the data preview, then click Import.`,
  },
  importing: {
    color: "#60a5fa",
    bg: "rgba(96,165,250,0.08)",
    border: "rgba(96,165,250,0.3)",
    icon: "⏳",
    text: "Import in progress — do not close this tab.",
  },
};

export default function ImportGuide({ importType, rowCount, errorCount, isLoading, hasFile }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("kk_guide_open") !== "false"; }
    catch { return true; }
  });
  const [activeTab, setActiveTab] = useState("rules");

  const content = GUIDE_CONTENT[importType];

  useEffect(() => {
    try { localStorage.setItem("kk_guide_open", String(open)); }
    catch {}
  }, [open]);

  useEffect(() => { setActiveTab("rules"); }, [importType]);

  if (!content) return null;

  const state = isLoading
    ? "importing"
    : errorCount > 0
    ? "errors"
    : rowCount > 0
    ? "valid"
    : "nofile";

  const sc = STATE_CONFIG[state];
  const bannerText = sc.textFn
    ? sc.textFn(state === "valid" ? rowCount : errorCount)
    : sc.text;

  return (
    <div className="import-guide">
      <div className="import-guide__header" onClick={() => setOpen(o => !o)}>
        <div className="import-guide__header-left">
          <span className="import-guide__type-icon">{content.icon}</span>
          <span className="import-guide__title">{content.label} — Import Guide</span>
        </div>
        <div className="import-guide__toggle">
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </div>
      </div>

      <div className="import-guide__state-banner" style={{ background: sc.bg, borderColor: sc.border }}>
        <span>{sc.icon}</span>
        <span style={{ color: sc.color }}>{bannerText}</span>
      </div>

      {open && (
        <div className="import-guide__body">
          <div className="import-guide__columns-section">
            <div className="import-guide__section-label">Required</div>
            <div className="import-guide__chips">
              {content.required.map(c => (
                <span key={c} className="import-guide__chip import-guide__chip--required">{c}</span>
              ))}
            </div>
            {content.optional.length > 0 && (
              <>
                <div className="import-guide__section-label" style={{ marginTop: 8 }}>Optional</div>
                <div className="import-guide__chips">
                  {content.optional.map(c => (
                    <span key={c} className="import-guide__chip import-guide__chip--optional">{c}</span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="import-guide__tabs">
            {[
              { key: "rules", label: "📋 Rules" },
              { key: "mistakes", label: "⚠️ Mistakes" },
              { key: "tips", label: "💡 Tips" },
            ].map(tab => (
              <button
                key={tab.key}
                className={`import-guide__tab${activeTab === tab.key ? " import-guide__tab--active" : ""}`}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "rules" && (
            <ul className="import-guide__list">
              {content.rules.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {activeTab === "mistakes" && (
            <div className="import-guide__mistakes">
              {content.mistakes.map((m, i) => (
                <div key={i} className="import-guide__mistake">
                  <div className="import-guide__mistake-label">{m.label}</div>
                  <div className="import-guide__mistake-row">
                    <span className="import-guide__mistake-bad">❌ {m.bad}</span>
                    <span className="import-guide__mistake-arrow">→</span>
                    <span className="import-guide__mistake-good">✅ {m.good}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "tips" && (
            <ul className="import-guide__list import-guide__list--tips">
              {content.tips.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
