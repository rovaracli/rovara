// Enterprise foundations, Wave 2: the assembly functions the broker's call sites use (packages/broker/src/wiring/enterprise-identity.ts), and a check that every call site that has been wired
// still calls them. The sites are in files another builder is editing, so the wiring is applied later by the controller; the check below activates by itself: a site file that imports the
// assembly module must contain its calls, and once ANY site imports it ALL of them must (a half-applied wiring fails). Until then it reports the sites still to be wired.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { orgMemberKey, type OrgId } from "@agentx/contracts";
import {
  approverOfPlan, attributionForPublication, auditLinkFor, eraseAttributionOfPerson, routeEditionDependencies,
} from "../../packages/broker/src/wiring/enterprise-identity.js";
import { installEditionPolicy } from "../../packages/broker/src/aws/broker/edition-wiring.js";
import { dynamoAttributionLinkStore } from "../../packages/broker/src/attribution/links.js";
import { rewriteAttributionBody } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const maya = "a".repeat(64), priya = "b".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";

describe("the edition of an install", () => {
  // The edition is built once, by the E2 wiring (aws/broker/edition-wiring.ts), and this lane only passes it on: one source, not two.
  it("is passed on to the route dependencies when there is one, and adds nothing when there is not", () => {
    const policy = installEditionPolicy({ ROVARA_EDITION: "enterprise" }, false)!;
    expect(policy.features.auditorRole).toBe(true);
    expect(installEditionPolicy({ ROVARA_EDITION: "public" }, true)!.features.auditorRole).toBe(false);
    expect(routeEditionDependencies({ editionPolicy: policy })).toEqual({ editionPolicy: policy });
    expect(routeEditionDependencies({})).toEqual({});
    expect(Object.keys(routeEditionDependencies({ editionPolicy: undefined }))).toEqual([]);
  });
});

describe("who approved the plan", () => {
  const decision = (over: Record<string, unknown>) => ({
    requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 1, decision: "APPROVE", actorId: maya, actorRole: "TASK_OWNER", reason: "ok", at: "2026-10-31T10:00:00.000Z", ...over,
  });
  it("is the latest APPROVE at the gate by a person", () => {
    expect(approverOfPlan([decision({}), decision({ actorId: priya, actorRole: "PROJECT_ADMIN", at: "2026-10-31T11:00:00.000Z" })])).toBe(priya);
    expect(approverOfPlan([decision({ actorId: priya, at: "2026-10-31T12:00:00.000Z" }), decision({ at: "2026-10-31T09:00:00.000Z" })])).toBe(priya);
  });
  it("is no one when there is no approval, and never the broker's automatic decisions, a rejection, a send back or an unreadable record", () => {
    expect(approverOfPlan([])).toBeUndefined();
    expect(approverOfPlan([decision({ decision: "REJECT" }), decision({ decision: "REQUEST_CHANGES" })])).toBeUndefined();
    expect(approverOfPlan([decision({ source: "SEND_BACK" })])).toBeUndefined();
    expect(approverOfPlan([{ nonsense: true }, null, "x"])).toBeUndefined();
    expect(approverOfPlan([decision({ decision: "APPROVE", actorRole: "AGENTX", actorId: "c".repeat(64), source: "AUTO_FIX", auto: { stage: "PLAN" } })])).toBeUndefined();
  });
});

describe("the attribution for a publication, and the erasure of a person", () => {
  function world() {
    const db = new FakeDynamoDb();
    for (const [id, name] of [[maya, "Maya Chen"], [priya, "Priya Raman"]] as const) {
      db.set({ ...orgMemberKey(org, id), orgId: org, developerId: id, role: "member", joinedAt: "2026-10-01T00:00:00Z" });
      db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name });
    }
    const tables = { documentClient: db, stateTable: "state", signInTable: "state", teamRecordTable: "state" };
    return { db, tables };
  }
  const decisions = [{ requestId: "22222222-2222-4222-8222-222222222222", workflowRevision: 1, decision: "APPROVE", actorId: priya, actorRole: "TASK_OWNER", reason: "ok", at: "2026-10-31T10:00:00.000Z" }];

  it("names the requester and the plan's approver, links both people for the audit event, and gives the audit link", async () => {
    const { tables } = world();
    const result = await attributionForPublication(tables, { orgId: org, taskId: TASK, requesterId: maya, decisions, origin: "https://rovara.example/some/path" });
    expect(result.attribution).toMatchObject({ requester: { state: "named", name: "Maya Chen" }, approver: { state: "named", name: "Priya Raman" }, auditUrl: "https://rovara.example/v1/app/audit/view?action=pull_request.opened" });
    expect(result.relatedIds).toEqual([maya, priya]);
    expect(auditLinkFor("https://rovara.example/x/y")).toBe("https://rovara.example/v1/app/audit/view?action=pull_request.opened");
  });

  it("erasing a person deletes their references and rewrites each description they were named in", async () => {
    const { db, tables } = world();
    const links = dynamoAttributionLinkStore({ documentClient: db, tableName: "state" });
    await attributionForPublication(tables, { orgId: org, taskId: TASK, requesterId: maya, decisions, origin: "https://rovara.example", links });
    const bodies = new Map([[TASK, "Requested by: Maya Chen\nPlan approved by: Priya Raman\n"]]);
    const count = await eraseAttributionOfPerson(links, org, maya, async (taskId, role) => { bodies.set(taskId, rewriteAttributionBody(bodies.get(taskId)!, role)); });
    expect(count).toBe(1);
    expect(bodies.get(TASK)).toBe("Requested by: a former member\nPlan approved by: Priya Raman\n");
    expect(JSON.stringify(db.find(() => true).filter((item) => String(item.entityType).startsWith("ATTRIBUTION")))).not.toContain(maya);
  });
});

