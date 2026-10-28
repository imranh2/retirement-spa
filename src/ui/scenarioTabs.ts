import type { Account, AccountType, Contribution, IncomeStream, Mortgage, Person, Property, Scenario, WithdrawalStrategy } from '../model/types';
import { mortgagePayments } from '../model/mortgageMath';
import type { Store } from './store';
import { h, confirmButton } from './dom';
import { numberField, textField, selectField, checkboxField, errorSlot } from './fields';
import { formatMoney, formatPct } from './format';
import { ageAt, isIsoDate } from '../model/dates';
import { defaultStatePensionStartAge, minimumPensionAccessAge, statePensionAge } from '../model/ageRules';
import { ACCOUNT_TYPES, MIN_HISTORY_ROWS, SURPLUS_ACCOUNT_TYPES } from '../model/validateScenario';
import { EXAMPLE_SCENARIOS, starterScenario } from './exampleScenarios';
import { keyFacts, verdictBlock } from './verdict';

export interface TabCtx { store: Store; rerender: () => void }

export const ACCOUNT_LABEL: Record<AccountType, string> = {
  cash: 'Cash', gia: 'General investment account (GIA)', isa: 'ISA', lisa: 'Lifetime ISA', dcPension: 'DC pension',
};
const SHORT_LABEL: Record<AccountType, string> = { cash: 'Cash', gia: 'GIA', isa: 'ISA', lisa: 'LISA', dcPension: 'DC pension' };

const sc = (c: TabCtx): Scenario => c.store.getState().scenario;
const setS = (c: TabCtx, path: string, v: unknown) => c.store.setScenarioValue(path, v);

function personOptions(s: Scenario) {
  return s.people.map((p, i) => ({ value: String(i), label: p.name || `Person ${i + 1}` }));
}

function startAge(s: Scenario, i: number): number | undefined {
  const p = s.people[i];
  return p && isIsoDate(p.dateOfBirth) && isIsoDate(s.sim.startDate) ? ageAt(p.dateOfBirth, s.sim.startDate) : undefined;
}

/** A list of editable cards with add and remove controls. */
function list<T>(c: TabCtx, o: { title: string; path: string; items: T[]; heading: (item: T, i: number) => string; body: (item: T, i: number) => Node[]; onAdd?: () => void; addLabel?: string; canRemove?: (i: number) => boolean; onRemove?: (i: number) => void; intro?: string; adders?: Node | null }): HTMLElement {
  const cards = o.items.map((item, i) => h('div', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h4', {}, o.heading(item, i)),
      o.canRemove === undefined || o.canRemove(i)
        ? h('button', { type: 'button', class: 'btn ghost small', 'aria-label': `Remove ${o.heading(item, i)}`, onclick: () => { (o.onRemove ?? ((k: number) => c.store.removeScenarioValue(`${o.path}[${k}]`)))(i); c.rerender(); } }, 'Remove')
        : null),
    h('div', { class: 'grid' }, ...o.body(item, i))));
  return h('section', { class: 'panel-section' },
    h('h3', {}, o.title),
    o.intro ? h('p', { class: 'muted' }, o.intro) : null,
    errorSlot(o.path),
    o.items.length === 0 ? h('p', { class: 'muted empty' }, 'None yet.') : null,
    ...cards,
    o.adders ?? (o.onAdd ? h('button', { type: 'button', class: 'btn', onclick: () => { o.onAdd?.(); c.rerender(); } }, o.addLabel ?? 'Add') : null));
}

/** Let a field span two grid columns (long select labels). */
function wide(el: HTMLElement): HTMLElement {
  el.classList.add('wide');
  return el;
}

