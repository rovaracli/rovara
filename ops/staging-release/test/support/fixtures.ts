// A complete fake world for one Code pipeline execution: stacks, a release package, change sets, run records. Fake account 111111111111, fake ids only.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { World } from "./harness.ts";

export const ACCT = "111111111111";
export const EXEC_ID = "0123abcd-1111-4222-8333-444455556666";
export const EXEC8 = "0123abcd";
export const CS = `rovara-pipeline-${EXEC8}`;
export const SHA = "b".repeat(40);
const SHA_DEFAULT = SHA;
export const PREV = "a".repeat(40);
export const BUCKET = "rovara-staging-runs";
export const BOOTSTRAP = `cdk-hnb659fds-assets-${ACCT}-us-west-2`;
export const ROLE = `arn:aws:iam::${ACCT}:role/agentx/staging/agentx-staging-cloudformation`;
export const PARTS = ["access", "foundation", "identity", "runtime", "control-plane", "slack"] as const;
export const DEPLOY_ORDER = ["control-plane", "runtime", "slack", "foundation", "identity"] as const;
export const stack = (p: string): string => `agentx-staging-${p}`;
export const CID: Record<string, string> = {
  access: "AgentXAccess",
  foundation: "AgentXProductionFoundation",
  identity: "AgentXIdentity",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};
export const WORKER_URI = `${ACCT}.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/worker@sha256:${"4".repeat(64)}`;
export const SLACK_URI = `${ACCT}.dkr.ecr.us-west-2.amazonaws.com/agentx-staging/slack@sha256:${"5".repeat(64)}`;
export const ASSET_KEY = `${"c".repeat(64)}.zip`;

export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push("./" + p.slice(base.length + 1));
  }
  return out;
}
/** The release package hash, exactly as the pipeline and the shim compute it. */
export function dirHash(dir: string): string {
  const paths = walk(dir).sort();
  return sha256(paths.map((p) => `${sha256(readFileSync(join(dir, p)))}  ${p}\n`).join(""));
}
/** The canonical form the scripts hash for a template (`jq -cS .`). */
export function canon(doc: unknown): string {
  const r = spawnSync("jq", ["-cS", "."], { input: JSON.stringify(doc), encoding: "utf8" });
  return r.stdout;
}
export const canonSha = (doc: unknown): string => sha256(canon(doc));

const write = (p: string, body: string | Buffer): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};

export function templateOf(part: string): Record<string, unknown> {
  const params: Record<string, unknown> = { BootstrapVersion: { Type: "String", Default: "32" } };
  if (part === "runtime") params.WorkerImageUri = { Type: "String" };
  if (part === "slack") params.OrchestratorImageUri = { Type: "String" };
  if (part === "control-plane") params.CallbackSigningKey = { Type: "String", NoEcho: true };
  return { Parameters: params, Resources: { Thing: { Type: "AWS::SSM::Parameter", Properties: { Value: part } } } };
}

/** Writes the release package a fake Build would have made. Returns the package dir. */
export function writePackage(dir: string, opts: { assetBody?: string } = {}): string {
  const assetBody = opts.assetBody ?? "asset-zip-bytes";
  const manifest: Record<string, unknown> = { artifacts: {} };
  for (const p of PARTS) {
    (manifest.artifacts as Record<string, unknown>)[CID[p] as string] = { properties: { templateFile: `${CID[p]}.template.json` } };
    write(join(dir, "synth", `${CID[p]}.template.json`), JSON.stringify(templateOf(p), null, 1));
  }
  write(join(dir, "synth/manifest.json"), JSON.stringify(manifest));
  write(join(dir, "assets", ASSET_KEY), assetBody);
  write(join(dir, "asset-index.json"), JSON.stringify({ [ASSET_KEY]: { sha256: sha256(assetBody), bytes: assetBody.length, source: "asset.x", stack: "AgentXControlPlane" } }));
  write(join(dir, "answers.json"), JSON.stringify({ env: "staging", region: "us-west-2", account: ACCT, images: { worker: WORKER_URI, slack: SLACK_URI } }));
  write(join(dir, "overrides.json"), JSON.stringify({ runtime: { WorkerImageUri: WORKER_URI }, slack: { OrchestratorImageUri: SLACK_URI } }));
  write(join(dir, "images.json"), JSON.stringify([
    { repo: "agentx-staging/worker", digest: `sha256:${"4".repeat(64)}`, source: "built", key: "worker", uri: WORKER_URI },
    { repo: "agentx-staging/slack", digest: `sha256:${"5".repeat(64)}`, source: "built", key: "slack", uri: SLACK_URI },
  ]));
  write(join(dir, "npm-ci-dry-run.json"), JSON.stringify({ ok: true, exitCode: 0 }));
  return dir;
}

