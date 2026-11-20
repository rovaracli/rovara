// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionViewReaderSchema } from "@agentx/contracts/web";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { MergeSection } from "../../packages/ui/src/screens/session/MergeSection.js";
import { withClaim } from "../../packages/ui/src/screens/session/merge-pending.js";
import { workspaceTask } from "../../packages/ui/src/screens/session/workspace-types.js";
import { workspaceFixture } from "./support/workspace-fixture.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", org = "org_aaaaaaaaaaaaaaaaaaaa", person = "a1".repeat(32), sha = "a".repeat(40);
const subject = org + "|" + person + "|" + id, key = "rovara.merge.pending.v1:" + subject;
const success = { status: 200, body: { status: "MERGED", pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } };
const tracked = { orgId: org, taskId: "11111111-1111-4111-8111-111111111111", repositoryId: "acme/payments", number: 42, version: 1, headSha: sha, draft: false, state: "open", baseBranch: "main", ci: "passing", ciBasis: "required", checksEverSeen: true, failingChecks: [], review: "approved", branch: "up_to_date", headByRovara: true, nudges: { count: 0 }, syncs: { day: "2026-10-23", count: 0 }, decisionDigest: "b".repeat(64), observedAt: "2026-10-23T12:00:00.000Z" };
function setup(post: () => Promise<typeof success>) {
 localStorage.clear();
 const session = SessionViewReaderSchema.parse(workspaceFixture({ sessionId: id }, { pullRequests: [{ repository: "acme/payments", number: 42, url: "https://github.com/acme/payments/pull/42", state: "open" }], mergeTracking: [tracked], merge: { ready: true, risk: { level: "low", reasons: [] } } }));
 const f = fakeHost(async request => {
  if (request.path === "/v1/app/me") return { status: 200, body: { developer: { id: person, name: "Ana", orgRole: "owner" }, org: { orgId: org, name: "Acme", plan: "team" }, identities: [] } };
  if (request.path.endsWith("/merge") && request.method === "POST") return post();
  if (request.path.endsWith("/merge")) return { status: 200, body: { mayMerge: true, ready: true, risk: "low", heads: [{ repositoryId: "acme/payments", number: 42, headSha: sha }], pullRequests: [{ repositoryId: "acme/payments", number: 42 }] } };
  return { status: 200, body: { session } };
 });
 const mount = () => {
  const query = createQueryClient();
  return renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MergeSection, { sessionId: id, task: workspaceTask(session)! }) }) }));
 };
 return { ...f, mount, posts: () => f.request.mock.calls.filter(([request]) => request.method === "POST") };
}
async function confirm() { fireEvent.click(await screen.findByRole("button", { name: /^Merge #42/u }));return within(await screen.findByRole("dialog")).getByRole("button", { name: "Press Merge" }); }
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks();localStorage.clear(); });
it("mounted Merge timeout retains pending across reload, releases claim/busy, ignores late success and never posts twice", async () => {
 let answer!: (response: typeof success) => void;
 const f = setup(() => new Promise(resolve => { answer = resolve; }));const first = f.mount(), button = await confirm();
 vi.useFakeTimers();fireEvent.click(button);
 await act(async () => { await vi.advanceTimersByTimeAsync(119_999); });
 expect(f.posts()).toHaveLength(1);expect(localStorage.getItem(key)).not.toBeNull();
 expect(await withClaim(subject, () => true)).toEqual({ kind: "busy" });
 await act(async () => { await vi.advanceTimersByTimeAsync(1); });
 expect(screen.getByRole<HTMLButtonElement>("button", { name: "Check again" }).disabled).toBe(false);
 const claim = await withClaim(subject, () => true);expect(claim.kind).toBe("done");if (claim.kind === "done") claim.release();
 await act(async () => { answer(success);await vi.advanceTimersByTimeAsync(0); });
 expect(localStorage.getItem(key)).not.toBeNull();expect(f.posts()).toHaveLength(1);
 first.unmount();vi.useRealTimers();f.mount();
 await screen.findByRole("button", { name: "Check again" });expect(screen.queryByRole("button", { name: /^Merge #42/u })).toBeNull();expect(f.posts()).toHaveLength(1);
});
it("mounted Merge cannot clear pending from an accepted record whose exact readback failed", async () => {
 const f = setup(async () => success);f.mount();const button = await confirm(), original = Storage.prototype.setItem.bind(localStorage);
 vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) { original(name, name.startsWith("rovara.merge.accepted.v1:") ? JSON.stringify({ ...JSON.parse(value) as Record<string, unknown>, words: "altered" }) : value); });
 fireEvent.click(button);
 await waitFor(() => expect(screen.getByRole("heading", { name: /Merge accepted/u })).toBeTruthy());
 expect(localStorage.getItem(key)).not.toBeNull();expect(f.posts()).toHaveLength(1);
});
it("mounted Merge maps busy to another-tab words without a GitHub fallback", async () => {
 const f = setup(async () => success);f.mount();const button = await confirm();
 const held = await withClaim(subject, () => true);expect(held.kind).toBe("done");
 try {
  fireEvent.click(button);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("Another tab is merging this task right now. Nothing was sent here.");
  expect(alert.textContent).not.toContain("GitHub");expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.posts()).toHaveLength(0);expect(localStorage.getItem(key)).toBeNull();
 } finally { if (held.kind === "done") held.release(); }
});
it.each(["unsupported", "failed"] as const)("mounted Merge maps %s claim to the existing closed GitHub path", async kind => {
 const f = setup(async () => success);f.mount();const button = await confirm();
 const saved = Object.getOwnPropertyDescriptor(navigator, "locks")!;
 Object.defineProperty(navigator, "locks", { configurable: true, value: kind === "unsupported" ? undefined : { request() { throw new Error("claim failed"); } } });
 try {
  fireEvent.click(button);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("This browser can't make sure two tabs don't merge at once, so nothing was sent. Merge it on GitHub.");
  expect(screen.queryByRole("dialog")).toBeNull();expect(f.posts()).toHaveLength(0);expect(localStorage.getItem(key)).toBeNull();
 } finally { Object.defineProperty(navigator, "locks", saved); }
});
