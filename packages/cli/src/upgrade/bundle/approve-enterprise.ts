// `agentx bundle approve` for an Enterprise install (owner decision 2026-10-31, option A: upgrades are built at approval). The customer's administrator, with their own
// credentials: verifies the signed bundle (done by the caller), reads the install's recorded settings, builds the install's exact templates from the release's own pinned
// CDK app, shows what it built against what is deployed, and only then places the build and writes the approval, which pins the hash of the result and every setting.
// The Rovara operator supplies no input to any of this: it has no command here, no access to the settings and no say in the bundle's kit.
import { agentXError, editionRecordParameter, environmentStackName, synthSettingsSha256, type ApprovalRecord, type BuiltPart } from "@agentx/contracts";
import type { ParameterStore } from "../../environments/parameter-store.js";
import type { EnvironmentSettings } from "../../environments/settings.js";
import { approveBundle, type ApprovalStore } from "./approve.js";
import { buildAtApproval, requiredParts, type BuiltBundle } from "./build-at-approval.js";
import { summariseBuild } from "./build-summary.js";
import { readSynthSettings } from "./synth-settings.js";
import type { SynthRunner } from "./synth-run.js";
import type { VerifiedBundle } from "./verify.js";

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
  now: () => number;
  yes: boolean;
  interactive: boolean;
  ask(question: string): Promise<string>;
  write(line: string): void;
  /** Runs after the approver confirmed and before anything is placed: loads the bundle's images into the install's registry. A refused build never reaches it. */
  beforeApproval?(): Promise<void>;
}

/** Whether the install is recorded as Enterprise: the edition record is read from the install, and an unreadable one is a refusal. */
export async function installIsEnterprise(store: ParameterStore, env: string): Promise<boolean> {
  const stored = await store.get(editionRecordParameter(env));
  if (stored === undefined) return false;
  if (stored.value === "enterprise") return true;
  if (stored.value === "public") return false;
  throw agentXError("CONFIG_INVALID", `the edition recorded for ${env} is not "enterprise" or "public"; fix it before approving a bundle. Nothing was approved`);
}

export async function approveEnterpriseBundle(input: ApproveEnterpriseInput): Promise<{ record: ApprovalRecord; build: BuiltBundle }> {
  const { bundle, install, store } = input;
  if (!(await installIsEnterprise(store, install.env))) throw agentXError("CONFIG_INVALID", `${install.env} is not recorded as an Enterprise install; a build made at approval is for Enterprise installs only. Nothing was approved`);
  const settings = await readSynthSettings(store, install);
  const build = await buildAtApproval({ bundle, settings, runner: input.runner });

  const deployed = new Map<BuiltPart, string | undefined>();
  for (const part of requiredParts(settings.identityMode)) deployed.set(part, await input.readDeployedTemplate(environmentStackName(install.env, part)));
  const summary = summariseBuild({ built: build, settings, deployed, confined: input.runner.confined });
  for (const line of summary.lines) input.write(line);
  // The deployer only updates stacks, and never the access stack: an approval it must refuse is not written.
  const missing = summary.diffs.find((diff) => diff.status === "new" || diff.status === "unreadable");
  if (missing !== undefined) throw agentXError("CONFIG_INVALID", `the ${missing.part} stack is ${missing.status === "new" ? "not deployed" : "unreadable"}; the deployer only updates stacks that exist. Nothing was approved`);
  if (!summary.accessAgrees) throw agentXError("CONFIG_INVALID", "the build's access stack is not the deployed one; the deployer never changes the access stack, so it would refuse this approval. Your administrators deploy the access stack first. Nothing was approved");

  if (!input.yes) {
    if (!input.interactive) throw agentXError("CONFIG_INVALID", "agentx bundle approve needs --yes when stdin is not a terminal, since it asks you to confirm what was built. Nothing was approved");
    if (!/^y(es)?$/i.test((await input.ask(`Approve bundle ${bundle.bundleId} as built above, for ${install.env}? [y/N] `)).trim())) throw agentXError("CONFIG_INVALID", "not approved; nothing was written");
  }
  await input.beforeApproval?.();
  // The settings are read again just before the approval is written: a record changed while this ran would otherwise be pinned under a hash that is not the one built.
  const again = await readSynthSettings(store, install);
  if (synthSettingsSha256(again) !== build.settingsSha256) throw agentXError("CONFIG_INVALID", "the recorded build settings changed while the build was made; run agentx bundle approve again. Nothing was approved");

  const record = await approveBundle({ bundle, approvedBy: input.approvedBy, parameters: input.parameters, rollback: input.rollback, store: input.approvalStore, now: input.now, built: { build, settings } });
  return { record, build };
}
