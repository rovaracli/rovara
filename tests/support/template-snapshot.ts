import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { buildAgentXApp } from "../../infra/lib/app.js";

/**
 * Asset hashes change whenever bundled code changes; the names and shapes must not. A Lambda Version's logical id (`<Function>CurrentVersion` + 8 hex of the construct path + 32 hex of
 * the function's code) carries a hash of the bundle too, and the bundle's source map holds the checkout's file paths, so the id differs from one folder to the next (and on CI): it is masked
 * the same way.
 */
export function normalizedTemplate(stack: Stack): unknown {
  const text = JSON.stringify(Template.fromStack(stack).toJSON());
  return JSON.parse(text.replace(/CurrentVersion[A-F0-9]{8}[a-f0-9]{32}/g, "CurrentVersion<code-hash>").replace(/[a-f0-9]{64}/g, "<asset-hash>"));
}

/**
 * The production stacks, built with the same ids and props as infra/lib/app.ts
 * (default deployment mode "instances-ebs", no agentxRegion context: region "us-east-1",
 * no agentxEnv context: legacy naming). Includes the release pipeline: infra/lib/app.ts
 * builds it as one of the live deployment's stacks.
 */
export function legacyProductionStacks(): Stack[] {
  const app = buildAgentXApp();
  return app.node.children.filter((child): child is Stack => Stack.isStack(child));
}
