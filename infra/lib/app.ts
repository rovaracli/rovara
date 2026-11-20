import { App, Aspects, Tags } from "aws-cdk-lib";
import { ENVIRONMENT_TAG_KEY, RESOURCE_PREFIX, parseSourceKindsSwitch } from "@agentx/contracts";
import { CLOUD_PIPELINE_CONTEXT_KEY, CloudReleasePipelineStack, DEPLOY_ACCOUNT_CONTEXT_KEY } from "./cloud-release-pipeline.js";
import { CLOUD_APP_CONTEXT_KEY, CloudAppStack, cloudAppStackName } from "./cloud-app.js";
import { CloudWebStack, cloudWebStackName } from "./cloud-web.js";
import { RequireCloudBoundary } from "./cloud-boundary.js";
import { MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY, MODEL_GATEWAY_CONTEXT_KEY, MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY, MODEL_GATEWAY_PRODUCT_CONTEXT_KEY, MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_DISABLED_CONTEXT_KEY, MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY, ModelGatewayImagesStack, ModelGatewayStack, modelGatewayImagesStackName, modelGatewayStackName, providerSecretNamesMode } from "./model-gateway.js";

/**
 * Rovara Cloud's CDK app. What it makes is chosen by context:
 *  - `-c rovaraCloudApp=<environment>`: Rovara Cloud on an existing Rovara Code install: Cloud on CloudFront, Lambda and DynamoDB
 *    (cloud-web.ts), and its first address, which redirects there (cloud-app.ts, #11);
 *  - `-c rovaraCloudPipeline=<environment>`: the release pipeline that deploys those (cloud-release-pipeline.ts);
 *  - `-c rovaraModelGateway=<environment>`: the model gateway and its image repository (model-gateway.ts). The release pipeline
 *    never makes or deploys these. `-c rovaraModelGatewayProviderSecretNames=fixed` keeps an already-deployed environment's fixed
 *    provider secret names (default: CloudFormation generates them).
 * `-c agentxRegion=<region>` picks the region (us-east-1 by default).
 */
export function buildAgentXApp(context: Record<string, unknown> = {}): App {
  const app = new App({ context: { "@aws-cdk/core:defaultCrossStackReferences": "strong", ...context } });
  // Every role of every Cloud stack carries the environment's permissions boundary (cloud-boundary.ts); a stack that forgets it fails here.
  Aspects.of(app).add(new RequireCloudBoundary());
  const deploymentRegion = app.node.tryGetContext("agentxRegion") as string | undefined;
  // Rovara Cloud on an existing Rovara Code install: its own stack only, so a Cloud release synthesizes and deploys
  // nothing of Code's.
  const cloudAppEnv = app.node.tryGetContext(CLOUD_APP_CONTEXT_KEY) as unknown;
  if (cloudAppEnv !== undefined) {
    if (typeof cloudAppEnv !== "string" || cloudAppEnv === "") throw new Error(`${CLOUD_APP_CONTEXT_KEY} must name the Rovara Cloud environment, for example production`);
    // Rovara-cloud#269: a pipeline in another account names the account it deploys into, so cdk goes through that account's bootstrap
    // roles. Absent: the stacks deploy into the account of the credentials, as before.
    const account = app.node.tryGetContext(DEPLOY_ACCOUNT_CONTEXT_KEY) as unknown;
    if (account !== undefined && (typeof account !== "string" || !/^[0-9]{12}$/u.test(account))) throw new Error(`${DEPLOY_ACCOUNT_CONTEXT_KEY} must be a 12-digit AWS account id`);
    const cloudEnv = { region: deploymentRegion ?? "us-east-1", ...(typeof account === "string" ? { account } : {}) };
    // Cloud, with no gap on a release (#11). cloud-app.ts keeps only Cloud's first address, which redirects here.
    const cloudWeb = new CloudWebStack(app, "RovaraCloudWeb", {
      description: `Rovara Cloud ${cloudAppEnv}: the web app on CloudFront and S3, Cloud's server on Lambda, its state in DynamoDB`,
      stackName: cloudWebStackName(cloudAppEnv),
      env: cloudEnv,
      environmentName: cloudAppEnv,
      ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_PRODUCT_CONTEXT_KEY), MODEL_GATEWAY_PRODUCT_CONTEXT_KEY) ? { productAi: true } : {}),
      ...aiSourceKindsContext(app.node.tryGetContext(AI_SOURCE_KINDS_CONTEXT_KEY)),
      ...rovaraAiExemptContext(app.node.tryGetContext(MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY)),
    });
    Tags.of(cloudWeb).add(ENVIRONMENT_TAG_KEY, cloudAppEnv);
    const cloudApp = new CloudAppStack(app, "RovaraCloudApp", {
      description: `Rovara Cloud ${cloudAppEnv}: its first address, which sends people to its current one`,
      stackName: cloudAppStackName(cloudAppEnv),
      env: cloudEnv,
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
      ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY), MODEL_GATEWAY_BEDROCK_BYO_CONTEXT_KEY) ? { bedrockByo: true } : {}),
      ...aiSourceKindsContext(app.node.tryGetContext(AI_SOURCE_KINDS_CONTEXT_KEY)),
      ...(productAiOn(app.node.tryGetContext(MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY), MODEL_GATEWAY_OFFERED_PRICES_CONTEXT_KEY) ? { offeredPrices: true } : {}),
      providerSecretNames: providerSecretNamesMode(app.node.tryGetContext(MODEL_GATEWAY_PROVIDER_SECRET_NAMES_CONTEXT_KEY)),
    });
    Tags.of(gateway).add(ENVIRONMENT_TAG_KEY, gatewayEnv);
    return app;
  }
  throw new Error(`Name the stack to make: -c ${CLOUD_APP_CONTEXT_KEY}=<environment> (Rovara Cloud), -c ${CLOUD_PIPELINE_CONTEXT_KEY}=<environment> (its release pipeline) or -c ${MODEL_GATEWAY_CONTEXT_KEY}=<environment> (the model gateway)`);
}

