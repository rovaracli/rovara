import { App, Tags } from "aws-cdk-lib";
import { ENVIRONMENT_TAG_KEY, RESOURCE_PREFIX } from "@agentx/contracts";
import { CLOUD_PIPELINE_CONTEXT_KEY, CloudReleasePipelineStack } from "./cloud-release-pipeline.js";
import { CLOUD_APP_CONTEXT_KEY, CloudAppStack, cloudAppStackName } from "./cloud-app.js";
import { CloudWebStack, cloudWebStackName } from "./cloud-web.js";

/**
 * Rovara Cloud's CDK app. What it makes is chosen by context:
 *  - `-c rovaraCloudApp=<environment>`: Rovara Cloud on an existing Rovara Code install: Cloud on CloudFront, Lambda and DynamoDB
 *    (cloud-web.ts), and its first address, which redirects there (cloud-app.ts, #11);
 *  - `-c rovaraCloudPipeline=<environment>`: the release pipeline that deploys those (cloud-release-pipeline.ts).
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
  throw new Error(`Name the stack to make: -c ${CLOUD_APP_CONTEXT_KEY}=<environment> (Rovara Cloud) or -c ${CLOUD_PIPELINE_CONTEXT_KEY}=<environment> (its release pipeline)`);
}
