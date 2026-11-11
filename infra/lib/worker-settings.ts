import { Aws, CfnCondition, Fn, aws_iam as iam } from "aws-cdk-lib";
import { providerKeyParameters } from "./model-keys.js";
import { openRouterRoutingParameter } from "./openrouter.js";
import { CfnParameter, Stack, type StackProps, aws_ssm as ssm } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { BOOT_STAGE2_SHA256_PARAMETER, CATALOG_REGISTRY_ROOT, WORKER_SETTING_PARAMETERS } from "@rovara-code/contracts";
import { type AgentXNaming, legacyNaming } from "./naming.js";

export interface WorkerSettingsStackProps extends StackProps {
  naming?: AgentXNaming;
}

/**
 * What a release publishes for EC2 workers (#117): the worker image and model settings, as SSM
 * parameters the session provisioner reads when it boots a worker. This stack used to deploy the
 * retired runtime too; its stack and parameter names remain stable.
 */
export class WorkerSettingsStack extends Stack {
  constructor(scope: Construct, id: string, props: WorkerSettingsStackProps = {}) {
    super(scope, id, props);
    const naming = props.naming ?? legacyNaming();

    const imageUri = new CfnParameter(this, "WorkerImageUri", {
      type: "String",
      // A named environment derives the worker role's ECR access from this value, so it must be a private ECR digest
      // reference whose parts can be told apart; the legacy deployment's pattern is unchanged (ruling R58).
      allowedPattern: naming.env === undefined ? "^.+@sha256:[a-f0-9]{64}$" : WORKER_IMAGE_URI_PATTERN,
      description: "Immutable private ECR linux/arm64 worker image URI",
    });
    // Optional: a release before the web/API runtime has no executor, and an environment that never deploys one keeps "none".
    const executorImageUri = new CfnParameter(this, "ExecutorImageUri", {
      type: "String",
      default: "none",
      // A named environment derives the worker role's ECR access from this value too, so a value other than "none" must
      // be a private ECR digest reference; the legacy deployment's pattern is unchanged.
      allowedPattern: naming.env === undefined ? "^(none|.+@sha256:[a-f0-9]{64})$" : `^(none|${WORKER_IMAGE_URI_PATTERN.slice(1, -1)})$`,
      description: "Immutable private ECR linux/arm64 browser executor image URI, or none",
    });
    if (naming.env !== undefined) {
      this.grantImagePull("WorkerImagePull", "PullWorkerImage", "CachedWorkerImage", naming.env, naming.pullThroughPrefix, imageUri);
      // The workers boot-pull the executor image too (the web/API runtime): a named environment's role gets exactly that
      // image's repository as well, and only once a release sets one ("none" leaves the role with the worker image alone).
      this.grantImagePull("ExecutorImagePull", "PullExecutorImage", "CachedExecutorImage", naming.env, naming.pullThroughPrefix, executorImageUri,
        new CfnCondition(this, "HasExecutorImage", { expression: Fn.conditionNot(Fn.conditionEquals(executorImageUri.valueAsString, "none")) }));
    }
    // Test services (TS-IMG-1): the worker pulls the pinned catalog images from this environment's catalog repositories.
    if (naming.env !== undefined) this.grantCatalogPull(naming.env);
    const modelProvider = new CfnParameter(this, "ModelProvider", {
      type: "String",
      default: "amazon-bedrock",
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
    });
    // Task 4.10: the AI navigation model the installation chose, a setting beside the coding model (not a boot variable: the worker searches the eligible models for the revision
    // an admission names). `agentx config set models.e2eAgent` changes it; the broker reads it from SSM, the worker never does.
    const e2eAgentModelId = new CfnParameter(this, "E2eAgentModelId", {
      type: "String",
      default: "default",
      allowedPattern: "^(default|[A-Za-z0-9][A-Za-z0-9._:/-]{0,199})$",
      description: "AI navigation model for browser checks: default (Rovara's recommendation) or an eligible model id",
    });
    // MODEL3: the Bedrock model the coding worker runs on when its provider's key secret is missing. `none` (the default) means no fallback: the call fails by name. `agentx config set models.fallback` changes it.
    const modelFallback = new CfnParameter(this, "ModelFallback", {
      type: "String",
      default: "none",
      allowedPattern: "^(none|[A-Za-z0-9][A-Za-z0-9._:-]{0,79})$",
      description: "Bedrock model used when a provider key secret is missing: none, or a Bedrock model id",
    });
    const promptCacheRetention = new CfnParameter(this, "PromptCacheRetention", {
      type: "String",
      default: "long",
      allowedValues: ["short", "long"],
      description: "Bedrock prompt-cache retention mode used by pi",
    });

    new ssm.StringParameter(this, "WorkerImageParameter", {
      parameterName: naming.ec2.workerImageParameterName,
      stringValue: imageUri.valueAsString,
      description: "AgentX worker image URI pinned by digest, for EC2 workers",
    });
    // The secret ARN parameters stay declared in every environment, because the deployment passes them to this stack.
    const keys = providerKeyParameters(this);
    const providers = openRouterRoutingParameter(this);
    const hasProviders = new CfnCondition(this, "HasOpenRouterProviders", { expression: Fn.conditionNot(Fn.conditionEquals(providers.valueAsString, "")) });
    // A named environment's workers call models through the model proxy and hold no provider secret reference (Task 14),
    // so it publishes none; the legacy deployment's workers still read their provider keys themselves.
    const secretSettings: Array<[string, keyof typeof WORKER_SETTING_PARAMETERS, string]> = [];
    if (naming.env === undefined) {
      const hasSecret = new CfnCondition(this, "HasOpenRouterSecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.openrouter.valueAsString, "")) });
      const hasAnthropicSecret = new CfnCondition(this, "HasAnthropicSecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.anthropic.valueAsString, "")) });
      const hasOpenAISecret = new CfnCondition(this, "HasOpenAISecret", { expression: Fn.conditionNot(Fn.conditionEquals(keys.openai.valueAsString, "")) });
      secretSettings.push(
        ["WorkerOpenRouterSecretParameter", "openRouterSecretArn", Fn.conditionIf(hasSecret.logicalId, keys.openrouter.valueAsString, "none").toString()],
        ["WorkerAnthropicSecretParameter", "anthropicSecretArn", Fn.conditionIf(hasAnthropicSecret.logicalId, keys.anthropic.valueAsString, "none").toString()],
        ["WorkerOpenAISecretParameter", "openaiSecretArn", Fn.conditionIf(hasOpenAISecret.logicalId, keys.openai.valueAsString, "none").toString()],
      );
    }
    const workerSettings: Array<[string, keyof typeof WORKER_SETTING_PARAMETERS, string]> = [
      ...secretSettings,
      ["WorkerOpenRouterProvidersParameter", "openRouterProviders", Fn.conditionIf(hasProviders.logicalId, providers.valueAsString, "none").toString()],
      ["WorkerExecutorImageParameter", "executorImage", executorImageUri.valueAsString],
      ["WorkerModelProviderParameter", "modelProvider", modelProvider.valueAsString],
      ["WorkerModelIdParameter", "modelId", modelId.valueAsString],
      ["WorkerPromptCacheRetentionParameter", "promptCacheRetention", promptCacheRetention.valueAsString],
      ["WorkerE2eAgentModelParameter", "e2eAgentModel", e2eAgentModelId.valueAsString],
      ["WorkerModelFallbackParameter", "modelFallback", modelFallback.valueAsString],
    ];
    // Task 10 (named environments only; the legacy template is byte-identical): stage 2 of the boot ships in the worker image, and this is the
    // hash that checks it. It is one more setting of the same runtime stack deploy that sets the image, so the two travel together. "none"
    // (the default) is a release from before the boot split; the control plane then refuses to launch a worker and says to upgrade.
    if (naming.env !== undefined) {
      const bootStage2Sha256 = new CfnParameter(this, "BootStage2Sha256", {
        type: "String",
        default: "none",
        allowedPattern: "^(none|[a-f0-9]{64})$",
        description: "SHA-256 of the boot-stage2.sh in the release source the worker image was built from, or none",
      });
      new ssm.StringParameter(this, "WorkerBootStage2Sha256Parameter", {
        parameterName: `${naming.ec2.workerSettingsPrefix}${BOOT_STAGE2_SHA256_PARAMETER}`,
        stringValue: bootStage2Sha256.valueAsString,
        description: "AgentX worker boot stage 2 hash for EC2 workers",
      });
    }
    for (const [id, setting, value] of workerSettings) {
      new ssm.StringParameter(this, id, {
        parameterName: `${naming.ec2.workerSettingsPrefix}${WORKER_SETTING_PARAMETERS[setting]}`,
        stringValue: value,
        description: `AgentX worker ${setting} for EC2 workers`,
      });
    }
  }

  /**
   * Task 25 (R56): the worker role reads exactly the repository of the image this stack publishes, wherever it lives (a
   * pull-through release image, a hand-pushed one, an override), never repository/*. The repository, region and account
   * are cut out of the image URI in CloudFormation. Creating or importing a repository is allowed only for that same
   * repository and only under the environment's pull-through prefix: an Allow on the exact repository, and a Deny of
   * those two actions on everything outside the prefix (a CloudFormation condition cannot test a string cut from a
   * parameter, so IAM does the intersection). Called once for the worker image and once, under a condition, for the
   * executor image (public mainline's browser executor, which workers boot-pull).
   */
  private grantImagePull(policyId: string, sid: string, cacheSid: string, env: string, pullThroughPrefix: string, imageUri: CfnParameter, condition?: CfnCondition): void {
    // Declared once, by the first grant, and shared by the second.
    const roleArn = (this.node.tryFindChild("Ec2WorkerInstanceRoleArn") as CfnParameter | undefined) ?? new CfnParameter(this, "Ec2WorkerInstanceRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$",
      description: "The EC2 workers' instance role, which is allowed to pull the worker image",
    });
    // arn:<partition>:iam::<account>:role/agentx/<env>/<name>: the name is the fourth part, as the session lifecycle reads it.
    const roleName = Fn.select(3, Fn.split("/", roleArn.valueAsString));
    const imageName = Fn.select(0, Fn.split("@", imageUri.valueAsString));
    const afterEcr = Fn.select(1, Fn.split(".dkr.ecr.", imageName));
    const account = Fn.select(0, Fn.split(".dkr.ecr.", imageName));
    const region = Fn.select(0, Fn.split(".amazonaws.com/", afterEcr));
    const repository = Fn.select(1, Fn.split(".amazonaws.com/", afterEcr));
    const repositoryArn = `arn:${Aws.PARTITION}:ecr:${region}:${account}:repository/${repository}`;
    const policy = new iam.CfnPolicy(this, policyId, {
      policyName: `${policyId}-${env}`,
      roles: [roleName],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          { Sid: sid, Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: repositoryArn },
          { Sid: cacheSid, Effect: "Allow", Action: ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository"], Resource: repositoryArn },
          {
            Sid: "NoCacheOutsideThePrefix", Effect: "Deny", Action: ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository"],
            NotResource: `arn:${Aws.PARTITION}:ecr:*:${Aws.ACCOUNT_ID}:repository/${pullThroughPrefix}/*`,
          },
        ],
      },
    });
    if (condition !== undefined) policy.cfnOptions.condition = condition;
  }

