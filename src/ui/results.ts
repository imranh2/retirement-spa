import type { CentralCaseRow, PercentileBands, SimulationResult } from '../model/types';
import type { Store } from './store';
import { h, downloadText, uid } from './dom';
import { formatMoney, formatPct } from './format';
import { fanChart, barChart, stackedBars, percentLine, destroyCharts } from './charts';
import { costsOnTop, keyFacts, verdictBlock, whatMustBePaid } from './verdict';
import { cumulativeDepletion } from './longevity';
import { whatIfPanel } from './whatIf';
import { issueLocation, surplusDescription } from './scenarioTabs';

export interface ResultsCtx { store: Store; rerender: () => void }

const PREF_KEY = 'ukplanner.prefs.v1';

/**
 * Per-viewer choice of units for the Results page (storage failures fall back to the default):
 * actual pounds (what you would pay or hold in each year) or today's money.
 */
function readActual(): boolean {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    const p = raw === null ? {} : (JSON.parse(raw) as { actual?: boolean; tableActual?: boolean });
    return (p.actual ?? p.tableActual) !== false;
  } catch { return true; }
}
function writePrefs(): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify({ actual: tableActual })); } catch { /* not persisted */ }
}

let tableActual = readActual();

/** End-of-year balances; every other money column is a flow during the year. */
const END_OF_YEAR = new Set<keyof CentralCaseRow>(['portfolioEnd', 'propertyEquityEnd', 'mortgageBalanceEnd']);
/** A row in actual pounds: flows at that year's prices, balances at the year-end's. */
function inActualPounds(row: CentralCaseRow): CentralCaseRow {
  const out = { ...row } as Record<string, unknown>;
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'number' || k === 'age' || k === 'priceIndex' || k === 'priceIndexEnd' || k === 'months') continue;
    out[k] = v * ((END_OF_YEAR.has(k as keyof CentralCaseRow) ? row.priceIndexEnd : row.priceIndex) ?? 1);
  }
  return out as unknown as CentralCaseRow;
}

const CENTRAL_COLUMNS: { key: keyof CentralCaseRow; label: string }[] = [
  { key: 'age', label: 'Age' }, { key: 'taxYear', label: 'Tax year' },
  { key: 'salary', label: 'Salary' }, { key: 'statePension', label: 'State Pension' }, { key: 'otherIncome', label: 'Other income' }, { key: 'rentalIncome', label: 'Rent received' },
  { key: 'drawCash', label: 'From cash' }, { key: 'drawGia', label: 'From GIA' }, { key: 'drawIsa', label: 'From ISA' }, { key: 'drawLisa', label: 'From LISA' }, { key: 'drawPremiumBonds', label: 'From Premium Bonds' }, { key: 'drawPension', label: 'From pensions' },
  { key: 'spending', label: 'Spending' }, { key: 'oneOffCosts', label: 'One-off costs' }, { key: 'homePurchase', label: 'Buying a home' }, { key: 'rentPaid', label: 'Rent paid' }, { key: 'mortgagePayments', label: 'Mortgage' }, { key: 'mortgageInterest', label: 'of which interest' }, { key: 'propertyCosts', label: 'Property costs' },
  { key: 'taxPaid', label: 'Income tax + CGT' }, { key: 'niPaid', label: 'NI' },
  { key: 'savedFromPay', label: 'Saved from pay' }, { key: 'spareIncome', label: 'Spare income' },
  { key: 'portfolioEnd', label: 'Portfolio (end)' }, { key: 'propertyEquityEnd', label: 'Property equity (end)' }, { key: 'mortgageBalanceEnd', label: 'Mortgage left (end)' },
];

function centralCsv(rows: CentralCaseRow[]): string {
  const esc = (v: string | number | undefined) => (typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : (v ?? 0).toFixed(2));
  return [CENTRAL_COLUMNS.map((c) => esc(c.label)).join(','), ...rows.map((r) => CENTRAL_COLUMNS.map((c) => esc(r[c.key])).join(','))].join('\n');
}

