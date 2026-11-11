// Rovara Code (Plan 6 Task 18): nudging reviewers.
//
// A pull request that waits for review reminds the people GitHub lists as its requested reviewers, and only those who are members of the org (a linked GitHub account, a live
// membership): the first time `REVIEW_NUDGE_FIRST_HOURS` after the request, then every `REVIEW_NUDGE_REPEAT_HOURS`, at most `REVIEW_NUDGES_MAX` times, on weekdays in UTC (Plan 7's copy
// says so until orgs store a time zone). A reminder is a `review_nudge` milestone to those members (Slack, through the milestone hook) and a Home card (`reviewWaitsOf`); nothing is ever
// posted to GitHub and nothing is sent by email. When the third reminder has had its window and the pull request is still unreviewed, the task's owner is told once (a `stuck`
// milestone).
//
// It runs inside the tracking pass (Task 14) with what that pass already read: it makes no GitHub request and adds no sweep, row or schedule of its own, so it cannot take anything
// from tracking. Each reminder is one transaction: the tracking item's `nudges` (conditioned on the version and digest read, so two runners that meet send once), the milestone (a
// `Put` that only succeeds when absent), the reviewers' Home items, the ledger of who was reminded and a plain line for the owner's timeline. A repeat of a window finds the count moved
// and does nothing. The workflow snapshot is never touched.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { CODE_REVIEWERS_MAX, INDEX_EXPIRY_ATTRIBUTE, REVIEW_NUDGES_MAX, REVIEW_NUDGE_FIRST_HOURS, REVIEW_NUDGE_REPEAT_HOURS, SessionIdSchema, mergeTrackingKey, reviewNudgeLedgerKey, reviewWaitKey, sessionEventId, type OrgId } from "@rovara-code/contracts";
import { MergeTrackingItemSchema, mergeTrackingDecisionDigest, orgMemberKey, type MergeTrackingItem, type WorkflowSnapshot, isWriterOrgRole } from "@agentx/cloud-contracts";
import { errorName, type TransactItem } from "../agents/table-writes.js";
import { sessionEventItem } from "../agent-sessions/store.js";
import { tryEffectiveTaskOwner, type TaskOwnerSource } from "../developer/task-records.js";
import { githubUserOfMember, memberForGithubUser } from "./github-members.js";
import { codeMilestoneItems, deliverCodeMilestones } from "./milestones.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** How long a reviewer's Home item lives after the reminder that wrote it (the table's expiry). Home also checks the pull request itself each time. */
export const REVIEW_WAIT_RETENTION_DAYS = 14;
/** How long the ledger of one pull request's reminders lives after its last write. */
const LEDGER_RETENTION_DAYS = 90;
/** The most Home items read for one reviewer. */
export const REVIEW_WAITS_MAX = 25;
/** The owner's note is milestone number `OWNER_NOTE_N_BASE + <the pull request's place>`, clear of the numbers Task 15 gives its `stuck` milestones (a workflow revision). */
export const OWNER_NOTE_N_BASE = 900_000;

// ---- the schedule

const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
/** Whether a time is on a weekday in UTC. */
export const isWeekdayUtc = (ms: number): boolean => {
  const day = new Date(ms).getUTCDay();
  return day >= 1 && day <= 5;
};
/** A time that falls on a Saturday or a Sunday moves to the Monday that follows, at 00:00 UTC; any other time stays. */
const onWeekday = (ms: number): number => {
  const day = new Date(ms).getUTCDay();
  return day === 6 ? startOfDay(ms) + 2 * DAY_MS : day === 0 ? startOfDay(ms) + DAY_MS : ms;
};

/** Whether the pull request is waiting for someone to review it: open, out of draft, asked of someone and not yet decided. */
function waitingForReview(item: MergeTrackingItem): boolean {
  return item.state === "open" && !item.draft && item.review === "requested";
}

