import { h, uid } from './dom';
import { toPercentInput } from './format';

/** Units a numeric input can show. pct values are fractions stored, percentages shown. */
export type InputUnit = 'gbp' | 'gbpMonth' | 'pct' | 'age' | 'years' | 'count' | 'weeks';

const UNIT_LABEL: Record<InputUnit, string> = {
  gbp: '£', gbpMonth: '£ per month', pct: '%', age: 'age', years: 'years', count: '', weeks: 'weeks',
};

export interface FieldBase {
  label: string;
  /** Path used to show inline validation errors (data-error-for). */
  errorPath?: string;
  help?: string;
  /** Appended to the help text, e.g. a source link (shown when help is opened). */
  helpExtra?: Node | null;
  extra?: Node | null;          // e.g. source link, modified dot, reset button
  disabled?: boolean;
}

export interface NumberFieldOpts extends FieldBase {
  unit: InputUnit;
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  min?: number; max?: number; step?: number;
  nullable?: boolean;           // empty input means null/undefined
  placeholder?: string;
}

/** Wrap an input with label, unit, help toggle and an inline error slot. */
function wrap(id: string, opts: FieldBase, control: HTMLElement, unitText = ''): HTMLElement {
  const helpId = opts.help ? `${id}-help` : undefined;
  const errId = `${id}-err`;
  const described = [helpId, errId].filter(Boolean).join(' ');
  control.setAttribute('aria-describedby', described);
  const label = h('label', { for: id }, opts.label, unitText ? h('span', { class: 'unit' }, ` (${unitText})`) : null);
  const head = h('div', { class: 'field-head' }, label);
  let helpEl: HTMLElement | null = null;
  if (opts.help && helpId) {
    helpEl = h('p', { class: 'help', id: helpId, hidden: true }, opts.help, opts.helpExtra ? ' ' : null, opts.helpExtra ?? null);
    const btn = h('button', { type: 'button', class: 'help-btn', 'aria-expanded': 'false', 'aria-controls': helpId, title: opts.help, 'aria-label': `Help: ${opts.label}` }, '?');
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      btn.setAttribute('aria-expanded', String(open));
      if (helpEl) helpEl.hidden = !open;
    });
    head.append(btn);
  }
  if (opts.extra) head.append(opts.extra);
  const err = h('p', { class: 'error', id: errId, 'data-error-for': opts.errorPath ?? '' });
  return h('div', { class: 'field' }, head, control, helpEl, err);
}

const grouped = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/**
 * Numeric input. Percent units display x100. Money units are text inputs showing
 * thousands separators (450,000), which accept "£450,000" or "450000" when typed.
 * Empty input sets null when nullable, else shows an error.
 */
export function numberField(o: NumberFieldOpts): HTMLElement {
  const id = uid(o.errorPath ?? o.label);
  const isPct = o.unit === 'pct';
  const isMoney = o.unit === 'gbp' || o.unit === 'gbpMonth';
  const display = (v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '';
    return isMoney ? grouped.format(v) : String(isPct ? toPercentInput(v) : v);
  };
  const input = isMoney
    ? h('input', { id, type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'money', value: display(o.value), disabled: o.disabled, placeholder: o.placeholder })
    : h('input', {
      id, type: 'number', inputmode: 'decimal', value: display(o.value), disabled: o.disabled,
      min: o.min !== undefined ? (isPct ? toPercentInput(o.min) : o.min) : undefined,
      max: o.max !== undefined ? (isPct ? toPercentInput(o.max) : o.max) : undefined,
      step: o.step !== undefined ? (isPct ? toPercentInput(o.step) : o.step) : 'any',
      placeholder: o.placeholder,
    });
  const el = wrap(id, o, input, UNIT_LABEL[o.unit]);
  // Its own slot: the shared error slot is rewritten by plan validation, which would hide this message.
  const localErr = h('p', { class: 'error local-error', 'aria-live': 'polite' });
  el.querySelector('.error')?.before(localErr);
  const setLocalError = (msg: string) => {
    localErr.textContent = msg;
    if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  };
  const parse = (raw: string): number => Number(isMoney ? raw.replace(/[£,\s]/g, '') : raw);
  input.addEventListener('input', () => {
    const raw = input.value.trim();
    if (raw === '') {
      if (o.nullable) { setLocalError(''); o.onChange(null); }
      else setLocalError('Enter a number, or 0');
      return;
    }
    const n = parse(raw);
    if (!Number.isFinite(n)) { setLocalError(isMoney ? 'Enter an amount in pounds, e.g. 60000' : 'Enter a number'); return; }
    setLocalError('');
    o.onChange(isPct ? n / 100 : n);
  });
  if (isMoney) {
    input.addEventListener('blur', () => {
      const n = parse(input.value.trim());
      if (input.value.trim() !== '' && Number.isFinite(n)) input.value = display(n);
    });
  }
  return el;
}

