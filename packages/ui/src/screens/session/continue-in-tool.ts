import { isClosedTask, sessionDisplay, type ReadSession } from "./SessionHeader.js";
import { workspaceTask } from "./workspace-types.js";
import { CHANGED_OUTSIDE, type ContinueLoop } from "./continue-outside.js";
/**
 * What the "Continue in your own tool" panel says, as plain functions (no React, no reads). Everything here comes from what exists today: the CLI's `mcp install` command
 * (packages/cli/src/mcp/install.ts, docs/mcp-install.md), the MCP tools `agentx_get_task` and `agentx_get_plan`, and the task view's own fields.
 */
export type ToolKind = "claude-code" | "codex" | "cursor";
/** The published CLI's package name (`DEFAULT_CLI_PACKAGE_NAME` in Rovara Code's contracts; a test keeps the two equal). The web app does not import the contracts package for one string. */
export const CLI_PACKAGE = "@preplabsai/rovara-code";
export const TOOLS: readonly { kind: ToolKind; label: string; where: string }[] = [
 { kind: "claude-code", label: "Claude Code", where: "Rovara runs claude mcp add for you, once, for your user." },
 { kind: "codex", label: "Codex", where: "Rovara adds an entry to ~/.codex/config.toml and keeps a backup if there was one." },
 { kind: "cursor", label: "Cursor", where: "Rovara adds an entry to ~/.cursor/mcp.json and keeps a backup if there was one." },
];
export const installCommand = (tool: ToolKind): string => "npx " + CLI_PACKAGE + " mcp install --client " + tool;
/** The tools the prompt tells the person's AI tool to call: both exist in Rovara's MCP server today. */
export const LOAD_TOOLS = ["agentx_get_task", "agentx_get_plan"] as const;
export const LESSONS_TOOL = "rovara_lessons";
export const NO_BRANCH_YET = "The branch appears once Rovara opens the pull request.";
/** A repository with no branch yet, for a reader who may publish one. */
export const NO_BRANCH_PUBLISH = "No branch yet. Rovara makes it at the commit it started from: no code is pushed and no pull request is opened.";
export const PUSH_EXPLAINER = "When you push to the task's branch, your commits show up on its pull request. Rovara doesn't re-run its checks on pushes made outside it yet, so mention the change to your reviewer.";
/** Where the server offers Recheck (`canRecheck`), the push explanation says what Rovara does instead. Until then PUSH_EXPLAINER stays: the page never promises a re-check the server cannot start. */
export const PUSH_EXPLAINER_RECHECK = "When you push to the task's branch, your commits show up on its pull request. Rovara will mark the work '" + CHANGED_OUTSIDE + "'; press Recheck when you're ready.";
export const pushExplainer = (loop: ContinueLoop | undefined): string => loop?.canRecheck === true ? PUSH_EXPLAINER_RECHECK : PUSH_EXPLAINER;
/** What Recheck says when the server cannot start a re-check yet and gave no sentence of its own. */
export const RECHECK_UNAVAILABLE = "Recheck isn't available yet";

/** A branch name that is safe to put into a sentence and a prompt: plain git-ref characters only. Anything else is treated as unknown. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
/** A task id as Rovara writes it (a UUID). Anything else never goes into the copied prompt. */
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A repository name that is safe to put into a sentence and a prompt. Anything else is left out of the prompt. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;

export type LoopBranch = ContinueLoop["branches"][number];
export interface ContinueOffer {
 sessionId: string; taskId: string; title: string; project: string | undefined;
 /** The one branch the prompt names: the continue loop's branch when every repository has the same one, else an agent-step run's chosen branch. */
 branch: string | undefined;
 pullRequests: readonly { repository: string; number: number; url: string }[];
 /** The task view's `continueLoop` (a server from 0.5.15 sends it), or undefined for an older one: then the panel reads as it did before it. */
 loop: ContinueLoop | undefined;
 /** The repositories the task has: those with a pull request or a branch, and those Rovara prepared (the task view's review base). They are the names Publish working branch is sent with. */
 repositories: readonly string[];
}

