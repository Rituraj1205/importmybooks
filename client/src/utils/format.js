export const formatDateInput = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export const formatDateTime = value => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
};

export const formatDuration = ms => {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSeconds = Math.round(ms / 1e3);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
};

export const formatEta = ms => {
  if (!ms || ms <= 0) return "";
  return formatDuration(ms);
};

export const formatCount = value => {
  if (!Number.isFinite(value)) return "-";
  return value.toLocaleString();
};

export const formatPercent = value => {
  if (!Number.isFinite(value)) return "-";
  return `${value}%`;
};

export const formatMonthLabel = value => {
  if (!value) return "-";
  const [y, m] = String(value).split("-");
  const date = new Date(Number(y), Number(m) - 1, 1);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: "short", year: "numeric" });
};

export const buildLinePath = (points, width, height) => {
  if (!points.length) return "";
  const max = Math.max(1, ...points.map(p => p.value));
  return points
    .map((point, i) => {
      const x = (i / (points.length - 1 || 1)) * width;
      const y = height - (point.value / max) * height;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
};

export const getMax = (items, key) => {
  if (!Array.isArray(items) || items.length === 0) return 1;
  return Math.max(1, ...items.map(item => (Number.isFinite(item?.[key]) ? item[key] : 0)));
};

export const buildProgressDetail = (progress, startedAt) => {
  if (!progress || !progress.page) return "";
  const { page, pageCount, count, totalCount } = progress;
  const parts = [];
  if (pageCount) parts.push(`Page ${page}/${pageCount}`);
  else if (page) parts.push(`Page ${page}`);
  if (totalCount) {
    const pct = Math.min(100, Math.round((count / totalCount) * 100));
    parts.push(`${pct}%`);
    if (startedAt && count > 0) {
      const elapsed = Date.now() - startedAt;
      const etaMs = (elapsed / count) * (totalCount - count);
      const etaLabel = formatDuration(etaMs);
      if (etaLabel) parts.push(`ETA ${etaLabel}`);
    }
  }
  return parts.length ? `Progress: ${parts.join(" · ")}` : "";
};
