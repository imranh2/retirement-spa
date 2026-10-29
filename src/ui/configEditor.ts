import type { ConfigBundle, FieldMeta, UpratedItem } from '../config/configTypes';
import { CONFIG_FIELDS, GROUPS, expandFields, fieldFor } from '../config/configFields';
import { getPath } from '../config/paths';
import { validateCorrelations } from '../config/configValidate';
import { historicalToCsv } from '../config/historicalCsv';
import { taxYearStartYear, taxYearStartYearOf, todayIso } from '../model/dates';
import type { Store } from './store';
import { h, confirmButton, extLink } from './dom';
import { numberField, textField, selectField, checkboxField, errorSlot, type InputUnit } from './fields';
import { formatMoney, formatPct, toPercentInput } from './format';

export interface ConfigCtx { store: Store; rerender: () => void }

let selectedYear: string | undefined;
/** Sections the user has expanded (kept across re-renders). The first section starts open. */
const openSections = new Set<string>(['Tax years']);

const UPRATED_LABEL: Record<UpratedItem, string> = {
  personalAllowance: 'Personal allowance (and taper threshold)', incomeTaxBands: 'Income tax bands', niThresholds: 'NI thresholds',
  savingsAndDividendAllowances: 'Savings and dividend allowances', cgtExempt: 'CGT annual exempt amount', isaAllowance: 'ISA and LISA allowances', pensionAllowances: 'Pension allowances (AA, MPAA, LSA)',
};
const SERIES = ['Equities', 'Bonds', 'Cash', 'Property', 'Inflation'];
const HISTORY_PREVIEW_ROWS = 8;

const cfgOf = (c: ConfigCtx): ConfigBundle => c.store.getState().config;

function sortedYears(cfg: ConfigBundle): string[] {
  return Object.keys(cfg.tax).sort((a, b) => taxYearStartYear(a) - taxYearStartYear(b));
}

