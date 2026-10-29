// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Store, STORAGE_KEYS } from '../../src/ui/store';
import type { SimRunner, RunHandlers } from '../../src/ui/simClient';
import type { RetireAgeValue } from '../../src/model/workerMessages';
import { simulate } from '../../src/engine/simulate';
import { DEFAULT_CONFIG } from '../../src/defaults/ukDefaults';
import { EXAMPLE_SCENARIOS } from '../../src/ui/exampleScenarios';
import type { Scenario } from '../../src/model/types';
import type { ConfigBundle } from '../../src/config/configTypes';

/** Runs the engine synchronously, standing in for the worker. */
class FakeRunner implements SimRunner {
  runs = 0;
  cancels = 0;
  run(scenario: Scenario, config: ConfigBundle, h: RunHandlers): void {
    this.runs++;
    h.onResult?.(simulate(scenario, config, { runsOverride: 200 }));
  }
  cancel(): void { this.cancels++; }
}

const small = () => {
  const s = structuredClone(EXAMPLE_SCENARIOS[0].scenario);
  s.sim.runs = 200;
  return s;
};

beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('store persistence', () => {
  it('saves to prefixed keys after a 400ms debounce and reloads', () => {
    const a = new Store({ initialScenario: small(), autoRun: false });
    a.setScenarioValue('people[0].name', 'Pat');
    a.setConfigValue('tax.2026/27.personalAllowance', 13000);
    expect(localStorage.getItem(STORAGE_KEYS.scenario)).toBeNull();
    vi.advanceTimersByTime(400);
    expect(Object.keys(localStorage).every((k) => k.startsWith('ukplanner.'))).toBe(true);
    const b = new Store({ autoRun: false });
    expect(b.getState().scenario.people[0].name).toBe('Pat');
    expect(b.getState().config.tax['2026/27'].personalAllowance).toBe(13000);
    expect(b.isModified('tax.2026/27.personalAllowance')).toBe(true);
    expect(b.isModified('tax.2026/27.ni.mainRate')).toBe(false);
  });

  it('discards corrupt data with a visible notice instead of crashing', () => {
    localStorage.setItem(STORAGE_KEYS.scenario, '{not json');
    localStorage.setItem(STORAGE_KEYS.config, JSON.stringify({ hello: 1 }));
    const s = new Store({ autoRun: false });
    const ids = s.getState().notices.map((n) => n.id);
    expect(ids).toContain('corrupt-scenario');
    expect(ids).toContain('corrupt-config');
    expect(s.getState().config).toEqual(DEFAULT_CONFIG);
  });

  it('falls back to memory with a notice when storage is unavailable', () => {
    const s = new Store({ storage: null, autoRun: false });
    expect(s.getState().notices.some((n) => n.id === 'storage')).toBe(true);
    s.setScenarioValue('people[0].name', 'X');
    vi.advanceTimersByTime(500);
    expect(s.getState().scenario.people[0].name).toBe('X');
  });
});

describe('store runs', () => {
  it('debounces runs by 500ms and cancels a run in progress', () => {
    const runner = new FakeRunner();
    const s = new Store({ initialScenario: small(), runner });
    s.setScenarioValue('sim.seed', 2);
    s.setScenarioValue('sim.seed', 3);
    expect(runner.runs).toBe(0);
    vi.advanceTimersByTime(500);
    expect(runner.runs).toBe(1);
    expect(s.getState().status).toBe('done');
    expect(s.getState().results?.meta.seed).toBe(3);
  });
  it('does not run invalid scenarios', () => {
    const runner = new FakeRunner();
    const s = new Store({ initialScenario: small(), runner });
    s.setScenarioValue('accounts', []);
    vi.advanceTimersByTime(500);
    expect(runner.runs).toBe(0);
    expect(s.getState().status).toBe('invalid');
    expect(s.getState().scenarioErrors.length).toBeGreaterThan(0);
  });
});

describe('export / import', () => {
  it('round trip export -> clear storage -> import reproduces identical results', () => {
    const runner = new FakeRunner();
    const a = new Store({ initialScenario: small(), runner });
    a.setConfigValue('market.equities.meanReal', 0.045);
    a.runNow();
    const first = a.getState().results;
    const json = a.exportJson();
    a.clearStorage();
    localStorage.clear();
    const b = new Store({ runner });
    expect(b.importJson(json)).toEqual({ ok: true, errors: [] });
    b.runNow();
    const second = b.getState().results;
    expect(second?.portfolioReal).toEqual(first?.portfolioReal);
    expect(second?.successRate).toBe(first?.successRate);
  });
  it('rejects invalid imports with errors and changes nothing', () => {
    const s = new Store({ initialScenario: small(), autoRun: false });
    const before = s.getState();
    expect(s.importJson('nope').ok).toBe(false);
    const bad = JSON.parse(s.exportJson());
    bad.config.tax['2026/27'].incomeTaxBands[0].rate = 2;
    bad.scenario.accounts = [];
    const r = s.importJson(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /Rules, .*[Rr]ate/.test(e))).toBe(true);   // named by its label, not its path
    expect(r.errors.some((e) => e.includes('cash account'))).toBe(true);
    expect(s.getState().scenario).toEqual(before.scenario);
    expect(s.getState().config).toEqual(before.config);
  });
});

