/** Ephemeral UI state (which detail sheet is open, toasts). */
import { useSyncExternalStore } from 'react';
export type SheetRef = { type: 'task' | 'responsibility' | 'artifact' | 'memory' | 'assign'; id: string } | null;
let sheet: SheetRef = null;
const ls = new Set<() => void>();
export const openSheet = (s: SheetRef) => { sheet = s; ls.forEach((l) => l()); };
export const useSheet = () => useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, () => sheet);
