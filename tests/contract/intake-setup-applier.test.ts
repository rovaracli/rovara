// Wire lane D (MF-2, applier part): an approved intake card becomes ONE intake source of the project. The mapping from a suggestion to a source, the bound on sources, and that nothing else is touched.
import { describe, expect, it } from "vitest";
import { IntakeChannelRefSchema, intakeSourceCountKey, type OrgId, type SetupIntakeValue } from "@rovara-code/contracts";
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

  it("cannot go over the most when two applies take the last place at once: one is added, the other refused", async () => {
    const t = table();
    for (let n = 0; n < INTAKE_MAX_SOURCES_PER_PROJECT - 1; n += 1) await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", `s${String(n)}`), setBy: "x" });
    const results = await Promise.allSettled([
      addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "late-a"), setBy: "x" }),
      addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "late-b"), setBy: "y" }),
      addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "late-c"), setBy: "z" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value === "added")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(await listIntakeSources(t, ORG, "web")).toHaveLength(INTAKE_MAX_SOURCES_PER_PROJECT);
  });

  it("the same place applied twice at once is added once, and a set made by the sources editor keeps the count right", async () => {
    const t = table();
    const both = await Promise.all([addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "one"), setBy: "x" }), addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "one"), setBy: "y" })]);
    expect([...both].sort()).toEqual(["added", "already_set"]);
    await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a", "x1"), ref("a", "x2"), ref("a", "x3")], setBy: "m" });
    for (let n = 0; n < INTAKE_MAX_SOURCES_PER_PROJECT - 3; n += 1) expect(await addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", `n${String(n)}`), setBy: "x" })).toBe("added");
    await expect(addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", "over"), setBy: "x" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("a sources-editor save and card applies at the same moment leave the count equal to the sources, never drifting", async () => {
    for (const adds of [1, 2, 4]) {
      const db = new FakeDynamoDb();
      const t = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00.000Z") };
      await replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a", "e1"), ref("a", "e2")], setBy: "m" });
      const work: Array<Promise<unknown>> = [replaceIntakeSources(t, { orgId: ORG, project: "web", refs: [ref("a", "e1"), ref("a", "e2"), ref("a", "e3")], setBy: "m" })];
      for (let n = 0; n < adds; n += 1) work.push(addIntakeSource(t, { orgId: ORG, project: "web", ref: ref("rovara", `c${String(n)}`), setBy: "x" }));
      await Promise.allSettled(work);
      const listed = await listIntakeSources(t, ORG, "web");
      const counted = db.get(intakeSourceCountKey(ORG, "web")) as { count: number } | undefined;
      expect(counted?.count, `adds=${String(adds)}`).toBe(listed.length);
      expect(listed.length).toBeLessThanOrEqual(INTAKE_MAX_SOURCES_PER_PROJECT);
    }
  });

  it("a card applied between the editor save's read and its write makes the save read again, so the count still equals the sources", async () => {
    const db = new FakeDynamoDb();
    const plain = { documentClient: db, tableName: "state", now: () => Date.parse("2026-10-31T10:00:00.000Z") };
    await replaceIntakeSources(plain, { orgId: ORG, project: "web", refs: [ref("a", "e1"), ref("a", "e2")], setBy: "m" });
    let interrupted = false;
    const racing = { ...plain, documentClient: { send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "TransactWriteCommand" && !interrupted) {
        interrupted = true;
        await addIntakeSource(plain, { orgId: ORG, project: "web", ref: ref("rovara", "card"), setBy: "x" });
      }
      return db.send(command as never);
    } } };
    await replaceIntakeSources(racing, { orgId: ORG, project: "web", refs: [ref("a", "e1"), ref("a", "e2"), ref("a", "e3")], setBy: "m" });
    const listed = await listIntakeSources(plain, ORG, "web");
    expect(interrupted).toBe(true);
    expect(listed.map((source) => source.ref.system).sort()).toEqual(["e1", "e2", "e3"]);
    expect((db.get(intakeSourceCountKey(ORG, "web")) as { count: number }).count).toBe(3);
  });
});
