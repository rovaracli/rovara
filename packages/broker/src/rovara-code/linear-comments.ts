// Live interaction L1: a Linear comment on an issue that a session follows. Linear is ASK-ONLY (owner decision 2026-10-31): `@rovara ask <question>` becomes an Ask for the Linear audience; anything else
// that talks to Rovara (stop it, change it, approve it, do something) gets one reply with a link to the task page and changes nothing. No stop, no redirect, no instruction, no approval ever comes from
// Linear: there is no Linear-user-to-member link yet, so every Linear author is an outsider and the answer is built for the Linear audience only (the title, stage, next step, block reason and what
// Rovara already posted there; no plan text, diff, checks or notes; `ask-context.ts`).
//
// What this module believes: nothing that the hook ingress has not already verified (the delivery's signature over its own bytes and the hook's Linear organization, `triggers/ingress.ts`), and then
// only a comment on an issue that a session in THIS hook's org and project is bound to (`sessionForSurface`). A comment on any other issue, from an application or integration, without the trigger
// phrase, or older than its handled marker is ignored and writes nothing. A comment is handled once (its id is its marker). The switch is the Ask switch: with it off (no Ask dependencies), or with
// no way to reply in Linear (`LinearReplyPort`), nothing is read or spent.
import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ASK_QUESTION_MAX_CHARS, ASK_UNAVAILABLE_MESSAGE, INDEX_EXPIRY_ATTRIBUTE, askLinearCommentKey, redactText, type HookRecord, type OrgId } from "@rovara-code/contracts";
import { admitAsk, withoutMentions, type AskDependencies } from "../agent-sessions/ask.js";
import { sessionForSurface } from "../agent-sessions/bindings.js";
import { linearWorkspaceOfBinding } from "./linear-close.js";
import { sessionBindingsOf } from "./session-bindings.js";
import { taskKey, type DeveloperTaskRecord } from "../developer/task-records.js";
import { linearCommentOf } from "../triggers/providers/linear.js";

/** Posts a comment on a Linear issue as Rovara. The only way an Ask's answer or a refusal reaches Linear; absent, the Linear intake does nothing. */
export interface LinearReplyPort {
  /**
   * Posts the comment. `commentKey` is a stable name for it: the same key again is the same comment (a retry is never a second post). `workspace` is the Linear workspace the issue's binding names, when it
   * names one. Answers the comment's id when it knows it.
   */
  reply(input: { orgId: OrgId; issueKey: string; text: string; commentKey?: string | undefined; workspace?: string | undefined }): Promise<{ commentId: string; workspace?: string | undefined } | void>;
  /** Rewrites a comment Rovara posted (an erased person's name taken out). Refuses a comment that is not Rovara's own. Absent: such comments are not rewritten. */
  update?(input: { orgId: OrgId; commentId: string; text: string; workspace?: string | undefined }): Promise<void>;
  /** Deletes a comment Rovara posted. Refuses a comment that is not Rovara's own. Absent: such comments are not deleted. */
  remove?(input: { orgId: OrgId; commentId: string; workspace?: string | undefined }): Promise<void>;
  /** Linear's user id of the account Rovara writes as in this org (so a comment Rovara wrote is never read as a person's). Undefined when it cannot be known. */
  ownActorId(orgId: OrgId): Promise<string | undefined>;
}

export const LINEAR_LINK_REPLY = "I answer questions here (`@rovara ask <question>`). To stop or change anything, use the task page";
export const LINEAR_TOO_LONG_REPLY = `Keep the question under ${String(ASK_QUESTION_MAX_CHARS)} characters, or ask it on the task page`;
export const LINEAR_BUSY_REPLY = "Too many questions right now. Try again a little later.";

const DAY_SECONDS = 86_400;
const MARKER_TTL_DAYS = 3;
/** `@rovara` as Linear writes a mention: plain, or as a Markdown link whose text is the mention. */
const MENTION = /(?:\[@rovara\]\([^)]*\)|@rovara)\b/iu;
const ASK_AT_START = /^\s*(?:\[@rovara\]\([^)]*\)|@rovara)\s+ask\b\s*[:\-–]?\s*([\s\S]*)$/iu;

export type LinearCommentOutcome =
  | "ignored"          // not for Rovara, not a created comment, another org or team, a bot, or a hook of no bound issue
  | "unavailable"      // the Ask switch is off, or there is no way to reply
  | "link_reply"       // addressed to Rovara but not an Ask: told where to go, nothing changed
  | "asked"            // queued as an Ask
  | "refused"          // an Ask that was refused (rate, lock, closed task): told in fixed words
  | "duplicate";       // the same comment again

export interface LinearCommentDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  /** The Ask dependencies (the switch). Absent: the intake does nothing. */
  ask: AskDependencies | undefined;
  /** How Rovara writes in Linear. Absent: the intake does nothing (nothing would be answered). */
  reply: LinearReplyPort | undefined;
  /** The link to a task's page, for the reply that sends a person there. */
  taskPageLink?: ((orgId: OrgId, sessionId: string, taskId: string) => string | undefined) | undefined;
  /**
   * The Linear workspace url keys the org's Linear connections have checked as (`acme`). Read only for a binding made before bindings named their workspace (dual read, no migration): one key is that
   * binding's workspace; several keys mean the signed comment's own link decides (and no link, no post); none means the comment's link is used when it has one.
   */
  workspacesOfOrg?: ((orgId: OrgId) => Promise<string[]>) | undefined;
  log?: ((entry: Record<string, unknown>) => void) | undefined;
}

