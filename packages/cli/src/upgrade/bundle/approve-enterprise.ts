// `agentx bundle approve` for an Enterprise install (owner decision 2026-10-31, option A: upgrades are built at approval). The customer's administrator, with their own
// credentials: verifies the signed bundle (done by the caller), reads the install's recorded settings, builds the install's exact templates from the release's own pinned
// CDK app, shows what it built against what is deployed, and only then places the build and writes the approval, which pins the hash of the result and every setting.
// The Rovara operator supplies no input to any of this: it has no command here, no access to the settings and no say in the bundle's kit.
import { agentXError, environmentStackName } from "@rovara-code/contracts";
import { synthSettingsSha256, type ApprovalRecord, type BuiltPart } from "@agentx/cloud-contracts";
import { readRecordedEdition } from "../../deploy/edition.js";
import type { ParameterStore } from "../../environments/parameter-store.js";
import type { EnvironmentSettings } from "../../environments/settings.js";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { approveBundle, type ApprovalStore, type BundleRollbackGuard } from "./approve.js";
import { buildAtApproval, requiredParts, type BuiltBundle } from "./build-at-approval.js";
import { summariseBuild } from "./build-summary.js";
import { readSynthSettings } from "./synth-settings.js";
import type { SynthRunner } from "./synth-run.js";
import type { VerifiedBundle } from "./verify.js";
import { rollbackDirection, ROLLBACK_FLOORS, ROLLBACK_FLOORS_DECLARED_THROUGH } from "../target.js";

export interface ApproveEnterpriseInput {
  bundle: VerifiedBundle;
  install: EnvironmentSettings;
  store: ParameterStore;
  runner: SynthRunner;
  approvalStore: ApprovalStore;
  /** The deployed template of a stack (CloudFormation GetTemplate, original stage), or undefined when there is no such stack. */
  readDeployedTemplate(stackName: string): Promise<string | undefined>;
  approvedBy: string;
  parameters: unknown;
  rollback: boolean;
  /** Required with `rollback` (approve.ts). */
  rollbackGuard?: BundleRollbackGuard;
  now: () => number;
  yes: boolean;
  interactive: boolean;
  ask(question: string): Promise<string>;
  write(line: string): void;
  /** Where to write the whole build (templates, packages, manifest and this summary) before anything is asked, so it can be read and diffed. Must be absent or empty. */
  writeBuildTo?: string;
  /** The flag that confirms the build without asking, named in the refusal when there is no terminal (default `--yes`). */
  confirmFlag?: string;
  /** The release this install runs now, to tell an upgrade's changes from drift. */
  installedVersion?: string;
  /** Runs first, before the build is made or anything is read for it: a refusal (a left-over Team record table, say) stops the approval with nothing built, loaded or written. */
  beforeBuild?(): Promise<void>;
  /** Runs after the approver confirmed and before anything is placed: loads the bundle's images into the install's registry. A refused build never reaches it. */
  beforeApproval?(): Promise<void>;
}

/** Whether the install is recorded as Enterprise: the edition record, or its backup while a deploy has the record out of the way. An unreadable or disagreeing record is a refusal. */
export async function installIsEnterprise(store: ParameterStore, env: string): Promise<boolean> {
  return (await readRecordedEdition(store, env)) === "enterprise";
}

export async function approveEnterpriseBundle(input: ApproveEnterpriseInput): Promise<{ record: ApprovalRecord; build: BuiltBundle }> {
  const { bundle, install, store } = input;
  if (!(await installIsEnterprise(store, install.env))) throw agentXError("CONFIG_INVALID", `${install.env} is not recorded as an Enterprise install; a build made at approval is for Enterprise installs only. Nothing was approved`);
  // A rollback under a floor is refused before anything is built (approveBundle checks it again before the approval is written).
  if (input.rollback) {
    const guard = input.rollbackGuard;
    if (guard === undefined) throw agentXError("CONFIG_INVALID", "a rollback approval needs the install's recorded and highest versions to check the rollback floors; nothing was approved");
    rollbackDirection(guard.env, guard.installedVersion, bundle.manifest.version, guard.floors ?? ROLLBACK_FLOORS, guard.declaredThrough ?? ROLLBACK_FLOORS_DECLARED_THROUGH, guard.highWater);
  }
  await input.beforeBuild?.();
  const settings = await readSynthSettings(store, install);
  const build = await buildAtApproval({ bundle, settings, runner: input.runner });

  const deployed = new Map<BuiltPart, string | undefined>();
  for (const part of requiredParts(settings.identityMode)) deployed.set(part, await input.readDeployedTemplate(environmentStackName(install.env, part)));
  const summary = summariseBuild({ built: build, settings, deployed, confined: input.runner.confined, sandbox: input.runner.sandbox, installedVersion: input.installedVersion ?? install.version });
  for (const line of summary.lines) input.write(line);
  if (input.writeBuildTo !== undefined) {
    await writeBuildFolder(input.writeBuildTo, build, summary.lines);
    input.write(`  The whole build was written to ${input.writeBuildTo}.`);
  }
  // The deployer only updates stacks, and never the access stack: an approval it must refuse is not written.
  const missing = summary.diffs.find((diff) => diff.status === "new" || diff.status === "unreadable");
  if (missing !== undefined) throw agentXError("CONFIG_INVALID", `the ${missing.part} stack is ${missing.status === "new" ? "not deployed" : "unreadable"}; the deployer only updates stacks that exist. Nothing was approved`);
  if (!summary.accessAgrees) throw agentXError("CONFIG_INVALID", "the build's access stack is not the deployed one; the deployer never changes the access stack, so it would refuse this approval. Your administrators deploy the access stack first. Nothing was approved");

  if (!input.yes) {
    if (!input.interactive) throw agentXError("CONFIG_INVALID", `this needs ${input.confirmFlag ?? "--yes"} when stdin is not a terminal, since it asks you to confirm what was built. Nothing was approved`);
    if (!/^y(es)?$/i.test((await input.ask(`Approve bundle ${bundle.bundleId} as built above, for ${install.env}? [y/N] `)).trim())) throw agentXError("CONFIG_INVALID", "not approved; nothing was written");
  }
  await input.beforeApproval?.();
  // The settings are read again just before the approval is written: a record changed while this ran would otherwise be pinned under a hash that is not the one built.
  const again = await readSynthSettings(store, install);
  if (synthSettingsSha256(again) !== build.settingsSha256) throw agentXError("CONFIG_INVALID", "the recorded build settings changed while the build was made; run agentx bundle approve again. Nothing was approved");

  const record = await approveBundle({ bundle, approvedBy: input.approvedBy, parameters: input.parameters, rollback: input.rollback, store: input.approvalStore, now: input.now, built: { build, settings }, ...(input.rollbackGuard === undefined ? {} : { rollbackGuard: input.rollbackGuard }) });
  return { record, build };
}

/** Writes the whole build to a new or empty folder (mode 0700, files 0600): every template and package as built, the manifest, and the summary as shown. Never over anything. */
export async function writeBuildFolder(dir: string, build: BuiltBundle, summary: readonly string[]): Promise<void> {
  const root = resolve(dir);
  const existing = await readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing !== undefined && existing.length > 0) throw agentXError("CONFIG_INVALID", `${root} is not empty; choose a new folder for --write-build, so nothing you kept is written over. Nothing was approved`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const { file, body } of build.files) {
    const target = join(root, ...file.replace(/^built\//, "").split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { mode: 0o600 });
  }
  await writeFile(join(root, "summary.txt"), `${summary.join("\n")}\n`, { mode: 0o600 });
}
