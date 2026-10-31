// Wire lane D (MF-2, applier part): an approved intake card becomes ONE intake source of the project. The mapping from a suggestion to a source, the bound on sources, and that nothing else is touched.
import { describe, expect, it } from "vitest";
import { IntakeChannelRefSchema, type OrgId, type SetupIntakeValue } from "@agentx/contracts";
import { INTAKE_SETUP_WORDS, intakeRefOfSetupValue } from "../../packages/broker/src/intake/setup-applier.js";
import { INTAKE_MAX_SOURCES_PER_PROJECT, addIntakeSource, listIntakeSources, replaceIntakeSources } from "../../packages/broker/src/intake/sources.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const value = (over: Partial<SetupIntakeValue> = {}): SetupIntakeValue => ({ channel: "jira", hint: "tickets", label: "rovara", ...over });

describe("a suggestion becomes a source", () => {
  it("maps Jira, GitHub Issues and a team's own tracker, with the label that asks for work and the connection by name", () => {
    expect(intakeRefOfSetupValue(value({ connection: "acme-jira" }))).toEqual({ channel: "jira", connection: "acme-jira", when: { label: "rovara" } });
    expect(intakeRefOfSetupValue(value({ channel: "github_issue", system: "ignored" }))).toEqual({ channel: "github_issue", when: { label: "rovara" } });
    expect(intakeRefOfSetupValue(value({ channel: "tracker", system: "sim" }))).toEqual({ channel: "tracker", system: "sim", when: { label: "rovara" } });
  });

  it("refuses, in fixed words, Slack, Linear and other channels, a suggestion with no label, and a tracker with no system", () => {
    for (const channel of ["slack", "linear", "other"] as const) expect(() => intakeRefOfSetupValue(value({ channel }))).toThrow(INTAKE_SETUP_WORDS.channel);
    expect(() => intakeRefOfSetupValue({ channel: "jira", hint: "tickets" })).toThrow(INTAKE_SETUP_WORDS.label);
    expect(() => intakeRefOfSetupValue(value({ channel: "tracker" }))).toThrow(INTAKE_SETUP_WORDS.invalid);
    expect(() => intakeRefOfSetupValue(value({ channel: "tracker", system: "jira" }))).toThrow(INTAKE_SETUP_WORDS.invalid);
  });
});

describe("adding one source", () => {
  const table = () => { const db = new FakeDynamoDb(); return { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00.000Z") }; };
  const ref = (label: string, system = "sim") => IntakeChannelRefSchema.parse({ channel: "tracker", system, when: { label } });

  it("adds it once, leaves the others as they are, and says so when it is already there", async () => {
    const t = table();
    await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a", "one")], setBy: "x" });
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("b", "two"), setBy: "y" })).toBe("added");
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("b", "two"), setBy: "z" })).toBe("already_set");
    // The same place with another label is the maintainer's to change: a card never overwrites it.
    expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("c", "two"), setBy: "z" })).toBe("differs");
    const sources = await listIntakeSources(t, ORG, "web");
    expect(sources).toHaveLength(2);
    expect(sources.find((source) => source.ref.system === "two")).toMatchObject({ setBy: "y", failures: 0, ref: { when: { label: "b" } } });
    expect(await listIntakeSources(t, OTHER, "web")).toEqual([]);
  });

  it("refuses a source past the most a project holds, and adds nothing", async () => {
    const t = table();
    for (let n = 0; n < INTAKE_MAX_SOURCES_PER_PROJECT; n += 1) await addIntakeSource(t, { orgId: ORG, project: "web", ref: IntakeChannelRefSchema.parse({ channel: "tracker", system: `s${String(n)}`, when: { label: "rovara" } }), setBy: "x" });
    await expect(addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "extra"), setBy: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await listIntakeSources(t, ORG, "web")).toHaveLength(INTAKE_MAX_SOURCES_PER_PROJECT);
  });
});
