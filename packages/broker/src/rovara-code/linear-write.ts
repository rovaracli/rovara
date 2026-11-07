// Linear writes for Ask (lane ask-linear, LA-1): how Rovara posts an Ask's answer on a Linear issue. It writes through the org's EXISTING Linear connection (the saved API key of `OrgConnectionStore`, the
// one the Team record already reads users with) and calls Linear's fixed GraphQL address and nothing else.
//
// What this module holds, each fail closed:
//   - only a connection that may write (`access: read_write`), holds a saved secret AND has been checked as an account (`actorId`) is used, so every comment Rovara posts can later be edited or deleted by the
//     same connections; a service identity before a personal key; a connection whose checked workspace is not the one the binding
//     names is skipped; when the binding names a workspace, the issue's own link must be in it before anything is written;
//   - the comment's id is made from the org and a stable key the caller gives (`linearCommentIdFor`), and Linear accepts the id the client chooses, so the same post again is the same comment: a lost answer
//     is found by that id and counted as posted, never written twice. The caller can name the id BEFORE it posts (it records what it is about to post, so a crash cannot leave an unrecorded comment);
//   - a comment is edited or deleted only when its author is Rovara's own account (the account the connection's check recorded), whatever id is given. A comment counts as gone ONLY on Linear's real not-found
//     answer; a permission error, any other error or a connection that cannot be used is a retryable fault, never "gone";
//   - a rate limit (HTTP 429 or a RATELIMITED answer) is waited out as Linear says (`Retry-After`), a bounded number of times and for a bounded time, then it is a TOO_MANY_REQUESTS fault;
//   - the text is bounded; the key goes only in the `authorization` header to Linear, no redirect is followed, a response is read to a cap, and no error carries the key, the request or the text.
import { createHash } from "node:crypto";
import { z } from "zod";
import { agentXError, type OrgId } from "@agentx/contracts";
import { LINEAR_GRAPHQL, LINEAR_WORKSPACE_KEY, OrgConnectionStore, readConnection, readConnectionSecret, type OrgConnectionDeps, type OrgConnectionRecord } from "../connections/store.js";
import { normalizeIssueKey } from "./linear-close.js";
import { linearCommentIdFor } from "./linear-comment-id.js";
import type { LinearReplyPort } from "./linear-comments.js";

/** The most characters one comment holds (Linear's own limit is far higher; an answer is at most 8,000 and its label is short). */
export const LINEAR_COMMENT_MAX_CHARS = 10_000;
const TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 1_000_000;
/** One call is made at most this many times when Linear says "slow down"; each wait is what Linear asked for, at most this long, and all waits together at most `RATE_WAIT_TOTAL_MS`. */
export const LINEAR_RATE_ATTEMPTS = 3;
export const LINEAR_RATE_WAIT_MAX_MS = 8_000;
export const LINEAR_RATE_WAIT_TOTAL_MS = 15_000;
const RATE_WAIT_DEFAULT_MS = 1_000;

export { linearCommentIdFor };
export const LINEAR_NOT_SET_UP_MESSAGE = "Writing in Linear is not set up for this company.";
const UNAVAILABLE_MESSAGE = "Linear could not be reached just now.";

/** What Rovara can do to a Linear issue's comments, through the org's connection. */
export interface LinearWritePort extends LinearReplyPort {
  /** Posts the comment (once per `commentKey`) and answers its id. Throws when it could not be posted. */
  reply(input: { orgId: OrgId; issueKey: string; text: string; commentKey?: string | undefined; workspace?: string | undefined }): Promise<{ commentId: string; workspace?: string }>;
  /**
   * Replaces the text of a comment Rovara's own account wrote. Throws for any other comment. `workspace` is the workspace the comment was posted in (AL-1): given, only a connection to that workspace
   * can say the comment is gone.
   */
  update(input: { orgId: OrgId; commentId: string; text: string; workspace?: string | undefined }): Promise<void>;
  /** Deletes a comment Rovara's own account wrote. A comment that is already gone is not an error. Throws for any other comment. `workspace` as for `update`. */
  remove(input: { orgId: OrgId; commentId: string; workspace?: string | undefined }): Promise<void>;
}

