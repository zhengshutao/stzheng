// K 线页的画线工具 —— 射线、水平线、矩形。
//
// 画在 K 线 series 上的一个 primitive(lightweight-charts 的自定义绘制插件)。
// 锚点存的是 {time, price}:time 用和 K 线同一套"美东墙上时间当 UTC"的秒数(见 candles.ts),
// 所以同一只股票在日线上画的线,切到分钟线也在对应的时间/价格位置。
// 超出最后一根 K 线右边空白处的点,按周期长度往外推时间。
//
// 存在浏览器 localStorage 里(按股票分开),只在这台电脑这个浏览器上有。

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export type DrawTool = "cursor" | "ray" | "hline" | "rect";

export interface Pt {
  time: number;
  price: number;
}

export type Drawing =
  | { id: string; type: "ray"; a: Pt; b: Pt }
  | { id: string; type: "hline"; price: number }
  | { id: string; type: "rect"; a: Pt; b: Pt };

const COLORS = {
  ray: "#38bdf8",
  hline: "#f5c542",
  rect: "#8b5cf6",
  rectFill: "rgba(139,92,246,0.12)",
};

const HIT_PX = 6;

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

// ---------- 存取 ----------

const storageKey = (symbol: string) => `chart.drawings.${symbol.toUpperCase()}`;

export function loadDrawings(symbol: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDrawings(symbol: string, drawings: Drawing[]): void {
  try {
    if (drawings.length) localStorage.setItem(storageKey(symbol), JSON.stringify(drawings));
    else localStorage.removeItem(storageKey(symbol));
  } catch {
    /* 隐私模式等存不了就只在本次页面里有效 */
  }
}

// ---------- 几何 ----------

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** 射线从 a 出发经过 b 一直延伸:返回一个远在画布外的终点 */
function rayEnd(x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const far = 20000 / len;
  return [x1 + dx * far, y1 + dy * far];
}

// ---------- primitive ----------

export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;

  private drawings: Drawing[] = [];
  private draft: Drawing | null = null;
  private selectedId: string | null = null;
  private times: number[] = [];
  private barSeconds = 86400;

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart as IChartApi;
    this.series = param.series as ISeriesApi<"Candlestick">;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  setDrawings(drawings: Drawing[], selectedId: string | null): void {
    this.drawings = drawings;
    this.selectedId = selectedId;
    this.requestUpdate?.();
  }

  setDraft(draft: Drawing | null): void {
    this.draft = draft;
    this.requestUpdate?.();
  }

  setTimeline(times: number[], barSeconds: number): void {
    this.times = times;
    this.barSeconds = barSeconds;
    this.requestUpdate?.();
  }

  // --- 时间 ↔ 逻辑序号(K 线下标,可以是小数/超出两端) ---

  private timeToLogical(time: number): number | null {
    const T = this.times;
    const n = T.length;
    if (!n) return null;
    if (time <= T[0]) return (time - T[0]) / this.barSeconds;
    if (time >= T[n - 1]) return n - 1 + (time - T[n - 1]) / this.barSeconds;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= time) lo = mid;
      else hi = mid;
    }
    return lo + (time - T[lo]) / (T[hi] - T[lo]);
  }

  private logicalToTime(l: number): number | null {
    const T = this.times;
    const n = T.length;
    if (!n) return null;
    if (l <= 0) return T[0] + l * this.barSeconds;
    if (l >= n - 1) return T[n - 1] + (l - (n - 1)) * this.barSeconds;
    const i = Math.floor(l);
    return T[i] + (l - i) * (T[i + 1] - T[i]);
  }

  /** 图上的像素坐标 → 锚点 */
  pointToPt(x: number, y: number): Pt | null {
    if (!this.chart || !this.series) return null;
    const l = this.chart.timeScale().coordinateToLogical(x);
    const price = this.series.coordinateToPrice(y);
    if (l === null || price === null) return null;
    const time = this.logicalToTime(l);
    return time === null ? null : { time, price };
  }

  private toX(time: number): number | null {
    const l = this.timeToLogical(time);
    if (l === null || !this.chart) return null;
    return this.chart.timeScale().logicalToCoordinate(l as Logical);
  }

  private toY(price: number): number | null {
    return this.series?.priceToCoordinate(price) ?? null;
  }

  private toXY(p: Pt): [number, number] | null {
    const x = this.toX(p.time);
    const y = this.toY(p.price);
    return x === null || y === null ? null : [x, y];
  }

  /** 点击位置命中哪条线(取最后画的那条);没命中返回 null */
  findAt(x: number, y: number): string | null {
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (d.type === "hline") {
        const yy = this.toY(d.price);
        if (yy !== null && Math.abs(y - yy) <= HIT_PX) return d.id;
        continue;
      }
      const a = this.toXY(d.a);
      const b = this.toXY(d.b);
      if (!a || !b) continue;
      if (d.type === "ray") {
        const [ex, ey] = rayEnd(a[0], a[1], b[0], b[1]);
        if (distToSegment(x, y, a[0], a[1], ex, ey) <= HIT_PX) return d.id;
      } else {
        const [l, r] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
        const [t, btm] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        if (x >= l - HIT_PX && x <= r + HIT_PX && y >= t - HIT_PX && y <= btm + HIT_PX) return d.id;
      }
    }
    return null;
  }

  // --- 绘制 ---

  private readonly view: IPrimitivePaneView = {
    zOrder: () => "top",
    renderer: () => ({ draw: (target: DrawTarget) => this.draw(target) }),
  };

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  private draw(target: DrawTarget): void {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
      for (const d of all) {
        const selected = d.id === this.selectedId || d === this.draft;
        ctx.save();
        ctx.lineWidth = selected ? 2 : 1.5;
        if (d.type === "hline") {
          const y = this.toY(d.price);
          if (y === null) {
            ctx.restore();
            continue;
          }
          ctx.strokeStyle = COLORS.hline;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(mediaSize.width, y);
          ctx.stroke();
          ctx.fillStyle = COLORS.hline;
          ctx.font = "11px 'JetBrains Mono', monospace";
          ctx.textAlign = "right";
          ctx.fillText(d.price.toFixed(2), mediaSize.width - 6, y - 4);
          if (selected) this.handle(ctx, mediaSize.width / 2, y, COLORS.hline);
          ctx.restore();
          continue;
        }
        const a = this.toXY(d.a);
        const b = this.toXY(d.b);
        if (!a || !b) {
          ctx.restore();
          continue;
        }
        if (d.type === "ray") {
          const [ex, ey] = rayEnd(a[0], a[1], b[0], b[1]);
          ctx.strokeStyle = COLORS.ray;
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(ex, ey);
          ctx.stroke();
          if (selected) {
            this.handle(ctx, a[0], a[1], COLORS.ray);
            this.handle(ctx, b[0], b[1], COLORS.ray);
          }
        } else {
          const x = Math.min(a[0], b[0]);
          const y = Math.min(a[1], b[1]);
          const w = Math.abs(a[0] - b[0]);
          const h = Math.abs(a[1] - b[1]);
          ctx.fillStyle = COLORS.rectFill;
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = COLORS.rect;
          ctx.strokeRect(x, y, w, h);
          if (selected) {
            this.handle(ctx, a[0], a[1], COLORS.rect);
            this.handle(ctx, b[0], b[1], COLORS.rect);
          }
        }
        ctx.restore();
      }
    });
  }

  private handle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#060a14";
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}
