import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDollarSign,
  Database,
  FileCode2,
  FolderOpen,
  Gauge,
  Languages,
  Moon,
  RefreshCw,
  Server,
  Sun,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { compactNumber, exactNumber, formatUsd, percent } from "./lib/format";
import type {
  ModelUsage,
  ProviderUsage,
  UsageReport,
  UsageTrendPoint,
} from "./types";

type RangeKey = "today" | "1" | "7" | "30" | "month" | "all" | "custom";
type DateRange = { start: string; end: string };
type Language = "en" | "zh";
type Theme = "dark" | "light";

const RANGE_OPTIONS: RangeKey[] = ["today", "1", "7", "30", "month", "all", "custom"];

interface Copy {
  brandTitle: string;
  brandSubtitle: string;
  languageTitle: string;
  themeTitle: Record<Theme, string>;
  rangeOptions: Record<RangeKey, string>;
  grain: Record<string, string>;
  selectRangeTitle: string;
  selectFolder: string;
  refresh: string;
  change: string;
  directoryLabel: string;
  resolvingDirectory: string;
  usageSummary: string;
  metrics: Record<string, string>;
  awaitingScan: string;
  exact: string;
  cachedOfInput: string;
  usageEvents: string;
  officialOnly: string;
  tabsLabel: string;
  usageTrend: string;
  sourcesModels: string;
  scanning: string;
  ready: string;
  desktopOnly: string;
  updated: string;
  files: string;
  requests: string;
  trendSubtitle: string;
  awaitingData: string;
  noUsage: string;
  loadingData: string;
  legend: Record<string, string>;
  tokensUsd: string;
  totalTokensSuffix: string;
  sources: string;
  sourcesSubtitle: string;
  noSourceData: string;
  customReference: string;
  dataQuality: string;
  dataQualitySubtitle: string;
  scanFiles: string;
  replayExcluded: string;
  deferredFiles: string;
  parseErrors: string;
  qualityNote: string;
  models: string;
  modelsSubtitle: string;
  model: string;
  modelsCount: string;
  noModelData: string;
  table: Record<string, string>;
  customDateRange: string;
  customDateSubtitle: string;
  startDate: string;
  endDate: string;
  cancel: string;
  applyRange: string;
  invalidEnd: string;
  futureEnd: string;
}

