import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_codebuild as codebuild,
  aws_iam as iam,
  aws_logs as logs,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { RESOURCE_PREFIX, environmentSettingsPrefix } from "@agentx/contracts";
import {
  CDK_BOOTSTRAP_ASSUMED_ROLES,
  CDK_BOOTSTRAP_QUALIFIER,
  CLOUD_BETA_RELEASE_ROLE_NAME,
  CLOUD_STATE_ARTIFACT_PREFIXES,
  CLOUD_RELEASE_PROJECT_PREFIX,
  BETA_GATEWAY_IMAGES_PREFIX,
  PRICE_FETCH_TASK_FAMILY,
  PULL_BETA_IMAGE_ACTIONS,
  RELEASE_ACTIONS_PART,
  RELEASE_IMAGE_REPOSITORY_ACTIONS,
  applyCloudBoundary,
  artifactKeyPattern,
  cloudPartRolePath,
  keepRoleAtRoot,
  releaseActionsDenies,
} from "./cloud-boundary.js";

/**
 * The private half of the single release pipeline (BETA-CLOUD-PLAN 1.1 option A, lane L1b): the CodeBuild projects that run the Cloud stage CLI
 * (`node ops/pipeline/stage.ts <env> <step>`, ops/pipeline/), their roles and the permissions boundary of those roles. The public pipeline
 * (Rovara Code's AgentXProductionRelease) holds no Cloud logic: it names these projects through two parameters and starts them, once per step.
 *
 * ONE project per environment, the step arriving as STAGE_STEP on each action (L2-STAGE-CLI-INTERFACE.md section 7). The names below are the contract with the
 * public pipeline: they start with `release-` (its parameter pattern; the legacy runtime boundary denies every CodeBuild action on `project/release-*`) and equal
 * the defaults it ships with. A project accepts only its own environment's steps. Roles, per environment:
 *  - beta: a role with the FIXED name the beta release role trusts (BETA-RELEASE-ROLE-PREP.md 2.1 and 2.5). It may assume that one role in the beta account and nothing
 *    else: every beta write (ECR, the price fetch, SSM, the CDK bootstrap roles) happens as the beta release role.
 *  - production: the account's own bootstrap roles (cdk deploy and every CloudFormation call go through them), the gateway image repository, the price fetch task, the
 *    release records under /rovara-cloud/<env>/release/, and the one cross-account grant: read-only pull of beta's gateway image repository, with its OWN credentials, which
 *    works only because a repository policy in beta names this role (betaGatewayPullPolicy; a hand step in beta, not part of this stack). It assumes nothing in beta.
 * Both trust only codebuild.amazonaws.com, for exactly their own project and this account (confused deputy); both carry the stack's boundary (cloud-boundary.ts, part
 * "release-actions") and an explicit Deny on the organization's management-account Administrator role. Deployed once by hand, by change set, before the public
 * pipeline is redeployed (CodePipeline refuses an action whose project does not exist). The stack never deploys itself.
 *
 * NO ACCOUNT ID IS COMMITTED: the beta account and the production account arrive as the stack's parameters (or the stack's own account) and reach the stage CLI as
 * ROVARA_EXPECTED_DEPLOY_ACCOUNT, which the CLI compares with what STS says (ops/pipeline/lib/account.ts).
 */
export const CLOUD_RELEASE_ACTIONS_CONTEXT_KEY = "rovaraCloudReleaseActions";
export const CLOUD_RELEASE_ACTIONS_STACK_NAME = `${RESOURCE_PREFIX}-release-actions`;

export type ReleaseActionEnvironment = "beta" | "production";
export const CLOUD_RELEASE_ACTION_ENVIRONMENTS: readonly ReleaseActionEnvironment[] = ["beta", "production"];
/** The project names the public pipeline imports (its CloudBetaProjectName and CloudProductionProjectName parameters). */
export const CLOUD_RELEASE_PROJECT_NAMES: Readonly<Record<ReleaseActionEnvironment, string>> = Object.freeze({
  beta: `${CLOUD_RELEASE_PROJECT_PREFIX}beta`,
  production: `${CLOUD_RELEASE_PROJECT_PREFIX}production`,
});
/**
 * The build roles. The beta one is named in the beta release role's trust (its PrimaryBuildRoleArn): a name, no path, so that trust's ArnEquals matches. Both are fixed
 * names for the same reason: a new name needs a trust change in beta.
 */
