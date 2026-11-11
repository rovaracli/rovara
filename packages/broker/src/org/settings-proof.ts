// TE-4 (owner decision 2026-11-02): the commands and dev container in a project's settings are PROVED by a check on a fresh machine, whoever saved them.
//   - A person in a browser saves at once; Rovara then checks exactly what was saved, in the background (`saved`). If the check fails the saver is told and may go back to the last proved setup (`proven`).
//   - A change made with an API key is HELD (`held`): it is not in the settings. It is written only when its own check passes, at the settings revision it was made against.
// This module is the stored record and the pure reading of it. One item per project (`PROJECT#.../SETTINGS_PROOF`); each part is written as a whole, with a condition on the part it replaces. No command text
// is ever shown from here: the lists are kept so the check, the write and the undo use exactly what was proved.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalJson, projectMetaKey, type OrgId, type OrgKey, type ProjectCommand } from "@rovara-code/contracts";
import { type StoredProjectDefinition } from "@agentx/cloud-contracts";

type Send = { send(command: unknown): Promise<unknown> };
export interface ProofStoreDependencies { documentClient: Send; tableName: string; now: () => number }

export interface ProofDevcontainer { repository: string; configPath?: string | undefined }
/** What a check proves: the commands and the dev container they run in. An absent dev container means none. */
export interface ProofLists { setup: ProjectCommand[]; readiness: ProjectCommand[]; devcontainer?: ProofDevcontainer | undefined }

/** The last setup that passed a check. Kept as the lists themselves, so going back needs nothing else. */
export interface ProvenSetup extends ProofLists { revision: number; provenAt: string }

/** A browser save under its background check. */
export interface SavedProof extends ProofLists {
  revision: number; digest: string; checkRequestId: string; by: string; byName: string; slackUserId?: string | undefined; savedAt: string;
  workspaceId?: string | undefined; startedAt?: string | undefined;
  status: "checking" | "not_started" | "failed" | "superseded" | "proven"; reason?: string | undefined;
  /** Set once the saver was told the check failed; the notifier sends the message once. */
  noticeAt?: string | undefined;
}

/** What the API key asked for, held. The body is kept as the person sent it (command lines); the lists are what the save would store and what the check runs. */
export interface HeldBody { setupCommands?: string[] | undefined; testCommands?: string[] | undefined; devcontainer?: { repository: string; configPath?: string | undefined } | null | undefined }
export interface HeldChange {
  requestId: string; checkRequestId: string; digest: string; by: string; byName: string; amr: string; slackUserId?: string | undefined; heldAt: string; baseRevision: number;
  sessionId: string; body: HeldBody; fields: Array<"setupCommands" | "testCommands" | "devcontainer">;
  /** The lists as the save would store them. `devcontainer: null` means the change removes it. */
  lists: { setup: ProjectCommand[]; readiness: ProjectCommand[]; devcontainer?: ProofDevcontainer | null | undefined };
  workspaceId?: string | undefined; startedAt?: string | undefined;
  status: "checking" | "applying" | "applied" | "failed" | "stale" | "refused" | "not_started"; reason?: string | undefined; claimedAt?: string | undefined;
  /** Set once the change ended without being written; the notifier tells the person who sent it, once. */
  noticeAt?: string | undefined;
}

export interface ProofItem { proven?: ProvenSetup; saved?: SavedProof; held?: HeldChange; lastUndo?: { requestId: string; revision: number; at: string } }

export const SETTINGS_PROOF_ENTITY = "PROJECT_SETTINGS_PROOF";
export const settingsProofKey = (orgId: OrgId, project: string): OrgKey => ({ pk: projectMetaKey(orgId, project).pk, sk: "SETTINGS_PROOF" });

/** The lists a stored definition holds. */
export function listsOfDefinition(definition: Pick<StoredProjectDefinition, "setup" | "readiness" | "devcontainer">): ProofLists {
  const devcontainer = definition.devcontainer;
  return {
    setup: [...definition.setup], readiness: [...definition.readiness],
    ...(devcontainer === undefined ? {} : { devcontainer: { repository: devcontainer.repository, ...(devcontainer.configPath === undefined ? {} : { configPath: devcontainer.configPath }) } }),
  };
}

