import { useSyncExternalStore } from 'react';
const ls = new Set<() => void>();
window.addEventListener('popstate', () => ls.forEach((l) => l()));
export function navigate(to: string) { if (location.pathname + location.search !== to) { history.pushState(null, '', to); ls.forEach((l) => l()); window.scrollTo({ top: 0 }); } }
export function useRoute() {
  const path = useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, () => location.pathname + location.search);
  const [p, qs] = path.split('?');
  return { path: p, parts: p.split('/').filter(Boolean), query: new URLSearchParams(qs ?? '') };
}
