// Test services, wide AWS plans (decision 109), Cloud's wire copy of the plan: Cloud's `TaskDependencyPlanSchema` (it adds the company image's mirror) takes any service of the generated table, reads a legacy
// spelling as its key, refuses a service the table does not know and a plan of more than 64, and the shipped catalog's emulator entry names the engine the table was made from.
import { AWS_EMULATOR_ENGINE_VERSION, AWS_EMULATOR_SERVICES, AWS_PLAN_SERVICES_MAX } from "@rovara-code/contracts";
import { TaskDependencyPlanSchema } from "@agentx/cloud-contracts";
import { describe, expect, it } from "vitest";
import { shippedCatalog } from "../support/catalog-pinning.js";

const plan = (services: string[], family = `aws:${services[0]}`) => ({
  id: "aws-1", name: "AWS", kind: "cloud_api", family, backing: "emulated", catalogId: "local-aws@r1", repository: "svc/local-aws", digest: "c".repeat(64), config: {}, aliases: ["aws"], connect: [], seeds: [], reset: "fresh_per_round",
  aws: { services, region: "us-east-1" },
});

describe("Cloud's plan wire shape", () => {
  it("takes any service of the table and keeps the key", () => {
    for (const service of ["s3", "sns", "lambda", "secrets-manager", "cognito-identity-provider"]) {
      const parsed = TaskDependencyPlanSchema.safeParse(plan([service]));
      expect(parsed.success, service).toBe(true);
      expect(parsed.data?.aws?.services).toEqual([service]);
    }
  });
  it("reads a legacy spelling as its key, in the list and in the family", () => {
    const parsed = TaskDependencyPlanSchema.parse(plan(["secretsmanager", "events"], "aws:secretsmanager"));
    expect(parsed.aws?.services).toEqual(["secrets-manager", "eventbridge"]);
    // The family's own service must be listed, whichever way each is spelled.
    expect(TaskDependencyPlanSchema.safeParse(plan(["s3"], "aws:sns")).success).toBe(false);
  });
  it("refuses a service the table does not know, a repeat, an empty list and more than the plan limit", () => {
    expect(TaskDependencyPlanSchema.safeParse(plan(["nosuchservice"])).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan(["s3", "s3"])).success).toBe(false);
    expect(TaskDependencyPlanSchema.safeParse(plan([])).success).toBe(false);
    const keys = AWS_EMULATOR_SERVICES.map((row) => row.key);
    expect(TaskDependencyPlanSchema.safeParse(plan(keys.slice(0, AWS_PLAN_SERVICES_MAX))).success).toBe(true);
    expect(TaskDependencyPlanSchema.safeParse(plan(keys.slice(0, AWS_PLAN_SERVICES_MAX + 1))).success).toBe(false);
  });
});

describe("the shipped catalog", () => {
  it("names the engine the generated table was made from in the local-aws entry (a worker advertises the all-services feature only then)", () => {
    const entry = shippedCatalog().entries.find((candidate) => candidate.id === "local-aws@r1");
    expect(entry?.emulator?.engineVersion).toBe(AWS_EMULATOR_ENGINE_VERSION);
    expect(AWS_EMULATOR_ENGINE_VERSION).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,5}$/u);
  });
});
