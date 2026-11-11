// agentx upgrade (FR-042 to FR-044): read the environment's version and engine from SSM, show the
// target release's notes and every change, deploy in upgrade order (stopping at the first failure,
// which leaves earlier stacks upgraded and is safe to re-run), then run doctor.
import { teamRecordRecordedOrUnknown, teamRecordRefusalHint } from "../deploy/team-record-switch.js";
import { enforceTeamRecordPreflight, type TeamRecordProbe } from "../deploy/team-record-preflight.js";
import { GetTemplateCommand } from "@aws-sdk/client-cloudformation";
import { agentXError, environmentStackName } from "@rovara-code/contracts";
import { isRovaraOperatorArn } from "@agentx/cloud-contracts";
import { CONFIG_KEYS } from "../config/keys.js";
import { CLOUD_NEEDS_CDK_MESSAGE, bootStage2ImagesProblem } from "../deploy/answer-schemas.js";
import { progressLine, type Ask, type PreparedDeployment } from "../deploy/commands.js";
import { deployEnvironment, keptOperatorParameters, templateParameterNames } from "../deploy/deploy-environment.js";
import type { DeployRequest } from "../deploy/deployer.js";
import { RETIRED_PARAMETER_NOTES, upgradeOrder, type DeployPart } from "../deploy/parameters.js";
import type { LoadedRelease } from "../deploy/release.js";
import { reportText, type DoctorReport } from "../doctor/checks.js";
import type { CallerIdentity, StackDescription, StackReader } from "../environments/adopt.js";
import { withEnvironmentLock, type LockRecord } from "../environments/lock.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { readEnvironmentSettings, type EnvironmentSettings } from "../environments/settings.js";
import { activeHintLine, ensureGithubWebhook, missingEventsLine } from "../github/webhook-setup.js";
import { isOperatorRole } from "../init/commands.js";
import type { InitSecrets } from "../init/context.js";
import { githubAppJwt, githubAppSecretName, githubWebhookUrl, parseAppSecret, type GitHubApi } from "../init/github-app.js";
import { plainMessage } from "../output.js";
import { readStoredDeveloperSignIn } from "../signin/settings.js";
import { upgradeAnswers } from "./answers.js";
import { recordInstalledBundle, recordRestorePoint } from "./bundle/restore-point.js";
import type { VerifiedBundle } from "./bundle/verify.js";
import { writeUpgradeBundle } from "./export.js";
import { FORCED_OPERATOR_VALUES, forcedOperatorValues, forcedValueLines } from "./forced-values.js";
import { cdkDiffRisks, cdkReviewedDeployer, guardData, upgradeConfirm } from "./review.js";
import { notesText, refusePrereleaseTarget, upgradeDirection, type ReleaseNotes } from "./target.js";

/** The release's embedder image, sent over the deployed value of the control plane's EmbedderImageUri (only where the Team record is built, see prepareDeployment). */
function withEmbedderImage(forced: ReturnType<typeof forcedOperatorValues>, image: string | undefined): ReturnType<typeof forcedOperatorValues> {
  if (image === undefined) return forced;
  return { ...forced, "control-plane": { ...forced["control-plane"], EmbedderImageUri: image } };
}

export interface UpgradeOptions { env: string; /** With `--bundle` on a cdk install: the build made at approval is approved without asking. `--yes` never does this. */ approveBuild?: boolean; /** N3: a signed release bundle directory; verified (signature, approved id, every hash) before anything is read or changed. */ bundleDir?: string; /** N3: the bundle id (SHA-256 of bundle.json) the customer approved; any other bundle is refused. */ approvedBundleSha256?: string; to?: string; releaseDir?: string; source?: string; yes: boolean; allowReplace: string[]; exportDir?: string; /** --no-reserved-concurrency: the cdk app leaves Lambda reserved concurrency off (cdk engine only). */ reservedConcurrency?: false; images?: { worker?: string; slack?: string; bootStage2Sha256?: string; /** --embedder-image: the embedder image for a release that names none (a source or override upgrade). */ embedder?: string } }

