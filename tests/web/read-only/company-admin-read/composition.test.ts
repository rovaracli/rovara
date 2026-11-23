// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { audit, project, refused, reply, settings } from "./fixtures.js";
import { mount } from "./mount.js";

const pages = ["/app/admin", "/app/admin/settings", "/app/admin/audit"] as const;
const here = () => screen.getByRole("region", { name: "Company administration" });
const writeButtons = /^(Change rules|Save rules|Add a rule|Approve this change|Reject this change|Withdraw my change|Remove rule \d+)$/;

// A failed read draws the one 4e error block (retry and a copyable reference) and no write control: the actions need a confirmed read.
it.each(pages)("failed read at %s shows one 4e error block with a retry and a copyable reference, and no write control", async path => {
 await mount(path, r => r.path === "/v1/app/me" ? reply(r) : refused(503));
 const alert = await screen.findByText("Rovara couldn't read this page");
 const block = alert.closest("section")!;
 expect(block.textContent).toContain("Rovara can't tell yet. The latest read failed");
 expect(within(block).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Load again", "Copy reference"]);
 expect(block.textContent).toMatch(/Ref [A-Z-]+READ-FAILED/);
 expect(within(here()).queryAllByRole("button").filter(button => writeButtons.test(button.textContent ?? ""))).toHaveLength(0);
 expect(screen.getAllByText("Rovara couldn't read this page")).toHaveLength(1);
});
it("a refused read (access lost) wipes the details and shows the 4e error block with its own reference (DEC 324)", async () => {
 await mount("/app/admin/audit", r => r.path.startsWith("/v1/app/company/audit") ? refused(403) : reply(r));
 const alert = (await screen.findByText("Rovara couldn't read this page")).closest("section")!;
 expect(alert.textContent).toContain("This read is no longer available to you.");
 expect(alert.textContent).toMatch(/Ref [A-Z-]+ACCESS-LOST/);
 expect(within(alert).getAllByRole("button").map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Load again", "Copy reference"]);
 expect(screen.queryByText("Updated company rules")).toBeNull();
});
it("a member with no records still sees the directory, with a zero count in the header", async () => {
 await mount("/app/admin", r => r.path === "/v1/app/org/members" ? { status: 200, body: { members: [] } } : reply(r));
 expect((await screen.findAllByText(/0 people/)).length).toBeGreaterThan(0);
 expect(within(screen.getByRole("list", { name: "Needs an owner or admin" })).getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 expect(within(screen.getByRole("list", { name: "Company destinations" })).getAllByRole("listitem")).toHaveLength(7);
});
it("shows the current rules once in Company policy when no change is pending, with Change rules offered and no pending card", async () => {
 await mount("/app/admin/settings", r => r.path === "/v1/app/org/settings" ? { status: 200, body: settings } : reply(r));
 await screen.findByText("Review changes before merging");
 expect(screen.getAllByText("Review changes before merging")).toHaveLength(1);
 // G1 SHIP: the old "No pending change was returned." card is dropped (nothing is drawn when nothing is pending).
 expect(screen.queryByText("No pending change was returned.")).toBeNull();
 expect(screen.queryByText("A change is waiting for approval")).toBeNull();
 expect(screen.getByRole("button", { name: "Change rules" })).toBeTruthy();
 expect(screen.getByRole("heading", { level: 3, name: "Company rules" })).toBeTruthy();
 expect(screen.queryByText("Waiting for approval")).toBeNull();
});
it("the pending block compares the rules now with the rules if approved, each once", async () => {
 await mount("/app/admin/settings");
 const block = (await screen.findByText("Review every change")).closest("section")!;
 expect(within(block).getByText("Now, and still in force")).toBeTruthy();
 expect(within(block).getByText("If approved")).toBeTruthy();
 expect(within(block).getAllByText("Review changes before merging")).toHaveLength(1);
 expect(within(block).getByText("Another admin")).toBeTruthy();
 expect(screen.queryByRole("heading", { level: 3, name: "Company rules" })).toBeNull();
});
it("the pending block marks what changes in words: the rule only in force is Removed, the rule only proposed is Added", async () => {
 await mount("/app/admin/settings");
 const block = (await screen.findByText("Review every change")).closest("section")!;
 const removed = within(block).getByText("Review changes before merging").closest("li")!;
 const added = within(block).getByText("Review every change").closest("li")!;
 expect(removed.getAttribute("data-change")).toBe("removed");
 expect(within(removed).getByText("Removed")).toBeTruthy();
 expect(added.getAttribute("data-change")).toBe("added");
 expect(within(added).getByText("Added")).toBeTruthy();
});
it("draws the audit as a table with one row per record and a held coverage note", async () => {
 await mount("/app/admin/audit");
 const table = await screen.findByRole("table", { name: /Recorded company actions · 1 on this page/ });
 expect(within(table).getAllByRole("columnheader").map(cell => cell.textContent)).toEqual(["When", "Who", "What", "Result", "Recorded by"]);
 expect(within(table).getAllByRole("row")).toHaveLength(2);
 expect(screen.getByRole("complementary", { name: "Coverage" }).textContent).toMatch(/can't tell yet whether this is the complete history/);
 expect(screen.getByText(/Partly read/)).toBeTruthy();
 expect(screen.getByText(/End of this range\. Rovara can't tell if older history exists/)).toBeTruthy();
 // G1 SHIP: "Load older events" is the live page's Previous page / Next page again; with no cursor, Next is disabled and Previous (page 1) is disabled.
 expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
 expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
 expect(screen.getByRole("status", { name: "Audit records shown on this page" }).textContent).toBe("Page 1: 1 record, up to 50 per page.");
 expect(audit.records).toHaveLength(1);
});
it("working branches: one Unknown for the saved branch, one held line, no saved branch invented", async () => {
 const two = { ...project, repositories: [...project.repositories, { name: "worker", fullName: "acme/payments-worker", defaultBranch: "main" }] };
 await mount("/app/admin/projects/payments", r => r.path === "/v1/app/projects/payments" ? { status: 200, body: two } : reply(r));
 const list = await screen.findByRole("list", { name: "Repository branches" });
 const rows = within(list).getAllByRole("listitem");
 expect(rows).toHaveLength(2);
 for (const row of rows) expect(within(row).queryAllByRole("img", { name: "Unknown" })).toHaveLength(0);
 expect(screen.getAllByRole("img", { name: "Unknown" })).toHaveLength(1);
 expect(screen.getAllByText(/can't tell yet which working branch/i)).toHaveLength(1);
 expect(screen.getByRole("heading", { level: 2, name: "Working branches" })).toBeTruthy();
 // The project page keeps its own title (level 1): the panel is a section of that page, not a page.
 expect(screen.getByRole("heading", { level: 1, name: "payments" })).toBeTruthy();
});
it("times follow the viewer's own clock and never name a fixed zone", async () => {
 await mount("/app/admin/settings");
 const block = (await screen.findByText("Review every change")).closest("section")!;
 expect(block.textContent).toMatch(/Proposed (today \d\d:\d\d|\d{1,2} [A-Z][a-z]{2} \d\d:\d\d) · open until/);
 expect(block.textContent).not.toMatch(/UTC|GMT/);
 expect(block.querySelectorAll("time")).toHaveLength(2);
});
it("audit results use the shared chip look: recorded reads Done, an unconfirmed outcome is a neutral chip", async () => {
 const rows = [{ ...audit.records[0]!, id: "a", outcome: "recorded" }, { ...audit.records[0]!, id: "b", outcome: "not confirmed" }];
 await mount("/app/admin/audit", r => r.path.startsWith("/v1/app/company/audit") ? { status: 200, body: { ...audit, records: rows } } : reply(r));
 const table = await screen.findByRole("table");
 expect(within(table).getByText("Done").closest(".rv-status-chip")?.getAttribute("data-hue")).toBe("ok");
 expect(within(table).getByText("Not confirmed").closest(".rv-status-chip")?.getAttribute("data-hue")).toBe("idle");
 expect(table.textContent).not.toMatch(/UTC/);
});