export const CLOUD_RELEASE_BUILD_ROLE_NAMES: Readonly<Record<ReleaseActionEnvironment, string>> = Object.freeze({
  beta: `${RESOURCE_PREFIX}-release-beta-build`,
  production: `${RESOURCE_PREFIX}-release-production-build`,
});
/** The steps a project runs (the stage CLI's run steps, in pipeline order); anything else in STAGE_STEP is refused before the CLI starts. */
export const CLOUD_RELEASE_STEPS = ["preflight", "image", "gateway", "gateway-check", "web-app", "proof"] as const;
/** What the stage CLI's preflight writes to out/exports.env and the project exports to the pipeline (the public Code actions read CODE_RELEASE_EFFECTIVE). */
export const CLOUD_RELEASE_EXPORTED_VARIABLES = ["CLOUD_TAG", "CLOUD_SHA", "CLOUD_MODE", "CODE_RELEASE_EFFECTIVE", "CODE_PINNED_SHA", "SUMMARY_LINE"] as const;
/**
 * The public pipeline gives every Cloud action the Code source as a secondary input named `Source` (a full clone; its Code `sourceOutput` artifact), next to the previous
 * action's state. CodeBuild puts it at $CODEBUILD_SRC_DIR_Source. The build exports that directory as ROVARA_CODE_REPO, which the stage CLI's Code-side checks read (the deployed-drift gate,
 * the gateway run-price gate, the rollback `code` floors). The steps that run those checks refuse to start without it.
 */
export const CLOUD_RELEASE_CODE_CLONE_ARTIFACT = "Source";
export const CLOUD_RELEASE_CODE_CLONE_STEPS = ["preflight", "gateway-check"] as const;
/** The AWS profile of the beta release role (BETA-RELEASE-ROLE-PREP.md 2.4; ops/pipeline/config.json environments.beta.profile) and its fixed session name. */
export const CLOUD_BETA_PROFILE = "rovara-cloud-beta";
export const CLOUD_BETA_SESSION_NAME = "rovara-cloud-beta-release";
/** The stack outputs, by name (the hand deploy reads them; a test pins them). */
export const CLOUD_RELEASE_ACTIONS_OUTPUTS = { betaProject: "BetaProjectName", productionProject: "ProductionProjectName", betaRole: "BetaBuildRoleArn", productionRole: "ProductionBuildRoleArn" } as const;
export const CLOUD_RELEASE_NODE_OPTIONS = "--max-old-space-size=8192";

/** Pinned tools, installed with a checksum. Node is the repository's own `.node-version`; the AWS CLI and gitleaks are Rovara Code's release pipeline's versions; crane is L6's image promotion. */
export const RELEASE_ACTION_TOOL_VARIABLES = {
  AWS_CLI_VERSION: "2.36.47",
  // sha256 of the exact awscli-exe-linux-aarch64-2.36.47.zip (computed from the published download; a new version needs a new hash)
  AWS_CLI_SHA256: "118ef53b6f5c652471fd299af01c058901c1a53db69c6b71a7bf3ebd93590969",
  GITLEAKS_VERSION: "8.30.1",
  GITLEAKS_SHA256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  CRANE_VERSION: "0.20.6",
  CRANE_SHA256: "fc0515857bc38e4ddd2d37a5ab03fb5959449c7b2d4ad759bcc1174ac0cad91b",
} as const;

