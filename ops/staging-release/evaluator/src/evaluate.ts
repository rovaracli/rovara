// The staging auto-approve evaluator (plan v3 section 3). Pure: no network, no file or clock access; every input comes in as data.
// AUTO only if every check passes. Anything unknown, missing, unparsable, truncated or throwing is MANUAL with the reason recorded.
import { checkCi, checkGates, checkModeAndOrder, checkPathText, checkPaths, checkRequires, checkSha, REGION, type Fail } from "./checks.ts";
import { documentImageOk, evaluateChangeSets, newRun, parseImages, type RowVerdict, type VerifiedImage } from "./changeset.ts";
import { checkLockfile } from "./lockfile.ts";
import { parseManualPaths, parsePolicy, parseRollbackFloors, type PipelineConfig, type Policy } from "./policy.ts";
import {
  InputError,
  asArray,
  asNonEmptyString,
  asRecord,
  asString,
  canonicalJson,
  deepDiff,
  field,
  hasOwn,
  onlyKeys,
  parseJsonText,
  sha256Hex,
  HEX64,
} from "./util.ts";

export interface Reason {
  rule: string;
  code: string;
  message: string;
}

export interface Decision {
  verdict: "AUTO" | "MANUAL";
  reasons: Reason[];
  /** Non-blocking notes the pipeline must still raise (an alert), for example an audit backlog that did not stop a rollback. */
  alerts: Reason[];
  rows: RowVerdict[];
  pipeline: string | null;
  sha: string | null;
  policyHash: string | null;
  inputHash: string;
}

export const POLICY_FILES = ["auto-approve-policy.json", "manual-paths.txt", "rollback-floor.txt"] as const;
/** Where the pack keeps each policy file, spelled exactly as `sha256sum` prints it from inside ops/staging-release (the pipeline's pin command hashes `find . -type f`): the manifest uses these paths so
 *  the evaluator's hash IS the pipeline's pin hash (the stages compare the pin with `sha256sum`'s own lines). */
export const POLICY_FILE_PACK_PATH = (name: (typeof POLICY_FILES)[number]): string => `./policy/${name}`;
export const MANUAL_ONLY_PIN = "MANUAL-ONLY";

