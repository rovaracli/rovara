// The fixture delivery callback, broker side (test services, slice 3, s3-fakes-run): `POST /v1/internal/workspaces/{w}/operations/{o}/fixture-set`. A worker asks for a fresh 15-minute read address of ONE approved fixture set,
// at the start of a phase that serves a fake. The address is never in the task plan: it would expire long before a round starts, so the plan names the set's DIGEST and the worker asks here, and then downloads at once and holds the
// bytes to that digest (`worker/src/fixture-fetch.ts`).
//
// The caller is authenticated the way every operation callback is (a capability signed for this operation and its fence, naming the action `fixture-set`, which the broker grants only to an operation whose plan names fixture
// sets), and then held to these rules, each of which refuses with the same fixed words so the answer says nothing about WHY (another company's set, a set nobody holds, a withdrawn set and a digest outside the plan read alike):
//   - the switch `tx` is on, and the operation is RUNNING (a finished one is refused before this runs) and is a task's coding or checks run, or a candidate check's preparation;
//   - the organisation is the OPERATION's, written by the broker when it dispatched the run; nothing about the organisation, the project or the task is read from the body, which names a digest and nothing else;
//   - the digest is one the run's PINNED PLAN named: the broker kept the plan's digests on the operation when it dispatched it (`fixtureSetDigests`), so a worker with a valid capability cannot ask for any other set, not
//     even another approved set of its own company;
//   - a task's operation must belong to a task of that organisation that is still open and not cancelled: a closed or cancelled task gets nothing, even with a capability that has not run out;
//   - the store (`deliver`) hands out a set only while it is APPROVED for that organisation, its stored bytes still hash to the digest and it still passes the scan against the project\'s production list as it is NOW, and a withdrawn set stops here: the next phase gets nothing.
// The reply is the digest, the address and its expiry, and nothing else. The address is not logged, kept or sent on by this module.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { FixtureSetCallbackReplySchema, FixtureSetCallbackRequestSchema, agentXError, type FixtureSetCallbackReply, type TestEnvProdDeny } from "@agentx/contracts";
import { taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { readApprovedTestEnvironment } from "../../org/test-environment.js";
import type { FixtureStoreFactory } from "../../test-env/fixture-lookup.js";
import { testServicesEnabled } from "../../test-env/test-services-switch.js";
import { workspaceKey } from "./admin-and-helpers.js";

/** The authenticated operation, as the callback route read it. */
export interface FixtureDeliveryOperation {
  kind: string;
  workflowMode?: string | undefined;
  status: string;
  workspaceId: string;
  orgId?: string | undefined;
  /** The digests of the fixture sets the run's pinned plan named, written when the run was dispatched. */
  fixtureSetDigests?: readonly string[] | undefined;
}

export interface FixtureDeliveryDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The install's fixture store, a factory over the production list (`fixtureStoreForRoutes`). */
  fixtureStore?: FixtureStoreFactory | undefined;
  now?: () => number;
}

/** What every refusal says. */
export const FIXTURE_DELIVERY_REFUSED = "this operation cannot be given that fixture set";
const MODES_WITH_FAKES: ReadonlySet<string | undefined> = new Set([undefined, "IMPLEMENT", "CHECKS"]);

const refuse = (): never => { throw agentXError("CALLBACK_FORBIDDEN", FIXTURE_DELIVERY_REFUSED); };

const get = async <T>(deps: FixtureDeliveryDeps, key: { pk: string; sk: string }): Promise<T | undefined> => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;

/** The project of the task a task operation belongs to, if the task is still open, not cancelled and of this organisation. */
async function openTaskProjectOf(deps: FixtureDeliveryDeps, operation: FixtureDeliveryOperation, orgId: string): Promise<string | undefined> {
  const pointer = await get<DeveloperTaskPointerRecord>(deps, taskPointerKey(operation.workspaceId));
  if (pointer === undefined || pointer.cancelledAt !== undefined) return undefined;
  const task = await get<DeveloperTaskRecord>(deps, taskKey(pointer.taskId));
  return task !== undefined && task.orgId === orgId && task.workspaceId === operation.workspaceId && task.closedAt === undefined ? task.project : undefined;
}

/** The project of the workspace a preparation belongs to, if the workspace is this organisation's. */
async function preparedProjectOf(deps: FixtureDeliveryDeps, operation: FixtureDeliveryOperation, orgId: string): Promise<string | undefined> {
  const workspace = await get<{ orgId?: string; projectName?: string }>(deps, workspaceKey(operation.workspaceId));
  return workspace?.orgId === orgId && typeof workspace.projectName === "string" ? workspace.projectName : undefined;
}

/** The production list the project's approved environment has (the store scans a set against it before it hands one out), or an empty list for a project with no approved environment. A read that fails throws: it is never an empty list. */
async function denyOf(deps: FixtureDeliveryDeps, orgId: string, project: string): Promise<TestEnvProdDeny> {
  const approved = await readApprovedTestEnvironment({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now ?? Date.now }, orgId, project);
  return approved?.environment.prodDeny ?? { accountIds: [], hosts: [], arnPrefixes: [] };
}

/** Handles one request. Throws CALLBACK_FORBIDDEN (always the same words) for anything outside the rules above, CONFIG_INVALID for a body that is not the shape. */
export async function handleFixtureSetCallback(deps: FixtureDeliveryDeps, operation: FixtureDeliveryOperation, rawBody: unknown, env: NodeJS.ProcessEnv = process.env): Promise<FixtureSetCallbackReply> {
  if (!testServicesEnabled(env)) return refuse();
  const taskRun = operation.kind === "task" && MODES_WITH_FAKES.has(operation.workflowMode);
  if ((!taskRun && operation.kind !== "prepare") || operation.status !== "RUNNING" || operation.orgId === undefined || deps.fixtureStore === undefined) return refuse();
  const body = FixtureSetCallbackRequestSchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", "the fixture-set callback body is not the shape");
  const digest = body.data.digest;
  if (!(operation.fixtureSetDigests ?? []).includes(digest)) return refuse();
  const orgId = operation.orgId;
  // A task's operation belongs to a task of that organisation that is still open; a preparation to a workspace of that organisation. Either way the project is the record's, never the request's.
  const project = await (taskRun ? openTaskProjectOf(deps, operation, orgId) : preparedProjectOf(deps, operation, orgId)).catch(() => undefined);
  if (project === undefined) return refuse();
  const deny = await denyOf(deps, orgId, project).catch(() => undefined);
  if (deny === undefined) return refuse();
  const delivered = await deps.fixtureStore(() => Promise.resolve(deny)).deliver(orgId, digest).catch(() => undefined);
  // The store checked the organisation, the approval and the stored bytes; its answer must be for the digest that was asked.
  if (delivered === undefined || !delivered.ok || delivered.digest !== digest) return refuse();
  // An address that is not https (or an expiry that is not a time) is not handed on.
  const reply = FixtureSetCallbackReplySchema.safeParse({ digest, url: delivered.url, expiresAt: delivered.expiresAt });
  return reply.success ? reply.data : refuse();
}
