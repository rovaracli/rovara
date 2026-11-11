// Approval place (U4, decision 83, requirement A-08): the shapes of `/v1/app/org/approval-window`, the company's setting for how recently a person must have signed in to Rovara to approve a medium-risk plan from Slack, a tracker or a pull request
// comment. Any company member reads it; an owner or admin changes it from a live browser session. Shortening applies at once; lengthening waits for a different admin (and needs a fresh sign-in). Words, numbers and ids only.
import { z } from "zod";
import { forwardReader } from "@rovara-code/contracts";
import { RECENT_SIGN_IN_DEFAULT_SECONDS, RECENT_SIGN_IN_MAX_SECONDS, RECENT_SIGN_IN_MIN_SECONDS } from "./approval-place.js";

export const APPROVAL_WINDOW_PATH = "/v1/app/org/approval-window";

export const ApprovalWindowStateSchema = z.object({
  /** The revision a change is made against (`POLICY_STALE` when it moved). 0: nothing is stored, the default stands. */
  revision: z.number().int().min(0),
  seconds: z.number().int().min(RECENT_SIGN_IN_MIN_SECONDS).max(RECENT_SIGN_IN_MAX_SECONDS),
  isDefault: z.boolean(),
  defaultSeconds: z.literal(RECENT_SIGN_IN_DEFAULT_SECONDS),
  minSeconds: z.literal(RECENT_SIGN_IN_MIN_SECONDS),
  maxSeconds: z.literal(RECENT_SIGN_IN_MAX_SECONDS),
  /** Who last changed the window (a member's display name; "A former member" for someone erased) and when. Absent while the default stands. */
  changedBy: z.string().min(1).max(200).optional(),
  changedAt: z.string().datetime().optional(),
  /** True for a company owner or admin. */
  canChange: z.boolean(),
  /** The stored setting did not read: `seconds` is the default and nothing should be offered to change. */
  unreadable: z.boolean(),
  /** A lengthening waits for a different admin. Sent only to owners and admins; at most one waits at a time. */
  pending: z.object({ changeId: z.string().min(1).max(100), seconds: z.number().int().min(RECENT_SIGN_IN_MIN_SECONDS).max(RECENT_SIGN_IN_MAX_SECONDS), proposedByYou: z.boolean(), expiresAt: z.string().datetime() }).strict().optional(),
}).strict();
export type ApprovalWindowState = z.infer<typeof ApprovalWindowStateSchema>;
export const ApprovalWindowStateReaderSchema = forwardReader(ApprovalWindowStateSchema);

export const ApprovalWindowBodySchema = z.discriminatedUnion("action", [
  /** A shorter (or equal) window applies at once; a longer one needs a fresh sign-in and then a different admin (202 needs_approval). */
  z.object({ action: z.literal("set"), expectedRevision: z.number().int().min(0), seconds: z.number().int().min(RECENT_SIGN_IN_MIN_SECONDS).max(RECENT_SIGN_IN_MAX_SECONDS) }).strict(),
  /** A different admin approves the waiting lengthening (a sign-in within the last 10 minutes). */
  z.object({ action: z.literal("approve"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
  /** Withdraws the waiting request (its proposer, or any admin). */
  z.object({ action: z.literal("cancel"), changeId: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u) }).strict(),
]);
export type ApprovalWindowBody = z.infer<typeof ApprovalWindowBodySchema>;

/** 200 `applied`, or 202 `needs_approval` (a lengthening waits for a different admin). */
export const ApprovalWindowAnswerSchema = z.discriminatedUnion("status", [
  ApprovalWindowStateSchema.extend({ status: z.literal("applied") }).strict(),
  ApprovalWindowStateSchema.extend({ status: z.literal("needs_approval"), changeId: z.string().min(1).max(100) }).strict(),
]);
export type ApprovalWindowAnswer = z.infer<typeof ApprovalWindowAnswerSchema>;
export const ApprovalWindowAnswerReaderSchema = forwardReader(ApprovalWindowAnswerSchema);