/** When the reviewers were asked: when Rovara asked them, else when the pull request became ready for review (a request GitHub already had, a code owner's). */
function askedAt(item: MergeTrackingItem): number | undefined {
  const stamp = item.reviewersRequestedAt ?? item.readyAt;
  const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * When the next step of the schedule is due, or undefined when there is none: the first reminder `REVIEW_NUDGE_FIRST_HOURS` after the request, each next one `REVIEW_NUDGE_REPEAT_HOURS`
 * after the one before, and, once the third is out, the owner's note one more window later. A time on a weekend moves to Monday 00:00 UTC. A pull request that is not waiting for review has
 * none.
 */
export function nextNudgeAt(item: MergeTrackingItem): number | undefined {
  if (!waitingForReview(item)) return undefined;
  const asked = askedAt(item);
  if (asked === undefined) return undefined;
  const { count } = item.nudges;
  if (count === 0) return onWeekday(asked + REVIEW_NUDGE_FIRST_HOURS * HOUR_MS);
  const lastAt = item.nudges.lastAt === undefined ? Number.NaN : Date.parse(item.nudges.lastAt);
  // A count with no time (it should not happen) counts from where the schedule would have put the last reminder.
  const last = Number.isFinite(lastAt) ? lastAt : asked + REVIEW_NUDGE_FIRST_HOURS * HOUR_MS + REVIEW_NUDGE_REPEAT_HOURS * HOUR_MS * (count - 1);
  // A review asked for again (the reviewersRequestedAt moved on) starts the first window over, whatever the last reminder's time says.
  return onWeekday(Math.max(last + REVIEW_NUDGE_REPEAT_HOURS * HOUR_MS, asked + REVIEW_NUDGE_FIRST_HOURS * HOUR_MS));
}

export interface NudgeDue {
  /** Which reminder this is: 1, 2 or 3. */
  number: number;
  /** The requested reviewers (GitHub user ids) it is for. */
  githubUserIds: string[];
}

/**
 * The reminder that is due now, or undefined: the pull request is waiting for review, someone is asked, fewer than `REVIEW_NUDGES_MAX` have gone out, the schedule says so and now is a
 * weekday in UTC. `requested` is who GitHub lists as asked now (people; teams are not reminded).
 */
export function nudgesDue(item: MergeTrackingItem, requested: readonly string[], now: number): NudgeDue | undefined {
  if (requested.length === 0 || item.nudges.count >= REVIEW_NUDGES_MAX) return undefined;
  const at = nextNudgeAt(item);
  if (at === undefined || now < at || !isWeekdayUtc(now)) return undefined;
  return { number: item.nudges.count + 1, githubUserIds: [...requested] };
}

/** Whether the owner is to be told now: three reminders are out, their last window has passed, someone is still asked, and now is a weekday. */
function ownerNoteDue(item: MergeTrackingItem, requested: readonly string[], now: number): boolean {
  if (requested.length === 0 || item.nudges.count < REVIEW_NUDGES_MAX) return false;
  const at = nextNudgeAt(item);
  return at !== undefined && now >= at && isWeekdayUtc(now);
}

// ---- the ledger and the reviewers' items

export interface NudgeDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
}

type Item = Record<string, unknown>;
interface Recipient { developerId: string; githubUserId: string }
interface Ledger { recipients: Recipient[]; revision: number; ownerToldAt?: string | undefined }

const GITHUB_ID = /^[1-9][0-9]{0,19}$/u;

const recipientOf = (value: unknown): Recipient | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const { developerId, githubUserId } = value as Record<string, unknown>;
  return typeof developerId === "string" && typeof githubUserId === "string" && GITHUB_ID.test(githubUserId) ? { developerId, githubUserId } : undefined;
};

