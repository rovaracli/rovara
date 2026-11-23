// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import * as contracts from "@agentx/contracts/web";
import { createSessionActions } from "../../packages/ui/src/api/session-actions.js";
import { fakeHost } from "./support/fake-host.js";
import { sessionFixture, SESSION_FIXTURE_ID as SESSION } from "./support/session-fixture.js";
import { CLOSE_REQUEST_ID as REQUEST, CLOSE_DIGEST as DIGEST, closePreview, RETAINED_CLOSE_REFUSAL } from "./support/task-close-preview.js";

describe("D-CORE Close wire compatibility", () => {
 it("reads documented close/discard previews, nullable workflow and every unavailable variant", () => {
  for (const action of ["close", "discard"] as const) expect(contracts.TaskClosePreviewResponseSchema.parse(closePreview(action))).toEqual(closePreview(action));
  const plain = closePreview();plain.preview.workflow = null as unknown as typeof plain.preview.workflow;
  expect(contracts.TaskClosePreviewResponseSchema.parse(plain)).toEqual(plain);
  for (const unavailable of ["inspection_required", "busy", "unsupported"]) expect(contracts.TaskClosePreviewResponseSchema.parse({ preview: null, unavailable })).toEqual({ preview: null, unavailable });
 });
 it.each([
  ["duplicate repository", (v: ReturnType<typeof closePreview>) => { v.preview.unpublished.push(v.preview.unpublished[0]!); }],
  ["duplicate reason", (v: ReturnType<typeof closePreview>) => { v.preview.unpublished[0]!.reasons = ["worktree_changes", "worktree_changes"]; }],
  ["discard without inspection", (v: ReturnType<typeof closePreview>) => { v.preview.action = "discard";v.preview.unpublished = [];v.preview.inspection = null as unknown as typeof v.preview.inspection; }],
  ["findings without inspection", (v: ReturnType<typeof closePreview>) => { v.preview.inspection = null as unknown as typeof v.preview.inspection; }],
  ["mismatched fence", (v: ReturnType<typeof closePreview>) => { v.preview.inspection.workspaceFence = 3; }],
  ["bad digest", (v: ReturnType<typeof closePreview>) => { v.preview.digest = "A".repeat(64); }],
 ] as const)("rejects %s", (_name, mutate) => {
  const value = closePreview();mutate(value);expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(false);
 });
 it("permits an uninspected clean close, and inspected clean close/discard with any matching fence", () => {
  for (const action of ["close", "discard"] as const) {
   const value = closePreview(action);value.preview.unpublished = [];value.preview.workspace.fence = 8;value.preview.inspection.workspaceFence = 8;
   expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(true);
  }
  const value = closePreview();value.preview.unpublished = [];value.preview.inspection = null as unknown as typeof value.preview.inspection;
  expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(true);
 });
 it.each([
  ["workflow", false], ["workspace", false], ["inspection", false], ["unpublished", false],
  ["action", "destroy"], ["taskId", "not-a-uuid"], ["digest", "short"], ["taskStatus", "future"],
  ["workflow.revision", -1], ["workflow.revision", 1.5], ["workflow.stage", 1], ["workflow.state", 1],
  ["workspace.status", "future"], ["workspace.fence", -1], ["workspace.fence", 1.5], ["workspace.activeOperationId", "bad"],
  ["inspection.operationId", "bad"], ["inspection.workspaceFence", -1], ["inspection.workspaceFence", 1.5], ["inspection.contentDigest", "bad"],
  ["unpublished.0.repository", ""], ["unpublished.0.reasons", []], ["unpublished.0.reasons", ["future"]],
  ["unpublished.0.reasons", Array.from({ length: 5 }, () => "worktree_changes")],
  ["unpublished", Array.from({ length: 33 }, (_, i) => ({ repository: String(i), reasons: ["worktree_changes"] }))],
  ["extra", true], ["workflow.extra", true], ["workspace.extra", true], ["inspection.extra", true], ["unpublished.0.extra", true],
 ] as const)("refuses malformed wire field %s=%j", (path, invalid) => {
  const value = closePreview();let object: Record<string, unknown> = value.preview;
  const fields = path.split(".");
  for (const field of fields.slice(0, -1)) object = object[field] as Record<string, unknown>;
  object[fields.at(-1)!] = invalid;expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(false);
 });
 it("rejects missing required fields and invalid unavailable envelopes", () => {
  for (const field of Object.keys(closePreview().preview)) {
   const value = closePreview();delete (value.preview as Record<string, unknown>)[field];
   expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(false);
  }
  for (const value of [{ preview: null }, { preview: null, unavailable: "future" }, { preview: null, unavailable: "busy", extra: true }, { ...closePreview(), extra: true }]) expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(false);
 });
 it.each([
  { requestId: "bad", expectedPreviewDigest: DIGEST }, { expectedPreviewDigest: DIGEST },
  { requestId: REQUEST }, { requestId: REQUEST, expectedPreviewDigest: "bad" },
  { requestId: REQUEST, expectedPreviewDigest: DIGEST, discard_unpublished: "true" },
  { requestId: REQUEST, expectedPreviewDigest: DIGEST, extra: true },
 ])("refuses invalid documented consent %j", body => {
  expect(contracts.SessionBoundCloseBodySchema.safeParse(body).success).toBe(false);
 });
 it.each([-1, 1.5])("refuses invalid workspace fence %s even before an inspection exists", fence => {
  const value = closePreview();value.preview.unpublished = [];value.preview.inspection = null as unknown as typeof value.preview.inspection;value.preview.workspace.fence = fence;
  expect(contracts.TaskClosePreviewResponseSchema.safeParse(value).success).toBe(false);
 });
 it("reads the documented strict bound body including explicit false and omission", () => {
  for (const flag of [true, false, undefined]) {
   const value = { requestId: REQUEST, expectedPreviewDigest: DIGEST, ...(flag === undefined ? {} : { discard_unpublished: flag }) };
   expect(contracts.SessionBoundCloseBodySchema.parse(value)).toEqual(value);
  }
 });
});

