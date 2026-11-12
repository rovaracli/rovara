// exp/automations: where focus goes when a dialog opened by a button closes (WCAG 2.4.3). The shared Dialog has no trigger element when it is controlled, so Radix leaves focus on the page's body;
// this puts it back on the button that opened it, or, when that button is gone (the change removed it), on a fallback the page names (a heading or section with tabIndex -1).
import { useCallback, useRef } from "react";

/** `fallbackElement` is where focus goes when the opening button is gone (a heading or section with tabIndex -1, kept by the page in state through its `ref`). */
export function useReturnFocus(fallbackElement: HTMLElement | null = null) {
  const opener = useRef<HTMLElement | null>(null);
  /** Put on the opening button's onClick: remembers which button asked. */
  const remember = useCallback((event: { currentTarget: HTMLElement }) => { opener.current = event.currentTarget; }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault();
    const target = opener.current;
    if (target !== null && target.isConnected && !(target instanceof HTMLButtonElement && target.disabled)) target.focus();
    else fallbackElement?.focus();
  }, [fallbackElement]);
  /** After a change that removed the opening button (the list has refreshed): if focus was lost to the page, it goes to the fallback. */
  const rescue = useCallback(() => { const active = document.activeElement; if (active === null || active === document.body) fallbackElement?.focus(); }, [fallbackElement]);
  return { remember, onCloseAutoFocus, rescue };
}
