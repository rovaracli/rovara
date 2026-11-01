// Enterprise foundations I3 (wiring): erasing a person from the Team record also erases the attribution change requests carry. The step runs inside erasePerson, calls the port once with
// the org and the developer, is resumed when it fails, and the broker's port rewrites the host's description, the broker's copies, and only then deletes the person's rows.
import { describe, expect, it, vi } from "vitest";
import { orgMemberKey, type OrgId } from "@agentx/contracts";
import { erasePerson } from "../../packages/broker/src/team-record/erase.js";
import { attributionErasureOf } from "../../packages/broker/src/aws/broker/attribution-erasure.js";
import { attributionForPublication } from "../../packages/broker/src/wiring/enterprise-identity.js";
import { dynamoAttributionLinkStore } from "../../packages/broker/src/attribution/links.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { ORG_A, world } from "../support/team-record-core.js";
import { deleteDeps } from "../support/team-record-delete.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { projectRow, pullRequestDetails } from "../support/p5-world.js";

describe("the Team record's person erase runs the attribution step", () => {
  it("calls the port once with the org and the developer, and reports the step done", async () => {
    const erase = vi.fn(async () => 2);
    const d = deleteDeps(world(), { attribution: { erase } });
    const result = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e1");
    expect(erase).toHaveBeenCalledTimes(1);
    expect(erase).toHaveBeenCalledWith(ORG_A, "dev-1");
    expect(result.steps?.attribution).toBe(true);
    expect(result.complete).toBe(true);
  });

  it("a failed rewrite leaves the step unfinished (so the erase is not complete), and the next run repeats it", async () => {
    const erase = vi.fn().mockRejectedValueOnce(new Error("host down")).mockResolvedValue(1);
    const d = deleteDeps(world(), { attribution: { erase } });
    const first = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e1");
    expect(first.steps?.attribution).toBe(false);
    expect(first.complete).toBe(false);
    const second = await erasePerson(d.deps, ORG_A, { developerId: "dev-1" }, "e2");
    expect(second.steps?.attribution).toBe(true);
    expect(second.complete).toBe(true);
    expect(erase).toHaveBeenCalledTimes(2);
  });

  it("a person known only by a source identity is named on no change request: the port is not called", async () => {
    const erase = vi.fn(async () => 0);
    const d = deleteDeps(world(), { attribution: { erase } });
    const result = await erasePerson(d.deps, ORG_A, { identities: [{ system: "slack:T1", sourceId: "U1" }], projects: ["web"] }, "e1");
    expect(erase).not.toHaveBeenCalled();
    expect(result.steps?.attribution).toBe(true);
  });
});

