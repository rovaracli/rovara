// What a source's provider is to ingress (Plan 4 Task 19): how a delivery is verified and how its body becomes events. Tasks 22 to 25 write the providers; ingress is theirs
// to call and never looks inside a body itself. The two comparisons here are the only ways a provider may compare a secret: both hash both sides to a fixed length and compare
// the digests with `timingSafeEqual`, so neither the length of a secret nor the first byte that differs shows in how long a refusal takes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { HookRecord, HookSource, TriggerEvent } from "@rovara-code/contracts";

export type HookHeaders = Record<string, string | undefined>;

export type Normalized = { events: TriggerEvent[] } | { ignored: string } | { tenantMismatch: true };

/** What a person is told to do at the vendor once a hook exists: fixed text per provider (never made from a body), shown with the answer that created the hook. */
export interface HookSetup {
  steps: string[];
  /** A payload the vendor has to be given exactly as it is written (Datadog's webhook has no fixed body). */
  payloadTemplate?: string;
}

export interface HookProvider {
  source: HookSource;
  /** Who makes the secret: Rovara (shown once on creation), the vendor (the person pastes it in), or nobody (an SNS hook has none: the message's own signature is the proof). */
  secretOrigin: "rovara" | "vendor" | "none";
  auth: "hmac" | "token" | "sns";
  /** What to set at the vendor, when it is more than pasting an address and a secret. */
  setup?: HookSetup;
  /** What to set at the vendor for this hook in particular (its own topic, say); undefined when the hook is not one this provider reads. Used in place of `setup` when present. */
  setupFor?(hook: HookRecord): HookSetup | undefined;
  /** Whether `raw` (the bytes as they arrived) and the headers prove the sender holds `secret`. Never throws for a malformed delivery: it answers false. An SNS provider answers false always: its deliveries are checked by `verifySnsMessage`, not by a secret. */
  verify(raw: Buffer, headers: HookHeaders, secret: string): boolean;
  /** The events of a verified, parsed body. Ingress sets `project` and `hookId` on each from the hook record afterwards, whatever this answers. */
  normalize(body: unknown, headers: HookHeaders, hook: HookRecord): Normalized;
}

const digest = (value: string | Buffer): Buffer => createHash("sha256").update(value).digest();

/** Whether two strings are equal, comparing their SHA-256 digests in constant time. An empty secret is never equal to anything: it is no secret. */
export function tokenEquals(supplied: string, secret: string): boolean {
  const equal = timingSafeEqual(digest(supplied), digest(secret));
  return equal && secret.length > 0;
}

/** Whether `suppliedHex` is the hex HMAC (`algorithm`) of `raw` under `secret`, compared as digests in constant time. A secret that is empty never verifies. */
export function hmacHexEquals(algorithm: "sha256" | "sha1", raw: Buffer, secret: string, suppliedHex: string): boolean {
  const expected = createHmac(algorithm, secret).update(raw).digest("hex");
  return tokenEquals(suppliedHex.trim().toLowerCase(), expected) && secret.length > 0;
}
