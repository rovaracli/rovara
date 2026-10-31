import { readFileSync } from "node:fs";
import { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it, vi } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { createEditionGuard, EDITION_RECORD_UNREADABLE_MESSAGE, EDITION_STAMP_DIFFERS_MESSAGE, EDITION_STAMP_MISSING_MESSAGE, editionRecordName } from "../../packages/broker/src/aws/broker/edition-wiring.js";
import { createAdminBroker, adminCall } from "../support/admin-broker.js";

// Enterprise foundations I-2 (fix round 1): the edition record survives, and a process whose stamp is not the recorded edition does not serve.

function appStacks(context: Record<string, unknown>): Record<string, Template> {
  const app = buildAgentXApp(context);
  const out: Record<string, Template> = {};
  for (const stack of app.node.children.filter((child): child is Stack => Stack.isStack(child))) out[stack.node.id] = Template.fromStack(stack);
  return out;
}
const ENTERPRISE = { agentxEnv: "ent", rovaraEdition: "enterprise", rovaraEnterpriseEgressCidrs: "10.20.0.0/16", agentxAuditTsa: "off" } as const;

describe("the edition record in the foundation", () => {
  it("is kept when the stack is deleted or the resource is replaced", () => {
    const foundation = appStacks(ENTERPRISE).AgentXProductionFoundation!;
    const records = Object.values(foundation.findResources("AWS::SSM::Parameter", { Properties: { Name: "/agentx/ent/edition" } }));
    expect(records).toHaveLength(1);
    // CDK writes Retain as RetainExceptOnCreate for a resource whose first creation may roll back: either way the record survives a delete.
    expect((records[0] as { DeletionPolicy: string }).DeletionPolicy).toMatch(/^Retain/);
    expect(records[0]).toMatchObject({ UpdateReplacePolicy: "Retain", Properties: { Value: "enterprise" } });
  });
});

describe("the broker and the sign-in server can read the record in every synth", () => {
  it("with the edition, and without it (the synth that lost the stamp must still be able to look)", () => {
    for (const context of [ENTERPRISE, { agentxEnv: "ent" }]) {
      const controlPlane = JSON.stringify(appStacks(context).AgentXControlPlane!.toJSON());
      // Two functions read it: the broker and the sign-in server.
      expect(controlPlane.split('"ReadEditionRecord"').length - 1, JSON.stringify(context)).toBeGreaterThanOrEqual(2);
      expect(controlPlane).toContain("parameter/agentx/ent/edition");
    }
  });
});

describe("the guard", () => {
  const guard = (stamp: "enterprise" | "public" | undefined, value: string | undefined | Error, log = vi.fn()) => {
    const read = vi.fn(async () => { if (value instanceof Error) throw value; return value; });
    return { run: createEditionGuard({ stamp, recordName: editionRecordName("ent"), read, log }), read, log };
  };
  const refusal = async (run: () => Promise<void>) => run().then(() => undefined, (error: Error) => error.message);

  it("serves an Enterprise install whose stamp is its record, and reads the record once", async () => {
    const { run, read } = guard("enterprise", "enterprise");
    await run();
    await run();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("/agentx/ent/edition");
  });

  it("refuses a process that lost its stamp while the install has an edition on record", async () => {
    expect(await refusal(guard(undefined, "enterprise").run)).toContain(EDITION_STAMP_MISSING_MESSAGE);
  });

  it("refuses a stamp that is not the recorded edition", async () => {
    expect(await refusal(guard("public", "enterprise").run)).toContain(EDITION_STAMP_DIFFERS_MESSAGE);
    expect(await refusal(guard("enterprise", "public").run)).toContain(EDITION_STAMP_DIFFERS_MESSAGE);
  });

  it("refuses an Enterprise process that cannot read its record, or finds none, or finds one it cannot understand", async () => {
    expect(await refusal(guard("enterprise", new Error("AccessDeniedException")).run)).toContain(EDITION_RECORD_UNREADABLE_MESSAGE);
    expect(await refusal(guard("enterprise", undefined).run)).toContain(EDITION_RECORD_UNREADABLE_MESSAGE);
    expect(await refusal(guard("enterprise", "Enterprise").run)).toContain(EDITION_RECORD_UNREADABLE_MESSAGE);
    expect(await refusal(guard(undefined, "garbage").run)).toContain(EDITION_RECORD_UNREADABLE_MESSAGE);
  });

  it("serves an install deployed before editions (no stamp, no record), and one whose record it may not read (logged)", async () => {
    await guard(undefined, undefined).run();
    const unreadable = guard(undefined, new Error("AccessDeniedException"));
    await unreadable.run();
    expect(unreadable.log).toHaveBeenCalledWith(expect.objectContaining({ event: "edition.record_unreadable" }));
    await guard("public", undefined).run();
  });

  it("tries again after a refusal (a read error is not remembered)", async () => {
    let fail = true;
    const read = vi.fn(async () => { if (fail) throw new Error("throttled"); return "enterprise"; });
    const run = createEditionGuard({ stamp: "enterprise", recordName: "/agentx/ent/edition", read });
    expect(await refusal(run)).toBeDefined();
    fail = false;
    await run();
  });

  it("an install with no named environment has nothing to check", async () => {
    const read = vi.fn();
    await createEditionGuard({ stamp: undefined, recordName: undefined, read })();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("the broker serves through the guard", () => {
  it("a refusing guard stops the request before anything is read; a passing one lets it through", async () => {
    const refusing = await createAdminBroker({ extra: { editionGuard: async () => { throw new Error(EDITION_STAMP_MISSING_MESSAGE); } } });
    await expect(adminCall(refusing.handler, { method: "GET", path: "/v1/admin/projects" })).rejects.toThrow(/edition/);
    const passing = await createAdminBroker({ extra: { editionGuard: async () => undefined } });
    expect((await adminCall(passing.handler, { method: "GET", path: "/v1/admin/projects" })).status).toBe(200);
  });
});

describe("the entry points hand the guard to the processes", () => {
  it("broker.ts and the sign-in Lambda build and run it", () => {
    const broker = readFileSync(new URL("../../packages/broker/src/aws/broker.ts", import.meta.url), "utf8");
    expect(broker).toMatch(/editionGuard: createEditionGuard\(/);
    const identity = readFileSync(new URL("../../packages/broker/src/aws/developer-identity.ts", import.meta.url), "utf8");
    expect(identity).toMatch(/editionGuard = createEditionGuard\(/);
    expect(identity).toMatch(/await editionGuard\?\.\(\);/);
  });
});