/** Columns that are zero in every row are hidden on screen (the CSV keeps them all). */
const ALWAYS_SHOWN = new Set<keyof CentralCaseRow>(['age', 'taxYear', 'spending', 'portfolioEnd']);
function visibleColumns(rows: CentralCaseRow[]) {
  return CENTRAL_COLUMNS.filter((c) => ALWAYS_SHOWN.has(c.key) || rows.some((r) => typeof r[c.key] === 'number' && Math.abs(r[c.key] as number) >= 0.5));
}

/**
 * A y-axis cap for fan charts: the top 5% of runs can be many times the median and
 * squash everything else, so cap at 1.5x the highest 75th percentile when that is lower.
 */
function fanYMax(b: PercentileBands): number | undefined {
  const TAIL_CAP = 1.5;
  const cap = niceCeil(Math.max(...b.p75) * TAIL_CAP);
  return cap > 0 && Math.max(...b.p95) > cap ? cap : undefined;
}

/** The spread at the horizon in words: how many futures have run out, and the 1-in-20 range. */
function portfolioSpread(r: SimulationResult, b: PercentileBands): string {
  const last = (xs: number[]) => xs[xs.length - 1] ?? 0;
  const ranOut = 1 - r.successRate;
  if (last(b.p95) < 1) return 'Every simulated future has run out of money by then.';
  const low = last(b.p5) < 1 ? `${formatPct(ranOut)} of futures have run out of money by then` : `1 run in 20 ends below ${formatMoney(last(b.p5))}`;
  return `${low}; 1 in 20 ends above ${formatMoney(last(b.p95))}.`;
}

/** Round up to 1, 2, 2.5 or 5 times a power of ten, so a capped axis ends on a round tick. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** Math.floor(Math.log10(v));
  const STEPS = [1, 2, 2.5, 5, 10];
  return (STEPS.find((m) => m * p >= v) ?? 10) * p;
}

/**
 * Bands hold year-END values, recorded against the age at the START of each year. For the
 * charts, start at the known value today (every percentile equal) and plot each year-end
 * value at the next age, so age 50 shows what you have now and the last point is the horizon.
 */
