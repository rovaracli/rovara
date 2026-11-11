// srv/needs-broker-ui-2 item 9: `GET /v1/app/org/approvals/pending-summary`, the company's open approvals at a glance, for an org owner or admin only. Read-only: the count of what is waiting and the
// newest `ORG_PENDING_APPROVALS_MAX`, each as the words the confirmation page already shows (its title) with who asked, when, and the page's own link. No subject, no arguments, no digests, no diff:
// deciding stays on that page. Browser-safe: nothing here imports `node:*`.
import { z } from "zod";
import { ApprovalIdSchema, forwardReader } from "@rovara-code/contracts";

export const ORG_PENDING_APPROVALS_PATH = "/v1/app/org/approvals/pending-summary";
/** The most approvals one answer lists (the first page, newest first); `total` counts all that are waiting. */
export const ORG_PENDING_APPROVALS_MAX = 50;

/** The three kinds of approval the broker keeps: an agent's write, a run's step that waits for a person, and a change somebody asked for. */
export const ORG_PENDING_APPROVAL_KINDS = ["write", "step", "change"] as const;

export const OrgPendingApprovalItemSchema = z.object({
  approvalId: ApprovalIdSchema,
  kind: z.enum(ORG_PENDING_APPROVAL_KINDS),
  /** For a change: which change (a fixed word such as `agent_publish`), the same `subject.kind` the approval has. Never the subject itself. */
  subjectKind: z.string().min(1).max(60).optional(),
  /** The title of the approval's confirmation page, word for word. */
  title: z.string().min(1).max(200),
  /** The person who asked (a change's requester) or whose run it is (a write's or step's owner), by display name; absent when it isn't known. */
  proposedBy: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
  /** The approval's confirmation page: the bare link, with no ticket. */
  confirmUrl: z.string().url().max(2048),
}).strict();
export type OrgPendingApprovalItem = z.infer<typeof OrgPendingApprovalItemSchema>;

export const OrgPendingApprovalsSummarySchema = z.object({
  /** Everything waiting in the company (counted from the part of the open index that was read; see `truncated`). */
  total: z.number().int().min(0),
  approvals: z.array(OrgPendingApprovalItemSchema).max(ORG_PENDING_APPROVALS_MAX),
  /** Present when the open index was longer than one answer reads, so `total` may be short. */
  truncated: z.literal(true).optional(),
}).strict();
export type OrgPendingApprovalsSummary = z.infer<typeof OrgPendingApprovalsSummarySchema>;

export const OrgPendingApprovalsSummaryReaderSchema = forwardReader(OrgPendingApprovalsSummarySchema);
