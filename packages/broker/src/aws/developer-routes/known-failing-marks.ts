// Setup and test health KF-1: `/v1/app/projects/{name}/known-failing`, the tests a maintainer marked as already failing, and Undo. Behind the `vx` switch: with it off the path is not found, as any unknown path.
//   GET     a project maintainer (a role that may edit the project's settings): every mark (test, check, who, when, which card), the most a list holds, and whether the viewer made each mark.
//   POST    a project maintainer, from a live browser session only (a token, the CLI or Slack never change it):
//             { action: "undo", requestId, name, checkId, markedBy, markedAt, epoch }   removes that one mark. It makes results stricter, so no second person is asked. Audited.
// Marks are named by everything stored with them; a mark that was undone, changed or marked again since the list was shown answers CHANGE_STALE. The expiry of a mark by a passing nightly is not a route: it happens when a
// nightly is recorded (`known-failing-undo.ts`). Answers are fixed words, booleans, numbers and the test ids a maintainer already sees on the Fix setup card.
import { routeEnvOf } from "../../org/feature-rollout.js";
import { z } from "zod";
import { agentXError, projectAllows, type OrgId } from "@rovara-code/contracts";
import { logDeveloperEvent } from "../../developer/log.js";
import { KNOWN_FAILING_MAX, KnownFailingMarkSchema, readKnownFailingRow } from "../../test-env/known-failing.js";
import { KNOWN_FAILING_UNDO_BROWSER_MESSAGE, undoKnownFailing } from "../../test-env/known-failing-undo.js";
import { verifyResultsEnabled } from "../../verification/switch.js";
import { StatusReply } from "../status-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { signInStoreOf } from "./common.js";
import { jsonBody } from "./organization.js";
import { projectRoleForRoute } from "./project-members.js";
import { testEnvStoreOf } from "./test-environment.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const KNOWN_FAILING_MARKS_PATH = /^\/v1\/app\/projects\/([^/]+)\/known-failing$/u;
export const KNOWN_FAILING_MARKS_BROWSER_MESSAGE = KNOWN_FAILING_UNDO_BROWSER_MESSAGE;
const NAMES_AT_ONCE_MAX = 100;

const BodySchema = z.object({
  action: z.literal("undo"),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/u),
  name: KnownFailingMarkSchema.shape.name, checkId: KnownFailingMarkSchema.shape.checkId, markedBy: KnownFailingMarkSchema.shape.markedBy, markedAt: KnownFailingMarkSchema.shape.markedAt, epoch: KnownFailingMarkSchema.shape.epoch,
}).strict();

async function listOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, project: string) {
  const row = await readKnownFailingRow(testEnvStoreOf(deps), caller.orgId, project);
  if (row === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "The list of known-failing tests could not be read. Try again.");
  const ids = [...new Set(row.marks.map((mark) => mark.markedBy))].slice(0, NAMES_AT_ONCE_MAX);
  // A person's name is best effort: an unknown or unreadable one is shown as "Unknown", never as an error.
  const people = ids.length === 0 ? new Map() : await signInStoreOf(deps).getDevelopers(ids).catch(() => new Map());
  return {
    max: KNOWN_FAILING_MAX,
    marks: row.marks.map((mark) => ({
      name: mark.name, checkId: mark.checkId, markedBy: mark.markedBy, markedByName: (people.get(mark.markedBy) as { displayName?: string } | undefined)?.displayName ?? "Unknown", markedAt: mark.markedAt, epoch: mark.epoch, markedByYou: mark.markedBy === caller.developerId,
    })),
  };
}

/** The reply, or undefined when the switch is off or the path is not this one. */
export async function routeKnownFailingMarks(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = routeEnvOf(deps)): Promise<StatusReply | undefined> {
  if (!verifyResultsEnabled(env)) return undefined;
  const match = KNOWN_FAILING_MARKS_PATH.exec(url.pathname);
  if (match === null || (request.method !== "GET" && request.method !== "POST")) return undefined;
  const { name, role } = await projectRoleForRoute(deps, caller, match[1]!);
  if (!projectAllows(role, "edit_settings")) throw agentXError("FORBIDDEN", "Only a project maintainer can see or change the known-failing tests.");
  if (request.method === "GET") return new StatusReply(200, await listOf(deps, caller, name));
  // Defence in depth: the entry file refuses a token for both methods before this, and so does the undo itself.
  if (caller.browserSession !== true) throw agentXError("FORBIDDEN", KNOWN_FAILING_MARKS_BROWSER_MESSAGE);
  const parsed = BodySchema.safeParse(jsonBody(request));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Field names only: the values are the person's.
    throw agentXError("CONFIG_INVALID", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
  }
  const { requestId, name: test, checkId, markedBy, markedAt, epoch } = parsed.data;
  const orgId: OrgId = caller.orgId;
  // The role was read for this request, from the live records.
  const answer = await undoKnownFailing({ store: testEnvStoreOf(deps), mayEditSettings: async () => projectAllows(role, "edit_settings") }, { orgId, developerId: caller.developerId, browserSession: true }, name, { name: test, checkId, markedBy, markedAt, epoch }, requestId);
  if (answer === "stale") throw agentXError("CHANGE_STALE", "That mark was already removed or changed. Reload the list.");
  if (answer === "not_ready") throw agentXError("RUNTIME_UNAVAILABLE", "The mark could not be removed right now. Try again.");
  logDeveloperEvent({ event: "developer.known_failing_undone", orgId, project: name });
  return new StatusReply(200, { status: "done", ...(await listOf(deps, caller, name)) });
}
