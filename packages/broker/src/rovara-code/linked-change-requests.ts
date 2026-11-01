// P6 (Enterprise foundations): the reverse link from a published change request to its task, keyed by the neutral repository identity.
//
// Until now the link was `GITHUB_PR#<owner/repo>` / `PR#<number>` (task-records.ts `githubWorkflowPullRequestKey`), so only GitHub could have one. A link now has a neutral key,
// `CODEHOST_CR#<kind>#<repository key>` / `CR#<id>`, and every reader reads BOTH: the neutral row first, then (for GitHub only) the old row. There is no migration and the old
// rows are not rewritten. This is the reader-first step: the writer for a repository on another code host is this module's `linkedChangeRequestItem`; the GitHub writer is unchanged
// (the old row carries a candidate digest that later steps update, so writing two copies of it is a later step, when the old row can be retired).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { PluginKind } from "@agentx/contracts";
import { githubWorkflowPullRequestKey, type GithubWorkflowPullRequestRecord } from "../developer/task-records.js";
import { codeHostRepositoryKey } from "../plugins/events/repository-key.js";

export const LINKED_CHANGE_REQUEST_ENTITY = "CODEHOST_WORKFLOW_CR";

/** A change request id the key can hold: the host's own id, no `#`, no control characters. Whole numbers are zero-padded so they sort, as the old key's pull request numbers did. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface LinkedChangeRequestRecord {
  pk: string;
  sk: string;
  entityType: typeof LINKED_CHANGE_REQUEST_ENTITY;
  hostKind: PluginKind;
  repositoryKey: string;
  changeRequestId: string;
  /** The project's name for the repository. */
  repositoryId: string;
  /** The change request's number, for a host whose ids are whole numbers (the workflow records one). */
  number: number;
  url: string;
  taskId: string;
  workspaceId: string;
  candidateDigest: string;
  createdAt: string;
}

/** The link as a reader sees it, whichever row held it. */
export interface LinkedChangeRequest {
  source: "neutral" | "github-legacy";
  hostKind: PluginKind;
  repositoryKey: string;
  changeRequestId: string;
  repositoryId: string;
  number: number;
  url: string;
  taskId: string;
  workspaceId: string;
  candidateDigest: string;
}

/** The neutral key of a link, or undefined when the repository address or the id cannot be keyed (a reader then finds no link). */
export function linkedChangeRequestKey(hostKind: PluginKind, repositoryAddress: string, id: string): { pk: string; sk: string } | undefined {
  const repositoryKey = codeHostRepositoryKey(hostKind, repositoryAddress);
  if (repositoryKey === undefined || !ID.test(id)) return undefined;
  return { pk: `CODEHOST_CR#${hostKind}#${repositoryKey}`, sk: `CR#${/^[0-9]{1,10}$/.test(id) ? id.padStart(10, "0") : id}` };
}

/** The Put for a new link on a host other than GitHub (`attribute_not_exists` so a second task can never take a change request). Undefined when it cannot be keyed. */
export function linkedChangeRequestItem(tableName: string, input: Omit<LinkedChangeRequestRecord, "pk" | "sk" | "entityType" | "repositoryKey" | "changeRequestId"> & { repositoryAddress: string; changeRequestId: string }): { Put: { TableName: string; Item: LinkedChangeRequestRecord; ConditionExpression: string } } | undefined {
  const key = linkedChangeRequestKey(input.hostKind, input.repositoryAddress, input.changeRequestId);
  const repositoryKey = codeHostRepositoryKey(input.hostKind, input.repositoryAddress);
  if (key === undefined || repositoryKey === undefined) return undefined;
  const { hostKind, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt } = input;
  return { Put: { TableName: tableName, ConditionExpression: "attribute_not_exists(pk)", Item: { ...key, entityType: LINKED_CHANGE_REQUEST_ENTITY, hostKind, repositoryKey, changeRequestId, repositoryId, number, url, taskId, workspaceId, candidateDigest, createdAt } } };
}

export interface LinkedReaderDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
}

/** The old GitHub link (`GITHUB_PR#<owner/repo>`), as it was read before P6: only an already-published pull request, and only when the row says what its key says. */
export async function findLegacyGithubLink(deps: LinkedReaderDependencies, input: { repositoryFullName: string; number: number }): Promise<GithubWorkflowPullRequestRecord | undefined> {
  let key: ReturnType<typeof githubWorkflowPullRequestKey>;
  try {
    key = githubWorkflowPullRequestKey(input.repositoryFullName, input.number);
  } catch {
    return undefined;
  }
  const result = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> };
  const item = result.Item;
  if (item?.entityType !== "GITHUB_WORKFLOW_PR" || typeof item.repositoryFullName !== "string" || item.repositoryFullName.toLowerCase() !== input.repositoryFullName.toLowerCase()
    || item.number !== input.number || typeof item.repositoryId !== "string" || typeof item.taskId !== "string"
    || typeof item.workspaceId !== "string" || typeof item.candidateDigest !== "string" || typeof item.url !== "string") return undefined;
  return item as unknown as GithubWorkflowPullRequestRecord;
}

/**
 * The task a change request is linked to, or undefined. Reads the neutral row, then the old GitHub row (GitHub only). A row that does not say what its key says (another
 * host, another repository, another id) is not a link. The old row is read as it was: its repository name and number must match the ones asked for.
 */
export async function findLinkedChangeRequest(
  deps: LinkedReaderDependencies,
  query: { hostKind: PluginKind; repositoryAddress: string; id: string },
): Promise<LinkedChangeRequest | undefined> {
  const key = linkedChangeRequestKey(query.hostKind, query.repositoryAddress, query.id);
  const repositoryKey = codeHostRepositoryKey(query.hostKind, query.repositoryAddress);
  if (key === undefined || repositoryKey === undefined) return undefined;
  const stored = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (stored !== undefined) {
    const item = stored;
    const valid = item.entityType === LINKED_CHANGE_REQUEST_ENTITY && item.hostKind === query.hostKind && item.repositoryKey === repositoryKey && item.changeRequestId === query.id
      && typeof item.repositoryId === "string" && typeof item.number === "number" && Number.isSafeInteger(item.number) && typeof item.url === "string"
      && typeof item.taskId === "string" && typeof item.workspaceId === "string" && typeof item.candidateDigest === "string";
    // A row under this key that is not a link for it is a refusal, not a miss to be filled from the old row.
    if (!valid) return undefined;
    return {
      source: "neutral", hostKind: query.hostKind, repositoryKey, changeRequestId: query.id, repositoryId: item.repositoryId as string, number: item.number as number,
      url: item.url as string, taskId: item.taskId as string, workspaceId: item.workspaceId as string, candidateDigest: item.candidateDigest as string,
    };
  }
  if (query.hostKind !== "github" || !/^[1-9][0-9]{0,9}$/.test(query.id)) return undefined;
  const legacy = await findLegacyGithubLink(deps, { repositoryFullName: repositoryKey, number: Number(query.id) });
  if (legacy === undefined) return undefined;
  return {
    source: "github-legacy", hostKind: "github", repositoryKey, changeRequestId: query.id, repositoryId: legacy.repositoryId, number: legacy.number, url: legacy.url,
    taskId: legacy.taskId, workspaceId: legacy.workspaceId, candidateDigest: legacy.candidateDigest,
  };
}