/**
 * DEC 254t (a): `-c rovaraAiSourceKinds=<kind>,...` names the company AI source kinds the owner switched on after each one's real-key
 * check passed (scripts/real-key-check.ts). The SAME value goes to Cloud (CLOUD_AI_SOURCE_KINDS: what an admin may choose) and to the
 * gateway (GATEWAY_AI_SOURCE_KINDS: what a call may use), so pass it to both deploys. Absent: neither setting (none switched on).
 */
export const AI_SOURCE_KINDS_CONTEXT_KEY = "rovaraAiSourceKinds";
/** Absent: nothing. A string: the checked list (the contracts' parseSourceKindsSwitch; a bad value stops the synth). Anything else is refused. */
export function aiSourceKindsContext(value: unknown): { aiSourceKinds?: string } {
  if (value === undefined) return {};
  if (typeof value !== "string") throw new Error(`${AI_SOURCE_KINDS_CONTEXT_KEY} must be AI source kinds, comma-separated`);
  try { parseSourceKindsSwitch(value); } catch { throw new Error(`${AI_SOURCE_KINDS_CONTEXT_KEY} must be AI source kinds, comma-separated (anthropic, openai, openrouter, bedrock, endpoint)`); }
  return { aiSourceKinds: value };
}

/**
 * DEC 254zzz3(1): the SAME `-c rovaraModelGatewayRovaraAiExempt=<org ids>` also goes to Cloud's server (CLOUD_ROVARA_AI_EXEMPT), words only. Absent or empty: nothing.
 * Company ids (org_ and 20 of a-z0-9), at most ten, no repeats; anything else stops the synth.
 */
export function rovaraAiExemptContext(value: unknown): { rovaraAiExempt?: string } {
  if (value === undefined || value === "") return {};
  if (typeof value !== "string") throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY} must be company ids`);
  const ids = value.split(",");
  if (ids.length > 10 || ids.some((id) => !/^org_[0-9a-z]{20}$/u.test(id)) || new Set(ids).size !== ids.length) throw new Error(`${MODEL_GATEWAY_ROVARA_AI_EXEMPT_CONTEXT_KEY}: give company ids (org_...), comma-separated`);
  return { rovaraAiExempt: value };
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