export function bandsFromStart(ages: number[], b: PercentileBands, startValue: number): { ages: number[]; bands: PercentileBands } {
  const keys = ['p5', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95'] as const;
  const bands = Object.fromEntries(keys.map((k) => [k, [startValue, ...b[k]]])) as unknown as PercentileBands;
  return { ages: ages.length ? [ages[0], ...ages.map((a) => a + 1)] : [], bands };
}

/** Key for the fan charts' shaded bands (Chart.js's own legend cannot describe a filled range). */
function fanLegend(): HTMLElement {
  return h('span', { class: 'fan-legend', 'aria-hidden': 'true' },
    h('span', {}, h('i', { class: 'sw median' }), 'Median'),
    h('span', {}, h('i', { class: 'sw inner' }), 'Middle 50%'),
    h('span', {}, h('i', { class: 'sw outer' }), 'Middle 90%'));
}

function chartBox(title: string, canvasId: string, caption: string, extra: Node | null = null): { el: HTMLElement; canvas: HTMLCanvasElement } {
  const canvas = h('canvas', { id: canvasId, role: 'img', 'aria-label': `${title}. ${caption}` });
  const el = h('figure', { class: 'chart' }, h('figcaption', {}, h('strong', {}, title), extra), h('div', { class: 'chart-box' }, canvas), h('p', { class: 'muted small' }, caption));
  return { el, canvas };
}

/**
 * What the simulation is doing right now, with a progress bar: waiting for edits to settle,
 * running the simulations (with Cancel), then working out the max sustainable spend.
 * Hidden when idle. Rendered into every `.progress-slot`, which the app refreshes on each change.
 */
export function progressBar(store: Store): HTMLElement {
  const st = store.getState();
  const ms = st.maxSpendProgress;
  const id = uid('sim-progress');
  if (st.status === 'queued') {
    return h('div', { class: 'progress-wrap' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, 'Change noticed, re-running shortly…'));
  }
  if (st.status === 'running') {
    const pct = st.progress.total > 0 ? st.progress.completed / st.progress.total : 0;
    return h('div', { class: 'progress-wrap' },
      h('label', { for: id }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` Running ${st.progress.total.toLocaleString('en-GB')} simulations… ${Math.round(pct * 100)}%`),
      h('progress', { id, max: 1, value: pct }),
      h('button', { type: 'button', class: 'btn small', onclick: () => store.cancelRun() }, 'Cancel'));
  }
  if (st.status === 'done' && !st.maxSpend && ms) {
    return h('div', { class: 'progress-wrap' },
      h('label', { for: id }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` Working out max sustainable spend… step ${Math.min(ms.completed + 1, ms.total)} of up to ${ms.total}`),
      h('progress', { id, max: ms.total, value: ms.completed }));
  }
  return h('div', { class: 'progress-wrap', hidden: true });
}

/** A live slot for progressBar (the app re-renders its contents on every state change). */
export function progressSlot(store: Store): HTMLElement {
  return h('div', { class: 'progress-slot', 'aria-live': 'polite' }, progressBar(store));
}

export function renderResults(c: ResultsCtx): HTMLElement {
  destroyCharts();
  const st = c.store.getState();
  const r = c.store.planResults();
  const s = st.scenario;
  const statusMsg = st.status === 'invalid' ? h('div', { class: 'error', role: 'alert' },
    h('p', {}, 'The plan or rules have problems, so the simulation has not run:'),
    h('ul', { class: 'error-list' }, ...st.scenarioErrors.slice(0, 8).map((e) => {
      const loc = issueLocation(e.path, s);
      return h('li', {}, h('strong', {}, `${loc.item}: `), e.message, ' ', h('a', { href: `#/${loc.tab}` }, `Fix in ${loc.tabLabel} →`));
    }), ...(st.scenarioErrors.length === 0 ? [h('li', {}, 'See Rules & Assumptions for the highlighted fields.')] : [])))
    : st.status === 'error' ? h('p', { class: 'error', role: 'alert' }, `Simulation failed: ${st.runError ?? 'unknown error'}`)
      : st.status === 'cancelled' ? h('p', { class: 'muted' }, 'Run cancelled. Results below (if any) are from the previous run.', h('button', { type: 'button', class: 'btn small', onclick: () => c.store.runNow() }, 'Run again'))
        : null;
  if (!r) {
    return h('div', {}, h('h2', {}, 'Results'), progressSlot(c.store), statusMsg ?? h('p', { class: 'muted' }, st.status === 'running' || st.status === 'queued' ? 'Working out your results…' : 'Results appear here after the first run.'),
      ...['Portfolio', 'Net worth', 'Depletion', 'Income', 'Tax'].map(() => h('div', { class: 'chart placeholder' }, h('div', { class: 'chart-box' }))));
  }

  const at = (xs: number[]) => xs[xs.length - 1] ?? 0;
  const target = s.sim.targetSuccessRate;
  const stale = st.status === 'running' || st.status === 'queued';
  const extra = costsOnTop(s);

  const realMode = !tableActual;
  /** One switch for the page's units, shown at the top and again above the table. */
  const unitsSwitch = () => h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Show amounts in' },
    ...([[true, 'Actual pounds'], [false, 'Today’s money']] as const).map(([actual, label]) => h('button', {
      type: 'button', role: 'radio', class: 'btn small', 'aria-checked': String(tableActual === actual),
      onclick: () => { tableActual = actual; writePrefs(); c.rerender(); },
    }, label)));
  const toggle = h('div', { class: 'units' }, h('span', { class: 'muted small' }, 'Charts and table in'), unitsSwitch());
  const moneyLabel = realMode ? '£ (today’s money)' : '£ (actual pounds in each year)';

  const portfolioBands = realMode ? r.portfolioReal : r.portfolioNominal;
  const netWorthBands = realMode ? r.netWorthReal : (r.netWorthNominal ?? r.netWorthReal);
  // Today's values (the same in real and nominal terms at the start).
  const startPortfolio = s.accounts.reduce((sum, a) => sum + a.balance, 0);
  // Only homes owned now: one still to buy is not part of today's net worth.
  const startEquity = s.properties.filter((p) => p.buyAtAge === undefined).reduce((sum, p) => sum + p.value - (p.mortgage?.balance ?? 0), 0);
  const portfolioChart = bandsFromStart(r.ages, portfolioBands, startPortfolio);
  const netWorthChart = bandsFromStart(r.ages, netWorthBands, startPortfolio + startEquity);
  const portfolioCap = fanYMax(portfolioChart.bands);
  const netWorthCap = fanYMax(netWorthChart.bands);
  const clipNote = ' The best 5% of outcomes run off the top of the chart so the typical range is readable.';
  const fan = chartBox('Portfolio value by age', 'chart-portfolio', `Half of the simulated outcomes fall in the darker band and 90% in the lighter one. Savings and investments only; excludes property.${portfolioCap ? clipNote : ''}`, fanLegend());
  const hasProperty = s.properties.length > 0;
  const nw = chartBox('Net worth by age', 'chart-networth', `Portfolio plus property equity (value minus mortgages). Same bands as above.${netWorthCap ? clipNote : ''}`, fanLegend());
  const runOut = cumulativeDepletion(r);
  const dep = chartBox('Chance the money has run out, by age', 'chart-depletion', r.depletionAgeHistogram.length === 0
    ? 'No simulated run ran out of money.'
    : `Share of the ${r.runs.toLocaleString('en-GB')} simulated futures that could no longer pay for ${whatMustBePaid(s)} by each age. The value at ${s.sim.horizonAge - 1} is the overall failure rate (${formatPct(1 - r.successRate)}).`);
  const inc = chartBox('Where the money comes from (today’s money)', 'chart-income', 'Average income and withdrawals per year, in today’s money, with withdrawals net of tax. Each year averages only the runs that still met spending in full, so the bars show what a funded year looks like; the dashed line shows how many runs that is.');
  const tax = chartBox('Tax paid by age (today’s money)', 'chart-tax', 'Average income tax, NI and CGT per year in today’s money, over runs that still met spending in full that year.');

  const maxSpend = st.maxSpend;

  const rows = tableActual ? r.centralCase.map(inActualPounds) : r.centralCase;
  const money = tableActual ? 'actual pounds' : 'today’s money';
  const tableView = unitsSwitch();
  // The central run stops in the year the money runs out; say so rather than let the table just end.
  const lastRow = rows[rows.length - 1];
  const runsOut = lastRow !== undefined && lastRow.age < s.sim.horizonAge - 1 ? lastRow : undefined;
  const hasMortgage = rows.some((row) => row.mortgagePayments > 0);
  const cols = visibleColumns(rows);
  const table = h('div', { class: 'table-wrap tall', tabindex: 0, role: 'region', 'aria-label': 'Central case table' }, h('table', { class: 'data-table sticky-first' },
    h('thead', {}, h('tr', {}, ...cols.map((col) => h('th', { scope: 'col' }, col.label)))),
    h('tbody', {}, ...rows.map((row) => h('tr', {}, ...cols.map((col) => {
      const v = row[col.key];
      if (col.key === 'age') return h('th', { scope: 'row' }, String(v));
      if (col.key === 'taxYear' && row.months !== undefined && row.months < 12) return h('td', { title: `This plan starts part-way through the tax year, so this row covers ${row.months} months` }, `${String(v)} (${row.months} mo)`);
      return h('td', {}, typeof v === 'number' ? formatMoney(v) : v);
    }))))));

  const el = h('div', { class: stale ? 'results stale' : 'results' },
    h('div', { class: 'results-head' }, h('h2', {}, 'Results'), toggle),
    h('nav', { class: 'jump-links', 'aria-label': 'Sections of the results' },
      ...[['Summary', 'summary'], ['What if?', 'whatif'], ['Charts', 'charts'], ['Year by year', 'year-by-year']].map(([label, id]) => h('a', { href: `#/results/${id}` }, label))),
    progressSlot(c.store),
    statusMsg,
    stale ? h('p', { class: 'muted' }, 'Updating… the figures below are from the previous run.') : null,
    h('section', { class: 'panel-section', id: 'summary' }, verdictBlock(r, s, maxSpend, stale ? null : 'Working out how much you could spend…'), keyFacts(r, s, st.retireAge, !stale && st.status === 'done')),
    whatIfPanel(c.store, r),
    h('div', { class: 'stats' },
      h('div', { class: 'card stat' }, h('h3', {}, `Portfolio at age ${s.sim.horizonAge}`), h('p', { class: 'big' }, formatMoney(at(portfolioBands.p50))),
        h('p', { class: 'muted' }, `Savings and investments (not property), typical (median) outcome, ${realMode ? 'today’s money' : 'actual pounds at that age'}. ${portfolioSpread(r, portfolioBands)}`)),
      h('div', { class: 'card stat' }, h('h3', {}, 'Lifetime tax paid (today’s money)'), h('p', { class: 'big' }, formatMoney(r.taxPaidTotal.median)),
        h('p', { class: 'muted' }, `Income tax, NI and CGT for the whole plan. Median, today’s money. 10th–90th percentile: ${formatMoney(r.taxPaidTotal.p10)} – ${formatMoney(r.taxPaidTotal.p90)}.`))),
    r.warnings.length > 0 ? h('section', { class: 'panel-section' }, h('h3', {}, 'Warnings'), h('ul', { class: 'warning-list' }, ...r.warnings.map((w) => h('li', {}, w)))) : null,
    h('div', { id: 'charts' }, fan.el), hasProperty ? nw.el : null, r.depletionAgeHistogram.length === 0 ? h('p', { class: 'muted chart-note' }, 'No simulated future ran out of money, so there is no run-out chart.') : dep.el, inc.el, tax.el,
    h('section', { class: 'panel-section', id: 'year-by-year' },
      h('div', { class: 'section-head' }, h('h3', {}, 'Year by year (central case: average returns, no ups and downs)'),
        h('span', { class: 'row-btns' }, tableView,
          h('button', { type: 'button', class: 'btn small', onclick: () => downloadText(`year-by-year-${tableActual ? 'actual' : 'todays-money'}.csv`, 'text/csv', centralCsv(rows)) }, 'Download CSV'))),
      h('p', { class: 'muted' }, `One run using the average return and inflation (${formatPct(st.config.market.inflation.mean)} a year) every year, in ${money}. ${tableActual ? 'Amounts are what you would actually pay or hold in each year, so spending and salary grow with prices. ' : 'Amounts are in today’s prices, so they compare directly with what things cost now. '}Real markets go up and down, and a bad run early on costs more than a good run later gives back, so a typical future does a little worse than this table (see Money lasts above). Useful for checking the model by hand: income plus withdrawals covers spending, one-off costs, buying a home, rent, mortgage, property costs, tax, NI and “Saved from pay”; anything left is “Spare income”, which is ${surplusDescription(s)}.${hasMortgage ? (tableActual
        ? ' A fixed-rate mortgage payment stays the same each year until the fix ends, when it is recalculated at the new rate. “of which interest” shows how much of each year’s payments is interest, which falls as the balance is paid down.'
        : ' Mortgage payments are fixed in pounds, so in today’s money they look smaller each year as prices rise; switch to actual pounds to see what you would pay. “of which interest” shows how much of each year’s payments is interest.') : ''}${cols.length < CENTRAL_COLUMNS.length ? ' Columns that are always zero are hidden here but included in the CSV.' : ''}`),
      runsOut ? h('p', { class: 'warning' }, `With average returns the money runs out at age ${runsOut.age}, so the table stops there.${runsOut.mortgageBalanceEnd >= 1 ? ` The mortgage still had ${formatMoney(runsOut.mortgageBalanceEnd)} left to pay (${money}).` : ''} Later years are not shown because the plan can no longer pay its way.`) : null,
      table),
    h('p', { class: 'muted small' }, `Seed ${r.meta.seed} · ${r.runs.toLocaleString('en-GB')} runs · ${Math.round(r.meta.durationMs)} ms · defaults ${r.meta.defaultsVersion}`));

  // Draw charts after the element is attached (canvas sizes are reserved in CSS, so no layout shift).
  requestAnimationFrame(() => {
    const ages = r.ages;
    void fanChart(fan.canvas, portfolioChart.ages, portfolioChart.bands, moneyLabel, portfolioCap);
    if (hasProperty) void fanChart(nw.canvas, netWorthChart.ages, netWorthChart.bands, moneyLabel, netWorthCap);
    if (r.depletionAgeHistogram.length > 0) void percentLine(dep.canvas, ages, runOut, 'Run out of money', 'Runs out of money (%)');
    void stackedBars(inc.canvas, ages, r.incomeBySourceMeanReal, r.fundedShareByAge);
    void barChart(tax.canvas, ages, r.taxPaidByAgeMeanReal, 'Tax paid', '£ per year (today’s money)', true);
  });
  return el;
}
