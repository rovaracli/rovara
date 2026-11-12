// The cdk deploy engine: an alternative to the templates engine that shells out to `cdk deploy`
// from a release-tagged source checkout, one stack at a time. Chosen for an install/upgrade that
// needs the flexibility of a real CDK deploy (drift reconciliation, asset diffing) instead of the
// templates engine's pre-synthesized, pre-uploaded change sets. Every other stack is deployed
// through the service role the access stack creates; the access stack itself is deployed with the
// caller's own credentials (no --role-arn), same as the templates engine.
//
// Termination protection is not this engine's job: the CDK app itself sets
// `terminationProtection: true` on the protected stacks' constructs (infra/lib/app.ts), so unlike
// the templates engine (which calls UpdateTerminationProtection after a bare CloudFormation
// change set), this engine never needs to touch it.
import { teamRecordContextArguments, type TeamRecordOptions } from "./team-record-switch.js";
import { modelProxyTlsContextArguments, modelProxyTlsPreviousContextArguments, type ModelProxyTlsPrevious, type ModelProxyTlsSetting } from "./model-proxy-tls.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { EDITION_CONTEXT_KEY, NEW_INSTALL_CONTEXT_KEY } from "@agentx/cloud-contracts";
import { agentXError, type Edition } from "@rovara-code/contracts";
import type { ParameterStore } from "../environments/parameter-store.js";
import type { DeployRequest, StackDeployer, StackOutputs } from "./deployer.js";
import { SECRET_PARAMETERS, type DeployPart } from "./parameters.js";

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the cdk engine needs to run a shell command: the release pipeline's real implementation
 * shells out to `child_process`; tests record calls instead. */
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options: {
      cwd: string;
      display: string;
      /** Applied to a failed run's captured stderr before it is ever surfaced in an error; mirrors
       * `redactSecrets` below so a secret that a child process itself echoes back never leaks
       * through a thrown error the way `display` already keeps it out of the printed command. */
      redact?: (text: string) => string;
      /** Captures stdout without echoing it (a long listing only our own code reads). */
      quiet?: boolean;
    },
  ): Promise<{
    stdout: string;
    /** The child's captured standard error, unredacted; only our own code reads it, and redacts it before showing it. */
    stderr?: string;
  }>;
}

/** Every deploy part's CDK construct id, exactly as infra/lib/app.ts names them. */
export const CDK_CONSTRUCT_IDS: Record<DeployPart, string> = {
  access: "AgentXAccess",
  foundation: "AgentXProductionFoundation",
  identity: "AgentXIdentity",
  runtime: "AgentXProductionRuntime",
  "control-plane": "AgentXControlPlane",
  slack: "AgentXSlackOrchestrator",
};

/** The SSM parameter the CDK CLI itself writes on `cdk bootstrap`, under the default qualifier. */
const CDK_BOOTSTRAP_VERSION_PARAMETER = "/cdk-bootstrap/hnb659fds/version";

/**
 * Refuses to run the cdk engine in a region CDK has never been bootstrapped in: without a
 * bootstrap stack there is no staging bucket for `cdk deploy` to upload assets and the nested
 * template to, so the deploy would fail deep into the run instead of failing fast here.
 */
export async function assertCdkBootstrapped(input: { store: ParameterStore; region: string }): Promise<void> {
  let parameter: Awaited<ReturnType<ParameterStore["get"]>>;
  try {
    parameter = await input.store.get(CDK_BOOTSTRAP_VERSION_PARAMETER);
  } catch (error) {
    throw new Error(`could not read ${CDK_BOOTSTRAP_VERSION_PARAMETER} in ${input.region}: ${errorMessage(error)}`, { cause: error });
  }
  if (parameter === undefined) {
    throw agentXError(
      "CONFIG_INVALID",
      `CDK is not bootstrapped in ${input.region}; run: npx cdk bootstrap aws://<account>/${input.region} (or use --engine templates, which needs no bootstrap)`,
    );
  }
}