const COPY: Record<Language, Copy> = {
  en: {
    brandTitle: "Codex Usage",
    brandSubtitle: "Local Codex session analytics",
    languageTitle: "Switch to Simplified Chinese",
    themeTitle: { dark: "Switch to light theme", light: "Switch to dark theme" },
    rangeOptions: { today: "Today", "1": "Last 24h", "7": "Last 7 days", "30": "Last 30 days", month: "This month", all: "All history", custom: "Custom range..." },
    grain: { hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly", fallback: "Timeline" },
    selectRangeTitle: "Select time range",
    selectFolder: "Select Folder",
    refresh: "Refresh",
    change: "Change",
    directoryLabel: "Codex Directory",
    resolvingDirectory: "Resolving default directory...",
    usageSummary: "Usage summary",
    metrics: { total: "Total Tokens", input: "Input Tokens", cached: "Cached Input", output: "Output Tokens", requests: "Requests", officialCost: "Estimated Cost" },
    awaitingScan: "Awaiting scan",
    exact: "exact",
    cachedOfInput: "of input",
    usageEvents: "Non-zero usage events",
    officialOnly: "OpenAI sessions only",
    tabsLabel: "Usage views",
    usageTrend: "Usage Trend",
    sourcesModels: "Sources & Models",
    scanning: "Scanning rollout logs...",
    ready: "Ready to scan local sessions",
    desktopOnly: "This dashboard must be opened through the Tauri desktop app.",
    updated: "Updated",
    files: "files",
    requests: "requests",
    trendSubtitle: "Token flow and estimated spend over time",
    awaitingData: "Awaiting data",
    noUsage: "No usage in this range",
    loadingData: "Loading usage data",
    legend: { input: "Input", cached: "Cached", output: "Output", cost: "Estimated Cost" },
    tokensUsd: "Tokens · USD",
    totalTokensSuffix: "total tokens",
    sources: "Sources",
    sourcesSubtitle: "Usage by API provider",
    noSourceData: "No source data",
    customReference: "Custom API spend is shown as an OpenAI-equivalent reference.",
    dataQuality: "Data Quality",
    dataQualitySubtitle: "Local scan health",
    scanFiles: "Scan files",
    replayExcluded: "Replay excluded",
    deferredFiles: "Deferred files",
    parseErrors: "Parse errors",
    qualityNote: "Official cost uses the built-in public price table. Custom provider actual spend is not configured.",
    models: "Models",
    modelsSubtitle: "Aggregated by provider and model",
    model: "model",
    modelsCount: "models",
    noModelData: "No model data",
    table: { source: "Source", model: "Model", requests: "Requests", input: "Input", cached: "Cached", cacheHitRate: "Cache Hit Rate", output: "Output", total: "Total", cost: "Cost / Ref" },
    customDateRange: "Custom date range",
    customDateSubtitle: "Use local calendar dates for the scan.",
    startDate: "Start date",
    endDate: "End date",
    cancel: "Cancel",
    applyRange: "Apply range",
    invalidEnd: "End date must be on or after the start date.",
    futureEnd: "End date cannot be in the future.",
  },
  zh: {
    brandTitle: "Codex 用量",
    brandSubtitle: "本机 Codex 会话分析",
    languageTitle: "切换为 English",
    themeTitle: { dark: "切换为亮色主题", light: "切换为暗色主题" },
    rangeOptions: { today: "今天", "1": "近 24 小时", "7": "近 7 天", "30": "近 30 天", month: "本月", all: "全部历史", custom: "自定义范围..." },
    grain: { hour: "每小时", day: "每天", week: "每周", month: "每月", fallback: "时间线" },
    selectRangeTitle: "选择时间范围",
    selectFolder: "选择目录",
    refresh: "刷新",
    change: "更改",
    directoryLabel: "Codex 数据目录",
    resolvingDirectory: "正在解析默认目录...",
    usageSummary: "用量概览",
    metrics: { total: "合计 Tokens", input: "输入 Tokens", cached: "缓存输入", output: "输出 Tokens", requests: "请求数", officialCost: "估算费用" },
    awaitingScan: "等待扫描",
    exact: "精确值",
    cachedOfInput: "占输入",
    usageEvents: "非零用量事件",
    officialOnly: "仅计算 OpenAI 会话",
    tabsLabel: "用量视图",
    usageTrend: "使用趋势",
    sourcesModels: "来源与模型",
    scanning: "正在扫描会话日志...",
    ready: "准备扫描本机会话",
    desktopOnly: "请通过 Tauri 桌面应用打开此页面。",
    updated: "更新于",
    files: "个文件",
    requests: "次请求",
    trendSubtitle: "查看 Tokens 流量与估算费用变化",
    awaitingData: "等待数据",
    noUsage: "当前范围没有用量",
    loadingData: "正在加载用量数据",
    legend: { input: "输入", cached: "缓存", output: "输出", cost: "估算费用" },
    tokensUsd: "Tokens · 美元",
    totalTokensSuffix: "合计 Tokens",
    sources: "来源",
    sourcesSubtitle: "按 API 来源统计用量",
    noSourceData: "暂无来源数据",
    customReference: "第三方 API 费用显示为 OpenAI 价格折算参考。",
    dataQuality: "数据质量",
    dataQualitySubtitle: "本地扫描状态",
    scanFiles: "扫描文件",
    replayExcluded: "排除重放",
    deferredFiles: "待处理文件",
    parseErrors: "解析错误",
    qualityNote: "官方费用使用内置公开价目表，第三方真实费用尚未配置。",
    models: "模型",
    modelsSubtitle: "按来源与模型聚合",
    model: "个模型",
    modelsCount: "个模型",
    noModelData: "暂无模型数据",
    table: { source: "来源", model: "模型", requests: "请求数", input: "输入", cached: "缓存", cacheHitRate: "缓存命中率", output: "输出", total: "合计", cost: "费用 / 参考" },
    customDateRange: "自定义日期范围",
    customDateSubtitle: "按本地日历日期扫描数据。",
    startDate: "开始日期",
    endDate: "结束日期",
    cancel: "取消",
    applyRange: "应用范围",
    invalidEnd: "结束日期不能早于开始日期。",
    futureEnd: "结束日期不能晚于今天。",
  },
};

const metricDefinitions: Array<{
  key: string;
  label: string;
  icon: LucideIcon;
  accent: string;
}> = [
  { key: "total", label: "Total Tokens", icon: Gauge, accent: "blue" },
  { key: "input", label: "Input Tokens", icon: ArrowUpRight, accent: "cyan" },
  { key: "cached", label: "Cached Input", icon: Database, accent: "purple" },
  { key: "output", label: "Output Tokens", icon: Activity, accent: "green" },
  { key: "requests", label: "Requests", icon: BarChart3, accent: "slate" },
  { key: "officialCost", label: "Estimated Cost", icon: CircleDollarSign, accent: "amber" },
];

const providerColors: Record<string, string> = {
  openai: "var(--provider-openai)",
  custom: "var(--provider-custom)",
};

const CHART_PALETTES: Record<Theme, {
  input: string;
  cached: string;
  output: string;
  cost: string;
  grid: string;
  axis: string;
  cursor: string;
  dot: string;
}> = {
  dark: {
    input: "#83aafa",
    cached: "#b497ee",
    output: "#77c7a2",
    cost: "#d7a56f",
    grid: "#202b3b",
    axis: "#708096",
    cursor: "#344258",
    dot: "#0f1622",
  },
  light: {
    input: "#3f70c8",
    cached: "#7c56b5",
    output: "#2f8968",
    cost: "#a96627",
    grid: "#dfe5ed",
    axis: "#69768a",
    cursor: "#a9b5c4",
    dot: "#ffffff",
  },
};

export default function App() {
  const [codexHome, setCodexHome] = useState("");
  const [language, setLanguage] = useState<Language>(() => (
    localStorage.getItem("codex-usage-language") === "en" ? "en" : "zh"
  ));
  const [theme, setTheme] = useState<Theme>(() => {
    const savedTheme = localStorage.getItem("codex-usage-theme");
    if (savedTheme === "dark" || savedTheme === "light") return savedTheme;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });
  const [range, setRange] = useState<RangeKey>("today");
  const [lastQuickRange, setLastQuickRange] = useState<RangeKey>("today");
  const [customDates, setCustomDates] = useState<DateRange | null>(null);
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [rangeMenuOpen, setRangeMenuOpen] = useState(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState("");
  const initialized = useRef(false);
  const rangeMenuRef = useRef<HTMLDivElement>(null);
  const copy = COPY[language];

  useEffect(() => {
    localStorage.setItem("codex-usage-language", language);
  }, [language]);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("codex-usage-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!rangeMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rangeMenuRef.current?.contains(event.target as Node)) {
        setRangeMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRangeMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [rangeMenuOpen]);

  const runReport = useCallback(
    async (targetHome: string, targetRange: RangeKey, targetDates: DateRange | null) => {
      const args = rangeArgs(targetRange, targetDates);
      setLoading(true);
      setError("");
      try {
        if (!isTauriRuntime()) {
          throw new Error(copy.desktopOnly);
        }
        const nextReport = await invoke<UsageReport>("analyze_usage", {
          codexHome: targetHome,
          days: args.days,
          fromTimestamp: args.fromTimestamp,
          toTimestamp: args.toTimestamp,
        });
        setReport(nextReport);
        setLastUpdated(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      } catch (cause) {
        setReport(null);
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [copy.desktopOnly],
  );

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void (async () => {
      try {
        if (!isTauriRuntime()) {
          throw new Error(copy.desktopOnly);
        }
        const defaultHome = await invoke<string>("default_codex_home");
        setCodexHome(defaultHome);
        await runReport(defaultHome, "today", null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    })();
  }, [runReport]);

  const handleRefresh = () => {
    if (codexHome) void runReport(codexHome, range, customDates);
  };

  const handleChooseFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select CODEX_HOME directory",
      });
      if (typeof selected === "string") {
        setCodexHome(selected);
        void runReport(selected, range, customDates);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const handleRangeChange = (nextRange: RangeKey) => {
    setRangeMenuOpen(false);
    if (nextRange === "custom") {
      setCustomDialogOpen(true);
      return;
    }
    setRange(nextRange);
    setLastQuickRange(nextRange);
    setCustomDates(null);
    if (codexHome) void runReport(codexHome, nextRange, null);
  };

  const applyCustomDates = (nextDates: DateRange) => {
    setCustomDates(nextDates);
    setRange("custom");
    setCustomDialogOpen(false);
    if (codexHome) void runReport(codexHome, "custom", nextDates);
  };

  const cancelCustomDates = () => {
    setCustomDialogOpen(false);
    setRange(lastQuickRange);
  };

  const totals = report?.totals;
  const cachedRatio = totals && totals.inputTokens > 0
    ? (totals.cachedInputTokens / totals.inputTokens) * 100
    : 0;
  const statusText = loading
    ? copy.scanning
    : report
      ? `${copy.updated} ${lastUpdated} · ${report.filesScanned} ${copy.files} · ${exactNumber(report.totals.requestCount)} ${copy.requests}`
      : copy.ready;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-icon"><Activity size={17} strokeWidth={1.8} /></div>
          <div>
            <div className="brand-title">{copy.brandTitle}</div>
            <div className="brand-subtitle">{copy.brandSubtitle}</div>
          </div>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="button theme-toggle"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title={copy.themeTitle[theme]}
            aria-label={copy.themeTitle[theme]}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="button language-toggle" onClick={() => setLanguage(language === "en" ? "zh" : "en")} title={copy.languageTitle} aria-label={copy.languageTitle}>
            <Languages size={15} />
            <span>{language === "en" ? "中文" : "EN"}</span>
          </button>
          <div className="range-menu" ref={rangeMenuRef}>
            <button
              type="button"
              className={rangeMenuOpen ? "range-select open" : "range-select"}
              title={copy.selectRangeTitle}
              aria-haspopup="menu"
              aria-expanded={rangeMenuOpen}
              onClick={() => setRangeMenuOpen((open) => !open)}
              disabled={loading}
            >
              <CalendarDays size={15} />
              <span className="range-select-label">{rangeSelectionLabel(range, copy, customDates, language)}</span>
              <ChevronDown size={14} className="range-chevron" />
            </button>
            {rangeMenuOpen && !loading && (
              <div className="range-menu-popover" role="menu">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    type="button"
                    className={range === option ? "range-option selected" : "range-option"}
                    key={option}
                    role="menuitem"
                    onClick={() => handleRangeChange(option)}
                  >
                    <span>{option === "custom" && customDates ? `${customDates.start} - ${customDates.end}` : copy.rangeOptions[option]}</span>
                    {range === option && <Check size={14} />}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="button button-secondary" onClick={handleChooseFolder} disabled={loading}>
            <FolderOpen size={15} /> {copy.selectFolder}
          </button>
          <button className="button button-primary" onClick={handleRefresh} disabled={loading || !codexHome}>
            <RefreshCw size={15} className={loading ? "spin" : ""} />
            {copy.refresh}
          </button>
        </div>
      </header>

      <main className="app-main">
        <section className="directory-bar" aria-label="Codex directory">
          <div className="directory-leading">
            <div className="directory-icon"><Database size={16} /></div>
            <div className="directory-copy">
              <span className="eyebrow">{copy.directoryLabel}</span>
              <strong title={codexHome}>{codexHome || copy.resolvingDirectory}</strong>
            </div>
          </div>
          <button className="button button-ghost" onClick={handleChooseFolder} disabled={loading}>
            {copy.change} <ArrowUpRight size={14} />
          </button>
        </section>

        {error && (
          <div className="error-banner" role="alert">
            <div><X size={16} /><span>{error}</span></div>
            <button className="button button-ghost compact" onClick={handleRefresh}>{copy.refresh}</button>
          </div>
        )}

        <section className="metrics-grid" aria-label={copy.usageSummary}>
          {metricDefinitions.map((metric) => (
            <MetricCard
              key={metric.key}
              icon={metric.icon}
              label={copy.metrics[metric.key]}
              accent={metric.accent}
              value={metricValue(metric.key, totals, report?.costSummary.officialEstimatedCostUsd)}
              detail={metricDetail(metric.key, totals, cachedRatio, copy)}
            />
          ))}
        </section>

        <div className="content-status">
          <div className={loading ? "scan-status scanning" : "scan-status"}>
            <span className="status-dot" />
            {statusText}
          </div>
        </div>

        <TrendPanel report={report} copy={copy} language={language} selectedRange={range} customDates={customDates} theme={theme} />
        <DetailsPanel report={report} copy={copy} language={language} />
      </main>

      {customDialogOpen && (
        <DateRangeDialog
          initialDates={customDates ?? recentDates(7)}
          copy={copy}
          onCancel={cancelCustomDates}
          onApply={applyCustomDates}
        />
      )}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  accent: string;
}) {
  return (
    <article className={`metric-card accent-${accent}`}>
      <div className="metric-label"><Icon size={14} /><span>{label}</span></div>
      <div className="metric-value">{value}</div>
      <div className="metric-detail">{detail}</div>
    </article>
  );
}

function TrendPanel({ report, copy, language, selectedRange, customDates, theme }: { report: UsageReport | null; copy: Copy; language: Language; selectedRange: RangeKey; customDates: DateRange | null; theme: Theme }) {
  const trend = report?.timeline ?? [];
  const grainLabel = report ? grainText(report.timelineGrain, copy) : copy.grain.hour;
  const hasUsage = trend.some((point) => point.totalTokens > 0 || point.officialEstimatedCostUsd > 0);
  const palette = CHART_PALETTES[theme];

  return (
    <section className="trend-panel panel">
      <div className="panel-header">
        <div>
          <div className="panel-title-row"><Activity size={16} /><h2>{copy.usageTrend}</h2></div>
          <p>{copy.trendSubtitle}</p>
        </div>
        <div className="panel-meta">{report ? `${rangeSelectionLabel(selectedRange, copy, customDates, language)} · ${grainLabel}` : copy.awaitingData}</div>
      </div>
      <div className="trend-chart-wrap">
        {hasUsage ? (
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={trend} margin={{ top: 12, right: 6, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="inputFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={palette.input} stopOpacity={0.16} />
                  <stop offset="100%" stopColor={palette.input} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke={palette.grid} strokeDasharray="2 7" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: palette.axis, fontSize: 11 }} minTickGap={28} />
              <YAxis yAxisId="tokens" axisLine={false} tickLine={false} tick={{ fill: palette.axis, fontSize: 11 }} tickFormatter={compactNumber} width={44} />
              <YAxis yAxisId="cost" orientation="right" axisLine={false} tickLine={false} tick={{ fill: palette.axis, fontSize: 11 }} tickFormatter={(value: number) => formatUsd(value)} width={54} />
              <Tooltip content={<TrendTooltip copy={copy} />} cursor={{ stroke: palette.cursor, strokeDasharray: "3 5" }} />
              <Area yAxisId="tokens" type="monotone" dataKey="inputTokens" stroke="none" fill="url(#inputFill)" tooltipType="none" />
              <Line yAxisId="tokens" type="monotone" dataKey="inputTokens" name={copy.legend.input} stroke={palette.input} strokeWidth={2.2} dot={false} activeDot={{ r: 4, strokeWidth: 2, fill: palette.dot }} />
              <Line yAxisId="tokens" type="monotone" dataKey="cachedInputTokens" name={copy.legend.cached} stroke={palette.cached} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, fill: palette.dot }} />
              <Line yAxisId="tokens" type="monotone" dataKey="outputTokens" name={copy.legend.output} stroke={palette.output} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, fill: palette.dot }} />
              <Line yAxisId="cost" type="monotone" dataKey="officialEstimatedCostUsd" name={copy.legend.cost} stroke={palette.cost} strokeWidth={1.8} strokeDasharray="5 4" dot={false} activeDot={{ r: 4, strokeWidth: 2, fill: palette.dot }} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState icon={Activity} title={report ? copy.noUsage : copy.loadingData} />
        )}
      </div>
      <div className="chart-legend">
        <LegendItem color={palette.input} label={copy.legend.input} />
        <LegendItem color={palette.cached} label={copy.legend.cached} />
        <LegendItem color={palette.output} label={copy.legend.output} />
        <LegendItem color={palette.cost} label={copy.legend.cost} dashed />
        <span className="axis-note">{copy.tokensUsd}</span>
      </div>
    </section>
  );
}

function TrendTooltip({ active, payload, label, copy }: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; name?: string; value?: number; color?: string; payload?: UsageTrendPoint }>;
  label?: string;
  copy: Copy;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-label">{label}</div>
      {payload.filter((entry) => entry.dataKey !== undefined).map((entry) => (
        <div className="tooltip-row" key={entry.dataKey}>
          <span><i style={{ background: entry.color }} />{entry.name}</span>
          <strong>{entry.dataKey === "officialEstimatedCostUsd" ? formatUsd(entry.value) : exactNumber(entry.value ?? 0)}</strong>
        </div>
      ))}
      {point && <div className="tooltip-total">{exactNumber(point.totalTokens)} {copy.totalTokensSuffix}</div>}
    </div>
  );
}

