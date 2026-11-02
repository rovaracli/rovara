// The fixed words of the project's known-failing list. A test id, a check and a person's name come from the server and are shown as text, never as markup.
export const KF = {
 HEADING: "Tests marked as already failing",
 HELP: "A test on this list that fails on a change is not held against the change; the result says it was already failing. Undo a mark when the test should count again.",
 LOADING: "Loading the marked tests", LOAD_FAILED: "Couldn't load the marked tests. Try again.", TRY_AGAIN: "Try again",
 NONE: "No test is marked as already failing.",
 UNDO: "Undo", UNDONE: "Mark removed. That test counts again.",
 CHANGED: "That mark was already removed or changed. The list was read again.",
 FAILED: "Couldn't remove the mark. Try again.",
 FULL: "This list is full. Undo marks that are no longer needed before marking more.",
 NIGHTLY: "Once nightly runs are on, a mark also goes away by itself after a nightly run shows the test passing.",
 SHOW_ALL: "Show all", SHOW_FEWER: "Show fewer",
} as const;
export const SHOWN_AT_FIRST = 20;
export const countText = (count: number, max: number): string => `${String(count)} of ${String(max)} marked`;
export const markedText = (who: string, you: boolean, day: string): string => `Marked by ${you ? "you" : who} on ${day}`;
