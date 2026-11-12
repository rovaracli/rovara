// Convergence lane A9: Cloud's Jira tracker beyond what Code's Tracker suite says (tests/conformance runs the suite): it writes only with a read-and-write connection of the ticket's own
// site, moves by the project's own status name, refuses a site it has no connection for, posts once per key, and a deliberately broken adapter fails the suite check that guards it.
import { describe, expect, it } from "vitest";
import { TrackerWriteRefusedError, type OrgId, type Tracker } from "@rovara-code/contracts";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { cloudJiraTracker, jiraSiteOf } from "../../packages/broker/src/plugins/tracker/jira/index.js";
import { trackerChecks } from "../../vendor/rovara-code/tests/support/ports/tracker-conformance.js";
import { InMemoryJiraSite, JIRA_SITE, jiraConnections, jiraWorld } from "../conformance/adapters/tracker-jira.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const SCOPE = { orgId: ORG } as const;
const ref = (id: string, url?: string) => ({ tracker: "jira", id, ...(url === undefined ? {} : { url }) });

async function readOnlyWorld() {
  const site = new InMemoryJiraSite();
  site.issues.set("PAY-1", { key: "PAY-1", summary: "s", description: "d", status: "open", labels: [], comments: [] });
  return { site, tracker: cloudJiraTracker({ connections: await jiraConnections("read"), fetch: site.fetch }) };
}

describe("the Cloud Jira tracker", () => {
  it("reads with a read connection, but never writes with one: a write is refused as needs_write_access and nothing is sent", async () => {
    const { site, tracker } = await readOnlyWorld();
    expect((await tracker.readItem(ref("PAY-1"), SCOPE)).ref).toEqual({ tracker: "jira", id: "PAY-1", url: `${JIRA_SITE}/browse/PAY-1` });
    const before = site.requests.length;
    await expect(tracker.comment!(ref("PAY-1"), "hello", SCOPE)).rejects.toEqual(new TrackerWriteRefusedError("needs_write_access"));
    await expect(tracker.setStatusByName!(ref("PAY-1"), "Done", SCOPE)).rejects.toEqual(new TrackerWriteRefusedError("needs_write_access"));
    expect(site.requests.length).toBe(before);
  });

  it("moves an item by the project's own status name, in any case, and says when there is no such status", async () => {
    const world = await jiraWorld();
    world.addItem("PAY-2", { status: "open" });
    expect(await world.tracker.setStatusByName!(ref("PAY-2"), "in review", SCOPE)).toBe("moved");
    expect(world.statusOf("PAY-2")).toBe("in_review");
    expect(await world.tracker.setStatusByName!(ref("PAY-2"), "Shipped", SCOPE)).toBe("no_such_status");
    await expect(world.tracker.setStatusByName!(ref("NOPE-9"), "Done", SCOPE)).rejects.toEqual(new TrackerWriteRefusedError("not_found"));
  });

  it("posts once per key: a retry with the same key finds its marker and posts nothing more", async () => {
    const world = await jiraWorld();
    world.addItem("PAY-3");
    await world.tracker.comment!(ref("PAY-3"), "Opened a change request.", SCOPE, { key: "task-1:opened" });
    await world.tracker.comment!(ref("PAY-3"), "Opened a change request.", SCOPE, { key: "task-1:opened" });
    expect(world.commentsOf("PAY-3")).toEqual(["Opened a change request."]);
  });

  it("sends keys only to the ticket's own Atlassian site: another site, a non-Atlassian link and several sites with no link are refused", async () => {
    const world = await jiraWorld();
    world.addItem("PAY-4");
    await expect(world.tracker.readItem(ref("PAY-4", "https://other.atlassian.net/browse/PAY-4"), SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(world.tracker.readItem(ref("PAY-4", "https://evil.example/browse/PAY-4"), SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(world.site.requests.every((request) => request.url.startsWith(`${JIRA_SITE}/`))).toBe(true);
    const connections = await jiraConnections();
    await new OrgConnectionStore(connections).put({ orgId: ORG, by: "dev-admin", connection: { connectionId: "con_jira0000000000000002", type: "jira", label: "Jira two", access: "read", siteUrl: "https://other.atlassian.net" }, secret: { email: "r@acme.test", apiToken: ["another", "fake"].join("-") } });
    const two = cloudJiraTracker({ connections, fetch: world.site.fetch });
    await expect(two.readItem(ref("PAY-4"), SCOPE)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await two.readItem(ref("PAY-4", `${JIRA_SITE}/browse/PAY-4`), SCOPE)).toMatchObject({ title: "Issue PAY-4" });
  });

  it("speaks for the install's organization under a system scope only when it has one", async () => {
    const world = await jiraWorld();
    world.addItem("PAY-5");
    expect(await world.tracker.readItem(ref("PAY-5"), { system: "install" })).toMatchObject({ ref: { id: "PAY-5" } });
    const noOrg = cloudJiraTracker({ connections: await jiraConnections(), fetch: world.site.fetch });
    await expect(noOrg.readItem(ref("PAY-5"), { system: "install" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("knows an Atlassian site only over https, with no sign-in data or port", () => {
    expect(jiraSiteOf("https://acme.atlassian.net/browse/X-1")).toBe(JIRA_SITE);
    for (const bad of ["http://acme.atlassian.net", "https://u:p@acme.atlassian.net", "https://acme.atlassian.net:444", "https://atlassian.net.evil.example", "", undefined]) expect(jiraSiteOf(bad)).toBeUndefined();
  });
});

// ---- the suite can fail: each broken adapter fails the check that guards what it breaks

describe("a broken Cloud Jira tracker fails the contract", () => {
  const check = (name: string) => trackerChecks.find((entry) => entry.name === name)!;
  it("one that accepts a call with no scope", async () => {
    const w = await jiraWorld();
    const broken: Tracker = { ...w.tracker, readItem: async (r) => w.tracker.readItem(r, SCOPE) };
    await expect(check("refuses a call with no valid scope").run({ ...w, tracker: broken })).rejects.toBeDefined();
  });
  it("one that posts an empty comment", async () => {
    const w = await jiraWorld();
    const broken: Tracker = { ...w.tracker, comment: async (r, body, scope) => w.tracker.comment!(r, body === "" ? "-" : body, scope) };
    await expect(check("writes a comment, and refuses an empty one").run({ ...w, tracker: broken })).rejects.toBeDefined();
  });
  it("one that changes the item's text", async () => {
    const w = await jiraWorld();
    const broken: Tracker = { ...w.tracker, readItem: async (r, scope) => ({ ...(await w.tracker.readItem(r, scope)), body: "cleaned" }) };
    await expect(check("reads an item fresh, as data, with its text unchanged").run({ ...w, tracker: broken })).rejects.toBeDefined();
  });
});
