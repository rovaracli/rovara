// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { mount } from "./mount.js";
import { checklist, identity, refusal, respond, run } from "./fixtures.js";

it("preserves onboard project and step=agents for the observed workflow roster", async () => {
 const f = mount("/app/onboard?project=web&step=agents#workflows", r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: "admin" } } } : respond(r));
 await screen.findByRole("heading", { name: "web", level: 1 });
 expect(await screen.findByText("Review")).toBeTruthy();
 expect(screen.getByText("Used in this project").nextElementSibling?.textContent).toMatch(/can't be told yet/);
 expect(f.request.mock.calls.some(([r]) => r.path.includes("agents?project="))).toBe(false);
 expect(document.querySelectorAll("form,input,select,button:not([data-read-retry])")).toHaveLength(0);
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true); f.close();
});
it.each(["/app/onboard?project=web&step=finish", "/app/projects/web#setup"])("reads checklist, progress and journal from the %s slot", async path => {
 const f = mount(path);
 expect(await screen.findByText("25% complete")).toBeTruthy();
 expect(await screen.findByText("Skipped (optional)")).toBeTruthy();
 expect(await screen.findByText("npm run check")).toBeTruthy();
 expect(screen.getByText("Exit unknown")).toBeTruthy();
 expect(screen.getByText("Waiting for an administrator")).toBeTruthy();
 expect(document.body.textContent).not.toContain("100% complete");
 expect(document.querySelectorAll("form,input,textarea,button:not([data-read-retry])")).toHaveLength(0);
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true); f.close();
});
it("company progress uses observed connections and never invents an overall percent", async () => {
 const f = mount("/app/onboard");
 expect(await screen.findByText("GitHub connected")).toBeTruthy();
 expect(await screen.findByText("Slack not added (optional)")).toBeTruthy();
 expect(document.querySelector("#g5-company-setup .rv-status-chip")?.getAttribute("data-state")).toBe("unknown");
 expect(document.querySelector("progress")).toBeNull(); f.close();
});
it.each(["/v1/app/projects/web/setup-status", "/v1/app/projects/web/setup-agent", "/v1/app/projects/web/setup-agent/journal", "/v1/app/agents?scope=all", "/v1/app/github/connections", "/v1/app/slack"])("R1 drops cached setup facts after %s fails", async endpoint => {
 let failed = false;
 const path = endpoint.includes("agents?") ? "/app/onboard?project=web&step=agents" : endpoint.includes("/projects/") ? "/app/onboard?project=web" : "/app/onboard";
 const label = endpoint.endsWith("setup-status") ? "25% complete" : endpoint.endsWith("setup-agent") ? "Setup is running" : endpoint.endsWith("journal") ? "npm run check" : endpoint.includes("scope=all") ? "Review" : endpoint.includes("project=web") ? "On project" : endpoint.endsWith("connections") ? "GitHub connected" : "Slack not added (optional)";
 const f = mount(path, r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, orgRole: "admin" } } } : failed && r.path === endpoint ? refusal(403) : respond(r));
 await screen.findByText(label); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await waitFor(() => expect(screen.queryByText(label)).toBeNull());
 expect(document.body.textContent).toContain("Can't tell yet"); f.close();
});
it("R4 does not infer completion from a later wizard step or ready run", async () => {
 const f = mount("/app/onboard?project=web&step=finish", r => r.path.endsWith("setup-agent") ? { status: 200, body: { ...run, status: "ready" } } : respond(r));
 expect(await screen.findByText("25% complete")).toBeTruthy();
 expect(await screen.findByText("Setup run is ready")).toBeTruthy();
 expect(screen.getByText(/Rovara can't tell yet which stage/)).toBeTruthy();
 expect(document.body.textContent).not.toContain("Setup complete"); f.close();
});
it("refuses checklist data for a different project", async () => {
 const f = mount("/app/onboard?project=web", r => r.path.endsWith("setup-status") ? { status: 200, body: { ...checklist, project: "other" } } : respond(r));
 await screen.findByRole("heading", { name: "Project setup checklist" });
 await waitFor(() => expect(screen.getAllByText(/Can't tell yet/).length).toBeGreaterThan(0));
 expect(screen.queryByText("25% complete")).toBeNull(); f.close();
});
