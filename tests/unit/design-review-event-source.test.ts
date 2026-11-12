// Design review stage: the source of the event that started a task, read where the broker recorded it (the chain run for a chain step's task; the session and its trigger otherwise). Anything unreadable is no source.
import { describe, expect, it } from "vitest";
import { agentSessionKey, chainRunKey, triggerKey, type OrgId } from "@rovara-code/contracts";
import { eventSourceOfTask } from "../../packages/broker/src/design-review/event-source.js";
import type { AwsBrokerDependencies } from "../../packages/broker/src/aws/broker/definitions.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TRIGGER_ID = "ctr_aaaaaaaaaaaaaaaaaaaa";

const keyText = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
function world(items: Array<[{ pk: string; sk: string }, Record<string, unknown>]>, failReads = false): AwsBrokerDependencies {
  const table = new Map(items.map(([key, item]) => [keyText(key), item] as const));
  return {
    tableName: "t", now: () => 0,
    documentClient: { send: async (command: { input: { Key: { pk: string; sk: string } } }) => { if (failReads) throw new Error("down"); return { Item: table.get(keyText(command.input.Key)) }; } },
  } as unknown as AwsBrokerDependencies;
}
const eventBy = (source: string) => ({ kind: "event", triggerId: TRIGGER_ID, eventKey: "evt-1", source, type: "issue.created", title: "t" });
const chainRunItem = (startedBy: unknown, orgId: OrgId = ORG) => [chainRunKey(ORG, "run1", "META"), { orgId, startedBy }] as [{ pk: string; sk: string }, Record<string, unknown>];
const sessionItem = (startedBy: unknown, orgId: OrgId = ORG) => [agentSessionKey(ORG, "ses1", "META"), { orgId, startedBy }] as [{ pk: string; sk: string }, Record<string, unknown>];
const triggerItem = (spec: unknown, orgId: OrgId = ORG) => [triggerKey(ORG, TRIGGER_ID), { orgId, triggerId: TRIGGER_ID, spec }] as [{ pk: string; sk: string }, Record<string, unknown>];

describe("the source of the event that started a task", () => {
  it("a chain step's task names the event source its chain run recorded", async () => {
    const dependencies = world([chainRunItem(eventBy("github"))]);
    expect(await eventSourceOfTask(dependencies, { origin: "event", chain: { chainRunId: "run1", stepId: "s1" } }, ORG)).toBe("github");
  });

  it("an agent trigger's task names the source of the trigger its session recorded", async () => {
    const dependencies = world([sessionItem({ kind: "event", triggerId: TRIGGER_ID }), triggerItem({ kind: "event", source: "sentry", type: "issue.created" })]);
    expect(await eventSourceOfTask(dependencies, { origin: "event", sessionId: "ses1" }, ORG)).toBe("sentry");
  });

  it("is no source for a task no event started, a missing record, another org's record, a schedule, a malformed record or a failed read", async () => {
    const chain = { chainRunId: "run1", stepId: "s1" };
    expect(await eventSourceOfTask(world([chainRunItem(eventBy("github"))]), { origin: "app", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([]), { origin: "event", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([chainRunItem(eventBy("github"), OTHER_ORG)]), { origin: "event", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([chainRunItem({ kind: "schedule", triggerId: TRIGGER_ID, scheduledAt: "2026-11-11T00:00:00.000Z" })]), { origin: "event", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([chainRunItem({ kind: "event", source: "github" })]), { origin: "event", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([chainRunItem(eventBy("github"))], true), { origin: "event", chain }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([]), { origin: "event" }, ORG)).toBeUndefined();
    // The session names a trigger that is gone, or is not an event trigger.
    expect(await eventSourceOfTask(world([sessionItem({ kind: "event", triggerId: TRIGGER_ID })]), { origin: "event", sessionId: "ses1" }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([sessionItem({ kind: "event", triggerId: TRIGGER_ID }), triggerItem({ kind: "schedule" })]), { origin: "event", sessionId: "ses1" }, ORG)).toBeUndefined();
    expect(await eventSourceOfTask(world([sessionItem({ kind: "event", triggerId: TRIGGER_ID }), triggerItem({ kind: "event", source: "github", type: "x" }, OTHER_ORG)]), { origin: "event", sessionId: "ses1" }, ORG)).toBeUndefined();
  });
});