/**
 * Refuses to run the cdk engine from a checkout that isn't exactly, cleanly, the release's tag:
 * unlike the templates engine (which deploys pre-synthesized templates a release records
 * checksums for), the cdk engine synthesizes from whatever source is on disk, so an untagged,
 * mismatched, or locally modified checkout would silently deploy something other than the release
 * it claims to be.
 *
 * `git describe --tags --exact-match` picks one tag when HEAD carries several, which could hide
 * the release tag behind an unrelated one; `git tag --points-at HEAD` lists every tag at HEAD, so
 * the release tag is required to be among them rather than to be the one describe happens to pick.
 */
export async function assertSourceAtRelease(input: { runner: CommandRunner; source: string; version: string }): Promise<void> {
  const expected = `v${input.version}`;

  const { stdout: statusOutput } = await input.runner.run("git", ["status", "--porcelain"], {
    cwd: input.source,
    display: "git status --porcelain",
  });
  if (statusOutput.trim() !== "") {
    throw agentXError("CONFIG_INVALID", `source at ${input.source} has uncommitted changes; check out ${expected} cleanly`);
  }

  let tags: string[];
  try {
    const { stdout } = await input.runner.run("git", ["tag", "--points-at", "HEAD"], {
      cwd: input.source,
      display: "git tag --points-at HEAD",
    });
    tags = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch (error) {
    // The brief's wording ("... is at no tag") is preserved even when the runner itself failed
    // (not a git repo, git missing, etc.) rather than simply finding zero tags — but the cause
    // must not be silently lost, so it's attached and its first line folded into the message.
    const firstLine = errorMessage(error).split("\n")[0];
    throw new Error(`the cdk engine must run from a checkout of tag ${expected}; ${input.source} is at no tag (${firstLine})`, { cause: error });
  }

  if (!tags.includes(expected)) {
    throw agentXError("CONFIG_INVALID", `the cdk engine must run from a checkout of tag ${expected}; ${input.source} is at ${tags.length === 0 ? "no tag" : tags.join(", ")}`);
  }
}

export type CatalogFlavor = "release" | "staging";
export interface BuiltSource { flavor: CatalogFlavor; restore(): Promise<void> }
/** The tool that switches a checkout's catalog flavor (packages/cloud-contracts/tools/catalog-flavor.ts). */
export const CATALOG_FLAVOR_TOOL = "packages/cloud-contracts/tools/catalog-flavor.ts";
/** The one AWS account the staging flavor is built in. */
export const CATALOG_STAGING_BUILD_ACCOUNT = "944937319445";

/**
 * Which catalog flavor an upgrade's build gets: `staging` ONLY when the target environment is named "staging" AND the account the upgrade's own AWS client is signed in to (STS, at build time) is the staging
 * account. Every other case, including an account that could not be read, is `release`: no staging key is trusted. The broker checks the account again at run time.
 */
export function catalogFlavorFor(input: { env: string; account: string | undefined }): CatalogFlavor {
  return input.env === "staging" && input.account === CATALOG_STAGING_BUILD_ACCOUNT ? "staging" : "release";
}

/**
 * Installs and builds the release's source checkout before `cdk deploy` runs: `infra/dist` is
 * gitignored, so a checkout at the right tag can still hold a stale build (or none at all), and the
 * tag check alone would then pass while `cdk deploy` synthesized something else. `npm ci` installs
 * exactly the lockfile's dependencies (including the CDK CLI `npx --no-install cdk` then runs), and
 * `npm run build` compiles every workspace, infra included.
 */
export async function buildSource(input: { runner: CommandRunner; source: string; flavor?: CatalogFlavor }): Promise<BuiltSource> {
  await input.runner.run("npm", ["ci"], { cwd: input.source, display: "npm ci" });
  // The catalog flavor of the Lambdas and the contracts dist (test services slice 1, H4). The committed tree IS the release flavor, so a release-flavor build runs nothing extra, command for command as before. Only a build
  // that was asked for the staging flavor switches the tree (the flavor line and the staging-only key list), and a switch that throws puts the tree back to release and builds as release: no staging key is ever trusted
  // by a build whose switch did not run to the end. If even the way back fails the build stops (a tree in an unknown state is never built).
  let staged = false;
  if (input.flavor === "staging") {
    try {
      await input.runner.run("npx", ["tsx", CATALOG_FLAVOR_TOOL, "staging"], { cwd: input.source, display: "set the staging catalog flavor" });
      staged = true;
    } catch {
      await input.runner.run("npx", ["tsx", CATALOG_FLAVOR_TOOL, "release"], { cwd: input.source, display: "set the release catalog flavor" });
    }
  }
  try {
    await input.runner.run("npm", ["run", "build"], { cwd: input.source, display: "npm run build" });
  } catch (error) {
    if (staged) await input.runner.run("npx", ["tsx", CATALOG_FLAVOR_TOOL, "release"], { cwd: input.source, display: "set the release catalog flavor" }).catch(() => undefined);
    throw error;
  }
  return {
    flavor: staged ? "staging" : "release",
    // Puts the source's files back to the committed release flavor (the compiled output keeps the flavor it was built with), so the checkout is clean for the next upgrade.
    async restore() {
      if (staged) await input.runner.run("npx", ["tsx", CATALOG_FLAVOR_TOOL, "release"], { cwd: input.source, display: "set the release catalog flavor" });
    },
  };
}

/** Quotes an argument for the printed command line when it contains whitespace (only `--app`'s value does today). */
function displayArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

/** Replaces every secret parameter's value in `text`; mirrors the templates engine's redactor.
 * Must run on each raw argument *before* `displayArg` quotes it: quoting can escape characters
 * (a `"` or `\` inside the secret) that would then no longer match the secret's literal value,
 * letting an escaped fragment of it slip into the printed command unredacted. */
function redactSecrets(text: string, parameters: Record<string, string>): string {
  let redacted = text;
  for (const name of SECRET_PARAMETERS) {
    const value = parameters[name];
    if (value === undefined || value === "") continue;
    redacted = redacted.split(value).join("<redacted>");
  }
  return redacted;
}

/** The app and context every cdk command runs with (deploy, diff, and cdk-source.ts's synth), so
 * the synth that reads the declared parameters synthesizes exactly what the deploy deploys. */
export function cdkAppArguments(input: { env: string; region: string; identityMode: "cognito" | "oidc"; cloud?: boolean; reservedConcurrency?: false; edition?: Edition; newInstall?: boolean; releaseVersion?: string; teamRecord?: TeamRecordOptions; modelProxyTls?: ModelProxyTlsSetting; modelProxyTlsPrevious?: ModelProxyTlsPrevious }): string[] {
  const args = ["--app", "node infra/dist/bin/agentx.js", "-c", `agentxEnv=${input.env}`, "-c", `agentxRegion=${input.region}`];
  if (input.identityMode === "oidc") args.push("-c", "agentxIdentity=oidc");
  // R45: the hosted-cloud switch is synth-time only, so it comes from the stored settings on every command.
  if (input.cloud === true) args.push("-c", "agentxCloud=true");
  // Enterprise foundations E2: the edition is synth-time only too (it stamps ROVARA_EDITION on every function). `rovara init` also marks a new install, so that a new install with no edition is refused at synth.
  if (input.edition !== undefined) args.push("-c", `${EDITION_CONTEXT_KEY}=${input.edition}`);
  if (input.newInstall === true) args.push("-c", `${NEW_INSTALL_CONTEXT_KEY}=true`);
  // `agentx upgrade --no-reserved-concurrency`: for an account whose Lambda concurrency limit is too low to reserve any. Unset keeps the default (reserved).
  if (input.reservedConcurrency === false) args.push("-c", "agentxReservedConcurrency=false");
  // QA6-10: the release this deploy carries, so the broker can tell the app which release it runs. Only a plain x.y.z is passed (a prerelease or a source build has none): the synth, and so the template, is unchanged otherwise.
  if (input.releaseVersion !== undefined && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u.test(input.releaseVersion)) args.push("-c", `agentxReleaseVersion=${input.releaseVersion}`);
  // UX-4b: the Team record, when the install records it as on (team-record-switch.ts), so an upgrade keeps its storage instead of synthesizing it away.
  if (input.teamRecord !== undefined) args.push(...teamRecordContextArguments(input.teamRecord));
  // MODEL-PROXY-TLS: the recorded HTTPS name, so no upgrade synthesizes the plain-http proxy again by leaving it out.
  if (input.modelProxyTls !== undefined) args.push(...modelProxyTlsContextArguments(input.modelProxyTls));
  if (input.modelProxyTlsPrevious !== undefined) args.push(...modelProxyTlsPreviousContextArguments(input.modelProxyTlsPrevious));
  return args;
}

/** The cdk command's arguments for one stack (deploy or diff); a deploy passes each parameter by physical stack name. */
function cdkArguments(input: { env: string; region: string; identityMode: "cognito" | "oidc"; cloud?: boolean; reservedConcurrency?: false; edition?: Edition; newInstall?: boolean; releaseVersion?: string; teamRecord?: TeamRecordOptions; modelProxyTls?: ModelProxyTlsSetting; modelProxyTlsPrevious?: ModelProxyTlsPrevious }, request: DeployRequest, command: "deploy" | "diff"): string[] {
  // --no-install: only the CDK CLI `npm ci` installed from the release's own lockfile, never one npx
  // would otherwise download on the fly.
  const args = ["--no-install", "cdk", command, CDK_CONSTRUCT_IDS[request.part], "--exclusively", ...cdkAppArguments(input)];
  // cdk diff ignores --parameters (CDK 2.1142 warns that they apply only to deploy).
  if (command === "diff") return args;
  // The CDK CLI looks `--parameters` up by the physical stack name (parameterMap[stack.stackName]),
  // not the construct id; a construct-id prefix silently drops every parameter.
  for (const [key, value] of Object.entries(request.parameters)) args.push("--parameters", `${request.stackName}:${key}=${value}`);
  return args;
}

/** FR-042: `cdk diff` for one stack, against the deployed template (`--method=template`: no change
 * set, so nothing is written to AWS). No `--parameters`: CDK 2.1142 ignores them for diff and warns.
 * A template diff cannot see a replacement caused only by a changed parameter value or cascading
 * through a Ref or GetAtt, nor a Conditions or Mappings change that adds or removes a conditional
 * resource; the live check (Task 20) looks at this. cdk prints the diff on stderr; the
 * text returned has every secret redacted. */
export async function cdkDiff(input: { runner: CommandRunner; source: string; env: string; region: string; identityMode: "cognito" | "oidc"; cloud?: boolean; reservedConcurrency?: false; edition?: Edition; newInstall?: boolean; releaseVersion?: string; teamRecord?: TeamRecordOptions; modelProxyTls?: ModelProxyTlsSetting; modelProxyTlsPrevious?: ModelProxyTlsPrevious; request: DeployRequest }): Promise<string> {
  // --no-notices: a notice naming a guarded resource type would otherwise read as an unclear line.
  const args = [...cdkArguments(input, input.request, "diff"), "--method=template", "--no-notices"];
  const redact = (text: string) => redactSecrets(text, input.request.parameters);
  const display = ["npx", ...args.map((arg) => displayArg(redact(arg)))].join(" ");
  const result = await input.runner.run("npx", args, { cwd: input.source, display, redact, quiet: true });
  return redact([result.stdout, result.stderr ?? ""].filter((part) => part !== "").join("\n"));
}

export function cdkDeployer(input: {
  runner: CommandRunner;
  source: string;
  env: string;
  region: string;
  identityMode: "cognito" | "oidc";
  cloud?: boolean;
  reservedConcurrency?: false;
  /** Enterprise foundations E2: the install's edition (the explicit request or the recorded one), passed to the synth as `-c rovaraEdition`. */
  edition?: Edition;
  newInstall?: boolean;
  /** QA6-10: the release being deployed (`release.manifest.version`), passed to the synth as `-c agentxReleaseVersion` when it is a plain x.y.z. */
  releaseVersion?: string;
  /** UX-4b: the install records its Team record as on (team-record-switch.ts); passed to the synth as `-c agentxTeamRecord=enabled`. */
  teamRecord?: TeamRecordOptions;
  /** MODEL-PROXY-TLS: the recorded model proxy TLS setting (model-proxy-tls.ts), passed to the synth as its `-c rovaraModelProxy*` pairs. */
  modelProxyTls?: ModelProxyTlsSetting;
  /** M-1: the previous name still to clean up (model-proxy-tls.ts), passed as its `-c rovaraModelProxyTlsPrevious*` pairs. */
  modelProxyTlsPrevious?: ModelProxyTlsPrevious;
  outputsDir: string;
  outputs: (stackName: string) => Promise<StackOutputs | undefined>;
}): StackDeployer {
  return {
    async deploy(request: DeployRequest): Promise<StackOutputs> {
      const outputsFile = join(input.outputsDir, `${request.part}.json`);
      const args = [...cdkArguments(input, request, "deploy"), "--require-approval", "never", "--outputs-file", outputsFile, ...(request.roleArn === undefined ? [] : ["--role-arn", request.roleArn])];

      // Redact each raw argument first, then quote the (now secret-free) result — quoting after
      // redaction would let an escaped fragment of a secret containing whitespace, a quote, or a
      // backslash slip through unredacted (see redactSecrets's doc comment).
      const display = ["npx", ...args.map((arg) => displayArg(redactSecrets(arg, request.parameters)))].join(" ");
      request.onEvent?.({ kind: "deploying", stackName: request.stackName });

      // A stale outputs file from an earlier run at this path must never be read back as this
      // run's result, so it is removed before `cdk deploy` runs; `force` makes a missing file a
      // no-op rather than an error.
      await rm(outputsFile, { force: true });
      await input.runner.run("npx", args, { cwd: input.source, display, redact: (text) => redactSecrets(text, request.parameters) });

      const written = await readOutputs(outputsFile, request.stackName);
      const outputs = written.outputs ?? (await noOutputsStack(input.outputs, request.stackName, outputsFile, written.stacksWritten));
      request.onEvent?.({ kind: "deployed", stackName: request.stackName });
      return outputs;
    },
    outputs: input.outputs,
  };
}

/** cdk leaves a stack with no outputs out of the file entirely (the runtime stack, seen in the Task
 * 20 live check), so when the file names no stacks at all the deployed stack itself is asked, and
 * only a stack CloudFormation reports with no outputs counts. A file
 * that names other stacks means cdk deployed a stack under another name (review I1): CloudFormation
 * would answer the requested stack's old outputs, so that still fails. */
async function noOutputsStack(read: (stackName: string) => Promise<StackOutputs | undefined>, stackName: string, file: string, stacksWritten: string[]): Promise<StackOutputs> {
  const missing = `cdk deploy wrote no outputs for ${stackName} to ${file} (stacks written: ${stacksWritten.length === 0 ? "none" : stacksWritten.join(", ")})`;
  if (stacksWritten.length > 0) throw new Error(missing);
  let outputs: StackOutputs | undefined;
  try {
    outputs = await read(stackName);
  } catch (error) {
    throw new Error(`cdk deploy of ${stackName} succeeded, but its outputs could not be read from CloudFormation: ${errorMessage(error)}`, { cause: error });
  }
  if (outputs === undefined) throw new Error(`${missing}, and CloudFormation reports no such stack`);
  // Re-review R2: a stack that has outputs always gets them written, so these would be old ones.
  if (Object.keys(outputs).length > 0) throw new Error(missing);
  return outputs;
}

/** Reads the outputs file `cdk deploy --outputs-file` wrote and returns `stackName`'s entry.
 * Throws a clear, cause-carrying message for a missing or unparseable file. When `stackName` has no
 * entry, it returns the stacks the file does name instead, for noOutputsStack to judge. */
async function readOutputs(file: string, stackName: string): Promise<{ outputs: StackOutputs; stacksWritten?: never } | { outputs?: never; stacksWritten: string[] }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`cdk deploy wrote no outputs file at ${file}: ${errorMessage(error)}`, { cause: error });
  }
  let written: Record<string, StackOutputs>;
  try {
    written = JSON.parse(raw) as Record<string, StackOutputs>;
  } catch (error) {
    throw new Error(`cdk deploy wrote an unreadable outputs file at ${file}: ${errorMessage(error)}`, { cause: error });
  }
  const outputs = written[stackName];
  if (outputs === undefined) {
    return { stacksWritten: Object.keys(written) };
  }
  return { outputs };
}