/** The branch every given branch agrees on, or undefined for none or for different ones. */
export function uniqueBranch(branches: readonly Pick<LoopBranch, "branch">[]): string | undefined {
 const names = new Set(branches.map(entry => entry.branch));
 const [only] = names;
 return names.size === 1 && only !== undefined && BRANCH.test(only) ? only : undefined;
}


/**
 * The offer for this session, or undefined when the panel does not apply: not a task, or an ended one (Merged or Closed), or a reader who cannot work on it. "Can work on it" is the task's owner or a
 * reader whose actions include steer (the session view's own answer for use and edit level); a reader who may only watch or comment does not see the button. The server still decides in the end.
 */
export function continueOffer(session: ReadSession): ContinueOffer | undefined {
 if (session.body.kind !== "task") return undefined;
 if (!(session.you.owner || session.you.actions.includes("steer"))) return undefined;
 if (isClosedTask(session)) return undefined;
 const state = sessionDisplay(session).state;
 if (state === "merged" || state === "closed") return undefined;
 const task = workspaceTask(session), taskId = task?.taskId ?? (typeof (session.body.task as { taskId?: unknown }).taskId === "string" ? (session.body.task as { taskId: string }).taskId : undefined);
 if (taskId === undefined || !TASK_ID.test(taskId)) return undefined;
 // The branch is known only where the task view says so: an agent-step run's chosen branch. The pull request summary names the repository and number, not the branch.
 const run = (task?.run as { branch?: unknown } | undefined)?.branch;
 const branch = typeof run === "string" && BRANCH.test(run) ? run : undefined;
 const pullRequests = (task?.pullRequests ?? []).map(pr => ({ repository: pr.repository, number: pr.number, url: pr.url }));
 const loop = task?.continueLoop;
 // The new field is the branch before there is a pull request too; the run's own branch is the fallback for a server that does not send it.
 const loopBranch = loop === undefined ? undefined : uniqueBranch(loop.branches);
 const names = [...(loop?.branches ?? []).map(entry => entry.repository), ...pullRequests.map(pr => pr.repository), ...(task?.workflow?.reviewBase ?? []).map(entry => entry.repositoryId)];
 const repositories = [...new Set(names)].slice(0, 32);
 return { sessionId: session.sessionId, taskId, title: session.title, project: session.project, branch: loopBranch ?? branch, pullRequests, loop, repositories };
}

/** The short prompt to paste into the person's tool. */
export function loadPrompt(offer: Pick<ContinueOffer, "taskId" | "branch"> & { branches?: readonly Pick<LoopBranch, "repository" | "branch">[] | undefined }): string {
 const load = "Load Rovara task " + offer.taskId + " (call " + LOAD_TOOLS.join(", then ") + ") and continue it";
 if (offer.branch !== undefined) return load + " on branch " + offer.branch + ".";
 // Different branches in different repositories: name each one (a name that is not plain git-ref characters is left out, never put into the prompt).
 const named = (offer.branches ?? []).filter(entry => REPOSITORY.test(entry.repository) && BRANCH.test(entry.branch));
 return named.length < 2 ? load + "." : load + ", on these branches: " + named.map(entry => entry.repository + ": " + entry.branch).join(", ") + ".";
}

/** What the lessons switch says for this project, in one sentence for the tool's reader, or undefined when the data does not say. */
export function lessonsLine(state: { enabled: boolean; reason?: string | undefined } | undefined): string | undefined {
 if (state === undefined) return undefined;
 if (state.enabled) return "Your tool can read this project's trusted, project-wide lessons (up to five at a time) with the " + LESSONS_TOOL + " tool.";
 if (state.reason === "regulated") return "This project uses the Regulated preset, so your tool gets no lessons.";
 if (state.reason === "company_stays") return "Your company keeps lessons inside Rovara, so your tool gets no lessons.";
 if (state.reason === "project_setting") return "Lessons are switched off for coding tools on this project, so your tool gets none.";
 return undefined;
}
