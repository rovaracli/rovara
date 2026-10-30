import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectAllowedWebsitesReviewReaderSchema, ProjectAllowedWebsitesResultReaderSchema } from "../../packages/contracts/src/app-allowed-websites.js";
import { createAllowedWebsitesApi } from "../../packages/ui/src/api/allowed-websites.js";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { fakeHost } from "./support/fake-host.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", project = "payments", requestId = "11111111-1111-4111-8111-111111111111", stamp = "2026-10-29T21:00:00.000Z";
const review = { kind: "review", status: "review", orgId, project, baseRevision: 1, contextDigest: "a".repeat(64), allowedDomains: [], defaultDomains: ["github.com"], staffDomains: [], liveProposal: null };
const body = { requestId, expectedRevision: 1, expectedContextDigest: "a".repeat(64), allowedDomains: [] };
const receipt = { kind: "receipt", status: "applied", receipt: { requestId, state: "applied", mode: "direct_narrowing", resultRevision: 2, createdAt: stamp } };
afterEach(() => { vi.useRealTimers();vi.restoreAllMocks(); });
it("browser readers strip tracing fields and retain the nested business UUID", () => {
 expect(ProjectAllowedWebsitesReviewReaderSchema.parse({ ...review, requestId: "transport", bodyHash: "not-for-browser" })).toEqual(review);
 expect(ProjectAllowedWebsitesResultReaderSchema.parse({ ...receipt, requestId: "transport" })).toEqual(receipt);
 expect(ProjectAllowedWebsitesReviewReaderSchema.safeParse({ ...review, allowedDomains: Array.from({ length: 51 }, (_, i) => `host${i}.acme.dev`) }).success).toBe(false);
});
it("uses the exact org-bound cookie paths with retry never and one explicit POST", async () => {
 const f = fakeHost(async input => ({ status: 200, body: input.method === "GET" ? review : receipt })), api = createAllowedWebsitesApi(f.host, orgId, project);
 expect(await api.review()).toEqual(review);expect(await api.save(body)).toEqual(receipt);
 expect(f.request.mock.calls.map(([input]) => input)).toEqual([
  { method: "GET", path: `/v1/app/projects/${project}/allowed-websites?expectedOrgId=${orgId}`, retry: "never" },
  { method: "POST", path: `/v1/app/projects/${project}/allowed-websites`, body: { ...body, expectedOrgId: orgId }, retry: "never" },
 ]);
});
for (const [status, code] of [[403, "CSRF_STALE"], [429, "TOO_MANY_REQUESTS"], [503, "RUNTIME_UNAVAILABLE"]] as const) it(`never automatically resends a ${status} mutation or leaks its raw message`, async () => {
 const f = fakeHost(async () => ({ status, body: { error: { code, message: "private diagnostic fixture" } } }));
 const error = await createAllowedWebsitesApi(f.host, orgId, project).save(body).catch((value: unknown) => value);
 expect(error).toMatchObject({ status, code });expect(String(error)).not.toContain("private diagnostic fixture");expect(f.request).toHaveBeenCalledTimes(1);
});
it("drops a late unauthorized reply after scope teardown and reactivation", async () => {
 let finish!: (response: ApiResponse) => void;const pending = new Promise<ApiResponse>(resolve => { finish = resolve; }), f = fakeHost(() => pending), api = createAllowedWebsitesApi(f.host, orgId, project), read = api.review().catch((error: unknown) => error);
 api.setScopeActive(false);api.setScopeActive(true);finish({ status: 401, body: {} });expect(await read).toMatchObject({ code: "SCOPE_ENDED" });expect(f.host.signIn).not.toHaveBeenCalled();
});
it("bounds a stalled mutation without a retry or late redirect", async () => {
 vi.useFakeTimers();let finish!: (response: ApiResponse) => void;const pending = new Promise<ApiResponse>(resolve => { finish = resolve; }), f = fakeHost(() => pending), api = createAllowedWebsitesApi(f.host, orgId, project), write = api.save(body).catch((error: unknown) => error);
 await vi.advanceTimersByTimeAsync(30001);expect(await write).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });finish({ status: 401, body: {} });await Promise.resolve();expect(f.host.signIn).not.toHaveBeenCalled();expect(f.request).toHaveBeenCalledTimes(1);
});
it("refuses a receipt belonging to another business UUID", async () => {
 const f = fakeHost(async () => ({ status: 200, body: { ...receipt, receipt: { ...receipt.receipt, requestId: randomUUID() } } }));
 await expect(createAllowedWebsitesApi(f.host, orgId, project).save(body)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

it("sends explicit sole-owner acknowledgement once to the proposal-bound approval path", async () => {
 const proposalId = "22222222-2222-4222-8222-222222222222", approved = { kind: "receipt", proposalId, status: "applied", receipt: { requestId, proposalId, state: "applied", mode: "sole_owner_exception", resultRevision: 2, createdAt: stamp } };
 const f = fakeHost(async () => ({ status: 200, body: approved })), api = createAllowedWebsitesApi(f.host, orgId, project);
 expect(await api.decide(proposalId, "approve", { requestId, soleOwnerAcknowledged: true })).toEqual(approved);
 expect(f.request.mock.calls.map(([input]) => input)).toEqual([{ method: "POST", path: `/v1/app/projects/${project}/allowed-websites/proposals/${proposalId}/approve`, body: { requestId, expectedOrgId: orgId, soleOwnerAcknowledged: true }, retry: "never" }]);
});