describe("the broker's port", () => {
  const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
  const maya = "a".repeat(64), priya = "b".repeat(64);
  const TASK = "11111111-1111-4111-8111-111111111111";
  const WORKSPACE = "ws-1";
  const URL = "https://github.com/example/demo.git";

  async function setup() {
    const db = new FakeDynamoDb();
    for (const [id, name] of [[maya, "Maya Chen"], [priya, "Priya Raman"]] as const) {
      db.set({ ...orgMemberKey(org, id), orgId: org, developerId: id, role: "member", joinedAt: "2026-10-01T00:00:00Z" });
      db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name });
    }
    const body = "Summary\nRequested by: Maya Chen\nPlan approved by: Priya Raman\n";
    db.set({ ...taskKey(TASK), entityType: "DEVTASK", taskId: TASK, workspaceId: WORKSPACE, orgId: org, project: "demo", startingRevision: 1 });
    db.set(projectRow([{ name: "demo", url: URL }], "demo", 1, org));
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "PULL_REQUEST#demo#000000000007", entityType: "PULL_REQUEST", repositoryUrl: URL, number: 7, body });
    db.set({ pk: `WORKSPACE#${WORKSPACE}`, sk: "OPERATION#op-1", entityType: "OPERATION", id: "op-1", publication: { title: "t", body, outboxId: "ob-1" } });
    db.set({ pk: "OUTBOX#ob-1", sk: "OUTBOX", id: "ob-1", entityType: "OUTBOX", status: "PENDING", operationId: "op-1", workspaceId: WORKSPACE,
      invocation: { kind: "publish", payload: { title: "t", body, attribution: { requester: { state: "named", name: "Maya Chen", ref: "0123456789abcdef" }, approver: { state: "named", name: "Priya Raman", ref: "fedcba9876543210" } } } } });
    const host = { body, reads: 0, failReads: false };
    const dependencies = {
      documentClient: db, tableName: "state", cloud: false,
      githubPullRequests: {
        getPullRequest: async () => { host.reads += 1; if (host.failReads) throw new Error("host down"); return pullRequestDetails(7, { body: host.body }); },
        updatePullRequest: async (_url: string, _number: number, patch: { body?: string }) => { if (patch.body !== undefined) host.body = patch.body; return pullRequestDetails(7, { body: host.body }); },
      },
    };
    const tables = { documentClient: db, stateTable: "state", signInTable: "state", teamRecordTable: "state" };
    const decisions = [{ requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 1, decision: "APPROVE", actorId: priya, actorRole: "TASK_OWNER", reason: "ok", at: "2026-10-31T10:00:00.000Z" }];
    await attributionForPublication(tables, { orgId: org, taskId: TASK, requesterId: maya, decisions, origin: "https://rovara.example" });
    return { db, host, port: attributionErasureOf(dependencies as never), links: dynamoAttributionLinkStore({ documentClient: db, tableName: "state" }) };
  }

  it("rewrites the person's line on the host and in the broker's copies, leaves the other person's line, and deletes the person's rows last", async () => {
    const { db, host, port, links } = await setup();
    expect(await port.erase(org, maya)).toBe(1);
    expect(host.body).toBe("Summary\nRequested by: a former member\nPlan approved by: Priya Raman\n");
    const pr = db.get(`WORKSPACE#${WORKSPACE}`, "PULL_REQUEST#demo#000000000007") as { body: string };
    const operation = db.get(`WORKSPACE#${WORKSPACE}`, "OPERATION#op-1") as { publication: { title: string; body: string; outboxId: string } };
    expect(pr.body).toBe(host.body);
    expect(operation.publication).toEqual({ title: "t", body: host.body, outboxId: "ob-1" });
    // The pending outbox item that would carry the description and the attribution to the worker is rewritten too, for the erased person only.
    const outbox = db.get("OUTBOX#ob-1", "OUTBOX") as { invocation: { payload: { body: string; attribution: Record<string, unknown> } } };
    expect(outbox.invocation.payload.body).toBe(host.body);
    expect(outbox.invocation.payload.attribution.requester).toEqual({ state: "former" });
    expect(outbox.invocation.payload.attribution.approver).toEqual({ state: "named", name: "Priya Raman", ref: "fedcba9876543210" });
    expect(JSON.stringify(outbox)).not.toContain("Maya");
    expect(await links.linksOf(org, maya)).toEqual([]);
    // Priya, the approver, is untouched.
    expect((await links.linksOf(org, priya)).length).toBe(1);
  });

  it("a host that cannot be read keeps the person's rows, and the retry finishes", async () => {
    const { host, port, links } = await setup();
    host.failReads = true;
    await expect(port.erase(org, maya)).rejects.toThrow("host down");
    expect((await links.linksOf(org, maya)).length).toBe(1);
    host.failReads = false;
    expect(await port.erase(org, maya)).toBe(1);
    expect(host.body).toContain("Requested by: a former member");
    expect(await links.linksOf(org, maya)).toEqual([]);
  });

  it("an outbox item that is already gone (sent and removed) is nothing to do, and an operation with no outbox id is skipped", async () => {
    const { db, host, port } = await setup();
    db.delete("OUTBOX#ob-1", "OUTBOX");
    expect(await port.erase(org, maya)).toBe(1);
    expect(host.body).toContain("Requested by: a former member");
  });

  it("is repeatable: a description that no longer names them is not written again", async () => {
    const { host, port } = await setup();
    await port.erase(org, maya);
    const before = host.body;
    expect(await port.erase(org, maya)).toBe(0);
    expect(host.body).toBe(before);
  });
});
