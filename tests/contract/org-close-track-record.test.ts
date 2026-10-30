// Track record: closing a company erases its outcome samples, their scored copies and its run costs (the 180 and 365 day expiries are only the backstop).
// Key prefixes are written out here on purpose: the test pins what is stored, not the helper that builds it.
import { expect, it } from "vitest";
import { agentDirectoryKey, orgMemberKey, orgMetaKey, orgProjectCatalogKey } from "../../packages/contracts/src/index.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const AGENT = "agent_0123456789abcdefghij";
async function fixture() {
  const db = new FakeDynamoDb(), store = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-10-30T10:00:00.000Z") });
  const orgId = await store.createOrgWithOwner({ name: "Closing", developerId: "owner" }), other = await store.createOrgWithOwner({ name: "Other", developerId: "other" });
  const seedOrg = (org: string, projects = ["payments", "web"]) => {
    const rows: Array<{ pk: string; sk: string }> = [];
    const put = (pk: string, sk: string, entityType: string) => { const row = { pk, sk, entityType, orgId: org }; db.set(row); rows.push({ pk, sk }); };
    for (const project of projects) {
      db.set({ ...orgProjectCatalogKey(org, project), entityType: "PROJECT_CATALOG", name: project, latestRevision: 1 });
      for (const stage of ["plan_critic", "review", "check", "risk"]) {
        for (let n = 0; n < 3; n += 1) {
          put(`ORG#${org}#OUTCOME#${project}#${stage}`, `2026-0${n + 1}-01T00:00:00.000Z#task-${n}#claim#1`, "OUTCOME_SAMPLE");
          put(`ORG#${org}#OUTCOME_SCORED#${project}#${stage}`, `2026-0${n + 1}-02T00:00:00.000Z#task-${n}#claim#1`, "OUTCOME_SCORED");
        }
      }
      for (const agent of ["rovara-code", AGENT]) for (const path of ["FULL", "QUICK", "TASK", "AGENT"]) {
        put(`ORG#${org}#RUN_COST#${project}#${agent}#${path}`, "2026-10-01T00:00:00.000Z#task-1", "RUN_COST");
      }
    }
    return rows;
  };
  db.set({ ...agentDirectoryKey(orgId, AGENT), entityType: "AGENT_DIRECTORY", agentId: AGENT });
  const close = () => store.closeOrg(orgId, { archiveProjects: async () => undefined, clearEgress: async () => undefined });
  return { db, store, orgId, other, seedOrg, close };
}

it("company close erases outcome samples, scored copies and run costs of every project, and nothing of another company", async () => {
  const f = await fixture();
  const mine = f.seedOrg(f.orgId), foreign = f.seedOrg(f.other);
  const unrelated = { pk: `ORG#${f.orgId}#PROJECT#payments`, sk: "REV#0000000001", entityType: "PROJECT" };
  f.db.set(unrelated);
  expect(mine.length).toBeGreaterThan(40);
  await f.close();
  expect(mine.filter((key) => f.db.get(key) !== undefined)).toEqual([]);
  expect(foreign.filter((key) => f.db.get(key) === undefined)).toEqual([]);
  expect(f.db.get(unrelated)).toEqual(unrelated);
  expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined();
});

it("the erasure runs while the company is closing, before its owner is removed", async () => {
  const f = await fixture();
  f.seedOrg(f.orgId);
  let seen: { closing: boolean; owner: boolean } | undefined;
  const send = f.db.send.bind(f.db);
  f.db.send = async (command: { constructor: { name: string } }) => {
    if (seen === undefined && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command).includes("OUTCOME")) {
      seen = { closing: f.db.get(orgMetaKey(f.orgId))?.closingAt !== undefined, owner: f.db.get(orgMemberKey(f.orgId, "owner")) !== undefined };
    }
    return send(command as never);
  };
  await f.close();
  expect(seen).toMatchObject({ closing: true, owner: true });
});

it("a failed erasure stops the close, keeps closingAt and resumes on the next close", async () => {
  const f = await fixture();
  const mine = f.seedOrg(f.orgId);
  const send = f.db.send.bind(f.db);
  let batches = 0, fail = true;
  f.db.send = async (command: { constructor: { name: string }; input?: { TransactItems?: unknown[] } }) => {
    if (fail && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("OUTCOME")) { batches += 1; if (batches === 3) throw new Error("private database failure"); }
    return send(command as never);
  };
  await expect(f.close()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  expect(f.db.get(orgMetaKey(f.orgId))?.closingAt).toBeDefined();
  expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeUndefined();
  expect(f.db.get(orgMemberKey(f.orgId, "owner"))).toBeDefined();
  expect(mine.filter((key) => f.db.get(key) !== undefined).length).toBeGreaterThan(0);
  fail = false;
  await f.close();
  expect(mine.filter((key) => f.db.get(key) !== undefined)).toEqual([]);
  expect(f.db.get(orgMetaKey(f.orgId))?.closedAt).toBeDefined();
});
