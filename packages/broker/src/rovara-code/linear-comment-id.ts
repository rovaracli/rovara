// The id Rovara gives a Linear comment it is about to post (lane ask-linear). Pure and small on purpose: the Ask code names the id BEFORE the post is made (so a crash cannot leave a comment the Ask
// does not know of), and must not load the Linear write client to do it.
import { createHash } from "node:crypto";
import type { OrgId } from "@rovara-code/contracts";

/** The id Linear is given for a comment: a version 4 UUID made from the org and the caller's stable key, so the same post always has the same id, in every process. Linear accepts the id the client chooses. */
export function linearCommentIdFor(orgId: OrgId, commentKey: string): string {
  const bytes = createHash("sha256").update(`rovara-linear-comment\0${orgId}\0${commentKey}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