export function liveParams(part: string): Array<Record<string, string>> {
  const p: Array<Record<string, string>> = [{ ParameterKey: "BootstrapVersion", ParameterValue: "32" }];
  if (part === "runtime") p.push({ ParameterKey: "WorkerImageUri", ParameterValue: "old-worker" });
  if (part === "slack") p.push({ ParameterKey: "OrchestratorImageUri", ParameterValue: "old-slack" });
  if (part === "control-plane") p.push({ ParameterKey: "CallbackSigningKey", ParameterValue: "****" });
  return p;
}

/** The stacks of the fake environment: settled, with outputs, and no change sets. */
export function writeStacks(w: World, overrides: Partial<Record<string, string>> = {}): void {
  for (const p of PARTS) {
    const outputs = [];
    if (p === "access") outputs.push({ OutputKey: "CloudFormationRoleArn", OutputValue: ROLE });
    if (p === "control-plane") outputs.push({ OutputKey: "ApiEndpoint", OutputValue: "https://api.example.test" });
    if (p === "identity") outputs.push({ OutputKey: "UserPoolId", OutputValue: "pool-1" });
    w.answer(`cloudformation.describe-stacks.${stack(p)}.json`, { Stacks: [{ StackName: stack(p), StackStatus: overrides[p] ?? "UPDATE_COMPLETE", Parameters: liveParams(p), Outputs: outputs }] });
    w.answer(`cloudformation.list-change-sets.${stack(p)}.json`, { Summaries: [] });
    w.answer(`cloudformation.get-template.${stack(p)}.json`, { TemplateBody: { Resources: { Thing: { Type: "AWS::SSM::Parameter", Properties: { Value: "live" } } } } });
  }
}

export function changeSetDoc(part: string, status = "CREATE_COMPLETE", reason = ""): Record<string, unknown> {
  return {
    ChangeSetName: CS,
    ChangeSetId: csId(part),
    StackName: stack(part),
    Status: status,
    ExecutionStatus: status === "CREATE_COMPLETE" ? "AVAILABLE" : "UNAVAILABLE",
    StatusReason: reason || undefined,
    Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
    Parameters: liveParams(part).map((x) => ({ ParameterKey: x.ParameterKey, ParameterValue: x.ParameterValue })),
    Changes: status === "CREATE_COMPLETE" ? [{ Type: "Resource", ResourceChange: { Action: "Modify", LogicalResourceId: "Thing", ResourceType: "AWS::SSM::Parameter", Replacement: "False", Scope: ["Properties"], Details: [] } }] : [],
  };
}
export const csId = (part: string): string => `arn:aws:cloudformation:us-west-2:${ACCT}:changeSet/${CS}/${part.padEnd(12, "0").slice(0, 8)}-0000-4000-8000-000000000000`;

/** What Preview would find: change sets exist for every stack. */
export function writeChangeSets(w: World): void {
  for (const p of PARTS) {
    w.answer(`cloudformation.describe-change-set.${stack(p)}.${CS}.json`, changeSetDoc(p));
    w.answer(`cloudformation.create-change-set.${stack(p)}.json`, { Id: csId(p), StackId: `arn:aws:cloudformation:us-west-2:${ACCT}:stack/${stack(p)}/1` });
    w.answer(`cloudformation.get-template.${stack(p)}.${CS}.json`, { TemplateBody: templateOf(p) });
  }
}

