// Setup and test health SH28: `/v1/app/projects/{name}/test-health`, behind the `nh` switch (and the test environment): with either off the path is not found, as any unknown path.
//   GET                 anyone who can see the project: its health (state, cause, since), whether failing tests propose a fix task, and the proposed tasks.
//   POST (set)          a maintainer turns `nightly.proposeFixTask` on or off: { action: "set_propose_fix_task", enabled, requestId }. Audited.
//   POST (dismiss)      a maintainer puts one proposed task away: { action: "dismiss_proposed_task", key }.
// Every answer is fixed words, a count, test ids and a day: no output and no message text.
import { z } from "zod";
import { agentXError, type OrgId } from "@agentx/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { dismissProposedFixTask, listProposedFixTasks } from "../../test-env/proposed-tasks.js";
import { readProjectHealth, readProposeFixTask, setProposeFixTask } from "../../test-env/health.js";
import { healthWiringOn } from "../../test-env/health-wiring.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import { projectRoleForRoute } from "./project-members.js";
import { testEnvStoreOf } from "./test-environment.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const TEST_HEALTH_PATH = /^\/v1\/app\/projects\/([^/]+)\/test-health$/u;

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_propose_fix_task"), enabled: z.boolean(), requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u) }).strict(),
  z.object({ action: z.literal("dismiss_proposed_task"), key: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
]);

async function stateOf(deps: DeveloperRouteDependencies, orgId: OrgId, name: string) {
  const store = testEnvStoreOf(deps);
  // A health that cannot be read is "unknown" to the reader, never "healthy".
  const health = await readProjectHealth(store, orgId, name).catch(() => undefined);
  return {
    health: health === undefined ? { state: "unknown" as const } : { state: health.state, ...(health.cause === undefined ? {} : { cause: health.cause }), since: health.since },
    proposeFixTask: await readProposeFixTask(store, orgId, name),
    proposedTasks: await listProposedFixTasks(store, orgId, name).catch(() => []),
  };
}

/** The reply, or undefined when the switch is off or the path is not this one. */
export async function routeTestHealth(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | undefined> {
  if (!healthWiringOn(env)) return undefined;
  const match = TEST_HEALTH_PATH.exec(url.pathname);
  if (match === null) return undefined;
  if (request.method !== "GET" && request.method !== "POST") return undefined;
  const { name, role } = await projectRoleForRoute(deps, caller, match[1]!);
  if (request.method === "GET") return new StatusReply(200, await stateOf(deps, caller.orgId, name));
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const store = testEnvStoreOf(deps);
  if (parsed.data.action === "set_propose_fix_task") {
    await setProposeFixTask(store, { orgId: caller.orgId, project: name, role, changedBy: caller.developerId, enabled: parsed.data.enabled, requestId: parsed.data.requestId });
    logDeveloperEvent({ event: "developer.test_health_setting_changed", orgId: caller.orgId, project: name, enabled: String(parsed.data.enabled) });
  } else {
    await dismissProposedFixTask(store, { orgId: caller.orgId, project: name, role, key: parsed.data.key });
    logDeveloperEvent({ event: "developer.test_health_proposal_dismissed", orgId: caller.orgId, project: name });
  }
  return new StatusReply(200, await stateOf(deps, caller.orgId, name));
}
