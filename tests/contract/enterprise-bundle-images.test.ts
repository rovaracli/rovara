// Enterprise foundations, N2: an Enterprise install runs LiteLLM from its own ECR (loaded from the signed bundle); every other edition is unchanged.
import { existsSync, mkdirSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { LITELLM_SOURCE_IMAGE, imageDigestOf } from "../../infra/lib/bundle-images.js";
import { LITELLM_IMAGE } from "../../infra/lib/model-proxy.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();
if (!existsSync("packages/web/dist/app/assets")) mkdirSync("packages/web/dist/app/assets", { recursive: true });

function appStacks(context: Record<string, unknown>): Record<string, Template> {
  const app = buildAgentXApp(context);
  const out: Record<string, Template> = {};
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) out[stack.node.id] = Template.fromStack(stack);
  return out;
}
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.99.0.0/16", agentxAuditTsa: "off" } as const;
const PUBLIC = { agentxEnv: "pub", agentxCloud: true, rovaraEdition: "public" } as const;
type Resource = { Type: string; Properties: Record<string, unknown> };
const resourcesOf = (template: Template, type: string): Array<[string, Resource]> => Object.entries(template.toJSON().Resources as Record<string, Resource>).filter(([, r]) => r.Type === type);
const litellmImage = (template: Template): unknown => {
  const [, task] = resourcesOf(template, "AWS::ECS::TaskDefinition").find(([, t]) => (t.Properties.ContainerDefinitions as Array<{ Name: string }>).some((c) => c.Name === "litellm"))!;
  return (task.Properties.ContainerDefinitions as Array<{ Name: string; Image: unknown }>).find((c) => c.Name === "litellm")!.Image;
};

describe("the model proxy image", () => {
  const enterprise = appStacks(ENTERPRISE);
  const digest = imageDigestOf(LITELLM_SOURCE_IMAGE);

  it("is the install's own ECR repository, by the pinned digest, in Enterprise; no template names a public registry for it", () => {
    const image = litellmImage(enterprise.AgentXControlPlane!) as { "Fn::Join": [string, unknown[]] };
    const joined = JSON.stringify(image);
    expect(joined).toContain(".dkr.ecr.");
    expect(joined).toContain("rovara-bundle/ent/litellm");
    expect(joined).toContain(digest);
    expect(JSON.stringify(enterprise.AgentXControlPlane!.toJSON())).not.toContain("ghcr.io");
  });

  it("lets the proxy's execution role pull from that repository only", () => {
    const statements = resourcesOf(enterprise.AgentXControlPlane!, "AWS::IAM::Policy").flatMap(([, policy]) => (policy.Properties.PolicyDocument as { Statement: Array<{ Sid?: string; Action: string[] | string; Resource: unknown }> }).Statement);
    const pull = statements.find((statement) => statement.Sid === "PullBundledImages")!;
    expect(pull).toBeDefined();
    expect(JSON.stringify(pull.Resource)).toContain("repository/rovara-bundle/ent/litellm");
    expect(JSON.stringify(pull.Resource)).not.toContain("*");
    expect(JSON.stringify(pull.Resource)).not.toMatch(/worker|slack|executor/);
    expect(pull.Action).toEqual(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]);
  });

  it("is created by the access stack for every image the bundle mirrors (LiteLLM, worker, Slack, executor): immutable tags, scan on push, kept when the stack goes", () => {
    const repositories = resourcesOf(enterprise.AgentXAccess!, "AWS::ECR::Repository");
    expect(repositories.map(([, repository]) => repository.Properties.RepositoryName).sort()).toEqual(["rovara-bundle/ent/executor", "rovara-bundle/ent/litellm", "rovara-bundle/ent/slack", "rovara-bundle/ent/worker"]);
    for (const [id, repository] of repositories) {
      expect(repository.Properties, id).toMatchObject({ ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true } });
      expect((enterprise.AgentXAccess!.toJSON().Resources as Record<string, { DeletionPolicy?: string }>)[id]!.DeletionPolicy).toBe("RetainExceptOnCreate");
    }
  });

  it("adds the embedder's repository only with the Team record on (the access stack of a template with the record off is what it was), the same kind of repository, and no wider operator right", () => {
    const KMS = "arn:aws:kms:us-east-1:111122223333:key/11111111-2222-3333-4444-555555555555";
    const withRecord = appStacks({ ...ENTERPRISE, agentxTeamRecord: "enabled", agentxTeamRecordKmsKeyArn: KMS, agentxTeamRecordEnterpriseWorkspaceId: "org_aaaaaaaaaaaaaaaaaaaa" });
    const repositories = resourcesOf(withRecord.AgentXAccess!, "AWS::ECR::Repository");
    expect(repositories.map(([, repository]) => repository.Properties.RepositoryName).sort()).toEqual(["rovara-bundle/ent/embedder", "rovara-bundle/ent/executor", "rovara-bundle/ent/litellm", "rovara-bundle/ent/slack", "rovara-bundle/ent/worker"]);
    const embedder = repositories.find(([, repository]) => repository.Properties.RepositoryName === "rovara-bundle/ent/embedder")![1];
    expect(embedder.Properties).toMatchObject({ ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true } });
    // the access stack with the record off is byte-identical to the one without the switch
    expect(JSON.stringify(enterprise.AgentXAccess!.toJSON())).toBe(JSON.stringify(appStacks(ENTERPRISE).AgentXAccess!.toJSON()));
    // nothing else changes in the access stack (so no role, boundary or operator statement gets wider): the repository is the only added resource, and every other resource is the same
    const before = appStacks(ENTERPRISE).AgentXAccess!.toJSON().Resources as Record<string, unknown>;
    const after = withRecord.AgentXAccess!.toJSON().Resources as Record<string, unknown>;
    const added = Object.keys(after).filter((id) => !(id in before));
    expect(added).toEqual([repositories.find(([, repository]) => repository.Properties.RepositoryName === "rovara-bundle/ent/embedder")![0]]);
    for (const id of Object.keys(before)) expect(JSON.stringify(after[id]), id).toBe(JSON.stringify(before[id]));
  });

  it("is unchanged in Public and for an install with no edition: the pinned public image, no repository, no pull statement", () => {
    for (const context of [PUBLIC, { agentxEnv: "legacyish" }]) {
      const stacks = appStacks(context);
      expect(litellmImage(stacks.AgentXControlPlane!), JSON.stringify(context)).toBe(LITELLM_IMAGE);
      expect(resourcesOf(stacks.AgentXAccess!, "AWS::ECR::Repository")).toEqual([]);
      expect(JSON.stringify(stacks.AgentXControlPlane!.toJSON())).not.toContain("PullBundledImages");
    }
  });
});
