import type { Scenario, SimulationResult } from '../model/types';
import type { MaxSpendValue, QuickResult } from '../model/workerMessages';
import type { Store } from './store';
import { withRetirementAge } from '../model/retirement';
import { h, uid } from './dom';
import { formatMoney, formatPct } from './format';
import { lastsLabel, moneyLastsUntil } from './longevity';
import { successBand } from './successBand';
import { costsOnTop } from './verdict';

/** Debounce for slider moves before a quick check is sent to the worker. */
const WHATIF_DEBOUNCE_MS = 200;
const SPEND_MIN_PCT = 50;
const SPEND_MAX_PCT = 200;
const SPEND_STEP_PCT = 1;
const FULL_PCT = 100;

/**
 * Slider positions survive re-renders of the Results tab (which happen on every run).
 * They reset to the plan when the scenario is replaced or a what-if is applied.
 */
const ui: {
  retireAt?: number; spendPct: number; replaceCount: number; key?: string; result?: QuickResult; timer?: ReturnType<typeof setTimeout>;
  /** Max spend at the slider's stop-work age (`spendKey` says which scenario and age it is for). */
  spendKey?: string; spendAt?: MaxSpendValue; spendTimer?: ReturnType<typeof setTimeout>;
} = { spendPct: FULL_PCT, replaceCount: -1 };

/** Whether person 1 still has a stop-work age ahead of them. */
function isWorking(s: Scenario, ageNow: number): boolean {
  return (s.people[0]?.retirementAge ?? 0) > ageNow;
}

/** The scenario with the slider changes applied (retirement age, spending scaled). */
export function whatIfScenario(s: Scenario, retireAt: number | undefined, spendPct: number): Scenario {
  const retired = retireAt === undefined ? s : withRetirementAge(s, retireAt);
  const k = spendPct / FULL_PCT;
  return { ...retired, spending: retired.spending.map((p) => ({ ...p, annualSpend: Math.round(p.annualSpend * k) })) };
}

/**
 * "What if?" card: move the stop-work age and spending level and see the chance of
 * success and how long the money lasts, from a quick 1,000-run check on a separate
 * worker. "Use these in my plan" writes the values back into the scenario.
 */
