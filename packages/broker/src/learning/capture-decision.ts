// v1.2 learning loop B4: a plan send-back becomes a correction, automatically (design 2.2, 2.4, test I1b).
//
// The one hook is in `decideTaskWorkflow` (aws/developer-tasks.ts), which every surface reaches: the task page, the developer API, Slack and MCP. It calls `captureSendBackQuietly` after a
// REQUEST_CHANGES decision on a requirements, design or plan document has committed.
//
// Standing is the DECIDER's, read live from the company and project records (standing.ts), never the task role: an owner who took a task over as a viewer, as a commenter or with no
// grant can send a plan back (review Critical 1), and that person's reason is stored as `outsider` and never grouped. Each included comment keeps its own author's standing. Nothing the
// request says about standing, author or stage is read.
//
// What is written:
//   - one correction from the note (source `send_back`, source key `decision#<task>#<request>`), unless the note is the page's default text, generic, or under 20 characters;
//   - one correction per included comment (same source, source key `comment#<task>#<comment>` as Remember uses, so a comment is one correction however it got here), `linkedTo` the
//     note's correction when that one was created now. They are all of one task, so grouping counts them as one task.
// Automatic captures carry no `rememberedBy`; Forget then allows the author or a maintainer. A forgotten send-back keeps its source record, so a retry does not bring it back.
// Then `groupCorrections` runs once if anything was created.
//
// Capture never fails the send-back: `captureSendBackQuietly` catches everything and logs fixed words (never the text).
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import { OrgRoleSchema, orgMemberKey, projectMemberKey, projectMetaKey, type LearningCorrection, type LearningStanding, type OrgId, type TaskComment } from "@agentx/contracts";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { DeveloperTaskRouteDependencies } from "../aws/developer-tasks.js";
import { readProjectMeta } from "../developer/project-roles.js";
import { COMMENT_STAGE, commentSourceKey } from "./capture-comment.js";
import { groupCorrections } from "./grouping.js";
import { signatureOf } from "./similarity.js";
import { learningSalt, learningScopeOf, readStanding } from "./standing.js";
import { captureCorrection, type CaptureInput, type LearningDeps, type LearningScope } from "./store.js";
import { prepareCorrection } from "./text.js";

type TransactItem = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]["TransactItems"]>[number];
type CaptureDeps = Pick<DeveloperTaskRouteDependencies, "documentClient" | "tableName" | "now" | "log">;

export interface SendBackInput {
  /** The person who decided: their standing is read here. */
  caller: DeveloperCaller;
  taskId: string;
  project: string;
  requestId: string;
  /** The note the person wrote (the page's note, or the reason Slack and MCP send). The page's default text is recognised as generic. */
  reason: string;
  /** The comments the decision sent along, as the decision locked them. */
  included: readonly TaskComment[];
}
export interface SendBackOutcome {
  /** Ids of the corrections created by this call (empty on a repeat). */
  created: string[];
}

/** The source key of a send-back: one correction per (task, decision request). */
export const sendBackSourceKey = (taskId: string, requestId: string): string => `decision#${taskId}#${requestId}`;
const correctionIdOf = (sourceKey: string): string => createHash("sha256").update(`learning-correction\0${sourceKey}`, "utf8").digest("hex").slice(0, 32);
const learningDepsOf = (deps: CaptureDeps): LearningDeps => ({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now });

// ---- the standing guard: ConditionChecks carried by the capture's own transaction
//
// The standing is read before the write. Without a guard, a person demoted or removed (or a project archived) between the two would still be stored as a member. These items re-assert, in the
// same transaction, what the read saw. They are appended after the store's own items, so the store's item indexes do not move. (A store-level `conditions` input is the same idea; when it
// lands, pass these items through it and drop `guarded`.)

type Row = Record<string, unknown>;
const readRow = async (deps: CaptureDeps, key: { pk: string; sk: string }): Promise<Row | undefined> =>
  ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;

/** ConditionChecks for a member: the company member record (same person, same role), the grant (contributor or maintainer) unless owner or admin, and the project (active, same instance). */
export async function standingConditions(deps: CaptureDeps, orgId: OrgId, developerId: string, project: string): Promise<TransactItem[]> {
  const table = deps.tableName;
  const member = await readRow(deps, orgMemberKey(orgId, developerId));
  const role = OrgRoleSchema.safeParse(member?.["role"]);
  const meta = await readProjectMeta(deps, orgId, project);
  if (member === undefined || !role.success || meta === undefined) throw new Error("the records that make a member could not be read");
  const items: TransactItem[] = [
    { ConditionCheck: { TableName: table, Key: orgMemberKey(orgId, developerId), ConditionExpression: "orgId = :org AND developerId = :dev AND #role = :role",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":org": orgId, ":dev": developerId, ":role": role.data } } },
    { ConditionCheck: { TableName: table, Key: projectMetaKey(orgId, project), ConditionExpression: "#status = :active AND createdAt = :createdAt",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":active": "active", ":createdAt": meta.createdAt } } },
  ];
  if (role.data !== "owner" && role.data !== "admin") {
    items.push({ ConditionCheck: { TableName: table, Key: projectMemberKey(orgId, developerId, project),
      ConditionExpression: "#role = :developer AND (attribute_not_exists(projectRole) OR projectRole = :contributor OR projectRole = :maintainer)",
      ExpressionAttributeNames: { "#role": "role" }, ExpressionAttributeValues: { ":developer": "developer", ":contributor": "contributor", ":maintainer": "maintainer" } } });
  }
  return items;
}

class GuardFailed extends Error { constructor() { super("the standing changed while the correction was being written"); this.name = "GuardFailed"; } }

