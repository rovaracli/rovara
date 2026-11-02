// The test-environment proposal a setup run made (SH15 fix round): a small marker beside the proposal saying THIS proposal came from the setup run `taskId`, which request made it, and what that request answered.
//   - the wizard shows a marked proposal (as Rovara's, with the sources of its commands), and credits nothing to a person's edit: the edited mark is never set for it;
//   - a repeat of the same request answers the same thing and stores nothing again (replays are tied to the request id);
//   - no proposal's commands reach the settings before approval (TE-2: `applyProposalCommands` refuses every unapproved proposal, and the approval writes only what the proposal's own candidate check ran); `refuseSetupRunProposal` is no longer called by the wizard;
//   - a person's own edit, or going back to Rovara's draft, replaces it (`clearEditedProposal` removes the marker too).
import { GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, projectPk, testEnvDigest, type OrgId, type TestEnvironmentBody } from "@agentx/contracts";

type Store = { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string; now: () => number };
const TTL_MS = 7 * 86_400_000;
const markerKey = (orgId: OrgId, project: string) => ({ pk: projectPk(orgId, project), sk: "TESTENV#SETUPRUN" });

export const SETUP_RUN_PROPOSAL_WORDS = "This setup came from a setup run. Its commands go into the project's settings only when the environment is approved after a passing proof; they can't be saved before.";

export interface SetupRunProposalMarker { digest: string; taskId: string; requestId: string; by: string; reply: Record<string, unknown> }

export async function readSetupRunProposal(store: Store, orgId: OrgId, project: string): Promise<SetupRunProposalMarker | undefined> {
  const item = (await store.documentClient.send(new GetCommand({ TableName: store.tableName, Key: markerKey(orgId, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> };
  const stored = item.Item;
  if (stored === undefined || stored["orgId"] !== orgId || stored["project"] !== project) return undefined;
  const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
  if (typeof expires === "number" && expires * 1000 <= store.now()) return undefined;
  const { digest, taskId, requestId, by, reply } = stored;
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest) || typeof taskId !== "string" || typeof requestId !== "string" || typeof by !== "string" || typeof reply !== "object" || reply === null) return undefined;
  return { digest, taskId, requestId, by, reply: reply as Record<string, unknown> };
}

export async function writeSetupRunProposal(store: Store, orgId: OrgId, project: string, marker: SetupRunProposalMarker): Promise<void> {
  await store.documentClient.send(new PutCommand({
    TableName: store.tableName,
    Item: { ...markerKey(orgId, project), entityType: "TEST_ENV_SETUP_RUN", orgId, project, ...marker, at: new Date(store.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor((store.now() + TTL_MS) / 1000) },
  }));
}

export async function clearSetupRunProposal(store: Pick<Store, "documentClient" | "tableName">, orgId: OrgId, project: string): Promise<void> {
  await store.documentClient.send(new DeleteCommand({ TableName: store.tableName, Key: markerKey(orgId, project) }));
}

/** Throws unless `body` is NOT the project's current setup-run proposal. Used before a proposal's commands would go into the settings. */
export async function refuseSetupRunProposal(store: Store, orgId: OrgId, project: string, body: TestEnvironmentBody): Promise<void> {
  const marker = await readSetupRunProposal(store, orgId, project);
  if (marker !== undefined && marker.digest === testEnvDigest(body)) throw agentXError("CONFIG_INVALID", SETUP_RUN_PROPOSAL_WORDS);
}