const Envelope = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).passthrough();
const IssueRead = z.object({ issue: z.object({ id: z.string().min(1).max(100), identifier: z.string().min(1).max(40), url: z.string().max(2_000) }).passthrough().nullable() }).passthrough();
const CommentRead = z.object({ comment: z.object({ id: z.string().min(1).max(100), user: z.object({ id: z.string().min(1).max(200) }).passthrough().nullish(), issue: z.object({ identifier: z.string().max(40) }).passthrough().nullish() }).passthrough().nullable() }).passthrough();
const CreateResult = z.object({ commentCreate: z.object({ success: z.boolean() }).passthrough() }).passthrough();
const SuccessOf = (name: string) => z.object({ [name]: z.object({ success: z.boolean() }).passthrough() }).passthrough();

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE_MESSAGE);
const rateLimited = () => agentXError("TOO_MANY_REQUESTS", "Linear asked Rovara to slow down.");

const errorsOf = (errors: unknown[]): Array<{ message?: unknown; extensions?: { code?: unknown } }> => errors.filter((entry): entry is { message?: unknown; extensions?: { code?: unknown } } => entry !== null && typeof entry === "object");
/** Linear's "slow down" answer: the code RATELIMITED on an error (Linear sends it with a 400, not a 429). */
const isRateLimitAnswer = (errors: unknown[]): boolean => errorsOf(errors).some((entry) => entry.extensions?.code === "RATELIMITED");
/** Linear's real "there is no such entity" answer, and only that: every error says so. A permission error, a rate limit or any other fault is not "gone". */
export const isNotFoundAnswer = (errors: unknown[]): boolean => {
  const list = errorsOf(errors);
  return list.length > 0 && list.length === errors.length && list.every((entry) => entry.extensions?.code === "NOT_FOUND" || (typeof entry.message === "string" && /^entity not found\b/iu.test(entry.message)));
};
/** How long Linear asked to wait: `Retry-After` in seconds (or a date), else a short default; never more than the bound. */
function waitOf(header: string | null): number {
  if (header === null) return RATE_WAIT_DEFAULT_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.ceil(ms), LINEAR_RATE_WAIT_MAX_MS) : RATE_WAIT_DEFAULT_MS;
}
const notSetUp = () => agentXError("CONFIG_INVALID", LINEAR_NOT_SET_UP_MESSAGE);

/** The workspace url key in an issue's link on linear.app (`https://linear.app/acme/issue/ENG-1/...`), or undefined. */
export function workspaceOfIssueUrl(link: string): string | undefined {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.username !== "" || url.password !== "" || url.port !== "") return undefined;
    const parts = url.pathname.split("/").filter((part) => part !== "");
    return parts[1] === "issue" && LINEAR_WORKSPACE_KEY.test(parts[0]!.toLowerCase()) ? parts[0]!.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

type Connection = OrgConnectionRecord & { actorId?: string; workspaceKey?: string; secretVersion?: string; identity?: "service" | "personal" };

