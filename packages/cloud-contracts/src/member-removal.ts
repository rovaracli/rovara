// Member removal (v1.1): what the one transaction (S0) records, and the words and limits the removal uses. The removal record is also the receipt of the
// request that made it. Everything here is data: the logic is the broker's (`org/member-removal/`).
import { z } from "zod";
import { type OrgId, type OrgKey, orgScoped } from "@rovara-code/contracts";

/** How many of a leaver's email pointers S0 deletes; the rest go in the always-run access step (they are named on the record). */
export const MEMBER_REMOVAL_EMAIL_CAP = 10;
/** Pointers beyond the cap kept on the record. A person has one per linked sign-in identity, so this is never reached in practice. */
export const MEMBER_REMOVAL_LEFTOVER_EMAILS_MAX = 100;
/** The most project grants one removal records (a grant entry is under 150 bytes, so 2,000 fit well inside DynamoDB's item limit). */
export const MEMBER_REMOVAL_GRANTS_MAX = 2000;
/** How many hops of "the successor was removed too" the movers follow before they fall back to the first owner. */
export const MEMBER_REMOVAL_SUCCESSOR_HOPS = 3;

export const MEMBER_REMOVAL_STATES = ["STARTED", "DONE", "CANCELLED_REJOINED"] as const;
export type MemberRemovalState = (typeof MEMBER_REMOVAL_STATES)[number];

export const SUCCESSOR_INVALID_MESSAGE = "Pick someone who is still in the company to take over.";
export const MEMBER_ALREADY_REMOVED_MESSAGE = "That person was already removed.";
export const REMOVAL_CHANGE_STALE_MESSAGE = "Company members changed. Reload and review the removal again.";
export const REMOVAL_FORBIDDEN_MESSAGE = "Your company access changed. Reload and check your access.";
export const REMOVAL_TOO_MANY_GRANTS_MESSAGE = "Too many project grants to remove in one go.";
export const REMOVAL_CLEANUP_UNFINISHED_MESSAGE = "The person was removed, but their project access was not all cleared. Try the removal again.";
export const REMOVAL_REQUEST_REUSED_MESSAGE = "Use a new request id for a different removal.";

/** One project grant of the leaver as S0 read it: the exact thing the access step deletes (while its `grantId` is still the one recorded). */
export const RemovedGrantSchema = z.object({
  project: z.string().min(1),
  grantId: z.string().min(1).optional(),
  role: z.string().optional(),
  projectRole: z.string().optional(),
}).strict();
export type RemovedGrant = z.infer<typeof RemovedGrantSchema>;

/** The removal record: written once by S0, finished by S7. */
export interface MemberRemovalRecord {
  orgId: OrgId;
  removalId: string;
  leaverId: string;
  role: string;
  /** Absent when the org had no owner to hand anything to (the movers then use their `orphaned` part). */
  successorId?: string;
  by: string;
  removedAt: string;
  state: MemberRemovalState;
  requestDigest: string;
  /** The leaver's grants as S0 read them: both the duties list and the exact delete list. */
  grants: RemovedGrant[];
  /** The leaver's monthly limit override as S0 read it, so the access step removes it only while it is still this value. */
  memberLimitUsd?: number;
  /** Email pointers beyond `MEMBER_REMOVAL_EMAIL_CAP` (their partition keys). */
  leftoverEmailPointers: string[];
  githubUnlinked: boolean;
  /** Set by S7. */
  finishedAt?: string;
  counts?: Record<string, number | boolean>;
}

/** The removal record's key; `removalId` is the request id of the removal. */
export function memberRemovalRecordKey(orgId: OrgId, removalId: string): OrgKey {
  return { pk: orgScoped(orgId, "MEMBER_REMOVAL"), sk: removalId };
}
