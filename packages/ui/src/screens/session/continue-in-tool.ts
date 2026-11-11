import { isClosedTask, sessionDisplay, type ReadSession } from "./SessionHeader.js";
import { workspaceTask } from "./workspace-types.js";
/**
 * What the "Continue in your own tool" panel says, as plain functions (no React, no reads). Everything here comes from what exists today: the CLI's `mcp install` command
 * (packages/cli/src/mcp/install.ts, docs/mcp-install.md), the MCP tools `agentx_get_task` and `agentx_get_plan`, and the task view's own fields.
 */
export type ToolKind = "claude-code" | "codex" | "cursor";
/** The published CLI's package name (`DEFAULT_CLI_PACKAGE_NAME` in Rovara Code's contracts; a test keeps the two equal). The web app does not import the contracts package for one string. */
export const CLI_PACKAGE = "@preplabsai/rovara-code";
export const TOOLS: readonly { kind: ToolKind; label: string; where: string }[] = [
 { kind: "claude-code", label: "Claude Code", where: "Rovara runs claude mcp add for you, once, for your user." },
 { kind: "codex", label: "Codex", where: "Rovara adds an entry to ~/.codex/config.toml and keeps a backup of the old file." },
 { kind: "cursor", label: "Cursor", where: "Rovara adds an entry to ~/.cursor/mcp.json and keeps a backup of the old file." },
];
export const installCommand = (tool: ToolKind): string => "npx " + CLI_PACKAGE + " mcp install --client " + tool;
/** The tools the prompt tells the person's AI tool to call: both exist in Rovara's MCP server today. */
export const LOAD_TOOLS = ["agentx_get_task", "agentx_get_plan"] as const;
export const LESSONS_TOOL = "rovara_lessons";
export const NO_BRANCH_YET = "The branch appears once Rovara opens the pull request.";
export const PUSH_EXPLAINER = "When you push to the task's branch, Rovara will mark the work 'Changed outside Rovara · checks needed'. Press Recheck when you're ready.";

/** A branch name that is safe to put into a sentence and a prompt: plain git-ref characters only. Anything else is treated as unknown. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;

export interface ContinueOffer { taskId: string; title: string; project: string | undefined; branch: string | undefined; pullRequests: readonly { repository: string; number: number; url: string }[] }

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
 if (taskId === undefined) return undefined;
 // The branch is known only where the task view says so: an agent-step run's chosen branch. The pull request summary names the repository and number, not the branch.
 const run = (task?.run as { branch?: unknown } | undefined)?.branch;
 const branch = typeof run === "string" && BRANCH.test(run) ? run : undefined;
 const pullRequests = (task?.pullRequests ?? []).map(pr => ({ repository: pr.repository, number: pr.number, url: pr.url }));
 return { taskId, title: session.title, project: session.project, branch, pullRequests };
}

/** The short prompt to paste into the person's tool. */
export function loadPrompt(offer: Pick<ContinueOffer, "taskId" | "branch">): string {
 return "Load Rovara task " + offer.taskId + " (call " + LOAD_TOOLS.join(", then ") + ") and continue it" + (offer.branch === undefined ? "." : " on branch " + offer.branch + ".");
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
