// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { mount } from "./mount.js";
import { identity, refusal, respond } from "./fixtures.js";

// Layout composition on the shared design system. Zero write controls stay asserted in read-only.test.ts and setup.test.ts.
it("account is one page: title, grouped sections of rows, and links to the GitHub page and key list only", async () => {
 const f = mount("/app/account");
 expect(await screen.findByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
 await screen.findByText("priya-dev");
 expect(screen.getAllByRole("heading", { level: 2 }).map(h => h.textContent)).toEqual(["You", "Signing in and identities", "Your companies", "What Rovara tells you, and where", "Learning"]);
 expect(document.querySelectorAll("ul.g5-rows")).toHaveLength(5);
 expect(screen.getByText("Linked").closest(".g5-pill")).not.toBeNull();
 expect(screen.getAllByRole("link").map(a => a.getAttribute("href"))).toEqual(["/app/account/github", "/app/account/automation-keys"]);
 expect(screen.getByText("Other companies")).toBeTruthy();
 f.close();
});
it("a failed identity read shows the 4e error block under the page title with one retry and a copyable reference", async () => {
 const f = mount("/app/account", r => r.path === "/v1/app/me" ? refusal(502) : respond(r));
 const alert = await screen.findByRole("alert");
 expect(screen.getByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
 expect(within(alert).getByRole("heading", { name: "Rovara couldn't read this page" })).toBeTruthy();
 for (const label of ["What happened", "What is safe", "What to do"]) expect(within(alert).getByText(label)).toBeTruthy();
 expect(within(alert).getByRole("button", { name: "Load again" }).hasAttribute("data-read-retry")).toBe(true);
 expect(within(alert).getByText("ACCOUNT-READ-FAILED")).toBeTruthy();
 expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL");
 f.close();
});
it("one failed section is unknown on its own and the rest of the page stays", async () => {
 const f = mount("/app/account", r => r.path === "/v1/app/me/sign-ins" ? refusal(502) : respond(r));
 await waitFor(() => expect(document.querySelector(".g5-unknown")?.textContent).toContain("Can't tell yet"));
 expect(screen.getByText("priya-dev")).toBeTruthy();
 expect(screen.getByRole("button", { name: "Check again" }).hasAttribute("data-read-retry")).toBe(true);
 f.close();
});
it("the shared read policy: a 503 re-read keeps the details with one 4f line; a 403 hides them behind the 4e block", async () => {
 for (const status of [503, 403]) {
  let failed = false;
  const f = mount("/app/account/automation-keys", r => failed && r.path === "/v1/app/script-tokens" ? refusal(status) : respond(r));
  await screen.findByText("Nightly CI"); failed = true;
  await act(async () => { await f.query.refetchQueries(); });
  if (status === 503) {
   const line = await screen.findByText(/Updated .+ · Reconnecting/);
   expect(line.hasAttribute("data-stale-line")).toBe(true);
   expect(document.querySelectorAll("[data-stale-line]")).toHaveLength(1);
   expect(screen.getByText("Nightly CI")).toBeTruthy();
  } else {
   await waitFor(() => expect(screen.queryByText("Nightly CI")).toBeNull());
   expect(screen.getByRole("alert")).toBeTruthy();
  }
  f.close();
 }
});
it("automation keys are one table with Key, Last used and State columns and a breadcrumb back", async () => {
 const f = mount("/app/account/automation-keys");
 await screen.findByText("Nightly CI");
 expect(screen.getAllByRole("columnheader").map(h => h.textContent)).toEqual(["Key", "Last used", "State"]);
 expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
 expect(document.body.textContent).toContain("3 keys · 1 active");
 expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
 f.close();
});
it("project checklist lists all eight rows, each with a state mark and its state in words", async () => {
 const f = mount("/app/onboard?project=web&step=finish");
 await screen.findByText("25% complete");
 const rows = within(screen.getByRole("list", { name: "Setup rows" })).getAllByRole("listitem");
 expect(rows).toHaveLength(8);
 expect(rows.every(row => row.querySelector(".g5-row-mark") !== null)).toBe(true);
 expect(screen.getAllByText("Optional").length).toBeGreaterThan(0);
 f.close();
});
it("a member's name section is one quiet card with no field", async () => {
 const f = mount("/app/work", r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, name: "Member 3fa9", nameChosen: false } } } : respond(r));
 expect(await screen.findByRole("heading", { name: "Choose your name" })).toBeTruthy();
 expect(document.querySelector("form,input,button")).toBeNull();
 f.close();
});
