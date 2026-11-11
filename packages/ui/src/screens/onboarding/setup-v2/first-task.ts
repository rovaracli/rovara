// Project setup, last step: the first task. The suggestions are written from the repository names only (there is no broker read of repository facts yet: "needs broker"), the start goes through the same route
// as Home's and the project page's start box (`createCodeApi(...).startCode`), and a refusal keeps the server's words and gets a plain fix beside them.
import { ApiError } from "../../../api/errors.js";
import { CODE_TEXT_MAX } from "../../../api/code.js";

const shortName = (fullName: string): string => fullName.slice(fullName.lastIndexOf("/") + 1);

/** Two or three first outcomes a person can start with one press, from the repositories the project has (and its meta repo, which the first one writes to). */
export function suggestFirstOutcomes(repositories: readonly string[], metaRepository?: string): string[] {
 const names = repositories.map(shortName).filter((name, at, all) => name !== "" && all.indexOf(name) === at);
 if (names.length === 0) return [];
 const first = names[0]!, second = names[1];
 if (second === undefined) return [`Explain how ${first} is built and how to run its tests`, `Find the flakiest test in ${first} and say why it is flaky`, `List the riskiest out-of-date dependencies in ${first}`];
 const meta = metaRepository === undefined ? "" : ` and write a summary to ${shortName(metaRepository)}`;
 return [`Map how ${first} and ${second} work together${meta}`, `Find the flakiest test in ${first} and say why it is flaky`, `Explain how ${second} is built and how to run its tests`];
}

export type RefusalAction = "environment" | "close_tasks" | "project" | "retry";
export interface Refusal { reason: string; fix: string; action: RefusalAction }
/** What was refused and what to do about it: the server's own sentence stays the reason; the fix is ours, chosen from the fixed code (or what the sentence is about when the code is generic). */
export function refusalOf(failure: unknown): Refusal {
 if (!(failure instanceof ApiError)) return { reason: "Couldn't start this task.", fix: "Try again in a moment.", action: "retry" };
 const reason = failure.message, about = `${failure.code} ${failure.message}`;
 if (failure.code === "WORKSPACE_LIMIT") return { reason: "You have too many open tasks to start more work.", fix: "Close one of your open tasks, then start again.", action: "close_tasks" };
 if (failure.code === "PROCESS_UNAVAILABLE") return { reason, fix: "A maintainer can fix the project's way of working on its page.", action: "project" };
 if (failure.code === "FORBIDDEN" || failure.status === 403) return { reason, fix: "Ask one of the project's maintainers to start it, or to give you the right to start work.", action: "project" };
 if (/setup|environment|not ready/iu.test(about)) return { reason, fix: "Go back to the environment check, fix or retry the repository that needs action, then start again.", action: "environment" };
 if (/limit|budget|spend|stop|cap\b/iu.test(about)) return { reason, fix: "Ask an admin to raise the spending limit, or start a smaller task.", action: "project" };
 return { reason, fix: "Try again. If it keeps happening, start the task from the project page.", action: "retry" };
}

/** Whether the project may be asked to start work: its setup passed. Anything else is told first, with the way back, instead of a refusal after the press. */
export function firstTaskGate(status: string): { ok: true } | { ok: false; reason: string } {
 if (status === "ready") return { ok: true };
 if (status === "checking") return { ok: false, reason: "The environment check is still running. Wait for it to finish." };
 if (status === "failed") return { ok: false, reason: "The environment check failed, so a first task would fail on setup." };
 return { ok: false, reason: "The environment hasn't been checked since the last change." };
}
export const FIRST_TASK_MAX = CODE_TEXT_MAX;