describe("Cloud Close adapter", () => {
 it.each(["close", "discard"] as const)("reads %s previews using the exact action query", async action => {
  const f = fakeHost(async () => ({ status: 200, body: closePreview(action) }));
  expect(await createSessionActions(f.host).previewClose(SESSION, action)).toEqual(closePreview(action));
  expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: `/v1/app/sessions/${SESSION}/close?action=${action}`, retry: "never" });
 });
 it("refuses invalid preview actions before sending", () => {
  const f = fakeHost();expect(() => createSessionActions(f.host).previewClose(SESSION, "destroy" as "close")).toThrow();expect(f.request).not.toHaveBeenCalled();
 });
 it.each([true, false, undefined])("sends the bound digest and discard=%s unchanged, once", async discard => {
  const f = fakeHost(async () => ({ status: 200, body: { session: sessionFixture(), closed: false } }));
  const body = { requestId: REQUEST, expectedPreviewDigest: DIGEST, ...(discard === undefined ? {} : { discard_unpublished: discard }) };
  expect(await createSessionActions(f.host).closeBound(SESSION, body)).toMatchObject({ kind: "done", value: { closed: false } });
  expect(f.request.mock.calls.map(([r]) => r)).toEqual([{ method: "POST", path: `/v1/app/sessions/${SESSION}/close`, body, retry: "never" }]);
 });
 it("never sends invalid consent, including a missing digest", () => {
  const f = fakeHost();const api = createSessionActions(f.host);
  for (const body of [{ requestId: REQUEST }, { requestId: REQUEST, expectedPreviewDigest: "bad" }, { requestId: REQUEST, expectedPreviewDigest: DIGEST, discard_unpublished: "true" }, { requestId: REQUEST, expectedPreviewDigest: DIGEST, force: true }]) {
   expect(() => api.closeBound(SESSION, body as Parameters<typeof api.closeBound>[1])).toThrow();
  }
  expect(f.request).not.toHaveBeenCalled();
 });
 it("surfaces a retained-workspace legacy refusal as Code's clear direction to the preview", async () => {
  const f = fakeHost(async () => ({ status: 409, body: RETAINED_CLOSE_REFUSAL }));
  await expect(createSessionActions(f.host).close(SESSION, { requestId: REQUEST })).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: RETAINED_CLOSE_REFUSAL.error.message });
  expect(f.request).toHaveBeenCalledTimes(1);
 });
 it("does not retry or fall back on stale, unavailable or network-failed bound Close", async () => {
  for (const status of [409, 404, 503]) {
   const f = fakeHost(async () => ({ status, body: { error: { code: "CHANGE_STALE", message: "Review the Close preview again." } } }));
   await expect(createSessionActions(f.host).closeBound(SESSION, { requestId: REQUEST, expectedPreviewDigest: DIGEST })).rejects.toMatchObject({ status });expect(f.request).toHaveBeenCalledTimes(1);
  }
  const f = fakeHost(async () => { throw new Error("lost answer"); });
  await expect(createSessionActions(f.host).closeBound(SESSION, { requestId: REQUEST, expectedPreviewDigest: DIGEST })).rejects.toMatchObject({ code: "NETWORK_ERROR" });expect(f.request).toHaveBeenCalledTimes(1);
 });
 it("keeps legacy first and discard bodies unchanged", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { session: sessionFixture(), closed: true } }));
  const api = createSessionActions(f.host);
  await api.close(SESSION, { requestId: REQUEST });await api.close(SESSION, { requestId: REQUEST, discardUnpublished: true });
  expect(f.request.mock.calls.map(([r]) => r.body)).toEqual([{ requestId: REQUEST }, { requestId: REQUEST, discardUnpublished: true }]);
 });
 it("refuses unreadable preview answers", async () => {
  const f = fakeHost(async () => ({ status: 200, body: { preview: { digest: DIGEST } } }));
  await expect(createSessionActions(f.host).previewClose(SESSION, "close")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
 });
});