function LegendItem({ color, label, dashed = false }: { color: string; label: string; dashed?: boolean }) {
  return <span className="legend-item"><i className={dashed ? "dashed" : ""} style={{ background: dashed ? "transparent" : color, borderColor: color }} />{label}</span>;
}

function DetailsPanel({ report, copy, language }: { report: UsageReport | null; copy: Copy; language: Language }) {
  const providers = report?.byProvider ?? [];
  const models = report?.byProviderModel ?? [];
  const totalTokens = report?.totals.totalTokens ?? 0;
  return (
    <div className="details-layout">
      <section className="panel provider-panel">
        <div className="panel-header compact-header">
          <div><div className="panel-title-row"><Server size={16} /><h2>{copy.sources}</h2></div><p>{copy.sourcesSubtitle}</p></div>
        </div>
        <div className="provider-list">
          {providers.length ? providers.map((row) => (
            <ProviderRow key={row.provider} row={row} totalTokens={totalTokens} copy={copy} language={language} />
          )) : <EmptyState icon={Server} title={copy.noSourceData} compact />}
        </div>
        <div className="provider-footnote"><span className="footnote-dot" />{copy.customReference}</div>
      </section>
      <QualityPanel report={report} copy={copy} />
      <section className="panel model-panel">
        <div className="panel-header compact-header model-header">
          <div><div className="panel-title-row"><FileCode2 size={16} /><h2>{copy.models}</h2></div><p>{copy.modelsSubtitle}</p></div>
          <span className="row-count">{models.length} {models.length === 1 ? copy.model : copy.modelsCount}</span>
        </div>
        <ModelTable rows={models} copy={copy} language={language} />
      </section>
    </div>
  );
}

