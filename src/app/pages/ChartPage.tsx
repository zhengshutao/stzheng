// K 线页 /dashboard/chart/:symbol —— 左边美股持仓列表,右边 K 线(EMA5/10/20/50 + 成交量 + 我的买卖点)。
// 颜色按 A 股习惯:涨红跌绿。买卖点画在成交价上:同一根 K 线里有多笔成交标 T,只有一笔标 B / S。
// 只做美股(USD、非期权);K 线数据来自 stock-candles edge function,盘中每 15 秒刷新一次。

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Eraser, GripVertical, Pencil, X, Heart, Plus, Settings, Minus, MousePointer2, MoveUpRight, RectangleHorizontal, RefreshCw, Trash2 } from "lucide-react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import DashboardNavbar from "./DashboardNavbar";
import { TradeMarksPrimitive } from "@/app/lib/chartMarks";
import { fetchAll, type StockSplit, type StockTrade } from "@/app/lib/dashboardData";
import { computePositions } from "@/app/lib/stockPositions";
import { fetchQuotes, type QuotesResponse } from "@/app/lib/stockApi";
import { runSnaptradeSync } from "@/app/lib/portfolioApi";
import { isFreeTextOption, isOccOption } from "@/app/lib/instruments";
import {
  DrawingsPrimitive,
  loadDrawings,
  saveDrawings,
  type DrawTool,
  type Drawing,
  type Pt,
} from "@/app/lib/chartDrawings";
import {
  BAR_SECONDS,
  EMA_LENGTHS,
  PERIODS,
  ema,
  fetchCandles,
  fetchSparks,
  groupTradesByBar,
  isDaily,
  previousDayClose,
  regularSessionOnly,
  type BarTrades,
  type Candle,
  type CandleData,
  type MarkKind,
  type Period,
  type Spark,
} from "@/app/lib/candles";
import {
  createWatchlist,
  deleteWatchlist,
  fetchWatchlists,
  isMissingWatchlistTable,
  updateWatchlist,
  type Watchlist,
} from "@/app/lib/watchlists";

const mono = { fontFamily: "'JetBrains Mono', monospace" };

const UP = "#f23645";
const DOWN = "#089981";
const FLAT = "#6b7fa8";
const TEXT = "#e2e8f4";
const SUB = "#6b7fa8";
const MUTED = "#4a5568";
const BG = "#060a14";
const BORDER = "rgba(139,92,246,0.18)";
const EMA_COLORS: Record<number, string> = { 5: "#f5c542", 10: "#38bdf8", 20: "#c084fc", 50: "#2dd4bf" };
// 买卖点故意不用 K 线的红/绿,也避开 EMA 的黄/天蓝/紫/青,压在 K 线上也看得清
// 默认值,设置里可以改
type MarkColors = Record<MarkKind, string>;
const DEFAULT_MARK_COLORS: MarkColors = { B: "#2f7bff", S: "#e040fb", T: "#ff9800" };
const MARK_TEXT = { B: "B", S: "S", T: "T" } as const;

/**
 * 买卖点画在 K 线上的价格:成交均价(按数量加权)。
 * 拆股前的成交价和雅虎复权后的 K 线对不上,落在这根 K 线高低点之外时改画在 K 线正中间。
 */
function markPrice(m: BarTrades, bar: Candle | undefined): number | null {
  if (!bar) return null;
  const qty = m.trades.reduce((s, t) => s + t.qty, 0);
  const avg = qty > 0 ? m.trades.reduce((s, t) => s + t.qty * t.price, 0) / qty : m.trades[0].price;
  const slack = (bar.high - bar.low) * 0.05;
  return avg >= bar.low - slack && avg <= bar.high + slack ? avg : (bar.high + bar.low) / 2;
}

const POLL_MS = 15000;
const PERIOD_KEY = "chart.period";

