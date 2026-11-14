import { App, Tags } from "aws-cdk-lib";
import { ENVIRONMENT_TAG_KEY, RESOURCE_PREFIX } from "@agentx/contracts";
import { CLOUD_PIPELINE_CONTEXT_KEY, CloudReleasePipelineStack } from "./cloud-release-pipeline.js";
import { CLOUD_APP_CONTEXT_KEY, CloudAppStack, cloudAppStackName } from "./cloud-app.js";

/**
 * Rovara Cloud's CDK app. It makes one stack per run, chosen by context:
 *  - `-c rovaraCloudApp=<environment>`: Rovara Cloud on an existing Rovara Code install (cloud-app.ts);
 *  - `-c rovaraCloudPipeline=<environment>`: the release pipeline that deploys that stack (cloud-release-pipeline.ts).
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
    const cloudApp = new CloudAppStack(app, "RovaraCloudApp", {
      description: `Rovara Cloud ${cloudAppEnv}: the web app and Cloud's server, signing people in through Rovara Code`,
      stackName: cloudAppStackName(cloudAppEnv),
      env: { region: deploymentRegion ?? "us-east-1" },
      environmentName: cloudAppEnv,
    });
    Tags.of(cloudApp).add(ENVIRONMENT_TAG_KEY, cloudAppEnv);
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
