// @vitest-environment jsdom
import { expect, it } from "vitest";
import { onlineManager } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { audit, identity, pendingSettings, project, refused, reply, settings, sceneRoute, sceneResponder } from "./fixtures.js";
const notNav = (app: { request: { mock: { calls: readonly (readonly [{ path: string }])[] } } }) => app.request.mock.calls.map(([r]) => r.path).filter(path => path !== "/v1/app/nav" && !path.startsWith("/v1/app/inbox"));
import { readFileSync } from "node:fs";
import { z } from "zod";
const heldStates = z.array(z.object({ id: z.string(), section: z.number(), classification: z.string(), fallback: z.string() })).parse(JSON.parse(readFileSync("tests/web/read-only/company-admin-read/held-states.json", "utf8")));
import { mount } from "./mount.js";

// R1: the shared access-only eviction (DEC 254zzz324): 401 / 403 / 404 clear the facts (a LATER 404 too), on remount as well. A transient failure is the next test.
it.each([401, 403, 404])("removes cached settings after a %s refetch and on remount, with the access-lost block", async status => {
 let fail = false;
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" && fail ? refused(status) : reply(r));
 await screen.findByText("Review changes before merging");
 fail = true;
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).toMatch(/Ref [A-Z-]+ACCESS-LOST/);
 expect(screen.queryByText("Review changes before merging")).toBeNull();
 expect(screen.queryByText("Review every change")).toBeNull();
 expect(screen.queryByText(/Reconnecting/)).toBeNull();
 app.unmount();
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? refused(status) : reply(r), app.query);
 await screen.findByRole("alert");
 expect(screen.queryByText("Review changes before merging")).toBeNull();
});
it.each([503, 0])("keeps the last settings with ONE Updated / Reconnecting line after a %s re-read, every action disabled, and removes the line when a read answers", async status => {
 let fail = false;
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" && fail ? refused(status) : reply(r));
 await screen.findByText("Review every change");
 fail = true;
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 await screen.findByText(/Updated .* · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText("Review every change")).toBeTruthy();
 expect(screen.queryByText("Rovara couldn't read this page")).toBeNull();
 for (const name of ["Approve this change", "Reject this change"]) expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Approve this change" }));
 expect(app.request.mock.calls.filter(([r]) => r.method !== "GET")).toHaveLength(0);
 fail = false;
 fireEvent.click(screen.getByRole("button", { name: "Read company settings again" }));
 await waitFor(() => expect(screen.queryByText(/Reconnecting/)).toBeNull());
 expect(screen.getByRole("button", { name: "Approve this change" }).hasAttribute("disabled")).toBe(false);
 app.close();
});
it("a first read that fails with a transient error has no earlier facts to keep: the one 4e block, not an access-lost one", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? refused(503) : reply(r));
 const block = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(block.textContent).toMatch(/Ref [A-Z-]+READ-FAILED/);
 expect(block.textContent).not.toMatch(/ACCESS-LOST/);
});
it("drops all private details when identity is refused on recheck", async () => {
 let fail = false;
 const app = await mount("/app/admin/settings", r => fail && r.path === "/v1/app/me" ? refused() : reply(r));
 await screen.findByText("Review every change");
 fail = true;
 await act(async () => { await app.query.refetchQueries({ queryKey: ["admin", "identity"] }); });
 await screen.findByRole("heading", { name: "Administration unavailable" });
 expect(screen.queryByText("Review every change")).toBeNull();
 // The admin area purges every cached read of the pages, the rebuilt ones included (they live under ["admin", "lane-c"]).
 expect(app.query.getQueryCache().findAll({ queryKey: ["admin", "lane-c"] })).toHaveLength(0);
 app.close();
});
it("does not issue private reads for a member or while identity is unread", async () => {
 const app = await mount("/app/admin/settings", r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: "member" } } } : reply(r));
 await screen.findByRole("heading", { name: "Administration unavailable" });
 expect(notNav(app)).toEqual(["/v1/app/me"]);
 expect(screen.queryByRole("region", { name: "Company administration" })).toBeNull();
 app.close();
});
// R4: optional missing facts are unknown, not inferred from an empty reader result.
it("does not turn absent branch data into a default branch choice", async () => {
 await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? { status: 200, body: { ...project } } : reply(r));
 await screen.findByText(/can't tell yet which working branch/i);
 expect(screen.queryByText("Using GitHub default branch")).toBeNull();
});
it("says 'Using GitHub default branch' only when the read carries a saved list that is empty", async () => {
 await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? { status: 200, body: { ...project, savedWorkingBranches: [] } } : reply(r));
 await screen.findByText("Using GitHub default branch");
 expect(screen.queryByText(/can't tell yet which working branch/i)).toBeNull();
});
it("does not draw another project's branches from a response for a different subject", async () => {
 await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? { status: 200, body: { ...project, name: "private-other", repositories: [{ name: "x", fullName: "acme/private-other-repo", defaultBranch: "main" }] } } : reply(r));
 await screen.findByRole("heading", { level: 2, name: "Working branches" });
 expect(screen.queryByText("acme/private-other-repo")).toBeNull();
});
it("shows saved branches as unused by tasks without claiming availability", async () => {
 await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? { status: 200, body: { ...project, savedWorkingBranches: [{ repository: "api", fullName: "acme/payments-api", branch: "work/refunds", commit: "a".repeat(40) }] } } : reply(r));
 await screen.findByText((_, node) => node?.tagName === "P" && node.textContent?.startsWith("Saved working branch work/refunds @ ") === true);
 expect(screen.getByText(/Not used by tasks yet; tasks start from the GitHub default branch/)).toBeTruthy();
 expect(screen.queryByText(/could not be found/)).toBeNull();
});
it("does not claim audit coverage from an empty or connected engine page", async () => {
 await mount("/app/admin/audit", r => r.path.startsWith("/v1/app/company/audit") ? { status: 200, body: { records: [], engine: { state: "connected" } } } : reply(r));
 await screen.findByText(/No audit records were returned for this page/);
 expect(screen.getByText(/can't tell yet whether this is the complete history/i)).toBeTruthy();
});
it("hides the previous audit page while reading another page, uses only Cloud's cursor, and Previous page goes back", async () => {
 const app = await mount("/app/admin/audit", r => r.path.startsWith("/v1/app/company/audit") ? { status: 200, body: r.path.includes("cursor=") ? { ...audit, records: [{ ...audit.records[0], id: "event-2", action: "Older recorded event" }] } : { ...audit, next: "opaque/next" } } : reply(r));
 await screen.findByText("Updated company rules");
 fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 await screen.findByText("Older recorded event");
 expect(screen.queryByText("Updated company rules")).toBeNull();
 expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toContain("Page 2:");
 expect(app.request.mock.calls.some(([r]) => r.path === "/v1/app/company/audit?limit=50&cursor=opaque%2Fnext")).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
 await screen.findByText("Updated company rules");
 expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toContain("Page 1:");
 app.close();
});
it("a next page that names the page just read is refused, not followed (no loop)", async () => {
 await mount("/app/admin/audit", r => r.path.startsWith("/v1/app/company/audit") ? { status: 200, body: r.path.includes("cursor=") ? { ...audit, next: "opaque/next" } : { ...audit, next: "opaque/next" } } : reply(r));
 await screen.findByText("Updated company rules");
 fireEvent.click(screen.getByRole("button", { name: "Next page" }));
 await screen.findByText("Rovara couldn't read this page");
});
it("distinguishes missing settings fields and malformed pending facts from empty lists", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? { status: 200, body: { companyId: identity.org.orgId, version: 2, settings: {}, pending: { changeId: "incomplete" } } } : reply(r));
 await screen.findByText(/can't tell yet which company rules/i);
 expect(screen.getByText(/can't tell yet what change is pending/i)).toBeTruthy();
 expect(screen.queryByText("No company rules were returned.")).toBeNull();
});
it("does not invent a successful save from a pending change", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? { status: 200, body: pendingSettings } : reply(r));
 await screen.findByText("Review every change");
 // G1 SHIP: a change the viewer can approve wears the "Needs you" chip (Waiting for approval stays for a change the viewer proposed, see company-admin-mount.test.ts).
 expect(screen.getByText("Needs you")).toBeTruthy();
 expect(screen.queryByText(/^Saved\./)).toBeNull();
});
it("keeps the nightly upkeep card (a live Withdraw action; DEC 254zzz226(3) hides only the upkeep's other controls)", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? { status: 200, body: { ...settings, automations: true } } : reply(r));
 await screen.findByText("Review changes before merging");
 expect(screen.getByRole("heading", { level: 2, name: "Nightly upkeep for the company" })).toBeTruthy();
});
it("holds loading without issuing dependent reads", async () => {
 const app = await mount("/app/admin", () => new Promise(() => undefined));
 await screen.findByText(/Checking administration access/);
 expect(notNav(app)).toHaveLength(1);
 app.close();
});

