/** Small DOM helpers. No framework: elements are built directly and wired to the store. */

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;

/** Create an element. Attributes starting with `on` become listeners; booleans toggle attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

let idCounter = 0;
/** Unique DOM id with a readable prefix. */
export function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix.replace(/[^a-z0-9-]/gi, '-')}-${idCounter}`;
}

/** A button that asks for confirmation inline (no alert/confirm dialogs). */
export function confirmButton(label: string, confirmLabel: string, onConfirm: () => void, cls = 'btn'): HTMLElement {
  const wrap = h('span', { class: 'confirm-wrap' });
  const ask = h('button', { type: 'button', class: cls }, label);
  const render = (confirming: boolean) => {
    wrap.replaceChildren();
    if (!confirming) { wrap.append(ask); return; }
    const yes = h('button', { type: 'button', class: `${cls} danger`, onclick: () => { render(false); onConfirm(); } }, confirmLabel);
    const no = h('button', { type: 'button', class: 'btn ghost', onclick: () => { render(false); ask.focus(); } }, 'Cancel');
    wrap.append(h('span', { class: 'confirm-q' }, 'Are you sure?'), yes, no);
    yes.focus();
  };
  ask.addEventListener('click', () => render(true));
  render(false);
  return wrap;
}

/** Trigger a client-side download of text content (Blob + object URL, revoked after use). */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** An external link that opens safely in a new tab. */
export function extLink(href: string, text: string): HTMLAnchorElement {
  return h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
}

/** Show a transient status message in the live region. */
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const region = document.getElementById('toasts');
  if (!region) return;
  const TOAST_MS = 5000;
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
  region.append(t);
  setTimeout(() => t.remove(), TOAST_MS);
}
