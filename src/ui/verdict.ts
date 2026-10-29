import type { Scenario, SimulationResult } from '../model/types';
import type { MaxSpendValue, RetireAgeValue } from '../model/workerMessages';
import { lastsLabel, moneyLastsUntil } from './longevity';
import { canChooseStopWork, currentAges } from '../model/retirement';
import { h } from './dom';
import { formatMoney, formatPct } from './format';
import { successBand } from './successBand';
import { surplusDescription } from './scenarioTabs';

/**
 * What the plan pays on top of the spending plan, e.g. "mortgage payments and home running
 * costs", or null when there is nothing. Max spend and the spending sliders exclude these.
 */
export function costsOnTop(s: Scenario): string | null {
  const parts = costsOnTopList(s);
  return parts.length ? (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]) : null;
}

function costsOnTopList(s: Scenario): string[] {
  const mortgage = s.properties.some((p) => (p.mortgage?.balance ?? 0) > 0);
  const running = s.properties.some((p) => p.runningCostsAnnual > 0 || (p.runningCostsPctOfValue ?? 0) > 0);
  const rent = (s.rentPaid ?? []).some((r) => r.monthly > 0);
  const oneOff = (s.oneOffCosts ?? []).some((o) => o.amount > 0);
  const buying = s.properties.some((p) => p.buyAtAge !== undefined);
  return [rent ? 'rent' : null, buying ? 'the cost of buying a home' : null, mortgage ? 'mortgage payments' : null, running ? 'property running costs' : null, oneOff ? 'one-off costs' : null].filter((x): x is string => x !== null);
}

