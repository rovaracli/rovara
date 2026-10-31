// The `agentx upgrade` command (FR-042 to FR-044, FR-026's upgrade --export), kept out of main.ts.
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ECRClient } from "@aws-sdk/client-ecr";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { STSClient } from "@aws-sdk/client-sts";
import { readFile } from "node:fs/promises";
import { agentXError, bundleTrustParameter } from "@agentx/contracts";
import type { Command } from "commander";
import { cdkDiff } from "../deploy/cdk-engine.js";
import { prepareDeployment, readlineAsk, realCommandRunner, type DeployCliDependencies } from "../deploy/commands.js";
import { loadRelease } from "../deploy/release.js";
import { realDoctorServices } from "../doctor/aws.js";
import { runDoctor } from "../doctor/run.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import { readEnvironmentSettings } from "../environments/settings.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { githubRestApi } from "../init/github-app.js";
import type { TextWriter } from "../init/prompts.js";
import { fetchRelease, sourceRelease } from "../init/release-fetch.js";
import { formatSuccess } from "../output.js";
import { RELEASE_VERSION } from "../version.js";
import { approveBundle, withdrawApproval, type ApprovalStore } from "./bundle/approve.js";
import { startApprovedDeployment, type DeployerInvoker } from "./bundle/deployer-client.js";
import { loadBundleImages } from "./bundle/load-images.js";
import { resetDeployment } from "./bundle/reset-deployment.js";
import { PINNED_BUNDLE_SIGNING_KEYS } from "./bundle/trusted-keys.js";
import { verifyBundle } from "./bundle/verify.js";
import { runUpgrade, type UpgradeDependencies } from "./run.js";
import { releaseNotes } from "./target.js";

export interface UpgradeCommandContext {
  overrides?: Partial<UpgradeDependencies>;
  deploy?: DeployCliDependencies;
  parameterStore: (region?: string) => ParameterStore;
  fetch: typeof fetch;
  home: string;
  stdout: TextWriter;
  stderr: TextWriter;
  /** Tests: the deployer's invoker. */
  deployerInvoker?: DeployerInvoker;
  /** Tests: the approval bucket's store. */
  approvalStore?: (bucket: string, region: string) => ApprovalStore;
}

function lambdaInvoker(client: LambdaClient): DeployerInvoker {
  return {
    async invoke(functionName, payload) {
      const response = await client.send(new InvokeCommand({ FunctionName: functionName, InvocationType: "RequestResponse", Payload: Buffer.from(JSON.stringify(payload)) }));
      if (response.FunctionError !== undefined) throw new Error("the deployer failed");
      return JSON.parse(Buffer.from(response.Payload ?? new Uint8Array()).toString("utf8")) as unknown;
    },
  };
}

