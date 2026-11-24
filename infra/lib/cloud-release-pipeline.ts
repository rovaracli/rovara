import {
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as actions,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { PRODUCTION_SOURCE_KINDS_REFUSAL, RESOURCE_PREFIX, environmentSettingsPrefix, parseSourceKindsSwitch, productionSourceKindsAllowed } from "@agentx/contracts";
import { CLOUD_APP_CONTEXT_KEY } from "./cloud-app.js";
import { CDK_BOOTSTRAP_ASSUMED_ROLES, applyCloudBoundary, keepRoleAtRoot } from "./cloud-boundary.js";
import { MODEL_GATEWAY_PRODUCT_CONTEXT_KEY } from "./model-gateway.js";

/**
 * The Rovara Cloud release pipeline (owner decisions 2026-11-14): a vX.Y.Z tag pushed to PrepLabsAI/Rovara-cloud waits for a
 * person to approve, then deploys Rovara Cloud (cloud-app.ts) on an existing Rovara Code install.
 *
 *   Source (tag) -> Check (a vX.Y.Z tag on cloud/next) -> Approve (manual) -> Deploy (cdk deploy, with the release check)
 *
 * Rovara Code is installed first and on its own (its own pipeline or `rovara init`); this pipeline never deploys any of
 * Code's stacks, and Cloud has no user pool: people sign in through Code. The Code install's address is the CodeUrl
 * parameter. The deploy job can only assume the account's CDK bootstrap roles. The pipeline never deploys itself.
 */
export const CLOUD_PIPELINE_CONTEXT_KEY = "rovaraCloudPipeline";
export const CLOUD_PIPELINE_REPOSITORY_OWNER = "PrepLabsAI";
export const CLOUD_PIPELINE_REPOSITORY_NAME = "Rovara-cloud";
/** The branch the source action names. A tag on any commit triggers it; release tags are cut from cloud/next. */
export const CLOUD_PIPELINE_BRANCH = "cloud/next";
/** The CDK build needs more than Node's default 2 GB heap; the LARGE build machine has 16 GB. */
export const CLOUD_PIPELINE_NODE_OPTIONS = "--max-old-space-size=8192";
/** The CDK bootstrap qualifier the account was bootstrapped with (the default). */
export const CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER = "hnb659fds";

/**
 * The deploy switches each environment's pipeline carries into `cdk deploy` (PRODUCT-AI-PIPELINE-SWITCH): read from here when the
 * pipeline is made, never typed per run, so a release deploys an environment exactly as it was switched on by hand. Without the
 * product AI switch, a pipeline deploy of a switched-on environment would drop the Cloud server's product key grants and settings.
 * Production carries it (Rovara-cloud#247): its web stack was switched on by hand first, with the gateway's ProductKeys* parameters.
 * A change here reaches a pipeline only when its stack is redeployed by hand.
 */
/**
 * Rovara-cloud#308: `aiSourceKinds` is the environment's `-c rovaraAiSourceKinds` (app.ts), carried so a release keeps the company AI source
 * kinds its web stack was deployed with by hand. The gateway is deployed by hand only, with the same value.
 */
export interface CloudPipelineSwitches { productAi?: true; aiSourceKinds?: string }
/** app.ts AI_SOURCE_KINDS_CONTEXT_KEY (app.ts imports this file, so the name is repeated here; a contract test holds the two equal). */
export const PIPELINE_AI_SOURCE_KINDS_CONTEXT_KEY = "rovaraAiSourceKinds";
export const CLOUD_PIPELINE_SWITCHES: Readonly<Record<string, Readonly<CloudPipelineSwitches>>> = Object.freeze({
  staging: Object.freeze({ productAi: true as const }),
  // Rovara-cloud#247: production's gateway is deployed, and its web stack was switched on by hand with the gateway's ProductKeys* parameters.
  production: Object.freeze({ productAi: true as const }),
  // Rovara-cloud#269, #273: beta, on beta Code (account 233082642592). Its gateway is gateway.beta.rovara.dev, and its web stack was
  // switched on by hand with that gateway's ProductKeys* parameters, ModelGatewayUrl and GatewayMeterTableName, as production's was.
  beta: Object.freeze({ productAi: true as const }),
});
/**
 * Rovara-cloud#269: an environment whose Cloud lives in another account. Its pipeline runs in the account that holds the GitHub
 * connection (as Rovara Code's beta release does) and deploys into this account through its CDK bootstrap roles, which must trust the
 * pipeline's account (`cdk bootstrap --trust <pipeline account> --trust-for-lookup <pipeline account>` there). Absent: its own account.
 */
export const CLOUD_PIPELINE_DEPLOY_ACCOUNTS: Readonly<Record<string, string>> = Object.freeze({
  beta: "233082642592",
});
/** The account the environment's pipeline deploys into, or undefined for the pipeline's own. */
export function pipelineDeployAccount(env: string, accounts: Readonly<Record<string, string>> = CLOUD_PIPELINE_DEPLOY_ACCOUNTS): string | undefined {
  const account = Object.hasOwn(accounts, env) ? accounts[env] : undefined;
  if (account !== undefined && !/^[0-9]{12}$/u.test(account)) throw new Error(`the deploy account for ${env} must be 12 digits`);
  return account;
}
/** The cdk context naming the account the Cloud stacks deploy into (app.ts). */
export const DEPLOY_ACCOUNT_CONTEXT_KEY = "agentxAccount";

/** The `-c` arguments the environment's deploy carries (cdk context), from CLOUD_PIPELINE_SWITCHES. */
export function pipelineDeployContext(env: string, config: Readonly<Record<string, Readonly<CloudPipelineSwitches>>> = CLOUD_PIPELINE_SWITCHES): string[] {
  const switches: Readonly<CloudPipelineSwitches> = Object.hasOwn(config, env) ? config[env]! : {};
  const context = switches.productAi === true ? [`-c ${MODEL_GATEWAY_PRODUCT_CONTEXT_KEY}=on`] : [];
  if (switches.aiSourceKinds !== undefined) {
    // Checked as the app checks it (a bad value would stop the synth) and as production allows it, so a release never carries what a hand deploy refuses.
    parseSourceKindsSwitch(switches.aiSourceKinds);
    if (env === "production" && !productionSourceKindsAllowed(switches.aiSourceKinds)) throw new Error(PRODUCTION_SOURCE_KINDS_REFUSAL);
    if (switches.aiSourceKinds !== "") context.push(`-c ${PIPELINE_AI_SOURCE_KINDS_CONTEXT_KEY}=${switches.aiSourceKinds}`);
  }
  return context;
}

export interface CloudReleasePipelineProps extends StackProps {
  /** The named cloud environment this pipeline deploys, for example "production". */
  readonly environmentName: string;
}

const INSTALL_NODE = [
  // The pinned Node, under /opt so the checkout stays untouched.
  'node_version="$(cat .node-version)"',
  'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
  'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
  'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
  'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
  'export PATH="/opt/node/bin:$PATH"',
  "node --version && npm --version",
];

/** Fetches the tags and finds the one release tag on this commit: the pipeline deploys release tags only. */
export const FIND_RELEASE_TAG = [
  'git fetch --force --quiet origin "refs/tags/*:refs/tags/*"',
  'RELEASE_TAG="$(git tag --points-at HEAD | grep -E "^v[0-9]+\\.[0-9]+\\.[0-9]+$" | head -n 1)"',
  'if [ -z "$RELEASE_TAG" ]; then echo "this commit has no vX.Y.Z release tag; the pipeline deploys release tags only" >&2; exit 1; fi',
  'echo "release $RELEASE_TAG at $(git rev-parse HEAD)"',
];

/**
 * The release tag's commit must be on cloud/next. A tag trigger can't name a branch, so a vX.Y.Z tag cut anywhere else in the repository
 * (for example a staging release on an integration branch) would otherwise start this pipeline and reach Approve. Runs after
 * FIND_RELEASE_TAG, in the Check stage (before Approve, so such a run fails on its own) and again in the deploy job.
 */
export const RELEASE_TAG_ON_BRANCH = [
  `git fetch --quiet origin "+refs/heads/${CLOUD_PIPELINE_BRANCH}:refs/remotes/origin/${CLOUD_PIPELINE_BRANCH}"`,
  `if ! git merge-base --is-ancestor HEAD "origin/${CLOUD_PIPELINE_BRANCH}"; then echo "$RELEASE_TAG ($(git rev-parse --short HEAD)) is not on ${CLOUD_PIPELINE_BRANCH}: this pipeline deploys only release tags cut from ${CLOUD_PIPELINE_BRANCH}" >&2; exit 1; fi`,
  `echo "$RELEASE_TAG is on ${CLOUD_PIPELINE_BRANCH}"`,
];

/** How often the release check asks the live address during a deploy, and what it asks for (the page shell, and the API without a sign-in). */
export const RELEASE_CHECK_PATHS = ["/app", "/v1/web/me"] as const;

/**
 * The deploy, with the release check around it (#11): while `cdk deploy` runs, Cloud's live address (the web stack's CloudUrl) is asked
 * every second, and any 5xx or failed connection fails the release, even when the deploy itself succeeded. The first deploy of the web
 * stack has no address yet, so it isn't checked.
 */
const releaseCheckedDeploy = (context: readonly string[], deployAccount?: string) => [
  // DEC 254zzz279: never release the new default before existing own-key choices are saved.
  // Only reads through the already allowed CDK lookup role; the pipeline never applies the migration.
  'node scripts/agent-own-key-backfill.mjs --check --release-stack "${STACK_PREFIX}-web" --lookup-role "$C1_LOOKUP_ROLE" --region "$AWS_REGION" || exit 1',
  ...(deployAccount === undefined
    ? ['base="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-web" --query "Stacks[0].Outputs[?OutputKey==\'CloudUrl\'].OutputValue" --output text 2>/dev/null | sed "s#/app\\$##")"']
    // The web stack is in the deploy account: read its address through that account's lookup role (read only).
    : [
      `lookup="$(aws sts assume-role --role-arn "arn:aws:iam::${deployAccount}:role/cdk-${CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER}-lookup-role-${deployAccount}-$AWS_REGION" --role-session-name release-check --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text)"`,
      'base="$(set -- $lookup; AWS_ACCESS_KEY_ID="$1" AWS_SECRET_ACCESS_KEY="$2" AWS_SESSION_TOKEN="$3" aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-web" --query "Stacks[0].Outputs[?OutputKey==\'CloudUrl\'].OutputValue" --output text 2>/dev/null | sed "s#/app\\$##")"',
    ]),
  "rm -f /tmp/release-check.log; poller=",
  'if [ -n "$base" ] && [ "$base" != "None" ]; then',
  `  ( while :; do for path in ${RELEASE_CHECK_PATHS.join(" ")}; do code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$base$path")"; case "$code" in 5*|000) echo "$(date -u +%H:%M:%S) $path $code" >> /tmp/release-check.log;; esac; done; sleep 1; done ) &`,
  "  poller=$!",
  '  echo "release check: asking $base every second during the deploy"',
  "else",
  '  echo "release check: no live address yet (the first deploy of ${STACK_PREFIX}-web), so nothing to check"',
  "fi",
  `npx cdk deploy RovaraCloudApp RovaraCloudWeb --app "node infra/dist/bin/agentx.js" -c ${CLOUD_APP_CONTEXT_KEY}="$ROVARA_ENV" -c agentxRegion="$AWS_REGION"${deployAccount === undefined ? "" : ` -c ${DEPLOY_ACCOUNT_CONTEXT_KEY}=${deployAccount}`}${context.map((arg) => ` ${arg}`).join("")} --parameters CodeUrl="$CODE_URL" --require-approval never --progress events`,
  "status=$?",
  'if [ -n "$poller" ]; then kill "$poller" 2>/dev/null; wait "$poller" 2>/dev/null; fi',
  'if [ -s /tmp/release-check.log ]; then echo "the release check saw errors on $base during the deploy:" >&2; cat /tmp/release-check.log >&2; exit 1; fi',
  'if [ -n "$poller" ]; then echo "release check: no errors on $base during the deploy"; fi',
  "exit $status",
].join("\n");

export class CloudReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudReleasePipelineProps) {
    super(scope, id, props);
    const env = props.environmentName;
    // Validates the name (at most 14 characters, the environment-name rules) at synth.
    environmentSettingsPrefix(env);
    const deployAccount = pipelineDeployAccount(env);
    // Where cdk deploy goes: the deploy account's bootstrap roles, or this account's.
    const target = deployAccount ?? this.account;

    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: `Authorized CodeConnections GitHub connection that can read ${CLOUD_PIPELINE_REPOSITORY_OWNER}/${CLOUD_PIPELINE_REPOSITORY_NAME}`,
    });
    const codeUrl = new CfnParameter(this, "CodeUrl", {
      type: "String",
      allowedPattern: "^https://[^/\\s]+$",
      constraintDescription: "the Rovara Code install's API address: https:// and a host, no path",
      description: "The Rovara Code install this Cloud signs people in through, for example https://abc.execute-api.us-east-1.amazonaws.com",
    });

    const useConnection = new iam.PolicyStatement({
      actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:GetConnectionToken"],
      resources: [connectionArn.valueAsString],
    });

    // A short id: CloudFormation names the bucket <stack name>-<logical id>-<random>, and past S3's 63 characters it shortens the stack
    // name too, which the role boundary (cloud-boundary.ts, by stack name) would then not match. "Art" keeps the longest one at 62.
    const artifactBucket = new s3.Bucket(this, "Art", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, "BuildLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });

    const deploy = new codebuild.PipelineProject(this, "Deploy", {
      projectName: `${RESOURCE_PREFIX}-${env}-deploy`,
      description: `Deploys Rovara Cloud ${env} (its one stack) from a release tag`,
      // cdk deploy builds the Cloud image (linux/arm64) with Docker.
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      concurrentBuildLimit: 1,
      timeout: Duration.minutes(60),
      logging: { cloudWatch: { logGroup, prefix: "deploy" } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: {
          shell: "bash",
          "git-credential-helper": "yes",
          variables: { ROVARA_ENV: env, STACK_PREFIX: `${RESOURCE_PREFIX}-${env}`, CODE_URL: codeUrl.valueAsString, NODE_OPTIONS: CLOUD_PIPELINE_NODE_OPTIONS, C1_LOOKUP_ROLE: `arn:${this.partition}:iam::${target}:role/cdk-${CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER}-lookup-role-${target}-${this.region}` },
        },
        phases: {
          install: { commands: INSTALL_NODE },
          // The web build: cloud-web.ts uploads the app's files to S3 and puts the page shell in the function.
          pre_build: { commands: [...FIND_RELEASE_TAG, ...RELEASE_TAG_ON_BRANCH, "npm ci", "npx tsc -b infra", "npx tsc -b packages/model-gateway", "npm run build:web"] },
          build: {
            // One command: the release check's poller and the deploy share one shell.
            commands: [releaseCheckedDeploy(pipelineDeployContext(env), deployAccount)],
          },
        },
      }),
    });
    deploy.addToRolePolicy(useConnection);
    // The release check reads the live address from the web stack's outputs, and nothing else (in another account: through its lookup
    // role, below).
    if (deployAccount === undefined) deploy.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks"],
      resources: [`arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${RESOURCE_PREFIX}-${env}-web/*`],
    }));
    // cdk deploy works through the account's bootstrap roles (deploy, publishing, lookup) and nothing else: named, so never the
    // CloudFormation execution role (the role boundary denies that one too).
    deploy.addToRolePolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${this.partition}:iam::${target}:role/cdk-${CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER}-${role}-${target}-${this.region}`),
    }));

    const sourceRole = new iam.Role(this, "SourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: `Reads ${CLOUD_PIPELINE_REPOSITORY_OWNER}/${CLOUD_PIPELINE_REPOSITORY_NAME} through the GitHub connection`,
    });
    sourceRole.addToPolicy(useConnection);

    // The Check stage: the tag is a vX.Y.Z release tag on cloud/next, before anyone is asked to approve.
    const check = new codebuild.PipelineProject(this, "Check", {
      projectName: `${RESOURCE_PREFIX}-${env}-check`,
      description: `Checks a release tag for Rovara Cloud ${env} is a vX.Y.Z tag on ${CLOUD_PIPELINE_BRANCH}, before approval`,
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.SMALL },
      timeout: Duration.minutes(10),
      logging: { cloudWatch: { logGroup, prefix: "check" } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: { shell: "bash", "git-credential-helper": "yes" },
        phases: { build: { commands: [...FIND_RELEASE_TAG, ...RELEASE_TAG_ON_BRANCH] } },
      }),
    });
    check.addToRolePolicy(useConnection);

    const sourceOutput = new codepipeline.Artifact("Source");
    const source = new actions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      connectionArn: connectionArn.valueAsString,
      owner: CLOUD_PIPELINE_REPOSITORY_OWNER,
      repo: CLOUD_PIPELINE_REPOSITORY_NAME,
      branch: CLOUD_PIPELINE_BRANCH,
      codeBuildCloneOutput: true,
      triggerOnPush: false,
      output: sourceOutput,
      role: sourceRole,
      variablesNamespace: "SourceVariables",
    });

    new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: `${RESOURCE_PREFIX}-${env}-release`,
      pipelineType: codepipeline.PipelineType.V2,
      // Each release runs on its own, in order; a waiting release is never replaced by a newer one.
      executionMode: codepipeline.ExecutionMode.QUEUED,
      // aws-cdk-lib types Bucket.isWebsite as `boolean | undefined`, which exactOptionalPropertyTypes rejects for IBucket.
      artifactBucket: artifactBucket as s3.IBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: false,
      stages: [
        { stageName: "Source", actions: [source] },
        { stageName: "Check", actions: [new actions.CodeBuildAction({ actionName: "CheckReleaseTag", project: check, input: sourceOutput })] },
        {
          stageName: "Approve",
          actions: [new actions.ManualApprovalAction({
            actionName: "ApproveDeploy",
            additionalInformation: `Deploy commit #{SourceVariables.CommitId} to Rovara Cloud ${env}.`,
          })],
        },
        {
          stageName: "Deploy",
          actions: [new actions.CodeBuildAction({ actionName: "DeployCloud", project: deploy, input: sourceOutput })],
        },
      ],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: { sourceAction: source, pushFilter: [{ tagsIncludes: ["v*.*.*"], tagsExcludes: ["v*-*"] }] },
      }],
    });
    // Last, so the template keeps its section order; the aspect puts it on every role at synth (cloud-boundary.ts).
    // CDK names a CodeBuild project's service role by name, which CodeBuild reads as a role at "/": those two stay there.
    keepRoleAtRoot(deploy.role!);
    keepRoleAtRoot(check.role!);
    applyCloudBoundary(this, env, "pipeline", undefined, deployAccount);
  }
}
