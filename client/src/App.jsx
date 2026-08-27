import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "sonner";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import FileDropZone from "./components/FileDropZone.jsx";
import ConfirmModal from "./components/ConfirmModal.jsx";
import { EmptyStateNoHistory, EmptyStateSelectTenant } from "./components/EmptyState.jsx";
import PrismScene from "./components/PrismScene.jsx";
import Spinner from "./components/Spinner.jsx";
import { PrismMark, PrismWordmark } from "./components/PrismLogo.jsx";
import ImportPrismMark from "./components/ImportPrismMark.jsx";
import {
  LayoutDashboard, Clock, SlidersHorizontal,
  RefreshCw, Upload, Trash2, BookOpen, LogOut,
  Database, ArrowUpRight, FileInput, Layers,
  Moon, Sun, Menu, X as XIcon, User
} from "lucide-react";
import { motion } from "framer-motion";
import ColumnMappingModal from "./components/ColumnMappingModal.jsx";
import AccountingLoader from "./components/AccountingLoader.jsx";
import VoidLoader from "./components/VoidLoader.jsx";
import AutoAllocation from "./components/AutoAllocation.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import ImportGuide from "./components/ImportGuide.jsx";
import Terms from "./pages/Terms.jsx";
import Privacy from "./pages/Privacy.jsx";
import Pricing from "./pages/Pricing.jsx";
import Account from "./pages/Account.jsx";
import Signup from "./pages/Signup.jsx";
import LandingPage from "./pages/LandingPage.jsx";
import CookieConsent from "./components/CookieConsent.jsx";
import Lottie from "lottie-react";

import importAnimation from "./assets/import-loader.json";
const pageMotion = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2, ease: "easeOut" } };

// Fuzzy matching helpers for auto column mapping
const _lev = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
};
const _normF = s => s.toLowerCase().replace(/[\s_\-\.\/\(\)]+/g, "");
const _fuzzyScore = (a, b) => {
  const na = _normF(a), nb = _normF(b);
  if (na === nb) return 100;
  if (na.includes(nb) || nb.includes(na)) return Math.max(50, Math.round(85 - Math.abs(na.length - nb.length) * 2));
  const maxLen = Math.max(na.length, nb.length);
  return maxLen === 0 ? 100 : Math.round((1 - _lev(na, nb) / maxLen) * 100);
};
const computeFuzzyMapping = (actualHeaders, expectedHeaders, optionalHeaders = [], importTypeKey = "") => {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem(`kk_colmap_${importTypeKey}`) || "null"); }
    catch { return null; }
  })();
  const mapping = {}, confidence = {};
  const usedCols = new Set();
  for (const expected of [...expectedHeaders, ...optionalHeaders]) {
    const savedCol = saved && saved[expected] ? saved[expected].trim() : null;
    const savedMatch = savedCol ? actualHeaders.find(a => a.trim().toLowerCase() === savedCol.toLowerCase()) : null;
    if (savedMatch) {
      mapping[expected] = savedMatch;
      confidence[expected] = 100;
      usedCols.add(savedMatch);
      continue;
    }
    let bestScore = 0, bestCol = "";
    for (const col of actualHeaders) {
      if (usedCols.has(col)) continue;
      const score = _fuzzyScore(expected, col);
      if (score > bestScore) { bestScore = score; bestCol = col; }
    }
    if (bestScore >= 40) {
      mapping[expected] = bestCol;
      confidence[expected] = bestScore;
      usedCols.add(bestCol);
    } else {
      mapping[expected] = "";
      confidence[expected] = 0;
    }
  }
  return { mapping, confidence };
};
const resolveApiBase = () => {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  const path = window.location.pathname || "/";
  if (path.startsWith("/xero-data-extraction/")) {
    return "/xero-data-extraction/api";
  }
  return "/api";
};
const API_BASE = resolveApiBase();
// Add credentials:include to all /api/ fetch calls so httpOnly cookies are sent automatically
if (typeof window !== "undefined" && !window.__apiFetchWrapped) {
  const _nativeFetch = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    if (typeof url === "string" && url.includes("/api/")) {
      return _nativeFetch(url, { credentials: "include", ...opts });
    }
    return _nativeFetch(url, opts);
  };
  window.__apiFetchWrapped = true;
}

// ── Hero pricing: auto-detect visitor currency from browser locale + timezone ──
const HERO_PRICES = {
  INR: { sym: "₹",  name: "INR", starter: "3,299",  pro: "8,499",  growth: "14,999" },
  GBP: { sym: "£",  name: "GBP", starter: "32",      pro: "84",     growth: "149"    },
  USD: { sym: "$",  name: "USD", starter: "39",      pro: "99",     growth: "179"    },
  AUD: { sym: "A$", name: "AUD", starter: "59",      pro: "149",    growth: "249"    },
  EUR: { sym: "€",  name: "EUR", starter: "36",      pro: "92",     growth: "169"    },
  ZAR: { sym: "R",  name: "ZAR", starter: "699",     pro: "1,799",  growth: "2,999"  },
};
function detectHeroCurrency() {
  try {
    const lang = (navigator.language || "").toLowerCase();
    const tz   = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
    if (lang.startsWith("en-gb") || tz === "europe/london")      return "GBP";
    if (lang.startsWith("en-au") || tz.startsWith("australia/")) return "AUD";
    if (lang.startsWith("en-nz") || tz === "pacific/auckland")   return "AUD";
    if (lang.startsWith("en-za") || tz === "africa/johannesburg") return "ZAR";
    if (lang.startsWith("en-in") || tz === "asia/kolkata")       return "INR";
    if (lang.startsWith("en-ie") || tz === "europe/dublin")      return "EUR";
    if (tz.startsWith("europe/") || /^(fr|de|es|it|nl|pt|pl|cs|sk|ro|hu)/.test(lang)) return "EUR";
    return "USD";
  } catch { return "USD"; }
}

function App() {
  const _location = useLocation();
  const _routerNavigate = useNavigate();
  const currentPath = _location.pathname;
  const [user, setUser] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [userToken, setUserToken] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [forgotPwOpen, setForgotPwOpen] = useState(false);
  const [forgotPwEmail, setForgotPwEmail] = useState("");
  const [forgotPwLoading, setForgotPwLoading] = useState(false);
  const [forgotPwSent, setForgotPwSent] = useState(false);
  const [selectedWorkspace, setSelectedWorkspace] = useState("extraction");
  const [dateFormatPref, setDateFormatPref] = useState(() => localStorage.getItem("kk_dateFormat") || "DD/MM/YYYY");
  const [accountsImportFile, setAccountsImportFile] = useState(null);
  const [accountsImportStatus, setAccountsImportStatus] = useState(() => localStorage.getItem("kk_accountsJobId") ? "Reconnecting to in-progress import..." : "");
  const [accountsImportRows, setAccountsImportRows] = useState([]);
  const [accountsImportErrors, setAccountsImportErrors] = useState([]);
  const [accountsImportLoading, setAccountsImportLoading] = useState(() => !!localStorage.getItem("kk_accountsJobId"));
  const [accountsImportJobId, setAccountsImportJobId] = useState(() => localStorage.getItem("kk_accountsJobId") || "");
  const [accountsImportProgress, setAccountsImportProgress] = useState(null);
  const [billsImportFile, setBillsImportFile] = useState(null);
  const [billsImportRows, setBillsImportRows] = useState([]);
  const [billsImportErrors, setBillsImportErrors] = useState([]);
  const [billsImportStatus, setBillsImportStatus] = useState(() => localStorage.getItem("kk_billsJobId") ? "Reconnecting to in-progress import..." : "");
  const [billsImportJobId, setBillsImportJobId] = useState(() => localStorage.getItem("kk_billsJobId") || "");
  const [billsImportProgress, setBillsImportProgress] = useState(null);
  const [billsImportLoading, setBillsImportLoading] = useState(() => !!localStorage.getItem("kk_billsJobId"));
  const [invoicesImportFile, setInvoicesImportFile] = useState(null);
  const [invoicesImportRows, setInvoicesImportRows] = useState([]);
  const [invoicesImportErrors, setInvoicesImportErrors] = useState([]);
  const [invoicesImportStatus, setInvoicesImportStatus] = useState(() => localStorage.getItem("kk_invoicesJobId") ? "Reconnecting to in-progress import..." : "");
  const [invoicesImportJobId, setInvoicesImportJobId] = useState(() => localStorage.getItem("kk_invoicesJobId") || "");
  const [invoicesImportProgress, setInvoicesImportProgress] = useState(null);
  const [invoicesImportLoading, setInvoicesImportLoading] = useState(() => !!localStorage.getItem("kk_invoicesJobId"));
  const [creditNotesImportFile, setCreditNotesImportFile] = useState(null);
  const [creditNotesImportRows, setCreditNotesImportRows] = useState([]);
  const [creditNotesImportErrors, setCreditNotesImportErrors] = useState([]);
  const [creditNotesImportStatus, setCreditNotesImportStatus] = useState(() => localStorage.getItem("kk_creditNotesJobId") ? "Reconnecting to in-progress import..." : "");
  const [creditNotesImportJobId, setCreditNotesImportJobId] = useState(() => localStorage.getItem("kk_creditNotesJobId") || "");
  const [creditNotesImportProgress, setCreditNotesImportProgress] = useState(null);
  const [creditNotesImportLoading, setCreditNotesImportLoading] = useState(() => !!localStorage.getItem("kk_creditNotesJobId"));
  const [spendMoneyFile, setSpendMoneyFile] = useState(null);
  const [spendMoneyRows, setSpendMoneyRows] = useState([]);
  const [spendMoneyErrors, setSpendMoneyErrors] = useState([]);
  const [spendMoneyStatus, setSpendMoneyStatus] = useState(() => localStorage.getItem("kk_spendMoneyJobId") ? "Reconnecting to in-progress import..." : "");
  const [spendMoneyJobId, setSpendMoneyJobId] = useState(() => localStorage.getItem("kk_spendMoneyJobId") || "");
  const [spendMoneyProgress, setSpendMoneyProgress] = useState(null);
  const [spendMoneyLoading, setSpendMoneyLoading] = useState(() => !!localStorage.getItem("kk_spendMoneyJobId"));
  const [spendMoneySkipDupCheck, setSpendMoneySkipDupCheck] = useState(false);
  const [dryRunMode, setDryRunMode] = useState(false);
  const [dryRunResult, setDryRunResult] = useState(null);
  const [importHistory, setImportHistory] = useState([]);
  const [importHistoryLoading, setImportHistoryLoading] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [lastImportMeta, setLastImportMeta] = useState(null);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoResult, setUndoResult] = useState(null);
  const [undoingHistoryId, setUndoingHistoryId] = useState(null);
  const [undoProgress, setUndoProgress] = useState(null);
  const [columnMappingState, setColumnMappingState] = useState(null);
  const [interruptedCheckpoints, setInterruptedCheckpoints] = useState([]);
  const [historySearch, setHistorySearch] = useState("");
  const [historyTypeFilter, setHistoryTypeFilter] = useState("");
  const [historyStatusFilter, setHistoryStatusFilter] = useState("");
  const [xeroQuota, setXeroQuota] = useState(null);
  const [filterDeleteType, setFilterDeleteType] = useState("invoices");
  const [filterDeleteStatus, setFilterDeleteStatus] = useState("DRAFT");
  const [filterDeleteFrom, setFilterDeleteFrom] = useState("");
  const [filterDeleteTo, setFilterDeleteTo] = useState("");
  const [filterDeleteScanResult, setFilterDeleteScanResult] = useState(null);
  const [filterDeleteScanning, setFilterDeleteScanning] = useState(false);
  const [filterDeleteJobId, setFilterDeleteJobId] = useState("");
  const [filterDeleteProgress, setFilterDeleteProgress] = useState(null);
  const [filterDeleteRunning, setFilterDeleteRunning] = useState(false);
  const [inlineEditMode, setInlineEditMode] = useState(false);
  const [inlineEditDraft, setInlineEditDraft] = useState({});
  const [progressOverlayMinimized, setProgressOverlayMinimized] = useState(false);
  const [stopConfirming, setStopConfirming] = useState(false);
  const [receiveMoneyFile, setReceiveMoneyFile] = useState(null);
  const [receiveMoneyRows, setReceiveMoneyRows] = useState([]);
  const [receiveMoneyErrors, setReceiveMoneyErrors] = useState([]);
  const [receiveMoneyStatus, setReceiveMoneyStatus] = useState(() => localStorage.getItem("kk_receiveMoneyJobId") ? "Reconnecting to in-progress import..." : "");
  const [receiveMoneyJobId, setReceiveMoneyJobId] = useState(() => localStorage.getItem("kk_receiveMoneyJobId") || "");
  const [receiveMoneyProgress, setReceiveMoneyProgress] = useState(null);
  const [receiveMoneyLoading, setReceiveMoneyLoading] = useState(() => !!localStorage.getItem("kk_receiveMoneyJobId"));
  const [receiveMoneySkipDupCheck, setReceiveMoneySkipDupCheck] = useState(false);
  const [opSkipDupCheck, setOpSkipDupCheck] = useState(false);
  const [selectedImportType, setSelectedImportType] = useState("");
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [hintStep, setHintStep] = useState(() => localStorage.getItem("kk_hintDone") === "1" ? null : 0);
  const [hintRect, setHintRect] = useState(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideSelectedType, setGuideSelectedType] = useState("bills");
  const [allImportFile, setAllImportFile] = useState(null);
  const [allImportSections, setAllImportSections] = useState([]);
  const [allImportFileError, setAllImportFileError] = useState("");
  const [allImportPhases, setAllImportPhases] = useState([]);
  const [allImportRunning, setAllImportRunning] = useState(false);
  const [conversionDate, setConversionDate] = useState("");
  const [conversionAccounts, setConversionAccounts] = useState([]);
  const [conversionLoading, setConversionLoading] = useState(false);
  const [conversionError, setConversionError] = useState("");
  const [conversionRunning, setConversionRunning] = useState(false);
  const [conversionStatus, setConversionStatus] = useState("");
  const [conversionResult, setConversionResult] = useState(null);
  const [guideSearch, setGuideSearch] = useState("");
  const [billPaymentFile, setBillPaymentFile] = useState(null);
  const [billPaymentRows, setBillPaymentRows] = useState([]);
  const [billPaymentErrors, setBillPaymentErrors] = useState([]);
  const [billPaymentStatus, setBillPaymentStatus] = useState(() => localStorage.getItem("kk_billPaymentJobId") ? "Reconnecting to in-progress import..." : "");
  const [billPaymentJobId, setBillPaymentJobId] = useState(() => localStorage.getItem("kk_billPaymentJobId") || "");
  const [billPaymentProgress, setBillPaymentProgress] = useState(null);
  const [billPaymentLoading, setBillPaymentLoading] = useState(() => !!localStorage.getItem("kk_billPaymentJobId"));
  const [invoicePaymentFile, setInvoicePaymentFile] = useState(null);
  const [invoicePaymentRows, setInvoicePaymentRows] = useState([]);
  const [invoicePaymentErrors, setInvoicePaymentErrors] = useState([]);
  const [invoicePaymentStatus, setInvoicePaymentStatus] = useState(() => localStorage.getItem("kk_invoicePaymentJobId") ? "Reconnecting to in-progress import..." : "");
  const [invoicePaymentJobId, setInvoicePaymentJobId] = useState(() => localStorage.getItem("kk_invoicePaymentJobId") || "");
  const [invoicePaymentProgress, setInvoicePaymentProgress] = useState(null);
  const [invoicePaymentLoading, setInvoicePaymentLoading] = useState(() => !!localStorage.getItem("kk_invoicePaymentJobId"));
  const [creditNoteRefundFile, setCreditNoteRefundFile] = useState(null);
  const [creditNoteRefundRows, setCreditNoteRefundRows] = useState([]);
  const [creditNoteRefundErrors, setCreditNoteRefundErrors] = useState([]);
  const [creditNoteRefundStatus, setCreditNoteRefundStatus] = useState(() => localStorage.getItem("kk_creditNoteRefundJobId") ? "Reconnecting to in-progress import..." : "");
  const [creditNoteRefundJobId, setCreditNoteRefundJobId] = useState(() => localStorage.getItem("kk_creditNoteRefundJobId") || "");
  const [creditNoteRefundProgress, setCreditNoteRefundProgress] = useState(null);
  const [creditNoteRefundLoading, setCreditNoteRefundLoading] = useState(() => !!localStorage.getItem("kk_creditNoteRefundJobId"));
  const [manualJournalFile, setManualJournalFile] = useState(null);
  const [manualJournalRows, setManualJournalRows] = useState([]);
  const [manualJournalErrors, setManualJournalErrors] = useState([]);
  const [manualJournalStatus, setManualJournalStatus] = useState(() => localStorage.getItem("kk_manualJournalJobId") ? "Reconnecting to in-progress import..." : "");
  const [manualJournalJobId, setManualJournalJobId] = useState(() => localStorage.getItem("kk_manualJournalJobId") || "");
  const [manualJournalProgress, setManualJournalProgress] = useState(null);
  const [manualJournalLoading, setManualJournalLoading] = useState(() => !!localStorage.getItem("kk_manualJournalJobId"));
  const [journalFixModal, setJournalFixModal] = useState(false);
  const [journalFixDateFrom, setJournalFixDateFrom] = useState("");
  const [journalFixDateTo, setJournalFixDateTo] = useState("");
  const [journalFixShift, setJournalFixShift] = useState(1);
  const [journalFixLoading, setJournalFixLoading] = useState(false);
  const [journalFixResult, setJournalFixResult] = useState(null);
  const [spendOpFile, setSpendOpFile] = useState(null);
  const [spendOpRows, setSpendOpRows] = useState([]);
  const [spendOpErrors, setSpendOpErrors] = useState([]);
  const [spendOpStatus, setSpendOpStatus] = useState(() => localStorage.getItem("kk_spendOpJobId") ? "Reconnecting to in-progress import..." : "");
  const [spendOpJobId, setSpendOpJobId] = useState(() => localStorage.getItem("kk_spendOpJobId") || "");
  const [spendOpProgress, setSpendOpProgress] = useState(null);
  const [spendOpLoading, setSpendOpLoading] = useState(() => !!localStorage.getItem("kk_spendOpJobId"));
  const [importResultsFilter, setImportResultsFilter] = useState("all");
  const [receiveOpFile, setReceiveOpFile] = useState(null);
  const [receiveOpRows, setReceiveOpRows] = useState([]);
  const [receiveOpErrors, setReceiveOpErrors] = useState([]);
  const [receiveOpStatus, setReceiveOpStatus] = useState(() => localStorage.getItem("kk_receiveOpJobId") ? "Reconnecting to in-progress import..." : "");
  const [receiveOpJobId, setReceiveOpJobId] = useState(() => localStorage.getItem("kk_receiveOpJobId") || "");
  const [receiveOpProgress, setReceiveOpProgress] = useState(null);
  const [receiveOpLoading, setReceiveOpLoading] = useState(() => !!localStorage.getItem("kk_receiveOpJobId"));
  const [spendAllocFile, setSpendAllocFile] = useState(null);
  const [spendAllocRows, setSpendAllocRows] = useState([]);
  const [spendAllocErrors, setSpendAllocErrors] = useState([]);
  const [spendAllocStatus, setSpendAllocStatus] = useState(() => localStorage.getItem("kk_spendAllocJobId") ? "Reconnecting to in-progress import..." : "");
  const [spendAllocJobId, setSpendAllocJobId] = useState(() => localStorage.getItem("kk_spendAllocJobId") || "");
  const [spendAllocProgress, setSpendAllocProgress] = useState(null);
  const [spendAllocLoading, setSpendAllocLoading] = useState(() => !!localStorage.getItem("kk_spendAllocJobId"));
  const [receiveAllocFile, setReceiveAllocFile] = useState(null);
  const [receiveAllocRows, setReceiveAllocRows] = useState([]);
  const [receiveAllocErrors, setReceiveAllocErrors] = useState([]);
  const [receiveAllocStatus, setReceiveAllocStatus] = useState(() => localStorage.getItem("kk_receiveAllocJobId") ? "Reconnecting to in-progress import..." : "");
  const [receiveAllocJobId, setReceiveAllocJobId] = useState(() => localStorage.getItem("kk_receiveAllocJobId") || "");
  const [receiveAllocProgress, setReceiveAllocProgress] = useState(null);
  const [receiveAllocLoading, setReceiveAllocLoading] = useState(() => !!localStorage.getItem("kk_receiveAllocJobId"));
  const [cnAllocFile, setCnAllocFile] = useState(null);
  const [cnAllocRows, setCnAllocRows] = useState([]);
  const [cnAllocErrors, setCnAllocErrors] = useState([]);
  const [cnAllocStatus, setCnAllocStatus] = useState("");
  const [cnAllocJobId, setCnAllocJobId] = useState("");
  const [cnAllocProgress, setCnAllocProgress] = useState(null);
  const [cnAllocLoading, setCnAllocLoading] = useState(false);
  const [dnAllocFile, setDnAllocFile] = useState(null);
  const [dnAllocRows, setDnAllocRows] = useState([]);
  const [dnAllocErrors, setDnAllocErrors] = useState([]);
  const [dnAllocStatus, setDnAllocStatus] = useState("");
  const [dnAllocJobId, setDnAllocJobId] = useState("");
  const [dnAllocProgress, setDnAllocProgress] = useState(null);
  const [dnAllocLoading, setDnAllocLoading] = useState(false);
  const [itemsImportFile, setItemsImportFile] = useState(null);
  const [itemsImportRows, setItemsImportRows] = useState([]);
  const [itemsImportErrors, setItemsImportErrors] = useState([]);
  const [itemsImportStatus, setItemsImportStatus] = useState(() => localStorage.getItem("kk_itemsJobId") ? "Reconnecting to in-progress import..." : "");
  const [itemsImportJobId, setItemsImportJobId] = useState(() => localStorage.getItem("kk_itemsJobId") || "");
  const [itemsImportProgress, setItemsImportProgress] = useState(null);
  const [itemsImportLoading, setItemsImportLoading] = useState(() => !!localStorage.getItem("kk_itemsJobId"));
  const [customersImportFile, setCustomersImportFile] = useState(null);
  const [customersImportRows, setCustomersImportRows] = useState([]);
  const [customersImportErrors, setCustomersImportErrors] = useState([]);
  const [customersImportStatus, setCustomersImportStatus] = useState(() => localStorage.getItem("kk_customersJobId") ? "Reconnecting to in-progress import..." : "");
  const [customersImportJobId, setCustomersImportJobId] = useState(() => localStorage.getItem("kk_customersJobId") || "");
  const [customersImportProgress, setCustomersImportProgress] = useState(null);
  const [customersImportLoading, setCustomersImportLoading] = useState(() => !!localStorage.getItem("kk_customersJobId"));
  const [vendorsImportFile, setVendorsImportFile] = useState(null);
  const [vendorsImportRows, setVendorsImportRows] = useState([]);
  const [vendorsImportErrors, setVendorsImportErrors] = useState([]);
  const [vendorsImportStatus, setVendorsImportStatus] = useState(() => localStorage.getItem("kk_vendorsJobId") ? "Reconnecting to in-progress import..." : "");
  const [vendorsImportJobId, setVendorsImportJobId] = useState(() => localStorage.getItem("kk_vendorsJobId") || "");
  const [vendorsImportProgress, setVendorsImportProgress] = useState(null);
  const [vendorsImportLoading, setVendorsImportLoading] = useState(() => !!localStorage.getItem("kk_vendorsJobId"));
  const [trackingCatImportFile, setTrackingCatImportFile] = useState(null);
  const [trackingCatImportRows, setTrackingCatImportRows] = useState([]);
  const [trackingCatImportErrors, setTrackingCatImportErrors] = useState([]);
  const [trackingCatImportStatus, setTrackingCatImportStatus] = useState(() => localStorage.getItem("kk_trackingCatJobId") ? "Reconnecting to in-progress import..." : "");
  const [trackingCatImportJobId, setTrackingCatImportJobId] = useState(() => localStorage.getItem("kk_trackingCatJobId") || "");
  const [trackingCatImportProgress, setTrackingCatImportProgress] = useState(null);
  const [trackingCatImportLoading, setTrackingCatImportLoading] = useState(() => !!localStorage.getItem("kk_trackingCatJobId"));
  const [poImportFile, setPoImportFile] = useState(null);
  const [poImportRows, setPoImportRows] = useState([]);
  const [poImportErrors, setPoImportErrors] = useState([]);
  const [poImportStatus, setPoImportStatus] = useState("");
  const [poImportJobId, setPoImportJobId] = useState("");
  const [poImportProgress, setPoImportProgress] = useState(null);
  const [poImportLoading, setPoImportLoading] = useState(false);
  const [quotesImportFile, setQuotesImportFile] = useState(null);
  const [quotesImportRows, setQuotesImportRows] = useState([]);
  const [quotesImportErrors, setQuotesImportErrors] = useState([]);
  const [quotesImportStatus, setQuotesImportStatus] = useState("");
  const [quotesImportJobId, setQuotesImportJobId] = useState("");
  const [quotesImportProgress, setQuotesImportProgress] = useState(null);
  const [quotesImportLoading, setQuotesImportLoading] = useState(false);
  const [autoCreateContacts, setAutoCreateContacts] = useState(true);
  const [docSkipDupCheck, setDocSkipDupCheck] = useState(false);
  const [updateStatusFile, setUpdateStatusFile] = useState(null);
  const [updateStatusRows, setUpdateStatusRows] = useState([]);
  const [updateStatusErrors, setUpdateStatusErrors] = useState([]);
  const [updateStatusStatus, setUpdateStatusStatus] = useState("");
  const [updateStatusJobId, setUpdateStatusJobId] = useState("");
  const [updateStatusProgress, setUpdateStatusProgress] = useState(null);
  const [updateStatusLoading, setUpdateStatusLoading] = useState(false);
  const [bankTransferFile, setBankTransferFile] = useState(null);
  const [bankTransferRows, setBankTransferRows] = useState([]);
  const [bankTransferErrors, setBankTransferErrors] = useState([]);
  const [bankTransferStatus, setBankTransferStatus] = useState("");
  const [bankTransferJobId, setBankTransferJobId] = useState("");
  const [bankTransferProgress, setBankTransferProgress] = useState(null);
  const [bankTransferLoading, setBankTransferLoading] = useState(false);
  const [exchangeRateUpdateFile, setExchangeRateUpdateFile] = useState(null);
  const [exchangeRateUpdateRows, setExchangeRateUpdateRows] = useState([]);
  const [exchangeRateUpdateErrors, setExchangeRateUpdateErrors] = useState([]);
  const [exchangeRateUpdateStatus, setExchangeRateUpdateStatus] = useState("");
  const [exchangeRateUpdateJobId, setExchangeRateUpdateJobId] = useState("");
  const [exchangeRateUpdateProgress, setExchangeRateUpdateProgress] = useState(null);
  const [exchangeRateUpdateLoading, setExchangeRateUpdateLoading] = useState(false);
  const [selectedUpdateType, setSelectedUpdateType] = useState("update-status");
  const [lastImportJobIds, setLastImportJobIds] = useState({});
  const [taxRates, setTaxRates] = useState([]);
  const [taxRatesLoading, setTaxRatesLoading] = useState(false);
  const [taxRatesStatus, setTaxRatesStatus] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [types, setTypes] = useState([]);
  const [typesError, setTypesError] = useState("");
  const [typesLoading, setTypesLoading] = useState(false);
  const [tenants, setTenants] = useState([]); // each: {tenantId, tenantName, sessionId}
  const [allUserSessions, setAllUserSessions] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState("");
  const [selectedTypes, setSelectedTypes] = useState([]);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [status, setStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingSession, setIsCheckingSession] = useState(false);
  const [lastAuthUrl, setLastAuthUrl] = useState("");
  const [lastCallbackUrl, setLastCallbackUrl] = useState("");
  const [exportResults, setExportResults] = useState([]);
  const [showAllTenants] = useState(true);
  const [groupByTenant] = useState(true);
  const [openTenants, setOpenTenants] = useState({});
  const [showHistory, setShowHistory] = useState(false);
  const [adminSettings, setAdminSettings] = useState(null);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("kk_theme") !== "light");
  const [confirmModal, setConfirmModal] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const askConfirm = (title, message, onConfirm, confirmLabel = "Confirm") => setConfirmModal({ title, message, onConfirm, confirmLabel });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", darkMode ? "dark" : "light");
    localStorage.setItem("kk_theme", darkMode ? "dark" : "light");
  }, [darkMode]);
  useEffect(() => {
    if (localStorage.getItem("kk_manualDisconnect") === "1") {
      manuallyDisconnectedRef.current = true;
    }
  }, []);
  useEffect(() => {
    if (sessionId) {
      localStorage.removeItem("kk_manualDisconnect");
      manuallyDisconnectedRef.current = false;
    }
  }, [sessionId]);
  useEffect(() => {
    if (!typePickerOpen) return;
    const close = (e) => { if (!e.target.closest("[data-type-picker]")) setTypePickerOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [typePickerOpen]);
  useEffect(() => {
    if (hintStep == null) { setHintRect(null); return; }
    const ids = ["connect-btn","org-select","type-picker-btn","guide-btn","download-template-btn","upload-zone"];
    const targetId = ids[hintStep];
    if (!targetId) return;
    const el = document.querySelector(`[data-hint-target="${targetId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const update = () => {
      const r = el.getBoundingClientRect();
      setHintRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    const t = setTimeout(update, 400);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { clearTimeout(t); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [hintStep]);
  useEffect(() => {
    setHintStep(prev => {
      if (prev === null) return null;
      if (prev === 0 && sessionId) return selectedTenant ? 2 : 1;
      if (prev === 1 && selectedTenant) return 2;
      return prev;
    });
  }, [sessionId, selectedTenant]);
  useEffect(() => {
    if (hintStep === 3) setGuideOpen(true);
    else if (hintStep !== null) setGuideOpen(false);
  }, [hintStep]);
  const [adminLimit, setAdminLimit] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminSuccess, setAdminSuccess] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminEmail, setAdminEmail] = useState("rituraj@gmail.com");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminTypes, setAdminTypes] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminPendingPopup, setAdminPendingPopup] = useState(false);
  const [adminApprovingId, setAdminApprovingId] = useState(null);
  const [requestTestingLoading, setRequestTestingLoading] = useState(false);
  const [requestTeamLoading, setRequestTeamLoading] = useState(false);
  const [heroCurrency, setHeroCurrency] = useState(() => detectHeroCurrency());
  const [adminTypeMode, setAdminTypeMode] = useState("allow");
  const [adminTypeSelection, setAdminTypeSelection] = useState([]);
  const [adminHydrated, setAdminHydrated] = useState(false);
  const [adminAnalytics, setAdminAnalytics] = useState(null);
  const [adminAnalyticsLoading, setAdminAnalyticsLoading] = useState(false);
  const [adminAnalyticsError, setAdminAnalyticsError] = useState("");
  const [adminAnalyticsDays, setAdminAnalyticsDays] = useState(30);
  const [downloadAllFormat, setDownloadAllFormat] = useState("excel");
  const [hoverTenantMonth, setHoverTenantMonth] = useState(null);
  const [hoverUserMonth, setHoverUserMonth] = useState(null);
  const [adminFilterTenant, setAdminFilterTenant] = useState("");
  const [adminFilterUser, setAdminFilterUser] = useState("");
  const [adminCleanupStatus, setAdminCleanupStatus] = useState("");
  const [adminCleanupLoading, setAdminCleanupLoading] = useState(false);
  const [deletePaymentId, setDeletePaymentId] = useState("");
  const [deleteTenantId, setDeleteTenantId] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [paymentLookup, setPaymentLookup] = useState(null);
  const [paymentLookupLoading, setPaymentLookupLoading] = useState(false);
  const [bulkDeleteFile, setBulkDeleteFile] = useState(null);
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [bulkDeleteResults, setBulkDeleteResults] = useState([]);
  const [bulkDeleteJobId, setBulkDeleteJobId] = useState("");
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState(null);
  const [activeDeleteType, setActiveDeleteType] = useState("invoice");
  const [opDupScanType, setOpDupScanType] = useState("SPEND");
  const [opDupScanLoading, setOpDupScanLoading] = useState(false);
  const [opDupScanResults, setOpDupScanResults] = useState(null);
  const [opDupSelected, setOpDupSelected] = useState({});
  const [opDupVoidLoading, setOpDupVoidLoading] = useState(false);
  const [opDupVoidResults, setOpDupVoidResults] = useState(null);
  const [opDupRefSheet, setOpDupRefSheet] = useState(null);
  const [opDupRefLoading, setOpDupRefLoading] = useState(false);
  const [opDupRefVoidResults, setOpDupRefVoidResults] = useState(null);
  const [opDupVoidJobId, setOpDupVoidJobId] = useState("");
  const [opDupVoidProgress, setOpDupVoidProgress] = useState(null);
  const [invoiceDeleteFile, setInvoiceDeleteFile] = useState(null);
  const [invoiceDeleteLoading, setInvoiceDeleteLoading] = useState(false);
  const [invoiceDeleteJobId, setInvoiceDeleteJobId] = useState("");
  const [invoiceDeleteProgress, setInvoiceDeleteProgress] = useState(null);
  const [billDeleteFile, setBillDeleteFile] = useState(null);
  const [billDeleteLoading, setBillDeleteLoading] = useState(false);
  const [billDeleteJobId, setBillDeleteJobId] = useState("");
  const [billDeleteProgress, setBillDeleteProgress] = useState(null);
  const [paymentDeleteFile, setPaymentDeleteFile] = useState(null);
  const [paymentDeleteLoading, setPaymentDeleteLoading] = useState(false);
  const [paymentDeleteJobId, setPaymentDeleteJobId] = useState("");
  const [paymentDeleteProgress, setPaymentDeleteProgress] = useState(null);
  const [mjVoidFile, setMjVoidFile] = useState(null);
  const [mjVoidLoading, setMjVoidLoading] = useState(false);
  const [mjVoidJobId, setMjVoidJobId] = useState("");
  const [mjVoidProgress, setMjVoidProgress] = useState(null);
  const [simpleDeleteFile, setSimpleDeleteFile] = useState(null);
  const [simpleDeleteLoading, setSimpleDeleteLoading] = useState(false);
  const [simpleDeleteJobId, setSimpleDeleteJobId] = useState("");
  const [simpleDeleteProgress, setSimpleDeleteProgress] = useState(null);
  const [apiUsage, setApiUsage] = useState(null);
  const [apiUsageLoading, setApiUsageLoading] = useState(false);
  const [apiUsageError, setApiUsageError] = useState("");
  const [adminUserPlanSaving, setAdminUserPlanSaving] = useState(null);
  const [adminPlanRenewSaving, setAdminPlanRenewSaving] = useState(null);
  const [adminPlanCancelSaving, setAdminPlanCancelSaving] = useState(null);
  const [adminApproveModal, setAdminApproveModal] = useState(null);
  const [adminApproveForm, setAdminApproveForm] = useState({plan:"professional",days:30,customDays:""});
  const [adminRenewModal, setAdminRenewModal] = useState(null);
  const [adminRenewForm, setAdminRenewForm] = useState({days:30,customDays:""});
  const [adminCancelModal, setAdminCancelModal] = useState(null);
  const [adminUserRoleSaving, setAdminUserRoleSaving] = useState(null);
  const [adminUserResetPwModal, setAdminUserResetPwModal] = useState(null);
  const [adminUserResetPwValue, setAdminUserResetPwValue] = useState("");
  const [adminUserResetPwLoading, setAdminUserResetPwLoading] = useState(false);
  const [adminUserResetPwError, setAdminUserResetPwError] = useState("");
  const [adminUserNoteModal, setAdminUserNoteModal] = useState(null);
  const [adminUserNoteValue, setAdminUserNoteValue] = useState("");
  const [adminUserNoteSaving, setAdminUserNoteSaving] = useState(false);
  const [adminImportHistory, setAdminImportHistory] = useState([]);
  const [adminImportHistoryLoading, setAdminImportHistoryLoading] = useState(false);
  const [adminImportHistoryTotal, setAdminImportHistoryTotal] = useState(0);
  const [adminImportHistoryPage, setAdminImportHistoryPage] = useState(1);
  const [adminImportHistoryPages, setAdminImportHistoryPages] = useState(1);
  const [adminImportHistoryFilterUser, setAdminImportHistoryFilterUser] = useState("");
  const [adminImportHistoryFilterType, setAdminImportHistoryFilterType] = useState("");
  const [adminActiveTab, setAdminActiveTab] = useState("users");
  const [adminCustomLimitsModal, setAdminCustomLimitsModal] = useState(null);
  const [adminCustomLimitsSaving, setAdminCustomLimitsSaving] = useState(false);
  const [adminCustomLimitsForm, setAdminCustomLimitsForm] = useState({});
  // Xero Client ID per user
  const [adminXeroClientModal, setAdminXeroClientModal] = useState(null);
  const [adminXeroClientValue, setAdminXeroClientValue] = useState("");
  const [adminXeroClientSaving, setAdminXeroClientSaving] = useState(false);
  const [adminXeroClientError, setAdminXeroClientError] = useState("");
  // Login history
  const [adminLoginHistoryModal, setAdminLoginHistoryModal] = useState(null);
  const [adminLoginHistory, setAdminLoginHistory] = useState([]);
  const [adminLoginHistoryLoading, setAdminLoginHistoryLoading] = useState(false);
  // Xero connections
  const [adminXeroConnsModal, setAdminXeroConnsModal] = useState(null);
  const [adminXeroConns, setAdminXeroConns] = useState([]);
  const [adminXeroConnsLoading, setAdminXeroConnsLoading] = useState(false);
  const [adminXeroConnsRevoking, setAdminXeroConnsRevoking] = useState(false);
  // Global Xero sessions
  const [adminAllXeroSessions, setAdminAllXeroSessions] = useState([]);
  const [adminAllXeroLoading, setAdminAllXeroLoading] = useState(false);
  const [adminXeroDisconnecting, setAdminXeroDisconnecting] = useState(null);
  // Bulk actions
  const [adminSelectedUsers, setAdminSelectedUsers] = useState(new Set());
  const [adminBulkLoading, setAdminBulkLoading] = useState(false);
  // Live jobs/sessions
  const [adminLiveJobs, setAdminLiveJobs] = useState([]);
  const [adminLiveSessions, setAdminLiveSessions] = useState([]);
  const [adminLiveLoading, setAdminLiveLoading] = useState(false);
  // Health
  const [adminHealth, setAdminHealth] = useState(null);
  const [adminHealthLoading, setAdminHealthLoading] = useState(false);
  // Broadcast
  const [adminBroadcastMsg, setAdminBroadcastMsg] = useState("");
  const [adminBroadcastSaving, setAdminBroadcastSaving] = useState(false);
  // Maintenance
  const [adminMaintenanceMode, setAdminMaintenanceMode] = useState(false);
  const [adminMaintenanceBanner, setAdminMaintenanceBanner] = useState("");
  const [adminMaintenanceSaving, setAdminMaintenanceSaving] = useState(false);
  // Landing videos
  const [adminLandingVideos, setAdminLandingVideos] = useState({ video1: "", video2: "", video3: "" });
  const [adminLandingVideosSaving, setAdminLandingVideosSaving] = useState(false);
  // Audit log
  const [adminAuditLog, setAdminAuditLog] = useState([]);
  const [adminAuditLogLoading, setAdminAuditLogLoading] = useState(false);
  const [adminAuditLogTotal, setAdminAuditLogTotal] = useState(0);
  const [adminAuditLogPage, setAdminAuditLogPage] = useState(1);
  // Broadcast banner for users
  const [userBroadcast, setUserBroadcast] = useState("");
  const [userPlanInfo, setUserPlanInfo] = useState(null);
  // Import note (optional note attached to each import, saved in history)
  const [importNote, setImportNote] = useState("");
  const [partialSkippedRows, setPartialSkippedRows] = useState([]);
  // RBAC: user role fetched after login
  const [userRole, setUserRole] = useState("importer");
  const [userPermissions, setUserPermissions] = useState(["import"]);
  const [accessDeniedModal, setAccessDeniedModal] = useState(null); // { feature: "Delete Centre" }
  // Xero Pre-Validation
  const [preCheckLoading, setPreCheckLoading] = useState(false);
  const [preCheckResult, setPreCheckResult] = useState(null); // { type, total, found, notFound, notFoundList, foundList }
  const [preCheckModal, setPreCheckModal] = useState(false);
  const [adminChartSelection, setAdminChartSelection] = useState(["line", "monthlyTenants", "userWorkload", "statusSplit", "tenantUserMatrix", "recentActivity"]);
  const overviewRef = useRef(null);
  const filtersRef = useRef(null);
  const resultsRef = useRef(null);
  const adminAutosaveRef = useRef(null);
  const manuallyDisconnectedRef = useRef(false);
  const etaTrackerRef = useRef({});
  const isAdminPage = currentPath === "/admin";
  const isDeleteCentrePage = currentPath === "/delete-centre";
  const isUpdateCentrePage = currentPath === "/update-centre";
  const isImportPage = currentPath === "/import";
  const isGuidePage = currentPath === "/guide";
  const isImportHistoryPage = currentPath === "/import-history";
  const isAutoAllocationPage = currentPath === "/auto-allocation";
  const isDashboardPage = currentPath === "/dashboard";
  const isTermsPage = currentPath === "/terms";
  const isPrivacyPage = currentPath === "/privacy";
  const isPricingPage = currentPath === "/pricing";
  const isPricingSuccessPage = currentPath === "/pricing/success";
  const isAccountPage = currentPath === "/account";
  const isSignupPage = currentPath === "/signup";
  const isLoginPage = currentPath === "/login";
  useEffect(() => {
    if (isImportPage && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [isImportPage]);

  useEffect(() => {
    if (userToken && (currentPath === "/" || currentPath === "/login") && !hasPermission("export")) {
      navigate("/import");
    }
  }, [userToken, currentPath, userPermissions]);
  const formatDateInput = value => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  const formatDateTime = value => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  };
  const applyPreset = days => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - days);
    setFromDate(formatDateInput(from));
    setToDate(formatDateInput(now));
  };
  const formatDuration = ms => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const totalSeconds = Math.round(ms / 1e3);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
    return `${seconds}s`;
  };
  const formatCount = value => {
    if (!Number.isFinite(value)) return "-";
    return value.toLocaleString();
  };
  const _sendBrowserNotif = (title, body) => {
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: "/favicon.ico", tag: "xero-import" });
      }
    } catch {}
  };
  const notifyImportDone = (data, label, importTypeKey) => {
    if (data.status === "completed") {
      toast.success(`${label} import complete — ${(data.created || 0).toLocaleString()} created.`);
      _sendBrowserNotif(`✅ ${label} Import Complete`, `${(data.created || 0).toLocaleString()} records created successfully.`);
    } else if (data.status === "completed_with_errors") {
      toast.warning(`${label} import finished with errors — ${(data.created || 0).toLocaleString()} created, ${(data.errors || 0).toLocaleString()} errors.`);
      _sendBrowserNotif(`⚠️ ${label} Import Finished`, `${(data.created || 0).toLocaleString()} created, ${(data.errors || 0).toLocaleString()} errors.`);
    } else if (data.status === "error") {
      toast.error(`${label} import failed: ${data.error || "Unknown error"}`);
      _sendBrowserNotif(`❌ ${label} Import Failed`, data.error || "Unknown error occurred.");
    }
    if ((data.status === "completed" || data.status === "completed_with_errors") && (data.created || 0) > 0 && importTypeKey) {
      setLastImportMeta({ type: importTypeKey, created: data.created || 0, historyId: data.historyId || data.jobId || "", jobId: data.jobId || "" });
    }
  };
  const formatPercent = value => {
    if (!Number.isFinite(value)) return "-";
    return `${value}%`;
  };
  const formatMonthLabel = value => {
    if (!value) return "-";
    const [y, m] = String(value).split("-");
    const date = new Date(Number(y), Number(m) - 1, 1);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(void 0, {
      month: "short",
      year: "numeric"
    });
  };
  const buildLinePath = (points, width, height) => {
    if (!points.length) return "";
    const max = Math.max(1, ...points.map(point => point.value));
    return points.map((point, index) => {
      const x = index / (points.length - 1 || 1) * width;
      const y = height - point.value / max * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
  };
  const getMax = (items, key) => {
    if (!Array.isArray(items) || items.length === 0) return 1;
    return Math.max(1, ...items.map(item => Number.isFinite(item?.[key]) ? item[key] : 0));
  };
  const buildProgressDetail = (progress, startedAt) => {
    if (!progress || !progress.page) return "";
    const {
      page,
      pageCount,
      count,
      totalCount
    } = progress;
    const parts = [];
    if (pageCount) {
      parts.push(`Page ${page}/${pageCount}`);
    } else if (page) {
      parts.push(`Page ${page}`);
    }
    if (totalCount) {
      const pct = Math.min(100, Math.round(count / totalCount * 100));
      parts.push(`${pct}%`);
      if (startedAt && count > 0) {
        const elapsed = Date.now() - startedAt;
        const etaMs = elapsed / count * (totalCount - count);
        const etaLabel = formatDuration(etaMs);
        if (etaLabel) {
          parts.push(`ETA ${etaLabel}`);
        }
      }
    }
    return parts.length ? `Progress: ${parts.join(" · ")}` : "";
  };
  const handleCopy = async text => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Folder path copied.");
    } catch {
      toast.error("Copy failed. Please copy manually.");
    }
  };
  const parseApiResponse = async res => {
    const text = await res.text();
    if (!text) {
      return {
        data: {},
        rawText: ""
      };
    }
    try {
      return {
        data: JSON.parse(text),
        rawText: text
      };
    } catch {
      return {
        data: {},
        rawText: text
      };
    }
  };
  const loadAdminSettings = async (tokenOverride = "") => {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) return;
    if (!adminAuthed && !tokenOverride) return;
    setAdminLoading(true);
    setAdminError("");
    setAdminSuccess("");
    try {
      const res = await fetch(`${API_BASE}/admin/settings`, {
        headers: {
          "x-admin-token": tokenToUse
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load admin settings");
      }
      setAdminSettings(data);
      setAdminLimit(String(data.maxUsers));
      if (Array.isArray(data.allowedTypes) && data.allowedTypes.length) {
        setAdminTypeMode("allow");
        setAdminTypeSelection(data.allowedTypes);
      } else {
        setAdminTypeMode("allow");
        setAdminTypeSelection([]);
      }
      setAdminHydrated(true);
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };
  const loadAdminTypes = async (tokenOverride = "") => {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) return;
    if (!adminAuthed && !tokenOverride) return;
    try {
      const res = await fetch(`${API_BASE}/admin/types`, {
        headers: {
          "x-admin-token": tokenToUse
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load types");
      }
      setAdminTypes(data.types || []);
      if (adminTypeMode === "allow" && (!adminTypeSelection || adminTypeSelection.length === 0) && Array.isArray(data.types) && data.types.length) {
        setAdminTypeSelection(data.types);
      }
    } catch (err) {
      setAdminError(err.message);
    }
  };
  const loadAdminUsers = async (tokenOverride = "") => {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) return;
    if (!adminAuthed && !tokenOverride) return;
    try {
      const res = await fetch(`${API_BASE}/admin/users`, {
        headers: {
          "x-admin-token": tokenToUse
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load users");
      }
      const users = data.users || [];
      setAdminUsers(users);
      if (users.some(u => u.planStatus === "pending")) setAdminPendingPopup(true);
    } catch (err) {
      setAdminError(err.message);
    }
  };
  const handleApproveTesting = (userId, email, userPlan) => {
    const isPaid = userPlan && userPlan !== "testing" && userPlan !== "none";
    setAdminApproveModal({id:userId, email:email||"", plan:userPlan||"testing", isPaid});
    setAdminApproveForm({plan:"professional", days:30, customDays:""});
  };
  const handleApproveWithPlan = async (userId, plan, days, mode = "approve") => {
    if (!adminToken) return;
    setAdminApprovingId(userId);
    try {
      const url = mode === "set"
        ? `${API_BASE}/admin/users/${userId}/set-plan`
        : `${API_BASE}/admin/users/${userId}/approve-testing`;
      const body = mode === "set"
        ? { plan, durationDays: days }
        : { plan, durationDays: days };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to set plan");
      const expiry = new Date(Date.now() + days * 86400000).toISOString();
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, planStatus: "active", plan, planExpiry: expiry, planStartAt: new Date().toISOString() } : u));
      setAdminApproveModal(null);
      toast.success(mode === "set" ? `Plan set to ${plan} for ${days} days` : `Access granted — ${plan} plan, ${days} days`);
    } catch (err) {
      toast.error(err.message || "Failed to set plan");
    } finally {
      setAdminApprovingId(null);
    }
  };
  const handleClearAllExports = async () => {
    if (!adminToken) return;
    setAdminCleanupLoading(true);
    setAdminCleanupStatus("");
    try {
      const res = await fetch(`${API_BASE}/admin/exports/clear-all`, {
        method: "POST",
        headers: adminHeader
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to clear exports");
      }
      setAdminCleanupStatus("All export jobs and files cleared.");
      setExportResults([]);
      await loadAdminAnalytics();
    } catch (err) {
      setAdminCleanupStatus(err.message);
    } finally {
      setAdminCleanupLoading(false);
    }
  };
  const loadAdminAnalytics = async (tokenOverride = "", daysOverride = null) => {
    const tokenToUse = tokenOverride || adminToken;
    if (!tokenToUse) return;
    if (!adminAuthed && !tokenOverride) return;
    const daysToUse = Number.isFinite(daysOverride) ? daysOverride : adminAnalyticsDays;
    setAdminAnalyticsLoading(true);
    setAdminAnalyticsError("");
    try {
      const params = new URLSearchParams();
      params.set("days", String(daysToUse));
      if (adminFilterTenant) {
        params.set("tenant", adminFilterTenant);
      }
      if (adminFilterUser) {
        params.set("user", adminFilterUser);
      }
      const res = await fetch(`${API_BASE}/admin/analytics?${params.toString()}`, {
        headers: {
          "x-admin-token": tokenToUse
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load analytics");
      }
      setAdminAnalytics(data);
    } catch (err) {
      setAdminAnalyticsError(err.message);
    } finally {
      setAdminAnalyticsLoading(false);
    }
  };
  const handleSaveAdminSettings = async () => {
    if (!adminToken) return;
    setAdminLoading(true);
    setAdminError("");lete 
    setAdminSuccess("");
    try {
      const res = await fetch(`${API_BASE}/admin/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeader
        },
        body: JSON.stringify({
          maxUsers: adminLimit,
          allowedTypes: adminTypeSelection,
          deniedTypes: []
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update limit");
      }
      setAdminSettings(data);
      setAdminLimit(String(data.maxUsers));
      setAdminSuccess("Settings updated.");
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };
  const handleSaveAdminSettingsSilent = async () => {
    if (!adminToken) return;
    if (adminLoading) return;
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/admin/settings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeader
        },
        body: JSON.stringify({
          maxUsers: adminLimit,
          allowedTypes: adminTypeSelection,
          deniedTypes: []
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update settings");
      }
      setAdminSettings(data);
      setAdminLimit(String(data.maxUsers));
    } catch (err) {
      setAdminError(err.message);
    }
  };
  const toggleAdminType = (type, checked) => {
    if (checked) {
      setAdminTypeSelection(prev => Array.from(new Set([...prev, type])));
    } else {
      setAdminTypeSelection(prev => prev.filter(item => item !== type));
    }
  };
  const handleToggleUser = async (userId, disabled) => {
    if (!adminToken) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...adminHeader
        },
        body: JSON.stringify({
          disabled
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update user");
      }
      setAdminUsers(prev => prev.map(user2 => user2.id === userId ? {
        ...user2,
        disabled: data.disabled
      } : user2));
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };
  const handleSetUserPlan = async (userId, plan, durationDays = 30) => {
    if (!adminToken) return;
    setAdminUserPlanSaving(userId);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/set-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ plan, durationDays }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to set plan");
      const expiry = new Date(Date.now() + durationDays * 86400000).toISOString();
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, plan, planStatus: "active", planExpiry: expiry, planStartAt: new Date().toISOString() } : u));
      toast.success(`Plan set to ${plan} for ${durationDays} days`);
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminUserPlanSaving(null);
    }
  };
  const handleRenewPlan = async (userId, days = 30) => {
    if (!adminToken) return false;
    setAdminPlanRenewSaving(userId);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/renew-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ days }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to renew plan");
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, planExpiry: data.planExpiry, planStatus: "active" } : u));
      setAdminRenewModal(null);
      toast.success(`Plan renewed for ${days} days`);
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    } finally {
      setAdminPlanRenewSaving(null);
    }
  };
  const handleCancelPlanUser = (userId, email, plan) => {
    setAdminCancelModal({id:userId, email:email||"", plan:plan||"none"});
  };
  const handleConfirmCancelPlan = async (userId) => {
    if (!adminToken) return;
    setAdminPlanCancelSaving(userId);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/cancel-plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to cancel plan");
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, plan: "none", planStatus: "cancelled", planExpiry: null } : u));
      setAdminCancelModal(null);
      toast.success("Plan cancelled");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdminPlanCancelSaving(null);
    }
  };
  const handleSetUserRole = async (userId, role) => {
    if (!adminToken) return;
    setAdminUserRoleSaving(userId);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/set-role`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to set role");
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, role } : u));
      toast.success(`Role set to ${role}`);
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminUserRoleSaving(null);
    }
  };
  const handleSetUserPermissions = async (userId, permissions) => {
    if (!adminToken) return;
    setAdminUserRoleSaving(userId);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/set-permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ permissions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to update permissions");
      setAdminUsers(prev => prev.map(u => u.id === userId ? { ...u, permissions } : u));
      toast.success("Permissions updated");
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminUserRoleSaving(null);
    }
  };

  const handleResetUserPassword = async () => {
    if (!adminToken || !adminUserResetPwModal) return;
    if (!adminUserResetPwValue || adminUserResetPwValue.length < 6) {
      setAdminUserResetPwError("Password must be at least 6 characters");
      return;
    }
    setAdminUserResetPwLoading(true);
    setAdminUserResetPwError("");
    try {
      const res = await fetch(`${API_BASE}/admin/users/${adminUserResetPwModal.userId}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ newPassword: adminUserResetPwValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to reset password");
      setAdminUserResetPwModal(null);
      setAdminUserResetPwValue("");
      toast.success("Password reset successfully. User sessions invalidated.");
    } catch (err) {
      setAdminUserResetPwError(err.message);
    } finally {
      setAdminUserResetPwLoading(false);
    }
  };
  const handleSaveUserNote = async () => {
    if (!adminToken || !adminUserNoteModal) return;
    setAdminUserNoteSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${adminUserNoteModal.userId}/set-note`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ note: adminUserNoteValue }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save note");
      setAdminUsers(prev => prev.map(u => u.id === adminUserNoteModal.userId ? { ...u, note: adminUserNoteValue } : u));
      setAdminUserNoteModal(null);
      setAdminUserNoteValue("");
      toast.success("Note saved.");
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminUserNoteSaving(false);
    }
  };
  const handleDeleteUser = async (userId, email) => {
    if (!adminToken) return;
    if (!window.confirm(`Delete user "${email}" permanently? All their sessions will be invalidated. This cannot be undone.`)) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}`, {
        method: "DELETE",
        headers: adminHeader,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to delete user");
      setAdminUsers(prev => prev.filter(u => u.id !== userId));
      toast.success(`User "${email}" deleted.`);
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };
  const handleSaveCustomLimits = async () => {
    if (!adminToken || !adminCustomLimitsModal) return;
    setAdminCustomLimitsSaving(true);
    try {
      const f = adminCustomLimitsForm;
      const customLimits = Object.keys(f).length === 0 ? null : {
        ...(f.maxRowsPerImport !== "" && !isNaN(Number(f.maxRowsPerImport)) ? { maxRowsPerImport: Number(f.maxRowsPerImport) } : {}),
        ...(f.maxOrgs === "unlimited" ? { maxOrgs: null } : f.maxOrgs !== "" && !isNaN(Number(f.maxOrgs)) ? { maxOrgs: Number(f.maxOrgs) } : {}),
        ...(Array.isArray(f.allowedImportTypes) && f.allowedImportTypes.length > 0 ? { allowedImportTypes: f.allowedImportTypes } : {}),
        ...(typeof f.exportAccess === "boolean" ? { exportAccess: f.exportAccess } : {}),
        ...(typeof f.deleteAccess === "boolean" ? { deleteAccess: f.deleteAccess } : {}),
        ...(typeof f.manualJournalsAccess === "boolean" ? { manualJournalsAccess: f.manualJournalsAccess } : {}),
        ...(typeof f.paymentImportAccess === "boolean" ? { paymentImportAccess: f.paymentImportAccess } : {}),
        ...(typeof f.overpaymentAccess === "boolean" ? { overpaymentAccess: f.overpaymentAccess } : {}),
      };
      const res = await fetch(`${API_BASE}/admin/users/${adminCustomLimitsModal.userId}/set-custom-limits`, {
        method: "POST",
        headers: { ...adminHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ customLimits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save custom limits");
      setAdminUsers(prev => prev.map(u => u.id === adminCustomLimitsModal.userId ? { ...u, customLimits: data.customLimits } : u));
      toast.success("Custom limits saved.");
      setAdminCustomLimitsModal(null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdminCustomLimitsSaving(false);
    }
  };
  const loadAdminImportHistory = async (page = 1, filterUser = adminImportHistoryFilterUser, filterType = adminImportHistoryFilterType) => {
    if (!adminToken) return;
    setAdminImportHistoryLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "25" });
      if (filterUser) params.set("user", filterUser);
      if (filterType) params.set("type", filterType);
      const res = await fetch(`${API_BASE}/admin/import-history?${params}`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load import history");
      setAdminImportHistory(data.items || []);
      setAdminImportHistoryTotal(data.total || 0);
      setAdminImportHistoryPage(data.page || 1);
      setAdminImportHistoryPages(data.pages || 1);
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminImportHistoryLoading(false);
    }
  };
  const handleAdminLogin = async () => {
    setAdminLoading(true);
    setAdminError("");
    setAdminSuccess("");
    try {
      const res = await fetch(`${API_BASE}/admin/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: adminEmail,
          password: adminPassword
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Admin login failed");
      }
      localStorage.setItem("xero_admin_token", data.token);
      setAdminToken(data.token);
      setAdminAuthed(true);
      setAdminPassword("");
      await loadAdminSettings(data.token);
      await loadAdminTypes(data.token);
      await loadAdminUsers(data.token);
      await loadAdminAnalytics(data.token, adminAnalyticsDays);
      await loadApiUsage(data.token);
      loadAdminBroadcast();
      loadAdminMaintenance();
      loadAdminLandingVideos();
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };
  const handleAdminLogout = async () => {
    if (!adminToken) return;
    try {
      await fetch(`${API_BASE}/admin/logout`, {
        method: "POST",
        headers: adminHeader
      });
    } catch {}
    localStorage.removeItem("xero_admin_token");
    setAdminToken("");
    setAdminAuthed(false);
    setAdminSettings(null);
    setAdminHydrated(false);
  };
  const isConnected = Boolean(sessionId);
  const selectedTenantName = tenants.find(tenant => tenant.tenantId === selectedTenant)?.tenantName || "";
  const sessionHeader = useMemo(() => {
    if (!sessionId) return {};
    return {
      "x-session-id": sessionId
    };
  }, [sessionId]);
  const userHeader = useMemo(() => {
    if (!userToken) return {};
    return {
      "x-user-token": userToken
    };
  }, [userToken]);
  const adminHeader = useMemo(() => {
    if (!adminToken) return {};
    return {
      "x-admin-token": adminToken
    };
  }, [adminToken]);
  const navigate = path => {
    _routerNavigate(path);
  };
  const openDeleteCentrePage = () => {
    navigate("/delete-centre");
  };
  const openImportPage = () => {
    navigate("/import");
  };
  const getXeroReturnPath = () => {
    const stored = localStorage.getItem("xero_return_path") || "/";
    if (stored === "/import" || stored === "/delete-centre" || stored === "/") {
      return stored;
    }
    return "/";
  };
  const restoreXeroReturnPath = () => {
    const path = getXeroReturnPath();
    _routerNavigate(path, { replace: true });
    localStorage.removeItem("xero_return_path");
  };
  const downloadAccountsCsvTemplate = () => {
    const headers = ["Code", "Name", "Bank Account Number", "Bank Account Type", "Type", "Description", "Tax", "Show on Dashboard", "Enable Payments To Account", "Expense Claims", "Currency Code"];
    const csv = `${headers.join(",")}\r
`;
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xero_chart_of_accounts_import_template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const downloadCsvFile = (filename, headers, sampleRows = []) => {
    const escapeCell = v => {
      const s = String(v == null ? "" : v);
      return /[,"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headerLine = Array.isArray(headers) ? headers.map(escapeCell).join(",") : String(headers);
    let csv = `${headerLine}\r\n`;
    sampleRows.forEach(row => { csv += row.map(escapeCell).join(",") + "\r\n"; });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const downloadVoidTemplate = () => {
    downloadCsvFile("xero_invoice_creditnote_delete_template.csv", ["ID", "Number"]);
  };
  const downloadBillVoidTemplate = () => {
    downloadCsvFile("xero_bill_creditnote_delete_template.csv", ["ID", "Number"]);
  };
  const downloadPaymentDeleteTemplate = () => {
    downloadCsvFile("xero_payment_delete_template.csv", ["payment id"]);
  };
  const downloadVoidResults = async (endpointBase, jobId, statusFilter) => {
    if (!jobId || !userToken) return;
    const params = new URLSearchParams({ jobId });
    if (statusFilter) params.set("status", statusFilter);
    const url = `${API_BASE}/${endpointBase}/bulk-delete/results?${params.toString()}`;
    const res = await fetch(url, { headers: { "x-user-token": userToken } });
    if (!res.ok) return;
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `${endpointBase}_void_results${statusFilter ? "_" + statusFilter : ""}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  };
  const cancelVoidJob = async (endpointBase, jobId, setProgress) => {
    if (!jobId || !userToken) return;
    await fetch(`${API_BASE}/${endpointBase}/bulk-delete/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-user-token": userToken },
      body: JSON.stringify({ jobId })
    });
    setProgress(prev => prev ? { ...prev, status: "cancelled" } : prev);
  };
  const runDocDelete = async ({ endpointBase, file, tenantId, setLoading, setJobId, setProgress }) => {
    if (!userToken) return;
    if (!sessionId) { toast.error("Please connect to Xero first."); return; }
    if (!tenantId) { toast.error("Select a tenant first."); return; }
    if (!file) { toast.error("Upload a sheet first."); return; }
    setLoading(true);
    setProgress(null);
    setJobId("");
    try {
      const contentBase64 = await readFileAsBase64(file);
      const res = await fetch(`${API_BASE}/${endpointBase}/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId, "x-tenant-id": tenantId },
        body: JSON.stringify({ tenantId, filename: file.name, contentBase64 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start void job");
      if (data.sessionId) { localStorage.setItem("xero_session", data.sessionId); setSessionId(data.sessionId); }
      setJobId(data.jobId || "");
      setProgress(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  };
  const loadApiUsage = async (tokenOverride) => {
    const tok = tokenOverride || adminToken;
    if (!tok) return;
    setApiUsageLoading(true);
    setApiUsageError("");
    try {
      const res = await fetch(`${API_BASE}/admin/api-usage`, { headers: { "x-admin-token": tok } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load API usage");
      setApiUsage(data);
    } catch (e) {
      setApiUsageError(e.message);
    } finally {
      setApiUsageLoading(false);
    }
  };
  // ── New admin helpers ────────────────────────────────────────────────────────
  const loadAdminLive = async () => {
    if (!adminToken) return;
    setAdminLiveLoading(true);
    try {
      const [rJ, rS] = await Promise.all([
        fetch(`${API_BASE}/admin/live/jobs`, { headers: adminHeader }),
        fetch(`${API_BASE}/admin/live/sessions`, { headers: adminHeader }),
      ]);
      const dJ = await rJ.json().catch(() => ({}));
      const dS = await rS.json().catch(() => ({}));
      if (rJ.ok) setAdminLiveJobs(dJ.jobs || []);
      if (rS.ok) setAdminLiveSessions(dS.sessions || []);
    } catch (_) {}
    finally { setAdminLiveLoading(false); }
  };

  const loadAdminAllXeroSessions = async () => {
    if (!adminToken) return;
    setAdminAllXeroLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/xero-all-sessions`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminAllXeroSessions(data.sessions || []);
    } catch (_) {}
    finally { setAdminAllXeroLoading(false); }
  };

  const adminDisconnectXeroSession = async (sessionId) => {
    if (!adminToken || !sessionId) return;
    setAdminXeroDisconnecting(sessionId);
    try {
      const res = await fetch(`${API_BASE}/admin/xero-all-sessions/${sessionId}/disconnect`, { method: "POST", headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success("Disconnected from Xero"); loadAdminAllXeroSessions(); }
      else toast.error(data.error || "Disconnect failed");
    } catch (_) { toast.error("Connection error"); }
    finally { setAdminXeroDisconnecting(null); }
  };

  const loadAdminHealth = async () => {
    if (!adminToken) return;
    setAdminHealthLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/health`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminHealth(data);
    } catch (_) {}
    finally { setAdminHealthLoading(false); }
  };

  const loadAdminBroadcast = async () => {
    if (!adminToken) return;
    try {
      const res = await fetch(`${API_BASE}/admin/broadcast`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminBroadcastMsg(data.broadcastMessage || "");
    } catch (_) {}
  };

  const loadAdminLandingVideos = async () => {
    try {
      const res = await fetch(`${API_BASE}/landing/settings`);
      const data = await res.json();
      if (data.landingVideos) setAdminLandingVideos(data.landingVideos);
    } catch (_) {}
  };
  const saveAdminLandingVideos = async () => {
    setAdminLandingVideosSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/landing/videos`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeader }, body: JSON.stringify(adminLandingVideos) });
      const data = await res.json();
      if (res.ok) { setAdminLandingVideos(data.landingVideos); toast.success("Landing page videos saved"); }
      else toast.error(data.error || "Save failed");
    } catch (_) { toast.error("Save failed"); }
    finally { setAdminLandingVideosSaving(false); }
  };
  const loadAdminMaintenance = async () => {
    if (!adminToken) return;
    try {
      const res = await fetch(`${API_BASE}/admin/maintenance`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAdminMaintenanceMode(Boolean(data.maintenanceMode)); setAdminMaintenanceBanner(data.maintenanceBanner || ""); }
    } catch (_) {}
  };

  const saveBroadcast = async () => {
    if (!adminToken) return;
    setAdminBroadcastSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/broadcast`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeader }, body: JSON.stringify({ broadcastMessage: adminBroadcastMsg }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAdminBroadcastMsg(data.broadcastMessage || ""); toast.success("Broadcast saved"); }
      else toast.error(data.error || "Failed");
    } catch (e) { toast.error(e.message); }
    finally { setAdminBroadcastSaving(false); }
  };

  const saveMaintenance = async (mode, banner) => {
    if (!adminToken) return;
    setAdminMaintenanceSaving(true);
    try {
      const res = await fetch(`${API_BASE}/admin/maintenance`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeader }, body: JSON.stringify({ maintenanceMode: mode, maintenanceBanner: banner }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAdminMaintenanceMode(Boolean(data.maintenanceMode)); setAdminMaintenanceBanner(data.maintenanceBanner || ""); toast.success(mode ? "Maintenance ON" : "Maintenance OFF"); }
      else toast.error(data.error || "Failed");
    } catch (e) { toast.error(e.message); }
    finally { setAdminMaintenanceSaving(false); }
  };

  const loadAuditLog = async (page = 1) => {
    if (!adminToken) return;
    setAdminAuditLogLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/audit-log?page=${page}&limit=50`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setAdminAuditLog(data.items || []); setAdminAuditLogTotal(data.total || 0); setAdminAuditLogPage(data.page || 1); }
    } catch (_) {}
    finally { setAdminAuditLogLoading(false); }
  };

  const openLoginHistory = async (user) => {
    setAdminLoginHistoryModal(user);
    setAdminLoginHistoryLoading(true);
    setAdminLoginHistory([]);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${user.id}/login-history`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminLoginHistory(data.loginHistory || []);
    } catch (_) {}
    finally { setAdminLoginHistoryLoading(false); }
  };

  const openXeroConns = async (user) => {
    setAdminXeroConnsModal(user);
    setAdminXeroConnsLoading(true);
    setAdminXeroConns([]);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${user.id}/xero-connections`, { headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setAdminXeroConns(data.connections || []);
    } catch (_) {}
    finally { setAdminXeroConnsLoading(false); }
  };

  const revokeXeroConns = async (user) => {
    setAdminXeroConnsRevoking(true);
    try {
      const res = await fetch(`${API_BASE}/admin/users/${user.id}/revoke-xero`, { method: "DELETE", headers: adminHeader });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`Revoked ${data.revoked} Xero session(s)`); setAdminXeroConns([]); }
      else toast.error(data.error || "Failed");
    } catch (e) { toast.error(e.message); }
    finally { setAdminXeroConnsRevoking(false); }
  };

  const openXeroClientModal = (user) => {
    setAdminXeroClientModal(user);
    setAdminXeroClientValue(user.xeroClientId || "");
    setAdminXeroClientError("");
  };

  const saveXeroClientId = async () => {
    if (!adminXeroClientModal) return;
    setAdminXeroClientSaving(true);
    setAdminXeroClientError("");
    try {
      const res = await fetch(`${API_BASE}/admin/users/${adminXeroClientModal.id}/set-xero-client`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeader }, body: JSON.stringify({ xeroClientId: adminXeroClientValue.trim() || null }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success("Xero Client ID saved"); setAdminXeroClientModal(null); loadAdminUsers(); }
      else setAdminXeroClientError(data.error || "Failed");
    } catch (e) { setAdminXeroClientError(e.message); }
    finally { setAdminXeroClientSaving(false); }
  };

  const handleBulkAction = async (action) => {
    if (!adminSelectedUsers.size) return;
    setAdminBulkLoading(true);
    try {
      const res = await fetch(`${API_BASE}/admin/users/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", ...adminHeader }, body: JSON.stringify({ action, userIds: [...adminSelectedUsers] }) });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { toast.success(`${action}: ${data.affected} user(s)`); setAdminSelectedUsers(new Set()); loadAdminUsers(); }
      else toast.error(data.error || "Failed");
    } catch (e) { toast.error(e.message); }
    finally { setAdminBulkLoading(false); }
  };

  const downloadUsersCsv = () => {
    const url = `${API_BASE}/admin/users/export-csv`;
    const a = document.createElement("a");
    a.href = url;
    a.setAttribute("x-admin-token", adminToken);
    // Use fetch to download with auth header
    fetch(url, { headers: adminHeader }).then(r => r.blob()).then(blob => {
      const bUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = bUrl;
      link.download = `users_${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(bUrl);
    });
  };

  // Fetch broadcast for regular logged-in users
  const loadUserBroadcast = async () => {
    try {
      const res = await fetch(`${API_BASE}/user/broadcast`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setUserBroadcast(data.broadcastMessage || "");
    } catch (_) {}
  };

  const ALL_IMPORT_ORDER = [{
    type: "accounts",
    label: "Chart of Accounts",
    endpoint: "accounts/start",
    statusEp: "accounts/status",
    bodyKey: "rows"
  }, {
    type: "items",
    label: "Items / Products",
    endpoint: "items/start",
    statusEp: "items/status",
    bodyKey: "rows"
  }, {
    type: "customers",
    label: "Customers",
    endpoint: "customers/start",
    statusEp: "customers/status",
    bodyKey: "rows"
  }, {
    type: "vendors",
    label: "Vendors / Suppliers",
    endpoint: "vendors/start",
    statusEp: "vendors/status",
    bodyKey: "rows"
  }, {
    type: "tracking-categories",
    label: "Tracking Categories",
    endpoint: "tracking-categories/start",
    statusEp: "tracking-categories/status",
    bodyKey: "rows"
  }, {
    type: "bills",
    label: "Purchase Bills",
    endpoint: "bills/start",
    statusEp: "bills/status",
    bodyKey: "rows"
  }, {
    type: "invoices",
    label: "Invoices & Credit Notes",
    endpoint: "invoices/start",
    statusEp: "invoices/status",
    bodyKey: "rows"
  }, {
    type: "manual-journals",
    label: "Manual Journals",
    endpoint: "manual-journals/start",
    statusEp: "manual-journals/status",
    bodyKey: "rows"
  }, {
    type: "bill-payments",
    label: "Bill Payments",
    endpoint: "bill-payments/start",
    statusEp: "bill-payments/status",
    bodyKey: "rows"
  }, {
    type: "invoice-payments",
    label: "Invoice Payments",
    endpoint: "invoice-payments/start",
    statusEp: "invoice-payments/status",
    bodyKey: "rows"
  }, {
    type: "spend-money",
    label: "Spend Money",
    endpoint: "spend-money/start",
    statusEp: "spend-money/status",
    bodyKey: "rows"
  }, {
    type: "receive-money",
    label: "Receive Money",
    endpoint: "receive-money/start",
    statusEp: "receive-money/status",
    bodyKey: "rows"
  }, {
    type: "spend-op",
    label: "Spend Overpayment",
    endpoint: "overpayment/start",
    statusEp: "overpayment/status",
    bodyKey: "rows",
    extra: {
      overpaymentType: "SPEND"
    }
  }, {
    type: "receive-op",
    label: "Receive Overpayment",
    endpoint: "overpayment/start",
    statusEp: "overpayment/status",
    bodyKey: "rows",
    extra: {
      overpaymentType: "RECEIVE"
    }
  }, {
    type: "spend-allocation",
    label: "Spend Allocation",
    endpoint: "overpayment-allocation/start",
    statusEp: "overpayment-allocation/status",
    bodyKey: "rows",
    extra: {
      allocationType: "SPEND"
    }
  }, {
    type: "receive-allocation",
    label: "Receive Allocation",
    endpoint: "overpayment-allocation/start",
    statusEp: "overpayment-allocation/status",
    bodyKey: "rows",
    extra: {
      allocationType: "RECEIVE"
    }
  }, {
    type: "cn-allocation",
    label: "Credit Note Allocation",
    endpoint: "credit-note-allocation/start",
    statusEp: "credit-note-allocation/status",
    bodyKey: "rows",
    extra: { allocationType: "credit" }
  }, {
    type: "dn-allocation",
    label: "Debit Note Allocation",
    endpoint: "credit-note-allocation/start",
    statusEp: "credit-note-allocation/status",
    bodyKey: "rows",
    extra: { allocationType: "debit" }
  }];
  const ALL_IMPORT_COL_MAPS = {
    accounts: {
      "Code": "code",
      "Name": "name",
      "Bank Account Number": "bankAccountNumber",
      "Bank Account Type": "bankAccountType",
      "Type": "type",
      "Description": "description",
      "Tax": "tax",
      "Show on Dashboard": "showOnDashboard",
      "Enable Payments To Account": "enablePaymentsToAccount",
      "Expense Claims": "expenseClaims",
      "Currency Code": "currencyCode"
    },
    items: {
      "Code": "code",
      "Name": "name",
      "Description": "description",
      "Purchase Description": "purchaseDescription",
      "Is Sold": "isSold",
      "Is Purchased": "isPurchased",
      "Sales Unit Price": "salesUnitPrice",
      "Sales Account Code": "salesAccountCode",
      "Sales Tax Type": "salesTaxType",
      "Purchase Unit Price": "purchaseUnitPrice",
      "Purchase Account Code": "purchaseAccountCode",
      "Purchase Tax Type": "purchaseTaxType",
      "COGS Account Code": "cogsAccountCode"
    },
    customers: {
      "Name": "name",
      "First Name": "firstName",
      "Last Name": "lastName",
      "Email Address": "emailAddress",
      "Account Number": "accountNumber",
      "Tax Number": "taxNumber",
      "Phone": "phone",
      "Website": "website",
      "Address Line 1": "addressLine1",
      "Address Line 2": "addressLine2",
      "City": "city",
      "State/Region": "region",
      "Postal Code": "postalCode",
      "Country": "country"
    },
    vendors: {
      "Name": "name",
      "First Name": "firstName",
      "Last Name": "lastName",
      "Email Address": "emailAddress",
      "Account Number": "accountNumber",
      "Tax Number": "taxNumber",
      "Phone": "phone",
      "Website": "website",
      "Address Line 1": "addressLine1",
      "Address Line 2": "addressLine2",
      "City": "city",
      "State/Region": "region",
      "Postal Code": "postalCode",
      "Country": "country"
    },
    "tracking-categories": {
      "Category Name": "categoryName",
      "Option Name": "optionName",
      "Status": "status"
    },
    bills: {
      "Bill Number": "billNumber",
      "Contact Name": "contactName",
      "Bill Date": "billDate",
      "Due Date": "dueDate",
      "Reference": "reference",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2",
      "Status": "status"
    },
    invoices: {
      "Invoice Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Invoice Date": "invoiceDate",
      "Due Date": "dueDate",
      "Reference": "reference",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2",
      "Status": "status"
    },
    "manual-journals": {
      "Journal Reference": "reference",
      "Date": "date",
      "Narration": "narration",
      "Account Code": "accountCode",
      "Line Description": "description",
      "Amount": "amount",
      "Debit": "debit",
      "Credit": "credit",
      "Tax Type": "taxType"
    },
    "bill-payments": {
      "Invoice Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Bank Account Code": "bankAccountCode",
      "Date": "date",
      "Amount": "amount",
      "Reference": "reference",
      "Currency Rate": "currencyRate"
    },
    "invoice-payments": {
      "Invoice Number": "invoiceNumber",
      "Bank Account Code": "bankAccountCode",
      "Date": "date",
      "Amount": "amount",
      "Reference": "reference",
      "Currency Rate": "currencyRate"
    },
    "spend-money": {
      "Bank Account Code": "bankAccountCode",
      "Contact Name": "contactName",
      "Date": "date",
      "Reference": "reference",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2"
    },
    "receive-money": {
      "Bank Account Code": "bankAccountCode",
      "Contact Name": "contactName",
      "Date": "date",
      "Reference": "reference",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2"
    },
    "spend-op": {
      "Reference": "reference",
      "Contact Name": "contactName",
      "Date": "date",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Bank Account Code": "bankAccountCode",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2"
    },
    "receive-op": {
      "Reference": "reference",
      "Contact Name": "contactName",
      "Date": "date",
      "Currency Code": "currencyCode",
      "Exchange Rate": "exchangeRate",
      "Bank Account Code": "bankAccountCode",
      "Line Description": "description",
      "Quantity": "quantity",
      "Unit Amount": "unitAmount",
      "Account Code": "accountCode",
      "Tax Type": "taxType",
      "Tax Amount": "taxAmount",
      "Tracking Name 1": "trackingName1",
      "Tracking Option 1": "trackingOption1",
      "Tracking Name 2": "trackingName2",
      "Tracking Option 2": "trackingOption2"
    },
    "spend-allocation": {
      "Overpayment Reference": "overpaymentReference",
      "Bill Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Amount": "amount",
      "Date": "date"
    },
    "receive-allocation": {
      "Overpayment Reference": "overpaymentReference",
      "Invoice Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Amount": "amount",
      "Date": "date"
    },
    "cn-allocation": {
      "Credit Note Number": "creditNoteReference",
      "Invoice Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Amount": "amount",
      "Date": "date"
    },
    "dn-allocation": {
      "Credit Note Number": "creditNoteReference",
      "Bill Number": "invoiceNumber",
      "Contact Name": "contactName",
      "Amount": "amount",
      "Date": "date"
    },
    "exchange-rate-update": {
      "Invoice Number": "invoiceNumber",
      "Exchange Rate": "exchangeRate"
    },
    "bank-transfers": {
      "From Account Code": "fromAccountCode",
      "To Account Code": "toAccountCode",
      "Amount": "amount",
      "Date": "date",
      "Reference": "reference",
      "Exchange Rate": "exchangeRate"
    }
  };
  const downloadCombinedTemplate = () => {
    const sections = [{
      type: "accounts",
      label: "Chart of Accounts",
      headers: ["Code", "Name", "Bank Account Number", "Bank Account Type", "Type", "Description", "Tax", "Show on Dashboard", "Enable Payments To Account", "Expense Claims", "Currency Code"]
    }, {
      type: "items",
      label: "Items / Products",
      headers: ["Code", "Name", "Description", "Purchase Description", "Is Sold", "Is Purchased", "Sales Unit Price", "Sales Account Code", "Sales Tax Type", "Purchase Unit Price", "Purchase Account Code", "Purchase Tax Type", "COGS Account Code"]
    }, {
      type: "customers",
      label: "Customers",
      headers: ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]
    }, {
      type: "vendors",
      label: "Vendors / Suppliers",
      headers: ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]
    }, {
      type: "tracking-categories",
      label: "Tracking Categories",
      headers: ["Category Name", "Option Name", "Status"]
    }, {
      type: "bills",
      label: "Purchase Bills",
      headers: ["Bill Number", "Contact Name", "Bill Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"]
    }, {
      type: "invoices",
      label: "Invoices & Credit Notes",
      headers: ["Invoice Number", "Contact Name", "Invoice Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"]
    }, {
      type: "manual-journals",
      label: "Manual Journals",
      headers: ["Journal Reference", "Date", "Narration", "Account Code", "Line Description", "Debit", "Credit", "Tax Type"]
    }, {
      type: "bill-payments",
      label: "Bill Payments",
      headers: ["Invoice Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"]
    }, {
      type: "invoice-payments",
      label: "Invoice Payments",
      headers: ["Invoice Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"]
    }, {
      type: "spend-money",
      label: "Spend Money",
      headers: ["Bank Account Code", "Contact Name", "Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      type: "receive-money",
      label: "Receive Money",
      headers: ["Bank Account Code", "Contact Name", "Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      type: "spend-op",
      label: "Spend Overpayment",
      headers: ["Reference", "Contact Name", "Date", "Currency Code", "Exchange Rate", "Bank Account Code", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      type: "receive-op",
      label: "Receive Overpayment",
      headers: ["Reference", "Contact Name", "Date", "Currency Code", "Exchange Rate", "Bank Account Code", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      type: "spend-allocation",
      label: "Spend Allocation",
      headers: ["Overpayment Reference", "Bill Number", "Amount", "Date"]
    }, {
      type: "receive-allocation",
      label: "Receive Allocation",
      headers: ["Overpayment Reference", "Invoice Number", "Amount", "Date"]
    }, {
      type: "cn-allocation",
      label: "Credit Note Allocation",
      headers: ["Credit Note Number", "Invoice Number", "Amount", "Date"]
    }, {
      type: "dn-allocation",
      label: "Debit Note Allocation",
      headers: ["Credit Note Number", "Bill Number", "Amount", "Date"]
    }];
    let csv = "## XERO ALL-IN-ONE IMPORT TEMPLATE\r\n";
    csv += "## Instructions: Fill your data rows under each #TYPE: section\r\n";
    csv += "## Leave a section empty if not needed\r\n";
    csv += "## Import runs in this exact order automatically\r\n";
    csv += "## DO NOT edit or remove any #TYPE: lines\r\n\r\n";
    sections.forEach(({
      type,
      label,
      headers
    }) => {
      csv += `## ── ${label} ──\r
`;
      csv += `#TYPE:${type}\r
`;
      csv += `${headers.join(",")}\r
\r
`;
    });
    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xero_all_in_one_import_template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const parseCombinedImportCsv = async file => {
    rejectNonCsv(file);
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    const sections = {};
    let currentType = null;
    let currentHeaders = null;
    const parseLine = line => {
      const result = [];
      let inQuote = false,
        cur = "";
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          inQuote = !inQuote;
        } else if (ch === "," && !inQuote) {
          result.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      result.push(cur.trim());
      return result;
    };
    for (let li = 0; li < lines.length; li++) {
      const raw = lines[li];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith("##")) continue;
      if (trimmed.startsWith("#TYPE:")) {
        currentType = trimmed.slice(6).trim().toLowerCase();
        currentHeaders = null;
        if (!sections[currentType]) sections[currentType] = {
          headers: [],
          rows: []
        };
        continue;
      }
      if (!currentType) continue;
      const cells = parseLine(raw);
      if (!currentHeaders) {
        currentHeaders = cells.map(h => h.trim());
        sections[currentType].headers = currentHeaders;
      } else {
        if (cells.some(c => c.trim())) {
          const colMap = ALL_IMPORT_COL_MAPS[currentType] || {};
          const row = {
            rowNumber: sections[currentType].rows.length + 2
          };
          currentHeaders.forEach((h, i) => {
            const key = colMap[h] || h;
            row[key] = cells[i] ? cells[i].trim() : "";
          });
          sections[currentType].rows.push(row);
        }
      }
    }
    return sections;
  };
  const handleAllImportFile = async file => {
    setAllImportFile(file);
    setAllImportSections([]);
    setAllImportFileError("");
    setAllImportPhases([]);
    if (!file) return;
    try {
      const sections = await parseCombinedImportCsv(file);
      const summary = ALL_IMPORT_ORDER.map(({
        type,
        label
      }) => ({
        type,
        label,
        rows: sections[type]?.rows?.length || 0
      })).filter(s => s.rows > 0);
      if (!summary.length) {
        setAllImportFileError("No data rows found in any section. Fill data under the #TYPE: sections.");
        return;
      }
      setAllImportSections(summary);
    } catch (err) {
      setAllImportFileError(err.message);
    }
  };
  const startAllImport = async () => {
    if (!selectedTenant) {
      setAllImportFileError("Select a Xero organisation before importing.");
      return;
    }
    if (!allImportFile) {
      setAllImportFileError("Upload a combined CSV file first.");
      return;
    }
    setAllImportRunning(true);
    setAllImportFileError("");
    const sections = await parseCombinedImportCsv(allImportFile);
    const phases = allImportSections.map(s => ({
      ...s,
      status: "pending",
      created: 0,
      errors: 0,
      total: s.rows,
      message: ""
    }));
    setAllImportPhases([...phases]);
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      const def = ALL_IMPORT_ORDER.find(d => d.type === phase.type);
      if (!def) continue;
      const rows = sections[phase.type]?.rows || [];
      if (!rows.length) {
        phases[i] = {
          ...phases[i],
          status: "skipped"
        };
        setAllImportPhases([...phases]);
        continue;
      }
      phases[i] = {
        ...phases[i],
        status: "running"
      };
      setAllImportPhases([...phases]);
      try {
        const body = {
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: `${phase.type}.csv`,
          rows,
          ...(def.extra || {})
        };
        const startRes = await fetch(`${API_BASE}/import/${def.endpoint}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...importHeaders,
            "x-tenant-id": selectedTenant
          },
          body: JSON.stringify(body)
        });
        const startData = await startRes.json().catch(() => ({}));
        if (!startRes.ok) throw new Error(startData.error || `Failed to start ${phase.label} import.`);
        const jobId = startData.jobId;
        await new Promise(resolve => {
          const poll = async () => {
            try {
              const statusRes = await fetch(`${API_BASE}/import/${def.statusEp}?jobId=${jobId}`, {
                headers: {
                  ...importHeaders,
                  "x-tenant-id": selectedTenant
                }
              });
              const statusData = await statusRes.json().catch(() => ({}));
              const done = ["completed", "completed_with_errors", "error"].includes(statusData.status);
              phases[i] = {
                ...phases[i],
                status: done ? statusData.errors > 0 ? "done_with_errors" : "done" : "running",
                created: statusData.created || 0,
                errors: statusData.errors || 0,
                total: statusData.total || phase.rows,
                message: statusData.status === "error" ? statusData.error || "Import failed." : ""
              };
              setAllImportPhases([...phases]);
              if (!done) setTimeout(poll, 2e3);else resolve();
            } catch {
              resolve();
            }
          };
          poll();
        });
      } catch (err) {
        phases[i] = {
          ...phases[i],
          status: "done_with_errors",
          message: err.message
        };
        setAllImportPhases([...phases]);
      }
    }
    setAllImportRunning(false);
  };
  const loadConversionAccounts = async () => {
    if (!selectedTenant) {
      setConversionError("Select a Xero organisation first.");
      return;
    }
    setConversionLoading(true);
    setConversionError("");
    try {
      const res = await fetch(`${API_BASE}/accounts/chart?tenantId=${selectedTenant}`, {
        headers: {
          ...importHeaders,
          "x-tenant-id": selectedTenant,
          "x-session-id": sessionId
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load chart of accounts.");
      const accounts = Array.isArray(data.accounts) ? data.accounts : [];
      setConversionAccounts(accounts.map(a => ({
        ...a,
        debit: "",
        credit: ""
      })));
      setConversionResult(null);
      setConversionStatus("");
    } catch (err) {
      setConversionError(err.message);
    } finally {
      setConversionLoading(false);
    }
  };
  const isArApAccount = a => a.systemAccount === "DEBTORS" || a.systemAccount === "CREDITORS";
  const updateConversionRow = (code, field, value) => {
    setConversionAccounts(prev => prev.map(r => r.code === code ? {
      ...r,
      [field]: value
    } : r));
  };
  const conversionTotals = conversionAccounts.reduce((acc, r) => {
    acc.debit += Number(r.debit) || 0;
    acc.credit += Number(r.credit) || 0;
    return acc;
  }, {
    debit: 0,
    credit: 0
  });
  const conversionDiff = Math.round((conversionTotals.debit - conversionTotals.credit) * 100) / 100;
  const startConversionImport = async () => {
    if (!selectedTenant) {
      setConversionStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!conversionDate) {
      setConversionStatus("Set the Conversion Date first.");
      return;
    }
    if (Math.abs(conversionDiff) > 0.01) {
      setConversionStatus("Debit and Credit totals must match before importing.");
      return;
    }
    const lines = conversionAccounts.filter(r => !isArApAccount(r) && ((Number(r.debit) || 0) !== 0 || (Number(r.credit) || 0) !== 0)).map(r => ({
      accountCode: r.code,
      description: r.name,
      debit: r.debit,
      credit: r.credit,
      taxType: ""
    }));
    if (lines.length < 2) {
      setConversionStatus("Enter at least 2 account balances before importing.");
      return;
    }
    const d = new Date(conversionDate);
    d.setDate(d.getDate() - 1);
    const journalDate = d.toISOString().slice(0, 10);
    setConversionRunning(true);
    setConversionStatus("Starting Conversion Balances import...");
    setConversionResult(null);
    try {
      const journal = {
        rowNumber: 1,
        reference: "Conversion Balances",
        narration: "Conversion Balances",
        date: journalDate,
        lines
      };
      const startRes = await fetch(`${API_BASE}/import/manual-journals/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: "conversion-balances.csv",
          rows: [journal]
        })
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok) throw new Error(startData.error || "Failed to start Conversion Balances import.");
      const jobId = startData.jobId;
      await new Promise(resolve => {
        const poll = async () => {
          try {
            const statusRes = await fetch(`${API_BASE}/import/manual-journals/status?jobId=${jobId}`, {
              headers: {
                ...importHeaders,
                "x-tenant-id": selectedTenant
              }
            });
            const statusData = await statusRes.json().catch(() => ({}));
            const done = ["completed", "completed_with_errors", "error"].includes(statusData.status);
            if (!done) {
              setTimeout(poll, 1500);
              return;
            }
            setConversionResult(statusData);
            setConversionStatus(statusData.status === "completed" ? "Conversion Balances journal created successfully." : statusData.error || "Conversion Balances import finished with errors.");
            resolve();
          } catch {
            resolve();
          }
        };
        poll();
      });
    } catch (err) {
      setConversionStatus(err.message);
    } finally {
      setConversionRunning(false);
    }
  };
  const downloadAllTemplatesAsZip = async () => {
    const templates = [{
      filename: "01_bills.csv",
      headers: ["Bill Number", "Contact Name", "Bill Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"]
    }, {
      filename: "02_invoices.csv",
      headers: ["Invoice Number", "Contact Name", "Invoice Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"]
    }, {
      filename: "03_credit_notes.csv",
      headers: ["Credit Note Number", "Contact Name", "Credit Note Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"]
    }, {
      filename: "04_bill_payments.csv",
      headers: ["Invoice Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"]
    }, {
      filename: "05_invoice_payments.csv",
      headers: ["Invoice Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"]
    }, {
      filename: "06_accounts.csv",
      headers: ["Code", "Name", "Bank Account Number", "Bank Account Type", "Type", "Description", "Tax", "Show on Dashboard", "Enable Payments To Account", "Expense Claims", "Currency Code"]
    }, {
      filename: "07_items.csv",
      headers: ["Code", "Name", "Description", "Purchase Description", "Is Sold", "Is Purchased", "Sales Unit Price", "Sales Account Code", "Sales Tax Type", "Purchase Unit Price", "Purchase Account Code", "Purchase Tax Type", "COGS Account Code"]
    }, {
      filename: "08_customers.csv",
      headers: ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]
    }, {
      filename: "09_vendors.csv",
      headers: ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]
    }, {
      filename: "10_tracking_categories.csv",
      headers: ["Category Name", "Option Name", "Status"]
    }, {
      filename: "11_spend_money.csv",
      headers: ["Bank Account Code", "Contact Name", "Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      filename: "12_receive_money.csv",
      headers: ["Bank Account Code", "Contact Name", "Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      filename: "13_spend_overpayment.csv",
      headers: ["Reference", "Contact Name", "Date", "Currency Code", "Exchange Rate", "Bank Account Code", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      filename: "14_receive_overpayment.csv",
      headers: ["Reference", "Contact Name", "Date", "Currency Code", "Exchange Rate", "Bank Account Code", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"]
    }, {
      filename: "15_allocation.csv",
      headers: ["Overpayment Reference", "Amount", "Date"]
    }, {
      filename: "16_manual_journals.csv",
      headers: ["Journal Reference", "Date", "Narration", "Account Code", "Line Description", "Debit", "Credit", "Tax Type"]
    }];
    const zip = new JSZip();
    templates.forEach(({
      filename,
      headers
    }) => {
      zip.file(filename, `${headers.join(",")}\r
`);
    });
    const blob = await zip.generateAsync({
      type: "blob"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "xero_all_import_templates.zip";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const downloadCustomersCsvTemplate = () => {
    downloadCsvFile("xero_customers_import_template.csv", ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]);
  };
  const downloadVendorsCsvTemplate = () => {
    downloadCsvFile("xero_vendors_import_template.csv", ["Name", "First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"]);
  };
  const downloadTrackingCatTemplate = () => {
    downloadCsvFile("xero_tracking_categories_import_template.csv", ["Category Name", "Option Name", "Status"]);
  };
  const downloadItemsCsvTemplate = () => {
    downloadCsvFile("xero_items_import_template.csv", ["Code", "Name", "Description", "Purchase Description", "Is Sold", "Is Purchased", "Sales Unit Price", "Sales Account Code", "Sales Tax Type", "Purchase Unit Price", "Purchase Account Code", "Purchase Tax Type", "COGS Account Code"]);
  };
  const downloadBillsCsvTemplate = () => {
    downloadCsvFile("xero_purchase_bills_import_template.csv", ["Bill Number", "Contact Name", "Bill Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"], [
      ["BILL-001", "Example Vendor Ltd", "2026-01-15", "2026-02-15", "PO-123", "NZD", "1", "Example product or service", "1", "100.00", "200", "NONE", "", "", "", "", "", "DRAFT"],
    ]);
  };
  const downloadCreditNotesCsvTemplate = () => {
    downloadCsvFile("xero_credit_notes_import_template.csv", ["Credit Note Number", "Contact Name", "Credit Note Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"], [
      ["CN-001", "Example Customer Ltd", "2026-01-15", "REF-001", "NZD", "1", "Example item returned", "1", "100.00", "200", "NONE", "", "", "", "", "", "DRAFT"],
    ]);
  };
  const downloadInvoicesCsvTemplate = () => {
    downloadCsvFile("xero_sales_invoices_credit_notes_import_template.csv", ["Invoice Number", "Contact Name", "Invoice Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"], [
      ["INV-001", "Example Customer Ltd", "2026-01-15", "2026-02-15", "REF-001", "NZD", "1", "Example product or service", "1", "100.00", "200", "NONE", "", "", "", "", "", "DRAFT"],
    ]);
  };
  const parseCsvRows = text => {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === "," && !quoted) {
        row.push(cell.trim());
        cell = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[index + 1] === "\n") index += 1;
        row.push(cell.trim());
        if (row.some(value => value)) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += char;
      }
    }
    row.push(cell.trim());
    if (row.some(value => value)) rows.push(row);
    return rows;
  };
  const rejectNonCsv = (file) => {
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm") || name.endsWith(".xlsb")) {
      throw new Error(`Excel files are not supported. Save your file as CSV first, then upload the .csv file.`);
    }
  };
  const readFileAsMatrix = async (file) => {
    rejectNonCsv(file);
    return parseCsvRows(await file.text());
  };
  const readCsvByHeaders = async ({
    file,
    expectedHeaders,
    optionalHeaders = [],
    importTypeKey = ""
  }) => {
    // Reject Excel files — only plain CSV is supported
    const name = (file.name || "").toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".xlsm") || name.endsWith(".xlsb")) {
      throw new Error(`Excel files (.xlsx/.xls) are not supported. Please save your file as CSV (comma-separated) first, then upload the .csv file.`);
    }
    if (!name.endsWith(".csv") && file.type && file.type !== "text/csv" && file.type !== "text/plain" && file.type !== "application/csv") {
      throw new Error(`Only CSV files are accepted. "${file.name}" does not appear to be a CSV file.`);
    }
    const matrix = await readFileAsMatrix(file);
    const actualHeaders = matrix[0] || [];
    const normalize = value => String(value || "").replace(/[^a-zA-Z0-9 ]/g, "").trim().toLowerCase();
    const missingRequired = expectedHeaders.filter(h => !actualHeaders.some(a => normalize(a) === normalize(h)));

    if (missingRequired.length > 0) {
      const { mapping, confidence } = computeFuzzyMapping(actualHeaders, expectedHeaders, optionalHeaders, importTypeKey);
      const allCoveredBySaved = expectedHeaders.every(h => mapping[h] && confidence[h] === 100);

      const resolvedMapping = allCoveredBySaved
        ? mapping
        : await new Promise((resolve, reject) => {
            setColumnMappingState({ expectedHeaders, optionalHeaders, actualHeaders, suggestions: mapping, confidence, importTypeKey, resolve, reject });
          });

      const indexes = {};
      for (const [expected, userCol] of Object.entries(resolvedMapping)) {
        indexes[expected] = userCol ? actualHeaders.indexOf(userCol) : -1;
      }
      return matrix.slice(1).map((cells, i) => ({ cells, indexes, rowNumber: i + 2 }));
    }

    const indexes = Object.fromEntries(
      [...expectedHeaders, ...optionalHeaders].map(h => [h, actualHeaders.findIndex(a => normalize(a) === normalize(h))])
    );
    return matrix.slice(1).map((cells, i) => ({ cells, indexes, rowNumber: i + 2 }));
  };
  const handleAccountsImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setAccountsImportFile(file);
    setAccountsImportRows([]);
    setAccountsImportErrors([]);
    setAccountsImportProgress(null);
    setAccountsImportJobId("");
    if (!file) {
      setAccountsImportStatus("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Code", "Name", "Type"],
        optionalHeaders: ["Bank Account Number", "Bank Account Type", "Description", "Tax", "Show on Dashboard", "Enable Payments To Account", "Expense Claims", "Currency Code"],
        importTypeKey: "accounts"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        code: cells[indexes.Code] || "",
        name: cells[indexes.Name] || "",
        type: cells[indexes.Type] || "",
        bankAccountNumber: cells[indexes["Bank Account Number"]] || "",
        bankAccountType: cells[indexes["Bank Account Type"]] || "",
        description: cells[indexes.Description] || "",
        tax: cells[indexes.Tax] || "",
        showOnDashboard: cells[indexes["Show on Dashboard"]] || "",
        enablePaymentsToAccount: cells[indexes["Enable Payments To Account"]] || "",
        expenseClaims: cells[indexes["Expense Claims"]] || "",
        currencyCode: cells[indexes["Currency Code"]] || ""
      }));
      const validationErrors = parsedRows.filter(row => !row.code || !row.name || !row.type).map(row => `Row ${row.rowNumber}: Code, Name, and Type are required.`);
      setAccountsImportRows(parsedRows);
      setAccountsImportErrors(validationErrors);
      setAccountsImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated successfully. ${parsedRows.length} account row(s) ready to import.`);
    } catch (err) {
      setAccountsImportErrors([err.message]);
      setAccountsImportStatus(err.message);
    }
  };
  const handleItemsImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setItemsImportFile(file);
    setItemsImportRows([]);
    setItemsImportErrors([]);
    setItemsImportProgress(null);
    setItemsImportJobId("");
    if (!file) {
      setItemsImportStatus("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Code", "Name"],
        optionalHeaders: ["Description", "Purchase Description", "Is Sold", "Is Purchased", "Sales Unit Price", "Sales Account Code", "Sales Tax Type", "Purchase Unit Price", "Purchase Account Code", "Purchase Tax Type", "COGS Account Code"],
        importTypeKey: "items"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        code: cells[indexes.Code] || "",
        name: cells[indexes.Name] || "",
        description: cells[indexes.Description] || "",
        purchaseDescription: cells[indexes["Purchase Description"]] || "",
        isSold: cells[indexes["Is Sold"]] || "",
        isPurchased: cells[indexes["Is Purchased"]] || "",
        salesUnitPrice: cells[indexes["Sales Unit Price"]] || "",
        salesAccountCode: cells[indexes["Sales Account Code"]] || "",
        salesTaxType: cells[indexes["Sales Tax Type"]] || "",
        purchaseUnitPrice: cells[indexes["Purchase Unit Price"]] || "",
        purchaseAccountCode: cells[indexes["Purchase Account Code"]] || "",
        purchaseTaxType: cells[indexes["Purchase Tax Type"]] || "",
        cogsAccountCode: cells[indexes["COGS Account Code"]] || ""
      }));
      const validationErrors = parsedRows.filter(row => !row.code || !row.name).map(row => `Row ${row.rowNumber}: Code and Name are required.`);
      setItemsImportRows(parsedRows);
      setItemsImportErrors(validationErrors);
      setItemsImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} item row(s) ready to import.`);
    } catch (err) {
      setItemsImportErrors([err.message]);
      setItemsImportStatus(err.message);
    }
  };
  const handleCustomersImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setCustomersImportFile(file);
    setCustomersImportRows([]);
    setCustomersImportErrors([]);
    setCustomersImportProgress(null);
    setCustomersImportJobId("");
    if (!file) {
      setCustomersImportStatus("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Name"],
        optionalHeaders: ["First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"],
        importTypeKey: "customers"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        name: cells[indexes.Name] || "",
        firstName: cells[indexes["First Name"]] || "",
        lastName: cells[indexes["Last Name"]] || "",
        emailAddress: cells[indexes["Email Address"]] || "",
        accountNumber: cells[indexes["Account Number"]] || "",
        taxNumber: cells[indexes["Tax Number"]] || "",
        phone: cells[indexes.Phone] || "",
        website: cells[indexes.Website] || "",
        addressLine1: cells[indexes["Address Line 1"]] || "",
        addressLine2: cells[indexes["Address Line 2"]] || "",
        city: cells[indexes.City] || "",
        region: cells[indexes["State/Region"]] || "",
        postalCode: cells[indexes["Postal Code"]] || "",
        country: cells[indexes.Country] || ""
      }));
      const validationErrors = parsedRows.filter(row => !row.name).map(row => `Row ${row.rowNumber}: Name is required.`);
      setCustomersImportRows(parsedRows);
      setCustomersImportErrors(validationErrors);
      setCustomersImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} customer row(s) ready to import.`);
    } catch (err) {
      setCustomersImportErrors([err.message]);
      setCustomersImportStatus(err.message);
    }
  };
  const handleVendorsImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setVendorsImportFile(file);
    setVendorsImportRows([]);
    setVendorsImportErrors([]);
    setVendorsImportProgress(null);
    setVendorsImportJobId("");
    if (!file) {
      setVendorsImportStatus("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Name"],
        optionalHeaders: ["First Name", "Last Name", "Email Address", "Account Number", "Tax Number", "Phone", "Website", "Address Line 1", "Address Line 2", "City", "State/Region", "Postal Code", "Country"],
        importTypeKey: "vendors"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        name: cells[indexes.Name] || "",
        firstName: cells[indexes["First Name"]] || "",
        lastName: cells[indexes["Last Name"]] || "",
        emailAddress: cells[indexes["Email Address"]] || "",
        accountNumber: cells[indexes["Account Number"]] || "",
        taxNumber: cells[indexes["Tax Number"]] || "",
        phone: cells[indexes.Phone] || "",
        website: cells[indexes.Website] || "",
        addressLine1: cells[indexes["Address Line 1"]] || "",
        addressLine2: cells[indexes["Address Line 2"]] || "",
        city: cells[indexes.City] || "",
        region: cells[indexes["State/Region"]] || "",
        postalCode: cells[indexes["Postal Code"]] || "",
        country: cells[indexes.Country] || ""
      }));
      const validationErrors = parsedRows.filter(row => !row.name).map(row => `Row ${row.rowNumber}: Name is required.`);
      setVendorsImportRows(parsedRows);
      setVendorsImportErrors(validationErrors);
      setVendorsImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} vendor row(s) ready to import.`);
    } catch (err) {
      setVendorsImportErrors([err.message]);
      setVendorsImportStatus(err.message);
    }
  };
  const handleTrackingCatImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setTrackingCatImportFile(file);
    setTrackingCatImportRows([]);
    setTrackingCatImportErrors([]);
    setTrackingCatImportProgress(null);
    setTrackingCatImportJobId("");
    if (!file) {
      setTrackingCatImportStatus("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Category Name", "Option Name"],
        optionalHeaders: ["Status"],
        importTypeKey: "tracking-categories"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        categoryName: cells[indexes["Category Name"]] || "",
        optionName: cells[indexes["Option Name"]] || "",
        status: cells[indexes.Status] || "ACTIVE"
      }));
      const validationErrors = parsedRows.filter(row => !row.categoryName || !row.optionName).map(row => `Row ${row.rowNumber}: Category Name and Option Name are required.`);
      setTrackingCatImportRows(parsedRows);
      setTrackingCatImportErrors(validationErrors);
      setTrackingCatImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} option row(s) ready to import.`);
    } catch (err) {
      setTrackingCatImportErrors([err.message]);
      setTrackingCatImportStatus(err.message);
    }
  };
  const handlePoImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setPoImportFile(file);
    setPoImportRows([]);
    setPoImportErrors([]);
    setPoImportProgress(null);
    setPoImportJobId("");
    if (!file) { setPoImportStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["PO Number", "Contact Name", "Date", "Line Description", "Unit Amount", "Account Code"],
        optionalHeaders: ["Delivery Date", "Reference", "Attention To", "Telephone", "Delivery Instructions", "Currency Code", "Exchange Rate", "Quantity", "Item Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"],
        importTypeKey: "purchase-orders"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        poNumber: cells[indexes["PO Number"]] || "",
        contactName: cells[indexes["Contact Name"]] || "",
        date: cells[indexes.Date] || "",
        deliveryDate: cells[indexes["Delivery Date"]] || "",
        reference: cells[indexes.Reference] || "",
        attentionTo: cells[indexes["Attention To"]] || "",
        telephone: cells[indexes.Telephone] || "",
        deliveryInstructions: cells[indexes["Delivery Instructions"]] || "",
        currencyCode: cells[indexes["Currency Code"]] || "",
        exchangeRate: cells[indexes["Exchange Rate"]] || "",
        description: cells[indexes["Line Description"]] || "",
        quantity: cells[indexes.Quantity] || "",
        unitAmount: cells[indexes["Unit Amount"]] || "",
        accountCode: cells[indexes["Account Code"]] || "",
        itemCode: cells[indexes["Item Code"]] || "",
        taxType: cells[indexes["Tax Type"]] || "",
        taxAmount: cells[indexes["Tax Amount"]] || "",
        trackingName1: cells[indexes["Tracking Name 1"]] || "",
        trackingOption1: cells[indexes["Tracking Option 1"]] || "",
        trackingName2: cells[indexes["Tracking Name 2"]] || "",
        trackingOption2: cells[indexes["Tracking Option 2"]] || "",
        status: cells[indexes.Status] || "DRAFT"
      }));
      const validationErrors = parsedRows.flatMap(row => {
        const errs = [];
        if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
        if (!row.unitAmount) errs.push(`Row ${row.rowNumber}: Unit Amount is required.`);
        if (!row.accountCode) errs.push(`Row ${row.rowNumber}: Account Code is required.`);
        return errs;
      });
      setPoImportRows(parsedRows);
      setPoImportErrors(validationErrors);
      setPoImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated. ${parsedRows.length} line row(s) ready.`);
    } catch (err) {
      setPoImportErrors([err.message]);
      setPoImportStatus(err.message);
    }
  };

  const handleUpdateStatusFile = async event => {
    const file = event.target.files?.[0] || null;
    setUpdateStatusFile(file);
    setUpdateStatusRows([]);
    setUpdateStatusErrors([]);
    setUpdateStatusProgress(null);
    setUpdateStatusJobId("");
    if (!file) { setUpdateStatusStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Number", "New Status"],
        optionalHeaders: ["Type"],
        importTypeKey: "update-status"
      });
      const errors = [];
      const validStatuses = ["DRAFT", "SUBMITTED", "AUTHORISED", "VOIDED", "DELETED"];
      const parsed = rows.map(({ cells, indexes, rowNumber }) => {
        const number = cells[indexes.Number] || "";
        const newStatus = String(cells[indexes["New Status"]] || "").trim().toUpperCase();
        const docType = String(cells[indexes.Type] || "INVOICE").trim().toUpperCase();
        if (!number) errors.push({ rowNumber, message: "Number is required" });
        if (!validStatuses.includes(newStatus)) errors.push({ rowNumber, message: `Invalid status: ${newStatus}. Use: DRAFT, AUTHORISED, VOIDED` });
        return { rowNumber, number, newStatus, docType };
      }).filter(r => r.number);
      setUpdateStatusRows(parsed);
      setUpdateStatusErrors(errors);
      setUpdateStatusStatus(errors.length ? `${errors.length} validation error(s) found.` : `${parsed.length} record(s) ready to update.`);
    } catch (err) {
      if (err.message === "Column mapping cancelled.") { setUpdateStatusStatus(""); return; }
      setUpdateStatusErrors([{ rowNumber: 0, message: err.message }]);
      setUpdateStatusStatus(err.message);
    }
  };

  const startUpdateStatus = async () => {
    if (!selectedTenant) { setUpdateStatusStatus("Select a Xero organisation before updating."); return; }
    if (!updateStatusRows.length || updateStatusErrors.length) { setUpdateStatusStatus("Upload a valid CSV file before updating."); return; }
    setUpdateStatusLoading(true);
    setUpdateStatusStatus("Starting bulk status update...");
    try {
      const res = await fetch(`${API_BASE}/update/status/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, filename: updateStatusFile?.name || "update-status.csv", rows: updateStatusRows })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start bulk update.");
      setUpdateStatusProgress(data);
      setUpdateStatusJobId(data.jobId);
      setUpdateStatusStatus("Update started. Progress will update automatically.");
    } catch (err) {
      setUpdateStatusStatus(err.message);
      setUpdateStatusLoading(false);
    }
  };

  const bankTransferTemplateHeaders = ["From Account Code", "To Account Code", "Amount", "Date", "Reference", "Exchange Rate"];
  const downloadBankTransferTemplate = () => downloadCsvFile("xero_bank_transfer_import_template.csv", bankTransferTemplateHeaders, [
    ["090", "091", "1000.00", "2026-01-15", "Transfer ref", "1"],
  ]);

  const handleBankTransferFile = async event => {
    const file = event.target.files?.[0] || null;
    setBankTransferFile(file);
    setBankTransferRows([]);
    setBankTransferErrors([]);
    setBankTransferProgress(null);
    setBankTransferJobId("");
    if (!file) { setBankTransferStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["From Account Code", "To Account Code", "Amount", "Date"],
        optionalHeaders: ["Reference", "Exchange Rate"],
        importTypeKey: "bank-transfers"
      });
      const parsed = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        fromAccountCode: String(cells[indexes["From Account Code"]] || "").trim(),
        toAccountCode:   String(cells[indexes["To Account Code"]]   || "").trim(),
        amount:          String(cells[indexes["Amount"]]             || "").trim(),
        date:            String(cells[indexes["Date"]]               || "").trim(),
        reference:       String(cells[indexes["Reference"]]          || "").trim(),
        exchangeRate:    String(cells[indexes["Exchange Rate"]]       || "").trim(),
      })).filter(r => r.fromAccountCode && r.toAccountCode && r.amount && r.date);
      setBankTransferRows(parsed);
      setBankTransferStatus(`${parsed.length} transfer(s) ready to import.`);
    } catch (err) {
      if (err.message === "Column mapping cancelled.") { setBankTransferStatus(""); return; }
      setBankTransferErrors([err.message]);
      setBankTransferStatus(err.message);
    }
  };

  const startBankTransferImport = async () => {
    if (!selectedTenant) { setBankTransferStatus("Select a Xero organisation first."); return; }
    if (!bankTransferRows.length) { setBankTransferStatus("Upload a CSV file first."); return; }
    if (bankTransferLoading) return;
    setBankTransferLoading(true);
    setBankTransferStatus("Starting bank transfer import...");
    try {
      const res = await fetch(`${API_BASE}/import/bank-transfers/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, dateFormat: dateFormatPref, filename: bankTransferFile?.name || "bank-transfers.csv", rows: bankTransferRows })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start bank transfer import.");
      setBankTransferProgress(data);
      setBankTransferJobId(data.jobId);
      setBankTransferStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setBankTransferStatus(err.message);
      setBankTransferLoading(false);
    }
  };

  const downloadExchangeRateUpdateTemplate = () => {
    downloadCsvFile("xero_exchange_rate_update_template.csv", "Invoice Number");
  };

  const handleExchangeRateUpdateFile = async event => {
    const file = event.target.files?.[0] || null;
    setExchangeRateUpdateFile(file);
    setExchangeRateUpdateRows([]);
    setExchangeRateUpdateErrors([]);
    setExchangeRateUpdateProgress(null);
    setExchangeRateUpdateJobId("");
    if (!file) { setExchangeRateUpdateStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Invoice Number"],
        optionalHeaders: ["Exchange Rate"],
        importTypeKey: "exchange-rate-update"
      });
      const parsed = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        invoiceNumber: String(cells[indexes["Invoice Number"]] || "").trim(),
        exchangeRate: String(cells[indexes["Exchange Rate"]] || "").trim()
      })).filter(r => r.invoiceNumber);
      setExchangeRateUpdateRows(parsed);
      setExchangeRateUpdateStatus(`${parsed.length} invoice(s) ready to update.`);
    } catch (err) {
      if (err.message === "Column mapping cancelled.") { setExchangeRateUpdateStatus(""); return; }
      setExchangeRateUpdateErrors([err.message]);
      setExchangeRateUpdateStatus(err.message);
    }
  };

  const startExchangeRateUpdateImport = async () => {
    if (!selectedTenant) { setExchangeRateUpdateStatus("Select a Xero organisation first."); return; }
    if (!exchangeRateUpdateRows.length) { setExchangeRateUpdateStatus("Upload a CSV file first."); return; }
    if (exchangeRateUpdateLoading) return;
    setExchangeRateUpdateLoading(true);
    setExchangeRateUpdateStatus("Starting exchange rate update...");
    try {
      const res = await fetch(`${API_BASE}/import/exchange-rate-update/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, filename: exchangeRateUpdateFile?.name || "exchange-rate-update.csv", rows: exchangeRateUpdateRows })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start exchange rate update.");
      setExchangeRateUpdateProgress(data);
      setExchangeRateUpdateJobId(data.jobId);
      localStorage.setItem("erUpdateJobId", data.jobId);
      setExchangeRateUpdateStatus("Update started. Progress will update automatically.");
    } catch (err) {
      setExchangeRateUpdateStatus(err.message);
      setExchangeRateUpdateLoading(false);
    }
  };

  const startPoImport = async () => {
    if (!selectedTenant) { setPoImportStatus("Select a Xero organisation before importing."); return; }
    if (!poImportRows.length || poImportErrors.length) { setPoImportStatus("Upload a valid CSV file before importing."); return; }
    setPoImportLoading(true);
    setPoImportStatus("Starting Purchase Orders import...");
    if (autoCreateContacts) { setPoImportStatus("Auto-creating missing contacts..."); await autoEnsureContacts(poImportRows.map(r => r.contactName)); }
    try {
      const res = await fetch(`${API_BASE}/import/purchase-orders/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, dateFormat: dateFormatPref, filename: poImportFile?.name || "purchase-orders.csv", rows: poImportRows, skipDuplicateCheck: docSkipDupCheck, updateMode: isUpdateCentrePage })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start Purchase Orders import.");
      setPoImportProgress(data);
      setPoImportJobId(data.jobId);
      setPoImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setPoImportStatus(err.message);
      setPoImportLoading(false);
    }
  };

  const handleQuotesImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setQuotesImportFile(file);
    setQuotesImportRows([]);
    setQuotesImportErrors([]);
    setQuotesImportProgress(null);
    setQuotesImportJobId("");
    if (!file) { setQuotesImportStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: ["Quote Number", "Contact Name", "Date", "Line Description", "Unit Amount", "Account Code"],
        optionalHeaders: ["Expiry Date", "Title", "Summary", "Terms", "Reference", "Currency Code", "Line Amount Types", "Quantity", "Item Code", "Discount Rate", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"],
        importTypeKey: "quotes"
      });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
        rowNumber,
        quoteNumber: cells[indexes["Quote Number"]] || "",
        contactName: cells[indexes["Contact Name"]] || "",
        date: cells[indexes.Date] || "",
        expiryDate: cells[indexes["Expiry Date"]] || "",
        title: cells[indexes.Title] || "",
        summary: cells[indexes.Summary] || "",
        terms: cells[indexes.Terms] || "",
        reference: cells[indexes.Reference] || "",
        currencyCode: cells[indexes["Currency Code"]] || "",
        lineAmountTypes: cells[indexes["Line Amount Types"]] || "",
        description: cells[indexes["Line Description"]] || "",
        quantity: cells[indexes.Quantity] || "",
        unitAmount: cells[indexes["Unit Amount"]] || "",
        accountCode: cells[indexes["Account Code"]] || "",
        itemCode: cells[indexes["Item Code"]] || "",
        discountRate: cells[indexes["Discount Rate"]] || "",
        taxType: cells[indexes["Tax Type"]] || "",
        taxAmount: cells[indexes["Tax Amount"]] || "",
        trackingName1: cells[indexes["Tracking Name 1"]] || "",
        trackingOption1: cells[indexes["Tracking Option 1"]] || "",
        trackingName2: cells[indexes["Tracking Name 2"]] || "",
        trackingOption2: cells[indexes["Tracking Option 2"]] || "",
        status: cells[indexes.Status] || "DRAFT"
      }));
      const validationErrors = parsedRows.flatMap(row => {
        const errs = [];
        if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
        if (!row.unitAmount) errs.push(`Row ${row.rowNumber}: Unit Amount is required.`);
        if (!row.accountCode) errs.push(`Row ${row.rowNumber}: Account Code is required.`);
        return errs;
      });
      setQuotesImportRows(parsedRows);
      setQuotesImportErrors(validationErrors);
      setQuotesImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated. ${parsedRows.length} line row(s) ready.`);
    } catch (err) {
      setQuotesImportErrors([err.message]);
      setQuotesImportStatus(err.message);
    }
  };

  const startQuotesImport = async () => {
    if (!selectedTenant) { setQuotesImportStatus("Select a Xero organisation before importing."); return; }
    if (!quotesImportRows.length || quotesImportErrors.length) { setQuotesImportStatus("Upload a valid CSV file before importing."); return; }
    setQuotesImportLoading(true);
    setQuotesImportStatus("Starting Quotes import...");
    if (autoCreateContacts) { setQuotesImportStatus("Auto-creating missing contacts..."); await autoEnsureContacts(quotesImportRows.map(r => r.contactName)); }
    try {
      const res = await fetch(`${API_BASE}/import/quotes/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, dateFormat: dateFormatPref, filename: quotesImportFile?.name || "quotes.csv", rows: quotesImportRows, skipDuplicateCheck: docSkipDupCheck, updateMode: isUpdateCentrePage })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start Quotes import.");
      setQuotesImportProgress(data);
      setQuotesImportJobId(data.jobId);
      setQuotesImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setQuotesImportStatus(err.message);
      setQuotesImportLoading(false);
    }
  };

  const handleBillsImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setBillsImportFile(file);
    setBillsImportRows([]);
    setBillsImportErrors([]);
    if (!file) {
      setBillsImportStatus("");
      return;
    }
    const expectedHeaders = ["Bill Number", "Contact Name", "Bill Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"];
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders,
        importTypeKey: "bills"
      });
      const parsedRows = rows.map(({
        cells,
        indexes,
        rowNumber
      }) => ({
        rowNumber,
        billNumber: cells[indexes["Bill Number"]] || "",
        contactName: cells[indexes["Contact Name"]] || "",
        billDate: cells[indexes["Bill Date"]] || "",
        dueDate: cells[indexes["Due Date"]] || cells[indexes["Bill Date"]] || "",
        reference: cells[indexes.Reference] || "",
        currencyCode: cells[indexes["Currency Code"]] || "",
        exchangeRate: cells[indexes["Exchange Rate"]] || "",
        description: cells[indexes["Line Description"]] || "",
        quantity: cells[indexes.Quantity] || "",
        unitAmount: cells[indexes["Unit Amount"]] || "",
        accountCode: cells[indexes["Account Code"]] || "",
        taxType: cells[indexes["Tax Type"]] || "",
        taxAmount: cells[indexes["Tax Amount"]] || "",
        trackingName1: cells[indexes["Tracking Name 1"]] || "",
        trackingOption1: cells[indexes["Tracking Option 1"]] || "",
        trackingName2: cells[indexes["Tracking Name 2"]] || "",
        trackingOption2: cells[indexes["Tracking Option 2"]] || "",
        status: cells[indexes.Status] || "DRAFT"
      }));
      const validationErrors = parsedRows.flatMap(row => {
        const errors = [];
        if (!row.billNumber) errors.push(`Row ${row.rowNumber}: Bill Number is required.`);
        if (!row.contactName) errors.push(`Row ${row.rowNumber}: Contact Name is required.`);
        if (!row.billDate) errors.push(`Row ${row.rowNumber}: Bill Date is required.`);
        if (!row.dueDate) errors.push(`Row ${row.rowNumber}: Due Date is required.`);
        if (!row.description) errors.push(`Row ${row.rowNumber}: Line Description is required.`);
        if (!row.accountCode) errors.push(`Row ${row.rowNumber}: Account Code is required.`);
        const _billUa = String(row.unitAmount || "").trim();
        if (!_billUa || isNaN(Number(_billUa))) errors.push(`Row ${row.rowNumber}: Unit Amount is required and must be a number (e.g. 100.00).`);
        if (row.exchangeRate && Number.isNaN(Number(row.exchangeRate))) {
          errors.push(`Row ${row.rowNumber}: Exchange Rate must be numeric.`);
        }
        if (row.taxAmount && Number.isNaN(Number(row.taxAmount))) {
          errors.push(`Row ${row.rowNumber}: Tax Amount must be numeric.`);
        }
        return errors;
      });
      setBillsImportRows(parsedRows);
      setBillsImportErrors(validationErrors);
      setBillsImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated successfully. ${parsedRows.length} bill line row(s) ready for review.`);
    } catch (err) {
      setBillsImportErrors([err.message]);
      setBillsImportStatus(err.message);
    }
  };
  const loadTaxRates = async () => {
    if (!selectedTenant || !sessionId || !userToken) {
      setTaxRatesStatus("Connect to Xero and select an organisation to load tax rates.");
      return;
    }
    setTaxRatesLoading(true);
    setTaxRatesStatus("Loading tax rates from Xero...");
    try {
      const params = new URLSearchParams({
        tenantId: selectedTenant
      });
      const res = await fetch(`${API_BASE}/tax-rates?${params.toString()}`, {
        headers: authHeaders
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to load tax rates.");
      const activeRates = (data.taxRates || []).filter(rate => !rate.status || rate.status === "ACTIVE");
      setTaxRates(activeRates);
      setTaxRatesStatus(`${activeRates.length} active tax rate(s) loaded from Xero.`);
    } catch (err) {
      setTaxRates([]);
      setTaxRatesStatus(err.message);
    } finally {
      setTaxRatesLoading(false);
    }
  };
  const isNoTaxType = taxType => {
    const normalized = String(taxType || "").trim().toLowerCase().replace(/\s+/g, "");
    return normalized === "none" || normalized === "notax";
  };
  const formatTaxTypeDisplay = taxType => {
    const value = String(taxType || "").trim();
    if (!value || isNoTaxType(value)) return "-";
    return value;
  };
  const formatTaxPercent = percent => {
    if (!Number.isFinite(percent)) return "-";
    const trimmed = Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/\.?0+$/, "");
    return `${trimmed}%`;
  };
  const formatTaxAmount = value => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    const amount = Number(trimmed);
    return Number.isFinite(amount) ? amount.toFixed(2) : trimmed;
  };
  const getTaxRatePercent = taxType => {
    const normalized = String(taxType || "").trim().toLowerCase();
    if (!normalized) return null;
    if (isNoTaxType(normalized)) return 0;
    const match = taxRates.find(rate => String(rate.taxType || "").trim().toLowerCase() === normalized || String(rate.name || "").trim().toLowerCase() === normalized);
    if (!match) return null;
    const percent = Number(match.effectiveRate || match.displayTaxRate);
    return Number.isFinite(percent) ? percent : null;
  };
  const calculateBillTaxAmount = row => {
    const quantity = Number(row.quantity || 1);
    const unitAmount = Number(row.unitAmount || 0);
    const percent = getTaxRatePercent(row.taxType);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitAmount) || percent === null) {
      return "";
    }
    return (quantity * unitAmount * percent / 100).toFixed(2);
  };
  const getBillTaxRateLabel = row => {
    const taxType = String(row.taxType || "").trim();
    if (!taxType) return "-";
    const percent = getTaxRatePercent(taxType);
    if (percent === null) return taxRates.length ? "Not found" : "Load rates";
    return formatTaxPercent(percent);
  };
  const getBillTaxAmountDisplay = row => formatTaxAmount(row.taxAmount) || calculateBillTaxAmount(row) || "-";
  const startAccountsImport = async () => {
    if (!selectedTenant) {
      setAccountsImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!accountsImportRows.length || accountsImportErrors.length) {
      setAccountsImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setAccountsImportLoading(true);
    setAccountsImportStatus("Starting Chart of Accounts import...");
    try {
      const res = await fetch(`${API_BASE}/import/accounts/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: accountsImportFile?.name || "chart-of-accounts.csv",
          rows: accountsImportRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start accounts import.");
      setAccountsImportProgress(data);
      setAccountsImportJobId(data.jobId);
      setAccountsImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setAccountsImportStatus(err.message);
      setAccountsImportLoading(false);
    }
  };
  const startItemsImport = async () => {
    if (!selectedTenant) {
      setItemsImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!itemsImportRows.length || itemsImportErrors.length) {
      setItemsImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setItemsImportLoading(true);
    const CHUNK_SIZE = 5000;
    const totalRows = itemsImportRows.length;
    try {
      if (totalRows > CHUNK_SIZE) {
        // Large file: send in chunks to avoid browser crash
        const totalChunks = Math.ceil(totalRows / CHUNK_SIZE);
        setItemsImportStatus(`Uploading chunk 1/${totalChunks}...`);
        const firstChunk = itemsImportRows.slice(0, CHUNK_SIZE);
        const res1 = await fetch(`${API_BASE}/import/items/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
          body: JSON.stringify({ tenantId: selectedTenant, filename: itemsImportFile?.name || "items.csv", rows: firstChunk, chunkMode: true, totalRows })
        });
        const d1 = await res1.json().catch(() => ({}));
        if (!res1.ok) throw new Error(d1.error || "Failed to start items import.");
        const jobId = d1.jobId;
        for (let i = CHUNK_SIZE; i < totalRows; i += CHUNK_SIZE) {
          const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;
          setItemsImportStatus(`Uploading chunk ${chunkNum}/${totalChunks}...`);
          const chunk = itemsImportRows.slice(i, i + CHUNK_SIZE);
          const rChunk = await fetch(`${API_BASE}/import/items/append/${jobId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ rows: chunk })
          });
          if (!rChunk.ok) {
            const dc = await rChunk.json().catch(() => ({}));
            throw new Error(dc.error || "Failed to upload chunk.");
          }
        }
        setItemsImportStatus("Starting import processing...");
        const resFin = await fetch(`${API_BASE}/import/items/finalize/${jobId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
          body: JSON.stringify({ tenantId: selectedTenant })
        });
        const dFin = await resFin.json().catch(() => ({}));
        if (!resFin.ok) throw new Error(dFin.error || "Failed to finalize import.");
        setItemsImportProgress(dFin);
        setItemsImportJobId(dFin.jobId || jobId);
        setItemsImportStatus("Import started. Progress will update automatically.");
      } else {
        // Small file: single request
        const res = await fetch(`${API_BASE}/import/items/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
          body: JSON.stringify({ tenantId: selectedTenant, filename: itemsImportFile?.name || "items.csv", rows: itemsImportRows })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to start items import.");
        setItemsImportProgress(data);
        setItemsImportJobId(data.jobId);
        setItemsImportStatus("Import started. Progress will update automatically.");
      }
    } catch (err) {
      setItemsImportStatus(err.message);
      setItemsImportLoading(false);
    }
  };
  const startCustomersImport = async () => {
    if (!selectedTenant) {
      setCustomersImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!customersImportRows.length || customersImportErrors.length) {
      setCustomersImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setCustomersImportLoading(true);
    setCustomersImportStatus("Starting Customers import...");
    try {
      const res = await fetch(`${API_BASE}/import/customers/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: customersImportFile?.name || "customers.csv",
          rows: customersImportRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start customers import.");
      setCustomersImportProgress(data);
      setCustomersImportJobId(data.jobId);
      setCustomersImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setCustomersImportStatus(err.message);
      setCustomersImportLoading(false);
    }
  };
  const startVendorsImport = async () => {
    if (!selectedTenant) {
      setVendorsImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!vendorsImportRows.length || vendorsImportErrors.length) {
      setVendorsImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setVendorsImportLoading(true);
    setVendorsImportStatus("Starting Vendors import...");
    try {
      const res = await fetch(`${API_BASE}/import/vendors/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: vendorsImportFile?.name || "vendors.csv",
          rows: vendorsImportRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start vendors import.");
      setVendorsImportProgress(data);
      setVendorsImportJobId(data.jobId);
      setVendorsImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setVendorsImportStatus(err.message);
      setVendorsImportLoading(false);
    }
  };
  const startTrackingCatImport = async () => {
    if (!selectedTenant) {
      setTrackingCatImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!trackingCatImportRows.length || trackingCatImportErrors.length) {
      setTrackingCatImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setTrackingCatImportLoading(true);
    setTrackingCatImportStatus("Starting Tracking Categories import...");
    try {
      const res = await fetch(`${API_BASE}/import/tracking-categories/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: trackingCatImportFile?.name || "tracking-categories.csv",
          rows: trackingCatImportRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start tracking categories import.");
      setTrackingCatImportProgress(data);
      setTrackingCatImportJobId(data.jobId);
      setTrackingCatImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setTrackingCatImportStatus(err.message);
      setTrackingCatImportLoading(false);
    }
  };
  const autoEnsureContacts = async (contactNames) => {
    if (!autoCreateContacts || !contactNames.length || !selectedTenant) return;
    try {
      const res = await fetch(`${API_BASE}/contacts/ensure`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, names: [...new Set(contactNames.filter(Boolean))] })
      });
      const data = await res.json().catch(() => ({}));
      if (data.created?.length) toast.success(`Auto-created ${data.created.length} missing contact(s).`);
    } catch (_) {}
  };

  const startBillsImport = async () => {
    if (!selectedTenant) {
      setBillsImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!billsImportRows.length || billsImportErrors.length) {
      setBillsImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setBillsImportLoading(true);
    setBillsImportStatus("Starting Purchase Bills import...");
    if (autoCreateContacts) {
      setBillsImportStatus("Auto-creating missing contacts...");
      await autoEnsureContacts(billsImportRows.map(r => r.contactName));
    }
    try {
      const res = await fetch(`${API_BASE}/import/bills/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: billsImportFile?.name || "purchase-bills.csv",
          rows: billsImportRows,
          skipDuplicateCheck: docSkipDupCheck,
          updateMode: isUpdateCentrePage,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start bills import.");
      setBillsImportProgress(data);
      setBillsImportJobId(data.jobId);
      setBillsImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setBillsImportStatus(err.message);
      setBillsImportLoading(false);
    }
  };
  const handleCreditNotesImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setCreditNotesImportFile(file);
    setCreditNotesImportRows([]);
    setCreditNotesImportErrors([]);
    setCreditNotesImportProgress(null);
    setCreditNotesImportJobId("");
    if (!file) {
      setCreditNotesImportStatus("");
      return;
    }
    const expectedHeaders = ["Credit Note Number", "Contact Name", "Credit Note Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"];
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders,
        importTypeKey: "credit-notes"
      });
      const parsedRows = rows.map(({
        cells,
        indexes,
        rowNumber
      }) => ({
        rowNumber,
        creditNoteNumber: cells[indexes["Credit Note Number"]] || "",
        contactName: cells[indexes["Contact Name"]] || "",
        creditNoteDate: cells[indexes["Credit Note Date"]] || "",
        reference: cells[indexes.Reference] || "",
        currencyCode: cells[indexes["Currency Code"]] || "",
        exchangeRate: cells[indexes["Exchange Rate"]] || "",
        description: cells[indexes["Line Description"]] || "",
        quantity: cells[indexes.Quantity] || "",
        unitAmount: cells[indexes["Unit Amount"]] || "",
        accountCode: cells[indexes["Account Code"]] || "",
        taxType: cells[indexes["Tax Type"]] || "",
        taxAmount: cells[indexes["Tax Amount"]] || "",
        trackingName1: cells[indexes["Tracking Name 1"]] || "",
        trackingOption1: cells[indexes["Tracking Option 1"]] || "",
        trackingName2: cells[indexes["Tracking Name 2"]] || "",
        trackingOption2: cells[indexes["Tracking Option 2"]] || "",
        status: cells[indexes.Status] || "DRAFT"
      }));
      const validationErrors = parsedRows.flatMap(row => {
        const errs = [];
        if (!row.creditNoteNumber) errs.push(`Row ${row.rowNumber}: Credit Note Number is required.`);
        if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
        if (!row.creditNoteDate) errs.push(`Row ${row.rowNumber}: Credit Note Date is required.`);
        if (!row.description) errs.push(`Row ${row.rowNumber}: Line Description is required.`);
        if (!row.accountCode) errs.push(`Row ${row.rowNumber}: Account Code is required.`);
        const _cnUa = String(row.unitAmount || "").trim();
        if (!_cnUa || isNaN(Number(_cnUa))) errs.push(`Row ${row.rowNumber}: Unit Amount is required and must be a number (e.g. 100.00).`);
        if (row.exchangeRate && Number.isNaN(Number(row.exchangeRate))) errs.push(`Row ${row.rowNumber}: Exchange Rate must be numeric.`);
        if (row.taxAmount && Number.isNaN(Number(row.taxAmount))) errs.push(`Row ${row.rowNumber}: Tax Amount must be numeric.`);
        return errs;
      });
      setCreditNotesImportRows(parsedRows);
      setCreditNotesImportErrors(validationErrors);
      setCreditNotesImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated successfully. ${parsedRows.length} credit note line row(s) ready for review.`);
    } catch (err) {
      setCreditNotesImportErrors([err.message]);
      setCreditNotesImportStatus(err.message);
    }
  };
  const startCreditNotesImport = async () => {
    if (!selectedTenant) {
      setCreditNotesImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!creditNotesImportRows.length || creditNotesImportErrors.length) {
      setCreditNotesImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setCreditNotesImportLoading(true);
    setCreditNotesImportStatus("Starting Credit Notes import...");
    try {
      const res = await fetch(`${API_BASE}/import/credit-notes/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: creditNotesImportFile?.name || "credit-notes.csv",
          rows: creditNotesImportRows,
          updateMode: isUpdateCentrePage,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start credit notes import.");
      setCreditNotesImportProgress(data);
      setCreditNotesImportJobId(data.jobId);
      setCreditNotesImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setCreditNotesImportStatus(err.message);
      setCreditNotesImportLoading(false);
    }
  };
  const handleInvoicesImportFile = async event => {
    const file = event.target.files?.[0] || null;
    setInvoicesImportFile(file);
    setInvoicesImportRows([]);
    setInvoicesImportErrors([]);
    setInvoicesImportProgress(null);
    setInvoicesImportJobId("");
    if (!file) {
      setInvoicesImportStatus("");
      return;
    }
    const expectedHeaders = ["Invoice Number", "Contact Name", "Invoice Date", "Due Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Status"];
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders,
        importTypeKey: "invoices"
      });
      const parsedRows = rows.map(({
        cells,
        indexes,
        rowNumber
      }) => ({
        rowNumber,
        invoiceNumber: cells[indexes["Invoice Number"]] || "",
        contactName: cells[indexes["Contact Name"]] || "",
        invoiceDate: cells[indexes["Invoice Date"]] || "",
        dueDate: cells[indexes["Due Date"]] || "",
        reference: cells[indexes.Reference] || "",
        currencyCode: cells[indexes["Currency Code"]] || "",
        exchangeRate: cells[indexes["Exchange Rate"]] || "",
        description: cells[indexes["Line Description"]] || "",
        quantity: cells[indexes.Quantity] || "",
        unitAmount: cells[indexes["Unit Amount"]] || "",
        accountCode: cells[indexes["Account Code"]] || "",
        taxType: cells[indexes["Tax Type"]] || "",
        taxAmount: cells[indexes["Tax Amount"]] || "",
        trackingName1: cells[indexes["Tracking Name 1"]] || "",
        trackingOption1: cells[indexes["Tracking Option 1"]] || "",
        trackingName2: cells[indexes["Tracking Name 2"]] || "",
        trackingOption2: cells[indexes["Tracking Option 2"]] || "",
        status: cells[indexes.Status] || "DRAFT"
      }));
      const validationErrors = parsedRows.flatMap(row => {
        const errors = [];
        if (!row.invoiceNumber) errors.push(`Row ${row.rowNumber}: Invoice Number is required.`);
        if (!row.contactName) errors.push(`Row ${row.rowNumber}: Contact Name is required.`);
        if (!row.invoiceDate) errors.push(`Row ${row.rowNumber}: Invoice Date is required.`);
        if (!row.description) errors.push(`Row ${row.rowNumber}: Line Description is required.`);
        if (!row.accountCode) errors.push(`Row ${row.rowNumber}: Account Code is required.`);
        const _invUa = String(row.unitAmount || "").trim();
        if (!_invUa || isNaN(Number(_invUa))) errors.push(`Row ${row.rowNumber}: Unit Amount is required and must be a number (e.g. 100.00).`);
        if (row.exchangeRate && Number.isNaN(Number(row.exchangeRate))) errors.push(`Row ${row.rowNumber}: Exchange Rate must be numeric.`);
        if (row.taxAmount && Number.isNaN(Number(row.taxAmount))) errors.push(`Row ${row.rowNumber}: Tax Amount must be numeric.`);
        return errors;
      });
      setInvoicesImportRows(parsedRows);
      setInvoicesImportErrors(validationErrors);
      setInvoicesImportStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated successfully. ${parsedRows.length} line row(s) ready. Invoice or Credit Note will be auto-detected by total amount sign.`);
    } catch (err) {
      setInvoicesImportErrors([err.message]);
      setInvoicesImportStatus(err.message);
    }
  };
  const startInvoicesImport = async () => {
    if (!selectedTenant) {
      setInvoicesImportStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!invoicesImportRows.length || invoicesImportErrors.length) {
      setInvoicesImportStatus("Upload a valid CSV file before importing.");
      return;
    }
    setInvoicesImportLoading(true);
    setInvoicesImportStatus("Starting Sales Invoices import...");
    if (autoCreateContacts) {
      setInvoicesImportStatus("Auto-creating missing contacts...");
      await autoEnsureContacts(invoicesImportRows.map(r => r.contactName));
    }
    try {
      const res = await fetch(`${API_BASE}/import/invoices/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: invoicesImportFile?.name || "invoices.csv",
          rows: invoicesImportRows,
          skipDuplicateCheck: docSkipDupCheck,
          updateMode: isUpdateCentrePage,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start invoices import.");
      setInvoicesImportProgress(data);
      setInvoicesImportJobId(data.jobId);
      setInvoicesImportStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setInvoicesImportStatus(err.message);
      setInvoicesImportLoading(false);
    }
  };
  const paymentImportHeaders = ["Invoice Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"];
  const downloadBillPaymentTemplate = () => {
    downloadCsvFile("xero_bill_payment_import_template.csv", paymentImportHeaders, [
      ["BILL-001", "090", "2026-01-15", "1000.00", "Payment ref", "1"],
    ]);
  };
  const downloadInvoicePaymentTemplate = () => {
    downloadCsvFile("xero_invoice_payment_import_template.csv", paymentImportHeaders, [
      ["INV-001", "090", "2026-01-15", "1000.00", "Payment ref", "1"],
    ]);
  };
  const creditNoteRefundHeaders = ["Credit Note Number", "Bank Account Code", "Date", "Amount", "Reference", "Currency Rate"];
  const downloadCreditNoteRefundTemplate = () => {
    downloadCsvFile("xero_credit_note_refund_import_template.csv", creditNoteRefundHeaders, [
      ["CN-001", "090", "2026-01-15", "500.00", "Refund ref", "1"],
    ]);
  };
  const handleCreditNoteRefundFile = async (e) => {
    const file = e.target.files?.[0] || null;
    setCreditNoteRefundFile(file);
    setCreditNoteRefundRows([]);
    setCreditNoteRefundErrors([]);
    setCreditNoteRefundProgress(null);
    setCreditNoteRefundJobId("");
    if (!file) { setCreditNoteRefundStatus(""); return; }
    try {
      const rows = await readCsvByHeaders({ file, expectedHeaders: creditNoteRefundHeaders, importTypeKey: "credit-note-refunds" });
      const parsedRows = rows.map(({ cells, indexes, rowNumber }) => {
        const rawCN = String(cells[indexes["Credit Note Number"]] || "").trim();
        return {
          rowNumber,
          creditNoteNumber: /^\d+$/.test(rawCN) ? String(parseInt(rawCN, 10)) : rawCN,
          bankAccountCode: cells[indexes["Bank Account Code"]] || "",
          date: cells[indexes["Date"]] || "",
          amount: cells[indexes["Amount"]] || "",
          reference: cells[indexes["Reference"]] || "",
          currencyRate: cells[indexes["Currency Rate"]] || "",
        };
      });
      const validationErrors = parsedRows.flatMap(row => {
        const errs = [];
        if (!row.creditNoteNumber) errs.push(`Row ${row.rowNumber}: Credit Note Number is required.`);
        if (!row.bankAccountCode) errs.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
        if (!row.date) errs.push(`Row ${row.rowNumber}: Date is required.`);
        if (!row.amount || isNaN(Number(row.amount))) errs.push(`Row ${row.rowNumber}: Amount is required and must be a number.`);
        if (row.currencyRate && isNaN(Number(row.currencyRate))) errs.push(`Row ${row.rowNumber}: Currency Rate must be numeric.`);
        return errs;
      });
      setCreditNoteRefundRows(parsedRows);
      setCreditNoteRefundErrors(validationErrors);
      setCreditNoteRefundStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated. ${parsedRows.length} refund row(s) ready.`);
    } catch (err) {
      setCreditNoteRefundErrors([err.message]);
      setCreditNoteRefundStatus(err.message);
    }
  };
  const startCreditNoteRefundImport = () => startPaymentImport({
    endpoint: "credit-note-refunds",
    rows: creditNoteRefundRows,
    file: creditNoteRefundFile,
    label: "Credit Note Refund",
    errors: creditNoteRefundErrors,
    loading: creditNoteRefundLoading,
    setLoading: setCreditNoteRefundLoading,
    setStatus: setCreditNoteRefundStatus,
    setJobId: setCreditNoteRefundJobId,
    setProgress: setCreditNoteRefundProgress,
  });
  const handlePaymentImportFile = async (file, {
    setFile,
    setRows,
    setErrors,
    setStatus: setStatus2,
    setProgress,
    setJobId,
    label,
    importTypeKey: payImportTypeKey = ""
  }) => {
    setFile(file);
    setRows([]);
    setErrors([]);
    setProgress(null);
    setJobId("");
    if (!file) {
      setStatus2("");
      return;
    }
    try {
      const rows = await readCsvByHeaders({
        file,
        expectedHeaders: paymentImportHeaders,
        importTypeKey: payImportTypeKey
      });
      const parsedRows = rows.map(({
        cells,
        indexes,
        rowNumber
      }) => {
        const rawInv = String(cells[indexes["Invoice Number"]] || "").trim();
        return {
          rowNumber,
          invoiceNumber: /^\d+$/.test(rawInv) ? String(parseInt(rawInv, 10)) : rawInv,
          bankAccountCode: cells[indexes["Bank Account Code"]] || "",
          date: cells[indexes.Date] || "",
          amount: cells[indexes.Amount] || "",
          reference: cells[indexes.Reference] || "",
          currencyRate: cells[indexes["Currency Rate"]] || ""
        };
      });
      const validationErrors = parsedRows.flatMap(row => {
        const errs = [];
        if (!row.invoiceNumber) errs.push(`Row ${row.rowNumber}: Invoice Number is required.`);
        if (!row.bankAccountCode) errs.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
        if (!row.date) errs.push(`Row ${row.rowNumber}: Date is required.`);
        if (!row.amount || isNaN(Number(row.amount))) errs.push(`Row ${row.rowNumber}: Amount is required and must be a number.`);
        if (row.currencyRate && isNaN(Number(row.currencyRate))) errs.push(`Row ${row.rowNumber}: Currency Rate must be numeric.`);
        return errs;
      });
      setRows(parsedRows);
      setErrors(validationErrors);
      setStatus2(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated. ${parsedRows.length} payment row(s) ready.`);
    } catch (err) {
      setErrors([err.message]);
      setStatus2(err.message);
    }
  };
  const handleBillPaymentFile = e => handlePaymentImportFile(e.target.files?.[0] || null, {
    setFile: setBillPaymentFile,
    setRows: setBillPaymentRows,
    setErrors: setBillPaymentErrors,
    setStatus: setBillPaymentStatus,
    setProgress: setBillPaymentProgress,
    setJobId: setBillPaymentJobId,
    label: "Bill Payment",
    importTypeKey: "bill-payments"
  });
  const handleInvoicePaymentFile = e => handlePaymentImportFile(e.target.files?.[0] || null, {
    setFile: setInvoicePaymentFile,
    setRows: setInvoicePaymentRows,
    setErrors: setInvoicePaymentErrors,
    setStatus: setInvoicePaymentStatus,
    setProgress: setInvoicePaymentProgress,
    setJobId: setInvoicePaymentJobId,
    label: "Invoice Payment",
    importTypeKey: "invoice-payments"
  });
  const startPaymentImport = async ({
    endpoint,
    rows,
    file,
    label,
    loading,
    setLoading,
    setStatus: setStatus2,
    setJobId,
    setProgress,
    errors
  }) => {
    if (loading) return;
    if (!selectedTenant) {
      setStatus2("Select a Xero organisation before importing.");
      return;
    }
    if (!rows.length || errors.length) {
      setStatus2("Upload a valid CSV file before importing.");
      return;
    }
    setLoading(true);
    setStatus2(`Starting ${label} import...`);
    try {
      const res = await fetch(`${API_BASE}/import/${endpoint}/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: file?.name || `${endpoint}.csv`,
          rows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Failed to start ${label} import.`);
      setProgress(data);
      setJobId(data.jobId);
      setStatus2("Import started. Progress will update automatically.");
    } catch (err) {
      setStatus2(err.message);
      setLoading(false);
    }
  };
  const startBillPaymentImport = () => startPaymentImport({
    endpoint: "bill-payments",
    rows: billPaymentRows,
    file: billPaymentFile,
    label: "Bill Payment",
    errors: billPaymentErrors,
    loading: billPaymentLoading,
    setLoading: setBillPaymentLoading,
    setStatus: setBillPaymentStatus,
    setJobId: setBillPaymentJobId,
    setProgress: setBillPaymentProgress
  });
  const startInvoicePaymentImport = () => startPaymentImport({
    endpoint: "invoice-payments",
    rows: invoicePaymentRows,
    file: invoicePaymentFile,
    label: "Invoice Payment",
    errors: invoicePaymentErrors,
    loading: invoicePaymentLoading,
    setLoading: setInvoicePaymentLoading,
    setStatus: setInvoicePaymentStatus,
    setJobId: setInvoicePaymentJobId,
    setProgress: setInvoicePaymentProgress
  });
  const manualJournalImportHeaders = ["Journal Reference", "Date", "Account Code", "Line Description", "Tax Type"];
  const validateManualJournals = (journals) => journals.flatMap(journal => {
    const errs = [];
    const ref = journal.reference || `Row ${journal.rowNumber}`;
    if (!journal.reference) errs.push(`Row ${journal.rowNumber}: Journal Reference is required.`);
    if (!journal.date) errs.push(`Journal "${ref}": Date is required. Use YYYY-MM-DD format (e.g. 2026-04-08).`);
    if (journal.lines.length < 2) errs.push(`Journal "${ref}": At least 2 lines required.`);
    const totalDebit = journal.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
    const totalCredit = journal.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) errs.push(`Journal "${ref}": Not balanced — Debit ${totalDebit.toFixed(2)} ≠ Credit ${totalCredit.toFixed(2)}.`);
    journal.lines.forEach((line, i) => {
      if (!line.accountCode) errs.push(`Journal "${ref}", line ${i + 1}: Account Code is required.`);
    });
    return errs;
  });
  const convertManualJournalDatesToDDMM = () => {
    const swapDate = d => {
      const m = String(d || "").trim().match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})$/);
      if (!m) return d;
      return `${m[2]}/${m[1]}/${m[3]}`;
    };
    const converted = manualJournalRows.map(j => ({ ...j, date: swapDate(j.date) }));
    const errs = validateManualJournals(converted);
    setManualJournalRows(converted);
    setManualJournalErrors(errs);
    setManualJournalStatus(errs.length
      ? `Dates converted to DD/MM/YYYY. ${errs.length} issue(s) remaining.`
      : `Dates converted to DD/MM/YYYY. ${converted.length} journal(s) ready to import.`
    );
  };
  const downloadImportErrors = (errors, typeKey) => {
    if (!errors?.length) return;
    const lines = ["Error"].concat(errors.map(e => `"${String(e).replace(/"/g, '""')}"`));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${typeKey || "import"}_validation_errors.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const revalidateImportRows = (type, rows) => {
    const errs = [];
    rows.forEach(row => {
      const r = row.rowNumber;
      if (type === "accounts") {
        if (!row.code) errs.push(`Row ${r}: Code is required.`);
        if (!row.name) errs.push(`Row ${r}: Name is required.`);
        if (!row.type) errs.push(`Row ${r}: Type is required.`);
      } else if (type === "items") {
        if (!row.code) errs.push(`Row ${r}: Code is required.`);
        if (!row.name) errs.push(`Row ${r}: Name is required.`);
      } else if (type === "customers" || type === "vendors") {
        if (!row.name) errs.push(`Row ${r}: Name is required.`);
      } else if (type === "bills") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.invoiceDate) errs.push(`Row ${r}: Date is required.`);
        if (!row.dueDate) errs.push(`Row ${r}: Due Date is required.`);
        if (!row.description) errs.push(`Row ${r}: Description is required.`);
        const _ua = String(row.unitAmount ?? "").trim();
        if (!_ua || isNaN(Number(_ua))) errs.push(`Row ${r}: Unit Amount is required and must be a number (e.g. 100.00).`);
      } else if (type === "invoices") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.invoiceDate) errs.push(`Row ${r}: Date is required.`);
        if (!row.dueDate) errs.push(`Row ${r}: Due Date is required.`);
        if (!row.description) errs.push(`Row ${r}: Description is required.`);
        const _ua = String(row.unitAmount ?? "").trim();
        if (!_ua || isNaN(Number(_ua))) errs.push(`Row ${r}: Unit Amount is required and must be a number (e.g. 100.00).`);
      } else if (type === "credit-notes") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
        const _ua = String(row.unitAmount ?? "").trim();
        if (!_ua || isNaN(Number(_ua))) errs.push(`Row ${r}: Unit Amount is required and must be a number (e.g. 100.00).`);
      } else if (type === "spend-money" || type === "receive-money") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
        if (!row.accountCode) errs.push(`Row ${r}: Account Code is required.`);
      } else if (type === "purchase-orders") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
      } else if (type === "quotes") {
        if (!row.contactName) errs.push(`Row ${r}: Contact Name is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
      } else if (type === "bill-payments") {
        if (!row.invoiceNumber) errs.push(`Row ${r}: Invoice/Bill Number is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
        if (row.amount === undefined || row.amount === null || row.amount === "") errs.push(`Row ${r}: Amount is required.`);
      } else if (type === "invoice-payments") {
        if (!row.invoiceNumber) errs.push(`Row ${r}: Invoice Number is required.`);
        if (!row.date) errs.push(`Row ${r}: Date is required.`);
        if (row.amount === undefined || row.amount === null || row.amount === "") errs.push(`Row ${r}: Amount is required.`);
      } else if (type === "tracking-categories") {
        if (!row.categoryName) errs.push(`Row ${r}: Category Name is required.`);
        if (!row.optionName) errs.push(`Row ${r}: Option Name is required.`);
      }
    });
    return errs;
  };
  const handleInlineEditApply = () => {
    const rowsMap = {
      bills: billsImportRows, invoices: invoicesImportRows, "credit-notes": creditNotesImportRows,
      "manual-journals": manualJournalRows, "spend-money": spendMoneyRows, "receive-money": receiveMoneyRows,
      "bank-transfers": bankTransferRows, "purchase-orders": poImportRows, quotes: quotesImportRows,
      "bill-payments": billPaymentRows, "invoice-payments": invoicePaymentRows, "credit-note-refunds": creditNoteRefundRows,
      items: itemsImportRows, customers: customersImportRows, vendors: vendorsImportRows,
      accounts: accountsImportRows, "tracking-categories": trackingCatImportRows,
      "spend-op": spendOpRows, "receive-op": receiveOpRows,
      "cn-allocation": cnAllocRows, "dn-allocation": dnAllocRows,
      "spend-allocation": spendAllocRows, "receive-allocation": receiveAllocRows,
      "update-status": updateStatusRows, "exchange-rate-update": exchangeRateUpdateRows,
    };
    const setterMap = {
      bills: { setRows: setBillsImportRows, setErrors: setBillsImportErrors, setStatus: setBillsImportStatus },
      invoices: { setRows: setInvoicesImportRows, setErrors: setInvoicesImportErrors, setStatus: setInvoicesImportStatus },
      "credit-notes": { setRows: setCreditNotesImportRows, setErrors: setCreditNotesImportErrors, setStatus: setCreditNotesImportStatus },
      "manual-journals": { setRows: setManualJournalRows, setErrors: setManualJournalErrors, setStatus: setManualJournalStatus },
      "spend-money": { setRows: setSpendMoneyRows, setErrors: setSpendMoneyErrors, setStatus: setSpendMoneyStatus },
      "receive-money": { setRows: setReceiveMoneyRows, setErrors: setReceiveMoneyErrors, setStatus: setReceiveMoneyStatus },
      "bank-transfers": { setRows: setBankTransferRows, setErrors: setBankTransferErrors, setStatus: setBankTransferStatus },
      "purchase-orders": { setRows: setPoImportRows, setErrors: setPoImportErrors, setStatus: setPoImportStatus },
      quotes: { setRows: setQuotesImportRows, setErrors: setQuotesImportErrors, setStatus: setQuotesImportStatus },
      "bill-payments": { setRows: setBillPaymentRows, setErrors: setBillPaymentErrors, setStatus: setBillPaymentStatus },
      "invoice-payments": { setRows: setInvoicePaymentRows, setErrors: setInvoicePaymentErrors, setStatus: setInvoicePaymentStatus },
      "credit-note-refunds": { setRows: setCreditNoteRefundRows, setErrors: setCreditNoteRefundErrors, setStatus: setCreditNoteRefundStatus },
      items: { setRows: setItemsImportRows, setErrors: setItemsImportErrors, setStatus: setItemsImportStatus },
      customers: { setRows: setCustomersImportRows, setErrors: setCustomersImportErrors, setStatus: setCustomersImportStatus },
      vendors: { setRows: setVendorsImportRows, setErrors: setVendorsImportErrors, setStatus: setVendorsImportStatus },
      accounts: { setRows: setAccountsImportRows, setErrors: setAccountsImportErrors, setStatus: setAccountsImportStatus },
      "tracking-categories": { setRows: setTrackingCatImportRows, setErrors: setTrackingCatImportErrors, setStatus: setTrackingCatImportStatus },
      "spend-op": { setRows: setSpendOpRows, setErrors: setSpendOpErrors, setStatus: setSpendOpStatus },
      "receive-op": { setRows: setReceiveOpRows, setErrors: setReceiveOpErrors, setStatus: setReceiveOpStatus },
      "cn-allocation": { setRows: setCnAllocRows, setErrors: setCnAllocErrors, setStatus: setCnAllocStatus },
      "dn-allocation": { setRows: setDnAllocRows, setErrors: setDnAllocErrors, setStatus: setDnAllocStatus },
      "spend-allocation": { setRows: setSpendAllocRows, setErrors: setSpendAllocErrors, setStatus: setSpendAllocStatus },
      "receive-allocation": { setRows: setReceiveAllocRows, setErrors: setReceiveAllocErrors, setStatus: setReceiveAllocStatus },
      "update-status": { setRows: setUpdateStatusRows, setErrors: setUpdateStatusErrors, setStatus: setUpdateStatusStatus },
      "exchange-rate-update": { setRows: setExchangeRateUpdateRows, setErrors: setExchangeRateUpdateErrors, setStatus: setExchangeRateUpdateStatus },
    };
    const currentRows = rowsMap[selectedImportType];
    const setters = setterMap[selectedImportType];
    if (!currentRows || !setters) { toast.error("Inline edit not supported for this import type."); return; }
    if (!Object.keys(inlineEditDraft).length) { toast.info("No changes made."); return; }
    const updated = currentRows.map(row => {
      const overrides = inlineEditDraft[row.rowNumber];
      return overrides ? { ...row, ...overrides } : row;
    });
    const newErrors = revalidateImportRows(selectedImportType, updated);
    setters.setRows(updated);
    setters.setErrors(newErrors);
    setters.setStatus(newErrors.length
      ? `${newErrors.length} issue(s) remaining after inline edit.`
      : `All errors fixed. ${updated.length} row(s) ready to import.`
    );
    setInlineEditDraft({});
    if (newErrors.length === 0) { setInlineEditMode(false); toast.success("All errors fixed — ready to import!"); }
    else toast.info(`${newErrors.length} issue(s) still remaining.`);
  };
  const downloadPartialSkippedRows = () => {
    if (!partialSkippedRows.length) return;
    const dataKeys = Object.keys(partialSkippedRows[0]).filter(k => k !== "_error" && k !== "rowNumber");
    const headers = ["Row Number", ...dataKeys, "Error"];
    const escape = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const lines = [headers.join(",")].concat(
      partialSkippedRows.map(r => [r.rowNumber, ...dataKeys.map(k => escape(r[k])), escape(r._error)].join(","))
    );
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selectedImportType || "import"}_skipped_rows.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleAutoFix = () => {
    const rowsMap = {
      bills: billsImportRows, invoices: invoicesImportRows, "credit-notes": creditNotesImportRows,
      "manual-journals": manualJournalRows, "spend-money": spendMoneyRows, "receive-money": receiveMoneyRows,
      "bank-transfers": bankTransferRows, "purchase-orders": poImportRows, quotes: quotesImportRows,
      "bill-payments": billPaymentRows, "invoice-payments": invoicePaymentRows, "credit-note-refunds": creditNoteRefundRows,
      items: itemsImportRows, customers: customersImportRows, vendors: vendorsImportRows,
      accounts: accountsImportRows, "tracking-categories": trackingCatImportRows,
      "spend-op": spendOpRows, "receive-op": receiveOpRows,
      "cn-allocation": cnAllocRows, "dn-allocation": dnAllocRows,
      "spend-allocation": spendAllocRows, "receive-allocation": receiveAllocRows,
      "update-status": updateStatusRows, "exchange-rate-update": exchangeRateUpdateRows,
    };
    const setterMap = {
      bills: { setRows: setBillsImportRows, setErrors: setBillsImportErrors, setStatus: setBillsImportStatus },
      invoices: { setRows: setInvoicesImportRows, setErrors: setInvoicesImportErrors, setStatus: setInvoicesImportStatus },
      "credit-notes": { setRows: setCreditNotesImportRows, setErrors: setCreditNotesImportErrors, setStatus: setCreditNotesImportStatus },
      "manual-journals": { setRows: setManualJournalRows, setErrors: setManualJournalErrors, setStatus: setManualJournalStatus },
      "spend-money": { setRows: setSpendMoneyRows, setErrors: setSpendMoneyErrors, setStatus: setSpendMoneyStatus },
      "receive-money": { setRows: setReceiveMoneyRows, setErrors: setReceiveMoneyErrors, setStatus: setReceiveMoneyStatus },
      "bank-transfers": { setRows: setBankTransferRows, setErrors: setBankTransferErrors, setStatus: setBankTransferStatus },
      "purchase-orders": { setRows: setPoImportRows, setErrors: setPoImportErrors, setStatus: setPoImportStatus },
      quotes: { setRows: setQuotesImportRows, setErrors: setQuotesImportErrors, setStatus: setQuotesImportStatus },
      "bill-payments": { setRows: setBillPaymentRows, setErrors: setBillPaymentErrors, setStatus: setBillPaymentStatus },
      "invoice-payments": { setRows: setInvoicePaymentRows, setErrors: setInvoicePaymentErrors, setStatus: setInvoicePaymentStatus },
      "credit-note-refunds": { setRows: setCreditNoteRefundRows, setErrors: setCreditNoteRefundErrors, setStatus: setCreditNoteRefundStatus },
      items: { setRows: setItemsImportRows, setErrors: setItemsImportErrors, setStatus: setItemsImportStatus },
      customers: { setRows: setCustomersImportRows, setErrors: setCustomersImportErrors, setStatus: setCustomersImportStatus },
      vendors: { setRows: setVendorsImportRows, setErrors: setVendorsImportErrors, setStatus: setVendorsImportStatus },
      accounts: { setRows: setAccountsImportRows, setErrors: setAccountsImportErrors, setStatus: setAccountsImportStatus },
      "tracking-categories": { setRows: setTrackingCatImportRows, setErrors: setTrackingCatImportErrors, setStatus: setTrackingCatImportStatus },
      "spend-op": { setRows: setSpendOpRows, setErrors: setSpendOpErrors, setStatus: setSpendOpStatus },
      "receive-op": { setRows: setReceiveOpRows, setErrors: setReceiveOpErrors, setStatus: setReceiveOpStatus },
      "cn-allocation": { setRows: setCnAllocRows, setErrors: setCnAllocErrors, setStatus: setCnAllocStatus },
      "dn-allocation": { setRows: setDnAllocRows, setErrors: setDnAllocErrors, setStatus: setDnAllocStatus },
      "spend-allocation": { setRows: setSpendAllocRows, setErrors: setSpendAllocErrors, setStatus: setSpendAllocStatus },
      "receive-allocation": { setRows: setReceiveAllocRows, setErrors: setReceiveAllocErrors, setStatus: setReceiveAllocStatus },
      "update-status": { setRows: setUpdateStatusRows, setErrors: setUpdateStatusErrors, setStatus: setUpdateStatusStatus },
      "exchange-rate-update": { setRows: setExchangeRateUpdateRows, setErrors: setExchangeRateUpdateErrors, setStatus: setExchangeRateUpdateStatus },
    };
    const rows = rowsMap[selectedImportType];
    const setters = setterMap[selectedImportType];
    if (!rows?.length) { toast.error("No data loaded — upload a CSV first."); return; }
    if (!setters) { toast.error("Auto-fix not supported for this import type."); return; }
    let fixCount = 0;
    const amountKeys = new Set(["debit", "credit"]);
    const fixedRows = rows.map(row => {
      const fixed = { ...row };
      for (const [key, val] of Object.entries(row)) {
        if (typeof val !== "string") continue;
        let v = val;
        const trimmed = v.trim();
        if (trimmed !== v) { fixCount++; v = trimmed; }
        const k = key.toLowerCase();
        if (amountKeys.has(k) || k.includes("amount") || k.includes("price") || k.includes("subtotal") || k.includes("total")) {
          const cleaned = v.replace(/[₹$£€¥₩,]/g, "").trim();
          if (cleaned !== v) { fixCount++; v = cleaned; }
        }
        fixed[key] = v;
      }
      return fixed;
    });
    const revalidated = revalidateImportRows(selectedImportType, fixedRows);
    setters.setRows(fixedRows);
    setters.setErrors(revalidated);
    const recCount = fixedRows.length.toLocaleString();
    if (fixCount === 0) {
      setters.setStatus(`✨ Auto-fix complete — ${recCount} record(s) checked. No changes needed (data was already clean).`);
      toast.success(`Auto-fix complete — ${recCount} records checked, nothing to clean`);
    } else if (revalidated.length === 0) {
      setters.setStatus(`✨ Auto-fix complete — ${fixCount} field(s) cleaned. All ${recCount} rows now valid — ready to import!`);
      toast.success(`Auto-fix complete — ${fixCount} field(s) cleaned, all rows valid`);
    } else {
      setters.setStatus(`✨ Auto-fix cleaned ${fixCount} field(s) — ${revalidated.length} issue(s) still remaining. Use Fix Inline to resolve manually.`);
      toast.info(`Auto-fix: ${fixCount} field(s) cleaned, ${revalidated.length} issue(s) remain`);
    }
  };
  const handlePartialImport = () => {
    const rowsMap = {
      bills: billsImportRows, invoices: invoicesImportRows, "credit-notes": creditNotesImportRows,
      "manual-journals": manualJournalRows, "spend-money": spendMoneyRows, "receive-money": receiveMoneyRows,
      "bank-transfers": bankTransferRows, "purchase-orders": poImportRows, quotes: quotesImportRows,
      "bill-payments": billPaymentRows, "invoice-payments": invoicePaymentRows, "credit-note-refunds": creditNoteRefundRows,
      items: itemsImportRows, customers: customersImportRows, vendors: vendorsImportRows,
      accounts: accountsImportRows, "tracking-categories": trackingCatImportRows,
      "spend-op": spendOpRows, "receive-op": receiveOpRows,
      "cn-allocation": cnAllocRows, "dn-allocation": dnAllocRows,
      "spend-allocation": spendAllocRows, "receive-allocation": receiveAllocRows,
      "update-status": updateStatusRows, "exchange-rate-update": exchangeRateUpdateRows,
    };
    const setterMap = {
      bills: { setRows: setBillsImportRows, setErrors: setBillsImportErrors, setStatus: setBillsImportStatus },
      invoices: { setRows: setInvoicesImportRows, setErrors: setInvoicesImportErrors, setStatus: setInvoicesImportStatus },
      "credit-notes": { setRows: setCreditNotesImportRows, setErrors: setCreditNotesImportErrors, setStatus: setCreditNotesImportStatus },
      "manual-journals": { setRows: setManualJournalRows, setErrors: setManualJournalErrors, setStatus: setManualJournalStatus },
      "spend-money": { setRows: setSpendMoneyRows, setErrors: setSpendMoneyErrors, setStatus: setSpendMoneyStatus },
      "receive-money": { setRows: setReceiveMoneyRows, setErrors: setReceiveMoneyErrors, setStatus: setReceiveMoneyStatus },
      "bank-transfers": { setRows: setBankTransferRows, setErrors: setBankTransferErrors, setStatus: setBankTransferStatus },
      "purchase-orders": { setRows: setPoImportRows, setErrors: setPoImportErrors, setStatus: setPoImportStatus },
      quotes: { setRows: setQuotesImportRows, setErrors: setQuotesImportErrors, setStatus: setQuotesImportStatus },
      "bill-payments": { setRows: setBillPaymentRows, setErrors: setBillPaymentErrors, setStatus: setBillPaymentStatus },
      "invoice-payments": { setRows: setInvoicePaymentRows, setErrors: setInvoicePaymentErrors, setStatus: setInvoicePaymentStatus },
      "credit-note-refunds": { setRows: setCreditNoteRefundRows, setErrors: setCreditNoteRefundErrors, setStatus: setCreditNoteRefundStatus },
      items: { setRows: setItemsImportRows, setErrors: setItemsImportErrors, setStatus: setItemsImportStatus },
      customers: { setRows: setCustomersImportRows, setErrors: setCustomersImportErrors, setStatus: setCustomersImportStatus },
      vendors: { setRows: setVendorsImportRows, setErrors: setVendorsImportErrors, setStatus: setVendorsImportStatus },
      accounts: { setRows: setAccountsImportRows, setErrors: setAccountsImportErrors, setStatus: setAccountsImportStatus },
      "tracking-categories": { setRows: setTrackingCatImportRows, setErrors: setTrackingCatImportErrors, setStatus: setTrackingCatImportStatus },
      "spend-op": { setRows: setSpendOpRows, setErrors: setSpendOpErrors, setStatus: setSpendOpStatus },
      "receive-op": { setRows: setReceiveOpRows, setErrors: setReceiveOpErrors, setStatus: setReceiveOpStatus },
      "cn-allocation": { setRows: setCnAllocRows, setErrors: setCnAllocErrors, setStatus: setCnAllocStatus },
      "dn-allocation": { setRows: setDnAllocRows, setErrors: setDnAllocErrors, setStatus: setDnAllocStatus },
      "spend-allocation": { setRows: setSpendAllocRows, setErrors: setSpendAllocErrors, setStatus: setSpendAllocStatus },
      "receive-allocation": { setRows: setReceiveAllocRows, setErrors: setReceiveAllocErrors, setStatus: setReceiveAllocStatus },
      "update-status": { setRows: setUpdateStatusRows, setErrors: setUpdateStatusErrors, setStatus: setUpdateStatusStatus },
      "exchange-rate-update": { setRows: setExchangeRateUpdateRows, setErrors: setExchangeRateUpdateErrors, setStatus: setExchangeRateUpdateStatus },
    };
    const rows = rowsMap[selectedImportType];
    const errors = active?.errors || [];
    const setters = setterMap[selectedImportType];
    if (!rows?.length) { toast.error("No data loaded — upload a CSV first."); return; }
    if (!errors.length) { toast.info("No errors found — all rows are already valid."); return; }
    // Parse row numbers from errors like "Row 5: ..." or "Row 12: ..."
    const errorRowNums = new Set();
    errors.forEach(e => {
      const m = String(e).match(/^Row\s+(\d+):/i);
      if (m) errorRowNums.add(Number(m[1]));
    });
    if (errorRowNums.size === 0) {
      toast.warning("Cannot determine which rows have errors from error messages. Fix errors manually or use Auto-Fix.");
      return;
    }
    const validRows = rows.filter(r => !errorRowNums.has(r.rowNumber));
    const skippedCount = rows.length - validRows.length;
    if (!validRows.length) {
      toast.error("All rows have errors — nothing valid to import.");
      return;
    }
    const errorByRow = {};
    errors.forEach(e => { const m = String(e).match(/^Row\s+(\d+):\s*(.*)/i); if (m) errorByRow[Number(m[1])] = m[2]; });
    const skippedWithErrors = rows.filter(r => errorRowNums.has(r.rowNumber)).map(r => ({ ...r, _error: errorByRow[r.rowNumber] || "Validation error" }));
    setPartialSkippedRows(skippedWithErrors);
    setters.setRows(validRows);
    setters.setErrors([]);
    setters.setStatus(`✂️ Partial import ready — ${validRows.length.toLocaleString()} valid row(s) kept, ${skippedCount} skipped. Click "Import to Xero" to proceed.`);
    toast.success(`${validRows.length.toLocaleString()} valid rows kept — ${skippedCount} skipped. Now click Import to Xero.`);
  };

  const handleClearInterruptedJob = (importType) => {
    const progressSetterMap = {
      bills: [setBillsImportProgress, setBillsImportJobId, "kk_billsJobId"],
      invoices: [setInvoicesImportProgress, setInvoicesImportJobId, "kk_invoicesJobId"],
      "credit-notes": [setCreditNotesImportProgress, setCreditNotesImportJobId, "kk_creditNotesJobId"],
      "manual-journals": [setManualJournalProgress, setManualJournalJobId, "kk_manualJournalJobId"],
      "spend-money": [setSpendMoneyProgress, setSpendMoneyJobId, "kk_spendMoneyJobId"],
      "receive-money": [setReceiveMoneyProgress, setReceiveMoneyJobId, "kk_receiveMoneyJobId"],
      "bank-transfers": [setBankTransferProgress, setBankTransferJobId, ""],
      "purchase-orders": [setPoImportProgress, setPoImportJobId, ""],
      quotes: [setQuotesImportProgress, setQuotesImportJobId, ""],
      "bill-payments": [setBillPaymentProgress, setBillPaymentJobId, "kk_billPaymentJobId"],
      "invoice-payments": [setInvoicePaymentProgress, setInvoicePaymentJobId, "kk_invoicePaymentJobId"],
      "credit-note-refunds": [setCreditNoteRefundProgress, setCreditNoteRefundJobId, "kk_creditNoteRefundJobId"],
      accounts: [setAccountsImportProgress, setAccountsImportJobId, "kk_accountsJobId"],
      items: [setItemsImportProgress, setItemsImportJobId, "kk_itemsJobId"],
      customers: [setCustomersImportProgress, setCustomersImportJobId, "kk_customersJobId"],
      vendors: [setVendorsImportProgress, setVendorsImportJobId, "kk_vendorsJobId"],
      "tracking-categories": [setTrackingCatImportProgress, setTrackingCatImportJobId, "kk_trackingCatJobId"],
    };
    const setters = progressSetterMap[importType];
    if (setters) {
      const [setProgress, setJobId, lsKey] = setters;
      setProgress(null);
      setJobId("");
      if (lsKey) localStorage.removeItem(lsKey);
      toast.info("Job cleared. Upload your file again to re-import.");
    }
  };

  const handlePreValidate = async (checkType) => {
    if (!selectedTenant) { toast.error("Select a Xero organisation first."); return; }
    setPreCheckLoading(true);
    setPreCheckResult(null);
    try {
      if (checkType === "invoices") {
        // For invoice-payments and bill-payments: check invoice numbers exist
        const rows = active?.rows || [];
        const invoiceNumbers = [...new Set(rows.map(r => String(r.invoiceNumber || "").trim()).filter(Boolean))];
        if (!invoiceNumbers.length) { toast.error("No invoice numbers found in loaded rows."); setPreCheckLoading(false); return; }
        const statuses = selectedImportType === "bill-payments" ? "AUTHORISED,PARTIAL" : "AUTHORISED,PARTIAL";
        const res = await fetch(`${API_BASE}/precheck/invoices`, {
          method: "POST", headers: { "Content-Type": "application/json", ...importHeaders },
          body: JSON.stringify({ tenantId: selectedTenant, sessionId, invoiceNumbers, statuses })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Pre-check failed");
        setPreCheckResult({ type: "invoices", label: "Invoice Numbers", ...data });
        setPreCheckModal(true);
      } else if (checkType === "contacts") {
        const rows = active?.rows || [];
        const contactNames = [...new Set(rows.map(r => String(r.contactName || "").trim()).filter(Boolean))];
        if (!contactNames.length) { toast.error("No contact names found in loaded rows."); setPreCheckLoading(false); return; }
        if (contactNames.length > 50) { toast.error("Too many unique contacts (max 50 for pre-check). Try a smaller file or filter duplicates first."); setPreCheckLoading(false); return; }
        const accountCodeFields = ["accountCode", "code", "purchaseAccountCode", "salesAccountCode", "accountCode2"];
        const accountCodes = [...new Set(rows.flatMap(r => accountCodeFields.map(f => String(r[f] || "").trim())).filter(Boolean))].slice(0, 50);
        const res = await fetch(`${API_BASE}/xero/prevalidate`, {
          method: "POST", headers: { "Content-Type": "application/json", ...importHeaders },
          body: JSON.stringify({ tenantId: selectedTenant, sessionId, contactNames, accountCodes })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Pre-check failed");
        setPreCheckResult({ type: "combined", contacts: data.contacts, accounts: data.accounts });
        setPreCheckModal(true);
      }
    } catch (err) {
      toast.error(`Pre-check failed: ${err.message}`);
    } finally {
      setPreCheckLoading(false);
    }
  };

  const handleManualJournalFile = async e => {
    const file = e.target.files?.[0] || null;
    setManualJournalFile(file);
    setManualJournalRows([]);
    setManualJournalErrors([]);
    setManualJournalProgress(null);
    setManualJournalJobId("");
    if (!file) {
      setManualJournalStatus("");
      return;
    }
    try {
      const csvRows = await readCsvByHeaders({
        file,
        expectedHeaders: manualJournalImportHeaders,
        optionalHeaders: ["Narration", "Amount", "Debit", "Credit", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2", "Tracking Name", "Tracking Option"],
        importTypeKey: "manual-journals"
      });
      const parsedLines = csvRows.map(({
        cells,
        indexes,
        rowNumber
      }) => {
        let debit = "";
        let credit = "";
        const amtRaw = cells[indexes.Amount];
        const amt = Number(amtRaw);
        if (amtRaw && Number.isFinite(amt) && amt !== 0) {
          if (amt > 0) debit = String(amt); else credit = String(Math.abs(amt));
        } else {
          debit = cells[indexes.Debit] || "";
          credit = cells[indexes.Credit] || "";
        }
        const trackingName1 = cells[indexes["Tracking Name 1"]] || cells[indexes["Tracking Name"]] || "";
        const trackingOption1 = cells[indexes["Tracking Option 1"]] || cells[indexes["Tracking Option"]] || "";
        return {
          rowNumber,
          reference: cells[indexes["Journal Reference"]] || "",
          date: cells[indexes.Date] || "",
          narration: cells[indexes.Narration] || "",
          accountCode: cells[indexes["Account Code"]] || "",
          description: cells[indexes["Line Description"]] || "",
          debit,
          credit,
          taxType: cells[indexes["Tax Type"]] || "",
          trackingName1,
          trackingOption1,
          trackingName2: cells[indexes["Tracking Name 2"]] || "",
          trackingOption2: cells[indexes["Tracking Option 2"]] || ""
        };
      });
      const journalMap = new Map();
      parsedLines.forEach(line => {
        const key = line.reference || `row_${line.rowNumber}`;
        if (!journalMap.has(key)) {
          journalMap.set(key, {
            rowNumber: line.rowNumber,
            reference: line.reference,
            date: line.date,
            narration: line.narration,
            lines: []
          });
        }
        journalMap.get(key).lines.push({
          accountCode: line.accountCode,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          taxType: line.taxType,
          trackingName1: line.trackingName1,
          trackingOption1: line.trackingOption1,
          trackingName2: line.trackingName2,
          trackingOption2: line.trackingOption2
        });
      });
      const journals = Array.from(journalMap.values());
      const validationErrors = validateManualJournals(journals);
      setManualJournalRows(journals);
      setManualJournalErrors(validationErrors);
      setManualJournalStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation issue(s).` : `${file.name} validated. ${journals.length} journal(s) ready.`);
    } catch (err) {
      setManualJournalErrors([err.message]);
      setManualJournalStatus(err.message);
    }
  };
  const startJournalFix = async () => {
    if (!selectedTenant) return;
    if (!journalFixDateFrom || !journalFixDateTo) { setJournalFixResult({ error: "Date range required." }); return; }
    setJournalFixLoading(true);
    setJournalFixResult({ status: "running", message: "Starting..." });
    try {
      const res = await fetch("/api/import/manual-journals/fix-dates", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": token, "x-tenant-id": selectedTenant, "x-session-id": sessionId },
        body: JSON.stringify({ tenantId: selectedTenant, sessionId, dateFrom: journalFixDateFrom, dateTo: journalFixDateTo, shiftDays: Number(journalFixShift) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setJournalFixResult({ error: data.error || "Failed." }); setJournalFixLoading(false); return; }
      const jobId = data.jobId;
      const poll = async () => {
        try {
          const r = await fetch(`/api/import/manual-journals/fix-dates/status?jobId=${jobId}`, { headers: { "x-user-token": token } });
          const d = await r.json().catch(() => ({}));
          setJournalFixResult(d);
          if (d.status === "running") setTimeout(poll, 2000);
          else setJournalFixLoading(false);
        } catch { setJournalFixLoading(false); }
      };
      poll();
    } catch (err) {
      setJournalFixResult({ error: err.message });
      setJournalFixLoading(false);
    }
  };
  const startManualJournalImport = async () => {
    if (!selectedTenant) {
      setManualJournalStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!manualJournalRows.length || manualJournalErrors.length) {
      setManualJournalStatus("Upload a valid CSV file before importing.");
      return;
    }
    setManualJournalLoading(true);
    setManualJournalStatus("Starting Manual Journal import...");
    try {
      const res = await fetch(`${API_BASE}/import/manual-journals/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: manualJournalFile?.name || "manual_journals.csv",
          rows: manualJournalRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start Manual Journal import.");
      setManualJournalProgress(data);
      setManualJournalJobId(data.jobId);
      setManualJournalStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setManualJournalStatus(err.message);
      setManualJournalLoading(false);
    }
  };
  const overpaymentTemplateHeaders = ["Reference", "Contact Name", "Date", "Currency Code", "Exchange Rate", "Bank Account Code", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"];
  const downloadSpendOpTemplate = () => {
    downloadCsvFile("xero_spend_overpayment_import_template.csv", overpaymentTemplateHeaders);
  };
  const downloadReceiveOpTemplate = () => {
    downloadCsvFile("xero_receive_overpayment_import_template.csv", overpaymentTemplateHeaders);
  };
  const parseOverpaymentCsvFile = async (file, importTypeKey = "spend-overpayments") => {
    const expectedHeaders = overpaymentTemplateHeaders;
    const rows = await readCsvByHeaders({
      file,
      expectedHeaders,
      importTypeKey
    });
    const parsedRows = rows.map(({
      cells,
      indexes,
      rowNumber
    }) => ({
      rowNumber,
      reference: cells[indexes.Reference] || "",
      contactName: cells[indexes["Contact Name"]] || "",
      date: cells[indexes.Date] || "",
      currencyCode: cells[indexes["Currency Code"]] || "",
      exchangeRate: cells[indexes["Exchange Rate"]] || "",
      bankAccountCode: cells[indexes["Bank Account Code"]] || "",
      description: cells[indexes["Line Description"]] || "",
      quantity: cells[indexes.Quantity] || "",
      unitAmount: cells[indexes["Unit Amount"]] || "",
      accountCode: cells[indexes["Account Code"]] || "",
      taxType: cells[indexes["Tax Type"]] || "",
      taxAmount: cells[indexes["Tax Amount"]] || "",
      trackingName1: cells[indexes["Tracking Name 1"]] || "",
      trackingOption1: cells[indexes["Tracking Option 1"]] || "",
      trackingName2: cells[indexes["Tracking Name 2"]] || "",
      trackingOption2: cells[indexes["Tracking Option 2"]] || ""
    }));
    const validationErrors = parsedRows.flatMap(row => {
      const errs = [];
      if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
      if (!row.date) errs.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.bankAccountCode) errs.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.unitAmount) errs.push(`Row ${row.rowNumber}: Unit Amount is required.`);
      if (row.exchangeRate && Number.isNaN(Number(row.exchangeRate))) errs.push(`Row ${row.rowNumber}: Exchange Rate must be numeric.`);
      return errs;
    });
    return {
      parsedRows,
      validationErrors
    };
  };
  const handleSpendOpFile = async event => {
    const file = event.target.files?.[0] || null;
    setSpendOpFile(file);
    setSpendOpRows([]);
    setSpendOpErrors([]);
    setSpendOpProgress(null);
    setSpendOpJobId("");
    if (!file) {
      setSpendOpStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseOverpaymentCsvFile(file, "spend-overpayments");
      setSpendOpRows(parsedRows);
      setSpendOpErrors(validationErrors);
      setSpendOpStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setSpendOpErrors([err.message]);
      setSpendOpStatus(err.message);
    }
  };
  const handleReceiveOpFile = async event => {
    const file = event.target.files?.[0] || null;
    setReceiveOpFile(file);
    setReceiveOpRows([]);
    setReceiveOpErrors([]);
    setReceiveOpProgress(null);
    setReceiveOpJobId("");
    if (!file) {
      setReceiveOpStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseOverpaymentCsvFile(file, "receive-overpayments");
      setReceiveOpRows(parsedRows);
      setReceiveOpErrors(validationErrors);
      setReceiveOpStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setReceiveOpErrors([err.message]);
      setReceiveOpStatus(err.message);
    }
  };
  const startOverpaymentImport = async ({
    rows,
    file,
    overpaymentType,
    setLoading,
    setStatus: setStatus2,
    setJobId,
    setProgress
  }) => {
    if (!selectedTenant) {
      setStatus2("Select a Xero organisation before importing.");
      return;
    }
    if (!rows.length) {
      setStatus2("Upload a valid CSV file before importing.");
      return;
    }
    setLoading(true);
    setStatus2(`Starting ${overpaymentType === "SPEND" ? "Spend" : "Receive"} Overpayment import...`);
    try {
      const res = await fetch(`${API_BASE}/import/overpayment/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          overpaymentType,
          filename: file?.name || "overpayment.csv",
          rows,
          skipDuplicateCheck: opSkipDupCheck
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start overpayment import.");
      setProgress(data);
      setJobId(data.jobId);
      setStatus2("Import started. Progress will update automatically.");
    } catch (err) {
      setStatus2(err.message);
      setLoading(false);
    }
  };
  const spendAllocationTemplateHeaders = ["Overpayment Reference", "Bill Number", "Contact Name", "Amount", "Date"];
  const receiveAllocationTemplateHeaders = ["Overpayment Reference", "Invoice Number", "Contact Name", "Amount", "Date"];
  const cnAllocationTemplateHeaders = ["Credit Note Number", "Invoice Number", "Contact Name", "Amount", "Date"];
  const dnAllocationTemplateHeaders = ["Credit Note Number", "Bill Number", "Contact Name", "Amount", "Date"];
  const downloadSpendAllocationTemplate = () => {
    downloadCsvFile("xero_spend_allocation_template.csv", spendAllocationTemplateHeaders);
  };
  const downloadReceiveAllocationTemplate = () => {
    downloadCsvFile("xero_receive_allocation_template.csv", receiveAllocationTemplateHeaders);
  };
  const downloadCnAllocationTemplate = () => {
    downloadCsvFile("xero_credit_note_allocation_template.csv", cnAllocationTemplateHeaders);
  };
  const downloadDnAllocationTemplate = () => {
    downloadCsvFile("xero_debit_note_allocation_template.csv", dnAllocationTemplateHeaders);
  };
  const parseAllocationCsvFile = async (file, importTypeKey = "spend-alloc") => {
    const isSpend = importTypeKey === "spend-alloc";
    const billCol = isSpend ? "Bill Number" : "Invoice Number";
    const rows = await readCsvByHeaders({
      file,
      expectedHeaders: ["Overpayment Reference"],
      optionalHeaders: [billCol, "Bill Number", "Invoice Number", "invoiceNumber", "Contact Name", "Amount", "Date"],
      importTypeKey
    });
    const parsedRows = rows.map(({
      cells,
      indexes,
      rowNumber
    }) => ({
      rowNumber,
      overpaymentReference: cells[indexes["Overpayment Reference"]] || "",
      invoiceNumber: cells[indexes["Bill Number"]] || cells[indexes["Invoice Number"]] || cells[indexes["invoiceNumber"]] || "",
      contactName: cells[indexes["Contact Name"]] || "",
      amount: cells[indexes.Amount] || "",
      date: cells[indexes.Date] || ""
    }));
    const validationErrors = parsedRows.flatMap(row => {
      const errs = [];
      if (!row.overpaymentReference) errs.push(`Row ${row.rowNumber}: Overpayment Reference is required.`);
      if (row.amount && Number.isNaN(Number(row.amount))) errs.push(`Row ${row.rowNumber}: Amount must be a number (or leave blank for full allocation).`);
      return errs;
    });
    return {
      parsedRows,
      validationErrors
    };
  };
  const parseCreditNoteAllocationCsvFile = async (file, importTypeKey = "cn-allocation") => {
    const isCredit = importTypeKey === "cn-allocation";
    const docCol = isCredit ? "Invoice Number" : "Bill Number";
    const rows = await readCsvByHeaders({
      file,
      expectedHeaders: ["Credit Note Number"],
      optionalHeaders: [docCol, "Invoice Number", "Bill Number", "Contact Name", "Amount", "Date"],
      importTypeKey
    });
    const parsedRows = rows.map(({ cells, indexes, rowNumber }) => ({
      rowNumber,
      creditNoteReference: cells[indexes["Credit Note Number"]] || "",
      invoiceNumber: cells[indexes["Invoice Number"]] || cells[indexes["Bill Number"]] || "",
      contactName: cells[indexes["Contact Name"]] || "",
      amount: cells[indexes.Amount] || "",
      date: cells[indexes.Date] || ""
    }));
    const validationErrors = parsedRows.flatMap(row => {
      const errs = [];
      if (!row.creditNoteReference) errs.push(`Row ${row.rowNumber}: Credit Note Number is required.`);
      if (row.amount && Number.isNaN(Number(row.amount))) errs.push(`Row ${row.rowNumber}: Amount must be a number (or leave blank for full allocation).`);
      return errs;
    });
    return { parsedRows, validationErrors };
  };
  const spendMoneyTemplateHeaders = ["Bank Account Code", "Contact Name", "Date", "Reference", "Currency Code", "Exchange Rate", "Line Description", "Quantity", "Unit Amount", "Account Code", "Tax Type", "Tax Amount", "Tracking Name 1", "Tracking Option 1", "Tracking Name 2", "Tracking Option 2"];
  const downloadSpendMoneyTemplate = () => {
    downloadCsvFile("xero_spend_money_template.csv", spendMoneyTemplateHeaders, [
      ["090", "Example Vendor", "2026-01-15", "REF-001", "NZD", "1", "Example expense", "1", "100.00", "400", "NONE", "", "", "", "", ""],
    ]);
  };
  const parseSpendMoneyCsvFile = async (file, importTypeKey = "spend-money") => {
    const rows = await readCsvByHeaders({
      file,
      expectedHeaders: spendMoneyTemplateHeaders,
      importTypeKey
    });
    const parsedRows = rows.map(({
      cells,
      indexes,
      rowNumber
    }) => ({
      rowNumber,
      bankAccountCode: cells[indexes["Bank Account Code"]] || "",
      contactName: cells[indexes["Contact Name"]] || "",
      date: cells[indexes.Date] || "",
      reference: cells[indexes.Reference] || "",
      currencyCode: cells[indexes["Currency Code"]] || "",
      exchangeRate: cells[indexes["Exchange Rate"]] || "",
      description: cells[indexes["Line Description"]] || "",
      quantity: cells[indexes.Quantity] || "",
      unitAmount: cells[indexes["Unit Amount"]] || "",
      accountCode: cells[indexes["Account Code"]] || "",
      taxType: cells[indexes["Tax Type"]] || "",
      taxAmount: cells[indexes["Tax Amount"]] || "",
      trackingName1: cells[indexes["Tracking Name 1"]] || "",
      trackingOption1: cells[indexes["Tracking Option 1"]] || "",
      trackingName2: cells[indexes["Tracking Name 2"]] || "",
      trackingOption2: cells[indexes["Tracking Option 2"]] || ""
    }));
    const validationErrors = parsedRows.flatMap(row => {
      const errs = [];
      if (!row.bankAccountCode) errs.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
      if (!row.date) errs.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.description) errs.push(`Row ${row.rowNumber}: Line Description is required.`);
      return errs;
    });
    return {
      parsedRows,
      validationErrors
    };
  };
  const handleSpendMoneyFile = async file => {
    setSpendMoneyFile(file);
    setSpendMoneyRows([]);
    setSpendMoneyErrors([]);
    setSpendMoneyProgress(null);
    setSpendMoneyJobId("");
    if (!file) {
      setSpendMoneyStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseSpendMoneyCsvFile(file, "spend-money");
      setSpendMoneyRows(parsedRows);
      setSpendMoneyErrors(validationErrors);
      setSpendMoneyStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setSpendMoneyErrors([err.message]);
      setSpendMoneyStatus(err.message);
    }
  };
  const startSpendMoneyImport = async () => {
    if (spendMoneyLoading) return;
    if (!selectedTenant) {
      setSpendMoneyStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!spendMoneyRows.length) {
      setSpendMoneyStatus("Upload a valid CSV file before importing.");
      return;
    }
    setSpendMoneyLoading(true);
    setSpendMoneyStatus("Starting Spend Money import...");
    try {
      const res = await fetch(`${API_BASE}/import/spend-money/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: spendMoneyFile?.name || "spend_money.csv",
          rows: spendMoneyRows,
          skipDuplicateCheck: spendMoneySkipDupCheck
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start Spend Money import.");
      setSpendMoneyProgress(data);
      setSpendMoneyJobId(data.jobId);
      setSpendMoneyStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setSpendMoneyStatus(err.message);
      setSpendMoneyLoading(false);
    }
  };
  const downloadReceiveMoneyTemplate = () => {
    downloadCsvFile("xero_receive_money_template.csv", spendMoneyTemplateHeaders, [
      ["090", "Example Customer", "2026-01-15", "REF-001", "NZD", "1", "Example receipt", "1", "100.00", "200", "NONE", "", "", "", "", ""],
    ]);
  };
  const parseReceiveMoneyCsvFile = async file => {
    const rows = await readCsvByHeaders({
      file,
      expectedHeaders: spendMoneyTemplateHeaders,
      importTypeKey: "receive-money"
    });
    const parsedRows = rows.map(({
      cells,
      indexes,
      rowNumber
    }) => ({
      rowNumber,
      bankAccountCode: cells[indexes["Bank Account Code"]] || "",
      contactName: cells[indexes["Contact Name"]] || "",
      date: cells[indexes.Date] || "",
      reference: cells[indexes.Reference] || "",
      currencyCode: cells[indexes["Currency Code"]] || "",
      exchangeRate: cells[indexes["Exchange Rate"]] || "",
      description: cells[indexes["Line Description"]] || "",
      quantity: cells[indexes.Quantity] || "",
      unitAmount: cells[indexes["Unit Amount"]] || "",
      accountCode: cells[indexes["Account Code"]] || "",
      taxType: cells[indexes["Tax Type"]] || "",
      taxAmount: cells[indexes["Tax Amount"]] || "",
      trackingName1: cells[indexes["Tracking Name 1"]] || "",
      trackingOption1: cells[indexes["Tracking Option 1"]] || "",
      trackingName2: cells[indexes["Tracking Name 2"]] || "",
      trackingOption2: cells[indexes["Tracking Option 2"]] || ""
    }));
    const validationErrors = parsedRows.flatMap(row => {
      const errs = [];
      if (!row.bankAccountCode) errs.push(`Row ${row.rowNumber}: Bank Account Code is required.`);
      if (!row.contactName) errs.push(`Row ${row.rowNumber}: Contact Name is required.`);
      if (!row.date) errs.push(`Row ${row.rowNumber}: Date is required.`);
      if (!row.description) errs.push(`Row ${row.rowNumber}: Line Description is required.`);
      return errs;
    });
    return {
      parsedRows,
      validationErrors
    };
  };
  const handleReceiveMoneyFile = async file => {
    setReceiveMoneyFile(file);
    setReceiveMoneyRows([]);
    setReceiveMoneyErrors([]);
    setReceiveMoneyProgress(null);
    setReceiveMoneyJobId("");
    if (!file) {
      setReceiveMoneyStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseReceiveMoneyCsvFile(file);
      setReceiveMoneyRows(parsedRows);
      setReceiveMoneyErrors(validationErrors);
      setReceiveMoneyStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setReceiveMoneyErrors([err.message]);
      setReceiveMoneyStatus(err.message);
    }
  };
  const startReceiveMoneyImport = async () => {
    if (receiveMoneyLoading) return;
    if (!selectedTenant) {
      setReceiveMoneyStatus("Select a Xero organisation before importing.");
      return;
    }
    if (!receiveMoneyRows.length) {
      setReceiveMoneyStatus("Upload a valid CSV file before importing.");
      return;
    }
    setReceiveMoneyLoading(true);
    setReceiveMoneyStatus("Starting Receive Money import...");
    try {
      const res = await fetch(`${API_BASE}/import/receive-money/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          dateFormat: dateFormatPref,
          filename: receiveMoneyFile?.name || "receive_money.csv",
          rows: receiveMoneyRows,
          skipDuplicateCheck: receiveMoneySkipDupCheck
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start Receive Money import.");
      setReceiveMoneyProgress(data);
      setReceiveMoneyJobId(data.jobId);
      setReceiveMoneyStatus("Import started. Progress will update automatically.");
    } catch (err) {
      setReceiveMoneyStatus(err.message);
      setReceiveMoneyLoading(false);
    }
  };
  const handleSpendAllocFile = async event => {
    const file = event.target.files?.[0] || null;
    setSpendAllocFile(file);
    setSpendAllocRows([]);
    setSpendAllocErrors([]);
    setSpendAllocProgress(null);
    setSpendAllocJobId("");
    if (!file) {
      setSpendAllocStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseAllocationCsvFile(file, "spend-alloc");
      setSpendAllocRows(parsedRows);
      setSpendAllocErrors(validationErrors);
      setSpendAllocStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setSpendAllocErrors([err.message]);
      setSpendAllocStatus(err.message);
    }
  };
  const handleReceiveAllocFile = async event => {
    const file = event.target.files?.[0] || null;
    setReceiveAllocFile(file);
    setReceiveAllocRows([]);
    setReceiveAllocErrors([]);
    setReceiveAllocProgress(null);
    setReceiveAllocJobId("");
    if (!file) {
      setReceiveAllocStatus("");
      return;
    }
    try {
      const {
        parsedRows,
        validationErrors
      } = await parseAllocationCsvFile(file, "receive-alloc");
      setReceiveAllocRows(parsedRows);
      setReceiveAllocErrors(validationErrors);
      setReceiveAllocStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setReceiveAllocErrors([err.message]);
      setReceiveAllocStatus(err.message);
    }
  };
  const startSpendAllocImport = async () => {
    if (!selectedTenant) {
      setSpendAllocStatus("Select a Xero organisation before allocating.");
      return;
    }
    if (!spendAllocRows.length) {
      setSpendAllocStatus("Upload a valid CSV file before allocating.");
      return;
    }
    setSpendAllocLoading(true);
    setSpendAllocStatus("Starting Spend Overpayment allocation...");
    try {
      const res = await fetch(`${API_BASE}/import/overpayment-allocation/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: spendAllocFile?.name || "allocation.csv",
          rows: spendAllocRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start allocation.");
      setSpendAllocProgress(data);
      setSpendAllocJobId(data.jobId);
      setSpendAllocStatus("Allocation started. Progress will update automatically.");
    } catch (err) {
      setSpendAllocStatus(err.message);
      setSpendAllocLoading(false);
    }
  };
  const startReceiveAllocImport = async () => {
    if (!selectedTenant) {
      setReceiveAllocStatus("Select a Xero organisation before allocating.");
      return;
    }
    if (!receiveAllocRows.length) {
      setReceiveAllocStatus("Upload a valid CSV file before allocating.");
      return;
    }
    setReceiveAllocLoading(true);
    setReceiveAllocStatus("Starting Receive Overpayment allocation...");
    try {
      const res = await fetch(`${API_BASE}/import/overpayment-allocation/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...importHeaders,
          "x-tenant-id": selectedTenant
        },
        body: JSON.stringify({
          tenantId: selectedTenant,
          filename: receiveAllocFile?.name || "allocation.csv",
          allocationType: "receive",
          rows: receiveAllocRows
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start allocation.");
      setReceiveAllocProgress(data);
      setReceiveAllocJobId(data.jobId);
      setReceiveAllocStatus("Allocation started. Progress will update automatically.");
    } catch (err) {
      setReceiveAllocStatus(err.message);
      setReceiveAllocLoading(false);
    }
  };
  const handleCnAllocFile = async event => {
    const file = event?.target?.files?.[0] || event;
    setCnAllocFile(file);
    setCnAllocRows([]);
    setCnAllocErrors([]);
    setCnAllocProgress(null);
    setCnAllocJobId("");
    if (!file) { setCnAllocStatus(""); return; }
    try {
      const { parsedRows, validationErrors } = await parseCreditNoteAllocationCsvFile(file, "cn-allocation");
      setCnAllocRows(parsedRows);
      setCnAllocErrors(validationErrors);
      setCnAllocStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setCnAllocErrors([err.message]);
      setCnAllocStatus(err.message);
    }
  };
  const handleDnAllocFile = async event => {
    const file = event?.target?.files?.[0] || event;
    setDnAllocFile(file);
    setDnAllocRows([]);
    setDnAllocErrors([]);
    setDnAllocProgress(null);
    setDnAllocJobId("");
    if (!file) { setDnAllocStatus(""); return; }
    try {
      const { parsedRows, validationErrors } = await parseCreditNoteAllocationCsvFile(file, "dn-allocation");
      setDnAllocRows(parsedRows);
      setDnAllocErrors(validationErrors);
      setDnAllocStatus(validationErrors.length ? `${file.name} loaded with ${validationErrors.length} validation error(s).` : `${file.name} validated. ${parsedRows.length} row(s) ready.`);
    } catch (err) {
      setDnAllocErrors([err.message]);
      setDnAllocStatus(err.message);
    }
  };
  const startCnAllocImport = async () => {
    if (!selectedTenant) { setCnAllocStatus("Select a Xero organisation before allocating."); return; }
    if (!cnAllocRows.length) { setCnAllocStatus("Upload a valid CSV file before allocating."); return; }
    setCnAllocLoading(true);
    setCnAllocStatus("Starting Credit Note allocation...");
    try {
      const res = await fetch(`${API_BASE}/import/credit-note-allocation/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, dateFormat: dateFormatPref, filename: cnAllocFile?.name || "allocation.csv", allocationType: "credit", rows: cnAllocRows })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start allocation.");
      setCnAllocProgress(data);
      setCnAllocJobId(data.jobId);
      setCnAllocStatus("Allocation started. Progress will update automatically.");
    } catch (err) {
      setCnAllocStatus(err.message);
      setCnAllocLoading(false);
    }
  };
  const startDnAllocImport = async () => {
    if (!selectedTenant) { setDnAllocStatus("Select a Xero organisation before allocating."); return; }
    if (!dnAllocRows.length) { setDnAllocStatus("Upload a valid CSV file before allocating."); return; }
    setDnAllocLoading(true);
    setDnAllocStatus("Starting Debit Note allocation...");
    try {
      const res = await fetch(`${API_BASE}/import/credit-note-allocation/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...importHeaders, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, dateFormat: dateFormatPref, filename: dnAllocFile?.name || "allocation.csv", allocationType: "debit", rows: dnAllocRows })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start allocation.");
      setDnAllocProgress(data);
      setDnAllocJobId(data.jobId);
      setDnAllocStatus("Allocation started. Progress will update automatically.");
    } catch (err) {
      setDnAllocStatus(err.message);
      setDnAllocLoading(false);
    }
  };
  const workspacePaths = {
    extraction: "/",
    importing: "/import",
    deletecentre: "/delete-centre"
  };
  const authHeaders = useMemo(() => ({
    ...sessionHeader,
    ...userHeader
  }), [sessionHeader, userHeader]);
  // importHeaders = authHeaders + optional note header for all import calls
  const importHeaders = useMemo(() => {
    const h = Object.assign({}, authHeaders);
    if (importNote) h["x-import-note"] = importNote;
    return h;
  }, [authHeaders, importNote]);

  const hasPermission = (perm) => userRole === "admin" || userPermissions.includes(perm);
  const groupedTypes = useMemo(() => {
    const categories = [{
      key: "Sales",
      match: type => type.startsWith("Invoice ") || type.startsWith("Invoice CreditNotes") || type === "Quotes" || type === "Receive" || type === "Invoice Payment" || type === "CreditNoteRefund Invoice"
    }, {
      key: "Purchases",
      match: type => type.startsWith("Bill ") || type.startsWith("Supplier CreditNotes") || type === "Purchase Orders" || type === "Spend" || type === "Bill Payment" || type === "CreditNoteRefund Bill" || type === "Prepayments" || type === "Debit Notes"
    }, {
      key: "Banking",
      match: type => type === "Transfer" || type === "Spend Overpayment" || type === "Receive Overpayment" || type === "Overpayment Refund AP" || type === "Overpayment Refund AR" || type === "Overpayment Refunds" || type === "Manual Journals"
    }, {
      key: "Contacts",
      match: type => type === "Contacts"
    }, {
      key: "Inventory",
      match: type => type === "Inventory" || type === "Items"
    }, {
      key: "Accounts",
      match: type => type === "Chart of Accounts"
    }, {
      key: "Tracking",
      match: type => type === "Tracking Category" || type === "Classes"
    }];
    const groups = categories.map(category => ({
      label: category.key,
      types: [],
      match: category.match
    }));
    const misc = {
      label: "Other",
      types: []
    };
    types.forEach(type => {
      const group = groups.find(item => item.match(type));
      if (group) {
        group.types.push(type);
      } else {
        misc.types.push(type);
      }
    });
    const result = groups.filter(group => group.types.length);
    if (misc.types.length) {
      result.push(misc);
    }
    return result;
  }, [types]);
  const exportSummary = useMemo(() => {
    if (!selectedTenantName) {
      return {
        downloaded: 0,
        noRecords: 0,
        errors: 0
      };
    }
    const scopedResults = exportResults.filter(result => {
      if (showAllTenants) return true;
      return result.tenantName === selectedTenantName;
    });
    const summary = {
      downloaded: 0,
      noRecords: 0,
      errors: 0
    };
    scopedResults.forEach(result => {
      if (result.status === "Ready") summary.downloaded += 1;
      if (result.status === "No records") summary.noRecords += 1;
      if (result.status === "Error") summary.errors += 1;
    });
    return summary;
  }, [exportResults, selectedTenantName, showAllTenants]);
  useEffect(() => {
    Object.keys(localStorage).filter(key => key.startsWith("xero_export_results_")).forEach(key => localStorage.removeItem(key));
    setExportResults([]);
    setShowHistory(false);
    setOpenTenants({});
  }, []);
  useEffect(() => {
    if (!user?.id) return;
    setExportResults([]);
    const stored = localStorage.getItem(`xero_export_results_${user.id}`);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setExportResults(parsed);
        }
      } catch {}
    }
  }, [user?.id]);
  useEffect(() => {
    if (!user?.id || !userToken) return;
    const clearedKey = `xero_history_cleared_${user.id}`;
    if (localStorage.getItem(clearedKey)) return;
    fetch(`${API_BASE}/export/jobs/clear`, {
      method: "DELETE",
      headers: userHeader
    }).then(res => {
      if (res.ok) {
        localStorage.setItem(clearedKey, "1");
        setExportResults([]);
        setShowHistory(false);
        setOpenTenants({});
      }
    }).catch(() => {});
  }, [user?.id, userToken, userHeader]);
  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(`xero_export_results_${user.id}`, JSON.stringify(exportResults));
  }, [exportResults, user?.id]);
  useEffect(() => {
    const storedAdminToken = localStorage.getItem("xero_admin_token") || "";
    if (!storedAdminToken) return;
    setAdminToken(storedAdminToken);
    fetch(`${API_BASE}/admin/me`, {
      headers: {
        "x-admin-token": storedAdminToken
      }
    }).then(res => res.json()).then(data => {
      if (data.admin?.email) {
        setAdminAuthed(true);
        loadAdminSettings(storedAdminToken);
        loadAdminTypes(storedAdminToken);
        loadAdminUsers(storedAdminToken);
        loadAdminAnalytics(storedAdminToken, adminAnalyticsDays);
      } else {
        localStorage.removeItem("xero_admin_token");
        setAdminToken("");
      }
    }).catch(() => {
      localStorage.removeItem("xero_admin_token");
      setAdminToken("");
    });
  }, []);
  useEffect(() => {
    if (!adminAuthed || !adminHydrated) return;
    if (!adminLimit) return;
    if (adminAutosaveRef.current) {
      clearTimeout(adminAutosaveRef.current);
    }
    adminAutosaveRef.current = setTimeout(() => {
      handleSaveAdminSettingsSilent();
    }, 700);
    return () => clearTimeout(adminAutosaveRef.current);
  }, [adminLimit, adminTypeSelection, adminAuthed, adminHydrated]);
  useEffect(() => {
    if (!adminAuthed) return;
    const timeout = setTimeout(() => {
      loadAdminAnalytics();
    }, 400);
    return () => clearTimeout(timeout);
  }, [adminFilterTenant, adminFilterUser]);
  // React Router handles popstate — manual listener removed
  useEffect(() => {
    // Restore session from httpOnly cookie — no localStorage needed
    fetch(`${API_BASE}/user/me`).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.user || !data.token) return;
      setUserToken(data.token);
      setUser(data.user);
      setUserRole(data.user?.isAdmin ? "admin" : (data.user?.role || "importer"));
      setUserPermissions(data.user?.isAdmin ? ["import","export","delete","allocation"] : (data.user?.permissions || ["import"]));
      fetch(`${API_BASE}/user/plan-info`)
        .then(r => r.json()).then(d => { if (d.plan) setUserPlanInfo(d); }).catch(() => {});
    }).catch(() => {}).finally(() => setSessionChecked(true));
  }, []);
  const handleAuthSubmit = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const endpoint = authMode === "signup" ? "signup" : "login";
      const res = await fetch(`${API_BASE}/user/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: authEmail,
          password: authPassword
        })
      });
      const {
        data,
        rawText
      } = await parseApiResponse(res);
      if (!res.ok) {
        const fallback = rawText && !rawText.trim().startsWith("<") ? rawText : `Auth failed (${res.status})`;
        throw new Error(data.error || fallback);
      }
      setUserToken(data.token);
      setUser(data.user);
      setUserRole(data.user?.isAdmin ? "admin" : (data.user?.role || "importer"));
      setUserPermissions(data.user?.isAdmin ? ["import","export","delete","allocation"] : (data.user?.permissions || ["import"]));
      fetch(`${API_BASE}/user/plan-info`, { headers: { "x-user-token": data.token } })
        .then(r => r.json()).then(d => { if (d.plan) setUserPlanInfo(d); }).catch(() => {});
      loadUserBroadcast();
      setExportResults([]);
      setShowHistory(false);
      setOpenTenants({});
      setAuthEmail("");
      setAuthPassword("");
      const pendingPlan = localStorage.getItem("imb_pending_plan");
      if (pendingPlan) { localStorage.removeItem("imb_pending_plan"); navigate("/pricing"); }
      else { navigate(workspacePaths[selectedWorkspace] || "/"); }
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };
  const handleLogout = async () => {
    if (sessionId) {
      toast.error("Pehle Xero se Disconnect karo, phir logout karo.", { duration: 4000 });
      return;
    }
    manuallyDisconnectedRef.current = true;
    localStorage.setItem("kk_manualDisconnect", "1");
    localStorage.removeItem("xero_session");
    setSessionId("");
    setTenants([]);
    setSelectedTenant("");
    try {
      await fetch(`${API_BASE}/user/logout`, {
        method: "POST",
        headers: userHeader
      });
    } catch {}
    setUserToken("");
    setUser(null);
    setExportResults([]);
    toast.success("Logged out successfully.");
  };
  const handleClearHistory = async () => {
    if (!user?.id) return;
    setStatus("Clearing history...");
    try {
      const res = await fetch(`${API_BASE}/export/jobs/clear`, {
        method: "DELETE",
        headers: userHeader
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error || "Failed to clear history");
      }
      localStorage.setItem(`xero_history_cleared_${user.id}`, "1");
      localStorage.removeItem(`xero_export_results_${user.id}`);
      setExportResults([]);
      setShowHistory(false);
      setOpenTenants({});
      setStatus("History cleared.");
    } catch (err) {
      setStatus(err.message);
    }
  };
  const handleDownloadAll = (tenantName = "") => {
    const format = String(downloadAllFormat || "excel").toLowerCase();
    const ready = exportResults.filter(item => {
      if (item.status !== "Ready" || !item[`${format}Url`]) return false;
      if (tenantName) {
        return item.tenantName === tenantName;
      }
      return true;
    });
    if (!ready.length) {
      setStatus("No ready exports to download.");
      return;
    }
    ready.forEach((item, index) => {
      setTimeout(() => {
        const link = document.createElement("a");
        link.href = item[`${format}Url`];
        link.target = "_blank";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 400);
    });
    const scope = tenantName ? ` for ${tenantName}` : "";
    setStatus(`Downloading ${ready.length} ${format.toUpperCase()} files${scope}...`);
  };
  const adminVolume = adminAnalytics?.volumeByDay || [];
  const adminTotals = adminAnalytics?.totals || {};
  const maxVolume = getMax(adminVolume, "count");
  const topUsers = adminAnalytics?.topUsers || [];
  const tenantUserMatrix = adminAnalytics?.tenantUserMatrix || [];
  const statusBreakdown = adminAnalytics?.statusBreakdown || [];
  const userStatusBreakdown = adminAnalytics?.userStatusBreakdown || [];
  const topUserTenants = adminAnalytics?.topUserTenants || [];
  const recentActivity = adminAnalytics?.recentActivity || [];
  const monthlyTenantCounts = adminAnalytics?.monthlyTenantCounts || [];
  const monthlyUserCounts = adminAnalytics?.monthlyUserCounts || [];
  const adminTenants = adminAnalytics?.lists?.tenants || [];
  const adminUsersList = adminAnalytics?.lists?.users || [];
  const statusTotal = statusBreakdown.reduce((sum, item) => sum + (item.count || 0), 0);
  const linePoints = adminVolume.map(item => ({
    label: item.date,
    value: item.count || 0
  }));
  const linePath = buildLinePath(linePoints, 400, 140);
  const donutSegments = statusBreakdown.map(item => ({
    ...item,
    pct: statusTotal ? item.count / statusTotal : 0
  }));
  const donutColors = {
    ready: "#2f6bff",
    running: "#f4b740",
    queued: "#8a93ad",
    no_records: "#ff6b6b",
    error: "#b94b4b"
  };
  const isChartEnabled = key => adminChartSelection.includes(key);
  const toggleChart = key => {
    setAdminChartSelection(prev => prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]);
  };
  if (isAdminPage) {
    return <div className="admin-page">
      {adminPendingPopup && adminUsers.some(u=>u.planStatus==="pending") && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminPendingPopup(false);}}>
          <div style={{background:"var(--surface)",border:"1px solid rgba(251,191,36,0.3)",borderRadius:16,width:"100%",maxWidth:520,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <div style={{width:36,height:36,borderRadius:"50%",background:"rgba(251,191,36,0.12)",border:"1.5px solid rgba(251,191,36,0.4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>⏳</div>
              <div><h3 style={{margin:0,fontSize:16,fontWeight:700}}>Pending Approvals</h3><p style={{margin:0,fontSize:13,color:"var(--muted)"}}>{adminUsers.filter(u=>u.planStatus==="pending").length} user(s) waiting for you to grant access</p></div>
            </div>
            <div style={{margin:"16px 0",display:"flex",flexDirection:"column",gap:8,maxHeight:320,overflowY:"auto"}}>
              {adminUsers.filter(u=>u.planStatus==="pending").map(u=>{
                const isPaid = u.plan && u.plan !== "testing" && u.plan !== "none";
                const planLabel = u.plan==="pro"?"Professional":u.plan==="growth"?"Growth":u.plan==="starter"?"Starter":u.plan==="testing"?"Testing (Free)":"Unknown";
                const dateStr = isPaid && u.planPaidAt ? new Date(u.planPaidAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}) : u.createdAt ? new Date(u.createdAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}) : "—";
                return (
                <div key={u.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,background:isPaid?"rgba(99,102,241,0.06)":"rgba(52,211,153,0.05)",border:`1px solid ${isPaid?"rgba(99,102,241,0.2)":"rgba(52,211,153,0.15)"}`,borderRadius:10,padding:"10px 14px"}}>
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2}}>
                      <span style={{fontWeight:600,fontSize:13,color:"var(--text)"}}>{u.email}</span>
                      <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:20,background:isPaid?"rgba(99,102,241,0.15)":"rgba(52,211,153,0.12)",color:isPaid?"#818cf8":"#34d399"}}>{planLabel}</span>
                    </div>
                    <div style={{fontSize:11,color:"var(--muted)"}}>{isPaid?"Payment received":"Requested"} {dateStr}</div>
                  </div>
                  <button type="button" onClick={()=>{setAdminApproveModal({id:u.id,email:u.email,plan:u.plan,isPaid,mode:"approve"});setAdminApproveForm({plan:"professional",days:30,customDays:""});setAdminPendingPopup(false);}} disabled={adminApprovingId===u.id} style={{padding:"6px 16px",background:isPaid?"rgba(99,102,241,0.15)":"rgba(52,211,153,0.15)",color:isPaid?"#818cf8":"#34d399",border:`1px solid ${isPaid?"rgba(99,102,241,0.4)":"rgba(52,211,153,0.4)"}`,borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>{adminApprovingId===u.id?"Approving…":"✓ Give Access"}</button>
                </div>
              );})}
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
              <button type="button" onClick={()=>setAdminPendingPopup(false)} style={{padding:"8px 20px",background:"var(--surface2)",color:"var(--muted)",border:"1px solid var(--border)",borderRadius:8,fontWeight:600,fontSize:13,cursor:"pointer"}}>Close</button>
            </div>
          </div>
        </div>
      )}
      {adminUserResetPwModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e => { if(e.target===e.currentTarget){setAdminUserResetPwModal(null);}}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:420,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
            <h3 style={{margin:"0 0 4px",fontSize:16,fontWeight:700}}>Reset Password</h3>
            <p style={{margin:"0 0 20px",fontSize:13,color:"var(--muted)"}}>{adminUserResetPwModal.email}</p>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>New Password</label>
            <input type="password" value={adminUserResetPwValue} onChange={e => setAdminUserResetPwValue(e.target.value)} placeholder="Min. 6 characters" style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:14,marginBottom:8}} onKeyDown={e => { if(e.key==="Enter") handleResetUserPassword(); }} />
            {adminUserResetPwError && <div style={{color:"#ef4444",fontSize:12,marginBottom:8}}>{adminUserResetPwError}</div>}
            <div style={{display:"flex",gap:10,marginTop:12}}>
              <button className="btn ghost" type="button" onClick={() => setAdminUserResetPwModal(null)} style={{flex:1}}>Cancel</button>
              <button className="btn primary" type="button" onClick={handleResetUserPassword} disabled={adminUserResetPwLoading} style={{flex:1}}>{adminUserResetPwLoading ? "Resetting…" : "Reset Password"}</button>
            </div>
          </div>
        </div>
      )}
      {adminUserNoteModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.72)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e => { if(e.target===e.currentTarget){setAdminUserNoteModal(null);}}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:440,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
            <h3 style={{margin:"0 0 4px",fontSize:16,fontWeight:700}}>Admin Note</h3>
            <p style={{margin:"0 0 20px",fontSize:13,color:"var(--muted)"}}>{adminUserNoteModal.email}</p>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>Note (max 500 characters)</label>
            <textarea value={adminUserNoteValue} onChange={e => setAdminUserNoteValue(e.target.value.slice(0,500))} placeholder="e.g. VIP client, accountant for XYZ firm..." rows={4} style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,resize:"vertical",marginBottom:4}} />
            <div style={{fontSize:11,color:"var(--muted)",textAlign:"right",marginBottom:12}}>{adminUserNoteValue.length}/500</div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn ghost" type="button" onClick={() => setAdminUserNoteModal(null)} style={{flex:1}}>Cancel</button>
              <button className="btn primary" type="button" onClick={handleSaveUserNote} disabled={adminUserNoteSaving} style={{flex:1}}>{adminUserNoteSaving ? "Saving…" : "Save Note"}</button>
            </div>
          </div>
        </div>
      )}
      {adminApproveModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(8px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminApproveModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid rgba(52,211,153,0.3)",borderRadius:18,width:"100%",maxWidth:480,padding:30,boxShadow:"0 40px 100px rgba(0,0,0,0.7)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:adminApproveModal.mode==="set"?"rgba(129,140,248,0.12)":"rgba(52,211,153,0.12)",border:`1.5px solid ${adminApproveModal.mode==="set"?"rgba(129,140,248,0.4)":"rgba(52,211,153,0.4)"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{adminApproveModal.mode==="set"?"📋":"✓"}</div>
              <div>
                <h3 style={{margin:0,fontSize:17,fontWeight:700,color:"var(--text)"}}>{adminApproveModal.mode==="set"?"Set Plan":"Grant Access"}</h3>
                <p style={{margin:"2px 0 0",fontSize:13,color:"var(--muted)",wordBreak:"break-all"}}>{adminApproveModal.email}</p>
              </div>
            </div>
            <div style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Select Plan</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[{v:"starter",l:"Starter",c:"#94a3b8"},{v:"professional",l:"Professional",c:"#2dd4bf"},{v:"enterprise",l:"Enterprise",c:"#818cf8"},{v:"growth",l:"Growth",c:"#f59e0b"}].map(p=>(
                  <button key={p.v} type="button" onClick={()=>setAdminApproveForm(f=>({...f,plan:p.v}))} style={{padding:"10px 14px",borderRadius:10,border:`1.5px solid ${adminApproveForm.plan===p.v?p.c:"var(--border)"}`,background:adminApproveForm.plan===p.v?`${p.c}18`:"var(--surface2)",color:adminApproveForm.plan===p.v?p.c:"var(--muted)",fontWeight:700,fontSize:13,cursor:"pointer",transition:"all 0.15s",textAlign:"left"}}>
                    <div style={{fontSize:16,marginBottom:2}}>{p.v==="starter"?"🔹":p.v==="professional"?"⭐":p.v==="enterprise"?"💎":"🚀"}</div>
                    {p.l}
                  </button>
                ))}
              </div>
            </div>
            <div style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Duration</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                {[30,60,90,180,365].map(d=>(
                  <button key={d} type="button" onClick={()=>setAdminApproveForm(f=>({...f,days:d,customDays:""}))} style={{padding:"6px 14px",borderRadius:8,border:`1.5px solid ${adminApproveForm.days===d&&!adminApproveForm.customDays?"rgba(52,211,153,0.6)":"var(--border)"}`,background:adminApproveForm.days===d&&!adminApproveForm.customDays?"rgba(52,211,153,0.12)":"var(--surface2)",color:adminApproveForm.days===d&&!adminApproveForm.customDays?"#2dd4bf":"var(--muted)",fontWeight:700,fontSize:12,cursor:"pointer",transition:"all 0.15s"}}>
                    {d===365?"1 Year":`${d}d`}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" max="3650" placeholder="Custom days…" value={adminApproveForm.customDays} onChange={e=>{const v=e.target.value;setAdminApproveForm(f=>({...f,customDays:v,days:parseInt(v,10)||f.days}));}} style={{flex:1,padding:"7px 12px",borderRadius:8,border:`1.5px solid ${adminApproveForm.customDays?"rgba(52,211,153,0.5)":"var(--border)"}`,background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
                <span style={{fontSize:12,color:"var(--muted)"}}>days</span>
              </div>
            </div>
            {(()=>{
              const days = adminApproveForm.customDays ? parseInt(adminApproveForm.customDays,10)||adminApproveForm.days : adminApproveForm.days;
              const expDate = new Date(Date.now()+days*86400000).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
              const planColors={"starter":"#94a3b8","professional":"#2dd4bf","enterprise":"#818cf8","growth":"#f59e0b"};
              const pc=planColors[adminApproveForm.plan]||"#2dd4bf";
              return <div style={{background:`${pc}0d`,border:`1px solid ${pc}30`,borderRadius:10,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:22}}>📅</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>Access until <span style={{color:pc}}>{expDate}</span></div>
                  <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>{adminApproveForm.plan.charAt(0).toUpperCase()+adminApproveForm.plan.slice(1)} plan · {days} days</div>
                </div>
              </div>;
            })()}
            <div style={{display:"flex",gap:10}}>
              <button type="button" onClick={()=>setAdminApproveModal(null)} style={{flex:1,padding:"10px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--muted)",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancel</button>
              <button type="button" disabled={adminApprovingId===adminApproveModal.id} onClick={()=>handleApproveWithPlan(adminApproveModal.id,adminApproveForm.plan,adminApproveForm.customDays?parseInt(adminApproveForm.customDays,10)||adminApproveForm.days:adminApproveForm.days,adminApproveModal.mode||"approve")} style={{flex:2,padding:"10px",borderRadius:10,border:`1.5px solid ${adminApproveModal.mode==="set"?"rgba(129,140,248,0.4)":"rgba(52,211,153,0.4)"}`,background:adminApproveModal.mode==="set"?"rgba(129,140,248,0.12)":"rgba(52,211,153,0.15)",color:adminApproveModal.mode==="set"?"#818cf8":"#2dd4bf",fontWeight:700,fontSize:14,cursor:"pointer"}}>
                {adminApprovingId===adminApproveModal.id?(adminApproveModal.mode==="set"?"Saving…":"Granting…"):(adminApproveModal.mode==="set"?"📋 Set Plan":"✓ Grant Access")}
              </button>
            </div>
          </div>
        </div>
      )}
      {adminRenewModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(8px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminRenewModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid rgba(45,212,191,0.3)",borderRadius:18,width:"100%",maxWidth:460,padding:30,boxShadow:"0 40px 100px rgba(0,0,0,0.7)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:"rgba(45,212,191,0.12)",border:"1.5px solid rgba(45,212,191,0.4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>↻</div>
              <div>
                <h3 style={{margin:0,fontSize:17,fontWeight:700,color:"var(--text)"}}>Renew Plan</h3>
                <p style={{margin:"2px 0 0",fontSize:13,color:"var(--muted)",wordBreak:"break-all"}}>{adminRenewModal.email}</p>
              </div>
            </div>
            {(()=>{
              const planColors={"starter":"#94a3b8","professional":"#2dd4bf","enterprise":"#818cf8","growth":"#f59e0b","none":"#64748b"};
              const pc=planColors[adminRenewModal.plan]||"#2dd4bf";
              const expMs=adminRenewModal.planExpiry?new Date(adminRenewModal.planExpiry)-Date.now():null;
              const daysLeft=expMs!=null?Math.ceil(expMs/86400000):null;
              const expiryStr=adminRenewModal.planExpiry?new Date(adminRenewModal.planExpiry).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}):"—";
              return <div style={{background:"var(--surface2)",borderRadius:12,padding:"14px 16px",marginBottom:20}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                  <div>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7,marginBottom:4}}>Current Plan</div>
                    <span style={{fontSize:14,fontWeight:700,color:pc}}>{adminRenewModal.plan.charAt(0).toUpperCase()+adminRenewModal.plan.slice(1)}</span>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7,marginBottom:4}}>Expires</div>
                    <div style={{fontSize:13,fontWeight:600,color:"var(--text)"}}>{expiryStr}</div>
                    {daysLeft!=null&&<div style={{fontSize:12,fontWeight:700,color:daysLeft<=0?"#f87171":daysLeft<=7?"#f59e0b":"#22c55e",marginTop:2}}>{daysLeft<=0?"Expired":daysLeft===1?"1 day left":`${daysLeft} days left`}</div>}
                  </div>
                </div>
                {adminRenewModal.planStartAt&&<div style={{marginTop:10,paddingTop:10,borderTop:"1px solid var(--border)",fontSize:11,color:"var(--muted)"}}>Plan started: {new Date(adminRenewModal.planStartAt).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}</div>}
              </div>;
            })()}
            <div style={{marginBottom:18}}>
              <div style={{fontSize:11,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.8,marginBottom:8}}>Extend by</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                {[30,60,90,180,365].map(d=>(
                  <button key={d} type="button" onClick={()=>setAdminRenewForm(f=>({...f,days:d,customDays:""}))} style={{padding:"6px 14px",borderRadius:8,border:`1.5px solid ${adminRenewForm.days===d&&!adminRenewForm.customDays?"rgba(45,212,191,0.6)":"var(--border)"}`,background:adminRenewForm.days===d&&!adminRenewForm.customDays?"rgba(45,212,191,0.12)":"var(--surface2)",color:adminRenewForm.days===d&&!adminRenewForm.customDays?"#2dd4bf":"var(--muted)",fontWeight:700,fontSize:12,cursor:"pointer",transition:"all 0.15s"}}>
                    {d===365?"1 Year":`${d}d`}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min="1" max="3650" placeholder="Custom days…" value={adminRenewForm.customDays} onChange={e=>{const v=e.target.value;setAdminRenewForm(f=>({...f,customDays:v,days:parseInt(v,10)||f.days}));}} style={{flex:1,padding:"7px 12px",borderRadius:8,border:`1.5px solid ${adminRenewForm.customDays?"rgba(45,212,191,0.5)":"var(--border)"}`,background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
                <span style={{fontSize:12,color:"var(--muted)"}}>days</span>
              </div>
            </div>
            {(()=>{
              const days=adminRenewForm.customDays?parseInt(adminRenewForm.customDays,10)||adminRenewForm.days:adminRenewForm.days;
              const base=adminRenewModal.planExpiry&&new Date(adminRenewModal.planExpiry)>new Date()?new Date(adminRenewModal.planExpiry):new Date();
              const newExpiry=new Date(base.getTime()+days*86400000).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});
              const note=adminRenewModal.planExpiry&&new Date(adminRenewModal.planExpiry)>new Date()?"Extended from current expiry":"Extended from today";
              return <div style={{background:"rgba(45,212,191,0.07)",border:"1px solid rgba(45,212,191,0.25)",borderRadius:10,padding:"12px 16px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
                <span style={{fontSize:22}}>📅</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>New expiry: <span style={{color:"#2dd4bf"}}>{newExpiry}</span></div>
                  <div style={{fontSize:12,color:"var(--muted)",marginTop:2}}>+{days} days · {note}</div>
                </div>
              </div>;
            })()}
            <div style={{display:"flex",gap:10}}>
              <button type="button" onClick={()=>setAdminRenewModal(null)} style={{flex:1,padding:"10px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--muted)",fontWeight:600,fontSize:13,cursor:"pointer"}}>Cancel</button>
              <button type="button" disabled={adminPlanRenewSaving===adminRenewModal.id} onClick={()=>handleRenewPlan(adminRenewModal.id,adminRenewForm.customDays?parseInt(adminRenewForm.customDays,10)||adminRenewForm.days:adminRenewForm.days)} style={{flex:2,padding:"10px",borderRadius:10,border:"1.5px solid rgba(45,212,191,0.4)",background:"rgba(45,212,191,0.12)",color:"#2dd4bf",fontWeight:700,fontSize:14,cursor:"pointer"}}>
                {adminPlanRenewSaving===adminRenewModal.id?"Renewing…":"↻ Renew Plan"}
              </button>
            </div>
          </div>
        </div>
      )}
      {adminCancelModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(8px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminCancelModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:18,width:"100%",maxWidth:420,padding:30,boxShadow:"0 40px 100px rgba(0,0,0,0.7)"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:20}}>
              <div style={{width:42,height:42,borderRadius:"50%",background:"rgba(239,68,68,0.1)",border:"1.5px solid rgba(239,68,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>✕</div>
              <div>
                <h3 style={{margin:0,fontSize:17,fontWeight:700,color:"var(--text)"}}>Cancel Plan</h3>
                <p style={{margin:"2px 0 0",fontSize:13,color:"var(--muted)",wordBreak:"break-all"}}>{adminCancelModal.email}</p>
              </div>
            </div>
            <div style={{background:"rgba(239,68,68,0.06)",border:"1px solid rgba(239,68,68,0.2)",borderRadius:12,padding:"14px 16px",marginBottom:20}}>
              <div style={{fontWeight:700,fontSize:13,color:"#f87171",marginBottom:6}}>⚠ This will immediately revoke access</div>
              <div style={{fontSize:13,color:"var(--muted)",lineHeight:1.5}}>User's <strong style={{color:"var(--text)"}}>{adminCancelModal.plan.charAt(0).toUpperCase()+adminCancelModal.plan.slice(1)}</strong> plan will be cancelled. They will lose import access right away and will need to request a new plan.</div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button type="button" onClick={()=>setAdminCancelModal(null)} style={{flex:1,padding:"10px",borderRadius:10,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--muted)",fontWeight:600,fontSize:13,cursor:"pointer"}}>Keep Plan</button>
              <button type="button" disabled={adminPlanCancelSaving===adminCancelModal.id} onClick={()=>handleConfirmCancelPlan(adminCancelModal.id)} style={{flex:1,padding:"10px",borderRadius:10,border:"1.5px solid rgba(239,68,68,0.5)",background:"rgba(239,68,68,0.1)",color:"#f87171",fontWeight:700,fontSize:14,cursor:"pointer"}}>
                {adminPlanCancelSaving===adminCancelModal.id?"Cancelling…":"✕ Cancel Plan"}
              </button>
            </div>
          </div>
        </div>
      )}
      {adminCustomLimitsModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20,overflowY:"auto"}} onClick={e => { if(e.target===e.currentTarget) setAdminCustomLimitsModal(null); }}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:520,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)",maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <span style={{fontSize:18}}>⚙️</span>
              <h3 style={{margin:0,fontSize:16,fontWeight:700}}>Custom Plan Limits</h3>
            </div>
            <p style={{margin:"4px 0 6px",fontSize:13,color:"var(--muted)"}}>{adminCustomLimitsModal.email}</p>
            <div style={{fontSize:11,background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:7,padding:"7px 12px",marginBottom:18,color:"#f59e0b"}}>
              Base plan: <strong>{adminCustomLimitsModal.plan}</strong> — leave fields blank to use base plan defaults. Filled fields override the base plan.
            </div>
            <div style={{display:"grid",gap:12}}>
              <label style={{display:"flex",flexDirection:"column",gap:5}}>
                <span style={{fontSize:12,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Max Rows Per Import</span>
                <input type="number" min="1" value={adminCustomLimitsForm.maxRowsPerImport || ""} onChange={e => setAdminCustomLimitsForm(f => ({...f, maxRowsPerImport: e.target.value}))} placeholder="Leave blank for plan default" style={{padding:"8px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
              </label>
              <label style={{display:"flex",flexDirection:"column",gap:5}}>
                <span style={{fontSize:12,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Max Xero Orgs</span>
                <select value={adminCustomLimitsForm.maxOrgs || ""} onChange={e => setAdminCustomLimitsForm(f => ({...f, maxOrgs: e.target.value}))} style={{padding:"8px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}}>
                  <option value="">Plan default</option>
                  <option value="1">1 org</option>
                  <option value="2">2 orgs</option>
                  <option value="3">3 orgs</option>
                  <option value="5">5 orgs</option>
                  <option value="10">10 orgs</option>
                  <option value="unlimited">Unlimited</option>
                </select>
              </label>
              {[
                {key:"exportAccess",label:"Export Access"},
                {key:"deleteAccess",label:"Delete/Void Access"},
                {key:"manualJournalsAccess",label:"Manual Journals"},
                {key:"paymentImportAccess",label:"Payment Imports"},
                {key:"overpaymentAccess",label:"Overpayment Imports"},
              ].map(({key,label}) => (
                <label key={key} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
                  <span style={{fontSize:13,color:"var(--text)"}}>{label}</span>
                  <select value={adminCustomLimitsForm[key] === "" ? "" : String(adminCustomLimitsForm[key])} onChange={e => setAdminCustomLimitsForm(f => ({...f, [key]: e.target.value === "" ? "" : e.target.value === "true"}))} style={{padding:"6px 10px",borderRadius:7,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,minWidth:130}}>
                    <option value="">Plan default</option>
                    <option value="true">Enabled</option>
                    <option value="false">Disabled</option>
                  </select>
                </label>
              ))}
            </div>
            <div style={{marginTop:20,paddingTop:16,borderTop:"1px solid var(--border)",display:"flex",gap:10,flexWrap:"wrap"}}>
              <button className="btn ghost" type="button" onClick={() => { setAdminCustomLimitsForm({}); }} style={{fontSize:12}}>Clear All Overrides</button>
              <div style={{flex:1}} />
              <button className="btn ghost" type="button" onClick={() => setAdminCustomLimitsModal(null)}>Cancel</button>
              <button className="btn primary" type="button" onClick={handleSaveCustomLimits} disabled={adminCustomLimitsSaving}>{adminCustomLimitsSaving ? "Saving…" : "Save Custom Limits"}</button>
            </div>
          </div>
        </div>
      )}
      {adminXeroClientModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminXeroClientModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:480,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
              <span style={{fontSize:20}}>🔑</span>
              <h3 style={{margin:0,fontSize:16,fontWeight:700}}>Xero Client ID</h3>
            </div>
            <p style={{margin:"4px 0 18px",fontSize:13,color:"var(--muted)"}}>{adminXeroClientModal.email}</p>
            <div style={{background:"rgba(99,102,241,0.08)",border:"1px solid rgba(99,102,241,0.2)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#818cf8",lineHeight:1.5}}>
              Create a free OAuth app in <strong>Xero Developer Portal</strong>, get the Client ID, and paste it here. This user will use their own Xero app for separate rate limits.
            </div>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>Client ID</label>
            <input type="text" value={adminXeroClientValue} onChange={e=>setAdminXeroClientValue(e.target.value)} placeholder="e.g. A257946BBFA5423CBF3236D047D0D60E" style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,marginBottom:8,fontFamily:"monospace"}} />
            {adminXeroClientError && <div style={{color:"#ef4444",fontSize:12,marginBottom:8}}>{adminXeroClientError}</div>}
            {adminXeroClientModal.xeroClientId && <div style={{fontSize:11,color:"var(--muted)",marginBottom:8}}>Current: <code style={{background:"var(--surface2)",padding:"1px 5px",borderRadius:4}}>{adminXeroClientModal.xeroClientId}</code></div>}
            <div style={{display:"flex",gap:10,marginTop:12}}>
              <button className="btn ghost" type="button" onClick={()=>setAdminXeroClientModal(null)} style={{flex:1}}>Cancel</button>
              <button className="btn ghost" type="button" style={{color:"#ef4444",borderColor:"#ef4444"}} onClick={()=>{ setAdminXeroClientValue(""); setTimeout(saveXeroClientId,0); }}>Clear</button>
              <button className="btn primary" type="button" onClick={saveXeroClientId} disabled={adminXeroClientSaving} style={{flex:1}}>{adminXeroClientSaving?"Saving…":"Save"}</button>
            </div>
          </div>
        </div>
      )}
      {adminLoginHistoryModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminLoginHistoryModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:440,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)",maxHeight:"80vh",display:"flex",flexDirection:"column"}}>
            <h3 style={{margin:"0 0 4px",fontSize:16,fontWeight:700}}>Login History</h3>
            <p style={{margin:"0 0 16px",fontSize:13,color:"var(--muted)"}}>{adminLoginHistoryModal.email}</p>
            <div style={{overflowY:"auto",flex:1}}>
              {adminLoginHistoryLoading ? <div style={{color:"var(--muted)",fontSize:13}}>Loading…</div> : adminLoginHistory.length ? adminLoginHistory.map((entry,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
                  <span style={{fontSize:11,color:"var(--muted)",minWidth:20,fontVariantNumeric:"tabular-nums"}}>#{i+1}</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:13,fontWeight:500}}>{new Date(entry.at).toLocaleString()}</div>
                    {entry.ip && <div style={{fontSize:11,color:"var(--muted)"}}>IP: {entry.ip}</div>}
                  </div>
                </div>
              )) : <div style={{color:"var(--muted)",fontSize:13}}>No login history yet.</div>}
            </div>
            <button className="btn ghost" style={{marginTop:16}} onClick={()=>setAdminLoginHistoryModal(null)}>Close</button>
          </div>
        </div>
      )}
      {adminXeroConnsModal && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setAdminXeroConnsModal(null);}}>
          <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:460,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
            <h3 style={{margin:"0 0 4px",fontSize:16,fontWeight:700}}>Xero Connections</h3>
            <p style={{margin:"0 0 16px",fontSize:13,color:"var(--muted)"}}>{adminXeroConnsModal.email}</p>
            {adminXeroConnsLoading ? <div style={{color:"var(--muted)",fontSize:13}}>Loading…</div> : adminXeroConns.length ? adminXeroConns.map((conn,i)=>(
              <div key={i} style={{background:"var(--surface2)",borderRadius:10,padding:"12px 16px",marginBottom:10,border:"1px solid var(--border)"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <span style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>Xero Session {i+1}</span>
                  {conn.clientId && <span style={{fontSize:10,background:"rgba(129,140,248,0.12)",color:"#818cf8",padding:"2px 8px",borderRadius:20,fontWeight:600}}>Custom Client ID</span>}
                </div>
                {conn.connectedAt && <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>Connected: {new Date(conn.connectedAt).toLocaleString()}</div>}
                {conn.expiresAt && <div style={{fontSize:11,color:"var(--muted)",marginBottom:8}}>Token expires: {new Date(conn.expiresAt).toLocaleString()}</div>}
                {conn.tenants && conn.tenants.length > 0 ? (
                  <div>
                    <div style={{fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.6,marginBottom:6}}>Connected Xero Orgs ({conn.tenants.length})</div>
                    {conn.tenants.map((t,ti)=>(
                      <div key={ti} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderTop:"1px solid var(--border)"}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:"#22c55e",flexShrink:0}} />
                        <span style={{fontSize:13,fontWeight:500,color:"var(--text)"}}>{t.tenantName||t.orgName||"Unknown org"}</span>
                        <span style={{fontSize:10,color:"var(--muted)",marginLeft:"auto",fontFamily:"monospace"}}>{(t.tenantId||"").slice(0,8)}…</span>
                      </div>
                    ))}
                    {conn.tenantsUpdatedAt && <div style={{fontSize:10,color:"var(--muted)",marginTop:6}}>Last synced: {new Date(conn.tenantsUpdatedAt).toLocaleString()}</div>}
                  </div>
                ) : <div style={{fontSize:12,color:"var(--muted)",fontStyle:"italic"}}>No org info yet — user needs to connect to Xero first to populate this.</div>}
              </div>
            )) : <div style={{color:"var(--muted)",fontSize:13,marginBottom:12}}>No active Xero sessions.</div>}
            <div style={{display:"flex",gap:10,marginTop:16}}>
              <button className="btn ghost" style={{flex:1}} onClick={()=>setAdminXeroConnsModal(null)}>Close</button>
              {adminXeroConns.length>0 && <button className="btn ghost" style={{color:"#ef4444",borderColor:"#ef4444"}} onClick={()=>revokeXeroConns(adminXeroConnsModal)} disabled={adminXeroConnsRevoking}>{adminXeroConnsRevoking?"Revoking…":"Revoke All"}</button>}
            </div>
          </div>
        </div>
      )}
      {<div className="admin-shell">{<div className="admin-topbar">{<div className="admin-topbar__brand">{<div className="admin-topbar__logo"/>}<span>ImportMyBooks</span></div>}<div className="admin-topbar__divider"/><span className="admin-topbar__badge">Admin</span><div className="admin-topbar__spacer"/><div className="admin-topbar__actions">{adminAuthed&&<button className="btn ghost btn-compact" type="button" onClick={handleAdminLogout}>Logout</button>}<button className="btn ghost btn-compact" onClick={()=>navigate("/")}>← App</button></div></div>}{!adminAuthed ? <div className="admin-login-wrap"><div className="admin-card admin-card--login"><h2>Admin Login</h2><p className="admin-note">First login password becomes permanent.</p><label className="field"><span>Email</span><input type="email" value={adminEmail} disabled /></label><label className="field"><span>Password</span><input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} /></label>{adminError ? <div className="status-banner">{adminError}</div> : null}<div className="actions"><button className="btn primary" onClick={handleAdminLogin} disabled={adminLoading}>{adminLoading ? "Working..." : "Login"}</button></div></div></div> : <div className="admin-body"><div className="admin-sidebar">{[{key:"overview",label:"Overview",icon:"▦"},{key:"analytics",label:"Analytics",icon:"▤"},{key:"users",label:"Users",icon:"◉"},{key:"live",label:"Live",icon:"◎"},{key:"health",label:"Health",icon:"♡"},{key:"history",label:"Imports",icon:"◑"},{key:"settings",label:"Settings",icon:"⊞"},{key:"security",label:"Security",icon:"⚿"},{key:"api",label:"API Usage",icon:"⚡"}].map(({key,label,icon})=><button key={key} type="button" className={`admin-nav-item${adminActiveTab===key?" admin-nav-item--active":""}`} onClick={()=>{setAdminActiveTab(key);if(key==="live")loadAdminLive();if(key==="health")loadAdminHealth();if(key==="security")loadAuditLog();}}><span className="admin-nav-item__icon">{icon}</span>{label}</button>)}</div><div className="admin-main">{adminActiveTab==="overview"&&<>{adminAnalytics&&<div className="admin-metrics">{[{cls:"teal",label:"Total Exports",val:formatCount(adminTotals.exports),sub:`Ready ${formatCount(adminTotals.exportsReady)} · Errors ${formatCount(adminTotals.exportsError)}`},{cls:"indigo",label:"Users",val:formatCount(adminTotals.activeUsers),sub:`Disabled ${formatCount(adminTotals.disabledUsers)}`},{cls:"green",label:"Success Rate",val:formatPercent(adminAnalytics?.successRate?.readyPct),sub:`Avg ${formatDuration(adminAnalytics?.avgDurationMs)||"-"}`},{cls:"amber",label:"Queue",val:formatCount(adminTotals.exportsQueued),sub:`Latest ${adminAnalytics?.latestExportAt?formatDateTime(adminAnalytics.latestExportAt):"-"}`}].map(({cls,label,val,sub})=><div key={cls} className={`admin-metric-card admin-metric-card--${cls}`}><p>{label}</p><h3>{val}</h3><span>{sub}</span></div>)}</div>}{<div className="admin-card">{<div className="admin-card__header">{<div>{<h2>User Limits</h2>}{<p>Manage maximum allowed users.</p>}</div>}{<button className="btn ghost btn-compact" onClick={() => {
                loadAdminSettings();
                loadAdminUsers();
                loadAdminTypes();
                loadAdminAnalytics();
                loadApiUsage();
              }} disabled={adminLoading}>{adminLoading ? "Loading..." : "Refresh"}</button>}</div>}{<div className="admin-card__content">{<label className="field">{<span>Max Users</span>}{<input type="number" min="1" value={adminLimit} onChange={e => setAdminLimit(e.target.value)} />}</label>}{<div className="admin-panel__meta">{"Current users: "}{adminSettings?.currentUsers ?? "-"}</div>}{<div className="actions">{<button className="btn primary" onClick={handleSaveAdminSettings} disabled={adminLoading}>{adminLoading ? "Saving..." : "Save Settings"}</button>}{<button className="btn ghost" type="button" onClick={handleAdminLogout} disabled={adminLoading}>Logout Admin</button>}</div>}{adminError ? <div className="status-banner">{adminError}</div> : null}{adminSuccess ? <div className="status-banner">{adminSuccess}</div> : null}</div>}</div>}</>}{adminActiveTab==="analytics"&&<>{<div className="admin-card admin-card--analytics">{<div className="admin-card__header">{<div>{<h2>Analytics</h2>}{<p>Power BI style overview for owner visibility.</p>}</div>}{<div className="admin-analytics-actions">{<select value={adminAnalyticsDays} onChange={e => {
                  const next = Number.parseInt(e.target.value, 10);
                  setAdminAnalyticsDays(next);
                  loadAdminAnalytics("", next);
                }}>{<option value={7}>Last 7 days</option>}{<option value={30}>Last 30 days</option>}{<option value={90}>Last 90 days</option>}{<option value={180}>Last 180 days</option>}{<option value={365}>Last 12 months</option>}</select>}{<button className="btn ghost btn-compact" type="button" onClick={() => loadAdminAnalytics()} disabled={adminAnalyticsLoading}>{adminAnalyticsLoading ? "Loading..." : "Refresh"}</button>}</div>}</div>}{<div className="admin-card__content">{<div className="admin-filter-bar">{<label className="field">{<span>Tenant Filter</span>}{<select value={adminFilterTenant} onChange={e => setAdminFilterTenant(e.target.value)}>{<option value="">All tenants</option>}{adminTenants.map(tenant => <option value={tenant}>{tenant}</option>)}</select>}</label>}{<label className="field">{<span>User Filter</span>}{<select value={adminFilterUser} onChange={e => setAdminFilterUser(e.target.value)}>{<option value="">All users</option>}{adminUsersList.map(userEmail => <option value={userEmail}>{userEmail}</option>)}</select>}</label>}{<div className="admin-filter-actions">{<button className="btn ghost btn-compact" type="button" onClick={() => {
                    setAdminFilterTenant("");
                    setAdminFilterUser("");
                  }}>Clear Filters</button>}{<button className="btn ghost btn-compact" type="button" onClick={handleClearAllExports} disabled={adminCleanupLoading}>{adminCleanupLoading ? "Clearing..." : "Clear All Exports"}</button>}</div>}</div>}{<div className="admin-chart-filter">{[{
                  key: "line",
                  label: "Exports/Day"
                }, {
                  key: "monthlyTenants",
                  label: "Monthly Tenants"
                }, {
                  key: "userWorkload",
                  label: "User Workload"
                }, {
                  key: "statusSplit",
                  label: "Status Split"
                }, {
                  key: "monthlyUsers",
                  label: "Monthly Users"
                }, {
                  key: "userStatusMix",
                  label: "User Status Mix"
                }, {
                  key: "userTenants",
                  label: "User -> Tenants"
                }, {
                  key: "tenantUserMatrix",
                  label: "Tenant × User"
                }, {
                  key: "recentActivity",
                  label: "Recent Activity"
                }].map(item => <label className="admin-chart-chip">{<input type="checkbox" checked={isChartEnabled(item.key)} onChange={() => toggleChart(item.key)} />}{item.label}</label>)}</div>}{adminAnalyticsError ? <div className="status-banner">{adminAnalyticsError}</div> : null}{adminCleanupStatus ? <div className="status-banner">{adminCleanupStatus}</div> : null}{!adminAnalytics && !adminAnalyticsLoading ? <div className="status-banner">No analytics yet.</div> : null}{adminAnalytics ? <div className="admin-analytics">{<div className="admin-metrics">{<div className="admin-metric-card">{<p>Total Exports</p>}{<h3>{formatCount(adminTotals.exports)}</h3>}{<span>{"Ready "}{formatCount(adminTotals.exportsReady)}{" · Errors"}{" "}{formatCount(adminTotals.exportsError)}</span>}</div>}{<div className="admin-metric-card">{<p>Users</p>}{<h3>{formatCount(adminTotals.activeUsers)}</h3>}{<span>{"Active · Disabled "}{formatCount(adminTotals.disabledUsers)}</span>}</div>}{<div className="admin-metric-card">{<p>Success Rate</p>}{<h3>{formatPercent(adminAnalytics?.successRate?.readyPct)}</h3>}{<span>Avg time{" "}{formatDuration(adminAnalytics?.avgDurationMs) || "-"}</span>}</div>}{<div className="admin-metric-card">{<p>Latest Export</p>}{<h3>{adminAnalytics?.latestExportAt ? formatDateTime(adminAnalytics.latestExportAt) : "-"}</h3>}{<span>{"Queue "}{formatCount(adminTotals.exportsQueued)}</span>}</div>}</div>}{<div className="admin-analytics-grid">{isChartEnabled("line") ? <div className="admin-chart">{<div className="admin-chart__header">{<h4>Exports per day</h4>}{<span>{adminAnalytics.rangeDays}{" days"}</span>}</div>}{<svg className="admin-line-chart" viewBox="0 0 400 160" role="img" aria-label="Exports per day">{<path className="admin-line-chart__grid" d="M 0 140 L 400 140" />}{<path className="admin-line-chart__path" d={linePath} />}{linePoints.map((point, index) => {
                        const x = index / (linePoints.length - 1 || 1) * 400;
                        const y = 140 - point.value / maxVolume * 140;
                        return <circle cx={x} cy={y} r="3" className="admin-line-chart__dot">{<title>{point.label}{": "}{point.value}</title>}</circle>;
                      })}</svg>}</div> : null}{isChartEnabled("monthlyTenants") ? <div className="admin-chart admin-chart--bar">{<div className="admin-chart__header">{<h4>Monthly Tenants</h4>}{<span>Tenants worked per month</span>}</div>}{<div className="admin-month-bars">{monthlyTenantCounts.length ? monthlyTenantCounts.map(item => <button className="admin-month-bar" type="button" onMouseEnter={() => setHoverTenantMonth(item)} onFocus={() => setHoverTenantMonth(item)} onMouseLeave={() => setHoverTenantMonth(null)} onBlur={() => setHoverTenantMonth(null)}>{<div className="admin-month-bar__fill" style={{
                          height: `${Math.round(item.tenantCount / getMax(monthlyTenantCounts, "tenantCount") * 100)}%`
                        }} />}{<span className="admin-month-bar__label">{formatMonthLabel(item.month)}</span>}</button>) : <div className="status-banner">No monthly tenant data yet.</div>}</div>}{hoverTenantMonth ? <div className="admin-tooltip">{<strong>{formatMonthLabel(hoverTenantMonth.month)}</strong>}{<span>Tenants:{" "}{formatCount(hoverTenantMonth.tenantCount)}</span>}{<span>Exports:{" "}{formatCount(hoverTenantMonth.exportCount)}</span>}</div> : null}</div> : null}{isChartEnabled("userWorkload") ? <div className="admin-chart admin-chart--list">{<div className="admin-chart__header">{<h4>User Workload</h4>}{<span>Most active users</span>}</div>}{<div className="admin-mini-list">{topUsers.length ? topUsers.map(item => <div className="admin-mini-row">{<div className="admin-mini-row__label">{item.email}</div>}{<div className="admin-mini-row__bar">{<div className="admin-mini-row__fill" style={{
                            width: `${Math.round(item.count / getMax(topUsers, "count") * 100)}%`
                          }} />}</div>}{<div className="admin-mini-row__value">{formatCount(item.count)}</div>}</div>) : <div className="status-banner">No user activity yet.</div>}</div>}</div> : null}</div>}{<div className="admin-analytics-grid">{isChartEnabled("statusSplit") ? <div className="admin-chart admin-chart--donut">{<div className="admin-chart__header">{<h4>Status Split</h4>}{<span>All exports</span>}</div>}{<div className="admin-donut">{<svg viewBox="0 0 160 160" aria-label="Status split">{donutSegments.reduce((acc, segment, index) => {
                          const radius = 60;
                          const circumference = 2 * Math.PI * radius;
                          const offset = acc.offset;
                          const length = segment.pct * circumference;
                          acc.offset += length;
                          acc.segments.push(<circle cx="80" cy="80" r={radius} fill="transparent" stroke={donutColors[segment.key] || "#2f6bff"} strokeWidth="18" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />);
                          return acc;
                        }, {
                          offset: 0,
                          segments: []
                        }).segments}{<circle cx="80" cy="80" r="42" fill="#ffffff" />}</svg>}{<div className="admin-donut__center">{<strong>{formatCount(statusTotal)}</strong>}{<span>Total</span>}</div>}</div>}{<div className="admin-donut-legend">{donutSegments.map(segment => <div className="admin-donut-legend__item">{<span className="admin-donut-legend__swatch" style={{
                          backgroundColor: donutColors[segment.key] || "#2f6bff"
                        }} />}{<span>{segment.label}</span>}{<strong>{formatCount(segment.count)}</strong>}</div>)}</div>}</div> : null}{isChartEnabled("monthlyUsers") ? <div className="admin-chart admin-chart--bar">{<div className="admin-chart__header">{<h4>Monthly User Exports</h4>}{<span>Top users by month</span>}</div>}{<div className="admin-month-bars admin-month-bars--stacked">{monthlyUserCounts.length ? monthlyUserCounts.map(item => {
                        const total = item.users.reduce((sum, user2) => sum + user2.count, 0);
                        return <button className="admin-month-bar admin-month-bar--stacked" type="button" onMouseEnter={() => setHoverUserMonth(item)} onFocus={() => setHoverUserMonth(item)} onMouseLeave={() => setHoverUserMonth(null)} onBlur={() => setHoverUserMonth(null)}>{<div className="admin-month-bar__stack">{item.users.map(user2 => <span style={{
                              height: `${total ? user2.count / total * 100 : 0}%`
                            }} />)}</div>}{<span className="admin-month-bar__label">{formatMonthLabel(item.month)}</span>}</button>;
                      }) : <div className="status-banner">No monthly user data yet.</div>}</div>}{hoverUserMonth ? <div className="admin-tooltip">{<strong>{formatMonthLabel(hoverUserMonth.month)}</strong>}{hoverUserMonth.users.map(user2 => <span>{user2.email}{": "}{formatCount(user2.count)}</span>)}</div> : null}</div> : null}{isChartEnabled("userStatusMix") ? <div className="admin-chart admin-chart--list">{<div className="admin-chart__header">{<h4>User Status Mix</h4>}{<span>Top 6 users</span>}</div>}{<div className="admin-stacked-list">{userStatusBreakdown.length ? userStatusBreakdown.map(item => {
                        const total = item.total || 0;
                        const ready = item.statuses.ready || 0;
                        const error = item.statuses.error || 0;
                        const queued = item.statuses.queued || 0;
                        const running = item.statuses.running || 0;
                        const noRecords = item.statuses.no_records || 0;
                        return <div className="admin-stacked-row">{<div className="admin-stacked-row__label">{item.email}</div>}{<div className="admin-stacked-row__bar">{<span style={{
                              width: total ? `${ready / total * 100}%` : "0%",
                              background: donutColors.ready
                            }} />}{<span style={{
                              width: total ? `${running / total * 100}%` : "0%",
                              background: donutColors.running
                            }} />}{<span style={{
                              width: total ? `${queued / total * 100}%` : "0%",
                              background: donutColors.queued
                            }} />}{<span style={{
                              width: total ? `${noRecords / total * 100}%` : "0%",
                              background: donutColors.no_records
                            }} />}{<span style={{
                              width: total ? `${error / total * 100}%` : "0%",
                              background: donutColors.error
                            }} />}</div>}{<div className="admin-stacked-row__value">{formatCount(total)}</div>}</div>;
                      }) : <div className="status-banner">No user status data yet.</div>}</div>}</div> : null}{isChartEnabled("userTenants") ? <div className="admin-chart admin-chart--list">{<div className="admin-chart__header">{<h4>{"User -> Tenants"}</h4>}{<span>Who worked on what</span>}</div>}{<div className="admin-mini-list">{topUserTenants.length ? topUserTenants.map(item => <div className="admin-mini-row">{<div className="admin-mini-row__label">{item.email}</div>}{<div className="admin-mini-row__value">{item.tenants.map(tenant => tenant.tenant).join(", ")}</div>}</div>) : <div className="status-banner">No tenant activity yet.</div>}</div>}</div> : null}</div>}{isChartEnabled("tenantUserMatrix") ? <div className="admin-chart admin-chart--table">{<div className="admin-chart__header">{<h4>Tenant x User Exports</h4>}{<span>Who exported which tenant</span>}</div>}{tenantUserMatrix.length ? <div className="admin-matrix">{<div className="admin-matrix__header">{<span>Tenant</span>}{tenantUserMatrix[0]?.users?.map(user2 => <span title={user2.email}>{user2.email}</span>)}{<span>Total</span>}</div>}{tenantUserMatrix.map(row => <div className="admin-matrix__row">{<span className="admin-matrix__tenant">{row.tenant}</span>}{row.users.map(user2 => <span className={`admin-matrix__cell ${user2.count ? "is-active" : ""}`}>{formatCount(user2.count)}</span>)}{<span className="admin-matrix__total">{formatCount(row.total)}</span>}</div>)}</div> : <div className="status-banner">No tenant-user data yet.</div>}</div> : null}{isChartEnabled("recentActivity") ? <div className="admin-chart admin-chart--table">{<div className="admin-chart__header">{<h4>Recent User Activity</h4>}{<span>Latest exports</span>}</div>}{recentActivity.length ? <div className="admin-activity">{<div className="admin-activity__header">{<span>User</span>}{<span>Tenant</span>}{<span>Status</span>}{<span>When</span>}{<span>Count</span>}</div>}{recentActivity.map(item => <div className="admin-activity__row">{<span>{item.email}</span>}{<span>{item.tenant}</span>}{<span className={`status-pill status-${item.status}`}>{item.status}</span>}{<span>{formatDateTime(item.createdAt)}</span>}{<span>{formatCount(item.count)}</span>}</div>)}</div> : <div className="status-banner">No recent activity.</div>}</div> : null}</div> : null}</div>}</div>}</>}{adminActiveTab==="settings"&&(<>
  <div className="admin-card" style={{marginBottom:20}}>
    <div className="admin-card__header"><div><h2>Type Access</h2><p>Selected types will be allowed for export.</p></div></div>
    <div className="admin-card__content">
      <div className="admin-type-list">{adminTypes.map(type=><label key={type} className="type-item"><input type="checkbox" checked={adminTypeSelection.includes(type)} onChange={e=>toggleAdminType(type,e.target.checked)} />{type}</label>)}</div>
      <div className="actions"><button className="btn ghost btn-compact" type="button" onClick={()=>setAdminTypeSelection(adminTypes)}>Select All</button><button className="btn ghost btn-compact" type="button" onClick={()=>setAdminTypeSelection([])}>Clear All</button></div>
    </div>
  </div>
  <div className="admin-card" style={{marginBottom:20}}>
    <div className="admin-card__header"><div><h2>📢 Broadcast Message</h2><p>Show a notice to all logged-in users.</p></div></div>
    <div className="admin-card__content">
      <textarea value={adminBroadcastMsg} onChange={e=>setAdminBroadcastMsg(e.target.value.slice(0,500))} placeholder="e.g. Maintenance on Sunday 2am–4am IST. Imports will be paused." rows={3} style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,resize:"vertical",marginBottom:4}} />
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <span style={{fontSize:11,color:"var(--muted)"}}>{adminBroadcastMsg.length}/500</span>
        {adminBroadcastMsg && <span style={{fontSize:11,color:"#f59e0b"}}>⚠ Broadcast is active</span>}
      </div>
      <div style={{display:"flex",gap:8}}>
        <button className="btn ghost btn-compact" type="button" onClick={()=>{setAdminBroadcastMsg("");saveBroadcast();}}>Clear</button>
        <button className="btn primary btn-compact" type="button" onClick={saveBroadcast} disabled={adminBroadcastSaving}>{adminBroadcastSaving?"Saving…":"Save Broadcast"}</button>
      </div>
    </div>
  </div>
  <div className="admin-card">
    <div className="admin-card__header"><div><h2>🔧 Maintenance Mode</h2><p>Lock out all users while you perform maintenance.</p></div></div>
    <div className="admin-card__content">
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
        <div style={{position:"relative",width:44,height:24}}>
          <input type="checkbox" checked={adminMaintenanceMode} onChange={e=>saveMaintenance(e.target.checked,adminMaintenanceBanner)} style={{opacity:0,position:"absolute",inset:0,cursor:"pointer",zIndex:1}} />
          <div style={{position:"absolute",inset:0,borderRadius:12,background:adminMaintenanceMode?"#ef4444":"var(--border)",transition:"background 0.2s"}} />
          <div style={{position:"absolute",top:2,left:adminMaintenanceMode?22:2,width:20,height:20,borderRadius:"50%",background:"#fff",transition:"left 0.2s",boxShadow:"0 1px 3px rgba(0,0,0,0.3)"}} />
        </div>
        <span style={{fontWeight:600,color:adminMaintenanceMode?"#ef4444":"var(--text)"}}>{adminMaintenanceMode?"MAINTENANCE ON — Users cannot access the app":"Maintenance Off"}</span>
      </div>
      <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>Banner Message</label>
      <input type="text" value={adminMaintenanceBanner} onChange={e=>setAdminMaintenanceBanner(e.target.value)} placeholder="e.g. Server under maintenance. Back in 30 minutes." style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,marginBottom:12}} />
      <button className="btn ghost btn-compact" type="button" onClick={()=>saveMaintenance(adminMaintenanceMode,adminMaintenanceBanner)} disabled={adminMaintenanceSaving}>{adminMaintenanceSaving?"Saving…":"Save Banner"}</button>
    </div>
  </div>
  <div className="admin-card" style={{marginBottom:24}}>
    <div className="admin-card__header"><div><h2>🎬 Landing Page Videos</h2><p>Paste YouTube video IDs to show tutorial videos on the landing page.</p></div></div>
    <div className="admin-card__content">
      {[{key:"video1",label:"Video 1 — Overview / How It Works"},{key:"video2",label:"Video 2 — Import Tutorial"},{key:"video3",label:"Video 3 — Auto Allocation / Advanced"}].map(({key,label})=>(
        <div key={key} style={{marginBottom:16}}>
          <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.7}}>{label}</label>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <input type="text" value={adminLandingVideos[key]||""} onChange={e=>setAdminLandingVideos(v=>({...v,[key]:e.target.value.trim().replace(/[^a-zA-Z0-9_-]/g,"").slice(0,20)}))} placeholder="e.g. dQw4w9WgXcQ" style={{flex:1,padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13,fontFamily:"monospace"}} />
            {adminLandingVideos[key] && <a href={`https://www.youtube.com/watch?v=${adminLandingVideos[key]}`} target="_blank" rel="noreferrer" style={{fontSize:12,color:"#2dd4bf",whiteSpace:"nowrap"}}>▶ Preview</a>}
          </div>
          {adminLandingVideos[key] && <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>youtube.com/watch?v=<strong style={{color:"var(--text)"}}>{adminLandingVideos[key]}</strong></div>}
        </div>
      ))}
      <div style={{display:"flex",gap:8,marginTop:4}}>
        <button className="btn primary btn-compact" type="button" onClick={saveAdminLandingVideos} disabled={adminLandingVideosSaving}>{adminLandingVideosSaving?"Saving…":"Save Videos"}</button>
        <span style={{fontSize:12,color:"var(--muted)",alignSelf:"center"}}>Leave blank to hide a video section on the landing page.</span>
      </div>
    </div>
  </div>
</>)}{adminActiveTab==="users"&&(<>
  <div className="admin-card" style={{marginBottom:24}}>
    <div className="admin-card__header">
      <div><h2>Users</h2><p>Manage plans, access and passwords for all accounts.</p></div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:12,color:"var(--muted)"}}>{adminUsers.length} total</span>
        <button className="btn ghost btn-compact" type="button" onClick={downloadUsersCsv} style={{fontSize:11}}>↓ CSV</button>
        <button className="btn ghost btn-compact" type="button" onClick={loadAdminUsers} disabled={adminLoading}>{adminLoading?"Loading…":"Refresh"}</button>
      </div>
    </div>
    {adminSelectedUsers.size>0 && (
      <div style={{padding:"10px 16px",borderBottom:"1px solid var(--border)",background:"rgba(99,102,241,0.08)",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <span style={{fontSize:13,fontWeight:600,color:"#818cf8"}}>{adminSelectedUsers.size} selected</span>
        <button className="btn ghost btn-compact" type="button" onClick={()=>handleBulkAction("enable")} disabled={adminBulkLoading} style={{fontSize:11,color:"#22c55e",borderColor:"rgba(34,197,94,0.4)"}}>Enable All</button>
        <button className="btn ghost btn-compact" type="button" onClick={()=>handleBulkAction("disable")} disabled={adminBulkLoading} style={{fontSize:11,color:"#f59e0b",borderColor:"rgba(245,158,11,0.4)"}}>Disable All</button>
        <button className="btn ghost btn-compact" type="button" onClick={()=>handleBulkAction("delete")} disabled={adminBulkLoading} style={{fontSize:11,color:"#ef4444",borderColor:"rgba(239,68,68,0.4)"}}>Delete All</button>
        <button className="btn ghost btn-compact" type="button" onClick={()=>setAdminSelectedUsers(new Set())} style={{fontSize:11}}>Clear</button>
        {adminBulkLoading && <span style={{fontSize:11,color:"var(--muted)"}}>Working…</span>}
      </div>
    )}
    <div className="admin-card__content" style={{padding:0,overflowX:"auto"}}>
      {adminUsers.length ? (
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:900}}>
          <thead>
            <tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
              <th style={{padding:"10px 12px",width:36}}>
                <input type="checkbox" checked={adminUsers.length>0&&adminSelectedUsers.size===adminUsers.length} onChange={e=>{if(e.target.checked)setAdminSelectedUsers(new Set(adminUsers.map(u=>u.id)));else setAdminSelectedUsers(new Set());}} style={{cursor:"pointer"}} />
              </th>
              <th style={{padding:"10px 16px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>User</th>
              <th style={{padding:"10px 16px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Plan</th>
              <th style={{padding:"10px 16px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Role</th>
              <th style={{padding:"10px 16px",textAlign:"center",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Imports</th>
              <th style={{padding:"10px 16px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Last Login</th>
              <th style={{padding:"10px 16px",textAlign:"center",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Status</th>
              <th style={{padding:"10px 16px",textAlign:"center",fontWeight:600,color:"var(--muted)",fontSize:11,textTransform:"uppercase",letterSpacing:0.7,whiteSpace:"nowrap"}}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {adminUsers.map((userItem,i)=>{
              const planColors={starter:"#6b7280",professional:"#6366f1",enterprise:"#f59e0b",testing:"#34d399"};
              const planBg={starter:"rgba(107,114,128,0.1)",professional:"rgba(99,102,241,0.1)",enterprise:"rgba(245,158,11,0.1)",testing:"rgba(52,211,153,0.1)"};
              const planLabel={starter:"Starter",professional:"Professional",enterprise:"Enterprise",testing:"Testing"};
              const currentPlan=userItem.plan||"starter";
              const isSelected=adminSelectedUsers.has(userItem.id);
              return (
                <tr key={userItem.id} style={{borderBottom:"1px solid var(--border)",background:isSelected?"rgba(99,102,241,0.06)":i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
                  <td style={{padding:"12px 12px",textAlign:"center"}}>
                    <input type="checkbox" checked={isSelected} onChange={e=>{const s=new Set(adminSelectedUsers);if(e.target.checked)s.add(userItem.id);else s.delete(userItem.id);setAdminSelectedUsers(s);}} style={{cursor:"pointer"}} />
                  </td>
                  <td style={{padding:"12px 16px",minWidth:200}}>
                    <div style={{fontWeight:600,fontSize:13,color:"var(--text)",wordBreak:"break-word"}}>{userItem.email}</div>
                    {userItem.xeroClientId && <div style={{fontSize:10,color:"#818cf8",marginTop:2}}>🔑 Custom Client ID</div>}
                    {userItem.note && <div style={{fontSize:11,color:"#f59e0b",marginTop:2,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>Note: {userItem.note}</div>}
                    <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>Joined {userItem.createdAt?formatDateTime(userItem.createdAt):"—"}</div>
                  </td>
                  <td style={{padding:"12px 16px",minWidth:160}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                      <span style={{display:"inline-block",padding:"2px 9px",borderRadius:20,fontSize:10,fontWeight:700,background:planBg[currentPlan],color:planColors[currentPlan],border:`1px solid ${planColors[currentPlan]}55`,whiteSpace:"nowrap"}}>{planLabel[currentPlan]}</span>
                      {userItem.customLimits && <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10,background:"rgba(245,158,11,0.15)",color:"#f59e0b",border:"1px solid rgba(245,158,11,0.3)"}}>CUSTOM</span>}
                      <select value={currentPlan} onChange={e=>handleSetUserPlan(userItem.id,e.target.value,30)} disabled={adminUserPlanSaving===userItem.id} style={{fontSize:12,padding:"3px 8px",background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:6,color:"var(--text)",cursor:"pointer"}}>
                        <option value="starter">Starter</option>
                        <option value="professional">Professional</option>
                        <option value="enterprise">Enterprise</option>
                        <option value="growth">Growth</option>
                      </select>
                      {adminUserPlanSaving===userItem.id && <span style={{fontSize:11,color:"var(--muted)"}}>Saving…</span>}
                      {(()=>{if(!userItem.planExpiry||userItem.plan==="team"||userItem.plan==="none")return null;const ms=new Date(userItem.planExpiry)-Date.now();const d=Math.ceil(ms/86400000);const expStr=new Date(userItem.planExpiry).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"});if(d<=0)return<div style={{display:"flex",flexDirection:"column",gap:2}}><span style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:10,background:"rgba(239,68,68,0.12)",color:"#f87171",border:"1px solid rgba(239,68,68,0.3)",whiteSpace:"nowrap",display:"inline-block"}}>🚫 Expired</span><span style={{fontSize:10,color:"#f87171",opacity:0.75}}>{expStr}</span></div>;if(d<=7)return<div style={{display:"flex",flexDirection:"column",gap:2}}><span style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:10,background:"rgba(245,158,11,0.12)",color:"#f59e0b",border:"1px solid rgba(245,158,11,0.3)",whiteSpace:"nowrap",display:"inline-block"}}>⏰ {d}d left</span><span style={{fontSize:10,color:"#f59e0b",opacity:0.75}}>{expStr}</span></div>;return<div style={{display:"flex",flexDirection:"column",gap:2}}><span style={{fontSize:11,fontWeight:700,padding:"3px 8px",borderRadius:10,background:"rgba(34,197,94,0.08)",color:"#22c55e",border:"1px solid rgba(34,197,94,0.2)",whiteSpace:"nowrap",display:"inline-block"}}>✓ {d}d left</span><span style={{fontSize:10,color:"#22c55e",opacity:0.7}}>{expStr}</span></div>;})()}
                    </div>
                  </td>
                  <td style={{padding:"12px 16px",minWidth:200}}>
                    {(() => {
                      const isAdmin = userItem.role === "admin";
                      const perms = userItem.permissions || ["import"];
                      const allPerms = [{key:"import",label:"Import"},{key:"export",label:"Export"},{key:"delete",label:"Delete Centre"},{key:"allocation",label:"Auto Allocation"}];
                      if (isAdmin) return <span style={{fontSize:12,color:"#f59e0b",fontWeight:600}}>Admin — Full Access</span>;
                      const isTeamMember = userItem.plan === "team" || userItem.role === "team";
                      return <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        {isTeamMember && <span style={{alignSelf:"flex-start",padding:"2px 8px",borderRadius:12,fontSize:10,fontWeight:700,background:"rgba(56,189,248,0.15)",border:"1px solid rgba(56,189,248,0.4)",color:"#38bdf8",marginBottom:2}}>👥 Team Member</span>}
                        {allPerms.map(p => {
                          const checked = perms.includes(p.key);
                          return <label key={p.key} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:adminUserRoleSaving===userItem.id?"not-allowed":"pointer",opacity:adminUserRoleSaving===userItem.id?0.6:1}}>
                            <input type="checkbox" checked={checked} disabled={adminUserRoleSaving===userItem.id}
                              onChange={() => {
                                const next = checked ? perms.filter(x=>x!==p.key) : [...perms, p.key];
                                handleSetUserPermissions(userItem.id, next);
                              }} style={{accentColor:"#6366f1",width:13,height:13}} />
                            <span style={{color:checked?"var(--text)":"var(--muted)"}}>{p.label}</span>
                          </label>;
                        })}
                        {adminUserRoleSaving===userItem.id && <span style={{fontSize:11,color:"var(--muted)"}}>Saving…</span>}
                      </div>;
                    })()}
                  </td>
                  <td style={{padding:"12px 16px",textAlign:"center",whiteSpace:"nowrap"}}>
                    <div style={{fontWeight:700,fontSize:16,color:"var(--text)"}}>{userItem.importCount||0}</div>
                    <div style={{fontSize:11,color:"var(--muted)"}}>{(userItem.totalImported||0).toLocaleString()} records</div>
                  </td>
                  <td style={{padding:"12px 16px",color:"var(--muted)",fontSize:12,whiteSpace:"nowrap"}}>
                    {userItem.lastLoginAt?formatDateTime(userItem.lastLoginAt):<span style={{opacity:0.5}}>Never</span>}
                  </td>
                  <td style={{padding:"12px 16px",textAlign:"center",whiteSpace:"nowrap"}}>
                    {(()=>{const isExpired=userItem.planExpiry&&new Date(userItem.planExpiry)<new Date()&&userItem.plan!=="none"&&userItem.plan!=="team"&&userItem.plan!=="testing";const isCancelled=userItem.planStatus==="cancelled";const isPending=userItem.planStatus==="pending";const bg=userItem.disabled?"rgba(239,68,68,0.1)":isExpired||isCancelled?"rgba(239,68,68,0.1)":isPending?"rgba(245,158,11,0.12)":"rgba(34,197,94,0.1)";const col=userItem.disabled?"#ef4444":isExpired||isCancelled?"#f87171":isPending?"#f59e0b":"#22c55e";const label=userItem.disabled?"Disabled":isExpired?"Expired":isCancelled?"Cancelled":isPending?"Pending":"Active";return<span style={{display:"inline-block",padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:700,background:bg,color:col,border:`1px solid ${col}40`}}>{label}</span>;})()}
                  </td>
                  <td style={{padding:"12px 16px",textAlign:"center"}}>
                    <div style={{display:"flex",gap:4,justifyContent:"center",flexWrap:"wrap"}}>
                      <button className={`btn ${userItem.disabled?"primary":"ghost"} btn-compact`} type="button" onClick={()=>handleToggleUser(userItem.id,!userItem.disabled)} disabled={adminLoading} style={{fontSize:11,padding:"3px 10px"}}>{userItem.disabled?"Enable":"Disable"}</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>{setAdminUserResetPwModal({userId:userItem.id,email:userItem.email});setAdminUserResetPwValue("");setAdminUserResetPwError("");}} style={{fontSize:11,padding:"3px 10px"}}>Reset PW</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>{setAdminUserNoteModal({userId:userItem.id,email:userItem.email});setAdminUserNoteValue(userItem.note||"");}} style={{fontSize:11,padding:"3px 10px"}}>Note</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>{const cl=userItem.customLimits||{};setAdminCustomLimitsForm({maxRowsPerImport:cl.maxRowsPerImport!==undefined?String(cl.maxRowsPerImport):"",maxOrgs:cl.maxOrgs===null?"unlimited":cl.maxOrgs!==undefined?String(cl.maxOrgs):"",exportAccess:cl.exportAccess!==undefined?cl.exportAccess:"",deleteAccess:cl.deleteAccess!==undefined?cl.deleteAccess:"",manualJournalsAccess:cl.manualJournalsAccess!==undefined?cl.manualJournalsAccess:"",paymentImportAccess:cl.paymentImportAccess!==undefined?cl.paymentImportAccess:"",overpaymentAccess:cl.overpaymentAccess!==undefined?cl.overpaymentAccess:"",allowedImportTypes:cl.allowedImportTypes||[]});setAdminCustomLimitsModal({userId:userItem.id,email:userItem.email,plan:userItem.plan});}} style={{fontSize:11,padding:"3px 10px",color:"#f59e0b",borderColor:"rgba(245,158,11,0.35)"}}>Custom Limits</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>openXeroClientModal(userItem)} style={{fontSize:11,padding:"3px 10px",color:"#818cf8",borderColor:"rgba(129,140,248,0.35)"}}>Xero Client</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>openLoginHistory(userItem)} style={{fontSize:11,padding:"3px 10px"}}>Login Log</button>
                      <button className="btn ghost btn-compact" type="button" onClick={()=>openXeroConns(userItem)} style={{fontSize:11,padding:"3px 10px"}}>Connections</button>
                      {<button className="btn ghost btn-compact" type="button" onClick={()=>{setAdminApproveModal({id:userItem.id,email:userItem.email,plan:userItem.plan,isPaid:false,mode:"set"});setAdminApproveForm({plan:"professional",days:30,customDays:""}); }} style={{fontSize:11,padding:"3px 10px",color:"#818cf8",borderColor:"rgba(129,140,248,0.35)"}}>📋 Set Plan</button>}
                      {userItem.planStatus==="pending"&&<button className="btn primary btn-compact" type="button" onClick={()=>handleApproveTesting(userItem.id,userItem.email,userItem.plan)} disabled={adminApprovingId===userItem.id} style={{fontSize:11,padding:"3px 10px",background:"rgba(52,211,153,0.15)",color:"#34d399",borderColor:"rgba(52,211,153,0.35)"}}>{adminApprovingId===userItem.id?"Approving…":"✓ Approve"}</button>}
                      {userItem.plan&&userItem.plan!=="none"&&userItem.plan!=="team"&&userItem.plan!=="testing"&&<button className="btn ghost btn-compact" type="button" disabled={adminPlanRenewSaving===userItem.id} onClick={()=>{setAdminRenewModal({id:userItem.id,email:userItem.email,plan:userItem.plan,planExpiry:userItem.planExpiry,planStartAt:userItem.planStartAt});setAdminRenewForm({days:30,customDays:""});}} style={{fontSize:11,padding:"3px 10px",color:"#2dd4bf",borderColor:"rgba(45,212,191,0.35)"}}>↻ Renew</button>}
                      {userItem.plan&&userItem.plan!=="none"&&userItem.plan!=="team"&&<button className="btn ghost btn-compact" type="button" disabled={adminPlanCancelSaving===userItem.id} onClick={()=>handleCancelPlanUser(userItem.id,userItem.email,userItem.plan)} style={{fontSize:11,padding:"3px 10px",color:"#f87171",borderColor:"rgba(248,113,113,0.3)"}}>✕ Cancel</button>}
                      {(userItem.plan==="team"||userItem.role==="team")
                        ? <button className="btn ghost btn-compact" type="button" style={{fontSize:11,padding:"3px 10px",color:"#38bdf8",borderColor:"rgba(56,189,248,0.35)"}} onClick={async()=>{if(!window.confirm(`Remove team access from ${userItem.email}?`))return;await fetch(`${API_BASE}/admin/users/${userItem.id}/set-team`,{method:"POST",headers:{"Content-Type":"application/json",...adminHeader},body:JSON.stringify({remove:true})});setAdminUsers(prev=>prev.map(u=>u.id===userItem.id?{...u,plan:"testing",role:"importer",planStatus:"pending"}:u));}}>👥 Remove Team</button>
                        : <button className="btn ghost btn-compact" type="button" style={{fontSize:11,padding:"3px 10px",color:"#38bdf8",borderColor:"rgba(56,189,248,0.25)"}} onClick={async()=>{await fetch(`${API_BASE}/admin/users/${userItem.id}/set-team`,{method:"POST",headers:{"Content-Type":"application/json",...adminHeader},body:JSON.stringify({})});setAdminUsers(prev=>prev.map(u=>u.id===userItem.id?{...u,plan:"team",role:"team",planStatus:"active"}:u));}}>👥 Set Team</button>
                      }
                      <button className="btn ghost btn-compact" type="button" onClick={()=>handleDeleteUser(userItem.id,userItem.email)} disabled={adminLoading} style={{fontSize:11,padding:"3px 10px",color:"#ef4444",borderColor:"rgba(239,68,68,0.35)"}}>Delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <div className="status-banner">No users found.</div>}
    </div>
  </div>
</>)}{adminActiveTab==="history"&&<>{<div className="admin-card" style={{marginBottom:24}}>
  <div className="admin-card__header">
    <div><h2>Import History</h2><p>All imports across all users — paginated view.</p></div>
    <div style={{display:"flex",gap:8,alignItems:"center"}}>
      <span style={{fontSize:12,color:"var(--muted)"}}>{adminImportHistoryTotal} total</span>
      <button className="btn ghost btn-compact" type="button" onClick={() => loadAdminImportHistory(1)} disabled={adminImportHistoryLoading}>{adminImportHistoryLoading ? "Loading…" : "Load"}</button>
    </div>
  </div>
  <div className="admin-card__content" style={{paddingTop:12}}>
    <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap"}}>
      <input type="text" value={adminImportHistoryFilterUser} onChange={e => setAdminImportHistoryFilterUser(e.target.value)} placeholder="Filter by user email…" style={{flex:"1 1 180px",padding:"7px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
      <select value={adminImportHistoryFilterType} onChange={e => setAdminImportHistoryFilterType(e.target.value)} style={{flex:"1 1 160px",padding:"7px 12px",borderRadius:8,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}}>
        <option value="">All types</option>
        <option value="bills">Bills</option>
        <option value="invoices">Invoices</option>
        <option value="credit-notes">Credit Notes</option>
        <option value="spend-money">Spend Money</option>
        <option value="receive-money">Receive Money</option>
        <option value="manual-journals">Manual Journals</option>
        <option value="bill-payments">Bill Payments</option>
        <option value="invoice-payments">Invoice Payments</option>
        <option value="purchase-orders">Purchase Orders</option>
        <option value="quotes">Quotes</option>
        <option value="update-status">Bulk Status Update</option>
      </select>
      <button className="btn ghost btn-compact" type="button" onClick={() => { setAdminImportHistoryFilterUser(""); setAdminImportHistoryFilterType(""); loadAdminImportHistory(1,"",""); }} style={{whiteSpace:"nowrap"}}>Clear</button>
      <button className="btn primary btn-compact" type="button" onClick={() => loadAdminImportHistory(1)} disabled={adminImportHistoryLoading} style={{whiteSpace:"nowrap"}}>Search</button>
    </div>
    {adminImportHistory.length > 0 ? (
      <>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:700}}>
            <thead>
              <tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
                <th style={{padding:"8px 12px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>User</th>
                <th style={{padding:"8px 12px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Type</th>
                <th style={{padding:"8px 12px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Org</th>
                <th style={{padding:"8px 12px",textAlign:"center",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Created</th>
                <th style={{padding:"8px 12px",textAlign:"center",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Errors</th>
                <th style={{padding:"8px 12px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Status</th>
                <th style={{padding:"8px 12px",textAlign:"left",fontWeight:600,color:"var(--muted)",fontSize:10,textTransform:"uppercase",letterSpacing:0.7}}>Date</th>
              </tr>
            </thead>
            <tbody>
              {adminImportHistory.map((h, i) => {
                const typeLabel = {bills:"Bills",invoices:"Invoices","credit-notes":"Credit Notes","spend-money":"Spend Money","receive-money":"Receive Money","manual-journals":"Manual Journals","bill-payments":"Bill Payments","invoice-payments":"Invoice Payments","purchase-orders":"Purchase Orders","quotes":"Quotes","update-status":"Status Update","credit-note-refunds":"CN Refunds","customers":"Customers","vendors":"Vendors","accounts":"Accounts","items":"Items","tracking-categories":"Tracking"}[h.importType] || h.importType;
                return (
                  <tr key={h.id || i} style={{borderBottom:"1px solid var(--border)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
                    <td style={{padding:"9px 12px",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--muted)",fontSize:12}}>{h.userEmail || "—"}</td>
                    <td style={{padding:"9px 12px",whiteSpace:"nowrap"}}><span style={{fontWeight:600,color:"var(--text)",fontSize:12}}>{typeLabel}</span></td>
                    <td style={{padding:"9px 12px",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--muted)",fontSize:12}}>{h.orgName || "—"}</td>
                    <td style={{padding:"9px 12px",textAlign:"center",fontWeight:700,color:"#22c55e",fontSize:13}}>{h.created || 0}</td>
                    <td style={{padding:"9px 12px",textAlign:"center",fontWeight:h.errors>0?700:400,color:h.errors>0?"#ef4444":"var(--muted)",fontSize:13}}>{h.errors || 0}</td>
                    <td style={{padding:"9px 12px"}}><span style={{fontSize:11,padding:"2px 8px",borderRadius:10,background:h.undone?"rgba(239,68,68,0.1)":h.status==="done"?"rgba(34,197,94,0.1)":"rgba(99,102,241,0.1)",color:h.undone?"#ef4444":h.status==="done"?"#22c55e":"#6366f1",fontWeight:600}}>{h.undone?"Undone":h.status||"done"}</span></td>
                    <td style={{padding:"9px 12px",color:"var(--muted)",fontSize:11,whiteSpace:"nowrap"}}>{h.date ? formatDateTime(h.date) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {adminImportHistoryPages > 1 && (
          <div style={{display:"flex",gap:8,justifyContent:"center",alignItems:"center",marginTop:16}}>
            <button className="btn ghost btn-compact" type="button" disabled={adminImportHistoryPage<=1||adminImportHistoryLoading} onClick={() => loadAdminImportHistory(adminImportHistoryPage-1)}>← Prev</button>
            <span style={{fontSize:13,color:"var(--muted)"}}>Page {adminImportHistoryPage} of {adminImportHistoryPages} &nbsp;·&nbsp; {adminImportHistoryTotal} records</span>
            <button className="btn ghost btn-compact" type="button" disabled={adminImportHistoryPage>=adminImportHistoryPages||adminImportHistoryLoading} onClick={() => loadAdminImportHistory(adminImportHistoryPage+1)}>Next →</button>
          </div>
        )}
      </>
    ) : (
      <div className="status-banner">{adminImportHistoryLoading ? "Loading import history…" : "Click Load to view import history."}</div>
    )}
  </div>
</div>}</>}{adminActiveTab==="api"&&(<>
  <div className="admin-card">
    <div className="admin-card__header"><div><h2>Xero API Usage</h2><p>Calls made to Xero API today and recent history.</p></div><button className="btn ghost btn-compact" type="button" onClick={()=>loadApiUsage()} disabled={apiUsageLoading}>{apiUsageLoading?"Loading...":"Refresh"}</button></div>
    <div className="admin-card__content">
      {apiUsageError?<div className="status-banner">{apiUsageError}</div>:null}
      {!apiUsage&&!apiUsageLoading?<div className="status-banner">Click Refresh to load API usage data.</div>:null}
      {apiUsage?(<>
        <div className="admin-panel__meta">Date: {apiUsage.date} · Total calls today: {apiUsage.total??Object.values(apiUsage.byFeature||{}).reduce((a,b)=>a+b,0)}</div>
        {Object.keys(apiUsage.byFeature||{}).length>0?<div className="admin-user-list" style={{marginTop:8}}>{Object.entries(apiUsage.byFeature).sort((a,b)=>b[1]-a[1]).map(([feat,cnt])=><div className="admin-user" key={feat}><div className="admin-user__email">{feat}</div><strong style={{minWidth:40,textAlign:"right"}}>{cnt}</strong></div>)}</div>:<div className="status-banner">No API calls recorded today.</div>}
        {apiUsage.history?.length>0?(<><h3 style={{marginTop:16,marginBottom:4,fontSize:14,fontWeight:600}}>Recent History</h3>{apiUsage.history.slice().reverse().map(day=><div key={day.date} style={{marginBottom:12}}><div className="admin-panel__meta" style={{marginBottom:4}}>{day.date} — Total: {day.total??Object.values(day.byFeature||{}).reduce((a,b)=>a+b,0)}</div>{Object.keys(day.byFeature||{}).length>0?<div className="admin-user-list">{Object.entries(day.byFeature).sort((a,b)=>b[1]-a[1]).map(([feat,cnt])=><div className="admin-user" key={feat}><div className="admin-user__email" style={{color:"#6b7280"}}>{feat}</div><strong style={{minWidth:40,textAlign:"right",color:"#6b7280"}}>{cnt}</strong></div>)}</div>:<div className="admin-panel__meta">No calls recorded.</div>}</div>)}</>):null}
      </>):null}
    </div>
  </div>
</>)}{adminActiveTab==="live"&&(<>
  <div className="admin-card" style={{marginBottom:20}}>
    <div className="admin-card__header"><div><h2>◎ Live Jobs</h2><p>Currently running or queued import jobs.</p></div><button className="btn ghost btn-compact" type="button" onClick={loadAdminLive} disabled={adminLiveLoading}>{adminLiveLoading?"Loading…":"Refresh"}</button></div>
    <div className="admin-card__content" style={{padding:0}}>
      {adminLiveJobs.length===0?<div className="status-banner" style={{margin:16}}>No active jobs right now.</div>:(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>User</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Type</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Tenant</th>
            <th style={{padding:"9px 14px",textAlign:"center",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Progress</th>
            <th style={{padding:"9px 14px",textAlign:"center",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Status</th>
          </tr></thead>
          <tbody>{adminLiveJobs.map((job,i)=>(
            <tr key={job.jobId} style={{borderBottom:"1px solid var(--border)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
              <td style={{padding:"10px 14px",fontSize:12}}>{job.userEmail||"—"}</td>
              <td style={{padding:"10px 14px",fontSize:12}}>{job.type||"—"}</td>
              <td style={{padding:"10px 14px",fontSize:12,color:"var(--muted)"}}>{job.tenantName||"—"}</td>
              <td style={{padding:"10px 14px",textAlign:"center",fontSize:12}}>{job.processed}/{job.total} <span style={{color:"#ef4444"}}>({job.errors} err)</span></td>
              <td style={{padding:"10px 14px",textAlign:"center"}}><span style={{padding:"2px 10px",borderRadius:20,fontSize:11,fontWeight:700,background:job.status==="running"?"rgba(34,197,94,0.1)":"rgba(245,158,11,0.1)",color:job.status==="running"?"#22c55e":"#f59e0b"}}>{job.status}</span></td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  </div>
  <div className="admin-card">
    <div className="admin-card__header"><div><h2>◉ Active Sessions</h2><p>Users currently logged into the app.</p></div></div>
    <div className="admin-card__content" style={{padding:0}}>
      {adminLiveSessions.length===0?<div className="status-banner" style={{margin:16}}>No active sessions.</div>:(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Email</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Plan</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Login At</th>
          </tr></thead>
          <tbody>{adminLiveSessions.map((sess,i)=>(
            <tr key={i} style={{borderBottom:"1px solid var(--border)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
              <td style={{padding:"10px 14px",fontSize:12,fontWeight:500}}>{sess.email||"—"}</td>
              <td style={{padding:"10px 14px",fontSize:12,color:"var(--muted)"}}>{sess.plan||"—"}</td>
              <td style={{padding:"10px 14px",fontSize:12,color:"var(--muted)"}}>{sess.loginAt?formatDateTime(sess.loginAt):"—"}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  </div>
  <div className="admin-card" style={{marginTop:20}}>
    <div className="admin-card__header">
      <div><h2>🔗 Xero Connections</h2><p>All active Xero OAuth sessions. Disconnect to free uncertified app slots.</p></div>
      <button className="btn ghost btn-compact" type="button" onClick={loadAdminAllXeroSessions} disabled={adminAllXeroLoading}>{adminAllXeroLoading?"Loading…":"Refresh"}</button>
    </div>
    <div className="admin-card__content" style={{padding:0}}>
      {!adminAllXeroSessions.length&&!adminAllXeroLoading?<div className="status-banner" style={{margin:16}}>Click Refresh to load active Xero connections.</div>:null}
      {adminAllXeroLoading?<div className="status-banner" style={{margin:16}}>Loading…</div>:null}
      {adminAllXeroSessions.length>0&&(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>User</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Org (Tenant)</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Connected At</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Status</th>
            <th style={{padding:"9px 14px",textAlign:"center",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Action</th>
          </tr></thead>
          <tbody>{adminAllXeroSessions.map((s,i)=>(
            <tr key={s.sessionId} style={{borderBottom:"1px solid var(--border)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
              <td style={{padding:"10px 14px",fontSize:12}}>{s.userEmail}</td>
              <td style={{padding:"10px 14px",fontSize:12}}>{s.tenants.length>0?s.tenants.map(t=>t.name).join(", "):<span style={{color:"var(--muted)"}}>—</span>}</td>
              <td style={{padding:"10px 14px",fontSize:12,color:"var(--muted)"}}>{s.connectedAt?formatDateTime(s.connectedAt):"—"}</td>
              <td style={{padding:"10px 14px"}}><span style={{padding:"2px 8px",borderRadius:20,fontSize:11,fontWeight:700,background:s.dayExhausted?"rgba(239,68,68,0.1)":"rgba(34,197,94,0.1)",color:s.dayExhausted?"#ef4444":"#22c55e"}}>{s.dayExhausted?"Exhausted":"Active"}</span></td>
              <td style={{padding:"10px 14px",textAlign:"center"}}>
                <button className="btn ghost btn-compact" style={{color:"#ef4444",borderColor:"rgba(239,68,68,0.4)",fontSize:11}} onClick={()=>adminDisconnectXeroSession(s.sessionId)} disabled={adminXeroDisconnecting===s.sessionId}>
                  {adminXeroDisconnecting===s.sessionId?"…":"Disconnect"}
                </button>
              </td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  </div>
</>)}{adminActiveTab==="health"&&(<>
  <div className="admin-card" style={{marginBottom:20}}>
    <div className="admin-card__header"><div><h2>♡ Server Health</h2><p>Runtime stats for the Node.js server process.</p></div><button className="btn ghost btn-compact" type="button" onClick={loadAdminHealth} disabled={adminHealthLoading}>{adminHealthLoading?"Loading…":"Refresh"}</button></div>
    <div className="admin-card__content">
      {!adminHealth&&!adminHealthLoading?<div className="status-banner">Click Refresh to load health data.</div>:null}
      {adminHealth&&(()=>{
        const uptimeSec=adminHealth.uptime||0;
        const days=Math.floor(uptimeSec/86400);const hrs=Math.floor((uptimeSec%86400)/3600);const mins=Math.floor((uptimeSec%3600)/60);
        const uptimeStr=[days&&`${days}d`,hrs&&`${hrs}h`,`${mins}m`].filter(Boolean).join(" ");
        const heapUsedMB=(adminHealth.memory?.heapUsed/1024/1024).toFixed(1);
        const heapTotalMB=(adminHealth.memory?.heapTotal/1024/1024).toFixed(1);
        const rssMB=(adminHealth.memory?.rss/1024/1024).toFixed(1);
        const heapPct=adminHealth.memory?.heapTotal?Math.round(adminHealth.memory.heapUsed/adminHealth.memory.heapTotal*100):0;
        return (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:14}}>
            {[
              {label:"Uptime",val:uptimeStr,sub:"Since last restart",color:"#22c55e"},
              {label:"Heap Used",val:`${heapUsedMB} MB`,sub:`${heapPct}% of ${heapTotalMB} MB`,color:"#6366f1"},
              {label:"RSS Memory",val:`${rssMB} MB`,sub:"Process total",color:"#f59e0b"},
              {label:"Node Version",val:adminHealth.node||"—",sub:adminHealth.platform||"",color:"#0ea5e9"},
              {label:"Active Sessions",val:adminHealth.activeSessions||0,sub:"Users logged in",color:"#8b5cf6"},
              {label:"Xero Sessions",val:adminHealth.xeroSessions||0,sub:"Xero connections",color:"#ec4899"},
              {label:"Total Users",val:adminHealth.totalUsers||0,sub:"Registered accounts",color:"#14b8a6"},
              {label:"Import History",val:adminHealth.importHistoryCount||0,sub:"Total records",color:"#f97316"},
            ].map(({label,val,sub,color})=>(
              <div key={label} style={{background:"var(--surface2)",borderRadius:10,padding:"14px 16px",border:"1px solid var(--border)"}}>
                <div style={{fontSize:11,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7,marginBottom:4}}>{label}</div>
                <div style={{fontSize:22,fontWeight:700,color,fontVariantNumeric:"tabular-nums"}}>{val}</div>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{sub}</div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  </div>
</>)}{adminActiveTab==="security"&&(<>
  <div className="admin-card">
    <div className="admin-card__header">
      <div><h2>⚿ Audit Log</h2><p>All admin actions tracked automatically.</p></div>
      <div style={{display:"flex",gap:8}}>
        <span style={{fontSize:12,color:"var(--muted)"}}>{adminAuditLogTotal} total</span>
        <button className="btn ghost btn-compact" type="button" onClick={()=>loadAuditLog(1)} disabled={adminAuditLogLoading}>{adminAuditLogLoading?"Loading…":"Refresh"}</button>
      </div>
    </div>
    <div className="admin-card__content" style={{padding:0}}>
      {adminAuditLog.length===0?<div className="status-banner" style={{margin:16}}>No audit log entries yet. Admin actions will appear here.</div>:(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{borderBottom:"2px solid var(--border)",background:"var(--surface2)"}}>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>When</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Action</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Target</th>
            <th style={{padding:"9px 14px",textAlign:"left",fontSize:11,fontWeight:600,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.7}}>Details</th>
          </tr></thead>
          <tbody>{adminAuditLog.map((entry,i)=>{
            const actionColor={
              "disable-user":"#ef4444","delete-user":"#ef4444","bulk-delete":"#ef4444","revoke-xero":"#f59e0b",
              "enable-user":"#22c55e","set-plan":"#6366f1","set-xero-client":"#818cf8","reset-password":"#f97316",
              "maintenance-on":"#ef4444","maintenance-off":"#22c55e","set-broadcast":"#0ea5e9",
            }[entry.action]||"var(--muted)";
            return (
              <tr key={entry.id||i} style={{borderBottom:"1px solid var(--border)",background:i%2===0?"transparent":"rgba(255,255,255,0.015)"}}>
                <td style={{padding:"9px 14px",fontSize:11,color:"var(--muted)",whiteSpace:"nowrap"}}>{formatDateTime(entry.at)}</td>
                <td style={{padding:"9px 14px"}}><span style={{fontSize:11,fontWeight:700,color:actionColor,background:`${actionColor}18`,padding:"2px 8px",borderRadius:20,border:`1px solid ${actionColor}40`}}>{entry.action}</span></td>
                <td style={{padding:"9px 14px",fontSize:12,color:"var(--text)"}}>{entry.target||"—"}</td>
                <td style={{padding:"9px 14px",fontSize:11,color:"var(--muted)"}}>{entry.details||"—"}</td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      {adminAuditLogTotal>50&&(
        <div style={{display:"flex",gap:8,padding:"12px 16px",borderTop:"1px solid var(--border)"}}>
          <button className="btn ghost btn-compact" type="button" disabled={adminAuditLogPage<=1} onClick={()=>loadAuditLog(adminAuditLogPage-1)}>← Prev</button>
          <span style={{fontSize:12,color:"var(--muted)",alignSelf:"center"}}>Page {adminAuditLogPage}</span>
          <button className="btn ghost btn-compact" type="button" onClick={()=>loadAuditLog(adminAuditLogPage+1)}>Next →</button>
        </div>
      )}
    </div>
  </div>
</>)}</div></div>}</div>}</div>;
  }
  const buildDetail = ({
    count,
    rateInfo,
    statusValue,
    error,
    progress,
    startedAt
  }) => {
    if (statusValue === "Error") {
      return error || "Export failed";
    }
    const rateParts = [];
    if (rateInfo?.day) rateParts.push(`day ${rateInfo.day}`);
    if (rateInfo?.minute) rateParts.push(`min ${rateInfo.minute}`);
    if (rateInfo?.appMinute) rateParts.push(`app ${rateInfo.appMinute}`);
    const rateDetail = rateParts.length ? `Remaining: ${rateParts.join(" / ")}` : "";
    const progressDetail = buildProgressDetail(progress, startedAt);
    if (statusValue === "Queued") return "Queued";
    if (statusValue === "In progress") {
      return progressDetail || "Working...";
    }
    const base = `Count: ${count ?? 0}`;
    if (rateDetail && progressDetail) {
      return `${base} | ${rateDetail} | ${progressDetail}`;
    }
    if (rateDetail) return `${base} | ${rateDetail}`;
    if (progressDetail) return `${base} | ${progressDetail}`;
    return base;
  };
  const mapJobToResult = (job, userTokenValue) => {
    const statusMap = {
      queued: "Queued",
      running: "In progress",
      ready: "Ready",
      no_records: "No records",
      error: "Error"
    };
    const statusValue = statusMap[job.status] || "In progress";
    const detail = buildDetail({
      count: job.count,
      rateInfo: job.rate,
      statusValue,
      error: job.error,
      progress: job.progress,
      startedAt: job.startedAt
    });
    const baseDownload = `${API_BASE}/export/download/${job.jobId}`;
    return {
      runId: job.jobId,
      jobId: job.jobId,
      type: job.type,
      tenantName: job.tenantName || null,
      folderPath: job.folderPath || null,
      createdAt: job.createdAt || null,
      updatedAt: job.updatedAt || null,
      startedAt: job.startedAt || null,
      progress: job.progress || null,
      status: statusValue,
      detail,
      excelUrl: statusValue === "Ready" ? `${baseDownload}?format=excel&userToken=${userTokenValue}` : null,
      csvUrl: statusValue === "Ready" ? `${baseDownload}?format=csv&userToken=${userTokenValue}` : null,
      jsonUrl: statusValue === "Ready" ? `${baseDownload}?format=json&userToken=${userTokenValue}` : null
    };
  };
  const groupedResults = useMemo(() => {
    const groups = new Map();
    exportResults.forEach(item => {
      const key = item.tenantName || "Unknown tenant";
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    });
    return Array.from(groups.entries()).map(([tenant, items]) => ({
      tenant,
      items
    }));
  }, [exportResults]);
  useEffect(() => {
    if (!showHistory) return;
    if (selectedTenantName) {}
  }, [showHistory, selectedTenantName]);
  const loadTypes = () => {
    setTypesLoading(true);
    setTypesError("");
    fetch(`${API_BASE}/types`).then(async res => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load data types");
      }
      setTypes(data.types || []);
    }).catch(err => {
      setTypes([]);
      setTypesError(err.message);
    }).finally(() => setTypesLoading(false));
  };
  useEffect(() => {
    loadTypes();
  }, []);
  useEffect(() => {
    const storedAuthUrl = localStorage.getItem("xero_last_auth_url") || "";
    const storedCallbackUrl = localStorage.getItem("xero_last_callback_url") || "";
    setLastAuthUrl(storedAuthUrl);
    setLastCallbackUrl(storedCallbackUrl);
    const params = new URLSearchParams(window.location.search);
    const sessionFromRedirect = params.get("sessionId");
    if (sessionFromRedirect) {
      localStorage.setItem("xero_session", sessionFromRedirect);
      setSessionId(sessionFromRedirect);
      setStatus("Connected. Fetch tenants...");
      restoreXeroReturnPath();
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;
    setStatus("Exchanging code for token...");
    fetch(`${API_BASE}/auth/callback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(userToken ? {
          "x-user-token": userToken
        } : {})
      },
      body: JSON.stringify({
        code,
        state
      })
    }).then(res => res.json()).then(data => {
      if (data.sessionId) {
        localStorage.setItem("xero_session", data.sessionId);
        setSessionId(data.sessionId);
        setStatus("Connected. Fetch tenants...");
        restoreXeroReturnPath();
      } else {
        setStatus(data.error || "Auth failed");
      }
    }).catch(err => setStatus(err.message));
  }, []);
  useEffect(() => {
    if (!sessionId) {
      const stored = localStorage.getItem("xero_session");
      if (stored) {
        setStatus("Previous session found. Click 'Use Latest Session' or Connect.");
      }
    }
  }, [sessionId]);
  useEffect(() => {
    if (!isDeleteCentrePage && !isImportPage && !isUpdateCentrePage) return;
    if (sessionId) return;
    if (manuallyDisconnectedRef.current) return;
    handleUseLatestSession();
  }, [isDeleteCentrePage, isImportPage, isUpdateCentrePage, sessionId]);
  useEffect(() => {
    if (!sessionId) {
      // No active session — still load all user sessions to show connected orgs
      refreshAllSessions();
      return;
    }
    // Cache tenants for this specific session on server, then reload all sessions
    fetch(`${API_BASE}/tenants`, { headers: sessionHeader })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setStatus(data.error);
          if (data.error.includes("Session")) {
            localStorage.removeItem("xero_session");
            setSessionId("");
            if (isDeleteCentrePage || isUpdateCentrePage) {
              setTimeout(() => { handleUseLatestSession(); }, 0);
            }
          }
          return;
        }
        // Directly set tenants from this session's /api/tenants response (primary fallback)
        // This works even if refreshAllSessions fails due to userToken not loaded yet
        if (Array.isArray(data.tenants) && data.tenants.length > 0) {
          const fromThisSession = data.tenants.map(t => ({
            tenantId: t.tenantId,
            tenantName: t.tenantName || t.orgName || "Unknown",
            sessionId
          }));
          setTenants(prev => {
            const withoutThis = prev.filter(t => t.sessionId !== sessionId);
            const seen = new Set(withoutThis.map(t => t.tenantId));
            const toAdd = fromThisSession.filter(t => !seen.has(t.tenantId));
            return [...withoutThis, ...toAdd];
          });
          setSelectedTenant(prev => {
            if (prev) return prev;
            setSessionId(fromThisSession[0].sessionId);
            return fromThisSession[0].tenantId;
          });
        }
        // Also refresh all sessions for multi-org support (best effort)
        refreshAllSessions();
      })
      .catch(err => setStatus(err.message));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionHeader, isDeleteCentrePage, isUpdateCentrePage]);
  useEffect(() => {
    if (!userToken) {
      return;
    }
    fetch(`${API_BASE}/export/jobs`, {
      headers: userHeader
    }).then(res => res.json()).then(data => {
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      if (!jobs.length) return;
      const mapped = jobs.map(job => mapJobToResult(job, userToken));
      setExportResults(prev => {
        const existing = new Set(prev.map(item => item.jobId));
        const merged = [...prev];
        mapped.forEach(item => {
          if (!existing.has(item.jobId)) {
            merged.push(item);
          }
        });
        return merged;
      });
    }).catch(() => {});
  }, [userToken, userHeader]);
  // Load all Xero sessions when user logs in
  useEffect(() => {
    if (userToken) refreshAllSessions();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userToken]);
  const refreshAllSessions = async () => {
    if (!userToken) return;
    try {
      const r = await fetch(`${API_BASE}/user/sessions`, { headers: { "x-user-token": userToken } });
      if (!r.ok) return;
      const data = await r.json();
      if (!Array.isArray(data.sessions)) return;
      setAllUserSessions(data.sessions);
      // Build combined list from ALL sessions (server auto-fetches missing tenants)
      const seen = new Set();
      const fromServer = [];
      data.sessions.forEach(sess => {
        (sess.tenants || []).forEach(t => {
          if (!seen.has(t.tenantId)) {
            seen.add(t.tenantId);
            fromServer.push({ tenantId: t.tenantId, tenantName: t.tenantName, sessionId: sess.sessionId });
          }
        });
      });
      // Merge: keep any locally-known tenants the server didn't return (e.g. slow token refresh)
      setTenants(prev => {
        const merged = [...fromServer];
        prev.forEach(t => {
          if (!seen.has(t.tenantId)) merged.push(t);
        });
        return merged;
      });
      // Auto-select: keep current selection if still valid, else pick first available
      const allKnown = fromServer; // use server list as authoritative for selection
      if (allKnown.length > 0) {
        setSelectedTenant(prev => {
          const stillValid = allKnown.find(t => t.tenantId === prev);
          if (stillValid) { setSessionId(stillValid.sessionId); return prev; }
          setSessionId(allKnown[0].sessionId);
          return allKnown[0].tenantId;
        });
      } else {
        setSelectedTenant("");
      }
    } catch (_) {}
  };
  const handleConnect = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/start`, {
        headers: userToken ? { "x-user-token": userToken } : {}
      });
      const data = await res.json();
      if (data.authUrl) {
        localStorage.setItem("xero_return_path", currentPath || "/");
        localStorage.setItem("xero_last_auth_url", data.authUrl);
        setLastAuthUrl(data.authUrl);
        setAuthUrl(data.authUrl);
        window.location.href = data.authUrl;
      } else {
        toast.error(data.error || "Could not start Xero connection. Please try again.");
      }
    } catch (e) {
      toast.error("Connection error: " + e.message);
    }
  };
  const cancelImport = async (type, jobId) => {
    if (!jobId || !userToken) return;
    try {
      await fetch(`${API_BASE}/import/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken },
        body: JSON.stringify({ jobId, type }),
      });
    } catch (_) {}
  };

  // Immediately clears the import overlay on the frontend AND sends cancel to server.
  // Used by both "Stop Import" and the force-dismiss "×" button.
  const forceDismissImport = (type, jobId) => {
    // Tell server to cancel (fire-and-forget)
    if (jobId && userToken) {
      fetch(`${API_BASE}/import/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken },
        body: JSON.stringify({ jobId, type }),
      }).catch(() => {});
    }
    // Immediately clear frontend state so overlay disappears right away
    const loadingSetterMap = {
      bills: [setBillsImportLoading, setBillsImportProgress, setBillsImportJobId, "kk_billsJobId"],
      invoices: [setInvoicesImportLoading, setInvoicesImportProgress, setInvoicesImportJobId, "kk_invoicesJobId"],
      "credit-notes": [setCreditNotesImportLoading, setCreditNotesImportProgress, setCreditNotesImportJobId, "kk_creditNotesJobId"],
      "manual-journals": [setManualJournalLoading, setManualJournalProgress, setManualJournalJobId, "kk_manualJournalJobId"],
      "spend-money": [setSpendMoneyLoading, setSpendMoneyProgress, setSpendMoneyJobId, "kk_spendMoneyJobId"],
      "receive-money": [setReceiveMoneyLoading, setReceiveMoneyProgress, setReceiveMoneyJobId, "kk_receiveMoneyJobId"],
      "bank-transfers": [setBankTransferLoading, setBankTransferProgress, setBankTransferJobId, ""],
      "purchase-orders": [setPoImportLoading, setPoImportProgress, setPoImportJobId, ""],
      quotes: [setQuotesImportLoading, setQuotesImportProgress, setQuotesImportJobId, ""],
      "bill-payments": [setBillPaymentLoading, setBillPaymentProgress, setBillPaymentJobId, "kk_billPaymentJobId"],
      "invoice-payments": [setInvoicePaymentLoading, setInvoicePaymentProgress, setInvoicePaymentJobId, "kk_invoicePaymentJobId"],
      "credit-note-refunds": [setCreditNoteRefundLoading, setCreditNoteRefundProgress, setCreditNoteRefundJobId, "kk_creditNoteRefundJobId"],
      accounts: [setAccountsImportLoading, setAccountsImportProgress, setAccountsImportJobId, "kk_accountsJobId"],
      items: [setItemsImportLoading, setItemsImportProgress, setItemsImportJobId, "kk_itemsJobId"],
      customers: [setCustomersImportLoading, setCustomersImportProgress, setCustomersImportJobId, "kk_customersJobId"],
      vendors: [setVendorsImportLoading, setVendorsImportProgress, setVendorsImportJobId, "kk_vendorsJobId"],
      "tracking-categories": [setTrackingCatImportLoading, setTrackingCatImportProgress, setTrackingCatImportJobId, "kk_trackingCatJobId"],
      "spend-op": [setSpendOpLoading, setSpendOpProgress, setSpendOpJobId, "kk_spendOpJobId"],
      "receive-op": [setReceiveOpLoading, setReceiveOpProgress, setReceiveOpJobId, "kk_receiveOpJobId"],
      "cn-allocation": [setCnAllocLoading, setCnAllocProgress, setCnAllocJobId, ""],
      "dn-allocation": [setDnAllocLoading, setDnAllocProgress, setDnAllocJobId, ""],
      "spend-allocation": [setSpendAllocLoading, setSpendAllocProgress, setSpendAllocJobId, "kk_spendAllocJobId"],
      "receive-allocation": [setReceiveAllocLoading, setReceiveAllocProgress, setReceiveAllocJobId, "kk_receiveAllocJobId"],
      "update-status": [setUpdateStatusLoading, setUpdateStatusProgress, setUpdateStatusJobId, ""],
      "exchange-rate-update": [setExchangeRateUpdateLoading, setExchangeRateUpdateProgress, setExchangeRateUpdateJobId, ""],
    };
    const s = loadingSetterMap[type];
    if (s) {
      const [setLoad, setProgress, setJobId, lsKey] = s;
      setLoad(false);
      setProgress(null);
      setJobId("");
      if (lsKey) localStorage.removeItem(lsKey);
    }
    setStopConfirming(false);
  };

  const handleDownloadErrors = (type, filter = "errors") => {
    const jobId = lastImportJobIds[type];
    if (!jobId || !userToken) return;
    const params = new URLSearchParams({ jobId, type, filter });
    const url = `${API_BASE}/import/errors/download?${params.toString()}`;
    fetch(url, {
      headers: {
        "x-user-token": userToken
      }
    }).then(res => {
      if (!res.ok) return res.json().then(d => {
        throw new Error(d.error || "Download failed");
      });
      const contentType = res.headers.get("content-type") || "";
      const disposition = res.headers.get("content-disposition") || "";
      const nameMatch = disposition.match(/filename="?([^"]+)"?/);
      const ext = contentType.includes("csv") ? "csv" : "xlsx";
      const filename = nameMatch ? nameMatch[1] : `import-errors-${type}-${Date.now()}.${ext}`;
      return res.blob().then(blob => ({
        blob,
        filename
      }));
    }).then(({
      blob,
      filename
    }) => {
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(blobUrl);
    }).catch(err => toast.error(err.message));
  };
  const handleExportHistoryCSV = () => {
    const params = new URLSearchParams();
    if (historySearch) params.set("search", historySearch);
    if (historyTypeFilter) params.set("importType", historyTypeFilter);
    if (historyStatusFilter) params.set("status", historyStatusFilter);
    fetch(`${API_BASE}/import/history/export?${params}`, { headers: { "x-user-token": userToken } })
      .then(r => r.ok ? r.blob() : r.json().then(d => { throw new Error(d.error || "Export failed"); }))
      .then(blob => { const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `import-history-${Date.now()}.csv`; a.click(); URL.revokeObjectURL(u); })
      .catch(err => toast.error(err.message));
  };
  const handleDownloadFailedRows = (type, progressData, rowsData) => {
    const errorResults = (progressData?.results || []).filter(r => r.status === "error");
    if (!errorResults.length) { toast.error("No failed rows found."); return; }
    const errorRowNums = new Set(errorResults.map(r => r.rowNumber));
    const failedRows = (rowsData || []).filter(r => errorRowNums.has(r.rowNumber));
    if (!failedRows.length) { toast.error("Cannot match failed rows to original data — re-upload the file to enable retry."); return; }
    const allKeys = Object.keys(failedRows[0]).filter(k => k !== "rowNumber" && !k.startsWith("_"));
    const esc = v => { const s = String(v ?? ""); return (s.includes(",") || s.includes('"') || s.includes("\n")) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [["Row Number", ...allKeys].map(esc).join(",")];
    failedRows.forEach(row => lines.push([row.rowNumber, ...allKeys.map(k => esc(row[k]))].join(",")));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = `failed-rows-${type}-${Date.now()}.csv`; a.click();
    URL.revokeObjectURL(u);
    toast.success(`Downloaded ${failedRows.length} failed row(s) — fix and re-upload to retry.`);
  };
  const handleFilterDeleteScan = async () => {
    if (!selectedTenant || !userToken) return;
    setFilterDeleteScanning(true);
    setFilterDeleteScanResult(null);
    try {
      const params = new URLSearchParams({ type: filterDeleteType, tenantId: selectedTenant });
      if (filterDeleteStatus) params.set("status", filterDeleteStatus);
      if (filterDeleteFrom) params.set("from", filterDeleteFrom);
      if (filterDeleteTo) params.set("to", filterDeleteTo);
      const res = await fetch(`${API_BASE}/delete/by-filter/scan?${params}`, { headers: { "x-user-token": userToken, "x-session-id": sessionId || "" } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scan failed");
      setFilterDeleteScanResult(data);
    } catch (err) { toast.error(err.message); }
    setFilterDeleteScanning(false);
  };
  const handleFilterDeleteStart = async () => {
    if (!filterDeleteScanResult?.records?.length || !selectedTenant || !userToken) return;
    setFilterDeleteRunning(true);
    try {
      const res = await fetch(`${API_BASE}/delete/by-filter/start`, { method: "POST", headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId || "", "x-tenant-id": selectedTenant }, body: JSON.stringify({ tenantId: selectedTenant, type: filterDeleteType, records: filterDeleteScanResult.records }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Start failed");
      setFilterDeleteJobId(data.jobId);
      setFilterDeleteProgress(data);
    } catch (err) { toast.error(err.message); setFilterDeleteRunning(false); }
  };
  const cancelFilterDeleteJob = async () => {
    if (!filterDeleteJobId) return;
    await fetch(`${API_BASE}/invoice/bulk-delete/cancel`, { method: "POST", headers: { "Content-Type": "application/json", "x-user-token": userToken }, body: JSON.stringify({ jobId: filterDeleteJobId }) }).catch(() => {});
  };
  const loadImportHistory = async (page = 1, overrides = {}) => {
    if (!userToken) return;
    const search = overrides.search !== undefined ? overrides.search : historySearch;
    const typeFilter = overrides.typeFilter !== undefined ? overrides.typeFilter : historyTypeFilter;
    const statusFilter = overrides.statusFilter !== undefined ? overrides.statusFilter : historyStatusFilter;
    setImportHistoryLoading(true);
    try {
      const params = new URLSearchParams({ page, limit: 20, _: Date.now() });
      if (search) params.set("search", search);
      if (typeFilter) params.set("importType", typeFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`${API_BASE}/import/history?${params}`, { headers: { "x-user-token": userToken }, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.history)) {
        setImportHistory(data.history);
        setHistoryTotal(data.total || 0);
        setHistoryPage(data.page || 1);
      }
    } catch (_) {}
    setImportHistoryLoading(false);
  };
  const loadCheckpoints = async () => {
    if (!userToken) return;
    try {
      const res = await fetch(`${API_BASE}/import/checkpoints`, { headers: { "x-user-token": userToken } });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.checkpoints)) setInterruptedCheckpoints(data.checkpoints);
    } catch (_) {}
  };
  const dismissCheckpoint = async (jobId) => {
    try {
      await fetch(`${API_BASE}/import/checkpoints/${jobId}`, { method: "DELETE", headers: { "x-user-token": userToken } });
      setInterruptedCheckpoints(prev => prev.filter(cp => cp.jobId !== jobId));
    } catch (_) {}
  };
  const handleUndoHistoryEntry = async (entry) => {
    if (!userToken) return;
    const count = entry.created || 0;
    const importTypeName = ({ bills: "Purchase Bills", invoices: "Sales Invoices", "purchase-orders": "Purchase Orders", quotes: "Quotes", "credit-notes": "Credit Notes", "spend-money": "Spend Money", "receive-money": "Receive Money", "bill-payments": "Bill Payments", "invoice-payments": "Invoice Payments", "manual-journals": "Manual Journals" })[entry.importType] || entry.importType;
    if (!window.confirm(`Undo this ${importTypeName} import? This will void/delete ${count} record(s). This cannot be undone.`)) return;
    setUndoingHistoryId(entry.id);
    try {
      const res = await fetch(`${API_BASE}/import/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId },
        body: JSON.stringify({ historyId: entry.id, tenantId: selectedTenant || entry.tenantId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Undo failed.");
      const jobId = data.jobId;
      if (!jobId) throw new Error("No job ID returned.");
      // Poll for completion
      await new Promise((resolve, reject) => {
        const poll = async () => {
          try {
            const r = await fetch(`${API_BASE}/import/undo/status?jobId=${jobId}`, { headers: { "x-user-token": userToken } });
            const d = await r.json().catch(() => ({}));
            if (d.status === "done") {
              setUndoProgress({ done: d.done || d.total, total: d.total, failed: d.failed || 0, finished: true, lastErrors: d.lastErrors || [] });
              toast.success(`Undo complete: ${d.done || 0} record(s) voided.`);
              resolve();
            } else if (d.status === "error") {
              setUndoProgress(null);
              reject(new Error(d.message || "Undo failed."));
            } else {
              setUndoProgress({ done: d.done || 0, total: d.total || 0, failed: d.failed || 0, finished: false, lastErrors: d.lastErrors || [] });
              setTimeout(poll, 2000);
            }
          } catch (e) { reject(e); }
        };
        poll();
      });
      loadImportHistory();
    } catch (err) {
      toast.error(err.message);
    }
    setUndoingHistoryId(null);
    setTimeout(() => setUndoProgress(null), 3000);
  };

  const handleUndoImport = async () => {
    if (!lastImportMeta || !userToken) return;
    if (!window.confirm(`Undo the last ${lastImportMeta.type} import? This will void/delete ${lastImportMeta.created} records.`)) return;
    setUndoLoading(true);
    setUndoResult(null);
    try {
      const res = await fetch(`${API_BASE}/import/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId },
        body: JSON.stringify({ historyId: lastImportMeta.historyId, tenantId: selectedTenant })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Undo failed.");
      setUndoResult(data);
      setLastImportMeta(null);
      toast.success(`Undo complete: ${data.voided || 0} records removed.`);
    } catch (err) {
      toast.error(err.message);
    }
    setUndoLoading(false);
  };
  const handleDisconnect = async () => {
    if (!sessionId) return;
    manuallyDisconnectedRef.current = true;
    try {
      await fetch(`${API_BASE}/xero/disconnect`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-token": userToken,
          "x-session-id": sessionId
        }
      });
    } catch (_) {}
    localStorage.removeItem("xero_session");
    setSessionId("");
    setSelectedTenant("");
    setStatus("Disconnected from Xero.");
    // Refresh — show remaining connected sessions (not clear all)
    await refreshAllSessions();
  };
  useEffect(() => {
    const pending = exportResults.filter(item => item.jobId && (item.status === "Queued" || item.status === "In progress" || item.status === "Ready" && !item.excelUrl));
    if (!pending.length || !sessionId) {
      return;
    }
    const interval = setInterval(async () => {
      for (const item of pending) {
        try {
          const res = await fetch(`${API_BASE}/export/status?jobId=${item.jobId}`, {
            headers: authHeaders
          });
          if (!res.ok) {
            continue;
          }
          const data = await res.json();
          const statusMap = {
            queued: "Queued",
            running: "In progress",
            ready: "Ready",
            no_records: "No records",
            error: "Error"
          };
          const statusValue = statusMap[data.status] || "In progress";
          const detail = buildDetail({
            count: data.count,
            rateInfo: data.rate,
            statusValue,
            error: data.error,
            progress: data.progress,
            startedAt: data.startedAt
          });
          const baseDownload = `${API_BASE}/export/download/${item.jobId}`;
          const excelUrl = `${baseDownload}?format=excel&userToken=${userToken}`;
          const csvUrl = `${baseDownload}?format=csv&userToken=${userToken}`;
          const jsonUrl = `${baseDownload}?format=json&userToken=${userToken}`;
          setExportResults(prev => prev.map(entry => entry.jobId === item.jobId ? {
            ...entry,
            status: statusValue,
            detail,
            tenantName: data.tenantName || entry.tenantName,
            folderPath: data.folderPath || entry.folderPath,
            startedAt: data.startedAt || entry.startedAt,
            progress: data.progress || entry.progress,
            updatedAt: Date.now(),
            excelUrl: statusValue === "Ready" ? excelUrl : entry.excelUrl,
            csvUrl: statusValue === "Ready" ? csvUrl : entry.csvUrl,
            jsonUrl: statusValue === "Ready" ? jsonUrl : entry.jsonUrl
          } : entry));
        } catch {}
      }
    }, 3e3);
    return () => clearInterval(interval);
  }, [exportResults, authHeaders, userToken, sessionId]);
  const handleUseLatestSession = async () => {
    setIsCheckingSession(true);
    try {
      const res = await fetch(`${API_BASE}/session/latest`);
      const data = await res.json();
      if (res.ok && data.sessionId) {
        localStorage.setItem("xero_session", data.sessionId);
        setSessionId(data.sessionId);
        setStatus("Using latest server session. Fetch tenants...");
        return;
      }
      const stored = localStorage.getItem("xero_session");
      if (stored) {
        setSessionId(stored);
        setStatus("Using stored session. Fetch tenants...");
        return;
      }
      throw new Error(data.error || "No recent session found");
    } catch (err) {
      setStatus(err.message);
    } finally {
      setIsCheckingSession(false);
    }
  };
  const handleToggleAllTypes = checked => {
    if (checked) {
      setSelectedTypes(types);
    } else {
      setSelectedTypes([]);
    }
  };
  const handleToggleGroup = (groupTypes, checked) => {
    if (checked) {
      setSelectedTypes(prev => Array.from(new Set([...prev, ...groupTypes])));
    } else {
      setSelectedTypes(prev => prev.filter(type => !groupTypes.includes(type)));
    }
  };
  const handleToggleType = (type, checked) => {
    if (checked) {
      setSelectedTypes(prev => [...prev, type]);
    } else {
      setSelectedTypes(prev => prev.filter(item => item !== type));
    }
  };
  const handleExport = async () => {
    if (!hasPermission("export")) {
      setAccessDeniedModal({ feature: "Export" });
      return;
    }
    if (!userToken) {
      setStatus("Please login first.");
      return;
    }
    if (!sessionId) {
      setStatus("Please connect to Xero first.");
      return;
    }
    if (!selectedTenant) {
      setStatus("Select a tenant first.");
      return;
    }
    if (!selectedTypes.length) {
      setStatus("Select at least one type.");
      return;
    }
    setIsLoading(true);
    setStatus("Preparing exports. This can take time for large ranges.");
    const runId = Date.now().toString();
    setExportResults(prev => [...prev, ...selectedTypes.map(type => ({
      runId,
      type,
      status: "Queued",
      detail: "Queued",
      createdAt: Date.now()
    }))]);
    try {
      let successCount = 0;
      for (const type of selectedTypes) {
        setStatus(`Starting ${type}...`);
        const payload = {
          type,
          tenantId: selectedTenant,
          tenantName: selectedTenantName,
          format: "all",
          from: fromDate || void 0,
          to: toDate || void 0
        };
        const res = await fetch(`${API_BASE}/export/start`, {
          method: "POST",
          headers: {
            ...importHeaders,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          let message = `Export failed for ${type}`;
          try {
            const data2 = await res.json();
            message = data2.error || message;
          } catch {}
          setExportResults(prev => prev.map(item => item.runId === runId && item.type === type ? {
            ...item,
            status: "Error",
            detail: message
          } : item));
          continue;
        }
        const data = await res.json();
        setExportResults(prev => prev.map(item => item.runId === runId && item.type === type ? {
          ...item,
          status: "Queued",
          detail: "Queued",
          jobId: data.jobId
        } : item));
        successCount += 1;
      }
      setStatus(`Export jobs started for ${successCount} types.`);
      toast.success(`Export started for ${successCount} type${successCount !== 1 ? "s" : ""}.`);
    } catch (err) {
      setStatus(err.message);
      toast.error(err.message);
    } finally {
      setIsLoading(false);
    }
  };
  const handleRetry = async jobId => {
    if (!userToken) {
      setStatus("Please login first.");
      return;
    }
    setStatus("Retrying export...");
    try {
      const res = await fetch(`${API_BASE}/export/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...userHeader
        },
        body: JSON.stringify({
          jobId
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Retry failed");
      }
      const newJob = {
        jobId: data.jobId,
        status: data.status || "queued",
        type: exportResults.find(item => item.jobId === jobId)?.type || "",
        tenantName: exportResults.find(item => item.jobId === jobId)?.tenantName || null
      };
      const mapped = mapJobToResult({
        jobId: newJob.jobId,
        type: newJob.type,
        tenantName: newJob.tenantName,
        status: newJob.status,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }, userToken);
      setExportResults(prev => [...prev, mapped]);
      setStatus("Retry queued.");
    } catch (err) {
      setStatus(err.message);
    }
  };
  const handleDeletePayment = async () => {
    if (!userToken) {
      setDeleteStatus("Please login first.");
      return;
    }
    if (!sessionId) {
      setDeleteStatus("Please connect to Xero first.");
      return;
    }
    if (!deleteTenantId) {
      setDeleteStatus("Select tenant first.");
      return;
    }
    if (!deletePaymentId.trim()) {
      setDeleteStatus("Enter payment ID.");
      return;
    }
    setDeleteLoading(true);
    setDeleteStatus("Deleting payment...");
    try {
      const res = await fetch(`${API_BASE}/billpayment/${encodeURIComponent(deletePaymentId.trim())}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "x-user-token": userToken,
          "x-session-id": sessionId,
          "x-tenant-id": deleteTenantId
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          localStorage.removeItem("xero_session");
          setSessionId("");
        }
        throw new Error(data.error || "Delete failed");
      }
      if (data.sessionId) {
        localStorage.setItem("xero_session", data.sessionId);
        setSessionId(data.sessionId);
      }
      if (data.data?.Payments?.[0]) {
        setPaymentLookup(data.data.Payments[0]);
      }
      setDeleteStatus(`Payment deleted: ${deletePaymentId.trim()}`);
      setDeletePaymentId("");
    } catch (err) {
      setDeleteStatus(err.message);
    } finally {
      setDeleteLoading(false);
    }
  };
  const handleCheckPayment = async () => {
    if (!userToken) {
      setDeleteStatus("Please login first.");
      return;
    }
    if (!sessionId) {
      setDeleteStatus("Please connect to Xero first.");
      return;
    }
    if (!deleteTenantId) {
      setDeleteStatus("Select tenant first.");
      return;
    }
    if (!deletePaymentId.trim()) {
      setDeleteStatus("Enter payment ID.");
      return;
    }
    setPaymentLookupLoading(true);
    setDeleteStatus("Checking payment...");
    setPaymentLookup(null);
    try {
      const params = new URLSearchParams({
        tenantId: deleteTenantId
      });
      const res = await fetch(`${API_BASE}/billpayment/${encodeURIComponent(deletePaymentId.trim())}?${params.toString()}`, {
        headers: {
          "x-user-token": userToken,
          "x-session-id": sessionId,
          "x-tenant-id": deleteTenantId
        }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Payment lookup failed");
      }
      if (data.sessionId) {
        localStorage.setItem("xero_session", data.sessionId);
        setSessionId(data.sessionId);
      }
      setPaymentLookup(data.payment || null);
      setDeleteStatus("Payment loaded. Check status before delete.");
    } catch (err) {
      setDeleteStatus(err.message);
      setPaymentLookup(null);
    } finally {
      setPaymentLookupLoading(false);
    }
  };
  const readFileAsBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const marker = "base64,";
      const index = result.indexOf(marker);
      if (index === -1) {
        reject(new Error("Failed to read file."));
        return;
      }
      resolve(result.slice(index + marker.length));
    };
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
  const formatBulkStatus = statusValue => {
    const map = {
      deleted: "Deleted",
      voided: "Voided",
      no_id: "No ID",
      not_found: "Not Found",
      already_deleted: "Already Deleted",
      already_voided: "Already Voided",
      validation_failed: "Validation Failed",
      wrong_doc_type: "Wrong Type",
      has_payments: "Has Payments",
      skipped: "Skipped",
      cancelled: "Stopped",
      error: "Error",
      queued: "Queued",
      running: "Running",
      completed: "Completed"
    };
    return map[statusValue] || statusValue || "-";
  };
  const formatEta = ms => {
    if (!Number.isFinite(ms) || ms <= 0) return "Calculating...";
    const totalSeconds = Math.max(1, Math.round(ms / 1e3));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
    return `${seconds}s`;
  };
  const formatTimeAgo = value => {
    if (!value) return "-";
    const diffMs = Date.now() - value;
    if (diffMs < 0) return "just now";
    const seconds = Math.floor(diffMs / 1e3);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return `${minutes}m ${String(remSeconds).padStart(2, "0")}s ago`;
  };
  const handleBulkDelete = async () => {
    if (!userToken) {
      setDeleteStatus("Please login first.");
      return;
    }
    if (!sessionId) {
      setDeleteStatus("Please connect to Xero first.");
      return;
    }
    if (!deleteTenantId) {
      setDeleteStatus("Select tenant first.");
      return;
    }
    if (!bulkDeleteFile) {
      setDeleteStatus("Upload a sheet first.");
      return;
    }
    setBulkDeleteLoading(true);
    setDeleteStatus("Uploading sheet and starting bulk delete...");
    setBulkDeleteResults([]);
    setBulkDeleteProgress(null);
    setBulkDeleteJobId("");
    try {
      const contentBase64 = await readFileAsBase64(bulkDeleteFile);
      const res = await fetch(`${API_BASE}/billpayment/bulk-delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-token": userToken,
          "x-session-id": sessionId,
          "x-tenant-id": deleteTenantId
        },
        body: JSON.stringify({
          tenantId: deleteTenantId,
          filename: bulkDeleteFile.name,
          contentBase64,
          columnName: "payment id"
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 413) {
          throw new Error(data.error || "Uploaded file too large. Split the sheet and try again.");
        }
        throw new Error(data.error || "Bulk delete failed");
      }
      if (data.sessionId) {
        localStorage.setItem("xero_session", data.sessionId);
        setSessionId(data.sessionId);
      }
      setBulkDeleteJobId(data.jobId || "");
      setBulkDeleteProgress(data);
      setDeleteStatus("Bulk delete started. Progress updating...");
    } catch (err) {
      setDeleteStatus(err.message);
      setBulkDeleteResults([]);
      setBulkDeleteProgress(null);
      setBulkDeleteJobId("");
    } finally {
      setBulkDeleteLoading(false);
    }
  };
  useEffect(() => {
    if (!bulkDeleteJobId || !userToken) return;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: bulkDeleteJobId
        });
        const res = await fetch(`${API_BASE}/billpayment/bulk-delete/status?${params.toString()}`, {
          headers: {
            "x-user-token": userToken
          }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Failed to load bulk delete status");
        }
        setBulkDeleteProgress(data);
        if (Array.isArray(data.results) && data.results.length) {
          setBulkDeleteResults(data.results);
        }
        if (data.status === "completed") {
          setDeleteStatus(`Bulk delete finished. Deleted: ${data.deleted || 0}, skipped: ${data.skipped || 0}, errors: ${data.errors || 0}`);
          setBulkDeleteJobId("");
        } else if (data.status === "error") {
          setDeleteStatus(data.error || "Bulk delete failed.");
          setBulkDeleteJobId("");
        } else {
          const currentLabel = data.currentPaymentId ? ` Current ID: ${data.currentPaymentId}` : "";
          setDeleteStatus(`Processed ${data.processed || 0}/${data.total || 0}. Remaining: ${data.remaining || 0}. ETA: ${formatEta(data.etaMs)}.${currentLabel}`);
        }
      } catch (err) {
        setDeleteStatus(err.message);
        setBulkDeleteJobId("");
      }
    };
    poll();
    const interval = setInterval(poll, 2e3);
    return () => clearInterval(interval);
  }, [bulkDeleteJobId, userToken]);
  const handleInvoiceBulkDelete = () => runDocDelete({
    endpointBase: "invoice",
    file: invoiceDeleteFile,
    tenantId: selectedTenant,
    setLoading: setInvoiceDeleteLoading,
    setJobId: setInvoiceDeleteJobId,
    setProgress: setInvoiceDeleteProgress
  });
  const handleBillBulkDelete = () => runDocDelete({
    endpointBase: "bill",
    file: billDeleteFile,
    tenantId: selectedTenant,
    setLoading: setBillDeleteLoading,
    setJobId: setBillDeleteJobId,
    setProgress: setBillDeleteProgress
  });
  useEffect(() => {
    if (!invoiceDeleteJobId || !userToken) return;
    let failCount = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/invoice/bulk-delete/status?jobId=${invoiceDeleteJobId}`, { headers: { "x-user-token": userToken } });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setInvoiceDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Job not found — server restarted. Reconnect Xero and start again." }));
          setInvoiceDeleteJobId("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Status check failed");
        failCount = 0;
        setInvoiceDeleteProgress(data);
        if (data.status === "completed" || data.status === "cancelled" || data.status === "error") {
          setInvoiceDeleteJobId("");
        }
      } catch (err) {
        failCount++;
        if (failCount >= 4) {
          setInvoiceDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Server connection lost. Reconnect Xero and try again." }));
          setInvoiceDeleteJobId("");
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [invoiceDeleteJobId, userToken]);
  useEffect(() => {
    if (!billDeleteJobId || !userToken) return;
    let failCount = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/bill/bulk-delete/status?jobId=${billDeleteJobId}`, { headers: { "x-user-token": userToken } });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setBillDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Job not found — server restarted. Reconnect Xero and start again." }));
          setBillDeleteJobId("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Status check failed");
        failCount = 0;
        setBillDeleteProgress(data);
        if (data.status === "completed" || data.status === "cancelled" || data.status === "error") {
          setBillDeleteJobId("");
        }
      } catch (err) {
        failCount++;
        if (failCount >= 4) {
          setBillDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Server connection lost. Reconnect Xero and try again." }));
          setBillDeleteJobId("");
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [billDeleteJobId, userToken]);
  const handlePaymentBulkDelete = async () => {
    if (!userToken) return;
    if (!sessionId) { toast.error("Please connect to Xero first."); return; }
    if (!selectedTenant) { toast.error("Select a tenant first."); return; }
    if (!paymentDeleteFile) { toast.error("Upload a sheet first."); return; }
    setPaymentDeleteLoading(true);
    setPaymentDeleteProgress(null);
    setPaymentDeleteJobId("");
    try {
      const contentBase64 = await readFileAsBase64(paymentDeleteFile);
      const res = await fetch(`${API_BASE}/billpayment/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, filename: paymentDeleteFile.name, contentBase64 })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start payment delete job");
      setPaymentDeleteJobId(data.jobId || "");
      setPaymentDeleteProgress(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPaymentDeleteLoading(false);
    }
  };
  useEffect(() => {
    if (!paymentDeleteJobId || !userToken) return;
    let failCount = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/billpayment/bulk-delete/status?jobId=${paymentDeleteJobId}`, { headers: { "x-user-token": userToken } });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setPaymentDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Job not found — server restarted. Reconnect Xero and start again." }));
          setPaymentDeleteJobId("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Status check failed");
        failCount = 0;
        setPaymentDeleteProgress(data);
        if (data.status === "completed" || data.status === "cancelled" || data.status === "error") {
          setPaymentDeleteJobId("");
        }
      } catch (err) {
        failCount++;
        if (failCount >= 4) {
          setPaymentDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Server connection lost. Reconnect Xero and try again." }));
          setPaymentDeleteJobId("");
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [paymentDeleteJobId, userToken]);
  const handleOpDupFromSheet = async () => {
    if (!selectedTenant) { toast.error("Select a tenant first."); return; }
    if (!opDupRefSheet) { toast.error("Upload a sheet first."); return; }
    setOpDupRefLoading(true);
    setOpDupRefVoidResults(null);
    setOpDupVoidJobId("");
    setOpDupVoidProgress(null);
    try {
      const arrayBuffer = await opDupRefSheet.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      const headers = (rows[0] || []).map(h => String(h).toLowerCase());
      const refColIdx = headers.findIndex(h => /reference|ref\b/.test(h));
      const colIdx = refColIdx >= 0 ? refColIdx : 0;
      const refs = new Set();
      for (let i = 1; i < rows.length; i++) {
        const val = String(rows[i][colIdx] || "").trim();
        if (val) refs.add(val);
      }
      if (refs.size === 0) { toast.error("No references found in sheet."); setOpDupRefLoading(false); return; }
      const params = new URLSearchParams({ tenantId: selectedTenant, type: opDupScanType });
      setOpDupVoidProgress({ status: "scanning", message: "Scanning Xero for duplicates…", total: 0, done: 0, errors: 0, refsInSheet: refs.size });
      const scanRes = await fetch(`${API_BASE}/delete/overpayment-duplicates/scan?${params}`, { headers: { ...userHeader, "x-session-id": sessionId } });
      const scanData = await scanRes.json();
      if (!scanRes.ok) throw new Error(scanData.error || "Scan failed");
      const relevant = (scanData.duplicates || []).filter(g => refs.has(String(g.reference).trim()));
      if (relevant.length === 0) {
        toast.success("No duplicates found for the references in your sheet.");
        setOpDupRefVoidResults({ refsInSheet: refs.size, found: 0, voided: 0, errors: 0, results: [] });
        setOpDupVoidProgress(null);
        setOpDupRefLoading(false);
        return;
      }
      const voidGroups = relevant.map(g => ({ keep: g.entries[0].bankTransactionId, extras: g.entries.slice(1).map(e => e.bankTransactionId) }));
      const totalExtras = voidGroups.reduce((s, g) => s + g.extras.length, 0);
      setOpDupVoidProgress({ status: "voiding", message: `Found ${relevant.length} duplicate groups. Voiding ${totalExtras} extras…`, total: totalExtras, done: 0, errors: 0, refsInSheet: refs.size, found: relevant.length });
      const voidRes = await fetch(`${API_BASE}/delete/overpayment-duplicates/void`, {
        method: "POST",
        headers: { ...userHeader, "x-session-id": sessionId, "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId: selectedTenant, groups: voidGroups }),
      });
      const voidData = await voidRes.json();
      if (!voidRes.ok) throw new Error(voidData.error || "Void failed");
      setOpDupVoidJobId(voidData.jobId);
      // polling starts via useEffect
    } catch (err) {
      toast.error(err.message);
      setOpDupRefLoading(false);
      setOpDupVoidProgress(null);
    }
  };
  useEffect(() => {
    if (!opDupVoidJobId) return;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/delete/overpayment-duplicates/void/${opDupVoidJobId}`, { headers: { ...userHeader, "x-session-id": sessionId } });
        const d = await r.json();
        if (!r.ok) return;
        setOpDupVoidProgress(prev => ({ ...prev, status: d.status, done: d.done, errors: d.errors, total: d.total, message: d.status === "running" ? `Voiding… ${d.done} of ${d.total} done` : `Completed — ${d.done} voided, ${d.errors} errors` }));
        if (d.status !== "running") {
          clearInterval(interval);
          setOpDupRefVoidResults(prev => ({ ...(prev || {}), voided: d.done, errors: d.errors, results: d.results || [] }));
          setOpDupRefLoading(false);
          if (d.errors === 0) toast.success(`Done! ${d.done} duplicate overpayments voided.`);
          else {
            const firstErr = (d.results || []).find(r2 => r2.status === "error");
            toast.error(`${d.done} voided, ${d.errors} errors. ${firstErr ? firstErr.message : ""}`);
          }
        }
      } catch (_) {}
    };
    const interval = setInterval(poll, 1500);
    poll();
    return () => clearInterval(interval);
  }, [opDupVoidJobId]);

  const handleMjVoidByRef = async () => {
    if (!userToken) return;
    if (!sessionId) { toast.error("Please connect to Xero first."); return; }
    if (!selectedTenant) { toast.error("Select a tenant first."); return; }
    if (!mjVoidFile) { toast.error("Upload a sheet first."); return; }
    setMjVoidLoading(true);
    setMjVoidProgress(null);
    setMjVoidJobId("");
    try {
      const rows = await readFileAsMatrix(mjVoidFile);
      if (rows.length < 2) throw new Error("Sheet is empty or has no data rows.");
      const header = rows[0].map(h => String(h || "").trim().toLowerCase());
      const refCol = header.findIndex(h => h.includes("reference") || h.includes("narration") || h.includes("ref") || h === "journal reference" || h === "journal ref");
      if (refCol < 0) throw new Error("Column not found. Sheet must have a column named 'Journal Reference', 'Reference', or 'Narration'.");
      const references = rows.slice(1).map(r => String(r[refCol] || "").trim()).filter(Boolean);
      if (references.length === 0) throw new Error("No reference values found in sheet.");
      const res = await fetch(`${API_BASE}/delete/manual-journals-by-ref`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId },
        body: JSON.stringify({ references, tenantId: selectedTenant }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start job.");
      setMjVoidJobId(data.jobId);
      setMjVoidProgress({ status: "running", total: data.total, voided: 0, notFound: 0, failed: 0, message: "Starting..." });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setMjVoidLoading(false);
    }
  };
  useEffect(() => {
    if (!mjVoidJobId || !userToken) return;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/delete/manual-journals-by-ref/status?jobId=${mjVoidJobId}`, { headers: { "x-user-token": userToken } });
        const d = await r.json().catch(() => ({}));
        setMjVoidProgress(d);
        if (d.status === "done" || d.status === "error") setMjVoidJobId("");
      } catch (_) {}
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [mjVoidJobId, userToken]);
  const simpleDeleteEndpoints = {
    "quotes": "/delete/quotes",
    "purchase-orders": "/delete/purchase-orders",
    "spend-receive": "/delete/spend-receive",
    "bank-transfers": "/delete/bank-transfers",
    "contact-archive": "/delete/contacts/archive",
  };
  const handleSimpleDelete = async () => {
    if (!userToken) return;
    if (!sessionId) { toast.error("Please connect to Xero first."); return; }
    if (!selectedTenant) { toast.error("Select a tenant first."); return; }
    if (!simpleDeleteFile) { toast.error("Upload a CSV file first."); return; }
    const endpoint = simpleDeleteEndpoints[activeDeleteType];
    if (!endpoint) return;
    setSimpleDeleteLoading(true);
    setSimpleDeleteProgress(null);
    setSimpleDeleteJobId("");
    try {
      const contentBase64 = await readFileAsBase64(simpleDeleteFile);
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-user-token": userToken, "x-session-id": sessionId, "x-tenant-id": selectedTenant },
        body: JSON.stringify({ tenantId: selectedTenant, filename: simpleDeleteFile.name, contentBase64, sessionId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to start job.");
      setSimpleDeleteJobId(data.jobId || "");
      setSimpleDeleteProgress(data);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSimpleDeleteLoading(false);
    }
  };
  useEffect(() => {
    if (!simpleDeleteJobId || !userToken) return;
    const endpoint = simpleDeleteEndpoints[activeDeleteType];
    if (!endpoint) return;
    let failCount = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}${endpoint}/status?jobId=${simpleDeleteJobId}`, { headers: { "x-user-token": userToken } });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setSimpleDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Job not found — server may have restarted." })); setSimpleDeleteJobId(""); return; }
        if (!res.ok) throw new Error(data.error || "Status check failed");
        failCount = 0;
        setSimpleDeleteProgress(data);
        if (["completed", "cancelled", "failed"].includes(data.status)) setSimpleDeleteJobId("");
      } catch (err) {
        failCount++;
        if (failCount >= 4) { setSimpleDeleteProgress(prev => ({ ...(prev || {}), status: "error", error: "Connection lost." })); setSimpleDeleteJobId(""); }
      }
    };
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [simpleDeleteJobId, userToken, activeDeleteType]);
  useEffect(() => {
    setSimpleDeleteFile(null); setSimpleDeleteProgress(null); setSimpleDeleteJobId("");
  }, [activeDeleteType]);

  useEffect(() => {
    if (!sessionId) return;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = "Xero se disconnect karo pehle — tab close karne se Xero slot block ho jayega.";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [sessionId]);

  useEffect(() => {
    if (!userToken) return;
    const fetchQuota = () => {
      fetch(`${API_BASE}/quota`, { headers: { "x-user-token": userToken } })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && d.dayRemaining !== null && d.dayRemaining !== undefined) setXeroQuota(d.dayRemaining); })
        .catch(() => {});
    };
    fetchQuota();
    const iv = setInterval(() => { fetchQuota(); }, 60000);
    return () => clearInterval(iv);
  }, [userToken]);
  useEffect(() => {
    if (!filterDeleteJobId || !userToken) return;
    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/delete/by-filter/status?jobId=${filterDeleteJobId}`, { headers: { "x-user-token": userToken } });
        const d = await r.json().catch(() => ({}));
        setFilterDeleteProgress(d);
        if (["completed", "cancelled", "error"].includes(d.status)) { setFilterDeleteJobId(""); setFilterDeleteRunning(false); }
      } catch (_) {}
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => clearInterval(iv);
  }, [filterDeleteJobId, userToken]);
  useEffect(() => {
    if (isImportHistoryPage && userToken) loadImportHistory();
  }, [isImportHistoryPage, userToken]);
  useEffect(() => {
    if (userToken) loadCheckpoints();
  }, [userToken]);
  useEffect(() => {
    if (!accountsImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      accounts: accountsImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: accountsImportJobId
        });
        const res = await fetch(`${API_BASE}/import/accounts/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setAccountsImportJobId("");
          setAccountsImportLoading(false);
          setAccountsImportStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load import progress.");
        consecutiveFailures = 0;
        setAccountsImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setAccountsImportJobId("");
          setAccountsImportLoading(false);
          if (data.status !== "error") {
            setAccountsImportRows([]);
            setAccountsImportFile(null);
          }
          setAccountsImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} account(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setAccountsImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} rows processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setAccountsImportStatus("Connection lost. Job may still be running on server.");
          setAccountsImportJobId("");
          setAccountsImportLoading(false);
        } else {
          setAccountsImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [accountsImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!itemsImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      items: itemsImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: itemsImportJobId
        });
        const res = await fetch(`${API_BASE}/import/items/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setItemsImportJobId("");
          setItemsImportLoading(false);
          setItemsImportStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load items import progress.");
        consecutiveFailures = 0;
        setItemsImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setItemsImportJobId("");
          setItemsImportLoading(false);
          if (data.status !== "error") {
            setItemsImportRows([]);
            setItemsImportFile(null);
          }
          setItemsImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} item(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setItemsImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} rows processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setItemsImportStatus("Connection lost. Job may still be running on server.");
          setItemsImportJobId("");
          setItemsImportLoading(false);
        } else {
          setItemsImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [itemsImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!customersImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      customers: customersImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: customersImportJobId
        });
        const res = await fetch(`${API_BASE}/import/customers/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setCustomersImportJobId("");
          setCustomersImportLoading(false);
          setCustomersImportStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load customers import progress.");
        consecutiveFailures = 0;
        setCustomersImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setCustomersImportJobId("");
          setCustomersImportLoading(false);
          if (data.status !== "error") {
            setCustomersImportRows([]);
            setCustomersImportFile(null);
          }
          setCustomersImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} customer(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setCustomersImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} rows processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setCustomersImportStatus("Connection lost. Job may still be running on server.");
          setCustomersImportJobId("");
          setCustomersImportLoading(false);
        } else {
          setCustomersImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [customersImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!vendorsImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      vendors: vendorsImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: vendorsImportJobId
        });
        const res = await fetch(`${API_BASE}/import/vendors/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setVendorsImportJobId("");
          setVendorsImportLoading(false);
          setVendorsImportStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load vendors import progress.");
        consecutiveFailures = 0;
        setVendorsImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setVendorsImportJobId("");
          setVendorsImportLoading(false);
          if (data.status !== "error") {
            setVendorsImportRows([]);
            setVendorsImportFile(null);
          }
          setVendorsImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} vendor(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setVendorsImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} rows processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setVendorsImportStatus("Connection lost. Job may still be running on server.");
          setVendorsImportJobId("");
          setVendorsImportLoading(false);
        } else {
          setVendorsImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [vendorsImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!trackingCatImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "tracking-categories": trackingCatImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: trackingCatImportJobId
        });
        const res = await fetch(`${API_BASE}/import/tracking-categories/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setTrackingCatImportJobId("");
          setTrackingCatImportLoading(false);
          setTrackingCatImportStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load tracking categories import progress.");
        consecutiveFailures = 0;
        setTrackingCatImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setTrackingCatImportJobId("");
          setTrackingCatImportLoading(false);
          if (data.status !== "error") {
            setTrackingCatImportRows([]);
            setTrackingCatImportFile(null);
          }
          setTrackingCatImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} option(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setTrackingCatImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} rows processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setTrackingCatImportStatus("Connection lost. Job may still be running on server.");
          setTrackingCatImportJobId("");
          setTrackingCatImportLoading(false);
        } else {
          setTrackingCatImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [trackingCatImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!poImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "purchase-orders": poImportJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: poImportJobId });
        const res = await fetch(`${API_BASE}/import/purchase-orders/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setPoImportJobId(""); setPoImportLoading(false); setPoImportStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load Purchase Orders import progress.");
        consecutiveFailures = 0;
        setPoImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setPoImportJobId("");
          setPoImportLoading(false);
          if (data.status !== "error") { setPoImportRows([]); setPoImportFile(null); }
          setPoImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} purchase order(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setPoImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} purchase orders processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setPoImportStatus("Connection lost. Job may still be running on server."); setPoImportJobId(""); setPoImportLoading(false); }
        else { setPoImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`); }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [poImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!quotesImportJobId || !userToken) return;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: quotesImportJobId });
        const res = await fetch(`${API_BASE}/import/quotes/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setQuotesImportJobId(""); setQuotesImportLoading(false); setQuotesImportStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load Quotes import progress.");
        consecutiveFailures = 0;
        setQuotesImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setQuotesImportJobId("");
          setQuotesImportLoading(false);
          if (data.status !== "error") { setQuotesImportRows([]); setQuotesImportFile(null); }
          setQuotesImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} quote(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setQuotesImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} quotes processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setQuotesImportStatus("Connection lost. Job may still be running on server."); setQuotesImportJobId(""); setQuotesImportLoading(false); }
        else { setQuotesImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`); }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [quotesImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!updateStatusJobId || !userToken) return;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: updateStatusJobId });
        const res = await fetch(`${API_BASE}/update/status/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setUpdateStatusJobId(""); setUpdateStatusLoading(false); setUpdateStatusStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load update progress.");
        consecutiveFailures = 0;
        setUpdateStatusProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setUpdateStatusJobId("");
          setUpdateStatusLoading(false);
          if (data.status !== "error") { setUpdateStatusRows([]); setUpdateStatusFile(null); }
          setUpdateStatusStatus(data.status === "completed" ? `Update completed. ${data.created || 0} record(s) updated successfully.` : data.status === "completed_with_errors" ? `Update completed with errors. Updated: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Update failed.");
        } else {
          setUpdateStatusStatus(`Update in progress: ${data.processed || 0}/${data.total || 0} records processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setUpdateStatusStatus("Connection lost. Job may still be running on server."); setUpdateStatusJobId(""); setUpdateStatusLoading(false); }
        else { setUpdateStatusStatus(`Network issue (retry ${consecutiveFailures}/10)...`); }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [updateStatusJobId, userToken, userHeader]);
  useEffect(() => {
    if (!bankTransferJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "bank-transfers": bankTransferJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: bankTransferJobId });
        const res = await fetch(`${API_BASE}/import/bank-transfers/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setBankTransferJobId(""); setBankTransferLoading(false); setBankTransferStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load import progress.");
        consecutiveFailures = 0;
        setBankTransferProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setBankTransferJobId("");
          setBankTransferLoading(false);
          if (data.status !== "error") { setBankTransferRows([]); setBankTransferFile(null); }
          setBankTransferStatus(
            data.status === "completed" ? `Import completed. ${data.created || 0} transfer(s) created.` :
            data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}, Errors: ${data.errors || 0}.` :
            data.error || "Import failed."
          );
        } else {
          setBankTransferStatus(`Importing: ${data.processed || 0}/${data.total || 0} transfers processed...`);
        }
      } catch {
        consecutiveFailures++;
        if (consecutiveFailures >= 10) { setBankTransferStatus("Connection lost."); setBankTransferJobId(""); setBankTransferLoading(false); }
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [bankTransferJobId, userToken, userHeader]);
  useEffect(() => {
    const saved = localStorage.getItem("erUpdateJobId");
    if (saved) { setExchangeRateUpdateJobId(saved); setExchangeRateUpdateLoading(true); }
  }, []);
  useEffect(() => {
    if (!exchangeRateUpdateJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "exchange-rate-update": exchangeRateUpdateJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: exchangeRateUpdateJobId });
        const res = await fetch(`${API_BASE}/import/exchange-rate-update/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setExchangeRateUpdateJobId(""); setExchangeRateUpdateLoading(false); setExchangeRateUpdateStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load update progress.");
        consecutiveFailures = 0;
        setExchangeRateUpdateProgress(data);
        if (["completed", "error"].includes(data.status)) {
          setExchangeRateUpdateJobId("");
          localStorage.removeItem("erUpdateJobId");
          setExchangeRateUpdateLoading(false);
          if (data.status !== "error") { setExchangeRateUpdateRows([]); setExchangeRateUpdateFile(null); }
          setExchangeRateUpdateStatus(data.status === "completed"
            ? `Update completed. ${data.created || 0} invoice(s) updated, ${data.errors || 0} error(s).`
            : data.error || "Update failed.");
        } else {
          setExchangeRateUpdateStatus(`Updating: ${data.processed || 0}/${data.total || 0} processed...`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setExchangeRateUpdateStatus("Connection lost."); setExchangeRateUpdateJobId(""); localStorage.removeItem("erUpdateJobId"); setExchangeRateUpdateLoading(false); }
      }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [exchangeRateUpdateJobId, userToken, userHeader]);
  useEffect(() => {
    if (!billsImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      bills: billsImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: billsImportJobId
        });
        const res = await fetch(`${API_BASE}/import/bills/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setBillsImportProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify how many bills were created." }));
          setBillsImportJobId("");
          setBillsImportLoading(false);
          setBillsImportStatus("⚠️ Import interrupted — server restarted. Check Xero for created records.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load bills import progress.");
        consecutiveFailures = 0;
        setBillsImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setBillsImportJobId("");
          setBillsImportLoading(false);
          if (data.status !== "error") {
            setBillsImportRows([]);
            setBillsImportFile(null);
          }
          setBillsImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} bill(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Bills", "bills");
        } else {
          setBillsImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} bills processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setBillsImportStatus("Connection lost. Job may still be running on server.");
          setBillsImportJobId("");
          setBillsImportLoading(false);
        } else {
          setBillsImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [billsImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!invoicesImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      invoices: invoicesImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: invoicesImportJobId
        });
        const res = await fetch(`${API_BASE}/import/invoices/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setInvoicesImportProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify how many invoices were created." }));
          setInvoicesImportJobId("");
          setInvoicesImportLoading(false);
          setInvoicesImportStatus("⚠️ Import interrupted — server restarted. Check Xero for created records.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load invoices import progress.");
        consecutiveFailures = 0;
        setInvoicesImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setInvoicesImportJobId("");
          setInvoicesImportLoading(false);
          if (data.status !== "error") {
            setInvoicesImportRows([]);
            setInvoicesImportFile(null);
          }
          setInvoicesImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} invoice(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Invoices", "invoices");
        } else {
          setInvoicesImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} invoices processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setInvoicesImportStatus("Connection lost. Job may still be running on server.");
          setInvoicesImportJobId("");
          setInvoicesImportLoading(false);
        } else {
          setInvoicesImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [invoicesImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (!creditNotesImportJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "credit-notes": creditNotesImportJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: creditNotesImportJobId
        });
        const res = await fetch(`${API_BASE}/import/credit-notes/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setCreditNotesImportProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify how many credit notes were created." }));
          setCreditNotesImportJobId("");
          setCreditNotesImportLoading(false);
          setCreditNotesImportStatus("⚠️ Import interrupted — server restarted. Check Xero for created records.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load credit notes import progress.");
        consecutiveFailures = 0;
        setCreditNotesImportProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setCreditNotesImportJobId("");
          setCreditNotesImportLoading(false);
          if (data.status !== "error") {
            setCreditNotesImportRows([]);
            setCreditNotesImportFile(null);
          }
          setCreditNotesImportStatus(data.status === "completed" ? `Import completed. ${data.created || 0} credit note(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setCreditNotesImportStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} credit notes processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setCreditNotesImportStatus("Connection lost. Job may still be running on server.");
          setCreditNotesImportJobId("");
          setCreditNotesImportLoading(false);
        } else {
          setCreditNotesImportStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [creditNotesImportJobId, userToken, userHeader]);
  useEffect(() => {
    if (billPaymentJobId) localStorage.setItem("kk_billPaymentJobId", billPaymentJobId);else localStorage.removeItem("kk_billPaymentJobId");
  }, [billPaymentJobId]);
  useEffect(() => {
    if (invoicePaymentJobId) localStorage.setItem("kk_invoicePaymentJobId", invoicePaymentJobId);else localStorage.removeItem("kk_invoicePaymentJobId");
  }, [invoicePaymentJobId]);
  useEffect(() => {
    if (creditNoteRefundJobId) localStorage.setItem("kk_creditNoteRefundJobId", creditNoteRefundJobId);else localStorage.removeItem("kk_creditNoteRefundJobId");
  }, [creditNoteRefundJobId]);
  useEffect(() => {
    if (accountsImportJobId) localStorage.setItem("kk_accountsJobId", accountsImportJobId);else localStorage.removeItem("kk_accountsJobId");
  }, [accountsImportJobId]);
  useEffect(() => {
    if (billsImportJobId) localStorage.setItem("kk_billsJobId", billsImportJobId);else localStorage.removeItem("kk_billsJobId");
  }, [billsImportJobId]);
  useEffect(() => {
    if (invoicesImportJobId) localStorage.setItem("kk_invoicesJobId", invoicesImportJobId);else localStorage.removeItem("kk_invoicesJobId");
  }, [invoicesImportJobId]);
  useEffect(() => {
    if (creditNotesImportJobId) localStorage.setItem("kk_creditNotesJobId", creditNotesImportJobId);else localStorage.removeItem("kk_creditNotesJobId");
  }, [creditNotesImportJobId]);
  useEffect(() => {
    if (spendMoneyJobId) localStorage.setItem("kk_spendMoneyJobId", spendMoneyJobId);else localStorage.removeItem("kk_spendMoneyJobId");
  }, [spendMoneyJobId]);
  useEffect(() => {
    if (receiveMoneyJobId) localStorage.setItem("kk_receiveMoneyJobId", receiveMoneyJobId);else localStorage.removeItem("kk_receiveMoneyJobId");
  }, [receiveMoneyJobId]);
  useEffect(() => {
    if (manualJournalJobId) localStorage.setItem("kk_manualJournalJobId", manualJournalJobId);else localStorage.removeItem("kk_manualJournalJobId");
  }, [manualJournalJobId]);
  useEffect(() => {
    if (spendOpJobId) localStorage.setItem("kk_spendOpJobId", spendOpJobId);else localStorage.removeItem("kk_spendOpJobId");
  }, [spendOpJobId]);
  useEffect(() => {
    if (receiveOpJobId) localStorage.setItem("kk_receiveOpJobId", receiveOpJobId);else localStorage.removeItem("kk_receiveOpJobId");
  }, [receiveOpJobId]);
  useEffect(() => {
    if (spendAllocJobId) localStorage.setItem("kk_spendAllocJobId", spendAllocJobId);else localStorage.removeItem("kk_spendAllocJobId");
  }, [spendAllocJobId]);
  useEffect(() => {
    if (receiveAllocJobId) localStorage.setItem("kk_receiveAllocJobId", receiveAllocJobId);else localStorage.removeItem("kk_receiveAllocJobId");
  }, [receiveAllocJobId]);
  useEffect(() => {
    if (itemsImportJobId) localStorage.setItem("kk_itemsJobId", itemsImportJobId);else localStorage.removeItem("kk_itemsJobId");
  }, [itemsImportJobId]);
  useEffect(() => {
    if (customersImportJobId) localStorage.setItem("kk_customersJobId", customersImportJobId);else localStorage.removeItem("kk_customersJobId");
  }, [customersImportJobId]);
  useEffect(() => {
    if (vendorsImportJobId) localStorage.setItem("kk_vendorsJobId", vendorsImportJobId);else localStorage.removeItem("kk_vendorsJobId");
  }, [vendorsImportJobId]);
  useEffect(() => {
    if (trackingCatImportJobId) localStorage.setItem("kk_trackingCatJobId", trackingCatImportJobId);else localStorage.removeItem("kk_trackingCatJobId");
  }, [trackingCatImportJobId]);
  useEffect(() => {
    if (!billPaymentJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "bill-payments": billPaymentJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: billPaymentJobId
        });
        const res = await fetch(`${API_BASE}/import/bill-payments/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setBillPaymentProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify payments created." }));
          setBillPaymentJobId("");
          setBillPaymentLoading(false);
          setBillPaymentStatus("⚠️ Import interrupted — server restarted.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load bill payment import progress.");
        consecutiveFailures = 0;
        setBillPaymentProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setBillPaymentJobId("");
          setBillPaymentLoading(false);
          if (data.status !== "error") {
            setBillPaymentRows([]);
            setBillPaymentFile(null);
          }
          setBillPaymentStatus(data.status === "completed" ? `Import completed. ${data.created || 0} payment(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Bill Payments", "bill-payments");
        } else {
          setBillPaymentStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} payments processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setBillPaymentStatus(`Connection lost after ${consecutiveFailures} retries. Job may still be running on server.`);
          setBillPaymentJobId("");
          setBillPaymentLoading(false);
        } else {
          setBillPaymentStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2e3);
    return () => clearInterval(interval);
  }, [billPaymentJobId, userToken, userHeader]);
  useEffect(() => {
    if (!invoicePaymentJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "invoice-payments": invoicePaymentJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: invoicePaymentJobId
        });
        const res = await fetch(`${API_BASE}/import/invoice-payments/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setInvoicePaymentProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify payments created." }));
          setInvoicePaymentJobId("");
          setInvoicePaymentLoading(false);
          setInvoicePaymentStatus("⚠️ Import interrupted — server restarted.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load invoice payment import progress.");
        consecutiveFailures = 0;
        setInvoicePaymentProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setInvoicePaymentJobId("");
          setInvoicePaymentLoading(false);
          if (data.status !== "error") {
            setInvoicePaymentRows([]);
            setInvoicePaymentFile(null);
          }
          setInvoicePaymentStatus(data.status === "completed" ? `Import completed. ${data.created || 0} payment(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Invoice Payments", "invoice-payments");
        } else {
          setInvoicePaymentStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} payments processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setInvoicePaymentStatus(`Connection lost after ${consecutiveFailures} retries. Job may still be running on server.`);
          setInvoicePaymentJobId("");
          setInvoicePaymentLoading(false);
        } else {
          setInvoicePaymentStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2e3);
    return () => clearInterval(interval);
  }, [invoicePaymentJobId, userToken, userHeader]);
  useEffect(() => {
    if (!creditNoteRefundJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "credit-note-refunds": creditNoteRefundJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: creditNoteRefundJobId });
        const res = await fetch(`${API_BASE}/import/credit-note-refunds/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setCreditNoteRefundProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify refunds created." }));
          setCreditNoteRefundJobId("");
          setCreditNoteRefundLoading(false);
          setCreditNoteRefundStatus("⚠️ Import interrupted — server restarted.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load credit note refund import progress.");
        consecutiveFailures = 0;
        setCreditNoteRefundProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setCreditNoteRefundJobId("");
          setCreditNoteRefundLoading(false);
          if (data.status !== "error") {
            setCreditNoteRefundRows([]);
            setCreditNoteRefundFile(null);
          }
          setCreditNoteRefundStatus(
            data.status === "completed" ? `Import completed. ${data.created || 0} refund(s) created successfully.` :
            data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` :
            data.error || "Import failed."
          );
          notifyImportDone(data, "Credit Note Refunds", "credit-note-refunds");
        } else {
          setCreditNoteRefundStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} refunds processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setCreditNoteRefundStatus(`Connection lost after ${consecutiveFailures} retries. Job may still be running on server.`);
          setCreditNoteRefundJobId("");
          setCreditNoteRefundLoading(false);
        } else {
          setCreditNoteRefundStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 2e3);
    return () => clearInterval(interval);
  }, [creditNoteRefundJobId, userToken, userHeader]);
  useEffect(() => {
    if (!manualJournalJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "manual-journals": manualJournalJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: manualJournalJobId
        });
        const res = await fetch(`${API_BASE}/import/manual-journals/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setManualJournalProgress(prev => ({ ...(prev || {}), status: "interrupted", error: "Server restarted mid-import. Check Xero to verify journals created." }));
          setManualJournalJobId("");
          setManualJournalLoading(false);
          setManualJournalStatus("⚠️ Import interrupted — server restarted.");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load manual journal import progress.");
        consecutiveFailures = 0;
        setManualJournalProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setManualJournalJobId("");
          setManualJournalLoading(false);
          setManualJournalStatus(data.status === "completed" ? `Import completed. ${data.created || 0} journal(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Manual Journals", "manual-journals");
        } else {
          setManualJournalStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} journals processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setManualJournalStatus("Connection lost. Job may still be running on server.");
          setManualJournalJobId("");
          setManualJournalLoading(false);
        } else {
          setManualJournalStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [manualJournalJobId, userToken, userHeader]);
  useEffect(() => {
    if (!spendMoneyJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "spend-money": spendMoneyJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: spendMoneyJobId
        });
        const res = await fetch(`${API_BASE}/import/spend-money/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setSpendMoneyJobId("");
          setSpendMoneyLoading(false);
          setSpendMoneyStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load spend money import progress.");
        consecutiveFailures = 0;
        setSpendMoneyProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setSpendMoneyJobId("");
          setSpendMoneyLoading(false);
          if (data.status !== "error") {
            setSpendMoneyRows([]);
            setSpendMoneyFile(null);
          }
          setSpendMoneyStatus(data.status === "completed" ? `Import completed. ${data.created || 0} transaction(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Spend Money", "spend-money");
        } else {
          setSpendMoneyStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setSpendMoneyStatus("Connection lost. Job may still be running on server.");
          setSpendMoneyJobId("");
          setSpendMoneyLoading(false);
        } else {
          setSpendMoneyStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [spendMoneyJobId, userToken, userHeader]);
  useEffect(() => {
    if (!receiveMoneyJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "receive-money": receiveMoneyJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: receiveMoneyJobId
        });
        const res = await fetch(`${API_BASE}/import/receive-money/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setReceiveMoneyJobId("");
          setReceiveMoneyLoading(false);
          setReceiveMoneyStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load receive money import progress.");
        consecutiveFailures = 0;
        setReceiveMoneyProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setReceiveMoneyJobId("");
          setReceiveMoneyLoading(false);
          if (data.status !== "error") {
            setReceiveMoneyRows([]);
            setReceiveMoneyFile(null);
          }
          setReceiveMoneyStatus(data.status === "completed" ? `Import completed. ${data.created || 0} transaction(s) created successfully.` : data.status === "completed_with_errors" ? `Import completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
          notifyImportDone(data, "Receive Money", "receive-money");
        } else {
          setReceiveMoneyStatus(`Import in progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setReceiveMoneyStatus("Connection lost. Job may still be running on server.");
          setReceiveMoneyJobId("");
          setReceiveMoneyLoading(false);
        } else {
          setReceiveMoneyStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [receiveMoneyJobId, userToken, userHeader]);
  useEffect(() => {
    if (!spendOpJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "spend-op": spendOpJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: spendOpJobId
        });
        const res = await fetch(`${API_BASE}/import/overpayment/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setSpendOpJobId("");
          setSpendOpLoading(false);
          setSpendOpStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setSpendOpProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setSpendOpJobId("");
          setSpendOpLoading(false);
          if (data.status !== "error") {
            setSpendOpRows([]);
            setSpendOpFile(null);
          }
          setSpendOpStatus(data.status === "completed" ? `Completed. ${data.created || 0} created${data.skipped ? `, ${data.skipped} skipped (already in Xero)` : ""}.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}${data.skipped ? `, skipped: ${data.skipped}` : ""}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setSpendOpStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setSpendOpStatus("Connection lost. Job may still be running on server.");
          setSpendOpJobId("");
          setSpendOpLoading(false);
        } else {
          setSpendOpStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [spendOpJobId, userToken, userHeader]);
  useEffect(() => {
    if (!receiveOpJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "receive-op": receiveOpJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: receiveOpJobId
        });
        const res = await fetch(`${API_BASE}/import/overpayment/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setReceiveOpJobId("");
          setReceiveOpLoading(false);
          setReceiveOpStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setReceiveOpProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setReceiveOpJobId("");
          setReceiveOpLoading(false);
          if (data.status !== "error") {
            setReceiveOpRows([]);
            setReceiveOpFile(null);
          }
          setReceiveOpStatus(data.status === "completed" ? `Completed. ${data.created || 0} created${data.skipped ? `, ${data.skipped} skipped (already in Xero)` : ""}.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}${data.skipped ? `, skipped: ${data.skipped}` : ""}, errors: ${data.errors || 0}.` : data.error || "Import failed.");
        } else {
          setReceiveOpStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setReceiveOpStatus("Connection lost. Job may still be running on server.");
          setReceiveOpJobId("");
          setReceiveOpLoading(false);
        } else {
          setReceiveOpStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [receiveOpJobId, userToken, userHeader]);
  useEffect(() => {
    if (!spendAllocJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "spend-allocation": spendAllocJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: spendAllocJobId
        });
        const res = await fetch(`${API_BASE}/import/overpayment-allocation/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setSpendAllocJobId("");
          setSpendAllocLoading(false);
          setSpendAllocStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setSpendAllocProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setSpendAllocJobId("");
          setSpendAllocLoading(false);
          if (data.status !== "error") {
            setSpendAllocRows([]);
            setSpendAllocFile(null);
          }
          setSpendAllocStatus(data.status === "completed" ? `Completed. ${data.created || 0} allocation(s) done.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Allocation failed.");
        } else {
          setSpendAllocStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setSpendAllocStatus("Connection lost. Job may still be running on server.");
          setSpendAllocJobId("");
          setSpendAllocLoading(false);
        } else {
          setSpendAllocStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [spendAllocJobId, userToken, userHeader]);
  useEffect(() => {
    if (!receiveAllocJobId || !userToken) return;
    setLastImportJobIds(prev => ({
      ...prev,
      "receive-allocation": receiveAllocJobId
    }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({
          jobId: receiveAllocJobId
        });
        const res = await fetch(`${API_BASE}/import/overpayment-allocation/status?${params.toString()}`, {
          headers: userHeader
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          setReceiveAllocJobId("");
          setReceiveAllocLoading(false);
          setReceiveAllocStatus("");
          return;
        }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setReceiveAllocProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setReceiveAllocJobId("");
          setReceiveAllocLoading(false);
          if (data.status !== "error") {
            setReceiveAllocRows([]);
            setReceiveAllocFile(null);
          }
          setReceiveAllocStatus(data.status === "completed" ? `Completed. ${data.created || 0} allocation(s) done.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Allocation failed.");
        } else {
          setReceiveAllocStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          setReceiveAllocStatus("Connection lost. Job may still be running on server.");
          setReceiveAllocJobId("");
          setReceiveAllocLoading(false);
        } else {
          setReceiveAllocStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [receiveAllocJobId, userToken, userHeader]);
  useEffect(() => {
    if (!cnAllocJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "cn-allocation": cnAllocJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: cnAllocJobId });
        const res = await fetch(`${API_BASE}/import/credit-note-allocation/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setCnAllocJobId(""); setCnAllocLoading(false); setCnAllocStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setCnAllocProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setCnAllocJobId("");
          setCnAllocLoading(false);
          if (data.status !== "error") { setCnAllocRows([]); setCnAllocFile(null); }
          setCnAllocStatus(data.status === "completed" ? `Completed. ${data.created || 0} allocation(s) done.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Allocation failed.");
        } else {
          setCnAllocStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setCnAllocStatus("Connection lost. Job may still be running on server."); setCnAllocJobId(""); setCnAllocLoading(false); }
        else setCnAllocStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [cnAllocJobId, userToken, userHeader]);
  useEffect(() => {
    if (!dnAllocJobId || !userToken) return;
    setLastImportJobIds(prev => ({ ...prev, "dn-allocation": dnAllocJobId }));
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const params = new URLSearchParams({ jobId: dnAllocJobId });
        const res = await fetch(`${API_BASE}/import/credit-note-allocation/status?${params.toString()}`, { headers: userHeader });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) { setDnAllocJobId(""); setDnAllocLoading(false); setDnAllocStatus(""); return; }
        if (!res.ok) throw new Error(data.error || "Failed to load progress.");
        consecutiveFailures = 0;
        setDnAllocProgress(data);
        if (["completed", "completed_with_errors", "error"].includes(data.status)) {
          setDnAllocJobId("");
          setDnAllocLoading(false);
          if (data.status !== "error") { setDnAllocRows([]); setDnAllocFile(null); }
          setDnAllocStatus(data.status === "completed" ? `Completed. ${data.created || 0} allocation(s) done.` : data.status === "completed_with_errors" ? `Completed with errors. Created: ${data.created || 0}, errors: ${data.errors || 0}.` : data.error || "Allocation failed.");
        } else {
          setDnAllocStatus(`In progress: ${data.processed || 0}/${data.total || 0} processed.`);
        }
      } catch (err) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) { setDnAllocStatus("Connection lost. Job may still be running on server."); setDnAllocJobId(""); setDnAllocLoading(false); }
        else setDnAllocStatus(`Network issue (retry ${consecutiveFailures}/10)... Import still running on server.`);
      }
    };
    poll();
    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [dnAllocJobId, userToken, userHeader]);
  if (isTermsPage) return <Terms onBack={() => navigate(user ? -1 : "/")} />;
  if (isPrivacyPage) return <Privacy onBack={() => navigate(user ? -1 : "/")} />;
  if (isPricingPage) return <Pricing onBack={() => navigate(user ? -1 : "/")} userToken={userToken} />;
  if (isAccountPage && user) return <Account user={user} userToken={userToken} onBack={() => navigate(-1)} onNavigatePricing={() => navigate("/pricing")} />;
  if (isSignupPage) return <Signup onBack={() => navigate("/pricing")} onLoginSuccess={(token, u) => { setUserToken(token); setUser(u); setUserRole(u.isAdmin ? "admin" : (u.role || "importer")); setUserPermissions(u.permissions || ["import"]); navigate("/import"); }} />;
  if (isPricingSuccessPage) return <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#030b18",color:"#fff",gap:20,padding:40,textAlign:"center"}}>
    <div style={{width:72,height:72,borderRadius:"50%",background:"rgba(45,212,191,0.12)",border:"2.5px solid #2dd4bf",display:"flex",alignItems:"center",justifyContent:"center",fontSize:34}}>✓</div>
    <div>
      <h1 style={{fontSize:30,fontWeight:800,margin:"0 0 10px"}}>Payment Successful!</h1>
      <p style={{color:"rgba(255,255,255,0.55)",fontSize:15,maxWidth:420,margin:0,lineHeight:1.6}}>Your ImportMyBooks plan is now <strong style={{color:"#2dd4bf"}}>active</strong>. You have immediate access — no approval needed.</p>
    </div>
    <div style={{background:"rgba(45,212,191,0.07)",border:"1px solid rgba(45,212,191,0.2)",borderRadius:12,padding:"16px 28px",display:"flex",flexDirection:"column",gap:4,minWidth:260}}>
      <div style={{fontSize:12,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.07em"}}>What's next</div>
      {["Connect your Xero organisation","Choose an import type","Upload your CSV and import"].map((s,i)=><div key={i} style={{fontSize:13,color:"rgba(255,255,255,0.65)",display:"flex",alignItems:"center",gap:8}}><span style={{width:20,height:20,borderRadius:"50%",background:"rgba(45,212,191,0.2)",border:"1px solid rgba(45,212,191,0.4)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:"#2dd4bf",flexShrink:0}}>{i+1}</span>{s}</div>)}
    </div>
    <button type="button" style={{padding:"12px 36px",background:"#2dd4bf",color:"#071929",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}} onClick={async()=>{if(userToken){try{const r=await fetch(`${API_BASE}/user/me`,{headers:{"x-user-token":userToken}});const d=await r.json();if(d.user){setUser(d.user);setUserRole(d.user.isAdmin?"admin":(d.user.role||"importer"));setUserPermissions(d.user.permissions||["import"]);}}catch(e){}}navigate(user?"/import":"/");}}>Go to ImportMyBooks →</button>
  </div>;
  const handleForgotPw = async () => {
    if (!forgotPwEmail || !forgotPwEmail.includes("@")) return;
    setForgotPwLoading(true);
    try {
      await fetch(`${API_BASE}/user/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: forgotPwEmail }) });
      setForgotPwSent(true);
    } catch {}
    setForgotPwLoading(false);
  };
  if (!user) {
    if (!sessionChecked) return <div style={{ minHeight: "100vh", background: "#0C2040" }} />;
    if (currentPath === "/") return <LandingPage onLogin={() => navigate("/login")} />;
    return <div className="auth-layout">
      {forgotPwOpen && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",backdropFilter:"blur(6px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget){setForgotPwOpen(false);}}}>
        <div style={{background:"var(--panel)",border:"1px solid var(--border)",borderRadius:14,width:"100%",maxWidth:400,padding:28,boxShadow:"0 40px 100px rgba(0,0,0,0.65)"}}>
          {forgotPwSent ? <>
            <div style={{fontSize:32,textAlign:"center",marginBottom:12}}>✅</div>
            <h3 style={{margin:"0 0 8px",fontSize:17,fontWeight:700,textAlign:"center"}}>Check your email</h3>
            <p style={{margin:"0 0 20px",fontSize:13,color:"var(--muted)",textAlign:"center",lineHeight:1.6}}>If an account exists for <strong>{forgotPwEmail}</strong>, a temporary password has been sent.</p>
            <button className="btn primary" type="button" style={{width:"100%"}} onClick={()=>setForgotPwOpen(false)}>Back to Login</button>
          </> : <>
            <h3 style={{margin:"0 0 6px",fontSize:17,fontWeight:700}}>Reset Password</h3>
            <p style={{margin:"0 0 20px",fontSize:13,color:"var(--muted)"}}>Enter your account email — we'll send a temporary password.</p>
            <label style={{display:"block",fontSize:12,fontWeight:600,color:"var(--muted)",marginBottom:6,textTransform:"uppercase",letterSpacing:0.6}}>Email</label>
            <input type="email" value={forgotPwEmail} onChange={e=>setForgotPwEmail(e.target.value)} placeholder="you@company.com" autoFocus
              onKeyDown={e=>e.key==="Enter"&&handleForgotPw()}
              style={{width:"100%",boxSizing:"border-box",padding:"9px 12px",borderRadius:8,border:"1.5px solid var(--border)",background:"var(--panel-elev)",color:"var(--text)",fontSize:14,marginBottom:16}} />
            <div style={{display:"flex",gap:10}}>
              <button className="btn ghost" type="button" style={{flex:1}} onClick={()=>setForgotPwOpen(false)}>Cancel</button>
              <button className="btn primary" type="button" style={{flex:1}} disabled={forgotPwLoading} onClick={handleForgotPw}>{forgotPwLoading?"Sending…":"Send Reset Email"}</button>
            </div>
          </>}
        </div>
      </div>}
      {<div className="auth-hero"><div className="auth-hero-inner"><div className="auth-hero__logo"><div className="auth-hero__logo-mark"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></div><div className="auth-hero__logo-divider" /><div className="auth-hero__logo-sub">importmybooks.com</div></div><h1 className="auth-hero__headline">The most complete<br />Xero import platform.</h1><p className="auth-hero__tagline">Bulk import 15+ document types. Auto-allocate payments. Delete in bulk. One tool for your entire Xero workflow.</p><div className="auth-hero__chips">{["15+ Import Types","Auto Allocation","Delete Centre","Multi-org"].map(f => <span key={f} className="auth-hero__chip">✓ {f}</span>)}</div><div className="auth-hero__pricing">
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8,gap:8}}>
    <div className="auth-hero__pricing-label">Plans &amp; Pricing — from free to enterprise</div>
    <div style={{display:"flex",gap:3}}>
      {Object.values(HERO_PRICES).map(c=>(
        <button key={c.name} type="button" onClick={()=>setHeroCurrency(c.name)}
          style={{fontSize:9,fontWeight:700,padding:"2px 6px",borderRadius:10,border:`1px solid ${heroCurrency===c.name?"rgba(45,212,191,0.6)":"rgba(255,255,255,0.1)"}`,background:heroCurrency===c.name?"rgba(45,212,191,0.12)":"transparent",color:heroCurrency===c.name?"#2dd4bf":"rgba(255,255,255,0.3)",cursor:"pointer",letterSpacing:"0.03em"}}>
          {c.name}
        </button>
      ))}
    </div>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
    {(()=>{const hp=HERO_PRICES[heroCurrency];return[
      {label:"Testing",price:"Free",desc:"100 rows · Admin approved",color:"#34d399",bg:"rgba(52,211,153,0.05)",border:"rgba(52,211,153,0.35)",badge:"FREE",click:true},
      {label:"Starter",price:`${hp.sym}${hp.starter}`,period:"/mo",desc:"1 org · 500 records",color:"rgba(255,255,255,0.5)",bg:"rgba(255,255,255,0.03)",border:"rgba(255,255,255,0.1)",badge:null},
      {label:"Professional",price:`${hp.sym}${hp.pro}`,period:"/mo",desc:"5 orgs · Unlimited",color:"#818cf8",bg:"rgba(99,102,241,0.07)",border:"rgba(99,102,241,0.45)",badge:"POPULAR"},
      {label:"Growth",price:`${hp.sym}${hp.growth}`,period:"/mo",desc:"15 orgs · All features",color:"#2dd4bf",bg:"rgba(45,212,191,0.05)",border:"rgba(45,212,191,0.3)",badge:"NEW"},
      {label:"Enterprise",price:"Custom",desc:"Unlimited · RBAC",color:"#f59e0b",bg:"rgba(245,158,11,0.04)",border:"rgba(245,158,11,0.3)",badge:null,wide:true},
    ];})().map(p=>(
      <div key={p.label} onClick={p.click?()=>navigate("/signup"):undefined}
        style={{border:`1.5px solid ${p.border}`,borderRadius:9,padding:"8px 10px",background:p.bg,position:"relative",cursor:p.click?"pointer":"default",gridColumn:p.wide?"span 2":undefined}}>
        {p.badge&&<div style={{position:"absolute",top:6,right:8,fontSize:8.5,fontWeight:800,background:`${p.color}28`,color:p.color,padding:"1px 6px",borderRadius:20,letterSpacing:"0.06em"}}>{p.badge}</div>}
        <div style={{fontSize:9.5,fontWeight:700,color:p.color,marginBottom:1,textTransform:"uppercase",letterSpacing:"0.05em"}}>{p.label}</div>
        <div style={{fontSize:15,fontWeight:800,color:"#fff",lineHeight:1}}>{p.price}{p.period&&<span style={{fontSize:9.5,fontWeight:500,color:"rgba(255,255,255,0.4)"}}>{p.period}</span>}</div>
        <div style={{fontSize:9.5,color:"rgba(255,255,255,0.38)",marginTop:3,lineHeight:1.3}}>{p.desc}</div>
      </div>
    ))}
  </div>
  <button type="button" className="auth-hero__pricing-link" style={{marginTop:8}} onClick={() => navigate("/pricing")}>Compare all plans &amp; features →</button>
</div></div></div>}{<div className="auth-panel">{<div className="auth-card">{<div className="auth-header">{<h2>Welcome back</h2>}{<p>Select your workspace and sign in to continue.</p>}</div>}{<div className="auth-workspace-picker">{<div className="auth-workspace-picker__label">Choose workspace</div>}{<button className={`auth-workspace-option ${selectedWorkspace === "extraction" ? "auth-workspace-option--active" : ""}`} type="button" onClick={() => setSelectedWorkspace("extraction")}>{<strong>Extraction</strong>}{<span>Download Xero data</span>}</button>}{<button className={`auth-workspace-option ${selectedWorkspace === "importing" ? "auth-workspace-option--active" : ""}`} type="button" onClick={() => setSelectedWorkspace("importing")}>{<strong>Importing</strong>}{<span>Upload data to Xero</span>}</button>}{<button className={`auth-workspace-option ${selectedWorkspace === "deletecentre" ? "auth-workspace-option--active" : ""}`} type="button" onClick={() => setSelectedWorkspace("deletecentre")}>{<strong>Delete Centre</strong>}{<span>Void & delete in bulk</span>}</button>}</div>}{<div className="auth-tabs">{<button className="btn primary" onClick={() => setAuthMode("login")}>Login</button>}{<button className="btn ghost" type="button" onClick={() => navigate("/signup")}>Create Account →</button>}</div>}{<div className="auth-form">{<label className="field">{<span>Email</span>}{<input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="you@company.com" />}</label>}{<label className="field">{<span>Password</span>}{<input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="********" />}</label>}{<div style={{textAlign:"right",marginTop:-4,marginBottom:4}}><button type="button" onClick={()=>{setForgotPwOpen(true);setForgotPwEmail(authEmail);setForgotPwSent(false);}} style={{background:"none",border:"none",color:"var(--accent)",fontSize:12,cursor:"pointer",padding:0}}>Forgot password?</button></div>}{authError ? <p className="auth-error">{authError}</p> : null}{<button className="btn primary" onClick={handleAuthSubmit} disabled={authLoading}>{authLoading ? <Spinner size={14} color="#fff" /> : authMode === "signup" ? "Create Account" : "Login"}</button>}</div>}</div>}{<div className="auth-footer-links">{<button type="button" className="auth-footer-link" onClick={() => navigate("/terms")}>Terms of Service</button>}{<span className="auth-footer-sep">·</span>}{<button type="button" className="auth-footer-link" onClick={() => navigate("/privacy")}>Privacy Policy</button>}{<span className="auth-footer-sep">·</span>}{<button type="button" className="auth-footer-link" onClick={() => navigate("/pricing")}>Pricing</button>}</div>}</div>}</div>;
  }
  if (user && !user.isAdmin && user.planStatus === "pending") {
    const isPaidPlan = user.plan && user.plan !== "testing" && user.plan !== "none";
    const planName = user.plan==="pro"?"Professional":user.plan==="growth"?"Growth":user.plan==="starter"?"Starter":"Testing";
    const pendingIcon = isPaidPlan ? "💳" : "🧪";
    const pendingColor = isPaidPlan ? "rgba(99,102,241,0.4)" : "rgba(245,158,11,0.4)";
    const pendingBg = isPaidPlan ? "rgba(99,102,241,0.12)" : "rgba(245,158,11,0.12)";
    const pendingAccent = isPaidPlan ? "#818cf8" : "#fbbf24";
    const pendingTitle = isPaidPlan ? "Payment Received — Awaiting Activation" : "Waiting for Admin Approval";
    const pendingDesc = isPaidPlan
      ? `Your ${planName} plan payment was successful. The admin will verify and activate your account. You'll see a notification here once you have access.`
      : "Your testing plan request has been received. The admin will review and activate your account. You'll be notified here once approved.";
    const pendingDetail = isPaidPlan ? `${planName} Plan · Payment confirmed · Pending activation` : "Testing Plan · 100 rows total · Pending approval";
    return <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#030b18",color:"#fff",gap:24,padding:40,textAlign:"center"}}>
      <div style={{width:72,height:72,borderRadius:"50%",background:pendingBg,border:`2px solid ${pendingColor}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>{pendingIcon}</div>
      <div>
        <h1 style={{fontSize:24,fontWeight:800,margin:"0 0 8px",color:"#fff"}}>{pendingTitle}</h1>
        <p style={{color:"rgba(255,255,255,0.55)",fontSize:15,maxWidth:420,margin:"0 auto",lineHeight:1.6}}>{pendingDesc}</p>
      </div>
      <div style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:12,padding:"16px 24px",display:"flex",flexDirection:"column",gap:6,minWidth:260,textAlign:"left"}}>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:4}}>Account details</div>
        <div style={{fontSize:14,color:"rgba(255,255,255,0.85)",fontWeight:600}}>{user.email}</div>
        <div style={{fontSize:12,color:pendingAccent}}>{pendingDetail}</div>
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",justifyContent:"center"}}>
        <button type="button" style={{padding:"10px 28px",background:"rgba(52,211,153,0.1)",color:"#34d399",border:"1px solid rgba(52,211,153,0.3)",borderRadius:8,fontWeight:600,fontSize:14,cursor:"pointer"}} onClick={()=>window.location.reload()}>Check Status</button>
        {!isPaidPlan && user.plan !== "team" && <button type="button" style={{padding:"10px 28px",background:"rgba(99,102,241,0.14)",color:"#818cf8",border:"1px solid rgba(99,102,241,0.35)",borderRadius:8,fontWeight:600,fontSize:14,cursor:"pointer"}} onClick={()=>navigate("/pricing")}>Upgrade Plan →</button>}
        <button type="button" style={{padding:"10px 28px",background:"rgba(255,255,255,0.06)",color:"rgba(255,255,255,0.5)",border:"1px solid rgba(255,255,255,0.12)",borderRadius:8,fontWeight:600,fontSize:14,cursor:"pointer"}} onClick={handleLogout}>Logout</button>
      </div>
    </div>;
  }
  if (user && !user.isAdmin && (!user.plan || user.plan === "none")) {
    const handleRequestTesting = async () => {
      setRequestTestingLoading(true);
      try {
        const res = await fetch(`${API_BASE}/user/request-testing`, { method: "POST", headers: { "x-user-token": userToken } });
        const data = await res.json();
        if (!res.ok) { alert(data.error || "Failed to request testing plan"); setRequestTestingLoading(false); return; }
        setUser(u => ({ ...u, plan: "testing", planStatus: "pending" }));
      } catch { alert("Something went wrong"); }
      setRequestTestingLoading(false);
    };
    const handleRequestTeam = async () => {
      setRequestTeamLoading(true);
      try {
        const res = await fetch(`${API_BASE}/user/request-team`, { method: "POST", headers: { "x-user-token": userToken } });
        const data = await res.json();
        if (!res.ok) { alert(data.error || "Failed to request team access"); setRequestTeamLoading(false); return; }
        setUser(u => ({ ...u, plan: "team", role: "team", planStatus: "pending" }));
        setUserRole("team");
      } catch { alert("Something went wrong"); }
      setRequestTeamLoading(false);
    };
    return (
      <div style={{minHeight:"100vh",background:"#030b18",color:"#fff",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"40px 20px",gap:36}}>
        {/* Header */}
        <div style={{textAlign:"center",maxWidth:560}}>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,marginBottom:18,padding:"5px 14px",borderRadius:20,background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)"}}>
            <span style={{fontSize:11,fontWeight:700,letterSpacing:"0.08em",color:"rgba(255,255,255,0.45)",textTransform:"uppercase"}}>Choose your plan</span>
          </div>
          <h1 style={{fontSize:30,fontWeight:800,margin:"0 0 10px",letterSpacing:"-0.5px"}}>Welcome to <span style={{color:"#2dd4bf"}}>ImportMyBooks</span></h1>
          <p style={{color:"rgba(255,255,255,0.45)",fontSize:14,margin:0,lineHeight:1.6}}>Select how you'd like to access ImportMyBooks, <span style={{color:"rgba(255,255,255,0.65)"}}>{user.email}</span></p>
        </div>

        {/* 4 Cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,width:"100%",maxWidth:1100}}>

          {/* Card 1: Testing */}
          <div style={{background:"rgba(52,211,153,0.04)",border:"1.5px solid rgba(52,211,153,0.28)",borderRadius:16,padding:"26px 22px",display:"flex",flexDirection:"column",gap:0,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#34d399,#059669)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontSize:26}}>🧪</span>
              <span style={{padding:"3px 10px",borderRadius:20,background:"rgba(52,211,153,0.18)",color:"#34d399",fontSize:10,fontWeight:800,letterSpacing:"0.07em"}}>FREE</span>
            </div>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4,color:"#fff"}}>Testing</div>
            <div style={{fontSize:24,fontWeight:900,color:"#34d399",marginBottom:4,letterSpacing:"-0.5px"}}>₹0<span style={{fontSize:13,fontWeight:500,color:"rgba(255,255,255,0.4)"}}>/forever</span></div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:20,lineHeight:1.6}}>Try ImportMyBooks with a small dataset. Admin approves within a few hours.</div>
            <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:22,flex:1}}>
              {["100 rows total (all imports)","Bills, Invoices, Contacts","1 Xero organisation","Admin approval required"].map(f=>(
                <div key={f} style={{display:"flex",alignItems:"flex-start",gap:7,fontSize:12,color:"rgba(255,255,255,0.6)"}}><span style={{color:"#34d399",flexShrink:0,marginTop:1}}>✓</span>{f}</div>
              ))}
            </div>
            <button type="button" onClick={handleRequestTesting} disabled={requestTestingLoading}
              style={{padding:"11px 0",background:"rgba(52,211,153,0.14)",color:"#34d399",border:"1.5px solid rgba(52,211,153,0.4)",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>
              {requestTestingLoading ? "Requesting…" : "Request Testing Access"}
            </button>
          </div>

          {/* Card 2: Starter + Professional */}
          <div style={{background:"rgba(99,102,241,0.04)",border:"1.5px solid rgba(99,102,241,0.35)",borderRadius:16,padding:"26px 22px",display:"flex",flexDirection:"column",gap:0,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#6366f1,#8b5cf6)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontSize:26}}>🚀</span>
              <span style={{padding:"3px 10px",borderRadius:20,background:"rgba(99,102,241,0.2)",color:"#818cf8",fontSize:10,fontWeight:800,letterSpacing:"0.07em"}}>PAID</span>
            </div>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4,color:"#fff"}}>Starter & Professional</div>
            <div style={{fontSize:24,fontWeight:900,color:"#818cf8",marginBottom:4,letterSpacing:"-0.5px"}}>₹3,299<span style={{fontSize:13,fontWeight:500,color:"rgba(255,255,255,0.4)"}}>/mo+</span></div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:14,lineHeight:1.6}}>Instant activation. Pay via Razorpay, no approval needed.</div>
            <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:10}}>
              {[
                {name:"Starter",price:"₹3,299",desc:"1 org · 500 records",color:null,badge:null},
                {name:"Professional",price:"₹8,499",desc:"5 orgs · Unlimited records",color:"#818cf8",badge:"POPULAR"},
                {name:"Growth",price:"₹14,999",desc:"15 orgs · All features",color:"#2dd4bf",badge:"NEW"},
              ].map(p=>(
                <div key={p.name} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:9,background:p.color?"rgba(99,102,241,0.08)":"rgba(255,255,255,0.03)",border:`1px solid ${p.color?"rgba(99,102,241,0.3)":"rgba(255,255,255,0.08)"}`}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{fontSize:12,fontWeight:600,color:p.color||"rgba(255,255,255,0.7)"}}>{p.name}</span>
                    {p.badge&&<span style={{fontSize:9,fontWeight:800,padding:"1px 6px",borderRadius:10,background:p.badge==="NEW"?"rgba(45,212,191,0.2)":"rgba(99,102,241,0.25)",color:p.badge==="NEW"?"#2dd4bf":"#818cf8"}}>{p.badge}</span>}
                    <span style={{fontSize:10,color:"rgba(255,255,255,0.35)"}}>{p.desc}</span>
                  </div>
                  <span style={{fontSize:12,fontWeight:800,color:"#fff",whiteSpace:"nowrap"}}>{p.price}<span style={{fontSize:10,fontWeight:400,color:"rgba(255,255,255,0.35)"}}>/mo</span></span>
                </div>
              ))}
            </div>
            <div style={{flex:1}} />
            <button type="button" onClick={() => navigate("/pricing")}
              style={{padding:"11px 0",background:"rgba(99,102,241,0.14)",color:"#818cf8",border:"1.5px solid rgba(99,102,241,0.4)",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",width:"100%",marginTop:16}}>
              View Plans & Buy Now →
            </button>
          </div>

          {/* Card 3: Enterprise / Custom */}
          <div style={{background:"rgba(245,158,11,0.04)",border:"1.5px solid rgba(245,158,11,0.28)",borderRadius:16,padding:"26px 22px",display:"flex",flexDirection:"column",gap:0,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#f59e0b,#d97706)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontSize:26}}>🏢</span>
              <span style={{padding:"3px 10px",borderRadius:20,background:"rgba(245,158,11,0.18)",color:"#f59e0b",fontSize:10,fontWeight:800,letterSpacing:"0.07em"}}>CUSTOM</span>
            </div>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4,color:"#fff"}}>Enterprise</div>
            <div style={{fontSize:24,fontWeight:900,color:"#f59e0b",marginBottom:4,letterSpacing:"-0.5px"}}>Custom<span style={{fontSize:13,fontWeight:500,color:"rgba(255,255,255,0.4)"}}> pricing</span></div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:20,lineHeight:1.6}}>For large CA firms and enterprise teams. We'll build a custom plan for you.</div>
            <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:22,flex:1}}>
              {["Unlimited Xero organisations","Unlimited records per import","Multi-user access with RBAC","Admin dashboard & audit trail","Dedicated account manager","SLA-backed support (4h response)"].map(f=>(
                <div key={f} style={{display:"flex",alignItems:"flex-start",gap:7,fontSize:12,color:"rgba(255,255,255,0.6)"}}><span style={{color:"#f59e0b",flexShrink:0,marginTop:1}}>✓</span>{f}</div>
              ))}
            </div>
            <button type="button" onClick={() => window.location.href = "mailto:support@importmybooks.com?subject=ImportMyBooks Enterprise Enquiry"}
              style={{padding:"11px 0",background:"rgba(245,158,11,0.12)",color:"#f59e0b",border:"1.5px solid rgba(245,158,11,0.4)",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>
              Contact Sales →
            </button>
          </div>

          {/* Card 4: Team Member */}
          <div style={{background:"rgba(56,189,248,0.04)",border:"1.5px solid rgba(56,189,248,0.28)",borderRadius:16,padding:"26px 22px",display:"flex",flexDirection:"column",gap:0,position:"relative",overflow:"hidden"}}>
            <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:"linear-gradient(90deg,#38bdf8,#0284c7)"}} />
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
              <span style={{fontSize:26}}>👥</span>
              <span style={{padding:"3px 10px",borderRadius:20,background:"rgba(56,189,248,0.18)",color:"#38bdf8",fontSize:10,fontWeight:800,letterSpacing:"0.07em"}}>INTERNAL</span>
            </div>
            <div style={{fontWeight:800,fontSize:17,marginBottom:4,color:"#fff"}}>Team Member</div>
            <div style={{fontSize:24,fontWeight:900,color:"#38bdf8",marginBottom:4,letterSpacing:"-0.5px"}}>₹0<span style={{fontSize:13,fontWeight:500,color:"rgba(255,255,255,0.4)"}}>/forever</span></div>
            <div style={{fontSize:12,color:"rgba(255,255,255,0.45)",marginBottom:20,lineHeight:1.6}}>For internal team members. Admin controls your access. No billing required.</div>
            <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:22,flex:1}}>
              {["Access controlled by admin","No pricing or billing visible","Import & export tools","Admin approval required"].map(f=>(
                <div key={f} style={{display:"flex",alignItems:"flex-start",gap:7,fontSize:12,color:"rgba(255,255,255,0.6)"}}><span style={{color:"#38bdf8",flexShrink:0,marginTop:1}}>✓</span>{f}</div>
              ))}
            </div>
            <button type="button" onClick={handleRequestTeam} disabled={requestTeamLoading}
              style={{padding:"11px 0",background:"rgba(56,189,248,0.12)",color:"#38bdf8",border:"1.5px solid rgba(56,189,248,0.35)",borderRadius:10,fontWeight:700,fontSize:13,cursor:"pointer",width:"100%"}}>
              {requestTeamLoading ? "Requesting…" : "Request Team Access"}
            </button>
          </div>
        </div>

        <button type="button" onClick={handleLogout} style={{color:"rgba(255,255,255,0.3)",fontSize:12,background:"none",border:"none",cursor:"pointer",letterSpacing:"0.03em"}}>Sign out</button>
      </div>
    );
  }
  if (user && !user.isAdmin && (!userPermissions || userPermissions.length === 0)) {
    return <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"#030b18",color:"#fff",gap:24,padding:40,textAlign:"center"}}><div style={{width:72,height:72,borderRadius:"50%",background:"rgba(239,68,68,0.12)",border:"2px solid rgba(239,68,68,0.4)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>🔒</div><div><h1 style={{fontSize:24,fontWeight:800,margin:"0 0 8px",color:"#fff"}}>Access Restricted</h1><p style={{color:"rgba(255,255,255,0.55)",fontSize:15,maxWidth:380,margin:"0 auto",lineHeight:1.6}}>Your account does not have any permissions enabled. Please contact your administrator to get access.</p></div><div style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:12,padding:"16px 24px",display:"flex",flexDirection:"column",gap:6,minWidth:260,textAlign:"left"}}><div style={{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:4}}>Logged in as</div><div style={{fontSize:14,color:"rgba(255,255,255,0.85)",fontWeight:600}}>{user.email}</div><div style={{fontSize:12,color:"rgba(255,255,255,0.4)"}}>Plan: {user.plan || "—"} · No permissions assigned</div></div><button type="button" style={{padding:"10px 28px",background:"rgba(255,255,255,0.08)",color:"rgba(255,255,255,0.7)",border:"1px solid rgba(255,255,255,0.15)",borderRadius:8,fontWeight:600,fontSize:14,cursor:"pointer"}} onClick={handleLogout}>Logout</button></div>;
  }
  if (isDeleteCentrePage) {
    const deleteTypeOptions = [
      { value: "invoice", label: "Invoice & Credit Note Void", desc: "Void Xero Sales Invoices (ACCREC) and Sales Credit Notes (ACCRECCREDIT). Upload sheet with ID or Number column — both types are handled automatically." },
      { value: "bill", label: "Bill & Bill Credit Note Void", desc: "Void Xero Purchase Bills (ACCPAY) and Bill Credit Notes (ACCPAYCREDIT). Upload sheet with ID or Number column — both types are handled automatically." },
      { value: "invoice-payment", label: "Invoice Payment Delete", desc: "Delete Invoice Payments by Payment ID. Upload sheet with 'payment id' column." },
      { value: "bill-payment", label: "Bill Payment Delete", desc: "Delete Bill Payments by Payment ID. Upload sheet with 'payment id' column." },
      { value: "manual-journals", label: "Manual Journals Void (by Reference)", desc: "Void Manual Journals by Journal Reference / Narration. Upload sheet with a 'Journal Reference' or 'Narration' column. Works for both DRAFT and POSTED journals." },
      { value: "overpayment-duplicates", label: "Overpayment Duplicate Finder & Void", desc: "Scan Xero for duplicate Spend/Receive Overpayments (same reference more than once) and void the extras in bulk." },
      { value: "quotes", label: "Quote Delete", desc: "Delete Quotes by Quote Number. All statuses (DRAFT, SENT, ACCEPTED, DECLINED, INVOICED) can be deleted. Column: 'Quote Number'." },
      { value: "purchase-orders", label: "Purchase Order Delete", desc: "Delete Purchase Orders by PO Number. Only DRAFT and SUBMITTED POs can be deleted — AUTHORISED/BILLED require status change first. Column: 'Purchase Order Number'." },
      { value: "spend-receive", label: "Spend / Receive Money Delete", desc: "Delete Spend Money and Receive Money transactions by Reference. Overpayments and Prepayments are NOT supported. Column: 'Reference'." },
      { value: "bank-transfers", label: "Bank Transfer Delete", desc: "Delete Bank Transfers by Reference. Reconciled transfers must be unreconciled in Xero first. Column: 'Reference'." },
      { value: "contact-archive", label: "Contact Archive", desc: "Archive contacts in Xero by Contact Name. Note: Xero does not support full deletion of contacts — they become ARCHIVED (hidden from active lists). Column: 'Contact Name'." },
      { value: "filter-delete", label: "Batch Delete by Filter (No CSV)", desc: "Scan Xero for records matching a date range and status, preview the list, then void/delete them — no CSV upload needed." },
    ];
    const activeOpt = deleteTypeOptions.find(o => o.value === activeDeleteType) || deleteTypeOptions[0];
    const isVoidType = ["invoice", "bill"].includes(activeDeleteType);
    const isPaymentType = activeDeleteType === "invoice-payment" || activeDeleteType === "bill-payment";
    const isInvoiceSide = activeDeleteType === "invoice";
    const voidFile = isInvoiceSide ? invoiceDeleteFile : billDeleteFile;
    const setVoidFile = isInvoiceSide ? setInvoiceDeleteFile : setBillDeleteFile;
    const voidLoading = isInvoiceSide ? invoiceDeleteLoading : billDeleteLoading;
    const voidJobId = isInvoiceSide ? invoiceDeleteJobId : billDeleteJobId;
    const voidProgress = isInvoiceSide ? invoiceDeleteProgress : billDeleteProgress;
    const handleVoidStart = isInvoiceSide ? handleInvoiceBulkDelete : handleBillBulkDelete;
    const endpointBase = isInvoiceSide ? "invoice" : "bill";
    const setVoidJobId = isInvoiceSide ? setInvoiceDeleteJobId : setBillDeleteJobId;
    const setVoidProgress = isInvoiceSide ? setInvoiceDeleteProgress : setBillDeleteProgress;
    const downloadTpl = isInvoiceSide ? downloadVoidTemplate : downloadBillVoidTemplate;
    if (!hasPermission("delete")) return (
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"var(--bg)"}}>
        <div style={{textAlign:"center",padding:40,borderRadius:12,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.06)",maxWidth:380}}>
          <div style={{fontSize:32,marginBottom:12}}>🔒</div>
          <div style={{fontWeight:700,fontSize:16,marginBottom:8,color:"#ef4444"}}>Access Restricted</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:20}}>You don't have permission to use Delete Centre. Contact your admin.</div>
          <button className="btn ghost" onClick={() => navigate("/import")} style={{fontSize:13}}>← Back to Import</button>
        </div>
      </div>
    );
    return (
      <div className="delete-page">
        <div className="delete-shell">
          <div className="delete-header">
            <div>
              <div className="delete-brand-row"><PrismMark size={18} /><span className="delete-brand-name"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></span></div>
              <h1>Delete Centre</h1>
              <p>Void invoices, bills, credit notes and delete payments in bulk.</p>
            </div>
            <div className="delete-nav-actions">
              <button className="btn ghost btn-compact" type="button" onClick={() => navigate("/")}>↗ Extraction</button>
              <button className="btn ghost btn-compact" type="button" onClick={openImportPage}>↗ Importing</button>
              <button className="btn ghost btn-compact" type="button" onClick={handleLogout}>Logout</button>
            </div>
          </div>
          <div className="delete-card">
            <div className="panel-header">
              <div>
                <h2>Xero Connection</h2>
                <p>Connect to Xero and select a tenant before starting.</p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn ghost btn-compact" type="button" onClick={handleConnect}>{sessionId ? "Reconnect Xero" : "Connect to Xero"}</button>
                {sessionId && <button className="btn btn-compact" style={{ background: "#e53e3e", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", padding: "6px 12px" }} type="button" onClick={handleDisconnect}>Disconnect</button>}
              </div>
            </div>
            <div className="grid">
              <label className="field"><span>Tenant / Organisation</span>
                <select value={selectedTenant} onChange={e => { const tid = e.target.value; setSelectedTenant(tid); const found = tenants.find(t => t.tenantId === tid); if (found?.sessionId) setSessionId(found.sessionId); }}>
                  <option value="">Select tenant</option>
                  {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
                </select>
              </label>
            </div>
            <div className="delete-meta">
              <span>User: {user?.email || "-"}</span>
              <span>Session: {sessionId ? "Connected" : "Not connected"}</span>
              <span>Tenants: {tenants.length}</span>
            </div>
          </div>
          <div className="delete-card">
            <h2>Select Delete Type</h2>
            <div className="grid">
              <label className="field"><span>Delete Type</span>
                <select value={activeDeleteType} onChange={e => setActiveDeleteType(e.target.value)}>
                  {deleteTypeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </label>
            </div>
            <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>{activeOpt.desc}</p>
            {(() => {
              const tips = {
                invoice: ["DRAFT invoices → DELETED · AUTHORISED invoices → VOIDED (auto-chosen)", "Cannot void an invoice that has payments — delete the payment first", "Upload a CSV with 'Number' column (e.g. INV-001) or 'ID' column (Xero UUID)"],
                bill:    ["DRAFT bills → DELETED · AUTHORISED bills → VOIDED (auto-chosen)", "Cannot void a bill that has payments — delete the payment first", "Upload a CSV with 'Number' column (e.g. BILL-001) or 'ID' column (Xero UUID)"],
                "invoice-payment": ["Requires the Xero Payment ID (UUID), NOT the invoice number", "Find Payment IDs via Xero Export or your Export Centre", "Upload a CSV with 'payment id' column"],
                "bill-payment":    ["Requires the Xero Payment ID (UUID), NOT the bill number", "Deleting a payment restores the balance on the bill", "Upload a CSV with 'payment id' column"],
                "manual-journals": ["Works on both DRAFT and POSTED journals", "Upload a CSV with 'Journal Reference' or 'Narration' column", "Voided journals can be seen in Xero under Manual Journals → Voided"],
                "overpayment-duplicates": ["Scans for references that appear more than once as Spend/Receive Overpayments", "Keeps the oldest entry, voids the rest — safe to run multiple times", "Start with a scan first, review results, then void"],
                quotes:            ["All statuses can be deleted: DRAFT, SENT, ACCEPTED, DECLINED, INVOICED", "Deleting an INVOICED quote does NOT delete the invoice raised from it", "Upload a CSV with 'Quote Number' column (e.g. QU-001)"],
                "purchase-orders": ["Only DRAFT and SUBMITTED POs can be deleted", "AUTHORISED/BILLED POs → use Update Centre → Bulk Status Update → change to DRAFT first, then delete", "Upload a CSV with 'Purchase Order Number' column (e.g. PO-001)"],
                "spend-receive":   ["Only plain SPEND and RECEIVE types — Overpayments/Prepayments cannot be deleted via API", "If multiple transactions share the same Reference, ALL of them will be deleted", "Upload a CSV with 'Reference' column matching the Reference field in Xero"],
                "bank-transfers":  ["Reconciled Bank Transfers cannot be deleted — unreconcile in Xero first", "Upload a CSV with 'Reference' column matching the Bank Transfer Reference in Xero", "After deletion, check your bank reconciliation — the transfer will disappear from both sides"],
                "contact-archive": ["Contacts cannot be permanently deleted in Xero — they become ARCHIVED (hidden from active lists)", "Archived contacts can be restored any time: Contacts → All Contacts → filter Archived", "Upload a CSV with 'Contact Name' column (exact match, case-insensitive)"],
                "filter-delete": ["Scan first — see exactly how many records match before deleting anything", "DRAFT invoices/bills → DELETED, AUTHORISED → VOIDED (Xero's rules apply)", "Date range is based on the document date (Invoice Date / Bill Date)"],
              };
              const rows = tips[activeDeleteType];
              if (!rows) return null;
              return (
                <div style={{marginTop:14,padding:"10px 14px",borderRadius:8,background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.18)"}}>
                  <div style={{fontSize:11,fontWeight:700,letterSpacing:".07em",textTransform:"uppercase",color:"var(--muted)",marginBottom:6}}>Quick Rules</div>
                  <ul style={{listStyle:"none",padding:0,margin:0,display:"flex",flexDirection:"column",gap:5}}>
                    {rows.map((tip,i) => (
                      <li key={i} style={{fontSize:12,color:"var(--muted)",display:"flex",gap:8,alignItems:"flex-start"}}>
                        <span style={{color:"#818cf8",flexShrink:0,marginTop:1}}>→</span>{tip}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </div>
          {isPaymentType && (
            <div className="delete-card">
              <div className="panel-header">
                <div>
                  <h2>{activeOpt.label}</h2>
                  <p>Upload a CSV with <strong>payment id</strong> column. Each row = one payment to delete.</p>
                </div>
                <button className="btn ghost btn-compact" type="button" onClick={downloadPaymentDeleteTemplate}>Download Template</button>
              </div>
              <div style={{ marginTop: 8 }}>
                <FileDropZone
                  accept=".csv"
                  file={paymentDeleteFile}
                  onChange={f => { setPaymentDeleteFile(f); setPaymentDeleteProgress(null); }}
                  label="CSV File (.csv)"
                />
              </div>
              <div className="delete-actions" style={{ marginTop: 12 }}>
                <button className="btn primary btn--danger" type="button" onClick={() => askConfirm("Delete Payments", "This will permanently delete all payments in the uploaded sheet from Xero. This cannot be undone.", handlePaymentBulkDelete, "Yes, Delete")} disabled={paymentDeleteLoading || !!paymentDeleteJobId}>
                  {paymentDeleteLoading ? "Starting..." : paymentDeleteJobId ? "Running..." : "Start Delete"}
                </button>
              </div>
              {paymentDeleteProgress && (
                <div className="delete-card delete-card--info" style={{ marginTop: 12 }}>
                  <h2>Progress</h2>
                  <div className="bulk-summary-grid">
                    <div className="bulk-summary-card"><strong>{paymentDeleteProgress.deleted || 0}</strong><span>Deleted</span></div>
                    <div className="bulk-summary-card"><strong>{paymentDeleteProgress.skipped || 0}</strong><span>Skipped</span></div>
                    <div className="bulk-summary-card"><strong>{paymentDeleteProgress.errors || 0}</strong><span>Errors</span></div>
                  </div>
                  <div className="delete-steps" style={{ marginTop: 10 }}>
                    <div>Status: <strong>{formatBulkStatus(paymentDeleteProgress.status)}</strong></div>
                    <div>Progress: {paymentDeleteProgress.processed || 0} / {paymentDeleteProgress.total || 0}</div>
                    <div>ETA: {formatEta(paymentDeleteProgress.etaMs)}</div>
                  </div>
                  {Array.isArray(paymentDeleteProgress.results) && paymentDeleteProgress.results.length > 0 && (
                    <div className="bulk-results" style={{ marginTop: 10 }}>
                      <div className="bulk-results-note">Last {paymentDeleteProgress.results.length} rows (most recent first):</div>
                      {paymentDeleteProgress.results.slice(-30).reverse().map(r => (
                        <div key={r.rowNumber} className={`bulk-result-row bulk-result-row--${r.status}`}>
                          <span>Row {r.rowNumber}</span>
                          <span>{r.paymentId || "-"}</span>
                          <span>{formatBulkStatus(r.status)}</span>
                          <span style={{ fontSize: 12, color: "#64748b" }}>{r.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {isVoidType && (
            <div className="delete-card">
              <div className="panel-header">
                <div>
                  <h2>{activeOpt.label}</h2>
                  <p>Upload a CSV with <strong>ID</strong> or <strong>Number</strong> column. Each row = one document to void.</p>
                </div>
                <button className="btn ghost btn-compact" type="button" onClick={downloadTpl}>Download Template</button>
              </div>
              <div style={{ marginTop: 8 }}>
                <FileDropZone
                  accept=".csv"
                  file={voidFile}
                  onChange={f => { setVoidFile(f); setVoidProgress(null); }}
                  label="CSV File (.csv)"
                />
              </div>
              <div className="delete-actions" style={{ marginTop: 12 }}>
                <button className="btn primary btn--danger" type="button" onClick={() => askConfirm("Void Documents", `This will permanently void all ${isInvoiceSide ? "invoices" : "bills"} in the uploaded sheet. This cannot be undone.`, handleVoidStart, "Yes, Void")} disabled={voidLoading || !!voidJobId}>
                  {voidLoading ? "Starting..." : voidJobId ? "Running..." : "Start Void"}
                </button>
                {voidJobId && (
                  <button className="btn btn-compact" style={{ background: "#e53e3e", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", padding: "6px 14px" }} type="button"
                    onClick={() => cancelVoidJob(endpointBase, voidJobId, setVoidProgress).then(() => setVoidJobId(""))}>
                    Stop
                  </button>
                )}
              </div>
              {voidProgress && (
                <div className="delete-card delete-card--info" style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2>Progress</h2>
                    {!voidJobId && <button className="btn ghost btn-compact" type="button" onClick={() => setVoidProgress(null)} style={{ fontSize: 12 }}>Clear</button>}
                  </div>
                  {voidProgress.error && (
                    <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 6, padding: "10px 14px", marginBottom: 10, color: "#b91c1c", fontSize: 13 }}>
                      <strong>Error:</strong> {voidProgress.error}
                      {voidProgress.error.includes("session") || voidProgress.error.includes("Session") || voidProgress.error.includes("Connect") ? (
                        <div style={{ marginTop: 6 }}><button className="btn primary btn-compact" type="button" onClick={handleConnect}>Reconnect Xero</button></div>
                      ) : null}
                    </div>
                  )}
                  <div className="bulk-summary-grid">
                    <div className="bulk-summary-card"><strong>{voidProgress.voided || 0}</strong><span>Voided</span></div>
                    <div className="bulk-summary-card"><strong>{voidProgress.deleted || 0}</strong><span>Deleted</span></div>
                    <div className="bulk-summary-card"><strong>{voidProgress.skipped || 0}</strong><span>Skipped</span></div>
                    <div className="bulk-summary-card"><strong>{voidProgress.errors || 0}</strong><span>Errors</span></div>
                  </div>
                  <div className="delete-steps" style={{ marginTop: 10 }}>
                    <div>Status: <strong>{formatBulkStatus(voidProgress.status)}</strong></div>
                    <div>Progress: {voidProgress.processed || 0} / {voidProgress.total || 0}</div>
                    {voidProgress.status === "running" && <div>ETA: {formatEta(voidProgress.etaMs)}</div>}
                    {voidProgress.status === "running" && <div>Health: {Date.now() - (voidProgress.updatedAt || 0) > 60000 ? "⚠ Waiting / Xero slow — may need Reconnect" : "Active"}</div>}
                  </div>
                  {["completed", "completed_with_errors", "cancelled", "error"].includes(voidProgress.status) && voidProgress.jobId && (
                    <div className="delete-actions" style={{ marginTop: 10 }}>
                      <button className="btn ghost btn-compact" type="button" onClick={() => downloadVoidResults(endpointBase, voidProgress.jobId || "", "")}>Download All Results</button>
                      <button className="btn ghost btn-compact" type="button" onClick={() => downloadVoidResults(endpointBase, voidProgress.jobId || "", "error")}>Download Errors Only</button>
                    </div>
                  )}
                  {Array.isArray(voidProgress.results) && voidProgress.results.length > 0 && (
                    <div className="bulk-results" style={{ marginTop: 10 }}>
                      <div className="bulk-results-note">Last {voidProgress.results.length} rows (most recent first):</div>
                      {voidProgress.results.slice(-30).reverse().map(r => (
                        <div key={r.rowNumber} className={`bulk-result-row bulk-result-row--${r.status}`}>
                          <span>Row {r.rowNumber}</span>
                          <span>{r.idValue || r.numberValue || "-"}</span>
                          <span>{formatBulkStatus(r.status)}</span>
                          <span style={{ fontSize: 12, color: "#64748b" }}>{r.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {activeDeleteType === "manual-journals" && (
            <div className="delete-card">
              <div className="panel-header">
                <div>
                  <h2>Manual Journals Void (by Reference)</h2>
                  <p>Upload a CSV with a <strong>Journal Reference</strong> or <strong>Narration</strong> column. The tool will find each journal in Xero and void it — works for both DRAFT and POSTED journals.</p>
                </div>
              </div>
              <div style={{ marginTop: 10 }}>
                <FileDropZone
                  accept=".csv"
                  file={mjVoidFile}
                  onChange={f => { setMjVoidFile(f); setMjVoidProgress(null); }}
                  label="CSV file — must have 'Journal Reference' or 'Narration' column"
                />
              </div>
              <div className="delete-actions" style={{ marginTop: 12 }}>
                <button
                  className="btn primary btn--danger"
                  type="button"
                  onClick={() => askConfirm("Void Manual Journals", `This will void all manual journals matching the references in your sheet. This cannot be undone.`, handleMjVoidByRef, "Yes, Void")}
                  disabled={mjVoidLoading || !!mjVoidJobId || !mjVoidFile}
                >
                  {mjVoidLoading ? "Starting..." : mjVoidJobId ? "Running..." : "Start Void"}
                </button>
              </div>
              {mjVoidProgress && (
                <div className="delete-card delete-card--info" style={{ marginTop: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h2>Progress</h2>
                    {!mjVoidJobId && <button className="btn ghost btn-compact" type="button" onClick={() => setMjVoidProgress(null)} style={{ fontSize: 12 }}>Clear</button>}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>{mjVoidProgress.message || ""}</div>
                  {mjVoidProgress.originalTotal > mjVoidProgress.total && (
                    <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8, padding: "5px 10px", background: "rgba(245,158,11,0.08)", borderRadius: 6 }}>
                      {mjVoidProgress.originalTotal - mjVoidProgress.total} duplicate references removed — processing {mjVoidProgress.total} unique refs
                    </div>
                  )}
                  <div className="bulk-summary-grid">
                    <div className="bulk-summary-card"><strong>{mjVoidProgress.processed || 0} / {mjVoidProgress.total || 0}</strong><span>Processed</span></div>
                    <div className="bulk-summary-card"><strong style={{ color: "#22c55e" }}>{mjVoidProgress.voided || 0}</strong><span>Voided</span></div>
                    <div className="bulk-summary-card"><strong style={{ color: "#f59e0b" }}>{mjVoidProgress.notFound || 0}</strong><span>Not Found</span></div>
                    <div className="bulk-summary-card"><strong style={{ color: "#ef4444" }}>{mjVoidProgress.failed || 0}</strong><span>Failed</span></div>
                  </div>
                  {mjVoidProgress.status === "running" && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ height: 5, background: "var(--surface2)", borderRadius: 10, overflow: "hidden" }}>
                        <div style={{ height: "100%", background: "#6366f1", borderRadius: 10, width: `${mjVoidProgress.total > 0 ? Math.round((mjVoidProgress.processed || 0) / mjVoidProgress.total * 100) : 0}%`, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  )}
                  {mjVoidProgress.status === "done" && (
                    <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", borderRadius: 7, color: "#22c55e", fontSize: 13 }}>
                      Done! {mjVoidProgress.voided || 0} journals voided, {mjVoidProgress.notFound || 0} not found, {mjVoidProgress.failed || 0} failed.
                    </div>
                  )}
                  {mjVoidProgress.status === "error" && (
                    <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 7, color: "#ef4444", fontSize: 13 }}>
                      Error: {mjVoidProgress.message}
                    </div>
                  )}
                  {mjVoidProgress.lastErrors && mjVoidProgress.lastErrors.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", marginBottom: 4 }}>Recent errors:</div>
                      <div style={{ background: "rgba(239,68,68,0.07)", borderRadius: 6, padding: "6px 10px", maxHeight: 120, overflowY: "auto" }}>
                        {mjVoidProgress.lastErrors.map((e, i) => (
                          <div key={i} style={{ fontSize: 11, color: "#ef4444", fontFamily: "monospace", lineHeight: 1.6 }}>{e}</div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {activeDeleteType === "overpayment-duplicates" && (
            <div className="delete-card">
              <div className="panel-header">
                <div>
                  <h2>Overpayment Duplicate Finder & Void</h2>
                  <p>Scans Xero for duplicate overpayments (same reference more than once). Select the extras and void them.</p>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <select value={opDupScanType} onChange={e => { setOpDupScanType(e.target.value); setOpDupScanResults(null); setOpDupSelected({}); setOpDupVoidResults(null); }} style={{ fontSize: 13, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--fg)", cursor: "pointer" }}>
                    <option value="SPEND">Spend Overpayment</option>
                    <option value="RECEIVE">Receive Overpayment</option>
                  </select>
                  <button className="btn ghost btn-compact" type="button" disabled={!selectedTenant || opDupScanLoading} onClick={async () => {
                    setOpDupScanLoading(true); setOpDupScanResults(null); setOpDupSelected({}); setOpDupVoidResults(null);
                    try {
                      const params = new URLSearchParams({ tenantId: selectedTenant, type: opDupScanType });
                      const res = await fetch(`${API_BASE}/delete/overpayment-duplicates/scan?${params}`, { headers: { ...userHeader, "x-session-id": sessionId } });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || "Scan failed");
                      setOpDupScanResults(data);
                    } catch (err) { toast.error(err.message); }
                    setOpDupScanLoading(false);
                  }}>
                    {opDupScanLoading ? "Scanning…" : "Scan Xero"}
                  </button>
                </div>
              </div>
              {opDupScanResults && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
                    Scanned <strong>{opDupScanResults.totalScanned}</strong> overpayments — found <strong style={{ color: opDupScanResults.totalDuplicateGroups > 0 ? "#ef4444" : "#22c55e" }}>{opDupScanResults.totalDuplicateGroups}</strong> duplicate reference group(s).
                  </div>
                  {opDupScanResults.duplicates.length === 0 && (
                    <div style={{ padding: "12px 16px", background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.25)", borderRadius: 8, color: "#22c55e", fontSize: 13 }}>No duplicates found.</div>
                  )}
                  {opDupScanResults.duplicates.length > 0 && (
                    <>
                      <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>
                        For each group, the <strong>first entry (oldest)</strong> is the original — tick the extras you want to void.
                        <button onClick={() => {
                          const sel = {};
                          opDupScanResults.duplicates.forEach(g => { g.entries.slice(1).forEach(e => { sel[e.bankTransactionId] = true; }); });
                          setOpDupSelected(sel);
                        }} style={{ marginLeft: 10, fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--fg)", cursor: "pointer" }}>Select All Extras</button>
                        <button onClick={() => setOpDupSelected({})} style={{ marginLeft: 6, fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border)", background: "var(--surface2)", color: "var(--fg)", cursor: "pointer" }}>Clear</button>
                      </div>
                      <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
                        {opDupScanResults.duplicates.map((group, gi) => (
                          <div key={group.reference} style={{ borderBottom: gi < opDupScanResults.duplicates.length - 1 ? "1px solid var(--border)" : "none" }}>
                            <div style={{ padding: "8px 12px", background: "var(--surface2)", fontSize: 12, fontWeight: 700, color: "#ef4444" }}>Reference: {group.reference} — {group.count} entries</div>
                            {group.entries.map((entry, ei) => (
                              <div key={entry.bankTransactionId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: ei === 0 ? "rgba(34,197,94,0.04)" : opDupSelected[entry.bankTransactionId] ? "rgba(239,68,68,0.06)" : "transparent", fontSize: 12 }}>
                                <input type="checkbox" disabled={ei === 0} checked={ei === 0 ? false : !!opDupSelected[entry.bankTransactionId]} onChange={e => setOpDupSelected(prev => ({ ...prev, [entry.bankTransactionId]: e.target.checked }))} />
                                <span style={{ color: ei === 0 ? "#22c55e" : "#ef4444", fontWeight: 600, minWidth: 60 }}>{ei === 0 ? "ORIGINAL" : `EXTRA ${ei}`}</span>
                                <span style={{ flex: 1 }}>{entry.contact}</span>
                                <span style={{ color: "var(--muted)" }}>{entry.date}</span>
                                <span style={{ fontVariantNumeric: "tabular-nums" }}>{entry.total}</span>
                                <span style={{ color: "var(--muted)", fontSize: 11 }}>{entry.bankAccount}</span>
                                {opDupVoidResults && (() => { const r = opDupVoidResults.find(x => x.id === entry.bankTransactionId); return r ? <span style={{ color: r.status === "deleted" ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{r.status === "deleted" ? "✓ Voided" : "✗ Error"}</span> : null; })()}
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                      <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center" }}>
                        <button className="btn primary btn--danger" type="button" disabled={opDupVoidLoading || Object.values(opDupSelected).filter(Boolean).length === 0} onClick={() => askConfirm("Void Duplicate Overpayments", `This will permanently void ${Object.values(opDupSelected).filter(Boolean).length} overpayment(s). This cannot be undone.`, async () => {
                          const ids = Object.entries(opDupSelected).filter(([, v]) => v).map(([id]) => id);
                          setOpDupVoidLoading(true);
                          try {
                            const res = await fetch(`${API_BASE}/delete/overpayment-duplicates/void`, {
                              method: "POST",
                              headers: { ...userHeader, "x-session-id": sessionId, "Content-Type": "application/json" },
                              body: JSON.stringify({ tenantId: selectedTenant, groups: ids.map(id => ({ keep: null, extras: [id] })) }),
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.error || "Failed");
                            // poll until done
                            let attempts = 0;
                            while (attempts < 120) {
                              await new Promise(r => setTimeout(r, 1500));
                              const pr = await fetch(`${API_BASE}/delete/overpayment-duplicates/void/${data.jobId}`, { headers: { ...userHeader, "x-session-id": sessionId } });
                              const pd = await pr.json();
                              if (pd.status !== "running") {
                                setOpDupVoidResults(pd.results || []);
                                if (pd.errors === 0) { toast.success(`${pd.done} voided`); setOpDupSelected({}); }
                                else toast.error(`${pd.done} voided, ${pd.errors} errors`);
                                break;
                              }
                              attempts++;
                            }
                          } catch (err) { toast.error(err.message); }
                          setOpDupVoidLoading(false);
                        }, "Yes, Void")}>
                          {opDupVoidLoading ? "Voiding…" : `Void Selected (${Object.values(opDupSelected).filter(Boolean).length})`}
                        </button>
                        <span style={{ fontSize: 12, color: "var(--muted)" }}>{Object.values(opDupSelected).filter(Boolean).length} selected</span>
                      </div>
                    </>
                  )}
                </div>
              )}
              <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 4px" }}>Quick Delete from Reference Sheet</h3>
                <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 10px" }}>Upload a sheet with a <strong>Reference</strong> column (or references in the first column). The tool will scan Xero, find the extras for each reference, and void them automatically.</p>
                <FileDropZone accept=".csv" file={opDupRefSheet} onChange={f => { setOpDupRefSheet(f); setOpDupRefVoidResults(null); setOpDupVoidProgress(null); setOpDupVoidJobId(""); }} label="Reference Sheet (.csv)" />
                <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
                  <button className="btn primary btn--danger" type="button" disabled={!opDupRefSheet || opDupRefLoading || !selectedTenant} onClick={() => askConfirm("Void Duplicate Overpayments from Sheet", `This will scan Xero and permanently void all extra (duplicate) overpayments for each reference in your sheet. Originals (oldest entry) will be kept. This cannot be undone.`, handleOpDupFromSheet, "Yes, Void Duplicates")}>
                    {opDupRefLoading ? (opDupVoidProgress?.status === "scanning" ? "Scanning…" : "Voiding…") : "Find & Void Duplicates"}
                  </button>
                  {opDupRefSheet && !opDupRefLoading && <span style={{ fontSize: 12, color: "var(--muted)" }}>{opDupRefSheet.name}</span>}
                </div>
                {opDupVoidProgress && (
                  <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 8, border: "1px solid rgba(99,102,241,0.3)", background: "rgba(99,102,241,0.06)", fontSize: 13 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6 }}>{opDupVoidProgress.status === "scanning" ? "Scanning Xero…" : opDupVoidProgress.status === "voiding" || opDupVoidProgress.status === "running" ? "Voiding Duplicates…" : "Completed"}</div>
                    {opDupVoidProgress.refsInSheet && <div>References in sheet: <strong>{opDupVoidProgress.refsInSheet}</strong></div>}
                    {opDupVoidProgress.found != null && <div>Duplicate groups found: <strong>{opDupVoidProgress.found}</strong></div>}
                    {opDupVoidProgress.total > 0 && (
                      <>
                        <div style={{ margin: "8px 0 4px", fontSize: 12, color: "var(--muted)" }}>
                          {opDupVoidProgress.done} of {opDupVoidProgress.total} voided
                          {opDupVoidProgress.errors > 0 && <span style={{ color: "#ef4444", marginLeft: 8 }}>{opDupVoidProgress.errors} errors</span>}
                        </div>
                        <div style={{ height: 6, borderRadius: 3, background: "rgba(99,102,241,0.15)", overflow: "hidden" }}>
                          <div style={{ height: "100%", borderRadius: 3, background: opDupVoidProgress.errors > 0 ? "#ef4444" : "#6366f1", width: `${Math.round((opDupVoidProgress.done / opDupVoidProgress.total) * 100)}%`, transition: "width 0.4s ease" }} />
                        </div>
                      </>
                    )}
                  </div>
                )}
                {opDupRefVoidResults && !opDupVoidProgress?.status?.startsWith("running") && !opDupVoidProgress?.status?.startsWith("voiding") && !opDupVoidProgress?.status?.startsWith("scanning") && (
                  <div style={{ marginTop: 8, padding: "12px 14px", borderRadius: 8, border: `1px solid ${opDupRefVoidResults.errors > 0 ? "rgba(239,68,68,0.3)" : "rgba(34,197,94,0.3)"}`, background: opDupRefVoidResults.errors > 0 ? "rgba(239,68,68,0.06)" : "rgba(34,197,94,0.06)", fontSize: 13 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Final Results</div>
                    <div>References in sheet: <strong>{opDupVoidProgress?.refsInSheet ?? opDupRefVoidResults.refsInSheet}</strong></div>
                    <div>Duplicate groups found: <strong>{opDupVoidProgress?.found ?? opDupRefVoidResults.found}</strong></div>
                    <div style={{ color: "#22c55e" }}>Voided: <strong>{opDupRefVoidResults.voided}</strong></div>
                    {opDupRefVoidResults.errors > 0 && <div style={{ color: "#ef4444" }}>Errors: <strong>{opDupRefVoidResults.errors}</strong></div>}
                    {opDupRefVoidResults.errors > 0 && (opDupRefVoidResults.results || []).filter(r => r.status === "error").slice(0, 3).map((r, i) => (
                      <div key={i} style={{ fontSize: 11, color: "#ef4444", marginTop: 2 }}>{r.id?.slice(0, 8)}: {r.message}</div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          {activeDeleteType === "filter-delete" && (
            <div className="delete-card">
              <div className="panel-header">
                <div>
                  <h2>Batch Delete by Filter</h2>
                  <p>Scan Xero for matching records — no CSV needed. Review the list, then void/delete.</p>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12, marginBottom: 16 }}>
                <label className="field"><span>Record Type</span>
                  <select value={filterDeleteType} onChange={e => { setFilterDeleteType(e.target.value); setFilterDeleteScanResult(null); setFilterDeleteProgress(null); }}>
                    <option value="invoices">Sales Invoices</option>
                    <option value="bills">Purchase Bills</option>
                    <option value="credit-notes">Credit Notes</option>
                    <option value="purchase-orders">Purchase Orders</option>
                    <option value="quotes">Quotes</option>
                  </select>
                </label>
                <label className="field"><span>Status</span>
                  <select value={filterDeleteStatus} onChange={e => { setFilterDeleteStatus(e.target.value); setFilterDeleteScanResult(null); }}>
                    <option value="">Any Status</option>
                    <option value="DRAFT">DRAFT</option>
                    <option value="SUBMITTED">SUBMITTED</option>
                    <option value="AUTHORISED">AUTHORISED</option>
                    <option value="VOIDED">VOIDED</option>
                  </select>
                </label>
                <label className="field"><span>From Date</span>
                  <input type="date" value={filterDeleteFrom} onChange={e => { setFilterDeleteFrom(e.target.value); setFilterDeleteScanResult(null); }} />
                </label>
                <label className="field"><span>To Date</span>
                  <input type="date" value={filterDeleteTo} onChange={e => { setFilterDeleteTo(e.target.value); setFilterDeleteScanResult(null); }} />
                </label>
              </div>
              <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn ghost btn-compact" type="button" onClick={handleFilterDeleteScan} disabled={filterDeleteScanning || filterDeleteRunning || !selectedTenant}>
                  {filterDeleteScanning ? "Scanning…" : "🔍 Scan Records"}
                </button>
                {filterDeleteScanResult && (
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>Found <strong style={{ color: "var(--text)" }}>{filterDeleteScanResult.count.toLocaleString()}</strong> matching records</span>
                )}
              </div>
              {filterDeleteScanResult && filterDeleteScanResult.count === 0 && (
                <div style={{ padding: 16, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>No records match these filters.</div>
              )}
              {filterDeleteScanResult && filterDeleteScanResult.records.length > 0 && (
                <>
                  <div style={{ maxHeight: 280, overflowY: "auto", marginBottom: 14, border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ background: "var(--surface-alt,#f5f5f5)", position: "sticky", top: 0 }}>
                          {["#", "Number", "Status", "Date"].map(h => <th key={h} style={{ padding: "7px 12px", textAlign: "left", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {filterDeleteScanResult.records.slice(0, 300).map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--surface-alt,#fafafa)" }}>
                            <td style={{ padding: "4px 12px", color: "var(--muted)" }}>{i + 1}</td>
                            <td style={{ padding: "4px 12px", fontVariantNumeric: "tabular-nums" }}>{r.number || r.id?.slice(0, 8) || "—"}</td>
                            <td style={{ padding: "4px 12px", color: r.status === "DRAFT" ? "#f59e0b" : r.status === "AUTHORISED" ? "#22c55e" : "var(--muted)" }}>{r.status}</td>
                            <td style={{ padding: "4px 12px", color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{r.date ? String(r.date).slice(0, 10) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {filterDeleteScanResult.count > 300 && <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted)", textAlign: "center" }}>Showing first 300 of {filterDeleteScanResult.count.toLocaleString()} records</div>}
                  </div>
                  {!filterDeleteJobId && !filterDeleteProgress && (
                    <button className="btn btn--danger" type="button" style={{ background: "#e53e3e", color: "#fff", border: "none" }} onClick={() => askConfirm("Confirm Batch Delete", `This will void or delete all ${filterDeleteScanResult.count.toLocaleString()} matching ${filterDeleteType}. DRAFT records → DELETED, AUTHORISED records → VOIDED. This cannot be undone. Are you sure?`, handleFilterDeleteStart, "Yes, Void / Delete All")} disabled={filterDeleteRunning}>
                      {filterDeleteRunning ? "Starting…" : `⚠ Void / Delete ${filterDeleteScanResult.count.toLocaleString()} Records`}
                    </button>
                  )}
                </>
              )}
              {filterDeleteProgress && (
                <div style={{ marginTop: 16, background: "var(--surface2)", borderRadius: 8, padding: 14, fontSize: 13 }}>
                  <div style={{ display: "flex", gap: 16, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span><strong>Status:</strong> <span style={{ color: filterDeleteProgress.status === "completed" ? "#22c55e" : filterDeleteProgress.status === "error" ? "#ef4444" : "var(--text)" }}>{filterDeleteProgress.status}</span></span>
                    <span><strong>Total:</strong> {filterDeleteProgress.total || 0}</span>
                    <span style={{ color: "#22c55e" }}><strong>Voided/Deleted:</strong> {(filterDeleteProgress.voided || 0) + (filterDeleteProgress.deleted || 0)}</span>
                    <span style={{ color: "#f59e0b" }}><strong>Skipped:</strong> {filterDeleteProgress.skipped || 0}</span>
                    <span style={{ color: "#ef4444" }}><strong>Errors:</strong> {filterDeleteProgress.errors || 0}</span>
                    {filterDeleteJobId && <button className="btn ghost btn-compact" type="button" style={{ marginLeft: "auto", color: "#ef4444", borderColor: "#ef4444", fontSize: 11 }} onClick={cancelFilterDeleteJob}>Cancel</button>}
                    {!filterDeleteJobId && filterDeleteProgress.status === "completed" && <button className="btn ghost btn-compact" type="button" style={{ fontSize: 11 }} onClick={() => { setFilterDeleteProgress(null); setFilterDeleteScanResult(null); }}>Clear</button>}
                  </div>
                  {(filterDeleteProgress.total || 0) > 0 && (
                    <div style={{ height: 4, background: "var(--surface3,#ddd)", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
                      <div style={{ height: "100%", width: `${Math.round(((filterDeleteProgress.processed || 0) / filterDeleteProgress.total) * 100)}%`, background: (filterDeleteProgress.errors || 0) > 0 ? "#f59e0b" : "#22c55e", borderRadius: 4, transition: "width 0.5s ease" }} />
                    </div>
                  )}
                  {Array.isArray(filterDeleteProgress.results) && filterDeleteProgress.results.length > 0 && (
                    <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 12 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead><tr style={{ background: "var(--surface3)" }}>{["Row", "Number", "Status", "Message"].map(h => <th key={h} style={{ padding: "4px 8px", textAlign: "left", fontWeight: 600, borderBottom: "1px solid var(--border)" }}>{h}</th>)}</tr></thead>
                        <tbody>{filterDeleteProgress.results.slice(-80).map((r, i) => (
                          <tr key={i} style={{ borderBottom: "1px solid var(--border)", background: r.status === "voided" || r.status === "deleted" ? "rgba(34,197,94,0.05)" : r.status === "error" ? "rgba(239,68,68,0.05)" : "transparent" }}>
                            <td style={{ padding: "3px 8px" }}>{r.rowNumber}</td>
                            <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{r.numberValue || r.idValue?.slice(0, 8) || "—"}</td>
                            <td style={{ padding: "3px 8px", color: r.status === "voided" || r.status === "deleted" ? "#22c55e" : r.status === "error" ? "#ef4444" : "var(--muted)" }}>{r.status}</td>
                            <td style={{ padding: "3px 8px", color: "var(--muted)" }}>{r.message}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {["quotes","purchase-orders","spend-receive","bank-transfers","contact-archive"].includes(activeDeleteType) && (() => {
            const cfg = {
              quotes: { title: "Quote Delete", sub: "Deletes Quotes by Quote Number. All statuses (DRAFT, SENT, ACCEPTED, DECLINED, INVOICED) can be deleted.", col: "Quote Number", warn: null, template: "Quote Number\nQU-001\nQU-002" },
              "purchase-orders": { title: "Purchase Order Delete", sub: "Deletes POs by PO Number. Only DRAFT and SUBMITTED POs can be deleted — AUTHORISED/BILLED need a status change first via Bulk Status Update.", col: "Purchase Order Number", warn: "AUTHORISED/BILLED POs cannot be deleted. Use Update Centre → Bulk Status Update to change to DRAFT first.", template: "Purchase Order Number\nPO-001\nPO-002" },
              "spend-receive": { title: "Spend / Receive Money Delete", sub: "Deletes Spend Money and Receive Money transactions by Reference. Overpayments and Prepayments are NOT supported via API.", col: "Reference", warn: "Overpayments and Prepayments cannot be deleted via API — only plain Spend/Receive Money transactions.", template: "Reference\nRef-001\nRef-002" },
              "bank-transfers": { title: "Bank Transfer Delete", sub: "Deletes Bank Transfers by Reference. Reconciled transfers must be unreconciled in Xero first.", col: "Reference", warn: "Reconciled Bank Transfers will fail — unreconcile them in Xero first.", template: "Reference\nTransfer-001\nTransfer-002" },
              "contact-archive": { title: "Contact Archive", sub: "Archives contacts by Contact Name. Note: Xero does not support full deletion of contacts — archiving hides them from active lists but they remain in Xero.", col: "Contact Name", warn: "Contacts cannot be permanently deleted in Xero — they will be ARCHIVED (hidden from active lists, accessible via 'Show Archived').", template: "Contact Name\nABC Limited\nXYZ Pvt Ltd" },
            }[activeDeleteType];
            const prog = simpleDeleteProgress;
            const isRunning = simpleDeleteJobId && prog && !["completed","cancelled","failed"].includes(prog.status);
            return (
              <div className="delete-card">
                <div className="panel-header">
                  <div>
                    <h2>{cfg.title}</h2>
                    <p>{cfg.sub}</p>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <button className="btn ghost btn-compact" type="button" onClick={() => { const blob = new Blob([cfg.template], {type:"text/csv"}); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `${activeDeleteType}_delete_template.csv`; a.click(); URL.revokeObjectURL(u); }}>⬇ Template</button>
                    {prog && (prog.status === "completed" || prog.status === "failed") && (
                      <button className="btn ghost btn-compact" type="button" onClick={async () => {
                        const endpoint = simpleDeleteEndpoints[activeDeleteType];
                        const url = `${API_BASE}${endpoint}/results?jobId=${(simpleDeleteProgress?.jobId||"")}`;
                        const res = await fetch(url, {headers:{"x-user-token":userToken}});
                        const blob = await res.blob(); const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = `${activeDeleteType}_results.csv`; a.click(); URL.revokeObjectURL(u);
                      }}>⬇ Results CSV</button>
                    )}
                  </div>
                </div>
                {cfg.warn && <div style={{background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#b45309",marginBottom:16}}>⚠️ {cfg.warn}</div>}
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:12,color:"var(--muted)",marginBottom:6}}>Required column: <strong>{cfg.col}</strong></div>
                  <input type="file" accept=".csv" onChange={e => setSimpleDeleteFile(e.target.files[0] || null)} style={{fontSize:13}} />
                  {simpleDeleteFile && <span style={{fontSize:12,color:"var(--muted)",marginLeft:8}}>{simpleDeleteFile.name}</span>}
                </div>
                <button className="btn danger" type="button" disabled={!simpleDeleteFile || simpleDeleteLoading || isRunning} onClick={handleSimpleDelete} style={{marginBottom:16}}>
                  {simpleDeleteLoading ? "Starting…" : isRunning ? "Running…" : cfg.title.includes("Archive") ? "Archive Contacts" : "Delete"}
                </button>
                {isRunning && <button className="btn ghost btn-compact" type="button" style={{marginLeft:8,marginBottom:16}} onClick={async () => {
                  const endpoint = simpleDeleteEndpoints[activeDeleteType];
                  await fetch(`${API_BASE}${endpoint}/cancel`, {method:"POST",headers:{"Content-Type":"application/json","x-user-token":userToken},body:JSON.stringify({jobId:simpleDeleteJobId})});
                }}>Cancel</button>}
                {prog && (
                  <div style={{background:"var(--surface2)",borderRadius:8,padding:14,fontSize:13}}>
                    <div style={{display:"flex",gap:16,marginBottom:8,flexWrap:"wrap"}}>
                      <span><strong>Status:</strong> {prog.status}</span>
                      <span><strong>Total:</strong> {prog.total||0}</span>
                      <span style={{color:"#22c55e"}}><strong>{cfg.title.includes("Archive")?"Archived":"Deleted"}:</strong> {prog.deleted||0}</span>
                      <span style={{color:"#f59e0b"}}><strong>Skipped:</strong> {prog.skipped||0}</span>
                      <span style={{color:"#ef4444"}}><strong>Errors:</strong> {prog.errors||0}</span>
                    </div>
                    {prog.error && <div style={{color:"#ef4444",marginBottom:8}}>{prog.error}</div>}
                    {Array.isArray(prog.results) && prog.results.length > 0 && (
                      <div style={{maxHeight:260,overflowY:"auto",fontSize:12}}>
                        <table style={{width:"100%",borderCollapse:"collapse"}}>
                          <thead><tr style={{background:"var(--surface3)"}}>{["Row","Identifier","Status","Message"].map(h=><th key={h} style={{padding:"4px 8px",textAlign:"left",fontWeight:600,borderBottom:"1px solid var(--border)"}}>{h}</th>)}</tr></thead>
                          <tbody>{prog.results.slice(-100).map((r,i)=>(
                            <tr key={i} style={{borderBottom:"1px solid var(--border)",background:r.status==="deleted"||r.status==="archived"?"rgba(34,197,94,0.05)":r.status==="error"?"rgba(239,68,68,0.05)":"transparent"}}>
                              <td style={{padding:"3px 8px"}}>{r.rowNumber}</td>
                              <td style={{padding:"3px 8px"}}>{r.identifier}</td>
                              <td style={{padding:"3px 8px",color:r.status==="deleted"||r.status==="archived"?"#22c55e":r.status==="error"?"#ef4444":"var(--muted)"}}>{r.status}</td>
                              <td style={{padding:"3px 8px",color:"var(--muted)"}}>{r.message}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
        {confirmModal && <ConfirmModal title={confirmModal.title} message={confirmModal.message} confirmLabel={confirmModal.confirmLabel} onConfirm={() => { confirmModal.onConfirm(); setConfirmModal(null); }} onCancel={() => setConfirmModal(null)} />}
        <CookieConsent onNavigate={navigate} />
      </div>
    );
  }
  if (isUpdateCentrePage) {
    const updateTypeOptions = [
      { value: "update-status",        label: "Bulk Status Update",               group: "⚡ Quick Actions",  desc: "Change status in bulk — works on Invoices, Bills, Credit Notes, Quotes and Purchase Orders. Type column values: INVOICE, BILL, CREDITNOTE, QUOTE, PO. Statuses: DRAFT, AUTHORISED, VOIDED (invoices/bills/credit notes) · SENT, ACCEPTED, DECLINED (quotes) · SUBMITTED, BILLED (purchase orders)." },
      { value: "exchange-rate-update", label: "Exchange Rate Update",              group: "⚡ Quick Actions",  desc: "Update currency exchange rates on existing invoices, bills and credit notes. Template: Invoice Number (or Bill Number), Exchange Rate. Xero blocks rate changes on AUTHORISED docs that already have payments applied." },
      { value: "invoices",             label: "Update Sales Invoices",             group: "📄 Documents",      desc: "Update existing invoices matched by Invoice Number. DRAFT invoices: all fields update. AUTHORISED invoices: reference, URL, branding update — line items/amounts/contact cannot change if payments exist." },
      { value: "bills",                label: "Update Bills (Purchase)",           group: "📄 Documents",      desc: "Update existing bills matched by Bill Number. DRAFT bills: all fields update. AUTHORISED bills: reference, URL update — amounts/contact cannot change if payments exist." },
      { value: "credit-notes",         label: "Update Credit Notes",              group: "📄 Documents",      desc: "Update existing credit notes matched by Credit Note Number. DRAFT: all fields update. AUTHORISED: partial update only — allocations block line item changes." },
      { value: "quotes",               label: "Update Quotes",                     group: "📄 Documents",      desc: "Update existing quotes matched by Quote Number. All fields update on DRAFT/SENT quotes. ACCEPTED quotes: only reference and URL can change." },
      { value: "purchase-orders",      label: "Update Purchase Orders",            group: "📄 Documents",      desc: "Update existing purchase orders matched by PO Number. DRAFT/SUBMITTED: all fields update. AUTHORISED: limited updates only." },
      { value: "customers",            label: "Update Customer Contacts",          group: "📋 Master Data",    desc: "Always a full upsert — Xero matches by contact name and updates all fields (email, phone, address, tax settings). Safe to run anytime." },
      { value: "vendors",              label: "Update Vendor / Supplier Contacts", group: "📋 Master Data",    desc: "Always a full upsert — Xero matches by contact name and updates all fields. Safe to run anytime." },
      { value: "items",                label: "Update Items / Products",           group: "📋 Master Data",    desc: "Always a full upsert — Xero matches by item code and updates price, description, account codes. Safe to run anytime." },
    ];
    const activeUpdateOpt = updateTypeOptions.find(o => o.value === selectedUpdateType) || updateTypeOptions[0];
    const updateMap = {
      "update-status": {
        file: updateStatusFile, rows: updateStatusRows, errors: updateStatusErrors,
        status: updateStatusStatus, loading: updateStatusLoading, progress: updateStatusProgress,
        onFile: handleUpdateStatusFile,
        onDownload: () => downloadCsvFile("xero_bulk_update_status_template.csv", "Number,New Status,Type\nINV-001,AUTHORISED,INVOICE\nBILL-001,AUTHORISED,BILL\nCN-001,VOIDED,CREDITNOTE\nQUO-001,SENT,QUOTE\nPO-001,AUTHORISED,PO"),
        onImport: startUpdateStatus,
        template: "Number, New Status, Type  (INVOICE / BILL / CREDITNOTE / QUOTE / PO)",
        progressLabel: p => `Updated: ${p.created || 0} / ${p.total || 0}`,
        resultCols: ["rowNumber", "number", "docType"], resultLabels: ["Row", "Number", "Type"],
      },
      "exchange-rate-update": {
        file: exchangeRateUpdateFile, rows: exchangeRateUpdateRows, errors: exchangeRateUpdateErrors,
        status: exchangeRateUpdateStatus, loading: exchangeRateUpdateLoading, progress: exchangeRateUpdateProgress,
        onFile: handleExchangeRateUpdateFile,
        onDownload: downloadExchangeRateUpdateTemplate,
        onImport: startExchangeRateUpdateImport,
        template: "Invoice Number, Exchange Rate, Invoice Type",
        progressLabel: p => `Updated: ${p.created || 0} / ${p.total || 0}`,
        resultCols: ["rowNumber", "invoiceNumber", "newRate", "status", "message"], resultLabels: ["Row", "Invoice No.", "New Rate", "Status", "Message"],
      },
      invoices: {
        file: invoicesImportFile, rows: invoicesImportRows, errors: invoicesImportErrors,
        status: invoicesImportStatus, loading: invoicesImportLoading, progress: invoicesImportProgress,
        onFile: handleInvoicesImportFile,
        onDownload: downloadInvoicesCsvTemplate,
        onImport: startInvoicesImport,
        template: "Invoice Number, Contact Name, Invoice Date, Due Date, Reference, Currency Code, Line Description, Quantity, Unit Amount, Account Code, Tax Type, Status",
        progressLabel: p => `Current: ${p.currentInvoiceNumber || "-"}`,
        resultCols: ["rowNumber", "invoiceNumber", "contactName"], resultLabels: ["Row", "Invoice No.", "Contact"],
      },
      bills: {
        file: billsImportFile, rows: billsImportRows, errors: billsImportErrors,
        status: billsImportStatus, loading: billsImportLoading, progress: billsImportProgress,
        onFile: handleBillsImportFile,
        onDownload: downloadBillsCsvTemplate,
        onImport: startBillsImport,
        template: "Bill Number, Contact Name, Bill Date, Due Date, Reference, Currency Code, Line Description, Quantity, Unit Amount, Account Code, Tax Type, Status",
        progressLabel: p => `Current: ${p.currentBillNumber || p.currentInvoiceNumber || "-"}`,
        resultCols: ["rowNumber", "billNumber", "contactName"], resultLabels: ["Row", "Bill No.", "Contact"],
      },
      "credit-notes": {
        file: creditNotesImportFile, rows: creditNotesImportRows, errors: creditNotesImportErrors,
        status: creditNotesImportStatus, loading: creditNotesImportLoading, progress: creditNotesImportProgress,
        onFile: handleCreditNotesImportFile,
        onDownload: downloadCreditNotesCsvTemplate,
        onImport: startCreditNotesImport,
        template: "Credit Note Number, Contact Name, Credit Note Date, Reference, Currency Code, Line Description, Quantity, Unit Amount, Account Code, Tax Type, Status",
        progressLabel: p => `Current: ${p.currentCreditNoteNumber || "-"}`,
        resultCols: ["rowNumber", "creditNoteNumber", "contactName"], resultLabels: ["Row", "CN No.", "Contact"],
      },
      quotes: {
        file: quotesImportFile, rows: quotesImportRows, errors: quotesImportErrors,
        status: quotesImportStatus, loading: quotesImportLoading, progress: quotesImportProgress,
        onFile: e => handleQuotesImportFile(e),
        onDownload: () => downloadCsvFile("xero_quotes_import_template.csv", ["Quote Number","Contact Name","Date","Expiry Date","Title","Summary","Terms","Reference","Currency Code","Line Amount Types","Line Description","Quantity","Unit Amount","Account Code","Item Code","Discount Rate","Tax Type","Tax Amount","Tracking Name 1","Tracking Option 1","Tracking Name 2","Tracking Option 2","Status"], [["QU-001","Example Customer","2026-01-15","2026-02-15","Example Quote","","","REF-001","NZD","EXCLUSIVE","Example item","1","100.00","200","","","NONE","","","","","","DRAFT"]]),
        onImport: startQuotesImport,
        template: "Quote Number, Contact Name, Date, Expiry Date, Title, Reference, Currency Code, Line Description, Quantity, Unit Amount, Account Code, Tax Type, Status",
        progressLabel: p => `Current: ${p.currentQuoteNumber || "-"}`,
        resultCols: ["rowNumber", "quoteNumber", "contactName"], resultLabels: ["Row", "Quote No.", "Contact"],
      },
      "purchase-orders": {
        file: poImportFile, rows: poImportRows, errors: poImportErrors,
        status: poImportStatus, loading: poImportLoading, progress: poImportProgress,
        onFile: e => handlePoImportFile(e),
        onDownload: () => downloadCsvFile("xero_purchase_orders_import_template.csv", ["PO Number","Contact Name","Date","Delivery Date","Reference","Attention To","Telephone","Delivery Instructions","Currency Code","Exchange Rate","Line Description","Quantity","Unit Amount","Account Code","Item Code","Tax Type","Tax Amount","Tracking Name 1","Tracking Option 1","Tracking Name 2","Tracking Option 2","Status"], [["PO-001","Example Vendor","2026-01-15","2026-02-15","REF-001","","","","NZD","1","Example item","1","100.00","630","","NONE","","","","","","DRAFT"]]),
        onImport: startPoImport,
        template: "PO Number, Contact Name, Date, Delivery Date, Reference, Currency Code, Line Description, Quantity, Unit Amount, Account Code, Tax Type, Status",
        progressLabel: p => `Current: ${p.currentPoNumber || "-"}`,
        resultCols: ["rowNumber", "poNumber", "contactName"], resultLabels: ["Row", "PO No.", "Contact"],
      },
      customers: {
        file: customersImportFile, rows: customersImportRows, errors: customersImportErrors,
        status: customersImportStatus, loading: customersImportLoading, progress: customersImportProgress,
        onFile: handleCustomersImportFile,
        onDownload: downloadCustomersCsvTemplate,
        onImport: startCustomersImport,
        template: "Name, First Name, Last Name, Email Address, Phone, Website, Address Line 1, City, Country",
        progressLabel: p => `Current: ${p.currentContactName || "-"}`,
        resultCols: ["rowNumber", "name", "email"], resultLabels: ["Row", "Name", "Email"],
      },
      vendors: {
        file: vendorsImportFile, rows: vendorsImportRows, errors: vendorsImportErrors,
        status: vendorsImportStatus, loading: vendorsImportLoading, progress: vendorsImportProgress,
        onFile: handleVendorsImportFile,
        onDownload: downloadVendorsCsvTemplate,
        onImport: startVendorsImport,
        template: "Name, First Name, Last Name, Email Address, Phone, Website, Address Line 1, City, Country",
        progressLabel: p => `Current: ${p.currentContactName || "-"}`,
        resultCols: ["rowNumber", "name", "email"], resultLabels: ["Row", "Name", "Email"],
      },
      items: {
        file: itemsImportFile, rows: itemsImportRows, errors: itemsImportErrors,
        status: itemsImportStatus, loading: itemsImportLoading, progress: itemsImportProgress,
        onFile: handleItemsImportFile,
        onDownload: downloadItemsCsvTemplate,
        onImport: startItemsImport,
        template: "Code, Name, Description, Sales Unit Price, Sales Account Code, Purchase Unit Price, Purchase Account Code",
        progressLabel: p => `Current: ${p.currentItemCode || "-"}`,
        resultCols: ["rowNumber", "code", "name"], resultLabels: ["Row", "Code", "Name"],
      },
    };
    const activeUpdate = updateMap[selectedUpdateType] || updateMap["update-status"];
    const updProgress = activeUpdate.progress;
    return (
      <div className="delete-page">
        <div className="delete-shell">
          <div className="delete-header">
            <div>
              <div className="delete-brand-row"><PrismMark size={18} /><span className="delete-brand-name"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></span></div>
              <h1>Update Centre</h1>
              <p>Update existing Xero records in bulk — status, exchange rates, contacts, and items.</p>
            </div>
            <div className="delete-nav-actions">
              <button className="btn ghost btn-compact" type="button" onClick={() => navigate("/import")}>↗ Import</button>
              <button className="btn ghost btn-compact" type="button" onClick={() => navigate("/delete-centre")}>↗ Delete Centre</button>
              <button className="btn ghost btn-compact" type="button" onClick={handleLogout}>Logout</button>
            </div>
          </div>
          <div className="delete-card">
            <div className="panel-header">
              <div><h2>Xero Connection</h2><p>Connect to Xero and select a tenant before starting.</p></div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn ghost btn-compact" type="button" onClick={handleConnect}>{sessionId ? "Reconnect Xero" : "Connect to Xero"}</button>
                {sessionId && <button className="btn btn-compact" style={{background:"#e53e3e",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",padding:"6px 12px"}} type="button" onClick={handleDisconnect}>Disconnect</button>}
              </div>
            </div>
            <div className="grid">
              <label className="field"><span>Tenant / Organisation</span>
                <select value={selectedTenant} onChange={e => { const tid = e.target.value; setSelectedTenant(tid); const found = tenants.find(t => t.tenantId === tid); if (found?.sessionId) setSessionId(found.sessionId); }}>
                  <option value="">Select tenant</option>
                  {tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}
                </select>
              </label>
            </div>
            <div className="delete-meta">
              <span>User: {user?.email || "-"}</span>
              <span>Session: {sessionId ? "Connected" : "Not connected"}</span>
              <span>Tenants: {tenants.length}</span>
            </div>
          </div>
          <div className="delete-card">
            <h2>Select Update Type</h2>
            <div className="grid">
              <label className="field"><span>Update Type</span>
                <select value={selectedUpdateType} onChange={e => setSelectedUpdateType(e.target.value)}>
                  {[...new Set(updateTypeOptions.map(o => o.group))].map(grp => (
                    <optgroup key={grp} label={grp}>
                      {updateTypeOptions.filter(o => o.group === grp).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
            </div>
            <p style={{color:"#64748b",fontSize:13,marginTop:6}}>{activeUpdateOpt.desc}</p>

            {/* Smart guidance card — changes based on selected type */}
            {["invoices","bills","credit-notes","quotes","purchase-orders"].includes(selectedUpdateType) && (
              <div style={{marginTop:10,display:"grid",gap:6}}>
                <div style={{padding:"10px 14px",borderRadius:7,background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.18)",fontSize:12}}>
                  <strong style={{color:"#16a34a"}}>✅ DRAFT status</strong>
                  <span style={{color:"#64748b",marginLeft:6}}>— All fields update: contact, dates, line items, amounts, account codes.</span>
                </div>
                <div style={{padding:"10px 14px",borderRadius:7,background:"rgba(251,191,36,0.06)",border:"1px solid rgba(251,191,36,0.2)",fontSize:12}}>
                  <strong style={{color:"#b45309"}}>⚠️ AUTHORISED status</strong>
                  <span style={{color:"#64748b",marginLeft:6}}>— Partial update. Reference, URL, branding update. If payments/allocations exist: line items, amounts, contact and dates are locked by Xero.</span>
                </div>
                <div style={{padding:"10px 14px",borderRadius:7,background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.18)",fontSize:12,color:"#64748b"}}>
                  <strong style={{color:"#4f46e5"}}>🔄 To fully update an AUTHORISED document:</strong>
                  <ol style={{margin:"4px 0 0 16px",padding:0,lineHeight:1.8}}>
                    <li>Use <strong>Bulk Status Update</strong> here → change to <code style={{fontSize:11,background:"var(--surface2)",padding:"1px 4px",borderRadius:3}}>VOIDED</code></li>
                    <li>Go to <strong>Delete Centre</strong> → delete the voided record</li>
                    <li>Go to <strong>Import Centre</strong> → reimport with corrected data</li>
                  </ol>
                </div>
              </div>
            )}
            {["customers","vendors","items"].includes(selectedUpdateType) && (
              <div style={{marginTop:10,padding:"10px 14px",borderRadius:7,background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.18)",fontSize:12}}>
                <strong style={{color:"#16a34a"}}>✅ Always full update</strong>
                <span style={{color:"#64748b",marginLeft:6}}>— No status restrictions. Xero matches by name/code and updates all fields every time.</span>
              </div>
            )}
            {["update-status"].includes(selectedUpdateType) && (
              <div style={{marginTop:10,padding:"10px 14px",borderRadius:7,background:"rgba(99,102,241,0.06)",border:"1px solid rgba(99,102,241,0.18)",fontSize:12,color:"#64748b"}}>
                <strong style={{color:"#4f46e5"}}>ℹ️ Type column values:</strong>
                <div style={{marginTop:4,display:"flex",flexWrap:"wrap",gap:"6px 14px"}}>
                  {[["INVOICE","Invoices"],["BILL","Bills"],["CREDITNOTE","Credit Notes"],["QUOTE","Quotes"],["PO","Purchase Orders"]].map(([val,lbl]) => (
                    <span key={val}><code style={{fontSize:11,background:"var(--surface2)",padding:"1px 5px",borderRadius:3,border:"1px solid var(--border)"}}>{val}</code> <span style={{fontSize:11}}>{lbl}</span></span>
                  ))}
                </div>
              </div>
            )}
            {["exchange-rate-update"].includes(selectedUpdateType) && (
              <div style={{marginTop:10,padding:"10px 14px",borderRadius:7,background:"rgba(251,191,36,0.06)",border:"1px solid rgba(251,191,36,0.2)",fontSize:12,color:"#92400e"}}>
                <strong>⚠️ Note:</strong> Exchange rate cannot be changed on AUTHORISED invoices/bills that already have payments applied. Xero will return an error for those rows — others will update successfully.
              </div>
            )}
            <div style={{marginTop:8,padding:"8px 12px",borderRadius:6,background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.15)",fontSize:11.5,color:"#991b1b"}}>
              ❌ <strong>Cannot be updated:</strong> Payments, Spend Money, Receive Money, Manual Journals, Bank Transfers — these always create new records. Use Delete Centre first, then reimport.
            </div>
          </div>
          <div className="delete-card">
            <div className="panel-header">
              <div>
                <h2>Upload File</h2>
                <p style={{fontSize:12,color:"var(--muted)",marginTop:2}}>Columns: <strong style={{color:"var(--text)"}}>{activeUpdate.template}</strong></p>
              </div>
              <button className="btn ghost btn-compact" type="button" onClick={activeUpdate.onDownload}>Download Template</button>
            </div>
            <div style={{marginTop:10}}>
              <label className="btn ghost" style={{cursor:"pointer",display:"inline-flex",alignItems:"center",gap:6,padding:"8px 14px",fontSize:13}}>
                {activeUpdate.file ? `✓ ${activeUpdate.file.name}` : "Choose CSV file"}
                <input type="file" accept=".csv" style={{display:"none"}} onChange={activeUpdate.onFile} />
              </label>
              {activeUpdate.file && <button className="btn ghost btn-compact" style={{marginLeft:8,fontSize:11,color:"#ef4444",borderColor:"#ef4444"}} onClick={() => activeUpdate.onFile({ target: { files: [] } })}>✕ Clear</button>}
            </div>
            {activeUpdate.errors?.length > 0 && (
              <div className="import-validation import-validation--error" style={{marginTop:8}}>
                {activeUpdate.errors.map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
            {activeUpdate.rows?.length > 0 && (
              <div style={{marginTop:8,padding:"8px 12px",borderRadius:8,background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.2)",fontSize:13,color:"#16a34a",fontWeight:600}}>
                {activeUpdate.rows.length} rows ready to update
              </div>
            )}
            <div className="delete-actions" style={{marginTop:12}}>
              <button className="btn primary" type="button" disabled={activeUpdate.loading || !activeUpdate.rows?.length || !selectedTenant} onClick={activeUpdate.onImport} style={{background:"#f59e0b",borderColor:"#f59e0b"}}>
                {activeUpdate.loading ? "Running..." : "Start Update"}
              </button>
            </div>
            {activeUpdate.status && !updProgress && <div style={{marginTop:8,fontSize:13,color:"var(--muted)"}}>{activeUpdate.status}</div>}
          </div>
          {updProgress && (
            <div className="delete-card delete-card--info">
              <h2>Progress</h2>
              <div className="bulk-summary-grid">
                <div className="bulk-summary-card"><strong>{updProgress.processed || 0}</strong><span>Processed</span></div>
                <div className="bulk-summary-card"><strong style={{color:"#22c55e"}}>{updProgress.created || 0}</strong><span>Updated</span></div>
                <div className="bulk-summary-card"><strong style={{color:"#ef4444"}}>{updProgress.errors || 0}</strong><span>Errors</span></div>
                <div className="bulk-summary-card"><strong>{updProgress.total || 0}</strong><span>Total</span></div>
              </div>
              <div style={{marginTop:8,fontSize:13,color:"var(--muted)"}}>
                {activeUpdate.progressLabel?.(updProgress)} · Status: {
                  updProgress.status === "completed" ? "Finished" :
                  updProgress.status === "completed_with_errors" ? "Finished with errors" :
                  updProgress.status === "error" ? "Failed" :
                  updProgress.status === "queued" ? "Queued" :
                  "In progress"
                }
              </div>
              {Array.isArray(updProgress.results) && updProgress.results.length > 0 && (
                <div style={{marginTop:14}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <strong style={{fontSize:13}}>Results ({updProgress.results.length})</strong>
                    {updProgress.results.some(r => r.status === "error") && (
                      <button className="btn ghost btn-compact" style={{fontSize:11}} onClick={() => {
                        const errRows = updProgress.results.filter(r => r.status === "error");
                        const cols = activeUpdate.resultCols;
                        const labels = activeUpdate.resultLabels;
                        const csv = [labels.join(","), ...errRows.map(r => cols.map(c => JSON.stringify(String(r[c] ?? ""))).join(","))].join("\n");
                        const u = URL.createObjectURL(new Blob([csv],{type:"text/csv"})); const a = document.createElement("a"); a.href = u; a.download = `errors_update_${selectedUpdateType}_${Date.now()}.csv`; a.click(); URL.revokeObjectURL(u);
                      }}>⬇ Download Errors CSV</button>
                    )}
                  </div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr style={{borderBottom:"1px solid var(--border)",background:"var(--surface2)"}}>
                        {activeUpdate.resultLabels.map((l, i) => <th key={i} style={{padding:"6px 8px",textAlign:"left",color:"var(--muted)",fontWeight:600,whiteSpace:"nowrap"}}>{l}</th>)}
                        <th style={{padding:"6px 8px",textAlign:"left",color:"var(--muted)",fontWeight:600}}>Status</th>
                        <th style={{padding:"6px 8px",textAlign:"left",color:"var(--muted)",fontWeight:600}}>Message</th>
                      </tr></thead>
                      <tbody>
                        {updProgress.results.slice(0, 100).map((r, i) => (
                          <tr key={i} style={{borderBottom:"1px solid var(--border)",background:r.status==="error"?"rgba(239,68,68,0.04)":r.status==="updated"||r.status==="created"?"rgba(34,197,94,0.03)":""}}>
                            {activeUpdate.resultCols.map((c, j) => <td key={j} style={{padding:"5px 8px",whiteSpace:"nowrap"}}>{r[c] ?? "-"}</td>)}
                            <td style={{padding:"5px 8px",fontWeight:600,color:r.status==="error"?"#ef4444":r.status==="updated"||r.status==="created"?"#22c55e":"var(--muted)"}}>{r.status || "-"}</td>
                            <td style={{padding:"5px 8px",color:"var(--muted)",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.message || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {updProgress.results.length > 100 && <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>Showing 100 of {updProgress.results.length} results</div>}
                  </div>
                </div>
              )}
            </div>
          )}
          <CookieConsent onNavigate={navigate} />
        </div>
      </div>
    );
  }
  if (isImportPage) {
    const importTypes = [{
      value: "purchase-orders",
      label: "Purchase Orders",
      desc: "Import purchase orders into Xero. Rows with same PO Number are grouped as one purchase order. Status: DRAFT, SUBMITTED, AUTHORISED."
    }, {
      value: "bills",
      label: "Purchase Bills",
      desc: "Import supplier bills (ACCPAY) and bill credit notes (ACCPAYCREDIT) in one CSV. Rows with same Bill Number are grouped — negative total amount = auto-detected as a Bill Credit Note, same as Invoices import."
    }, {
      value: "bill-payments",
      label: "Bill Payments",
      desc: "Apply payments to existing supplier bills (ACCPAY). Each row = one payment. Requires Bill Number, Bank Account Code, Date, Amount."
    }, {
      value: "quotes",
      label: "Quotes / Estimates",
      desc: "Import quotes (estimates) into Xero. Rows with same Quote Number are grouped as one quote. Status: DRAFT, SENT, DECLINED, ACCEPTED."
    }, {
      value: "invoices",
      label: "Sales Invoices & Credit Notes",
      desc: "Import customer invoices (ACCREC) and credit notes (ACCRECCREDIT) in one CSV. Set 'Type' column to 'Invoice' or 'Credit Note' per row. Rows with same number are grouped as one document."
    }, {
      value: "invoice-payments",
      label: "Invoice Payments",
      desc: "Apply payments to existing customer invoices (ACCREC). Each row = one payment. Requires Invoice Number, Bank Account Code, Date, Amount."
    }, {
      value: "credit-note-refunds",
      label: "Credit Note Refunds",
      desc: "Refund a credit note back to the customer via a bank account. Each row = one refund. Requires Credit Note Number, Bank Account Code, Date, Amount."
    }, {
      value: "accounts",
      label: "Chart of Accounts",
      desc: "Import your chart of accounts. Each row is one account."
    }, {
      value: "spend-op",
      label: "Spend Overpayment",
      desc: "Import spend overpayments (supplier paid too much). Rows with same Reference are grouped."
    }, {
      value: "receive-op",
      label: "Receive Overpayment",
      desc: "Import receive overpayments (customer paid too much). Rows with same Reference are grouped."
    }, {
      value: "spend-allocation",
      label: "Spend Allocation",
      desc: "Allocate an existing Spend Overpayment against a supplier bill. Each row = one allocation."
    }, {
      value: "receive-allocation",
      label: "Receive Allocation",
      desc: "Allocate an existing Receive Overpayment against a customer invoice. Each row = one allocation."
    }, {
      value: "cn-allocation",
      label: "Credit Note Allocation",
      desc: "Allocate an existing Sales Credit Note against a customer invoice. Each row = one allocation."
    }, {
      value: "dn-allocation",
      label: "Debit Note Allocation",
      desc: "Allocate an existing Purchase Credit Note (Debit Note) against a supplier bill. Each row = one allocation."
    }, {
      value: "spend-money",
      label: "Spend Money",
      desc: "Import Spend Money bank transactions. Each row is one transaction."
    }, {
      value: "receive-money",
      label: "Receive Money",
      desc: "Import Receive Money bank transactions. Each row is one transaction."
    }, {
      value: "items",
      label: "Items / Products",
      desc: "Import items (products & services) into your Xero inventory. Each row is one item."
    }, {
      value: "customers",
      label: "Customers",
      desc: "Import customers (contacts marked as customer) into Xero. Each row is one customer."
    }, {
      value: "vendors",
      label: "Vendors / Suppliers",
      desc: "Import vendors (contacts marked as supplier) into Xero. Each row is one vendor."
    }, {
      value: "tracking-categories",
      label: "Tracking Categories",
      desc: "Import tracking categories and their options (classes). Each row is one option under a category."
    }, {
      value: "manual-journals",
      label: "Manual Journals",
      desc: "Import manual journals for double-entry bookkeeping. Group lines by Journal Reference — each reference = one journal. Debit must equal Credit per journal."
    }, {
      value: "conversion-balances",
      label: "Conversion Balances",
      desc: "Set opening balances when migrating to Xero. Loads your live Chart of Accounts, excludes AR/AP control accounts (import those via Bills/Invoices instead), and pushes one balanced Manual Journal dated the day before your Conversion Date."
    }, {
      value: "bank-transfers",
      label: "Bank Transfers",
      desc: "Import bank transfers between accounts. CSV columns: From Account Code, To Account Code, Amount, Date, Reference (optional), Exchange Rate (optional for multi-currency)."
    }, {
      value: "update-status",
      label: "Bulk Update Status",
      desc: "Approve, void, or change the status of existing invoices and bills in bulk. CSV columns: Number, New Status (DRAFT / AUTHORISED / VOIDED), Type (INVOICE or BILL)."
    }, {
      value: "exchange-rate-update",
      label: "Update Exchange Rate",
      desc: "Fix exchange rates on existing invoices or bills. Upload a CSV with Invoice Numbers — the tool fetches the current rate and automatically inverts it (1 ÷ current rate)."
    }];
    const importTypeGroups = [{
      label: "Payables",
      icon: "↓",
      types: ["purchase-orders", "bills", "bill-payments"]
    }, {
      label: "Receivables",
      icon: "↑",
      types: ["quotes", "invoices", "invoice-payments", "credit-note-refunds"]
    }, {
      label: "Journals",
      icon: "≡",
      types: ["manual-journals", "conversion-balances"]
    }, {
      label: "Accounts",
      icon: "◎",
      types: ["accounts"]
    }, {
      label: "Inventory",
      icon: "⊡",
      types: ["items"]
    }, {
      label: "Contacts",
      icon: "⊙",
      types: ["customers", "vendors"]
    }, {
      label: "Settings",
      icon: "⚙",
      types: ["tracking-categories"]
    }, {
      label: "Banking",
      icon: "⊞",
      types: ["spend-money", "receive-money", "spend-op", "receive-op", "bank-transfers"]
    }, {
      label: "Allocations",
      icon: "⇌",
      types: ["spend-allocation", "receive-allocation", "cn-allocation", "dn-allocation"]
    }, {
      label: "Update",
      icon: "✎",
      types: ["update-status", "exchange-rate-update"]
    }];
    const importMap = {
      "purchase-orders": {
        file: poImportFile,
        rows: poImportRows,
        errors: poImportErrors,
        status: poImportStatus,
        loading: poImportLoading,
        progress: poImportProgress,
        onFile: e => handlePoImportFile(e),
        onDownload: () => downloadCsvFile("xero_purchase_orders_import_template.csv", ["PO Number","Contact Name","Date","Delivery Date","Reference","Attention To","Telephone","Delivery Instructions","Currency Code","Exchange Rate","Line Description","Quantity","Unit Amount","Account Code","Item Code","Tax Type","Tax Amount","Tracking Name 1","Tracking Option 1","Tracking Name 2","Tracking Option 2","Status"], [
          ["PO-001","Example Vendor","2026-01-15","2026-02-15","REF-001","","","","NZD","1","Example item","1","100.00","630","","NONE","","","","","","DRAFT"],
        ]),
        onImport: startPoImport,
        progressLabel: p => `Current PO: ${p.currentPoNumber || "-"}`,
        resultCols: ["rowNumber", "poNumber", "contactName"],
        resultLabels: ["Row", "PO Number", "Contact"]
      },
      bills: {
        file: billsImportFile,
        rows: billsImportRows,
        errors: billsImportErrors,
        status: billsImportStatus,
        loading: billsImportLoading,
        progress: billsImportProgress,
        onFile: handleBillsImportFile,
        onDownload: downloadBillsCsvTemplate,
        onImport: startBillsImport,
        progressLabel: p => `Current bill: ${p.currentBillNumber || "-"}`,
        resultCols: ["rowNumber", "docType", "billNumber", "contactName"],
        resultLabels: ["Row", "Type", "Bill Number", "Contact"]
      },
      quotes: {
        file: quotesImportFile,
        rows: quotesImportRows,
        errors: quotesImportErrors,
        status: quotesImportStatus,
        loading: quotesImportLoading,
        progress: quotesImportProgress,
        onFile: e => handleQuotesImportFile(e),
        onDownload: () => downloadCsvFile("xero_quotes_import_template.csv", ["Quote Number","Contact Name","Date","Expiry Date","Title","Summary","Terms","Reference","Currency Code","Line Amount Types","Line Description","Quantity","Unit Amount","Account Code","Item Code","Discount Rate","Tax Type","Tax Amount","Tracking Name 1","Tracking Option 1","Tracking Name 2","Tracking Option 2","Status"], [
          ["QU-001","Example Customer","2026-01-15","2026-02-15","Example Quote","","","REF-001","NZD","EXCLUSIVE","Example item","1","100.00","200","","","NONE","","","","","","DRAFT"],
        ]),
        onImport: startQuotesImport,
        progressLabel: p => `Current Quote: ${p.currentQuoteNumber || "-"}`,
        resultCols: ["rowNumber", "quoteNumber", "contactName"],
        resultLabels: ["Row", "Quote Number", "Contact"]
      },
      invoices: {
        file: invoicesImportFile,
        rows: invoicesImportRows,
        errors: invoicesImportErrors,
        status: invoicesImportStatus,
        loading: invoicesImportLoading,
        progress: invoicesImportProgress,
        onFile: handleInvoicesImportFile,
        onDownload: downloadInvoicesCsvTemplate,
        onImport: startInvoicesImport,
        progressLabel: p => `Current: ${p.currentInvoiceNumber || "-"}`,
        resultCols: ["rowNumber", "docType", "invoiceNumber", "contactName"],
        resultLabels: ["Row", "Type", "Number", "Contact"]
      },
      "credit-notes": {
        file: creditNotesImportFile,
        rows: creditNotesImportRows,
        errors: creditNotesImportErrors,
        status: creditNotesImportStatus,
        loading: creditNotesImportLoading,
        progress: creditNotesImportProgress,
        onFile: handleCreditNotesImportFile,
        onDownload: downloadCreditNotesCsvTemplate,
        onImport: startCreditNotesImport,
        progressLabel: p => `Current credit note: ${p.currentCreditNoteNumber || "-"}`,
        resultCols: ["rowNumber", "creditNoteNumber", "contactName"],
        resultLabels: ["Row", "Credit Note No.", "Contact"]
      },
      "bill-payments": {
        file: billPaymentFile,
        rows: billPaymentRows,
        errors: billPaymentErrors,
        status: billPaymentStatus,
        loading: billPaymentLoading,
        progress: billPaymentProgress,
        onFile: handleBillPaymentFile,
        onDownload: downloadBillPaymentTemplate,
        onImport: startBillPaymentImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "invoiceNumber", "amount"],
        resultLabels: ["Row", "Invoice/Bill No.", "Amount"]
      },
      "invoice-payments": {
        file: invoicePaymentFile,
        rows: invoicePaymentRows,
        errors: invoicePaymentErrors,
        status: invoicePaymentStatus,
        loading: invoicePaymentLoading,
        progress: invoicePaymentProgress,
        onFile: handleInvoicePaymentFile,
        onDownload: downloadInvoicePaymentTemplate,
        onImport: startInvoicePaymentImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "invoiceNumber", "amount"],
        resultLabels: ["Row", "Invoice No.", "Amount"]
      },
      "credit-note-refunds": {
        file: creditNoteRefundFile,
        rows: creditNoteRefundRows,
        errors: creditNoteRefundErrors,
        status: creditNoteRefundStatus,
        loading: creditNoteRefundLoading,
        progress: creditNoteRefundProgress,
        onFile: handleCreditNoteRefundFile,
        onDownload: downloadCreditNoteRefundTemplate,
        onImport: startCreditNoteRefundImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "creditNoteNumber", "amount"],
        resultLabels: ["Row", "Credit Note No.", "Amount"]
      },
      accounts: {
        file: accountsImportFile,
        rows: accountsImportRows,
        errors: accountsImportErrors,
        status: accountsImportStatus,
        loading: accountsImportLoading,
        progress: accountsImportProgress,
        onFile: handleAccountsImportFile,
        onDownload: downloadAccountsCsvTemplate,
        onImport: startAccountsImport,
        progressLabel: p => `Current: ${p.currentAccountCode || "-"}`,
        resultCols: ["rowNumber", "code", "name"],
        resultLabels: ["Row", "Code", "Name"]
      },
      "spend-op": {
        file: spendOpFile,
        rows: spendOpRows,
        errors: spendOpErrors,
        status: spendOpStatus,
        loading: spendOpLoading,
        progress: spendOpProgress,
        onFile: handleSpendOpFile,
        onDownload: downloadSpendOpTemplate,
        onImport: () => startOverpaymentImport({
          rows: spendOpRows,
          file: spendOpFile,
          overpaymentType: "SPEND",
          setLoading: setSpendOpLoading,
          setStatus: setSpendOpStatus,
          setJobId: setSpendOpJobId,
          setProgress: setSpendOpProgress
        }),
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "reference", "contactName"],
        resultLabels: ["Row", "Reference", "Contact"]
      },
      "receive-op": {
        file: receiveOpFile,
        rows: receiveOpRows,
        errors: receiveOpErrors,
        status: receiveOpStatus,
        loading: receiveOpLoading,
        progress: receiveOpProgress,
        onFile: handleReceiveOpFile,
        onDownload: downloadReceiveOpTemplate,
        onImport: () => startOverpaymentImport({
          rows: receiveOpRows,
          file: receiveOpFile,
          overpaymentType: "RECEIVE",
          setLoading: setReceiveOpLoading,
          setStatus: setReceiveOpStatus,
          setJobId: setReceiveOpJobId,
          setProgress: setReceiveOpProgress
        }),
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "reference", "contactName"],
        resultLabels: ["Row", "Reference", "Contact"]
      },
      "spend-allocation": {
        file: spendAllocFile,
        rows: spendAllocRows,
        errors: spendAllocErrors,
        status: spendAllocStatus,
        loading: spendAllocLoading,
        progress: spendAllocProgress,
        onFile: handleSpendAllocFile,
        onDownload: downloadSpendAllocationTemplate,
        onImport: startSpendAllocImport,
        isAllocation: true,
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "overpaymentReference", "allocatedTo", "amount"],
        resultLabels: ["Row", "Overpayment Ref", "Allocated To (FIFO)", "Amount"]
      },
      "receive-allocation": {
        file: receiveAllocFile,
        rows: receiveAllocRows,
        errors: receiveAllocErrors,
        status: receiveAllocStatus,
        loading: receiveAllocLoading,
        progress: receiveAllocProgress,
        onFile: handleReceiveAllocFile,
        onDownload: downloadReceiveAllocationTemplate,
        onImport: startReceiveAllocImport,
        isAllocation: true,
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "overpaymentReference", "allocatedTo", "amount"],
        resultLabels: ["Row", "Overpayment Ref", "Allocated To (FIFO)", "Amount"]
      },
      "cn-allocation": {
        file: cnAllocFile,
        rows: cnAllocRows,
        errors: cnAllocErrors,
        status: cnAllocStatus,
        loading: cnAllocLoading,
        progress: cnAllocProgress,
        onFile: handleCnAllocFile,
        onDownload: downloadCnAllocationTemplate,
        onImport: startCnAllocImport,
        isAllocation: true,
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "creditNoteReference", "allocatedTo", "amount"],
        resultLabels: ["Row", "Credit Note No.", "Allocated To", "Amount"]
      },
      "dn-allocation": {
        file: dnAllocFile,
        rows: dnAllocRows,
        errors: dnAllocErrors,
        status: dnAllocStatus,
        loading: dnAllocLoading,
        progress: dnAllocProgress,
        onFile: handleDnAllocFile,
        onDownload: downloadDnAllocationTemplate,
        onImport: startDnAllocImport,
        isAllocation: true,
        progressLabel: p => `Current: ${p.currentReference || "-"}`,
        resultCols: ["rowNumber", "creditNoteReference", "allocatedTo", "amount"],
        resultLabels: ["Row", "Credit Note No.", "Allocated To", "Amount"]
      },
      "update-status": {
        file: updateStatusFile,
        rows: updateStatusRows,
        errors: updateStatusErrors,
        status: updateStatusStatus,
        loading: updateStatusLoading,
        progress: updateStatusProgress,
        onFile: e => handleUpdateStatusFile(e),
        onDownload: () => downloadCsvFile("xero_bulk_update_status_template.csv", "Number,New Status,Type"),
        onImport: startUpdateStatus,
        progressLabel: p => `Updated: ${p.created || 0} / ${p.total || 0}`,
        resultCols: ["rowNumber", "number", "docType"],
        resultLabels: ["Row", "Number", "Type"]
      },
      "bank-transfers": {
        file: bankTransferFile,
        rows: bankTransferRows,
        errors: bankTransferErrors,
        status: bankTransferStatus,
        loading: bankTransferLoading,
        progress: bankTransferProgress,
        onFile: handleBankTransferFile,
        onDownload: downloadBankTransferTemplate,
        onImport: startBankTransferImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "fromAccountCode", "toAccountCode", "amount"],
        resultLabels: ["Row", "From Account", "To Account", "Amount"]
      },
      "exchange-rate-update": {
        file: exchangeRateUpdateFile,
        rows: exchangeRateUpdateRows,
        errors: exchangeRateUpdateErrors,
        status: exchangeRateUpdateStatus,
        loading: exchangeRateUpdateLoading,
        progress: exchangeRateUpdateProgress,
        onFile: handleExchangeRateUpdateFile,
        onDownload: downloadExchangeRateUpdateTemplate,
        onImport: startExchangeRateUpdateImport,
        progressLabel: p => `Updated: ${p.created || 0} / ${p.total || 0}`,
        resultCols: ["rowNumber", "invoiceNumber", "newRate", "status", "message"],
        resultLabels: ["Row", "Invoice No.", "New Rate", "Status", "Message"]
      },
      items: {
        file: itemsImportFile,
        rows: itemsImportRows,
        errors: itemsImportErrors,
        status: itemsImportStatus,
        loading: itemsImportLoading,
        progress: itemsImportProgress,
        onFile: handleItemsImportFile,
        onDownload: downloadItemsCsvTemplate,
        onImport: startItemsImport,
        progressLabel: p => `Current: ${p.currentItemCode || "-"}`,
        resultCols: ["rowNumber", "code", "name"],
        resultLabels: ["Row", "Code", "Name"]
      },
      customers: {
        file: customersImportFile,
        rows: customersImportRows,
        errors: customersImportErrors,
        status: customersImportStatus,
        loading: customersImportLoading,
        progress: customersImportProgress,
        onFile: handleCustomersImportFile,
        onDownload: downloadCustomersCsvTemplate,
        onImport: startCustomersImport,
        progressLabel: p => `Current: ${p.currentContactName || "-"}`,
        resultCols: ["rowNumber", "name", "email"],
        resultLabels: ["Row", "Name", "Email"]
      },
      vendors: {
        file: vendorsImportFile,
        rows: vendorsImportRows,
        errors: vendorsImportErrors,
        status: vendorsImportStatus,
        loading: vendorsImportLoading,
        progress: vendorsImportProgress,
        onFile: handleVendorsImportFile,
        onDownload: downloadVendorsCsvTemplate,
        onImport: startVendorsImport,
        progressLabel: p => `Current: ${p.currentContactName || "-"}`,
        resultCols: ["rowNumber", "name", "email"],
        resultLabels: ["Row", "Name", "Email"]
      },
      "tracking-categories": {
        file: trackingCatImportFile,
        rows: trackingCatImportRows,
        errors: trackingCatImportErrors,
        status: trackingCatImportStatus,
        loading: trackingCatImportLoading,
        progress: trackingCatImportProgress,
        onFile: handleTrackingCatImportFile,
        onDownload: downloadTrackingCatTemplate,
        onImport: startTrackingCatImport,
        progressLabel: p => `Category: ${p.currentCategoryName || "-"} | Option: ${p.currentOptionName || "-"}`,
        resultCols: ["rowNumber", "categoryName", "optionName"],
        resultLabels: ["Row", "Category", "Option"]
      },
      "spend-money": {
        file: spendMoneyFile,
        rows: spendMoneyRows,
        errors: spendMoneyErrors,
        status: spendMoneyStatus,
        loading: spendMoneyLoading,
        progress: spendMoneyProgress,
        onFile: e => handleSpendMoneyFile(e.target.files?.[0] || null),
        onDownload: downloadSpendMoneyTemplate,
        onImport: startSpendMoneyImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "reference", "contactName"],
        resultLabels: ["Row", "Reference", "Contact"]
      },
      "receive-money": {
        file: receiveMoneyFile,
        rows: receiveMoneyRows,
        errors: receiveMoneyErrors,
        status: receiveMoneyStatus,
        loading: receiveMoneyLoading,
        progress: receiveMoneyProgress,
        onFile: e => handleReceiveMoneyFile(e.target.files?.[0] || null),
        onDownload: downloadReceiveMoneyTemplate,
        onImport: startReceiveMoneyImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "reference", "contactName"],
        resultLabels: ["Row", "Reference", "Contact"]
      },
      "manual-journals": {
        file: manualJournalFile,
        rows: manualJournalRows,
        errors: manualJournalErrors,
        status: manualJournalStatus,
        loading: manualJournalLoading,
        progress: manualJournalProgress,
        onFile: handleManualJournalFile,
        onDownload: () => downloadCsvFile("xero_manual_journal_import_template.csv", manualJournalImportHeaders, [
        ["JNL-001", "2026-01-15", "200", "Debit example line", "NONE"],
        ["JNL-001", "2026-01-15", "210", "Credit example line", "NONE"],
      ]),
        onImport: startManualJournalImport,
        progressLabel: p => `Current: ${p.currentRef || "-"}`,
        resultCols: ["rowNumber", "reference", "narration"],
        resultLabels: ["#", "Reference", "Narration"]
      }
    };
    const activeType = importTypes.find(t => t.value === selectedImportType);
    const active = importMap[selectedImportType];
    return <><div className="import-page">{<div className="import-shell">{<aside className="import-sidebar">{<div className="import-sidebar__brand">{<ImportPrismMark size={36} />}{<div className="import-sidebar__brand-text">{<div className="import-sidebar__title"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></div>}{<div className="import-sidebar__sub">importmybooks.com</div>}</div>}</div>}{<div className="import-sidebar__spectrum-strip" />}{<div className="import-sidebar__footer">{<div className="import-sidebar__nav-links">
              <button className="import-sidebar__nav-link" type="button" onClick={() => navigate("/dashboard")} style={{ color: "#2dd4bf" }}>
                <LayoutDashboard size={13} />Dashboard
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => { if (!hasPermission("export")) { setAccessDeniedModal({ feature: "Extraction (Export)" }); return; } navigate("/"); }}>
                <Database size={13} />Extraction
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => { if (!hasPermission("delete")) { setAccessDeniedModal({ feature: "Delete Centre" }); return; } openDeleteCentrePage(); }}>
                <Trash2 size={13} />Delete Centre
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => navigate("/update-centre")} style={{ color: "#f59e0b" }}>
                <SlidersHorizontal size={13} />Update Centre
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => { navigate("/import-history"); loadImportHistory(); }} style={{ color: "#38bdf8" }}>
                <Clock size={13} />Import History
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => { if (!hasPermission("allocation")) { setAccessDeniedModal({ feature: "Auto Allocation" }); return; } navigate("/auto-allocation"); }} style={{ color: "#22c55e" }}>
                <span style={{ fontSize: 13 }}>⇌</span>Auto Allocation
              </button>
              <button className="import-sidebar__nav-link" type="button" onClick={() => navigate("/guide")} style={{ color: "#a78bfa" }}>
                <BookOpen size={13} />Template Guide
              </button>
              {user?.plan === "testing" && <div style={{margin:"8px 0",padding:"8px 12px",borderRadius:8,background:"rgba(52,211,153,0.08)",border:"1px solid rgba(52,211,153,0.2)",fontSize:11,color:"#34d399"}}>
                🧪 Testing · {Math.max(0, 100 - (user.testingRowsUsed || 0))} rows left
              </div>}
              {user?.plan && user.plan !== "testing" && (() => {
                const planMeta = {
                  starter:      { label: "Starter",      color: "#fbbf24", bg: "rgba(251,191,36,0.1)",  border: "rgba(251,191,36,0.25)" },
                  pro:          { label: "Professional",  color: "#818cf8", bg: "rgba(129,140,248,0.1)", border: "rgba(129,140,248,0.28)" },
                  professional: { label: "Professional",  color: "#818cf8", bg: "rgba(129,140,248,0.1)", border: "rgba(129,140,248,0.28)" },
                  growth:       { label: "Growth",        color: "#2dd4bf", bg: "rgba(45,212,191,0.1)",  border: "rgba(45,212,191,0.25)" },
                  enterprise:   { label: "Enterprise",    color: "#a78bfa", bg: "rgba(167,139,250,0.1)", border: "rgba(167,139,250,0.25)" },
                  team:         { label: "Team",          color: "#38bdf8", bg: "rgba(56,189,248,0.1)",  border: "rgba(56,189,248,0.25)" },
                };
                const m = planMeta[user.plan] || planMeta.starter;
                return (
                  <div style={{margin:"6px 0",padding:"7px 12px",borderRadius:8,background:m.bg,border:`1px solid ${m.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:6}}>
                    <span style={{fontSize:11,fontWeight:700,color:m.color}}>★ {m.label}</span>
                    {["starter","pro"].includes(user.plan) && <button type="button" onClick={()=>navigate("/pricing")} style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:6,background:m.bg,color:m.color,border:`1px solid ${m.border}`,cursor:"pointer"}}>Upgrade</button>}
                  </div>
                );
              })()}
              {/* ── Xero API Quota ── */}
              {xeroQuota !== null && (
                <div style={{margin:"4px 0",padding:"7px 12px",borderRadius:8,background:"rgba(56,189,248,0.06)",border:"1px solid rgba(56,189,248,0.18)",fontSize:11}}>
                  <div style={{color:"rgba(255,255,255,0.38)",fontWeight:600,letterSpacing:"0.04em",marginBottom:5}}>XERO API TODAY</div>
                  <div style={{display:"flex",alignItems:"center",gap:7}}>
                    <div style={{flex:1,height:3,background:"rgba(255,255,255,0.08)",borderRadius:4,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${Math.max(0,Math.min(100,Math.round((xeroQuota/1000)*100)))}%`,background:xeroQuota>200?"#38bdf8":"#ef4444",borderRadius:4,transition:"width 1s ease"}} />
                    </div>
                    <span style={{color:xeroQuota>200?"#38bdf8":"#ef4444",fontWeight:700,fontVariantNumeric:"tabular-nums",fontSize:11}}>{xeroQuota.toLocaleString()}/1000</span>
                  </div>
                </div>
              )}
              {userRole !== "team" && !user?.plan && <button className="import-sidebar__nav-link" type="button" onClick={() => navigate("/pricing")} style={{ color: "#fbbf24" }}>
                <span style={{ fontSize: 13 }}>★</span>Pricing
              </button>}
              <button className="import-sidebar__nav-link" type="button" onClick={() => navigate("/account")} style={{ color: "rgba(255,255,255,0.45)" }}>
                <User size={13} />Account
              </button>
              <button className="import-sidebar__nav-link import-sidebar__nav-link--logout" type="button" onClick={handleLogout}>
                <LogOut size={13} />Logout
              </button>
            </div>}{<button type="button" className="user-pill" onClick={()=>navigate("/account")} title="Account & Billing" style={{cursor:"pointer",background:"none",border:"none",fontFamily:"inherit",textAlign:"left",width:"100%"}}>{user?.email || "Signed in"}</button>}</div>}</aside>}{<div className="import-main">{<div className="import-topbar">{<div className="import-topbar__left">{<div>{<div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}} data-type-picker><span style={{fontSize:14,fontWeight:800,color:"var(--text)",letterSpacing:"-0.01em",whiteSpace:"nowrap"}}>Import Suite</span><span style={{color:"var(--border-2)",fontSize:18,fontWeight:300,lineHeight:1}}>›</span><div style={{position:"relative"}}><button type="button" data-hint-target="type-picker-btn" onClick={()=>setTypePickerOpen(v=>!v)} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 14px",borderRadius:9,border:"1.5px solid rgba(45,212,191,0.3)",background:"rgba(45,212,191,0.07)",cursor:"pointer",fontWeight:700,fontSize:15,color:"var(--text)",outline:"none",transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(45,212,191,0.65)";e.currentTarget.style.background="rgba(45,212,191,0.12)";}} onMouseLeave={e=>{e.currentTarget.style.borderColor=typePickerOpen?"rgba(45,212,191,0.65)":"rgba(45,212,191,0.3)";e.currentTarget.style.background=typePickerOpen?"rgba(45,212,191,0.12)":"rgba(45,212,191,0.07)";}}>{activeType?.label||"Select Import Type"}<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{flexShrink:0,marginLeft:2,transition:"transform 0.18s",transform:typePickerOpen?"rotate(180deg)":"rotate(0deg)"}}><path d="M2 4l4 4 4-4" stroke="#2dd4bf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></button>{typePickerOpen&&<div style={{position:"absolute",top:"calc(100% + 8px)",left:0,zIndex:9999,background:"var(--panel)",border:"1px solid var(--border)",borderRadius:12,boxShadow:"var(--shadow)",minWidth:260,maxHeight:440,overflowY:"auto",padding:"6px 0"}}><div style={{padding:"6px 8px",borderBottom:"1px solid var(--divider-color)"}}><button type="button" onClick={()=>{setSelectedImportType("all-import");setTypePickerOpen(false);}} style={{width:"100%",textAlign:"left",padding:"8px 10px",borderRadius:8,border:"none",background:selectedImportType==="all-import"?"rgba(45,212,191,0.12)":"transparent",color:selectedImportType==="all-import"?"var(--accent)":"var(--dropdown-item-color)",fontWeight:700,fontSize:13,cursor:"pointer"}}>⚡ All-in-One Import</button></div>{importTypeGroups.map(group=><div key={group.label} style={{padding:"4px 6px"}}><div style={{fontSize:9.5,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.11em",color:"var(--muted)",padding:"8px 10px 3px"}}>{group.label}</div>{group.types.map(typeValue=>{const t=importTypes.find(t=>t.value===typeValue);if(!t)return null;const isActive=selectedImportType===typeValue;return <button key={typeValue} type="button" onClick={()=>{setSelectedImportType(typeValue);setTypePickerOpen(false);}} style={{display:"block",width:"100%",textAlign:"left",padding:"7px 12px",borderRadius:7,border:"none",background:isActive?"rgba(45,212,191,0.12)":"transparent",color:isActive?"var(--accent)":"var(--dropdown-item-color)",fontWeight:isActive?700:400,fontSize:13,cursor:"pointer"}} onMouseEnter={e=>{if(!isActive)e.currentTarget.style.background="var(--dropdown-item-hover)";}} onMouseLeave={e=>{if(!isActive)e.currentTarget.style.background="transparent";}}>{t.label}</button>;})}</div>)}</div>}</div><button data-hint-target="guide-btn" type="button" onClick={()=>setGuideOpen(true)} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,padding:"6px 14px",borderRadius:8,border:"1.5px solid rgba(167,139,250,0.45)",background:"rgba(167,139,250,0.1)",color:"#c4b5fd",cursor:"pointer",fontWeight:700,whiteSpace:"nowrap",transition:"all 0.15s",flexShrink:0,letterSpacing:0.2}} onMouseEnter={e=>{e.currentTarget.style.borderColor="rgba(167,139,250,0.75)";e.currentTarget.style.background="rgba(167,139,250,0.18)";e.currentTarget.style.color="#ddd6fe";}} onMouseLeave={e=>{e.currentTarget.style.borderColor="rgba(167,139,250,0.45)";e.currentTarget.style.background="rgba(167,139,250,0.1)";e.currentTarget.style.color="#c4b5fd";}}><span style={{fontSize:14}}>📖</span> Guide</button></div>}{activeType && (() => {
                const importTips = {
                  invoices:      "Required: Invoice Number · Contact Name · Invoice Date · Due Date · Line Description · Unit Amount · Account Code",
                  bills:         "Required: Bill Number · Supplier Name · Bill Date · Due Date · Line Description · Unit Amount · Account Code",
                  "credit-notes":"Required: Credit Note Number · Contact Name · Date · Line Description · Unit Amount · Account Code",
                  "debit-notes": "Required: Credit Note Number · Contact Name · Date · Line Description · Unit Amount · Account Code",
                  payments:      "Required: Invoice Number · Payment Date · Amount · Account Code (bank account)",
                  "bill-payments":"Required: Bill Number · Payment Date · Amount · Account Code (bank account)",
                  journals:      "Required: Journal Date · Reference · Narration · Account Code · Description · Amount (positive = Debit, negative = Credit)",
                  customers:     "Required: Contact Name — all other fields (email, phone, address, tax) are optional",
                  vendors:       "Required: Contact Name — all other fields optional. AccountsPayableTaxType for GST/VAT",
                  items:         "Required: Item Code · Name · SalesUnitPrice or PurchaseUnitPrice · SalesAccountCode or PurchaseAccountCode",
                  "bank-transactions":"Required: Reference · Date · Amount · Account Code (bank) · Description",
                  "bank-transfers":   "Required: From Bank Account · To Bank Account · Amount · Date · Reference",
                  "purchase-orders":  "Required: PO Number · Supplier Name · Order Date · Delivery Date · Line Description · Unit Amount · Account Code",
                  quotes:             "Required: Quote Number · Contact Name · Quote Date · Expiry Date · Line Description · Unit Amount · Account Code",
                  "spend-money":      "Required: Reference · Date · Amount · Account Code (bank) · Contact (optional)",
                  "receive-money":    "Required: Reference · Date · Amount · Account Code (bank) · Contact (optional)",
                  accounts:           "Required: Account Code · Account Name · Account Type · Tax Type",
                };
                const tip = importTips[activeType.value];
                if (!tip) return null;
                return <div style={{marginTop:5,fontSize:11.5,color:"var(--muted)",display:"flex",alignItems:"flex-start",gap:6}}><span style={{color:"var(--accent)",fontWeight:700,flexShrink:0}}>Columns:</span><span>{tip}</span></div>;
              })()}</div>}</div>}{<div className="import-topbar__actions">{sessionId ? <div data-hint-target="connect-btn" style={{display:"flex",gap:4,alignItems:"center",flexShrink:0,borderRight:"1px solid var(--border)",paddingRight:10,marginRight:2}}><span style={{display:"inline-block",width:7,height:7,borderRadius:"50%",background:"#2dd4bf",flexShrink:0,boxShadow:"0 0 6px #2dd4bf"}}/><button type="button" onClick={handleConnect} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"}}>Reconnect</button><button type="button" onClick={handleDisconnect} style={{fontSize:11,padding:"3px 8px",borderRadius:6,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.07)",color:"#f87171",cursor:"pointer",fontWeight:600,whiteSpace:"nowrap"}}>Disconnect</button></div> : <button data-hint-target="connect-btn" type="button" onClick={handleConnect} style={{fontSize:12,padding:"5px 12px",borderRadius:7,border:"1.5px solid rgba(45,212,191,0.45)",background:"rgba(45,212,191,0.1)",color:"#2dd4bf",cursor:"pointer",fontWeight:700,whiteSpace:"nowrap",flexShrink:0}}>+ Connect Xero</button>}{<select data-hint-target="org-select" value={selectedTenant} onChange={e => { const tid = e.target.value; setSelectedTenant(tid); const found = tenants.find(t => t.tenantId === tid); if (found?.sessionId) setSessionId(found.sessionId); }} disabled={!tenants.length} style={{
                fontSize: 13,
                padding: "6px 10px",
                borderRadius: 8,
                minWidth: 160
              }}>{<option value="">{tenants.length ? "Select organisation" : "Connect to Xero first"}</option>}{tenants.map(t => <option key={t.tenantId} value={t.tenantId}>{t.tenantName}</option>)}</select>}{<button type="button" title="Date format used when parsing CSV dates that are ambiguous (e.g. 04/01/2025)" onClick={() => { const next = dateFormatPref === "DD/MM/YYYY" ? "MM/DD/YYYY" : "DD/MM/YYYY"; setDateFormatPref(next); localStorage.setItem("kk_dateFormat", next); }} style={{fontSize:12,padding:"5px 10px",borderRadius:7,border:"1.5px solid var(--border)",background:"var(--surface2)",color:"var(--text)",cursor:"pointer",fontWeight:600,letterSpacing:0.3,whiteSpace:"nowrap"}}>📅 {dateFormatPref}</button>}{<button type="button" className="import-chip import-chip--neutral" onClick={()=>navigate("/account")} title="Account & Billing" style={{cursor:"pointer",background:"transparent",border:"1px solid var(--border)",borderRadius:6,fontFamily:"inherit"}}>{user?.email || "Signed in"}</button>}{<button type="button" onClick={()=>{if(hintStep!=null){setHintStep(null);setHintRect(null);}else{localStorage.removeItem("kk_hintDone");const s=!sessionId?0:!selectedTenant?1:2;setHintStep(s);}}} title={hintStep!=null?"Tour running — click to stop":"Start guided tour (5 steps)"} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,padding:"4px 10px",borderRadius:7,border:`1px solid ${hintStep!=null?"rgba(245,158,11,0.45)":"var(--border)"}`,background:hintStep!=null?"rgba(245,158,11,0.1)":"transparent",color:hintStep!=null?"#f59e0b":"var(--muted)",cursor:"pointer",fontWeight:700,transition:"all 0.2s",flexShrink:0,whiteSpace:"nowrap"}}><span style={{fontSize:13}}>💡</span>{hintStep!=null?"Tour ON":"Tour"}</button>}{<button type="button" onClick={()=>setDarkMode(v=>!v)} title={darkMode?"Switch to light mode":"Switch to dark mode"} style={{display:"flex",alignItems:"center",justifyContent:"center",width:30,height:30,borderRadius:7,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--muted)",cursor:"pointer",fontSize:15,transition:"all 0.2s",flexShrink:0}} onMouseEnter={e=>{e.currentTarget.style.background="var(--surface2)";e.currentTarget.style.color="var(--ink)";}} onMouseLeave={e=>{e.currentTarget.style.background="var(--surface)";e.currentTarget.style.color="var(--muted)";;}}>{darkMode?"☀️":"🌙"}</button>}</div>}</div>}{<div className="import-body">{(()=>{if(!user?.planExpiry||user?.plan==="team"||user?.plan==="testing"||user?.plan==="none")return null;const expMs=new Date(user.planExpiry)-Date.now();const daysLeft=Math.ceil(expMs/86400000);if(daysLeft>7)return null;if(daysLeft<=0){return(<div style={{margin:"0 0 12px",padding:"14px 18px",borderRadius:10,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.35)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>🚫</span><div><div style={{fontWeight:700,fontSize:14,color:"#f87171"}}>Plan Expired</div><div style={{fontSize:13,color:"var(--muted)",marginTop:2}}>Your <strong style={{color:"var(--ink)"}}>{user.plan}</strong> plan expired on {new Date(user.planExpiry).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}. Imports are blocked until renewed.</div></div></div><button type="button" onClick={()=>navigate("/pricing")} style={{padding:"7px 18px",background:"rgba(239,68,68,0.15)",color:"#f87171",border:"1px solid rgba(239,68,68,0.4)",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>↗ Renew Plan</button></div>);}return(<div style={{margin:"0 0 12px",padding:"14px 18px",borderRadius:10,background:"rgba(245,158,11,0.07)",border:"1px solid rgba(245,158,11,0.35)",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>⏰</span><div><div style={{fontWeight:700,fontSize:14,color:"#f59e0b"}}>{daysLeft===1?"Plan expires tomorrow":`Plan expires in ${daysLeft} days`}</div><div style={{fontSize:13,color:"var(--muted)",marginTop:2}}>Your <strong style={{color:"var(--ink)"}}>{user.plan}</strong> plan expires on {new Date(user.planExpiry).toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"})}. Renew now to avoid interruption.</div></div></div><button type="button" onClick={()=>navigate("/pricing")} style={{padding:"7px 18px",background:"rgba(245,158,11,0.12)",color:"#f59e0b",border:"1px solid rgba(245,158,11,0.4)",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",flexShrink:0,whiteSpace:"nowrap"}}>↗ Renew Plan</button></div>);})()}{user?.pendingApprovalNotification && <div style={{margin:"0 0 12px",padding:"14px 18px",borderRadius:10,background:user?.plan==="team"?"rgba(56,189,248,0.08)":"rgba(52,211,153,0.08)",border:`1px solid ${user?.plan==="team"?"rgba(56,189,248,0.35)":"rgba(52,211,153,0.35)"}`,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:22}}>{user?.plan==="team"?"👥":"🎉"}</span><div><div style={{fontWeight:700,fontSize:14,color:user?.plan==="team"?"#38bdf8":"#34d399"}}>{user?.plan==="team"?"Team Access Approved!":"Testing Plan Approved!"}</div><div style={{fontSize:13,color:"rgba(255,255,255,0.6)",marginTop:2}}>{user?.plan==="team"?"Your team account is now active. Your admin has configured your access permissions.":(<>Your account is now active. You can import up to <strong style={{color:"#fff"}}>100 rows total</strong> across all imports.</>)}</div></div></div><button type="button" onClick={async()=>{try{await fetch(`${API_BASE}/user/dismiss-notification`,{method:"POST",headers:{"x-user-token":userToken}});}catch{}setUser(u=>({...u,pendingApprovalNotification:false}));}} style={{padding:"6px 16px",background:"rgba(52,211,153,0.15)",color:"#34d399",border:"1px solid rgba(52,211,153,0.3)",borderRadius:8,fontWeight:600,fontSize:12,cursor:"pointer",flexShrink:0}}>Got it ✓</button></div>}{<div className="import-status-strip">{<div className="import-status-strip__item">{<span className="import-status-strip__label">Connection</span>}{<span className="import-status-strip__value" style={{
                  color: sessionId ? "var(--accent-3)" : "var(--muted)"
                }}>{sessionId ? "Connected" : "Not connected"}</span>}</div>}{<div className="import-status-strip__item">{<span className="import-status-strip__label">Organisation</span>}{<span className="import-status-strip__value">{selectedTenantName || "—"}</span>}</div>}{<div className="import-status-strip__item">{<span className="import-status-strip__label">Import Type</span>}{<span className="import-status-strip__value">{activeType?.label || "—"}</span>}</div>}{<div className="import-status-strip__item">{<span className="import-status-strip__label">Rows Ready</span>}{<span className="import-status-strip__value" style={{
                  color: (active?.rows?.length || 0) > 0 ? "var(--accent-3)" : "var(--ink)"
                }}>{active?.rows?.length || 0}</span>}</div>}</div>}{!["all-import","conversion-balances"].includes(selectedImportType) && !active?.rows?.length && !active?.status && !active?.progress && (() => {
  const steps = [
    {
      num: 1,
      title: "Connect to Xero",
      done: !!sessionId,
      status: sessionId ? `Connected · ${selectedTenantName || "select org below"}` : "Not connected",
      action: !sessionId ? { label: "Connect Xero", onClick: handleConnect } : null,
    },
    {
      num: 2,
      title: "Select import type",
      done: !!selectedImportType,
      status: activeType?.label || "Choose from sidebar",
      action: null,
    },
    {
      num: 3,
      title: "Download & fill template",
      done: false,
      status: "Get the CSV template for this import type",
      action: active?.onDownload ? { label: "⬇ Download Template", onClick: active.onDownload } : null,
    },
    {
      num: 4,
      title: "Upload file & import",
      done: false,
      status: "Upload your filled CSV file below",
      action: null,
    },
  ];
  const allDone = steps.slice(0,2).every(s => s.done);
  return (
    <div style={{marginBottom:20,padding:"18px 20px",borderRadius:12,background:"var(--surface)",border:"1px solid var(--border)"}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:14,color:"var(--text)"}}>How to import — 4 steps</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10}}>
        {steps.map(s => (
          <div key={s.num} style={{padding:"12px 14px",borderRadius:9,background:s.done?"rgba(34,197,94,0.07)":"var(--surface2)",border:`1px solid ${s.done?"rgba(34,197,94,0.25)":"var(--border)"}`,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{width:22,height:22,borderRadius:"50%",background:s.done?"#22c55e":"var(--surface3)",border:`1.5px solid ${s.done?"#22c55e":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:s.done?"#fff":"var(--muted)",flexShrink:0}}>{s.done?"✓":s.num}</span>
              <span style={{fontSize:12,fontWeight:700,color:s.done?"#22c55e":"var(--text)"}}>{s.title}</span>
            </div>
            <div style={{fontSize:11,color:"var(--muted)",paddingLeft:30}}>{s.status}</div>
            {s.action && <button type="button" onClick={s.action.onClick} style={{marginLeft:30,marginTop:2,fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:6,background:"rgba(99,102,241,0.1)",color:"var(--accent,#818cf8)",border:"1px solid rgba(99,102,241,0.25)",cursor:"pointer",width:"fit-content"}}>{s.action.label}</button>}
          </div>
        ))}
      </div>
      {!allDone && <div style={{marginTop:12,fontSize:11,color:"var(--muted)",padding:"8px 12px",borderRadius:7,background:"var(--surface2)",border:"1px solid var(--border)"}}>💡 Tip: Select the import type from the left sidebar, then download the CSV template — fill in your data and upload here. CSV files only.</div>}
      {allDone && <div style={{marginTop:12,fontSize:11,color:"#22c55e",padding:"8px 12px",borderRadius:7,background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.2)"}}>✓ Ready — download the template, fill it in, and upload below to start importing.</div>}
    </div>
  );
})()}
{selectedImportType === "all-import" && <div className="import-card">{<div className="allimport-intro">{<h2>All-in-One Import</h2>}{<p>Upload the combined CSV template. All sections will be imported automatically in the correct order.</p>}</div>}{<div className="import-connection-actions">{<button className="btn ghost" type="button" onClick={downloadCombinedTemplate}>Download Combined Template</button>}{<label className="btn primary import-upload-button">Upload Filled CSV{<input type="file" accept=".csv" onChange={e => handleAllImportFile(e.target.files?.[0] || null)} />}</label>}{allImportFile && <span className="import-chip import-chip--neutral">{allImportFile.name}</span>}</div>}{allImportFileError && <div className="import-validation import-validation--error">{allImportFileError}</div>}{allImportSections.length > 0 && allImportPhases.length === 0 && <div className="import-preview">{<div className="import-preview__header">{<strong>{"Ready to import — "}{allImportSections.length}{" section(s) found"}</strong>}</div>}{<div className="allimport-table">{<div className="allimport-row allimport-row--header allimport-row--preview">{<span>#</span>}{<span>Import Type</span>}{<span style={{
                      textAlign: "right"
                    }}>Rows</span>}</div>}{allImportSections.map((s, i) => <div className="allimport-row allimport-row--preview">{<span style={{
                      color: "var(--muted-2)"
                    }}>{i + 1}</span>}{<span style={{
                      fontWeight: 500
                    }}>{s.label}</span>}{<span style={{
                      textAlign: "right",
                      color: "var(--accent-3)",
                      fontWeight: 600
                    }}>{s.rows}</span>}</div>)}</div>}{<div className="import-submit-row">{<button className="btn primary" type="button" onClick={startAllImport} disabled={allImportRunning}>Start All Import (in order)</button>}</div>}</div>}{allImportPhases.length > 0 && <div className="import-preview">{<div className="import-preview__header">{<strong>{allImportRunning ? `Importing… (${allImportPhases.filter(p => p.status === "done" || p.status === "done_with_errors").length}/${allImportPhases.filter(p => p.status !== "skipped").length} done)` : (() => {
                      const done = allImportPhases.filter(p => p.status === "done").length;
                      const errs = allImportPhases.filter(p => p.status === "done_with_errors").length;
                      const skip = allImportPhases.filter(p => p.status === "skipped").length;
                      return `Complete — ${done} imported${errs > 0 ? `, ${errs} with errors` : ""}${skip > 0 ? `, ${skip} skipped` : ""}`;
                    })()}</strong>}</div>}{<div className="allimport-table">{<div className="allimport-row allimport-row--header">{<span />}{<span>Import Type</span>}{<span>Status</span>}{<span style={{
                      textAlign: "right"
                    }}>Created</span>}{<span style={{
                      textAlign: "right"
                    }}>Errors</span>}</div>}{allImportPhases.map(p => <div className={`allimport-row allimport-row--${p.status}`}>{<span />}{<span style={{
                      fontWeight: 500
                    }}>{p.label}</span>}{<span className={`allimport-status allimport-status--${p.status}`}>{p.status === "pending" && "waiting"}{p.status === "running" && "running"}{p.status === "done" && "done"}{p.status === "done_with_errors" && "done with errors"}{p.status === "skipped" && "skipped (no data)"}</span>}{<span style={{
                      textAlign: "right",
                      color: "var(--accent-3)",
                      fontWeight: 600
                    }}>{["pending", "skipped"].includes(p.status) ? "—" : p.created}</span>}{<span style={{
                      textAlign: "right",
                      color: p.errors > 0 ? "var(--accent-2)" : "var(--muted-2)",
                      fontWeight: 600
                    }}>{["pending", "skipped"].includes(p.status) ? "—" : p.errors}</span>}</div>)}</div>}{!allImportRunning && <div className="import-submit-row">{<button className="btn ghost" type="button" onClick={() => {
                    setAllImportPhases([]);
                    setAllImportSections([]);
                    setAllImportFile(null);
                  }}>← Start New Import</button>}</div>}</div>}{allImportPhases.length === 0 && allImportSections.length === 0 && <div className="allimport-order-box">{<span className="allimport-order-box__title">Import order (automatic)</span>}{<div className="allimport-order-grid">{ALL_IMPORT_ORDER.map((d, i) => <div>{i + 1}{". "}{d.label}</div>)}</div>}</div>}</div>}{selectedImportType === "conversion-balances" && <div className="import-card">{<div className="allimport-intro">{<h2>Conversion Balances</h2>}{<p>Load your live Chart of Accounts, enter opening Debit/Credit balances, and push one balanced Manual Journal dated the day before your Conversion Date. AR/AP control accounts are excluded here — bring those in via Bills/Invoices import instead so Xero's Aged Receivables/Payables stay accurate.</p>}</div>}{<div className="import-control-grid">{<label className="field">{<span>Conversion Date</span>}{<input type="date" value={conversionDate} onChange={e => setConversionDate(e.target.value)} />}</label>}</div>}{<div className="import-connection-actions">{<button className="btn ghost" type="button" onClick={loadConversionAccounts} disabled={conversionLoading || !selectedTenant}>{conversionLoading ? "Loading..." : "Load Chart of Accounts from Xero"}</button>}{conversionAccounts.length > 0 && <span className="import-chip import-chip--neutral">{conversionAccounts.length}{" account(s) loaded"}</span>}</div>}{conversionError && <div className="import-validation import-validation--error">{conversionError}</div>}{conversionAccounts.length > 0 && <div className="import-preview">{<div className="import-preview__header">{<strong>Enter opening balances</strong>}{<span>AR/AP control accounts are locked — use Bills/Invoices import for those</span>}</div>}{<div className="allimport-table" style={{
                  maxHeight: 420,
                  overflowY: "auto"
                }}>{<div className="allimport-row allimport-row--header" style={{
                    gridTemplateColumns: "90px 1fr 140px 140px 140px"
                  }}>{<span>Code</span>}{<span>Account</span>}{<span>Type</span>}{<span style={{
                      textAlign: "right"
                    }}>Debit</span>}{<span style={{
                      textAlign: "right"
                    }}>Credit</span>}</div>}{conversionAccounts.map(r => {
                    const locked = isArApAccount(r);
                    return <div className="allimport-row" style={{
                      gridTemplateColumns: "90px 1fr 140px 140px 140px",
                      opacity: locked ? 0.5 : 1
                    }}>{<span>{r.code}</span>}{<span style={{
                        fontWeight: 500
                      }}>{r.name}{locked ? " (AR/AP — import via Bills/Invoices)" : ""}</span>}{<span style={{
                        color: "var(--muted)"
                      }}>{r.type}</span>}{<input type="number" value={r.debit} disabled={locked} onChange={e => updateConversionRow(r.code, "debit", e.target.value)} style={{
                        textAlign: "right",
                        padding: "5px 8px"
                      }} />}{<input type="number" value={r.credit} disabled={locked} onChange={e => updateConversionRow(r.code, "credit", e.target.value)} style={{
                        textAlign: "right",
                        padding: "5px 8px"
                      }} />}</div>;
                  })}</div>}{<div className="import-progress-grid" style={{
                  gridTemplateColumns: "repeat(3, minmax(0,1fr))"
                }}>{<div>{<strong style={{
                      color: "var(--accent-3)"
                    }}>{conversionTotals.debit.toFixed(2)}</strong>}{<span>Total Debit</span>}</div>}{<div>{<strong style={{
                      color: "var(--accent-2)"
                    }}>{conversionTotals.credit.toFixed(2)}</strong>}{<span>Total Credit</span>}</div>}{<div>{<strong style={{
                      color: Math.abs(conversionDiff) > 0.01 ? "var(--accent-2)" : "var(--accent-3)"
                    }}>{conversionDiff.toFixed(2)}</strong>}{<span>{"Difference "}{Math.abs(conversionDiff) > 0.01 ? "— must be 0 to import" : "— balanced"}</span>}</div>}</div>}{<div className="import-submit-row">{<p>{"Journal will be dated "}{conversionDate ? new Date(new Date(conversionDate).setDate(new Date(conversionDate).getDate() - 1)).toLocaleDateString() : "—"}{" (one day before the Conversion Date)."}</p>}{<button className="btn primary" type="button" onClick={startConversionImport} disabled={conversionRunning || !conversionDate || Math.abs(conversionDiff) > 0.01}>{conversionRunning ? "Importing..." : "Push Conversion Balances to Xero"}</button>}</div>}</div>}{conversionStatus && <div className={`import-validation ${conversionResult?.status === "completed" ? "import-validation--success" : conversionResult ? "import-validation--error" : ""}`}>{conversionStatus}</div>}</div>}{!["all-import", "conversion-balances"].includes(selectedImportType) && <>{<div className="import-card">{["bills", "invoices", "credit-notes"].includes(selectedImportType) && <div>{<div className="import-connection-actions">{<button className="btn ghost btn-compact" type="button" onClick={loadTaxRates} disabled={taxRatesLoading}>{taxRatesLoading ? "Loading..." : "Load Tax Rates from Xero"}</button>}{taxRates.length ? <span style={{
                      fontSize: 11,
                      color: "var(--muted)"
                    }}>{taxRates.length}{" rate(s) loaded"}</span> : null}</div>}{taxRates.length > 0 && <div style={{margin:"14px 0 6px",borderRadius:12,overflow:"hidden",border:"1px solid rgba(45,212,191,0.25)",boxShadow:"0 0 0 1px rgba(45,212,191,0.06),0 4px 20px rgba(0,0,0,0.22)"}}>
                    <div style={{padding:"10px 16px",borderBottom:"1px solid rgba(45,212,191,0.15)",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(45,212,191,0.05)"}}>
                      <span style={{fontWeight:700,fontSize:11,color:"#2dd4bf",letterSpacing:1.2,textTransform:"uppercase"}}>Tax Rates</span>
                      <span style={{fontSize:11,color:"var(--muted)"}}>Copy the code → paste into CSV Tax Type column</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1.15fr 64px",padding:"5px 16px",background:"rgba(255,255,255,0.025)",borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
                      <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.8}}>Display Name</span>
                      <span style={{fontSize:10,fontWeight:700,color:"#2dd4bf",textTransform:"uppercase",letterSpacing:0.8}}>Code → paste in CSV</span>
                      <span style={{fontSize:10,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.8,textAlign:"right"}}>Rate</span>
                    </div>
                    <div style={{maxHeight:310,overflowY:"auto"}}>
                      {taxRates.map((rate,i)=>{
                        const pct=rate.effectiveRate;
                        const [rc,rb]=pct>=20?["#f59e0b","rgba(245,158,11,0.13)"]:pct>=5?["#60a5fa","rgba(96,165,250,0.13)"]:["#94a3b8","rgba(148,163,184,0.1)"];
                        return <div key={rate.taxType||i} style={{display:"grid",gridTemplateColumns:"1fr 1.15fr 64px",padding:"8px 16px",borderBottom:i<taxRates.length-1?"1px solid rgba(255,255,255,0.05)":"none",alignItems:"center",background:i%2===0?"transparent":"rgba(255,255,255,0.018)"}}>
                          <span style={{fontSize:12,color:"var(--text)",fontWeight:500}}>{rate.name||"—"}</span>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <code style={{background:"rgba(45,212,191,0.1)",color:"#2dd4bf",padding:"3px 9px",borderRadius:5,fontWeight:700,fontSize:11,letterSpacing:0.5,border:"1px solid rgba(45,212,191,0.2)"}}>{rate.taxType||"—"}</code>
                            <button type="button" title="Copy to clipboard" onClick={()=>navigator.clipboard?.writeText(rate.taxType||"")} style={{background:"none",border:"none",cursor:"pointer",color:"var(--muted)",padding:"2px 5px",fontSize:13,lineHeight:1,borderRadius:4,opacity:0.45,transition:"opacity 0.15s"}} onMouseEnter={e=>e.currentTarget.style.opacity=1} onMouseLeave={e=>e.currentTarget.style.opacity=0.45}>⎘</button>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <span style={{display:"inline-block",padding:"2px 8px",borderRadius:20,fontSize:11,fontWeight:700,color:rc,background:rb}}>{pct!=null?`${pct}%`:"—"}</span>
                          </div>
                        </div>;
                      })}
                    </div>
                  </div>}</div>}{<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div data-hint-target="download-template-btn">{<button className="btn ghost btn-compact" type="button" onClick={active?.onDownload}>Download Template</button>}</div>
                  <div data-hint-target="upload-zone"><FileDropZone
                    file={active?.file ?? null}
                    onChange={f => active?.onFile({ target: { files: f ? [f] : [] } })}
                    label="Upload CSV"
                    disabled={active?.loading}
                  /></div>
                </div>}{active?.errors?.length ? (
  <>
    <div className="import-validation import-validation--error">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6,marginBottom:6}}>
        <strong>Validation errors ({active.errors.length})</strong>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          <button className="btn ghost btn-compact" type="button" style={{fontSize:11,padding:"3px 10px",borderColor:"#7c3aed",color:"#7c3aed"}} onClick={() => { setInlineEditMode(v => !v); setInlineEditDraft({}); }}>
            {inlineEditMode ? "× Close Editor" : "✏️ Fix Inline"}
          </button>
          <button className="btn ghost btn-compact" type="button" style={{fontSize:11,padding:"3px 10px",borderColor:"#e53e3e",color:"#e53e3e"}} onClick={() => downloadImportErrors(active.errors, selectedImportType)}>⬇ Download Error Report</button>
        </div>
      </div>
      {active.errors.slice(0, 6).map((e, i) => <span key={i}>{e}</span>)}
      {active.errors.length > 6 && <span style={{opacity:0.6,fontSize:12}}>...and {active.errors.length - 6} more. Use Fix Inline or Download Error Report to review all.</span>}
    </div>
    {inlineEditMode && (() => {
      const errorRowNums = new Set((active.errors || []).map(e => { const m = String(e).match(/^Row\s+(\d+):/i); return m ? Number(m[1]) : null; }).filter(Boolean));
      const errorRows = (active.rows || []).filter(r => errorRowNums.has(r.rowNumber));
      if (!errorRows.length) return null;
      // Extract precise field keys from error messages ("Unit Amount is required" → "unitAmount")
      const toLabelCamel = label => label.trim().split(/\s+/).map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
      const errorFieldKeys = new Set();
      const errorFieldsPerRow = new Map();
      (active.errors || []).forEach(e => {
        const rm = String(e).match(/^Row\s+(\d+):\s+(.+?)(?:\s+is\s+required|\s+must\s+be|\s+cannot|\s+is\s+invalid)/i);
        if (!rm) return;
        const rowNum = Number(rm[1]);
        const camel = toLabelCamel(rm[2]);
        errorFieldKeys.add(camel);
        if (!errorFieldsPerRow.has(rowNum)) errorFieldsPerRow.set(rowNum, new Set());
        errorFieldsPerRow.get(rowNum).add(camel);
      });
      // Key identifier column per import type
      const keyColMap = { bills:"billNumber", invoices:"invoiceNumber", "credit-notes":"creditNoteNumber", "purchase-orders":"poNumber", quotes:"quoteNumber", "bill-payments":"invoiceNumber", "invoice-payments":"invoiceNumber", "spend-money":"reference", "receive-money":"reference", "manual-journals":"reference", accounts:"code", items:"code", customers:"name", vendors:"name", "tracking-categories":"categoryName" };
      const keyCol = keyColMap[selectedImportType];
      const sampleRow = errorRows[0] || {};
      const pinnedCols = [keyCol, "contactName"].filter(c => c && c in sampleRow);
      const errCols = [...errorFieldKeys].filter(c => c in sampleRow && !pinnedCols.includes(c));
      const editCols = [...new Set([...pinnedCols, ...errCols])];
      const fieldLabelMap = { billNumber:"Bill #", invoiceNumber:"Invoice #", creditNoteNumber:"Credit Note #", poNumber:"PO #", quoteNumber:"Quote #", contactName:"Contact", unitAmount:"Unit Amount ★", accountCode:"Account Code", description:"Description", quantity:"Qty", taxType:"Tax Type", taxAmount:"Tax Amt", dueDate:"Due Date", invoiceDate:"Date", billDate:"Date", creditNoteDate:"Date", reference:"Reference", currencyCode:"Currency", code:"Code", name:"Name", categoryName:"Category" };
      const editLabels = editCols.map(c => fieldLabelMap[c] || c.replace(/([A-Z])/g, " $1").trim());
      const MAX_ROWS = 100;
      const visibleRows = errorRows.slice(0, MAX_ROWS);
      const hiddenCount = errorRows.length - visibleRows.length;
      const getDraft = (rowNum, col) => inlineEditDraft[rowNum]?.[col] !== undefined ? inlineEditDraft[rowNum][col] : (sampleRow.rowNumber === rowNum ? sampleRow[col] ?? "" : (errorRows.find(r => r.rowNumber === rowNum)?.[col] ?? ""));
      const updateCell = (rowNum, col, val) => setInlineEditDraft(prev => ({ ...prev, [rowNum]: { ...(prev[rowNum] || {}), [col]: val } }));
      return (
        <div style={{marginTop:12,border:"1px solid rgba(239,68,68,0.25)",borderRadius:10,overflow:"hidden",background:"var(--surface)"}}>
          <div style={{padding:"10px 14px",background:"rgba(239,68,68,0.05)",borderBottom:"1px solid rgba(239,68,68,0.15)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <div style={{display:"flex",flexDirection:"column",gap:2}}>
              <div><strong style={{fontSize:13,color:"#dc2626"}}>Editing {errorRows.length} error row{errorRows.length !== 1 ? "s" : ""}</strong>{hiddenCount > 0 && <span style={{fontSize:11,color:"#f59e0b",marginLeft:10}}>Showing first {MAX_ROWS} — fix & re-validate for rest</span>}</div>
              <span style={{fontSize:11,color:"var(--muted)"}}>Red border = has error · Green border = edited · ★ = error column</span>
            </div>
            <button className="btn primary" type="button" style={{fontSize:12,padding:"5px 14px",background:"#16a34a",borderColor:"#16a34a"}} onClick={handleInlineEditApply}>Apply & Re-validate</button>
          </div>
          <div style={{overflowX:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
              <thead>
                <tr style={{background:"var(--surface-alt,#f5f5f5)"}}>
                  <th style={{padding:"7px 10px",textAlign:"left",fontWeight:600,color:"var(--muted)",borderBottom:"1px solid var(--border)",whiteSpace:"nowrap"}}>Row</th>
                  {editCols.map((col, ci) => <th key={col} style={{padding:"7px 10px",textAlign:"left",fontWeight:600,borderBottom:"1px solid var(--border)",whiteSpace:"nowrap",color:errCols.includes(col)?"#ef4444":"inherit"}}>{editLabels[ci] || col}</th>)}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map(row => (
                  <tr key={row.rowNumber} style={{borderBottom:"1px solid var(--border)"}}>
                    <td style={{padding:"5px 10px",color:"var(--muted)",fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap",fontWeight:600}}>{row.rowNumber}</td>
                    {editCols.map(col => {
                      const hasErr = errorFieldsPerRow.get(row.rowNumber)?.has(col);
                      const isDirty = inlineEditDraft[row.rowNumber]?.[col] !== undefined;
                      return (
                        <td key={col} style={{padding:"3px 6px"}}>
                          <input type="text" value={getDraft(row.rowNumber, col)} onChange={e => updateCell(row.rowNumber, col, e.target.value)}
                            style={{width:"100%",padding:"4px 7px",borderRadius:5,border:hasErr?"1.5px solid #ef4444":isDirty?"1.5px solid #22c55e":"1px solid var(--border)",background:hasErr?"rgba(239,68,68,0.06)":isDirty?"rgba(34,197,94,0.04)":"var(--surface)",color:"var(--text)",fontSize:12,outline:"none",minWidth:hasErr?110:80}} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    })()}
  </>
) : active?.rows?.length ? <div className="import-validation import-validation--success">{<strong>CSV validated successfully</strong>}{<span>{active.rows.length}{" row(s) ready to import."}</span>}</div> : null}{active?.rows?.length ? <div className="import-preview">{<div className="import-preview__header">{<strong>Data Preview</strong>}{<span>{"First "}{Math.min(active.rows.length, 5)}{" of "}{active.rows.length}{" rows"}</span>}</div>}{<div className="import-preview__table">{<div className="import-preview__row import-preview__row--header" style={{
                      gridTemplateColumns: `56px repeat(${active.resultCols.length - 1}, 1fr)`
                    }}>{active.resultLabels.map(l => <span>{l}</span>)}</div>}{active.rows.slice(0, 5).map(row => <div className="import-preview__row" style={{
                      gridTemplateColumns: `56px repeat(${active.resultCols.length - 1}, 1fr)`
                    }}>{active.resultCols.map(col => <span>{row[col] || "-"}</span>)}</div>)}</div>}</div> : null}{<div className="import-submit-row">
  {<p>{!selectedTenant ? "Select a Xero organisation to enable import." : "Review the data preview above before importing."}</p>}
  {(selectedImportType === "spend-money" || selectedImportType === "receive-money") && <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",userSelect:"none",fontWeight:400,color:"var(--muted)"}}><input type="checkbox" checked={selectedImportType === "spend-money" ? spendMoneySkipDupCheck : receiveMoneySkipDupCheck} onChange={e => selectedImportType === "spend-money" ? setSpendMoneySkipDupCheck(e.target.checked) : setReceiveMoneySkipDupCheck(e.target.checked)} />{" Skip duplicate check (faster, no pre-scan)"}</label>}
  {["spend-op", "receive-op"].includes(selectedImportType) && (
    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",userSelect:"none",fontWeight:400,color:"var(--muted)"}}>
      <input type="checkbox" checked={opSkipDupCheck} onChange={e => setOpSkipDupCheck(e.target.checked)} />
      {" Skip already-existing references (auto-detect duplicates before import)"}
    </label>
  )}
  {["bills", "invoices", "purchase-orders", "quotes", "credit-notes"].includes(selectedImportType) && (
    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",userSelect:"none",fontWeight:400,color:"var(--muted)"}}>
      <input type="checkbox" checked={autoCreateContacts} onChange={e => setAutoCreateContacts(e.target.checked)} />
      {" Auto-create missing contacts before import"}
    </label>
  )}
  <label style={{display:"flex",alignItems:"center",gap:6,fontSize:13,cursor:"pointer",userSelect:"none",fontWeight:400,color:"var(--muted)"}}>
    <input type="checkbox" checked={dryRunMode} onChange={e => { setDryRunMode(e.target.checked); setDryRunResult(null); }} />
    {" Dry Run (preview only — nothing will be created)"}
  </label>
  {dryRunMode
    ? <button className="btn ghost" type="button" style={{borderColor:"#d97706",color:"#d97706"}} onClick={() => { if (!active?.rows?.length) return; setDryRunResult({ rows: active.rows.length, errors: active.errors || [], typeName: activeType?.label || "Records" }); }} disabled={!active?.rows?.length || !selectedTenant}>Preview Import (Dry Run)</button>
    : <>
      <button className="btn primary" type="button" onClick={() => { if (!hasPermission("import")) { setAccessDeniedModal({ feature: "Import" }); return; } active?.onImport?.(); }} disabled={active?.loading || !active?.rows?.length || active?.errors?.length > 0 || !selectedTenant}>{active?.loading ? active?.isAllocation ? "Allocating..." : "Importing..." : active?.isAllocation ? "Allocate to Xero" : "Import to Xero"}</button>
      {active?.errors?.length > 0 && active?.rows?.length > 0 && !active?.loading && !dryRunMode && (
        <button className="btn ghost" type="button" style={{borderColor:"#f97316",color:"#f97316",fontSize:12}} onClick={handlePartialImport} title="Skip rows with errors and import only valid rows">✂️ Import Valid Rows Only ({(active.rows.filter(r => { const errNums = new Set((active.errors||[]).map(e => { const m = String(e).match(/^Row\s+(\d+):/i); return m ? Number(m[1]) : null; }).filter(Boolean)); return !errNums.has(r.rowNumber); }).length).toLocaleString()} valid)</button>
      )}
      {partialSkippedRows.length > 0 && !active?.loading && (
        <button className="btn ghost" type="button" style={{borderColor:"#f97316",color:"#f97316",fontSize:12}} onClick={downloadPartialSkippedRows} title="Download the rows that were skipped (had errors) as a CSV so you can fix and re-import them">⬇ Download {partialSkippedRows.length} Skipped Row{partialSkippedRows.length !== 1 ? "s" : ""} CSV</button>
      )}
      {!hasPermission("import") && <span style={{fontSize:11,color:"var(--muted)",marginLeft:4}}>No import permission</span>}
    </>
  }
  {lastImportMeta?.type === selectedImportType && !active?.loading && !dryRunMode && (
    <button className="btn ghost" type="button" style={{borderColor:"#e53e3e",color:"#e53e3e",fontSize:12}} onClick={handleUndoImport} disabled={undoLoading}>{undoLoading ? "Undoing..." : `Undo Last Import (${lastImportMeta.created} records)`}</button>
  )}
  {selectedImportType === "manual-journals" && !active?.loading && !dryRunMode && (
    <button className="btn ghost" type="button" style={{borderColor:"#6366f1",color:"#6366f1",fontSize:12}} onClick={() => { setJournalFixResult(null); setJournalFixModal(true); }}>Fix Journal Dates (shift +1/-1 day)</button>
  )}
  {selectedImportType === "manual-journals" && manualJournalRows.length > 0 && !active?.loading && !dryRunMode && (
    <button className="btn ghost" type="button" style={{borderColor:"#0ea5e9",color:"#0ea5e9",fontSize:12}} onClick={convertManualJournalDatesToDDMM} title="Converts dates from MM/DD/YYYY (US format) to DD/MM/YYYY">🔄 Convert MM/DD → DD/MM dates</button>
  )}
  {(active?.rows?.length > 0 || active?.errors?.length > 0) && !active?.loading && !dryRunMode && (
    <button className="btn ghost" type="button" style={{borderColor:"#8b5cf6",color:"#8b5cf6",fontSize:12}} onClick={handleAutoFix} title="Trim whitespace and remove currency symbols (₹$£€) from all fields">✨ Auto-Fix (trim &amp; clean)</button>
  )}
  {active?.rows?.length > 0 && !active?.loading && !dryRunMode && ["invoice-payments","bill-payments","credit-note-refunds"].includes(selectedImportType) && (
    <button className="btn ghost" type="button" style={{borderColor:"#0ea5e9",color:"#0ea5e9",fontSize:12}} onClick={() => handlePreValidate("invoices")} disabled={preCheckLoading} title="Check if invoice numbers exist in Xero before importing">
      {preCheckLoading ? "Checking…" : "🔍 Pre-check Invoices in Xero"}
    </button>
  )}
  {active?.rows?.length > 0 && !active?.loading && !dryRunMode && ["bills","invoices","credit-notes","purchase-orders","quotes","spend-money","receive-money"].includes(selectedImportType) && (
    <button className="btn ghost" type="button" style={{borderColor:"#0ea5e9",color:"#0ea5e9",fontSize:12}} onClick={() => handlePreValidate("contacts")} disabled={preCheckLoading} title="Check if contact names exist in Xero before importing">
      {preCheckLoading ? "Checking…" : "🔍 Pre-check Contacts in Xero"}
    </button>
  )}
  {!active?.loading && !dryRunMode && active?.rows?.length > 0 && (
    <div style={{width:"100%",marginTop:4}}>
      <input
        type="text"
        value={importNote}
        onChange={e => setImportNote(e.target.value.slice(0, 500))}
        placeholder="📝 Add import note (optional) — e.g. Q1 2021 Invoice Payments - Batch A"
        maxLength={500}
        style={{width:"100%",boxSizing:"border-box",padding:"7px 10px",fontSize:12,border:"1px solid var(--border)",borderRadius:6,background:"var(--surface)",color:"var(--text)",outline:"none"}}
      />
    </div>
  )}
</div>}
{dryRunResult && <div className="import-validation" style={{background:"#fffbeb",borderColor:"#d97706",marginTop:8}}>
  <strong style={{color:"#d97706"}}>Dry Run Preview — {dryRunResult.typeName}</strong>
  <div style={{marginTop:6}}>
    <div><strong>{dryRunResult.rows}</strong> row(s) loaded</div>
    <div style={{color: dryRunResult.errors.length ? "#e53e3e" : "var(--accent-3)",marginTop:4}}>{dryRunResult.errors.length === 0 ? "No validation errors — ready to import." : `${dryRunResult.errors.length} validation error(s) found:`}</div>
    {dryRunResult.errors.slice(0,10).map((e,i) => <div key={i} style={{color:"#e53e3e",fontSize:12,marginTop:2}}>• {e}</div>)}
    {dryRunResult.errors.length > 10 && <div style={{color:"#e53e3e",fontSize:12}}>...and {dryRunResult.errors.length - 10} more</div>}
  </div>
  <div style={{display:"flex",gap:8,marginTop:10}}>
    {dryRunResult.errors.length === 0 && <button className="btn primary" type="button" onClick={() => { setDryRunMode(false); setDryRunResult(null); active?.onImport(); }}>Confirm & Import to Xero</button>}
    <button className="btn ghost" type="button" onClick={() => setDryRunResult(null)}>Close</button>
  </div>
</div>}{active?.status ? <div className="import-validation">{<strong>Status</strong>}{<span>{active.status}</span>}</div> : null}</div>}{active?.progress ? <div className="import-card">{<div className="import-card__heading">{<div>{<p className="kicker" style={{
                      color: "var(--accent)",
                      marginBottom: 4
                    }}>Live Progress</p>}{<h2>{activeType?.label}{" — Import Activity"}</h2>}</div>}{<div style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center"
                  }}>{lastImportJobIds[selectedImportType] && (active.progress.created > 0 || active.progress.skipped > 0) && <button className="btn ghost btn-compact" type="button" style={{
                      fontSize: 12,
                      color: "#22c55e",
                      borderColor: "#22c55e"
                    }} onClick={() => handleDownloadErrors(selectedImportType, "success")}>✅ Success Sheet</button>}{active.progress.errors > 0 && lastImportJobIds[selectedImportType] && <button className="btn ghost btn-compact" type="button" style={{
                      fontSize: 12,
                      color: "#e53e3e",
                      borderColor: "#e53e3e"
                    }} onClick={() => handleDownloadErrors(selectedImportType, "errors")}>❌ Error Sheet (Reimport)</button>}{active.progress.errors > 0 && ["completed", "completed_with_errors"].includes(active.progress.status) && (active.rows || []).length > 0 && <button className="btn ghost btn-compact" type="button" style={{ fontSize: 12, color: "#f59e0b", borderColor: "#f59e0b" }} onClick={() => handleDownloadFailedRows(selectedImportType, active.progress, active.rows)}>⬇ Failed Rows CSV</button>}{(active.progress.status === "running" || active.progress.status === "queued") && <button className="btn btn-compact" type="button" style={{ fontSize: 12, background: "#e53e3e", color: "#fff", border: "none", borderRadius: 7, padding: "4px 12px", cursor: "pointer" }} onClick={() => cancelImport(selectedImportType, active.progress.jobId)}>⏹ Stop</button>}{<span className={`import-chip import-chip--${(active.progress.status||"queued").replace(/_/g,"-")}`}>{active.progress.status==="completed"?"Completed":active.progress.status==="completed_with_errors"?"Done — Errors":active.progress.status==="error"?"Failed":active.progress.status==="cancelled"?"Stopped":active.progress.status==="running"?"Running…":active.progress.status==="queued"?"Queued":active.progress.status==="interrupted"?"Interrupted":active.progress.status||"…"}</span>}</div>}</div>}{(() => {
                    const pct = active.progress.total ? Math.round(active.progress.processed / active.progress.total * 100) : 0;
                    const isInterrupted = active.progress.status === "interrupted";
                    const isDone = active.progress.status === "completed" || active.progress.status === "completed_with_errors" || active.progress.status === "cancelled" || isInterrupted || pct >= 100;
                    const hasErrors = (active.progress.errors || 0) > 0;
                    const barMod = isDone ? (isInterrupted ? "import-progress-bar--errors" : hasErrors ? "import-progress-bar--errors" : "import-progress-bar--done") : "";
                    return <>
                      <div className="import-progress-bar-wrap">
                        <div className="import-progress-bar-header">
                          <span className="import-progress-bar-label">{active.progress.status === "cancelled" ? "Stopped by user" : isInterrupted ? "Interrupted — server restarted" : isDone ? (hasErrors ? "Completed with errors" : "Import complete") : "Processing…"}</span>
                          <span className={`import-progress-bar-pct ${barMod}`}>{pct}%</span>
                        </div>
                        <div className={`import-progress-bar ${barMod}`}><span style={{ width: `${pct}%` }} /></div>
                      </div>
                      {isInterrupted && (
                        <div style={{marginTop:10,padding:"12px 14px",borderRadius:8,background:"rgba(245,158,11,0.1)",border:"1px solid rgba(245,158,11,0.35)"}}>
                          <strong style={{color:"#d97706",fontSize:13}}>⚠️ Import was interrupted by a server restart</strong>
                          <div style={{fontSize:12,color:"var(--muted)",marginTop:6,lineHeight:1.5}}>
                            <strong style={{color:"var(--text)"}}>{(active.progress.created||0).toLocaleString()} records</strong> were already created in Xero before the interruption.
                            The remaining <strong style={{color:"var(--text)"}}>{Math.max(0,(active.progress.total||0)-(active.progress.processed||0)).toLocaleString()}</strong> rows were not processed.
                          </div>
                          <div style={{fontSize:12,color:"var(--muted)",marginTop:6,lineHeight:1.5}}>
                            To resume: Upload the same file again, then use <strong>✂️ Import Valid Rows Only</strong> — skip rows 2 to {active.progress.processed||0} (already imported) and send only the remaining rows.
                          </div>
                          <div style={{marginTop:8,display:"flex",gap:8}}>
                            <button className="btn ghost btn-compact" type="button" style={{fontSize:11,color:"#d97706",borderColor:"rgba(245,158,11,0.4)"}} onClick={() => handleClearInterruptedJob(selectedImportType)}>Clear & Upload New File</button>
                          </div>
                        </div>
                      )}
                    </>;
                  })()}{<div className="import-progress-grid">{<div className="ipstat ipstat--processed">{<strong>{active.progress.processed || 0}</strong>}{<span>Processed</span>}</div>}{<div className="ipstat ipstat--created">{<strong>{active.progress.created || 0}</strong>}{<span>Created</span>}</div>}{<div className="ipstat ipstat--remaining">{<strong>{active.progress.remaining || 0}</strong>}{<span>Remaining</span>}</div>}{<div className={`ipstat ipstat--errors${(active.progress.errors||0)>0?" ipstat--has-errors":""}`}>{<strong>{active.progress.errors || 0}</strong>}{<span>Errors</span>}</div>}{(active.progress.skipped || 0) > 0 && <div>{<strong style={{color:"#6366f1"}}>{active.progress.skipped}</strong>}{<span style={{color:"#6366f1"}}>Skipped</span>}</div>}{(active.progress.warnings || 0) > 0 && <div>{<strong style={{
                      color: "#d97706"
                    }}>{active.progress.warnings}</strong>}{<span style={{
                      color: "#d97706"
                    }}>Tax Warnings</span>}</div>}</div>}{<div className="import-progress-detail">{<span>{active.progressLabel(active.progress)}</span>}{<span>{"ETA: "}{formatEta(active.progress.etaMs)}</span>}</div>}{active.progress.results?.length ? <div className="import-results">{(() => {
  const allResults = active.progress.results;
  const filters = ["all","created","skipped","error"];
  const filtered = importResultsFilter === "all" ? allResults : allResults.filter(r => r.status === importResultsFilter);
  const counts = Object.fromEntries(filters.map(f => [f, f === "all" ? allResults.length : allResults.filter(r => r.status === f).length]));
  return <>
    <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap",alignItems:"center"}}>
      {filters.filter(f => counts[f] > 0).map(f => (
        <button key={f} onClick={() => setImportResultsFilter(f)} className={`import-result-filter-btn import-result-filter-btn--${f}${importResultsFilter===f?" import-result-filter-btn--active":""}`}>
          {f==="all"?"All":f.charAt(0).toUpperCase()+f.slice(1)} ({counts[f]})
        </button>
      ))}
      {importResultsFilter==="skipped" && counts["skipped"] > 0 && (
        <button onClick={() => {
          const refs = allResults.filter(r => r.status==="skipped").map(r => r.reference || r.code || r.invoiceNumber || r.billNumber || r.name || "-").filter(Boolean).join("\n");
          navigator.clipboard.writeText(refs).then(() => toast.success(`${counts["skipped"]} skipped references copied!`));
        }} style={{fontSize:11,padding:"2px 10px",borderRadius:4,border:"1px solid #6366f1",background:"transparent",color:"#6366f1",cursor:"pointer",marginLeft:"auto"}}>
          Copy References
        </button>
      )}
    </div>
    {filtered.map(result => <div className={`import-result import-result--${result.status}`}>{active.resultCols.map(col => <span>{col === "rowNumber" ? `Row ${result[col]}` : result[col] || "-"}</span>)}{<span>{result.message}</span>}</div>)}
  </>;
})()}</div> : null}</div> : null}</>}</div>}</div>}</div>}</div>{journalFixModal && <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(5px)",zIndex:9998,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget&&!journalFixLoading){setJournalFixModal(false);}}}>
  <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:16,width:"100%",maxWidth:500,padding:"28px 28px 24px",boxShadow:"0 30px 80px rgba(0,0,0,0.5)"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
      <div>
        <h3 style={{margin:0,fontSize:15,fontWeight:700}}>Fix Journal Dates</h3>
        <p style={{margin:"4px 0 0",fontSize:12,color:"var(--muted)"}}>Shift dates of all DRAFT manual journals in a date range by +1 or -1 days</p>
      </div>
      {!journalFixLoading && <button onClick={()=>setJournalFixModal(false)} style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:8,width:28,height:28,cursor:"pointer",color:"var(--muted)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>✕</button>}
    </div>
    <div style={{background:"rgba(99,102,241,0.07)",border:"1px solid rgba(99,102,241,0.2)",borderRadius:8,padding:"10px 14px",fontSize:12,color:"#818cf8",marginBottom:18,lineHeight:1.55}}>
      <strong>How to use:</strong> Enter the date range of affected journals (the wrong dates in Xero). Select +1 to move dates forward by 1 day. Only DRAFT journals can be updated — POSTED journals will be skipped.
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
      <label style={{display:"flex",flexDirection:"column",gap:5,fontSize:12,color:"var(--muted)",fontWeight:600}}>
        Date From (in Xero)
        <input type="date" value={journalFixDateFrom} onChange={e=>setJournalFixDateFrom(e.target.value)} disabled={journalFixLoading} style={{padding:"7px 10px",borderRadius:7,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
      </label>
      <label style={{display:"flex",flexDirection:"column",gap:5,fontSize:12,color:"var(--muted)",fontWeight:600}}>
        Date To (in Xero)
        <input type="date" value={journalFixDateTo} onChange={e=>setJournalFixDateTo(e.target.value)} disabled={journalFixLoading} style={{padding:"7px 10px",borderRadius:7,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}} />
      </label>
    </div>
    <label style={{display:"flex",flexDirection:"column",gap:5,fontSize:12,color:"var(--muted)",fontWeight:600,marginBottom:18}}>
      Shift dates by
      <select value={journalFixShift} onChange={e=>setJournalFixShift(Number(e.target.value))} disabled={journalFixLoading} style={{padding:"7px 10px",borderRadius:7,border:"1px solid var(--border)",background:"var(--surface2)",color:"var(--text)",fontSize:13}}>
        <option value={1}>+1 day (forward)</option>
        <option value={-1}>-1 day (backward)</option>
        <option value={2}>+2 days</option>
        <option value={-2}>-2 days</option>
      </select>
    </label>
    {journalFixResult && (
      <div style={{background:journalFixResult.error?"rgba(239,68,68,0.08)":journalFixResult.status==="completed"?"rgba(34,197,94,0.08)":"rgba(99,102,241,0.08)",border:`1px solid ${journalFixResult.error?"rgba(239,68,68,0.25)":journalFixResult.status==="completed"?"rgba(34,197,94,0.25)":"rgba(99,102,241,0.25)"}`,borderRadius:8,padding:"10px 14px",fontSize:12,marginBottom:14}}>
        {journalFixResult.error && <span style={{color:"#ef4444"}}>Error: {journalFixResult.error}</span>}
        {!journalFixResult.error && <div>
          <div style={{fontWeight:600,color:journalFixResult.status==="completed"?"#22c55e":"#818cf8",marginBottom:4}}>{journalFixResult.status==="running"?"Processing...":journalFixResult.status==="completed"?"Done!":"Completed"}</div>
          <div style={{color:"var(--muted)",lineHeight:1.6}}>
            {journalFixResult.total!=null && <div>Total found: <strong>{journalFixResult.total}</strong></div>}
            {journalFixResult.updated!=null && <div>Updated: <strong style={{color:"#22c55e"}}>{journalFixResult.updated}</strong></div>}
            {journalFixResult.skipped>0 && <div>Skipped (POSTED): <strong style={{color:"#f59e0b"}}>{journalFixResult.skipped}</strong></div>}
            {journalFixResult.failed>0 && <div>Failed: <strong style={{color:"#ef4444"}}>{journalFixResult.failed}</strong></div>}
            {journalFixResult.message && <div style={{marginTop:4,color:"var(--text)"}}>{journalFixResult.message}</div>}
          </div>
        </div>}
      </div>
    )}
    <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
      {!journalFixLoading && <button className="btn ghost" onClick={()=>setJournalFixModal(false)} style={{fontSize:13}}>Close</button>}
      <button className="btn primary" onClick={startJournalFix} disabled={journalFixLoading||!journalFixDateFrom||!journalFixDateTo||!selectedTenant} style={{fontSize:13,background:"#6366f1",borderColor:"#6366f1"}}>
        {journalFixLoading?"Fixing...":"Start Fix"}
      </button>
    </div>
  </div>
</div>}
{accessDeniedModal && (
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(4px)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={()=>setAccessDeniedModal(null)}>
    <div style={{background:"var(--surface)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:12,padding:32,maxWidth:360,width:"100%",textAlign:"center",boxShadow:"0 20px 60px rgba(0,0,0,0.4)"}} onClick={e=>e.stopPropagation()}>
      <div style={{fontSize:36,marginBottom:12}}>🔒</div>
      <div style={{fontWeight:700,fontSize:17,color:"#ef4444",marginBottom:8}}>Access Restricted</div>
      <div style={{fontSize:13,color:"var(--muted)",marginBottom:20,lineHeight:1.6}}>You don't have permission to use <strong style={{color:"var(--text)"}}>{accessDeniedModal.feature}</strong>.<br/>Contact your admin to get access.</div>
      <button className="btn ghost" onClick={()=>setAccessDeniedModal(null)} style={{fontSize:13}}>Close</button>
    </div>
  </div>
)}
{preCheckModal && preCheckResult && (
  <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.65)",backdropFilter:"blur(5px)",zIndex:9998,display:"flex",alignItems:"center",justifyContent:"center",padding:20}} onClick={e=>{if(e.target===e.currentTarget)setPreCheckModal(false);}}>
    <div style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:12,padding:28,maxWidth:580,width:"100%",maxHeight:"80vh",overflowY:"auto",boxShadow:"0 20px 60px rgba(0,0,0,0.4)"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
        <h2 style={{margin:0,fontSize:18,fontWeight:700}}>🔍 Pre-validation Results</h2>
        <button onClick={()=>setPreCheckModal(false)} style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:8,width:28,height:28,cursor:"pointer",color:"var(--muted)",fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
      </div>
      {preCheckResult.type === "combined" ? (() => {
        const ct = preCheckResult.contacts || { found: [], missing: [] };
        const ac = preCheckResult.accounts || { found: [], missing: [] };
        const allOk = ct.missing.length === 0 && ac.missing.length === 0;
        const renderSection = (label, icon, found, missing) => (
          <div style={{marginBottom:14,padding:"12px 14px",borderRadius:8,background:"var(--surface2)",border:`1px solid ${missing.length>0?"rgba(239,68,68,0.3)":"rgba(34,197,94,0.25)"}`}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:missing.length>0?8:0}}>
              <span style={{fontWeight:600,fontSize:13}}>{icon} {label}</span>
              <div style={{display:"flex",gap:8,fontSize:12}}>
                <span style={{color:"#22c55e",fontWeight:700}}>{found.length} found</span>
                {missing.length>0 && <span style={{color:"#ef4444",fontWeight:700}}>{missing.length} missing</span>}
              </div>
            </div>
            {missing.length>0 && (
              <div style={{maxHeight:120,overflowY:"auto",marginTop:4}}>
                {missing.map((m,i)=>(
                  <div key={i} style={{fontSize:11,padding:"2px 0",color:"#ef4444",borderTop:i>0?"1px solid rgba(239,68,68,0.12)":"none"}}>• {m}</div>
                ))}
              </div>
            )}
          </div>
        );
        return (
          <div>
            {renderSection("Contacts", "👤", ct.found, ct.missing)}
            {ac.found.length + ac.missing.length > 0 && renderSection("Account Codes", "📊", ac.found, ac.missing)}
            {allOk ? (
              <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)",color:"#16a34a",fontSize:13,fontWeight:600}}>
                ✅ All contacts and account codes found in Xero — safe to proceed.
              </div>
            ) : (
              <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.25)",color:"#dc2626",fontSize:13,marginBottom:8}}>
                ⚠️ Some items are missing in Xero. Use <strong>✂️ Import Valid Rows Only</strong> to skip affected rows, or fix the source data first.
              </div>
            )}
            <div style={{marginTop:12,display:"flex",gap:8}}>
              <button className="btn ghost" onClick={()=>setPreCheckModal(false)} style={{fontSize:13}}>Close</button>
              {allOk && <button className="btn primary" onClick={()=>{setPreCheckModal(false);}} style={{fontSize:13}}>Proceed with Import</button>}
            </div>
          </div>
        );
      })() : (
        <div>
          <div style={{display:"flex",gap:12,marginBottom:16,flexWrap:"wrap"}}>
            <div style={{flex:"1 1 120px",padding:"12px 16px",borderRadius:8,background:"var(--surface2)",textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:700}}>{preCheckResult.total}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Total checked</div>
            </div>
            <div style={{flex:"1 1 120px",padding:"12px 16px",borderRadius:8,background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)",textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:700,color:"#22c55e"}}>{preCheckResult.found}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Found in Xero ✓</div>
            </div>
            <div style={{flex:"1 1 120px",padding:"12px 16px",borderRadius:8,background:preCheckResult.notFound>0?"rgba(239,68,68,0.08)":"rgba(34,197,94,0.08)",border:`1px solid ${preCheckResult.notFound>0?"rgba(239,68,68,0.25)":"rgba(34,197,94,0.25)"}`,textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:700,color:preCheckResult.notFound>0?"#ef4444":"#22c55e"}}>{preCheckResult.notFound}</div>
              <div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>Not found ✗</div>
            </div>
          </div>
          {preCheckResult.notFound === 0 ? (
            <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.25)",color:"#16a34a",fontSize:13,fontWeight:600}}>
              ✅ All {preCheckResult.label?.toLowerCase()} found in Xero — safe to proceed with import.
            </div>
          ) : (
            <div>
              <div style={{padding:"10px 14px",borderRadius:8,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.25)",color:"#dc2626",fontSize:13,fontWeight:600,marginBottom:12}}>
                ⚠️ {preCheckResult.notFound} {preCheckResult.label?.toLowerCase()} not found — these rows will fail during import.
              </div>
              {preCheckResult.notFoundList?.length > 0 && (
                <div>
                  <div style={{fontSize:12,color:"var(--muted)",marginBottom:6,fontWeight:600}}>Missing (first {preCheckResult.notFoundList.length}):</div>
                  <div style={{maxHeight:200,overflowY:"auto",background:"var(--surface2)",borderRadius:8,padding:"8px 12px",border:"1px solid var(--border)"}}>
                    {preCheckResult.notFoundList.map((n,i) => (
                      <div key={i} style={{fontSize:12,padding:"3px 0",borderBottom:i<preCheckResult.notFoundList.length-1?"1px solid var(--border)":"none",color:"#dc2626"}}>• {typeof n === "object" ? n.invoiceNumber || n.name || JSON.stringify(n) : n}</div>
                    ))}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:8}}>
                    Tip: Fix these issues first, or use <strong>✂️ Import Valid Rows Only</strong> to skip rows that reference missing {preCheckResult.label?.toLowerCase()}.
                  </div>
                </div>
              )}
            </div>
          )}
          <div style={{marginTop:16,display:"flex",gap:8}}>
            <button className="btn ghost" onClick={()=>setPreCheckModal(false)} style={{fontSize:13}}>Close</button>
            {preCheckResult.notFound === 0 && <button className="btn primary" onClick={()=>{setPreCheckModal(false); active?.onImport?.();}} disabled={!active?.rows?.length||active?.errors?.length>0||!selectedTenant} style={{fontSize:13}}>Proceed with Import</button>}
          </div>
        </div>
      )}
    </div>
  </div>
)}
{columnMappingState && <ColumnMappingModal state={columnMappingState} onConfirm={(mapping, save) => { if (save && columnMappingState.importTypeKey) localStorage.setItem(`kk_colmap_${columnMappingState.importTypeKey}`, JSON.stringify(mapping)); columnMappingState.resolve(mapping); setColumnMappingState(null); }} onCancel={() => { columnMappingState.reject(new Error("Column mapping cancelled.")); setColumnMappingState(null); }} />}
{active?.loading && (() => {
  const _prog = active.progress || {};
  const _proc = _prog.processed || 0;
  const _total = _prog.total || 0;
  const _pct = _total > 0 ? Math.min(100, Math.round((_proc / _total) * 100)) : 0;
  const _created = _prog.created || 0;
  const _errors = _prog.errors || 0;
  const _skipped = _prog.skipped || 0;
  const _currentRef = _prog.currentReference || "";
  const _lastErr = _prog.results ? [..._prog.results].reverse().find(r => r.status === "error") : null;
  const _apiCalls = _prog.apiCalls || null;
  const _isBatch = _apiCalls && (_apiCalls.batch > 0 || _apiCalls.fallback === 0);
  const _jobId = lastImportJobIds[selectedImportType] || "";
  if (_jobId && !etaTrackerRef.current[_jobId]) { etaTrackerRef.current[_jobId] = Date.now(); setStopConfirming(false); }
  const _elapsed = _jobId && etaTrackerRef.current[_jobId] ? (Date.now() - etaTrackerRef.current[_jobId]) / 1000 : 0;
  const _rate = _proc > 5 && _elapsed > 5 ? _proc / _elapsed : 0;
  const _remainSecs = _rate > 0 && _pct < 100 ? Math.ceil((_total - _proc) / _rate) : 0;
  const _etaStr = _remainSecs > 0 ? (_remainSecs >= 3600 ? `~${Math.ceil(_remainSecs/3600)}h remaining` : _remainSecs >= 60 ? `~${Math.ceil(_remainSecs/60)}m remaining` : `~${_remainSecs}s remaining`) : "";
  if (progressOverlayMinimized) {
    return (
      <div style={{ position:"fixed", bottom:20, right:20, zIndex:99999, background:"rgba(8,12,28,0.97)", border:"1px solid #22c55e44", borderRadius:14, padding:"12px 16px", boxShadow:"0 0 24px rgba(34,197,94,0.2)", minWidth:200, cursor:"pointer" }} onClick={() => setProgressOverlayMinimized(false)}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <span style={{ fontSize:10, color:"#22c55e", fontWeight:800, letterSpacing:2, textTransform:"uppercase" }}>⬆ Importing</span>
          <span style={{ fontSize:10, color:"rgba(255,255,255,0.35)" }}>click to expand</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
          <div style={{ flex:1, height:4, background:"rgba(255,255,255,0.08)", borderRadius:3, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${_pct}%`, background:"linear-gradient(90deg,#16a34a,#22c55e)", borderRadius:3, transition:"width 0.6s ease" }} />
          </div>
          <span style={{ fontSize:12, color:"#22c55e", fontFamily:"'Courier New',monospace", fontWeight:700, minWidth:32 }}>{_pct}%</span>
        </div>
        <div style={{ fontSize:10, color:"rgba(255,255,255,0.3)", fontFamily:"'Courier New',monospace" }}>{_proc.toLocaleString()} of {_total.toLocaleString()} records</div>
        <button type="button" style={{ marginTop:8, width:"100%", padding:"4px 0", background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.4)", borderRadius:7, color:"#ef4444", fontSize:11, fontWeight:700, cursor:"pointer" }} onClick={e => { e.stopPropagation(); cancelImport(selectedImportType, _jobId); }}>⏹ Stop Import</button>
      </div>
    );
  }
  return (
    <div style={{ position:"fixed", inset:0, zIndex:99999, background:"rgba(2,6,18,0.92)", backdropFilter:"blur(14px)", display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:0 }}>
      <Lottie animationData={importAnimation} loop={true} autoplay={true} style={{ width:220, height:220, marginBottom:-8 }} />
      <div style={{ background:"rgba(8,12,28,0.97)", border:"1px solid #22c55e22", borderRadius:18, padding:"20px 28px 18px", width:420, boxShadow:"0 0 60px rgba(34,197,94,0.15)", textAlign:"center" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <button type="button" title="Minimize — import continues in background" style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.12)", borderRadius:7, color:"rgba(255,255,255,0.45)", fontSize:11, padding:"3px 10px", cursor:"pointer" }} onClick={() => setProgressOverlayMinimized(true)}>— Minimize</button>
          {stopConfirming ? (
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ fontSize:10, color:"rgba(255,255,255,0.5)", marginRight:2 }}>Stop?</span>
              <button type="button" style={{ background:"rgba(239,68,68,0.9)", border:"none", borderRadius:6, color:"#fff", fontSize:11, fontWeight:700, padding:"3px 10px", cursor:"pointer" }} onClick={() => { forceDismissImport(selectedImportType, _jobId); toast.info("Import stopped."); }}>Yes, Stop</button>
              <button type="button" style={{ background:"transparent", border:"1px solid rgba(255,255,255,0.15)", borderRadius:6, color:"rgba(255,255,255,0.5)", fontSize:11, padding:"3px 8px", cursor:"pointer" }} onClick={() => setStopConfirming(false)}>No</button>
            </div>
          ) : (
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <button type="button" title="Stop import" style={{ background:"rgba(239,68,68,0.15)", border:"1px solid rgba(239,68,68,0.4)", borderRadius:7, color:"#ef4444", fontSize:11, fontWeight:700, padding:"3px 12px", cursor:"pointer" }} onClick={() => setStopConfirming(true)}>⏹ Stop Import</button>
              <button type="button" title="Dismiss overlay — import will continue on server" style={{ background:"transparent", border:"none", color:"rgba(255,255,255,0.3)", fontSize:11, padding:"3px 6px", cursor:"pointer", lineHeight:1 }} onClick={() => { forceDismissImport(selectedImportType, _jobId); toast.info("Overlay dismissed. Import stopped."); }}>✕</button>
            </div>
          )}
        </div>
        <div style={{ fontSize:10, fontWeight:800, letterSpacing:3, color:"#22c55e", textTransform:"uppercase", marginBottom:8 }}>⬆ Posting Entries</div>
        <div style={{ fontSize:30, fontWeight:900, color:"#22c55e", fontFamily:"'Courier New',monospace", lineHeight:1 }}>{_pct}%</div>
        <div style={{ fontSize:12, color:"rgba(255,255,255,0.4)", fontFamily:"'Courier New',monospace", margin:"4px 0 10px" }}>{_proc.toLocaleString()} of {_total.toLocaleString()} records</div>
        <div style={{ height:4, background:"rgba(255,255,255,0.06)", borderRadius:4, overflow:"hidden", marginBottom:6 }}>
          <div style={{ height:"100%", width:`${_pct}%`, borderRadius:4, background:"linear-gradient(90deg,#16a34a,#22c55e)", boxShadow:"0 0 8px #22c55e", transition:"width 0.6s ease" }} />
        </div>
        {_etaStr && <div style={{ fontSize:10, color:"rgba(255,255,255,0.35)", fontFamily:"'Courier New',monospace", marginBottom:8, letterSpacing:0.5 }}>{_etaStr}</div>}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8, marginBottom:10 }}>
          <div style={{ background:"rgba(34,197,94,0.08)", borderRadius:8, padding:"6px 4px" }}>
            <div style={{ fontSize:18, fontWeight:800, color:"#22c55e", fontFamily:"'Courier New',monospace" }}>{_created.toLocaleString()}</div>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.4)", letterSpacing:1, textTransform:"uppercase" }}>Created</div>
          </div>
          <div style={{ background:"rgba(239,68,68,0.08)", borderRadius:8, padding:"6px 4px" }}>
            <div style={{ fontSize:18, fontWeight:800, color:"#ef4444", fontFamily:"'Courier New',monospace" }}>{_errors.toLocaleString()}</div>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.4)", letterSpacing:1, textTransform:"uppercase" }}>Failed</div>
          </div>
          <div style={{ background:"rgba(251,191,36,0.08)", borderRadius:8, padding:"6px 4px" }}>
            <div style={{ fontSize:18, fontWeight:800, color:"#fbbf24", fontFamily:"'Courier New',monospace" }}>{_skipped.toLocaleString()}</div>
            <div style={{ fontSize:9, color:"rgba(255,255,255,0.4)", letterSpacing:1, textTransform:"uppercase" }}>Skipped</div>
          </div>
        </div>
        {_apiCalls && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginBottom:8 }}>
            <div style={{ background: _apiCalls.batch > 0 ? "rgba(34,197,94,0.12)" : "rgba(255,255,255,0.04)", border: _apiCalls.batch > 0 ? "1px solid #22c55e44" : "1px solid transparent", borderRadius:7, padding:"5px 4px" }}>
              <div style={{ fontSize:14, fontWeight:800, color: _apiCalls.batch > 0 ? "#22c55e" : "rgba(255,255,255,0.25)", fontFamily:"'Courier New',monospace" }}>{_apiCalls.batch}</div>
              <div style={{ fontSize:8, color:"rgba(255,255,255,0.35)", letterSpacing:1, textTransform:"uppercase" }}>Batch calls ✓</div>
            </div>
            <div style={{ background: _apiCalls.fallback > 0 ? "rgba(239,68,68,0.12)" : "rgba(255,255,255,0.04)", border: _apiCalls.fallback > 0 ? "1px solid #ef444444" : "1px solid transparent", borderRadius:7, padding:"5px 4px" }}>
              <div style={{ fontSize:14, fontWeight:800, color: _apiCalls.fallback > 0 ? "#ef4444" : "rgba(255,255,255,0.25)", fontFamily:"'Courier New',monospace" }}>{_apiCalls.fallback}</div>
              <div style={{ fontSize:8, color:"rgba(255,255,255,0.35)", letterSpacing:1, textTransform:"uppercase" }}>Fallback calls ⚠</div>
            </div>
          </div>
        )}
        {_currentRef && <div style={{ fontSize:10, color:"rgba(255,255,255,0.3)", fontFamily:"'Courier New',monospace", marginBottom:4, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>Current: {_currentRef}</div>}
        {_lastErr && <div style={{ fontSize:10, color:"#ef4444", fontFamily:"'Courier New',monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", opacity:0.7 }} title={_lastErr.message}>Last error: {_lastErr.message}</div>}
        {_prog.rateLimited?.active && (
          <div style={{ marginTop:8, padding:"8px 12px", borderRadius:8, background:"rgba(251,191,36,0.1)", border:"1px solid rgba(251,191,36,0.4)", textAlign:"center" }}>
            <div style={{ fontSize:12, color:"#fbbf24", fontWeight:700, fontFamily:"'Courier New',monospace" }}>⏸ Xero rate limit — auto-pausing</div>
            <div style={{ fontSize:10, color:"rgba(255,255,255,0.4)", marginTop:3 }}>Resuming in ~{_prog.rateLimited.remainingSecs}s ({_prog.rateLimited.reason || "minute"} limit)</div>
          </div>
        )}
      </div>
    </div>
  );
})()}
{undoingHistoryId && (
  <VoidLoader
    message={undoProgress ? `Voiding ${undoProgress.done} of ${undoProgress.total}...` : "Starting..."}
    processed={undoProgress?.done || 0}
    total={undoProgress?.total || 0}
    failed={undoProgress?.failed || 0}
  />
)}
{hintStep != null && hintRect && (() => {
  const STEPS = [
    { id:"connect-btn",           title:"Connect to Xero",       desc:"Click here to link your Xero account. You'll be redirected to Xero to authorise — takes just a moment.", color:"#38bdf8" },
    { id:"org-select",            title:"Select Organisation",    desc:"Choose which Xero company to import into. If you have multiple orgs they all appear here.", color:"#a78bfa" },
    { id:"type-picker-btn",       title:"Choose Import Type",     desc:"Pick what you want to import — Invoices, Bills, Contacts, Journals, and 20+ more types.", color:"#2dd4bf" },
    { id:"guide-btn",             title:"Read the Import Guide",  desc:"Click 'Guide' to open the full import guide — required columns, common mistakes to avoid, and pro tips for this import type.", color:"#c4b5fd" },
    { id:"download-template-btn", title:"Download Template",      desc:"Get the pre-formatted CSV template. Open it in any spreadsheet app, fill in your data, then save as CSV before uploading. Don't change the column headers.", color:"#f59e0b" },
    { id:"upload-zone",           title:"Upload & Import",        desc:"Drag-and-drop your filled CSV here, or click to browse. The tool validates your data then sends it to Xero.", color:"#22c55e" },
  ];
  const s = STEPS[hintStep];
  if (!s) return null;
  const PAD = 10;
  const { top, left, width, height } = hintRect;
  const spaceBelow = window.innerHeight - top - height;
  const isBottom = spaceBelow > 220;
  const tipTopRaw = isBottom ? top + height + PAD + 12 : top - PAD - 180;
  const tipTop = Math.max(12, Math.min(tipTopRaw, window.innerHeight - 200));
  const tipLeft = Math.max(12, Math.min(left, window.innerWidth - 312));
  const arrowLeft = Math.max(20, left + width / 2 - tipLeft - 8);
  return (
    <>
      <div style={{position:"fixed",top:top-PAD,left:left-PAD,width:width+PAD*2,height:height+PAD*2,borderRadius:10,boxShadow:`0 0 0 9999px rgba(0,0,0,0.68)`,zIndex:99999,pointerEvents:"none",border:`2px solid ${s.color}`,boxSizing:"border-box",transition:"top 0.3s cubic-bezier(0.4,0,0.2,1),left 0.3s cubic-bezier(0.4,0,0.2,1),width 0.3s cubic-bezier(0.4,0,0.2,1),height 0.3s cubic-bezier(0.4,0,0.2,1)"}} />
      <div style={{position:"fixed",top:tipTop,left:tipLeft,zIndex:100000,background:"var(--panel)",border:`1.5px solid ${s.color}`,borderRadius:14,padding:"18px 20px 16px",width:296,boxShadow:"var(--shadow)",pointerEvents:"all"}}>
        {isBottom && <div style={{position:"absolute",top:-9,left:Math.max(20,Math.min(arrowLeft,268)),width:16,height:9,overflow:"hidden",pointerEvents:"none"}}>
          <div style={{position:"absolute",bottom:0,left:0,width:14,height:14,background:"var(--panel)",border:`1.5px solid ${s.color}`,transform:"rotate(45deg)",transformOrigin:"bottom left",marginLeft:1}} />
        </div>}
        {!isBottom && <div style={{position:"absolute",bottom:-9,left:Math.max(20,Math.min(arrowLeft,268)),width:16,height:9,overflow:"hidden",pointerEvents:"none"}}>
          <div style={{position:"absolute",top:0,left:0,width:14,height:14,background:"var(--panel)",border:`1.5px solid ${s.color}`,transform:"rotate(45deg)",transformOrigin:"top left",marginLeft:1}} />
        </div>}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
          <span style={{fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:"0.09em",color:s.color,background:"rgba(0,0,0,0.08)",padding:"2px 9px",borderRadius:20,border:`1px solid ${s.color}55`}}>Step {hintStep+1} of {STEPS.length}</span>
          <button type="button" onClick={()=>{setHintStep(null);setHintRect(null);}} style={{width:22,height:22,borderRadius:"50%",border:"1px solid var(--border)",background:"var(--surface)",color:"var(--muted)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700}}>✕</button>
        </div>
        <div style={{fontSize:15,fontWeight:700,color:"var(--ink)",marginBottom:6,lineHeight:1.3}}>{s.title}</div>
        <div style={{fontSize:13,color:"var(--tooltip-muted)",lineHeight:1.6,marginBottom:14}}>{s.desc}</div>
        <div style={{display:"flex",gap:5,justifyContent:"center",marginBottom:14}}>
          {STEPS.map((_st,i) => <span key={i} style={{display:"inline-block",width:i===hintStep?16:6,height:6,borderRadius:3,background:i===hintStep?s.color:i<hintStep?"var(--muted-2)":"var(--border)",transition:"all 0.3s"}} />)}
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          {hintStep > 0 && <button type="button" onClick={()=>setHintStep(v=>v-1)} style={{fontSize:12,fontWeight:700,padding:"6px 14px",borderRadius:8,border:"1px solid var(--border)",background:"transparent",color:"var(--muted)",cursor:"pointer"}}>← Back</button>}
          {hintStep < STEPS.length-1
            ? <button type="button" onClick={()=>setHintStep(v=>v+1)} style={{fontSize:12,fontWeight:800,padding:"6px 18px",borderRadius:8,border:"none",background:s.color,color:"#fff",cursor:"pointer"}} onMouseEnter={e=>e.currentTarget.style.opacity="0.86"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>Next →</button>
            : <button type="button" onClick={()=>{localStorage.setItem("kk_hintDone","1");setHintStep(null);setHintRect(null);}} style={{fontSize:12,fontWeight:700,padding:"6px 18px",borderRadius:8,border:"none",background:"#22c55e",color:"#fff",cursor:"pointer"}}>Done ✓</button>
          }
        </div>
      </div>
    </>
  );
})()}
{guideOpen && (
  <div style={{position:"fixed",inset:0,zIndex:100003,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px 16px"}} onClick={e=>{if(e.target===e.currentTarget)setGuideOpen(false);}}>
    <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.6)",backdropFilter:"blur(4px)"}} onClick={()=>setGuideOpen(false)} />
    <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:720,maxHeight:"88vh",background:"var(--panel)",border:"1.5px solid rgba(139,92,246,0.25)",borderRadius:16,display:"flex",flexDirection:"column",boxShadow:"var(--shadow)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"18px 24px 16px",borderBottom:"1px solid var(--border)",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:38,height:38,borderRadius:10,background:"rgba(139,92,246,0.1)",border:"1.5px solid rgba(139,92,246,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>📖</div>
          <div>
            <div style={{fontSize:16,fontWeight:800,color:"var(--ink)",letterSpacing:"-0.01em"}}>Import Guide</div>
            <div style={{fontSize:12,color:"var(--muted)",marginTop:2,fontWeight:600}}>{activeType?.label||"Purchase Bills"} — Required columns, rules & tips</div>
          </div>
        </div>
        <button type="button" onClick={()=>setGuideOpen(false)} style={{width:32,height:32,borderRadius:8,border:"1px solid var(--border)",background:"var(--surface)",color:"var(--muted)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,fontWeight:700,flexShrink:0,transition:"all 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.background="var(--surface2)";e.currentTarget.style.color="var(--ink)";}} onMouseLeave={e=>{e.currentTarget.style.background="var(--surface)";e.currentTarget.style.color="var(--muted)";}}>✕</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
        <ImportGuide importType={selectedImportType||"bills"} rowCount={active?.rows?.length||0} errorCount={active?.errors?.length||0} isLoading={!!active?.loading} hasFile={!!active?.file} />
      </div>
    </div>
  </div>
)}
<CookieConsent onNavigate={navigate} /></>;
  }
  if (isImportHistoryPage) {
    const typeLabel = { bills: "Purchase Bills", invoices: "Sales Invoices", "credit-notes": "Credit Notes", "spend-money": "Spend Money", "receive-money": "Receive Money", "bill-payments": "Bill Payments", "invoice-payments": "Invoice Payments", "credit-note-refunds": "Credit Note Refunds", "manual-journals": "Manual Journals", accounts: "Chart of Accounts", items: "Inventory Items", customers: "Customers", vendors: "Vendors", "tracking-categories": "Tracking Categories", "purchase-orders": "Purchase Orders", "quotes": "Quotes / Estimates", "update-status": "Bulk Status Update" };
    return (
      <div style={{ minHeight: "100vh", background: "var(--bg)", padding: "32px 24px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
            <button className="btn ghost btn-compact" type="button" onClick={() => navigate("/import")}>← Back to Import</button>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Import History</h1>
            <button className="btn ghost btn-compact" type="button" onClick={loadImportHistory} disabled={importHistoryLoading}>{importHistoryLoading ? "Loading..." : "Refresh"}</button>
            <button className="btn ghost btn-compact" type="button" onClick={handleExportHistoryCSV} style={{ fontSize: 12, color: "#22c55e", borderColor: "#22c55e" }}>⬇ Export CSV</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              placeholder="Search by type, org, user, note…"
              value={historySearch}
              onChange={e => { setHistorySearch(e.target.value); loadImportHistory(1, { search: e.target.value }); }}
              style={{ flex: "1 1 200px", padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 13 }}
            />
            <select value={historyTypeFilter} onChange={e => { setHistoryTypeFilter(e.target.value); loadImportHistory(1, { typeFilter: e.target.value }); }} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 13 }}>
              <option value="">All types</option>
              {Object.entries(typeLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={historyStatusFilter} onChange={e => { setHistoryStatusFilter(e.target.value); loadImportHistory(1, { statusFilter: e.target.value }); }} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", fontSize: 13 }}>
              <option value="">All statuses</option>
              <option value="completed">Completed</option>
              <option value="completed_with_errors">With Errors</option>
              <option value="interrupted">Interrupted</option>
            </select>
            {(historySearch || historyTypeFilter || historyStatusFilter) && (
              <button className="btn ghost btn-compact" onClick={() => { setHistorySearch(""); setHistoryTypeFilter(""); setHistoryStatusFilter(""); loadImportHistory(1, { search: "", typeFilter: "", statusFilter: "" }); }} style={{ fontSize: 12 }}>Clear filters</button>
            )}
          </div>
          {importHistory.length === 0 ? (
            <div style={{ textAlign: "center", color: "var(--muted)", padding: 48 }}>
              {importHistoryLoading ? "Loading history..." : "No import history yet. Import data to see records here."}
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 8 }}>Showing {importHistory.length} of {historyTotal} records</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--surface-alt, #f5f5f5)", borderBottom: "2px solid var(--border)" }}>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>Date</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>Type</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>Organisation</th>
                    <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600 }}>Total</th>
                    <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "var(--accent-3)" }}>Created</th>
                    <th style={{ padding: "10px 12px", textAlign: "right", fontWeight: 600, color: "#e53e3e" }}>Errors</th>
                    <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600 }}>Status</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600 }}>User</th>
                    <th style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: "var(--muted)" }}>Note</th>
                    <th style={{ padding: "10px 12px", textAlign: "center", fontWeight: 600 }}>Undo</th>
                  </tr>
                </thead>
                <tbody>
                  {importHistory.map((h, i) => {
                    const undoableTypes = ["bills", "invoices", "credit-notes", "spend-money", "receive-money", "bill-payments", "invoice-payments", "credit-note-refunds", "manual-journals", "purchase-orders", "quotes"];
                    const canUndo = !h.undone && h.created > 0 && undoableTypes.includes(h.importType) && Array.isArray(h.createdIds) && h.createdIds.length > 0;
                    const isUndoing = undoingHistoryId === h.id;
                    return (
                      <tr key={h.id || i} style={{ borderBottom: "1px solid var(--border)", background: i % 2 === 0 ? "transparent" : "var(--surface-alt, #fafafa)" }}>
                        <td style={{ padding: "9px 12px", color: "var(--muted)" }}>{h.date ? new Date(h.date).toLocaleString() : "—"}</td>
                        <td style={{ padding: "9px 12px", fontWeight: 500 }}>{typeLabel[h.importType] || h.importType || "—"}</td>
                        <td style={{ padding: "9px 12px", color: "var(--muted)" }}>{h.orgName || h.tenantId || "—"}</td>
                        <td style={{ padding: "9px 12px", textAlign: "right" }}>{(h.total || 0).toLocaleString()}</td>
                        <td style={{ padding: "9px 12px", textAlign: "right", color: "var(--accent-3)", fontWeight: 600 }}>{(h.created || 0).toLocaleString()}</td>
                        <td style={{ padding: "9px 12px", textAlign: "right", color: (h.errors || 0) > 0 ? "#e53e3e" : "var(--muted-2)", fontWeight: 600 }}>{(h.errors || 0).toLocaleString()}</td>
                        <td style={{ padding: "9px 12px", textAlign: "center" }}>
                          <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: h.status === "completed" ? "#dcfce7" : h.status === "completed_with_errors" ? "#fef9c3" : "#fee2e2", color: h.status === "completed" ? "#166534" : h.status === "completed_with_errors" ? "#713f12" : "#991b1b" }}>{h.status || "—"}</span>
                        </td>
                        <td style={{ padding: "9px 12px", color: "var(--muted)", fontSize: 12 }}>{h.userEmail || "—"}</td>
                        <td style={{ padding: "9px 12px", fontSize: 12, color: "var(--muted)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={h.note || ""}>{h.note || <span style={{opacity:0.3}}>—</span>}</td>
                        <td style={{ padding: "9px 12px", textAlign: "center", minWidth: 140 }}>
                          {h.undone
                            ? <span style={{ fontSize: 11, color: "var(--muted)", opacity: 0.5 }}>Undone</span>
                            : isUndoing && undoProgress
                              ? (
                                <div style={{ minWidth: 130 }}>
                                  <div style={{ fontSize: 11, color: "#e53e3e", fontWeight: 600, marginBottom: 3 }}>
                                    {undoProgress.finished ? "Done!" : `Voiding… ${undoProgress.done}/${undoProgress.total}`}
                                  </div>
                                  <div style={{ height: 5, background: "var(--surface2, #eee)", borderRadius: 4, overflow: "hidden" }}>
                                    <div style={{ height: "100%", width: `${undoProgress.total > 0 ? Math.round((undoProgress.done / undoProgress.total) * 100) : 0}%`, background: undoProgress.finished ? "#22c55e" : "#e53e3e", borderRadius: 4, transition: "width 0.4s ease" }} />
                                  </div>
                                  {undoProgress.failed > 0 && <div style={{ fontSize: 10, color: "#f59e0b", marginTop: 2 }}>{undoProgress.failed} failed</div>}
                                  {undoProgress.lastErrors && undoProgress.lastErrors.length > 0 && (
                                    <div style={{ fontSize: 9, color: "#ef4444", marginTop: 3, maxHeight: 50, overflow: "auto", textAlign: "left" }}>
                                      {undoProgress.lastErrors.slice(0, 3).map((e, i) => <div key={i}>{e}</div>)}
                                    </div>
                                  )}
                                </div>
                              )
                            : canUndo
                              ? <button className="btn ghost" type="button" style={{ fontSize: 11, padding: "3px 10px", borderColor: "#e53e3e", color: "#e53e3e" }} onClick={() => handleUndoHistoryEntry(h)} disabled={isUndoing || !!undoingHistoryId}>{isUndoing ? "Undoing…" : "Undo"}</button>
                              : <span style={{ fontSize: 11, color: "var(--muted)", opacity: 0.35 }}>—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {historyTotal > 20 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
                  <button className="btn ghost btn-compact" disabled={historyPage <= 1 || importHistoryLoading} onClick={() => loadImportHistory(historyPage - 1)}>← Previous</button>
                  <span style={{ fontSize: 13, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>Page {historyPage} of {Math.ceil(historyTotal / 20)} · {historyTotal.toLocaleString()} total</span>
                  <button className="btn ghost btn-compact" disabled={historyPage >= Math.ceil(historyTotal / 20) || importHistoryLoading} onClick={() => loadImportHistory(historyPage + 1)}>Next →</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (isDashboardPage) {
    if (!userToken) { navigate("/"); return null; }
    return (
      <Dashboard
        userToken={userToken}
        onBack={() => navigate("/import")}
        onNavigateImport={() => navigate("/import")}
      />
    );
  }
  if (isAutoAllocationPage) {
    if (!hasPermission("allocation")) return (
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",background:"var(--bg)"}}>
        <div style={{textAlign:"center",padding:40,borderRadius:12,border:"1px solid rgba(239,68,68,0.3)",background:"rgba(239,68,68,0.06)",maxWidth:380}}>
          <div style={{fontSize:32,marginBottom:12}}>🔒</div>
          <div style={{fontWeight:700,fontSize:16,marginBottom:8,color:"#ef4444"}}>Access Restricted</div>
          <div style={{fontSize:13,color:"var(--muted)",marginBottom:20}}>You don't have permission to use Auto Allocation. Contact your admin.</div>
          <button className="btn ghost" onClick={() => navigate("/import")} style={{fontSize:13}}>← Back to Import</button>
        </div>
      </div>
    );
    return (
      <AutoAllocation
        userToken={userToken}
        tenantId={selectedTenant}
        sessionId={sessionId}
        onBack={() => navigate("/import")}
      />
    );
  }
  if (isGuidePage) {
    const GUIDE_TYPES = [{
      id: "bills",
      label: "Purchase Bills",
      group: "Payables",
      desc: "Import supplier bills (ACCPAY) and bill credit notes (ACCPAYCREDIT) in one CSV. Type is auto-detected from the total amount sign — no separate Type column needed.",
      required: [{
        col: "Bill Number",
        rule: "Unique ID per bill/credit note. All rows with the same Bill Number become one document with multiple lines."
      }, {
        col: "Contact Name",
        rule: "Supplier/vendor name. Will be created in Xero if not found."
      }, {
        col: "Bill Date",
        rule: "Format: DD/MM/YYYY (e.g. 30/04/2025)"
      }, {
        col: "Account Code",
        rule: "Xero expense account code for this line (e.g. 6000)"
      }, {
        col: "Unit Amount",
        rule: "Amount per unit. Positive = normal bill (ACCPAY). Negative total for the group = Bill Credit Note (ACCPAYCREDIT) — same as the Invoices import."
      }],
      optional: [{
        col: "Due Date",
        rule: "Format: DD/MM/YYYY. Leave blank for no due date."
      }, {
        col: "Reference",
        rule: "Your internal reference/PO number."
      }, {
        col: "Currency Code",
        rule: "3-letter ISO code: USD, EUR, GBP. Leave blank = org default."
      }, {
        col: "Exchange Rate",
        rule: "Required only for foreign currency bills."
      }, {
        col: "Quantity",
        rule: "Number of units. Default is 1 if blank."
      }, {
        col: "Line Description",
        rule: "Description text for this line item."
      }, {
        col: "Tax Type",
        rule: "Exact Xero tax type name e.g. 'No VAT', 'Tax Exempt'. Blank = account default."
      }, {
        col: "Tax Amount",
        rule: "Leave blank — Xero calculates automatically."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "First tracking category name and its option value."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Second tracking category name and its option value."
      }, {
        col: "Status",
        rule: "DRAFT or AUTHORISED. Default: DRAFT."
      }],
      rules: ["Same Bill Number = one document in Xero with multiple line items", "Auto-detect: sum of (Quantity × Unit Amount) across all lines of that Bill Number — negative total = Bill Credit Note, positive/zero = normal Bill", "Date format must be DD/MM/YYYY — other formats will fail", "If a bill with that number already exists in Xero, it will be skipped", "Status: DRAFT or AUTHORISED (blank defaults to DRAFT)", "For foreign currency: fill Currency Code and Exchange Rate"],
      mistakes: ["Wrong date format: use DD/MM/YYYY not YYYY-MM-DD", "Different Bill Numbers for same bill → creates multiple separate bills", "Wrong Tax Type name → use exact names from your Xero settings", "Mixing positive and negative lines under the same Bill Number when you only want a plain bill — check the group total, not just one line"],
      example: [{
        "Bill Number": "INV-001",
        "Contact Name": "Office Supplies Ltd",
        "Bill Date": "30/04/2025",
        "Due Date": "30/05/2025",
        "Account Code": "6000",
        "Unit Amount": "500.00",
        "Line Description": "Office supplies"
      }, {
        "Bill Number": "INV-001",
        "Contact Name": "Office Supplies Ltd",
        "Bill Date": "30/04/2025",
        "Due Date": "30/05/2025",
        "Account Code": "6001",
        "Unit Amount": "200.00",
        "Line Description": "Postage & courier"
      }, {
        "Bill Number": "CN-001",
        "Contact Name": "Office Supplies Ltd",
        "Bill Date": "30/04/2025",
        "Account Code": "6000",
        "Unit Amount": "-500.00",
        "Line Description": "Returned goods (becomes a Bill Credit Note)"
      }],
      onDownload: downloadBillsCsvTemplate
    }, {
      id: "bill-payments",
      label: "Bill Payments",
      group: "Payables",
      desc: "Apply payments against existing supplier bills in Xero. Each row = one payment.",
      required: [{
        col: "Invoice Number",
        rule: "The Bill Number of an existing bill in Xero."
      }, {
        col: "Bank Account Code",
        rule: "Xero bank account code the payment comes from (e.g. 1200)."
      }, {
        col: "Date",
        rule: "Payment date. Format: DD/MM/YYYY"
      }, {
        col: "Amount",
        rule: "Payment amount. Must be positive. Cannot exceed bill amount."
      }],
      optional: [{
        col: "Reference",
        rule: "Payment reference or cheque number."
      }, {
        col: "Currency Rate",
        rule: "Exchange rate for foreign currency payments."
      }],
      rules: ["The bill must already exist in Xero before importing payments", "Invoice Number here refers to the Bill Number in Xero", "Amount cannot exceed the outstanding balance of the bill", "One row = one payment (no grouping)", "Date format: DD/MM/YYYY"],
      mistakes: ["Using a bill number that doesn't exist in Xero", "Amount larger than the bill's remaining balance", "Wrong Bank Account Code → use Xero account code, not account name"],
      example: [{
        "Invoice Number": "INV-001",
        "Bank Account Code": "1200",
        "Date": "05/05/2025",
        "Amount": "700.00",
        "Reference": "PAY-001"
      }, {
        "Invoice Number": "INV-002",
        "Bank Account Code": "1200",
        "Date": "06/05/2025",
        "Amount": "1200.00"
      }],
      onDownload: downloadBillPaymentTemplate
    }, {
      id: "invoices",
      label: "Sales Invoices & Credit Notes",
      group: "Receivables",
      desc: "Import customer invoices and credit notes in one CSV. Use the Type column to distinguish.",
      required: [{
        col: "Invoice Number / Credit Note Number",
        rule: "Unique ID. Same number = multiple lines in one document."
      }, {
        col: "Contact Name",
        rule: "Customer name. Created in Xero if not found."
      }, {
        col: "Invoice Date / Credit Note Date",
        rule: "Document date. Format: DD/MM/YYYY"
      }, {
        col: "Account Code",
        rule: "Revenue account code for this line."
      }, {
        col: "Unit Amount",
        rule: "Amount per unit. Positive for invoices, negative for credit notes."
      }, {
        col: "Type",
        rule: "Must be 'Invoice' or 'Credit Note' per row."
      }],
      optional: [{
        col: "Due Date",
        rule: "Format: DD/MM/YYYY."
      }, {
        col: "Reference",
        rule: "Internal reference."
      }, {
        col: "Currency Code",
        rule: "3-letter ISO e.g. USD, EUR."
      }, {
        col: "Exchange Rate",
        rule: "For foreign currency documents."
      }, {
        col: "Quantity",
        rule: "Default 1 if blank."
      }, {
        col: "Line Description",
        rule: "Line item description."
      }, {
        col: "Tax Type",
        rule: "Exact Xero tax type name."
      }, {
        col: "Tax Amount",
        rule: "Leave blank — Xero calculates."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "First tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Second tracking category."
      }, {
        col: "Status",
        rule: "DRAFT or AUTHORISED. Default: DRAFT."
      }],
      rules: ["Type column must say 'Invoice' or 'Credit Note' on every row", "Same Invoice Number = one invoice with multiple lines", "Same Credit Note Number = one credit note with multiple lines", "Date format: DD/MM/YYYY", "For credit notes: negative amount = credit to customer, positive = charge within credit note"],
      mistakes: ["Missing Type column or wrong value (must be exactly 'Invoice' or 'Credit Note')", "Mixing invoice and credit note rows with same number", "Wrong date format"],
      example: [{
        "Invoice Number": "SI-001",
        "Contact Name": "Customer Ltd",
        "Invoice Date": "30/04/2025",
        "Type": "Invoice",
        "Account Code": "4000",
        "Unit Amount": "1000.00",
        "Line Description": "Consulting services"
      }, {
        "Invoice Number": "SI-001",
        "Contact Name": "Customer Ltd",
        "Invoice Date": "30/04/2025",
        "Type": "Invoice",
        "Account Code": "4001",
        "Unit Amount": "250.00",
        "Line Description": "Travel expenses"
      }, {
        "Invoice Number": "CN-001",
        "Contact Name": "Customer Ltd",
        "Credit Note Date": "30/04/2025",
        "Type": "Credit Note",
        "Account Code": "4000",
        "Unit Amount": "-500.00",
        "Line Description": "Partial refund"
      }],
      onDownload: downloadInvoicesCsvTemplate
    }, {
      id: "invoice-payments",
      label: "Invoice Payments",
      group: "Receivables",
      desc: "Apply received payments against existing customer invoices in Xero. Each row = one payment.",
      required: [{
        col: "Invoice Number",
        rule: "The invoice number of an existing invoice in Xero."
      }, {
        col: "Bank Account Code",
        rule: "Xero bank account code receiving the payment."
      }, {
        col: "Date",
        rule: "Receipt date. Format: DD/MM/YYYY"
      }, {
        col: "Amount",
        rule: "Payment amount. Must be positive."
      }],
      optional: [{
        col: "Reference",
        rule: "Payment reference."
      }, {
        col: "Currency Rate",
        rule: "Exchange rate for foreign currency."
      }],
      rules: ["The invoice must already exist in Xero", "One row = one payment", "Amount cannot exceed invoice outstanding balance", "Date format: DD/MM/YYYY"],
      mistakes: ["Invoice number that doesn't exist in Xero", "Amount larger than remaining invoice balance"],
      example: [{
        "Invoice Number": "SI-001",
        "Bank Account Code": "1200",
        "Date": "05/05/2025",
        "Amount": "1250.00",
        "Reference": "REC-001"
      }],
      onDownload: downloadInvoicePaymentTemplate
    }, {
      id: "credit-note-refunds",
      label: "Credit Note Refunds",
      group: "Receivables",
      desc: "Refund a credit note back to the customer. Each row = one refund.",
      required: [{
        col: "Credit Note Number",
        rule: "The credit note number of an existing credit note in Xero."
      }, {
        col: "Bank Account Code",
        rule: "Xero bank account code from which the refund is paid."
      }, {
        col: "Date",
        rule: "Refund date. Format: DD/MM/YYYY"
      }, {
        col: "Amount",
        rule: "Refund amount. Must be positive and not exceed the credit note remaining balance."
      }],
      optional: [{
        col: "Reference",
        rule: "Refund reference (e.g. bank transaction ref)."
      }, {
        col: "Currency Rate",
        rule: "Exchange rate for foreign currency credit notes."
      }],
      rules: ["The credit note must already exist in Xero", "One row = one refund", "Amount cannot exceed credit note remaining balance", "Date format: DD/MM/YYYY"],
      mistakes: ["Credit Note Number that doesn't exist in Xero", "Amount larger than remaining credit note balance"],
      example: [{
        "Credit Note Number": "CN-001",
        "Bank Account Code": "1200",
        "Date": "05/05/2025",
        "Amount": "500.00",
        "Reference": "REFUND-001"
      }],
      onDownload: downloadCreditNoteRefundTemplate
    }, {
      id: "accounts",
      label: "Chart of Accounts",
      group: "Accounts",
      desc: "Import your chart of accounts. Each row = one account.",
      required: [{
        col: "Code",
        rule: "Unique account code (e.g. 4000, 6001). Must be unique in Xero."
      }, {
        col: "Name",
        rule: "Account name."
      }, {
        col: "Type",
        rule: "Xero account type: REVENUE, EXPENSE, ASSET, LIABILITY, EQUITY, BANK, etc."
      }],
      optional: [{
        col: "Bank Account Number",
        rule: "BSB/Account number for bank accounts."
      }, {
        col: "Bank Account Type",
        rule: "For bank accounts: BANK, CREDITCARD, PAYPAL."
      }, {
        col: "Description",
        rule: "Account description."
      }, {
        col: "Tax",
        rule: "Default tax type for this account."
      }, {
        col: "Show On Dashboard",
        rule: "TRUE or FALSE. Show account on Xero dashboard."
      }, {
        col: "Enable Payments To Account",
        rule: "TRUE or FALSE. Allow payments to this account."
      }, {
        col: "Currency Code",
        rule: "3-letter ISO. Only for accounts in foreign currency."
      }],
      rules: ["Account Code must be unique — duplicates will be skipped", "Type must be a valid Xero account type in ALL CAPS", "Max 500 accounts per import", "Bank accounts need Type=BANK and bank account number"],
      mistakes: ["Wrong Type value → use REVENUE, EXPENSE, ASSET, LIABILITY, EQUITY, BANK exactly", "Duplicate account codes → only first will be imported"],
      example: [{
        "Code": "4000",
        "Name": "Sales Revenue",
        "Type": "REVENUE",
        "Tax": "Tax on Sales"
      }, {
        "Code": "6000",
        "Name": "Office Expenses",
        "Type": "EXPENSE",
        "Tax": "Tax on Purchases"
      }, {
        "Code": "1200",
        "Name": "Main Bank Account",
        "Type": "BANK",
        "Bank Account Number": "12345678"
      }],
      onDownload: downloadAccountsCsvTemplate
    }, {
      id: "items",
      label: "Items / Products",
      group: "Inventory",
      desc: "Import products and services into Xero inventory. Each row = one item.",
      required: [{
        col: "Code",
        rule: "Unique item/product code."
      }, {
        col: "Name",
        rule: "Item name."
      }],
      optional: [{
        col: "Description",
        rule: "Sales description."
      }, {
        col: "Purchase Description",
        rule: "Purchase description."
      }, {
        col: "Is Sold",
        rule: "TRUE or FALSE. Mark item as sold to customers."
      }, {
        col: "Is Purchased",
        rule: "TRUE or FALSE. Mark item as purchased from suppliers."
      }, {
        col: "Sales Unit Price",
        rule: "Default selling price."
      }, {
        col: "Sales Account Code",
        rule: "Revenue account code for sales."
      }, {
        col: "Sales Tax Type",
        rule: "Tax type for sales."
      }, {
        col: "Purchase Unit Price",
        rule: "Default purchase price."
      }, {
        col: "Purchase Account Code",
        rule: "Expense account code for purchases."
      }, {
        col: "Purchase Tax Type",
        rule: "Tax type for purchases."
      }, {
        col: "COGS Account Code",
        rule: "Cost of goods sold account."
      }],
      rules: ["Item Code must be unique", "Max 50000 items per import", "Set Is Sold=TRUE for items sold to customers; Is Purchased=TRUE for items bought from suppliers"],
      mistakes: ["Duplicate item codes", "Missing Sales Account Code when Is Sold=TRUE"],
      example: [{
        "Code": "ITEM001",
        "Name": "Consulting Service",
        "Is Sold": "TRUE",
        "Sales Unit Price": "150.00",
        "Sales Account Code": "4000",
        "Sales Tax Type": "Tax on Sales"
      }, {
        "Code": "ITEM002",
        "Name": "Office Chair",
        "Is Sold": "FALSE",
        "Is Purchased": "TRUE",
        "Purchase Unit Price": "299.00",
        "Purchase Account Code": "6000"
      }],
      onDownload: downloadItemsCsvTemplate
    }, {
      id: "customers",
      label: "Customers",
      group: "Contacts",
      desc: "Import customer contacts into Xero. Each row = one customer.",
      required: [{
        col: "Name",
        rule: "Contact/company name. Must be unique — duplicates will be updated."
      }],
      optional: [{
        col: "First Name",
        rule: "First name (for individual contacts)."
      }, {
        col: "Last Name",
        rule: "Last name."
      }, {
        col: "Email Address",
        rule: "Contact email."
      }, {
        col: "Account Number",
        rule: "Your internal customer account number."
      }, {
        col: "Tax Number",
        rule: "VAT/GST/Tax registration number."
      }, {
        col: "Website",
        rule: "Website URL."
      }, {
        col: "Phone",
        rule: "Phone number."
      }, {
        col: "Address Line 1",
        rule: "Street address."
      }, {
        col: "Address Line 2",
        rule: "Address line 2."
      }, {
        col: "City",
        rule: "City/town."
      }, {
        col: "Region",
        rule: "State/county/region."
      }, {
        col: "Postal Code",
        rule: "Postcode/zip."
      }, {
        col: "Country",
        rule: "Country name."
      }],
      rules: ["Name is the only required field", "Max 1000 customers per import", "If a contact with the same Name exists, it will be updated", "Email must be valid format if provided"],
      mistakes: ["Duplicate names — same-named customers get merged/updated", "Invalid email format"],
      example: [{
        "Name": "Acme Corporation",
        "Email Address": "billing@acme.com",
        "Phone": "+44 20 1234 5678",
        "City": "London",
        "Country": "United Kingdom"
      }, {
        "Name": "John Smith",
        "First Name": "John",
        "Last Name": "Smith",
        "Email Address": "john@example.com"
      }],
      onDownload: downloadCustomersCsvTemplate
    }, {
      id: "vendors",
      label: "Vendors / Suppliers",
      group: "Contacts",
      desc: "Import supplier/vendor contacts into Xero. Each row = one vendor.",
      required: [{
        col: "Name",
        rule: "Supplier/company name."
      }],
      optional: [{
        col: "First Name",
        rule: "First name."
      }, {
        col: "Last Name",
        rule: "Last name."
      }, {
        col: "Email Address",
        rule: "Supplier email."
      }, {
        col: "Account Number",
        rule: "Internal account number."
      }, {
        col: "Tax Number",
        rule: "VAT/GST/Tax number."
      }, {
        col: "Website",
        rule: "Website URL."
      }, {
        col: "Phone",
        rule: "Phone number."
      }, {
        col: "Address Line 1",
        rule: "Street address."
      }, {
        col: "Address Line 2",
        rule: "Address line 2."
      }, {
        col: "City",
        rule: "City."
      }, {
        col: "Region",
        rule: "State/region."
      }, {
        col: "Postal Code",
        rule: "Postcode."
      }, {
        col: "Country",
        rule: "Country name."
      }],
      rules: ["Name is the only required field", "Max 1000 vendors per import", "Same Name = contact gets updated if already exists"],
      mistakes: ["Duplicate vendor names", "Invalid email format"],
      example: [{
        "Name": "Global Supplies Ltd",
        "Email Address": "orders@globalsupplies.com",
        "Phone": "+1 555 1234",
        "City": "New York",
        "Country": "United States"
      }],
      onDownload: downloadVendorsCsvTemplate
    }, {
      id: "tracking-categories",
      label: "Tracking Categories",
      group: "Settings",
      desc: "Import tracking category options (e.g. Class, Department). Each row = one option under a category.",
      required: [{
        col: "Category Name",
        rule: "The tracking category name e.g. 'Class', 'Department'. Must already exist in Xero."
      }, {
        col: "Option Name",
        rule: "Full option name e.g. 'C00100-Supply chain and procurement'. Hyphens and spaces are allowed."
      }],
      optional: [{
        col: "Status",
        rule: "ACTIVE or ARCHIVED. Default: ACTIVE."
      }],
      rules: ["The Category (e.g. 'Class') must already exist in Xero — create it manually first", "Option Name is imported exactly as written — include the full name with code and description", "Format 'C00100-Supply chain and procurement' imports the entire string as the option name", "Max 2000 rows per import", "Duplicate options in same category will be skipped"],
      mistakes: ["Category doesn't exist in Xero → option import will fail", "Truncating option name — full name 'C00100-Supply chain and procurement' must be in the cell", "Status value other than ACTIVE or ARCHIVED"],
      example: [{
        "Category Name": "Class",
        "Option Name": "C00100-Supply chain and procurement",
        "Status": "ACTIVE"
      }, {
        "Category Name": "Class",
        "Option Name": "C00200-Lysate Manufacturing",
        "Status": "ACTIVE"
      }, {
        "Category Name": "Department",
        "Option Name": "Finance",
        "Status": "ACTIVE"
      }],
      onDownload: downloadTrackingCatTemplate
    }, {
      id: "spend-money",
      label: "Spend Money",
      group: "Banking",
      desc: "Import Spend Money bank transactions. Rows with same Reference + Bank Account Code = one transaction with multiple lines.",
      required: [{
        col: "Bank Account Code",
        rule: "Xero bank account code (e.g. 1200, 1210)."
      }, {
        col: "Contact Name",
        rule: "Payee/vendor name."
      }, {
        col: "Date",
        rule: "Transaction date. Format: DD/MM/YYYY"
      }, {
        col: "Line Description",
        rule: "Description for this line item."
      }, {
        col: "Unit Amount",
        rule: "Amount for this line. Positive numbers."
      }, {
        col: "Account Code",
        rule: "Expense account code."
      }],
      optional: [{
        col: "Reference",
        rule: "Transaction reference. Rows with same Reference + Bank Account = one transaction."
      }, {
        col: "Currency Code",
        rule: "3-letter ISO e.g. USD, EUR."
      }, {
        col: "Exchange Rate",
        rule: "For foreign currency transactions."
      }, {
        col: "Quantity",
        rule: "Default 1."
      }, {
        col: "Tax Type",
        rule: "Exact Xero tax type name."
      }, {
        col: "Tax Amount",
        rule: "Leave blank — Xero calculates."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "First tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Second tracking category."
      }],
      rules: ["Same Reference + Same Bank Account Code = one Xero transaction with multiple line items", "If Reference already exists in that bank account in Xero, all rows with that reference are skipped", "Date format: DD/MM/YYYY", "All amounts must be positive (this is Spend Money — debit side)", "First row's Contact Name, Date, Currency, Exchange Rate apply to the whole transaction"],
      mistakes: ["Different Reference for rows that should be one transaction", "Negative amounts — Spend Money amounts must be positive", "Wrong Bank Account Code — must match Xero bank account code exactly"],
      example: [{
        "Bank Account Code": "1200",
        "Contact Name": "Office Ltd",
        "Date": "30/04/2025",
        "Reference": "REF001",
        "Line Description": "Stationery",
        "Unit Amount": "100.00",
        "Account Code": "6000"
      }, {
        "Bank Account Code": "1200",
        "Contact Name": "Office Ltd",
        "Date": "30/04/2025",
        "Reference": "REF001",
        "Line Description": "Printer cartridges",
        "Unit Amount": "50.00",
        "Account Code": "6000"
      }],
      onDownload: downloadSpendMoneyTemplate
    }, {
      id: "receive-money",
      label: "Receive Money",
      group: "Banking",
      desc: "Import Receive Money bank transactions. Rows with same Reference + Bank Account Code = one transaction with multiple lines.",
      required: [{
        col: "Bank Account Code",
        rule: "Xero bank account code receiving the money."
      }, {
        col: "Contact Name",
        rule: "Payer/customer name."
      }, {
        col: "Date",
        rule: "Transaction date. Format: DD/MM/YYYY"
      }, {
        col: "Line Description",
        rule: "Description for this line item."
      }, {
        col: "Unit Amount",
        rule: "Amount for this line. Positive numbers."
      }, {
        col: "Account Code",
        rule: "Revenue account code."
      }],
      optional: [{
        col: "Reference",
        rule: "Transaction reference. Same Reference + Bank Account = one transaction."
      }, {
        col: "Currency Code",
        rule: "3-letter ISO e.g. USD, EUR."
      }, {
        col: "Exchange Rate",
        rule: "For foreign currency."
      }, {
        col: "Quantity",
        rule: "Default 1."
      }, {
        col: "Tax Type",
        rule: "Exact Xero tax type name."
      }, {
        col: "Tax Amount",
        rule: "Leave blank."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "First tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Second tracking category."
      }],
      rules: ["Same Reference + Same Bank Account Code = one Xero transaction with multiple line items", "If Reference already exists in that bank account in Xero, all matching rows are skipped", "Date format: DD/MM/YYYY", "All amounts positive (this is Receive Money — credit side)", "First row's Contact Name, Date, Currency, Exchange Rate apply to whole transaction"],
      mistakes: ["Different Reference for rows that should be one transaction", "Negative amounts — Receive Money amounts must be positive", "Wrong Bank Account Code"],
      example: [{
        "Bank Account Code": "1246 Therapy paypal USD",
        "Contact Name": "No Name",
        "Date": "30/04/2025",
        "Reference": "21157",
        "Line Description": "Keltoum Elkhaier",
        "Unit Amount": "440.00",
        "Account Code": "2104"
      }, {
        "Bank Account Code": "1246 Therapy paypal USD",
        "Contact Name": "No Name",
        "Date": "30/04/2025",
        "Reference": "21157",
        "Line Description": "Faith Fix",
        "Unit Amount": "880.00",
        "Account Code": "2104"
      }],
      onDownload: downloadReceiveMoneyTemplate
    }, {
      id: "spend-op",
      label: "Spend Overpayment",
      group: "Banking",
      desc: "Import spend overpayments — when you paid a supplier more than the bill amount.",
      required: [{
        col: "Bank Account Code",
        rule: "Xero bank account code."
      }, {
        col: "Contact Name",
        rule: "Supplier name."
      }, {
        col: "Date",
        rule: "Date. Format: DD/MM/YYYY"
      }, {
        col: "Line Description",
        rule: "Line description."
      }, {
        col: "Unit Amount",
        rule: "Overpayment amount."
      }, {
        col: "Account Code",
        rule: "Account code."
      }],
      optional: [{
        col: "Reference",
        rule: "Reference. Same Reference + Bank Account = grouped as one overpayment."
      }, {
        col: "Currency Code",
        rule: "Currency code."
      }, {
        col: "Exchange Rate",
        rule: "Exchange rate."
      }, {
        col: "Tax Type",
        rule: "Tax type."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "Tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Tracking category."
      }],
      rules: ["Same columns as Spend Money template", "Creates an overpayment record (not a bill payment)", "Use Spend Allocation to link the overpayment to a bill later", "Same Reference + Bank Account = one overpayment with multiple lines"],
      mistakes: ["Confusing with Spend Money — overpayments are for excess payments to suppliers"],
      example: [{
        "Bank Account Code": "1200",
        "Contact Name": "Supplier Co",
        "Date": "30/04/2025",
        "Reference": "OVPAY001",
        "Line Description": "Overpayment",
        "Unit Amount": "500.00",
        "Account Code": "800"
      }],
      onDownload: downloadSpendOpTemplate
    }, {
      id: "receive-op",
      label: "Receive Overpayment",
      group: "Banking",
      desc: "Import receive overpayments — when a customer paid you more than the invoice amount.",
      required: [{
        col: "Bank Account Code",
        rule: "Xero bank account code."
      }, {
        col: "Contact Name",
        rule: "Customer name."
      }, {
        col: "Date",
        rule: "Date. Format: DD/MM/YYYY"
      }, {
        col: "Line Description",
        rule: "Description."
      }, {
        col: "Unit Amount",
        rule: "Overpayment amount."
      }, {
        col: "Account Code",
        rule: "Account code."
      }],
      optional: [{
        col: "Reference",
        rule: "Reference. Same Reference + Bank Account = one overpayment."
      }, {
        col: "Currency Code / Exchange Rate",
        rule: "For foreign currency."
      }, {
        col: "Tax Type",
        rule: "Tax type."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "Tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Tracking category."
      }],
      rules: ["Same columns as Receive Money template", "Creates an overpayment record in Xero", "Use Receive Allocation to apply the overpayment to an invoice later"],
      mistakes: ["Confusing with Receive Money — use this only for excess payments from customers"],
      example: [{
        "Bank Account Code": "1200",
        "Contact Name": "Customer Co",
        "Date": "30/04/2025",
        "Reference": "OVPAY002",
        "Line Description": "Customer overpayment",
        "Unit Amount": "300.00",
        "Account Code": "800"
      }],
      onDownload: downloadReceiveOpTemplate
    }, {
      id: "spend-allocation",
      label: "Spend Allocation",
      group: "Allocations",
      desc: "Allocate an existing Spend Overpayment against a specific supplier bill. Each row = one allocation.",
      required: [{
        col: "Overpayment Reference",
        rule: "The reference of an existing Spend Overpayment in Xero."
      }],
      optional: [{
        col: "Bill Number",
        rule: "Specific bill number to allocate against. Blank = FIFO (oldest bill first)."
      }, {
        col: "Amount",
        rule: "Amount to allocate. Blank = full overpayment remaining credit."
      }, {
        col: "Date",
        rule: "Allocation date. Format: DD/MM/YYYY. Blank = today."
      }],
      rules: ["Overpayment must already exist in Xero (import it first via Spend Overpayment)", "One row = one allocation", "Amount cannot exceed the overpayment remaining balance", "Bill Number blank = oldest outstanding bill used (FIFO)"],
      mistakes: ["Reference doesn't match an existing overpayment in Xero", "Amount larger than remaining overpayment balance", "Bill Number doesn't match an outstanding bill in Xero"],
      example: [{
        "Overpayment Reference": "OVPAY001",
        "Bill Number": "BILL-0042",
        "Amount": "500.00",
        "Date": "05/05/2025"
      }],
      onDownload: downloadSpendAllocationTemplate
    }, {
      id: "receive-allocation",
      label: "Receive Allocation",
      group: "Allocations",
      desc: "Allocate an existing Receive Overpayment against a specific customer invoice. Each row = one allocation.",
      required: [{
        col: "Overpayment Reference",
        rule: "The reference of an existing Receive Overpayment in Xero."
      }],
      optional: [{
        col: "Invoice Number",
        rule: "Specific invoice number to allocate against. Blank = FIFO (oldest invoice first)."
      }, {
        col: "Amount",
        rule: "Amount to allocate. Blank = full overpayment remaining credit."
      }, {
        col: "Date",
        rule: "Allocation date. Format: DD/MM/YYYY. Blank = today."
      }],
      rules: ["Overpayment must already exist in Xero (import via Receive Overpayment first)", "One row = one allocation", "Invoice Number blank = oldest outstanding invoice used (FIFO)"],
      mistakes: ["Reference doesn't match an existing overpayment", "Amount larger than remaining balance", "Invoice Number doesn't match an outstanding invoice in Xero"],
      example: [{
        "Overpayment Reference": "OVPAY002",
        "Invoice Number": "INV-1001",
        "Amount": "300.00",
        "Date": "05/05/2025"
      }],
      onDownload: downloadReceiveAllocationTemplate
    }, {
      id: "cn-allocation",
      label: "Credit Note Allocation",
      group: "Allocations",
      desc: "Allocate an existing Sales Credit Note against a specific customer invoice. Each row = one allocation.",
      required: [{
        col: "Credit Note Number",
        rule: "The number of an existing Sales Credit Note (ACCREC type) in Xero with remaining credit."
      }],
      optional: [{
        col: "Invoice Number",
        rule: "Specific invoice to allocate against. Blank = FIFO (oldest outstanding invoice first)."
      }, {
        col: "Amount",
        rule: "Amount to allocate. Blank = full remaining credit on the credit note."
      }, {
        col: "Date",
        rule: "Allocation date. Format: DD/MM/YYYY. Blank = today."
      }, {
        col: "Contact Name",
        rule: "Optional — used for reference only (not sent to Xero)."
      }],
      rules: ["Credit Note must already exist in Xero with remaining credit", "One row = one allocation", "Amount cannot exceed remaining credit", "Invoice Number blank = oldest outstanding invoice used (FIFO)", "Credit Note must be ACCREC type (Sales)"],
      mistakes: ["Credit Note Number doesn't match an existing credit note", "Amount larger than remaining credit", "Invoice Number not found or not AUTHORISED in Xero"],
      example: [{ "Credit Note Number": "CN-0042", "Invoice Number": "INV-1001", "Amount": "500.00", "Date": "05/05/2025" }],
      onDownload: downloadCnAllocationTemplate
    }, {
      id: "dn-allocation",
      label: "Debit Note Allocation",
      group: "Allocations",
      desc: "Allocate an existing Purchase Credit Note (Debit Note) against a specific supplier bill. Each row = one allocation.",
      required: [{
        col: "Credit Note Number",
        rule: "The number of an existing Purchase Credit Note (ACCPAY type) in Xero with remaining credit."
      }],
      optional: [{
        col: "Bill Number",
        rule: "Specific bill to allocate against. Blank = FIFO (oldest outstanding bill first)."
      }, {
        col: "Amount",
        rule: "Amount to allocate. Blank = full remaining credit on the credit note."
      }, {
        col: "Date",
        rule: "Allocation date. Format: DD/MM/YYYY. Blank = today."
      }, {
        col: "Contact Name",
        rule: "Optional — used for reference only (not sent to Xero)."
      }],
      rules: ["Credit Note (Debit Note) must already exist in Xero with remaining credit", "One row = one allocation", "Amount cannot exceed remaining credit", "Bill Number blank = oldest outstanding bill used (FIFO)", "Credit Note must be ACCPAY type (Purchase)"],
      mistakes: ["Credit Note Number doesn't match an existing purchase credit note", "Amount larger than remaining credit", "Bill Number not found or not AUTHORISED in Xero"],
      example: [{ "Credit Note Number": "DN-0001", "Bill Number": "BILL-0042", "Amount": "200.00", "Date": "05/05/2025" }],
      onDownload: downloadDnAllocationTemplate
    }, {
      id: "manual-journals",
      label: "Manual Journals",
      group: "Journals",
      desc: "Import double-entry manual journals. Group lines by Journal Reference — each unique reference = one journal.",
      required: [{
        col: "Journal Reference",
        rule: "Unique reference per journal. All rows with same reference = one journal."
      }, {
        col: "Date",
        rule: "Journal date. Format: DD/MM/YYYY"
      }, {
        col: "Account Code",
        rule: "Account code for this journal line."
      }, {
        col: "Debit OR Credit",
        rule: "Put the amount in Debit column or Credit column. Debit total must equal Credit total per journal."
      }],
      optional: [{
        col: "Narration",
        rule: "Journal description/narration."
      }, {
        col: "Tax Type",
        rule: "Tax type for this line."
      }, {
        col: "Tracking Name 1 / Option 1",
        rule: "Tracking category."
      }, {
        col: "Tracking Name 2 / Option 2",
        rule: "Tracking category."
      }, {
        col: "Amount",
        rule: "If Debit and Credit are both left blank, a signed Amount column is accepted instead — positive becomes Debit, negative becomes Credit. Useful for CSVs exported from other accounting systems."
      }],
      rules: ["Same Journal Reference = one journal in Xero", "Minimum 2 lines per journal", "Debit total MUST equal Credit total per journal (must balance to 0)", "Date format: DD/MM/YYYY", "Max 1000 journals per import", "Journal Reference or Narration is required — at least one must be filled", "If your source file only has a single signed Amount column, leave Debit/Credit blank — it will auto-split by sign"],
      mistakes: ["Journal doesn't balance (Debit ≠ Credit) → will be rejected", "Only 1 line per journal (minimum 2 required)", "Both Debit and Credit filled in same row", "Wrong date format"],
      example: [{
        "Journal Reference": "MJ-001",
        "Date": "30/04/2025",
        "Account Code": "6000",
        "Debit": "1000.00",
        "Credit": "",
        "Narration": "Accrual entry"
      }, {
        "Journal Reference": "MJ-001",
        "Date": "30/04/2025",
        "Account Code": "2100",
        "Debit": "",
        "Credit": "1000.00",
        "Narration": "Accrual entry"
      }],
      onDownload: () => downloadCsvFile("xero_manual_journal_import_template.csv", manualJournalImportHeaders, [
        ["JNL-001", "2026-01-15", "200", "Debit example line", "NONE"],
        ["JNL-001", "2026-01-15", "210", "Credit example line", "NONE"],
      ])
    }];
    // ── Update Centre guide entries (appended at end of GUIDE_TYPES above) ──
    GUIDE_TYPES.push({
      id: "update-centre-overview",
      label: "Update Centre — How It Works",
      group: "Update Centre",
      desc: "Understand what can and cannot be updated in Xero, and when to use each update method.",
      required: [
        { col: "DRAFT documents", rule: "Full update — all fields (contact, dates, line items, amounts, account codes) can be changed. Just upload the corrected CSV." },
        { col: "AUTHORISED documents", rule: "Partial update — reference, URL, branding theme update. Line items / amounts / contact / dates are LOCKED by Xero if payments or allocations are applied." },
        { col: "Master Data (Contacts, Items)", rule: "Always full upsert — no status restrictions. Safe to run anytime." },
      ],
      optional: [
        { col: "Payments", rule: "❌ CANNOT be updated. Xero only allows voiding a payment. To fix: use Delete Centre → void the payment, then reimport via Import Centre." },
        { col: "Spend Money / Receive Money", rule: "❌ Not supported in Update Centre. Use Delete Centre + Import Centre." },
        { col: "Manual Journals", rule: "❌ Not supported. Only DRAFT journals can be updated and they need a Journal ID." },
        { col: "Bank Transfers", rule: "❌ Xero has no update API for bank transfers. Delete and recreate." },
      ],
      rules: [
        "To FULLY update an AUTHORISED document: (1) Bulk Status Update → VOIDED, (2) Delete Centre → delete it, (3) Import Centre → reimport with correct data",
        "AUTHORISED docs with NO payments: most fields can still be updated — Xero will return a WARNING (not an error), and the result shows 'updated (AUTHORISED — some fields restricted)'",
        "The Update Centre uses the exact same CSV templates as the Import Centre — no new format to learn",
        "The 'Updated' count in results = successful updates. 'Errors' = Xero rejected the change (usually because the doc is in a locked period or has payments applied)"
      ],
      mistakes: [
        "Trying to update an AUTHORISED invoice amount when it already has a payment — Xero will block this. Void and reimport instead.",
        "Expecting Payments or Bank Transfers to update — they cannot. Only Invoices, Bills, Credit Notes, Quotes, POs, Contacts, and Items are updatable.",
        "Uploading a CSV with the wrong Invoice Number — Xero won't find the document and will try to create a new one instead of updating.",
      ],
      example: [
        { "Situation": "Change DRAFT invoice amount", "Method": "Upload corrected CSV via Update Centre > Update Sales Invoices", "Result": "Full update ✅" },
        { "Situation": "Change AUTHORISED invoice reference", "Method": "Upload CSV with new Reference via Update Centre > Update Sales Invoices", "Result": "Partial update ✅ (WARNING)" },
        { "Situation": "Change AUTHORISED invoice amount", "Method": "Bulk Status → VOIDED → Delete Centre → Import Centre", "Result": "Full replace ✅" },
        { "Situation": "Fix wrong payment amount", "Method": "Delete Centre → void payment → Import Centre → reimport", "Result": "Recreated ✅" },
      ],
    });
    GUIDE_TYPES.push({
      id: "update-bulk-status",
      label: "Bulk Status Update",
      group: "Update Centre",
      desc: "Change the status of invoices, bills, credit notes, quotes or purchase orders in bulk. Works on any document regardless of its current status.",
      required: [
        { col: "Number", rule: "The document number exactly as it appears in Xero (e.g. INV-001, BILL-002, QUO-005)" },
        { col: "New Status", rule: "Target status. Invoices/Bills/Credit Notes: DRAFT, AUTHORISED, VOIDED. Quotes: DRAFT, SENT, ACCEPTED, DECLINED. Purchase Orders: DRAFT, SUBMITTED, AUTHORISED, BILLED." },
        { col: "Type", rule: "INVOICE, BILL, CREDITNOTE, QUOTE, or PO — tells the tool which Xero endpoint to use." },
      ],
      optional: [],
      rules: [
        "Type column is case-insensitive — INVOICE, Invoice, invoice all work",
        "Xero does not allow all status transitions — e.g. you cannot go from VOIDED back to AUTHORISED directly. You must restore in Xero first.",
        "Batch size: 20 documents per request, 3 concurrent — very fast for large lists",
        "Each row = one document. One CSV can mix invoices, bills, credit notes, quotes and POs together.",
        "Download the template from the Update Centre page — it includes example rows for all 5 types"
      ],
      mistakes: [
        "Wrong Type value → the tool looks in the wrong Xero collection and returns 'not found'",
        "Trying to VOID a document that already has payments — Xero rejects this. You must delete the payments first.",
        "Using SUBMITTED for invoices — only Quotes and POs support SUBMITTED status",
        "Trying to set ACCEPTED on a Quote that is already DECLINED — some transitions are blocked by Xero"
      ],
      example: [
        { "Number": "INV-001", "New Status": "AUTHORISED", "Type": "INVOICE" },
        { "Number": "BILL-002", "New Status": "VOIDED", "Type": "BILL" },
        { "Number": "CN-003", "New Status": "AUTHORISED", "Type": "CREDITNOTE" },
        { "Number": "QUO-004", "New Status": "SENT", "Type": "QUOTE" },
        { "Number": "PO-005", "New Status": "AUTHORISED", "Type": "PO" },
      ],
    });
    GUIDE_TYPES.push({
      id: "update-exchange-rate",
      label: "Exchange Rate Update",
      group: "Update Centre",
      desc: "Fix or update the currency exchange rate on existing invoices, bills and credit notes. Use this when you imported with a wrong rate or the rate needs to be updated to the actual settlement rate.",
      required: [
        { col: "Invoice Number", rule: "The document number exactly as it appears in Xero. Works for invoices, bills AND credit notes — just use the document's number." },
        { col: "Exchange Rate", rule: "The new rate to apply. This is the rate from the foreign currency TO your base currency (e.g. if base = GBP and invoice is USD 1000 = GBP 800, rate = 0.8)." },
      ],
      optional: [],
      rules: [
        "Works for Invoices (ACCREC), Bills (ACCPAY), and Credit Notes",
        "DRAFT documents: rate always updates successfully",
        "AUTHORISED documents: rate updates ONLY if no payments are applied. If payments exist, Xero blocks the change — you will see an error row.",
        "Xero verifies the returned rate matches what you sent — if Xero silently ignores it (common on AUTHORISED docs with payments), the row is marked as error with explanation",
        "Batch size: 50 per request, 3 concurrent — handles thousands of records efficiently"
      ],
      mistakes: [
        "Putting the rate the wrong way round — if your base currency is GBP and the invoice is in USD, rate should be USD→GBP (e.g. 0.79), not GBP→USD (e.g. 1.27)",
        "Expecting AUTHORISED invoices with payments to update — they won't. Void the payment first, update the rate, then reapply the payment.",
        "Using Bill Number column header when it should be 'Invoice Number' — both document types use the same column name in this template"
      ],
      example: [
        { "Invoice Number": "INV-001", "Exchange Rate": "0.7850" },
        { "Invoice Number": "BILL-002", "Exchange Rate": "1.2340" },
        { "Invoice Number": "CN-003", "Exchange Rate": "0.8120" },
      ],
    });

    // ── Delete Centre guide entries ──────────────────────────────────────────
    GUIDE_TYPES.push({
      id: "delete-centre-overview",
      label: "Delete Centre — How It Works",
      group: "Delete Centre",
      desc: "Understand what can be deleted/voided in Xero, which column to use, and common restrictions to avoid errors.",
      required: [
        { col: "Invoice / Bill Void", rule: "Upload a sheet with an 'ID' column (Xero UUID) or 'Number' column (Invoice/Bill number). Both ACCREC invoices and ACCRECCREDIT credit notes are handled from the same sheet — auto-detected." },
        { col: "Invoice/Bill Payment Delete", rule: "Requires Payment ID (UUID). Find Payment IDs via Xero export or the Export Centre. Cannot delete by invoice number — must be Payment ID." },
        { col: "Manual Journal Void", rule: "Upload a sheet with 'Journal Reference' or 'Narration' column. Works for both DRAFT and POSTED journals." },
        { col: "Quote Delete", rule: "Upload a sheet with 'Quote Number' column. All statuses (DRAFT, SENT, ACCEPTED, DECLINED, INVOICED) can be deleted." },
        { col: "Purchase Order Delete", rule: "Upload a sheet with 'Purchase Order Number' column. Only DRAFT and SUBMITTED POs can be deleted." },
        { col: "Spend/Receive Money Delete", rule: "Upload a sheet with 'Reference' column. Only SPEND and RECEIVE types — Overpayments and Prepayments are NOT deletable via API." },
        { col: "Bank Transfer Delete", rule: "Upload a sheet with 'Reference' column. Reconciled transfers must be unreconciled first." },
        { col: "Contact Archive", rule: "Upload a sheet with 'Contact Name' column. Contacts cannot be fully deleted in Xero — only archived (hidden from active lists)." },
      ],
      optional: [],
      rules: [
        "Invoice/Bill Void: DRAFT → DELETED, AUTHORISED → VOIDED — the tool automatically chooses the correct action",
        "Cannot void an invoice/bill that has payments applied — remove payments first in Xero or use Payment Delete first",
        "Cannot delete an AUTHORISED or BILLED Purchase Order — use Update Centre → Bulk Status Update to change to DRAFT first",
        "Bank Transfers cannot be deleted if either side is reconciled — unreconcile in Xero first",
        "Overpayments and Prepayments (SPEND-OVERPAYMENT etc.) cannot be deleted via API — only plain SPEND/RECEIVE can",
        "Archived contacts still exist in Xero and can be found via 'Show Archived' in the Contacts list",
        "Results CSV download is available after each job completes — shows row-by-row status"
      ],
      mistakes: [
        "Using Invoice Number instead of Payment ID for payment delete — payment delete requires the Xero Payment UUID, not the invoice number",
        "Trying to delete an AUTHORISED Purchase Order — must change to DRAFT via Bulk Status Update first",
        "Uploading a sheet with the wrong column name — check the template for exact column names",
        "Trying to void an invoice that has a payment — void will fail; delete the payment first",
        "Expecting Overpayments/Prepayments to delete — they are excluded from Spend/Receive Money Delete by design"
      ],
      example: [
        { "Feature": "Invoice Void", "Required Column": "Number or ID", "Handles": "ACCREC + ACCRECCREDIT (auto-detect)" },
        { "Feature": "Bill Void", "Required Column": "Number or ID", "Handles": "ACCPAY + ACCPAYCREDIT (auto-detect)" },
        { "Feature": "Quote Delete", "Required Column": "Quote Number", "Handles": "All statuses" },
        { "Feature": "PO Delete", "Required Column": "Purchase Order Number", "Handles": "DRAFT and SUBMITTED only" },
        { "Feature": "Spend/Receive Delete", "Required Column": "Reference", "Handles": "SPEND and RECEIVE only" },
        { "Feature": "Bank Transfer Delete", "Required Column": "Reference", "Handles": "Non-reconciled only" },
        { "Feature": "Contact Archive", "Required Column": "Contact Name", "Handles": "ACTIVE contacts" },
      ],
    });
    GUIDE_TYPES.push({
      id: "delete-quote",
      label: "Quote Delete",
      group: "Delete Centre",
      desc: "Delete Xero Quotes in bulk by Quote Number. All quote statuses can be deleted — DRAFT, SENT, ACCEPTED, DECLINED, INVOICED.",
      required: [
        { col: "Quote Number", rule: "The exact Quote Number as shown in Xero (e.g. QU-001). One quote per row." },
      ],
      optional: [],
      rules: [
        "All statuses can be deleted — including INVOICED quotes (where an invoice has already been raised from the quote)",
        "Deleting an INVOICED quote does NOT delete the invoice that was created from it — the invoice remains",
        "Batch size: 50 per API call — fast for large lists",
        "Already DELETED quotes are skipped with a note, not counted as errors",
        "Download the Results CSV after the job to get a row-by-row audit trail"
      ],
      mistakes: [
        "Expecting the linked invoice to also be deleted when deleting an INVOICED quote — it won't be; delete the invoice separately",
        "Wrong Quote Number format — check Xero for exact numbers (case-insensitive but must match exactly)",
        "Uploading a CSV without the 'Quote Number' header — use the template from the Download Template button"
      ],
      example: [
        { "Quote Number": "QU-001" },
        { "Quote Number": "QU-002" },
        { "Quote Number": "QU-010" },
      ],
    });
    GUIDE_TYPES.push({
      id: "delete-purchase-order",
      label: "Purchase Order Delete",
      group: "Delete Centre",
      desc: "Delete Xero Purchase Orders in bulk by PO Number. Only DRAFT and SUBMITTED POs can be deleted via API.",
      required: [
        { col: "Purchase Order Number", rule: "The exact PO Number as shown in Xero (e.g. PO-001). One PO per row." },
      ],
      optional: [],
      rules: [
        "DRAFT POs → deleted ✅",
        "SUBMITTED POs → deleted ✅",
        "AUTHORISED POs → ❌ BLOCKED by Xero. Fix: use Update Centre → Bulk Status Update → change to DRAFT, then delete",
        "BILLED POs → ❌ BLOCKED by Xero. Same fix: change status to DRAFT first",
        "Already DELETED POs are skipped with a note",
        "Batch lookup uses ?PurchaseOrderNumbers= which is fast — handles hundreds in seconds"
      ],
      mistakes: [
        "Trying to delete an AUTHORISED PO — will be skipped with error. Change status to DRAFT via Bulk Status Update first",
        "Wrong column name — must be 'Purchase Order Number' (or 'PO Number') exactly",
        "Confusing PO Number with PO ID (UUID) — this feature uses the human-readable PO Number, not the Xero UUID"
      ],
      example: [
        { "Purchase Order Number": "PO-001" },
        { "Purchase Order Number": "PO-002" },
        { "Purchase Order Number": "PO-010" },
      ],
    });
    GUIDE_TYPES.push({
      id: "delete-spend-receive",
      label: "Spend / Receive Money Delete",
      group: "Delete Centre",
      desc: "Delete Spend Money and Receive Money bank transactions in bulk by Reference. Overpayments and Prepayments are NOT supported.",
      required: [
        { col: "Reference", rule: "The Reference field of the Spend/Receive Money transaction as entered in Xero. One reference per row." },
      ],
      optional: [],
      rules: [
        "SPEND type → deleted ✅",
        "RECEIVE type → deleted ✅",
        "SPEND-OVERPAYMENT / RECEIVE-OVERPAYMENT → ❌ NOT supported by Xero API",
        "SPEND-PREPAYMENT / RECEIVE-PREPAYMENT → ❌ NOT supported by Xero API",
        "Batch lookup uses ?References= which is optimised and fast",
        "If multiple transactions share the same Reference, ALL of them will be deleted — use unique references to avoid this",
        "Already DELETED transactions are skipped with a note"
      ],
      mistakes: [
        "Uploading Overpayment or Prepayment references — these will show as 'not supported', not an error",
        "Expecting all matching references to be deleted when multiple transactions share a reference — all will be deleted",
        "Wrong Reference value — must match exactly what's in the Xero Reference field (case-insensitive)"
      ],
      example: [
        { "Reference": "RENT-JAN-2026" },
        { "Reference": "SALARY-FEB-2026" },
        { "Reference": "UTIL-003" },
      ],
    });
    GUIDE_TYPES.push({
      id: "delete-bank-transfer",
      label: "Bank Transfer Delete",
      group: "Delete Centre",
      desc: "Delete Bank Transfers in bulk by Reference. Reconciled transfers must be unreconciled in Xero first.",
      required: [
        { col: "Reference", rule: "The Reference of the Bank Transfer as entered in Xero. One reference per row." },
      ],
      optional: [],
      rules: [
        "Non-reconciled Bank Transfers → deleted ✅",
        "Reconciled Bank Transfers → ❌ Xero blocks deletion. Go to Xero → Bank Accounts → find the transfer → unreconcile → then delete",
        "Bulk delete is sent in one API call (up to 50 per call) — very efficient",
        "Lookup uses ?where=Reference== which is one call per reference — slightly slower than batch but still concurrent (3 at a time)",
        "If no transfer is found with that reference, it will show as 'not found' — not an error"
      ],
      mistakes: [
        "Trying to delete a reconciled Bank Transfer — it will fail with an error from Xero. Unreconcile first in the Xero UI",
        "Wrong Reference — must match the Reference field exactly as stored in Xero",
        "Confusing Bank Transfer Reference with the bank statement description — use the Reference you entered when creating the transfer"
      ],
      example: [
        { "Reference": "TRANSFER-001" },
        { "Reference": "SWEEP-JAN" },
        { "Reference": "INTER-ACCOUNT-002" },
      ],
    });
    GUIDE_TYPES.push({
      id: "delete-contact-archive",
      label: "Contact Archive",
      group: "Delete Centre",
      desc: "Archive contacts in Xero in bulk by Contact Name. Xero does not support permanent deletion of contacts — archiving hides them from active views.",
      required: [
        { col: "Contact Name", rule: "The full name of the contact exactly as shown in Xero (e.g. ABC Limited). One contact per row. Case-insensitive." },
      ],
      optional: [],
      rules: [
        "Archived contacts are HIDDEN from active Contacts list but still exist in Xero",
        "To see archived contacts in Xero: Contacts → All Contacts → filter by 'Archived'",
        "Archived contacts can be RESTORED in Xero at any time — this is reversible",
        "Contacts with unpaid invoices or open transactions can still be archived — the transactions remain untouched",
        "Batch archive uses POST /Contacts (up to 50 per call) — very fast for large lists",
        "Already ARCHIVED contacts are skipped with a note, not counted as errors"
      ],
      mistakes: [
        "Expecting permanent deletion — Xero does not allow true deletion of contacts; they become archived",
        "Using Contact ID instead of Contact Name — this feature matches by name. Use exact name as in Xero",
        "Slight name differences (extra space, different capitalisation in Xero) — the match is case-insensitive but must be exact otherwise",
        "Archiving a contact that has active bank rules or recurring transactions — the rules/transactions still run; you may need to update those separately"
      ],
      example: [
        { "Contact Name": "ABC Limited" },
        { "Contact Name": "XYZ Pvt Ltd" },
        { "Contact Name": "Test Vendor" },
      ],
    });

    const guideGroups = [{
      label: "Payables",
      icon: "↓",
      types: ["bills", "bill-payments"]
    }, {
      label: "Receivables",
      icon: "↑",
      types: ["invoices", "invoice-payments"]
    }, {
      label: "Journals",
      icon: "≡",
      types: ["manual-journals"]
    }, {
      label: "Accounts",
      icon: "◎",
      types: ["accounts"]
    }, {
      label: "Inventory",
      icon: "⊡",
      types: ["items"]
    }, {
      label: "Contacts",
      icon: "⊙",
      types: ["customers", "vendors"]
    }, {
      label: "Settings",
      icon: "⚙",
      types: ["tracking-categories"]
    }, {
      label: "Banking",
      icon: "⊞",
      types: ["spend-money", "receive-money", "spend-op", "receive-op", "bank-transfers"]
    }, {
      label: "Allocations",
      icon: "⇌",
      types: ["spend-allocation", "receive-allocation", "cn-allocation", "dn-allocation"]
    }, {
      label: "Update Centre",
      icon: "✎",
      types: ["update-centre-overview", "update-bulk-status", "update-exchange-rate"]
    }, {
      label: "Delete Centre",
      icon: "🗑",
      types: ["delete-centre-overview", "delete-quote", "delete-purchase-order", "delete-spend-receive", "delete-bank-transfer", "delete-contact-archive"]
    }];
    const searchLower = guideSearch.toLowerCase();
    const filteredTypes = guideSearch ? GUIDE_TYPES.filter(t => t.label.toLowerCase().includes(searchLower) || t.group.toLowerCase().includes(searchLower) || t.desc.toLowerCase().includes(searchLower) || t.required.some(r => r.col.toLowerCase().includes(searchLower) || r.rule.toLowerCase().includes(searchLower)) || t.optional.some(r => r.col.toLowerCase().includes(searchLower))) : GUIDE_TYPES;
    const activeGuide = GUIDE_TYPES.find(t => t.id === guideSelectedType) || GUIDE_TYPES[0];
    const exampleCols = activeGuide.example.length ? Object.keys(activeGuide.example[0]) : [];
    const tagStyle = variant => ({
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      background: variant === "required" ? "#dcfce7" : "#f3f4f6",
      color: variant === "required" ? "#166534" : "#6b7280",
      marginRight: 4,
      marginBottom: 4
    });
    return <div className="guide-page" style={{
      display: "flex",
      height: "100vh",
      background: "#f8fafc",
      fontFamily: "inherit"
    }}>{<aside style={{
        width: 240,
        background: "#fff",
        borderRight: "1px solid #e5e7eb",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0
      }}>{<div style={{
          padding: "20px 16px 12px",
          borderBottom: "1px solid #f0f0f0"
        }}>{<div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 12
          }}>{<div className="imb-mini-mark" />}{<div>{<div style={{
                fontWeight: 700,
                fontSize: 14,
                color: "#111"
              }}>ImportMyBooks</div>}{<div style={{
                fontSize: 11,
                color: "#6b7280"
              }}>Template Guide</div>}</div>}</div>}{<input type="text" placeholder="Search templates..." value={guideSearch} onChange={e => setGuideSearch(e.target.value)} style={{
            width: "100%",
            padding: "7px 10px",
            borderRadius: 7,
            border: "1px solid #e5e7eb",
            fontSize: 13,
            outline: "none",
            boxSizing: "border-box"
          }} />}</div>}{<nav style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 0"
        }}>{guideSearch ? filteredTypes.length ? filteredTypes.map(t => <button type="button" onClick={() => {
            setGuideSelectedType(t.id);
            setGuideSearch("");
          }} style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "7px 16px",
            background: guideSelectedType === t.id ? "#f5f3ff" : "transparent",
            color: guideSelectedType === t.id ? "#7c3aed" : "#374151",
            border: "none",
            cursor: "pointer",
            fontSize: 13,
            fontWeight: guideSelectedType === t.id ? 600 : 400
          }}>{t.label}</button>) : <div style={{
            padding: "16px",
            color: "#9ca3af",
            fontSize: 13
          }}>No results found.</div> : guideGroups.map(group => <div>{<div style={{
              padding: "8px 16px 4px",
              fontSize: 11,
              fontWeight: 700,
              color: "#9ca3af",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              display: "flex",
              alignItems: "center",
              gap: 5
            }}>{<span>{group.icon}</span>}{" "}{group.label}</div>}{group.types.map(typeId => {
              const t = GUIDE_TYPES.find(x => x.id === typeId);
              if (!t) return null;
              return <button type="button" onClick={() => setGuideSelectedType(t.id)} style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "7px 16px 7px 24px",
                background: guideSelectedType === t.id ? "#f5f3ff" : "transparent",
                color: guideSelectedType === t.id ? "#7c3aed" : "#374151",
                border: "none",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: guideSelectedType === t.id ? 600 : 400,
                borderLeft: guideSelectedType === t.id ? "3px solid #7c3aed" : "3px solid transparent"
              }}>{t.label}</button>;
            })}</div>)}</nav>}{<div style={{
          padding: "12px 16px",
          borderTop: "1px solid #f0f0f0",
          display: "flex",
          flexDirection: "column",
          gap: 6
        }}>{<button type="button" onClick={downloadAllTemplatesAsZip} style={{
            background: "#059669",
            border: "none",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 12,
            cursor: "pointer",
            color: "#fff",
            fontWeight: 600,
            textAlign: "center"
          }}>📥 Download All Templates</button>}{<button type="button" onClick={() => navigate("/import")} style={{
            background: "none",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            cursor: "pointer",
            color: "#374151",
            textAlign: "center"
          }}>← Back to Import</button>}{<button type="button" onClick={() => navigate("/")} style={{
            background: "none",
            border: "none",
            fontSize: 12,
            cursor: "pointer",
            color: "#9ca3af"
          }}>↗ Extraction</button>}</div>}</aside>}{<div style={{
        flex: 1,
        overflowY: "auto",
        padding: "32px 40px"
      }}>{<div style={{
          marginBottom: 28
        }}>{<div style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16
          }}>{<div>{<div style={{
                fontSize: 11,
                fontWeight: 700,
                color: "#7c3aed",
                letterSpacing: "0.07em",
                textTransform: "uppercase",
                marginBottom: 6
              }}>{activeGuide.group}</div>}{<h1 style={{
                margin: 0,
                fontSize: 26,
                fontWeight: 700,
                color: "#111827"
              }}>{activeGuide.label}</h1>}{<p style={{
                margin: "8px 0 0",
                color: "#6b7280",
                fontSize: 15
              }}>{activeGuide.desc}</p>}</div>}{<div style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              flexShrink: 0
            }}>{<button type="button" onClick={activeGuide.onDownload} style={{
                padding: "10px 18px",
                background: "#7c3aed",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap"
              }}>⬇ Download This Template</button>}{<button type="button" onClick={downloadAllTemplatesAsZip} style={{
                padding: "10px 18px",
                background: "#059669",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap"
              }}>📥 Download All Templates (ZIP)</button>}</div>}</div>}</div>}{<div style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          marginBottom: 20,
          overflow: "hidden"
        }}>{<div style={{
            padding: "14px 20px",
            borderBottom: "1px solid #f0f4f0",
            display: "flex",
            alignItems: "center",
            gap: 10
          }}>{<span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#16a34a",
              display: "inline-block"
            }} />}{<span style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#111"
            }}>Required Columns</span>}{<span style={{
              ...tagStyle("required")
            }}>{activeGuide.required.length}{" fields"}</span>}</div>}{<div>{activeGuide.required.map((item, i) => <div style={{
              display: "grid",
              gridTemplateColumns: "200px 1fr",
              gap: 0,
              padding: "11px 20px",
              borderBottom: i < activeGuide.required.length - 1 ? "1px solid #f9fafb" : "none",
              alignItems: "start"
            }}>{<div style={{
                fontWeight: 600,
                fontSize: 13,
                color: "#111827",
                paddingRight: 12
              }}>{<span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5
                }}>{<span style={{
                    width: 5,
                    height: 5,
                    background: "#16a34a",
                    borderRadius: "50%",
                    display: "inline-block",
                    flexShrink: 0
                  }} />}{item.col}</span>}</div>}{<div style={{
                fontSize: 13,
                color: "#4b5563",
                lineHeight: 1.5
              }}>{item.rule}</div>}</div>)}</div>}</div>}{<div style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          marginBottom: 20,
          overflow: "hidden"
        }}>{<div style={{
            padding: "14px 20px",
            borderBottom: "1px solid #f0f0f0",
            display: "flex",
            alignItems: "center",
            gap: 10
          }}>{<span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#9ca3af",
              display: "inline-block"
            }} />}{<span style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#111"
            }}>Optional Columns</span>}{<span style={{
              ...tagStyle("optional")
            }}>{activeGuide.optional.length}{" fields"}</span>}</div>}{<div>{activeGuide.optional.map((item, i) => <div style={{
              display: "grid",
              gridTemplateColumns: "200px 1fr",
              gap: 0,
              padding: "11px 20px",
              borderBottom: i < activeGuide.optional.length - 1 ? "1px solid #f9fafb" : "none",
              alignItems: "start"
            }}>{<div style={{
                fontWeight: 500,
                fontSize: 13,
                color: "#6b7280",
                paddingRight: 12
              }}>{<span style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5
                }}>{<span style={{
                    width: 5,
                    height: 5,
                    background: "#d1d5db",
                    borderRadius: "50%",
                    display: "inline-block",
                    flexShrink: 0
                  }} />}{item.col}</span>}</div>}{<div style={{
                fontSize: 13,
                color: "#6b7280",
                lineHeight: 1.5
              }}>{item.rule}</div>}</div>)}</div>}</div>}{<div style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 10,
          marginBottom: 20,
          overflow: "hidden"
        }}>{<div style={{
            padding: "14px 20px",
            borderBottom: "1px solid #fde68a"
          }}>{<span style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#92400e"
            }}>Important Rules</span>}</div>}{<ul style={{
            margin: 0,
            padding: "12px 20px 12px 36px",
            listStyle: "none"
          }}>{activeGuide.rules.map((rule, i) => <li style={{
              fontSize: 13,
              color: "#78350f",
              lineHeight: 1.6,
              paddingBottom: 4,
              display: "flex",
              alignItems: "flex-start",
              gap: 8
            }}>{<span style={{
                marginTop: 5,
                width: 6,
                height: 6,
                background: "#d97706",
                borderRadius: "50%",
                flexShrink: 0
              }} />}{rule}</li>)}</ul>}</div>}{<div style={{
          background: "#fff5f5",
          border: "1px solid #fecaca",
          borderRadius: 10,
          marginBottom: 20,
          overflow: "hidden"
        }}>{<div style={{
            padding: "14px 20px",
            borderBottom: "1px solid #fecaca"
          }}>{<span style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#991b1b"
            }}>Common Mistakes to Avoid</span>}</div>}{<ul style={{
            margin: 0,
            padding: "12px 20px 12px 36px",
            listStyle: "none"
          }}>{activeGuide.mistakes.map((m, i) => <li style={{
              fontSize: 13,
              color: "#7f1d1d",
              lineHeight: 1.6,
              paddingBottom: 4,
              display: "flex",
              alignItems: "flex-start",
              gap: 8
            }}>{<span style={{
                marginTop: 5,
                width: 6,
                height: 6,
                background: "#ef4444",
                borderRadius: "50%",
                flexShrink: 0
              }} />}{m}</li>)}</ul>}</div>}{activeGuide.example.length > 0 && <div style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 10,
          marginBottom: 20,
          overflow: "hidden"
        }}>{<div style={{
            padding: "14px 20px",
            borderBottom: "1px solid #f0f0f0"
          }}>{<span style={{
              fontWeight: 700,
              fontSize: 14,
              color: "#111"
            }}>Example CSV Data</span>}{<span style={{
              fontSize: 12,
              color: "#9ca3af",
              marginLeft: 8
            }}>{activeGuide.example.length}{" example row"}{activeGuide.example.length > 1 ? "s" : ""}</span>}</div>}{<div style={{
            overflowX: "auto"
          }}>{<table style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12
            }}>{<thead>{<tr style={{
                  background: "#f9fafb"
                }}>{exampleCols.map(col => <th style={{
                    padding: "8px 14px",
                    textAlign: "left",
                    fontWeight: 600,
                    color: "#374151",
                    borderBottom: "1px solid #e5e7eb",
                    whiteSpace: "nowrap"
                  }}>{col}</th>)}</tr>}</thead>}{<tbody>{activeGuide.example.map((row, ri) => <tr style={{
                  background: ri % 2 === 0 ? "#fff" : "#f9fafb"
                }}>{exampleCols.map(col => <td style={{
                    padding: "8px 14px",
                    color: "#374151",
                    borderBottom: "1px solid #f3f4f6",
                    whiteSpace: "nowrap",
                    fontFamily: "monospace"
                  }}>{row[col] || ""}</td>)}</tr>)}</tbody>}</table>}</div>}</div>}{<div style={{
          background: "#f0f9ff",
          border: "1px solid #bae6fd",
          borderRadius: 10,
          padding: "16px 20px"
        }}>{<div style={{
            fontWeight: 700,
            fontSize: 13,
            color: "#0369a1",
            marginBottom: 10
          }}>General Tips for All Templates</div>}{<ul style={{
            margin: 0,
            padding: 0,
            listStyle: "none"
          }}>{["Always download the template first — use the 'Download Template' button above.", "Date format is always DD/MM/YYYY (day/month/year).", "Do not add extra columns or rearrange column order.", "Save your file as CSV (comma-separated), not Excel format.", "Tax Type names must exactly match what's in your Xero settings.", "Account Codes must exist in your Xero chart of accounts.", "After import, check the progress panel for any errors and download failed rows to fix and re-import."].map((tip, i) => <li style={{
              fontSize: 13,
              color: "#0c4a6e",
              lineHeight: 1.6,
              paddingBottom: 4,
              display: "flex",
              alignItems: "flex-start",
              gap: 8
            }}>{<span style={{
                marginTop: 5,
                width: 6,
                height: 6,
                background: "#0ea5e9",
                borderRadius: "50%",
                flexShrink: 0
              }} />}{tip}</li>)}</ul>}</div>}</div>}</div>;
  }
  return <div className={`dashboard${sidebarOpen ? " dashboard--sidebar-open" : ""}`}>{sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}{<aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}>{<div className="sidebar-brand">{<PrismMark size={22} className="sidebar-prism-mark" />}{<div>{<div className="sidebar-title"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></div>}{<div className="sidebar-sub">importmybooks.com</div>}</div>}<button className="sidebar-close-btn" type="button" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><XIcon size={18} /></button></div>}{<div className="sidebar-cta">{sessionId ? <div style={{
          display: "flex",
          gap: 6
        }}>{<button className="btn primary btn-compact" style={{
            flex: 1
          }} onClick={handleConnect}>Reconnect</button>}{<button className="btn btn-compact" style={{
            flex: 1,
            background: "#e53e3e",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            cursor: "pointer"
          }} onClick={handleDisconnect}>Disconnect</button>}</div> : <button className="btn primary btn-compact" onClick={handleConnect}>Connect to Xero</button>}</div>}{<nav className="nav">
        <button className="nav-item nav-item--active" type="button" onClick={() => overviewRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <LayoutDashboard size={16} />Overview
        </button>
        <button className={`nav-item ${showHistory ? "nav-item--active" : ""}`} type="button" onClick={() => { setShowHistory(true); resultsRef.current?.scrollIntoView({ behavior: "smooth" }); }}>
          <Clock size={16} />History
        </button>
        <button className="nav-item" type="button" onClick={() => filtersRef.current?.scrollIntoView({ behavior: "smooth" })}>
          <SlidersHorizontal size={16} />Filters
        </button>
      </nav>}{<div className="sidebar-footer">
        <div className="sidebar-footer-label">Tools</div>
        <div className="sidebar-actions">
          <button className="nav-item" type="button" onClick={handleUseLatestSession}>
            <RefreshCw size={14} />{isCheckingSession ? "Checking..." : "Latest Session"}
          </button>
          <button className="nav-item" type="button" onClick={openImportPage}>
            <Upload size={14} />Importing
          </button>
          <button className="nav-item" type="button" onClick={() => { if (!hasPermission("delete")) { setAccessDeniedModal({ feature: "Delete Centre" }); return; } openDeleteCentrePage(); }}>
            <Trash2 size={14} />Delete Centre
          </button>
          <button className="nav-item" type="button" onClick={() => navigate("/update-centre")} style={{ color: "#f59e0b" }}>
            <SlidersHorizontal size={14} />Update Centre
          </button>
          <button className="nav-item" type="button" onClick={() => navigate("/guide")} style={{ color: "#a78bfa" }}>
            <BookOpen size={14} />Template Guide
          </button>
          {userRole !== "team" && <button className="nav-item" type="button" onClick={() => navigate("/pricing")} style={{ color: "#fbbf24" }}>
            <span style={{ fontSize: 14 }}>★</span>Pricing
          </button>}
          <button className="nav-item" type="button" onClick={() => navigate("/account")} style={{ color: "rgba(255,255,255,0.45)" }}>
            <User size={14} />Account
          </button>
          <button className="nav-item nav-item--logout" type="button" onClick={handleLogout}>
            <LogOut size={14} />Logout
          </button>
        </div>
        <button type="button" className="user-pill" onClick={()=>navigate("/account")} title="Account & Billing" style={{cursor:"pointer",background:"none",border:"none",fontFamily:"inherit",textAlign:"left",width:"100%"}}>{user?.email || "Signed in"}</button>
      </div>}</aside>}{<main className="app-shell">{<header className="topbar">{<button className="hamburger-btn" type="button" onClick={() => setSidebarOpen(o => !o)} aria-label="Toggle sidebar"><Menu size={20} /></button>}{<div className="brand">{<PrismMark size={18} />}{<span className="brand-kalki-name"><span style={{color:"#2dd4bf"}}>Import</span><span style={{color:"#2dd4bf"}}>My</span><span style={{color:"rgba(255,255,255,0.9)"}}>Books</span></span>}</div>}</header>}{userBroadcast && <div style={{background:"rgba(245,158,11,0.12)",borderBottom:"1px solid rgba(245,158,11,0.3)",padding:"10px 24px",fontSize:13,color:"#f59e0b",display:"flex",alignItems:"center",gap:10}}><span>📢</span><span style={{flex:1}}>{userBroadcast}</span><button type="button" onClick={()=>setUserBroadcast("")} style={{background:"none",border:"none",color:"#f59e0b",cursor:"pointer",fontSize:16,lineHeight:1}}>✕</button></div>}
      {<section className="overview-strip" ref={overviewRef}>{<div>{<p className="kicker">ImportMyBooks · importmybooks.com</p>}{<h1>Your Xero command centre.</h1>}{<p className="sub">Extract, import and manage Xero data across all your tenants — in one clean, powerful workspace.</p>}</div>}{<div className="hero-status">{<span>{isConnected ? "Connected" : "Not connected"}</span>}{selectedTenantName ? <span>{selectedTenantName}</span> : null}{user?.email ? <span>{user.email}</span> : null}</div>}</section>}{<section className="hero-grid">{<div className="hero-metrics">{<div className="stat-card">{<p className="stat-label">Connection</p>}{<p className="stat-value">{isConnected ? "Active" : "Idle"}</p>}{<p className="stat-sub">{selectedTenantName || "No tenant selected"}</p>}</div>}{<div className="stat-card">{<p className="stat-label">Types Selected</p>}{<p className="stat-value">{selectedTypes.length}</p>}{<p className="stat-sub">{"Total available: "}{types.length}</p>}</div>}{<div className="stat-card">{<p className="stat-label">Exports Ready</p>}{<p className="stat-value">{exportSummary.downloaded}</p>}{<p className="stat-sub">{"No records: "}{exportSummary.noRecords}{" | Errors: "}{exportSummary.errors}</p>}</div>}</div>}</section>}{<section className="workspace" ref={filtersRef}>{<div className="panel filters-panel">{<div className="panel-header">{<div>{<h2>Filters</h2>}{<p>Scope your export before starting a run.</p>}</div>}{<div className="panel-actions">{<button className="btn ghost" onClick={() => {
                setSelectedTenant("");
                setStatus("Pick another tenant to switch.");
              }} disabled={!sessionId}>Switch Tenant</button>}{<button className="btn ghost" onClick={handleDisconnect} disabled={!sessionId}>Disconnect</button>}</div>}</div>}{<div className="grid">{<label className="field">{<span>From</span>}{<input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />}</label>}{<label className="field">{<span>To</span>}{<input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />}</label>}{<label className="field">{<span>Tenant</span>}{<select value={selectedTenant} onChange={e => { const tid = e.target.value; setSelectedTenant(tid); const found = tenants.find(t => t.tenantId === tid); if (found?.sessionId) setSessionId(found.sessionId); }}>{<option value="">Select tenant</option>}{tenants.map(tenant => <option key={tenant.tenantId} value={tenant.tenantId}>{tenant.tenantName}</option>)}</select>}</label>}</div>}{<div className="preset-row">{<span className="preset-label">Quick range</span>}{<button className="btn ghost btn-compact" onClick={() => applyPreset(7)}>Last 7 days</button>}{<button className="btn ghost btn-compact" onClick={() => applyPreset(30)}>Last 30 days</button>}{<button className="btn ghost btn-compact" onClick={() => applyPreset(90)}>Last 90 days</button>}{<button className="btn ghost btn-compact" onClick={() => applyPreset(365)}>Last 12 months</button>}</div>}</div>}{<div className="panel types-panel">{<div className="panel-header">{<div>{<h2>Data Types</h2>}{<p>Choose what you want to extract.</p>}</div>}{<div className="type-meta">{selectedTypes.length}{" selected"}{<button className="btn ghost btn-compact" type="button" onClick={loadTypes} disabled={typesLoading}>{typesLoading ? "Loading..." : "Reload Types"}</button>}</div>}</div>}{typesError ? <div className="status-banner">{"Types not loaded: "}{typesError}</div> : null}{typesLoading && types.length === 0 ? <div className="type-skeleton-wrap">{[0,1,2].map(gi => <div key={gi} className="skeleton-group"><div className="skeleton skeleton-group-label" />{[0,1,2,3].map(i => <div key={i} className="skeleton skeleton-item" />)}</div>)}</div> : <div className="type-list">{<div className="type-toolbar">{<label className="type-item">{<input type="checkbox" checked={selectedTypes.length === types.length && types.length > 0} onChange={e => handleToggleAllTypes(e.target.checked)} />}Select all</label>}</div>}{<div className="type-groups">{groupedTypes.map(group => {
                const groupAllSelected = group.types.every(type => selectedTypes.includes(type));
                return <div className="type-group">{<div className="type-group__header">{<div className="type-group__title">{group.label}</div>}{<label className="type-item type-item--muted">{<input type="checkbox" checked={groupAllSelected} onChange={e => handleToggleGroup(group.types, e.target.checked)} />}Select group</label>}</div>}{<div className="type-group__list">{group.types.map(type => <label className="type-item">{<input type="checkbox" checked={selectedTypes.includes(type)} onChange={e => handleToggleType(type, e.target.checked)} />}{type}</label>)}</div>}</div>;
              })}</div>}</div>}{<div className="actions actions--sticky"><button className="btn primary" onClick={handleExport} disabled={isLoading || !sessionId || !selectedTenant || !selectedTypes.length}>{isLoading ? "Exporting..." : "Download Files"}</button></div>}</div>}</section>}{<section className="panel results-panel" ref={resultsRef}>{<div className="panel-header panel-header--results">{<div className="panel-title">{<h2>Export Results</h2>}{<p>Track what is ready and download instantly.</p>}</div>}{<div className="results-actions">{showHistory ? <button className="btn ghost btn-compact" onClick={handleClearHistory} disabled={!exportResults.length} type="button">Clear History</button> : null}{showHistory && exportResults.length ? <div className="export-filter">{<span className="export-filter__note">Grouped by tenant</span>}</div> : null}</div>}</div>}{<div className="status-banner">{status}</div>}{showHistory ? exportResults.length ? showAllTenants && groupByTenant ? <div className="tenant-groups">{groupedResults.map(group => <div className="tenant-group">{<div className="tenant-group__header">{<button className="tenant-group__toggle" type="button" onClick={() => setOpenTenants(prev => ({
                ...prev,
                [group.tenant]: !prev[group.tenant]
              }))}>{<h3>{group.tenant}</h3>}{<span>{group.items.length}{" exports"}</span>}</button>}{<select className="tenant-group__select" value={downloadAllFormat} onChange={e => setDownloadAllFormat(e.target.value)}>{<option value="excel">Excel</option>}{<option value="csv">CSV</option>}{<option value="json">JSON</option>}</select>}{<button className="btn ghost btn-compact" type="button" onClick={() => handleDownloadAll(group.tenant)}>Download All</button>}</div>}{openTenants[group.tenant] ? <div className="export-results export-results--table">{<div className="export-results__header">{<span>Type</span>}{<span>Status</span>}{<span>Detail</span>}{<span>Downloads</span>}</div>}{group.items.map(result => <div className="export-result export-result--row">{<div className="export-result__type">{<div>{result.type}</div>}{result.createdAt ? <div className="export-result__meta">{formatDateTime(result.createdAt)}</div> : null}</div>}{<div className={`export-result__status export-result__status--${result.status.toLowerCase().replace(/\s+/g, "-")}`}>{result.status}</div>}{<div className="export-result__detail">{result.detail || "-"}</div>}{<div className="export-result__download">{result.status === "Ready" ? <>{<a className="btn btn--excel" href={result.excelUrl}>Excel</a>}{<a className="btn btn--csv" href={result.csvUrl}>CSV</a>}{<a className="btn btn--json" href={result.jsonUrl}>JSON</a>}{result.folderPath ? <button className="btn btn--path" type="button" onClick={() => handleCopy(result.folderPath)}>Copy Path</button> : null}</> : result.status === "Error" ? <button className="btn btn--retry" type="button" onClick={() => handleRetry(result.jobId)}>Retry</button> : <span className="export-result__muted">-</span>}</div>}</div>)}</div> : null}</div>)}</div> : selectedTenantName ? <div className="export-results export-results--table">{<div className="export-results__header">{<span>Type</span>}{<span>Tenant</span>}{<span>Status</span>}{<span>Detail</span>}{<span>Downloads</span>}</div>}{exportResults.filter(result => {
            if (!selectedTenantName) return false;
            if (showAllTenants) return true;
            return result.tenantName === selectedTenantName;
          }).map(result => <div className="export-result export-result--row">{<div className="export-result__type">{<div>{result.type}</div>}{result.createdAt ? <div className="export-result__meta">{formatDateTime(result.createdAt)}</div> : null}</div>}{<div className="export-result__tenant">{result.tenantName || "-"}</div>}{<div className={`export-result__status export-result__status--${result.status.toLowerCase().replace(/\s+/g, "-")}`}>{result.status}</div>}{<div className="export-result__detail">{result.detail || "-"}</div>}{<div className="export-result__download">{result.status === "Ready" ? <>{<a className="btn btn--excel" href={result.excelUrl}>Excel</a>}{<a className="btn btn--csv" href={result.csvUrl}>CSV</a>}{<a className="btn btn--json" href={result.jsonUrl}>JSON</a>}{result.folderPath ? <button className="btn btn--path" type="button" onClick={() => handleCopy(result.folderPath)}>Copy Path</button> : null}</> : result.status === "Error" ? <button className="btn btn--retry" type="button" onClick={() => handleRetry(result.jobId)}>Retry</button> : <span className="export-result__muted">-</span>}</div>}</div>)}</div> : <EmptyStateSelectTenant /> : <EmptyStateNoHistory /> : null}</section>}
{isLoading && <AccountingLoader type="export" message={status} processed={exportResults.filter(r => r.status === "Ready").length} total={selectedTypes.length} />}
</main>}</div>;
}
export default App;
