// The stage CLI of the one release pipeline (BETA-CLOUD-PLAN 1.2-1.7; L2-STAGE-CLI-INTERFACE.md).
//   node ops/pipeline/stage.ts <beta|production> <ref|preflight|image|gateway|gateway-check|web-app|proof|summary|last-good> [flags]
// Run by a CodeBuild action in the Cloud repo checkout. Node runs this file directly: erasable TypeScript, node: imports only.
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { loadConfig, loadGatePolicy, lastGoodParameter, releaseTagRegex, stackName } from "./config.ts";
import type { PipelineConfig } from "./config.ts";
import { createRealPorts } from "./ports.ts";
import { codeUrlFor, contextArgs, loadSwitches, rowFor, SWITCHES_ENVIRONMENTS } from "./switches.ts";
import type { SwitchesFile } from "./switches.ts";
import { EXIT, StageError } from "./types.ts";
import type { Gate, PipelineEnv, Ports, StepName } from "./types.ts";
import { accountSource } from "./lib/account.ts";
import { parseCodeCtx } from "./lib/codectx.ts";
import { CODE_RELEASE_FROM_TRIGGER, decideCodeRelease } from "./lib/coderelease.ts";
import { errorText } from "./lib/context.ts";
import type { Inputs, StepContext } from "./lib/context.ts";
import { discoverGates } from "./lib/gates.ts";
import { readLastGood, renderLastGood } from "./lib/lastgood.ts";
import { planRollback } from "./lib/rollbackplan.ts";
import { parseManifest } from "./lib/manifest.ts";
import { LATEST, decideMode, readLiveCloudSha, resolveCloudRef } from "./lib/refs.ts";
import { runStep } from "./lib/run.ts";
import type { StepFunction } from "./lib/run.ts";
import { buildSummary, renderSummary } from "./lib/summary.ts";
import { gatewayCheckStep } from "./steps/gateway-check.ts";
import { gatewayStep } from "./steps/gateway.ts";
import { imageStep } from "./steps/image-step.ts";
import { preflight } from "./steps/preflight.ts";
import { proofStep } from "./steps/proof.ts";
import { webAppStep } from "./steps/web-app.ts";

const RUN_STEPS: Record<StepName, StepFunction> = {
  preflight,
  image: (ctx, state) => imageStep(ctx, state),
  gateway: gatewayStep,
  "gateway-check": gatewayCheckStep,
  "web-app": webAppStep,
  proof: proofStep,
};
const READ_ONLY_STEPS = ["ref", "summary", "last-good", "rollback-plan"] as const;
type ReadOnlyStep = (typeof READ_ONLY_STEPS)[number];

export const USAGE = `usage: node ops/pipeline/stage.ts <${SWITCHES_ENVIRONMENTS.join("|")}> <${[...Object.keys(RUN_STEPS), ...READ_ONLY_STEPS].join("|")}> [flags]
flags (env var): --exec-id (EXEC_ID) --manifest (PIPELINE_MANIFEST) --out (PIPELINE_OUT, default out) --cloud-ref (CLOUD_REF; from-trigger reads --cloud-source-commit / CLOUD_SOURCE_COMMIT)
  --code-release run|skip|from-trigger (CODE_RELEASE; from-trigger, the pipeline's default, is decided from which source started the run) --cloud-prod on|off (CLOUD_PROD) --code-sha (CODE_SHA) --code-live-sha (CODE_LIVE_SHA)
  --adopt (PIPELINE_ADOPT=1, or PIPELINE_MODE=adopt; PIPELINE_MODE=release is the default; PIPELINE_MODE=rollback declares a rollback) --gateway-digest sha256:... (GATEWAY_DIGEST) --dry-run (PIPELINE_DRY_RUN=1)
  --code-target <40-hex sha> (CODE_ROLLBACK_TARGET: hand-started runs and rollback-plan; a pipeline run gets it inside CODE_CTX)
  rollback-plan only: --target last-good|previous (default last-good); --code-target <sha> also plans a Code rollback (prints the variables)
other env: ROVARA_EXPECTED_DEPLOY_ACCOUNT (required: the account this stage must run in; from a pipeline variable, never git), AWS_REGION, ROVARA_PIPELINE_PROFILE, PIPELINE_WORK, CODE_LIVE_FACTS (json),
  CODE_CTX (the Cloud Preflight action only: live:<sha>,target:<sha|none>,supersedes:<id|none>,supersedesSha:<sha|none>[,trigger:<cloud-tag@vX.Y.Z|code-push|manual|unknown>]; set by the pipeline, parsed strictly), PIPELINE_SUPERSEDES (json; hand-started runs only)
`;

