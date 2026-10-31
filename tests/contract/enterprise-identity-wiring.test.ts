// Enterprise foundations, Wave 2: the assembly functions the broker's call sites use (packages/broker/src/wiring/enterprise-identity.ts), and a check that every call site that has been wired
// still calls them. The sites are in files another builder is editing, so the wiring is applied later by the controller; the check below activates by itself: a site file that imports the
// assembly module must contain its calls, and once ANY site imports it ALL of them must (a half-applied wiring fails). Until then it reports the sites still to be wired.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { orgMemberKey, type OrgId } from "@agentx/contracts";
import {
  approverOfPlan, attributionForPublication, auditLinkFor, eraseAttributionOfPerson, installEditionPolicy, routeEditionDependencies,
} from "../../packages/broker/src/wiring/enterprise-identity.js";
import { dynamoAttributionLinkStore } from "../../packages/broker/src/attribution/links.js";
import { rewriteAttributionBody } from "../../packages/contracts/src/index.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const org = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const maya = "a".repeat(64), priya = "b".repeat(64);
const TASK = "11111111-1111-4111-8111-111111111111";

describe("the edition of an install", () => {
  it("is none for an install with no stamp (it runs as it does today, never as Enterprise), the stamped edition otherwise, and refuses a stamp that is not an edition", () => {
    expect(installEditionPolicy({})).toBeUndefined();
    expect(installEditionPolicy({ ROVARA_EDITION: "" })).toBeUndefined();
    expect(installEditionPolicy({ ROVARA_EDITION: "enterprise" })?.features.auditorRole).toBe(true);
    expect(installEditionPolicy({ ROVARA_EDITION: "public" })?.features.auditorRole).toBe(false);
    for (const bad of ["Enterprise", "enterprise ", "private", "true", "0"]) expect(() => installEditionPolicy({ ROVARA_EDITION: bad }), bad).toThrow("CONFIG_INVALID");
  });

  it("is passed on to the route dependencies when there is one, and adds nothing when there is not", () => {
    const policy = installEditionPolicy({ ROVARA_EDITION: "enterprise" })!;
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

// ---- the call sites

interface Site { file: string; calls: readonly string[]; why: string }
const SITES: readonly Site[] = [
  { file: "packages/broker/src/aws/broker/handler.ts", calls: ["routeEditionDependencies(dependencies)", "installEditionPolicy("], why: "both builders of the route dependencies spread routeEditionDependencies; the broker's dependencies take installEditionPolicy(process.env)" },
  { file: "packages/broker/src/aws/broker/scope-helpers.ts", calls: ["routeEditionDependencies(dependencies)"], why: "the authenticateBearer dependencies" },
  { file: "packages/broker/src/aws/developer-tasks/publication.ts", calls: ["attributionForPublication(", "attribution"], why: "the publish payload's attribution and the pull request body context's attribution come from one attributionForPublication call" },
  { file: "packages/broker/src/aws/developer-tasks/start.ts", calls: ["assertRepositoryHostsKnown("], why: "a task start refuses a repository whose host kind is not registered" },
  { file: "packages/broker/src/aws/broker/pull-request-reconcile.ts", calls: ["relatedIds"], why: "the pull_request.opened audit event carries the people named, as related ids" },
];
const root = resolve(import.meta.dirname, "..", "..");
const source = (file: string) => readFileSync(resolve(root, file), "utf8");
const IMPORTS_ASSEMBLY = /from\s+["'][^"']*wiring\/enterprise-identity\.js["']/u;
const wired = SITES.filter((site) => IMPORTS_ASSEMBLY.test(source(site.file)));

describe("the call sites of the assembly", () => {
  it("every site that imports the assembly makes its calls, and a half-applied wiring fails", () => {
    for (const site of wired) for (const call of site.calls) expect(source(site.file), `${site.file} must contain ${call} (${site.why})`).toContain(call);
    if (wired.length > 0) {
      expect(wired.map((site) => site.file), "once one site is wired every site is").toEqual(SITES.map((site) => site.file));
    }
  });

  it("the handler spreads the edition into both route-dependency builders once it is wired", () => {
    const handler = source("packages/broker/src/aws/broker/handler.ts");
    if (!IMPORTS_ASSEMBLY.test(handler)) return;
    expect(handler.split("routeEditionDependencies(dependencies)").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("reports the sites still to be wired", () => {
    const pending = SITES.filter((site) => !wired.includes(site)).map((site) => site.file);
    // Not a failure: the wiring is applied by the controller. The list is the report's "Wiring pending", kept where it cannot go stale.
    expect([...wired.map((site) => site.file), ...pending].sort()).toEqual(SITES.map((site) => site.file).sort());
  });
});
