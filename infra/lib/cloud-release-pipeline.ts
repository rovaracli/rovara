import {
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_codebuild as codebuild,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as actions,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix, environmentStackName } from "@agentx/contracts";

/**
 * The Rovara Cloud release pipeline (owner decisions 2026-11-14): a vX.Y.Z tag pushed to PrepLabsAI/Rovara-cloud builds the
 * worker and Slack images, waits for a person to approve, then deploys one named cloud environment with the CLI.
 *
 *   Source (tag) -> Images (build and push, by digest) -> Approve (manual) -> Deploy (rovara init or rovara upgrade)
 *
 * The first deployment of an environment runs `rovara init --rovara-cloud --yes --stop-after slack-service`: every stack, nothing
 * that needs a browser. A person then finishes the GitHub App, the Slack app, the admin sign-in and the first reply once with
 * `rovara init` on their own machine (docs/rovara-cloud-install.md). Every later tag runs `rovara upgrade`.
 *
 * The deploy job has AdministratorAccess: the CLI deploys the cdk engine only with admin credentials (it refuses the operator
 * role). It is guarded by the tag trigger and the approval. The pipeline never deploys itself.
 */
export const CLOUD_PIPELINE_CONTEXT_KEY = "rovaraCloudPipeline";
export const CLOUD_PIPELINE_REPOSITORY_OWNER = "PrepLabsAI";
export const CLOUD_PIPELINE_REPOSITORY_NAME = "Rovara-cloud";
/** The branch the source action names. A tag on any commit triggers it; release tags are cut from cloud/next. */
export const CLOUD_PIPELINE_BRANCH = "cloud/next";
export const CLOUD_PIPELINE_AWS_CLI_VERSION = "2.36.47";

/** The images repository of one environment's image, created by this stack in the environment's account and region. */
export function cloudImageRepositoryName(env: string, image: "worker" | "slack"): string {
  return `${RESOURCE_PREFIX}-${env}/${image}`;
}

export interface CloudReleasePipelineProps extends StackProps {
  /** The named cloud environment this pipeline deploys, for example "production". */
  readonly environmentName: string;
}

const INSTALL_TOOLS = [
  // Tools go under /opt so the CLI's clean-checkout check sees an untouched tree.
  'node_version="$(cat .node-version)"',
  'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
  'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
  'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
  'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
  'curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"',
  "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-cli/bin",
  'export PATH="/opt/node/bin:/opt/aws-cli/bin:$PATH"',
  "node --version && npm --version && aws --version",
];

/** Fetches the tags and finds the one release tag on this commit; the CLI deploys only a clean checkout of a vX.Y.Z tag. */
const FIND_RELEASE_TAG = [
  'git fetch --force --quiet origin "refs/tags/*:refs/tags/*"',
  'RELEASE_TAG="$(git tag --points-at HEAD | grep -E "^v[0-9]+\\.[0-9]+\\.[0-9]+$" | head -n 1)"',
  'if [ -z "$RELEASE_TAG" ]; then echo "this commit has no vX.Y.Z release tag; the pipeline deploys release tags only" >&2; exit 1; fi',
  'echo "release $RELEASE_TAG at $(git rev-parse HEAD)"',
];

export class CloudReleasePipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudReleasePipelineProps) {
    super(scope, id, props);
    const env = props.environmentName;
    // Validates the name (at most 14 characters, the environment-name rules) at synth.
    const settingsPrefix = environmentSettingsPrefix(env);
    environmentStackName(env, "access");

