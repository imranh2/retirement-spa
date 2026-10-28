import type { Scenario, SimulationResult } from '../model/types';
import type { MaxSpendValue, RetireAgeValue } from '../model/workerMessages';
import { lastsLabel, moneyLastsUntil } from './longevity';
import { h } from './dom';
import { formatMoney, formatPct } from './format';
import { successBand } from './successBand';

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
  const amount = formatMoney(maxSpend.annualSpendReal);
  if (Math.abs(gap) < ON_TARGET) return { lead, spend: `Your planned spending (${formatMoney(planned)} a year) is about right for a ${target} chance.` };
  return gap < 0
    ? { lead, spend: `For a ${target} chance, spend about ${amount} a year: ${formatPct(-gap)} less than the ${formatMoney(planned)} you plan.` }
    : { lead, spend: `For a ${target} chance you could spend up to ${amount} a year: ${formatPct(gap)} more than the ${formatMoney(planned)} you plan.` };
}

/** Plain-English answer for the earliest stop-work search, or null when there is nothing to say. */
export function retireAgeText(v: RetireAgeValue | undefined, s: Scenario): string | null {
  if (!v) return null;
  const pct = `${Math.round(v.targetSuccessRate * 100)}%`;
  switch (v.status) {
    case 'now': return `Now — stopping work today already gives a ${pct} chance`;
    case 'found': {
      const planned = s.people[0]?.retirementAge;
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
    retire !== null || (retirePending && s.people[0] && s.people[0].retirementAge > (r.ages[0] ?? 0))
      ? fact(s.people.length > 1 ? `Earliest stop-work age (${who})` : 'Earliest stop-work age', retire ?? 'working it out…', `With planned spending and a ${Math.round(target * 100)}% chance the money lasts. Explore it with the What if? sliders on Results.`)
      : null);
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
      s.strategy.kind !== 'fixedReal'
        ? h('p', { class: 'small' }, 'With your withdrawal strategy, spending falls when investments do, so a future only counts as running out if it cannot cover fixed costs. Check “Where the money comes from” for how low spending gets.')
        : null,
      h('p', { class: 'muted small' }, `Based on ${r.runs.toLocaleString('en-GB')} simulated futures. All amounts are in today’s money.`)));
}