export interface TextFieldOpts extends FieldBase {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'date';
  pattern?: string;
  placeholder?: string;
}

export function textField(o: TextFieldOpts): HTMLElement {
  const id = uid(o.errorPath ?? o.label);
  const input = h('input', { id, type: o.type ?? 'text', value: o.value, pattern: o.pattern, placeholder: o.placeholder, disabled: o.disabled });
  input.addEventListener(o.type === 'date' ? 'change' : 'input', () => o.onChange(input.value));
  return wrap(id, o, input);
}

export interface SelectFieldOpts<T extends string> extends FieldBase {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}

export function selectField<T extends string>(o: SelectFieldOpts<T>): HTMLElement {
  const id = uid(o.errorPath ?? o.label);
  const sel = h('select', { id, disabled: o.disabled },
    ...o.options.map((opt) => h('option', { value: opt.value, selected: opt.value === o.value, disabled: opt.disabled }, opt.label)));
  sel.addEventListener('change', () => o.onChange(sel.value as T));
  return wrap(id, o, sel);
}

export interface CheckboxOpts extends FieldBase {
  checked: boolean;
  onChange: (v: boolean) => void;
}

export function checkboxField(o: CheckboxOpts): HTMLElement {
  const id = uid(o.errorPath ?? o.label);
  const box = h('input', { id, type: 'checkbox', checked: o.checked, disabled: o.disabled });
  box.addEventListener('change', () => o.onChange(box.checked));
  const err = h('p', { class: 'error', id: `${id}-err`, 'data-error-for': o.errorPath ?? '' });
  const helpId = o.help ? `${id}-help` : undefined;
  box.setAttribute('aria-describedby', [helpId, `${id}-err`].filter(Boolean).join(' '));
  let helpEl: HTMLElement | null = null;
  let btn: HTMLElement | null = null;
  if (o.help && helpId) {
    helpEl = h('p', { class: 'help', id: helpId, hidden: true }, o.help, o.helpExtra ? ' ' : null, o.helpExtra ?? null);
    btn = h('button', { type: 'button', class: 'help-btn', 'aria-expanded': 'false', 'aria-controls': helpId, title: o.help, 'aria-label': `Help: ${o.label}` }, '?');
    btn.addEventListener('click', () => {
      const open = btn?.getAttribute('aria-expanded') !== 'true';
      btn?.setAttribute('aria-expanded', String(open));
      if (helpEl) helpEl.hidden = !open;
    });
  }
  return h('div', { class: 'field check' }, h('div', { class: 'field-head' }, h('label', { for: id }, box, ` ${o.label}`), btn), helpEl, o.extra ?? null, err);
}

/** Error slot not attached to a single input (e.g. list-level errors). */
export function errorSlot(path: string): HTMLElement {
  return h('p', { class: 'error', 'data-error-for': path, 'aria-live': 'polite' });
}

/** Update every [data-error-for] element under `root` from a path -> messages map. Prefix matches roll up. */
export function showErrors(root: ParentNode, issues: { path: string; message: string; severity?: string }[]): void {
  const byPath = new Map<string, string[]>();
  for (const i of issues) byPath.set(i.path, [...(byPath.get(i.path) ?? []), i.message]);
  root.querySelectorAll<HTMLElement>('[data-error-for]').forEach((el) => {
    const p = el.dataset.errorFor ?? '';
    if (p === '') return;
    const msgs = byPath.get(p) ?? [];
    el.textContent = msgs.join(' ');
    const input = el.parentElement?.querySelector('input, select, textarea');
    if (input) {
      if (msgs.length > 0) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  });
}