async function readLedger(deps: NudgeDependencies, orgId: OrgId, item: MergeTrackingItem): Promise<Ledger | undefined> {
  const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: reviewNudgeLedgerKey(item.taskId, item.repositoryId, item.number), ConsistentRead: true }))) as { Item?: Item };
  const stored = found.Item;
  if (stored === undefined || stored["orgId"] !== orgId || stored["taskId"] !== item.taskId) return undefined;
  const recipients = Array.isArray(stored["recipients"]) ? stored["recipients"].flatMap((entry) => recipientOf(entry) ?? []) : [];
  const revision = typeof stored["revision"] === "number" && Number.isInteger(stored["revision"]) ? stored["revision"] : 0;
  return { recipients, revision, ...(typeof stored["ownerToldAt"] === "string" ? { ownerToldAt: stored["ownerToldAt"] } : {}) };
}

const isCancelled = (error: unknown): boolean => errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException";

/** One line for a milestone or a session: no @-mentions, no control characters, no double quotes, cut short. */
function inertLine(text: string, max: number): string {
  return [...text.replace(/[\p{Cc}\p{Cf}@]/gu, " ").replace(/"/gu, "'").replace(/\s+/gu, " ").trim()].slice(0, max).join("").trim();
}

export interface NudgeTask {
  taskId: string;
  orgId?: OrgId | undefined;
  sessionId?: string | undefined;
  title?: string | undefined;
  workflow?: WorkflowSnapshot | undefined;
}

export interface NudgeInput {
  /** The task, read fresh by the tracking pass. */
  task: NudgeTask;
  pullRequest: { repositoryId: string; number: number; url: string };
  /** The tracking item as it is stored now (what the pass wrote, or read and left). */
  item: MergeTrackingItem;
  /** Who GitHub lists as asked for a review now, as GitHub user ids; undefined when the pass did not read it (then nothing is sent or taken away). */
  requested: readonly string[] | undefined;
}

export interface NudgeResult {
  sent: "nudge" | "owner_note" | "none";
  /** When the pass should look at the task again for the next step, if nothing wakes it sooner. */
  recheckAt?: number;
}

const taskGuard = (deps: NudgeDependencies, task: NudgeTask & { orgId: OrgId }): TransactItem => ({
  ConditionCheck: {
    TableName: deps.tableName, Key: { pk: `DEVTASK#${task.taskId}`, sk: "META" },
    ConditionExpression: "orgId = :org AND attribute_not_exists(closedAt) AND attribute_not_exists(releasedAt)", ExpressionAttributeValues: { ":org": task.orgId },
  },
});

/** Writes the tracking item's next `nudges`, conditioned on the version and the digest read: the one writer that changes it wins, the other changes nothing. */
function nudgesUpdate(deps: NudgeDependencies, item: MergeTrackingItem, nudges: MergeTrackingItem["nudges"]): TransactItem {
  return { Update: {
    TableName: deps.tableName, Key: mergeTrackingKey(item.taskId, item.repositoryId, item.number),
    UpdateExpression: "SET #nudges = :nudges, #version = :next, #digest = :digest",
    ConditionExpression: "#version = :version AND #digest = :priorDigest AND orgId = :org AND taskId = :task",
    ExpressionAttributeNames: { "#nudges": "nudges", "#version": "version", "#digest": "decisionDigest" },
    ExpressionAttributeValues: {
      ":nudges": nudges, ":next": item.version + 1, ":digest": mergeTrackingDecisionDigest({ ...item, nudges }), ":version": item.version, ":priorDigest": item.decisionDigest,
      ":org": item.orgId, ":task": item.taskId,
    },
  } };
}

/** The ledger's write: an update that creates it when it is not there, conditioned on the revision read (a ledger that is not there is created only if still not there). */
function ledgerUpdate(deps: NudgeDependencies, item: MergeTrackingItem, ledger: Ledger | undefined, change: { recipients: Recipient[]; at: string; nudge?: number; ownerToldAt?: string }, now: number): TransactItem {
  const sets = [
    "entityType = :entity", "orgId = :org", "taskId = :task", "repositoryId = :repository", "#number = :number", "recipients = :recipients", "#revision = :next", "updatedAt = :at", "#expires = :expires",
    ...(change.nudge === undefined ? [] : ["lastNudge = :nudge"]), ...(change.ownerToldAt === undefined ? [] : ["ownerToldAt = :told"]),
  ];
  return { Update: {
    TableName: deps.tableName, Key: reviewNudgeLedgerKey(item.taskId, item.repositoryId, item.number),
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: ledger === undefined ? "attribute_not_exists(pk)" : "#revision = :revision",
    ExpressionAttributeNames: { "#number": "number", "#revision": "revision", "#expires": INDEX_EXPIRY_ATTRIBUTE },
    ExpressionAttributeValues: {
      ":entity": "REVIEW_NUDGE_LEDGER", ":org": item.orgId, ":task": item.taskId, ":repository": item.repositoryId, ":number": item.number, ":recipients": change.recipients,
      ":next": (ledger?.revision ?? 0) + 1, ":at": change.at, ":expires": Math.floor(now / 1000) + LEDGER_RETENTION_DAYS * 86_400,
      ...(ledger === undefined ? {} : { ":revision": ledger.revision }),
      ...(change.nudge === undefined ? {} : { ":nudge": change.nudge }), ...(change.ownerToldAt === undefined ? {} : { ":told": change.ownerToldAt }),
    },
  } };
}

const waitKeyOf = (item: MergeTrackingItem, developerId: string) => reviewWaitKey(item.orgId, developerId, item.taskId, item.repositoryId, item.number);

/** Takes away the reminders of the people who are no longer asked (they reviewed, or were taken off), or of everyone once the pull request is no longer waiting. Returns the ledger as it is then. */
async function settleLedger(deps: NudgeDependencies, item: MergeTrackingItem, ledger: Ledger | undefined, requested: readonly string[]): Promise<Ledger | undefined> {
  if (ledger === undefined) return undefined;
  const waiting = waitingForReview(item);
  const stale = ledger.recipients.filter((recipient) => !waiting || !requested.includes(recipient.githubUserId));
  if (stale.length === 0) return ledger;
  const kept = ledger.recipients.filter((recipient) => !stale.includes(recipient));
  const now = deps.now();
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
      ...stale.map((recipient): TransactItem => ({ Delete: { TableName: deps.tableName, Key: waitKeyOf(item, recipient.developerId) } })),
      ledgerUpdate(deps, item, ledger, { recipients: kept, at: new Date(now).toISOString() }, now),
    ] }));
  } catch (error) {
    if (isCancelled(error)) return ledger;
    throw error;
  }
  return { ...ledger, recipients: kept, revision: ledger.revision + 1 };
}

