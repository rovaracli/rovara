import { Aws, CfnCondition, Fn, aws_iam as iam } from "aws-cdk-lib";
import { providerKeyParameters } from "./model-keys.js";
import { openRouterRoutingParameter } from "./openrouter.js";
import { CfnParameter, Stack, type StackProps, aws_ssm as ssm } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { WORKER_SETTING_PARAMETERS } from "@agentx/contracts";
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
    if (naming.env !== undefined) this.grantWorkerImagePull(naming.env, naming.pullThroughPrefix, imageUri);
    const modelProvider = new CfnParameter(this, "ModelProvider", {
      type: "String",
      default: "amazon-bedrock",
      description: "pi model provider identifier",
    });
    const modelId = new CfnParameter(this, "ModelId", {
      type: "String",
      description: "pi model identifier available in the deployment region",
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
      ["WorkerModelProviderParameter", "modelProvider", modelProvider.valueAsString],
      ["WorkerModelIdParameter", "modelId", modelId.valueAsString],
      ["WorkerPromptCacheRetentionParameter", "promptCacheRetention", promptCacheRetention.valueAsString],
    ];
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
   * parameter, so IAM does the intersection).
   */
  private grantWorkerImagePull(env: string, pullThroughPrefix: string, imageUri: CfnParameter): void {
    const roleArn = new CfnParameter(this, "Ec2WorkerInstanceRoleArn", {
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
    new iam.CfnPolicy(this, "WorkerImagePull", {
      policyName: `WorkerImagePull-${env}`,
      roles: [roleName],
      policyDocument: {
        Version: "2012-10-17",
        Statement: [
          { Sid: "PullWorkerImage", Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: repositoryArn },
          { Sid: "CachedWorkerImage", Effect: "Allow", Action: ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository"], Resource: repositoryArn },
          {
            Sid: "NoCacheOutsideThePrefix", Effect: "Deny", Action: ["ecr:BatchImportUpstreamImage", "ecr:CreateRepository"],
            NotResource: `arn:${Aws.PARTITION}:ecr:*:${Aws.ACCOUNT_ID}:repository/${pullThroughPrefix}/*`,
          },
        ],
      },
    });
  }
}

/** A private ECR image pinned by digest, with a lower-case repository name (one or more path parts). */
export const WORKER_IMAGE_URI_PATTERN = "^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9]([a-z0-9._/-]*[a-z0-9])?@sha256:[a-f0-9]{64}$";
