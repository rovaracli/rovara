// Rehearsal of the stage CLI's change-set path against REAL CloudFormation, on throwaway stacks (briefs/beta-move/STAGE-CLI-REHEARSAL-RUNBOOK.md).
// It runs the stage CLI's own code, not a copy: the real ports (ops/pipeline/ports.ts: describe/execute/delete/list change sets, the deploy role), the real
// previewChangeSets / executeRecorded / tidyChangeSets / discardChangeSets (lib/changesets.ts), the real gate runner and the real change-set-integrity gate,
// and the real step runner (runStep) for a failing step, so the tidy-on-failure is proven on CloudFormation, not on a fake.
// Only `cdk deploy --no-execute` is replaced: the three scratch stacks are a few WaitConditionHandle resources (no IAM, no cost), so the change sets come from
// `aws cloudformation create-change-set` with an inline template.
//
// SAFETY: every stack this touches is named rovara-scratch-proof-<timestamp>-beta-<part>; the name is checked before every CloudFormation call; the account STS
// reports must equal ROVARA_REHEARSAL_PROOF_ACCOUNT (set by the controller; never in a file); the region must be the beta row's. --dry-run makes NO AWS call.
// The scratch stacks are deleted at the end, also after a failure.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, stackName, changeSetNameFor } from "../config.ts";
import type { PipelineConfig } from "../config.ts";
import { gate as integrityGate } from "../gates/change-set-integrity.gate.ts";
import { discardChangeSets, executeRecorded, previewChangeSets, tidyChangeSets } from "../lib/changesets.ts";
import type { Inputs, StepContext } from "../lib/context.ts";
import { newStageRecord, stageOf } from "../lib/manifest.ts";
import { gatePhase, runStep } from "../lib/run.ts";
import type { State, StepFunction } from "../lib/run.ts";
import { assumeDeployRole, createRealPorts } from "../ports.ts";
import { loadSwitches, rowFor } from "../switches.ts";
import type { SwitchesRow } from "../switches.ts";
import { StageError } from "../types.ts";
import type { ChangeSetRecord, Gate, Manifest, Ports, StackPart } from "../types.ts";

export const SCRATCH_PREFIX = "rovara-scratch-proof-";
export const PROOF_ACCOUNT_ENV = "ROVARA_REHEARSAL_PROOF_ACCOUNT";
const PARTS: readonly StackPart[] = ["gateway", "web", "app"];
const SCRATCH_NAME = /^rovara-scratch-proof-[a-z0-9][a-z0-9-]{0,80}$/u;

/** Refuses any stack name that is not a scratch one. Called before every CloudFormation call this script makes (the real ports are wrapped with it). */
export function assertScratchName(name: string): void {
  if (!SCRATCH_NAME.test(name)) throw new StageError("REFUSED", `refusing to touch the stack ${JSON.stringify(name)}: the rehearsal only touches stacks named ${SCRATCH_PREFIX}<timestamp>-...`);
}

/** The real (or fake) ports with a scratch-name check in front of every CloudFormation method. */
export function guardPorts(ports: Ports): Ports {
  const c = ports.cfn;
  return {
    ...ports,
    cfn: {
      describeStack: (s) => { assertScratchName(s); return c.describeStack(s); },
      describeChangeSet: (s, n) => { assertScratchName(s); return c.describeChangeSet(s, n); },
      templateSha256: (s, n) => { assertScratchName(s); return c.templateSha256(s, n); },
      liveTemplateSha256: (s) => { assertScratchName(s); return c.liveTemplateSha256(s); },
      executeChangeSet: (s, n) => { assertScratchName(s); return c.executeChangeSet(s, n); },
      deleteChangeSet: (s, n) => { assertScratchName(s); return c.deleteChangeSet(s, n); },
      listChangeSetNames: (s) => { assertScratchName(s); return c.listChangeSetNames(s); },
      waitSettled: (s, t) => { assertScratchName(s); return c.waitSettled(s, t); },
    },
  };
}

