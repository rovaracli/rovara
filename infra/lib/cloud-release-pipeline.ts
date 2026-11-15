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
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";
import { CLOUD_APP_CONTEXT_KEY } from "./cloud-app.js";

/**
 * The Rovara Cloud release pipeline (owner decisions 2026-11-14): a vX.Y.Z tag pushed to PrepLabsAI/Rovara-cloud waits for a
 * person to approve, then deploys Rovara Cloud (cloud-app.ts) on an existing Rovara Code install.
 *
 *   Source (tag) -> Approve (manual) -> Deploy (cdk deploy of the Cloud stack, which builds its image)
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
const FIND_RELEASE_TAG = [
  'git fetch --force --quiet origin "refs/tags/*:refs/tags/*"',
  'RELEASE_TAG="$(git tag --points-at HEAD | grep -E "^v[0-9]+\\.[0-9]+\\.[0-9]+$" | head -n 1)"',
  'if [ -z "$RELEASE_TAG" ]; then echo "this commit has no vX.Y.Z release tag; the pipeline deploys release tags only" >&2; exit 1; fi',
  'echo "release $RELEASE_TAG at $(git rev-parse HEAD)"',
];

/** How often the release check asks the live address during a deploy, and what it asks for (the page shell, and the API without a sign-in). */
export const RELEASE_CHECK_PATHS = ["/app", "/v1/web/me"] as const;

/**
 * The deploy, with the release check around it (#11): while `cdk deploy` runs, Cloud's live address (the web stack's CloudUrl) is asked
 * every second, and any 5xx or failed connection fails the release, even when the deploy itself succeeded. The first deploy of the web
 * stack has no address yet, so it isn't checked.
 */
const RELEASE_CHECKED_DEPLOY = [
  'base="$(aws cloudformation describe-stacks --stack-name "${STACK_PREFIX}-web" --query "Stacks[0].Outputs[?OutputKey==\'CloudUrl\'].OutputValue" --output text 2>/dev/null | sed "s#/app\\$##")"',
  "rm -f /tmp/release-check.log; poller=",
  'if [ -n "$base" ] && [ "$base" != "None" ]; then',
  `  ( while :; do for path in ${RELEASE_CHECK_PATHS.join(" ")}; do code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$base$path")"; case "$code" in 5*|000) echo "$(date -u +%H:%M:%S) $path $code" >> /tmp/release-check.log;; esac; done; sleep 1; done ) &`,
  "  poller=$!",
  '  echo "release check: asking $base every second during the deploy"',
  "else",
  '  echo "release check: no live address yet (the first deploy of ${STACK_PREFIX}-web), so nothing to check"',
  "fi",
  `npx cdk deploy RovaraCloudApp RovaraCloudWeb --app "node infra/dist/bin/agentx.js" -c ${CLOUD_APP_CONTEXT_KEY}="$ROVARA_ENV" -c agentxRegion="$AWS_REGION" --parameters CodeUrl="$CODE_URL" --require-approval never --progress events`,
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

    const artifactBucket = new s3.Bucket(this, "Artifacts", {
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
          variables: { ROVARA_ENV: env, STACK_PREFIX: `${RESOURCE_PREFIX}-${env}`, CODE_URL: codeUrl.valueAsString, NODE_OPTIONS: CLOUD_PIPELINE_NODE_OPTIONS },
        },
        phases: {
          install: { commands: INSTALL_NODE },
          // The web build: cloud-web.ts uploads the app's files to S3 and puts the page shell in the function.
          pre_build: { commands: [...FIND_RELEASE_TAG, "npm ci", "npx tsc -b infra", "npm run build:web"] },
          build: {
            // One command: the release check's poller and the deploy share one shell.
            commands: [RELEASE_CHECKED_DEPLOY],
          },
        },
      }),
    });
    deploy.addToRolePolicy(useConnection);
    // The release check reads the live address from the web stack's outputs, and nothing else.
    deploy.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cloudformation:DescribeStacks"],
      resources: [`arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/${RESOURCE_PREFIX}-${env}-web/*`],
    }));
    // cdk deploy works through the account's bootstrap roles (deploy, publishing, lookup) and nothing else.
    deploy.addToRolePolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-${CLOUD_PIPELINE_BOOTSTRAP_QUALIFIER}-*-${this.account}-${this.region}`],
    }));

    const sourceRole = new iam.Role(this, "SourceActionRole", {
      assumedBy: new iam.AccountRootPrincipal(),
      description: `Reads ${CLOUD_PIPELINE_REPOSITORY_OWNER}/${CLOUD_PIPELINE_REPOSITORY_NAME} through the GitHub connection`,
    });
    sourceRole.addToPolicy(useConnection);

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
  }
}