/** The members among the requested reviewers: a linked GitHub account of a person who is a member of the org now, at most `CODE_REVIEWERS_MAX`. Nothing else is learned or kept about the others. */
async function recipientsAmong(deps: NudgeDependencies, orgId: OrgId, githubUserIds: readonly string[]): Promise<Recipient[]> {
  const found: Recipient[] = [];
  const memberDeps = { documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now };
  for (const githubUserId of githubUserIds) {
    if (found.length >= CODE_REVIEWERS_MAX) break;
    const developerId = await memberForGithubUser(memberDeps, orgId, githubUserId);
    if (developerId === undefined || developerId.includes("#") || /[\p{Cc}\p{Cf}]/u.test(developerId) || found.some((entry) => entry.developerId === developerId)) continue;
    // The link must still be the member's own, and the member must still be in the org.
    if (await githubUserOfMember(memberDeps, orgId, developerId) !== githubUserId) continue;
    const member = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: orgMemberKey(orgId, developerId), ConsistentRead: true }))) as { Item?: Item }).Item;
    if (member === undefined || !isWriterOrgRole(member["role"])) continue;
    found.push({ developerId, githubUserId });
  }
  return found;
}

// ---- sending

const placeOf = (task: NudgeTask, pullRequest: NudgeInput["pullRequest"]): number =>
  Math.max(0, (task.workflow?.pullRequests ?? []).findIndex((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number));

const titleOf = (task: NudgeTask, pullRequest: NudgeInput["pullRequest"]): string =>
  inertLine(task.title ?? "", 100) || `${inertLine(pullRequest.repositoryId, 60)} pull request ${String(pullRequest.number)}`;

async function sendNudge(deps: NudgeDependencies, input: NudgeInput & { task: NudgeTask & { orgId: OrgId } }, due: NudgeDue, ledger: Ledger | undefined): Promise<NudgeResult> {
  const { task, pullRequest, item } = input;
  const now = deps.now();
  const stamp = new Date(now).toISOString();
  const recipients = await recipientsAmong(deps, task.orgId, due.githubUserIds);
  // Nobody who is a member is asked: nothing is sent and none of the three is used up.
  if (recipients.length === 0) return { sent: "none" };
  const asked = askedAt(item) ?? now;
  const days = Math.max(1, Math.floor((now - asked) / DAY_MS));
  const place = placeOf(task, pullRequest);
  // People reminded before who are not among those reminded now (they reviewed, were taken off, or left the org) lose their Home item in the same transaction.
  const gone = (ledger?.recipients ?? []).filter((entry) => !recipients.some((next) => next.developerId === entry.developerId));
  const nudges = { count: due.number, lastAt: stamp };
  const items: TransactItem[] = [
    taskGuard(deps, task),
    nudgesUpdate(deps, item, nudges),
    ledgerUpdate(deps, item, ledger, { recipients, at: stamp, nudge: due.number }, now),
    ...recipients.map((recipient): TransactItem => ({ Put: { TableName: deps.tableName, Item: {
      ...waitKeyOf(item, recipient.developerId), entityType: "REVIEW_WAIT", orgId: item.orgId, developerId: recipient.developerId, githubUserId: recipient.githubUserId, taskId: item.taskId,
      repositoryId: item.repositoryId, number: item.number, since: new Date(asked).toISOString(), at: stamp, nudge: due.number,
      [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / 1000) + REVIEW_WAIT_RETENTION_DAYS * 86_400,
    } } })),
    ...gone.map((entry): TransactItem => ({ Delete: { TableName: deps.tableName, Key: waitKeyOf(item, entry.developerId) } })),
    ...codeMilestoneItems({ tableName: deps.tableName }, {
      kind: "review_nudge", orgId: task.orgId, taskId: task.taskId, at: stamp,
      // The text goes to Slack for every recipient, and a reviewer may not be allowed to view the session: it names the pull request, never the task's words.
      text: `${inertLine(pullRequest.repositoryId, 60)} #${String(pullRequest.number)} has been waiting for your review for ${String(days)} ${days === 1 ? "day" : "days"}`,
      pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }], to: recipients.map((recipient) => recipient.developerId),
    }, place * REVIEW_NUDGES_MAX + due.number - 1, { definitionVersion: task.workflow?.definitionVersion ?? "1.1.0" }),
  ];
  if (task.sessionId !== undefined && SessionIdSchema.safeParse(task.sessionId).success) {
    items.push(sessionEventItem({ tableName: deps.tableName }, { orgId: task.orgId, sessionId: task.sessionId }, {
      eventId: sessionEventId("review_nudge", `${task.taskId}\n${pullRequest.repositoryId}\n${String(pullRequest.number)}\n${String(due.number)}`), at: stamp, type: "status", actor: { kind: "system" },
      text: `Rovara reminded the requested reviewers of ${inertLine(pullRequest.repositoryId, 60)} pull request ${String(pullRequest.number)} (reminder ${String(due.number)} of ${String(REVIEW_NUDGES_MAX)}).`,
    }));
  }
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    // The item moved on (a pass of another runner wrote it, or sent this reminder first), or the task ended: nothing was written, the next pass looks again.
    if (isCancelled(error)) return { sent: "none" };
    throw error;
  }
  await deliverCodeMilestones({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, task.taskId).catch(() => undefined);
  const after = nextNudgeAt({ ...item, nudges });
  return { sent: "nudge", ...(after !== undefined && after > now ? { recheckAt: after } : {}) };
}

