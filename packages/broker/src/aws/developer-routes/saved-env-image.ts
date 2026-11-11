// Saved project images (SV wiring, switch `sv`): the project's Environment panel as routes. Behind `sv`: with it off every path here is not found, as any unknown path. The project is a browser route family, so the
// app reaches these as `/v1/web/...`; a token (an API or CLI token) is refused here and, for every method, before this in the entry file.
//   GET   /v1/app/projects/{name}/environment-image             a member of the project (any role): the panel, fixed words, counts and times (contracts `app-saved-env.ts`). `canReset` says whether the caller is a maintainer.
//   POST  /v1/app/projects/{name}/environment-image             { action: "reset", requestId }: a maintainer of the project, from a live browser session. The same browser session and CSRF guard as every /v1/app write
//                                                               runs before this file (a write with no valid token is refused there). The role is the one the broker reads for the session's person, never one the request names.
//   PUT   /v1/app/projects/{name}/environment-image/setting     { enabled }: the project's `savedEnv.enabled` setting. A maintainer, from a browser; audited (`saved_env.setting_changed`, who and the new value).
// The registry's rules are in `test-env/saved-env-panel.ts` and `test-env/saved-env.ts`; this file reads the caller's role and passes it.
import { SavedEnvResetBodySchema, SavedEnvSettingBodySchema, agentXError, projectAllows } from "@rovara-code/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { savedEnvPanel, resetFromPanel } from "../../test-env/saved-env-panel.js";
import { setProjectEnabled } from "../../test-env/saved-env.js";
import { savedEnvEnabled } from "../../test-env/saved-env-switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { bodyError } from "./common.js";
import { jsonBody } from "./organization.js";
import { visibleProjectRoles } from "./project-list.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const SAVED_ENV_IMAGE_PATH = /^\/v1\/app\/projects\/([^/]+)\/environment-image(\/setting)?$/u;
export const SAVED_ENV_IMAGE_BROWSER_MESSAGE = "Use a live browser session for the project's saved environment.";
/** Whether the path is one of this file's (the entry file refuses a token for these before anything is read). */
export const isSavedEnvImagePath = (pathname: string): boolean => SAVED_ENV_IMAGE_PATH.test(pathname);

export async function routeSavedEnvImage(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!savedEnvEnabled(env)) return undefined;
  const match = SAVED_ENV_IMAGE_PATH.exec(url.pathname);
  if (match === null) return undefined;
  const setting = match[2] !== undefined;
  const wanted = setting ? "PUT" : request.method === "GET" || request.method === "POST" ? request.method : undefined;
  if (wanted === undefined || request.method !== wanted) return undefined;
  // The registry is installed only where the install made one; without it the panel does not exist.
  const registry = deps.savedEnv;
  if (registry === undefined) return undefined;
  // Defence in depth: the entry file refuses a token for these paths before this, and so does this.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", SAVED_ENV_IMAGE_BROWSER_MESSAGE);
  let name: string;
  try { name = decodeURIComponent(match[1]!); } catch { throw agentXError("PROJECT_NOT_FOUND", "project not found"); }
  // The role is read live for the authenticated person (an org owner or admin counts as a maintainer of every project). A person with no role on the project learns nothing about it.
  const role = (await visibleProjectRoles(deps, caller, name)).get(name);
  if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const ids = { orgId: caller.orgId, projectId: name };
  if (setting) {
    if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "Only a project maintainer can change the project's saved environment.");
    const parsed = SavedEnvSettingBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw bodyError(parsed.error);
    const changed = await setProjectEnabled(registry, ids, parsed.data.enabled, caller.developerId);
    if (!changed.ok) throw agentXError(changed.reason === "disabled" ? "NOT_FOUND" : "CHANGE_STALE", changed.reason === "disabled" ? "route not found" : "The project's saved environment changed meanwhile; try again.");
    if (changed.changed) logDeveloperEvent({ event: "developer.saved_env_setting_changed", orgId: caller.orgId, project: name, enabled: String(parsed.data.enabled) });
    return new StatusReply(200, { enabled: parsed.data.enabled, changed: changed.changed });
  }
  if (request.method === "GET") {
    const panel = await savedEnvPanel(registry, ids, { projectRole: role });
    if (!panel.ok) return undefined;
    return new StatusReply(200, panel.panel);
  }
  const parsed = SavedEnvResetBodySchema.safeParse(jsonBody(request));
  if (!parsed.success) throw bodyError(parsed.error);
  const reset = await resetFromPanel(registry, ids, { actorId: caller.developerId, projectRole: role, requestId: parsed.data.requestId });
  if (!reset.ok) {
    if (reset.reason === "not_maintainer") throw agentXError("FORBIDDEN", "Only a project maintainer can reset the project's saved environment.");
    if (reset.reason === "stale_write") throw agentXError("CHANGE_STALE", "The project's saved environment changed meanwhile; try again.");
    return undefined;
  }
  logDeveloperEvent({ event: "developer.saved_env_reset", orgId: caller.orgId, project: name, status: reset.status });
  return new StatusReply(200, { status: reset.status, panel: reset.panel });
}