/** Modified dot + per-field reset button, both shown only while the value differs from the default. */
function fieldExtras(c: ConfigCtx, path: string, meta: FieldMeta): HTMLElement {
  const modified = c.store.isModified(path);
  return h('span', { class: 'field-extras', 'data-modified-for': path, hidden: !modified },
    h('span', { class: 'modified-dot', title: 'Changed from the default' }, '●', h('span', { class: 'sr-only' }, ' modified')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Reset to default', 'aria-label': `Reset ${meta.label} to default`, onclick: () => { c.store.resetField(path); c.rerender(); } }, '↺'));
}

/** Source link and last-verified date, shown inside the field's help text. */
/** Readable names for enum values in the rules editor (anything missing is shown as it is). */
const OPTION_LABELS: Record<string, string> = {
  adjustedTripleLock: 'Adjusted triple lock (earnings link ends 2030)', tripleLock: 'Triple lock',
  inflation: 'Inflation', earnings: 'Earnings', fixed: 'Fixed rate', wageGrowth: 'Wage growth', none: 'None (stay frozen)',
  'england-wales-ni': 'England, Wales & NI', scotland: 'Scotland',
};

function sourceNote(meta: FieldMeta): HTMLElement | null {
  if (!meta.sourceUrl) return null;
  const site = new URL(meta.sourceUrl).hostname.replace(/^www\./, '');
  return h('span', { class: 'source-note' }, extLink(meta.sourceUrl, `Source (${site})`), meta.lastVerified ? `, checked ${meta.lastVerified}.` : '.');
}

/** Render one registry field at a concrete path. */
function configField(c: ConfigCtx, path: string, meta: FieldMeta = fieldFor(path) ?? CONFIG_FIELDS[0], labelOverride?: string): HTMLElement {
  const value = getPath(cfgOf(c), path);
  const base = { label: labelOverride ?? meta.label, errorPath: path, help: meta.tooltip, helpExtra: sourceNote(meta), extra: fieldExtras(c, path, meta), disabled: meta.readOnly };
  const set = (v: unknown) => c.store.setConfigValue(path, v);
  if (meta.unit === 'enum' && meta.options) {
    return selectField({ ...base, value: String(value), options: meta.options.map((o) => ({ value: o, label: OPTION_LABELS[o] ?? o })), onChange: set });
  }
  if (meta.unit === 'date') return textField({ ...base, value: String(value ?? ''), onChange: set, placeholder: path.includes('Year') || path.includes('TaxYear') ? 'e.g. 2030/31' : 'yyyy-mm-dd' });
  if (meta.unit === 'bool') return checkboxField({ ...base, checked: value === true, onChange: set });
  const unit: InputUnit = meta.unit === 'pct' ? 'pct' : meta.unit === 'gbp' ? 'gbp' : meta.unit === 'age' ? 'age' : meta.unit === 'years' ? 'years' : meta.unit === 'weeks' ? 'weeks' : 'count';
  return numberField({ ...base, unit, value: typeof value === 'number' ? value : null, nullable: meta.nullable, min: meta.min, max: meta.max, step: meta.step, placeholder: meta.nullable ? 'no limit' : undefined, onChange: (v) => set(v === null ? (meta.nullable ? null : 0) : v) });
}

/** Paths reset by a section's "Reset section" button (array element paths collapse to the array). */
function sectionPaths(cfg: ConfigBundle, group: string, year: string): string[] {
  const paths = expandFields(cfg)
    .filter((f) => f.group === group && !f.readOnly && (!f.path.startsWith('tax.') || f.path.startsWith(`tax.${year}.`)))
    .map((f) => f.path.replace(/\[\d+\].*$/, ''));
  if (group === 'Historical returns') paths.push('historicalReturns');
  return [...new Set(paths)];
}

const sectionId = (group: string) => `sec-${group.replace(/[^a-z]/gi, '').toLowerCase()}`;

/** A collapsible section. Its summary says how many values differ from the defaults. */
function section(c: ConfigCtx, group: string, year: string, body: Node[]): HTMLElement {
  const cfg = cfgOf(c);
  const paths = sectionPaths(cfg, group, year);
  const id = sectionId(group);
  const changed = paths.filter((p) => c.store.isModified(p)).length;
  const problems = c.store.getState().errors.filter((e) => paths.some((p) => e.path === p || e.path.startsWith(`${p}.`) || e.path.startsWith(`${p}[`))).length;
  const details = h('details', { class: 'panel-section config-section', id, open: openSections.has(group) || problems > 0 },
    h('summary', {}, h('h3', {}, group),
      changed > 0 ? h('span', { class: 'changed-count' }, `● ${changed} changed`) : null,
      problems > 0 ? h('span', { class: 'problem-count' }, `⚠ ${problems} to check`) : null),
    h('div', { class: 'section-head' }, h('span'),
      paths.length > 0 ? confirmButton('Reset section', `Reset ${group}`, () => { c.store.resetSection(paths); c.rerender(); }, 'btn small') : null),
    ...body);
  details.addEventListener('toggle', () => { if (details.open) openSections.add(group); else openSections.delete(group); });
  return details;
}

function scalarFields(c: ConfigCtx, group: string, year: string): HTMLElement {
  const fields = expandFields(cfgOf(c)).filter((f) => f.group === group && !f.path.includes('[') && f.path !== 'taxProjection.upratedItems'
    && (!f.path.startsWith('tax.') || f.path.startsWith(`tax.${year}.`)));
  return h('div', { class: 'grid' }, ...fields.map((f) => configField(c, f.path, f)));
}

function bandsEditor(c: ConfigCtx, year: string): HTMLElement {
  const bands = cfgOf(c).tax[year].incomeTaxBands;
  const path = `tax.${year}.incomeTaxBands`;
  const names = ['Basic', 'Higher', 'Additional'];
  const rows = bands.map((b, i) => h('tr', {},
    h('th', { scope: 'row' }, names[i] ?? `Band ${i + 1}`),
    h('td', {}, configField(c, `${path}[${i}].upTo`, undefined, i === bands.length - 1 ? 'Top (blank = no limit)' : 'Top of band')),
    h('td', {}, configField(c, `${path}[${i}].rate`, undefined, 'Rate')),
    h('td', {}, bands.length > 1 ? h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove band ${i + 1}`, onclick: () => { c.store.setConfigValue(path, bands.filter((_, k) => k !== i)); c.rerender(); } }, 'Remove') : null)));
  const addBand = () => {
    const next = [...bands];
    const prevTop = next.length >= 2 ? next[next.length - 2].upTo ?? 0 : 0;
    next.splice(Math.max(0, next.length - 1), 0, { upTo: prevTop + 50000, rate: next[next.length - 1]?.rate ?? 0.4 });
    c.store.setConfigValue(path, next);
    c.rerender();
  };
  return h('div', {}, h('h4', {}, 'Income tax bands'),
    h('p', { class: 'muted' }, 'Tops are measured in taxable income (after the personal allowance). Bands must ascend and the last band has no limit.'),
    errorSlot(path),
    h('div', { class: 'table-wrap' }, h('table', { class: 'editor-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Band'), h('th', {}, 'Top'), h('th', {}, 'Rate'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))), h('tbody', {}, ...rows))),
    h('button', { type: 'button', class: 'btn small', onclick: addBand }, 'Add band'));
}

function scheduleEditor(c: ConfigCtx): HTMLElement {
  const rows = cfgOf(c).statePension.ageSchedule;
  const path = 'statePension.ageSchedule';
  return h('div', {}, h('h4', {}, 'State Pension age by date of birth'),
    errorSlot(path),
    h('div', { class: 'table-wrap' }, h('table', { class: 'editor-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Born on or after'), h('th', {}, 'Years'), h('th', {}, 'Months'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, ...rows.map((_, i) => h('tr', {},
        h('td', {}, configField(c, `${path}[${i}].bornOnOrAfter`, undefined, 'Date')),
        h('td', {}, configField(c, `${path}[${i}].ageYears`, undefined, 'Years')),
        h('td', {}, configField(c, `${path}[${i}].ageMonths`, undefined, 'Months')),
        h('td', {}, rows.length > 1 ? h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove row ${i + 1}`, onclick: () => { c.store.setConfigValue(path, rows.filter((_, k) => k !== i)); c.rerender(); } }, 'Remove') : null)))))),
    h('button', { type: 'button', class: 'btn small', onclick: () => { const last = rows[rows.length - 1]; c.store.setConfigValue(path, [...rows, { bornOnOrAfter: last ? `${Number(last.bornOnOrAfter.slice(0, 4)) + 1}${last.bornOnOrAfter.slice(4)}` : '1980-01-01', ageYears: last?.ageYears ?? 68, ageMonths: 0 }]); c.rerender(); } }, 'Add row'));
}

