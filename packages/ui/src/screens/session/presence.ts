import { useSyncExternalStore } from "react";
const subscribe = (listener: () => void) => { document.addEventListener("visibilitychange", listener);return () => document.removeEventListener("visibilitychange", listener); };
const snapshot = () => document.visibilityState !== "hidden";
export function usePageVisible(): boolean { return useSyncExternalStore(subscribe, snapshot, () => false); }
