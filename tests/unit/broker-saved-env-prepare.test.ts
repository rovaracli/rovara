// SH25: the prepare invocation's saved environment field is asked of the installed resolver, and never blocks or fails a preparation.
import { describe, expect, it } from "vitest";
import { installSavedEnv, savedEnvPrepareOf } from "../../packages/broker/src/aws/broker/saved-env-prepare.js";
import type { AwsBrokerDependencies, RegisteredProjectRecord } from "../../packages/broker/src/aws/broker/definitions.js";

const project = { definition: { name: "payments" } } as unknown as RegisteredProjectRecord;
const withResolver = (resolver: AwsBrokerDependencies["savedEnvPrepare"]) => ({ savedEnvPrepare: resolver }) as unknown as AwsBrokerDependencies;
const pin = { revision: 4, digest: "d".repeat(64) };
const told = { savedEnv: { taskTestEnvRevision: 4 } } as never;

describe("savedEnvPrepareOf", () => {
  it("asks the resolver for this org and project and passes its answer on", async () => {
    const seen: unknown[] = [];
    const answer = await savedEnvPrepareOf(withResolver(async (input) => { seen.push(input); return told; }), project, { orgId: "org-1", testEnvPin: pin });
    expect(answer).toBe(told);
    expect(seen).toEqual([{ orgId: "org-1", projectName: "payments", testEnvPin: pin }]);
  });
  it("sends nothing when no resolver is installed (the switch is off), the run runs none of the project's code, or the org is unknown", async () => {
    expect(await savedEnvPrepareOf({} as AwsBrokerDependencies, project, { orgId: "org-1", testEnvPin: pin })).toEqual({});
    expect(await savedEnvPrepareOf(withResolver(async () => told), project, { orgId: "org-1", readOnly: true, testEnvPin: pin })).toEqual({});
    expect(await savedEnvPrepareOf(withResolver(async () => told), project, { orgId: undefined, testEnvPin: pin })).toEqual({});
  });
  it("sends nothing without the task's approved environment pin, and nothing for a setup draft (thread workspaces, registrations and every other preparation name no pin)", async () => {
    const seen: unknown[] = [];
    const resolver = withResolver(async (input) => { seen.push(input); return told; });
    expect(await savedEnvPrepareOf(resolver, project, { orgId: "org-1" })).toEqual({});
    expect(await savedEnvPrepareOf(resolver, project, { orgId: "org-1", testEnvPin: undefined })).toEqual({});
    expect(await savedEnvPrepareOf(resolver, project, { orgId: "org-1", setupDraft: true, testEnvPin: pin })).toEqual({});
    expect(seen).toEqual([]);
  });
  it("a resolver that throws sends nothing: the preparation goes ahead and sets up fresh", async () => {
    expect(await savedEnvPrepareOf(withResolver(async () => { throw new Error("boom"); }), project, { orgId: "org-1", testEnvPin: pin })).toEqual({});
  });
});

describe("installSavedEnv", () => {
  const deps = { session: { config: { enabled: true } } } as never;
  it("installs both hooks only while the switch is on, and only with the registry's ports", () => {
    expect(Object.keys(installSavedEnv({ savedEnvDeps: deps }, { SAVED_ENV_ENABLED: "1" })).sort()).toEqual(["savedEnvLogin", "savedEnvPrepare"]);
    // off is EXPLICIT: both keys are present and undefined, so spreading the result over an input that already had a hook clears it
    const off = { savedEnvPrepare: undefined, savedEnvLogin: undefined };
    expect(installSavedEnv({ savedEnvDeps: deps }, {})).toStrictEqual(off);
    expect(installSavedEnv({ savedEnvDeps: deps }, { SAVED_ENV_ENABLED: "0" })).toStrictEqual(off);
    expect(installSavedEnv({ savedEnvDeps: deps }, { SAVED_ENV_ENABLED: "true" })).toStrictEqual(off);
    expect(installSavedEnv({}, { SAVED_ENV_ENABLED: "1" })).toStrictEqual(off);
    const inherited = { savedEnvPrepare: async () => ({}), savedEnvLogin: async () => undefined };
    expect({ ...inherited, ...installSavedEnv({ savedEnvDeps: deps }, {}) }).toStrictEqual(off);
  });
});
