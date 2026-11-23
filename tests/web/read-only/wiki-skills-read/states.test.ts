// @vitest-environment jsdom
import { expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { mount } from "./test-support.js";
import { index, page, reply, skills, sources } from "./fixtures.js";
import { readFileSync } from "node:fs";
const held: unknown = JSON.parse(readFileSync("tests/web/read-only/wiki-skills-read/held-states.json", "utf8"));
const privateText = "Private page text: requests enter the API.";
const reconnecting = () => screen.getAllByText(/^Updated .* · Reconnecting$/);
const transient = [
 { name: "network", response: () => { throw new TypeError("offline"); } },
 { name: "timeout", response: () => { throw new DOMException("timeout", "TimeoutError"); } },
 { name: "aborted", response: () => { throw new DOMException("aborted", "AbortError"); } },
 { name: "503", response: () => ({ status: 503, body: { error: { code: "UNAVAILABLE", message: "unsafe raw" } } }) },
 { name: "unreadable", response: () => ({ status: 200, body: { broken: true } }) },
 { name: "202", response: () => ({ status: 202, body: { status: "pending" } }) },
];
it.each(transient)("keeps the last good page and original timestamp through $name, repeated failure and remount, then replaces it", async ({ response }) => {
 let failing = false, recovered = false;
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => failing && r.path.endsWith("/wiki/pages/overview") ? response() : recovered && r.path.endsWith("/wiki/pages/overview") ? { status: 200, body: { ...page, page: { ...page.page, blocks: [{ kind: "paragraph", blockId: "body-002", text: "New confirmed page", claimIds: [] }] } } } : reply(r));
 try {
  await screen.findByText(privateText);
  const key = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === "page:overview")!.queryKey;
  const originalAt = f.client.getQueryState(key)!.dataUpdatedAt;
  failing = true;
  for (let i = 0; i < 2; i++) {
   await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
   await waitFor(() => expect(reconnecting()).toHaveLength(1));
   expect(reconnecting()[0]?.textContent).toBe("Updated " + new Date(originalAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + " · Reconnecting");
   expect(screen.getByText(privateText)).toBeTruthy();
   expect(f.client.getQueryData(key)).toEqual(page);
   expect(f.client.getQueryState(key)?.dataUpdatedAt).toBe(originalAt);
   expect(screen.queryByText(/Read from Rovara/)).toBeNull();
   expect(screen.queryByRole("alert")).toBeNull();
  }
  f.unmount(); const again = f.reopen();
  await screen.findByText(privateText);
  await waitFor(() => { expect(f.client.isFetching()).toBe(0); expect(reconnecting()).toHaveLength(1); });
  failing = false; recovered = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
  await screen.findByText("New confirmed page");
  expect(screen.queryByText(/Reconnecting/)).toBeNull();
  expect(screen.queryByText(privateText)).toBeNull();
  again.unmount();
 } finally { f.close(); }
});
const refusals = [
 { status: 401, body: { error: { code: "REQUEST_FAILED", message: "unsafe raw" } } },
 { status: 403, body: { error: { code: "REQUEST_FAILED", message: "unsafe raw" } } },
 { status: 200, body: { error: { code: "ACCESS_ENDED" } } },
 { status: 503, body: { code: "SESSION_EXPIRED" } },
];
it.each(refusals)("keeps twice then wipes the whole scope on access signal $status/$body, including cache and remount", async refusal => {
 let failure: typeof refusal | undefined;
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => failure !== undefined && r.path.endsWith("/wiki/pages/overview") ? failure : reply(r));
 try {
  await screen.findByText(privateText);
  const key = f.client.getQueryCache().findAll().find(q => q.queryKey.at(-1) === "page:overview")!.queryKey;
  failure = { status: 503, body: { error: { code: "UNAVAILABLE", message: "unsafe raw" } } };
  for (let i = 0; i < 2; i++) await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
  await waitFor(() => expect(reconnecting()).toHaveLength(1));
  failure = refusal;
  await act(async () => { await f.client.refetchQueries({ queryKey: key, exact: true }); });
  await screen.findByRole("heading", { name: "Access ended" });
  const scoped = () => f.client.getQueriesData({ queryKey: key.slice(0, -1) }).filter(([k]) => k.at(-1) !== "denied");
  expect(scoped().length).toBeGreaterThan(2);
  expect(scoped().every(([, data]) => data === undefined)).toBe(true);
  expect(screen.queryByText(privateText)).toBeNull();
  expect(screen.queryByText(/Reconnecting|unsafe raw/)).toBeNull();
  f.unmount(); failure = undefined; const again = f.reopen();
  await screen.findByRole("heading", { name: "Access ended" });
  // Older/background successes cannot refill a denied scope or restore its display.
  await act(async () => { await f.client.refetchQueries({ queryKey: key.slice(0, -1), type: "all", predicate: q => q.queryKey.at(-1) !== "denied" }); });
  expect(scoped().every(([, data]) => data === undefined)).toBe(true);
  expect(screen.queryByText(privateText)).toBeNull();
  again.unmount();
 } finally { f.close(); }
});
it("a 404 on the INDEX read (the scope itself) wipes the whole scope; a 404 on one page does not (see g3-wiki-skills-mount)", async () => {
 let failure = false;
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => failure && r.path === "/v1/app/projects/web/wiki" ? { status: 404, body: { error: { code: "REQUEST_FAILED", message: "unsafe raw" } } } : reply(r));
 try {
  await screen.findByText(privateText);
  failure = true;
  await act(async () => { await f.client.refetchQueries({ predicate: q => q.queryKey.at(-1) === "index" }); });
  await screen.findByRole("heading", { name: "Access ended" });
  expect(screen.queryByText(privateText)).toBeNull();
 } finally { f.close(); }
});
it.each(["identity", "index", "page:overview", "sources:overview", "corrections:overview", "all"])("one reconnecting line for a composed page when %s fails", async part => {
 let failing = false;
 const paths: Record<string, string> = { identity: "/v1/app/me", index: "/v1/app/projects/web/wiki", "page:overview": "/v1/app/projects/web/wiki/pages/overview", "sources:overview": "/v1/app/projects/web/wiki/pages/overview/sources", "corrections:overview": "/v1/app/projects/web/wiki/pages/overview/corrections" };
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => failing && (part === "all" || r.path === paths[part]) ? { status: 503, body: { error: { code: "UNAVAILABLE", message: "offline" } } } : reply(r));
 try {
  await screen.findByText(privateText);
  failing = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: ["g3"], predicate: q => q.queryKey.at(-1) !== "denied" && (part === "all" || q.queryKey.at(-1) === part) }); });
  await screen.findByText(privateText);
  await waitFor(() => expect(reconnecting()).toHaveLength(1));
  expect(screen.queryByText(/Read from Rovara/)).toBeNull();
 } finally { f.close(); }
});
it("an identity access signal purges its scoped sibling payloads and stays denied on remount", async () => {
 let denied = false;
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => denied && r.path === "/v1/app/me" ? { status: 200, body: { code: "SESSION_EXPIRED" } } : reply(r));
 try {
  await screen.findByText(privateText); denied = true;
  await act(async () => { await f.client.refetchQueries({ queryKey: ["g3"], predicate: q => q.queryKey.at(-1) === "identity" }); });
  await screen.findByRole("heading", { name: "Access ended" });
  expect(f.client.getQueriesData({ queryKey: ["g3"] }).filter(([key]) => key.at(-1) !== "denied").every(([, data]) => data === undefined)).toBe(true);
  f.unmount(); denied = false; const again = f.reopen();
  await screen.findByRole("heading", { name: "Access ended" });
  expect(screen.queryByText(privateText)).toBeNull(); again.unmount();
 } finally { f.close(); }
});
it("first-read failure has no last-good snapshot or reconnecting line", async () => {
 const f = mount(undefined, r => r.path.endsWith("/wiki") ? { status: 503, body: {} } : reply(r));
 try { await screen.findByRole("alert"); expect(screen.queryByText(/Reconnecting/)).toBeNull(); } finally { f.close(); }
});
it.each(["commit", "repo"])("R4 hides source evidence with a mismatched %s and explains the partial read", async field => {
 const mismatch = { ...sources.files[0], path: "src/unverified.ts", [field]: field === "commit" ? "b".repeat(40) : "other-repo" };
 const f = mount("/app/projects/web?tab=wiki&page=overview", r => r.path.endsWith("/sources") ? { status: 200, body: { ...sources, files: [...sources.files, mismatch] } } : reply(r));
 await screen.findByText("Private page text: requests enter the API.");
 const fold = screen.getByText("Relevant source files").closest("details");
 if (fold === null) throw new Error("Missing source disclosure");
 fold.open = true;
 await within(fold).findByText("beacon-api/src/server.ts");
 expect(within(fold).queryByText(/src\/unverified\.ts/)).toBeNull();
 expect(within(fold).getByText(/Can't tell yet.*source files.*page revision/)).toBeTruthy(); f.close();
});
it.each(["unreadable", "mixed", "duplicate"])("R4 keeps a %s Skills response partial through local filtering", async kind => {
 const rows = kind === "unreadable" ? [{ name: "broken-skill" }] : kind === "mixed" ? [skills.skills[0], { name: "broken-skill" }] : [skills.skills[0], skills.skills[0]];
 const f = mount("/app/projects/web?tab=skills", r => r.path.endsWith("/skills") ? { status: 200, body: { ...skills, skills: rows } } : reply(r));
 await screen.findByRole("heading", { name: "Skills in web" });
 expect(screen.queryByText(/No (current|retired) skills in this read/)).toBeNull();
 expect(screen.getByText(/Can't tell yet.*skills.*partial/)).toBeTruthy();
 if (kind !== "unreadable") expect(within(screen.getByRole("table", { name: "Skills in use" })).getAllByText("safe-retries")).toHaveLength(1);
 expect(screen.queryByText(/No (current|retired) skills in this read/)).toBeNull();
 expect(screen.getByText(/Can't tell yet.*skills.*partial/)).toBeTruthy(); f.close();
});
it("R4 rejects an answer for a different project", async () => {
 const f = mount(undefined, r => r.path.endsWith("/wiki") ? { status: 200, body: { ...index, project: "other" } } : reply(r));
 await screen.findByRole("alert"); expect(screen.queryByText("Product overview")).toBeNull(); f.close();
});
it("R4 reports truncated reads as partial, never complete", async () => {
 const f = mount("/app/projects/web?tab=wiki&view=gaps");
 await screen.findByText("How are retries handled?"); expect(screen.getAllByText(/More items may be available/).length).toBeGreaterThan(0); f.close();
});
it("R4 keeps answer history and unserved board states held", async () => {
 expect(Array.isArray(held) && held.length > 0).toBe(true);
 const f = mount("/app/projects/web?tab=wiki&view=ask"); await screen.findByText("Existing answer: Can't tell yet.");
 expect(f.calls.some(r => /answer/.test(r.path))).toBe(false); f.close();
});