async function sendOwnerNote(deps: NudgeDependencies, input: NudgeInput & { task: NudgeTask & { orgId: OrgId } }, ledger: Ledger | undefined): Promise<NudgeResult> {
  const { task, pullRequest, item } = input;
  const now = deps.now();
  const stamp = new Date(now).toISOString();
  const owner = tryEffectiveTaskOwner(task as unknown as TaskOwnerSource);
  const items: TransactItem[] = [
    taskGuard(deps, task),
    // The tracking item is only checked here: the note changes nothing on it. The ledger's `ownerToldAt` is what makes the note once.
    { ConditionCheck: {
      TableName: deps.tableName, Key: mergeTrackingKey(item.taskId, item.repositoryId, item.number),
      ConditionExpression: "#version = :version AND #digest = :digest AND orgId = :org AND taskId = :task",
      ExpressionAttributeNames: { "#version": "version", "#digest": "decisionDigest" },
      ExpressionAttributeValues: { ":version": item.version, ":digest": item.decisionDigest, ":org": item.orgId, ":task": item.taskId },
    } },
    ledgerUpdate(deps, item, ledger, { recipients: ledger?.recipients ?? [], at: stamp, ownerToldAt: stamp }, now),
    ...codeMilestoneItems({ tableName: deps.tableName }, {
      kind: "stuck", orgId: task.orgId, taskId: task.taskId, ...(task.sessionId !== undefined && SessionIdSchema.safeParse(task.sessionId).success ? { sessionId: task.sessionId } : {}), at: stamp,
      text: `Nobody has reviewed "${titleOf(task, pullRequest)}" after ${String(REVIEW_NUDGES_MAX)} reminders. You may want to ask someone directly.`,
      pullRequests: [{ repository: pullRequest.repositoryId, number: pullRequest.number, url: pullRequest.url }], ...(owner === undefined ? {} : { to: [owner.developerId] }),
    }, OWNER_NOTE_N_BASE + placeOf(task, pullRequest), { definitionVersion: task.workflow?.definitionVersion ?? "1.1.0" }),
  ];
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (isCancelled(error)) return { sent: "none" };
    throw error;
  }
  await deliverCodeMilestones({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, task.taskId).catch(() => undefined);
  return { sent: "owner_note" };
}