/** The combined policy hash: sha256 over the sorted manifest lines "<sha256>  <path>\n". Decide builds the manifest from the Ops pack (policy files, evaluator/**, order.txt). */
export function manifestHash(manifest: readonly { path: string; sha256: string }[]): string {
  const lines = [...manifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((m) => `${m.sha256}  ${m.path}\n`);
  return sha256Hex(lines.join(""));
}

interface Trusted {
  policy: Policy;
  manualGlobs: string[];
  floors: ReturnType<typeof parseRollbackFloors>;
  hash: string;
}

/** P-EDIT: the policy is used only when its combined hash equals the pinned value, and the files handed in are the files the manifest hashed. */
function trustPolicy(root: Record<string, unknown>, fail: Fail): Trusted | null {
  const files = asRecord(field(root, "policyFiles", "input"), "policyFiles");
  onlyKeys(files, [...POLICY_FILES], "policyFiles");
  const manifestRaw = asArray(field(root, "policyManifest", "input"), "policyManifest");
  const manifest = manifestRaw.map((item, i) => {
    const m = asRecord(item, `policyManifest[${i}]`);
    onlyKeys(m, ["path", "sha256"], `policyManifest[${i}]`);
    const sha = asString(field(m, "sha256", `policyManifest[${i}]`), `policyManifest[${i}].sha256`);
    if (!HEX64.test(sha)) throw new InputError("input-invalid", `policyManifest[${i}].sha256 is not 64 hex`);
    return { path: asNonEmptyString(field(m, "path", `policyManifest[${i}]`), `policyManifest[${i}].path`), sha256: sha };
  });
  if (new Set(manifest.map((m) => m.path)).size !== manifest.length) throw new InputError("input-invalid", "policyManifest has a duplicate path");
  const pin = asNonEmptyString(field(root, "policyPin", "input"), "policyPin");
  const hash = manifestHash(manifest);
  if (pin === MANUAL_ONLY_PIN) {
    fail("P-EDIT", "pin-manual-only", "the policy pin is MANUAL-ONLY");
    return null;
  }
  if (!HEX64.test(pin)) {
    fail("P-EDIT", "pin-invalid", "the policy pin is not a sha256");
    return null;
  }
  if (pin !== hash) {
    fail("P-EDIT", "pin-mismatch", "the policy files do not match the pinned hash: a policy change is always MANUAL");
    return null;
  }
  for (const name of POLICY_FILES) {
    const text = asString(field(files, name, "policyFiles"), `policyFiles.${name}`);
    const entry = manifest.find((m) => m.path === POLICY_FILE_PACK_PATH(name));
    if (entry === undefined || entry.sha256 !== sha256Hex(text)) {
      fail("P-EDIT", "policy-file-hash", `${name} is not the file the pinned manifest hashed`);
      return null;
    }
  }
  return {
    policy: parsePolicy(files["auto-approve-policy.json"]),
    manualGlobs: parseManualPaths(files["manual-paths.txt"]),
    floors: parseRollbackFloors(files["rollback-floor.txt"]),
    hash,
  };
}

/** answers.json and overrides.json: equal to the last-good run's except the allowed image paths, and a changed value must carry a verified digest. */
function checkDocuments(root: Record<string, unknown>, key: "answers" | "overrides", allowed: readonly string[], verified: readonly VerifiedImage[], accountId: string, fail: Fail): void {
  const doc = asRecord(field(root, key, "input"), key);
  onlyKeys(doc, ["lastGood", "current"], key);
  const last = parseJsonText(field(doc, "lastGood", key), `${key}.lastGood`);
  const current = parseJsonText(field(doc, "current", key), `${key}.current`);
  for (const d of deepDiff(last, current)) {
    const dotted = d.path.map(String);
    const ok = allowed.some((pattern) => {
      const segs = pattern.split(".");
      return segs.length === dotted.length && segs.every((s, i) => s === "*" || s === dotted[i]);
    });
    if (!ok) fail("E", `${key}-differs`, `${key}.json differs from last-good at ${dotted.join(".")}`);
    else if (d.kind !== "change") fail("E", `${key}-differs`, `${key}.json ${d.kind === "add" ? "adds" : "removes"} ${dotted.join(".")}`);
    else if (typeof d.after !== "string" || !documentImageOk(d.after, verified, accountId)) {
      // Exact, not "contains": a bare verified digest, or a full URI in this account and region whose repo and digest this run verified.
      fail("E", `${key}-image`, `${key}.json value at ${dotted.join(".")} is not a digest or image URI this run verified`);
    }
  }
}

function describe(error: unknown): { code: string; message: string } {
  if (error instanceof InputError) return { code: error.code, message: error.message };
  return { code: "evaluator-error", message: `the evaluator hit an unexpected error (${error instanceof Error ? error.name : "unknown"})` };
}

export function evaluate(rawInput: unknown): Decision {
  const reasons: Reason[] = [];
  const alerts: Reason[] = [];
  const fail: Fail = (rule, code, message) => {
    reasons.push({ rule, code, message });
  };
  const alert: Fail = (rule, code, message) => {
    alerts.push({ rule, code, message });
  };
  let inputHash = "";
  try {
    inputHash = sha256Hex(canonicalJson(rawInput));
  } catch {
    fail("input", "input-unhashable", "the input could not be hashed");
  }
  let rows: RowVerdict[] = [];
  let pipelineName: string | null = null;
  let sha: string | null = null;
  let policyHash: string | null = null;
  const guard = (rule: string, fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      const d = describe(error);
      fail(rule, d.code, d.message);
    }
  };
  try {
    const root = asRecord(rawInput, "input");
    onlyKeys(root, [
      "pipeline", "sha", "previousInstalledSha", "tree", "now", "environment", "checkMode", "holdParameters", "unauditedAutoRuns", "trigger", "ancestry", "policyFiles",
      "policyManifest", "policyPin", "changedPaths", "releaseNotes", "lock", "npmCiDryRun", "stacks", "images", "gates", "ci", "answers", "overrides",
    ], "input");
    const name = asString(field(root, "pipeline", "input"), "pipeline");
    if (name !== "code" && name !== "cloud") throw new InputError("input-invalid", `pipeline "${name}" is not code or cloud`);
    pipelineName = name;
    sha = checkSha(field(root, "sha", "input"), "sha");
    const previous = checkSha(field(root, "previousInstalledSha", "input"), "previousInstalledSha");

    let trusted: Trusted | null = null;
    guard("P-EDIT", () => {
      trusted = trustPolicy(root, fail);
    });
    if (trusted === null) {
      if (reasons.length === 0) fail("P-EDIT", "policy-untrusted", "the policy could not be trusted");
      return { verdict: "MANUAL", reasons, alerts, rows, pipeline: pipelineName, sha, policyHash, inputHash };
    }
    const t = trusted as Trusted;
    policyHash = t.hash;
    const pipeline = t.policy.pipelines.get(name) as PipelineConfig;
    const env = asRecord(field(root, "environment", "input"), "environment");
    onlyKeys(env, ["accountId", "region"], "environment");
    const accountId = asString(field(env, "accountId", "environment"), "environment.accountId");
    if (!/^\d{12}$/.test(accountId)) throw new InputError("input-invalid", "environment.accountId is not a 12-digit id");
    if (env.region !== REGION) fail("E", "region", `the region is "${String(env.region)}", not ${REGION}`);
    const tree = asString(field(root, "tree", "input"), "tree");
    const now = Date.parse(asString(field(root, "now", "input"), "now"));
    if (Number.isNaN(now)) throw new InputError("input-invalid", "now is not a timestamp");

    let rollback = false;
    guard("A", () => {
      rollback = checkModeAndOrder(root, t.policy, t.floors, pipeline, sha as string, previous, fail, alert).kind === "rollback";
    });
    const changed: string[] = [];
    guard("D", () => {
      const paths = asArray(field(root, "changedPaths", "input"), "changedPaths").map((p, i) => checkPathText(p, i));
      changed.push(...paths);
      // A rollback checks the manual list (not the allow-list) over the range it would undo; changedPaths and releaseNotes are that range (target..installed).
      checkPaths(paths, t.policy, t.manualGlobs, fail, rollback);
    });
    if (!rollback) {
      guard("B", () => checkGates(root, t.policy, pipeline, sha as string, now, fail));
      guard("C", () => checkCi(root, pipeline, fail));
      if (changed.includes(t.policy.lockfile.path)) {
        guard("J", () => {
          for (const failure of checkLockfile(field(root, "lock", "input"), changed, t.policy, field(root, "npmCiDryRun", "input"))) fail("J", "lockfile", failure);
        });
      }
    }
    guard("K", () => checkRequires(root, changed, t.policy, fail));
    let verifiedImages: readonly VerifiedImage[] = [];
    guard("F", () => {
      const verified = parseImages(field(root, "images", "input"), tree, fail);
      const run = newRun(t.policy, pipeline, accountId, verified, fail);
      const result = evaluateChangeSets(run, { accountId, stacks: field(root, "stacks", "input"), images: [], tree });
      rows = result.rows;
      verifiedImages = result.verified;
    });
    guard("E", () => checkDocuments(root, "answers", pipeline.answersAllowedDiffPaths, verifiedImages, accountId, fail));
    guard("E", () => checkDocuments(root, "overrides", pipeline.overridesAllowedDiffPaths, verifiedImages, accountId, fail));
    if (rollback) {
      // A rollback never deploys the access stack: its rows were judged above, and any real access row is a stack-scope failure.
      for (const row of rows) {
        const stack = pipeline.stacks.get(row.stack);
        if (stack?.access === true && row.rule !== "R7" && row.rule !== "R8") fail("P-RB", "rollback-access", `a rollback never deploys the access stack (${row.stack}/${row.logicalId})`);
      }
    }
  } catch (error) {
    const d = describe(error);
    fail("input", d.code, d.message);
  }
  return { verdict: reasons.length === 0 ? "AUTO" : "MANUAL", reasons, alerts, rows, pipeline: pipelineName, sha, policyHash, inputHash };
}

export { hasOwn };
