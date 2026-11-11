// `agentx project check <name>` (Plan 2, Task 22): a maintainer has the project's setup and test commands run on a fresh workspace. One signed-in call
// starts the check (`POST /v1/app/projects/{name}/setup-check`), then the project is read every 10 seconds until the check is no longer running. The
// control plane decides who may check and what it costs; this starts it, waits, and says how it ended.
import { randomUUID } from "node:crypto";
import { AppProjectDetailSchema, ProjectSetupCheckResponseSchema, agentXError, type AppProjectDetail } from "@rovara-code/contracts";
import { developerRequest } from "./commands.js";
import type { DeveloperSessionDeps } from "./session.js";

/** How often the project is read while its check runs, and how long the CLI waits for it (a little over the control plane's own 50 minutes). */
export const CHECK_POLL_MS = 10_000;
export const CHECK_WAIT_MS = 3_600_000;

/** Server text for a terminal: no control or format characters (escapes, direction overrides), no tokens, and not unbounded. */
function shown(text: string): string {
  return [...text.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/agx[rc]_[A-Za-z0-9_-]+/g, "[hidden]")].slice(0, 500).join("");
}

export async function checkDeveloperProject(
  deps: DeveloperSessionDeps,
  env: string | undefined,
  name: string,
  options: { requestId?: string; sleep: (ms: number) => Promise<void> },
): Promise<{ env: string; url: string; project: AppProjectDetail }> {
  const path = `/v1/app/projects/${encodeURIComponent(name)}`;
  const started = await developerRequest(deps, env, `${path}/setup-check`, ProjectSetupCheckResponseSchema, {
    method: "POST", body: { requestId: options.requestId ?? randomUUID() }, explain: true,
  });
  let project = started.body.project;
  let waited = 0;
  while (project.setup.status === "checking") {
    if (waited >= CHECK_WAIT_MS) {
      throw agentXError("RUNTIME_UNAVAILABLE", `the setup check of ${shown(name)} is still running after an hour; run agentx project show ${shown(name)} later to see how it ended`);
    }
    await options.sleep(CHECK_POLL_MS);
    waited += CHECK_POLL_MS;
    project = (await developerRequest(deps, env, path, AppProjectDetailSchema, { explain: true })).body;
  }
  return { env: started.env, url: started.url, project };
}

/**
 * What the command says once the check is over. Passed and outdated are told on stdout; a failed check throws (CONFIG_INVALID, a non-zero exit),
 * with the failing step as the control plane recorded it.
 */
export function projectCheckText(project: AppProjectDetail): string {
  const name = shown(project.name);
  const checked = project.setup.checkedRevision;
  if (project.setup.status === "failed") {
    throw agentXError("CONFIG_INVALID", `Setup check failed for ${name} (revision ${String(checked ?? project.latestRevision)})${project.setup.failedStep === undefined ? "" : `: ${shown(project.setup.failedStep)}`}`);
  }
  if (project.setup.status === "outdated") {
    return `The settings of ${name} changed while it was being checked (it ran at revision ${String(checked)}, the project is now at revision ${String(project.latestRevision)}). Run agentx project check ${name} again.\n`;
  }
  if (project.setup.status === "ready") return `Setup check passed for ${name} (revision ${String(checked ?? project.latestRevision)}): the setup and test commands ran cleanly on a fresh workspace.\n`;
  return `The setup check of ${name} has not run.\n`;
}