// ---- the pass

/**
 * What the tracking pass does about reviewers after it has read and written one pull request: takes back the reminders that no longer apply, sends the reminder that is due (at most one,
 * to the members among the requested reviewers), or tells the owner once when three reminders went unanswered. Never throws: a failure is logged with a fixed word and the next pass
 * looks again. Sends nothing for a task that has ended (the transaction checks the task), and nothing without the pass's own list of who is asked.
 */
export async function runReviewNudges(deps: NudgeDependencies, input: NudgeInput): Promise<NudgeResult> {
  try {
    const { task, item } = input;
    if (task.orgId === undefined || item.orgId !== task.orgId || item.taskId !== task.taskId) return { sent: "none" };
    const guarded = input as NudgeInput & { task: NudgeTask & { orgId: OrgId } };
    const now = deps.now();
    const future = (at: number | undefined): { recheckAt?: number } => (at !== undefined && at > now ? { recheckAt: at } : {});
    if (input.requested === undefined) return { sent: "none", ...(item.nudges.count < REVIEW_NUDGES_MAX ? future(nextNudgeAt(item)) : {}) };
    let ledger = item.nudges.count > 0 ? await readLedger(deps, task.orgId, item) : undefined;
    if (ledger !== undefined) ledger = await settleLedger(deps, item, ledger, input.requested);
    // A fix round (or anything but the wait for the merge) is running: the code under review is about to change, so nobody is reminded now. The clock runs on.
    if (task.workflow !== undefined && (task.workflow.stage !== "WAIT_FOR_MERGE" || task.workflow.state !== "WAITING")) return { sent: "none" };
    const due = nudgesDue(item, input.requested, now);
    if (due !== undefined) {
      const sent = await sendNudge(deps, guarded, due, ledger);
      if (sent.sent === "nudge") return sent;
    } else if (ownerNoteDue(item, input.requested, now) && ledger?.ownerToldAt === undefined) {
      return await sendOwnerNote(deps, guarded, ledger);
    }
    // Not sent: when the next step is due, unless the owner has been told already.
    const finished = item.nudges.count >= REVIEW_NUDGES_MAX && (ledger?.ownerToldAt !== undefined || input.requested.length === 0);
    return { sent: "none", ...(finished ? {} : future(nextNudgeAt(item))) };
  } catch (error) {
    deps.log?.("review_nudge.failed", { error: errorName(error) ?? "unknown" });
    return { sent: "none" };
  }
}

