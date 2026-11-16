import { App, Tags } from "aws-cdk-lib";
import { ENVIRONMENT_TAG_KEY, RESOURCE_PREFIX } from "@agentx/contracts";
import { CLOUD_PIPELINE_CONTEXT_KEY, CloudReleasePipelineStack } from "./cloud-release-pipeline.js";
import { CLOUD_APP_CONTEXT_KEY, CloudAppStack, cloudAppStackName } from "./cloud-app.js";
import { CloudWebStack, cloudWebStackName } from "./cloud-web.js";
import { MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, ModelGatewayImagesStack, ModelGatewayStack, modelGatewayImagesStackName, modelGatewayStackName } from "./model-gateway.js";

/**
 * Rovara Cloud's CDK app. What it makes is chosen by context:
 *  - `-c rovaraCloudApp=<environment>`: Rovara Cloud on an existing Rovara Code install: Cloud on CloudFront, Lambda and DynamoDB
 *    (cloud-web.ts), and its first address, which redirects there (cloud-app.ts, #11);
 *  - `-c rovaraCloudPipeline=<environment>`: the release pipeline that deploys those (cloud-release-pipeline.ts);
 *  - `-c rovaraModelGateway=<environment>`: the model gateway and its image repository (model-gateway.ts). The release pipeline
 *    never makes or deploys these.
 * `-c agentxRegion=<region>` picks the region (us-east-1 by default).
 */
