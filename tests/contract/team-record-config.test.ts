// UX-4b: the Team record as a normal install setting (agentx config set teamRecord.enabled and teamRecord.options, the TeamRecordEnabled stack parameter, and the synth context every cdk
// command passes), with the review fixes: the synth's edition checks before recording (2), the storage options recorded and passed back (3), the hand-built hint only when nothing is recorded (4),
// and the environment lock on both paths (5).
import { describe, expect, it } from "vitest";
import { runConfigGet, runConfigSet } from "../../packages/cli/src/config/commands.js";
import { cdkAppArguments } from "../../packages/cli/src/deploy/cdk-engine.js";
import { OPERATOR_PARAMETERS } from "../../packages/cli/src/deploy/parameters.js";
import { parseTeamRecordOptions, readTeamRecordRecord, readTeamRecordSwitch, teamRecordRecordedOrUnknown, teamRecordRefusalHint, teamRecordSwitchName } from "../../packages/cli/src/deploy/team-record-switch.js";
import { lockParameterName } from "../../packages/cli/src/environments/lock.js";
import { readEnvironmentSettings, writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { fakeCloudFormation } from "../support/fake-cloudformation.js";
import { seeded, services, stacks } from "../support/config-services.js";
import type { MemoryParameterStore } from "../support/memory-parameter-store.js";

const ENV = "staging";
async function cdkInstall(over: { cloud?: boolean } = {}) {
  const store = await seeded();
  const settings = (await readEnvironmentSettings(store, ENV))!;
  await writeEnvironmentSettings(store, { ...settings, engine: "cdk", ...(over.cloud === false ? {} : { cloud: true as const }) });
  return store;
}
const notBuilt = (store: MemoryParameterStore) => services({ store, cloudFormation: fakeCloudFormation({ parameters: {} }), stacks: stacks({ "agentx-staging-control-plane": {} }) });
const lockOps = (store: MemoryParameterStore) => store.calls.filter((call) => call.name === lockParameterName(ENV)).map((call) => call.op);

describe("teamRecord.enabled before the record is built", () => {
  it("records the choice and the confirmed options for the next upgrade, touching no stack, each under the environment's lock", async () => {
    const store = await cdkInstall();
    const configured = notBuilt(store);
    await expect(runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow("first confirm the Team record's storage options");
    expect(await runConfigSet(configured, ENV, { key: "teamRecord.options", value: "default", yes: true })).toEqual({ changed: true });
    expect(await runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).toEqual({ changed: true });
    expect(await readTeamRecordSwitch(store, ENV)).toEqual({});
    expect(configured.lines.join("\n")).toContain("The next agentx --env staging upgrade builds the Team record's storage");
    expect((await runConfigGet(configured, ENV, "teamRecord.enabled")).value).toBe("1 (recorded; agentx --env staging upgrade builds it)");
    expect((await runConfigGet(configured, ENV, "teamRecord.options")).value).toBe("default");
    const before = lockOps(store).length;
    // Off before it is built withdraws the choice, under the same lock (review fix 5).
    expect(await runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "0", yes: true })).toEqual({ changed: true });
    expect(lockOps(store).length).toBeGreaterThan(before);
    expect(await readTeamRecordSwitch(store, ENV)).toBeUndefined();
    expect((await runConfigGet(configured, ENV, "teamRecord.enabled")).value).toBe("0 (not built)");
  });

  it("runs the synth's edition checks before recording: an install with no edition outside the hosted cloud is refused, and nothing is recorded", async () => {
    const store = await cdkInstall({ cloud: false });
    const configured = notBuilt(store);
    await runConfigSet(configured, ENV, { key: "teamRecord.options", value: "default", yes: true });
    await expect(runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow("needs an install with an edition");
    expect((await readTeamRecordRecord(store, ENV))?.enabled).toBe(false);
  });

  it("refuses Enterprise-only options on the hosted cloud", async () => {
    const store = await cdkInstall();
    const configured = notBuilt(store);
    await runConfigSet(configured, ENV, { key: "teamRecord.options", value: "enterpriseWorkspaceId=org_a", yes: true });
    await expect(runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow("for Enterprise only");
  });

  it("refuses a prebuilt-templates install (the record is built only from source)", async () => {
    const store = await seeded();
    await expect(runConfigSet(services({ store, stacks: stacks({ "agentx-staging-control-plane": {} }) }), ENV, { key: "teamRecord.enabled", value: "1", yes: true })).rejects.toThrow("needs an install deployed from source");
    expect(await readTeamRecordSwitch(store, ENV)).toBeUndefined();
  });

  it("refuses a recorded value that does not read, and the first form (no options) at deploy, with the fix", async () => {
    const store = await cdkInstall();
    await store.put(teamRecordSwitchName(ENV), "yes");
    await expect(readTeamRecordSwitch(store, ENV)).rejects.toThrow("can't be read");
    await store.put(teamRecordSwitchName(ENV), "enabled");
    await expect(readTeamRecordSwitch(store, ENV)).rejects.toThrow("its storage options are not confirmed");
  });
});

describe("the storage options", () => {
  it("reads default or name=value pairs, and refuses names and values it does not know", () => {
    expect(parseTeamRecordOptions("default", ENV)).toEqual({});
    expect(parseTeamRecordOptions("lake=false; kmsKeyArn=arn:aws:kms:us-west-2:123456789012:key/1", ENV)).toEqual({ lake: "false", kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/1" });
    // Retired (DECISIONS 27): the Team record has no embedding model to choose; typing the option says so.
    expect(() => parseTeamRecordOptions("embeddingModelId=amazon.titan-embed-text-v2:0", ENV)).toThrow("embeddingModelId is retired");
    expect(() => parseTeamRecordOptions("colour=blue", ENV)).toThrow("unknown option");
    expect(() => parseTeamRecordOptions("lake=maybe", ENV)).toThrow("lake is true or false");
    expect(() => parseTeamRecordOptions("kmsKeyArn=$(rm)", ENV)).toThrow("needs a value");
  });

  it("are passed back to every cdk command as the synth's own context keys", () => {
    const base = { env: "staging", region: "us-west-2", identityMode: "cognito" as const, cloud: true };
    expect(cdkAppArguments({ ...base, teamRecord: {} })).toEqual([...cdkAppArguments(base), "-c", "agentxTeamRecord=enabled"]);
    expect(cdkAppArguments({ ...base, teamRecord: { kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/1", lake: "false", athenaUsers: "arn:aws:iam::1:role/a,arn:aws:iam::1:role/b", enterpriseWorkspaceId: "w1", embeddingModelId: "m" } as never }))
      .toEqual([...cdkAppArguments(base), "-c", "agentxTeamRecord=enabled", "-c", "agentxTeamRecordKmsKeyArn=arn:aws:kms:us-west-2:123456789012:key/1", "-c", "agentxTeamRecordLake=false", "-c", "agentxTeamRecordAthenaUsers=arn:aws:iam::1:role/a,arn:aws:iam::1:role/b", "-c", "agentxTeamRecordEnterpriseWorkspaceId=w1"]);
    expect(cdkAppArguments(base).join(" ")).not.toContain("agentxTeamRecord");
  });

  it("still reads a record stored with the retired embeddingModelId, so an older install is not stuck", async () => {
    const store = await cdkInstall();
    await store.put(teamRecordSwitchName(ENV), JSON.stringify({ v: 1, enabled: true, options: { lake: "false", embeddingModelId: "amazon.titan-embed-text-v2:0" } }));
    expect((await readTeamRecordSwitch(store, ENV))?.lake).toBe("false");
  });

  it("can't be changed once the record is built", async () => {
    const store = await cdkInstall();
    await runConfigSet(notBuilt(store), ENV, { key: "teamRecord.options", value: "default", yes: true });
    const built = services({ store, stacks: stacks({ "agentx-staging-control-plane": { TeamRecordEnabled: "1" } }) });
    await expect(runConfigSet(built, ENV, { key: "teamRecord.options", value: "lake=false", yes: true })).rejects.toThrow("could replace its storage");
  });
});

describe("teamRecord.enabled once built", () => {
  it("pauses through the TeamRecordEnabled stack parameter and keeps the record", async () => {
    const store = await cdkInstall();
    const cloudFormation = fakeCloudFormation({ parameters: { TeamRecordEnabled: "1" } });
    const configured = services({ store, cloudFormation, stacks: stacks({ "agentx-staging-control-plane": { TeamRecordEnabled: "1" } }) });
    expect(await runConfigSet(configured, ENV, { key: "teamRecord.enabled", value: "0", yes: true })).toEqual({ changed: true });
    const create = cloudFormation.calls.find((call) => call.name === "CreateChangeSetCommand")!.input;
    expect(create.Parameters).toEqual(expect.arrayContaining([{ ParameterKey: "TeamRecordEnabled", ParameterValue: "0" }]));
  });

  it("is an operator parameter, so an upgrade keeps its deployed value", () => {
    expect(OPERATOR_PARAMETERS["control-plane"]).toContain("TeamRecordEnabled");
  });
});

describe("the upgrade's hint", () => {
  it("names the fix when an upgrade would drop a record built by hand, and only when nothing records it as on", () => {
    expect(teamRecordRefusalHint("staging", ["TeamRecordTableTable1234"], false)).toContain("config set teamRecord.enabled 1");
    expect(teamRecordRefusalHint("staging", ["TeamRecordTableTable1234"], true)).toBeUndefined();
    expect(teamRecordRefusalHint("staging", ["SessionsTable"], false)).toBeUndefined();
  });

  it("treats a record that can't be read as unknown (no hint), and a missing one as unrecorded", async () => {
    const store = await cdkInstall();
    expect(await teamRecordRecordedOrUnknown(store, ENV)).toBe(false);
    await store.put(teamRecordSwitchName(ENV), "not json");
    expect(await teamRecordRecordedOrUnknown(store, ENV)).toBe(true);
    const failing = { get: async () => { throw new Error("ssm down"); } } as never;
    expect(await teamRecordRecordedOrUnknown(failing, ENV)).toBe(true);
  });
});