function correlationEditor(c: ConfigCtx): HTMLElement {
  const m = cfgOf(c).market.correlations;
  const warn = h('p', { class: 'warning', id: 'corr-warning', role: 'status' });
  const refreshWarn = () => {
    const issues = validateCorrelations(cfgOf(c).market.correlations);
    warn.textContent = issues.map((i) => i.message).join(' ');
    warn.hidden = issues.length === 0;
  };
  const cells = (i: number) => SERIES.map((_, j) => {
    if (i === j) return h('td', { class: 'diag' }, '1');
    const id = `corr-${i}-${j}`;
    const input = h('input', { id, type: 'number', min: -1, max: 1, step: 0.05, value: String(m[i][j]), 'aria-label': `Correlation ${SERIES[i]} / ${SERIES[j]}` });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value === '' || !Number.isFinite(v)) return;
      c.store.setCorrelation(i, j, v);
      const mirror = document.getElementById(`corr-${j}-${i}`) as HTMLInputElement | null;
      if (mirror) mirror.value = input.value;
      refreshWarn();
    });
    return h('td', {}, input);
  });
  refreshWarn();
  return h('div', {}, h('h4', {}, 'Correlations'),
    h('p', { class: 'muted' }, 'Editing one cell updates its mirror so the matrix stays symmetric. The diagonal is fixed at 1.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'matrix' },
      h('thead', {}, h('tr', {}, h('th', {}, h('span', { class: 'sr-only' }, 'Series')), ...SERIES.map((s) => h('th', { scope: 'col' }, s)))),
      h('tbody', {}, ...SERIES.map((s, i) => h('tr', {}, h('th', { scope: 'row' }, s), ...cells(i)))))),
    warn);
}

function historicalEditor(c: ConfigCtx): HTMLElement {
  const rows = cfgOf(c).historicalReturns;
  const area = h('textarea', { id: 'hist-csv', rows: 8, spellcheck: 'false', 'aria-describedby': 'hist-help', placeholder: 'year,equities,bonds,cash,property,inflation\n1990,0.10,0.05,0.04,0.02,0.03' }, rows.length > 0 ? historicalToCsv(rows) : '');
  const report = h('div', { 'aria-live': 'polite' });
  const preview = (data: typeof rows) => data.length === 0 ? h('p', { class: 'muted' }, 'No historical data loaded. The bootstrap return model needs at least 10 years.')
    : h('div', {}, h('p', {}, `${data.length} years loaded (${data[0].year}–${data[data.length - 1].year}).`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, ...['Year', 'Equities', 'Bonds', 'Cash', 'Property', 'Inflation'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, ...data.slice(0, HISTORY_PREVIEW_ROWS).map((r) => h('tr', {}, h('td', {}, String(r.year)), ...[r.equities, r.bonds, r.cash, r.property, r.inflation].map((v) => h('td', {}, formatPct(v)))))))),
      data.length > HISTORY_PREVIEW_ROWS ? h('p', { class: 'muted' }, `…and ${data.length - HISTORY_PREVIEW_ROWS} more rows.`) : null);
  report.append(preview(rows));
  const importBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => {
    const res = c.store.importHistoricalCsv(area.value);
    report.replaceChildren();
    if (res.errors.length > 0) {
      report.append(h('p', { class: 'error' }, `Not imported: ${res.errors.length} line${res.errors.length === 1 ? '' : 's'} need fixing.`),
        h('ul', { class: 'error-list' }, ...res.errors.map((e) => h('li', {}, `Line ${e.line}: ${e.message}`))), preview(res.rows));
    } else {
      report.append(h('p', { class: 'ok' }, 'Imported.'), preview(res.rows));
    }
  } }, 'Import CSV');
  return h('div', {},
    h('label', { for: 'hist-csv' }, 'Paste CSV'),
    h('p', { class: 'help', id: 'hist-help' }, 'Columns: year, equities, bonds, cash, property, inflation. Values are NOMINAL annual returns as decimals (0.07 = 7%); inflation as a decimal. No data is shipped with the app.'),
    area, h('div', { class: 'row-btns' }, importBtn,
      rows.length > 0 ? confirmButton('Clear data', 'Clear historical data', () => { c.store.setConfigValue('historicalReturns', []); c.rerender(); }, 'btn') : null),
    report);
}