export interface UpgradeDependencies {
  store: ParameterStore;
  stacks: StackReader;
  /** GetTemplate, for the access-stack comparison under the operator role. */
  cloudFormation: { send(command: unknown): Promise<unknown> };
  identity: CallerIdentity;
  loadRelease(input: { releaseDir?: string; version?: string }): Promise<LoadedRelease>;
  /** N3: verifies a bundle against the trusted keys; throws a refusal on any mismatch. Required for `--bundle`. */
  verifyBundle?(input: { dir: string; approvedBundleSha256?: string }): Promise<VerifiedBundle>;
  /** N3: loads a verified bundle's images into the install's ECR, digests preserved. Required when the bundle carries images. */
  loadBundleImages?(input: { bundle: VerifiedBundle; settings: EnvironmentSettings }): Promise<void>;
  /**
   * Enterprise foundations N3b: `--bundle` on a cdk-engine install. Builds the install's templates at approval from its recorded settings, shows them, writes the approval that pins
   * the result and starts the customer-owned deployer for exactly that bundle id: the same approve-then-deploy path the Rovara operator's deployment takes. Nothing here deploys
   * the bundle's own prebuilt templates, and nothing is built from a flag.
   */
  approveAndDeploy?(input: { bundle: VerifiedBundle; settings: EnvironmentSettings; /** The build is approved without asking (`--approve-build`); false asks the approver. */ yes: boolean }): Promise<{ status: string; done: string[] }>;
  /** Issue 152: a source-built CLI's cdk upgrade with no --release or --to builds its release from
   * the --source checkout (release-fetch.ts's sourceRelease): the tag's version, the images from the
   * image flags or the tag's published release.json. */
  sourceRelease(input: { source: string; images?: { worker?: string; slack?: string; bootStage2Sha256?: string } }): Promise<LoadedRelease>;
  notes(version: string): Promise<ReleaseNotes | undefined>;
  prepare(input: { settings: EnvironmentSettings; release: LoadedRelease; source?: string; reservedConcurrency?: false; /** --embedder-image. */ embedderImage?: string; /** The control plane stack's EmbedderImageUri now (not `none`): kept when the release names no image. */ deployedEmbedderImage?: string }): Promise<PreparedDeployment>;
  cdkDiff(request: DeployRequest, settings: EnvironmentSettings, source: string, reservedConcurrency?: false, releaseVersion?: string): Promise<string>;
  ask: Ask;
  isInteractive(): boolean;
  /** The clients that point the GitHub App's webhook at the control plane: Secrets Manager (read and write) and GitHub. */
  githubWebhook(settings: EnvironmentSettings): { secrets: Pick<InitSecrets, "get" | "put">; github: GitHubApi };
  doctor(env: string): Promise<DoctorReport>;
  write: (line: string) => void;
  now: () => number;
  /** This agentx's own release (RELEASE_VERSION); undefined for a build from source. */
  cliVersion: string | undefined;
  /** Read-only check for a table left over by a rolled-back Team record build, run before the first build (team-record-preflight.ts). Absent: not checked. */
  teamRecordProbe?: TeamRecordProbe;
}

export interface UpgradeResult { env: string; from: string; to: string; parts: DeployPart[]; exported?: string; doctor?: { failed: number; warned: number } }

/** Sorts object keys at every level, so two templates compare by content, not by formatting. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

/** Question 9: whether the release's access template differs from the deployed one. A deployed
 * template this code cannot read as JSON counts as changed, so the upgrade stops rather than leave
 * the access stack behind. */
export async function accessChanged(input: { cloudFormation: { send(command: unknown): Promise<unknown> }; stackName: string; release: LoadedRelease; region: string; env: string }): Promise<boolean> {
  // Only the parse is caught: the release's own refusal (a region it does not cover, say) keeps its words.
  const releaseText = input.release.template("access", input.region, input.env);
  let releaseTemplate: unknown;
  try {
    releaseTemplate = JSON.parse(releaseText);
  } catch {
    throw agentXError("CONFIG_INVALID", `the release's access template for ${input.region} could not be read; rebuild or re-download release ${input.release.manifest.version}`);
  }
  const deployed = ((await input.cloudFormation.send(new GetTemplateCommand({ StackName: input.stackName, TemplateStage: "Original" }))) as { TemplateBody?: string }).TemplateBody;
  if (deployed === undefined) return true;
  let deployedTemplate: unknown;
  try {
    deployedTemplate = JSON.parse(deployed);
  } catch {
    return true;
  }
  return JSON.stringify(canonical(deployedTemplate)) !== JSON.stringify(canonical(releaseTemplate));
}