export function whatIfPanel(store: Store, base: SimulationResult): HTMLElement {
  const st = store.getState();
  const s = st.scenario;
  if (ui.replaceCount !== store.replaceCount) { ui.retireAt = undefined; ui.spendPct = FULL_PCT; ui.result = undefined; ui.key = undefined; ui.spendAt = undefined; ui.spendKey = undefined; ui.replaceCount = store.replaceCount; }
  const ageNow = base.ages[0] ?? 0;
  const working = isWorking(s, ageNow);
  const planned = s.people[0]?.retirementAge ?? ageNow;
  const latest = s.sim.horizonAge - 1;
  const retireAt = working ? Math.min(Math.max(ui.retireAt ?? planned, ageNow), latest) : undefined;
  const target = s.sim.targetSuccessRate;
  const who = s.people[0]?.name || 'person 1';
  // The phase in force now (the last one that has started), as max spend uses.
  const spendNow = s.spending.reduce((amount, p) => (p.fromAge <= ageNow ? p.annualSpend : amount), s.spending[0]?.annualSpend ?? 0);
  const extra = costsOnTop(s);

  const out = h('div', { class: 'whatif-out', 'aria-live': 'polite' });
  const changed = () => (retireAt !== undefined && (ui.retireAt ?? planned) !== planned) || ui.spendPct !== FULL_PCT;

  const renderOut = () => {
    const r = changed() ? ui.result : base;
    if (!r) { out.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Checking…')); return; }
    const band = successBand(r.successRate);
    const delta = changed() ? r.successRate - base.successRate : 0;
    const sure = moneyLastsUntil(r, target);
    const typical = moneyLastsUntil(r, 0.5);
    out.replaceChildren(
      h('div', { class: `whatif-figure success ${band.cls}` },
        h('span', { class: 'big' }, formatPct(r.successRate)),
        h('span', {}, 'chance the money lasts'),
        Math.abs(delta) >= 0.0005 ? h('span', { class: `delta ${delta > 0 ? 'up' : 'down'}` }, `${delta > 0 ? '▲' : '▼'} ${(Math.abs(delta) * 100).toFixed(1)} pts vs your plan`) : null),
      h('p', {}, `Money lasts to age ${lastsLabel(sure)} in ${Math.round(target * 100)}% of futures, and to ${lastsLabel(typical)} in a typical one.`),
      changed() ? h('p', { class: 'muted small' }, `Quick check: ${r.runs.toLocaleString('en-GB')} simulated futures, so it can differ slightly from the full results.`) : h('p', { class: 'muted small' }, 'This is your current plan. Move a slider to try something else.'));
  };

  // "If I stop work at X, what can I spend?": the max sustainable spend at the slider's age.
  // At the planned age it is the full run's figure; otherwise a quicker search on its own worker.
  const spendLine = h('div', { class: 'whatif-spend', 'aria-live': 'polite' });
  const retireNow = () => (retireAt === undefined ? undefined : (ui.retireAt ?? planned));
  const spendKeyFor = (age: number | undefined) => JSON.stringify([age, s.spending, s.people.map((p) => p.retirementAge), st.results?.meta.seed, s.sim, s.accounts, s.contributions, s.properties]);
  const renderSpendLine = () => {
    const age = retireNow();
    const v = age === undefined || age === planned ? st.maxSpend : (ui.spendKey === spendKeyFor(age) ? ui.spendAt : undefined);
    const pct = `${Math.round(target * 100)}%`;
    const when = age === undefined ? 'With your plan' : age === planned ? `Stopping work at ${age} (your plan)` : `Stopping work at ${age}`;
    if (!v) {
      spendLine.replaceChildren(h('p', { class: 'muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ` ${when}: working out how much you could spend…`));
      return;
    }
    const tryPct = Math.min(SPEND_MAX_PCT, Math.max(SPEND_MIN_PCT, Math.round(v.multiplier * FULL_PCT)));
    const tryIt = h('button', { type: 'button', class: 'btn small', onclick: () => {
      ui.spendPct = tryPct;
      spendInput.value = String(tryPct);
      setSpendLabel(tryPct);
      schedule();
      renderSpendLine();
    } }, 'Try this spending');
    spendLine.replaceChildren(
      h('p', {}, `${when}, you could spend up to `, h('strong', {}, `${formatMoney(v.annualSpendReal)} a year`),
        ` for a ${pct} chance${extra ? ` (plus your ${extra})` : ''}. `, ui.spendPct === tryPct ? null : tryIt),
      ...v.warnings.map((w) => h('p', { class: 'muted small' }, w)),
      ...(age !== undefined && age !== planned ? [h('p', { class: 'muted small' }, 'Quick estimate, to within about 1% of your planned spending.')] : []));
  };
  const scheduleSpend = () => {
    const age = retireNow();
    if (age === undefined || age === planned) { renderSpendLine(); return; }
    const key = spendKeyFor(age);
    if (ui.spendKey === key && ui.spendAt) { renderSpendLine(); return; }
    ui.spendAt = undefined; ui.spendKey = undefined;
    renderSpendLine();
    if (ui.spendTimer !== undefined) clearTimeout(ui.spendTimer);
    ui.spendTimer = setTimeout(() => {
      void store.maxSpendAt(withRetirementAge(s, age)).then((v) => {
        if (!v) return;
        ui.spendKey = key; ui.spendAt = v;
        if (spendLine.isConnected) renderSpendLine();
      });
    }, WHATIF_DEBOUNCE_MS);
  };

  const schedule = () => {
    renderOut();
    if (!changed()) return;
    const variant = whatIfScenario(s, retireAt === undefined ? undefined : (ui.retireAt ?? planned), ui.spendPct);
    const key = JSON.stringify([variant.people.map((p) => p.retirementAge), variant.spending, st.results?.meta.seed, s.sim]);
    if (key === ui.key && ui.result) return;
    ui.result = undefined;
    renderOut();
    if (ui.timer !== undefined) clearTimeout(ui.timer);
    ui.timer = setTimeout(() => {
      void store.whatIf(variant).then((res) => {
        if (!res) return;
        ui.key = key; ui.result = res;
        if (out.isConnected) renderOut();
      });
    }, WHATIF_DEBOUNCE_MS);
  };

  const retireId = uid('whatif-retire');
  const retireValue = h('output', { for: retireId, class: 'whatif-value' });
  const setRetireLabel = (age: number) => { retireValue.textContent = age === planned ? `${age} (your plan)` : `${age} (${Math.abs(age - planned)} year${Math.abs(age - planned) === 1 ? '' : 's'} ${age < planned ? 'earlier' : 'later'})`; };
  const retireRow = retireAt === undefined ? null : h('div', { class: 'whatif-row' },
    h('label', { for: retireId }, s.people.length > 1 ? `Stop work at (${who})` : 'Stop work at'), retireValue,
    h('input', { type: 'range', id: retireId, min: ageNow, max: latest, step: 1, value: retireAt,
      oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); ui.retireAt = v; setRetireLabel(v); schedule(); scheduleSpend(); } }));
  if (retireAt !== undefined) setRetireLabel(retireAt);

  const spendId = uid('whatif-spend');
  const spendValue = h('output', { for: spendId, class: 'whatif-value' });
  const setSpendLabel = (pct: number) => { spendValue.textContent = `${formatMoney(spendNow * pct / FULL_PCT)} a year${pct === FULL_PCT ? ' (your plan)' : ` (${pct}% of plan${s.spending.length > 1 ? ', every phase' : ''})`}`; };
  setSpendLabel(ui.spendPct);
  const spendInput = h('input', { type: 'range', id: spendId, min: SPEND_MIN_PCT, max: SPEND_MAX_PCT, step: SPEND_STEP_PCT, value: ui.spendPct,
    oninput: (e: Event) => { ui.spendPct = Number((e.target as HTMLInputElement).value); setSpendLabel(ui.spendPct); schedule(); renderSpendLine(); } });
  const spendRow = h('div', { class: 'whatif-row' }, h('label', { for: spendId }, 'Spending'), spendValue, spendInput);

  const apply = h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const v = whatIfScenario(s, retireAt === undefined ? undefined : (ui.retireAt ?? planned), ui.spendPct);
    ui.retireAt = undefined; ui.spendPct = FULL_PCT; ui.result = undefined; ui.key = undefined; ui.spendAt = undefined; ui.spendKey = undefined;
    store.setScenarioValue('people', v.people);
    store.setScenarioValue('spending', v.spending);
  } }, 'Use these in my plan');
  const reset = h('button', { type: 'button', class: 'btn', onclick: () => {
    ui.retireAt = undefined; ui.spendPct = FULL_PCT; ui.result = undefined; ui.key = undefined;
    const fresh = whatIfPanel(store, base);
    panel.replaceWith(fresh);
  } }, 'Back to my plan');

  const panel = h('section', { class: 'panel-section whatif', id: 'whatif' },
    h('h3', {}, 'What if?'),
    h('p', { class: 'muted' }, working
      ? `Try stopping work earlier or later, or spending more or less, and see how long the money lasts. Move the stop-work age to see the most you could spend if you stopped then. ${s.people.length > 1 ? 'A partner who is still working moves their stop-work age by the same number of years. ' : ''}${extra ? `The spending slider scales your spending plan only; your ${extra} stay as they are. ` : ''}Nothing changes until you choose “Use these in my plan”.`
      : `Try spending more or less and see how long the money lasts. ${extra ? `The slider scales your spending plan only; your ${extra} stay as they are. ` : ''}Nothing changes until you choose “Use these in my plan”.`),
    h('div', { class: 'whatif-grid' }, h('div', { class: 'whatif-controls' }, retireRow, spendRow, h('p', { class: 'row-btns' }, apply, reset)), h('div', {}, out, spendLine)));
  schedule();
  scheduleSpend();
  return panel;
}
