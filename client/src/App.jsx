import { useEffect, useMemo, useRef, useState } from "react";

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

function App() {
  const [user, setUser] = useState(null);
  const [userToken, setUserToken] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [authUrl, setAuthUrl] = useState("");
  const [types, setTypes] = useState([]);
  const [typesError, setTypesError] = useState("");
  const [typesLoading, setTypesLoading] = useState(false);
  const [tenants, setTenants] = useState([]);
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
  const [adminLimit, setAdminLimit] = useState("");
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [adminSuccess, setAdminSuccess] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminEmail, setAdminEmail] = useState("rituraj@gmail.com");
  const [adminPassword, setAdminPassword] = useState("");
  const [isAdminPage, setIsAdminPage] = useState(
    () => window.location.pathname === "/admin"
  );
  const [adminTypes, setAdminTypes] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
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
  const [adminChartSelection, setAdminChartSelection] = useState([
    "line",
    "monthlyTenants",
    "userWorkload",
    "statusSplit",
    "tenantUserMatrix",
    "recentActivity",
  ]);
  const overviewRef = useRef(null);
  const filtersRef = useRef(null);
  const resultsRef = useRef(null);
  const adminAutosaveRef = useRef(null);

  const formatDateInput = (value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };

  const formatDateTime = (value) => {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  };

  const applyPreset = (days) => {
    const now = new Date();
    const from = new Date(now);
    from.setDate(now.getDate() - days);
    setFromDate(formatDateInput(from));
    setToDate(formatDateInput(now));
  };

  const formatDuration = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
    return `${seconds}s`;
  };

  const formatCount = (value) => {
    if (!Number.isFinite(value)) return "-";
    return value.toLocaleString();
  };

  const formatPercent = (value) => {
    if (!Number.isFinite(value)) return "-";
    return `${value}%`;
  };

  const formatMonthLabel = (value) => {
    if (!value) return "-";
    const [y, m] = String(value).split("-");
    const date = new Date(Number(y), Number(m) - 1, 1);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, { month: "short", year: "numeric" });
  };

  const buildLinePath = (points, width, height) => {
    if (!points.length) return "";
    const max = Math.max(1, ...points.map((point) => point.value));
    return points
      .map((point, index) => {
        const x = (index / (points.length - 1 || 1)) * width;
        const y = height - (point.value / max) * height;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const getMax = (items, key) => {
    if (!Array.isArray(items) || items.length === 0) return 1;
    return Math.max(
      1,
      ...items.map((item) => (Number.isFinite(item?.[key]) ? item[key] : 0))
    );
  };

  const buildProgressDetail = (progress, startedAt) => {
    if (!progress || !progress.page) return "";
    const { page, pageCount, count, totalCount } = progress;
    const parts = [];
    if (pageCount) {
      parts.push(`Page ${page}/${pageCount}`);
    } else if (page) {
      parts.push(`Page ${page}`);
    }
    if (totalCount) {
      const pct = Math.min(100, Math.round((count / totalCount) * 100));
      parts.push(`${pct}%`);
      if (startedAt && count > 0) {
        const elapsed = Date.now() - startedAt;
        const etaMs = (elapsed / count) * (totalCount - count);
        const etaLabel = formatDuration(etaMs);
        if (etaLabel) {
          parts.push(`ETA ${etaLabel}`);
        }
      }
    }
    return parts.length ? `Progress: ${parts.join(" · ")}` : "";
  };

  const handleCopy = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Folder path copied.");
    } catch {
      setStatus("Copy failed. Please copy manually.");
    }
  };

  const parseApiResponse = async (res) => {
    const text = await res.text();
    if (!text) {
      return { data: {}, rawText: "" };
    }
    try {
      return { data: JSON.parse(text), rawText: text };
    } catch {
      return { data: {}, rawText: text };
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
        headers: { "x-admin-token": tokenToUse },
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
        headers: { "x-admin-token": tokenToUse },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load types");
      }
      setAdminTypes(data.types || []);
      if (
        adminTypeMode === "allow" &&
        (!adminTypeSelection || adminTypeSelection.length === 0) &&
        Array.isArray(data.types) &&
        data.types.length
      ) {
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
        headers: { "x-admin-token": tokenToUse },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to load users");
      }
      setAdminUsers(data.users || []);
    } catch (err) {
      setAdminError(err.message);
    }
  };

  const handleClearAllExports = async () => {
    if (!adminToken) return;
    setAdminCleanupLoading(true);
    setAdminCleanupStatus("");
    try {
      const res = await fetch(`${API_BASE}/admin/exports/clear-all`, {
        method: "POST",
        headers: adminHeader,
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
    const daysToUse = Number.isFinite(daysOverride)
      ? daysOverride
      : adminAnalyticsDays;
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
        headers: { "x-admin-token": tokenToUse },
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
    setAdminError("");
    setAdminSuccess("");
    try {
      const res = await fetch(`${API_BASE}/admin/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({
          maxUsers: adminLimit,
          allowedTypes: adminTypeSelection,
          deniedTypes: [],
        }),
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
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({
          maxUsers: adminLimit,
          allowedTypes: adminTypeSelection,
          deniedTypes: [],
        }),
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
      setAdminTypeSelection((prev) => Array.from(new Set([...prev, type])));
    } else {
      setAdminTypeSelection((prev) => prev.filter((item) => item !== type));
    }
  };

  const handleToggleUser = async (userId, disabled) => {
    if (!adminToken) return;
    setAdminLoading(true);
    setAdminError("");
    try {
      const res = await fetch(`${API_BASE}/admin/users/${userId}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...adminHeader },
        body: JSON.stringify({ disabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to update user");
      }
      setAdminUsers((prev) =>
        prev.map((user) =>
          user.id === userId ? { ...user, disabled: data.disabled } : user
        )
      );
    } catch (err) {
      setAdminError(err.message);
    } finally {
      setAdminLoading(false);
    }
  };

  const handleAdminLogin = async () => {
    setAdminLoading(true);
    setAdminError("");
    setAdminSuccess("");
    try {
      const res = await fetch(`${API_BASE}/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
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
        headers: adminHeader,
      });
    } catch {
      // ignore logout errors
    }
    localStorage.removeItem("xero_admin_token");
    setAdminToken("");
    setAdminAuthed(false);
    setAdminSettings(null);
    setAdminHydrated(false);
  };

  const isConnected = Boolean(sessionId);
  const selectedTenantName =
    tenants.find((tenant) => tenant.tenantId === selectedTenant)?.tenantName || "";

  const sessionHeader = useMemo(() => {
    if (!sessionId) return {};
    return { "x-session-id": sessionId };
  }, [sessionId]);

  const userHeader = useMemo(() => {
    if (!userToken) return {};
    return { "x-user-token": userToken };
  }, [userToken]);

  const adminHeader = useMemo(() => {
    if (!adminToken) return {};
    return { "x-admin-token": adminToken };
  }, [adminToken]);

  const navigate = (path) => {
    window.history.pushState({}, "", path);
    setIsAdminPage(path === "/admin");
  };

  const authHeaders = useMemo(
    () => ({ ...sessionHeader, ...userHeader }),
    [sessionHeader, userHeader]
  );

  const groupedTypes = useMemo(() => {
    const categories = [
      {
        key: "Sales",
        match: (type) =>
          type.startsWith("Invoice ") ||
          type.startsWith("Invoice CreditNotes") ||
          type === "Quotes" ||
          type === "Receive" ||
          type === "Invoice Payment" ||
          type === "CreditNoteRefund Invoice",
      },
      {
        key: "Purchases",
        match: (type) =>
          type.startsWith("Bill ") ||
          type.startsWith("Supplier CreditNotes") ||
          type === "Purchase Orders" ||
          type === "Spend" ||
          type === "Bill Payment" ||
          type === "CreditNoteRefund Bill" ||
          type === "Prepayments" ||
          type === "Debit Notes",
      },
      {
        key: "Banking",
        match: (type) =>
          type === "Transfer" ||
          type === "Spend Overpayment" ||
          type === "Receive Overpayment" ||
          type === "Overpayment Refund AP" ||
          type === "Overpayment Refund AR" ||
          type === "Overpayment Refunds" ||
          type === "Manual Journals",
      },
      {
        key: "Contacts",
        match: (type) => type === "Contacts",
      },
      {
        key: "Inventory",
        match: (type) => type === "Inventory" || type === "Items",
      },
      {
        key: "Accounts",
        match: (type) => type === "Chart of Accounts",
      },
      {
        key: "Tracking",
        match: (type) => type === "Tracking Category" || type === "Classes",
      },
    ];

    const groups = categories.map((category) => ({
      label: category.key,
      types: [],
      match: category.match,
    }));
    const misc = { label: "Other", types: [] };

    types.forEach((type) => {
      const group = groups.find((item) => item.match(type));
      if (group) {
        group.types.push(type);
      } else {
        misc.types.push(type);
      }
    });

    const result = groups.filter((group) => group.types.length);
    if (misc.types.length) {
      result.push(misc);
    }
    return result;
  }, [types]);

  const exportSummary = useMemo(() => {
    if (!selectedTenantName) {
      return { downloaded: 0, noRecords: 0, errors: 0 };
    }
    const scopedResults = exportResults.filter((result) => {
      if (showAllTenants) return true;
      return result.tenantName === selectedTenantName;
    });
    const summary = {
      downloaded: 0,
      noRecords: 0,
      errors: 0,
    };
    scopedResults.forEach((result) => {
      if (result.status === "Ready") summary.downloaded += 1;
      if (result.status === "No records") summary.noRecords += 1;
      if (result.status === "Error") summary.errors += 1;
    });
    return summary;
  }, [exportResults, selectedTenantName, showAllTenants]);
  useEffect(() => {
    Object.keys(localStorage)
      .filter((key) => key.startsWith("xero_export_results_"))
      .forEach((key) => localStorage.removeItem(key));
    setExportResults([]);
    setShowHistory(false);
    setOpenTenants({});
    localStorage.removeItem("xero_user_token");
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
      } catch {
        // ignore invalid storage data
      }
    }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !userToken) return;
    const clearedKey = `xero_history_cleared_${user.id}`;
    if (localStorage.getItem(clearedKey)) return;
    fetch(`${API_BASE}/export/jobs/clear`, {
      method: "DELETE",
      headers: userHeader,
    })
      .then((res) => {
        if (res.ok) {
          localStorage.setItem(clearedKey, "1");
          setExportResults([]);
          setShowHistory(false);
          setOpenTenants({});
        }
      })
      .catch(() => {
        // ignore clear errors
      });
  }, [user?.id, userToken, userHeader]);

  useEffect(() => {
    if (!user?.id) return;
    localStorage.setItem(
      `xero_export_results_${user.id}`,
      JSON.stringify(exportResults)
    );
  }, [exportResults, user?.id]);

  useEffect(() => {
    const storedAdminToken = localStorage.getItem("xero_admin_token") || "";
    if (!storedAdminToken) return;
    setAdminToken(storedAdminToken);
    fetch(`${API_BASE}/admin/me`, {
      headers: { "x-admin-token": storedAdminToken },
    })
      .then((res) => res.json())
      .then((data) => {
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
      })
      .catch(() => {
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

  useEffect(() => {
    const updateFromPath = () => {
      setIsAdminPage(window.location.pathname === "/admin");
    };
    updateFromPath();
    window.addEventListener("popstate", updateFromPath);
    return () => window.removeEventListener("popstate", updateFromPath);
  }, []);

  const handleAuthSubmit = async () => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const endpoint = authMode === "signup" ? "signup" : "login";
      const res = await fetch(`${API_BASE}/user/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      const { data, rawText } = await parseApiResponse(res);
      if (!res.ok) {
        const fallback =
          rawText && !rawText.trim().startsWith("<")
            ? rawText
            : `Auth failed (${res.status})`;
        throw new Error(data.error || fallback);
      }
      setUserToken(data.token);
      setUser(data.user);
      setExportResults([]);
      setShowHistory(false);
      setOpenTenants({});
      setAuthEmail("");
      setAuthPassword("");
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch(`${API_BASE}/user/logout`, {
        method: "POST",
        headers: userHeader,
      });
    } catch {
      // ignore logout errors
    }
    localStorage.removeItem("xero_user_token");
    setUserToken("");
    setUser(null);
    setExportResults([]);
  };

  const handleClearHistory = async () => {
    if (!user?.id) return;
    setStatus("Clearing history...");
    try {
      const res = await fetch(`${API_BASE}/export/jobs/clear`, {
        method: "DELETE",
        headers: userHeader,
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
    const ready = exportResults.filter((item) => {
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
    setStatus(
      `Downloading ${ready.length} ${format.toUpperCase()} files${scope}...`
    );
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
  const statusTotal = statusBreakdown.reduce(
    (sum, item) => sum + (item.count || 0),
    0
  );
  const linePoints = adminVolume.map((item) => ({
    label: item.date,
    value: item.count || 0,
  }));
  const linePath = buildLinePath(linePoints, 400, 140);
  const donutSegments = statusBreakdown.map((item) => ({
    ...item,
    pct: statusTotal ? item.count / statusTotal : 0,
  }));
  const donutColors = {
    ready: "#2f6bff",
    running: "#f4b740",
    queued: "#8a93ad",
    no_records: "#ff6b6b",
    error: "#b94b4b",
  };

  const isChartEnabled = (key) => adminChartSelection.includes(key);
  const toggleChart = (key) => {
    setAdminChartSelection((prev) =>
      prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]
    );
  };

  if (isAdminPage) {
    return (
      <div className="admin-page">
        <div className="admin-shell">
          <div className="admin-header">
            <div>
              <h1>Admin Console</h1>
              <p>Private controls for users and data access.</p>
            </div>
            <button className="btn ghost" onClick={() => navigate("/")}>
              Back to App
            </button>
          </div>

          {!adminAuthed ? (
            <div className="admin-card">
              <h2>Login</h2>
              <p className="admin-note">
                First login password becomes permanent.
              </p>
              <label className="field">
                <span>Email</span>
                <input type="email" value={adminEmail} disabled />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                />
              </label>
              {adminError ? <div className="status-banner">{adminError}</div> : null}
              <div className="actions">
                <button
                  className="btn primary"
                  onClick={handleAdminLogin}
                  disabled={adminLoading}
                >
                  {adminLoading ? "Working..." : "Login"}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="admin-card">
                <div className="admin-card__header">
                  <div>
                    <h2>User Limits</h2>
                    <p>Manage maximum allowed users.</p>
                  </div>
                    <button
                      className="btn ghost btn-compact"
                      onClick={() => {
                        loadAdminSettings();
                        loadAdminUsers();
                        loadAdminTypes();
                        loadAdminAnalytics();
                      }}
                      disabled={adminLoading}
                    >
                    {adminLoading ? "Loading..." : "Refresh"}
                  </button>
                </div>
                <div className="admin-card__content">
                  <label className="field">
                    <span>Max Users</span>
                    <input
                      type="number"
                      min="1"
                      value={adminLimit}
                      onChange={(e) => setAdminLimit(e.target.value)}
                    />
                  </label>
                  <div className="admin-panel__meta">
                    Current users: {adminSettings?.currentUsers ?? "-"}
                  </div>
                  <div className="actions">
                    <button
                      className="btn primary"
                      onClick={handleSaveAdminSettings}
                      disabled={adminLoading}
                    >
                      {adminLoading ? "Saving..." : "Save Settings"}
                    </button>
                    <button
                      className="btn ghost"
                      type="button"
                      onClick={handleAdminLogout}
                      disabled={adminLoading}
                    >
                      Logout Admin
                    </button>
                  </div>
                  {adminError ? <div className="status-banner">{adminError}</div> : null}
                  {adminSuccess ? (
                    <div className="status-banner">{adminSuccess}</div>
                  ) : null}
                </div>
              </div>

              <div className="admin-card admin-card--analytics">
                <div className="admin-card__header">
                  <div>
                    <h2>Analytics</h2>
                    <p>Power BI style overview for owner visibility.</p>
                  </div>
                  <div className="admin-analytics-actions">
                    <select
                      value={adminAnalyticsDays}
                      onChange={(e) => {
                        const next = Number.parseInt(e.target.value, 10);
                        setAdminAnalyticsDays(next);
                        loadAdminAnalytics("", next);
                      }}
                    >
                      <option value={7}>Last 7 days</option>
                      <option value={30}>Last 30 days</option>
                      <option value={90}>Last 90 days</option>
                      <option value={180}>Last 180 days</option>
                      <option value={365}>Last 12 months</option>
                    </select>
                    <button
                      className="btn ghost btn-compact"
                      type="button"
                      onClick={() => loadAdminAnalytics()}
                      disabled={adminAnalyticsLoading}
                    >
                      {adminAnalyticsLoading ? "Loading..." : "Refresh"}
                    </button>
                  </div>
                </div>
                <div className="admin-card__content">
                  <div className="admin-filter-bar">
                    <label className="field">
                      <span>Tenant Filter</span>
                      <select
                        value={adminFilterTenant}
                        onChange={(e) => setAdminFilterTenant(e.target.value)}
                      >
                        <option value="">All tenants</option>
                        {adminTenants.map((tenant) => (
                          <option key={tenant} value={tenant}>
                            {tenant}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>User Filter</span>
                      <select
                        value={adminFilterUser}
                        onChange={(e) => setAdminFilterUser(e.target.value)}
                      >
                        <option value="">All users</option>
                        {adminUsersList.map((userEmail) => (
                          <option key={userEmail} value={userEmail}>
                            {userEmail}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="admin-filter-actions">
                      <button
                        className="btn ghost btn-compact"
                        type="button"
                        onClick={() => {
                          setAdminFilterTenant("");
                          setAdminFilterUser("");
                        }}
                      >
                        Clear Filters
                      </button>
                      <button
                        className="btn ghost btn-compact"
                        type="button"
                        onClick={handleClearAllExports}
                        disabled={adminCleanupLoading}
                      >
                        {adminCleanupLoading ? "Clearing..." : "Clear All Exports"}
                      </button>
                    </div>
                  </div>

                  <div className="admin-chart-filter">
                    {[
                      { key: "line", label: "Exports/Day" },
                      { key: "monthlyTenants", label: "Monthly Tenants" },
                      { key: "userWorkload", label: "User Workload" },
                      { key: "statusSplit", label: "Status Split" },
                      { key: "monthlyUsers", label: "Monthly Users" },
                      { key: "userStatusMix", label: "User Status Mix" },
                      { key: "userTenants", label: "User -> Tenants" },
                      { key: "tenantUserMatrix", label: "Tenant × User" },
                      { key: "recentActivity", label: "Recent Activity" },
                    ].map((item) => (
                      <label className="admin-chart-chip" key={item.key}>
                        <input
                          type="checkbox"
                          checked={isChartEnabled(item.key)}
                          onChange={() => toggleChart(item.key)}
                        />
                        {item.label}
                      </label>
                    ))}
                  </div>

                  {adminAnalyticsError ? (
                    <div className="status-banner">{adminAnalyticsError}</div>
                  ) : null}
                  {adminCleanupStatus ? (
                    <div className="status-banner">{adminCleanupStatus}</div>
                  ) : null}
                  {!adminAnalytics && !adminAnalyticsLoading ? (
                    <div className="status-banner">No analytics yet.</div>
                  ) : null}
                  {adminAnalytics ? (
                    <div className="admin-analytics">
                      <div className="admin-metrics">
                        <div className="admin-metric-card">
                          <p>Total Exports</p>
                          <h3>{formatCount(adminTotals.exports)}</h3>
                          <span>
                            Ready {formatCount(adminTotals.exportsReady)} · Errors{" "}
                            {formatCount(adminTotals.exportsError)}
                          </span>
                        </div>
                        <div className="admin-metric-card">
                          <p>Users</p>
                          <h3>{formatCount(adminTotals.activeUsers)}</h3>
                          <span>
                            Active · Disabled {formatCount(adminTotals.disabledUsers)}
                          </span>
                        </div>
                        <div className="admin-metric-card">
                          <p>Success Rate</p>
                          <h3>
                            {formatPercent(adminAnalytics?.successRate?.readyPct)}
                          </h3>
                          <span>
                            Avg time{" "}
                            {formatDuration(adminAnalytics?.avgDurationMs) || "-"}
                          </span>
                        </div>
                        <div className="admin-metric-card">
                          <p>Latest Export</p>
                          <h3>
                            {adminAnalytics?.latestExportAt
                              ? formatDateTime(adminAnalytics.latestExportAt)
                              : "-"}
                          </h3>
                          <span>Queue {formatCount(adminTotals.exportsQueued)}</span>
                        </div>
                      </div>

                      <div className="admin-analytics-grid">
                        {isChartEnabled("line") ? (
                        <div className="admin-chart">
                          <div className="admin-chart__header">
                            <h4>Exports per day</h4>
                            <span>{adminAnalytics.rangeDays} days</span>
                          </div>
                          <svg
                            className="admin-line-chart"
                            viewBox="0 0 400 160"
                            role="img"
                            aria-label="Exports per day"
                          >
                            <path
                              className="admin-line-chart__grid"
                              d="M 0 140 L 400 140"
                            />
                            <path
                              className="admin-line-chart__path"
                              d={linePath}
                            />
                            {linePoints.map((point, index) => {
                              const x = (index / (linePoints.length - 1 || 1)) * 400;
                              const y = 140 - (point.value / maxVolume) * 140;
                              return (
                                <circle
                                  key={point.label}
                                  cx={x}
                                  cy={y}
                                  r="3"
                                  className="admin-line-chart__dot"
                                >
                                  <title>
                                    {point.label}: {point.value}
                                  </title>
                                </circle>
                              );
                            })}
                          </svg>
                        </div>
                        ) : null}

                        {isChartEnabled("monthlyTenants") ? (
                        <div className="admin-chart admin-chart--bar">
                          <div className="admin-chart__header">
                            <h4>Monthly Tenants</h4>
                            <span>Tenants worked per month</span>
                          </div>
                          <div className="admin-month-bars">
                            {monthlyTenantCounts.length ? (
                              monthlyTenantCounts.map((item) => (
                                <button
                                  className="admin-month-bar"
                                  type="button"
                                  key={item.month}
                                  onMouseEnter={() => setHoverTenantMonth(item)}
                                  onFocus={() => setHoverTenantMonth(item)}
                                  onMouseLeave={() => setHoverTenantMonth(null)}
                                  onBlur={() => setHoverTenantMonth(null)}
                                >
                                  <div
                                    className="admin-month-bar__fill"
                                    style={{
                                      height: `${Math.round(
                                        (item.tenantCount /
                                          getMax(monthlyTenantCounts, "tenantCount")) *
                                          100
                                      )}%`,
                                    }}
                                  />
                                  <span className="admin-month-bar__label">
                                    {formatMonthLabel(item.month)}
                                  </span>
                                </button>
                              ))
                            ) : (
                              <div className="status-banner">
                                No monthly tenant data yet.
                              </div>
                            )}
                          </div>
                          {hoverTenantMonth ? (
                            <div className="admin-tooltip">
                              <strong>{formatMonthLabel(hoverTenantMonth.month)}</strong>
                              <span>
                                Tenants:{" "}
                                {formatCount(hoverTenantMonth.tenantCount)}
                              </span>
                              <span>
                                Exports:{" "}
                                {formatCount(hoverTenantMonth.exportCount)}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        ) : null}

                        {isChartEnabled("userWorkload") ? (
                        <div className="admin-chart admin-chart--list">
                          <div className="admin-chart__header">
                            <h4>User Workload</h4>
                            <span>Most active users</span>
                          </div>
                          <div className="admin-mini-list">
                            {topUsers.length ? (
                              topUsers.map((item) => (
                                <div className="admin-mini-row" key={item.userId}>
                                  <div className="admin-mini-row__label">
                                    {item.email}
                                  </div>
                                  <div className="admin-mini-row__bar">
                                    <div
                                      className="admin-mini-row__fill"
                                      style={{
                                        width: `${Math.round(
                                          (item.count / getMax(topUsers, "count")) * 100
                                        )}%`,
                                      }}
                                    />
                                  </div>
                                  <div className="admin-mini-row__value">
                                    {formatCount(item.count)}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="status-banner">No user activity yet.</div>
                            )}
                          </div>
                        </div>
                        ) : null}
                      </div>

                      <div className="admin-analytics-grid">
                        {isChartEnabled("statusSplit") ? (
                        <div className="admin-chart admin-chart--donut">
                          <div className="admin-chart__header">
                            <h4>Status Split</h4>
                            <span>All exports</span>
                          </div>
                          <div className="admin-donut">
                            <svg viewBox="0 0 160 160" aria-label="Status split">
                              {donutSegments.reduce(
                                (acc, segment, index) => {
                                  const radius = 60;
                                  const circumference = 2 * Math.PI * radius;
                                  const offset = acc.offset;
                                  const length = segment.pct * circumference;
                                  acc.offset += length;
                                  acc.segments.push(
                                    <circle
                                      key={`${segment.key}-${index}`}
                                      cx="80"
                                      cy="80"
                                      r={radius}
                                      fill="transparent"
                                      stroke={donutColors[segment.key] || "#2f6bff"}
                                      strokeWidth="18"
                                      strokeDasharray={`${length} ${circumference - length}`}
                                      strokeDashoffset={-offset}
                                    />
                                  );
                                  return acc;
                                },
                                { offset: 0, segments: [] }
                              ).segments}
                              <circle cx="80" cy="80" r="42" fill="#ffffff" />
                            </svg>
                            <div className="admin-donut__center">
                              <strong>{formatCount(statusTotal)}</strong>
                              <span>Total</span>
                            </div>
                          </div>
                          <div className="admin-donut-legend">
                            {donutSegments.map((segment) => (
                              <div className="admin-donut-legend__item" key={segment.key}>
                                <span
                                  className="admin-donut-legend__swatch"
                                  style={{
                                    backgroundColor:
                                      donutColors[segment.key] || "#2f6bff",
                                  }}
                                />
                                <span>{segment.label}</span>
                                <strong>{formatCount(segment.count)}</strong>
                              </div>
                            ))}
                          </div>
                        </div>
                        ) : null}

                        {isChartEnabled("monthlyUsers") ? (
                        <div className="admin-chart admin-chart--bar">
                          <div className="admin-chart__header">
                            <h4>Monthly User Exports</h4>
                            <span>Top users by month</span>
                          </div>
                          <div className="admin-month-bars admin-month-bars--stacked">
                            {monthlyUserCounts.length ? (
                              monthlyUserCounts.map((item) => {
                                const total = item.users.reduce(
                                  (sum, user) => sum + user.count,
                                  0
                                );
                                return (
                                  <button
                                    className="admin-month-bar admin-month-bar--stacked"
                                    type="button"
                                    key={item.month}
                                    onMouseEnter={() => setHoverUserMonth(item)}
                                    onFocus={() => setHoverUserMonth(item)}
                                    onMouseLeave={() => setHoverUserMonth(null)}
                                    onBlur={() => setHoverUserMonth(null)}
                                  >
                                    <div className="admin-month-bar__stack">
                                      {item.users.map((user) => (
                                        <span
                                          key={`${item.month}-${user.userId}`}
                                          style={{
                                            height: `${total
                                              ? (user.count / total) * 100
                                              : 0}%`,
                                          }}
                                        />
                                      ))}
                                    </div>
                                    <span className="admin-month-bar__label">
                                      {formatMonthLabel(item.month)}
                                    </span>
                                  </button>
                                );
                              })
                            ) : (
                              <div className="status-banner">
                                No monthly user data yet.
                              </div>
                            )}
                          </div>
                          {hoverUserMonth ? (
                            <div className="admin-tooltip">
                              <strong>{formatMonthLabel(hoverUserMonth.month)}</strong>
                              {hoverUserMonth.users.map((user) => (
                                <span key={`${hoverUserMonth.month}-${user.userId}`}>
                                  {user.email}: {formatCount(user.count)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        ) : null}

                        {isChartEnabled("userStatusMix") ? (
                        <div className="admin-chart admin-chart--list">
                          <div className="admin-chart__header">
                            <h4>User Status Mix</h4>
                            <span>Top 6 users</span>
                          </div>
                          <div className="admin-stacked-list">
                            {userStatusBreakdown.length ? (
                              userStatusBreakdown.map((item) => {
                                const total = item.total || 0;
                                const ready = item.statuses.ready || 0;
                                const error = item.statuses.error || 0;
                                const queued = item.statuses.queued || 0;
                                const running = item.statuses.running || 0;
                                const noRecords = item.statuses.no_records || 0;
                                return (
                                  <div className="admin-stacked-row" key={item.userId}>
                                    <div className="admin-stacked-row__label">
                                      {item.email}
                                    </div>
                                    <div className="admin-stacked-row__bar">
                                      <span
                                        style={{
                                          width: total
                                            ? `${(ready / total) * 100}%`
                                            : "0%",
                                          background: donutColors.ready,
                                        }}
                                      />
                                      <span
                                        style={{
                                          width: total
                                            ? `${(running / total) * 100}%`
                                            : "0%",
                                          background: donutColors.running,
                                        }}
                                      />
                                      <span
                                        style={{
                                          width: total
                                            ? `${(queued / total) * 100}%`
                                            : "0%",
                                          background: donutColors.queued,
                                        }}
                                      />
                                      <span
                                        style={{
                                          width: total
                                            ? `${(noRecords / total) * 100}%`
                                            : "0%",
                                          background: donutColors.no_records,
                                        }}
                                      />
                                      <span
                                        style={{
                                          width: total
                                            ? `${(error / total) * 100}%`
                                            : "0%",
                                          background: donutColors.error,
                                        }}
                                      />
                                    </div>
                                    <div className="admin-stacked-row__value">
                                      {formatCount(total)}
                                    </div>
                                  </div>
                                );
                              })
                            ) : (
                              <div className="status-banner">
                                No user status data yet.
                              </div>
                            )}
                          </div>
                        </div>
                        ) : null}

                        {isChartEnabled("userTenants") ? (
                        <div className="admin-chart admin-chart--list">
                          <div className="admin-chart__header">
                            <h4>{"User -> Tenants"}</h4>
                            <span>Who worked on what</span>
                          </div>
                          <div className="admin-mini-list">
                            {topUserTenants.length ? (
                              topUserTenants.map((item) => (
                                <div className="admin-mini-row" key={item.userId}>
                                  <div className="admin-mini-row__label">
                                    {item.email}
                                  </div>
                                  <div className="admin-mini-row__value">
                                    {item.tenants
                                      .map((tenant) => tenant.tenant)
                                      .join(", ")}
                                  </div>
                                </div>
                              ))
                            ) : (
                              <div className="status-banner">
                                No tenant activity yet.
                              </div>
                            )}
                          </div>
                        </div>
                        ) : null}
                      </div>

                      {isChartEnabled("tenantUserMatrix") ? (
                      <div className="admin-chart admin-chart--table">
                        <div className="admin-chart__header">
                          <h4>Tenant x User Exports</h4>
                          <span>Who exported which tenant</span>
                        </div>
                        {tenantUserMatrix.length ? (
                          <div className="admin-matrix">
                            <div className="admin-matrix__header">
                              <span>Tenant</span>
                              {tenantUserMatrix[0]?.users?.map((user) => (
                                <span key={user.userId} title={user.email}>
                                  {user.email}
                                </span>
                              ))}
                              <span>Total</span>
                            </div>
                            {tenantUserMatrix.map((row) => (
                              <div className="admin-matrix__row" key={row.tenant}>
                                <span className="admin-matrix__tenant">
                                  {row.tenant}
                                </span>
                                {row.users.map((user) => (
                                  <span
                                    className={`admin-matrix__cell ${
                                      user.count ? "is-active" : ""
                                    }`}
                                    key={`${row.tenant}-${user.userId}`}
                                  >
                                    {formatCount(user.count)}
                                  </span>
                                ))}
                                <span className="admin-matrix__total">
                                  {formatCount(row.total)}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="status-banner">No tenant-user data yet.</div>
                        )}
                      </div>
                      ) : null}

                      {isChartEnabled("recentActivity") ? (
                      <div className="admin-chart admin-chart--table">
                        <div className="admin-chart__header">
                          <h4>Recent User Activity</h4>
                          <span>Latest exports</span>
                        </div>
                        {recentActivity.length ? (
                          <div className="admin-activity">
                            <div className="admin-activity__header">
                              <span>User</span>
                              <span>Tenant</span>
                              <span>Status</span>
                              <span>When</span>
                              <span>Count</span>
                            </div>
                            {recentActivity.map((item) => (
                              <div className="admin-activity__row" key={item.jobId}>
                                <span>{item.email}</span>
                                <span>{item.tenant}</span>
                                <span className={`status-pill status-${item.status}`}>
                                  {item.status}
                                </span>
                                <span>{formatDateTime(item.createdAt)}</span>
                                <span>{formatCount(item.count)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="status-banner">No recent activity.</div>
                        )}
                      </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card__header">
                  <div>
                    <h2>Type Access</h2>
                    <p>Selected types will be allowed for export.</p>
                  </div>
                </div>
                <div className="admin-card__content">
                  <div className="admin-type-list">
                    {adminTypes.map((type) => (
                      <label className="type-item" key={`admin-type-${type}`}>
                        <input
                          type="checkbox"
                          checked={adminTypeSelection.includes(type)}
                          onChange={(e) => toggleAdminType(type, e.target.checked)}
                        />
                        {type}
                      </label>
                    ))}
                  </div>
                  <div className="actions">
                    <button
                      className="btn ghost btn-compact"
                      type="button"
                      onClick={() => setAdminTypeSelection(adminTypes)}
                    >
                      Select All
                    </button>
                    <button
                      className="btn ghost btn-compact"
                      type="button"
                      onClick={() => setAdminTypeSelection([])}
                    >
                      Clear All
                    </button>
                  </div>
                </div>
              </div>

              <div className="admin-card">
                <div className="admin-card__header">
                  <div>
                    <h2>Users</h2>
                    <p>Enable or disable user access.</p>
                  </div>
                </div>
                <div className="admin-card__content">
                  {adminUsers.length ? (
                    <div className="admin-user-list">
                      {adminUsers.map((userItem) => (
                        <div className="admin-user" key={userItem.id}>
                          <div>
                            <div className="admin-user__email">{userItem.email}</div>
                            <div className="admin-user__meta">
                              {userItem.createdAt
                                ? formatDateTime(userItem.createdAt)
                                : ""}
                            </div>
                          </div>
                          <button
                            className={`btn ${
                              userItem.disabled ? "primary" : "ghost"
                            } btn-compact`}
                            type="button"
                            onClick={() =>
                              handleToggleUser(userItem.id, !userItem.disabled)
                            }
                            disabled={adminLoading}
                          >
                            {userItem.disabled ? "Enable" : "Disable"}
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="status-banner">No users found.</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const buildDetail = ({ count, rateInfo, statusValue, error, progress, startedAt }) => {
    if (statusValue === "Error") {
      return error || "Export failed";
    }
    const rateParts = [];
    if (rateInfo?.day) rateParts.push(`day ${rateInfo.day}`);
    if (rateInfo?.minute) rateParts.push(`min ${rateInfo.minute}`);
    if (rateInfo?.appMinute) rateParts.push(`app ${rateInfo.appMinute}`);
    const rateDetail = rateParts.length
      ? `Remaining: ${rateParts.join(" / ")}`
      : "";
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
      error: "Error",
    };
    const statusValue = statusMap[job.status] || "In progress";
    const detail = buildDetail({
      count: job.count,
      rateInfo: job.rate,
      statusValue,
      error: job.error,
      progress: job.progress,
      startedAt: job.startedAt,
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
      excelUrl:
        statusValue === "Ready"
          ? `${baseDownload}?format=excel&userToken=${userTokenValue}`
          : null,
      csvUrl:
        statusValue === "Ready"
          ? `${baseDownload}?format=csv&userToken=${userTokenValue}`
          : null,
      jsonUrl:
        statusValue === "Ready"
          ? `${baseDownload}?format=json&userToken=${userTokenValue}`
          : null,
    };
  };

  const groupedResults = useMemo(() => {
    const groups = new Map();
    exportResults.forEach((item) => {
      const key = item.tenantName || "Unknown tenant";
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(item);
    });
    return Array.from(groups.entries()).map(([tenant, items]) => ({
      tenant,
      items,
    }));
  }, [exportResults]);

  useEffect(() => {
    if (!showHistory) return;
    if (selectedTenantName) {
      // history stays grouped by tenant
    }
  }, [showHistory, selectedTenantName]);
  const loadTypes = () => {
    setTypesLoading(true);
    setTypesError("");
    fetch(`${API_BASE}/types`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || "Failed to load data types");
        }
        setTypes(data.types || []);
      })
      .catch((err) => {
        setTypes([]);
        setTypesError(err.message);
      })
      .finally(() => setTypesLoading(false));
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
      window.history.replaceState({}, document.title, "/");
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return;

    setStatus("Exchanging code for token...");
    fetch(`${API_BASE}/auth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.sessionId) {
          localStorage.setItem("xero_session", data.sessionId);
          setSessionId(data.sessionId);
          setStatus("Connected. Fetch tenants...");
          window.history.replaceState({}, document.title, "/");
        } else {
          setStatus(data.error || "Auth failed");
        }
      })
      .catch((err) => setStatus(err.message));
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
    if (!sessionId) {
      return;
    }
    fetch(`${API_BASE}/tenants`, { headers: sessionHeader })
      .then((res) => res.json())
      .then((data) => {
        const list = data.tenants || [];
        setTenants(list);
        if (!list.length) {
          setSelectedTenant("");
        }
        if (data.error) {
          setStatus(data.error);
          if (data.error.includes("Session")) {
            localStorage.removeItem("xero_session");
            setSessionId("");
          }
        }
      })
      .catch((err) => setStatus(err.message));
  }, [sessionId, sessionHeader]);

  useEffect(() => {
    if (!userToken) {
      return;
    }
    fetch(`${API_BASE}/export/jobs`, {
      headers: userHeader,
    })
      .then((res) => res.json())
      .then((data) => {
        const jobs = Array.isArray(data.jobs) ? data.jobs : [];
        if (!jobs.length) return;
        const mapped = jobs.map((job) => mapJobToResult(job, userToken));
        setExportResults((prev) => {
          const existing = new Set(prev.map((item) => item.jobId));
          const merged = [...prev];
          mapped.forEach((item) => {
            if (!existing.has(item.jobId)) {
              merged.push(item);
            }
          });
          return merged;
        });
      })
      .catch(() => {
        // ignore restore errors
      });
  }, [userToken, userHeader]);

  const handleConnect = async () => {
    const res = await fetch(`${API_BASE}/auth/start`);
    const data = await res.json();
    if (data.authUrl) {
      localStorage.setItem("xero_last_auth_url", data.authUrl);
      setLastAuthUrl(data.authUrl);
      setAuthUrl(data.authUrl);
      window.location.href = data.authUrl;
    }
  };

  useEffect(() => {
    const pending = exportResults.filter(
      (item) =>
        item.jobId &&
        (item.status === "Queued" ||
          item.status === "In progress" ||
          (item.status === "Ready" && !item.excelUrl))
    );
    if (!pending.length || !sessionId) {
      return;
    }
    const interval = setInterval(async () => {
      for (const item of pending) {
        try {
          const res = await fetch(`${API_BASE}/export/status?jobId=${item.jobId}`, {
            headers: authHeaders,
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
            error: "Error",
          };
          const statusValue = statusMap[data.status] || "In progress";
          const detail = buildDetail({
            count: data.count,
            rateInfo: data.rate,
            statusValue,
            error: data.error,
            progress: data.progress,
            startedAt: data.startedAt,
          });
          const baseDownload = `${API_BASE}/export/download/${item.jobId}`;
          const excelUrl = `${baseDownload}?format=excel&userToken=${userToken}`;
          const csvUrl = `${baseDownload}?format=csv&userToken=${userToken}`;
          const jsonUrl = `${baseDownload}?format=json&userToken=${userToken}`;

          setExportResults((prev) =>
            prev.map((entry) =>
              entry.jobId === item.jobId
                ? {
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
                    jsonUrl: statusValue === "Ready" ? jsonUrl : entry.jsonUrl,
                  }
                : entry
            )
          );
        } catch {
          // ignore polling errors
        }
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [exportResults, authHeaders, userToken, sessionId]);
  const handleUseLatestSession = async () => {
    setIsCheckingSession(true);
    try {
      const stored = localStorage.getItem("xero_session");
      if (stored) {
        setSessionId(stored);
        setStatus("Using stored session. Fetch tenants...");
        return;
      }
      const res = await fetch(`${API_BASE}/session/latest`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "No recent session found");
      }
      localStorage.setItem("xero_session", data.sessionId);
      setSessionId(data.sessionId);
      setStatus("Connected. Fetch tenants...");
    } catch (err) {
      setStatus(err.message);
    } finally {
      setIsCheckingSession(false);
    }
  };

  const handleToggleAllTypes = (checked) => {
    if (checked) {
      setSelectedTypes(types);
    } else {
      setSelectedTypes([]);
    }
  };

  const handleToggleGroup = (groupTypes, checked) => {
    if (checked) {
      setSelectedTypes((prev) => Array.from(new Set([...prev, ...groupTypes])));
    } else {
      setSelectedTypes((prev) => prev.filter((type) => !groupTypes.includes(type)));
    }
  };

  const handleToggleType = (type, checked) => {
    if (checked) {
      setSelectedTypes((prev) => [...prev, type]);
    } else {
      setSelectedTypes((prev) => prev.filter((item) => item !== type));
    }
  };

  const handleExport = async () => {
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
    setExportResults((prev) => [
      ...prev,
      ...selectedTypes.map((type) => ({
        runId,
        type,
        status: "Queued",
        detail: "Queued",
        createdAt: Date.now(),
      })),
    ]);

    try {
      let successCount = 0;
      for (const type of selectedTypes) {
        setStatus(`Starting ${type}...`);
        const payload = {
          type,
          tenantId: selectedTenant,
          tenantName: selectedTenantName,
          format: "all",
          from: fromDate || undefined,
          to: toDate || undefined,
        };
        const res = await fetch(`${API_BASE}/export/start`, {
          method: "POST",
          headers: { ...authHeaders, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          let message = `Export failed for ${type}`;
          try {
            const data = await res.json();
            message = data.error || message;
          } catch {
            // ignore parse errors and keep default message
          }
          setExportResults((prev) =>
            prev.map((item) =>
              item.runId === runId && item.type === type
                ? { ...item, status: "Error", detail: message }
                : item
            )
          );
          continue;
        }
        const data = await res.json();
        setExportResults((prev) =>
          prev.map((item) =>
            item.runId === runId && item.type === type
              ? { ...item, status: "Queued", detail: "Queued", jobId: data.jobId }
              : item
          )
        );
        successCount += 1;
      }
      setStatus(`Export jobs started for ${successCount} types.`);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRetry = async (jobId) => {
    if (!userToken) {
      setStatus("Please login first.");
      return;
    }
    setStatus("Retrying export...");
    try {
      const res = await fetch(`${API_BASE}/export/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...userHeader },
        body: JSON.stringify({ jobId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Retry failed");
      }
      const newJob = {
        jobId: data.jobId,
        status: data.status || "queued",
        type: exportResults.find((item) => item.jobId === jobId)?.type || "",
        tenantName:
          exportResults.find((item) => item.jobId === jobId)?.tenantName || null,
      };
      const mapped = mapJobToResult(
        {
          jobId: newJob.jobId,
          type: newJob.type,
          tenantName: newJob.tenantName,
          status: newJob.status,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        userToken
      );
      setExportResults((prev) => [...prev, mapped]);
      setStatus("Retry queued.");
    } catch (err) {
      setStatus(err.message);
    }
  };

  if (!user) {
    return (
      <div className="auth-layout">
        <div className="auth-hero">
          <div className="brand-mark">
            <span>Xero Tool</span>
          </div>
          <h1>Premium exports, zero clutter.</h1>
          <p>
            A refined workspace to connect Xero, pick data types, and download
            structured files with clarity and speed.
          </p>
          <div className="auth-badges">
            <span>Instant setup</span>
            <span>Safe throttling</span>
            <span>Multi-tenant ready</span>
          </div>
        </div>
        <div className="auth-panel">
          <div className="auth-card">
            <div className="auth-header">
              <h2>Welcome back</h2>
              <p>Sign in to see export history and downloads.</p>
            </div>
            <div className="auth-tabs">
              <button
                className={`btn ${authMode === "login" ? "primary" : "ghost"}`}
                onClick={() => setAuthMode("login")}
              >
                Login
              </button>
              <button
                className={`btn ${authMode === "signup" ? "primary" : "ghost"}`}
                onClick={() => setAuthMode("signup")}
              >
                Create Account
              </button>
            </div>
            <div className="auth-form">
              <label className="field">
                <span>Email</span>
                <input
                  type="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </label>
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  placeholder="********"
                />
              </label>
              {authError ? <p className="auth-error">{authError}</p> : null}
              <button
                className="btn primary"
                onClick={handleAuthSubmit}
                disabled={authLoading}
              >
                {authLoading ? "Working..." : authMode === "signup" ? "Create" : "Login"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-dot" />
          <div>
            <div className="sidebar-title">Xero Tool</div>
            <div className="sidebar-sub">Executive Console</div>
          </div>
        </div>
        <div className="sidebar-cta">
          <button className="btn primary btn-compact" onClick={handleConnect}>
            Connect to Xero
          </button>
        </div>
        <nav className="nav">
          <button
            className="nav-item nav-item--active"
            type="button"
            onClick={() => overviewRef.current?.scrollIntoView({ behavior: "smooth" })}
          >
            <span className="nav-icon nav-icon--overview" aria-hidden="true" />
            Overview
          </button>
          <button
            className={`nav-item ${showHistory ? "nav-item--active" : ""}`}
            type="button"
            onClick={() => {
              setShowHistory(true);
              resultsRef.current?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <span className="nav-icon nav-icon--history" aria-hidden="true" />
            History
          </button>
          <button
            className="nav-item"
            type="button"
            onClick={() => filtersRef.current?.scrollIntoView({ behavior: "smooth" })}
          >
            <span className="nav-icon nav-icon--filters" aria-hidden="true" />
            Filters
          </button>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-actions">
            <button className="btn ghost btn-compact" onClick={handleUseLatestSession}>
              {isCheckingSession ? "Checking..." : "Use Latest Session"}
            </button>
            <button className="btn ghost btn-compact" onClick={handleLogout}>
              Logout
            </button>
          </div>
          <div className="user-pill">{user?.email || "Signed in"}</div>
        </div>
      </aside>

      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-dot" />
            <span>Command Center</span>
          </div>
        </header>

        <section className="overview-strip" ref={overviewRef}>
          <div>
            <p className="kicker">Xero Data Extraction</p>
            <h1>Precision exports, premium workflow.</h1>
            <p className="sub">
              Curated controls for date ranges, tenants, and data types. Export to
              Excel, CSV, or JSON with confidence.
            </p>
          </div>
          <div className="hero-status">
            <span>{isConnected ? "Connected" : "Not connected"}</span>
            {selectedTenantName ? <span>{selectedTenantName}</span> : null}
            {user?.email ? <span>{user.email}</span> : null}
          </div>
        </section>

        <section className="hero-grid">
          <div className="hero-metrics">
            <div className="stat-card">
              <p className="stat-label">Connection</p>
              <p className="stat-value">{isConnected ? "Active" : "Idle"}</p>
              <p className="stat-sub">
                {selectedTenantName || "No tenant selected"}
              </p>
            </div>
            <div className="stat-card">
              <p className="stat-label">Types Selected</p>
              <p className="stat-value">{selectedTypes.length}</p>
              <p className="stat-sub">Total available: {types.length}</p>
            </div>
            <div className="stat-card">
              <p className="stat-label">Exports Ready</p>
              <p className="stat-value">{exportSummary.downloaded}</p>
              <p className="stat-sub">
                No records: {exportSummary.noRecords} | Errors: {exportSummary.errors}
              </p>
            </div>
          </div>
        </section>
        <section className="workspace" ref={filtersRef}>
        <div className="panel filters-panel">
          <div className="panel-header">
            <div>
              <h2>Filters</h2>
              <p>Scope your export before starting a run.</p>
            </div>
            <div className="panel-actions">
              <button
                className="btn ghost"
                onClick={() => {
                  setSelectedTenant("");
                  setStatus("Pick another tenant to switch.");
                }}
                disabled={!sessionId}
              >
                Switch Tenant
              </button>
              <button
                className="btn ghost"
                onClick={() => {
                  localStorage.removeItem("xero_session");
                  setSessionId("");
                  setTenants([]);
                  setSelectedTenant("");
                  setStatus("Disconnected");
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
          <div className="grid">
            <label className="field">
              <span>From</span>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </label>
            <label className="field">
              <span>To</span>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Tenant</span>
              <select
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
              >
                <option value="">Select tenant</option>
                {tenants.map((tenant) => (
                  <option key={tenant.tenantId} value={tenant.tenantId}>
                    {tenant.tenantName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="preset-row">
            <span className="preset-label">Quick range</span>
            <button className="btn ghost btn-compact" onClick={() => applyPreset(7)}>
              Last 7 days
            </button>
            <button className="btn ghost btn-compact" onClick={() => applyPreset(30)}>
              Last 30 days
            </button>
            <button className="btn ghost btn-compact" onClick={() => applyPreset(90)}>
              Last 90 days
            </button>
            <button className="btn ghost btn-compact" onClick={() => applyPreset(365)}>
              Last 12 months
            </button>
          </div>
        </div>

        <div className="panel types-panel">
          <div className="panel-header">
            <div>
              <h2>Data Types</h2>
              <p>Choose what you want to extract.</p>
            </div>
            <div className="type-meta">
              {selectedTypes.length} selected
              <button
                className="btn ghost btn-compact"
                type="button"
                onClick={loadTypes}
                disabled={typesLoading}
              >
                {typesLoading ? "Loading..." : "Reload Types"}
              </button>
            </div>
          </div>
          {typesError ? (
            <div className="status-banner">Types not loaded: {typesError}</div>
          ) : null}
          <div className="type-list">
            <div className="type-toolbar">
              <label className="type-item">
                <input
                  type="checkbox"
                  checked={selectedTypes.length === types.length && types.length > 0}
                  onChange={(e) => handleToggleAllTypes(e.target.checked)}
                />
                Select all
              </label>
            </div>
            <div className="type-groups">
              {groupedTypes.map((group) => {
                const groupAllSelected = group.types.every((type) =>
                  selectedTypes.includes(type)
                );
                return (
                  <div className="type-group" key={group.label}>
                    <div className="type-group__header">
                      <div className="type-group__title">{group.label}</div>
                      <label className="type-item type-item--muted">
                        <input
                          type="checkbox"
                          checked={groupAllSelected}
                          onChange={(e) =>
                            handleToggleGroup(group.types, e.target.checked)
                          }
                        />
                        Select group
                      </label>
                    </div>
                    <div className="type-group__list">
                      {group.types.map((type) => (
                        <label className="type-item" key={type}>
                          <input
                            type="checkbox"
                            checked={selectedTypes.includes(type)}
                            onChange={(e) =>
                              handleToggleType(type, e.target.checked)
                            }
                          />
                          {type}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="actions actions--sticky">
            <button
              className="btn primary"
              onClick={handleExport}
              disabled={
                isLoading || !sessionId || !selectedTenant || !selectedTypes.length
              }
            >
              {isLoading ? "Exporting..." : "Download Files"}
            </button>
          </div>
        </div>
      </section>
        <section className="panel results-panel" ref={resultsRef}>
          <div className="panel-header panel-header--results">
          <div className="panel-title">
              <h2>Export Results</h2>
              <p>Track what is ready and download instantly.</p>
            </div>
          <div className="results-actions">
            {showHistory ? (
              <button
                className="btn ghost btn-compact"
                onClick={handleClearHistory}
                disabled={!exportResults.length}
                type="button"
              >
                Clear History
              </button>
            ) : null}
            {showHistory && exportResults.length ? (
              <div className="export-filter">
                <span className="export-filter__note">Grouped by tenant</span>
              </div>
            ) : null}
            </div>
          </div>

        <div className="status-banner">{status}</div>

        {showHistory ? (
          exportResults.length ? (
            showAllTenants && groupByTenant ? (
              <div className="tenant-groups">
                {groupedResults.map((group) => (
                  <div className="tenant-group" key={group.tenant}>
                    <div className="tenant-group__header">
                      <button
                        className="tenant-group__toggle"
                        type="button"
                        onClick={() =>
                          setOpenTenants((prev) => ({
                            ...prev,
                            [group.tenant]: !prev[group.tenant],
                          }))
                        }
                      >
                        <h3>{group.tenant}</h3>
                        <span>{group.items.length} exports</span>
                      </button>
                      <select
                        className="tenant-group__select"
                        value={downloadAllFormat}
                        onChange={(e) => setDownloadAllFormat(e.target.value)}
                      >
                        <option value="excel">Excel</option>
                        <option value="csv">CSV</option>
                        <option value="json">JSON</option>
                      </select>
                      <button
                        className="btn ghost btn-compact"
                        type="button"
                        onClick={() => handleDownloadAll(group.tenant)}
                      >
                        Download All
                      </button>
                    </div>
                    {openTenants[group.tenant] ? (
                      <div className="export-results export-results--table">
                        <div className="export-results__header">
                          <span>Type</span>
                          <span>Status</span>
                          <span>Detail</span>
                          <span>Downloads</span>
                        </div>
                    {group.items.map((result) => (
                      <div
                        className="export-result export-result--row"
                        key={`${result.runId || "run"}-${result.type}`}
                      >
                            <div className="export-result__type">
                              <div>{result.type}</div>
                              {result.createdAt ? (
                                <div className="export-result__meta">
                                  {formatDateTime(result.createdAt)}
                                </div>
                              ) : null}
                            </div>
                            <div
                              className={`export-result__status export-result__status--${result.status
                                .toLowerCase()
                                .replace(/\s+/g, "-")}`}
                            >
                              {result.status}
                            </div>
                            <div className="export-result__detail">
                              {result.detail || "-"}
                            </div>
                        <div className="export-result__download">
                          {result.status === "Ready" ? (
                            <>
                              <a className="btn btn--excel" href={result.excelUrl}>
                                Excel
                              </a>
                              <a className="btn btn--csv" href={result.csvUrl}>
                                CSV
                              </a>
                              <a className="btn btn--json" href={result.jsonUrl}>
                                JSON
                              </a>
                              {result.folderPath ? (
                                <button
                                  className="btn btn--path"
                                  type="button"
                                  onClick={() => handleCopy(result.folderPath)}
                                >
                                  Copy Path
                                </button>
                              ) : null}
                            </>
                          ) : result.status === "Error" ? (
                            <button
                              className="btn btn--retry"
                              type="button"
                              onClick={() => handleRetry(result.jobId)}
                            >
                              Retry
                            </button>
                          ) : (
                            <span className="export-result__muted">-</span>
                          )}
                        </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : selectedTenantName ? (
              <div className="export-results export-results--table">
                <div className="export-results__header">
                  <span>Type</span>
                  <span>Tenant</span>
                  <span>Status</span>
                  <span>Detail</span>
                  <span>Downloads</span>
                </div>
                {exportResults
                  .filter((result) => {
                    if (!selectedTenantName) return false;
                    if (showAllTenants) return true;
                    return result.tenantName === selectedTenantName;
                  })
                  .map((result) => (
                    <div
                      className="export-result export-result--row"
                      key={`${result.runId || "run"}-${result.type}`}
                    >
                      <div className="export-result__type">
                        <div>{result.type}</div>
                        {result.createdAt ? (
                          <div className="export-result__meta">
                            {formatDateTime(result.createdAt)}
                          </div>
                        ) : null}
                      </div>
                      <div className="export-result__tenant">
                        {result.tenantName || "-"}
                      </div>
                      <div
                        className={`export-result__status export-result__status--${result.status
                          .toLowerCase()
                          .replace(/\s+/g, "-")}`}
                      >
                        {result.status}
                      </div>
                      <div className="export-result__detail">
                        {result.detail || "-"}
                      </div>
                      <div className="export-result__download">
                        {result.status === "Ready" ? (
                          <>
                            <a className="btn btn--excel" href={result.excelUrl}>
                              Excel
                            </a>
                            <a className="btn btn--csv" href={result.csvUrl}>
                              CSV
                            </a>
                            <a className="btn btn--json" href={result.jsonUrl}>
                              JSON
                            </a>
                            {result.folderPath ? (
                              <button
                                className="btn btn--path"
                                type="button"
                                onClick={() => handleCopy(result.folderPath)}
                              >
                                Copy Path
                              </button>
                            ) : null}
                          </>
                        ) : result.status === "Error" ? (
                          <button
                            className="btn btn--retry"
                            type="button"
                            onClick={() => handleRetry(result.jobId)}
                          >
                            Retry
                          </button>
                        ) : (
                          <span className="export-result__muted">-</span>
                        )}
                      </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="status-banner">
                Select a tenant to view history.
              </div>
            )
          ) : (
            <div className="status-banner">No export history yet.</div>
          )
        ) : null}
      </section>

      </main>
    </div>
  );
}

export default App;