  /**
   * Test services (TS-IMG-1, design test-services.md 2.5): the worker role pulls the pinned catalog images, by digest, from
   * `rovara-catalog/<env>/svc/*` in this account and region (the repositories the control plane creates for the catalog). Two read
   * actions named exactly, on this environment's `svc/` repositories only: no push, no repository creation, no other environment, no
   * wildcard action. The token (`ecr:GetAuthorizationToken`) is the worker role's existing grant. The repositories are KMS-encrypted,
   * but a pull needs no key permission (ECR uses its own grant). Unconditional like the repositories themselves (service-catalog-images.ts):
   * an empty repository is inert, and nothing starts a catalog image unless the `tx` switch is on and the catalog pins its digest.
   * A separate policy from the worker image's, whose test insists on a single exact repository per statement.
   */
  private grantCatalogPull(env: string): void {
    const roleArn = (this.node.tryFindChild("Ec2WorkerInstanceRoleArn") as CfnParameter | undefined) ?? new CfnParameter(this, "Ec2WorkerInstanceRoleArn", {
      type: "String",
      allowedPattern: "^arn:aws[a-z-]*:iam::[0-9]{12}:role/.+$",
      description: "The EC2 workers' instance role, which is allowed to pull the worker image",
    });
    new iam.CfnPolicy(this, "CatalogImagePull", {
      policyName: `CatalogImagePull-${env}`,
      roles: [Fn.select(3, Fn.split("/", roleArn.valueAsString))],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PullCatalogImages", Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
            Resource: `arn:${Aws.PARTITION}:ecr:${Aws.REGION}:${Aws.ACCOUNT_ID}:repository/${CATALOG_REGISTRY_ROOT}/${env}/svc/*`,
          },
        ],
      },
    });
  }
}

/** A private ECR image pinned by digest, with a lower-case repository name (one or more path parts). */
export const WORKER_IMAGE_URI_PATTERN = "^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]([a-z0-9._/-]*[a-z0-9])?@sha256:[a-f0-9]{64}$";
