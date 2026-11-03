// Linear writes for Ask (lane ask-linear, LA-1): how Rovara posts an Ask's answer on a Linear issue. It writes through the org's EXISTING Linear connection (the saved API key of `OrgConnectionStore`, the
// one the Team record already reads users with) and calls Linear's fixed GraphQL address and nothing else.
//
// What this module holds, each fail closed:
//   - only a connection that may write (`access: read_write`) and holds a saved secret is used; a service identity before a personal key; a connection whose checked workspace is not the one the binding
//     names is skipped; when the binding names a workspace, the issue's own link must be in it before anything is written;
//   - the comment's id is made from the org and a stable key the caller gives (`linearCommentIdFor`), and Linear accepts the id the client chooses, so the same post again is the same comment: a lost answer
//     is found by that id and counted as posted, never written twice. The caller can name the id BEFORE it posts (it records what it is about to post, so a crash cannot leave an unrecorded comment);
//   - a comment is edited or deleted only when its author is Rovara's own account (the account the connection's check recorded), whatever id is given;
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

export { linearCommentIdFor };
export const LINEAR_NOT_SET_UP_MESSAGE = "Writing in Linear is not set up for this company.";
const UNAVAILABLE_MESSAGE = "Linear could not be reached just now.";

/** What Rovara can do to a Linear issue's comments, through the org's connection. */
export interface LinearWritePort extends LinearReplyPort {
  /** Posts the comment (once per `commentKey`) and answers its id. Throws when it could not be posted. */
  reply(input: { orgId: OrgId; issueKey: string; text: string; commentKey?: string | undefined; workspace?: string | undefined }): Promise<{ commentId: string }>;
  /** Replaces the text of a comment Rovara's own account wrote. Throws for any other comment. */
  update(input: { orgId: OrgId; commentId: string; text: string }): Promise<void>;
  /** Deletes a comment Rovara's own account wrote. A comment that is already gone is not an error. Throws for any other comment. */
  remove(input: { orgId: OrgId; commentId: string }): Promise<void>;
}

const Envelope = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).passthrough();
const IssueRead = z.object({ issue: z.object({ id: z.string().min(1).max(100), identifier: z.string().min(1).max(40), url: z.string().max(2_000) }).passthrough().nullable() }).passthrough();
const CommentRead = z.object({ comment: z.object({ id: z.string().min(1).max(100), user: z.object({ id: z.string().min(1).max(200) }).passthrough().nullish(), issue: z.object({ identifier: z.string().max(40) }).passthrough().nullish() }).passthrough().nullable() }).passthrough();
const CreateResult = z.object({ commentCreate: z.object({ success: z.boolean() }).passthrough() }).passthrough();
const SuccessOf = (name: string) => z.object({ [name]: z.object({ success: z.boolean() }).passthrough() }).passthrough();

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", UNAVAILABLE_MESSAGE);
const notSetUp = () => agentXError("CONFIG_INVALID", LINEAR_NOT_SET_UP_MESSAGE);

