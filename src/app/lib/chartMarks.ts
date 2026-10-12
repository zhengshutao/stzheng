// K 线页的买卖点 —— 自己画的圆点。
//
// lightweight-charts 自带的 markers 最小也有 ~11px,K 线窄的时候比 K 线还宽;
// 这里让圆点直径始终 = K 线实体宽度的 2/3,跟着缩放变,字母标在圆点下面。

import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  Time,
} from "lightweight-charts";

export interface TradeMark {
  time: number;
  price: number;
  color: string;
  text: string;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/** 和 lightweight-charts 内部 optimalCandlestickWidth 一样的算法(位图像素) */
function candleBodyWidth(barSpacing: number, pixelRatio: number): number {
  if (barSpacing >= 2.5 && barSpacing <= 4) return Math.floor(3 * pixelRatio);
  const coeff = 1 - (0.2 * Math.atan(Math.max(4, barSpacing) - 4)) / (Math.PI * 0.5);
  const res = Math.floor(barSpacing * coeff * pixelRatio);
  return Math.max(Math.floor(pixelRatio), Math.min(res, Math.floor(barSpacing * pixelRatio)));
}

export class TradeMarksPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<"Candlestick"> | null = null;
  private requestUpdate: (() => void) | null = null;
  private marks: TradeMark[] = [];

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

  setMarks(marks: TradeMark[]): void {
    this.marks = marks;
    this.requestUpdate?.();
  }

  private readonly view: IPrimitivePaneView = {
    zOrder: () => "top",
    renderer: () => ({ draw: (target: DrawTarget) => this.draw(target) }),
  };

  updateAllViews(): void {}

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view];
  }

  private draw(target: DrawTarget): void {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.marks.length) return;
    const ts = chart.timeScale();
    const barSpacing = ts.options().barSpacing;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
      const radius = (candleBodyWidth(barSpacing, hpr) * 2) / 3 / 2;
      const fontPx = Math.round(Math.min(11, Math.max(8, barSpacing)) * vpr);
      ctx.font = `600 ${fontPx}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const m of this.marks) {
        const x = ts.timeToCoordinate(m.time as Time);
        const y = series.priceToCoordinate(m.price);
        if (x === null || y === null) continue;
        // K 线实体按整像素对齐,圆心也对齐到同一列的中心
        const cx = Math.round(x * hpr) + (candleBodyWidth(barSpacing, hpr) % 2 ? 0.5 : 0);
        const cy = y * vpr;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(radius, 1.5 * hpr), 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(m.text, cx, cy + Math.max(radius, 1.5 * hpr) + 2 * vpr);
      }
    });
  }
}