/** `rovara-scratch-proof-YYYYMMDDHHMMSS` (UTC). */
export function scratchPrefixFor(now: Date): string {
  return `${SCRATCH_PREFIX}${now.toISOString().replace(/[-:T]/gu, "").slice(0, 14)}`;
}

/** The stage CLI's config with its three stacks renamed to scratch ones (the stack ids and everything else stay). */
export function scratchConfig(base: PipelineConfig, prefix: string): PipelineConfig {
  assertScratchName(prefix);
  return { ...base, stackNames: { gateway: `${prefix}-{env}-gateway`, web: `${prefix}-{env}-web`, app: `${prefix}-{env}-app`, gatewayImages: `${prefix}-{env}-gateway-images` } };
}

/** One tiny template: N WaitConditionHandles (no permissions, no cost) and one output. Changing only `version` is a change set with no resource rows (the beta incident's shape). */
export function templateFor(version: number, handles: readonly string[]): string {
  return JSON.stringify({
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Rovara stage CLI rehearsal: a scratch stack, safe to delete",
    Resources: Object.fromEntries(handles.map((h) => [h, { Type: "AWS::CloudFormation::WaitConditionHandle" }])),
    Outputs: { RehearsalVersion: { Value: String(version) } },
  });
}

/** What the rehearsal needs from AWS besides the stage CLI's own ports: make a change set from a template, delete a scratch stack. */
export interface RehearsalAws {
  createChangeSet(a: { stack: string; name: string; type: "CREATE" | "UPDATE"; template: string; tag: string }): Promise<void>;
  deleteStack(stack: string): Promise<void>;
}

/** The real thing: CloudFormation as the CDK bootstrap deploy role (as the stage CLI's ports do), changing stacks with the bootstrap's CloudFormation execution role (as cdk does). */
export function realRehearsalAws(ports: Ports, config: PipelineConfig, region: string, exec8: string): RehearsalAws {
  let creds: Record<string, string> | null = null;
  const env = async (): Promise<Record<string, string>> => (creds ??= await assumeDeployRole(ports.aws, config, region, exec8, await ports.sts.account()));
  return {
    async createChangeSet(a) {
      assertScratchName(a.stack);
      const acct = await ports.sts.account();
      const role = `arn:aws:iam::${acct}:role/cdk-${config.bootstrapQualifier}-cfn-exec-role-${acct}-${region}`;
      await ports.aws.json(["cloudformation", "create-change-set", "--stack-name", a.stack, "--change-set-name", a.name, "--change-set-type", a.type, "--template-body", a.template, "--role-arn", role, "--tags", `Key=rovara-rehearsal,Value=${a.tag}`], { env: await env(), profile: null });
    },
    async deleteStack(stack) {
      assertScratchName(stack);
      await ports.aws.json(["cloudformation", "delete-stack", "--stack-name", stack], { env: await env(), profile: null });
    },
  };
}

export interface Check { name: string; ok: boolean; detail: string }

export interface RehearseOptions {
  ports: Ports;
  aws: RehearsalAws;
  /** The scratch config (scratchConfig). */
  config: PipelineConfig;
  row: SwitchesRow;
  proofAccount: string;
  region: string;
  /** Stack tag value (the timestamp). */
  tag: string;
  outDir: string;
  workDir: string;
  /** Three distinct 8-hex ids: the first deploy, the update, the failing run. The third is the head of the failing run's execution id. */
  exec8s: readonly [string, string, string];
  out: (line: string) => void;
  /** Checked between scenarios: true = stop early (a SIGINT); the cleanup still runs. */
  interrupted?: () => boolean;
}

export interface RehearseResult { ok: boolean; checks: Check[]; leftovers: string[] }

const sleepLong = 10_000;

