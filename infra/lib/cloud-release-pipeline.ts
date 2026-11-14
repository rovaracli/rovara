import {
  CfnOutput,
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
import { INSTALLER_TIMEOUT } from "./installer.js";
import { setupPage } from "./setup-page.js";

/**
 * The Rovara Cloud release pipeline (owner decisions 2026-11-14): a vX.Y.Z tag pushed to PrepLabsAI/Rovara-cloud builds the
 * worker and Slack images, waits for a person to approve, then deploys one named cloud environment with the CLI.
 *
 *   Source (tag) -> Images (build and push, by digest) -> Approve (manual) -> Deploy (rovara init or rovara upgrade) -> Setup
 *
 * Two phases. The first deployment of an environment runs `rovara init --rovara-cloud --yes --stop-after slack-service`: every
 * stack, no questions; the identity stack already allows this stack's setup page (--setup-page-url). The Setup stage then
 * resumes `rovara init` on that hosted setup page (setup-page.ts, the Launch in AWS installer's page): it makes the first admin
 * (SetupEmail), whose temporary password and the page's address Cognito emails, and the person finishes the GitHub App, the
 * Slack app, the first project, alerts and the first reply there. No laptop. Once the CLI's install progress says init
 * finished, the Setup stage does nothing, and every later tag runs `rovara upgrade`.
 *
 * The deploy and setup jobs have AdministratorAccess: the CLI deploys the cdk engine only with admin credentials (it refuses
 * the operator role), and init's finishing steps create users, secrets and subscriptions. They are guarded by the tag trigger
 * and the approval. The pipeline never deploys itself.
 */
export const CLOUD_PIPELINE_CONTEXT_KEY = "rovaraCloudPipeline";
export const CLOUD_PIPELINE_REPOSITORY_OWNER = "PrepLabsAI";
export const CLOUD_PIPELINE_REPOSITORY_NAME = "Rovara-cloud";
/** The branch the source action names. A tag on any commit triggers it; release tags are cut from cloud/next. */
export const CLOUD_PIPELINE_BRANCH = "cloud/next";
export const CLOUD_PIPELINE_AWS_CLI_VERSION = "2.36.47";
/** The GitHub organization that owns every cloud environment's shared, public GitHub App. */
export const CLOUD_PIPELINE_GITHUB_ACCOUNT = "PrepLabsAI";
/** `rovara init --yes` insists on --channel before it starts, though only the first-project step (on the setup page) uses it.
 * The first run stops before that step and never stores it, so the setup page asks for the real channel. */
export const CLOUD_PIPELINE_PLACEHOLDER_CHANNEL = "rovara-setup-placeholder";
/** How long the setup job may wait for the person on the setup page (the installer's limit). */
export const CLOUD_SETUP_TIMEOUT = INSTALLER_TIMEOUT;

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

/** Defines setup_state, which prints "finished" once the CLI's install progress (SSM /rovara-cloud/<env>/install/progress)
 * records its last step, e2e, as done, and "unfinished" otherwise (no progress yet included). Init records a step done only
 * after every step before it, so a done e2e means every step is. Any other read failure is an error, never a guess. */
const SETUP_STATE = [
  "setup_state() {",
  '  local out',
  '  if ! out="$(aws ssm get-parameter --name "$PROGRESS_PARAMETER" --region "$AWS_REGION" --query Parameter.Value --output text 2>&1)"; then',
  '    case "$out" in *ParameterNotFound*) echo unfinished; return 0;; esac',
  '    echo "could not read $PROGRESS_PARAMETER: $out" >&2; return 1',
  "  fi",
  "  PROGRESS=\"$out\" node -e 'const steps = JSON.parse(process.env.PROGRESS).steps || {}; console.log(steps.e2e && steps.e2e.status === \"done\" ? \"finished\" : \"unfinished\")'",
  "}",
].join("\n");

/** The TypeScript build needs more than Node's default 2 GB heap; the LARGE build machine has 16 GB. */
export const CLOUD_PIPELINE_NODE_OPTIONS = "--max-old-space-size=8192";
const BUILD_CHECKOUT = ["npm ci", "npm run build", 'test -z "$(git status --porcelain)" || { git status --porcelain >&2; echo "the build changed tracked files" >&2; exit 1; }'];

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
    // The person who finishes the install on the setup page: the identity stack's first admin. Their temporary password and
    // the page's address are emailed here, and the environment's alerts go here until changed (as with the installer).
    const setupEmail = new CfnParameter(this, "SetupEmail", {
      type: "String",
      allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
      constraintDescription: "an email address",
      description: `Email of the person who finishes the ${env} install on the setup page (its first Rovara staff admin; the setup link, the temporary password and alerts go here)`,
    });

    // The hosted setup page, shared with the Launch in AWS installer.
    const setup = setupPage(this, {
      installName: env,
      apiName: `${RESOURCE_PREFIX}-${env}-setup`,
      keyDescription: `Rovara Cloud ${env}: the setup page's table and the admin's sign-in hand-off`,
    });

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
            NODE_OPTIONS: CLOUD_PIPELINE_NODE_OPTIONS,
            ROVARA_ENV: env,
            SETTINGS_PARAMETER: `${settingsPrefix}settings`,
            PROGRESS_PARAMETER: `${settingsPrefix}install/progress`,
            SETUP_EMAIL: setupEmail.valueAsString,
            SETUP_URL: setup.url,
            GITHUB_ACCOUNT: CLOUD_PIPELINE_GITHUB_ACCOUNT,
            PLACEHOLDER_CHANNEL: CLOUD_PIPELINE_PLACEHOLDER_CHANNEL,
          },
        },
        phases: {
          install: { commands: INSTALL_TOOLS },
          pre_build: { commands: [...FIND_RELEASE_TAG, ...BUILD_CHECKOUT] },
          build: {
            commands: [
              'cli() { node packages/cli/dist/bin.js --env "$ROVARA_ENV" "$@"; }',
              'images=(--worker-image "$WORKER_IMAGE" --boot-stage2-sha256 "$BOOT_STAGE2_SHA256" --slack-image "$SLACK_IMAGE")',
              SETUP_STATE,
              [
                'if aws ssm get-parameter --name "$SETTINGS_PARAMETER" --region "$AWS_REGION" >/dev/null 2>&1; then',
                // An upgrade over an unfinished setup would drop the setup page's sign-in from the identity stack, and the
                // setup can only be resumed by the release that started it.
                '  state="$(setup_state)" || exit 1',
                '  if [ "$state" != finished ]; then',
                '    echo "$ROVARA_ENV is installed but its setup is not finished; finish it on $SETUP_URL (retry the Setup stage of the release that installed it), then retry this stage" >&2',
                "    exit 1",
                "  fi",
                '  echo "$ROVARA_ENV is installed: upgrading to $RELEASE_TAG"',
                '  cli upgrade --region "$AWS_REGION" --source "$PWD" "${images[@]}" --yes',
                "else",
                '  echo "$ROVARA_ENV is not installed: installing $RELEASE_TAG (every stack; the Setup stage finishes the rest on $SETUP_URL)"',
                '  cli init --region "$AWS_REGION" --engine cdk --source "$PWD" --rovara-cloud --yes --no-browser --no-ui "${images[@]}" \\',
                '    --github-account "$GITHUB_ACCOUNT" --github-account-type organization --admin-email "$SETUP_EMAIL" \\',
                '    --channel "$PLACEHOLDER_CHANNEL" --connectors none --setup-page-url "$SETUP_URL" --stop-after slack-service',
                "fi",
              ].join("\n"),
            ],
          },
        },
      }),
    });
    deploy.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"));

    const finishSetup = new codebuild.PipelineProject(this, "Setup", {
      projectName: `${RESOURCE_PREFIX}-${env}-setup`,
      description: `Finishes the ${env} Rovara Cloud install on its setup page (rovara init --setup-table); does nothing once it is finished`,
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE },
      concurrentBuildLimit: 1,
      // It waits for the person on the setup page; the CLI resumes where a cut-off run stopped.
      timeout: CLOUD_SETUP_TIMEOUT,
      logging: { cloudWatch: { logGroup, prefix: "setup" } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        env: {
          shell: "bash",
          "git-credential-helper": "yes",
          variables: {
            AWS_CLI_VERSION: CLOUD_PIPELINE_AWS_CLI_VERSION,
            NODE_OPTIONS: CLOUD_PIPELINE_NODE_OPTIONS,
            ROVARA_ENV: env,
            PROGRESS_PARAMETER: `${settingsPrefix}install/progress`,
            SETUP_TABLE: setup.table.tableName,
            SETUP_URL: setup.url,
          },
        },
        phases: {
          install: { commands: INSTALL_TOOLS },
          pre_build: { commands: FIND_RELEASE_TAG },
          build: {
            commands: [
              SETUP_STATE,
              [
                'state="$(setup_state)" || exit 1',
                'if [ "$state" = finished ]; then',
                '  echo "$ROVARA_ENV is set up: nothing to do"',
                "else",
                // A multi-line command goes on after a failed line, so each line stops the job itself.
                ...BUILD_CHECKOUT.map((command) => `  ${command.startsWith("npm ") ? `${command} || exit 1` : command}`),
                '  echo "Finishing $ROVARA_ENV on its setup page: $SETUP_URL (the sign-in is emailed to the setup email)"',
                '  node packages/cli/dist/bin.js --env "$ROVARA_ENV" init --region "$AWS_REGION" --engine cdk --source "$PWD" --rovara-cloud --resume \\',
                '    --worker-image "$WORKER_IMAGE" --boot-stage2-sha256 "$BOOT_STAGE2_SHA256" --slack-image "$SLACK_IMAGE" \\',
                '    --setup-table "$SETUP_TABLE" --setup-url "$SETUP_URL" --connectors none',
                // A run that ends waiting on someone (a Slack admin, the alert subscription) is not finished: retry the stage.
                '  state="$(setup_state)" || exit 1',
                '  if [ "$state" != finished ]; then echo "$ROVARA_ENV is not set up yet; retry this stage to continue on $SETUP_URL" >&2; exit 1; fi',
                "fi",
              ].join("\n"),
            ],
          },
        },
      }),
    });
    finishSetup.role?.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AdministratorAccess"));
    setup.table.grantReadWriteData(finishSetup);

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
        {
          stageName: "Setup",
          actions: [new actions.CodeBuildAction({
            actionName: "FinishSetup",
            project: finishSetup,
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

    new CfnOutput(this, "SetupPageUrl", {
      value: setup.url,
      description: "Open this when the email with the temporary password arrives, after the first release deploys",
    });
  }
}
