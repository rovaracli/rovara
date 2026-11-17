import { z } from "zod";
import { forwardReader } from "./forward-reader.js";

/**
 * Web task channel K5 (plan section 5): the person's inbox. Cloud answers `GET /v1/app/inbox` and `POST /v1/app/inbox/read` from Rovara Code's
 * in-app inbox routes (C7) as the signed-in person. Code decides whose rows these are and shows only rows the person may still read; the company
 * and the person come from the sign-in, never from the browser. Cloud's one addition is `open`: where the row goes in this app.
 */

/** Shown when Code answers 404 or 501 for the inbox: this install's Code does not serve it yet. Fixed words, nothing echoed. */
export const INBOX_NOT_AVAILABLE_TEXT = "Your inbox isn't available on this install yet.";

/** Code's kinds of notice (what is waiting for the person, or what happened). */
export const INBOX_KINDS = ["needs_you", "paused", "ready", "failed", "done"] as const;
export const INBOX_KIND_WORDS = { needs_you: "Needs you", paused: "Paused", ready: "Ready", failed: "Failed", done: "Done" } as const;

/** The most rows one page holds, and the most one read mark takes (Code's INBOX_PAGE_MAX and INBOX_READ_IDS_MAX). */
export const INBOX_PAGE_MAX = 50;
export const INBOX_READ_IDS_MAX = 50;
/** How often the screen and the badge read the inbox again (live updates come later). */
export const INBOX_POLL_MS = 30_000;

/** A row's id as Code names it: `<session>.<kind>.<time in ms>`. It names no person; Code marks only the caller's own rows. */
export const InboxIdSchema = z.string().regex(/^[0-9a-z_]{1,64}\.[a-z_]{1,20}\.[0-9]{1,16}$/u);

/** Where a row opens in this app: the session Cloud has for the task, otherwise the task by its id (`/t/<id>`). */
export const InboxOpenPathSchema = z.string().regex(/^\/(?:s\/ses_[0-9a-z]{20}|t\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/u);

export const InboxItemSchema = z.object({
  id: InboxIdSchema,
  kind: z.enum(INBOX_KINDS),
  title: z.string().min(1).max(200),
  /** One fixed sentence about where the task stands. */
  status: z.string().max(300),
  at: z.string().datetime(),
  read: z.boolean(),
  open: InboxOpenPathSchema,
}).strict();
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** `GET /v1/app/inbox?limit=&cursor=`: newest first. `unread` is on the first page only. */
export const InboxPageSchema = z.object({
  items: z.array(InboxItemSchema).max(INBOX_PAGE_MAX),
  nextCursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).optional(),
  unread: z.number().int().min(0).max(1000).optional(),
}).strict();
export const InboxPageReaderSchema = forwardReader(InboxPageSchema);

/** `POST /v1/app/inbox/read`: mark the person's own rows read. */
export const InboxReadBodySchema = z.object({
  requestId: z.string().uuid(),
  ids: z.array(InboxIdSchema).min(1).max(INBOX_READ_IDS_MAX),
}).strict();
export type InboxReadBody = z.infer<typeof InboxReadBodySchema>;

export const InboxReadResponseSchema = z.object({ marked: z.number().int().min(0).max(INBOX_READ_IDS_MAX) }).strict();
export const InboxReadResponseReaderSchema = forwardReader(InboxReadResponseSchema);