const VALUE_FLAGS = ["exec-id", "manifest", "out", "cloud-ref", "cloud-source-commit", "code-release", "cloud-prod", "code-sha", "code-live-sha", "gateway-digest", "expected-account", "target", "code-target"];
const BOOLEAN_FLAGS = ["adopt", "dry-run", "help"];

export interface Parsed { env: PipelineEnv; step: StepName | ReadOnlyStep; flags: Record<string, string | true> }

export function parseArgs(argv: readonly string[]): Parsed {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) flags[name] = true;
    else if (VALUE_FLAGS.includes(name)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new StageError("USAGE", `--${name} needs a value`);
      flags[name] = value;
      i += 1;
    } else throw new StageError("USAGE", `unknown flag --${name}`);
  }
  if (flags.help === true) throw new StageError("USAGE", "help");
  const [env, step, extra] = positional;
  if (extra !== undefined || env === undefined || step === undefined) throw new StageError("USAGE", "give an environment and a step");
  if (!(SWITCHES_ENVIRONMENTS as readonly string[]).includes(env)) throw new StageError("USAGE", `unknown environment ${env}`);
  if (!(step in RUN_STEPS) && !(READ_ONLY_STEPS as readonly string[]).includes(step)) throw new StageError("USAGE", `unknown step ${step}`);
  return { env: env as PipelineEnv, step: step as StepName | ReadOnlyStep, flags };
}

const SHA40 = /^[0-9a-f]{40}$/u;

const jsonEnv = (raw: string | undefined, what: string): unknown => {
  if (raw === undefined || raw === "") return null;
  try { return JSON.parse(raw); } catch { throw new StageError("USAGE", `${what} is not JSON`); }
};