/** The spec's edge case "A release that removes a config key an environment has set": each operator
 * parameter a deployed stack holds that the target release's template no longer declares. Ruling
 * F10: keptOperatorParameters owns that test; this only names each one by its config key.
 * `declared` is what the deploy itself filters by: the cdk engine's synth (issue 152), or the
 * release's templates. */
export async function droppedConfigKeys(input: { declared: (part: DeployPart) => ReadonlySet<string> | undefined; env: string; parts: DeployPart[]; stacks: StackReader }): Promise<Array<{ key: string; value: string; instead?: string }>> {
  const dropped: Array<{ key: string; value: string; instead?: string }> = [];
  for (const part of input.parts) {
    const deployed = (await input.stacks.describe(environmentStackName(input.env, part)))?.parameters;
    if (deployed === undefined) continue;
    const found = keptOperatorParameters({ part, computed: {}, deployed, declared: input.declared(part) }).dropped;
    for (const { parameter, value } of found) {
      const retired = RETIRED_PARAMETER_NOTES[parameter];
      const key = CONFIG_KEYS.find((entry) => entry.target.kind === "stack-parameter" && entry.target.part === part && entry.target.parameter === parameter)?.key ?? retired?.key ?? parameter;
      dropped.push({ key, value, ...(retired === undefined ? {} : { instead: retired.instead }) });
    }
  }
  return dropped;
}

/** The lines an upgrade says about the operator values it forces once (forced-values.ts; 0.5.9: decision cards on), for each stack that held another value. */
export async function forcedNotes(input: { env: string; from: string; to: string; stacks: StackReader }): Promise<string[]> {
  const deployed: Partial<Record<DeployPart, Record<string, string> | undefined>> = {};
  for (const part of new Set(FORCED_OPERATOR_VALUES.map((entry) => entry.part))) deployed[part] = (await input.stacks.describe(environmentStackName(input.env, part)))?.parameters;
  return forcedValueLines(input.from, input.to, (part) => deployed[part]);
}

/** FR-026: the upgrade as files for a platform team's pipeline. No AWS write and no lock: it reads
 * the stacks and writes a directory. A changed access stack is included for the platform team to
 * deploy with its own credentials (question 9); an unchanged one is left out. */
async function exportUpgrade(input: { options: UpgradeOptions; deps: UpgradeDependencies; settings: EnvironmentSettings; release: LoadedRelease; dir: string }): Promise<UpgradeResult> {
  const { options, deps, settings, release } = input;
  const { env } = settings;
  // R45: the bundle carries the release's prebuilt templates, which are synthesized without the cloud switch.
  if (settings.cloud === true) throw agentXError("CONFIG_INVALID", CLOUD_NEEDS_CDK_MESSAGE);
  const target = release.manifest.version;
  deps.write(`Writing the upgrade of ${env} from ${settings.version} to ${target} (${settings.engine} engine) to a bundle`);
  deps.write(notesText(await deps.notes(target), target));
  const order = upgradeOrder(settings.identity.mode);
  // Each stack is described once; the answers, the dropped keys and the bundle all read these.
  const described = new Map<string, StackDescription | undefined>();
  for (const part of order) {
    const name = settings.stacks[part] ?? environmentStackName(env, part);
    described.set(name, await deps.stacks.describe(name));
  }
  const stacks: StackReader = { describe: async (name) => (described.has(name) ? described.get(name) : deps.stacks.describe(name)) };
  const answers = await upgradeAnswers({ settings, stacks, ...(options.images === undefined ? {} : { images: options.images }) });
  // Ruling F29: the stored developer sign-in, as deployEnvironment sends it on an upgrade.
  const developerSignIn = await readStoredDeveloperSignIn(deps.store, env);
  const accessStack = settings.stacks.access ?? environmentStackName(env, "access");
  const includeAccess = await accessChanged({ cloudFormation: deps.cloudFormation, stackName: accessStack, release, region: settings.region, env });
  const parts = order.filter((part) => part !== "access" || includeAccess);
  for (const entry of await droppedConfigKeys({ declared: (part) => templateParameterNames(release, part, env), env, parts, stacks })) {
    deps.write(`config key ${entry.key} (${entry.value}) is not in release ${target}, so the upgrade drops it; ${entry.instead === undefined ? "nothing replaces it" : `instead, ${entry.instead}`}`);
  }
  for (const line of await forcedNotes({ env, from: settings.version, to: target, stacks })) deps.write(line);
  const outputs: Partial<Record<DeployPart, Record<string, string>>> = {};
  const deployed: Partial<Record<DeployPart, Record<string, string>>> = {};
  for (const part of order) {
    const stack = described.get(settings.stacks[part] ?? environmentStackName(env, part));
    if (stack !== undefined) { outputs[part] = stack.outputs; deployed[part] = stack.parameters; }
  }
  const written = await writeUpgradeBundle({ dir: input.dir, settings, answers: { ...answers, ...(developerSignIn === undefined ? {} : { developerSignIn }) }, release, parts, outputs, deployed, forced: forcedOperatorValues(settings.version, target) });
  return { env, from: settings.version, to: target, parts, exported: written.dir };
}

