/**
 * Web task channel K6: Rovara Code writes some of its sentences for a task that lives in a Slack thread ("in the task's Slack thread or on the task page", "in the thread").
 * A task started and kept on the web (a GitHub, Cloud or any other sign-in) has no thread, so the same sentence is shown with the ways that exist for it. A task that does have
 * a thread keeps Code's words exactly. Only these phrases are changed, each by its own rule; any other sentence is shown as Code wrote it. `tests/web/task-words.test.ts` reads every
 * one of Code's block reasons through this, so a new reason that names Slack or a thread cannot reach a task without one.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
 [/ \(in the task's Slack thread or on the task page\)/gu, " (on the task page)"],
 [/ in the thread\./gu, " on the task page."],
];
export function taskWords(text: string, hasThread: boolean): string {
 return hasThread ? text : RULES.reduce((words, [pattern, replacement]) => words.replace(pattern, replacement), text);
}
