// Test services TS19: the registry side of the image catalog, on the synthesised template. What must hold: one repository per catalog repository with immutable tags, scan on push and KMS; a lifecycle policy; every
// resource conditional on the test services switch (`TestServicesEnabled`, `tx`), so with it off nothing exists; nothing added to the broker's environment; a legacy install untouched.
import { App, CfnParameter, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { SERVICE_CATALOG_REPOSITORIES, catalogRepositoryName } from "@agentx/contracts";
import { SERVICE_CATALOG_KEEP_TAGGED, attachServiceCatalogImages, serviceCatalogLifecyclePolicy } from "../../infra/lib/service-catalog-images.js";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { normalizedTemplate } from "../support/template-snapshot.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

const ACCOUNT = "111122223333";
const REGION = "us-west-2";
const KMS = "arn:aws:kms:us-west-2:111122223333:key/11111111-2222-3333-4444-555555555555";

function build(props: { repositories?: readonly string[]; kmsKeyArn?: string; account?: string } = {}) {
  const stack = new Stack(new App(), "T", { env: { account: props.account ?? ACCOUNT, region: REGION } });
  const testServicesEnabled = new CfnParameter(stack, "TestServicesEnabled", { type: "String", default: "0", allowedValues: ["0", "1"] });
  const images = attachServiceCatalogImages(stack, { env: "test", repositories: props.repositories ?? SERVICE_CATALOG_REPOSITORIES, testServicesEnabled, ...(props.kmsKeyArn === undefined ? {} : { kmsKeyArn: props.kmsKeyArn }) });
  return { stack, images, template: Template.fromStack(stack) };
}
type Resource = { Type: string; Condition?: string; Properties?: Record<string, unknown>; DeletionPolicy?: string; UpdateReplacePolicy?: string };
const resourcesOf = (template: Template): Record<string, Resource> => template.toJSON().Resources as Record<string, Resource>;

describe("the catalog repositories", () => {
  const { template } = build();
  const repositories = () => Object.values(resourcesOf(template)).filter((resource) => resource.Type === "AWS::ECR::Repository");

  it("are one per catalog repository, named rovara-catalog/<env>/<repository>", () => {
    template.resourceCountIs("AWS::ECR::Repository", SERVICE_CATALOG_REPOSITORIES.length);
    expect(repositories().map((repository) => repository.Properties!["RepositoryName"]).sort()).toEqual(SERVICE_CATALOG_REPOSITORIES.map((name) => catalogRepositoryName("test", name)).sort());
  });
  it("have immutable tags, scan on push and KMS encryption with the key made here", () => {
    for (const repository of repositories()) {
      expect(repository.Properties).toMatchObject({ ImageTagMutability: "IMMUTABLE", ImageScanningConfiguration: { ScanOnPush: true }, EncryptionConfiguration: { EncryptionType: "KMS" } });
      expect((repository.Properties!["EncryptionConfiguration"] as { KmsKey: unknown }).KmsKey).toHaveProperty("Fn::GetAtt");
    }
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  });
  it("carry a lifecycle policy: untagged out after a day, and a backstop that is large (a retired digest may still be pinned)", () => {
    const policy = JSON.parse((repositories()[0]!.Properties!["LifecyclePolicy"] as { LifecyclePolicyText: string }).LifecyclePolicyText) as { rules: Array<{ rulePriority: number; selection: Record<string, unknown> }> };
    expect(policy).toEqual(serviceCatalogLifecyclePolicy());
    expect(policy.rules[0]!.selection).toMatchObject({ tagStatus: "untagged", countType: "sinceImagePushed", countUnit: "days", countNumber: 1 });
    expect(policy.rules[1]!.selection).toMatchObject({ tagStatus: "tagged", countType: "imageCountMoreThan", countNumber: SERVICE_CATALOG_KEEP_TAGGED });
    expect(SERVICE_CATALOG_KEEP_TAGGED).toBeGreaterThanOrEqual(30);
  });
  it("are retained when the switch is turned off or the stack is deleted, and so is the key", () => {
    for (const resource of [...repositories(), ...Object.values(resourcesOf(template)).filter((candidate) => candidate.Type === "AWS::KMS::Key")]) {
      expect(resource.DeletionPolicy).toBe("Retain");
      expect(resource.UpdateReplacePolicy).toBe("Retain");
    }
  });
  it("grant no role anything and add no policy, no output and no role: a worker pulls through the instance role it already has", () => {
    const types = new Set(Object.values(resourcesOf(template)).map((resource) => resource.Type));
    expect([...types].sort()).toEqual(["AWS::ECR::Repository", "AWS::KMS::Key"]);
    expect(template.toJSON().Outputs).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toContain("Principal\":\"*\"");
  });
  it("carries no em dash in any name or description", () => {
    expect(JSON.stringify(template.toJSON())).not.toContain("—");
  });
});

describe("the switch", () => {
  it("makes every resource conditional on TestServicesEnabled being 1, and the condition exists", () => {
    const { template } = build();
    const json = template.toJSON() as { Conditions: Record<string, unknown>; Resources: Record<string, Resource> };
    const conditions = Object.keys(json.Conditions);
    expect(conditions).toHaveLength(1);
    expect(json.Conditions[conditions[0]!]).toEqual({ "Fn::Equals": [{ Ref: "TestServicesEnabled" }, "1"] });
    for (const [id, resource] of Object.entries(json.Resources)) expect(resource.Condition, id).toBe(conditions[0]);
  });
});

describe("the customer's key (Enterprise)", () => {
  it("is used in place of a key made here, and must be a key ARN in this account and region", () => {
    const { template } = build({ kmsKeyArn: KMS });
    template.resourceCountIs("AWS::KMS::Key", 0);
    for (const repository of Object.values(resourcesOf(template)).filter((resource) => resource.Type === "AWS::ECR::Repository")) {
      expect(repository.Properties!["EncryptionConfiguration"]).toEqual({ EncryptionType: "KMS", KmsKey: KMS });
    }
    for (const bad of ["alias/x", "arn:aws:kms:us-west-2:111122223333:alias/x", "arn:aws:kms:eu-west-1:111122223333:key/11111111-2222-3333-4444-555555555555", "arn:aws:kms:us-west-2:999999999999:key/11111111-2222-3333-4444-555555555555", "not an arn"]) {
      expect(() => build({ kmsKeyArn: bad }), bad).toThrow();
    }
  });
});

describe("what it refuses", () => {
  it("no repositories, a repeated one, or a name that is not a catalog repository", () => {
    expect(() => build({ repositories: [] })).toThrow();
    expect(() => build({ repositories: ["svc/postgres", "svc/postgres"] })).toThrow();
    expect(() => build({ repositories: ["postgres"] })).toThrow();
    expect(() => build({ repositories: ["svc/../x"] })).toThrow();
  });
});

describe("in the stacks", () => {
  it("the staging control plane has the repositories, all conditional on its TestServicesEnabled parameter; nothing else in it changes because of them", () => {
    const stack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
    const json = normalizedTemplate(stack) as { Parameters: Record<string, { Default?: string }>; Conditions: Record<string, { "Fn::Equals"?: unknown[] }>; Resources: Record<string, Resource> };
    expect(json.Parameters["TestServicesEnabled"]!.Default).toBe("0");
    const mine = Object.entries(json.Resources).filter(([id]) => id.startsWith("ServiceCatalogImages"));
    expect(mine.map(([, resource]) => resource.Type).sort()).toEqual([...SERVICE_CATALOG_REPOSITORIES.map(() => "AWS::ECR::Repository"), "AWS::KMS::Key"].sort());
    const conditions = new Set(mine.map(([, resource]) => resource.Condition));
    expect(conditions.size).toBe(1);
    const condition = [...conditions][0]!;
    expect(json.Conditions[condition]).toEqual({ "Fn::Equals": [{ Ref: "TestServicesEnabled" }, "1"] });
    // No other resource refers to one of them (the control plane's roles, policies and functions are unchanged).
    const mineIds = new Set(mine.map(([id]) => id));
    const text = (resource: Resource): string => JSON.stringify(resource);
    for (const [id, resource] of Object.entries(json.Resources)) {
      if (mineIds.has(id)) continue;
      for (const mineId of mineIds) expect(text(resource), `${id} refers to ${mineId}`).not.toContain(`"${mineId}"`);
    }
  }, 120_000);

  it("the broker's environment gains no variable (its budget is 4 KB)", () => {
    const stack = buildAgentXApp({ agentxEnv: "staging" }).node.children.filter((child): child is Stack => Stack.isStack(child)).find((candidate) => candidate.stackName === "agentx-staging-control-plane")!;
    const variables = Object.values((normalizedTemplate(stack) as { Resources: Record<string, Resource> }).Resources).filter((resource) => resource.Type === "AWS::Lambda::Function").flatMap((resource) => Object.keys(((resource.Properties?.["Environment"] as { Variables?: Record<string, unknown> } | undefined)?.Variables) ?? {}));
    expect(variables.filter((name) => /SERVICE_CATALOG|CATALOG_IMAGE|PREPULL|ROVARA_CATALOG/u.test(name))).toEqual([]);
  }, 120_000);

  it("a legacy install has none of them", () => {
    const stacks = buildAgentXApp({}).node.children.filter((child): child is Stack => Stack.isStack(child));
    for (const stack of stacks) expect(JSON.stringify(normalizedTemplate(stack))).not.toContain("ServiceCatalogImages");
  }, 120_000);
});
