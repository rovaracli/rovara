import { useRef } from "react";
import { ApiError } from "../../../api/errors.js";

/**
 * One request id per intent: it is kept while the outcome is unknown (a network failure, so a repeat is the same request and cannot be done twice) and dropped once the server has answered (a refusal, a stale
 * revision or a success), so the next press is a new request under whatever the page has read since. `get(key)` also drops it when the intent's key changes (a different option, say).
 */
export function useRequestId() {
 const ref = useRef<{ id: string; key: string } | undefined>(undefined);
 return {
  get: (key = ""): string => { if (ref.current === undefined || ref.current.key !== key) ref.current = { id: globalThis.crypto.randomUUID(), key };return ref.current.id; },
  reset: () => { ref.current = undefined; },
  settle: (error: unknown) => { if (!(error instanceof ApiError && error.status === 0)) ref.current = undefined; },
 };
}
/** What a refusal says, as the server said it (the API client keeps its text); a lost connection says so. */
export const failureText = (error: unknown): string => error instanceof ApiError ? error.message : "Couldn't complete this. Try again.";
/** "Not there for this person": a 404, or a 403 `TASK_ACCESS_DENIED` (the same answer in another coat). Wherever a screen hides on a 404 it hides on this too. */
export const isGone = (error: unknown): boolean => error instanceof ApiError && (error.status === 404 || (error.status === 403 && error.code === "TASK_ACCESS_DENIED"));

/**
 * Where focus goes when a dialog closes (WCAG 2.4.3): back to the control that opened it, on cancel and after a save alike. `remember` takes that control when the dialog is opened; `onCloseAutoFocus` is the Dialog's
 * hook for closing. If the opener is gone by then (a removed person's row, an approved decision's button) focus goes to `fallback`, a heading near where it was, so it never drops to the page.
 */
export function useRestoreFocus(fallback: () => HTMLElement | null) {
 const opener = useRef<HTMLElement | null>(null);
 return {
  remember: (element: Element | null) => { opener.current = element instanceof HTMLElement ? element : null; },
  onCloseAutoFocus: (event: Event) => { event.preventDefault();const element = opener.current, target = element !== null && element.isConnected ? element : fallback();target?.focus(); },
 };
}
/** The server's own words for a stale answer (each route has its own: the approvals switch, a decision, the roster), shown as they came; the roster's sentence only if none came. */
export const staleText = (error: unknown, fallback: string): string => error instanceof ApiError && error.message !== "" ? error.message : fallback;