/** The workspace url key in an issue's link on linear.app (`https://linear.app/acme/issue/ENG-1/...`), or undefined. */
function workspaceOfIssueUrl(link: string): string | undefined {
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

export function linearWriteOf(input: { deps: OrgConnectionDeps; fetch?: typeof fetch | undefined }): LinearWritePort {
  const { deps } = input;
  const fetchImpl = input.fetch ?? fetch;

  /** The org's connections that may write, a service identity first, then by id (a stable choice). */
  async function writers(orgId: OrgId, workspace?: string): Promise<Connection[]> {
    const listed = await new OrgConnectionStore({ ...deps }).list(orgId);
    const found: Connection[] = [];
    for (const entry of listed) {
      if (entry.type !== "linear" || entry.access !== "read_write" || entry.hasSecret !== true) continue;
      const record = await readConnection(deps, orgId, entry.connectionId) as Connection | undefined;
      if (record === undefined || record.orgId !== orgId || record.type !== "linear" || record.access !== "read_write" || record.hasSecret !== true) continue;
      // A connection whose workspace is known and is not the one named is not used; one that was never checked is (the issue's own link is checked below).
      if (workspace !== undefined && record.workspaceKey !== undefined && record.workspaceKey !== workspace) continue;
      found.push(record);
    }
    return found.sort((left, right) => Number(right.identity === "service") - Number(left.identity === "service") || left.connectionId.localeCompare(right.connectionId));
  }

  async function call<T>(orgId: OrgId, connection: Connection, schema: z.ZodType<T>, query: string, variables: Record<string, unknown>): Promise<{ data: T } | { errors: true }> {
    const secret = await readConnectionSecret(deps, orgId, connection).catch(() => undefined);
    if (secret === undefined || !("apiKey" in secret)) throw notSetUp();
    let text: string;
    try {
      const response = await fetchImpl(LINEAR_GRAPHQL, {
        method: "POST", headers: { authorization: secret.apiKey, "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw unavailable();
      text = await response.text();
    } catch {
      // A network error can quote the request: only the fixed words are thrown.
      throw unavailable();
    }
    if (Buffer.byteLength(text, "utf8") > RESPONSE_MAX_BYTES) throw unavailable();
    let envelope: z.infer<typeof Envelope>;
    try { envelope = Envelope.parse(JSON.parse(text)); } catch { throw unavailable(); }
    if (envelope.errors !== undefined && envelope.errors.length > 0) return { errors: true };
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw unavailable();
    return { data: parsed.data };
  }

  /** A comment, with its author and issue, or undefined when Linear has none by that id. */
  async function readComment(orgId: OrgId, connection: Connection, commentId: string): Promise<NonNullable<z.infer<typeof CommentRead>["comment"]> | undefined> {
    const answer = await call(orgId, connection, CommentRead, "query($id:String!){ comment(id:$id){ id user{ id } issue{ identifier } } }", { id: commentId });
    if ("errors" in answer) return undefined;
    return answer.data.comment ?? undefined;
  }

  /** The connection that wrote as Rovara in this org and the comment, when the comment is Rovara's own. */
  async function ownComment(orgId: OrgId, commentId: string): Promise<{ connection: Connection; comment: NonNullable<z.infer<typeof CommentRead>["comment"]> } | "gone"> {
    const all = await writers(orgId);
    if (all.length === 0) throw notSetUp();
    for (const connection of all) {
      if (connection.actorId === undefined) continue;
      const comment = await readComment(orgId, connection, commentId);
      if (comment === undefined) continue;
      if (comment.user?.id === connection.actorId) return { connection, comment };
    }
    // Not found by any writer: either it is gone, or it is another account's. Tell them apart by asking each writer once more whether it exists at all.
    for (const connection of all) if (connection.actorId !== undefined && await readComment(orgId, connection, commentId) !== undefined) throw agentXError("FORBIDDEN", "that comment is not Rovara's");
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
          if ("errors" in read || read.data.issue === null) continue;
          const issue = read.data.issue;
          // An answer for another issue than the one asked about is no answer; and the issue's own link says which workspace it is in.
          if (normalizeIssueKey(issue.identifier) !== key) continue;
          if (workspace !== undefined && workspaceOfIssueUrl(issue.url) !== workspace) continue;
          const created = await call(orgId, connection, CreateResult, "mutation($input:CommentCreateInput!){ commentCreate(input:$input){ success } }", { input: { id: commentId, issueId: issue.id, body: cut } });
          if (!("errors" in created) && created.data.commentCreate.success) return { commentId };
          // Linear refused or the answer was lost: if a comment with this very id is on this very issue, it is posted (the same post again is the same comment).
          const existing = await readComment(orgId, connection, commentId);
          if (existing !== undefined && existing.id === commentId && normalizeIssueKey(existing.issue?.identifier) === key) return { commentId };
          lastError = unavailable();
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : notSetUp();
    },

    async update({ orgId, commentId, text }) {
      const body = text.trim();
      if (body === "") throw agentXError("CONFIG_INVALID", "A comment needs some words.");
      const own = await ownComment(orgId, commentId);
      if (own === "gone") throw agentXError("NOT_FOUND", "that comment is gone");
      const cut = Array.from(body).slice(0, LINEAR_COMMENT_MAX_CHARS).join("");
      const done = await call(orgId, own.connection, SuccessOf("commentUpdate"), "mutation($id:String!,$input:CommentUpdateInput!){ commentUpdate(id:$id,input:$input){ success } }", { id: commentId, input: { body: cut } });
      if ("errors" in done || (done.data as { commentUpdate: { success: boolean } }).commentUpdate.success !== true) throw unavailable();
    },

    async remove({ orgId, commentId }) {
      const own = await ownComment(orgId, commentId);
      if (own === "gone") return;
      const done = await call(orgId, own.connection, SuccessOf("commentDelete"), "mutation($id:String!){ commentDelete(id:$id){ success } }", { id: commentId });
      if ("errors" in done || (done.data as { commentDelete: { success: boolean } }).commentDelete.success !== true) throw unavailable();
    },
  };
}
