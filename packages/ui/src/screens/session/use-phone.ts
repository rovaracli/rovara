import { useSyncExternalStore } from "react";
/** The phone layout of the task page (480px and narrower, owner decision 40). Matches the CSS breakpoint; false where `matchMedia` does not exist (a test DOM). */
export const PHONE_QUERY = "(max-width: 480px)";
const media = (): MediaQueryList | undefined => { try { return typeof window === "undefined" || typeof window.matchMedia !== "function" ? undefined : window.matchMedia(PHONE_QUERY); } catch { return undefined; } };
const subscribe = (changed: () => void): (() => void) => { const list = media();list?.addEventListener?.("change", changed);return () => list?.removeEventListener?.("change", changed); };
export function useIsPhone(): boolean { return useSyncExternalStore(subscribe, () => media()?.matches === true, () => false); }
