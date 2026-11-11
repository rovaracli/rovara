// Plan 5 Task 16 review: the reads behind a project's page are bounded. The org's Slack channel bindings (read for the project's channels) and a project's roster (read for its agents)
// are cut at a cap, and a read that was cut says so in the log, so a very large org gets a page with fewer channels or agents and never a request that reads without end.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAYA, createDeveloperTaskBroker, type Developer } from "../support/developer-task-broker.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";
import { orgProjectCatalogKey, projectAgentKey, slackBindingKey } from "@rovara-code/contracts";
import { SESSION_PROJECT_BINDINGS_MAX, PROJECT_ROSTER_LIST_MAX } from "@rovara-code/contracts";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => { vi.restoreAllMocks(); });

async function setup() {
  const members = new FakeProjectMembers();
  const h = await createDeveloperTaskBroker({ brokerExtra: { agents: { projectMembers: members } } });
  members.setOrgRole(TEST_ORG, MAYA.developerId, "owner");
  members.grant(TEST_ORG, "payments", MAYA.developerId, "maintainer");
  h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "payments"), entityType: "PROJECT_CATALOG", name: "payments" });
  const call = async (who: Developer, method: string, path: string) => {
    const reply = await h.dev(who, method, path, undefined);
    return { status: reply.status, body: reply.body };
  };
  return { h, call };
}

const loggedEvents = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls.flatMap(([line]) => {
  try { return [String((JSON.parse(String(line)) as { event?: unknown }).event)]; } catch { return []; }
});

describe("the channel bindings behind access are not cut (Round 2 review I-1)", () => {
  it("still lists a project to a member whose only route is a channel sorting past the project page's cap of bindings", async () => {
    const h = await createDeveloperTaskBroker();
    // Maya is a plain member in the channel bound to payments (C0123456789). More bindings than the project page reads, all sorting before her channel and none of them hers, are bound to another project.
    h.db.set({ ...orgProjectCatalogKey(TEST_ORG, "ledger"), entityType: "PROJECT_CATALOG", name: "ledger" });
    for (let n = 0; n < SESSION_PROJECT_BINDINGS_MAX + 5; n += 1) {
      const channelId = `A${String(n).padStart(10, "0")}`;
      h.db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, channelId), entityType: "SLACK_CHANNEL_BINDING", projectName: "ledger", channelId });
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const listed = await h.dev(MAYA, "GET", "/v1/app/projects");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body.projects as Array<{ name: string }>).map((project) => project.name)).toEqual(["payments"]);
    expect(loggedEvents(log)).not.toContain("slack_bindings.truncated");
  });
});

describe("the project page's bounded reads", () => {
  it("reads at most SESSION_PROJECT_BINDINGS_MAX channel bindings and says so in the log when it cut", async () => {
    const { h, call } = await setup();
    for (let n = 0; n < SESSION_PROJECT_BINDINGS_MAX + 5; n += 1) {
      h.db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, `C${String(n).padStart(10, "0")}`), entityType: "SLACK_CHANNEL_BINDING", projectName: "payments", channelId: `C${String(n).padStart(10, "0")}` });
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const overview = await call(MAYA, "GET", "/v1/app/projects/payments/overview");
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(loggedEvents(log)).toContain("project_page.bindings_truncated");
  });

  it("does not log a cut for a few bindings", async () => {
    const { h, call } = await setup();
    h.db.set({ ...slackBindingKey(TEST_ORG, SLACK_TEAM, "C0000000001"), entityType: "SLACK_CHANNEL_BINDING", projectName: "payments", channelId: "C0000000001" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await call(MAYA, "GET", "/v1/app/projects/payments/overview")).status).toBe(200);
    expect(loggedEvents(log)).not.toContain("project_page.bindings_truncated");
  });

  const rosterWithAgents = async (extra: number) => {
    const { h, call } = await setup();
    const ids = Array.from({ length: PROJECT_ROSTER_LIST_MAX + extra }, (_, n) => `agt_${String(n).padStart(20, "0")}`);
    for (const agentId of ids) h.db.set({ ...projectAgentKey(TEST_ORG, "payments", agentId), entityType: "PROJECT_AGENT", agentId, addedBy: MAYA.developerId, addedAt: "2026-10-24T00:00:00.000Z" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reads = vi.spyOn(h.db, "send");
    const agentReads = () => reads.mock.calls.filter(([command]) => {
      const key = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
      return key?.sk === "META" && String(key.pk).includes("AGENT#agt_");
    }).length;
    return { call, log, agentReads, ids };
  };

  it("looks at no more than PROJECT_ROSTER_LIST_MAX entries of a roster for the project page and says so in the log when it cut", async () => {
    const { call, log, agentReads } = await rosterWithAgents(7);
    const overview = await call(MAYA, "GET", "/v1/app/projects/payments/overview");
    expect(overview.status, JSON.stringify(overview.body)).toBe(200);
    expect(loggedEvents(log)).toContain("roster.list_truncated");
    expect(agentReads()).toBeLessThanOrEqual(PROJECT_ROSTER_LIST_MAX);
  });

  it("does not cut the roster the public roster route lists (Round 2 review M-1)", async () => {
    const { call, log, agentReads, ids } = await rosterWithAgents(7);
    const listed = await call(MAYA, "GET", "/v1/app/projects/payments/agents");
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(loggedEvents(log)).not.toContain("roster.list_truncated");
    expect(agentReads()).toBe(ids.length);
  });

  it("does not log a cut for a short roster", async () => {
    const { call } = await setup();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect((await call(MAYA, "GET", "/v1/app/projects/payments/agents")).status).toBe(200);
    expect(loggedEvents(log)).not.toContain("roster.list_truncated");
  });
});