export function buildInputs(flags: Record<string, string | true>, env: Record<string, string | undefined>, now: Date): Inputs {
  const pick = (flag: string, name: string): string | null => {
    const v = flags[flag] !== undefined && flags[flag] !== true ? flags[flag] : env[name];
    return v === undefined || v === "" ? null : v;
  };
  const execId = pick("exec-id", "EXEC_ID");
  if (execId === null) throw new StageError("USAGE", "EXEC_ID is not set (the pipeline execution id; locally pass --exec-id local-<something>)");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(execId) && !/^local-[a-z0-9-]{1,32}$/u.test(execId)) throw new StageError("USAGE", "EXEC_ID is not a pipeline execution id");
  const codeRelease = pick("code-release", "CODE_RELEASE") ?? "run";
  if (codeRelease !== "run" && codeRelease !== "skip" && codeRelease !== CODE_RELEASE_FROM_TRIGGER) throw new StageError("USAGE", `CODE_RELEASE must be run, skip or ${CODE_RELEASE_FROM_TRIGGER}`);
  const cloudProd = pick("cloud-prod", "CLOUD_PROD") ?? "off";
  if (cloudProd !== "on" && cloudProd !== "off") throw new StageError("USAGE", "CLOUD_PROD must be on or off");
  const sha = (value: string | null, what: string): string | null => {
    if (value !== null && !SHA40.test(value)) throw new StageError("USAGE", `${what} must be a full 40-hex sha`);
    return value;
  };
  const facts = jsonEnv(env.CODE_LIVE_FACTS, "CODE_LIVE_FACTS");
  const codeLiveFacts: Record<string, string> = {};
  if (facts !== null) {
    if (typeof facts !== "object" || Array.isArray(facts)) throw new StageError("USAGE", "CODE_LIVE_FACTS must be a JSON object");
    for (const [k, v] of Object.entries(facts as Record<string, unknown>)) if (typeof v === "string") codeLiveFacts[k] = v;
  }
  const sup = jsonEnv(env.PIPELINE_SUPERSEDES, "PIPELINE_SUPERSEDES") as { executionId?: unknown; codeSha?: unknown } | null;
  const handSupersedes = sup !== null && typeof sup.executionId === "string" && sup.executionId !== "" ? { executionId: sup.executionId, codeSha: typeof sup.codeSha === "string" && sup.codeSha !== "" ? sup.codeSha : null } : null;
  const handTargetRaw = pick("code-target", "CODE_ROLLBACK_TARGET");
  const handTarget = handTargetRaw === "none" ? null : sha(handTargetRaw, "CODE_ROLLBACK_TARGET");
  const handLive = sha(pick("code-live-sha", "CODE_LIVE_SHA"), "CODE_LIVE_SHA");
  // L9b: in a pipeline run the Code facts arrive in ONE value, CODE_CTX, parsed strictly (a malformed one refuses, exit 3). A hand variable beside it must say the same thing, or the run is refused.
  const ctxRaw = env.CODE_CTX === undefined || env.CODE_CTX === "" ? null : env.CODE_CTX;
  const ctx = ctxRaw === null ? null : parseCodeCtx(ctxRaw);
  if (ctx !== null) {
    const disagree = (what: string): StageError => new StageError("REFUSED", `${what} contradicts CODE_CTX: a pipeline run takes its Code facts from CODE_CTX alone`);
    if (handLive !== null && handLive !== ctx.live) throw disagree("CODE_LIVE_SHA");
    if (handTargetRaw !== null && handTarget !== ctx.target) throw disagree("CODE_ROLLBACK_TARGET");
    if (handSupersedes !== null && (handSupersedes.executionId !== ctx.supersedes?.executionId || handSupersedes.codeSha !== ctx.supersedes.codeSha)) throw disagree("PIPELINE_SUPERSEDES");
  }
  const gatewayDigest = pick("gateway-digest", "GATEWAY_DIGEST");
  // The pipeline's per-run mode (L1, L9b): PIPELINE_MODE=release|adopt|rollback. PIPELINE_ADOPT=1 and --adopt stay; a contradiction between them is refused.
  const mode = env.PIPELINE_MODE === undefined || env.PIPELINE_MODE === "" ? null : env.PIPELINE_MODE;
  if (mode !== null && mode !== "release" && mode !== "adopt" && mode !== "rollback") throw new StageError("USAGE", "PIPELINE_MODE must be release, adopt or rollback");
  const adoptRequested = flags.adopt === true || env.PIPELINE_ADOPT === "1";
  if ((mode === "release" || mode === "rollback") && adoptRequested) throw new StageError("USAGE", `PIPELINE_MODE=${mode} contradicts --adopt / PIPELINE_ADOPT=1`);
  const adopt = mode === "adopt" || adoptRequested;
  const expectedAccount = pick("expected-account", "ROVARA_EXPECTED_DEPLOY_ACCOUNT");
  if (expectedAccount !== null && !/^[0-9]{12}$/u.test(expectedAccount)) throw new StageError("USAGE", "ROVARA_EXPECTED_DEPLOY_ACCOUNT must be a 12-digit account id");
  const work = env.PIPELINE_WORK !== undefined && env.PIPELINE_WORK !== "" ? env.PIPELINE_WORK : `${tmpdir()}/rovara-pipeline-${execId.slice(0, 8)}`;
  void now;
  return {
    execId,
    // CLOUD_REF=latest is the newest trunk tag, the same as no CLOUD_REF: normalized ONCE here, so every reader of inputs.cloudRef (the CLOUD_PROD=on rule, Beta's resolver, Production's "deploys what Beta deployed" check) sees null.
    cloudRef: ((ref) => ref === LATEST ? null : ref)(pick("cloud-ref", "CLOUD_REF")),
    cloudSourceCommit: pick("cloud-source-commit", "CLOUD_SOURCE_COMMIT"),
    codeRelease,
    codeTrigger: ctx === null ? null : ctx.trigger,
    cloudProd: cloudProd === "on",
    codeSha: sha(pick("code-sha", "CODE_SHA"), "CODE_SHA"),
    codeLiveSha: ctx === null ? handLive : ctx.live,
    codeLiveFacts,
    supersedes: ctx === null ? handSupersedes : ctx.supersedes,
    codeTarget: ctx === null ? handTarget : ctx.target,
    declaredRollback: mode === "rollback",
    codeCtxGiven: ctx !== null,
    adopt,
    gatewayDigest,
    target: typeof flags.target === "string" ? flags.target : null,
    expectedAccount,
    dryRun: flags["dry-run"] === true || env.PIPELINE_DRY_RUN === "1",
    region: env.AWS_REGION ?? null,
    manifestPath: pick("manifest", "PIPELINE_MANIFEST"),
    outDir: pick("out", "PIPELINE_OUT") ?? "out",
    workDir: work,
  };
}

export interface Deps {
  config?: PipelineConfig;
  switchesFile?: SwitchesFile;
  gates?: readonly Gate[];
  requiredGates?: Record<string, string[]>;
  makePorts?: (args: { env: PipelineEnv; region: string; exec8: string; profile: string | null }) => Ports;
  out?: (line: string) => void;
  now?: () => Date;
}

