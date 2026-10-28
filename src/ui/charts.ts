import type { Chart as ChartType, ChartConfiguration } from 'chart.js';
import type { PercentileBands } from '../model/types';
import { formatMoney, formatMoneyCompact } from './format';

type ChartCtor = typeof ChartType;
let chartPromise: Promise<ChartCtor> | undefined;
const live = new Set<ChartType>();

/** Load Chart.js on first use so the main bundle stays small. */
export function loadChart(): Promise<ChartCtor> {
  chartPromise ??= import('chart.js/auto').then((m) => m.default as ChartCtor);
  return chartPromise;
}

export function destroyCharts(): void {
  for (const c of live) c.destroy();
  live.clear();
}

function css(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function theme() {
  return {
    text: css('--text', '#1f2933'),
    muted: css('--muted', '#52606d'),
    grid: css('--grid', 'rgba(0,0,0,0.08)'),
    accent: css('--accent', '#1d4ed8'),
    band1: css('--band-outer', 'rgba(29,78,216,0.15)'),
    band2: css('--band-inner', 'rgba(29,78,216,0.30)'),
    danger: css('--danger', '#b42318'),
  };
}

/** Distinct series colours that also work in dark mode; series are labelled, never colour-only. */
const SERIES_COLOURS: Record<string, string> = {
  salary: '#2563eb', statePension: '#ea580c', otherIncome: '#16a34a', rental: '#9333ea',
  cash: '#64748b', gia: '#a16207', isa: '#db2777', lisa: '#0891b2', dcPension: '#4d7c0f',
};
export const SERIES_LABELS: Record<string, string> = {
  salary: 'Salary', statePension: 'State Pension', otherIncome: 'Other income', rental: 'Rent',
  cash: 'From cash', gia: 'From GIA', isa: 'From ISA', lisa: 'From LISA', dcPension: 'From pensions',
};

function baseOptions(yTitle: string, money = true): ChartConfiguration['options'] {
  const t = theme();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: t.text } },
      tooltip: { callbacks: money ? { label: (ctx) => `${ctx.dataset.label ?? ''}: ${formatMoney(Number(ctx.parsed.y))}` } : {} },
    },
    scales: {
      x: { title: { display: true, text: 'Age', color: t.muted }, ticks: { color: t.muted }, grid: { color: t.grid } },
      y: { title: { display: true, text: yTitle, color: t.muted }, ticks: { color: t.muted, callback: money ? (v) => formatMoneyCompact(Number(v)) : undefined }, grid: { color: t.grid } },
    },
  };
}

async function make(canvas: HTMLCanvasElement, config: ChartConfiguration): Promise<void> {
  const Chart = await loadChart();
  if (!canvas.isConnected) return;
  live.add(new Chart(canvas, config));
}

/** Fan chart: 5–95 and 25–75 bands with the median line. */
export function fanChart(canvas: HTMLCanvasElement, ages: number[], b: PercentileBands, yTitle: string, yMax?: number): Promise<void> {
  const t = theme();
  const line = (label: string, data: number[], extra: object) => ({ label, data, pointRadius: 0, borderWidth: 0, ...extra });
  return make(canvas, {
    type: 'line',
    data: {
      labels: ages,
      datasets: [
        line('95th percentile', b.p95, { borderColor: 'transparent', backgroundColor: t.band1, fill: false }),
        line('5th percentile', b.p5, { borderColor: 'transparent', backgroundColor: t.band1, fill: '-1' }),
        line('75th percentile', b.p75, { borderColor: 'transparent', backgroundColor: t.band2, fill: false }),
        line('25th percentile', b.p25, { borderColor: 'transparent', backgroundColor: t.band2, fill: '-1' }),
        line('Median', b.p50, { borderColor: t.accent, borderWidth: 2.5, backgroundColor: t.accent, fill: false }),
      ],
    },
    options: (() => {
      const o = baseOptions(yTitle);
      return { ...o, plugins: { ...o?.plugins, legend: { display: false } }, scales: { ...o?.scales, y: { ...o?.scales?.y, min: 0, max: yMax } } };
    })(),
  });
}

export function barChart(canvas: HTMLCanvasElement, labels: (string | number)[], data: number[], label: string, yTitle: string, money: boolean): Promise<void> {
  const t = theme();
  return make(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: money ? t.accent : t.danger }] },
    options: (() => {
      const o = baseOptions(yTitle, money);
      return { ...o, plugins: { ...o?.plugins, legend: { display: false } } };
    })(),
  });
}

/** A single percentage line (0–100%) by age, e.g. the chance of having run out of money. */
export function percentLine(canvas: HTMLCanvasElement, ages: number[], fractions: number[], label: string, yTitle: string): Promise<void> {
  const t = theme();
  const o = baseOptions(yTitle, false);
  return make(canvas, {
    type: 'line',
    data: { labels: ages, datasets: [{ label, data: fractions.map((v) => v * 100), borderColor: t.danger, backgroundColor: t.danger, borderWidth: 2.5, pointRadius: 0, stepped: 'after', fill: false }] },
    options: {
      ...o,
      plugins: { ...o?.plugins, legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${label}: ${Number(ctx.parsed.y).toFixed(1)}%` } } },
      scales: { ...o?.scales, y: { ...o?.scales?.y, min: 0, suggestedMax: 10, ticks: { color: t.muted, callback: (v: string | number) => `${v}%` } } },
    },
  });
}

/**
 * Stacked income bars. If `funded` (share of runs still funded each year) ever drops below
 * 100%, it is drawn as a dashed line against a right-hand percentage axis.
 */
export function stackedBars(canvas: HTMLCanvasElement, ages: number[], series: Record<string, number[]>, funded?: number[]): Promise<void> {
  const t = theme();
  const keys = Object.keys(series).filter((k) => series[k].some((v) => v > 0.5));
  const opts = baseOptions('£ per year (today’s money)');
  const FULL = 0.9995;
  const showFunded = funded !== undefined && funded.some((v) => v < FULL);
  const bars = keys.map((k) => ({ type: 'bar' as const, label: SERIES_LABELS[k] ?? k, data: series[k], backgroundColor: SERIES_COLOURS[k] ?? '#888', stack: 'income', yAxisID: 'y', order: 2 }));
  const line = showFunded ? [{ type: 'line' as const, label: 'Runs still funded', data: funded.map((v) => v * 100), borderColor: t.text, backgroundColor: 'transparent', borderDash: [6, 4], borderWidth: 2, pointRadius: 0, yAxisID: 'y1', order: 1 }] : [];
  return make(canvas, {
    type: 'bar',
    data: { labels: ages, datasets: [...bars, ...line] },
    options: {
      ...opts,
      plugins: {
        ...opts?.plugins,
        tooltip: { callbacks: { label: (ctx) => (ctx.dataset.yAxisID === 'y1' ? `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%` : `${ctx.dataset.label ?? ''}: ${formatMoney(Number(ctx.parsed.y))}`) } },
      },
      scales: {
        x: { ...opts?.scales?.x, stacked: true },
        y: { ...opts?.scales?.y, stacked: true },
        ...(showFunded ? { y1: { position: 'right' as const, min: 0, max: 100, grid: { drawOnChartArea: false }, title: { display: true, text: 'Runs still funded (%)', color: t.muted }, ticks: { color: t.muted, callback: (v: string | number) => `${v}%` } } } : {}),
      },
    },
  } as ChartConfiguration);
}
