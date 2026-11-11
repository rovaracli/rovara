// Company-approved images, the worker's pull login (test services, switch `pj`): `POST /v1/internal/workspaces/{w}/operations/{o}/company-image-login`. The worker's run pulls an approved image from the install's OWN registry
// (the mirror); this is where it gets the login for that one repository. The worker has no registry login and no AWS credentials of its own, so it asks, per image, right before the pull.
//
// The caller is authenticated like every operation callback (a capability signed for this operation and its fence, naming `company-image-login`, which the broker grants only to a run whose pinned plan names a company
// image). Then, each rule refusing with the same fixed words so the answer says nothing about WHY:
//   - the switches `tx` and `pj` are on, and the operation is RUNNING and is a task's coding or checks run, or a candidate check's preparation;
//   - the organisation is the OPERATION's (written by the broker at dispatch); the body names an image id and nothing else;
//   - the image id is one the run's PINNED PLAN named (`companyImageIds`, kept on the operation at dispatch): a worker with a valid capability cannot ask for any other image, not even another approved image of its company;
//   - the image is STILL approved for that organisation right now (a revoked image gets no login, even in a run whose plan named it), its registry is still on the company's list, and its copy is finished for exactly the
//     approved digest;
//   - the repository is `companyImageRepositoryName` of the organisation and the image: never a name from the request. The login is for that one repository (a session policy), short lived, and is never logged;
//   - a run asks at most `COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION` times: a counter on the operation, added to with a condition.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION, CompanyImageLoginRequestSchema, SavedEnvRegistryAuthSchema, companyImageRegistryRule, companyImageRepositoryName, type SavedEnvRegistryAuth } from "@agentx/cloud-contracts";
import { agentXError, type OrgId } from "@rovara-code/contracts";
import { dynamoCompanyImageStore } from "../../org/company-test-image-store.js";
import { readMirrorState } from "../../test-env/company-image-mirror-state.js";
import { mintPullSessionFor, type SavedEnvSessionConfig, type SavedEnvSessionPorts } from "../../test-env/saved-env-session.js";
import { projectImagesEnabled, testServicesEnabled } from "../../test-env/test-services-switch.js";
import { operationKey } from "../cancellation.js";

export const COMPANY_IMAGE_LOGIN_REFUSED = "this operation cannot be given a login for that image";

export interface CompanyImageLoginOperation {
  kind: string;
  workflowMode?: string | undefined;
  status: string;
  workspaceId: string;
  id?: string | undefined;
  orgId?: string | undefined;
  /** The ids of the company images the run's pinned plan named, written when the run was dispatched. */
  companyImageIds?: readonly string[] | undefined;
}

export interface CompanyImageLoginDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The registry sessions. Absent: the install has no registry for images, so no login is given. */
  sessions?: { config: SavedEnvSessionConfig; ports: SavedEnvSessionPorts } | undefined;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}

const MODES_WITH_SERVICES: ReadonlySet<string | undefined> = new Set([undefined, "IMPLEMENT", "CHECKS"]);
const refuse = (): never => { throw agentXError("CALLBACK_FORBIDDEN", COMPANY_IMAGE_LOGIN_REFUSED); };

/** Counts one login against the operation, atomically: false once the run has had the most it may. */
async function countLogin(deps: CompanyImageLoginDeps, workspaceId: string, operationId: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: operationKey(workspaceId, operationId), UpdateExpression: "ADD companyImageLogins :one",
      ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(companyImageLogins) OR companyImageLogins < :max)",
      ExpressionAttributeValues: { ":one": 1, ":max": COMPANY_IMAGE_LOGIN_MAX_PER_OPERATION },
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function handleCompanyImageLogin(deps: CompanyImageLoginDeps, operation: CompanyImageLoginOperation, rawBody: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{ login: SavedEnvRegistryAuth }> {
  if (!testServicesEnabled(env) || !projectImagesEnabled(env)) return refuse();
  const taskRun = operation.kind === "task" && MODES_WITH_SERVICES.has(operation.workflowMode);
  if ((!taskRun && operation.kind !== "prepare") || operation.status !== "RUNNING" || operation.orgId === undefined || deps.sessions === undefined || operation.id === undefined) return refuse();
  const body = CompanyImageLoginRequestSchema.safeParse(rawBody);
  if (!body.success) throw agentXError("CONFIG_INVALID", "the company-image-login callback body is not the shape");
  const imageId = body.data.imageId;
  if (!(operation.companyImageIds ?? []).includes(imageId)) return refuse();
  const orgId: OrgId = operation.orgId;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const store = dynamoCompanyImageStore(table);
  // Live, not cached: the approval and the company's registry list are read now.
  const [image, registries] = await Promise.all([store.get(orgId, imageId), store.registries(orgId)]).catch((): [undefined, undefined] => [undefined, undefined]);
  if (image === undefined || registries === undefined || image.status !== "approved" || companyImageRegistryRule(image.registry, registries.hosts) === undefined) return refuse();
  const state = await readMirrorState(table, orgId, imageId).catch(() => undefined);
  if (state?.state !== "ready" || state.digest !== image.digest) return refuse();
  let repository: string;
  try { repository = companyImageRepositoryName({ env: deps.sessions.config.env, orgId, imageId }); } catch { return refuse(); }
  if (state.repository !== repository) return refuse();
  if (!(await countLogin(deps, operation.workspaceId, operation.id).catch(() => false))) return refuse();
  const minted = await mintPullSessionFor(deps.sessions.config, deps.sessions.ports, repository);
  if (!minted.ok) return refuse();
  const parsed = SavedEnvRegistryAuthSchema.safeParse(minted.auth);
  if (!parsed.success || parsed.data.repository !== repository) return refuse();
  (deps.log ?? ((event) => { console.log(JSON.stringify({ component: "broker", ...event })); }))({ event: "company_image.login_issued", workspaceId: operation.workspaceId, operationId: operation.id, imageId, digest: image.digest, expiresAt: parsed.data.expiresAt });
  return { login: parsed.data };
}
