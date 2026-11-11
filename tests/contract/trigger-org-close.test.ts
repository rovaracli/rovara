// Plan 4 Task 18 (P2-7): closing an org deletes its triggers, their activity and the notices stored for its people, and nothing of another org's. Through the real broker:
// the last owner leaves, which closes a cloud org.
import { randomUUID } from "node:crypto";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, describe, expect, it } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { TriggerStore } from "../../packages/broker/src/triggers/store.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

beforeAll(async () => { await loadSlackBroker(); });

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const CHAIN = `chn_${"c".repeat(20)}`;

describe("closing an org", () => {
  it("deletes the org's triggers, activity and notices when its last owner leaves, and leaves another org's alone", async () => {
    const h = await createDeveloperTaskBroker({
      register: false, orgResolver: async (subject) => (subject.developerId === OMAR.developerId ? ORG_B : TEST_ORG),
      brokerExtra: { cloud: true, agents: { projectMembers: new FakeProjectMembers() } },
    });
    for (const [who, orgId] of [[MAYA, TEST_ORG], [OMAR, ORG_B]] as const) {
      await h.orgOf(who);
      seedMembership(h.db, who.developerId, { orgId, role: "owner" });
    }
    const triggers = new TriggerStore({ documentClient: h.db, tableName: "state", now: Date.now });
    const make = async (orgId: OrgId, letter: string, by: string) => {
      const trigger = await triggers.create({ record: { orgId, triggerId: `ctr_${letter.repeat(20)}`, target: { kind: "chain", chainId: CHAIN }, project: "web", spec: { kind: "event", source: "github", type: "pull_request.opened" }, enabled: true, maxRunsPerHour: 30, createdBy: by } });
      await triggers.recordActivity(orgId, trigger.triggerId, { eventKey: "github:1", outcome: "started" });
      await h.db.send(new TransactWriteCommand({ TransactItems: triggers.noticeItems(orgId, trigger.triggerId, by, "a notice") }));
      return trigger;
    };
    const mine = await make(TEST_ORG, "a", MAYA.developerId);
    const theirs = await make(ORG_B, "b", OMAR.developerId);
    expect((await triggers.listNotices(TEST_ORG, MAYA.developerId)).length).toBe(1);
    const left = await h.dev(MAYA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(left.body).toMatchObject({ orgClosed: true });
    expect(await triggers.get(TEST_ORG, mine.triggerId)).toBeUndefined();
    expect(await triggers.listActivity(TEST_ORG, mine.triggerId)).toEqual([]);
    expect(await triggers.listNotices(TEST_ORG, MAYA.developerId)).toEqual([]);
    expect(h.db.find((item) => String(item.pk).startsWith(`ORG#${TEST_ORG}#TRIGGER`) || String(item.pk).startsWith(`ORG#${TEST_ORG}#TARGET_TRIGGERS`))).toEqual([]);
    expect(await triggers.get(ORG_B, theirs.triggerId)).toBeDefined();
    expect(await triggers.listActivity(ORG_B, theirs.triggerId)).toHaveLength(1);
    expect(await triggers.listNotices(ORG_B, OMAR.developerId)).toHaveLength(1);
  });
});
