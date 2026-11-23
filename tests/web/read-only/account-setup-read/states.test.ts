// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { mount } from "./mount.js";
import { identity, refusal, respond } from "./fixtures.js";

it.each([401, 403, 404])("R1 hides cached identity and all nested facts after the access signal %s on refetch", async status => {
 let failed = false;
 const f = mount("/app/account", r => failed && r.path === "/v1/app/me" ? refusal(status) : respond(r));
 await screen.findByText("priya-dev"); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await waitFor(() => expect(screen.queryByText("Priya")).toBeNull());
 expect(screen.queryByText("priya-dev")).toBeNull();
 expect(document.body.textContent).toContain("Can't tell yet");
 expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL");
 expect(f.host.signIn).not.toHaveBeenCalled(); f.close();
});
it.each(["/v1/app/me/github", "/v1/app/me/sign-ins", "/v1/app/me/lessons-slack", "/v1/app/script-tokens"])("R1 removes facts after a later access-ended %s read", async endpoint => {
 let failed = false;
 const path = endpoint.endsWith("script-tokens") ? "/app/account/automation-keys" : "/app/account";
 const text = endpoint.endsWith("github") ? "priya-dev" : endpoint.endsWith("sign-ins") ? "how you first signed in" : endpoint.endsWith("lessons-slack") ? /once, when its work ends/ : "Nightly CI";
 const f = mount(path, r => failed && r.path === endpoint ? refusal(403) : respond(r));
 await screen.findByText(text); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await waitFor(() => expect(screen.queryByText(text)).toBeNull());
 expect(document.body.textContent).toContain("Can't tell yet"); f.close();
});
it.each([404, 501, 502])("R4 unknown reads %s never say disconnected or empty", async status => {
 const f = mount("/app/account", r => r.path === "/v1/app/me" ? respond(r) : refusal(status));
 await screen.findByRole("heading", { name: "Account" });
 await waitFor(() => expect(screen.getAllByText(/Can't tell yet/).length).toBeGreaterThan(0));
 expect(document.body.textContent).not.toMatch(/No GitHub account connected|No connected sign-ins|Your Slack replies are left out/); f.close();
});
it("R4 ignores callback claims and explains a missing name without synthesizing one", async () => {
 const f = mount("/app/work?github_link=linked", r => r.path === "/v1/app/me" ? { status: 200, body: { ...identity, developer: { ...identity.developer, name: "Member 3fa9", nameChosen: false } } } : respond(r));
 expect(await screen.findByText(/You haven't chosen a name yet\./)).toBeTruthy();
 expect(document.body.textContent).not.toContain("Member 3fa9"); f.close();
});
it("R4 identity changes isolate cached key facts by company AND person", async () => {
 let changed = false;
 const f = mount("/app/account/automation-keys", r => {
  if (!changed) return respond(r);
  if (r.path === "/v1/app/me") return { status: 200, body: { ...identity, developer: { ...identity.developer, id: "b".repeat(64) }, org: { ...identity.org, orgId: "org_other", name: "Other" } } };
  return new Promise(() => undefined);
 });
 await screen.findByText("Nightly CI"); changed = true;
 await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me") }); });
 await waitFor(() => expect(screen.queryByText("Nightly CI")).toBeNull()); f.close();
});
it("R5 malformed metadata is unknown rather than an empty success", async () => {
 const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
 const f = mount("/app/account/automation-keys", r => r.path.endsWith("script-tokens") ? { status: 200, body: { tokens: "unreadable" } } : respond(r));
 await screen.findByText(/Can't tell yet/); expect(screen.queryByText("No automation keys.")).toBeNull(); f.close(); spy.mockRestore();
});
it("loading and offline are unknown, never empty or a successful identity", async () => {
 const f = mount("/app/account", () => new Promise(() => undefined));
 expect((await screen.findByRole("status")).textContent).toContain("Checking"); expect(screen.queryByText("Priya")).toBeNull(); f.close();
 const offline = mount("/app/account", () => { throw new Error("offline"); });
 await screen.findByText(/Can't tell yet/); expect(screen.queryByText("Priya")).toBeNull(); offline.close();
});

// DEC 254zzz324 (the shared servedReadState + isAccessEnded): a transient failed re-read KEEPS the last facts with ONE Reconnecting line.
it.each([500, 502, 503, 504])("DEC 324: a %s identity refetch keeps the identity and nested facts with exactly one Reconnecting line", async status => {
 let failed = false;
 const f = mount("/app/account", r => failed && r.path === "/v1/app/me" ? refusal(status) : respond(r));
 await screen.findByText("priya-dev"); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await screen.findByText(/Updated .+ · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText("Priya")).toBeTruthy(); expect(screen.getByText("priya-dev")).toBeTruthy();
 expect(screen.queryByRole("alert")).toBeNull();
 expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL");
 expect(f.host.signIn).not.toHaveBeenCalled(); f.close();
});
it.each(["/v1/app/me/github", "/v1/app/me/sign-ins", "/v1/app/me/lessons-slack", "/v1/app/script-tokens"])("DEC 324: a 503 %s re-read keeps that section's facts with one Reconnecting line", async endpoint => {
 let failed = false;
 const path = endpoint.endsWith("script-tokens") ? "/app/account/automation-keys" : "/app/account";
 const text = endpoint.endsWith("github") ? "priya-dev" : endpoint.endsWith("sign-ins") ? "how you first signed in" : endpoint.endsWith("lessons-slack") ? /once, when its work ends/ : "Nightly CI";
 const f = mount(path, r => failed && r.path === endpoint ? refusal(503) : respond(r));
 await screen.findByText(text); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await screen.findByText(/Updated .+ · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText(text)).toBeTruthy();
 expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL"); f.close();
});
it("DEC 324: every read failing at once still shows ONE Reconnecting line on the page", async () => {
 let failed = false;
 const f = mount("/app/account", r => failed ? refusal(503) : respond(r));
 await screen.findByText("priya-dev"); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await screen.findByText(/Updated .+ · Reconnecting/);
 expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
 expect(screen.getByText("priya-dev")).toBeTruthy(); expect(screen.getByText("Priya")).toBeTruthy(); f.close();
});
it("DEC 324: the shared access codes also clear (an ACCESS_ENDED code on a 400), and the last facts clear on 404 too", async () => {
 let failed = false;
 const f = mount("/app/account/automation-keys", r => failed && r.path === "/v1/app/script-tokens" ? { status: 400, body: { error: { code: "ACCESS_ENDED", message: "x" } } } : respond(r));
 await screen.findByText("Nightly CI"); failed = true;
 await act(async () => { await f.query.refetchQueries(); });
 await waitFor(() => expect(screen.queryByText("Nightly CI")).toBeNull());
 expect(screen.queryByText(/Reconnecting/)).toBeNull(); f.close();
});
it("DEC 324: the last good facts stay visible while the same read is fetched again (no Loading blink)", async () => {
 let hold = false;
 const f = mount("/app/account", r => hold && r.path === "/v1/app/me/sign-ins" ? new Promise(() => undefined) : respond(r));
 await screen.findByText("how you first signed in"); hold = true;
 act(() => { void f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me/sign-ins") }); });
 await waitFor(() => expect(f.query.isFetching({ predicate: q => q.queryKey.includes("/v1/app/me/sign-ins") })).toBe(1));
 expect(screen.getByText("how you first signed in")).toBeTruthy();
 expect(screen.queryByText(/Checking connected sign-ins/)).toBeNull(); expect(screen.queryByText(/Reconnecting/)).toBeNull(); f.close();
});