const keyed = (lists: ProofLists) => canonicalJson({ setup: lists.setup, readiness: lists.readiness, devcontainer: lists.devcontainer ?? null });
/** Two list pairs are the same when every command (env and timeout included) and the dev container are identical. */
export const sameProofLists = (left: ProofLists, right: ProofLists): boolean => keyed(left) === keyed(right);

/** The part of the held lists that a stored definition would have once the change is written: a `null` dev container is none. */
export function heldAsLists(lists: HeldChange["lists"], current: ProofLists): ProofLists {
  return { setup: lists.setup, readiness: lists.readiness, ...(lists.devcontainer === undefined ? (current.devcontainer === undefined ? {} : { devcontainer: current.devcontainer }) : lists.devcontainer === null ? {} : { devcontainer: lists.devcontainer }) };
}

export async function readProof(deps: ProofStoreDependencies, orgId: OrgId, project: string): Promise<ProofItem | undefined> {
  const item = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: settingsProofKey(orgId, project), ConsistentRead: true }))) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item.entityType !== SETTINGS_PROOF_ENTITY) return undefined;
  const part = <T>(name: string): T | undefined => (item[name] !== null && typeof item[name] === "object" ? item[name] as T : undefined);
  const proven = part<ProvenSetup>("proven"), saved = part<SavedProof>("saved"), held = part<HeldChange>("held"), lastUndo = part<NonNullable<ProofItem["lastUndo"]>>("lastUndo");
  return { ...(proven === undefined ? {} : { proven }), ...(saved === undefined ? {} : { saved }), ...(held === undefined ? {} : { held }), ...(lastUndo === undefined ? {} : { lastUndo }) };
}

/** The partition the periodic settle reads: one watch per project with a check under way (a saved change or a held one), so nothing waits for a page view. */
export const SETTINGS_PROOF_WATCH_PK = "SETTINGS_PROOF_WATCH";
const watchKey = (orgId: OrgId, project: string): OrgKey => ({ pk: SETTINGS_PROOF_WATCH_PK, sk: `${orgId}#${project}` });

/** The projects whose checks are being waited on, oldest watch first, at most `limit`. */
export async function watchedProofs(deps: ProofStoreDependencies, limit: number): Promise<Array<{ orgId: OrgId; project: string }>> {
  const response = await deps.documentClient.send(new QueryCommand({ TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": SETTINGS_PROOF_WATCH_PK }, Limit: limit, ConsistentRead: true })) as { Items?: Array<{ orgId?: unknown; project?: unknown }> };
  return (response.Items ?? []).flatMap((item) => (typeof item.orgId === "string" && typeof item.project === "string" ? [{ orgId: item.orgId, project: item.project }] : []));
}

/** Whether a project's proof still has a check being waited on. */
export const waitingOn = (proof: ProofItem | undefined): boolean =>
  proof?.saved?.status === "checking" || proof?.held?.status === "checking" || proof?.held?.status === "applying";

export async function dropWatch(deps: ProofStoreDependencies, orgId: OrgId, project: string): Promise<void> {
  await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: watchKey(orgId, project) }));
}

type Part = "proven" | "saved" | "held" | "lastUndo";
interface Guard { expression: string; values: Record<string, unknown>; names?: Record<string, string> }

/**
 * Replaces one part of the item (creating the item when it is not there) when `guard` holds. False when the guard did not: another writer got there first, and the caller reads again.
 */