function uniqueId(existing: string[], prefix: string): string {
  let n = 1;
  while (existing.includes(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

// ---------------- Overview ----------------

/** Plain-English summary of the scenario. */
export function describeScenario(s: Scenario): string[] {
  const out: string[] = [];
  const names = s.people.map((p, i) => p.name || `Person ${i + 1}`);
  s.people.forEach((p, i) => {
    const age = startAge(s, i);
    const work = p.salary > 0 && age !== undefined && age < p.retirementAge
      ? `earns ${formatMoney(p.salary)} a year and stops work at ${p.retirementAge}`
      : 'is not working';
    out.push(`${names[i]}${age !== undefined ? `, aged ${age},` : ''} ${work}, with ${p.niQualifyingYears} NI qualifying years.`);
  });
  const byType = new Map<AccountType, number>();
  for (const a of s.accounts) byType.set(a.type, (byType.get(a.type) ?? 0) + a.balance);
  const total = [...byType.values()].reduce((x, y) => x + y, 0);
  out.push(`Savings and investments total ${formatMoney(total)}: ${[...byType.entries()].map(([t, v]) => `${SHORT_LABEL[t]} ${formatMoney(v)}`).join(', ')}.`);
  for (const p of s.properties) {
    out.push(`${p.name || 'A property'} worth ${formatMoney(p.value)}${p.mortgage ? ` with a ${formatMoney(p.mortgage.balance)} mortgage` : ''}${p.rentalIncomeAnnual ? `, let for ${formatMoney(p.rentalIncomeAnnual)} a year` : ''}${p.downsize ? `, downsizing at ${p.downsize.atAge}` : ''}.`);
  }
  const phases = s.spending.map((ph, i) => (i === 0 ? `${formatMoney(ph.annualSpend)} a year` : `${formatMoney(ph.annualSpend)} from ${ph.fromAge}`)).join(', then ');
  out.push(`Household spending (today's money, excluding mortgage and property costs): ${phases}.`);
  const st = s.strategy;
  const strat = st.kind === 'fixedReal' ? 'spending follows the plan above, rising with inflation'
    : st.kind === 'percentOfPortfolio' ? `in retirement, spending is ${formatPct(st.pct)} of the portfolio each year`
      : st.kind === 'guardrails' ? `in retirement, guardrails start at ${formatPct(st.initialPct)} of the portfolio and adjust by ${formatPct(st.adjust)}`
        : `in retirement, spending is ${formatPct(st.pct)} of the portfolio, kept between ${formatMoney(st.floor)} and ${formatMoney(st.ceiling)}`;
  out.push(`Strategy: ${strat}. Accounts are drawn in this order: ${s.withdrawalOrder.map((t) => SHORT_LABEL[t]).join(' → ')}.`);
  out.push(`Spare income (left after spending, tax and saving) is ${surplusDescription(s)}.`);
  out.push(`The model runs ${s.sim.runs.toLocaleString('en-GB')} simulations until ${names[0]} is ${s.sim.horizonAge}.`);
  return out;
}

/** Where a scenario validation path lives in the UI: the tab and a readable name for the item. */
/** Plain-English destination for spare income, e.g. "kept as cash savings". */
export function surplusDescription(s: Scenario): string {
  const r = s.surplus ?? { kind: 'cash' };
  if (r.kind === 'spend') return 'treated as spent';
  if (r.kind === 'cash') return 'kept as cash savings';
  const acc = s.accounts.find((a) => a.id === r.accountId);
  return `invested in ${acc?.name || 'the chosen account'}${acc?.type === 'isa' ? ' (up to the ISA allowance)' : ''}`;
}

/** The "Spare income" setting: keep as cash, invest in a cash account/GIA/ISA, or treat as spent. */
function surplusSection(c: TabCtx): HTMLElement {
  const s = sc(c);
  const r = s.surplus ?? { kind: 'cash' as const };
  const value = r.kind === 'invest' ? `invest:${r.accountId}` : r.kind;
  const targets = s.accounts.filter((a) => SURPLUS_ACCOUNT_TYPES.includes(a.type));
  return h('section', { class: 'panel-section' }, h('h3', {}, 'Spare income'),
    h('p', { class: 'muted' }, 'In years when income is more than spending, tax, mortgage and the contributions you set up, the difference has to go somewhere. Results → Central case shows how much there is each year (“Spare income”).'),
    h('div', { class: 'grid' }, wide(selectField({
      label: 'What happens to spare income', value, errorPath: 'surplus',
      help: 'Keeping it as cash is the default. If in real life you spend it, choose “Treat it as spent” (or raise your spending); if you invest it, choose the account. An ISA takes it only up to what is left of the owner’s allowance after their contributions; the rest goes to their GIA, or cash.',
      options: [
        { value: 'cash', label: 'Keep it as cash savings (first cash account)' },
        ...targets.map((a) => ({ value: `invest:${a.id}`, label: `Invest it in ${a.name || ACCOUNT_LABEL[a.type]}${a.type === 'isa' ? ' (within the ISA allowance)' : ''}` })),
        { value: 'spend', label: 'Treat it as spent (not saved)' },
      ],
      onChange: (v) => setS(c, 'surplus', v.startsWith('invest:') ? { kind: 'invest', accountId: v.slice('invest:'.length) } : { kind: v as 'cash' | 'spend' }),
    }))));
}

export function issueLocation(path: string, s: Scenario): { tab: string; tabLabel: string; item: string } {
  const m = /^(\w+)(?:\[(\d+)\])?/.exec(path);
  const root = m?.[1] ?? '';
  const i = m?.[2] !== undefined ? Number(m[2]) : undefined;
  const at = <T>(xs: T[]): T | undefined => (i === undefined ? undefined : xs[i]);
  switch (root) {
    case 'people': return { tab: 'people', tabLabel: 'People & Income', item: at(s.people)?.name || (i !== undefined ? `Person ${i + 1}` : 'People') };
    case 'incomeStreams': return { tab: 'people', tabLabel: 'People & Income', item: at(s.incomeStreams)?.name || 'Other income' };
    case 'accounts': return { tab: 'accounts', tabLabel: 'Accounts', item: at(s.accounts)?.name || 'Accounts' };
    case 'contributions': return { tab: 'contributions', tabLabel: 'Contributions', item: i !== undefined ? `Contribution ${i + 1}` : 'Contributions' };
    case 'properties': return { tab: 'property', tabLabel: 'Property & Mortgage', item: at(s.properties)?.name || 'Property' };
    case 'spending': return { tab: 'spending', tabLabel: 'Spending & Strategy', item: i !== undefined ? `Spending phase ${i + 1}` : 'Spending plan' };
    case 'strategy': return { tab: 'spending', tabLabel: 'Spending & Strategy', item: 'Withdrawal strategy' };
    case 'withdrawalOrder': return { tab: 'spending', tabLabel: 'Spending & Strategy', item: 'Withdrawal order' };
    case 'surplus': return { tab: 'spending', tabLabel: 'Spending & Strategy', item: 'Spare income' };
    case 'sim': return { tab: 'spending', tabLabel: 'Spending & Strategy', item: 'Simulation settings' };
    default: return { tab: 'rules', tabLabel: 'Rules & Assumptions', item: path };
  }
}

export function renderOverview(c: TabCtx): HTMLElement {
  const st = c.store.getState();
  const s = st.scenario;
  const r = st.results;
  const pendingSpend = st.maxSpendProgress ? 'Working out how much you could spend…' : null;
  const headline = r
    ? h('div', {}, verdictBlock(r, s, st.maxSpend, pendingSpend), keyFacts(r, s, st.retireAge, st.status === 'done'))
    : h('p', { class: 'muted' }, st.status === 'invalid' ? 'Fix the problems listed below to see results.' : 'Results will appear here once the simulation has run.');
  const issues = st.scenarioErrors.slice(0, 8).map((e) => {
    const loc = issueLocation(e.path, s);
    return h('li', {}, h('strong', {}, `${loc.item}: `), e.message, ' ', h('a', { href: `#/${loc.tab}` }, `Fix in ${loc.tabLabel} →`));
  });
  const moreIssues = st.scenarioErrors.length - issues.length;
  const warnings = (r?.warnings ?? []).map((w) => h('li', {}, w));
  const replaceCard = (title: string, description: string, load: () => void) => h('div', { class: 'card' },
    h('h4', {}, title), h('p', { class: 'muted' }, description),
    confirmButton('Load', 'Replace my scenario', () => { load(); c.rerender(); }));
  return h('div', {},
    h('section', { class: 'panel-section' }, h('h2', {}, 'Your plan at a glance'), headline,
      h('p', { class: 'row-btns' }, h('a', { href: '#/results', class: 'btn primary' }, 'See full results →'), h('a', { href: '#/people', class: 'btn' }, 'Edit your details'))),
    issues.length > 0 ? h('section', { class: 'panel-section' }, h('h3', {}, 'Problems to fix'), h('ul', { class: 'error-list' }, ...issues), moreIssues > 0 ? h('p', { class: 'muted' }, `…and ${moreIssues} more, highlighted on their tabs.`) : null) : null,
    warnings.length > 0 ? h('section', { class: 'panel-section' }, h('h3', {}, 'Things to know'), h('ul', { class: 'warning-list' }, ...warnings)) : null,
    h('section', { class: 'panel-section' }, h('h3', {}, 'Your scenario in words'), h('ul', { class: 'scenario-list' }, ...describeScenario(s).map((t) => h('li', {}, t)))),
    h('section', { class: 'panel-section', id: 'examples' }, h('h3', {}, 'Start again from a template or example'),
      h('p', { class: 'muted' }, 'Replaces your current scenario (your rules and assumptions are kept). Export first if you want to keep it.'),
      h('div', { class: 'examples' },
        replaceCard('Simple template', 'One person aged 40 with a salary, a workplace pension and some cash. Replace the placeholder figures with your own.', () => c.store.replaceScenario(starterScenario())),
        ...EXAMPLE_SCENARIOS.map((ex) => replaceCard(ex.name, ex.description, () => c.store.loadExample(ex.id))))));
}

// ---------------- People & Income ----------------

function personFields(c: TabCtx, p: Person, i: number): Node[] {
  const pre = `people[${i}]`;
  const s = sc(c);
  return [
    textField({ label: 'Name', value: p.name, errorPath: `${pre}.name`, onChange: (v) => setS(c, `${pre}.name`, v) }),
    textField({ label: 'Date of birth', type: 'date', value: p.dateOfBirth, errorPath: `${pre}.dateOfBirth`, onChange: (v) => setS(c, `${pre}.dateOfBirth`, v) }),
    numberField({ label: 'Salary (gross, per year)', unit: 'gbp', min: 0, step: 100, value: p.salary, errorPath: `${pre}.salary`, help: 'Gross annual employment income in today’s money. Set 0 if not working.', onChange: (v) => setS(c, `${pre}.salary`, v ?? 0) }),
    numberField({ label: 'Salary growth above inflation', unit: 'pct', step: 0.001, value: p.salaryGrowthRealPct, errorPath: `${pre}.salaryGrowthRealPct`, help: 'Annual pay rise above inflation, e.g. 1%.', onChange: (v) => setS(c, `${pre}.salaryGrowthRealPct`, v ?? 0) }),
    numberField({ label: 'Stops work at', unit: 'age', min: 0, max: 120, step: 1, value: p.retirementAge, errorPath: `${pre}.retirementAge`, help: 'Salary stops at this age, and so do contributions unless you set them to carry on (Contributions tab). For person 1 this is also when the retirement withdrawal strategy begins.', onChange: (v) => setS(c, `${pre}.retirementAge`, v ?? 0) }),
    numberField({ label: 'NI qualifying years so far', unit: 'years', min: 0, max: 60, step: 1, value: p.niQualifyingYears, errorPath: `${pre}.niQualifyingYears`, help: 'From your State Pension forecast on gov.uk. Each future year before State Pension age adds one if you earn at least the lower earnings limit, or get NI credits (see below).', onChange: (v) => setS(c, `${pre}.niQualifyingYears`, v ?? 0) }),
    numberField({ label: 'NI credits or voluntary NI until', unit: 'age', nullable: true, min: 0, max: 120, step: 1, value: p.niCreditsUntilAge, placeholder: 'none', errorPath: `${pre}.niCreditsUntilAge`,
      help: 'A future year counts towards the State Pension only if your salary reaches the lower earnings limit. Enter an age here if you will get NI credits until then without earning (e.g. Child Benefit for a child under 12, Carer’s Allowance, Universal Credit) or plan to pay voluntary NI. The cost of voluntary NI is not modelled.',
      onChange: (v) => setS(c, `${pre}.niCreditsUntilAge`, v ?? undefined) }),
    statePensionField(c, p, i),
    checkboxField({ label: 'Already triggered the Money Purchase Annual Allowance', checked: p.mpaaTriggered === true, errorPath: `${pre}.mpaaTriggered`, help: 'Tick if you have already taken taxable money from a DC pension.', onChange: (v) => setS(c, `${pre}.mpaaTriggered`, v) }),
    h('p', { class: 'muted full' }, `Age at start: ${startAge(s, i) ?? '—'}`),
  ];
}

/** State Pension start age with the person's State Pension age and the deferral uplift spelled out. */
function statePensionField(c: TabCtx, p: Person, i: number): HTMLElement {
  const pre = `people[${i}]`;
  const sp = c.store.getState().config.statePension;
  const dobOk = isIsoDate(p.dateOfBirth) && sp.ageSchedule.length > 0;
  const spa = dobOk ? statePensionAge(p.dateOfBirth, sp.ageSchedule) : undefined;
  const start = dobOk ? defaultStatePensionStartAge(p.dateOfBirth, sp.ageSchedule) : undefined;
  const spaText = spa ? `${spa.years}${spa.months ? ` years ${spa.months} months` : ''}` : undefined;
  const note = h('p', { class: 'muted small' });
  const describe = (startAt: number | undefined) => {
    if (spaText === undefined) { note.textContent = ''; return; }
    const deferred = startAt !== undefined && start !== undefined ? Math.max(0, startAt - start) : 0;
    note.textContent = `State Pension age: ${spaText}${start !== undefined && spa && spa.months ? ` (the model starts it at ${start})` : ''}.`
      + (deferred > 0 ? ` Deferring ${deferred} year${deferred === 1 ? '' : 's'} adds ${formatPct(sp.deferralIncreasePerYear * deferred)} to it.` : '');
  };
  describe(p.statePensionStartAge);
  const field = numberField({
    label: 'Start State Pension at', unit: 'age', nullable: true, min: start ?? 0, max: 120, step: 1, value: p.statePensionStartAge,
    placeholder: start !== undefined ? `${start} (State Pension age)` : 'State Pension age', errorPath: `${pre}.statePensionStartAge`,
    help: `Leave blank to start at State Pension age. Enter a later age to defer: each year deferred adds about ${formatPct(sp.deferralIncreasePerYear)} (set in Rules & Assumptions). It cannot start earlier than State Pension age.`,
    onChange: (v) => { setS(c, `${pre}.statePensionStartAge`, v ?? undefined); describe(v ?? undefined); },
  });
  field.append(note);
  return field;
}

function streamFields(c: TabCtx, st: IncomeStream, i: number): Node[] {
  const pre = `incomeStreams[${i}]`;
  return [
    textField({ label: 'Name', value: st.name, errorPath: `${pre}.name`, onChange: (v) => setS(c, `${pre}.name`, v) }),
    selectField({ label: 'Paid to', value: String(st.personIndex), options: personOptions(sc(c)), errorPath: `${pre}.personIndex`, onChange: (v) => setS(c, `${pre}.personIndex`, Number(v)) }),
    numberField({ label: 'Amount per year', unit: 'gbp', min: 0, step: 100, value: st.annualAmount, errorPath: `${pre}.annualAmount`, help: 'In today’s money if inflation-linked; otherwise a fixed cash amount.', onChange: (v) => setS(c, `${pre}.annualAmount`, v ?? 0) }),
    numberField({ label: 'Starts at', unit: 'age', min: 0, max: 120, step: 1, value: st.startAge, errorPath: `${pre}.startAge`, help: 'The recipient’s age when payments start.', onChange: (v) => setS(c, `${pre}.startAge`, v ?? 0) }),
    numberField({ label: 'Ends at', unit: 'age', nullable: true, min: 0, max: 120, step: 1, value: st.endAge, placeholder: 'for life', errorPath: `${pre}.endAge`, help: 'Payments stop at this age (exclusive). Blank means for life.', onChange: (v) => setS(c, `${pre}.endAge`, v ?? undefined) }),
    checkboxField({ label: 'Rises with inflation', checked: st.inflationLinked, onChange: (v) => setS(c, `${pre}.inflationLinked`, v) }),
    checkboxField({ label: 'Taxable as income', checked: st.taxable, onChange: (v) => setS(c, `${pre}.taxable`, v) }),
  ];
}

export function renderPeople(c: TabCtx): HTMLElement {
  const s = sc(c);
  const twoPeople = s.people.length >= 2;
  return h('div', {},
    list(c, {
      title: 'People', path: 'people', items: s.people,
      intro: 'Up to two people. Person 1’s age is the simulation clock; each person is taxed separately.',
      heading: (p, i) => p.name || `Person ${i + 1}`,
      body: (p, i) => personFields(c, p, i),
      canRemove: (i) => i > 0,
      onRemove: (i) => {
        // Move anything owned by the removed person to person 1 so references stay valid.
        const cur = sc(c);
        const fix = <T extends { personIndex: number }>(xs: T[]) => xs.map((x) => (x.personIndex === i ? { ...x, personIndex: 0 } : x));
        c.store.setScenario({
          ...cur,
          people: cur.people.filter((_, k) => k !== i),
          accounts: cur.accounts.map((a) => (a.ownerIndex === i ? { ...a, ownerIndex: 0 } : a)),
          contributions: fix(cur.contributions),
          incomeStreams: fix(cur.incomeStreams),
        });
      },
      onAdd: twoPeople ? undefined : () => setS(c, `people[${s.people.length}]`, { name: 'Partner', dateOfBirth: s.people[0]?.dateOfBirth ?? '1970-01-01', salary: 0, salaryGrowthRealPct: 0, retirementAge: 60, niQualifyingYears: 0 } satisfies Person),
      addLabel: 'Add a partner',
    }),
    list(c, {
      title: 'Other income', path: 'incomeStreams', items: s.incomeStreams,
      intro: 'Defined benefit pensions, part-time work, annuities, maintenance and similar.',
      heading: (st) => st.name || 'Income',
      body: (st, i) => streamFields(c, st, i),
      onAdd: () => setS(c, `incomeStreams[${s.incomeStreams.length}]`, { id: uniqueId(s.incomeStreams.map((x) => x.id), 'income'), name: 'DB pension', annualAmount: 5000, startAge: 65, inflationLinked: true, taxable: true, personIndex: 0 } satisfies IncomeStream),
      addLabel: 'Add income',
    }));
}

// ---------------- Accounts ----------------

/** One-click investment mixes; the four fields stay editable for anything else. */
const ALLOCATION_PRESETS: { label: string; allocation: Account['allocation'] }[] = [
  { label: 'All cash', allocation: { equities: 0, bonds: 0, cash: 1, property: 0 } },
  { label: 'Cautious 40/60', allocation: { equities: 0.4, bonds: 0.5, cash: 0.1, property: 0 } },
  { label: 'Balanced 60/40', allocation: { equities: 0.6, bonds: 0.3, cash: 0.1, property: 0 } },
  { label: 'Growth 80/20', allocation: { equities: 0.8, bonds: 0.15, cash: 0.05, property: 0 } },
  { label: 'All equities', allocation: { equities: 1, bonds: 0, cash: 0, property: 0 } },
];
const ALLOC_TOLERANCE = 1e-6;
function sameAllocation(a: Account['allocation'], b: Account['allocation']): boolean {
  return (['equities', 'bonds', 'cash', 'property'] as const).every((k) => Math.abs(a[k] - b[k]) < ALLOC_TOLERANCE);
}

function accountFields(c: TabCtx, a: Account, i: number): Node[] {
  const pre = `accounts[${i}]`;
  const s = sc(c);
  const owner = s.people[a.ownerIndex];
  const al = a.allocation;
  const sum = al.equities + al.bonds + al.cash + al.property;
  const fields: Node[] = [
    textField({ label: 'Name', value: a.name, errorPath: `${pre}.name`, onChange: (v) => setS(c, `${pre}.name`, v) }),
    selectField({ label: 'Type', value: a.type, errorPath: `${pre}.type`, options: ACCOUNT_TYPES.map((t) => ({ value: t, label: ACCOUNT_LABEL[t] })), onChange: (v) => { setS(c, `${pre}.type`, v); const order = sc(c).withdrawalOrder; if (!order.includes(v)) setS(c, 'withdrawalOrder', [...order, v]); c.rerender(); } }),
    selectField({ label: 'Owner', value: String(a.ownerIndex), options: personOptions(s), errorPath: `${pre}.ownerIndex`, help: 'Tax on withdrawals is calculated for the owner.', onChange: (v) => setS(c, `${pre}.ownerIndex`, Number(v)) }),
    numberField({ label: 'Balance today', unit: 'gbp', min: 0, step: 100, value: a.balance, errorPath: `${pre}.balance`, onChange: (v) => setS(c, `${pre}.balance`, v ?? 0) }),
    numberField({ label: 'Annual fee', unit: 'pct', min: 0, max: 0.1, step: 0.0001, value: a.annualFeePct, errorPath: `${pre}.annualFeePct`, help: 'Charges taken as a percentage of the balance each year, e.g. fund charges plus a percentage platform fee.', onChange: (v) => setS(c, `${pre}.annualFeePct`, v ?? 0) }),
    numberField({ label: 'Fixed fee per year', unit: 'gbp', nullable: true, min: 0, step: 10, value: a.annualFeeFixed, placeholder: 'none', errorPath: `${pre}.annualFeeFixed`, help: 'A flat platform fee in pounds (e.g. £120 a year), in today’s money; it rises with inflation. Applies on top of the percentage fee.', onChange: (v) => setS(c, `${pre}.annualFeeFixed`, v ?? undefined) }),
  ];
  const presetRow = h('div', { class: 'alloc-presets full', role: 'group', 'aria-label': 'Investment mix presets' },
    h('span', { class: 'muted small' }, 'Quick fill:'),
    ...ALLOCATION_PRESETS.map((p) => h('button', {
      type: 'button', class: 'btn small', 'aria-pressed': String(sameAllocation(al, p.allocation)),
      title: `Equities ${formatPct(p.allocation.equities)}, bonds ${formatPct(p.allocation.bonds)}, cash ${formatPct(p.allocation.cash)}`,
      onclick: () => { setS(c, `${pre}.allocation`, { ...p.allocation }); c.rerender(); },
    }, p.label)));
  const alloc = h('fieldset', { class: 'allocation full' }, h('legend', {}, 'Investment mix'), presetRow,
    ...(['equities', 'bonds', 'cash', 'property'] as const).map((k) => numberField({
      label: k === 'property' ? 'Property funds' : k[0].toUpperCase() + k.slice(1), unit: 'pct', min: 0, max: 1, step: 0.01, value: al[k],
      onChange: (v) => { setS(c, `${pre}.allocation.${k}`, v ?? 0); const tot = document.getElementById(`alloc-sum-${i}`); const cur = sc(c).accounts[i]?.allocation; if (tot && cur) tot.textContent = `Total ${formatPct(cur.equities + cur.bonds + cur.cash + cur.property)}`; },
    })),
    h('p', { class: 'muted', id: `alloc-sum-${i}`, 'aria-live': 'polite' }, `Total ${formatPct(sum)}`),
    errorSlot(`${pre}.allocation`));
  fields.push(alloc);
  if (a.type === 'gia') {
    fields.push(numberField({ label: 'Cost basis', unit: 'gbp', nullable: true, min: 0, step: 100, value: a.giaCostBasis, placeholder: 'same as balance', errorPath: `${pre}.giaCostBasis`, help: 'What you originally paid in. Gains above this are subject to Capital Gains Tax when sold.', onChange: (v) => setS(c, `${pre}.giaCostBasis`, v ?? undefined) }));
  }
  if (a.type === 'dcPension') {
    fields.push(
      numberField({ label: 'Your access age', unit: 'age', nullable: true, min: 0, max: 120, step: 1, value: a.pensionAccessAge, placeholder: owner ? `${minimumPensionAccessAge(owner.dateOfBirth, c.store.getState().config.pensionAccess)} (from the rules)` : 'from the rules', errorPath: `${pre}.pensionAccessAge`, help: 'Leave blank to use the minimum pension age from the rules: 55 only if you reach 57 on or before 6 April 2028, otherwise 57. Enter your own age if you have a protected pension age (e.g. 55 under your scheme rules) or plan to wait longer. The pension is never touched before this age.', onChange: (v) => setS(c, `${pre}.pensionAccessAge`, v ?? undefined) }),
      numberField({ label: 'Tax-free cash already taken', unit: 'gbp', nullable: true, min: 0, step: 100, value: a.taxFreeCashTaken, placeholder: '0', errorPath: `${pre}.taxFreeCashTaken`, help: 'Counts against the Lump Sum Allowance.', onChange: (v) => setS(c, `${pre}.taxFreeCashTaken`, v ?? undefined) }),
      selectField({ label: 'Tax relief method', value: a.pensionReliefMethod ?? 'netPay', options: [{ value: 'netPay', label: 'Net pay (workplace, deducted before tax)' }, { value: 'reliefAtSource', label: 'Relief at source (SIPP / some workplace)' }], errorPath: `${pre}.pensionReliefMethod`, help: 'Net pay: contributions come off taxable pay. Relief at source: you pay 80% and the provider claims basic-rate relief; higher-rate relief extends your basic band.', onChange: (v) => setS(c, `${pre}.pensionReliefMethod`, v) }),
    );
  }
  if (a.type === 'lisa') {
    const l = c.store.getState().config.tax[Object.keys(c.store.getState().config.tax).sort().slice(-1)[0]]?.lisa;
    fields.push(h('p', { class: 'muted full' }, l
      ? `LISA money is treated as locked until ${l.penaltyFreeAge}. You can pay in from ${l.minAge} until ${l.maxContributionAge}, and a LISA must be opened by ${l.maxOpenAge}: a LISA with a £0 balance is opened by its first payment, so payments into it that start after ${l.maxOpenAge} go to a GIA or cash instead.`
      : 'LISA money is treated as locked until the penalty-free age.'));
  }
  return fields;
}

export function renderAccounts(c: TabCtx): HTMLElement {
  const s = sc(c);
  const cfg = c.store.getState().config;
  const add = (type: AccountType) => {
    const alloc = type === 'cash' ? { equities: 0, bonds: 0, cash: 1, property: 0 } : { equities: 0.6, bonds: 0.3, cash: 0.1, property: 0 };
    setS(c, `accounts[${s.accounts.length}]`, {
      id: uniqueId(s.accounts.map((a) => a.id), type), type, name: ACCOUNT_LABEL[type], ownerIndex: 0, balance: 0, allocation: alloc,
      annualFeePct: cfg.market.defaultAnnualFeePct[type], ...(type === 'dcPension' ? { pensionReliefMethod: 'netPay' as const } : {}),
    } satisfies Account);
    if (!s.withdrawalOrder.includes(type)) setS(c, 'withdrawalOrder', [...s.withdrawalOrder, type]);
    c.rerender();
  };
  return list(c, {
    title: 'Accounts', path: 'accounts', items: s.accounts,
    intro: 'At least one cash account is needed. Spare income is kept in the first one unless you choose otherwise in Spending & Strategy.',
    heading: (a) => `${a.name || ACCOUNT_LABEL[a.type]} · ${SHORT_LABEL[a.type]}`,
    body: (a, i) => accountFields(c, a, i),
    onRemove: (i) => {
      const cur = sc(c);
      const id = cur.accounts[i].id;
      c.store.setScenario({
        ...cur,
        accounts: cur.accounts.filter((_, k) => k !== i),
        contributions: cur.contributions.filter((x) => x.accountId !== id),
        properties: cur.properties.map((p) => (p.downsize?.releaseToAccountId === id ? { ...p, downsize: { ...p.downsize, releaseToAccountId: cur.accounts.find((a) => a.type === 'cash' && a.id !== id)?.id ?? '' } } : p)),
      });
    },
    adders: h('div', { class: 'adders' }, h('span', { class: 'muted' }, 'Add: '), ...ACCOUNT_TYPES.map((t) => h('button', { type: 'button', class: 'btn small', onclick: () => add(t) }, `+ ${SHORT_LABEL[t]}`))),
  });
}

// ---------------- Contributions ----------------

const CONTRIB_LABEL: Record<Contribution['type'], string> = {
  fixedMonthly: 'Fixed amount per month', pctOfSalary: 'Percentage of salary (you)', employerPctOfSalary: 'Percentage of salary (employer)', lumpSum: 'One-off lump sum',
};

/** End age stored for contributions that stop with work (the field is hidden and not used). */
const MAX_CONTRIBUTION_AGE = 120;

function contributionFields(c: TabCtx, k: Contribution, i: number): Node[] {
  const pre = `contributions[${i}]`;
  const s = sc(c);
  const acc = s.accounts.find((a) => a.id === k.accountId);
  const isPct = k.type === 'pctOfSalary' || k.type === 'employerPctOfSalary';
  const payer = s.people[k.personIndex];
  const payerName = payer?.name || `person ${k.personIndex + 1}`;
  // "Even after stopping work" makes no sense for a share of salary; show those as a set age.
  const stops = isPct && k.stopsWith === 'ageEvenAfterWork' ? 'age' : (k.stopsWith ?? 'age');
  const outside = k.type === 'lumpSum' && k.source === 'external';
  const fields: Node[] = [
    selectField({ label: 'Into account', value: k.accountId, errorPath: `${pre}.accountId`, options: [{ value: '', label: 'Choose…', disabled: true }, ...s.accounts.map((a) => ({ value: a.id, label: `${a.name} (${SHORT_LABEL[a.type]}, ${s.people[a.ownerIndex]?.name ?? '?'})` }))],
      onChange: (v) => { const a = s.accounts.find((x) => x.id === v); setS(c, `${pre}.accountId`, v); if (a && a.type !== 'cash' && a.type !== 'gia') setS(c, `${pre}.personIndex`, a.ownerIndex); c.rerender(); } }),
    selectField({ label: 'Paid by', value: String(k.personIndex), options: personOptions(s), errorPath: `${pre}.personIndex`, help: 'Whose salary and allowances this uses.', onChange: (v) => setS(c, `${pre}.personIndex`, Number(v)) }),
    selectField({ label: 'Type', value: k.type, errorPath: `${pre}.type`,
      options: (Object.keys(CONTRIB_LABEL) as Contribution['type'][]).map((t) => ({ value: t, label: CONTRIB_LABEL[t], disabled: t === 'employerPctOfSalary' && acc !== undefined && acc.type !== 'dcPension' })),
      onChange: (v) => { setS(c, `${pre}.type`, v); c.rerender(); } }),
    numberField({ label: isPct ? 'Percentage of gross salary' : k.type === 'fixedMonthly' ? 'Amount' : 'Amount', unit: isPct ? 'pct' : k.type === 'fixedMonthly' ? 'gbpMonth' : 'gbp', min: 0, step: isPct ? 0.005 : 10, value: k.amount, errorPath: `${pre}.amount`,
      help: acc?.type === 'dcPension' ? 'For pensions, enter the GROSS amount reaching the pot, including tax relief. Your own payments are limited to your salary, or £3,600 a year gross into a relief-at-source pension if you earn less.' : acc?.type === 'lisa' ? 'Amount you pay in; the 25% bonus is added on top.' : 'Paid from take-home pay.',
      onChange: (v) => setS(c, `${pre}.amount`, v ?? 0) }),
    numberField({ label: k.type === 'lumpSum' ? 'Paid at' : 'From', unit: 'age', min: 0, max: 120, step: 1, value: k.startAge, errorPath: `${pre}.startAge`, help: 'The payer’s age (inclusive).', onChange: (v) => setS(c, `${pre}.startAge`, v ?? 0) }),
    k.type === 'lumpSum' ? selectField({ label: 'Paid from', value: k.source ?? 'pay', errorPath: `${pre}.source`,
      help: 'Outside money (an inheritance, a gift, a bonus already received) is added to the account without coming out of your income or other accounts, and is paid at this age even after you stop work. ISA, LISA and pension allowances still apply. For a pension it must be relief at source: you pay in the amount less 20% and the provider adds the rest.',
      options: [{ value: 'pay', label: 'My pay or savings' }, { value: 'external', label: 'Outside money (gift, inheritance…)' }],
      onChange: (v) => { setS(c, `${pre}.source`, v); c.rerender(); } }) : null,
    outside ? null : selectField({ label: 'Stop paying', value: stops, errorPath: `${pre}.stopsWith`,
      help: 'Payments after stopping work come out of your savings and investments, like spending does. A percentage of salary stops anyway, as there is no salary.',
      options: [
        { value: 'work', label: `When ${payerName} stops work (age ${payer?.retirementAge ?? '—'})` },
        { value: 'age', label: 'At a set age, or on stopping work if sooner' },
        ...(isPct ? [] : [{ value: 'ageEvenAfterWork', label: 'At a set age, even after stopping work' }]),
      ],
      onChange: (v) => {
        setS(c, `${pre}.stopsWith`, v);
        // A set age needs a sensible default; for 'work' the end age is not used.
        if (v !== 'work' && !(k.endAge > k.startAge && k.endAge < MAX_CONTRIBUTION_AGE)) setS(c, `${pre}.endAge`, payer?.retirementAge ?? k.startAge + 1);
        c.rerender();
      } }),
    stops === 'work' || outside ? null : numberField({ label: 'Until (not including)', unit: 'age', min: 0, max: 120, step: 1, value: k.endAge, errorPath: `${pre}.endAge`, help: stops === 'age' ? 'Payments also stop when the payer stops work, if that comes first.' : 'Payments carry on after the payer stops work, until this age.', onChange: (v) => setS(c, `${pre}.endAge`, v ?? 0) }),
  ].filter((x): x is HTMLElement => x !== null);
  if (!isPct) fields.push(checkboxField({ label: 'Rises with inflation', checked: k.escalatesWithInflation, onChange: (v) => setS(c, `${pre}.escalatesWithInflation`, v) }));
  return fields;
}

export function renderContributions(c: TabCtx): HTMLElement {
  const s = sc(c);
  return list(c, {
    title: 'Contributions', path: 'contributions', items: s.contributions,
    intro: 'Paid at the start of each year, normally until the payer stops work (choose per contribution). ISA + LISA are capped at the ISA allowance (excess goes to a GIA or cash); pensions at the annual allowance (tapered for incomes over £260,000, or the MPAA) and 100% of earnings (at least £3,600 gross with relief at source).',
    heading: (k) => { const a = s.accounts.find((x) => x.id === k.accountId); return `${CONTRIB_LABEL[k.type]} → ${a?.name ?? 'no account'}`; },
    body: (k, i) => contributionFields(c, k, i),
    onAdd: () => {
      const target = s.accounts.find((a) => a.type === 'dcPension') ?? s.accounts[0];
      setS(c, `contributions[${s.contributions.length}]`, { id: uniqueId(s.contributions.map((x) => x.id), 'contrib'), accountId: target?.id ?? '', personIndex: target?.ownerIndex ?? 0, type: 'fixedMonthly', amount: 200, startAge: startAge(s, target?.ownerIndex ?? 0) ?? 30, endAge: MAX_CONTRIBUTION_AGE, stopsWith: 'work', escalatesWithInflation: true } satisfies Contribution);
    },
    addLabel: 'Add contribution',
  });
}

// ---------------- Property & Mortgage ----------------

/** The calculated monthly payment, so it can be checked against the lender's figure. */
function mortgagePaymentNote(m: Mortgage, id: string): HTMLElement {
  const pay = mortgagePayments(m);
  const over = m.monthlyOverpayment > 0 ? ` plus your ${formatMoney(m.monthlyOverpayment)} overpayment` : '';
  const kind = m.type === 'interestOnly' ? 'Interest-only payment' : 'Monthly payment';
  const fixed = m.fixedYearsRemaining > 0 && pay.afterFix !== undefined;
  return h('p', { id, class: 'full mortgage-payment', 'aria-live': 'polite' },
    h('strong', {}, `${kind}: ${formatMoney(pay.now)}`), over,
    fixed ? `, then about ${formatMoney(pay.afterFix ?? 0)} a month at ${formatPct(m.reversionRate)} once the fix ends` : '',
    '. ', h('span', { class: 'muted' }, 'Worked out from the balance, rates and term; check it against your lender’s figure. Paid on top of your spending plan.'));
}

function propertyFields(c: TabCtx, p: Property, i: number): Node[] {
  const pre = `properties[${i}]`;
  const s = sc(c);
  const fields: Node[] = [
    textField({ label: 'Name', value: p.name, errorPath: `${pre}.name`, onChange: (v) => setS(c, `${pre}.name`, v) }),
    numberField({ label: 'Value today', unit: 'gbp', min: 0, step: 1000, value: p.value, errorPath: `${pre}.value`, onChange: (v) => setS(c, `${pre}.value`, v ?? 0) }),
    numberField({ label: 'Growth above inflation', unit: 'pct', step: 0.001, value: p.growthRealPct, errorPath: `${pre}.growthRealPct`, help: 'Replaces the market property return for this home; the year-to-year volatility still applies.', onChange: (v) => setS(c, `${pre}.growthRealPct`, v ?? 0) }),
    numberField({ label: 'Running costs per year', unit: 'gbp', min: 0, step: 100, value: p.runningCostsAnnual, errorPath: `${pre}.runningCostsAnnual`, help: 'Fixed costs such as insurance, council tax or service charges, in today’s money.', onChange: (v) => setS(c, `${pre}.runningCostsAnnual`, v ?? 0) }),
    numberField({ label: 'Plus % of home value per year', unit: 'pct', nullable: true, min: 0, max: 0.1, step: 0.001, value: p.runningCostsPctOfValue, placeholder: 'none', errorPath: `${pre}.runningCostsPctOfValue`, help: 'Costs that grow with the home’s value, such as maintenance (often 1% a year). Added to the fixed amount.', onChange: (v) => setS(c, `${pre}.runningCostsPctOfValue`, v ?? undefined) }),
    numberField({ label: 'Rental income per year', unit: 'gbp', nullable: true, min: 0, step: 100, value: p.rentalIncomeAnnual, placeholder: 'not let', errorPath: `${pre}.rentalIncomeAnnual`, help: 'Taxable income, split equally between the people.', onChange: (v) => setS(c, `${pre}.rentalIncomeAnnual`, v ?? undefined) }),
    checkboxField({ label: 'Main residence', checked: p.isMainResidence, errorPath: `${pre}.isMainResidence`, help: 'Only the main residence can be downsized. Its sale is free of CGT.', onChange: (v) => { setS(c, `${pre}.isMainResidence`, v); c.rerender(); } }),
  ];
  const m = p.mortgage;
  const payId = `mortgage-pay-${i}`;
  /** Set a mortgage field and refresh the calculated payment beside the form. */
  const setM = (key: keyof Mortgage, value: unknown) => {
    setS(c, `${pre}.mortgage.${key}`, value);
    const now = sc(c).properties[i]?.mortgage;
    const el = document.getElementById(payId);
    if (now && el) el.replaceWith(mortgagePaymentNote(now, payId));
  };
  fields.push(h('fieldset', { class: 'full' }, h('legend', {}, 'Mortgage'),
    checkboxField({ label: 'Has a mortgage', checked: m !== undefined, onChange: (v) => { setS(c, `${pre}.mortgage`, v ? { balance: 100000, type: 'repayment', rate: 0.045, fixedYearsRemaining: 2, reversionRate: 0.065, termYearsRemaining: 20, monthlyOverpayment: 0 } : undefined); c.rerender(); } }),
    m ? h('div', { class: 'grid' },
      numberField({ label: 'Balance', unit: 'gbp', min: 0, step: 1000, value: m.balance, errorPath: `${pre}.mortgage.balance`, onChange: (v) => setM('balance', v ?? 0) }),
      selectField({ label: 'Type', value: m.type, options: [{ value: 'repayment', label: 'Repayment' }, { value: 'interestOnly', label: 'Interest only' }], onChange: (v) => setM('type', v) }),
      numberField({ label: 'Current rate', unit: 'pct', min: 0, max: 0.3, step: 0.0005, value: m.rate, errorPath: `${pre}.mortgage.rate`, onChange: (v) => setM('rate', v ?? 0) }),
      numberField({ label: 'Years left on fixed rate', unit: 'years', min: 0, step: 0.5, value: m.fixedYearsRemaining, errorPath: `${pre}.mortgage.fixedYearsRemaining`, onChange: (v) => setM('fixedYearsRemaining', v ?? 0) }),
      numberField({ label: 'Rate after the fix', unit: 'pct', min: 0, max: 0.3, step: 0.0005, value: m.reversionRate, errorPath: `${pre}.mortgage.reversionRate`, onChange: (v) => setM('reversionRate', v ?? 0) }),
      numberField({ label: 'Term remaining', unit: 'years', min: 0, step: 0.5, value: m.termYearsRemaining, errorPath: `${pre}.mortgage.termYearsRemaining`, help: 'Any balance left at the end of the term (e.g. interest-only) is paid as a lump sum the following year.', onChange: (v) => setM('termYearsRemaining', v ?? 0) }),
      numberField({ label: 'Monthly overpayment', unit: 'gbp', min: 0, step: 10, value: m.monthlyOverpayment, errorPath: `${pre}.mortgage.monthlyOverpayment`, help: 'Fixed cash amount, not inflated.', onChange: (v) => setM('monthlyOverpayment', v ?? 0) }),
      mortgagePaymentNote(m, payId),
    ) : null));
  if (p.isMainResidence) {
    const d = p.downsize;
    const cash = s.accounts.find((a) => a.type === 'cash');
    fields.push(h('fieldset', { class: 'full' }, h('legend', {}, 'Downsizing'),
      checkboxField({ label: 'Plan to downsize', checked: d !== undefined, onChange: (v) => { setS(c, `${pre}.downsize`, v ? { atAge: 70, newValue: Math.round(p.value * 0.6), releaseToAccountId: cash?.id ?? s.accounts[0]?.id ?? '' } : undefined); c.rerender(); } }),
      d ? h('div', { class: 'grid' },
        numberField({ label: 'At age (person 1)', unit: 'age', min: 0, max: 120, step: 1, value: d.atAge, errorPath: `${pre}.downsize.atAge`, onChange: (v) => setS(c, `${pre}.downsize.atAge`, v ?? 0) }),
        numberField({ label: 'New home value (today’s money)', unit: 'gbp', min: 0, step: 1000, value: d.newValue, errorPath: `${pre}.downsize.newValue`, onChange: (v) => setS(c, `${pre}.downsize.newValue`, v ?? 0) }),
        selectField({ label: 'Pay released money into', value: d.releaseToAccountId, errorPath: `${pre}.downsize.releaseToAccountId`, options: s.accounts.filter((a) => a.type === 'cash' || a.type === 'gia').map((a) => ({ value: a.id, label: a.name })), help: 'A cash account or GIA. Money can be moved into ISAs or pensions only within their allowances.', onChange: (v) => setS(c, `${pre}.downsize.releaseToAccountId`, v) }),
      ) : null));
  }
  return fields;
}

export function renderProperty(c: TabCtx): HTMLElement {
  const s = sc(c);
  return list(c, {
    title: 'Property & mortgages', path: 'properties', items: s.properties,
    intro: 'Property counts towards net worth but is never sold to fund spending, except by downsizing the main residence.',
    heading: (p) => p.name || 'Property',
    body: (p, i) => propertyFields(c, p, i),
    onAdd: () => setS(c, `properties[${s.properties.length}]`, { id: uniqueId(s.properties.map((x) => x.id), 'property'), name: s.properties.some((p) => p.isMainResidence) ? 'Buy-to-let' : 'Home', value: 300000, growthRealPct: 0.01, isMainResidence: !s.properties.some((p) => p.isMainResidence), runningCostsAnnual: 2000 } satisfies Property),
    addLabel: 'Add property',
  });
}

// ---------------- Spending & Strategy ----------------

const STRATEGY_DEFAULTS: Record<WithdrawalStrategy['kind'], WithdrawalStrategy> = {
  fixedReal: { kind: 'fixedReal' },
  percentOfPortfolio: { kind: 'percentOfPortfolio', pct: 0.04 },
  guardrails: { kind: 'guardrails', initialPct: 0.04, upperGuard: 0.2, lowerGuard: 0.2, adjust: 0.1 },
  floorCeiling: { kind: 'floorCeiling', floor: 20000, ceiling: 50000, pct: 0.04 },
};
const STRATEGY_LABEL: Record<WithdrawalStrategy['kind'], string> = {
  fixedReal: 'Fixed real (follow the spending plan)', percentOfPortfolio: 'Percentage of portfolio', guardrails: 'Guardrails (Guyton-Klinger style)', floorCeiling: 'Percentage with floor and ceiling',
};

function strategyFields(c: TabCtx, st: WithdrawalStrategy): Node[] {
  const set = (k: string, v: number | null) => setS(c, `strategy.${k}`, v ?? 0);
  switch (st.kind) {
    case 'fixedReal': return [h('p', { class: 'muted full' }, 'Spend exactly the plan above every year, rising with inflation. If the money runs out, the plan fails.')];
    case 'percentOfPortfolio': return [numberField({ label: 'Withdraw each year', unit: 'pct', min: 0, max: 1, step: 0.001, value: st.pct, errorPath: 'strategy.pct', help: 'Share of the start-of-year portfolio spent on living costs each year in retirement; mortgage and property costs are paid on top. Spending varies with markets.', onChange: (v) => set('pct', v) })];
    case 'guardrails': return [
      numberField({ label: 'Initial withdrawal rate', unit: 'pct', min: 0, max: 1, step: 0.001, value: st.initialPct, errorPath: 'strategy.initialPct', help: 'First retirement year: this share of the portfolio. Later years: last year’s amount plus inflation, unless a guardrail is hit.', onChange: (v) => set('initialPct', v) }),
      numberField({ label: 'Upper guardrail', unit: 'pct', min: 0, max: 1, step: 0.01, value: st.upperGuard, errorPath: 'strategy.upperGuard', help: 'Cut spending if the withdrawal rate rises this far above the initial rate (e.g. 20% → above 4.8%).', onChange: (v) => set('upperGuard', v) }),
      numberField({ label: 'Lower guardrail', unit: 'pct', min: 0, max: 1, step: 0.01, value: st.lowerGuard, errorPath: 'strategy.lowerGuard', help: 'Raise spending if the withdrawal rate falls this far below the initial rate.', onChange: (v) => set('lowerGuard', v) }),
      numberField({ label: 'Adjustment', unit: 'pct', min: 0, max: 1, step: 0.01, value: st.adjust, errorPath: 'strategy.adjust', help: 'Size of each cut or raise.', onChange: (v) => set('adjust', v) }),
    ];
    case 'floorCeiling': return [
      numberField({ label: 'Withdraw each year', unit: 'pct', min: 0, max: 1, step: 0.001, value: st.pct, errorPath: 'strategy.pct', onChange: (v) => set('pct', v) }),
      numberField({ label: 'Floor (today’s money)', unit: 'gbp', min: 0, step: 500, value: st.floor, errorPath: 'strategy.floor', help: 'Never spend less than this.', onChange: (v) => set('floor', v) }),
      numberField({ label: 'Ceiling (today’s money)', unit: 'gbp', min: 0, step: 500, value: st.ceiling, errorPath: 'strategy.ceiling', help: 'Never spend more than this.', onChange: (v) => set('ceiling', v) }),
    ];
  }
}

function randomSeed(): number {
  const MAX_SEED = 2 ** 31 - 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % MAX_SEED;
}

export function renderSpending(c: TabCtx): HTMLElement {
  const st = c.store.getState();
  const s = st.scenario;
  const order = s.withdrawalOrder;
  const move = (i: number, d: number) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setS(c, 'withdrawalOrder', next);
    c.rerender();
    requestAnimationFrame(() => document.getElementById(`order-${next[i + d]}-${d < 0 ? 'up' : 'down'}`)?.focus());
  };
  const missing = ACCOUNT_TYPES.filter((t) => !order.includes(t));
  const histOk = st.config.historicalReturns.length >= MIN_HISTORY_ROWS;
  const ageNow = startAge(s, 0);

  return h('div', {},
    list(c, {
      title: 'Spending plan', path: 'spending', items: s.spending,
      intro: `Household living costs in today’s money, for every year from now, working and retired. Excludes mortgage payments and property running costs (added separately). The first phase must start at or before ${s.people[0]?.name || 'person 1'}’s current age${ageNow !== undefined ? ` (${ageNow})` : ''}.`,
      heading: (ph, i) => (i === 0 ? 'From now' : `From age ${ph.fromAge}`),
      body: (ph, i) => [
        numberField({ label: 'From age (person 1)', unit: 'age', min: 0, max: 120, step: 1, value: ph.fromAge, errorPath: `spending[${i}].fromAge`, onChange: (v) => setS(c, `spending[${i}].fromAge`, v ?? 0) }),
        numberField({ label: 'Spending per year', unit: 'gbp', min: 0, step: 500, value: ph.annualSpend, errorPath: `spending[${i}].annualSpend`, help: 'Living costs in today’s money. Leave out mortgage payments and property running costs: they are entered under Property and paid on top.', onChange: (v) => setS(c, `spending[${i}].annualSpend`, v ?? 0) }),
      ],
      canRemove: () => s.spending.length > 1,
      onAdd: () => { const last = s.spending[s.spending.length - 1]; setS(c, `spending[${s.spending.length}]`, { fromAge: (last?.fromAge ?? 60) + 10, annualSpend: last?.annualSpend ?? 30000 }); },
      addLabel: 'Add phase',
    }),
    h('section', { class: 'panel-section' }, h('h3', {}, 'Retirement withdrawal strategy'),
      h('p', { class: 'muted' }, `Applies from ${s.people[0]?.name || 'person 1'}’s stop-work age (${s.people[0]?.retirementAge ?? '—'}). Before then every strategy follows the spending plan.`),
      h('div', { class: 'grid' },
        wide(selectField({ label: 'Strategy', value: s.strategy.kind, options: (Object.keys(STRATEGY_LABEL) as WithdrawalStrategy['kind'][]).map((k) => ({ value: k, label: STRATEGY_LABEL[k] })),
          onChange: (k) => { setS(c, 'strategy', STRATEGY_DEFAULTS[k]); c.rerender(); } })),
        ...strategyFields(c, s.strategy))),
    surplusSection(c),
    h('section', { class: 'panel-section' }, h('h3', {}, 'Withdrawal order'),
      h('p', { class: 'muted' }, 'Accounts are drawn in this order when income does not cover spending. Locked pensions and LISAs are skipped until accessible, so an ISA/GIA/cash “bridge” works automatically.'),
      errorSlot('withdrawalOrder'),
      h('ol', { class: 'order' }, ...order.map((t, i) => h('li', {},
        h('span', {}, ACCOUNT_LABEL[t]),
        h('span', { class: 'order-btns' },
          h('button', { type: 'button', class: 'btn small', id: `order-${t}-up`, disabled: i === 0, 'aria-label': `Move ${ACCOUNT_LABEL[t]} up`, onclick: () => move(i, -1) }, '↑'),
          h('button', { type: 'button', class: 'btn small', id: `order-${t}-down`, disabled: i === order.length - 1, 'aria-label': `Move ${ACCOUNT_LABEL[t]} down`, onclick: () => move(i, 1) }, '↓'),
          h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove ${ACCOUNT_LABEL[t]} from the order`, onclick: () => { setS(c, 'withdrawalOrder', order.filter((x) => x !== t)); c.rerender(); } }, '✕'))))),
      missing.length > 0 ? h('div', { class: 'adders' }, h('span', { class: 'muted' }, 'Add: '), ...missing.map((t) => h('button', { type: 'button', class: 'btn small', onclick: () => { setS(c, 'withdrawalOrder', [...order, t]); c.rerender(); } }, `+ ${SHORT_LABEL[t]}`))) : null),
    h('section', { class: 'panel-section' }, h('h3', {}, 'Simulation settings'),
      h('div', { class: 'grid' },
        numberField({ label: 'Number of simulations', unit: 'count', min: 1, max: 100000, step: 100, value: s.sim.runs, errorPath: 'sim.runs', help: 'More runs give smoother results but take longer. 5,000 is a good default.', onChange: (v) => setS(c, 'sim.runs', Math.round(v ?? 0)) }),
        h('div', { class: 'field' },
          numberField({ label: 'Random seed', unit: 'count', step: 1, value: s.sim.seed, errorPath: 'sim.seed', help: 'The same seed always gives the same results, so you can compare changes fairly.', onChange: (v) => setS(c, 'sim.seed', Math.round(v ?? 0)) }),
          h('button', { type: 'button', class: 'btn small', onclick: () => { setS(c, 'sim.seed', randomSeed()); c.rerender(); } }, 'New random seed')),
        numberField({ label: 'Plan until age (person 1)', unit: 'age', min: 1, max: 120, step: 1, value: s.sim.horizonAge, errorPath: 'sim.horizonAge', help: 'There is no mortality model: pick an age you want the money to last to.', onChange: (v) => setS(c, 'sim.horizonAge', v ?? 0) }),
        textField({ label: 'Start date', type: 'date', value: s.sim.startDate, errorPath: 'sim.startDate', help: 'The simulation starts in the tax year containing this date.', onChange: (v) => setS(c, 'sim.startDate', v) }),
        wide(selectField({ label: 'Return model', value: s.sim.returnModel, errorPath: 'sim.returnModel',
          help: histOk ? 'Lognormal uses your market assumptions. Bootstrap resamples 5-year blocks of your pasted history.' : `Bootstrap needs at least ${MIN_HISTORY_ROWS} years of historical returns: paste them in Rules & Assumptions > Historical returns.`,
          options: [{ value: 'lognormal', label: 'Lognormal (market assumptions)' }, { value: 'historicalBlockBootstrap', label: `Historical block bootstrap${histOk ? '' : ' (needs data)'}`, disabled: !histOk }],
          onChange: (v) => setS(c, 'sim.returnModel', v) })),
        selectField({ label: 'Time step', value: String(s.sim.stepsPerYear), errorPath: 'sim.stepsPerYear',
          help: 'Annual: all cash flows on 6 April each year, then a year of returns (fast, slightly conservative). Monthly: flows and returns every month, tax settled at the end of each tax year (about 5x slower).',
          options: [{ value: '1', label: 'Annual (faster)' }, { value: '12', label: 'Monthly (more precise timing)' }],
          onChange: (v) => setS(c, 'sim.stepsPerYear', v === '12' ? 12 : 1) }),
        numberField({ label: 'Target success rate', unit: 'pct', min: 0.01, max: 0.99, step: 0.01, value: s.sim.targetSuccessRate, errorPath: 'sim.targetSuccessRate', help: 'The chance of the money lasting that you are aiming for. Used for max sustainable spend, the earliest stop-work age and “Money lasts”.', onChange: (v) => setS(c, 'sim.targetSuccessRate', v ?? 0) }))));
}

