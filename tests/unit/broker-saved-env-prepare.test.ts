// SH25: the prepare invocation's saved environment field is asked of the installed resolver, and never blocks or fails a preparation.
import { describe, expect, it } from "vitest";
import { savedEnvPrepareOf } from "../../packages/broker/src/aws/broker/saved-env-prepare.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "../../packages/broker/src/aws/broker/definitions.js";

const project = { definition: { name: "payments" } } as unknown as RegisteredProjectRecord;
const withResolver = (resolver: AwsBrokerDependencies["savedEnvPrepare"]) => ({ savedEnvPrepare: resolver }) as unknown as AwsBrokerDependencies;
const told = { savedEnv: { taskTestEnvRevision: 4 } } as never;

describe("savedEnvPrepareOf", () => {
  it("asks the resolver for this org and project and passes its answer on", async () => {
    const seen: unknown[] = [];
    const answer = await savedEnvPrepareOf(withResolver(async (input) => { seen.push(input); return told; }), project, { orgId: "org-1" });
    expect(answer).toBe(told);
    expect(seen).toEqual([{ orgId: "org-1", projectName: "payments" }]);
  });
  it("sends nothing when no resolver is installed (the switch is off), the run runs none of the project's code, or the org is unknown", async () => {
    expect(await savedEnvPrepareOf({} as AwsBrokerDependencies, project, { orgId: "org-1" })).toEqual({});
    expect(await savedEnvPrepareOf(withResolver(async () => told), project, { orgId: "org-1", readOnly: true })).toEqual({});
    expect(await savedEnvPrepareOf(withResolver(async () => told), project, { orgId: undefined })).toEqual({});
  });
  it("a resolver that throws sends nothing: the preparation goes ahead and sets up fresh", async () => {
    expect(await savedEnvPrepareOf(withResolver(async () => { throw new Error("boom"); }), project, { orgId: "org-1" })).toEqual({});
  });
});
