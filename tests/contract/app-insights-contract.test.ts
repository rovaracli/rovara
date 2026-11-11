// Insights (srv/insights-reads): the shapes the browser reads and sends. Strict for what the server answers; the readers keep what a newer server adds and read a new enum value as "unknown".
import { describe, expect, it } from "vitest";
import { InsightsAccessBodySchema, InsightsAccessReaderSchema, InsightsAccessSchema, InsightsFlowReaderSchema, InsightsFlowSchema, InsightsOverviewReaderSchema, InsightsOverviewSchema, InsightsShippedReaderSchema, InsightsShippedSchema, InsightsSpendReaderSchema, InsightsSpendSchema, InsightsStuckReaderSchema, InsightsStuckSchema } from "@agentx/cloud-contracts";
import * as web from "@agentx/cloud-contracts/web";
import * as barrel from "@agentx/cloud-contracts";

const id = (digit: string) => digit.repeat(64);
const at = "2026-11-11T09:00:00.000Z";
const coverage = { sources: ["sessions", "spend_requests"], notCovered: ["change_approvals", "plan_reviews", "merge_readiness", "handoff_blockers"], partial: false, truncated: false };
const overview = {
  enabled: true,
  viewer: { role: "member", via: ["maintainer"], scope: { kind: "projects", projects: ["web"] }, contentLevel: "full_where_readable", canSeePerPerson: false },
  panels: { stuck: { status: "ready", coverage }, shipped: { status: "unavailable", collectingSince: null }, spend: { status: "ready", outcomesStatus: "unavailable" }, flow: { status: "unavailable", collectingSince: null } },
  capture: { workEvents: "off", since: null, retentionMonths: 13 }, asOf: at,
};
const full = { itemId: "ses_00000000000000000001", project: "web", blocker: "decision", state: "needs_you", stateWords: "Needs you", nextActor: { kind: "person", name: "Arjun", role: "owner" }, owner: { id: id("a"), name: "Priya" },
  since: at, sinceKind: "last_update", ageHours: 26, visibility: "full", title: "Bump the SDK", reason: "the checks didn't pass", link: "https://app.example.test/app/sessions/ses_00000000000000000001" };
const metadata = { itemId: "ses_00000000000000000002", project: "web", blocker: "unknown", state: "unknown", stateWords: "Waiting for a budget decision", nextActor: { kind: "unknown" }, since: at, sinceKind: "state", ageHours: 3, visibility: "metadata" };
const stuck = { status: "ready", asOf: at, coverage, summary: { total: 2, over24h: 1, over72h: 0, byNextActorKind: { person: 1 }, byBlocker: { decision: 1 } }, items: [full, metadata] };

describe("the Insights shapes", () => {
  it("takes every answer the server gives, and refuses a field the shape does not name", () => {
    expect(InsightsOverviewSchema.parse(overview)).toEqual(overview);
    expect(InsightsStuckSchema.parse(stuck)).toEqual(stuck);
    expect(InsightsShippedSchema.parse({ status: "unavailable", collectingSince: null, weeks: [] })).toBeDefined();
    expect(InsightsFlowSchema.parse({ days: 30, status: "unavailable", collectingSince: null, minSamples: 5, byProject: [] })).toBeDefined();
    const spend = { month: "2026-11", status: "ready", scope: "company", totals: { spentUsd: 1, committedUsd: 2 }, byProject: [{ project: "web", spentUsd: 1, committedUsd: 2, people: null, shipped: null, costPerShippedUsd: null }],
      byPerson: [{ developerId: id("b"), name: "Arjun", spentUsd: 1 }], outcomes: { status: "unavailable" } };
    expect(InsightsSpendSchema.parse(spend)).toEqual(spend);
    const access = { viewers: [{ person: { id: id("c"), name: "Max" }, grantedBy: { id: id("d"), name: "Ola" }, grantedAt: at }], eligibleCount: 3 };
    expect(InsightsAccessSchema.parse(access)).toEqual(access);
    for (const [schema, value] of [[InsightsOverviewSchema, overview], [InsightsStuckSchema, stuck], [InsightsSpendSchema, spend], [InsightsAccessSchema, access]] as const) {
      expect(schema.safeParse({ ...value, extra: 1 }).success).toBe(false);
    }
    expect(InsightsStuckSchema.safeParse({ ...stuck, items: [{ ...full, secret: "x" }] }).success).toBe(false);
  });

  it("keeps the per-person list absent, not empty, for a reader who may not have it", () => {
    const spend = { month: "2026-11", status: "ready", scope: "projects", byProject: [], outcomes: { status: "unavailable" } };
    const parsed = InsightsSpendSchema.parse(spend);
    expect("byPerson" in parsed).toBe(false);
    expect("totals" in parsed).toBe(false);
  });

  it("reads a value a newer server adds as unknown, and keeps the fields it does not know", () => {
    const read = InsightsStuckReaderSchema.parse({ ...stuck, future: 1, items: [{ ...full, blocker: "legal_hold", nextActor: { kind: "swarm" }, extra: true }] });
    expect(read.items[0]).toMatchObject({ blocker: "unknown", nextActor: { kind: "unknown" }, extra: true });
    expect(InsightsOverviewReaderSchema.parse({ ...overview, viewer: { ...overview.viewer, via: ["maintainer", "sponsor"] } }).viewer.via).toEqual(["maintainer", "unknown"]);
    expect(InsightsSpendReaderSchema.parse({ month: "2026-11", status: "ready", scope: "galaxy", byProject: [], outcomes: { status: "later" } })).toMatchObject({ scope: "unknown", outcomes: { status: "unknown" } });
    expect(InsightsShippedReaderSchema.parse({ status: "soon", collectingSince: null, weeks: [] }).status).toBe("unknown");
    expect(InsightsFlowReaderSchema.parse({ days: 30, status: "ready", collectingSince: null, minSamples: 5, byProject: [] }).status).toBe("ready");
    expect(InsightsAccessReaderSchema.parse({ viewers: [], eligibleCount: 0, future: true })).toMatchObject({ future: true });
    // A missing required value is still an error, not "unknown".
    expect(InsightsStuckReaderSchema.safeParse({ ...stuck, items: [{ ...full, blocker: undefined }] }).success).toBe(false);
  });

  it("limits what the grant sends: a strict body with a request id and a developer id", () => {
    const body = { action: "grant", requestId: "11111111-1111-4111-8111-111111111111", developerId: id("e") };
    expect(InsightsAccessBodySchema.parse(body)).toEqual(body);
    for (const bad of [{ ...body, action: "promote" }, { ...body, requestId: "x" }, { ...body, developerId: "Priya" }, { ...body, role: "admin" }, { action: "grant" }]) expect(InsightsAccessBodySchema.safeParse(bad).success).toBe(false);
  });

  it("is exported to the browser and to the broker", () => {
    expect(web.InsightsStuckReaderSchema).toBe(InsightsStuckReaderSchema);
    expect(barrel.InsightsAccessBodySchema).toBe(InsightsAccessBodySchema);
  });
});
