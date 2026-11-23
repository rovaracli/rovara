import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * While a person's own write is reading the page back, the page stays on screen. Without this a refused write
 * re-reads the scope, the read state shows "Loading" and the open form (with the refusal sentence) unmounts.
 * The hold lets go one tick after the read ends (the read library publishes its new state on a timer). Only our own post-write refresh holds; any other refresh still hides the earlier read until it is confirmed.
 */
export interface Hold { held: () => boolean; subscribe: (listener: () => void) => () => void; acquire: () => () => void }
export function createHold(): Hold {
 let count = 0; const listeners = new Set<() => void>();
 const emit = () => { for (const listener of [...listeners]) listener(); };
 return { held: () => count > 0, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, acquire: () => { count += 1; emit(); let released = false; return () => { if (released) return; released = true; /* the read library tells the screen its new state one tick after the read ends: let go after that, or one frame shows "reading" without the hold */ setTimeout(() => { count -= 1; emit(); }, 0); }; } };
}
export const HoldContext = createContext<Hold | undefined>(undefined);
const none = () => () => undefined;
export function useHolding(): boolean {
 const hold = useContext(HoldContext);
 return useSyncExternalStore(hold === undefined ? none : hold.subscribe, () => hold !== undefined && hold.held(), () => false);
}
/** Reads this scope's pages again after a write, holding the page open while it does. Never throws. */
export function useRefreshScope(scopeKey: readonly (string | number)[]) {
 const client = useQueryClient(), hold = useContext(HoldContext);
 return useCallback(async () => {
  const release = hold?.acquire();
  try { await client.invalidateQueries({ queryKey: scopeKey }); } catch { /* a failed read shows its own state */ } finally { release?.(); }
 }, [client, hold, scopeKey]);
}