export async function writePart(deps: ProofStoreDependencies, orgId: OrgId, project: string, part: Part, value: unknown, guard?: Guard): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: settingsProofKey(orgId, project),
      UpdateExpression: `SET entityType = if_not_exists(entityType, :entity), orgId = if_not_exists(orgId, :org), #project = if_not_exists(#project, :project), #part = :value, updatedAt = :now`,
      ...(guard === undefined ? {} : { ConditionExpression: guard.expression }),
      ExpressionAttributeNames: { "#project": "project", "#part": part, ...(guard?.names ?? {}) },
      ExpressionAttributeValues: { ":entity": SETTINGS_PROOF_ENTITY, ":org": orgId, ":project": project, ":value": JSON.parse(JSON.stringify(value)) as unknown, ":now": new Date(deps.now()).toISOString(), ...(guard?.values ?? {}) },
    }));
    // A check now under way is watched, so the periodic settle sees it end whichever way it ends (a result, the 50-minute sweep, a failed dispatch).
    const status = (value as { status?: unknown }).status;
    if ((part === "saved" || part === "held") && (status === "checking" || status === "applying")) {
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...watchKey(orgId, project), entityType: "SETTINGS_PROOF_WATCH", orgId, project, since: new Date(deps.now()).toISOString() } }));
    }
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Replaces the part (`saved` or `held`) only while it is still the one with this check id and status: the writer read it, so a change another reader made meanwhile is not overwritten. */
export const whileStill = (checkRequestId: string, status: string): Guard => ({
  expression: "#part.checkRequestId = :guardId AND #part.#guardStatus = :guardStatus",
  names: { "#guardStatus": "status" },
  values: { ":guardId": checkRequestId, ":guardStatus": status },
});

/** `proven` only moves forward in time: an older proof never replaces a newer one. */
export const provenNotNewerThan = (provenAt: string): Guard => ({ expression: "attribute_not_exists(#part) OR #part.provenAt <= :provenAt", values: { ":provenAt": provenAt } });

/** Fixed words (no command, no name) for the screen and the notice. */
export const PROOF_WORDS = {
  failed: "These commands did not pass the check on a fresh machine.",
  failedWithUndo: "These commands did not pass the check on a fresh machine. You can go back to the last setup that passed.",
  failedNoUndo: "These commands did not pass the check on a fresh machine. No earlier setup was ever proved, so there is nothing to go back to.",
  notStarted: "The check of these commands did not start, so they are not proved.",
  notChecked: "These commands have not been checked yet.",
  superseded: "A newer change started its own check, so this one was stopped.",
  heldChecking: "Rovara is checking this change on a fresh machine. It is not in the settings yet; tasks keep using the commands saved now.",
  heldFailed: "This change did not pass the check on a fresh machine, so it was not saved. Tasks keep using the commands saved now.",
  heldStale: "The settings changed while this change was being checked, so it was not saved. Send it again.",
  heldRefused: "This change passed its check but could not be saved, so nothing was changed.",
  heldNotStarted: "The check of this change did not start, so it was not saved. Send it again.",
  heldTimedOut: "The check of this change did not finish in time, so it was not saved. Send it again.",
  heldGone: "The sign-in of the person who sent this change has ended, or they can no longer change this project's settings, so it was not saved.",
  heldBusy: "A check is already running for this project. Send this change again when it has finished.",
  apiOnly: "Change setup commands in the Rovara app, in a browser, or send them again after the running check.",
  noCheck: "Checking commands on a fresh machine is not set up here, so commands cannot be changed with an API key.",
  needsOwnRequest: "Send repository changes and commands in separate requests.",
  /** UX-4b review I1: with the test environment on, commands are proved there first. */
  provedInTestEnvironment: "With the test environment on, setup and test commands are proved in it before they are used: send them to the test environment (POST /v1/app/projects/{name}/setup-draft/typed), then check, prove and approve them there.",
  undoBrowser: "Go back to the last proved setup in the Rovara app, in a browser.",
  undoSignIn: "Sign in again to go back to the last proved setup.",
  undoNone: "No setup was ever proved for this project, so there is nothing to go back to.",
  undoMaintainer: "Only a project maintainer can go back to the last proved setup.",
} as const;

export const REASON_MAX = 400;
/** A reason for a screen: one line, at most 400 characters. */
export const reasonLine = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const line = [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()].slice(0, REASON_MAX).join("");
  return line === "" ? undefined : line;
};