export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context } });
  const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
  // Rovara Cloud on an existing Rovara Code install: its own stack only, so a Cloud release synthesizes and deploys
  // nothing of Code's.
  const cloudAppEnv = app.node.tryGetContext(CLOUD_APP_CONTEXT_KEY) as unknown;
  if (cloudAppEnv !== undefined) {
    if (typeof cloudAppEnv !== "string" || cloudAppEnv === "") throw new Error(`${CLOUD_APP_CONTEXT_KEY} must name the Rovara Cloud environment, for example production`);
    // Cloud, with no gap on a release (#11). cloud-app.ts keeps only Cloud's first address, which redirects here.
    const cloudWeb = new CloudWebStack(app, "RovaraCloudWeb", {
      description: `Rovara Cloud ${cloudAppEnv}: the web app on CloudFront and S3, Cloud's server on Lambda, its state in DynamoDB`,
      stackName: cloudWebStackName(cloudAppEnv),
      env: { region: deploymentRegion ?? "us-east-1" },
      environmentName: cloudAppEnv,
      ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_PRODUCT_CONTEXT_KEY), MODEL_GATEWAY_PRODUCT_CONTEXT_KEY) ? { productAi: true } : {}),
    });
    Tags.of(cloudWeb).add(ENVIRONMENT_TAG_KEY, cloudAppEnv);
    const cloudApp = new CloudAppStack(app, "RovaraCloudApp", {
      description: `Rovara Cloud ${cloudAppEnv}: its first address, which sends people to its current one`,
      stackName: cloudAppStackName(cloudAppEnv),
      env: { region: deploymentRegion ?? "us-east-1" },
      environmentName: cloudAppEnv,
      // Its first address only redirects now (#11): every request goes to the same path at Cloud's address.
      movedTo: cloudWeb.origin,
    });
    Tags.of(cloudApp).add(ENVIRONMENT_TAG_KEY, cloudAppEnv);
    // Said outright, not only through the references: the new address and its table exist before the Fargate app copies to them and
    // sends people there.
    cloudApp.addStackDependency(cloudWeb, "its first address sends people to the web stack's address");
    return app;
  }
  // The Rovara Cloud release pipeline: deployed once by hand, then every vX.Y.Z tag deploys that Cloud through it.
  const cloudPipelineEnv = app.node.tryGetContext(CLOUD_PIPELINE_CONTEXT_KEY) as unknown;
  if (cloudPipelineEnv !== undefined) {
    if (typeof cloudPipelineEnv !== "string" || cloudPipelineEnv === "") throw new Error(`${CLOUD_PIPELINE_CONTEXT_KEY} must name the environment the pipeline deploys, for example production`);
    new CloudReleasePipelineStack(app, "RovaraCloudPipeline", {
      description: `Rovara Cloud release pipeline: a vX.Y.Z tag waits for approval, then deploys Rovara Cloud ${cloudPipelineEnv} on its Rovara Code install`,
      stackName: `${RESOURCE_PREFIX}-${cloudPipelineEnv}-pipeline`,
      env: { region: deploymentRegion ?? "us-east-1" },
      environmentName: cloudPipelineEnv,
    });
    return app;
  }
  // The model gateway (migration plan v3.2, 7.4): its image repository first, then the service that runs an image from it.
  const gatewayEnv = app.node.tryGetContext(MODEL_GATEWAY_CONTEXT_KEY) as unknown;
  if (gatewayEnv !== undefined) {
    if (typeof gatewayEnv !== "string" || gatewayEnv === "") throw new Error(`${MODEL_GATEWAY_CONTEXT_KEY} must name the Rovara Cloud environment, for example staging`);
    const env = { region: deploymentRegion ?? "us-east-1" };
    const images = new ModelGatewayImagesStack(app, "RovaraModelGatewayImages", {
      description: `Rovara Cloud ${gatewayEnv}: the model gateway's image repository`,
      stackName: modelGatewayImagesStackName(gatewayEnv),
      env,
      environmentName: gatewayEnv,
    });
    Tags.of(images).add(ENVIRONMENT_TAG_KEY, gatewayEnv);
    const gateway = new ModelGatewayStack(app, "RovaraModelGateway", {
      description: `Rovara Cloud ${gatewayEnv}: the model gateway (two Fargate tasks behind HTTPS), its meter, ledger and price tables, and alarms`,
      stackName: modelGatewayStackName(gatewayEnv),
      env,
      environmentName: gatewayEnv,
      repository: images.repository,
      ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_PRODUCT_CONTEXT_KEY), MODEL_GATEWAY_PRODUCT_CONTEXT_KEY) ? { productAi: true } : {}),
      ...rovaraAiContext(app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY), app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY), app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY)),
    });
    Tags.of(gateway).add(ENVIRONMENT_TAG_KEY, gatewayEnv);
    return app;
  }
  throw new Error(`Name the stack to make: -c ${CLOUD_APP_CONTEXT_KEY}=<environment> (Rovara Cloud), -c ${CLOUD_PIPELINE_CONTEXT_KEY}=<environment> (its release pipeline) or -c ${MODEL_GATEWAY_CONTEXT_KEY}=<environment> (the model gateway)`);
}

/** Rovara's AI for agents (DEC 240): absent is off; a non-empty string is the allow-list; the exempt list never alone. */
export function rovaraAiContext(models: unknown, exempt: unknown, disabled?: unknown): { rovaraAi?: { models: string; exempt?: string; disabled?: string } } {
  if (models === undefined) {
    if (exempt !== undefined) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} needs ${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}`);
    if (disabled !== undefined) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY} needs ${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY}`);
    return {};
  }
  if (typeof models !== "string" || models === "") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY} must be <agent model>=<bedrock id> pairs`);
  if (exempt !== undefined && typeof exempt !== "string") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} must be company ids`);
  if (disabled !== undefined && typeof disabled !== "string") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY} must be model names`);
  return { rovaraAi: { models, ...(exempt === undefined || exempt === "" ? {} : { exempt }), ...(disabled === undefined ? {} : { disabled }) } };
}

/** An opt-in switch read from CDK context: absent is off, "on" is on, anything else is refused (never guessed). */
export function productAiOn(value: unknown, name: string): boolean {
  if (value === undefined) return false;
  if (value === "on") return true;
  throw new Error(`${name} must be "on" or absent`);
}
