import type { Scenario, SimulationResult } from '../model/types';
import type { ConfigBundle } from '../config/configTypes';
import type { MaxSpendValue, QuickResult, RetireAgeValue } from '../model/workerMessages';
import { DEFAULT_CONFIG } from '../defaults/ukDefaults';
import { validateConfig, blockingIssues, type ValidationIssue } from '../config/configValidate';
import { validateScenario, type ScenarioIssue } from '../model/validateScenario';
import { diffConfig, deepEqual } from '../config/configDiff';
import { migrateConfig } from '../config/configMigrate';
import { getPath, hasPath, setPath, deletePath } from '../config/paths';
import { parseHistoricalCsv, type CsvParseResult } from '../config/historicalCsv';
import { taxYearLabel, taxYearStartYear } from '../model/dates';
import { EXAMPLE_SCENARIOS } from './exampleScenarios';
import type { SimRunner } from './simClient';

export const STORAGE_KEYS = {
  scenario: 'ukplanner.scenario.v1',
  config: 'ukplanner.config.v1',
  configBase: 'ukplanner.configBase.v1',   // the shipped defaults the user's config was based on
  welcomed: 'ukplanner.welcomed.v1',       // the welcome notice was dismissed
} as const;

export const SAVE_DEBOUNCE_MS = 400;
export const RUN_DEBOUNCE_MS = 500;

export type RunStatus = 'idle' | 'queued' | 'running' | 'done' | 'cancelled' | 'error' | 'invalid';

export interface Notice { id: string; kind: 'info' | 'warning' | 'error'; text: string }

export interface DefaultsDiffRow { path: string; yours: unknown; oldDefault: unknown; newDefault: unknown }

export interface AppState {
  scenario: Scenario;
  config: ConfigBundle;
  results?: SimulationResult;
  maxSpend?: MaxSpendValue;
  /** Earliest stop-work age at the target success rate (worked out after max spend). */
  retireAge?: RetireAgeValue;
  status: RunStatus;
  progress: { completed: number; total: number };
  /** Steps of the max-sustainable-spend search done so far, while it is being worked out. */
  maxSpendProgress?: { completed: number; total: number };
  runError?: string;
  errors: ValidationIssue[];          // config validation (errors and warnings)
  scenarioErrors: ScenarioIssue[];
  notices: Notice[];
  storageAvailable: boolean;
}

export interface StoreOptions {
  storage?: Storage | null;           // defaults to window.localStorage when available
  runner?: SimRunner;                 // simulation runner (the worker client in the app)
  defaults?: ConfigBundle;
  initialScenario?: Scenario;
  autoRun?: boolean;                  // default true
}

export interface ExportFile { app: 'ukplanner'; version: 1; scenario: Scenario; config: ConfigBundle }