const chgColor = (n: number | null) => (n === null || n === 0 ? FLAT : n > 0 ? UP : DOWN);
const fmtPct = (n: number | null) => (n === null ? "--" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
const fmtPrice = (n: number | null | undefined) => (n === null || n === undefined ? "--" : n.toFixed(2));

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

function isUsStock(t: { ticker: string; currency: string }): boolean {
  return t.currency.toUpperCase() === "USD" && !isFreeTextOption(t.ticker) && !isOccOption(t.ticker);
}

function readPeriod(): Period {
  try {
    const v = localStorage.getItem(PERIOD_KEY);
    if (v && PERIODS.some((p) => p.key === v)) return v as Period;
  } catch {
    /* 隐私模式等读不到就用默认 */
  }
  return "1d";
}

// ---------- 设置(存在本机浏览器) ----------

interface ChartSettings {
  /** 分钟线/小时线显示盘前盘后 */
  extendedHours: boolean;
  /** 默认视野:每根 K 线占的像素宽 */
  barSpacing: number;
  /** 默认视野:最后一根 K 线放在图宽的百分之几处,右边留白 */
  lastBarAt: number;
  /** 买卖点颜色 */
  markColors: MarkColors;
}

const SETTINGS_KEY = "chart.settings";
const DEFAULT_SETTINGS: ChartSettings = { extendedHours: true, barSpacing: 8, lastBarAt: 70, markColors: DEFAULT_MARK_COLORS };

function readSettings(): ChartSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...saved, markColors: { ...DEFAULT_MARK_COLORS, ...saved.markColors } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex items-start justify-between gap-4 cursor-pointer select-none">
      <span>
        <span className="block text-xs" style={{ color: TEXT }}>
          {label}
        </span>
        {hint && (
          <span className="block text-[10px] mt-0.5" style={{ color: MUTED }}>
            {hint}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="relative w-9 h-5 rounded-full shrink-0 transition-colors"
        style={{ background: checked ? "#8b5cf6" : "rgba(139,92,246,0.15)" }}
      >
        <span
          className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
          style={{ left: checked ? 18 : 2 }}
        />
      </button>
    </label>
  );
}

function Slider({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block select-none">
      <span className="flex items-baseline justify-between gap-4">
        <span className="text-xs" style={{ color: TEXT }}>
          {label}
        </span>
        <span className="text-xs" style={{ ...mono, color: SUB }}>
          {value}
          {unit}
        </span>
      </span>
      {hint && (
        <span className="block text-[10px] mt-0.5" style={{ color: MUTED }}>
          {hint}
        </span>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full mt-2 accent-violet-500"
      />
    </label>
  );
}

const MARK_LABELS: { kind: MarkKind; label: string }[] = [
  { kind: "B", label: "买入" },
  { kind: "S", label: "卖出" },
  { kind: "T", label: "同一根K线多笔" },
];

// ---------- 颜色选择器(自己画的,浏览器自带的加不了保存/取消) ----------

type Hsv = { h: number; s: number; v: number };

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [f(5), f(3), f(1)];
}

/** 在一个元素上按住拖动,回调 0–1 的相对坐标 */
function useDrag(onMove: (x: number, y: number) => void) {
  return (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const emit = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onMove(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
    };
    emit(e);
    const move = (ev: PointerEvent) => emit(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
}

function ColorPopover({ value, onSave, onCancel }: { value: string; onSave: (hex: string) => void; onCancel: () => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(...hexToRgb(value)));
  const rgb = hsvToRgb(hsv).map(Math.round) as [number, number, number];
  const hex = rgbToHex(...rgb);
  const [hexInput, setHexInput] = useState(hex);
  useEffect(() => setHexInput(hex), [hex]);
  useEffect(() => {
    // 捕获阶段拦下 Esc,只关颜色框,不关整个设置窗口
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const dragSv = useDrag((x, y) => setHsv((c) => ({ ...c, s: x, v: 1 - y })));
  const dragHue = useDrag((x) => setHsv((c) => ({ ...c, h: x * 359.9 })));
  const setChannel = (i: number, raw: string) => {
    const next = [...rgb] as [number, number, number];
    next[i] = Math.min(255, Math.max(0, Number(raw) || 0));
    setHsv(rgbToHsv(...next));
  };
  const hueColor = rgbToHex(...hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  const inputStyle = { ...mono, color: TEXT, background: "rgba(139,92,246,0.06)", border: `1px solid ${BORDER}` };

  return (
    <div
      className="mt-3 w-64 rounded-lg p-3 space-y-3"
      style={{ background: "rgba(10,14,28,0.99)", border: `1px solid ${BORDER}`, boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}
    >
      <div
        className="relative h-36 rounded cursor-crosshair touch-none"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={dragSv}
      >
        <span
          className="absolute w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full border-2 border-white pointer-events-none"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
        />
      </div>
      <div className="flex items-center gap-3">
        <span className="w-7 h-7 rounded-full shrink-0" style={{ background: hex, border: `1px solid ${BORDER}` }} />
        <div
          className="relative flex-1 h-3 rounded-full cursor-pointer touch-none"
          style={{ background: "linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
          onPointerDown={dragHue}
        >
          <span
            className="absolute top-1/2 w-3.5 h-3.5 -ml-[7px] -mt-[7px] rounded-full border-2 border-white pointer-events-none"
            style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor, boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
          />
        </div>
      </div>
      <div className="grid grid-cols-5 gap-1.5 text-center">
        <label className="col-span-2 text-[9px]" style={{ color: MUTED }}>
          <input
            value={hexInput}
            onChange={(e) => {
              setHexInput(e.target.value);
              const v = e.target.value.trim().replace(/^#?/, "#");
              if (/^#[0-9a-f]{6}$/i.test(v)) setHsv(rgbToHsv(...hexToRgb(v)));
            }}
            className="w-full rounded px-1 py-1 text-[11px] text-center outline-none focus:border-violet-500"
            style={inputStyle}
            aria-label="HEX"
          />
          HEX
        </label>
        {(["R", "G", "B"] as const).map((ch, i) => (
          <label key={ch} className="text-[9px]" style={{ color: MUTED }}>
            <input
              type="number"
              min={0}
              max={255}
              value={rgb[i]}
              onChange={(e) => setChannel(i, e.target.value)}
              className="w-full rounded px-1 py-1 text-[11px] text-center outline-none focus:border-violet-500 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
              style={inputStyle}
              aria-label={ch}
            />
            {ch}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          className="px-3 py-1 rounded text-[11px] transition-colors hover:bg-violet-500/10"
          style={{ color: SUB, border: `1px solid ${BORDER}` }}
        >
          取消
        </button>
        <button
          onClick={() => onSave(hex)}
          className="px-3 py-1 rounded text-[11px] text-white transition-colors hover:brightness-110"
          style={{ background: "#8b5cf6", border: "1px solid rgba(139,92,246,0.8)" }}
        >
          保存
        </button>
      </div>
    </div>
  );
}

function MarkColorPicker({ colors, onChange }: { colors: MarkColors; onChange: (c: MarkColors) => void }) {
  const [editing, setEditing] = useState<MarkKind | null>(null);
  const close = useCallback(() => setEditing(null), []);
  return (
    <div>
      <div className="text-xs" style={{ color: TEXT }}>
        买卖点颜色
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2">
        {MARK_LABELS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            onClick={() => setEditing((k) => (k === kind ? null : kind))}
            className="flex items-center gap-2 select-none text-[11px]"
            style={{ color: SUB }}
            aria-label={`${label}颜色`}
            aria-expanded={editing === kind}
          >
            <span
              className="w-6 h-6 rounded-full shrink-0"
              style={{ background: colors[kind], border: `1px solid ${editing === kind ? "#fff" : BORDER}` }}
            />
            <b style={{ ...mono, color: colors[kind] }}>{kind}</b>
            {label}
          </button>
        ))}
      </div>
      {editing && (
        <ColorPopover
          key={editing}
          value={colors[editing]}
          onCancel={close}
          onSave={(hex) => {
            onChange({ ...colors, [editing]: hex });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

type SettingsSection = "session" | "chart";
const SETTINGS_SECTIONS: { key: SettingsSection; label: string }[] = [
  { key: "session", label: "交易时段" },
  { key: "chart", label: "图表" },
];

/** 设置窗口。图表里的是默认视野:打开、换周期、点刷新时用;手动拖动/缩放不会改它 */
function SettingsDialog({ settings, onChange }: { settings: ChartSettings; onChange: (s: ChartSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("session");
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-1.5 rounded transition-colors hover:bg-violet-500/10"
        style={{ color: open ? "#fff" : SUB }}
        title="图表设置"
        aria-label="图表设置"
      >
        <Settings size={14} aria-hidden />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="图表设置"
            className="w-full max-w-lg max-h-full rounded-lg overflow-hidden flex flex-col"
            style={{ background: "rgba(10,14,28,0.98)", border: `1px solid ${BORDER}`, boxShadow: "0 16px 48px rgba(0,0,0,0.6)" }}
          >
            <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
              <span className="text-[11px] tracking-widest" style={{ ...mono, color: SUB }}>
                图表设置
              </span>
              <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-violet-500/10" style={{ color: SUB }} aria-label="关闭">
                <X size={14} aria-hidden />
              </button>
            </div>
            <div className="flex min-h-[220px] overflow-y-auto">
              <nav className="w-28 shrink-0 p-2 space-y-1" style={{ borderRight: `1px solid ${BORDER}` }}>
                {SETTINGS_SECTIONS.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setSection(s.key)}
                    className="w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors"
                    style={{
                      color: section === s.key ? "#fff" : SUB,
                      background: section === s.key ? "rgba(139,92,246,0.3)" : "transparent",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </nav>
              <div className="flex-1 p-4 space-y-5">
                {section === "session" && (
                  <Toggle
                    checked={settings.extendedHours}
                    onChange={(v) => onChange({ ...settings, extendedHours: v })}
                    label="盘前盘后"
                    hint="分钟线、小时线显示 04:00–09:30 和 16:00–20:00(美东);日线/周线不受影响"
                  />
                )}
                {section === "chart" && (
                  <>
                    <div className="text-[10px]" style={{ color: MUTED }}>
                      默认视野:打开、换周期、点刷新时回到这里。手动拖动、缩放不会改这些设置。
                    </div>
                    <Slider
                      label="K 线宽度"
                      value={settings.barSpacing}
                      min={3}
                      max={30}
                      unit="px"
                      onChange={(v) => onChange({ ...settings, barSpacing: v })}
                    />
                    <Slider
                      label="最新 K 线位置"
                      hint="最后一根 K 线在图宽的位置,右边留白"
                      value={settings.lastBarAt}
                      min={50}
                      max={95}
                      unit="%"
                      onChange={(v) => onChange({ ...settings, lastBarAt: v })}
                    />
                    <MarkColorPicker colors={settings.markColors} onChange={(markColors) => onChange({ ...settings, markColors })} />
                    <button
                      onClick={() =>
                        onChange({
                          ...settings,
                          barSpacing: DEFAULT_SETTINGS.barSpacing,
                          lastBarAt: DEFAULT_SETTINGS.lastBarAt,
                          markColors: DEFAULT_SETTINGS.markColors,
                        })
                      }
                      className="text-[11px] px-2.5 py-1 rounded transition-colors hover:bg-violet-500/10"
                      style={{ color: SUB, border: `1px solid ${BORDER}` }}
                    >
                      恢复默认
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

interface Holding {
  ticker: string;
  qty: number;
  avgCost: number;
}

// ---------- 左侧列表(持仓 + 自选列表) ----------

const HOLDINGS_TAB = "holdings";
const TAB_KEY = "chart.tab";

function readTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? HOLDINGS_TAB;
  } catch {
    return HOLDINGS_TAB;
  }
}

// 左侧列表的排序:null = 手动顺序(可拖拽);点表头在 升 → 降 → 手动 之间切换
type ListSort = { key: "name" | "chg"; dir: 1 | -1 } | null;
const SORT_KEY = "chart.listSort";
// 持仓没有对应的表,手动顺序只存在本机
const HOLDINGS_ORDER_KEY = "chart.holdingsOrder";

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 存不了就只对本次页面生效 */
  }
}

/** 当天走势迷你图:前收盘为虚线基准,收在前收盘之上红、之下绿 */
function Sparkline({ spark }: { spark: Spark | null | undefined }) {
  const W = 72;
  const H = 30;
  const closes = spark?.closes ?? [];
  if (closes.length < 2) return <span style={{ width: W, height: H }} className="block" />;
  const base = spark?.previousClose ?? closes[0];
  const lo = Math.min(base, ...closes);
  const hi = Math.max(base, ...closes);
  const span = hi - lo || 1;
  const y = (v: number) => 2 + (H - 4) * (1 - (v - lo) / span);
  // 一天常规时段 78 根 5 分钟线,盘中没走完的按比例只画到当前位置
  const slots = Math.max(78, closes.length);
  const x = (i: number) => (i / (slots - 1)) * W;
  const color = closes[closes.length - 1] >= base ? UP : DOWN;
  const line = closes.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `0,${H} ${line} ${x(closes.length - 1).toFixed(1)},${H}`;
  const gid = `spark-${color.slice(1)}`;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={W} y1={y(base)} y2={y(base)} stroke={SUB} strokeOpacity="0.5" strokeWidth="1" strokeDasharray="2 2" />
      <polygon points={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

interface ListRow {
  ticker: string;
  /** 代码下面那行小字:持仓显示股数和盈亏,自选显示公司名 */
  sub?: ReactNode;
}

function SidePanel({
  tab,
  onTab,
  lists,
  listsError,
  rows,
  quotes,
  sparks,
  active,
  onPick,
  onManageLists,
  sort,
  onSort,
  onReorder,
  onRefresh,
  refreshing,
  refreshNote,
}: {
  tab: string;
  onTab: (tab: string) => void;
  lists: Watchlist[];
  listsError: string | null;
  rows: ListRow[];
  quotes: QuotesResponse | null;
  sparks: Record<string, Spark | null>;
  active: string;
  onPick: (ticker: string) => void;
  onManageLists: () => void;
  sort: ListSort;
  onSort: (sort: ListSort) => void;
  /** 拖拽后的完整新顺序(排序状态下拖拽 = 以当前显示顺序为基础手动调整) */
  onReorder: (tickers: string[]) => void;
  /** 持仓页签右上角的刷新:从 SnapTrade 拉最新成交再重算持仓 */
  onRefresh: () => void;
  refreshing: boolean;
  refreshNote: string | null;
}) {
  const [input, setInput] = useState("");
  // 拖拽:dragFrom = 拖起的行下标,dropAt = 插入位置(0..n)
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const chgOf = (t: string) => {
    const q = quotes?.usd[t];
    return q && q.pc ? ((q.c - q.pc) / q.pc) * 100 : null;
  };
  const shown = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => {
      if (sort.key === "name") return sort.dir * a.ticker.localeCompare(b.ticker);
      // 没报价的永远排最后
      const ca = chgOf(a.ticker);
      const cb = chgOf(b.ticker);
      if (ca === null || cb === null) return ca === null ? (cb === null ? 0 : 1) : -1;
      return sort.dir * (ca - cb);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort, quotes]);
  // 第一次点:代码 A→Z、涨跌 从高到低;第二次反过来;第三次回到手动顺序
  const clickSort = (key: "name" | "chg") => {
    const first = key === "name" ? 1 : -1;
    if (sort?.key !== key) onSort({ key, dir: first });
    else if (sort.dir === first) onSort({ key, dir: -first as 1 | -1 });
    else onSort(null);
  };
  const sortIcon = (key: "name" | "chg") =>
    sort?.key === key ? sort.dir === 1 ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden /> : null;
  const endDrag = () => {
    setDragFrom(null);
    setDropAt(null);
  };
  const drop = () => {
    if (dragFrom !== null && dropAt !== null && dropAt !== dragFrom && dropAt !== dragFrom + 1) {
      const order = shown.map((r) => r.ticker);
      const [moved] = order.splice(dragFrom, 1);
      order.splice(dropAt > dragFrom ? dropAt - 1 : dropAt, 0, moved);
      onReorder(order);
    }
    endDrag();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = input.trim().toUpperCase();
    if (t) onPick(t);
    setInput("");
  };
  const list = lists.find((l) => l.id === tab) ?? null;
  const tabs = [{ id: HOLDINGS_TAB, name: "持仓" }, ...lists.map((l) => ({ id: l.id, name: l.name }))];
  return (
    <aside className="flex flex-col min-h-0 lg:w-[340px] shrink-0" style={{ borderRight: `1px solid ${BORDER}` }}>
      <div className="px-4 pt-4 pb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-bold text-white truncate">
            {list ? list.name : "美股持仓"} ({rows.length})
          </span>
          {!list && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title={refreshNote ?? "从 SnapTrade 拉最新成交,更新持仓"}
              aria-label="刷新持仓"
              className="p-1 rounded hover:bg-white/5 shrink-0"
              style={{ color: SUB, opacity: refreshing ? 0.6 : 1 }}
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : undefined} />
            </button>
          )}
        </span>
        <form onSubmit={submit} autoComplete="off" role="search">
          {/* 只是个搜索框:关掉自动填充,免得 Safari / iCloud 密码、1Password 把它当成登录框 */}
          <input
            type="search"
            name="ticker-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入代码 ↵"
            className="w-24 px-2 py-1 rounded text-xs outline-none"
            style={{ ...mono, background: "rgba(139,92,246,0.08)", border: `1px solid ${BORDER}`, color: TEXT }}
          />
        </form>
      </div>
      {!list && refreshNote && (
        <div className="px-4 pb-1.5 text-[10px]" style={{ color: SUB }}>
          {refreshNote}
        </div>
      )}

      {/* 列表切换 */}
      <div className="px-3 pb-2 flex items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onTab(t.id)}
            className="px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors"
            style={{
              color: tab === t.id ? "#fff" : SUB,
              background: tab === t.id ? "rgba(139,92,246,0.3)" : "transparent",
              fontWeight: tab === t.id ? 600 : 400,
            }}
          >
            {t.name}
          </button>
        ))}
        {!listsError && (
          <button onClick={onManageLists} className="p-1 rounded hover:bg-violet-500/10 shrink-0" style={{ color: SUB }} title="管理列表" aria-label="管理列表">
            <Plus size={14} aria-hidden />
          </button>
        )}
      </div>
      {listsError && (
        <div className="px-4 pb-2 text-[10px] leading-relaxed" style={{ ...mono, color: "#fbbf24" }}>
          {listsError}
        </div>
      )}

      <div
        className="grid grid-cols-[1fr_72px_auto] gap-x-3 px-4 pb-2 text-[10px] tracking-widest"
        style={{ ...mono, color: MUTED, borderBottom: `1px solid ${BORDER}` }}
      >
        <button className="flex items-center gap-1 text-left whitespace-nowrap text-[10px] tracking-widest hover:text-violet-300" onClick={() => clickSort("name")} title="按代码排序(再点反序,第三次回到手动顺序)">
          代码 {sortIcon("name")}
        </button>
        <span>今日</span>
        <button className="relative text-right w-20 whitespace-nowrap text-[10px] tracking-widest hover:text-violet-300" onClick={() => clickSort("chg")} title="按涨跌幅排序(再点反序,第三次回到手动顺序)">
          {/* 箭头挂在左边,不占列宽 */}
          <span className="absolute -left-3.5 top-1/2 -translate-y-1/2">{sortIcon("chg")}</span>
          现价 / 涨跌
        </button>
      </div>
      <div className="overflow-y-auto max-h-72 lg:max-h-none lg:flex-1">
        {shown.map((r, i) => {
          const q = quotes?.usd[r.ticker] ?? null;
          const chg = chgOf(r.ticker);
          const selected = r.ticker === active;
          return (
            <button
              key={r.ticker}
              onClick={() => onPick(r.ticker)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", r.ticker);
                setDragFrom(i);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop();
              }}
              onDragEnd={endDrag}
              className="w-full grid grid-cols-[1fr_72px_auto] gap-x-3 items-center px-4 py-2 text-left transition-colors hover:bg-violet-500/5 cursor-grab active:cursor-grabbing"
              style={{
                borderBottom: "1px solid rgba(139,92,246,0.07)",
                background: selected ? "rgba(139,92,246,0.14)" : undefined,
                borderLeft: `2px solid ${selected ? "#8b5cf6" : "transparent"}`,
                opacity: dragFrom === i ? 0.4 : 1,
                // 插入位置画一条紫线
                boxShadow:
                  dropAt === i ? "inset 0 2px 0 #8b5cf6" : dropAt === i + 1 && i === shown.length - 1 ? "inset 0 -2px 0 #8b5cf6" : undefined,
              }}
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold" style={{ ...mono, color: TEXT }}>
                  {r.ticker}
                </span>
                <span className="block text-[10px] truncate" style={{ ...mono, color: SUB }}>
                  {r.sub ?? sparks[r.ticker]?.name ?? ""}
                </span>
              </span>
              <Sparkline spark={sparks[r.ticker]} />
              <span className="text-right w-20">
                <span className="block text-sm" style={{ ...mono, color: chgColor(chg) }}>
                  {fmtPrice(q?.c)}
                </span>
                <span className="block text-xs" style={{ ...mono, color: chgColor(chg) }}>
                  {fmtPct(chg)}
                </span>
              </span>
            </button>
          );
        })}
        {rows.length === 0 && (
          <div className="px-4 py-6 text-xs text-center leading-relaxed whitespace-pre-line" style={{ ...mono, color: MUTED }}>
            {list ? "这个列表还是空的。\n打开一只股票,点标题旁边的 ♡ 加进来" : "没有美股持仓"}
          </div>
        )}
      </div>
    </aside>
  );
}

/** 列表管理弹窗:拖左边的把手改顺序,每行可改名/删除,最下面一行输入名字新建 */
function ListManager({
  lists,
  onClose,
  onCreate,
  onRename,
  onDelete,
  onReorder,
}: {
  lists: Watchlist[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (list: Watchlist, name: string) => void;
  onDelete: (list: Watchlist) => void;
  onReorder: (ids: string[]) => void;
}) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  // 只有按住把手时整行才可拖,免得拖动选中输入框里的文字
  const [armed, setArmed] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  const endDrag = () => {
    setArmed(null);
    setDragFrom(null);
    setDropAt(null);
  };
  const drop = () => {
    if (dragFrom !== null && dropAt !== null && dropAt !== dragFrom && dropAt !== dragFrom + 1) {
      const ids = lists.map((l) => l.id);
      const [moved] = ids.splice(dragFrom, 1);
      ids.splice(dropAt > dragFrom ? dropAt - 1 : dropAt, 0, moved);
      onReorder(ids);
    }
    endDrag();
  };
  const commitEdit = () => {
    if (!editing) return;
    const list = lists.find((l) => l.id === editing.id);
    const name = editing.name.trim();
    if (list && name && name !== list.name) onRename(list, name);
    setEditing(null);
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    onCreate(name);
    setNewName("");
  };
  const inputStyle = { ...mono, background: "rgba(139,92,246,0.08)", border: `1px solid ${BORDER}`, color: TEXT };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="管理列表"
        className="w-full max-w-sm rounded-lg shadow-2xl flex flex-col max-h-[80vh]"
        style={{ background: "#0b1020", border: `1px solid ${BORDER}` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${BORDER}` }}>
          <span className="text-sm font-bold text-white">管理列表</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-violet-500/10" style={{ color: SUB }} aria-label="关闭">
            <X size={15} aria-hidden />
          </button>
        </div>

        <div className="overflow-y-auto py-1">
          {lists.map((l, i) => (
            <div
              key={l.id}
              draggable={armed === l.id}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", l.id);
                setDragFrom(i);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop();
              }}
              onDragEnd={endDrag}
              className="flex items-center gap-2 px-2 py-1.5"
              style={{
                opacity: dragFrom === i ? 0.4 : 1,
                boxShadow:
                  dropAt === i ? "inset 0 2px 0 #8b5cf6" : dropAt === i + 1 && i === lists.length - 1 ? "inset 0 -2px 0 #8b5cf6" : undefined,
              }}
            >
              <span
                className="p-1 cursor-grab active:cursor-grabbing"
                style={{ color: MUTED }}
                onPointerDown={() => setArmed(l.id)}
                onPointerUp={() => dragFrom === null && setArmed(null)}
                title="拖动改顺序"
              >
                <GripVertical size={14} aria-hidden />
              </span>
              {editing?.id === l.id ? (
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="flex-1 min-w-0 px-2 py-1 rounded text-sm outline-none"
                  style={inputStyle}
                />
              ) : (
                <span className="flex-1 min-w-0 truncate text-sm" style={{ color: TEXT }}>
                  {l.name}
                  <span className="ml-2 text-[10px]" style={{ ...mono, color: MUTED }}>
                    {l.symbols.length}
                  </span>
                </span>
              )}
              <button
                onClick={() => setEditing({ id: l.id, name: l.name })}
                className="p-1.5 rounded hover:bg-violet-500/10 hover:text-violet-300"
                style={{ color: SUB }}
                title="改名"
                aria-label={`改名 ${l.name}`}
              >
                <Pencil size={13} aria-hidden />
              </button>
              <button
                onClick={() => onDelete(l)}
                className="p-1.5 rounded hover:bg-red-500/10 hover:text-red-400"
                style={{ color: SUB }}
                title="删除"
                aria-label={`删除 ${l.name}`}
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
          ))}
          {lists.length === 0 && (
            <div className="px-4 py-4 text-xs text-center" style={{ ...mono, color: MUTED }}>
              还没有自选列表
            </div>
          )}
        </div>

        <form onSubmit={add} autoComplete="off" className="flex items-center gap-2 px-4 py-3" style={{ borderTop: `1px solid ${BORDER}` }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新列表名"
            data-1p-ignore
            data-lpignore="true"
            className="flex-1 min-w-0 px-2 py-1.5 rounded text-sm outline-none"
            style={inputStyle}
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="flex items-center gap-1 px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-40"
            style={{ color: "#fff", background: "rgba(139,92,246,0.35)", border: "1px solid rgba(139,92,246,0.6)" }}
          >
            <Plus size={12} aria-hidden />
            添加
          </button>
        </form>
      </div>
    </div>
  );
}

/** 标题旁的爱心:空心 = 不在任何列表;红心 = 至少在一个列表。点开勾选要放进哪些列表 */
function FavoriteButton({
  symbol,
  lists,
  disabled,
  onToggle,
  onCreate,
}: {
  symbol: string;
  lists: Watchlist[];
  disabled: boolean;
  onToggle: (list: Watchlist) => void;
  onCreate: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const inAny = lists.some((l) => l.symbols.includes(symbol));
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || !symbol}
        className="p-1 rounded transition-colors hover:bg-violet-500/10 disabled:opacity-30"
        title={inAny ? "已收藏 · 管理所在列表" : "加入自选列表"}
        aria-label="收藏到列表"
        aria-expanded={open}
      >
        <Heart size={17} aria-hidden fill={inAny ? UP : "none"} style={{ color: inAny ? UP : SUB }} />
      </button>
      {open && (
        <div
          className="absolute left-0 mt-2 w-56 rounded-lg py-2 z-30"
          style={{ background: "rgba(10,14,28,0.97)", border: `1px solid ${BORDER}`, boxShadow: "0 8px 32px rgba(0,0,0,0.5)" }}
        >
          <div className="px-3 pb-2 text-[10px] tracking-widest" style={{ ...mono, color: MUTED }}>
            把 {symbol} 放进
          </div>
          {lists.map((l) => {
            const checked = l.symbols.includes(symbol);
            return (
              <label key={l.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-violet-500/10" style={{ color: TEXT }}>
                <input type="checkbox" checked={checked} onChange={() => onToggle(l)} className="accent-violet-500" />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="text-[10px]" style={{ ...mono, color: MUTED }}>
                  {l.symbols.length}
                </span>
              </label>
            );
          })}
          {lists.length === 0 && (
            <div className="px-3 py-1 text-[11px]" style={{ color: MUTED }}>
              还没有列表,在下面建一个
            </div>
          )}
          <form
            className="px-3 pt-2 mt-1 flex gap-1.5"
            style={{ borderTop: `1px solid ${BORDER}` }}
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              const n = name.trim();
              if (n) onCreate(n);
              setName("");
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              name="watchlist-name"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              placeholder="新列表名 ↵"
              className="flex-1 min-w-0 px-2 py-1 rounded text-xs outline-none"
              style={{ background: "rgba(139,92,246,0.08)", border: `1px solid ${BORDER}`, color: TEXT }}
            />
          </form>
        </div>
      )}
    </div>
  );
}

// ---------- K 线 ----------

interface Legend {
  bar: Candle;
  prevClose: number | null;
  emas: Record<number, number | undefined>;
  marks: BarTrades | undefined;
}

/** 纵向自动缩放以 K 线为准,EMA 最多把上下各撑开 K 线高低差的这么多倍,再远的部分出屏 */
const EMA_SCALE_SLACK = 0.35;

/** 默认视野:K 线宽 barSpacing,最后一根放在图宽 lastBarAt% 处 */
function placeLastBar(chart: IChartApi, barSpacing: number, lastBarAt: number, tries = 0) {
  const ts = chart.timeScale();
  const width = ts.width();
  // autoSize 要等 ResizeObserver 量完尺寸,宽度还是 0 时下一帧再试
  if (width <= 0) {
    if (tries < 30) requestAnimationFrame(() => placeLastBar(chart, barSpacing, lastBarAt, tries + 1));
    return;
  }
  ts.applyOptions({ barSpacing });
  ts.scrollToPosition((width * (1 - lastBarAt / 100)) / barSpacing, false);
}

const DRAW_TOOLS: { key: DrawTool; label: string; Icon: typeof Minus }[] = [
  { key: "cursor", label: "选择(点线条选中,Delete 删除)", Icon: MousePointer2 },
  { key: "ray", label: "射线:点起点,再点方向", Icon: MoveUpRight },
  { key: "hline", label: "水平线:点一下", Icon: Minus },
  { key: "rect", label: "矩形:点一个角,再点对角", Icon: RectangleHorizontal },
];

function ToolButton({
  active,
  disabled,
  title,
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="w-8 h-8 flex items-center justify-center rounded transition-colors hover:bg-violet-500/15 disabled:opacity-30 disabled:hover:bg-transparent"
      style={{
        color: active ? "#fff" : SUB,
        background: active ? "rgba(139,92,246,0.35)" : undefined,
        border: `1px solid ${active ? "rgba(139,92,246,0.6)" : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}

function CandleChart({
  symbol,
  period,
  data,
  marks,
  avgCost,
  viewKey,
  resetNonce,
  barSpacing,
  lastBarAt,
  markColors,
}: {
  symbol: string;
  period: Period;
  data: CandleData | null;
  marks: BarTrades[];
  avgCost: number | null;
  /** 换周期/盘前盘后/默认视野设置时变,视野重置到默认;换股票不重置,沿用当前的缩放和滚动位置 */
  viewKey: string;
  /** 刷新键 +1,视野重置到默认 */
  resetNonce: number;
  /** 默认视野(设置里调),viewKey 里也带上它们,改了设置就重置到新的默认视野 */
  barSpacing: number;
  lastBarAt: number;
  markColors: MarkColors;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRefs = useRef<Record<number, ISeriesApi<"Line">>>({});
  const marksPrimRef = useRef<TradeMarksPrimitive | null>(null);
  const costLineRef = useRef<IPriceLine | null>(null);
  // 上次定位视野时的 symbol / viewKey / resetNonce;同一组下的轮询刷新不动用户拖过的视野
  const fittedRef = useRef<{ symbol: string; viewKey: string; resetNonce: number } | null>(null);
  // 用户当前的横向视野(缩放 + 最后一根离右边几根 bar),换股票时照搬过去
  const viewRef = useRef<{ barSpacing: number; scrollPos: number } | null>(null);
  const hasDataRef = useRef(false);
  // EMA 的 autoscaleInfoProvider 在图表回调里读当前 K 线
  const candlesRef = useRef<Candle[]>([]);
  const [hover, setHover] = useState<Legend | null>(null);

  // 画线
  const primRef = useRef<DrawingsPrimitive | null>(null);
  const pendingRef = useRef<Pt | null>(null);
  const [tool, setTool] = useState<DrawTool>("cursor");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 图表只建一次
  useEffect(() => {
    const el = containerRef.current!;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: SUB,
        fontFamily: "'JetBrains Mono', monospace",
        attributionLogo: false,
        panes: { separatorColor: BORDER, separatorHoverColor: "rgba(139,92,246,0.35)" },
      },
      grid: {
        vertLines: { color: "rgba(139,92,246,0.06)" },
        horzLines: { color: "rgba(139,92,246,0.06)" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: BORDER, scaleMargins: { top: 0.08, bottom: 0.05 } },
      timeScale: { borderColor: BORDER, rightOffset: 6, timeVisible: true, secondsVisible: false },
      localization: { locale: "zh-CN" },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    // 成交量放在下面单独一个 pane,右边坐标轴就是成交量的刻度,不和价格轴混在一起
    const vol = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      },
      1
    );
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    const [pricePane, volPane] = chart.panes();
    pricePane.setStretchFactor(0.78);
    volPane.setStretchFactor(0.22);
    // EMA 不能把价格轴拉太开:均线滞后,跳空后 EMA50 会远在 K 线下面,全算进去 K 线就被挤到半屏
    const emaAutoscale = (base: () => AutoscaleInfo | null): AutoscaleInfo | null => {
      const info = base();
      const range = chart.timeScale().getVisibleLogicalRange();
      const bars = candlesRef.current;
      if (!info?.priceRange || !range || !bars.length) return info;
      const from = Math.max(0, Math.floor(range.from));
      const to = Math.min(bars.length - 1, Math.ceil(range.to));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i <= to; i++) {
        lo = Math.min(lo, bars[i].low);
        hi = Math.max(hi, bars[i].high);
      }
      if (lo > hi) return info;
      const slack = (hi - lo) * EMA_SCALE_SLACK;
      const { minValue, maxValue } = info.priceRange;
      return { ...info, priceRange: { minValue: Math.max(minValue, lo - slack), maxValue: Math.min(maxValue, hi + slack) } };
    };
    for (const n of EMA_LENGTHS) {
      emaRefs.current[n] = chart.addSeries(LineSeries, {
        color: EMA_COLORS[n],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: emaAutoscale,
      });
    }
    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;
    const marksPrim = new TradeMarksPrimitive();
    candle.attachPrimitive(marksPrim);
    marksPrimRef.current = marksPrim;
    const prim = new DrawingsPrimitive();
    candle.attachPrimitive(prim);
    primRef.current = prim;
    // 有数据时才记视野;换股票中途 setData([]) 引起的变化不算
    const ts = chart.timeScale();
    const onRange = () => {
      if (hasDataRef.current) viewRef.current = { barSpacing: ts.options().barSpacing, scrollPos: ts.scrollPosition() };
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  const candles = data?.candles ?? [];
  candlesRef.current = candles;
  const emaSeries = useMemo(() => {
    const out: Record<number, { time: number; value: number }[]> = {};
    for (const n of EMA_LENGTHS) out[n] = ema(candles, n);
    return out;
  }, [candles]);
  const indexByTime = useMemo(() => new Map(candles.map((c, i) => [c.time, i])), [candles]);
  const marksByTime = useMemo(() => new Map(marks.map((m) => [m.time, m])), [marks]);

  const legendAt = useCallback(
    (i: number): Legend | null => {
      const bar = candles[i];
      if (!bar) return null;
      const emas: Record<number, number | undefined> = {};
      for (const n of EMA_LENGTHS) {
        const s = emaSeries[n];
        // ema 序列从第 n-1 根开始,对应下标 i-(n-1)
        emas[n] = s[i - (n - 1)]?.value;
      }
      const prevClose = i > 0 ? candles[i - 1].close : data?.previousClose ?? null;
      return { bar, prevClose, emas, marks: marksByTime.get(bar.time) };
    },
    [candles, emaSeries, marksByTime, data?.previousClose]
  );

  // 喂数据
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !candleRef.current || !volRef.current) return;
    const t = (x: number) => x as UTCTimestamp;
    hasDataRef.current = false;
    candleRef.current.setData(candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    volRef.current.setData(
      candles.map((c) => ({
        time: t(c.time),
        value: c.volume,
        color: c.close >= c.open ? "rgba(242,54,69,0.45)" : "rgba(8,153,129,0.45)",
      }))
    );
    for (const n of EMA_LENGTHS) emaRefs.current[n]?.setData(emaSeries[n].map((p) => ({ time: t(p.time), value: p.value })));
    marksPrimRef.current?.setMarks(
      marks.flatMap((m) => {
        const price = markPrice(m, candles[indexByTime.get(m.time) ?? -1]);
        return price === null ? [] : [{ time: m.time, price, color: markColors[m.kind], text: MARK_TEXT[m.kind] }];
      })
    );
    const fitted = fittedRef.current;
    if (candles.length && (!fitted || fitted.symbol !== symbol || fitted.viewKey !== viewKey || fitted.resetNonce !== resetNonce)) {
      const keepView = fitted && fitted.viewKey === viewKey && fitted.resetNonce === resetNonce && viewRef.current;
      fittedRef.current = { symbol, viewKey, resetNonce };
      // 价格轴每次都回到自动缩放:不同股票价位不一样,纵向拖过的也一并还原
      candleRef.current.priceScale().applyOptions({ autoScale: true });
      volRef.current.priceScale().applyOptions({ autoScale: true });
      if (keepView) {
        const ts = chart.timeScale();
        ts.applyOptions({ barSpacing: viewRef.current!.barSpacing });
        ts.scrollToPosition(viewRef.current!.scrollPos, false);
      } else {
        placeLastBar(chart, barSpacing, lastBarAt);
      }
    }
    hasDataRef.current = candles.length > 0;
  }, [candles, emaSeries, marks, symbol, viewKey, resetNonce, indexByTime, barSpacing, lastBarAt, markColors]);

  // 持仓均价线
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    if (costLineRef.current) series.removePriceLine(costLineRef.current);
    costLineRef.current =
      avgCost !== null
        ? series.createPriceLine({
            price: avgCost,
            color: "#a78bfa",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "均价",
          })
        : null;
  }, [avgCost]);

  // 十字光标 → 顶部图例;移出图表回到最后一根
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (p: MouseEventParams<Time>) => {
      const i = p.time !== undefined ? indexByTime.get(p.time as number) : undefined;
      setHover(i !== undefined ? legendAt(i) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [indexByTime, legendAt]);

  // ---- 画线 ----

  useEffect(() => {
    setDrawings(loadDrawings(symbol));
    setSelectedId(null);
  }, [symbol]);

  useEffect(() => {
    primRef.current?.setDrawings(drawings, selectedId);
  }, [drawings, selectedId]);

  useEffect(() => {
    primRef.current?.setTimeline(
      candles.map((c) => c.time),
      BAR_SECONDS[period]
    );
  }, [candles, period]);

  // 换工具时丢掉画了一半的
  useEffect(() => {
    pendingRef.current = null;
    primRef.current?.setDraft(null);
  }, [tool, symbol]);

  const commit = useCallback(
    (next: Drawing[]) => {
      setDrawings(next);
      saveDrawings(symbol, next);
    },
    [symbol]
  );

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    commit(drawings.filter((d) => d.id !== selectedId));
    setSelectedId(null);
  }, [commit, drawings, selectedId]);

  useEffect(() => {
    const chart = chartRef.current;
    const prim = primRef.current;
    if (!chart || !prim) return;
    const twoPoint = (type: "ray" | "rect", a: Pt, b: Pt, id: string): Drawing =>
      type === "ray" ? { id, type: "ray", a, b } : { id, type: "rect", a, b };

    // 不用 chart.subscribeClick:它会把两下快速点击当双击吞掉,画射线/矩形时第二下就丢了。
    // 自己在容器上认"按下又松开、没怎么移动"为一次点击。
    const el = containerRef.current!;
    let down: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? local(e) : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      const { x, y } = local(e);
      const moved = Math.hypot(x - down.x, y - down.y);
      down = null;
      // 拖动是平移图表;点在右侧价格轴上也不算
      if (moved > 4 || x > chart.timeScale().width()) return;
      // 只在上面的 K 线 pane 里画,点到成交量 pane 不算
      if (tool !== "cursor" && y > chart.panes()[0].getHeight()) return;
      onClick(x, y);
    };

    const onClick = (x: number, y: number) => {
      if (tool === "cursor") {
        setSelectedId(prim.findAt(x, y));
        return;
      }
      const pt = prim.pointToPt(x, y);
      if (!pt) return;
      if (tool === "hline") {
        const d: Drawing = { id: crypto.randomUUID(), type: "hline", price: pt.price };
        commit([...drawings, d]);
        setSelectedId(d.id);
        setTool("cursor");
        return;
      }
      const start = pendingRef.current;
      if (!start) {
        pendingRef.current = pt;
        prim.setDraft(twoPoint(tool, pt, pt, "draft"));
        return;
      }
      const d = twoPoint(tool, start, pt, crypto.randomUUID());
      commit([...drawings, d]);
      setSelectedId(d.id);
      setTool("cursor");
    };

    // 画的过程中跟着鼠标预览
    const onMove = (p: MouseEventParams<Time>) => {
      if (tool === "cursor" || !p.point) return;
      const pt = prim.pointToPt(p.point.x, p.point.y);
      if (!pt) return;
      if (tool === "hline") prim.setDraft({ id: "draft", type: "hline", price: pt.price });
      else if (pendingRef.current) prim.setDraft(twoPoint(tool, pendingRef.current, pt, "draft"));
    };

    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("pointerup", onUp, true);
    chart.subscribeCrosshairMove(onMove);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("pointerup", onUp, true);
      chart.unsubscribeCrosshairMove(onMove);
    };
  }, [tool, drawings, commit]);

  // Esc 取消正在画的 / 取消选中;Delete、Backspace 删掉选中的
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "Escape") {
        setTool("cursor");
        setSelectedId(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, selectedId]);

  const legend = hover ?? legendAt(candles.length - 1);
  const chg = legend && legend.prevClose ? ((legend.bar.close - legend.prevClose) / legend.prevClose) * 100 : null;
  const barColor = legend ? chgColor(chg) : TEXT;

  return (
    <div className="flex-1 min-h-[420px] flex">
      <div className="flex flex-col items-center gap-1 px-1.5 py-2 shrink-0" style={{ borderRight: `1px solid ${BORDER}` }}>
        {DRAW_TOOLS.map(({ key, label, Icon }) => (
          <ToolButton key={key} active={tool === key} title={label} onClick={() => setTool(key)}>
            <Icon size={15} aria-hidden />
          </ToolButton>
        ))}
        <div className="w-5 my-1" style={{ borderTop: `1px solid ${BORDER}` }} />
        <ToolButton title="删除选中的线" disabled={!selectedId} onClick={deleteSelected}>
          <Trash2 size={15} aria-hidden />
        </ToolButton>
        <ToolButton
          title={`清除 ${symbol} 的全部画线`}
          disabled={drawings.length === 0}
          onClick={() => {
            if (window.confirm(`清除 ${symbol} 上的 ${drawings.length} 条画线?`)) {
              commit([]);
              setSelectedId(null);
            }
          }}
        >
          <Eraser size={15} aria-hidden />
        </ToolButton>
      </div>
      <div className="relative flex-1 min-w-0">
      <div ref={containerRef} className="absolute inset-0" />
      {legend && (
        <div className="absolute left-3 top-2 z-10 pointer-events-none text-[11px] space-y-1" style={mono}>
          <div className="flex flex-wrap gap-x-3" style={{ color: SUB }}>
            <span>O <b style={{ color: barColor, fontWeight: 500 }}>{fmtPrice(legend.bar.open)}</b></span>
            <span>H <b style={{ color: barColor, fontWeight: 500 }}>{fmtPrice(legend.bar.high)}</b></span>
            <span>L <b style={{ color: barColor, fontWeight: 500 }}>{fmtPrice(legend.bar.low)}</b></span>
            <span>C <b style={{ color: barColor, fontWeight: 500 }}>{fmtPrice(legend.bar.close)}</b></span>
            <span style={{ color: barColor }}>{fmtPct(chg)}</span>
            <span>Vol <b style={{ color: TEXT, fontWeight: 500 }}>{fmtVol(legend.bar.volume)}</b></span>
          </div>
          <div className="flex flex-wrap gap-x-3">
            {EMA_LENGTHS.map((n) => (
              <span key={n} style={{ color: EMA_COLORS[n] }}>
                EMA{n} {fmtPrice(legend.emas[n])}
              </span>
            ))}
          </div>
          {legend.marks && (
            <div className="flex flex-col gap-0.5">
              {legend.marks.trades.map((t) => (
                <span key={t.id} style={{ color: t.side === "buy" ? markColors.B : markColors.S }}>
                  {t.side === "buy" ? "买" : "卖"} {t.qty} @ {t.price}
                  <span style={{ color: SUB }}>
                    {" "}
                    · {t.account ?? ""}
                    {t.ts ? ` · ${new Date(t.ts).toLocaleString("zh-CN", { timeZone: "America/New_York", hour12: false })} ET` : ` · ${t.date}`}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ---------- 页面 ----------

export default function ChartPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [trades, setTrades] = useState<StockTrade[]>([]);
  const [splits, setSplits] = useState<StockSplit[]>([]);
  const [quotes, setQuotes] = useState<QuotesResponse | null>(null);
  const [period, setPeriodState] = useState<Period>(readPeriod);
  const [settings, setSettingsState] = useState<ChartSettings>(readSettings);
  const [data, setData] = useState<CandleData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [resetNonce, setResetNonce] = useState(0);
  const [lists, setLists] = useState<Watchlist[]>([]);
  const [listsError, setListsError] = useState<string | null>(null);
  const [tab, setTabState] = useState<string>(readTab);
  const [sparks, setSparks] = useState<Record<string, Spark | null>>({});
  const [listSort, setListSortState] = useState<ListSort>(() => readJson<ListSort>(SORT_KEY, null));
  const [managingLists, setManagingLists] = useState(false);
  const [holdingsOrder, setHoldingsOrder] = useState<string[]>(() => readJson<string[]>(HOLDINGS_ORDER_KEY, []));

  // 美股持仓:同一 ticker 跨账户合并
  const holdings = useMemo<Holding[]>(() => {
    const byTicker = new Map<string, { qty: number; cost: number }>();
    for (const p of computePositions(trades, splits)) {
      if (!isUsStock(p)) continue;
      const h = byTicker.get(p.ticker) ?? { qty: 0, cost: 0 };
      h.qty += p.qty;
      h.cost += p.qty * p.avg_cost;
      byTicker.set(p.ticker, h);
    }
    return [...byTicker.entries()]
      .map(([ticker, h]) => ({ ticker, qty: Math.round(h.qty * 10000) / 10000, avgCost: h.qty > 0 ? h.cost / h.qty : 0 }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [trades, splits]);

  const symbol = (params.symbol ?? holdings[0]?.ticker ?? "").toUpperCase();
  const holding = holdings.find((h) => h.ticker === symbol) ?? null;

  const setSettings = (next: ChartSettings) => {
    setSettingsState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* 存不了就只对本次页面生效 */
    }
  };

  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      localStorage.setItem(PERIOD_KEY, p);
    } catch {
      /* 存不了就算了 */
    }
  };

  const loadTrades = useCallback(
    () =>
      Promise.all([
        fetchAll<StockTrade>("stock_trades", ["date", "ts", "id"]),
        fetchAll<StockSplit>("stock_splits", ["date", "ts", "id"]),
      ]).then(([t, s]) => {
        setTrades(t);
        setSplits(s);
      }),
    []
  );

  useEffect(() => {
    loadTrades().catch((e) => setError(String((e as Error).message ?? e)));
  }, [loadTrades]);

  // 刷新持仓:先让 snaptrade-sync 把新成交写进库,再重读交易重算持仓。
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const refreshHoldings = async () => {
    setRefreshing(true);
    try {
      const r = await runSnaptradeSync();
      await loadTrades();
      const n = r.newTrades + r.newCash;
      setRefreshNote(`${new Date().toLocaleTimeString()} 已刷新:${n ? `新增交易 ${r.newTrades} / 现金 ${r.newCash}` : "没有新成交"}`);
    } catch (e) {
      setRefreshNote(`刷新失败:${String((e as Error).message ?? e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  // ---- 自选列表 ----
  useEffect(() => {
    fetchWatchlists()
      .then(setLists)
      .catch((e) => {
        const msg = String((e as Error).message ?? e);
        setListsError(
          isMissingWatchlistTable(msg) ? "自选列表的表还没建:在 Supabase SQL Editor 跑一次 supabase/2026-10-12-watchlists.sql" : msg
        );
      });
  }, []);

  const setTab = (t: string) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* 存不了就算了 */
    }
  };
  const activeList = lists.find((l) => l.id === tab) ?? null;
  // 存的列表被删了(或换了设备)就回到持仓
  const effectiveTab = activeList ? tab : HOLDINGS_TAB;

  /** 乐观更新:先改界面,写库失败再回滚并提示 */
  const mutateLists = async (next: Watchlist[], write: () => Promise<void>) => {
    const prev = lists;
    setLists(next);
    try {
      await write();
    } catch (e) {
      setLists(prev);
      window.alert(String((e as Error).message ?? e));
    }
  };

  const toggleInList = (list: Watchlist, sym: string) => {
    const symbols = list.symbols.includes(sym) ? list.symbols.filter((x) => x !== sym) : [...list.symbols, sym];
    void mutateLists(
      lists.map((l) => (l.id === list.id ? { ...l, symbols } : l)),
      () => updateWatchlist(list.id, { symbols })
    );
  };

  const createList = async (name: string, symbols: string[] = []) => {
    try {
      const sort = lists.reduce((m, l) => Math.max(m, l.sort), 0) + 1;
      const created = await createWatchlist(name, sort, symbols);
      setLists((ls) => [...ls, created]);
      return created;
    } catch (e) {
      window.alert(String((e as Error).message ?? e));
      return null;
    }
  };

  const renameListTo = (list: Watchlist, name: string) => {
    if (name === list.name) return;
    void mutateLists(
      lists.map((l) => (l.id === list.id ? { ...l, name } : l)),
      () => updateWatchlist(list.id, { name })
    );
  };

  const removeList = (list: Watchlist) => {
    if (!window.confirm(`删除列表「${list.name}」?(里面 ${list.symbols.length} 只股票只是从这个列表移除)`)) return;
    if (tab === list.id) setTab(HOLDINGS_TAB);
    void mutateLists(
      lists.filter((l) => l.id !== list.id),
      () => deleteWatchlist(list.id)
    );
  };

  // 列表(tab)顺序:sort 按新位置重编号,只写变了的行
  const reorderLists = (ids: string[]) => {
    const byId = new Map(lists.map((l) => [l.id, l]));
    const next = ids.map((id, i) => ({ ...byId.get(id)!, sort: i + 1 }));
    const changed = next.filter((l) => byId.get(l.id)!.sort !== l.sort);
    void mutateLists(next, async () => {
      await Promise.all(changed.map((l) => updateWatchlist(l.id, { sort: l.sort })));
    });
  };

  const setListSort = (s: ListSort) => {
    setListSortState(s);
    writeJson(SORT_KEY, s);
  };

  // 拖拽排序:自选列表写回库里的 symbols 顺序,持仓存本机;拖完回到手动顺序
  const reorderRows = (tickers: string[]) => {
    setListSort(null);
    if (activeList) {
      void mutateLists(
        lists.map((l) => (l.id === activeList.id ? { ...l, symbols: tickers } : l)),
        () => updateWatchlist(activeList.id, { symbols: tickers })
      );
    } else {
      setHoldingsOrder(tickers);
      writeJson(HOLDINGS_ORDER_KEY, tickers);
    }
  };

  // 关掉盘前盘后时前端直接过滤(stock-candles 分钟线总是带盘前盘后返回),EMA 也只用常规时段的 bar 算
  const shown = useMemo<CandleData | null>(
    () => (data && !settings.extendedHours ? { ...data, candles: regularSessionOnly(data.candles, period) } : data),
    [data, settings.extendedHours, period]
  );

  // 当前打开的股票:现价统一用图上最后一根 K 线的收盘价(K 线 15 秒刷新,报价 30 秒),
  // 这样标签页标题、左侧列表、图上右边的价格标签永远是同一个数;昨收仍用报价的
  // 报价还没到/拉失败时,昨收和开盘也从 K 线推
  const liveQuotes = useMemo<QuotesResponse | null>(() => {
    const lastBar = shown && shown.symbol === symbol ? shown.candles[shown.candles.length - 1] : undefined;
    if (!lastBar) return quotes;
    const q = quotes?.usd[symbol];
    const live = q
      ? { ...q, c: lastBar.close }
      : { c: lastBar.close, o: lastBar.open, pc: data ? previousDayClose(data.candles, period) : null };
    const base: QuotesResponse = quotes ?? { fx: null, usd: {}, cad: {} };
    return { ...base, usd: { ...base.usd, [symbol]: live } };
  }, [quotes, shown, symbol, data, period]);

  const rows = useMemo<ListRow[]>(() => {
    if (activeList) return activeList.symbols.map((ticker) => ({ ticker }));
    // 手动排过的按存的顺序,新出现的持仓按代码排在后面(holdings 本身已按代码排好)
    const rank = new Map(holdingsOrder.map((t, i) => [t, i]));
    const key = (t: string, i: number) => rank.get(t) ?? holdingsOrder.length + i;
    const ordered = holdings.map((h, i) => ({ h, k: key(h.ticker, i) })).sort((a, b) => a.k - b.k).map((x) => x.h);
    return ordered.map((h) => {
      const q = liveQuotes?.usd[h.ticker] ?? null;
      const pnlPct = q && h.avgCost > 0 ? ((q.c - h.avgCost) / h.avgCost) * 100 : null;
      return {
        ticker: h.ticker,
        sub: (
          <>
            {h.qty}股 · 持仓 <span style={{ color: chgColor(pnlPct) }}>{fmtPct(pnlPct)}</span>
          </>
        ),
      };
    });
  }, [activeList, holdings, holdingsOrder, liveQuotes]);

  // 左侧报价:30 秒一次,页面在后台时不拉。当前打开的股票也一起拉(不在列表里时标题要用)
  const tickerKey = [...new Set([...rows.map((r) => r.ticker), symbol].filter(Boolean))].join(",");
  useEffect(() => {
    if (!tickerKey) return;
    const tickers = tickerKey.split(",");
    const load = () => {
      if (document.hidden) return;
      fetchQuotes(tickers, [])
        .then(setQuotes)
        .catch((e) => console.error("报价刷新失败", e));
    };
    load();
    const id = window.setInterval(load, 30000);
    return () => window.clearInterval(id);
  }, [tickerKey]);

  // 迷你走势图:1 分钟一次
  const sparkKey = rows.map((r) => r.ticker).join(",");
  useEffect(() => {
    if (!sparkKey) return;
    const tickers = sparkKey.split(",");
    const load = () => {
      if (document.hidden) return;
      fetchSparks(tickers)
        .then((r) => setSparks((prev) => ({ ...prev, ...r })))
        .catch((e) => console.error("迷你图刷新失败", e));
    };
    load();
    const id = window.setInterval(load, 60000);
    return () => window.clearInterval(id);
  }, [sparkKey]);

  // K 线:换股票/周期时清空重拉,之后每 15 秒轮询(后台不拉)
  const loadSeq = useRef(0);
  const loadCandles = useCallback(
    async (initial: boolean) => {
      if (!symbol) return;
      const seq = ++loadSeq.current;
      if (initial) {
        setLoading(true);
        setData(null);
        setError(null);
      }
      try {
        const d = await fetchCandles(symbol, period);
        if (seq !== loadSeq.current) return; // 期间又切了股票,丢弃旧结果
        setData(d);
        setUpdatedAt(new Date());
        setError(null);
      } catch (e) {
        if (seq === loadSeq.current && initial) setError(String((e as Error).message ?? e));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [symbol, period]
  );

  useEffect(() => {
    void loadCandles(true);
    const id = window.setInterval(() => {
      if (!document.hidden) void loadCandles(false);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [loadCandles]);

  const symbolTrades = useMemo(
    () => trades.filter((t) => t.ticker.toUpperCase() === symbol && isUsStock(t)),
    [trades, symbol]
  );
  const marks = useMemo(
    () => (shown ? groupTradesByBar(shown.candles, symbolTrades, period) : []),
    [shown, symbolTrades, period]
  );

  const quote = liveQuotes?.usd[symbol] ?? null;
  const price = quote?.c ?? shown?.candles[shown.candles.length - 1]?.close ?? null;
  const prevClose = quote?.pc ?? (data ? previousDayClose(data.candles, period) : null);
  const dayChg = price !== null && prevClose ? ((price - prevClose) / prevClose) * 100 : null;

  const holdPct = holding && price !== null && holding.avgCost > 0 ? ((price - holding.avgCost) / holding.avgCost) * 100 : null;

  // 浏览器标签页标题:代码 现价 涨跌幅(持有的话再加 持仓盈亏%),离开页面时还原
  useEffect(() => {
    const prev = document.title;
    return () => {
      document.title = prev;
    };
  }, []);
  useEffect(() => {
    if (!symbol) return;
    document.title =
      price === null ? symbol : `${symbol} ${fmtPrice(price)} ${fmtPct(dayChg)}${holdPct === null ? "" : ` 持${fmtPct(holdPct)}`}`;
  }, [symbol, price, dayChg, holdPct]);

  return (
    <div className="min-h-screen lg:h-screen flex flex-col" style={{ background: BG, fontFamily: "'Inter', sans-serif" }}>
      <DashboardNavbar sub="SYS/ASSETS · CHART" showCurrency={false} />
      <div className="pt-16 flex-1 min-h-0 flex flex-col lg:flex-row">
        <SidePanel
          tab={effectiveTab}
          onTab={setTab}
          lists={lists}
          listsError={listsError}
          rows={rows}
          quotes={liveQuotes}
          sparks={sparks}
          active={symbol}
          onPick={(t) => navigate(`/dashboard/chart/${t}`)}
          onManageLists={() => setManagingLists(true)}
          sort={listSort}
          onSort={setListSort}
          onReorder={reorderRows}
          onRefresh={refreshHoldings}
          refreshing={refreshing}
          refreshNote={refreshNote}
        />
        {managingLists && (
          <ListManager
            lists={lists}
            onClose={() => setManagingLists(false)}
            onCreate={(name) => void createList(name)}
            onRename={renameListTo}
            onDelete={removeList}
            onReorder={reorderLists}
          />
        )}

        <section className="flex-1 min-w-0 flex flex-col">
          <header
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
            style={{ borderBottom: `1px solid ${BORDER}` }}
          >
            <Link to="/dashboard/stock" className="hover:text-violet-300" style={{ color: SUB }} title="返回股票记录">
              <ArrowLeft size={15} aria-hidden />
            </Link>
            <span className="text-lg font-bold text-white" style={mono}>
              {symbol || "--"}
            </span>
            {data?.name && (
              <span className="text-xs truncate max-w-[220px]" style={{ color: SUB }}>
                {data.name}
              </span>
            )}
            <span className="text-lg" style={{ ...mono, color: TEXT }}>
              {fmtPrice(price)}
            </span>
            <span className="text-sm" style={{ ...mono, color: chgColor(dayChg) }}>
              {fmtPct(dayChg)}
            </span>
            <FavoriteButton
              symbol={symbol}
              lists={lists}
              disabled={!!listsError}
              onToggle={(l) => toggleInList(l, symbol)}
              onCreate={(name) => void createList(name, [symbol])}
            />
            {holding && (
              <span className="text-xs" style={{ ...mono, color: SUB }}>
                {holding.qty}股 @ {holding.avgCost.toFixed(2)}
              </span>
            )}

            <div className="flex items-center gap-1 ml-auto">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setPeriod(p.key)}
                  className="px-2.5 py-1 rounded text-xs transition-colors"
                  style={{
                    ...mono,
                    color: period === p.key ? "#fff" : SUB,
                    background: period === p.key ? "rgba(139,92,246,0.35)" : "rgba(139,92,246,0.06)",
                    border: `1px solid ${period === p.key ? "rgba(139,92,246,0.6)" : BORDER}`,
                  }}
                >
                  {p.label}
                </button>
              ))}
              <button
                onClick={() => {
                  setResetNonce((n) => n + 1);
                  void loadCandles(false);
                }}
                className="ml-1 p-1.5 rounded transition-colors hover:bg-violet-500/10"
                style={{ color: SUB }}
                title={updatedAt ? `刷新并还原视野 · 更新于 ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })},每 15 秒自动刷新` : "刷新并还原视野"}
              >
                <RefreshCw size={14} className={loading ? "animate-spin" : undefined} aria-hidden />
              </button>
              <SettingsDialog settings={settings} onChange={setSettings} />
            </div>
          </header>

          {error && (
            <div className="px-4 py-2 text-xs" style={{ ...mono, color: UP }}>
              {error}
            </div>
          )}
          {!symbol && !error && (
            <div className="px-4 py-10 text-sm text-center" style={{ color: MUTED }}>
              左边选一只股票,或输入代码
            </div>
          )}
          <CandleChart symbol={symbol} period={period} data={shown} marks={marks} avgCost={holding?.avgCost ?? null} viewKey={`${period}|${settings.extendedHours}|${settings.barSpacing}|${settings.lastBarAt}`} resetNonce={resetNonce} barSpacing={settings.barSpacing} lastBarAt={settings.lastBarAt} markColors={settings.markColors} />
          <div className="flex flex-wrap gap-x-4 px-4 py-2 text-[10px]" style={{ ...mono, color: MUTED, borderTop: `1px solid ${BORDER}` }}>
            <span><b style={{ color: settings.markColors.B }}>B</b> 买入</span>
            <span><b style={{ color: settings.markColors.S }}>S</b> 卖出</span>
            <span><b style={{ color: settings.markColors.T }}>T</b> 同一根K线多笔成交</span>
            <span>点的位置 = 成交价</span>
            <span>{isDaily(period) ? "按交易日(美东)" : settings.extendedHours ? "时间为美东,含盘前盘后" : "时间为美东,仅常规时段"}</span>
            <span className="ml-auto">{symbolTrades.length} 笔交易 · 图上 {marks.length} 个点</span>
          </div>
        </section>
      </div>
    </div>
  );
}
