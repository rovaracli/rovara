import { useMemo, useSyncExternalStore } from "react";
import { useAppHost } from "../../host.js";
/** The shell turns into its phone layout below 768px (shell.css). The directory and profile follow the same line. */
export const PHONE_MAX_WIDTH = 767;
/** True on a phone-width window. A host that cannot say how wide the window is is treated as a large screen. */
export function useIsPhone(): boolean {
 const host = useAppHost();
 const store = useMemo(() => ({ subscribe: (listener: () => void) => host.viewport?.subscribe(listener) ?? (() => undefined), snapshot: () => { const width = host.viewport?.width() ?? 0;return width > 0 && width <= PHONE_MAX_WIDTH; } }), [host]);
 return useSyncExternalStore(store.subscribe, store.snapshot, () => false);
}
/** Building and publishing stay on a larger screen (owner decision 25). Reading and running an agent do not. */
export function DesktopBuilderNote({ text = "Building agents works best on a larger screen." }: { text?: string }) {
 return useIsPhone() ? <p className="rv-muted rv-agent-desktop-note" role="note">{text}</p> : null;
}