describe('defaults updates', () => {
  it('a new defaults version shows a diff and never overwrites user edits', () => {
    const a = new Store({ autoRun: false });
    a.setConfigValue('tax.2026/27.cgt.annualExempt', 5000);    // user edit
    a.saveNow();
    const newer = structuredClone(DEFAULT_CONFIG);
    newer.defaultsVersion = '2027-04-06';
    newer.tax['2026/27'].cgt.annualExempt = 3500;
    newer.tax['2026/27'].personalAllowance = 13000;
    const b = new Store({ defaults: newer, autoRun: false });
    expect(b.getState().config.tax['2026/27'].cgt.annualExempt).toBe(5000);
    expect(b.getState().config.tax['2026/27'].personalAllowance).toBe(12570);
    const diff = b.getDefaultsUpdateDiff();
    expect(diff.map((d) => d.path).sort()).toEqual(['tax.2026/27.cgt.annualExempt', 'tax.2026/27.personalAllowance']);
    expect(b.getState().notices.some((n) => n.id === 'defaults')).toBe(true);
    b.acceptDefault('tax.2026/27.personalAllowance');
    expect(b.getState().config.tax['2026/27'].personalAllowance).toBe(13000);
    b.keepMine('tax.2026/27.cgt.annualExempt');
    expect(b.getState().config.tax['2026/27'].cgt.annualExempt).toBe(5000);
    expect(b.getDefaultsUpdateDiff()).toEqual([]);
    expect(b.getState().config.defaultsVersion).toBe('2027-04-06');
  });
  it('accepting a changed correlation updates both halves, so the matrix stays symmetric', () => {
    const a = new Store({ autoRun: false });
    a.saveNow();
    const newer = structuredClone(DEFAULT_CONFIG);
    newer.defaultsVersion = '2027-04-06';
    newer.market.correlations[0][1] = 0.3;
    newer.market.correlations[1][0] = 0.3;
    const b = new Store({ defaults: newer, autoRun: false });
    b.acceptDefault('market.correlations[0][1]');
    expect(b.getState().config.market.correlations[1][0]).toBe(0.3);
    expect(b.getDefaultsUpdateDiff()).toEqual([]);
  });
});

describe('config actions', () => {
  it('reset field, section and all', () => {
    const s = new Store({ autoRun: false });
    s.setConfigValue('tax.2026/27.ni.mainRate', 0.1);
    s.setConfigValue('tax.2026/27.ni.upperRate', 0.03);
    s.setConfigValue('market.equities.vol', 0.2);
    s.resetField('tax.2026/27.ni.mainRate');
    expect(s.isModified('tax.2026/27.ni.mainRate')).toBe(false);
    s.resetSection('tax.2026/27.ni');
    expect(s.getState().config.tax['2026/27'].ni).toEqual(DEFAULT_CONFIG.tax['2026/27'].ni);
    expect(s.isModified('market.equities.vol')).toBe(true);
    s.resetAll();
    expect(s.getState().config).toEqual(DEFAULT_CONFIG);
  });
  it('add and remove tax years; the last year cannot be removed', () => {
    const s = new Store({ autoRun: false });
    // The defaults define 2026/27 and 2027/28, so the next year is 2028/29.
    const y = s.addTaxYear('2026/27');
    expect(y).toBe('2028/29');
    expect(s.getState().config.tax[y].taxYear).toBe('2028/29');
    expect(s.getState().config.tax[y].savings.basicRate).toBe(s.getState().config.tax['2026/27'].savings.basicRate);
    expect(s.removeTaxYear('2028/29')).toBe(true);
    expect(s.removeTaxYear('2027/28')).toBe(true);
    expect(s.removeTaxYear('2026/27')).toBe(false);
  });
  it('correlation edits stay symmetric', () => {
    const s = new Store({ autoRun: false });
    s.setCorrelation(0, 3, 0.4);
    expect(s.getState().config.market.correlations[3][0]).toBe(0.4);
  });
  it('historical CSV import applies only when every line is valid', () => {
    const s = new Store({ autoRun: false });
    expect(s.importHistoricalCsv('2000,0.1,0,0,0,0\nbad').errors).toHaveLength(1);
    expect(s.getState().config.historicalReturns).toEqual([]);
    s.importHistoricalCsv('2000,0.1,0,0,0,0\n2001,0.2,0,0,0,0');
    expect(s.getState().config.historicalReturns).toHaveLength(2);
  });
  it('loads examples', () => {
    const s = new Store({ autoRun: false });
    expect(s.loadExample('couple-mortgage')).toBe(true);
    expect(s.getState().scenario.people).toHaveLength(2);
    expect(s.getState().scenarioErrors).toEqual([]);
  });
});