/** Everything a year must pay for a future to count as a success, e.g. "spending, mortgage payments and tax". */
export function whatMustBePaid(s: Scenario): string {
  const items = ['spending', ...costsOnTopList(s), 'tax'];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Below this a year, drawing on savings while working is too small to mention. */
const SHORTFALL_NOTE_GBP = 500;

/**
 * While anyone still earns, how much a year (today's money, average) the central case draws from
 * savings to cover spending, mortgage, costs, tax and saving: i.e. outgoings above take-home pay.
 */
export function workingShortfall(r: SimulationResult): { perYear: number; years: number } | null {
  const rows = r.centralCase.filter((row) => row.salary > 0);
  if (rows.length === 0) return null;
  const drawn = rows.map((row) => row.drawCash + row.drawGia + row.drawIsa + row.drawLisa + row.drawPension + (row.drawPremiumBonds ?? 0));
  const short = drawn.filter((d) => d > 0);
  if (short.length === 0) return null;
  const perYear = short.reduce((a, b) => a + b, 0) / short.length;
  return perYear >= SHORTFALL_NOTE_GBP ? { perYear, years: short.length } : null;
}

/** Plain-English note about overspending while working, or null. */
export function shortfallText(r: SimulationResult): string | null {
  const w = workingShortfall(r);
  if (!w) return null;
  return `While working, you spend about ${formatMoney(Math.round(w.perYear / 100) * 100)} a year more than you take home (living costs, mortgage, home costs and saving together), so savings cover the gap${w.years > 1 ? ` in ${w.years} years` : ''}. See Results → Year by year.`;
}

/** Below this relative gap between planned and max spend, say the plan is "about right". */
const ON_TARGET = 0.02;

/**
 * The answer people come for, in one or two sentences: how likely the money is to last,
 * and how much they could spend to hit their target success rate.
 */
export function verdictText(r: SimulationResult, s: Scenario, maxSpend?: MaxSpendValue): { lead: string; spend?: string } {
  const who = s.people[0]?.name || 'person 1';
  // Ages follow person 1, so name them only when there are two people.
  const lead = s.people.length > 1 ? `chance your money lasts until ${who} is ${s.sim.horizonAge}` : `chance your money lasts to age ${s.sim.horizonAge}`;
  if (!maxSpend || maxSpend.multiplier <= 0) return { lead };
  const target = `${Math.round(maxSpend.targetSuccessRate * 100)}%`;
  const planned = maxSpend.annualSpendReal / maxSpend.multiplier;
  const gap = maxSpend.multiplier - 1;
  const extra = costsOnTop(s);
  const amount = `${formatMoney(maxSpend.annualSpendReal)} a year${extra ? ` (plus your ${extra})` : ''}`;
  if (Math.abs(gap) < ON_TARGET) return { lead, spend: `Your planned spending (${formatMoney(planned)} a year) is about right for a ${target} chance.` };
  return gap < 0
    ? { lead, spend: `For a ${target} chance, spend about ${amount}: ${formatPct(-gap)} less than the ${formatMoney(planned)} you plan.` }
    : { lead, spend: `For a ${target} chance you could spend up to ${amount}: ${formatPct(gap)} more than the ${formatMoney(planned)} you plan.` };
}

/** Plain-English answer for the earliest stop-work search, or null when there is nothing to say. */
export function retireAgeText(v: RetireAgeValue | undefined, s: Scenario): string | null {
  if (!v) return null;
  const pct = `${Math.round(v.targetSuccessRate * 100)}%`;
  switch (v.status) {
    case 'now': return `Now — stopping work today already gives a ${pct} chance`;
    case 'found': {
      // A stop-work age already reached counts as stopping now.
      const planned = s.people[0] ? Math.max(s.people[0].retirementAge, currentAges(s)[0]) : undefined;
      const diff = planned !== undefined && v.age !== undefined ? v.age - planned : 0;
      const vsPlan = diff === 0 ? 'your planned age' : `${Math.abs(diff)} year${Math.abs(diff) === 1 ? '' : 's'} ${diff < 0 ? 'earlier' : 'later'} than planned`;
      return `${v.age} (${vsPlan})`;
    }
    case 'notReachable': return `Not by ${v.latestTried} at this spending`;
    case 'notWorking': return null;
  }
}

/**
 * Key facts under the verdict: how long the money lasts (at the target confidence and in a
 * typical future) and the earliest age person 1 could stop work. Shared by Overview and Results.
 */
export function keyFacts(r: SimulationResult, s: Scenario, retireAge: RetireAgeValue | undefined, retirePending: boolean): HTMLElement {
  const target = s.sim.targetSuccessRate;
  const sure = moneyLastsUntil(r, target);
  const typical = moneyLastsUntil(r, 0.5);
  const who = s.people[0]?.name || 'person 1';
  const retire = retireAgeText(retireAge, s);
  const fact = (label: string, value: string, note: string) => h('div', { class: 'fact' }, h('dt', {}, label), h('dd', {}, h('span', { class: 'fact-value' }, value), h('span', { class: 'muted small' }, note)));
  return h('dl', { class: 'key-facts' },
    fact(`Money lasts (${Math.round(target * 100)}% of futures)`, `to age ${lastsLabel(sure)}`, sure.beyond ? `The money outlasts the plan in at least ${Math.round(target * 100)}% of futures.` : `In ${Math.round((1 - target) * 100)}% of futures it runs out before age ${sure.age + 1}.`),
    fact('Money lasts (typical future)', `to age ${lastsLabel(typical)}`, typical.beyond ? 'Half of futures still have money at the end of the plan.' : 'Half of futures have run out by this age.'),
    retire !== null || (retirePending && canChooseStopWork(s))
      ? fact(s.people.length > 1 ? `Earliest stop-work age (${who})` : 'Earliest stop-work age', retire ?? 'working it out…', `With planned spending and a ${Math.round(target * 100)}% chance the money lasts.${s.people.length > 1 ? ' The other person’s stop-work age moves by the same number of years.' : ''} Explore it with the What if? sliders.`)
      : null);
}

/**
 * With a flexible strategy the chance of success is high because spending falls in bad markets:
 * say how far it falls in a bad future (1 in 10), so the cost of that flexibility is visible.
 */
function flexibleSpendingText(r: SimulationResult): string {
  const lead = 'With your withdrawal strategy, spending falls when investments do, so a future only counts as running out if it cannot cover fixed costs.';
  const low = r.retirementSpendLow;
  if (low === undefined) return lead;
  return low <= 0
    ? `${lead} In 1 future in 10 the money runs out.`
    : `${lead} In 1 future in 10, spending in retirement drops to ${formatMoney(Math.round(low / 100) * 100)} a year or less at some point (today’s money).`;
}

/** Big success figure, band label and the plain-English verdict. */
export function verdictBlock(r: SimulationResult, s: Scenario, maxSpend: MaxSpendValue | undefined, pending: string | null): HTMLElement {
  const band = successBand(r.successRate);
  const v = verdictText(r, s, maxSpend);
  return h('div', { class: `verdict success ${band.cls}` },
    h('div', { class: 'verdict-figure' },
      h('span', { class: 'big' }, formatPct(r.successRate)),
      h('span', {}, v.lead),
      h('strong', { class: 'band-label' }, band.label)),
    h('div', { class: 'verdict-text' },
      v.spend ? h('p', { class: 'verdict-lead' }, v.spend) : pending ? h('p', { class: 'muted' }, pending) : null,
      v.spend && (s.spending.length > 1 || s.strategy.kind !== 'fixedReal')
        ? h('p', { class: 'muted small' }, `That figure is your spending now. It assumes ${s.spending.length > 1 ? 'every phase of your spending plan scales by the same amount and is ' : ''}spent as a fixed amount rising with inflation, whatever withdrawal strategy you chose.`)
        : null,
      ...(maxSpend?.warnings ?? []).map((w) => h('p', { class: 'warning small' }, w)),
      shortfallText(r) ? h('p', { class: 'warning small' }, shortfallText(r)) : null,
      s.strategy.kind !== 'fixedReal' ? h('p', { class: 'small' }, flexibleSpendingText(r)) : null,
      h('p', { class: 'muted small' }, `A future counts as a success if ${whatMustBePaid(s)} are paid in full every year until age ${s.sim.horizonAge}. Spare income while working is ${surplusDescription(s)}. Based on ${r.runs.toLocaleString('en-GB')} simulated futures. All amounts are in today’s money.`)));
}
