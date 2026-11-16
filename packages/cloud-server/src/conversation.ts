// A session's Conversation (Rovara-cloud#24): its timeline, read from the Code task's events, and its comments between people, which are Cloud's
// own (kept on the session record). Messages to the agent ("steer") are not offered: Code refuses extra instructions on a workflow task.
import { createHash } from "node:crypto";
import type { SessionComment } from "./work-sessions.js";

/** One line of a Code task's events (Code's DeveloperTaskEventSchema). */
export interface CodeTaskEvent { at: string; kind: string; text: string }

/** The app's limits (agent-sessions.ts): an event's text, a page of events, a comment's text, a page of comments. */
export const EVENT_TEXT_MAX = 500;
export const EVENTS_PAGE_MAX = 200;
export const COMMENT_TEXT_MAX = 2000;
export const COMMENTS_PAGE_MAX = 100;
/** The most comments one session keeps. */
export const COMMENTS_PER_SESSION_MAX = 500;
/** How far before a cursor a comments read starts again, so a comment saved late is still found (the app de-duplicates by id). */
const COMMENTS_REREAD_MS = 5_000;

const CONTROL = /(?![\n\t\r])\p{Cc}/gu;
const HAS_CONTROL = /(?![\n\t\r])\p{Cc}/u;
const cut = (text: string, max: number) => { const chars = [...text]; return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…"; };

/**
 * Code's task events as the session's timeline (SessionEventSchema), oldest first. A status or error line is the system's; progress, tool and
 * message lines are the agent's steps. Each gets a stable id from its own content, so a re-read finds the same event.
 */
export function timelineOf(events: readonly CodeTaskEvent[]) {
  const seen = new Map<string, number>();
  return [...events]
    .filter((event) => typeof event.at === "string" && !Number.isNaN(Date.parse(event.at)) && typeof event.text === "string")
    .sort((a, b) => a.at.localeCompare(b.at))
    .flatMap((event) => {
      const text = cut(event.text.replace(CONTROL, "").trim(), EVENT_TEXT_MAX);
      if (text === "") return [];
      const system = event.kind === "status" || event.kind === "error";
      const key = `${event.at}\u0000${event.kind}\u0000${text}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      const eventId = `evt_${createHash("sha256").update(`${key}\u0000${String(count)}`).digest("hex").slice(0, 24)}`;
      return [{ eventId, at: new Date(event.at).toISOString(), type: system ? "status" as const : "step" as const, actor: { kind: system ? "system" as const : "agent" as const }, text }];
    });
}

/** A page of the timeline after the cursor `<at>#<eventId>` (the last item's key), at most EVENTS_PAGE_MAX. */
export function timelinePage(events: ReturnType<typeof timelineOf>, after: string | null) {
  const later = after === null ? events : events.filter((event) => `${event.at}#${event.eventId}` > after);
  const page = later.slice(0, EVENTS_PAGE_MAX), last = page.at(-1);
  return { events: page, ...(last === undefined ? {} : { next: `${last.at}#${last.eventId}` }) };
}

/** A comment as the app reads it (SessionMessageSchema). A deleted one keeps no text. */
export function commentView(sessionId: string, comment: SessionComment, viewer?: { developerId: string; name?: string }) {
  const author = viewer?.name !== undefined && viewer.name !== "" && comment.author.developerId === viewer.developerId ? { ...comment.author, name: viewer.name } : comment.author;
  return {
    messageId: comment.messageId, sessionId, kind: comment.kind, source: comment.source, author,
    text: comment.deletedAt === undefined ? comment.text : "Comment deleted", createdAt: comment.createdAt,
    ...(comment.editedAt === undefined ? {} : { editedAt: comment.editedAt }), ...(comment.deletedAt === undefined ? {} : { deletedAt: comment.deletedAt }),
    rev: comment.rev, ...(comment.threadId === undefined ? {} : { threadId: comment.threadId }),
  };
}

/** A page of comments, oldest first, after the cursor `<createdAt>#<messageId>`, starting a few seconds before it. */
export function commentsPage(sessionId: string, comments: readonly SessionComment[], after: string | null, viewer?: { developerId: string; name?: string }) {
  // By time, and in the order they were written for the same instant (the sort is stable; the store keeps them in order).
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const since = after === null ? undefined : Date.parse(after.split("#")[0] ?? "");
  const from = since === undefined || Number.isNaN(since) ? sorted : sorted.filter((comment) => Date.parse(comment.createdAt) >= since - COMMENTS_REREAD_MS);
  const page = from.slice(0, COMMENTS_PAGE_MAX), last = page.at(-1);
  return { messages: page.map((comment) => commentView(sessionId, comment, viewer)), ...(last === undefined ? {} : { next: `${last.createdAt}#${last.messageId}` }) };
}

/** A comment's text as the person wrote it, or why it can't be saved. */
export function commentText(value: unknown): { text: string } | { problem: string } {
  if (typeof value !== "string" || value.trim() === "") return { problem: "Write a comment first." };
  if (HAS_CONTROL.test(value)) return { problem: "The comment has characters that can't be saved." };
  if ([...value].length > COMMENT_TEXT_MAX) return { problem: `A comment is at most ${String(COMMENT_TEXT_MAX)} characters.` };
  return { text: value };
}