describe("a failed rewrite does not lose the list of descriptions to rewrite (re-check New-2)", () => {
  const decisions: unknown[] = [];
  it("keeps the person's rows when a rewrite fails, has already cut the references, and a retry finishes the job", async () => {
    const db = new FakeDynamoDb();
    for (const [id, name] of [[maya, "Maya Chen"], [priya, "Priya Raman"]] as const) {
      db.set({ ...orgMemberKey(org, id), orgId: org, developerId: id, role: "member", joinedAt: "2026-10-01T00:00:00Z" });
      db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, displayName: name });
    }
    const tables = { documentClient: db, stateTable: "state", signInTable: "state", teamRecordTable: "state" };
    const links = dynamoAttributionLinkStore({ documentClient: db, tableName: "state" });
    const refs: string[] = [];
    const bodies = new Map<string, string>();
    for (const taskId of [TASK, "22222222-2222-4222-8222-222222222222"]) {
      const r = await attributionForPublication(tables, { orgId: org, taskId, requesterId: maya, decisions, origin: "https://rovara.example", links });
      if (r.attribution.requester?.state === "named") refs.push(r.attribution.requester.ref);
      bodies.set(taskId, "Requested by: Maya Chen\n");
    }
    let failOn: string | undefined = "22222222-2222-4222-8222-222222222222";
    const rewrite = async (taskId: string, role: "requester" | "approver") => {
      if (taskId === failOn) throw new Error("host down");
      bodies.set(taskId, rewriteAttributionBody(bodies.get(taskId)!, role));
    };
    await expect(eraseAttributionOfPerson(links, org, maya, rewrite)).rejects.toThrow("host down");
    // The references already lead nowhere, and the list of descriptions is still there.
    expect(await Promise.all(refs.map((ref) => links.resolve(org, ref)))).toEqual([undefined, undefined]);
    expect((await links.linksOf(org, maya)).map((link) => link.taskId).sort()).toEqual([TASK, "22222222-2222-4222-8222-222222222222"]);
    expect([...bodies.values()].some((body) => body.includes("Maya Chen"))).toBe(true);
    // The retry finds the same list and finishes: no description names the person, and no row is left.
    failOn = undefined;
    expect(await eraseAttributionOfPerson(links, org, maya, rewrite)).toBe(2);
    expect([...bodies.values()]).toEqual(["Requested by: a former member\n", "Requested by: a former member\n"]);
    expect(await links.linksOf(org, maya)).toEqual([]);
    expect(JSON.stringify(db.find(() => true).filter((item) => String(item.entityType).startsWith("ATTRIBUTION")))).not.toContain(maya);
  });
});

// ---- the call sites

interface Site { file: string; calls: readonly string[]; why: string }
const SITES: readonly Site[] = [
  { file: "packages/broker/src/aws/broker/handler.ts", calls: ["routeEditionDependencies(dependencies)"], why: "both builders of the route dependencies spread routeEditionDependencies (the edition itself is built once by installEditionPolicy in edition-wiring.ts)" },
  { file: "packages/broker/src/aws/broker/scope-helpers.ts", calls: ["routeEditionDependencies(dependencies)"], why: "the authenticateBearer dependencies" },
  { file: "packages/broker/src/aws/developer-tasks/start.ts", calls: ["assertRepositoryHostsKnown("], why: "a task start refuses a repository whose host kind is not registered" },
];
const root = resolve(import.meta.dirname, "..", "..");
const source = (file: string) => readFileSync(resolve(root, file), "utf8");
const IMPORTS_ASSEMBLY = /from\s+["'][^"']*wiring\/enterprise-identity\.js["']/u;

describe("the call sites of the assembly", () => {
  it("every site imports the assembly and makes its calls", () => {
    for (const site of SITES) {
      expect(source(site.file), `${site.file} must import the assembly`).toMatch(IMPORTS_ASSEMBLY);
      for (const call of site.calls) expect(source(site.file), `${site.file} must contain ${call} (${site.why})`).toContain(call);
    }
  });

  it("the handler spreads the edition into both route-dependency builders", () => {
    expect(source("packages/broker/src/aws/broker/handler.ts").split("routeEditionDependencies(dependencies)").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("the broker's own edition comes from one place: the assembly does not build a second policy", () => {
    expect(source("packages/broker/src/wiring/enterprise-identity.ts")).not.toMatch(/resolveEdition|function installEditionPolicy/u);
  });
});
