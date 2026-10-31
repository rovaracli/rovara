// Meta repo lane F (F1): the identities an intake start is made under. A start for a ticket is the same start however often it is asked for (a poll sees the ticket again, a webhook
// is delivered twice), so its request id is a UUID v5 of the org, the ticket and the member who starts it: the run start answers a repeat with the first task.
import { createHash } from "node:crypto";

const REQUEST_NAMESPACE = Buffer.from("7e4a1b9c2d6f4a8e9b0c3d5f7a1e2c48", "hex");

/** Plan 3's request id for the start of one ticket by one member. */
export function intakeRequestId(orgId: string, system: string, id: string, developerId: string): string {
  const hash = createHash("sha1").update(REQUEST_NAMESPACE).update(`${orgId}\0${system}\0${id}\0${developerId}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
