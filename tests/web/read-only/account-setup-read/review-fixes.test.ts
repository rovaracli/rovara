// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { mount } from "./mount.js";
import { connections, identity, keys, refusal, respond } from "./fixtures.js";

/** The primary sign-in row (G5 ship: one row per method; this is its detail line). */
const PRIMARY = "how you first signed in";

it.each([
 { label: "unreadable primary", rows: [{ method: "slack", primary: "unreadable" }] },
 { label: "mixed readable and unreadable", rows: [{ method: "slack", primary: true }, { method: "github", primary: "unreadable" }] },
 { label: "unreadable method", rows: [{ method: "invalid method", primary: true }] },
 { label: "non-record row", rows: [null] },
])("review5: $label sign-ins remain unknown instead of claiming a complete list", async ({ rows }) => {
 const f = mount("/app/account", r => r.path === "/v1/app/me/sign-ins" ? { status: 200, body: { signIns: rows } } : respond(r));
 try {
  const item = await screen.findByRole("listitem", { name: "Connected sign-ins" }), panel = within(item);
  expect(await panel.findByText(/Can't tell yet/)).toBeTruthy();
  expect(panel.queryByText("No connected sign-ins returned.")).toBeNull();
  expect(panel.queryByRole("list")).toBeNull();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  // Unreadable list: no Unlink or Connect is offered (the page's other live controls are elsewhere).
  expect(item.querySelector("form,input,select,textarea,button:not([data-read-retry])")).toBeNull();
  expect(screen.queryByRole("button", { name: /^(Unlink|Connect) / })).toBeNull();
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});

it.each([
 { label: "genuinely empty", rows: [], text: "No connected sign-ins returned." },
 { label: "readable future method", rows: [{ method: "future_method", primary: false }], text: "Another sign-in" },
])("review5: preserves $label sign-ins", async ({ rows, text }) => {
 const f = mount("/app/account", r => r.path === "/v1/app/me/sign-ins" ? { status: 200, body: { signIns: rows } } : respond(r));
 try {
  const panel = within(await screen.findByRole("list", { name: "Your sign-in methods" }));
  expect(await panel.findByText(text)).toBeTruthy();
  expect(panel.queryByText(/Can't tell yet/)).toBeNull();
 } finally { f.close(); }
});

it("review5 (DEC 324): an unreadable sign-ins refetch keeps the last list with one Reconnecting line and GET retry recovers", async () => {
 let unreadable = false;
 const f = mount("/app/account", r => unreadable && r.path === "/v1/app/me/sign-ins" ? { status: 200, body: { signIns: [{ method: "slack", primary: "unreadable" }] } } : respond(r));
 try {
  await within(await screen.findByRole("list", { name: "Your sign-in methods" })).findByText(PRIMARY);
  unreadable = true;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me/sign-ins") }); });
  expect(await screen.findByText(/Updated .+ · Reconnecting/)).toBeTruthy();
  expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
  expect(screen.getByText(PRIMARY)).toBeTruthy();
  expect(screen.queryByText("No connected sign-ins returned.")).toBeNull();
  unreadable = false;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me/sign-ins") }); });
  await waitFor(() => expect(screen.queryByText(/Reconnecting/)).toBeNull());
  expect(screen.getByText(PRIMARY)).toBeTruthy();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});

it("keeps the last facts visible while the identity is read again (DEC 324); no Reconnecting line for a read still in flight", async () => {
 let changed = false;
 const f = mount("/app/account/automation-keys", r => changed && r.path === "/v1/app/me" ? new Promise(() => undefined) : respond(r));
 await screen.findByText("Nightly CI"); changed = true;
 act(() => { void f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me") }); });
 await waitFor(() => expect(f.query.isFetching({ predicate: q => q.queryKey.includes("/v1/app/me") })).toBe(1));
 expect(screen.getByText("Nightly CI")).toBeTruthy();
 expect(screen.queryByText(/Reconnecting/)).toBeNull(); f.close();
});
it("rejects scoped metadata from a changed session while the parent identity read is deferred", async () => {
 let changed = false, checks = 0;
 const f = mount("/app/account/automation-keys", r => {
  if (!changed) return respond(r);
  if (r.path === "/v1/app/me") {
   checks++;
   if (checks > 1) return new Promise(() => undefined);
   return { status: 200, body: { ...identity, developer: { ...identity.developer, id: "b".repeat(64) }, org: { ...identity.org, orgId: "org_other" } } };
  }
  return { status: 200, body: { ...keys, tokens: [{ ...keys.tokens[0], name: "Other company CI" }] } };
 });
 await screen.findByText("Nightly CI"); changed = true;
 await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") }); });
 expect(screen.queryByText("Other company CI")).toBeNull();
 expect(checks).toBeGreaterThan(0); f.close();
});
it.each(["suspended", "uninstalled", undefined])("does not call GitHub connected for status %s", async status => {
 const f = mount("/app/onboard", r => r.path === "/v1/app/github/connections" ? { status: 200, body: { installations: connections.installations.map(row => ({ ...row, status })) } } : respond(r));
 await screen.findByRole("heading", { name: "Company setup progress" });
 await waitFor(() => expect(screen.queryByText(/Checking company GitHub/)).toBeNull());
 expect(screen.queryByText("GitHub connected")).toBeNull(); f.close();
});
it("holds the project roster the owning API rejects, and does not ask the admin-only directory for a member", async () => {
 const f = mount("/app/onboard?project=web&step=agents");
 await screen.findByRole("heading", { name: "web", level: 1 });
 expect(f.request.mock.calls.some(([r]) => r.path.startsWith("/v1/app/agents"))).toBe(false);
 expect((await screen.findByText("Used in this project")).nextElementSibling?.textContent).toMatch(/can't be told yet/); f.close();
});
it("rejects metadata if the session changes between identity preflight and response", async () => {
 let changed = false, checks = 0;
 const f = mount("/app/account/automation-keys", r => {
  if (!changed) return respond(r);
  if (r.path === "/v1/app/me") {
   checks++;
   if (checks === 1) return respond(r);
   if (checks > 2) return new Promise(() => undefined);
   return { status: 200, body: { ...identity, developer: { ...identity.developer, id: "b".repeat(64) } } };
  }
  return { status: 200, body: { ...keys, tokens: [{ ...keys.tokens[0], name: "Other company CI" }] } };
 });
 await screen.findByText("Nightly CI"); changed = true;
 await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") }); });
 expect(screen.queryByText("Other company CI")).toBeNull(); expect(checks).toBeGreaterThan(1); f.close();
});
it("lets a person refresh a successful running-read and see the terminal state with GET only", async () => {
 const { fireEvent, within } = await import("@testing-library/react");
 let finished = false;
 const f = mount("/app/onboard?project=web", r => {
  const answer = respond(r);
  return r.path.endsWith("setup-agent") && finished ? { status: 200, body: { ...(answer.body as object), status: "ready" } } : answer;
 });
 await screen.findByText("Setup is running"); finished = true;
 fireEvent.click(within(screen.getByRole("region", { name: "Setup run progress" })).getByRole("button", { name: "Check again" }));
 expect(await screen.findByText("Setup run is ready")).toBeTruthy();
 expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true); f.close();
});


it("review31: a scoped identity refusal drops all account facts until a fresh identity succeeds", async () => {
 let lost = false;
 const f = mount("/app/account", r => lost && r.path === "/v1/app/me" ? refusal(403) : respond(r));
 try {
  await screen.findByText("priya-dev");
  await screen.findByText(PRIMARY);
  lost = true;
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me/github") }); });
  await waitFor(() => expect({
   github: screen.queryByText("priya-dev")?.textContent ?? null,
   name: screen.queryByText("Priya")?.textContent ?? null,
   signIns: screen.queryByText(PRIMARY)?.textContent ?? null,
  }).toEqual({ github: null, name: null, signIns: null }));
  expect(document.body.textContent).toContain("Can't tell yet");
  expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL");
  // A successful sibling read cannot restore the refused identity.
  await act(async () => { await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me/sign-ins") }); });
  expect(screen.queryByText("Priya")).toBeNull();
  lost = false;
  fireEvent.click(screen.getByRole("button", { name: "Load again" }));
  expect(await screen.findByText("Priya")).toBeTruthy();
  expect(await screen.findByText("priya-dev")).toBeTruthy();
  expect(await screen.findByText(PRIMARY)).toBeTruthy();
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});

it.each([
 { stage: "preflight", status: 401 },
 { stage: "preflight", status: 403 },
 { stage: "preflight", status: 404 },
 { stage: "postflight", status: 403 },
 { stage: "postflight", status: 404 },
])("review31: setup Check again drops sibling facts after identity $stage fails with the access signal $status", async ({ stage, status }) => {
 let lost = false, checks = 0;
 const f = mount("/app/onboard?project=web", r => {
  if (lost && r.path === "/v1/app/me") {
   checks++;
   if (stage === "postflight" && checks === 1) return respond(r);
   return refusal(status);
  }
  return respond(r);
 });
 try {
  await screen.findByText("25% complete");
  await screen.findByText("npm run check");
  await screen.findByText("Setup is running");
  lost = true;
  fireEvent.click(within(screen.getByRole("region", { name: "Setup run progress" })).getByRole("button", { name: "Check again" }));
  await waitFor(() => expect({
   run: screen.queryByText("Setup is running")?.textContent ?? null,
   checklist: screen.queryByText("25% complete")?.textContent ?? null,
   journal: screen.queryByText("npm run check")?.textContent ?? null,
  }).toEqual({ run: null, checklist: null, journal: null }));
  expect(document.body.textContent).toContain("Can't tell yet");
  expect(checks).toBeGreaterThanOrEqual(stage === "postflight" ? 2 : 1);
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});

it.each([
 { stage: "preflight", status: 502 }, { stage: "preflight", status: 503 }, { stage: "postflight", status: 502 },
])("review31 (DEC 324): a transient identity failure ($status at $stage) keeps the setup facts with ONE Reconnecting line", async ({ stage, status }) => {
 let lost = false, checks = 0;
 const f = mount("/app/onboard?project=web", r => {
  if (lost && r.path === "/v1/app/me") {
   checks++;
   if (stage === "postflight" && checks === 1) return respond(r);
   return refusal(status);
  }
  return respond(r);
 });
 try {
  await screen.findByText("25% complete"); await screen.findByText("npm run check"); await screen.findByText("Setup is running");
  lost = true;
  fireEvent.click(within(screen.getByRole("region", { name: "Setup run progress" })).getByRole("button", { name: "Check again" }));
  await screen.findByText(/Updated .+ · Reconnecting/);
  expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
  expect(screen.getByText("Setup is running")).toBeTruthy();
  expect(screen.getByText("25% complete")).toBeTruthy();
  expect(screen.getByText("npm run check")).toBeTruthy();
  expect(document.body.textContent).not.toContain("PRIVATE ERROR DETAIL");
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});

it.each([
 { stage: "preflight", change: "role and name", developer: { orgRole: "member", name: "Updated name" }, company: "Acme", name: "Updated name", role: "member", suppliedName: false },
 { stage: "postflight", change: "role and name", developer: { orgRole: "member", name: "Updated name" }, company: "Acme", name: "Updated name", role: "member", suppliedName: false },
 { stage: "preflight", change: "role only", developer: { orgRole: "member" }, company: "Acme", name: "Priya", role: "member", suppliedName: false },
 { stage: "preflight", change: "name only", developer: { name: "Updated name" }, company: "Acme", name: "Updated name", role: "owner", suppliedName: false },
 { stage: "preflight", change: "name choice only", developer: { nameChosen: false }, company: "Acme", name: "Priya", role: "owner", suppliedName: true },
 { stage: "preflight", change: "company name only", developer: {}, company: "Updated company", name: "Priya", role: "owner", suppliedName: false },
])("review4: GitHub Check again reconciles same-person $change at identity $stage", async ({ stage, developer, company, name, role, suppliedName }) => {
 let retrying = false, checks = 0;
 const original = { ...identity, developer: { ...identity.developer, orgRole: "owner" } };
 const current = { ...original, developer: { ...original.developer, ...developer }, org: { ...original.org, name: company } };
 const f = mount("/app/account", r => {
  if (r.path === "/v1/app/me") {
   if (!retrying || (stage === "postflight" && ++checks === 1)) return { status: 200, body: original };
   return { status: 200, body: current };
  }
  if (!retrying && r.path === "/v1/app/me/github") return refusal(502);
  return respond(r);
 });
 try {
  await screen.findByText(PRIMARY);
  await waitFor(() => expect(f.query.isFetching()).toBe(0));
  expect(within(screen.getByRole("listitem", { name: "Your name" })).getByText("Priya")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Your companies" })).getByText("Owner")).toBeTruthy();
  retrying = true;
  fireEvent.click(within(screen.getByRole("listitem", { name: "Your GitHub account" })).getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("priya-dev")).toBeTruthy();
  await waitFor(() => {
   const profile = within(screen.getByRole("listitem", { name: "Your name" }));
   const org = within(screen.getByRole("region", { name: "Your companies" }));
   expect(profile.getByText(name)).toBeTruthy();
   expect(org.getByText(role.charAt(0).toUpperCase() + role.slice(1))).toBeTruthy();
   expect(org.getByText(company)).toBeTruthy();
   expect(profile.queryByText(/This is the name your sign-in supplied/) !== null).toBe(suppliedName);
   if (name !== "Priya") expect(profile.queryByText("Priya")).toBeNull();
   if (role !== "owner") expect(org.queryByText("Owner")).toBeNull();
   if (company !== "Acme") expect(org.queryByText("Acme")).toBeNull();
  });
  expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  // The retry opens no form or dialog: the page's live controls are only used by a person pressing them.
  expect(document.querySelector("form,[role=dialog]")).toBeNull();
  expect(f.host.signIn).not.toHaveBeenCalled();
 } finally { f.close(); }
});