/** A document client that adds `conditions` to the transaction that writes a correction, and says so (`GuardFailed`) when one of them is what cancelled it. */
function guarded(client: LearningDeps["documentClient"], conditions: readonly TransactItem[]): LearningDeps["documentClient"] {
  if (conditions.length === 0) return client;
  return {
    async send(command: unknown): Promise<unknown> {
      const input = command instanceof TransactWriteCommand ? command.input : undefined;
      const base = input?.TransactItems ?? [];
      if (input === undefined || !base.some((item) => (item.Put?.Item as Row | undefined)?.["entityType"] === "LEARNING_CORRECTION")) return client.send(command);
      try {
        return await client.send(new TransactWriteCommand({ ...input, TransactItems: [...base, ...conditions] }));
      } catch (error) {
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons ?? [];
        if (reasons.some((reason, index) => index >= base.length && reason.Code === "ConditionalCheckFailed")) throw new GuardFailed();
        throw error;
      }
    },
  };
}

// ---- capture

const COMMENTS_MAX = 25;

interface Written { created: LearningCorrection | undefined; id: string | undefined }

async function standingOf(deps: CaptureDeps, cache: Map<string, LearningStanding>, orgId: OrgId, developerId: string, project: string): Promise<LearningStanding> {
  const known = cache.get(developerId);
  if (known !== undefined) return known;
  const standing = await readStanding(deps, orgId, developerId, project);
  cache.set(developerId, standing);
  return standing;
}

async function write(deps: CaptureDeps, scope: LearningScope, input: CaptureInput, standing: LearningStanding): Promise<Written | "refused"> {
  const learning = learningDepsOf(deps);
  const conditions = standing === "member" ? await standingConditions(deps, scope.orgId, input.author, scope.project) : [];
  try {
    const result = await captureCorrection({ ...learning, documentClient: guarded(learning.documentClient, conditions) }, scope, input);
    if (!result.ok) return "refused";
    return result.created ? { created: result.correction, id: result.correction.id } : { created: undefined, id: undefined };
  } catch (error) {
    if (error instanceof GuardFailed) return "refused";
    throw error;
  }
}

/**
 * Captures a send-back: the note, then each included comment. Throws when the standing or the store cannot be read (callers log and carry on, see `captureSendBackQuietly`). A repeat of
 * the same decision creates nothing.
 */
export async function captureSendBack(deps: CaptureDeps, input: SendBackInput): Promise<SendBackOutcome> {
  const { caller, taskId, project, requestId } = input;
  const outcome: SendBackOutcome = { created: [] };
  const note = prepareCorrection(input.reason);
  const comments = input.included.slice(0, COMMENTS_MAX).flatMap((comment) => {
    if (comment.author.kind !== "person" || comment.deletedAt !== undefined) return [];
    const prepared = prepareCorrection(comment.text);
    return prepared.ok ? [{ comment, authorId: comment.author.developerId, text: prepared.text }] : [];
  });
  if (!note.ok && comments.length === 0) return outcome;

  const scope = await learningScopeOf(deps, caller.orgId, project);
  if (scope === undefined) return outcome;
  const salt = learningSalt(scope);
  const cache = new Map<string, LearningStanding>();

  let mainId: string | undefined;
  if (note.ok) {
    const sourceKey = sendBackSourceKey(taskId, requestId);
    const standing = await standingOf(deps, cache, caller.orgId, caller.developerId, project);
    const written = await write(deps, scope, {
      id: correctionIdOf(sourceKey), stage: COMMENT_STAGE, source: "send_back", sourceKey, sourceRef: { taskId, decisionRequestId: requestId }, taskId, text: note.text,
      signature: [...signatureOf(note.text, salt)], author: caller.developerId, standing, limit: "automatic",
    }, standing);
    if (written !== "refused" && written.created !== undefined) {
      mainId = written.created.id;
      outcome.created.push(mainId);
    }
  }

  for (const entry of comments) {
    try {
      const sourceKey = commentSourceKey(taskId, entry.comment.commentId);
      const standing = await standingOf(deps, cache, caller.orgId, entry.authorId, project);
      const written = await write(deps, scope, {
        id: correctionIdOf(sourceKey), stage: COMMENT_STAGE, source: "send_back", sourceKey, sourceRef: { taskId, commentId: entry.comment.commentId, decisionRequestId: requestId }, taskId, text: entry.text,
        signature: [...signatureOf(entry.text, salt)], author: entry.authorId, standing, ...(mainId === undefined ? {} : { linkedTo: mainId }), limit: "automatic",
      }, standing);
      if (written !== "refused" && written.created !== undefined) outcome.created.push(written.created.id);
    } catch (error) {
      // One comment that cannot be captured does not stop the others.
      logFailure(deps, taskId, "comment", error);
    }
  }

  if (outcome.created.length > 0) {
    try {
      await groupCorrections(learningDepsOf(deps), scope);
    } catch (error) {
      logFailure(deps, taskId, "grouping", error);
    }
  }
  return outcome;
}

function logFailure(deps: CaptureDeps, taskId: string, step: string, error: unknown): void {
  const entry = { event: "learning.send_back_capture_failed", taskId, step, errorName: error instanceof Error ? error.name : "unknown" };
  try {
    (deps.log ?? ((line) => console.log(JSON.stringify({ component: "broker", ...line }))))(entry);
  } catch {
    // Logging must not fail the send-back either.
  }
}

/** The hook's entry point: capture, and never fail the send-back. A failure is logged with fixed words (no text, no ids but the task's). */
export async function captureSendBackQuietly(deps: CaptureDeps, input: SendBackInput): Promise<void> {
  try {
    await captureSendBack(deps, input);
  } catch (error) {
    logFailure(deps, input.taskId, "capture", error);
  }
}
