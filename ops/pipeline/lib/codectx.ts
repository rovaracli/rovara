// CODE_CTX (L9b; the contract with Rovara Code's public pipeline): the Code facts of a run, delivered ONLY to each stage's Cloud Preflight action, as ONE value:
//   CODE_CTX=live:<40hex>,target:<40hex|none>,supersedes:<uuid|none>,supersedesSha:<40hex|none>[,trigger:<cloud-tag@vX.Y.Z|code-push|manual|unknown>]
// live = the Code commit the stage runs now (its released record); target = the commit a Code rollback moves to; supersedes = the execution waiting in front of Production that
// this run replaces, supersedesSha = the Code commit that execution holds. Production's Preflight always says `none` for the last two (Beta's stay in the state chain).
// trigger (Beta's Preflight only; Production's has no such part) = which source started the run, read by Code's Preflight from the execution's own record: a Cloud release tag push
// (`cloud-tag@<tag>`), a Code mainline push (`code-push`), a person (`manual`), or a lookup that proved none of these (`unknown`). It decides CODE_RELEASE=from-trigger (lib/coderelease.ts).
// Parsed strictly: exactly the four parts (or the four and the trigger), in this order, each of its exact shape. A malformed value REFUSES (exit 3); nothing is guessed, defaulted or trimmed.
import { StageError } from "../types.ts";

/** Which source started the run (see the header). `null` in a CodeCtx = the part was not given (Production's Preflight, an older Code pipeline). */
export type CodeTrigger = { kind: "cloud-tag"; tag: string } | { kind: "code-push" } | { kind: "manual" } | { kind: "unknown" };

export interface CodeCtx {
  live: string;
  target: string | null;
  supersedes: { executionId: string; codeSha: string | null } | null;
  trigger: CodeTrigger | null;
}

const SHA40 = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const KEYS = ["live", "target", "supersedes", "supersedesSha"] as const;

const TRIGGER_TAG = /^cloud-tag@(v[0-9]+\.[0-9]+\.[0-9]+)$/u;
const refuse = (why: string): StageError => new StageError("REFUSED", `CODE_CTX is malformed (${why}); expected live:<40hex>,target:<40hex|none>,supersedes:<uuid|none>,supersedesSha:<40hex|none>[,trigger:<cloud-tag@vX.Y.Z|code-push|manual|unknown>]`);

export function parseCodeCtx(raw: string): CodeCtx {
  const parts = raw.split(",");
  if (parts.length !== KEYS.length && parts.length !== KEYS.length + 1) throw refuse(`${parts.length} parts, not ${KEYS.length} or ${KEYS.length + 1}`);
  const values: Record<string, string> = {};
  KEYS.forEach((key, index) => {
    const part = parts[index]!;
    const colon = part.indexOf(":");
    if (colon < 0 || part.slice(0, colon) !== key) throw refuse(`part ${index + 1} is not ${key}:<value>`);
    values[key] = part.slice(colon + 1);
  });
  const need = (key: string, ok: (value: string) => boolean, shape: string, allowNone: boolean): string | null => {
    const value = values[key]!;
    if (allowNone && value === "none") return null;
    if (!ok(value)) throw refuse(`${key} is not ${shape}${allowNone ? " or none" : ""}`);
    return value;
  };
  const live = need("live", (v) => SHA40.test(v), "a 40-hex commit", false)!;
  const target = need("target", (v) => SHA40.test(v), "a 40-hex commit", true);
  const executionId = need("supersedes", (v) => UUID.test(v), "an execution id", true);
  const codeSha = need("supersedesSha", (v) => SHA40.test(v), "a 40-hex commit", true);
  if (executionId === null && codeSha !== null) throw refuse("supersedesSha is set but supersedes is none");
  return { live, target, supersedes: executionId === null ? null : { executionId, codeSha }, trigger: parts.length === KEYS.length ? null : parseTrigger(parts[KEYS.length]!) };
}

function parseTrigger(part: string): CodeTrigger {
  if (!part.startsWith("trigger:")) throw refuse("part 5 is not trigger:<value>");
  const value = part.slice("trigger:".length);
  if (value === "code-push" || value === "manual" || value === "unknown") return { kind: value };
  const tag = TRIGGER_TAG.exec(value);
  if (tag === null) throw refuse("trigger is not cloud-tag@vX.Y.Z, code-push, manual or unknown");
  return { kind: "cloud-tag", tag: tag[1]! };
}