/** Node (checksum from the release's own SHASUMS256.txt), the AWS CLI, gitleaks and crane for arm64, under /opt. Docker comes with the privileged build image. */
export const RELEASE_ACTION_TOOL_COMMANDS: readonly string[] = [
  'node_version="$(cat .node-version)"',
  'node_archive="node-v${node_version}-linux-arm64.tar.xz"',
  'curl -fsSL -o "/tmp/${node_archive}" "https://nodejs.org/dist/v${node_version}/${node_archive}"',
  'curl -fsSL "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" | grep " ${node_archive}$" | (cd /tmp && sha256sum -c -)',
  'mkdir -p /opt/node && tar -xJf "/tmp/${node_archive}" -C /opt/node --strip-components=1',
  'curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_VERSION}.zip"',
  'echo "${AWS_CLI_SHA256}  /tmp/awscliv2.zip" | sha256sum -c -',
  "unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --install-dir /opt/aws-cli --bin-dir /opt/aws-cli/bin",
  'curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz"',
  'echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tar.gz" | sha256sum -c -',
  "mkdir -p /opt/gitleaks && tar -xzf /tmp/gitleaks.tar.gz -C /opt/gitleaks gitleaks",
  'curl -fsSL -o /tmp/crane.tar.gz "https://github.com/google/go-containerregistry/releases/download/v${CRANE_VERSION}/go-containerregistry_Linux_arm64.tar.gz"',
  'echo "${CRANE_SHA256}  /tmp/crane.tar.gz" | sha256sum -c -',
  "mkdir -p /opt/crane && tar -xzf /tmp/crane.tar.gz -C /opt/crane crane",
  'export PATH="/opt/node/bin:/opt/aws-cli/bin:/opt/gitleaks:/opt/crane:$PATH"',
  "node --version && npm --version && aws --version && gitleaks version && crane version && docker buildx version",
];
/**
 * The beta project only: the beta release role's profile (BETA-RELEASE-ROLE-PREP.md 2.4). The build's own credentials come from CodeBuild's container endpoint, and the role is
 * assumed with the fixed session name. The production project has no such profile: it assumes nothing in beta.
 */
export const RELEASE_ACTION_BETA_PROFILE_COMMANDS: readonly string[] = [
  'mkdir -p "$HOME/.aws"',
  `printf '[profile ${CLOUD_BETA_PROFILE}]\\nrole_arn = %s\\ncredential_source = EcsContainer\\nrole_session_name = ${CLOUD_BETA_SESSION_NAME}\\nregion = %s\\n' "$BETA_RELEASE_ROLE_ARN" "$AWS_REGION" > "$HOME/.aws/config"`,
];
export const releaseActionInstallCommands = (environment: ReleaseActionEnvironment): string[] => [...RELEASE_ACTION_TOOL_COMMANDS, ...(environment === "beta" ? RELEASE_ACTION_BETA_PROFILE_COMMANDS : [])];

/**
 * The repository policy beta's gateway image repository needs so the production build role can pull from it (controller decision 2026-11-24, instead of widening the beta release
 * role's trust). It lives on the beta side and is applied by hand once, after this stack exists (the policy names the role, which must exist first, and is bound to the role's id:
 * if the role is ever deleted and recreated the policy must be set again):
 *   aws ecr set-repository-policy --repository-name <beta gateway repository> --policy-text file://policy.json   (read-only: the same four actions as the production role's own grant)
 * `productionBuildRoleArn` is this stack's ProductionBuildRoleArn output; nothing here holds an account id.
 */
export function betaGatewayPullPolicy(productionBuildRoleArn: string): { Version: string; Statement: Array<Record<string, unknown>> } {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "ProductionReleasePull", Effect: "Allow", Principal: { AWS: productionBuildRoleArn }, Action: [...PULL_BETA_IMAGE_ACTIONS] }],
  };
}

/**
 * The build commands. No Cloud logic: the stage CLI does everything. Around it: the environment and the step are checked (a project runs only its own environment, so a
 * misconfigured action cannot run a production step with beta's credentials or the reverse); the previous action's `PipelineState` directory is found from the artifact's
 * NAME (CodeBuild puts a secondary input at $CODEBUILD_SRC_DIR_<name>, and every action's output has a name of its own; L1's PIPELINE_STATE_ARTIFACT); the Production Preflight
 * first prints beta's promotion summary so the approver reads Code and Cloud together; and the preflight's exports file must exist, because the public Code actions read
 * CODE_RELEASE_EFFECTIVE from it and a missing one must fail here, never be read as `run`.
 */