function upratedItemsEditor(c: ConfigCtx): HTMLElement {
  const cur = new Set(cfgOf(c).taxProjection.upratedItems);
  const meta = fieldFor('taxProjection.upratedItems');
  return h('fieldset', { class: 'full' }, h('legend', {}, 'Thresholds that grow after the freeze', meta ? fieldExtras(c, 'taxProjection.upratedItems', meta) : null),
    ...(Object.keys(UPRATED_LABEL) as UpratedItem[]).map((k) => checkboxField({ label: UPRATED_LABEL[k], checked: cur.has(k), onChange: (on) => {
      const next = new Set(cfgOf(c).taxProjection.upratedItems);
      if (on) next.add(k); else next.delete(k);
      c.store.setConfigValue('taxProjection.upratedItems', (Object.keys(UPRATED_LABEL) as UpratedItem[]).filter((x) => next.has(x)));
    } })));
}

function defaultsBanner(c: ConfigCtx): HTMLElement | null {
  const diff = c.store.getDefaultsUpdateDiff();
  if (diff.length === 0) return null;
  const ASSETS = ['equities', 'bonds', 'cash', 'property', 'inflation'];
  const corr = (path: string) => /^market\.correlations\[(\d+)\]\[(\d+)\]$/.exec(path);
  /** A value as the rules editor would show it: 2%, £12,570, "Triple lock"; a whole new tax year by name. */
  const show = (v: unknown, path: string): string => {
    if (v === undefined || v === null) return '—';
    const meta = fieldFor(path);
    if (typeof v === 'number') return meta?.unit === 'pct' ? `${toPercentInput(v)}%` : meta?.unit === 'gbp' ? formatMoney(v) : String(v);
    if (typeof v === 'string') return OPTION_LABELS[v] ?? v;
    if (/^tax\.[^.]+$/.test(path)) return `${path.slice('tax.'.length)} rules`;
    // Lists of choices (e.g. which thresholds grow after the freeze): their names, or "None".
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return v.length === 0 ? 'None' : v.map((x: string) => UPRATED_LABEL[x as UpratedItem] ?? OPTION_LABELS[x] ?? x).join(', ');
    }
    return JSON.stringify(v);
  };
  const label = (path: string) => {
    const m = corr(path);
    if (m) return `Correlation: ${ASSETS[Number(m[1])]} and ${ASSETS[Number(m[2])]}`;
    if (/^tax\.[^.]+$/.test(path)) return `New tax year ${path.slice('tax.'.length)}`;
    return fieldFor(path)?.label ?? path;
  };
  // A correlation appears twice (i,j and j,i); list it once, and accepting it updates both.
  const rows = diff.filter((d) => { const m = corr(d.path); return !m || Number(m[1]) < Number(m[2]); });
  return h('section', { class: 'banner info', 'aria-labelledby': 'defaults-banner-title' },
    h('h3', { id: 'defaults-banner-title' }, `New defaults available (${c.store.getState().config.defaultsVersion} → current)`),
    h('p', {}, 'The app ships updated values for these fields. Your values are kept unless you accept the new one.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Yours'), h('th', {}, 'Old default'), h('th', {}, 'New default'), h('th', {}, h('span', { class: 'sr-only' }, 'Actions')))),
      h('tbody', {}, ...rows.map((d) => h('tr', {},
        h('td', {}, label(d.path), h('br'), h('code', {}, d.path)),
        h('td', {}, show(d.yours, d.path)), h('td', {}, show(d.oldDefault, d.path)), h('td', {}, show(d.newDefault, d.path)),
        h('td', { class: 'row-btns' },
          h('button', { type: 'button', class: 'btn small primary', onclick: () => { c.store.acceptDefault(d.path); c.rerender(); } }, 'Accept new'),
          h('button', { type: 'button', class: 'btn small', onclick: () => { c.store.keepMine(d.path); c.rerender(); } }, 'Keep mine'))))))));
}