function ProviderRow({ row, totalTokens, copy, language }: { row: ProviderUsage; totalTokens: number; copy: Copy; language: Language }) {
  const share = totalTokens ? (row.totalTokens / totalTokens) * 100 : 0;
  const color = providerColors[row.provider] ?? "#8595ab";
  return (
    <div className="provider-row">
      <div className="provider-topline"><div className="provider-name"><i style={{ background: color }} />{providerLabel(row.provider, language)}</div><strong>{percent(share)}</strong></div>
      <div className="provider-bar"><span style={{ width: `${Math.min(share, 100)}%`, background: color }} /></div>
      <div className="provider-stats"><span>{compactNumber(row.totalTokens)} Tokens</span><span>{exactNumber(row.requestCount)} {copy.requests}</span><span>{row.provider === "openai" ? formatUsd(row.estimatedCostUsd) : `${copy.table.cost} ${formatUsd(row.openAiEquivalentCostUsd)}`}</span></div>
    </div>
  );
}

function QualityPanel({ report, copy }: { report: UsageReport | null; copy: Copy }) {
  const qualityRows = [
    [copy.scanFiles, report ? `${report.filesParsed} / ${report.filesScanned}` : "-"],
    [copy.replayExcluded, report ? exactNumber(report.forkHandling.replayEventsSkipped) : "-"],
    [copy.deferredFiles, report ? exactNumber(report.forkHandling.deferredFiles) : "-"],
    [copy.parseErrors, report ? exactNumber(report.parseErrors.length) : "-"],
  ];
  return (
    <section className="panel quality-panel">
      <div className="panel-header compact-header"><div><div className="panel-title-row"><Check size={16} /><h2>{copy.dataQuality}</h2></div><p>{copy.dataQualitySubtitle}</p></div></div>
      <div className="quality-list">
        {qualityRows.map(([label, value]) => <div className="quality-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}
      </div>
      <div className="quality-note">{copy.qualityNote}</div>
    </section>
  );
}

function ModelTable({ rows, copy, language }: { rows: ModelUsage[]; copy: Copy; language: Language }) {
  if (!rows.length) return <EmptyState icon={FileCode2} title={copy.noModelData} compact />;
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>{copy.table.source}</th><th>{copy.table.model}</th><th>{copy.table.requests}</th><th>{copy.table.input}</th><th>{copy.table.cached}</th><th>{copy.table.cacheHitRate}</th><th>{copy.table.output}</th><th>{copy.table.total}</th><th>{copy.table.cost}</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={`${row.provider}-${row.model}`}>
            <td><span className="source-pill"><i style={{ background: providerColors[row.provider] ?? "#8595ab" }} />{providerLabel(row.provider, language)}</span></td>
            <td className="model-name">{row.model}</td>
            <td>{exactNumber(row.requestCount)}</td>
            <td>{compactNumber(row.inputTokens)}</td>
            <td>{compactNumber(row.cachedInputTokens)}</td>
            <td>{row.inputTokens > 0 ? percent(row.cachedInputTokens / row.inputTokens * 100) : "—"}</td>
            <td>{compactNumber(row.outputTokens)}</td>
            <td>{compactNumber(row.totalTokens)}</td>
            <td className="cost-cell">{row.provider === "openai" ? formatUsd(row.estimatedCostUsd) : `${copy.table.cost} ${formatUsd(row.openAiEquivalentCostUsd)}`}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function EmptyState({ icon: Icon, title, compact = false }: { icon: LucideIcon; title: string; compact?: boolean }) {
  return <div className={compact ? "empty-state compact" : "empty-state"}><Icon size={compact ? 20 : 26} /><span>{title}</span></div>;
}

function DateRangeDialog({ initialDates, onCancel, onApply, copy }: { initialDates: DateRange; onCancel: () => void; onApply: (dates: DateRange) => void; copy: Copy }) {
  const [start, setStart] = useState(initialDates.start);
  const [end, setEnd] = useState(initialDates.end);
  const [validation, setValidation] = useState("");
  const apply = () => {
    const today = isoDate(new Date());
    if (!start || !end || end < start) return setValidation(copy.invalidEnd);
    if (end > today) return setValidation(copy.futureEnd);
    onApply({ start, end });
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="date-dialog" role="dialog" aria-modal="true" aria-labelledby="date-dialog-title">
        <div className="dialog-header"><div><div className="panel-title-row"><CalendarDays size={17} /><h2 id="date-dialog-title">{copy.customDateRange}</h2></div><p>{copy.customDateSubtitle}</p></div><button className="icon-button" onClick={onCancel} title={copy.cancel}><X size={16} /></button></div>
        <div className="date-fields">
          <label>{copy.startDate}<input type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label>
          <label>{copy.endDate}<input type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label>
        </div>
        {validation && <div className="validation">{validation}</div>}
        <div className="dialog-actions"><button className="button button-secondary" onClick={onCancel}>{copy.cancel}</button><button className="button button-primary" onClick={apply}><Check size={15} />{copy.applyRange}</button></div>
      </div>
    </div>
  );
}

function metricValue(key: string, totals: UsageReport["totals"] | undefined, officialCost: number | undefined): string {
  if (!totals) return "-";
  if (key === "officialCost") return formatUsd(officialCost);
  const values: Record<string, number> = {
    total: totals.totalTokens,
    input: totals.inputTokens,
    cached: totals.cachedInputTokens,
    output: totals.outputTokens,
    requests: totals.requestCount,
  };
  return key === "requests" ? exactNumber(values[key]) : compactNumber(values[key]);
}

function metricDetail(key: string, totals: UsageReport["totals"] | undefined, cachedRatio: number, copy: Copy): string {
  if (!totals) return copy.awaitingScan;
  if (key === "cached") return `${percent(cachedRatio)} ${copy.cachedOfInput}`;
  if (key === "requests") return copy.usageEvents;
  if (key === "officialCost") return copy.officialOnly;
  const values: Record<string, number> = { total: totals.totalTokens, input: totals.inputTokens, output: totals.outputTokens };
  return `${exactNumber(values[key])} ${copy.exact}`;
}

function rangeArgs(range: RangeKey, dates: DateRange | null): { days: number; fromTimestamp: number | null; toTimestamp: number | null } {
  const now = new Date();
  if (range === "all") return { days: 0, fromTimestamp: null, toTimestamp: null };
  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { days: 1, fromTimestamp: unixSeconds(start), toTimestamp: null };
  }
  if (range === "1") {
    return { days: 1, fromTimestamp: Math.floor(now.getTime() / 1000) - 86_400, toTimestamp: null };
  }
  if (range === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { days: now.getDate(), fromTimestamp: unixSeconds(start), toTimestamp: null };
  }
  if (range === "custom" && dates) {
    const start = localDate(dates.start);
    const end = localDate(dates.end);
    const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    return {
      days: calendarDaysInclusive(start, end),
      fromTimestamp: unixSeconds(start),
      toTimestamp: unixSeconds(endExclusive) - 1,
    };
  }
  const days = Number(range) || 1;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { days, fromTimestamp: unixSeconds(start), toTimestamp: null };
}

function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}

function calendarDaysInclusive(start: Date, end: Date): number {
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(1, Math.round((endUtc - startUtc) / 86_400_000) + 1);
}

function rangeSelectionLabel(range: RangeKey, copy: Copy, dates: DateRange | null, language: Language): string {
  if (range === "custom" && dates) return `${dates.start} - ${dates.end}`;
  if (range in copy.rangeOptions) return copy.rangeOptions[range];
  return language === "zh" ? "自定义范围" : "Custom range";
}

function grainText(grain: string, copy: Copy): string {
  return copy.grain[grain] ?? copy.grain.fallback;
}

function providerLabel(provider: string, language: Language): string {
  if (provider === "openai") return language === "zh" ? "官方 OpenAI" : "OpenAI";
  if (provider === "custom") return language === "zh" ? "第三方 API" : "Custom API";
  return provider;
}

function recentDates(days: number): DateRange {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { start: isoDate(start), end: isoDate(end) };
}

function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unable to read Codex usage data.";
}

function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}