export async function rehearse(o: RehearseOptions): Promise<RehearseResult> {
  const ports = guardPorts(o.ports);
  const { config, aws } = o;
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = ""): void => { checks.push({ name, ok, detail }); o.out(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`); };
  const info = (line: string): void => { o.out(`INFO ${line}`); };
  const names = Object.fromEntries(PARTS.map((part) => [part, stackName(config, "beta", part)])) as Record<StackPart, string>;
  const allStacks = PARTS.map((part) => names[part]);
  for (const stack of allStacks) assertScratchName(stack);

  // The account check comes first: nothing is created in an account that is not the proof account.
  const account = await ports.sts.account();
  if (account !== o.proofAccount) throw new StageError("REFUSED", `STS says this is not the proof account (${PROOF_ACCOUNT_ENV} does not match the credentials in use): nothing is created`);
  info(`proof account confirmed; scratch stacks: ${allStacks.join(", ")}`);

  // What each stack's template is now (a new change set must differ from it, or CloudFormation says "no changes").
  const current: Record<StackPart, string> = { gateway: "", web: "", app: "" };
  let next: Record<StackPart, string> = { gateway: "", web: "", app: "" };
  const byId = (id: string): StackPart => PARTS.find((part) => config.stackIds[part] === id)!;
  const waitCreated = async (stack: string, name: string): Promise<void> => {
    for (let read = 0; read < 24; read += 1) {
      const found = await ports.cfn.describeChangeSet(stack, name);
      if (found !== null && found.status !== "CREATE_PENDING" && found.status !== "CREATE_IN_PROGRESS") return;
      await ports.clock.sleep(5000);
    }
  };
  // The stand-in for `cdk deploy --no-execute`: a change set per named stack from its next template, then the same wait cdk does.
  const makePreviewPorts = (): Ports => ({
    ...ports,
    cdk: {
      async deployNoExecute(a) {
        for (const s of a.stacks) {
          const type = (await ports.cfn.describeStack(s.stackName)) === null ? "CREATE" : "UPDATE";
          await aws.createChangeSet({ stack: s.stackName, name: a.changeSetName, type, template: next[byId(s.stackId)], tag: o.tag });
          await waitCreated(s.stackName, a.changeSetName);
        }
      },
    },
  });
  const preview = (name: string, parts: readonly StackPart[]): Promise<ChangeSetRecord[]> => previewChangeSets({
    ports: makePreviewPorts(), dir: o.workDir, changeSetName: name, stacks: parts.map((part) => ({ part, stack: names[part], stackId: config.stackIds[part] })), context: {}, parameters: {}, log: (line) => { info(line); },
  });
  const passGate: Gate = { name: "rehearsal-pass", phases: ["change-sets"], run: () => Promise.resolve({ result: "pass" }) };
  const refusingGate: Gate = { name: "rehearsal-refuses", phases: ["change-sets"], run: () => Promise.resolve({ result: "fail", failures: ["the rehearsal refuses on purpose, to prove the failure path tidies"] }) };
  const inputsFor = (execId: string): Inputs => ({
    execId, cloudRef: null, cloudSourceCommit: null, codeRelease: "skip", cloudProd: false, codeSha: null, codeLiveSha: null, codeLiveFacts: {}, supersedes: null, codeTarget: null, declaredRollback: false, codeCtxGiven: true, adopt: false,
    gatewayDigest: null, target: null, dryRun: false, region: o.region, expectedAccount: o.proofAccount, manifestPath: null, outDir: o.outDir, workDir: o.workDir,
  });
  const ctxFor = (execId: string, gates: readonly Gate[], required: readonly string[]): StepContext => ({
    env: "beta", step: "preflight", config, row: o.row, contextFor: () => ({}), codeUrl: "https://rehearsal.invalid", account: null, inputs: inputsFor(execId), ports, gates,
    requiredGates: { preflight: [], "change-sets": [...required], "gateway-live": [], proof: [] }, pipelineDir: process.cwd(), log: (line) => { info(line); },
  });
  const manifestFor = (execId: string): Manifest => ({
    schema: 1, executionId: execId, exec8: execId.slice(0, 8), createdAt: ports.clock.now().toISOString(), mode: "release",
    cloud: { tag: "v0.0.0-rehearsal", sha: "0".repeat(40), ref: "CLOUD_REF", trunk: "cloud/next", liveSha: { beta: null, production: null } },
    code: { sha: null, release: "skip", requestedRelease: "skip", pinnedSha: { beta: null, production: null }, supersedes: null, liveSha: { beta: null, production: null }, rollbackTarget: null },
    gateway: { digest: null, source: null, imageTag: null, repository: null }, stages: {},
  });
  const executionId = (exec8: string): string => `${exec8}-0000-4000-8000-${"0".repeat(12)}`;
  const noneLeft = async (name: string, stacks: readonly string[]): Promise<string[]> => {
    const left: string[] = [];
    for (const stack of stacks) { try { if ((await ports.cfn.listChangeSetNames(stack)).includes(name)) left.push(stack); } catch { /* a stack that is gone has none */ } }
    return left;
  };

  const leftovers: string[] = [];
  try {
    // ---- 1. the first deploy (CREATE change sets), gates, execute, verify by the stack, tidy ----
    const [e1, e2, e3] = o.exec8s;
    const name1 = changeSetNameFor(e1);
    next = { gateway: templateFor(1, ["Handle1"]), web: templateFor(1, ["Handle1"]), app: templateFor(1, ["Handle1"]) };
    const records1 = await preview(name1, PARTS);
    check("first deploy: every stack gets a CREATE_COMPLETE change set, none is 'no changes'", records1.every((r) => !r.noChanges && r.status === "CREATE_COMPLETE" && r.changeSetId !== null));
    const manifest1 = manifestFor(executionId(e1));
    manifest1.stages.beta = newStageRecord("beta", ports.clock.now(), false);
    const state1: State = { manifest: manifest1 };
    await gatePhase(ctxFor(executionId(e1), [integrityGate, passGate], ["change-set-integrity", "rehearsal-pass"]), state1, stageOf(manifest1, "beta"), "change-sets", records1, null, o.workDir);
    check("first deploy: the real change-set-integrity gate passes", stageOf(manifest1, "beta").gates.every((g) => g.result === "pass"));
    const done1 = await executeRecorded({ ports, records: records1, settleTimeoutSeconds: 900, log: (line) => { info(line); } });
    check("first deploy: every stack is verified by the STACK (its ChangeSetId is the recorded id) and ends CREATE_COMPLETE", done1.every((r) => r.finalStatus === "CREATE_COMPLETE"));
    for (const r of records1) {
      const after = await ports.cfn.describeChangeSet(r.stack, name1);
      info(`${r.stack}: describe-change-set by name after the execute is ${after === null ? "NOT FOUND (CloudFormation deleted it: why the old by-name check always failed)" : `still there (${after.executionStatus})`}`);
      const stack = await ports.cfn.describeStack(r.stack);
      check(`first deploy: ${r.part} stack's ChangeSetId equals the recorded change set id`, stack !== null && stack.changeSetId === r.changeSetId, stack === null ? "stack missing" : `${String(stack.changeSetId).slice(-12)} vs ${String(r.changeSetId).slice(-12)}`);
    }
    await tidyChangeSets(ports, allStacks, name1, (line) => { info(line); });
    check("first deploy: tidy leaves no change set of this run", (await noneLeft(name1, allStacks)).length === 0);
    for (const part of PARTS) current[part] = next[part];
    if (o.interrupted?.() === true) throw new StageError("REFUSED", "interrupted");

    // ---- 2. an update that only changes an output (the beta incident's shape), a resource added, a retried action ----
    const name2 = changeSetNameFor(e2);
    next = { gateway: templateFor(2, ["Handle1"]), web: templateFor(2, ["Handle1", "Handle2"]), app: templateFor(2, ["Handle1"]) };
    const records2 = await preview(name2, PARTS);
    check("update: every stack gets a CREATE_COMPLETE change set", records2.every((r) => !r.noChanges && r.status === "CREATE_COMPLETE"));
    const gatewayRow = records2.find((r) => r.part === "gateway")!;
    info(`gateway change set (outputs only): +${gatewayRow.counts.add} ~${gatewayRow.counts.modify} -${gatewayRow.counts.remove}, ${gatewayRow.rows.length} resource row(s)`);
    check("update: the web change set adds the new resource", records2.find((r) => r.part === "web")!.counts.add === 1);
    const done2 = await executeRecorded({ ports, records: records2, settleTimeoutSeconds: 900, log: (line) => { info(line); } });
    check("update: the incident shape (an outputs-only change set) executes and is verified by the stack, ending UPDATE_COMPLETE", done2.every((r) => r.finalStatus === "UPDATE_COMPLETE"));
    const before = await ports.cfn.describeStack(names.gateway);
    await executeRecorded({ ports, records: records2, settleTimeoutSeconds: 900, log: (line) => { info(line); } });
    const again = await ports.cfn.describeStack(names.gateway);
    check("update: a retried action waits for the executed stack instead of executing again (LastUpdatedTime unchanged)", before !== null && again !== null && before.lastUpdatedTime === again.lastUpdatedTime && before.changeSetId === again.changeSetId);
    for (const part of PARTS) current[part] = next[part];
    if (o.interrupted?.() === true) throw new StageError("REFUSED", "interrupted");

    // ---- 3. a step fails after its change sets were previewed: the real runner tidies every stack, by this run's name only ----
    const name3 = changeSetNameFor(e3);
    const bystander = "rovara-pipeline-0b5e4d00";
    next = { gateway: templateFor(8, ["Handle1"]), web: templateFor(8, ["Handle1", "Handle2"]), app: templateFor(8, ["Handle1"]) };
    await aws.createChangeSet({ stack: names.web, name: bystander, type: "UPDATE", template: next.web, tag: o.tag }); // another execution's change set: must survive
    await waitCreated(names.web, bystander);
    next = { gateway: templateFor(3, ["Handle1"]), web: templateFor(3, ["Handle1", "Handle2", "Handle3"]), app: templateFor(3, ["Handle1"]) };
    const failingStep: StepFunction = async (ctx, state) => {
      const manifest = manifestFor(ctx.inputs.execId);
      manifest.stages.beta = newStageRecord("beta", ports.clock.now(), false);
      state.manifest = manifest;
      const stage = stageOf(manifest, "beta");
      stage.changeSets = await preview(name3, PARTS);
      await gatePhase(ctx, state, stage, "change-sets", stage.changeSets, null, o.workDir); // the refusing gate throws GATE_FAILED here
    };
    let failure: unknown = null;
    try { await runStep(ctxFor(executionId(e3), [integrityGate, refusingGate], ["change-set-integrity", "rehearsal-refuses"]), failingStep); } catch (error) { failure = error; }
    check("failure path: the step fails with GATE_FAILED (the refusing gate)", failure instanceof StageError && failure.exitName === "GATE_FAILED", failure instanceof Error ? failure.message : "it did not fail");
    const left = await noneLeft(name3, allStacks);
    check("failure path: the runner deleted this run's change set on EVERY stack (gateway, web, app)", left.length === 0, left.length === 0 ? "" : `left on ${left.join(", ")}`);
    check("failure path: another execution's change set on the web stack was not touched", (await ports.cfn.listChangeSetNames(names.web)).includes(bystander));
    if (o.interrupted?.() === true) throw new StageError("REFUSED", "interrupted");

    // ---- 4. a change set with nothing to change: CloudFormation's own "didn't contain changes" is recorded as no changes, never executed, and tidied ----
    const name4 = changeSetNameFor(randomBytes(4).toString("hex"));
    next = { ...current };
    const records4 = await preview(name4, ["app"]);
    check("no changes: CloudFormation's \"didn't contain changes\" answer is recorded as noChanges", records4.length === 1 && records4[0]!.noChanges && records4[0]!.changeSetId === null);
    const done4 = await executeRecorded({ ports, records: records4, settleTimeoutSeconds: 60, log: (line) => { info(line); } });
    check("no changes: nothing is executed", done4[0]!.executedAt === null);
    await discardChangeSets(ports, [names.app], name4, (line) => { info(line); });
    check("no changes: the empty change set is deleted", (await noneLeft(name4, [names.app])).length === 0);
  } catch (error) {
    check("the rehearsal ran to the end", false, error instanceof Error ? error.message : String(error));
  } finally {
    // Cleanup, always: delete every scratch stack and wait for it to be gone.
    for (const stack of allStacks) {
      try {
        if ((await ports.cfn.describeStack(stack)) === null) continue;
        await aws.deleteStack(stack);
        info(`${stack}: delete requested`);
      } catch (error) { info(`${stack}: delete request failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const stack of allStacks) {
      let gone = false;
      for (let poll = 0; poll < 90 && !gone; poll += 1) {
        try { gone = (await ports.cfn.describeStack(stack)) === null; } catch { /* asked again */ }
        if (!gone) await ports.clock.sleep(sleepLong);
      }
      if (!gone) leftovers.push(stack);
    }
    info(leftovers.length === 0 ? "cleanup: every scratch stack is deleted" : `cleanup: NOT DELETED, delete by hand: ${leftovers.join(", ")}`);
  }
  const ok = leftovers.length === 0 && checks.every((c) => c.ok) && checks.length > 0;
  return { ok, checks, leftovers };
}

/** The calls a real run makes, in order, for --dry-run (nothing is called). */
export function plannedCalls(config: PipelineConfig, prefix: string, region: string): string[] {
  const stacks = PARTS.map((part) => stackName(config, "beta", part));
  const cf = (rest: string): string => `aws cloudformation ${rest} --region ${region}`;
  const each = (f: (s: string) => string): string[] => stacks.map(f);
  return [
    `aws sts get-caller-identity   (the account must equal $${PROOF_ACCOUNT_ENV}; otherwise REFUSED, nothing is created)`,
    `aws sts assume-role cdk-${config.bootstrapQualifier}-deploy-role-<proof account>-${region}   (every CloudFormation call below runs as this role)`,
    "-- 1. first deploy",
    ...each((s) => cf(`create-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec1> --change-set-type CREATE --template-body <1 handle, output 1> --role-arn cdk-${config.bootstrapQualifier}-cfn-exec-role-...`)),
    ...each((s) => cf(`describe-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec1>   (+ get-template --change-set-name)`)),
    "   gates: the real change-set-integrity gate + rehearsal-pass",
    ...each((s) => cf(`execute-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec1>   (then describe-stacks until settled: ChangeSetId == the recorded id, CREATE_COMPLETE)`)),
    ...each((s) => cf(`list-change-sets --stack-name ${s}   (tidy: none of this run's left)`)),
    "-- 2. update (gateway and app: only the output changes; web: one resource added), then a retried action",
    ...each((s) => cf(`create-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec2> --change-set-type UPDATE ...`)),
    ...each((s) => cf(`execute-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec2>   (verified by describe-stacks: ChangeSetId, UPDATE_COMPLETE, LastUpdatedTime)`)),
    "   the same records are run again: the stacks are waited for, nothing is executed twice",
    "-- 3. failure path (the real runStep)",
    cf(`create-change-set --stack-name ${stacks[1]} --change-set-name rovara-pipeline-0b5e4d00 --change-set-type UPDATE ...   (another execution's change set: must survive)`),
    ...each((s) => cf(`create-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec3> --change-set-type UPDATE ...`)),
    "   the rehearsal-refuses gate fails the step; runStep deletes this run's change set on every stack:",
    ...each((s) => cf(`delete-change-set --stack-name ${s} --change-set-name rovara-pipeline-<exec3>`)),
    "-- 4. no changes",
    cf(`create-change-set --stack-name ${stacks[2]} --change-set-name rovara-pipeline-<exec4> --change-set-type UPDATE   (the template it already has: "didn't contain changes")`),
    cf(`delete-change-set --stack-name ${stacks[2]} --change-set-name rovara-pipeline-<exec4>`),
    "-- cleanup (always, also after a failure)",
    ...each((s) => cf(`delete-stack --stack-name ${s}   (then describe-stacks until it is gone)`)),
    `(all stacks are named ${prefix}-beta-<part>; any other stack name is refused before the call)`,
  ];
}

export interface CliEnv { [name: string]: string | undefined }

export async function main(argv: readonly string[], env: CliEnv, out: (line: string) => void = (line) => { process.stdout.write(`${line}\n`); }, now: () => Date = () => new Date()): Promise<number> {
  try {
    const flags = new Set(argv);
    for (const flag of flags) if (flag !== "--dry-run" && flag !== "--help") throw new StageError("USAGE", `unknown argument ${flag} (use --dry-run or --help)`);
    if (flags.has("--help")) {
      out(`usage: node ops/pipeline/rehearsal/stage-cli-rehearsal.ts [--dry-run]\nenv: ${PROOF_ACCOUNT_ENV} (the beta PROOF account id), AWS_REGION (the beta row's region), ROVARA_PIPELINE_PROFILE (the profile of a role in that account; default: config.json's beta profile)`);
      return 0;
    }
    const base = loadConfig();
    const row = rowFor("beta", loadSwitches());
    const proofAccount = env[PROOF_ACCOUNT_ENV] ?? "";
    if (!/^[0-9]{12}$/u.test(proofAccount)) throw new StageError("REFUSED", `${PROOF_ACCOUNT_ENV} must be set to the 12-digit id of the beta PROOF account (the controller sets it; it is never in a file)`);
    const region = env.AWS_REGION ?? "";
    if (region === "") throw new StageError("REFUSED", "AWS_REGION is not set");
    if (region !== row.region) throw new StageError("REFUSED", `AWS_REGION is ${region}; the beta row is ${row.region} (switches.json)`);
    const started = now();
    const prefix = scratchPrefixFor(started);
    const config = scratchConfig(base, prefix);
    for (const part of PARTS) assertScratchName(stackName(config, "beta", part));
    const profile = env.ROVARA_PIPELINE_PROFILE !== undefined && env.ROVARA_PIPELINE_PROFILE !== "" ? env.ROVARA_PIPELINE_PROFILE : base.environments.beta.profile;
    if (flags.has("--dry-run")) {
      out(`REHEARSAL DRY RUN: no AWS call is made. Profile ${profile ?? "(none: the default credential chain)"}, region ${region}, scratch stacks ${PARTS.map((part) => stackName(config, "beta", part)).join(", ")}`);
      for (const line of plannedCalls(config, prefix, region)) out(`  ${line}`);
      return 0;
    }
    const exec8s = [randomBytes(4).toString("hex"), randomBytes(4).toString("hex"), randomBytes(4).toString("hex")] as const;
    const ports = createRealPorts({ config, env: "beta", region, exec8: exec8s[0], profile, cwd: process.cwd() });
    let stop = false;
    process.once("SIGINT", () => { stop = true; out("interrupt: finishing the current call, then deleting the scratch stacks"); });
    const outDir = mkdtempSync(`${tmpdir()}/rovara-rehearsal-out-`);
    const workDir = mkdtempSync(`${tmpdir()}/rovara-rehearsal-work-`);
    const result = await rehearse({ ports, aws: realRehearsalAws(ports, config, region, exec8s[0]), config, row, proofAccount, region, tag: prefix.slice(SCRATCH_PREFIX.length), outDir, workDir, exec8s, out, interrupted: () => stop });
    out(result.ok ? "REHEARSAL PASS" : `REHEARSAL FAIL (${result.checks.filter((c) => !c.ok).length} failed check(s)${result.leftovers.length === 0 ? "" : `; NOT DELETED: ${result.leftovers.join(", ")}`})`);
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof StageError) { out(`REHEARSAL ${error.exitName}: ${error.message}`); return error.exitName === "USAGE" ? 2 : 3; }
    out(`REHEARSAL FAILED: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