/** The settings an upgrade may run on. Read before the environment lock, and read again under it. */
function upgradableSettings(settings: EnvironmentSettings | undefined, env: string): EnvironmentSettings {
  if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${env} is not installed in this account and region; check --env and --region`);
  if (settings.naming !== "environment") throw agentXError("CONFIG_INVALID", `agentx upgrade works on environments installed with agentx init; ${env} uses the legacy stack names`);
  return settings;
}

/** Points the GitHub App's webhook at the control plane once the stacks are upgraded. The stacks are already upgraded, so
 * a failure here is told and doctor still runs; it never prints the webhook secret. */
async function setUpGithubWebhook(env: string, deps: UpgradeDependencies): Promise<void> {
  try {
    const settings = await readEnvironmentSettings(deps.store, env);
    if (settings === undefined) return;
    const { secrets, github } = deps.githubWebhook(settings);
    const secretName = githubAppSecretName(env);
    const raw = await secrets.get(secretName);
    if (raw === undefined) {
      deps.write(`GitHub webhook: skipped, ${secretName} holds no GitHub App yet`);
      return;
    }
    const app = parseAppSecret(raw, secretName);
    const controlPlane = await deps.stacks.describe(settings.stacks["control-plane"]);
    const outcome = await ensureGithubWebhook({
      appJwt: githubAppJwt({ appId: app.appId, privateKey: app.privateKey, nowSeconds: Math.floor(deps.now() / 1000) }),
      api: github, secrets, secretValue: raw, secretId: secretName,
      webhookUrl: controlPlane?.outputs.GithubWebhookUrl ?? githubWebhookUrl(settings.controlPlaneUrl),
    });
    deps.write(`GitHub webhook: ${outcome.status}`);
    for (const line of [activeHintLine(outcome), missingEventsLine(outcome)]) if (line !== undefined) deps.write(line);
  } catch (error) {
    deps.write(`GitHub webhook: could not be set up (${plainMessage(error)}); run agentx upgrade again`);
  }
}

/** N3: the bundle path, checked before anything else is read: nothing in AWS is touched until the signature and every hash have passed. */
async function verifiedBundle(options: UpgradeOptions, deps: UpgradeDependencies): Promise<VerifiedBundle | undefined> {
  if (options.bundleDir === undefined) {
    if (options.approveBuild === true) throw agentXError("CONFIG_INVALID", "--approve-build applies to --bundle only");
    if (options.approvedBundleSha256 !== undefined) throw agentXError("CONFIG_INVALID", "--approved-bundle-sha256 applies to --bundle only");
    return undefined;
  }
  if (options.releaseDir !== undefined || options.to !== undefined || options.source !== undefined || options.exportDir !== undefined || options.images !== undefined) {
    throw agentXError("CONFIG_INVALID", "--bundle carries its own release and images; do not combine it with --release, --to, --source, --export, --worker-image, --slack-image, --embedder-image or --boot-stage2-sha256");
  }
  if (deps.verifyBundle === undefined) throw agentXError("CONFIG_INVALID", "this agentx cannot verify bundles; bundle refused, nothing was changed");
  return deps.verifyBundle({ dir: options.bundleDir, ...(options.approvedBundleSha256 === undefined ? {} : { approvedBundleSha256: options.approvedBundleSha256 }) });
}

export async function runUpgrade(options: UpgradeOptions, deps: UpgradeDependencies): Promise<UpgradeResult> {
  // N3: first of all, before the environment, the account or the lock is looked at.
  const bundle = await verifiedBundle(options, deps);
  try {
    return await runVerifiedUpgrade(options, deps, bundle);
  } finally {
    await bundle?.cleanup();
  }
}

async function runVerifiedUpgrade(options: UpgradeOptions, deps: UpgradeDependencies, bundle: VerifiedBundle | undefined): Promise<UpgradeResult> {
  const { env } = options;
  if (bundle !== undefined && bundle.manifest.images.length > 0 && deps.loadBundleImages === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx cannot load the bundle's images into your registry; bundle refused, nothing was changed");
  }
  // Task 10: a hand-supplied worker image brings the hash of the stage 2 boot script it carries, before anything is read or changed.
  const imagesProblem = bootStage2ImagesProblem(options.images);
  if (imagesProblem !== undefined) throw agentXError("CONFIG_INVALID", imagesProblem);
  const first = upgradableSettings(await readEnvironmentSettings(deps.store, env), env);
  // Ruling F19 (FR-013): the bundle holds the published templates; deploying them onto cdk-deployed
  // stacks would switch the environment's engine.
  if (options.exportDir !== undefined && first.engine === "cdk") {
    throw agentXError("CONFIG_INVALID", "upgrade --export writes the published templates; a cdk environment upgrades with --source. Run agentx upgrade --source <dir> with admin credentials instead");
  }
  // The templates engine deploys the release's prebuilt templates, whose reservations are fixed; saying nothing would leave them on.
  if (options.reservedConcurrency === false && first.engine !== "cdk") {
    throw agentXError("CONFIG_INVALID", "--no-reserved-concurrency (reserved concurrency off) needs the cdk engine: this environment deploys the release's prebuilt templates, which reserve Lambda concurrency");
  }
  // A bundle on a cdk install is built at approval, from the install's recorded settings alone: a flag that would change what is built is refused, never ignored.
  if (bundle !== undefined && first.engine === "cdk" && options.reservedConcurrency === false) {
    throw agentXError("CONFIG_INVALID", "--no-reserved-concurrency cannot be combined with --bundle: an Enterprise install's templates are built from the settings recorded for it (agentx bundle record-settings), and from nothing given here. Nothing was changed");
  }
  if (first.engine === "cdk" && options.source === undefined && bundle === undefined) {
    throw agentXError("CONFIG_INVALID", "the cdk engine upgrades from a checkout of the target release's tag; pass --source <dir>");
  }
  if (options.exportDir === undefined && !options.yes && !deps.isInteractive()) throw agentXError("CONFIG_INVALID", "agentx upgrade needs --yes when stdin is not a terminal");

  const caller = await deps.identity.get();
  // N6: the standing Rovara operator role never runs an upgrade from its own disk or from any release it names: it starts the customer's deployer for an
  // approved bundle id (`--deploy-approved`), and the deployer does the rest. Anything else here is refused before a lock, a restore point or a stack is touched.
  if (isRovaraOperatorArn(caller.arn, env)) {
    throw agentXError("CONFIG_INVALID", "the Rovara operator role starts approved deployments with `agentx upgrade --deploy-approved <bundle id>`; it does not run an upgrade itself, so nothing was changed");
  }
  const operator = isOperatorRole(caller.arn, env);
  // Ruling F20: the cdk engine reads CDK's bootstrap version parameter and deploys through the
  // bootstrap roles and bucket, none of which the operator role may use.
  if (operator && first.engine === "cdk") {
    throw agentXError("CONFIG_INVALID", "a cdk environment upgrades with admin credentials (the operator role cannot use CDK's bootstrap resources); run agentx upgrade again with admin credentials");
  }

  if (bundle !== undefined && first.engine === "cdk") return runBuiltBundleUpgrade({ options, deps, bundle, first });

  const version = options.releaseDir === undefined && bundle === undefined ? options.to ?? deps.cliVersion : undefined;
  // Issue 152: a source-built CLI's cdk upgrade needs no release: the version is the source's tag.
  // With --to or --release, that release is loaded as before, and prepare refuses one that is not
  // the source's tag before anything deploys.
  const source = first.engine === "cdk" && options.releaseDir === undefined && version === undefined ? options.source : undefined;
  if (options.releaseDir === undefined && version === undefined && source === undefined && bundle === undefined) {
    throw agentXError("CONFIG_INVALID", "this agentx was built from source, so it has no release of its own; pass --to <version> or --release <dir>");
  }
  const release = bundle !== undefined ? bundle.release : source !== undefined
    ? await deps.sourceRelease({ source, ...(options.images === undefined ? {} : { images: options.images }) })
    : await deps.loadRelease({ ...(options.releaseDir === undefined ? {} : { releaseDir: options.releaseDir }), ...(version === undefined ? {} : { version }) });
  const target = release.manifest.version;
  refusePrereleaseTarget(target);
  if (options.to !== undefined && options.releaseDir !== undefined && options.to !== target) {
    throw agentXError("CONFIG_INVALID", `--release holds release ${target}, not ${options.to}; pass the release you mean`);
  }
  // Checked here to fail fast, and again under the lock, where it counts.
  upgradeDirection(env, first.version, target);
  if (options.exportDir !== undefined) return exportUpgrade({ options, deps, settings: first, release, dir: options.exportDir });

  // Question 3 under concurrency: another upgrade may finish between the read above and this lock,
  // so the settings are read again, and every check on them repeated, while the lock is held.
  // A killed upgrade leaves its lock. At a terminal, the same caller's next upgrade is offered its own
  // lock at once (takeOverOwn, as init and destroy do), and anyone's lock once it is stale (2 hours).
  // Without a terminal nothing is taken over; --yes never answers the takeover question.
  const confirmTakeover = deps.isInteractive()
    ? async (held: LockRecord) => /^y(es)?$/i.test((await deps.ask(`Environment ${env} is locked by ${held.holder} running "${held.command}" since ${held.acquiredAt}. Take the lock over? Say yes only if that command is no longer running. [y/N] `)).trim())
    : undefined;
  const { settings, parts } = await withEnvironmentLock({ store: deps.store, env, holder: caller.arn, command: "upgrade", now: deps.now, takeOverOwn: true, ...(confirmTakeover === undefined ? {} : { confirmTakeover }) }, async () => {
    const settings = upgradableSettings(await readEnvironmentSettings(deps.store, env), env);
    if (settings.engine !== first.engine) {
      throw agentXError("CONFIG_INVALID", `environment ${env}'s settings changed to the ${settings.engine} engine while agentx upgrade was starting; run agentx upgrade again`);
    }
    const direction = upgradeDirection(env, settings.version, target);
    deps.write(direction === "same" ? `Environment ${env} already runs ${target}; checking that every stack is on it` : `Upgrading ${env} from ${settings.version} to ${target} (${settings.engine} engine)`);
    deps.write(notesText(await deps.notes(target), target));

    const answers = await upgradeAnswers({ settings, stacks: deps.stacks, ...(options.images === undefined ? {} : { images: options.images }) });
    let parts = upgradeOrder(settings.identity.mode);
    // Question 9: the operator role cannot change the access stack (it holds the IAM roles). An
    // unchanged one is skipped; a changed one stops the upgrade before anything deploys. Admin
    // credentials deploy it first, like every other stack.
    if (operator) {
      parts = parts.filter((part) => part !== "access");
      const accessStack = settings.stacks.access ?? environmentStackName(env, "access");
      if (await accessChanged({ cloudFormation: deps.cloudFormation, stackName: accessStack, release, region: settings.region, env })) {
        throw agentXError("CONFIG_INVALID", `release ${target} changes the access stack, which only admin credentials can deploy. Ask your platform team to deploy it (agentx --env ${env} upgrade --export <dir> writes what they need), or run agentx upgrade with admin credentials; then run agentx upgrade again`);
      }
    }

    const allowReplace = new Set(options.allowReplace);
    const review = upgradeConfirm({ write: deps.write, ask: deps.ask, yes: options.yes, allowReplace });
    // Prepared before the dropped keys are named: the cdk engine's synth of the source (issue 152)
    // says which parameters the deploy can send, and so which it drops.
    // The embedder image the stack runs now, for a release that names none (a --source or --worker-image upgrade): kept, not refused. Read live, as the answers are.
    const runningControlPlane = await deps.stacks.describe(settings.stacks["control-plane"]);
    const runningEmbedder = runningControlPlane?.parameters.EmbedderImageUri;
    // The first build of the Team record (recorded as on, not yet in the stack): what an earlier, rolled-back try left behind would fail it (team-record-preflight.ts). Before anything is prepared or changed.
    await enforceTeamRecordPreflight({ env, store: deps.store, controlPlaneParameters: runningControlPlane?.parameters, probe: deps.teamRecordProbe, write: deps.write, stoppedMessage: "upgrade stopped before anything changed" });
    const prepared = await deps.prepare({
      settings, release, ...(options.source === undefined ? {} : { source: options.source }), ...(options.reservedConcurrency === false ? { reservedConcurrency: false as const } : {}),
      ...(options.images?.embedder === undefined ? {} : { embedderImage: options.images.embedder }),
      ...(runningEmbedder === undefined || runningEmbedder === "" || runningEmbedder === "none" ? {} : { deployedEmbedderImage: runningEmbedder }),
    });
    try {
      const declaredBy = prepared.declaredParameters;
      const declared = (part: DeployPart) => (declaredBy === undefined ? templateParameterNames(release, part, env) : declaredBy(part));
      for (const entry of await droppedConfigKeys({ declared, env, parts, stacks: deps.stacks })) {
        deps.write(`config key ${entry.key} (${entry.value}) is not in release ${target}, so the upgrade drops it; ${entry.instead === undefined ? "nothing replaces it" : `instead, ${entry.instead}`}`);
      }
      for (const line of await forcedNotes({ env, from: settings.version, to: target, stacks: deps.stacks })) deps.write(line);

      // N3: the restore point is written (and read back) before the first image or stack changes; if it cannot be, nothing has been.
      if (bundle !== undefined) {
        const point = await recordRestorePoint({ store: deps.store, env, now: deps.now(), fromVersion: settings.version, targetVersion: target, targetBundleId: bundle.bundleId });
        deps.write(`Restore point recorded: tables can be restored to ${point.pitrTimestamp} (point-in-time recovery); this install ran ${point.previousBundleId === null ? "no bundle before" : `bundle ${point.previousBundleId}`}`);
        if (bundle.manifest.images.length > 0) {
          await deps.loadBundleImages!({ bundle, settings });
          deps.write(`Loaded ${bundle.manifest.images.length} image${bundle.manifest.images.length === 1 ? "" : "s"} from bundle ${bundle.bundleId} into your registry`);
        }
      }
      const deployer = settings.engine === "templates" ? prepared.deployer : cdkReviewedDeployer(prepared.deployer, async (request) => {
        const risks = cdkDiffRisks(await deps.cdkDiff(request, settings, options.source ?? "", options.reservedConcurrency, release.manifest.version));
        if (risks.iam) deps.write(`${request.stackName} changes IAM; the changes are in the diff above.`);
        const refusal = await guardData({ stackName: request.stackName, data: risks.data, allowReplace, yes: options.yes, ask: deps.ask });
        if (refusal !== undefined) {
          // A record that can't be read is unknown, not "unrecorded": no hint then (re-check fix 4).
          const hint = teamRecordRefusalHint(env, risks.data.map((entry) => entry.logicalId), await teamRecordRecordedOrUnknown(deps.store, env));
          throw agentXError("CONFIG_INVALID", hint === undefined ? refusal : `${refusal} ${hint}`);
        }
        if (!options.yes && !/^y(es)?$/i.test((await deps.ask(`Deploy ${request.stackName}? [y/N] `)).trim())) {
          throw agentXError("CONFIG_INVALID", `upgrade stopped before ${request.stackName}: nothing in it changed. Stacks upgraded before it keep the new release; run agentx upgrade again to continue`);
        }
      });
      try {
        // The lock is this command's, in deps.store, where the settings live; deployEnvironment
        // checks that and writes the new settings there.
        await deployEnvironment({
          mode: "upgrade", engine: settings.engine, answers, release, deployer, store: deps.store, secrets: prepared.secrets, holder: caller.arn, parts, lockHeld: true,
          onEvent: (event) => deps.write(progressLine(event)),
          ...(settings.engine === "templates" ? { confirm: review.confirm } : {}),
          deployedParameters: async (stackName) => (await deps.stacks.describe(stackName))?.parameters,
          forcedParameters: withEmbedderImage(forcedOperatorValues(settings.version, target), prepared.embedderImageUri),
          ...(declaredBy === undefined ? {} : { declaredParameters: declaredBy }),
          ...(settings.engine === "cdk" && prepared.ensurePassRole !== undefined ? { ensurePassRole: prepared.ensurePassRole } : {}),
          ...(settings.engine === "cdk" && prepared.publishEmbedderImage !== undefined ? { afterAccess: prepared.publishEmbedderImage } : {}),
          now: deps.now,
        });
      } catch (error) {
        const refusal = review.refusal();
        if (refusal !== undefined && error instanceof Error && /confirmation declined/.test(error.message)) throw agentXError("CONFIG_INVALID", refusal);
        throw error;
      }
    } finally {
      await prepared.cleanup();
    }
    // The bundle is recorded as installed only after every stack deployed.
    if (bundle !== undefined) await recordInstalledBundle({ store: deps.store, env, now: deps.now(), version: target, bundleId: bundle.bundleId });
    return { settings, parts };
  });

  return finishUpgrade({ env, from: settings.version, target, parts, deps });
}

