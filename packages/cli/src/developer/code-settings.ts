// `agentx project code-settings <project> [--self-approval on|off] [--merge-method squash|merge] [--reviewers a,b]` (Plan 6 Task 19, with the Task 25 slice): a project's code settings
// from the command line. It reads the settings and their revision (`GET /v1/app/projects/{p}/code-settings`), and for a change sends the PUT under that revision. Everything applies at
// once except self-approval turned on, which answers `202 NEEDS_CONFIRMATION`: the command prints the link where an organization owner or admin confirms it and exits 0. Nothing here
// decides anything (R66): the CLI never decides an approval.
import { randomUUID } from "node:crypto";
import { CLI_PACKAGE_NAME, CODE_REVIEWERS_MAX, CodeSettingsResponseReaderSchema, NeedsConfirmationReaderSchema, agentXError, type CodeSettingsResponseRead } from "@agentx/contracts";
import { appRequest, clean, result, seg, type AppResult } from "./agents.js";
import { safeUrl } from "./sessions.js";
import type { DeveloperSessionDeps } from "./session.js";

const UNEXPECTED = `AgentX answered with something unexpected; try again, or upgrade: npx ${CLI_PACKAGE_NAME}@latest whoami`;
const REVIEWER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/;

export interface CodeSettingsOptions { selfApproval?: string | undefined; mergeMethod?: string | undefined; reviewers?: string | undefined }

/** The settings as the answer reads: the broker also sends `requestId`, which is not part of them, and a merge method a newer control plane added reads as "unknown". */
type ReadCodeSettings = CodeSettingsResponseRead["settings"];

interface Change { allowSelfApproval?: boolean; mergeMethod?: "squash" | "merge"; codeReviewers?: string[] }

/** What the person typed, checked before anything is sent. */
function changeOf(options: CodeSettingsOptions): Change {
  const change: Change = {};
  if (options.selfApproval !== undefined) {
    if (options.selfApproval !== "on" && options.selfApproval !== "off") throw agentXError("CONFIG_INVALID", "--self-approval takes on or off");
    change.allowSelfApproval = options.selfApproval === "on";
  }
  if (options.mergeMethod !== undefined) {
    if (options.mergeMethod !== "squash" && options.mergeMethod !== "merge") throw agentXError("CONFIG_INVALID", "--merge-method takes squash or merge");
    change.mergeMethod = options.mergeMethod;
  }
  if (options.reviewers !== undefined) {
    const names = options.reviewers.trim() === "" || options.reviewers.trim().toLowerCase() === "none" ? [] : options.reviewers.split(",").map((name) => name.trim()).filter((name) => name !== "");
    if (names.length > CODE_REVIEWERS_MAX) throw agentXError("CONFIG_INVALID", `--reviewers takes at most ${String(CODE_REVIEWERS_MAX)} names`);
    if (names.some((name) => !REVIEWER.test(name))) throw agentXError("CONFIG_INVALID", "--reviewers takes GitHub names (a person, or org/team) separated by commas, or none");
    change.codeReviewers = names;
  }
  return change;
}

const reviewersWords = (reviewers: readonly string[]): string => (reviewers.length === 0 ? "none" : reviewers.map(clean).join(", "));

function settingsLines(settings: ReadCodeSettings): string[] {
  return [`  Self-approval: ${settings.allowSelfApproval ? "on" : "off"}`, `  Merge method: ${settings.mergeMethod}`, `  Reviewers: ${reviewersWords(settings.codeReviewers)}`];
}

export async function projectCodeSettings(deps: DeveloperSessionDeps, env: string | undefined, project: string, options: CodeSettingsOptions): Promise<AppResult> {
  const change = changeOf(options);
  const path = `/v1/app/projects/${seg(project)}/code-settings`;
  const read = await appRequest(deps, env, path);
  const current = CodeSettingsResponseReaderSchema.safeParse(read.body);
  if (!current.success) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  const name = clean(project);
  if (Object.keys(change).length === 0) {
    return result(read, { settings: current.data.settings }, `${[`Code settings for ${name} (revision ${String(current.data.settings.revision)}):`, ...settingsLines(current.data.settings), ""].join("\n")}`);
  }
  const answer = await appRequest(deps, env, path, { method: "PUT", body: { requestId: randomUUID(), expectedRevision: current.data.settings.revision, ...change } });
  if (answer.status === 202 || answer.body["status"] === "NEEDS_CONFIRMATION") {
    const confirmation = NeedsConfirmationReaderSchema.safeParse(answer.body);
    const link = confirmation.success ? safeUrl(confirmation.data.confirmUrl, answer.url) : undefined;
    if (!confirmation.success || link === undefined) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
    const changedNow = [
      ...(change.mergeMethod === undefined ? [] : [`merge method ${change.mergeMethod}`]),
      ...(change.codeReviewers === undefined ? [] : [`reviewers ${reviewersWords(change.codeReviewers)}`]),
    ];
    const lines = [
      ...(changedNow.length === 0 ? [] : [`Changed now: ${changedNow.join(", ")}.`]),
      "An organization owner or admin has to confirm turning self-approval on. Nothing has changed for it yet.",
      ...confirmation.data.changes.map((text) => `  - ${clean(text)}`),
      `Confirm this in your browser: ${link}`, "",
    ];
    return result(answer, { status: confirmation.data.status, confirmUrl: link, changes: confirmation.data.changes, ...(changedNow.length === 0 ? {} : { changedNow }) }, lines.join("\n"));
  }
  const changed = CodeSettingsResponseReaderSchema.safeParse(answer.body);
  if (!changed.success) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  return result(answer, { settings: changed.data.settings }, `${[`Changed the code settings of ${name}.`, ...settingsLines(changed.data.settings), ""].join("\n")}`);
}