type Listener = (state: AppState) => void;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Loose shape checks before full validation, so corrupt data never crashes the app. */
function looksLikeScenario(v: unknown): v is Scenario {
  return isObject(v) && Array.isArray(v.people) && Array.isArray(v.accounts) && Array.isArray(v.contributions)
    && Array.isArray(v.properties) && Array.isArray(v.incomeStreams) && Array.isArray(v.spending)
    && isObject(v.strategy) && Array.isArray(v.withdrawalOrder) && isObject(v.sim);
}
function looksLikeConfig(v: unknown): v is ConfigBundle {
  return isObject(v) && typeof v.defaultsVersion === 'string' && isObject(v.tax) && isObject(v.taxProjection)
    && isObject(v.pensionAccess) && isObject(v.statePension) && isObject(v.market) && Array.isArray(v.historicalReturns);
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Observable app store. Holds scenario, config and results; persists to
 * localStorage (debounced 400ms, prefixed keys); re-runs the simulation 500ms after
 * a change (cancelling a run in progress); exposes reset, diff and import/export actions.
 */
export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private readonly defaults: ConfigBundle;
  private base: ConfigBundle;
  private readonly storage: Storage | null;
  private readonly runner?: SimRunner;
  private readonly autoRun: boolean;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped when the scenario is replaced wholesale (example, import), so the UI does not compare unrelated runs. */
  replaceCount = 0;
  /** Bumped on every run or cancel, so late answers from an older run are ignored. */
  private runToken = 0;
  /** True when no saved scenario was found, i.e. this is a first visit showing the built-in example. */
  firstVisit = false;
  private runTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: StoreOptions = {}) {
    this.defaults = structuredClone(opts.defaults ?? DEFAULT_CONFIG);
    this.base = structuredClone(this.defaults);
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.runner = opts.runner;
    this.autoRun = opts.autoRun !== false;
    const scenario = structuredClone(opts.initialScenario ?? EXAMPLE_SCENARIOS[0].scenario);
    this.state = this.withValidation({
      scenario,
      config: structuredClone(this.defaults),
      status: 'idle',
      progress: { completed: 0, total: 0 },
      errors: [],
      scenarioErrors: [],
      notices: [],
      storageAvailable: this.storage !== null,
    });
    this.load();
  }

  // ---- observation ----
  getState(): AppState { return this.state; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private set(patch: Partial<AppState>, opts: { persist?: boolean; rerun?: boolean } = {}): void {
    let next = { ...this.state, ...patch };
    if (patch.scenario || patch.config) next = this.withValidation(next);
    this.state = next;
    if (opts.persist) this.scheduleSave();
    if (opts.rerun) this.scheduleRun();
    for (const fn of this.listeners) fn(this.state);
  }

  private withValidation(s: AppState): AppState {
    const errors = validateConfig(s.config);
    const scenarioErrors = validateScenario(s.scenario, s.config);
    return { ...s, errors, scenarioErrors };
  }

  // ---- notices ----
  addNotice(n: Notice): void {
    this.set({ notices: [...this.state.notices.filter((x) => x.id !== n.id), n] });
  }
  dismissNotice(id: string): void {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) });
    // Remember that the welcome was closed, so it does not come back on every visit.
    if (id === 'welcome' && this.storage) { try { this.storage.setItem(STORAGE_KEYS.welcomed, 'true'); } catch { /* not persisted */ } }
  }

  // ---- persistence ----
  private read(key: string): unknown {
    if (!this.storage) return undefined;
    try {
      const raw = this.storage.getItem(key);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return null;   // corrupt
    }
  }

  /** Load persisted state. Corrupt or unreadable data is discarded with a visible notice. */
  load(): void {
    if (!this.storage) {
      this.addNotice({ id: 'storage', kind: 'warning', text: 'Browser storage is unavailable, so changes will not be saved when you close this page. Use Export to keep a copy.' });
      return;
    }
    const sc = this.read(STORAGE_KEYS.scenario);
    const cf = this.read(STORAGE_KEYS.config);
    const bs = this.read(STORAGE_KEYS.configBase);
    const patch: Partial<AppState> = {};
    if (sc === undefined && this.read(STORAGE_KEYS.welcomed) === undefined) this.firstVisit = true;
    if (sc !== undefined) {
      if (looksLikeScenario(sc)) patch.scenario = sc;
      else this.addNotice({ id: 'corrupt-scenario', kind: 'error', text: 'Your saved scenario could not be read and was discarded. An example scenario has been loaded instead.' });
    }
    if (cf !== undefined) {
      if (looksLikeConfig(cf)) {
        patch.config = migrateConfig(cf, this.defaults);
        this.base = migrateConfig(structuredClone(looksLikeConfig(bs) ? bs : cf), this.defaults);
      } else {
        this.addNotice({ id: 'corrupt-config', kind: 'error', text: 'Your saved rules and assumptions could not be read and were discarded. Defaults have been restored.' });
      }
    }
    if (patch.scenario || patch.config) this.set(patch);
    if (this.getDefaultsUpdateDiff().length > 0) {
      this.addNotice({ id: 'defaults', kind: 'info', text: `This version ships updated defaults (${this.defaults.defaultsVersion}). Review them in Rules & Assumptions; your edits are kept unless you accept a change.` });
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS);
  }

  /** Write scenario and config to storage now. Falls back to memory with a notice on failure. */
  saveNow(): void {
    if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined; }
    if (!this.storage) return;
    try {
      this.storage.setItem(STORAGE_KEYS.scenario, JSON.stringify(this.state.scenario));
      this.storage.setItem(STORAGE_KEYS.config, JSON.stringify(this.state.config));
      this.storage.setItem(STORAGE_KEYS.configBase, JSON.stringify(this.base));
    } catch {
      this.addNotice({ id: 'storage', kind: 'warning', text: 'Could not save to browser storage (it may be full or disabled). Changes are kept only until you close this page; use Export to keep a copy.' });
    }
  }

  /** Remove this app's saved data (only ukplanner.* keys). */
  clearStorage(): void {
    if (!this.storage) return;
    try { for (const k of Object.values(STORAGE_KEYS)) this.storage.removeItem(k); } catch { /* ignore */ }
  }

  // ---- running ----
  private scheduleRun(): void {
    if (!this.autoRun || !this.runner) return;
    if (this.runTimer !== undefined) clearTimeout(this.runTimer);
    if (this.state.status === 'running') this.runner.cancel();
    this.runTimer = setTimeout(() => this.runNow(), RUN_DEBOUNCE_MS);
    if (this.state.status !== 'queued') this.set({ status: 'queued' });
  }

  /** Start a simulation now (cancels any run in progress). Does nothing if inputs are invalid. */
  runNow(): void {
    if (this.runTimer !== undefined) { clearTimeout(this.runTimer); this.runTimer = undefined; }
    if (!this.runner) return;
    if (this.state.scenarioErrors.length > 0 || blockingIssues(this.state.errors).length > 0) {
      this.set({ status: 'invalid' });
      return;
    }
    const { scenario, config } = this.state;
    this.set({ status: 'running', progress: { completed: 0, total: scenario.sim.runs }, runError: undefined, maxSpend: undefined, maxSpendProgress: undefined, retireAge: undefined });
    // The earliest stop-work age search runs at the same time on its own worker.
    const token = ++this.runToken;
    void this.runner.retireAge?.(scenario, config).then((retireAge) => { if (retireAge && token === this.runToken) this.set({ retireAge }); });
    this.runner.run(scenario, config, {
      onProgress: (completed, total) => this.set({ progress: { completed, total } }),
      onResult: (results) => this.set({ results, status: 'done', progress: { completed: results.runs, total: results.runs } }),
      onMaxSpendProgress: (completed, total) => this.set({ maxSpendProgress: { completed, total } }),
      onMaxSpend: (maxSpend) => this.set({ maxSpend, maxSpendProgress: undefined }),
      // After the results arrive, an error can only come from the max-spend search: keep the results.
      onError: (message) => this.set(this.state.status === 'done' ? { runError: message, maxSpendProgress: undefined } : { status: 'error', runError: message, maxSpendProgress: undefined }),
      onCancelled: () => { if (this.state.status === 'running') this.set({ status: 'cancelled', maxSpendProgress: undefined }); else this.set({ maxSpendProgress: undefined }); },
    });
  }

  /** Quick what-if check of a variant of the scenario (null if superseded or unavailable). */
  whatIf(scenario: Scenario): Promise<QuickResult | null> {
    return this.runner?.quick ? this.runner.quick(scenario, this.state.config) : Promise.resolve(null);
  }

  /** Quick max sustainable spend for a variant of the scenario (null if superseded or unavailable). */
  maxSpendAt(scenario: Scenario): Promise<MaxSpendValue | null> {
    return this.runner?.maxSpendAt ? this.runner.maxSpendAt(scenario, this.state.config) : Promise.resolve(null);
  }

  /** Cancel the run in progress. */
  cancelRun(): void {
    if (this.runTimer !== undefined) { clearTimeout(this.runTimer); this.runTimer = undefined; }
    this.runToken += 1;
    this.runner?.cancel();
    if (this.state.status === 'running' || this.state.status === 'queued') this.set({ status: 'cancelled' });
  }

  // ---- scenario actions ----
  setScenarioValue(path: string, value: unknown): void {
    this.set({ scenario: setPath(this.state.scenario, path, value) }, { persist: true, rerun: true });
  }
  removeScenarioValue(path: string): void {
    this.set({ scenario: deletePath(this.state.scenario, path) }, { persist: true, rerun: true });
  }
  setScenario(scenario: Scenario): void {
    this.set({ scenario: structuredClone(scenario) }, { persist: true, rerun: true });
  }
  /** Replace the whole scenario (a template or example); the UI stops comparing with earlier runs. */
  replaceScenario(scenario: Scenario): void {
    this.replaceCount += 1;
    this.setScenario(scenario);
  }
  loadExample(id: string): boolean {
    const ex = EXAMPLE_SCENARIOS.find((e) => e.id === id);
    if (!ex) return false;
    this.replaceScenario(ex.scenario);
    return true;
  }

  // ---- config actions ----
  setConfigValue(path: string, value: unknown): void {
    this.set({ config: setPath(this.state.config, path, value) }, { persist: true, rerun: true });
  }

  /** Set a correlation, keeping the matrix symmetric with a unit diagonal. */
  setCorrelation(i: number, j: number, value: number): void {
    if (i === j) return;
    let c = setPath(this.state.config, `market.correlations[${i}][${j}]`, value);
    c = setPath(c, `market.correlations[${j}][${i}]`, value);
    this.set({ config: c }, { persist: true, rerun: true });
  }

  /** True if the value at `path` differs from the current shipped defaults. */
  isModified(path: string): boolean {
    if (!hasPath(this.defaults, path)) return hasPath(this.state.config, path);
    return !deepEqual(getPath(this.state.config, path), getPath(this.defaults, path));
  }

  /** Reset one field (or subtree) to the shipped default. Paths with no default are left alone. */
  resetField(path: string): void {
    if (!hasPath(this.defaults, path)) return;
    this.setConfigValue(path, structuredClone(getPath(this.defaults, path)));
  }

  /** Reset every path under the given prefix(es) to defaults. */
  resetSection(prefix: string | string[]): void {
    let c = this.state.config;
    for (const p of Array.isArray(prefix) ? prefix : [prefix]) {
      if (hasPath(this.defaults, p)) c = setPath(c, p, structuredClone(getPath(this.defaults, p)));
    }
    this.set({ config: c }, { persist: true, rerun: true });
  }

  resetAll(): void {
    this.base = structuredClone(this.defaults);
    this.set({ config: structuredClone(this.defaults) }, { persist: true, rerun: true });
  }

  /** Add a tax year cloned from `cloneFrom` (default: latest), labelled the year after the latest. */
  addTaxYear(cloneFrom?: string): string {
    const years = Object.keys(this.state.config.tax).sort((a, b) => taxYearStartYear(a) - taxYearStartYear(b));
    const source = cloneFrom && this.state.config.tax[cloneFrom] ? cloneFrom : years[years.length - 1];
    const label = taxYearLabel(taxYearStartYear(years[years.length - 1]) + 1);
    const copy = { ...structuredClone(this.state.config.tax[source]), taxYear: label };
    this.set({ config: { ...this.state.config, tax: { ...this.state.config.tax, [label]: copy } } }, { persist: true, rerun: true });
    return label;
  }

  /** Remove a tax year (the last remaining year cannot be removed). */
  removeTaxYear(year: string): boolean {
    const tax = { ...this.state.config.tax };
    if (!(year in tax) || Object.keys(tax).length <= 1) return false;
    delete tax[year];
    this.set({ config: { ...this.state.config, tax } }, { persist: true, rerun: true });
    return true;
  }

  /** Parse pasted CSV; if every line is valid, replace the historical returns. */
  importHistoricalCsv(text: string): CsvParseResult {
    const parsed = parseHistoricalCsv(text);
    if (parsed.errors.length === 0) this.setConfigValue('historicalReturns', parsed.rows);
    return parsed;
  }

  // ---- defaults updates ----
  /** Fields whose shipped default changed since the user's config was created. */
  getDefaultsUpdateDiff(): DefaultsDiffRow[] {
    return diffConfig(this.base, this.defaults)
      .filter((c) => c.path !== 'defaultsVersion')
      .map((c) => ({ path: c.path, yours: getPath(this.state.config, c.path), oldDefault: c.oldValue, newDefault: c.newValue }));
  }

  /** Take the new default for one changed field. */
  acceptDefault(path: string): void {
    this.base = setPath(this.base, path, structuredClone(getPath(this.defaults, path)));
    const config = setPath(this.state.config, path, structuredClone(getPath(this.defaults, path)));
    this.set({ config: this.markDefaultsCurrent(config) }, { persist: true, rerun: true });
  }

  /** Keep the user's value for one changed field (the prompt for it goes away). */
  keepMine(path: string): void {
    this.base = setPath(this.base, path, structuredClone(getPath(this.defaults, path)));
    this.set({ config: this.markDefaultsCurrent(this.state.config) }, { persist: true });
  }

  private markDefaultsCurrent(config: ConfigBundle): ConfigBundle {
    if (this.getDefaultsUpdateDiff().length > 0) return config;
    this.base = { ...this.base, defaultsVersion: this.defaults.defaultsVersion };
    this.dismissNotice('defaults');
    return { ...config, defaultsVersion: this.defaults.defaultsVersion };
  }

  // ---- import / export ----
  exportJson(): string {
    const file: ExportFile = { app: 'ukplanner', version: 1, scenario: this.state.scenario, config: this.state.config };
    return JSON.stringify(file, null, 2);
  }

  /** Validate and load an exported file. On any error nothing changes and the errors are returned. */
  importJson(text: string): { ok: boolean; errors: string[] } {
    let data: unknown;
    try { data = JSON.parse(text); } catch (e) {
      return { ok: false, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
    if (!isObject(data)) return { ok: false, errors: ['The file does not contain a planner export.'] };
    const errors: string[] = [];
    if (!looksLikeScenario(data.scenario)) errors.push('The file has no valid scenario.');
    if (!looksLikeConfig(data.config)) errors.push('The file has no valid rules and assumptions (config).');
    if (errors.length > 0) return { ok: false, errors };
    const scenario = data.scenario as Scenario;
    const config = migrateConfig(data.config as ConfigBundle, this.defaults);
    let issues: string[];
    try {
      issues = [
        ...blockingIssues(validateConfig(config)).map((i) => `Rules: ${i.path}: ${i.message}`),
        ...validateScenario(scenario, config).map((i) => `Scenario: ${i.path}: ${i.message}`),
      ];
    } catch (e) {
      issues = [`The file is malformed: ${e instanceof Error ? e.message : String(e)}`];
    }
    if (issues.length > 0) return { ok: false, errors: issues };
    this.replaceCount += 1;
    this.base = config.defaultsVersion === this.defaults.defaultsVersion ? structuredClone(this.defaults) : structuredClone(config);
    this.set({ scenario: structuredClone(scenario), config: structuredClone(config) }, { persist: true, rerun: true });
    return { ok: true, errors: [] };
  }
}

export function createStore(opts: StoreOptions = {}): Store {
  return new Store(opts);
}