export function linearWriteOf(input: { deps: OrgConnectionDeps; fetch?: typeof fetch | undefined; sleep?: ((ms: number) => Promise<void>) | undefined }): LinearWritePort {
  const { deps } = input;
  const fetchImpl = input.fetch ?? fetch;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** The org's connections that may write and are known as an account, a service identity first, then by id (a stable choice). */
  async function writers(orgId: OrgId, workspace?: string): Promise<Connection[]> {
    const listed = await new OrgConnectionStore({ ...deps }).list(orgId);
    const found: Connection[] = [];
    for (const entry of listed) {
      if (entry.type !== "linear" || entry.access !== "read_write" || entry.hasSecret !== true) continue;
      const record = await readConnection(deps, orgId, entry.connectionId) as Connection | undefined;
      if (record === undefined || record.orgId !== orgId || record.type !== "linear" || record.access !== "read_write" || record.hasSecret !== true) continue;
      // A connection that was never checked as an account cannot be told apart from another account's: a comment it posts could never be edited or deleted later. It posts nothing.
      if (typeof record.actorId !== "string" || record.actorId === "") continue;
      // A connection whose workspace is known and is not the one named is not used; one that was never checked is (the issue's own link is checked below).
      if (workspace !== undefined && record.workspaceKey !== undefined && record.workspaceKey !== workspace) continue;
      found.push(record);
    }
    return found.sort((left, right) => Number(right.identity === "service") - Number(left.identity === "service") || left.connectionId.localeCompare(right.connectionId));
  }

  async function call<T>(orgId: OrgId, connection: Connection, schema: z.ZodType<T>, query: string, variables: Record<string, unknown>): Promise<{ data: T } | { errors: unknown[] }> {
    const secret = await readConnectionSecret(deps, orgId, connection).catch(() => undefined);
    if (secret === undefined || !("apiKey" in secret)) throw notSetUp();
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      let text: string;
      let status: number;
      let retryAfter: string | null;
      try {
        const response = await fetchImpl(LINEAR_GRAPHQL, {
          method: "POST", headers: { authorization: secret.apiKey, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ query, variables }),
        });
        status = response.status;
        retryAfter = response.headers?.get("retry-after") ?? null;
        text = await response.text();
      } catch {
        // A network error can quote the request: only the fixed words are thrown.
        throw unavailable();
      }
      if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable();
      let envelope: z.infer<typeof Envelope> | undefined;
      try { envelope = Envelope.parse(JSON.parse(text)); } catch { envelope = undefined; }
      // Linear says "slow down" with a 429, or with a RATELIMITED error (which it sends with a 400): wait as it asked, a bounded number of times and time, then give up with one fixed fault.
      if (status === 429 || (envelope?.errors !== undefined && isRateLimitAnswer(envelope.errors))) {
        const wait = waitOf(retryAfter);
        if (attempt >= LINEAR_RATE_ATTEMPTS || waited + wait > LINEAR_RATE_WAIT_TOTAL_MS) throw rateLimited();
        waited += wait;
        await sleep(wait);
        continue;
      }
      if (status < 200 || status >= 300 || envelope === undefined) throw unavailable();
      if (envelope.errors !== undefined && envelope.errors.length > 0) return { errors: envelope.errors };
      const parsed = schema.safeParse(envelope.data);
      if (!parsed.success) throw unavailable();
      return { data: parsed.data };
    }
  }

  /** A comment, with its author and issue, or undefined when Linear has none by that id. */
  async function readComment(orgId: OrgId, connection: Connection, commentId: string): Promise<NonNullable<z.infer<typeof CommentRead>["comment"]> | undefined> {
    const answer = await call(orgId, connection, CommentRead, "query($id:String!){ comment(id:$id){ id user{ id } issue{ identifier } } }", { id: commentId });
    // Only Linear's real "no such comment" is "gone": a permission error or any other fault is retried by the caller, never read as gone.
    if ("errors" in answer) {
      if (isNotFoundAnswer(answer.errors)) return undefined;
      throw unavailable();
    }
    return answer.data.comment ?? undefined;
  }

  /**
   * The connection that wrote as Rovara in this org and the comment, when the comment is Rovara's own. "gone" ONLY when every connection that could see it got Linear's real not-found answer.
   * No usable connection, a connection that failed or was refused, and a comment that is another account's all throw (retryable by the caller, never read as "gone").
   *
   * AL-1: with the workspace the comment was posted in, a connection to ANOTHER workspace is not asked (it could never see the comment, so its not-found says nothing), and "gone" needs at least one
   * connection to that very workspace to have said not-found. When the posting connection was removed and only other workspaces' connections are left, nothing proves the comment is gone: it throws
   * (CONFIG_INVALID, "not set up"), so the caller keeps the work waiting and, in the end, reports it. A connection whose workspace was never recorded is still asked (it may see the comment); its not-found
   * counts as proof only while no connection is known to be in that workspace. Without a workspace (a comment recorded before this) the pass is as it was.
   */
  async function ownComment(orgId: OrgId, commentId: string, workspace?: string): Promise<{ connection: Connection; comment: NonNullable<z.infer<typeof CommentRead>["comment"]> } | "gone"> {
    const all = (await writers(orgId)).filter((connection) => workspace === undefined || connection.workspaceKey === undefined || connection.workspaceKey === workspace);
    if (all.length === 0) throw notSetUp();
    let foreign = false;
    let failure: unknown;
    // A connection whose workspace was never read may confirm "gone" only while no connection is known to be in the posting workspace (as before AL-1): then nothing better can answer.
    const keyedHere = workspace !== undefined && all.some((connection) => connection.workspaceKey === workspace);
    let proof = false;
    for (const connection of all) {
      let comment: Awaited<ReturnType<typeof readComment>>;
      try {
        comment = await readComment(orgId, connection, commentId);
      } catch (error) {
        // A rate limit stops the pass at once; any other fault is kept while the other connections are asked.
        if ((error as { code?: string }).code === "TOO_MANY_REQUESTS") throw error;
        failure = error;
        continue;
      }
      if (comment === undefined) {
        if (workspace === undefined || connection.workspaceKey === workspace || (connection.workspaceKey === undefined && !keyedHere)) proof = true;
        continue;
      }
      if (comment.user?.id === connection.actorId) return { connection, comment };
      foreign = true;
    }
    if (foreign) throw agentXError("FORBIDDEN", "that comment is not Rovara's");
    if (failure !== undefined) throw failure instanceof Error ? failure : unavailable();
    // No connection to the posting workspace answered: the comment may well still be there.
    if (!proof) throw notSetUp();
    return "gone";
  }

  return {
    async ownActorId(orgId: OrgId): Promise<string | undefined> {
      return (await writers(orgId)).find((connection) => connection.actorId !== undefined)?.actorId;
    },

    async reply({ orgId, issueKey, text, commentKey, workspace }) {
      const key = normalizeIssueKey(issueKey);
      const body = text.trim();
      if (key === undefined || body === "") throw agentXError("CONFIG_INVALID", "A comment needs an issue and some words.");
      if (workspace !== undefined && !LINEAR_WORKSPACE_KEY.test(workspace)) throw agentXError("CONFIG_INVALID", "A comment needs a valid workspace.");
      const cut = Array.from(body).slice(0, LINEAR_COMMENT_MAX_CHARS).join("");
      const choices = await writers(orgId, workspace);
      if (choices.length === 0) throw notSetUp();
      const commentId = linearCommentIdFor(orgId, commentKey ?? `once:${createHash("sha256").update(`${key}\0${cut}`, "utf8").digest("hex")}`);
      let lastError: unknown;
      for (const connection of choices) {
        try {
          const read = await call(orgId, connection, IssueRead, "query($id:String!){ issue(id:$id){ id identifier url } }", { id: key });
          if ("errors" in read) {
            // Linear's real "no such issue" tries the next connection; any other fault is remembered and thrown if nothing else posts.
            if (!isNotFoundAnswer(read.errors)) lastError = unavailable();
            continue;
          }
          if (read.data.issue === null) continue;
          const issue = read.data.issue;
          // An answer for another issue than the one asked about is no answer; and the issue's own link says which workspace it is in.
          if (normalizeIssueKey(issue.identifier) !== key) continue;
          if (workspace !== undefined && workspaceOfIssueUrl(issue.url) !== workspace) continue;
          const created = await call(orgId, connection, CreateResult, "mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }", { input: { id: commentId, issueId: issue.id, body: cut } });
          // The workspace is the posting connection's own, checked, one: what a later erase must ask in (AL-1).
          const posted = { commentId, ...(connection.workspaceKey === undefined ? {} : { workspace: connection.workspaceKey }) };
          if (!("errors" in created) && created.data.commentCreate.success) return posted;
          // Linear refused or the answer was lost: if a comment with this very id is on this very issue, it is posted (the same post again is the same comment).
          const existing = await readComment(orgId, connection, commentId);
          if (existing !== undefined && existing.id === commentId && normalizeIssueKey(existing.issue?.identifier) === key) return posted;
          lastError = unavailable();
        } catch (error) {
          // A rate limit is the same for every connection of the org: it stops the pass.
          if ((error as { code?: string }).code === "TOO_MANY_REQUESTS") throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : notSetUp();
    },

    async update({ orgId, commentId, text, workspace }) {
      const body = text.trim();
      if (body === "") throw agentXError("CONFIG_INVALID", "A comment needs some words.");
      const own = await ownComment(orgId, commentId, workspace);
      if (own === "gone") throw agentXError("NOT_FOUND", "that comment is gone");
      const cut = Array.from(body).slice(0, LINEAR_COMMENT_MAX_CHARS).join("");
      const done = await call(orgId, own.connection, SuccessOf("commentUpdate"), "mutation($id:String!,$input:CommentUpdateInput!){ commentUpdate(id:$id,input:$input){ success } }", { id: commentId, input: { body: cut } });
      if ("errors" in done && isNotFoundAnswer(done.errors)) throw agentXError("NOT_FOUND", "that comment is gone");
      if ("errors" in done || (done.data as { commentUpdate: { success: boolean } }).commentUpdate.success !== true) throw unavailable();
    },

    async remove({ orgId, commentId, workspace }) {
      const own = await ownComment(orgId, commentId, workspace);
      if (own === "gone") return;
      const done = await call(orgId, own.connection, SuccessOf("commentDelete"), "mutation($id:String!){ commentDelete(id:$id){ success } }", { id: commentId });
      if ("errors" in done && isNotFoundAnswer(done.errors)) return;
      if ("errors" in done || (done.data as { commentDelete: { success: boolean } }).commentDelete.success !== true) throw unavailable();
    },
  };
}