export interface RunRecords {
  pkg: string;
  hash: string;
}
const put = (w: World, stage: string, name: string, body: string | Buffer): void => w.s3Put(BUCKET, `${stage}/${EXEC_ID}/${name}`, body);

/** The run records Deploy needs: check, preview, decide, guard, gates; and the package (copied into the fake S3 under build/<exec>/release/). */
export function writeRunRecords(w: World, pkgDir: string, opts: { verdict?: "AUTO" | "MANUAL"; installed?: string; sha?: string } = {}): RunRecords {
  const SHA = opts.sha ?? SHA_DEFAULT;
  const hash = dirHash(pkgDir);
  for (const rel of walk(pkgDir)) put(w, "build", `release/${rel.slice(2)}`, readFileSync(join(pkgDir, rel)));
  put(w, "check", "check.json", JSON.stringify({ sha: SHA, installed: opts.installed ?? PREV, holds: "0", pin: "x", mode: "auto-eligible" }));
  put(w, "preview", "release.sha256", hash + "\n");
  const changeSets = PARTS.map((p) => ({ stack: stack(p), part: p, changeSetName: CS, changeSetId: csId(p), status: "CREATE_COMPLETE", statusReason: "", noChanges: false, rows: 1, templateSha256: canonSha(templateOf(p)), paramsSha256: "0".repeat(64) }));
  put(w, "preview", "preview.json", JSON.stringify({ execution: EXEC_ID, sha: SHA, releasePackageSha256: hash, changeSetName: CS, changeSets, assets: [] }));
  put(w, "preview", "before-outputs.json", JSON.stringify([{ OutputKey: "ApiEndpoint", OutputValue: "https://api.example.test" }, { OutputKey: "UserPoolId", OutputValue: "pool-1" }, { OutputKey: "CloudFormationRoleArn", OutputValue: ROLE }]));
  put(w, "decide", "decision.json", JSON.stringify({ verdict: opts.verdict ?? "MANUAL", reasons: [], policy_hash: "p".repeat(64), record: { execution: EXEC_ID, sha: SHA, releasePackageSha256: hash, changeSets: changeSets.map((c) => ({ stack: c.stack, changeSetName: CS, changeSetId: c.changeSetId, status: c.status, noChanges: false, templateSha256: c.templateSha256 })), assets: [] } }));
  const verdict = opts.verdict ?? "MANUAL";
  const result = `Checker result\nREADY ${SHA}\n`;
  if (verdict === "MANUAL") put(w, "89", "RESULT.md", result);
  put(w, "guard", "guard.json", JSON.stringify({ ok: true, execution: EXEC_ID, sha: SHA, verdict, ...(verdict === "MANUAL" ? { resultSha256: sha256(result) } : {}) }));
  for (const [name, result] of [["15-gate", "pass"], ["25-gate", "pass"], ["45-gate", "pass"], ["46-gate", "skipped"]] as const) {
    put(w, "gates", `gates/${name}.json`, JSON.stringify({ name, sha: SHA, writtenAt: "2026-11-23T12:00:00Z", result, failures: [], ...(result === "skipped" ? { skippedReason: "DEC 254zzz397" } : {}) }));
  }
  return { pkg: pkgDir, hash };
}

export function writePointers(w: World, installed = PREV): void {
  w.answer("ssm.get-parameter.json", "{}");
  w.answer("ssm.get-parameter._rovara-release_staging_code-installed.json", { Parameter: { Value: installed } });
  w.answer("ssm.get-parameters-by-path.json", { Parameters: [] });
}

export const PIPE_ENV = (w: World): Record<string, string> => ({
  EXEC_ID,
  RELEASE_SHA: SHA,
  RUNS_BUCKET: BUCKET,
  PIPELINE_NAME: "rovara-staging-code-release",
  PARAM_PREFIX: "/rovara-release/staging",
  BRANCH: "code/next",
  WORK: `${w.work}/scratch`,
});