function s3ApprovalStore(client: S3Client, bucket: string): ApprovalStore {
  return {
    async put(key, body) {
      const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      if (result.VersionId === undefined) throw new Error("the approval bucket returned no version id; it must be versioned");
      return { versionId: result.VersionId };
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerUpgradeCommand(program: Command, context: UpgradeCommandContext): void {
  program
    .command("upgrade")
    .description("upgrade an environment to a newer release: shows the release notes and every change, stops on a data replacement unless you name it, then runs doctor (operator role; the cdk engine needs admin credentials)")
    .option("--to <version>", "the release to upgrade to; default: this agentx's own release, or for an agentx built from source upgrading a cdk environment, the --source tag")
    .option("--release <dir>", "a release directory (agentx release build output) instead of downloading one")
    .option("--bundle <dir>", "a signed release bundle (Enterprise): its signature and every hash are checked before anything changes, a restore point is recorded, its images are loaded into your registry; instead of --release and --to")
    .option("--approved-bundle-sha256 <hex>", "with --bundle: the bundle id (SHA-256 of bundle.json) your team approved; any other bundle is refused")
    .option("--bundle-public-key <file>", "with --bundle: a PEM public key to trust for bundle signatures, besides the ones this agentx pins; repeat for each", collect, [])
    .option("--deploy-approved <bundle id>", "(Rovara operator) start the deployer in your account for a bundle your team approved with `agentx bundle approve`; the deployer re-verifies the bundle and deploys; nothing else is accepted with it")
    .option("--source <dir>", "the cdk engine only: a clean checkout of the target release's tag; --to or --release, when given, must match it")
    .option("--allow-replace <logical-id>", "accept replacing or deleting this table, user pool, bucket, key or secret; repeat for each", collect, [])
    .option("--export <dir>", "write the upgrade for a platform team's pipeline instead of deploying it")
    .option("--worker-image <digest-ref>", "worker image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--boot-stage2-sha256 <hex>", "with --worker-image: the SHA-256 of packages/worker/ec2/boot-stage2.sh in the release source that image was built from (a release supplies its own)")
    .option("--slack-image <digest-ref>", "Slack service image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--yes", "apply without asking; every change and the release notes are still printed", false)
    .option("--no-reserved-concurrency", "the cdk engine only: deploy with no Lambda reserved concurrency, for an AWS account whose Lambda concurrency limit is too low to reserve any (a new account's limit of 10); keep it on in production")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { deployApproved?: string; bundle?: string; approvedBundleSha256?: string; bundlePublicKey: string[]; to?: string; release?: string; source?: string; allowReplace: string[]; export?: string; workerImage?: string; slackImage?: string; bootStage2Sha256?: string; yes: boolean; region?: string; reservedConcurrency: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      const aws = options.region === undefined ? {} : { region: options.region };
      if (options.deployApproved !== undefined) {
        // The operator's whole path: a bundle id to the customer's deployer. No release, bundle, source or setting of the operator's choosing is accepted beside it.
        if (options.bundle !== undefined || options.to !== undefined || options.release !== undefined || options.source !== undefined || options.export !== undefined || options.approvedBundleSha256 !== undefined || options.workerImage !== undefined || options.slackImage !== undefined || options.bootStage2Sha256 !== undefined) {
          throw agentXError("CONFIG_INVALID", "--deploy-approved takes a bundle id and nothing else");
        }
        const result = await startApprovedDeployment({ env: globals.env, bundleId: options.deployApproved, invoker: context.deployerInvoker ?? lambdaInvoker(new LambdaClient(aws)), write: (line) => { context.stderr.write(`${line}\n`); } });
        context.stdout.write(globals.json ? formatSuccess(result, true) : result.status === "done" ? `Deployed bundle ${result.bundleId} to ${globals.env}.\n` : `The deployer did not finish: ${result.status}${result.reason === undefined ? "" : `, ${result.reason}`}.\n`);
        if (result.status !== "done") process.exitCode = 1;
        return;
      }
      const store = overrides.store ?? context.parameterStore(options.region);
      const runner = realCommandRunner(context.stderr);
      const write = overrides.write ?? ((line: string) => { context.stderr.write(`${line}\n`); });
      const deps: UpgradeDependencies = {
        store,
        stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
        cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
        identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
        loadRelease: overrides.loadRelease ?? (async (input) => loadRelease(input.releaseDir ?? await fetchRelease({ version: input.version, home: context.home, fetch: context.fetch, runner, write }))),
        verifyBundle: overrides.verifyBundle ?? (async (input) => {
          // A key file that cannot be read is a refusal, never a smaller set of trusted keys.
          const extra: string[] = [];
          for (const file of options.bundlePublicKey) extra.push(await readFile(file, "utf8").catch(() => { throw new Error(`bundle refused: the public key file ${file} could not be read; nothing was changed`); }));
          // The install's own trusted keys (written by its administrators, the same list the deployer reads), then any the caller names for this one run.
          let installed: string[] = [];
          try {
            const stored = await store.get(bundleTrustParameter(globals.env));
            const parsed: unknown = stored === undefined ? [] : JSON.parse(stored.value);
            if (Array.isArray(parsed)) installed = parsed.filter((entry): entry is string => typeof entry === "string");
          } catch {
            installed = [];
          }
          return verifyBundle({ ...input, trustedKeys: [...PINNED_BUNDLE_SIGNING_KEYS, ...installed, ...extra] });
        }),
        loadBundleImages: overrides.loadBundleImages ?? (async ({ bundle, settings }) => loadBundleImages({ bundle, env: settings.env, account: settings.account, region: settings.region, ecr: new ECRClient({ region: settings.region }), runner })),
        sourceRelease: overrides.sourceRelease ?? (async (input) => (await sourceRelease({ runner, source: input.source, images: input.images, fetch: context.fetch })).release),
        notes: overrides.notes ?? ((version) => releaseNotes({ fetch: context.fetch, version })),
        prepare: overrides.prepare ?? ((input) => prepareDeployment({
          engine: input.settings.engine, env: input.settings.env, region: input.settings.region, account: input.settings.account,
          identityMode: input.settings.identity.mode, ...(input.settings.cloud === true ? { cloud: true } : {}), ...(input.reservedConcurrency === false ? { reservedConcurrency: false as const } : {}), release: input.release, ...(input.source === undefined ? {} : { source: input.source }),
          deps: context.deploy ?? {}, stderr: context.stderr,
        })),
        cdkDiff: overrides.cdkDiff ?? ((request, settings, source, reservedConcurrency) => cdkDiff({ runner, source, env: settings.env, region: settings.region, identityMode: settings.identity.mode, ...(settings.cloud === true ? { cloud: true } : {}), ...(reservedConcurrency === false ? { reservedConcurrency: false as const } : {}), request })),
        ask: overrides.ask ?? readlineAsk(),
        isInteractive: overrides.isInteractive ?? (() => process.stdin.isTTY === true),
        githubWebhook: overrides.githubWebhook ?? ((settings) => ({ secrets: secretsManagerInitSecrets(new SecretsManagerClient({ region: settings.region })), github: githubRestApi(context.fetch) })),
        doctor: overrides.doctor ?? ((env) => runDoctor({ env, store, services: (settings) => realDoctorServices({ settings, store, fetch: context.fetch, home: context.home, configDir: globals.configDir, stderr: context.stderr }) })),
        write,
        now: overrides.now ?? Date.now,
        cliVersion: "cliVersion" in overrides ? overrides.cliVersion : RELEASE_VERSION,
      };
      const images = options.workerImage === undefined && options.slackImage === undefined && options.bootStage2Sha256 === undefined ? undefined : {
        ...(options.workerImage === undefined ? {} : { worker: options.workerImage }), ...(options.slackImage === undefined ? {} : { slack: options.slackImage }),
        ...(options.bootStage2Sha256 === undefined ? {} : { bootStage2Sha256: options.bootStage2Sha256 }),
      };
      const result = await runUpgrade({
        env: globals.env, yes: options.yes, allowReplace: options.allowReplace,
        ...(options.bundle === undefined ? {} : { bundleDir: options.bundle }), ...(options.approvedBundleSha256 === undefined ? {} : { approvedBundleSha256: options.approvedBundleSha256 }),
        ...(options.to === undefined ? {} : { to: options.to }), ...(options.release === undefined ? {} : { releaseDir: options.release }),
        ...(options.source === undefined ? {} : { source: options.source }), ...(options.export === undefined ? {} : { exportDir: options.export }),
        ...(options.reservedConcurrency === false ? { reservedConcurrency: false as const } : {}),
        ...(images === undefined ? {} : { images }),
      }, deps);
      context.stdout.write(globals.json ? formatSuccess(result, true) : result.exported !== undefined
        ? `Wrote the upgrade of ${result.env} to ${result.to} to ${result.exported}; give it to your platform team.\n`
        : `Upgraded ${result.env} from ${result.from} to ${result.to}.\n`);
    });
  const bundleCommand = program.command("bundle").description("approve or withdraw a signed release bundle for the Rovara operator to deploy (run by your own administrators)");
  bundleCommand
    .command("approve")
    .description("verify a signed bundle, load its images into your registry, place its files in your approval bucket and write your approval; the operator can then deploy exactly this bundle")
    .requiredOption("--bundle <dir>", "the bundle directory")
    .requiredOption("--approved-bundle-sha256 <hex>", "the bundle id your team approved (SHA-256 of bundle.json); any other bundle is refused")
    .option("--parameters <file>", "JSON {\"<stack part>\": {\"<ParameterName>\": \"<value>\"}}: the only parameters the deployment may set; every other parameter keeps its current value")
    .option("--rollback", "approve moving back to an older release than the installed one, on purpose", false)
    .option("--bundle-public-key <file>", "a PEM public key to trust for this run, besides the ones this agentx pins and your install lists; repeat for each", collect, [])
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { bundle: string; approvedBundleSha256: string; parameters?: string; rollback: boolean; bundlePublicKey: string[]; region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean }>();
      const aws = options.region === undefined ? {} : { region: options.region };
      const store = context.parameterStore(options.region);
      const settings = await readEnvironmentSettings(store, globals.env);
      if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${globals.env} is not installed in this account and region`);
      const outputs = (await cloudFormationStackReader(new CloudFormationClient(aws)).describe(settings.stacks.access ?? `agentx-${globals.env}-access`))?.outputs ?? {};
      const bucket = outputs.ApprovedBundlesBucketName;
      if (bucket === undefined) throw agentXError("CONFIG_INVALID", "this install has no approval bucket; the Rovara operator role is not set up (rovaraOperatorAccess)");
      const extra: string[] = [];
      for (const file of options.bundlePublicKey) extra.push(await readFile(file, "utf8").catch(() => { throw new Error(`bundle refused: the public key file ${file} could not be read; nothing was changed`); }));
      let installed: string[] = [];
      try {
        const stored = await store.get(bundleTrustParameter(globals.env));
        const parsed: unknown = stored === undefined ? [] : JSON.parse(stored.value);
        if (Array.isArray(parsed)) installed = parsed.filter((entry): entry is string => typeof entry === "string");
      } catch {
        installed = [];
      }
      const bundle = await verifyBundle({ dir: options.bundle, trustedKeys: [...PINNED_BUNDLE_SIGNING_KEYS, ...installed, ...extra], approvedBundleSha256: options.approvedBundleSha256 });
      try {
        const runner = realCommandRunner(context.stderr);
        if (bundle.manifest.images.length > 0) await loadBundleImages({ bundle, env: settings.env, account: settings.account, region: settings.region, ecr: new ECRClient({ region: settings.region }), runner });
        const caller = await stsCallerIdentity(new STSClient(aws)).get();
        let parameters: unknown = {};
        if (options.parameters !== undefined) parameters = JSON.parse(await readFile(options.parameters, "utf8").catch(() => { throw agentXError("CONFIG_INVALID", `the parameters file ${options.parameters} could not be read`); })) as unknown;
        const store_ = context.approvalStore?.(bucket, settings.region) ?? s3ApprovalStore(new S3Client({ region: settings.region }), bucket);
        const record = await approveBundle({ bundle, approvedBy: caller.arn, parameters, rollback: options.rollback, store: store_, now: Date.now });
        context.stdout.write(globals.json ? formatSuccess(record, true) : `Approved bundle ${record.bundleId} (release ${record.version}) for ${globals.env}. The Rovara operator can now start its deployment; withdraw it with: agentx bundle withdraw ${record.bundleId}\n`);
      } finally {
        await bundle.cleanup();
      }
    });
  bundleCommand
    .command("reset-deployment")
    .description("clear the deployer's progress record and run lock, after a deployment you do not mean to finish (for example a failed one whose bundle you withdrew); the next approved bundle can then start")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string }>();
      const outcome = await resetDeployment({ store: context.parameterStore(options.region), env: globals.env });
      context.stdout.write(outcome.clearedProgress || outcome.clearedLock
        ? `Cleared the deployer's ${outcome.clearedProgress ? `progress record${outcome.bundleId === undefined ? "" : ` (bundle ${outcome.bundleId})`}` : ""}${outcome.clearedProgress && outcome.clearedLock ? " and " : ""}${outcome.clearedLock ? "run lock" : ""}. Stacks already updated stay as they are; check them before approving the next bundle.\n`
        : "Nothing to clear: the deployer has no progress record or lock.\n");
    });
  bundleCommand
    .command("withdraw <bundle id>")
    .description("withdraw your approval of a bundle: the deployer refuses it from then on")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (bundleId: string, options: { region?: string }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string }>();
      const aws = options.region === undefined ? {} : { region: options.region };
      const settings = await readEnvironmentSettings(context.parameterStore(options.region), globals.env);
      if (settings === undefined) throw agentXError("CONFIG_INVALID", `environment ${globals.env} is not installed in this account and region`);
      const bucket = (await cloudFormationStackReader(new CloudFormationClient(aws)).describe(settings.stacks.access ?? `agentx-${globals.env}-access`))?.outputs.ApprovedBundlesBucketName;
      if (bucket === undefined) throw agentXError("CONFIG_INVALID", "this install has no approval bucket");
      await withdrawApproval({ bundleId: bundleId.toLowerCase(), store: context.approvalStore?.(bucket, settings.region) ?? s3ApprovalStore(new S3Client({ region: settings.region }), bucket) });
      context.stdout.write(`Withdrew the approval of bundle ${bundleId.toLowerCase()}; the deployer will refuse it.\n`);
    });
}