export function releaseActionBuildCommands(environment: ReleaseActionEnvironment): string[] {
  return [
    ': "${STAGE_STEP:?STAGE_STEP is not set: the action says which step to run}"',
    `[ "$STAGE_ENV" = ${environment} ] || { echo "this project runs ${environment} steps only; STAGE_ENV is '$STAGE_ENV'" >&2; exit 1; }`,
    `case "$STAGE_STEP" in ${CLOUD_RELEASE_STEPS.join("|")}) ;; *) echo "unknown STAGE_STEP '$STAGE_STEP'" >&2; exit 1;; esac`,
    'if [ -n "${PIPELINE_STATE_ARTIFACT:-}" ]; then case "$PIPELINE_STATE_ARTIFACT" in *[!A-Za-z0-9_]*) echo "PIPELINE_STATE_ARTIFACT is not an artifact name" >&2; exit 1;; esac; state_ref="CODEBUILD_SRC_DIR_${PIPELINE_STATE_ARTIFACT}"; state_dir="${!state_ref:-}"; if [ ! -f "$state_dir/manifest.json" ]; then echo "no manifest.json in the previous action output $PIPELINE_STATE_ARTIFACT" >&2; exit 1; fi; export PIPELINE_MANIFEST="$state_dir/manifest.json"; fi',
    // The Code clone input (a constant artifact name, so a plain indirect expansion; no eval). Whatever ROVARA_CODE_REPO the environment held is dropped first: only the input counts.
    `unset ROVARA_CODE_REPO; code_ref="CODEBUILD_SRC_DIR_${CLOUD_RELEASE_CODE_CLONE_ARTIFACT}"; code_dir="\${!code_ref:-}"; if [ -n "$code_dir" ] && [ -d "$code_dir" ]; then export ROVARA_CODE_REPO="$code_dir"; fi`,
    `case "$STAGE_STEP" in ${CLOUD_RELEASE_CODE_CLONE_STEPS.join("|")}) [ -n "\${ROVARA_CODE_REPO:-}" ] || { echo "no Code clone: the ${CLOUD_RELEASE_CODE_CLONE_ARTIFACT} input directory is missing, and the $STAGE_STEP step checks Code" >&2; exit 1; };; esac`,
    ...(environment === "production" ? ['if [ "$STAGE_STEP" = preflight ]; then node ops/pipeline/stage.ts beta summary; fi'] : []),
    ...CLOUD_RELEASE_EXPORTED_VARIABLES.map((name) => `export ${name}=""`),
    'node ops/pipeline/stage.ts "$STAGE_ENV" "$STAGE_STEP"',
    'if [ "$STAGE_STEP" = preflight ] && [ ! -f out/exports.env ]; then echo "the preflight wrote no out/exports.env" >&2; exit 1; fi',
    'if [ -f out/exports.env ]; then . out/exports.env; fi',
  ];
}

/** The project's buildspec: the install, the commands above, the exports and the `PipelineState` artifact (the whole out/ directory). */
export function releaseActionBuildSpec(environment: ReleaseActionEnvironment): codebuild.BuildSpec {
  return codebuild.BuildSpec.fromObject({
    version: "0.2",
    env: {
      shell: "bash",
      "git-credential-helper": "yes",
      variables: { ...RELEASE_ACTION_TOOL_VARIABLES },
      "exported-variables": [...CLOUD_RELEASE_EXPORTED_VARIABLES],
    },
    phases: {
      install: { commands: releaseActionInstallCommands(environment) },
      build: { commands: releaseActionBuildCommands(environment) },
    },
    artifacts: { files: ["**/*"], "base-directory": "out" },
  });
}

export interface CloudReleaseActionsProps extends StackProps {
  /**
   * The environment this stack's own account runs (production): its role path, its gateway repository, cluster and price fetch roles, and its release records are
   * named by it. The beta account is a parameter.
   */
  readonly environmentName: string;
}

export class CloudReleaseActionsStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudReleaseActionsProps) {
    super(scope, id, props);
    const env = props.environmentName;
    // Validates the name (at most 14 characters, the environment-name rules) at synth.
    const settingsPrefix = environmentSettingsPrefix(env);
    const named = (which: string): string => `${RESOURCE_PREFIX}-${env}-${which}`;

