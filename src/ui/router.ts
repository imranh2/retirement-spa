/** Hash routing only (#/overview etc.), so refresh and bookmarks work on any static host. */

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'people', label: 'People & Income' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'contributions', label: 'Contributions' },
  { id: 'property', label: 'Home & Property' },
  { id: 'spending', label: 'Spending & Strategy' },
  { id: 'rules', label: 'Rules & Assumptions' },
  { id: 'results', label: 'Results' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/** Tab for a hash such as '#/results'. Unknown or empty hashes fall back to Overview. */
export function tabFromHash(hash: string): TabId {
  const id = hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  return (TABS.find((t) => t.id === id)?.id ?? 'overview');
}

/** Optional element id after the tab, e.g. '#/overview/examples' -> 'examples'. */
export function anchorFromHash(hash: string): string | undefined {
  const part = hash.replace(/^#\/?/, '').split(/[?]/)[0].split('/')[1];
  return part ? part : undefined;
}

/** Call `onChange` with the current tab (and optional anchor) now and on every hashchange. Returns an unsubscribe. */
export function startRouter(onChange: (tab: TabId, anchor?: string) => void): () => void {
  const handler = () => onChange(tabFromHash(location.hash), anchorFromHash(location.hash));
  window.addEventListener('hashchange', handler);
  handler();
  return () => window.removeEventListener('hashchange', handler);
}