describe('what-if values applied to the plan', () => {
  it('writes the stop-work age and scaled spending back through the store', async () => {
    const { whatIfScenario } = await import('../../src/ui/whatIf');
    const ex = EXAMPLE_SCENARIOS.find((e) => e.scenario.people.length > 1);
    if (!ex) throw new Error('needs the couple example');
    const s = new Store({ initialScenario: structuredClone(ex.scenario), autoRun: false });
    const v = whatIfScenario(s.getState().scenario, 58, 90);
    s.setScenarioValue('people', v.people);
    s.setScenarioValue('spending', v.spending);
    const after = s.getState().scenario;
    expect(after.people[0].retirementAge).toBe(58);
    expect(after.people[1].retirementAge).toBe(ex.scenario.people[1].retirementAge - 2);
    expect(after.spending.map((p) => p.annualSpend)).toEqual(ex.scenario.spending.map((p) => Math.round(p.annualSpend * 0.9)));
    expect(s.getState().scenarioErrors).toEqual([]);
  });
});

describe('welcome notice', () => {
  it('shows on a first visit and stays away once dismissed, even if nothing was edited', () => {
    const a = new Store({ autoRun: false });
    expect(a.firstVisit).toBe(true);
    a.dismissNotice('welcome');
    expect(localStorage.getItem(STORAGE_KEYS.welcomed)).not.toBeNull();
    expect(new Store({ autoRun: false }).firstVisit).toBe(false);
  });
});

describe('earliest stop-work age', () => {
  it('keeps the answer for the current run and ignores a late answer from an older one', async () => {
    const resolvers: ((v: RetireAgeValue) => void)[] = [];
    const runner: SimRunner = {
      run: () => { /* main results are not needed here */ },
      cancel: () => {},
      retireAge: () => new Promise((resolve) => { resolvers.push(resolve); }),
    };
    const s = new Store({ initialScenario: small(), runner, autoRun: false });
    const answer = (age: number): RetireAgeValue => ({ status: 'found', age, targetSuccessRate: 0.9, latestTried: 94 });
    s.runNow();
    s.runNow();
    resolvers[0](answer(60));          // from the first, superseded run
    await Promise.resolve();
    expect(s.getState().retireAge).toBeUndefined();
    resolvers[1](answer(64));
    await Promise.resolve();
    expect(s.getState().retireAge?.age).toBe(64);
  });
});

describe('results from a replaced plan', () => {
  it('are not offered as the current plan’s results until its own run finishes', () => {
    const runner = new FakeRunner();
    const s = new Store({ initialScenario: small(), autoRun: false, runner });
    s.runNow();
    expect(s.planResults()).toBeDefined();
    // A held-back runner: the new plan's run has not finished yet.
    let finish: (() => void) | undefined;
    runner.run = (scenario, config, h) => { finish = () => h.onResult?.(simulate(scenario, config, { runsOverride: 50 })); };
    s.replaceScenario(small());
    s.runNow();
    expect(s.getState().results).toBeDefined();   // the old results still exist...
    expect(s.planResults()).toBeUndefined();      // ...but are not shown for the new plan
    expect(s.updating()).toBe(true);
    finish?.();
    expect(s.planResults()).toBeDefined();
  });
});

describe('what-if spending with a flexible strategy', () => {
  it('scales the strategy’s own numbers, so the slider changes the result', async () => {
    const { whatIfScenario } = await import('../../src/ui/whatIf');
    const s = small();
    s.strategy = { kind: 'percentOfPortfolio', pct: 0.04 };
    const v = whatIfScenario(s, undefined, 150);
    expect(v.strategy).toEqual({ kind: 'percentOfPortfolio', pct: 0.06 });
    expect(v.spending[0].annualSpend).toBe(Math.round(s.spending[0].annualSpend * 1.5));
  });
  it('an export from an older version missing newer fields still imports', () => {
    const s = new Store({ initialScenario: small(), autoRun: false });
    const old = JSON.parse(s.exportJson());
    delete old.scenario.sim.targetSuccessRate;
    delete old.scenario.incomeStreams;
    delete old.config.tax['2026/27'].stampDuty;
    expect(s.importJson(JSON.stringify(old)).ok).toBe(true);
    expect(s.getState().scenario.sim.targetSuccessRate).toBe(0.9);
    expect(s.getState().config.tax['2026/27'].stampDuty.ftbNilBand).toBe(300000);
  });
});