export function renderConfigEditor(c: ConfigCtx): HTMLElement {
  const cfg = cfgOf(c);
  const years = sortedYears(cfg);
  // Open on the tax year in force now (the latest that has started), not a future one.
  const thisYear = taxYearStartYearOf(todayIso());
  if (!selectedYear || !cfg.tax[selectedYear]) selectedYear = [...years].reverse().find((y) => taxYearStartYear(y) <= thisYear) ?? years[0];
  const year = selectedYear;

  const yearPicker = h('div', { class: 'year-picker' },
    selectField({ label: 'Tax year being edited', value: year, options: years.map((y) => ({ value: y, label: y })), help: 'Years after the last one you define reuse its rules, with thresholds uprated after the freeze (see Tax projection).', onChange: (v) => { selectedYear = v; c.rerender(); } }),
    h('div', { class: 'row-btns' },
      h('button', { type: 'button', class: 'btn', onclick: () => { selectedYear = c.store.addTaxYear(year); c.rerender(); } }, `Add tax year (clone ${year})`),
      years.length > 1 ? confirmButton(`Remove ${year}`, `Remove ${year}`, () => { c.store.removeTaxYear(year); selectedYear = undefined; c.rerender(); }, 'btn') : null));

  const body: Record<string, Node[]> = {
    'Tax years': [yearPicker, scalarFields(c, 'Tax years', year), bandsEditor(c, year)],
    'Savings & dividends': [scalarFields(c, 'Savings & dividends', year)],
    'National Insurance': [scalarFields(c, 'National Insurance', year)],
    'Capital gains': [scalarFields(c, 'Capital gains', year)],
    'ISA & LISA': [scalarFields(c, 'ISA & LISA', year)],
    'Pensions': [scalarFields(c, 'Pensions', year)],
    'State Pension': [scalarFields(c, 'State Pension', year), scheduleEditor(c)],
    'Market assumptions': [h('p', { class: 'muted' }, 'Editable assumptions, not predictions. Returns are arithmetic means above inflation.'), scalarFields(c, 'Market assumptions', year), correlationEditor(c)],
    'Historical returns': [historicalEditor(c)],
    'Tax projection': [scalarFields(c, 'Tax projection', year), upratedItemsEditor(c)],
  };

  return h('div', { class: 'config-editor' },
    h('section', { class: 'panel-section' },
      h('h2', {}, 'Rules & Assumptions'),
      h('p', { class: 'notice' }, `Defaults reflect UK rules as of ${cfg.defaultsVersion}. Check gov.uk and edit anything that has changed.`),
      h('p', { class: 'muted' }, 'Every rate, threshold, allowance and assumption used by the model is here. Changed values show a ● with a ↺ reset button; sections and everything can be reset too. Open a field’s ? for an explanation and its gov.uk source.'),
      h('nav', { class: 'section-nav', 'aria-label': 'Sections' }, ...GROUPS.map((g) => h('a', { href: `#/rules/${sectionId(g)}`, onclick: (e: Event) => {
        e.preventDefault();
        const el = document.getElementById(sectionId(g)) as HTMLDetailsElement | null;
        if (el) { el.open = true; el.scrollIntoView({ block: 'start' }); }
      } }, g))),
      h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn', onclick: () => { GROUPS.forEach((g) => openSections.add(g)); c.rerender(); } }, 'Expand all'),
        h('button', { type: 'button', class: 'btn', onclick: () => { openSections.clear(); c.rerender(); } }, 'Collapse all'),
        confirmButton('Reset all to defaults', 'Reset everything', () => { c.store.resetAll(); c.rerender(); }, 'btn'))),
    defaultsBanner(c),
    ...GROUPS.map((g) => section(c, g, year, body[g] ?? [])));
}

/** Refresh modified dots after edits without re-rendering inputs. */
export function refreshModifiedDots(root: ParentNode, store: Store): void {
  root.querySelectorAll<HTMLElement>('[data-modified-for]').forEach((el) => {
    el.hidden = !store.isModified(el.dataset.modifiedFor ?? '');
  });
}