/** A stable, non-reversible name for a Linear author, for the Ask's rates and lock (an outsider has no developer id). */
export const linearAskerKey = (authorId: string): string => `linear_${createHash("sha256").update(`linear-author\0${authorId}`, "utf8").digest("hex").slice(0, 32)}`;

/** Marks the comment handled, once: false when it already was (a redelivery). */
async function firstTime(deps: LinearCommentDependencies, orgId: OrgId, commentId: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName, Item: { ...askLinearCommentKey(orgId, commentId), entityType: "ASK_LINEAR_COMMENT", orgId, at: new Date(deps.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(deps.now() / 1000) + MARKER_TTL_DAYS * DAY_SECONDS },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** The question after `@rovara ask`, or undefined when the comment is not an Ask. */
export function askQuestionOf(text: string): string | undefined {
  const match = ASK_AT_START.exec(text);
  const question = match?.[1]?.trim();
  return question === undefined || question === "" ? undefined : question;
}

/** Handles one verified delivery's comment. Never throws into the ingress: the caller already bounded it, and every failure here is a log line by name only. */
export async function handleLinearComment(deps: LinearCommentDependencies, input: { orgId: OrgId; hook: HookRecord; body: unknown }): Promise<LinearCommentOutcome> {
  const ask = deps.ask;
  if (ask === undefined || deps.reply === undefined) return "unavailable";
  const comment = linearCommentOf(input.body, input.hook);
  // Not addressed to Rovara at all: a person talking to a person. Nothing is read, nothing is written.
  if (comment === undefined || !MENTION.test(comment.text)) return "ignored";
  const { orgId } = input;
  // Rovara's own account is never a person asking (its replies must never start another reply). An id that cannot be read ends the comment too: fail closed.
  // An id that is not known (it resolved to nothing, or could not be read) ends the comment: fail closed.
  const own = await deps.reply.ownActorId(orgId).then((id) => ({ id }), () => undefined);
  if (own?.id === undefined || own.id === comment.authorId) return "ignored";
  // The issue must be one a session of this hook's org AND project follows; anything else is ignored without a word (an unbound issue is not Rovara's business).
  const session = await sessionForSurface({ documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now }, orgId, { kind: "linear_issue", issueId: comment.issueKey, url: `https://linear.app/issue/${comment.issueKey}` });
  if (session === undefined || session.kind !== "task" || session.subject.kind !== "task" || session.project !== input.hook.project) return "ignored";
  // An issue key (`ENG-142`) exists in every Linear workspace, so the comment must come from the workspace the binding names (M8). A binding made before bindings named theirs asks the org's Linear
  // connections: exactly one workspace is that one. With several, the signed comment's own link says which workspace this is, and it must be one of the org's; with no link workspace, nothing is posted (S1).
  // With none known (or unreadable), the comment's own link is used when it has one, and otherwise the comment is believed as it always was.
  const bound = (await sessionBindingsOf({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, session.sessionId).catch(() => [])).find((binding) => binding.kind === "linear_issue" && binding.issueId === comment.issueKey);
  let expectedWorkspace = bound === undefined ? undefined : linearWorkspaceOfBinding(bound);
  if (expectedWorkspace === undefined) {
    const known = await deps.workspacesOfOrg?.(orgId).catch(() => undefined);
    if (known !== undefined && known.length > 1) {
      if (comment.workspace === undefined || !known.includes(comment.workspace)) return "ignored";
      expectedWorkspace = comment.workspace;
    } else {
      expectedWorkspace = known?.length === 1 ? known[0] : comment.workspace;
    }
  }
  if (expectedWorkspace !== undefined && comment.workspace !== expectedWorkspace) return "ignored";
  if (!await firstTime(deps, orgId, comment.commentId)) return "duplicate";
  const say = async (text: string): Promise<void> => {
    try { await deps.reply!.reply({ orgId, issueKey: comment.issueKey, text: withoutMentions(text), commentKey: `reply:${comment.commentId}`, ...(expectedWorkspace === undefined ? {} : { workspace: expectedWorkspace }) }); } catch (error) { deps.log?.({ event: "linear_comment.reply_failed", error: error instanceof Error ? error.name : "unknown" }); }
  };
  const question = askQuestionOf(comment.text);
  if (question === undefined) {
    // Anything that is not an Ask (stop, change, approve, do something) changes nothing: one reply, with the link.
    const link = deps.taskPageLink?.(orgId, session.sessionId, session.subject.taskId);
    await say(link === undefined ? `${LINEAR_LINK_REPLY}.` : `${LINEAR_LINK_REPLY}: ${link}`);
    return "link_reply";
  }
  if ([...question].length > ASK_QUESTION_MAX_CHARS) {
    await say(`${LINEAR_TOO_LONG_REPLY}.`);
    return "link_reply";
  }
  const task = ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(session.subject.taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
  if (task === undefined || task.orgId !== orgId || task.closedAt !== undefined) {
    await say(ASK_UNAVAILABLE_MESSAGE);
    return "refused";
  }
  try {
    await admitAsk(ask, {
      audience: "linear", orgId, sessionId: session.sessionId, task, askerKey: linearAskerKey(comment.authorId), issueId: comment.issueKey, ...(expectedWorkspace === undefined ? {} : { workspace: expectedWorkspace }),
      question: redactText(question), requestId: comment.commentId,
    });
    return "asked";
  } catch (error) {
    const code = (error as { code?: string }).code;
    deps.log?.({ event: "linear_comment.ask_refused", code: typeof code === "string" ? code : "unknown" });
    await say(code === "TOO_MANY_REQUESTS" || code === "TASK_BUSY" ? LINEAR_BUSY_REPLY : ASK_UNAVAILABLE_MESSAGE);
    return "refused";
  }
}
