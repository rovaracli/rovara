// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { mount } from "./mount.js";

const here = () => screen.getByRole("region", { name: "Company administration" });
// Catches a missing/misrouted G1 leaf and loss of canonical selection, through the REAL router.
it.each([
 ["/app/admin", "Acme", "3 people"],
 ["/app/admin/settings?tab=pending#pending-change", "Company settings", "Review every change"],
 ["/app/admin/audit", "Audit", "Updated company rules"],
 ["/app/admin/projects/payments?tab=working-branches#working-branches", "Working branches", "acme/payments-api"],
])("mounts the assigned entry at %s", async (path, heading, fact) => {
 const app = await mount(path);
 expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
 expect((await screen.findAllByText(fact, { exact: false })).length).toBeGreaterThan(0);
 expect(app.router.state.location.pathname + app.router.state.location.search + app.router.state.location.hash).toBe(path);
 app.close();
});

// The rebuilt layouts follow the owner-approved v2 boards; the structure that must hold is asserted directly.
it("keeps the company directory in the approved order, every row a link to the page that owns it", async () => {
 await mount("/app/admin");
 await screen.findByText(/Owners: Ana/);
 const directory = await screen.findByRole("list", { name: "Company destinations" });
 expect(within(here()).getAllByRole("heading", { level: 2 }).map(node => node.textContent)).toEqual(["Needs an owner or admin", "Company pages"]);
 const entries = within(directory).getAllByRole("listitem");
 expect(entries.map(entry => within(entry).getByRole("heading", { level: 3 }).textContent)).toEqual(["People", "Money", "Connections", "Rules", "Audit", "Settings", "Agents"]);
 expect(within(here()).getByRole("heading", { level: 1 }).textContent).toBe("Acme");
 expect(entries[0]!.textContent).toMatch(/3 people · 2 owners and admins/);
 expect(screen.getByText(/Owners: Ana · 3 people/)).toBeTruthy();
 expect(entries.map(entry => within(entry).getByRole("link").getAttribute("href"))).toEqual(["/app/admin/people", "/app/admin/money/budgets", "/app/admin/connections", "/app/admin/how-we-work", "/app/admin/audit", "/app/admin/settings", "/app/agents"]);
});

it("keeps the settings blocks, with every 'edited elsewhere' row a link", async () => {
 await mount("/app/admin/settings");
 await screen.findByText("Review every change");
 expect(within(here()).getByRole("heading", { level: 1 }).textContent).toBe("Company settings");
 expect(within(here()).getAllByRole("heading", { level: 2 }).map(node => node.textContent)).toEqual(["A change is waiting for approval", "Company policy", "Monthly limit", "Company", "Nightly upkeep for the company", "Edited elsewhere, one home each"]);
 // The knowledge switch and the outbound addresses draw their own cards only when their own reads are served (their live tests prove them); this fixture serves neither.
 const company = screen.getByRole("region", { name: "Company" });
 expect(within(company).getByText("Company name")).toBeTruthy();
 expect(within(company).getByText("Acme")).toBeTruthy();
 const elsewhere = screen.getByRole("region", { name: "Edited elsewhere, one home each" });
 const links = within(within(elsewhere).getByRole("list")).getAllByRole("link");
 expect(links.map(link => [link.getAttribute("aria-label"), link.getAttribute("href")])).toEqual([["Money", "/app/admin/money/budgets"], ["People", "/app/admin/people"], ["Connections", "/app/admin/connections"], ["Projects", "/app/admin/projects"], ["How we work", "/app/admin/how-we-work"]]);
 expect(screen.queryByText("A settings change is not confirmed")).toBeNull();
 // G1 SHIP: a change the viewer can approve wears the "Needs you" chip (Waiting for approval stays for a change the viewer proposed, see company-admin-mount.test.ts).
 expect(screen.getByText("Needs you")).toBeTruthy();
 expect(screen.getByText("Nothing has changed yet", { exact: false })).toBeTruthy();
 expect(screen.getByRole("navigation", { name: "Breadcrumb" }).textContent).toContain("Settings");
});
