// R8: trust and audience taint (design learning-v2-team-record.md control C2). Every derived item (fact, candidate, lesson) carries the
// LOWEST trust and the NARROWEST audience of everything it came from. Derivation never raises either. Both are computed here, in code,
// from the inputs; a model's output can never set them.
import type { AclSnapshot, Audience, TrustClass } from "./shared-types.js";

/**
 * Order from least to most trusted. `rovara` (structured signals with no people's free text) ranks above `member`, so a mix of the two
 * is `member`: the more conservative of two classes that both pass tier 0.
 */
const TRUST_RANK: Record<TrustClass, number> = { outsider: 0, system: 1, member: 2, rovara: 3 };

export function isTrustClass(value: unknown): value is TrustClass {
  return typeof value === "string" && Object.hasOwn(TRUST_RANK, value);
}

/** The lowest trust of the inputs. Nothing to derive from, or a value that is not a trust class, gives `outsider` (fail closed). */
export function minTrust(trusts: readonly unknown[]): TrustClass {
  let lowest: TrustClass | undefined;
  for (const value of trusts) {
    const trust: TrustClass = isTrustClass(value) ? value : "outsider";
    if (lowest === undefined || TRUST_RANK[trust] < TRUST_RANK[lowest]) lowest = trust;
  }
  return lowest ?? "outsider";
}

/** Two restricted audiences from different places cannot be merged into one ACL: the caller must split the bundle by audience. */
export class MixedAudienceError extends Error {
  constructor() {
    super("team-record: inputs have restricted audiences from different scopes");
    this.name = "MixedAudienceError";
  }
}

const PRINCIPALS_MAX = 500;

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const right = new Set(b);
  return [...new Set(a)].filter((item) => right.has(item)).slice(0, PRINCIPALS_MAX);
}

function intersectAcl(a: AclSnapshot, b: AclSnapshot): AclSnapshot {
  if (a.source !== b.source || a.scope !== b.scope) throw new MixedAudienceError();
  const out: AclSnapshot = {
    source: a.source,
    scope: a.scope,
    // The later snapshot is the better knowledge of who could see the place; a live re-check, if either wants it, is kept.
    capturedAt: a.capturedAt >= b.capturedAt ? a.capturedAt : b.capturedAt,
    liveCheck: a.liveCheck === "on_read" || b.liveCheck === "on_read" ? "on_read" : "none",
  };
  // A list on one side only is the narrower reading: a named list beats "everyone in the group". Both lists: their overlap.
  const principals = a.principals !== undefined && b.principals !== undefined ? intersect(a.principals, b.principals) : (a.principals ?? b.principals);
  const groups = a.groups !== undefined && b.groups !== undefined ? intersect(a.groups, b.groups) : (a.groups ?? b.groups);
  if (principals !== undefined) out.principals = principals;
  if (groups !== undefined) out.groups = groups;
  return out;
}

/**
 * The narrowest audience of the inputs. Project-wide with project-wide stays project-wide; any restricted input makes the result restricted;
 * two restricted inputs must share one scope (else MixedAudienceError). No inputs is an error, not a default.
 */
export function narrowestAudience(audiences: readonly Audience[]): Audience {
  if (audiences.length === 0) throw new Error("team-record: no audience to derive from");
  let restricted: AclSnapshot | undefined;
  for (const audience of audiences) {
    if (audience.kind !== "restricted") {
      if (audience.kind !== "project") throw new Error("team-record: unknown audience kind");
      continue;
    }
    restricted = restricted === undefined ? audience.acl : intersectAcl(restricted, audience.acl);
  }
  return restricted === undefined ? { kind: "project" } : { kind: "restricted", acl: restricted };
}

export interface TaintedInput {
  trust: TrustClass;
  audience: Audience;
}

export function taintOf(inputs: readonly TaintedInput[]): TaintedInput {
  return { trust: minTrust(inputs.map((input) => input.trust)), audience: narrowestAudience(inputs.map((input) => input.audience)) };
}
