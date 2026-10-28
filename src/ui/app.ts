import { createStore, type AppState, type Store } from './store';
import { createSimClient } from './simClient';
import { h, downloadText, toast } from './dom';
import { showErrors } from './fields';
import { formatMoney, formatMoneyCompact, formatPct } from './format';
import { TABS, startRouter, type TabId } from './router';
import { renderOverview, renderPeople, renderAccounts, renderContributions, renderProperty, renderSpending } from './scenarioTabs';
import { renderConfigEditor, refreshModifiedDots } from './configEditor';
import { renderResults, progressBar } from './results';
import { successBand } from './successBand';

/** Mount the single-page app into #app. */
export function startApp(root: HTMLElement): Store {
  const client = createSimClient();
  const store = createStore({ runner: client });
  let tab: TabId = 'overview';
  let last: AppState = store.getState();

  const panel = h('main', { id: 'panel', tabindex: -1 });
  const notices = h('div', { class: 'notices' });
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' },
    ...TABS.map((t) => h('a', { href: `#/${t.id}`, class: 'tab', 'data-tab': t.id }, t.label)));

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', id: 'import-file', 'aria-label': 'Import a saved plan (JSON)' });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    const res = store.importJson(await file.text());
    if (res.ok) { toast(`Imported ${file.name}.`); rerender(); }
    else store.addNotice({ id: 'import', kind: 'error', text: `Could not import ${file.name}: ${res.errors.slice(0, 6).join(' · ')}${res.errors.length > 6 ? ` (+${res.errors.length - 6} more)` : ''}` });
  });

  const header = h('header', { class: 'app-header' },
    h('div', { class: 'brand' }, h('h1', {}, 'UK Retirement Planner'), h('p', { class: 'muted' }, 'Monte Carlo planning for saving and drawing down, including early retirement.')),
    h('div', { class: 'header-actions' },
      h('a', { href: '#/overview/examples', class: 'btn ghost' }, 'Examples'),
      h('button', { type: 'button', class: 'btn', title: 'Save your scenario and rules as a JSON file', onclick: () => { downloadText(`ukplanner-${store.getState().scenario.sim.startDate}.json`, 'application/json', store.exportJson()); } }, 'Export'),
      h('label', { for: 'import-file', class: 'btn', tabindex: 0, title: 'Load a JSON file saved with Export', onkeydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); fileInput.click(); } } }, 'Import'),
      fileInput));

  // Not a live region itself: it is rebuilt on every progress tick. `announce` speaks only finished results.
  const summary = h('aside', { class: 'summary', 'aria-label': 'Results summary' });
  const announce = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const layout = h('div', { class: 'layout' }, panel, summary);

  root.replaceChildren(
    h('a', { href: '#panel', class: 'skip-link', onclick: (e: Event) => { e.preventDefault(); panel.focus(); } }, 'Skip to content'),
    header, notices, nav, layout,
    h('footer', { class: 'app-footer' },
      h('p', { class: 'disclaimer' }, h('strong', {}, 'This is a modelling tool, not financial advice.'), ' Results depend entirely on the assumptions you enter.'),
      h('p', { class: 'muted small' }, 'Your data stays in this browser (localStorage) and is never uploaded.')),
    h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }), announce);

  const allIssues = (s: AppState) => [...s.scenarioErrors, ...s.errors];

  // Change since the previous run, so what-if edits show their effect. Reset when the scenario is replaced.
  let delta: { success?: number; maxSpend?: number } = {};
  let prevMaxSpend: number | undefined;
  let replaceAtLastResult = store.replaceCount;

  function trackDeltas(s: AppState): void {
    const comparable = store.replaceCount === replaceAtLastResult;
    if (s.results && s.results !== last.results) {
      delta = { success: comparable && last.results ? s.results.successRate - last.results.successRate : undefined };
      if (!comparable) prevMaxSpend = undefined;
      replaceAtLastResult = store.replaceCount;
    }
    if (s.maxSpend && s.maxSpend !== last.maxSpend) {
      delta.maxSpend = prevMaxSpend !== undefined ? s.maxSpend.annualSpendReal - prevMaxSpend : undefined;
      prevMaxSpend = s.maxSpend.annualSpendReal;
    }
  }

  const deltaTag = (d: number | undefined, fmt: (v: number) => string, minAbs: number) => {
    if (d === undefined || Math.abs(d) < minAbs) return null;
    const up = d > 0;
    return h('span', { class: `delta ${up ? 'up' : 'down'}`, title: 'Change since the previous run' }, `${up ? '▲' : '▼'} ${fmt(Math.abs(d))}`);
  };

  function renderSummary(s: AppState): void {
    const r = s.results;
    const band = r ? successBand(r.successRate) : null;
    const MIN_PTS = 0.0005;
    const MIN_GBP = 50;
    const horizon = s.scenario.sim.horizonAge;
    const lastMedian = r ? r.portfolioReal.p50[r.portfolioReal.p50.length - 1] : undefined;
    const problems = s.scenarioErrors.length + s.errors.filter((e) => e.severity !== 'warning').length;
    const parts: (Node | null)[] = [
      r && band
        ? h('a', { href: '#/results', class: `sum-success success ${band.cls}` },
          h('span', { class: 'sum-label' }, `Chance the money lasts to ${horizon}`),
          h('span', { class: 'sum-big' }, formatPct(r.successRate), deltaTag(s.results === r ? delta.success : undefined, (v) => `${(v * 100).toFixed(1)} pts`, MIN_PTS)),
          h('span', { class: 'band-label' }, band.label))
        : h('p', { class: 'muted sum-empty' }, s.status === 'invalid' ? 'Fix the problems below to see results.' : 'Results will appear here once the simulation has run.'),
      r ? h('dl', { class: 'sum-stats' },
        h('div', {}, h('dt', {}, `Max spend at ${Math.round(s.scenario.sim.targetSuccessRate * 100)}% success`),
          h('dd', {}, s.maxSpend ? [`${formatMoney(s.maxSpend.annualSpendReal)}/yr`, deltaTag(delta.maxSpend, formatMoney, MIN_GBP)] : h('span', { class: 'muted' }, s.maxSpendProgress ? `working… ${s.maxSpendProgress.completed}/${s.maxSpendProgress.total}` : '—'))),
        h('div', {}, h('dt', {}, `Median portfolio at ${horizon}`), h('dd', {}, lastMedian !== undefined ? formatMoneyCompact(lastMedian) : '—')),
        h('div', {}, h('dt', {}, 'Lifetime tax (median)'), h('dd', {}, formatMoney(r.taxPaidTotal.median)))) : null,
      problems > 0 ? h('a', { href: '#/overview', class: 'sum-problems' }, `⚠ ${problems} problem${problems === 1 ? '' : 's'} to fix`) : null,
      progressBar(store),
      r ? h('p', { class: 'muted small sum-note' }, 'Today’s money. Updates automatically as you edit.') : null,
      h('a', { href: '#/results', class: 'btn primary sum-cta' }, 'See full results →')];
    summary.replaceChildren(...parts.filter((p): p is Node => p !== null));
  }

  function renderNotices(s: AppState): void {
    notices.replaceChildren(...s.notices.map((n) => h('div', { class: `notice-bar ${n.kind}`, role: n.kind === 'error' ? 'alert' : 'status' },
      h('p', {}, n.text),
      n.id === 'defaults' ? h('a', { href: '#/rules', class: 'btn small' }, 'Review') : null,
      h('button', { type: 'button', class: 'btn small ghost', 'aria-label': 'Dismiss', onclick: () => store.dismissNotice(n.id) }, '✕'))));
  }

  /** Previous / next links at the foot of the input tabs, so the tabs read as steps. */
  function stepNav(t: TabId): HTMLElement | null {
    const i = TABS.findIndex((x) => x.id === t);
    if (t === 'overview' || t === 'results' || i < 0) return null;
    const prev = TABS[i - 1];
    const next = TABS[i + 1];
    return h('nav', { class: 'step-nav', 'aria-label': 'Steps' },
      prev ? h('a', { href: `#/${prev.id}`, class: 'btn' }, `← ${prev.label}`) : h('span'),
      next ? h('a', { href: `#/${next.id}`, class: `btn${next.id === 'results' ? ' primary' : ''}` }, `${next.id === 'results' ? 'See results' : `Next: ${next.label}`} →`) : null);
  }

  function renderPanel(): void {
    const ctx = { store, rerender };
    const views: Record<TabId, () => HTMLElement> = {
      overview: () => renderOverview(ctx), people: () => renderPeople(ctx), accounts: () => renderAccounts(ctx),
      contributions: () => renderContributions(ctx), property: () => renderProperty(ctx), spending: () => renderSpending(ctx),
      rules: () => renderConfigEditor(ctx), results: () => renderResults(ctx),
    };
    panel.replaceChildren(views[tab](), ...[stepNav(tab)].filter((x): x is HTMLElement => x !== null));
    showErrors(panel, allIssues(store.getState()));
  }

  /** Rebuild the current tab (after structural edits), keeping the scroll position. */
  function rerender(): void {
    const y = window.scrollY;
    renderPanel();
    window.scrollTo(0, y);
  }

  store.subscribe((s) => {
    trackDeltas(s);
    if (s.results && s.results !== last.results) announce.textContent = `Results updated: ${formatPct(s.results.successRate)} chance the money lasts.`;
    renderSummary(s);
    panel.querySelectorAll<HTMLElement>('.progress-slot').forEach((el) => el.replaceChildren(progressBar(store)));
    if (s.notices !== last.notices) renderNotices(s);
    showErrors(panel, allIssues(s));
    if (tab === 'rules') refreshModifiedDots(panel, store);
    const resultsChanged = s.results !== last.results || s.maxSpend !== last.maxSpend || s.status !== last.status;
    if (resultsChanged && (tab === 'results' || tab === 'overview')) rerender();
    last = s;
  });

  startRouter((t, anchor) => {
    const sameTab = t === tab && panel.childElementCount > 0;
    tab = t;
    nav.querySelectorAll<HTMLElement>('.tab').forEach((a) => {
      if (a.dataset.tab === t) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    nav.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Overview and Results show the full verdict themselves, so the summary would only repeat it.
    layout.classList.toggle('no-summary', t === 'results' || t === 'overview');
    document.title = `${TABS.find((x) => x.id === t)?.label ?? ''} · UK Retirement Planner`;
    if (!sameTab) renderPanel();
    const target = anchor ? document.getElementById(anchor) : null;
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (target) target.scrollIntoView({ block: 'start' }); else if (!sameTab) window.scrollTo(0, 0);
  });

  if (store.firstVisit) {
    store.addNotice({ id: 'welcome', kind: 'info', text: 'Welcome! You are looking at an example plan. Edit it tab by tab, or start from the simple template under Examples. Everything stays in this browser.' });
  }
  renderSummary(store.getState());
  renderNotices(store.getState());
  client.ping().then(() => store.runNow()).catch(() => store.addNotice({ id: 'worker', kind: 'error', text: 'The simulation worker could not start.' }));
  return store;
}
