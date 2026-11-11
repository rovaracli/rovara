// `agentx project lessons-repo <project> [status|on|off|resume|pointer-add|pointer-decline|retire-confirm|retire-keep] [--repo <name>] [--held <digest>]` (lessons in the repo, lane R2; design LESSONS-REPO-FILE-DESIGN.md rev 2 section 9): in Rovara Code, which has no project page,
// the status of a project's `.rovara/lessons.md` and its weekly pull request is read here, and a maintainer switches a repository on or off from here. It reads and sends through `/v1/app/projects/{p}/lessons/repo`; every line it
// prints is a fixed sentence from the broker or the table below. Nothing here decides anything: the pull request is merged by a person on the code host.
import { LessonsRepoFileStatusReaderSchema, agentXError, closesHeldText, lessonFileWaitingText, strayBranchesText, unreachableRepoText, type LessonsRepoFileRow } from "@agentx/contracts";
import { appRequest, clean, result, seg, type AppResult } from "./agents.js";
import type { DeveloperSessionDeps } from "./session.js";

const UNEXPECTED = "AgentX answered with something unexpected; upgrade the command and try again";
export const LESSONS_REPO_ACTIONS = ["status", "on", "off", "resume", "pointer-add", "pointer-decline", "retire-confirm", "retire-keep"] as const;
const BODY_ACTION: Record<Exclude<(typeof LESSONS_REPO_ACTIONS)[number], "status">, string> = {
  on: "on", off: "off", resume: "resume", "pointer-add": "pointer_add", "pointer-decline": "pointer_decline", "retire-confirm": "retire_confirm", "retire-keep": "retire_keep",
};

function rowLines(row: Pick<LessonsRepoFileRow, "repo" | "enabled" | "unmerged" | "notices" | "pr"> & { waitingFor?: string | undefined; retireConfirm?: { digest: string } | undefined }, project: string): string[] {
  const state = row.enabled ? "on" : "off";
  const pr = row.pr === undefined ? "no pull request open" : `pull request #${clean(row.pr.number)} open (${String(row.pr.removals)} removals, ${String(row.pr.edits)} edits, ${String(row.pr.adds)} new)`;
  return [`  ${clean(row.repo)}: ${state}; ${pr}; ${String(row.unmerged)} unmerged in a row`, ...(lessonFileWaitingText(row.waitingFor) === undefined ? [] : [`    ${lessonFileWaitingText(row.waitingFor) ?? ""}`]), ...row.notices.map((notice) => `    ${clean(notice)}`), ...(row.retireConfirm === undefined ? [] : [`    To decide: agentx project lessons-repo ${clean(project)} retire-confirm (or retire-keep) --repo ${clean(row.repo)} --held ${clean(row.retireConfirm.digest)}`])];
}

export async function projectLessonsRepo(deps: DeveloperSessionDeps, env: string | undefined, project: string, action: string | undefined, options: { repo?: string | undefined; held?: string | undefined }): Promise<AppResult> {
  const what = action ?? "status";
  if (!(LESSONS_REPO_ACTIONS as readonly string[]).includes(what)) throw agentXError("CONFIG_INVALID", `the action is one of ${LESSONS_REPO_ACTIONS.join(", ")}`);
  const path = `/v1/app/projects/${seg(project)}/lessons/repo`;
  if (what === "status") {
    const read = await appRequest(deps, env, path);
    const status = LessonsRepoFileStatusReaderSchema.safeParse(read.body);
    if (!status.success) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
    const data = status.data;
    const lines = [
      `Lessons file for ${clean(project)}:`,
      ...(data.lessonsOff ? ["  Lessons are off for this project, so Rovara opens no lessons pull request until they are switched on."] : []),
      ...(data.repos.length === 0 ? ["  No repository has the lessons file switched on."] : data.repos.flatMap((row) => rowLines(row, project))),
      ...(data.unreachable ?? []).map((entry) => `  ${clean(unreachableRepoText(clean(entry.repo), entry.lessons))}`),
      ...(data.closesHeld ?? []).map((entry) => `  ${clean(closesHeldText(clean(entry.repo), entry.count))}`),
      ...(data.strayBranches ?? []).map((entry) => `  ${clean(strayBranchesText(clean(entry.repo), entry.branches))}`),
      ...(data.available.length === 0 ? [] : [`  Can be switched on: ${data.available.map(clean).join(", ")} (agentx project lessons-repo ${clean(project)} on --repo <name>)`]),
      "",
    ];
    return result(read, { status: data }, lines.join("\n"));
  }
  if (options.repo === undefined || options.repo.trim() === "") throw agentXError("CONFIG_INVALID", "--repo <name> is required: the repository's name in the project");
  const retire = what === "retire-confirm" || what === "retire-keep";
  if (retire && (options.held === undefined || !/^[0-9a-f]{16}$/u.test(options.held.trim()))) throw agentXError("CONFIG_INVALID", "--held <digest> is required: the digest the status shows for the missing lessons");
  if (!retire && options.held !== undefined) throw agentXError("CONFIG_INVALID", "--held is only for retire-confirm and retire-keep");
  const answer = await appRequest(deps, env, path, { method: "POST", body: { action: BODY_ACTION[what as keyof typeof BODY_ACTION], repo: options.repo.trim(), ...(retire ? { held: options.held!.trim() } : {}) } });
  const row = answer.body as unknown as LessonsRepoFileRow;
  if (typeof row.repo !== "string" || typeof row.enabled !== "boolean" || !Array.isArray(row.notices)) throw agentXError("RUNTIME_UNAVAILABLE", UNEXPECTED);
  return result(answer, { row }, [`Done for ${clean(project)}:`, ...rowLines(row, project), ""].join("\n"));
}