// ---- what Home reads

export interface ReviewWait {
  taskId: string;
  repositoryId: string;
  number: number;
  githubUserId: string;
  /** When the reviewers were asked. */
  since: string;
  /** When the latest reminder was sent. */
  at: string;
  /** Which reminder that was. */
  nudge: number;
}

/** The pull requests one member was reminded of (their own partition of the org, at most `REVIEW_WAITS_MAX`, expired ones left out). Home checks each against the live pull request before it shows it. */
export async function reviewWaitsOf(deps: Pick<NudgeDependencies, "documentClient" | "tableName"> & { now?: () => number }, orgId: OrgId, developerId: string): Promise<ReviewWait[]> {
  if (developerId.includes("#") || /[\p{Cc}\p{Cf}]/u.test(developerId)) return [];
  const pk = reviewWaitKey(orgId, developerId, "x", "x", 1).pk;
  const page = (await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true, Limit: REVIEW_WAITS_MAX,
  }))) as { Items?: Item[] };
  const nowSeconds = deps.now === undefined ? undefined : Math.floor(deps.now() / 1000);
  const waits: ReviewWait[] = [];
  for (const stored of page.Items ?? []) {
    const { taskId, repositoryId, number, githubUserId, since, at, nudge } = stored;
    const expires = stored[INDEX_EXPIRY_ATTRIBUTE];
    if (stored["orgId"] !== orgId || stored["developerId"] !== developerId || (nowSeconds !== undefined && typeof expires === "number" && expires <= nowSeconds)) continue;
    if (typeof taskId !== "string" || typeof repositoryId !== "string" || typeof number !== "number" || !Number.isInteger(number) || number < 1 || typeof githubUserId !== "string"
      || typeof since !== "string" || typeof at !== "string" || typeof nudge !== "number") continue;
    waits.push({ taskId, repositoryId, number, githubUserId, since, at, nudge });
  }
  return waits;
}

const TRACKING_FIELDS = Object.keys(MergeTrackingItemSchema.shape);

/** One tracking item as the schema reads it, or undefined (an item of another org or task, or one that does not read, is none). */
export async function trackingItemFor(
  deps: Pick<NudgeDependencies, "documentClient" | "tableName">, orgId: OrgId, taskId: string, repositoryId: string, number: number,
): Promise<MergeTrackingItem | undefined> {
  if (repositoryId.includes("#") || repositoryId === "" || taskId.includes("#") || !Number.isInteger(number) || number < 1) return undefined;
  const stored = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: mergeTrackingKey(taskId, repositoryId, number), ConsistentRead: true }))) as { Item?: Item }).Item;
  if (stored === undefined || stored["orgId"] !== orgId || stored["taskId"] !== taskId) return undefined;
  const picked: Item = {};
  for (const field of TRACKING_FIELDS) if (stored[field] !== undefined) picked[field] = stored[field];
  const parsed = MergeTrackingItemSchema.safeParse(picked);
  return parsed.success ? parsed.data : undefined;
}
