// The `agentx upgrade` command (FR-042 to FR-044, FR-026's upgrade --export), kept out of main.ts.
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { STSClient } from "@aws-sdk/client-sts";
import type { Command } from "commander";
import { cdkDiff } from "../deploy/cdk-engine.js";
import { resolveDeployEdition } from "../deploy/edition.js";
import { prepareDeployment, readlineAsk, realCommandRunner, type DeployCliDependencies } from "../deploy/commands.js";
import { loadRelease } from "../deploy/release.js";
import { realDoctorServices } from "../doctor/aws.js";
import { runDoctor } from "../doctor/run.js";
import { cloudFormationStackReader, stsCallerIdentity } from "../environments/adopt.js";
import type { ParameterStore } from "../environments/parameter-store.js";
import { secretsManagerInitSecrets } from "../init/context.js";
import { githubRestApi } from "../init/github-app.js";
import type { TextWriter } from "../init/prompts.js";
import { fetchRelease, sourceRelease } from "../init/release-fetch.js";
import { formatSuccess } from "../output.js";
import { RELEASE_VERSION } from "../version.js";
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
}

const collect = (value: string, previous: string[]) => [...previous, value];

export function registerUpgradeCommand(program: Command, context: UpgradeCommandContext): void {
  program
    .command("upgrade")
    .description("upgrade an environment to a newer release: shows the release notes and every change, stops on a data replacement unless you name it, then runs doctor (operator role; the cdk engine needs admin credentials)")
    .option("--to <version>", "the release to upgrade to; default: this agentx's own release, or for an agentx built from source upgrading a cdk environment, the --source tag")
    .option("--release <dir>", "a release directory (agentx release build output) instead of downloading one")
    .option("--source <dir>", "the cdk engine only: a clean checkout of the target release's tag; --to or --release, when given, must match it")
    .option("--allow-replace <logical-id>", "accept replacing or deleting this table, user pool, bucket, key or secret; repeat for each", collect, [])
    .option("--export <dir>", "write the upgrade for a platform team's pipeline instead of deploying it")
    .option("--worker-image <digest-ref>", "worker image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--boot-stage2-sha256 <hex>", "with --worker-image: the SHA-256 of packages/worker/ec2/boot-stage2.sh in the release source that image was built from (a release supplies its own)")
    .option("--slack-image <digest-ref>", "Slack service image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--yes", "apply without asking; every change and the release notes are still printed", false)
    .option("--no-reserved-concurrency", "the cdk engine only: deploy with no Lambda reserved concurrency, for an AWS account whose Lambda concurrency limit is too low to reserve any (a new account's limit of 10); keep it on in production")
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { to?: string; release?: string; source?: string; allowReplace: string[]; export?: string; workerImage?: string; slackImage?: string; bootStage2Sha256?: string; yes: boolean; region?: string; reservedConcurrency: boolean }, command: Command) => {
      const globals = command.optsWithGlobals<{ env: string; json: boolean; configDir: string }>();
      const overrides = context.overrides ?? {};
      const aws = options.region === undefined ? {} : { region: options.region };
      const store = overrides.store ?? context.parameterStore(options.region);
      const runner = realCommandRunner(context.stderr);
      const write = overrides.write ?? ((line: string) => { context.stderr.write(`${line}\n`); });
      const deps: UpgradeDependencies = {
        store,
        stacks: overrides.stacks ?? cloudFormationStackReader(new CloudFormationClient(aws)),
        cloudFormation: overrides.cloudFormation ?? new CloudFormationClient(aws),
        identity: overrides.identity ?? stsCallerIdentity(new STSClient(aws)),
        loadRelease: overrides.loadRelease ?? (async (input) => loadRelease(input.releaseDir ?? await fetchRelease({ version: input.version, home: context.home, fetch: context.fetch, runner, write }))),
        sourceRelease: overrides.sourceRelease ?? (async (input) => (await sourceRelease({ runner, source: input.source, images: input.images, fetch: context.fetch })).release),
        notes: overrides.notes ?? ((version) => releaseNotes({ fetch: context.fetch, version })),
        prepare: overrides.prepare ?? ((input) => prepareDeployment({
          engine: input.settings.engine, env: input.settings.env, region: input.settings.region, account: input.settings.account,
          identityMode: input.settings.identity.mode, ...(input.settings.cloud === true ? { cloud: true } : {}), ...(input.reservedConcurrency === false ? { reservedConcurrency: false as const } : {}), release: input.release, ...(input.source === undefined ? {} : { source: input.source }),
          deps: context.deploy ?? {}, stderr: context.stderr,
        })),
        // Enterprise foundations E2: the diff is synthesized with the install's recorded edition, as the deploy is, so it does not show the edition stamp as removed.
        cdkDiff: overrides.cdkDiff ?? (async (request, settings, source, reservedConcurrency) => {
          const edition = await resolveDeployEdition({ store, env: settings.env, engine: settings.engine, cloud: settings.cloud === true });
          return cdkDiff({ runner, source, env: settings.env, region: settings.region, identityMode: settings.identity.mode, ...(settings.cloud === true ? { cloud: true } : {}), ...(reservedConcurrency === false ? { reservedConcurrency: false as const } : {}), ...(edition === undefined ? {} : { edition }), request });
        }),
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
        ...(options.to === undefined ? {} : { to: options.to }), ...(options.release === undefined ? {} : { releaseDir: options.release }),
        ...(options.source === undefined ? {} : { source: options.source }), ...(options.export === undefined ? {} : { exportDir: options.export }),
        ...(options.reservedConcurrency === false ? { reservedConcurrency: false as const } : {}),
        ...(images === undefined ? {} : { images }),
      }, deps);
      context.stdout.write(globals.json ? formatSuccess(result, true) : result.exported !== undefined
        ? `Wrote the upgrade of ${result.env} to ${result.to} to ${result.exported}; give it to your platform team.\n`
        : `Upgraded ${result.env} from ${result.from} to ${result.to}.\n`);
    });
}