/** The testable entry: returns the exit code, never calls process.exit. */
export async function main(argv: readonly string[], envVars: Record<string, string | undefined>, deps: Deps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  let where = "stage";
  try {
    const parsed = parseArgs(argv);
    where = `${parsed.env} ${parsed.step}`;
    const config = deps.config ?? loadConfig();
    const switchesFile = deps.switchesFile ?? loadSwitches();
    const row = rowFor(parsed.env, switchesFile);
    const inputs = buildInputs(parsed.flags, envVars, new Date());
    if (inputs.region === null) throw new StageError("REFUSED", "AWS_REGION is not set");
    if (inputs.region !== row.region) throw new StageError("REFUSED", `AWS_REGION is ${inputs.region}; ${parsed.env} is ${row.region} (switches.json)`);
    // CLOUD_PROD=on deploys Cloud to production: it needs the release named outright. The default (from-trigger), an unset ref, or a tag found from a trigger is never enough,
    // so a pipeline that still carries older defaults cannot reach production by accident. Refused here, before any port is made.
    if (inputs.cloudProd && !(READ_ONLY_STEPS as readonly string[]).includes(parsed.step) && (inputs.cloudRef === null || !releaseTagRegex(config).test(inputs.cloudRef))) {
      throw new StageError("REFUSED", `CLOUD_PROD=on needs CLOUD_REF set to a release tag (vX.Y.Z), and it is ${inputs.cloudRef ?? "not set"}: production deploys only a release named on purpose`);
    }
    const exec8 = inputs.execId.slice(0, 8);
    const profile = envVars.ROVARA_PIPELINE_PROFILE !== undefined && envVars.ROVARA_PIPELINE_PROFILE !== "" ? envVars.ROVARA_PIPELINE_PROFILE : config.environments[parsed.env].profile;
    const ports = (deps.makePorts ?? ((a) => createRealPorts({ ...a, config, cwd: process.cwd() })))({ env: parsed.env, region: inputs.region, exec8, profile });
    if (inputs.execId.startsWith("local-")) out("warning: a local execution id; change sets are named after it");
    const here = dirname(fileURLToPath(import.meta.url));
    const gates = deps.gates ?? await discoverGates(ports, `${here}/gates`);
    const requiredGates = deps.requiredGates ?? loadGatePolicy().required;
    const ctx: StepContext = {
      env: parsed.env, step: (parsed.step in RUN_STEPS ? parsed.step : "preflight") as StepName, config, row,
      contextFor: (target) => contextArgs(parsed.env, target, switchesFile, accountSource(ctx)), codeUrl: codeUrlFor(parsed.env, switchesFile), account: null,
      inputs, ports, gates, requiredGates, pipelineDir: process.cwd(), log: out,
    };
    if ((READ_ONLY_STEPS as readonly string[]).includes(parsed.step)) return await readOnly(parsed.step as ReadOnlyStep, ctx, out);
    await runStep(ctx, RUN_STEPS[parsed.step as StepName]);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof StageError) {
      if (error.exitName === "USAGE") out(error.message === "help" ? USAGE : `${error.message}\n${USAGE}`);
      else out(`STAGE-FAILED ${where} ${error.exitName}: ${error.message}`);
      return error.message === "help" ? EXIT.OK : EXIT[error.exitName];
    }
    out(`STAGE-FAILED ${where} FAILED: ${errorText(error)}`);
    return EXIT.FAILED;
  }
}

async function readOnly(step: ReadOnlyStep, ctx: StepContext, out: (line: string) => void): Promise<number> {
  const { ports, config, env, inputs } = ctx;
  if (step === "last-good") {
    out(renderLastGood(await readLastGood(ports, config, env)).trimEnd());
    return EXIT.OK;
  }
  if (step === "rollback-plan") {
    const target = inputs.target ?? "last-good";
    if (target !== "last-good" && target !== "previous") throw new StageError("USAGE", "--target must be last-good or previous");
    for (const line of await planRollback({ ports, config, env, which: target, codeLiveSha: inputs.codeLiveSha, pipelineDir: ctx.pipelineDir, codeTarget: inputs.codeTarget })) out(line);
    return EXIT.OK;
  }
  if (step === "summary") {
    if (inputs.manifestPath === null) throw new StageError("REFUSED", "summary needs --manifest");
    const manifest = parseManifest(ports.fs.readText(inputs.manifestPath));
    const stage = manifest.stages[env];
    if (stage === undefined) throw new StageError("REFUSED", `the manifest has no ${env} stage`);
    out(renderSummary(buildSummary(manifest, env, stage)).trimEnd());
    return EXIT.OK;
  }
  const resolved = await resolveCloudRef(ports, config, inputs.cloudRef, { sourceCommit: inputs.cloudSourceCommit, env });
  const live = await readLiveCloudSha(ports, stackName(config, env, "web"));
  const codeRelease = decideCodeRelease(inputs, resolved);
  const decision = await decideMode(ports, { requested: codeRelease.request, resolved, liveSha: live.sha, adopt: inputs.adopt, env, declared: inputs.declaredRollback, codeTarget: inputs.codeTarget });
  out(JSON.stringify({ env, cloud: resolved, liveSha: live.sha, mode: decision.mode, codeRelease: decision.codeRelease, codeLiveShaNeeded: decision.mode === "rollback", codeTarget: inputs.codeTarget, lastGoodParameter: lastGoodParameter(config, env), warnings: [...live.warnings, ...decision.warnings] }, null, 2));
  return EXIT.OK;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