/** After the stacks are on the target: the GitHub webhook (outside the lock, since it changes only GitHub's hook and the App secret), then doctor. */
async function finishUpgrade(input: { env: string; from: string; target: string; parts: DeployPart[]; deps: UpgradeDependencies }): Promise<UpgradeResult> {
  const { env, from, target, parts, deps } = input;
  await setUpGithubWebhook(env, deps);

  deps.write("Checking the environment with agentx doctor");
  let report: DoctorReport;
  try {
    report = await deps.doctor(env);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `upgraded ${env} to ${target}, but doctor could not run: ${plainMessage(error)}; run agentx doctor`);
  }
  deps.write(reportText(report).trimEnd());
  if (report.failed > 0) {
    throw agentXError("CONFIG_INVALID", `upgraded ${env} to ${target}, but ${report.failed} doctor ${report.failed === 1 ? "check" : "checks"} failed; fix what each one names, then run agentx doctor again`);
  }
  return { env, from, to: target, parts, doctor: { failed: report.failed, warned: report.warned } };
}

/** N3b: a bundle on a cdk-engine install goes through the same approve-then-deploy path as everything Enterprise: built at approval, pinned, installed by the customer's deployer. */
async function runBuiltBundleUpgrade(input: { options: UpgradeOptions; deps: UpgradeDependencies; bundle: VerifiedBundle; first: EnvironmentSettings }): Promise<UpgradeResult> {
  const { options, deps, bundle, first } = input;
  const target = bundle.manifest.version;
  refusePrereleaseTarget(target);
  upgradeDirection(first.env, first.version, target);
  if (deps.approveAndDeploy === undefined) throw agentXError("CONFIG_INVALID", "this agentx cannot build an install's templates at approval; the bundle was refused and nothing was changed");
  // The same check as the main path, before the approval is written or the deployer started: a table left by a rolled-back Team record build would fail the deployer on "already exists".
  await enforceTeamRecordPreflight({ env: first.env, store: deps.store, controlPlaneParameters: (await deps.stacks.describe(first.stacks["control-plane"]))?.parameters, probe: deps.teamRecordProbe, write: deps.write, stoppedMessage: "upgrade stopped before anything changed" });
  deps.write(`Upgrading ${first.env} from ${first.version} to ${target} with bundle ${bundle.bundleId}: its templates are built from the settings recorded for this install, then installed by your own deployer`);
  // `--yes` answers the upgrade's own questions; it does not approve a build nobody read. Only `--approve-build` does that.
  const outcome = await deps.approveAndDeploy({ bundle, settings: first, yes: options.approveBuild === true });
  if (outcome.status !== "done") {
    throw agentXError("CONFIG_INVALID", `the deployer did not finish (${outcome.status}); stacks done so far: ${outcome.done.length === 0 ? "none" : outcome.done.join(", ")}. Run agentx upgrade again; the approval stands`);
  }
  return finishUpgrade({ env: first.env, from: first.version, target, parts: outcome.done as DeployPart[], deps });
}