// R4/R5: the held inventory is consumed as actual fallback/exclusion behavior.
// Section 28 (upkeep) rows are retired with the exclusion: the upkeep card is live again (see the test above and company-admin-mount.test.ts).
it.each(heldStates.filter(row => row.classification === "HELD" && row.section !== 28))("renders the held fallback for $id", async row => {
 const app = await mount(sceneRoute(row.id), sceneResponder(row.id));
 await waitFor(() => expect(app.container.textContent).toContain(row.fallback));
 app.close();
});

it("rejects settings explicitly tagged with a different company", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? { status: 200, body: { ...settings, companyId: "org_other" } } : reply(r));
 await screen.findByRole("alert");
 expect(screen.queryByText("Review changes before merging")).toBeNull();
});
it("a paused (offline) read keeps the last facts with the Reconnecting line and no enabled action", async () => {
 const app = await mount("/app/admin/settings");
 await screen.findByText("Review every change");
 try {
  await act(async () => { onlineManager.setOnline(false); void app.query.refetchQueries({ queryKey: ["admin", "lane-c"] }); });
  await screen.findByText(/Updated .* · Reconnecting/);
  expect(screen.getByText("Review every change")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Approve this change" }).hasAttribute("disabled")).toBe(true);
 } finally { await act(async () => { onlineManager.setOnline(true); }); }
 app.close();
});
it("describes start.allow without promising a person's task eligibility", async () => {
 await mount("/app/admin/settings");
 await screen.findByText("Review changes before merging");
 expect(screen.getByText(/Starting tasks is on for the company/)).toBeTruthy();
 expect(screen.queryByText("People with project access may start tasks.")).toBeNull();
});