    const connectionPattern = "^arn:aws(-[a-z]+)?:(codeconnections|codestar-connections):[a-z0-9-]+:[0-9]{12}:connection/[0-9a-f-]{36}$";
    const codeConnection = new CfnParameter(this, "GitHubConnectionArn", {
      type: "String",
      allowedPattern: connectionPattern,
      description: "The GitHub connection of the pipeline's Code source (the builds clone Code through it); the same value as the public pipeline's parameter",
    });
    const cloudConnection = new CfnParameter(this, "CloudConnectionArn", {
      type: "String",
      allowedPattern: connectionPattern,
      description: "The GitHub connection of the pipeline's Cloud source (the builds clone Cloud through it); the same value as the public pipeline's parameter",
    });
    const artifactBucket = new CfnParameter(this, "ArtifactBucketName", {
      type: "String",
      allowedPattern: "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      description: "The public pipeline's artifact bucket (its ArtifactBucketName output): CodePipeline hands every artifact to the builds through it",
    });
    const betaAccount = new CfnParameter(this, "BetaAccountId", {
      type: "String",
      allowedPattern: "^[0-9]{12}$",
      description: "The AWS account of the beta environment: the beta build assumes its release role and expects this account; the production build pulls beta's gateway image from it",
    });
    const rolePattern = `^arn:aws(-[a-z]+)?:iam::[0-9]{12}:role${cloudPartRolePath(env, "gateway")}[A-Za-z0-9+=,.@_-]{1,64}$`;
    const priceTaskRole = new CfnParameter(this, "ProductionPriceFetchTaskRoleArn", {
      type: "String",
      allowedPattern: rolePattern,
      description: `The gateway's price fetch task role in this account (a role under ${cloudPartRolePath(env, "gateway")}): the only task role the production build may pass to ECS`,
    });
    const priceExecutionRole = new CfnParameter(this, "ProductionPriceFetchExecutionRoleArn", {
      type: "String",
      allowedPattern: rolePattern,
      description: `The gateway's price fetch task execution role in this account (a role under ${cloudPartRolePath(env, "gateway")}): the only execution role the production build may pass to ECS`,
    });

    const betaReleaseRoleArn = `arn:${this.partition}:iam::${betaAccount.valueAsString}:role/${CLOUD_BETA_RELEASE_ROLE_NAME}`;
    const projectArn = (environment: ReleaseActionEnvironment): string => `arn:${this.partition}:codebuild:${this.region}:${this.account}:project/${CLOUD_RELEASE_PROJECT_NAMES[environment]}`;

    const logGroup = new logs.LogGroup(this, "BuildLogs", { retention: logs.RetentionDays.THREE_MONTHS, removalPolicy: RemovalPolicy.RETAIN });