    const connectionArn = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$",
      description: `Authorized CodeConnections GitHub connection that can read ${CLOUD_PIPELINE_REPOSITORY_OWNER}/${CLOUD_PIPELINE_REPOSITORY_NAME}`,
    });
    // The answers the first, unattended `rovara init --yes` needs. Later upgrades read the environment's own settings instead.
    const adminEmail = new CfnParameter(this, "AdminEmail", { type: "String", minLength: 3, description: "Email of the environment's first Rovara staff admin (the identity stack's admin user)" });
    const alertEmail = new CfnParameter(this, "AlertEmail", { type: "String", minLength: 3, description: "Email address the environment's alarms and budget alerts go to" });
    const githubAccount = new CfnParameter(this, "GitHubAccount", { type: "String", allowedPattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$", description: "GitHub organization or user that will own the environment's shared, public GitHub App" });
    const slackChannel = new CfnParameter(this, "SlackChannel", { type: "String", allowedPattern: "^[a-z0-9][a-z0-9_-]{0,79}$", description: "Slack channel name for the first project (used when a person finishes the install)" });

    const useConnection = new iam.PolicyStatement({
      actions: ["codeconnections:UseConnection", "codestar-connections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:GetConnectionToken"],
      resources: [connectionArn.valueAsString],
    });

    const repositories = (["worker", "slack"] as const).map((image) => new ecr.Repository(this, image === "worker" ? "WorkerImages" : "SlackImages", {
      repositoryName: cloudImageRepositoryName(env, image),
      imageScanOnPush: true,
      lifecycleRules: [{ description: "Keep the 30 newest images", maxImageCount: 30 }],
      // Images a deployed environment runs are pinned by digest; deleting this stack must not delete them.
      removalPolicy: RemovalPolicy.RETAIN,
    }));
    const [workerRepository, slackRepository] = repositories as [ecr.Repository, ecr.Repository];

    const artifactBucket = new s3.Bucket(this, "Artifacts", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, "BuildLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });

    const images = new codebuild.PipelineProject(this, "Images", {
      projectName: `${RESOURCE_PREFIX}-${env}-images`,
      description: `Builds and pushes the ${env} worker and Slack images for a release tag`,
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      concurrentBuildLimit: 1,
      timeout: Duration.minutes(90),
      logging: { cloudWatch: { logGroup, prefix: "images" } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: {
          shell: "bash",
          "git-credential-helper": "yes",
          variables: { WORKER_REPOSITORY: workerRepository.repositoryUri, SLACK_REPOSITORY: slackRepository.repositoryUri },
          "exported-variables": ["RELEASE_TAG", "WORKER_IMAGE", "SLACK_IMAGE", "BOOT_STAGE2_SHA256"],
        },
        phases: {
          pre_build: {
            commands: [
              ...FIND_RELEASE_TAG,
              'registry="${WORKER_REPOSITORY%%/*}"',
              'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry"',
              "docker buildx version",
            ],
          },
          build: {
            commands: [
              // One linux/arm64 image manifest each (no attestation index), so the digest read back is the image's own.
              'docker buildx build --platform linux/arm64 --provenance=false --sbom=false --file environments/base/Dockerfile --tag "$WORKER_REPOSITORY:$RELEASE_TAG-$CODEBUILD_BUILD_NUMBER" --push .',
              'docker buildx build --platform linux/arm64 --provenance=false --sbom=false --file environments/slack/Dockerfile --tag "$SLACK_REPOSITORY:$RELEASE_TAG-$CODEBUILD_BUILD_NUMBER" --push .',
              'worker_digest="$(docker buildx imagetools inspect "$WORKER_REPOSITORY:$RELEASE_TAG-$CODEBUILD_BUILD_NUMBER" --format "{{json .Manifest.Digest}}" | tr -d \'"\')"',
              'slack_digest="$(docker buildx imagetools inspect "$SLACK_REPOSITORY:$RELEASE_TAG-$CODEBUILD_BUILD_NUMBER" --format "{{json .Manifest.Digest}}" | tr -d \'"\')"',
              'case "$worker_digest$slack_digest" in *sha256:*sha256:*) ;; *) echo "the registry returned no digest" >&2; exit 1;; esac',
              'export WORKER_IMAGE="$WORKER_REPOSITORY@$worker_digest" SLACK_IMAGE="$SLACK_REPOSITORY@$slack_digest"',
              // The worker checks this hash at every boot; it must come from the commit the image was built from.
              'export BOOT_STAGE2_SHA256="$(sha256sum packages/worker/ec2/boot-stage2.sh | cut -d " " -f 1)"',
              'echo "worker $WORKER_IMAGE"; echo "slack $SLACK_IMAGE"; echo "boot-stage2 $BOOT_STAGE2_SHA256"',
            ],
          },
        },
      }),
    });
    for (const repository of repositories) repository.grantPullPush(images);
    images.addToRolePolicy(useConnection);

    const deploy = new codebuild.PipelineProject(this, "Deploy", {
      projectName: `${RESOURCE_PREFIX}-${env}-deploy`,
      description: `Deploys the ${env} Rovara Cloud environment with the rovara CLI (init the first time, upgrade after)`,
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true }, // cdk deploy builds container assets with Docker.
      concurrentBuildLimit: 1,
      // A first install takes about 25 minutes of stacks; an upgrade less. The CLI resumes where a cut-off run stopped.
      timeout: Duration.hours(2),
      logging: { cloudWatch: { logGroup, prefix: "deploy" } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: {
          shell: "bash",
          "git-credential-helper": "yes",
          variables: {
            AWS_CLI_VERSION: CLOUD_PIPELINE_AWS_CLI_VERSION,
            ROVARA_ENV: env,
            SETTINGS_PARAMETER: `${settingsPrefix}settings`,
            ADMIN_EMAIL: adminEmail.valueAsString,
            ALERT_EMAIL: alertEmail.valueAsString,
            GITHUB_ACCOUNT: githubAccount.valueAsString,
            SLACK_CHANNEL: slackChannel.valueAsString,
          },
        },
        phases: {
          install: { commands: INSTALL_TOOLS },
          pre_build: { commands: [...FIND_RELEASE_TAG, "npm ci", "npm run build", 'test -z "$(git status --porcelain)" || { git status --porcelain >&2; echo "the build changed tracked files" >&2; exit 1; }'] },
          build: {
            commands: [
              'cli() { node packages/cli/dist/bin.js --env "$ROVARA_ENV" "$@"; }',
              'images=(--worker-image "$WORKER_IMAGE" --boot-stage2-sha256 "$BOOT_STAGE2_SHA256" --slack-image "$SLACK_IMAGE")',
              [
                'if aws ssm get-parameter --name "$SETTINGS_PARAMETER" --region "$AWS_REGION" >/dev/null 2>&1; then',
                '  echo "$ROVARA_ENV is installed: upgrading to $RELEASE_TAG"',
                '  cli upgrade --region "$AWS_REGION" --source "$PWD" "${images[@]}" --yes',
                "else",
                '  echo "$ROVARA_ENV is not installed: installing $RELEASE_TAG (every stack; a person finishes the browser steps)"',
                '  cli init --region "$AWS_REGION" --engine cdk --source "$PWD" --rovara-cloud --yes --no-browser --no-ui "${images[@]}" \\',
                '    --github-account "$GITHUB_ACCOUNT" --alert-email "$ALERT_EMAIL" --admin-email "$ADMIN_EMAIL" --channel "$SLACK_CHANNEL" --connectors none \\',
                "    --stop-after slack-service",
                "fi",
              ].join("\n"),
            ],
          },
        },
      }),
    });
    deploy.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"));

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
    });
    const imagesAction = new actions.CodeBuildAction({ actionName: "BuildImages", project: images, input: sourceOutput, variablesNamespace: "Images" });

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
        { stageName: "Images", actions: [imagesAction] },
        {
          stageName: "Approve",
          actions: [new actions.ManualApprovalAction({
            actionName: "ApproveDeploy",
            additionalInformation: `Deploy release #{Images.RELEASE_TAG} to the ${env} Rovara Cloud environment (worker #{Images.WORKER_IMAGE}).`,
          })],
        },
        {
          stageName: "Deploy",
          actions: [new actions.CodeBuildAction({
            actionName: "DeployEnvironment",
            project: deploy,
            input: sourceOutput,
            environmentVariables: {
              WORKER_IMAGE: { value: imagesAction.variable("WORKER_IMAGE") },
              SLACK_IMAGE: { value: imagesAction.variable("SLACK_IMAGE") },
              BOOT_STAGE2_SHA256: { value: imagesAction.variable("BOOT_STAGE2_SHA256") },
            },
          })],
        },
      ],
      triggers: [{
        providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
        gitConfiguration: { sourceAction: source, pushFilter: [{ tagsIncludes: ["v*.*.*"], tagsExcludes: ["v*-*"] }] },
      }],
    });
  }
}