    const clusterPattern = `arn:${this.partition}:ecs:${this.region}:${this.account}:cluster/${named("gateway")}-*`;
    const scopedRole = (environment: ReleaseActionEnvironment): iam.Role => {
      const role = new iam.Role(this, `${environment === "beta" ? "Beta" : "Production"}BuildRole`, {
        roleName: CLOUD_RELEASE_BUILD_ROLE_NAMES[environment],
        description: `Runs the ${environment} Cloud release steps (CodeBuild project ${CLOUD_RELEASE_PROJECT_NAMES[environment]}) and nothing else`,
        // Only this project, only in this account: another project, or another account's CodeBuild, cannot use the role (the confused deputy protection that matters).
        assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com", {
          conditions: { StringEquals: { "aws:SourceAccount": this.account, "aws:SourceArn": projectArn(environment) } },
        }),
      });
      // What both builds do: read the two sources through their connections, and the previous state from (and write the new state to) the pipeline's artifact bucket.
      role.addToPolicy(new iam.PolicyStatement({
        sid: "PipelineSource",
        actions: ["codeconnections:UseConnection", "codeconnections:GetConnectionToken", "codestar-connections:UseConnection", "codestar-connections:GetConnectionToken"],
        resources: [codeConnection.valueAsString, cloudConnection.valueAsString],
      }));
      role.addToPolicy(new iam.PolicyStatement({
        sid: "PipelineArtifacts",
        actions: ["s3:GetObject", "s3:GetObjectVersion", "s3:GetBucketAcl", "s3:GetBucketLocation"],
        resources: [`arn:${this.partition}:s3:::${artifactBucket.valueAsString}`, `arn:${this.partition}:s3:::${artifactBucket.valueAsString}/*`],
      }));
      // Writes: this environment's own state artifacts and nothing else (PH-S3-PREFIXES). The bucket is not versioned, and the Source and CloudSource artifacts this build is handed are the
      // ones the Production stage reads later: a beta build must not be able to overwrite them, nor the other environment's state, nor a Code release manifest. The explicit Deny holds even
      // if a later change widens the Allow (NotResource: every object but the role's own prefix, so a new artifact is refused by default).
      const ownState = artifactKeyPattern(`arn:${this.partition}:s3:::${artifactBucket.valueAsString}`, CLOUD_STATE_ARTIFACT_PREFIXES[environment]);
      role.addToPolicy(new iam.PolicyStatement({ sid: "PipelineStateWrites", actions: ["s3:PutObject", "s3:AbortMultipartUpload"], resources: [ownState] }));
      role.addToPolicy(new iam.PolicyStatement({
        sid: "DenyArtifactWritesOutsideOwnState", effect: iam.Effect.DENY, actions: ["s3:PutObject*", "s3:DeleteObject*", "s3:AbortMultipartUpload"], notResources: [ownState],
      }));
      // The management account's Administrator path: no role of this stack may take it, whatever else is ever granted (BETA-RELEASE-ROLE-PREP.md 2.5).
      role.addToPolicy(new iam.PolicyStatement({
        sid: "DenyOrganizationAdminRole", effect: iam.Effect.DENY, actions: ["sts:AssumeRole"], resources: ["arn:aws:iam::*:role/OrganizationAccountAccessRole"],
      }));
      keepRoleAtRoot(role);
      return role;
    };

    // Beta: assume the beta release role, nothing else. Everything the beta steps do in beta happens as that role.
    const betaRole = scopedRole("beta");
    betaRole.addToPolicy(new iam.PolicyStatement({ sid: "AssumeBetaReleaseRole", actions: ["sts:AssumeRole"], resources: [betaReleaseRoleArn] }));

    // Production: this account's own bootstrap roles, gateway image repository, price fetch, release records and certificate reads; plus beta's gateway image repository (read only).
    const productionRole = scopedRole("production");
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "AssumeBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: CDK_BOOTSTRAP_ASSUMED_ROLES.map((role) => `arn:${this.partition}:iam::${this.account}:role/cdk-${CDK_BOOTSTRAP_QUALIFIER}-${role}-${this.account}-${this.region}`),
    }));
    // Beta's gateway image, read-only, with this role's own credentials (a repository policy in beta names this role: betaGatewayPullPolicy). No role in beta is assumed.
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PullBetaImage",
      actions: [...PULL_BETA_IMAGE_ACTIONS],
      resources: [`arn:${this.partition}:ecr:${this.region}:${betaAccount.valueAsString}:repository/${BETA_GATEWAY_IMAGES_PREFIX}*`],
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({ sid: "ImageToken", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ImageRepository",
      actions: [...RELEASE_IMAGE_REPOSITORY_ACTIONS],
      resources: [`arn:${this.partition}:ecr:${this.region}:${this.account}:repository/${named("gateway-images")}-*`],
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PriceFetchRun",
      actions: ["ecs:RunTask"],
      resources: [`arn:${this.partition}:ecs:${this.region}:${this.account}:task-definition/${PRICE_FETCH_TASK_FAMILY}*:*`],
      conditions: { ArnLike: { "ecs:cluster": clusterPattern } },
    }));
    // Exactly the schedule's two roles: RunTask can override a task's role, so a path would let the build run the price fetch image as the serving role.
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PriceFetchPassRoles",
      actions: ["iam:PassRole"],
      resources: [priceTaskRole.valueAsString, priceExecutionRole.valueAsString],
      conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PriceFetchReads",
      actions: ["ecs:DescribeTasks", "ecs:ListTasks", "ecs:DescribeServices", "ecs:ListServices"],
      resources: ["*"],
      conditions: { ArnLike: { "ecs:cluster": clusterPattern } },
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({ sid: "TaskDefinitionRead", actions: ["ecs:DescribeTaskDefinition"], resources: ["*"] }));
    productionRole.addToPolicy(new iam.PolicyStatement({ sid: "PriceScheduleRead", actions: ["events:ListTargetsByRule"], resources: [`arn:${this.partition}:events:${this.region}:${this.account}:rule/*`] }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "PriceFetchLogs",
      actions: ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
      resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:${named("gateway")}-PriceFetchLogs*`],
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReleaseRecords",
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${settingsPrefix}release/*`],
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReleaseChecksRead",
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${settingsPrefix}release-checks/*`],
    }));
    productionRole.addToPolicy(new iam.PolicyStatement({ sid: "CertificateRead", actions: ["acm:DescribeCertificate"], resources: [`arn:${this.partition}:acm:${this.region}:${this.account}:certificate/*`] }));
    // The same Deny as the boundary's (and the beta release role's): no interactive shell into a task.
    const noExec = releaseActionsDenies().find((deny) => deny.Sid === "DenyExecIntoTasks");
    productionRole.addToPolicy(new iam.PolicyStatement({
      sid: noExec!.Sid, effect: iam.Effect.DENY, actions: noExec!.Action, resources: noExec!.Resource, conditions: noExec!.Condition!,
    }));

    const projects = CLOUD_RELEASE_ACTION_ENVIRONMENTS.map((environment) => {
      const role = environment === "beta" ? betaRole : productionRole;
      const environmentVariables: Record<string, codebuild.BuildEnvironmentVariable> = {
        STAGE_ENV: { value: environment },
        NODE_OPTIONS: { value: CLOUD_RELEASE_NODE_OPTIONS },
        // Beta: the beta release role's address, for the profile the install phase writes. Production: the beta account, to name beta's registry for the pull (never git).
        ...(environment === "beta" ? { BETA_RELEASE_ROLE_ARN: { value: betaReleaseRoleArn } } : { BETA_ACCOUNT_ID: { value: betaAccount.valueAsString } }),
        // The account this stage must run in, from outside git: the CLI compares it with what STS says and refuses on any difference (production: this stack's own account).
        ROVARA_EXPECTED_DEPLOY_ACCOUNT: { value: environment === "beta" ? betaAccount.valueAsString : this.account },
        ...(environment === "beta" ? { ROVARA_PIPELINE_PROFILE: { value: CLOUD_BETA_PROFILE } } : {}),
      };
      return new codebuild.PipelineProject(this, environment === "beta" ? "BetaProject" : "ProductionProject", {
        projectName: CLOUD_RELEASE_PROJECT_NAMES[environment],
        description: `Runs the Rovara Cloud ${environment} release steps: the stage CLI, one step per action`,
        role,
        // Docker (privileged) for the gateway image build (arm64, native), crane for its promotion, and enough memory for npm ci, tsc, the web build and cdk synth.
        environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true, environmentVariables },
        // The stage CLI changes stacks: never two steps of one environment at once.
        concurrentBuildLimit: 1,
        timeout: Duration.minutes(90),
        logging: { cloudWatch: { logGroup, prefix: environment } },
        buildSpec: releaseActionBuildSpec(environment),
      });
    });

    new CfnOutput(this, CLOUD_RELEASE_ACTIONS_OUTPUTS.betaProject, { value: projects[0]!.projectName, description: "The Beta stage's Cloud project: the public pipeline's CloudBetaProjectName" });
    new CfnOutput(this, CLOUD_RELEASE_ACTIONS_OUTPUTS.productionProject, { value: projects[1]!.projectName, description: "The Production stage's Cloud project: the public pipeline's CloudProductionProjectName" });
    new CfnOutput(this, CLOUD_RELEASE_ACTIONS_OUTPUTS.betaRole, { value: betaRole.roleArn, description: "The beta build role: the beta release role's PrimaryBuildRoleArn" });
    new CfnOutput(this, CLOUD_RELEASE_ACTIONS_OUTPUTS.productionRole, { value: productionRole.roleArn, description: "The production build role: the principal of the repository policy on beta's gateway image repository (betaGatewayPullPolicy)" });

    // Last, so the template keeps its section order; the aspect puts it on every role at synth (cloud-boundary.ts).
    applyCloudBoundary(this, env, RELEASE_ACTIONS_PART, undefined, undefined, { artifactBucketName: artifactBucket.valueAsString, betaAccountId: betaAccount.valueAsString });
  }
}
