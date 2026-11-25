import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryObserver } from "@tanstack/react-query";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { isAccessEnded, partNotShownWords, routeNotServedWords, servedReadState } from "../../packages/ui/src/api/served-read.js";
import { ReadState } from "../../packages/ui/src/screens/admin/projects/read.js";
import { ReadSection } from "../../packages/ui/src/screens/admin/models/read.js";
import { fakeHost } from "./support/fake-host.js";
import type { ApiResponse } from "../../packages/ui/src/host.js";

const reader = z.object({ details: z.string() });
const privateData = { details: "Private company details" };
const lastRead = Date.parse("2026-11-21T12:34:56Z");
const failures: Array<{ name: string; failure: ApiResponse | Error; wipe: boolean }> = [
 ...[401, 403, 404].map(status => ({ name: `HTTP ${status}`, failure: { status, body: undefined }, wipe: true })),
 ...[408, 429, 500, 501, 503].map(status => ({ name: `HTTP ${status} without access signal`, failure: { status, body: {} }, wipe: false })),
 { name: "network drop", failure: new TypeError("Disconnected"), wipe: false },
 { name: "timeout", failure: new DOMException("Timed out", "TimeoutError"), wipe: false },
 { name: "aborted request", failure: new DOMException("Aborted", "AbortError"), wipe: false },
 { name: "unparseable successful body", failure: { status: 200, body: undefined }, wipe: false },
 { name: "unparseable 5xx body", failure: { status: 502, body: "<html>Unavailable</html>" }, wipe: false },
 { name: "unknown error", failure: new Error("Unknown"), wipe: false },
 ...["ACCESS_ENDED", "ACCESS_LOST", "FORBIDDEN", "NOT_FOUND", "TASK_ACCESS_DENIED", "SESSION_NOT_FOUND", "AUTH_REQUIRED"].map(code => ({ name: `200 body ${code}`, failure: { status: 200, body: { error: { code } } }, wipe: true })),
 { name: "503 body forbidden beats retry and unreadable body", failure: { status: 503, body: { error: { code: "FORBIDDEN" } } }, wipe: true },
 { name: "session-expired redirect signal", failure: new ApiError(302, "SESSION_EXPIRED", "Sign in again."), wipe: true },
 { name: "redirect with authentication body", failure: { status: 302, body: { error: { code: "AUTH_REQUIRED" } } }, wipe: true },
 { name: "redirect without access signal", failure: { status: 302, body: undefined }, wipe: false },
 { name: "invalid response is not access loss", failure: new ApiError(502, "INVALID_RESPONSE", "Unreadable"), wipe: false },
];

function setup(failure: ApiResponse | Error, earlier: boolean) {
 const client = createQueryClient(), key = ["served-read", "company", "person", "details"];
 const cell = fakeHost(async () => { if (failure instanceof Error) throw failure;return failure; });
 if (earlier) client.setQueryData(key, privateData, { updatedAt: lastRead });
 const api = createApiClient(cell.host);
 const observer = new QueryObserver(client, { queryKey: key, queryFn: () => api.get("/v1/app/details", reader, undefined, { retry: "never" }) });
 return { client, key, observer };
}
function markup(read: ReturnType<ReturnType<typeof setup>["observer"]["getCurrentResult"]>) {
 const children = (data: z.infer<typeof reader>) => h("p", null, data.details);
 return [renderToStaticMarkup(h(ReadState<z.infer<typeof reader>>, { read, label: "details", children })), renderToStaticMarkup(h(ReadSection<z.infer<typeof reader>>, { read, label: "details", children }))];
}
describe("shared served-read refresh policy", () => {
 beforeEach(() => { vi.stubEnv("TZ", "America/Los_Angeles"); });
 afterEach(() => { vi.unstubAllEnvs(); });
 it.each(failures)("$name keeps or wipes the payload and both read surfaces", async ({ failure, wipe }) => {
  const { client, key, observer } = setup(failure, true);
  try {
   await observer.refetch();
   const read = observer.getCurrentResult();
   expect(read.isError).toBe(true);
   expect(client.getQueryData(key)).toEqual(wipe ? undefined : privateData);
   for (const html of markup(read)) {
    if (wipe) { expect(html).not.toContain(privateData.details);expect(html).toContain('role="alert"');expect(html).not.toContain("Reconnecting"); }
    else { expect(html).toContain(privateData.details);expect(html.match(/Updated .*? · Reconnecting/gu)).toHaveLength(1);expect(html).toContain("Updated 11/21/2026, 4:34:56 AM · Reconnecting");expect(html).not.toContain('role="alert"'); }
   }
   expect(client.getQueryState(key)?.dataUpdatedAt).toBe(lastRead);
  } finally { observer.destroy();client.clear(); }
 });
 it.each(failures)("first read: $name has no stale data or reconnecting line", async ({ failure }) => {
  const { client, key, observer } = setup(failure, false);
  try {
   await observer.refetch();
   expect(client.getQueryData(key)).toBeUndefined();
   for (const html of markup(observer.getCurrentResult())) { expect(html).not.toContain(privateData.details);expect(html).not.toContain("Reconnecting");expect(html).toContain('role="alert"'); }
  } finally { observer.destroy();client.clear(); }
 });
 it.each([401, 403, 404])("%s wipes data after repeated kept failures, including a remounted observer", async status => {
  const { client, key, observer } = setup(new Error("Disconnected"), true);
  try {
   await observer.refetch();await observer.refetch();
   expect(client.getQueryData(key)).toEqual(privateData);
   expect(client.getQueryState(key)?.dataUpdatedAt).toBe(lastRead);
   observer.destroy();
   const remount = new QueryObserver<z.infer<typeof reader>>(client, { queryKey: key, queryFn: async () => { throw new ApiError(status, "REQUEST_FAILED", "Unavailable"); } });
   try {
    await remount.refetch();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(JSON.stringify(client.getQueryState(key))).not.toContain(privateData.details);
    for (const html of markup(remount.getCurrentResult())) expect(html).not.toContain(privateData.details);
   } finally { remount.destroy(); }
  } finally { observer.destroy();client.clear(); }
 });
 it.each(["unknown source", "looping cursor"])("unreadable new answer after good data (%s) keeps only the last validated success", async kind => {
  const client = createQueryClient(), key = ["served-read", "validated-answer", kind];
  const good = { details: "Last good details", source: "cloud", next: "next-page" };
  const bad = { details: "Unreadable new details", source: kind === "unknown source" ? "elsewhere" : "cloud", next: kind === "looping cursor" ? "current-page" : "next-page" };
  let body = good;
  const cell = fakeHost(async () => ({ status: 200, body }));
  const schema = reader.extend({ source: z.enum(["cloud", "engine"]), next: z.string() }).refine(value => value.next !== "current-page");
  const api = createApiClient(cell.host);
  const observer = new QueryObserver(client, { queryKey: key, queryFn: () => api.get("/v1/app/details", schema) });
  try {
   await observer.refetch();
   expect(client.getQueryData(key)).toEqual(good);
   const updatedAt = observer.getCurrentResult().dataUpdatedAt;
   body = bad;
   await observer.refetch();
   const read = observer.getCurrentResult();
   expect(read.error).toMatchObject({ code: "INVALID_RESPONSE" });
   expect(client.getQueryData(key)).toEqual(good);
   expect(JSON.stringify(client.getQueryState(key))).not.toContain(bad.details);
   expect(read.dataUpdatedAt).toBe(updatedAt);
   for (const html of markup(read)) {
    expect(html).toContain(good.details);
    expect(html).not.toContain(bad.details);
    expect(html.match(/Updated .*? · Reconnecting/gu)).toHaveLength(1);
    expect(html).not.toContain('role="alert"');
   }
  } finally { observer.destroy();client.clear(); }
 });
 it("a later successful read replaces kept data and clears the reconnecting line", async () => {
  const { client, key, observer } = setup(new Error("Disconnected"), true);
  try {
   await observer.refetch();
   observer.setOptions({ queryKey: key, queryFn: async () => ({ details: "Newly read company details" }) });
   await observer.refetch();
   expect(client.getQueryData(key)).toEqual({ details: "Newly read company details" });
   for (const html of markup(observer.getCurrentResult())) { expect(html).toContain("Newly read company details");expect(html).not.toContain("Reconnecting"); }
  } finally { observer.destroy();client.clear(); }
 });
 // Code's read rule: a share may read the summary but not this part. The words are Code's own sentence from the response; none is written in Cloud.
 const codesWords = "The owner shared this task's summary with you. The plan is not shown.";
 describe("403 TASK_PART_NOT_SHOWN (a part a share is not shown) through the real client and query cache", () => {
  it("keeps the cached task data and carries Code's own sentence for that tab", async () => {
   const { client, key, observer } = setup({ status: 403, body: { error: { code: "TASK_PART_NOT_SHOWN", message: codesWords } } }, true);
   try {
    await observer.refetch();
    const read = observer.getCurrentResult();
    expect(read.error).toMatchObject({ status: 403, code: "TASK_PART_NOT_SHOWN" });
    expect(client.getQueryData(key)).toEqual(privateData);
    expect(servedReadState(read).data).toEqual(privateData);
    expect(partNotShownWords(read.error)).toBe(codesWords);
    expect(isAccessEnded(read.error)).toBe(false);
   } finally { observer.destroy();client.clear(); }
  });
  it.each([
   ["a real 403 with a refusal code", { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } }],
   ["a 403 with a different Code refusal", { status: 403, body: { error: { code: "TASK_ACCESS_DENIED", message: "No." } } }],
   ["a 403 with no body", { status: 403, body: undefined }],
   ["a 403 with another part-shaped code", { status: 403, body: { error: { code: "TASK_PART_NOT_SHOWN_X", message: "No." } } }],
   ["the part code on a 404 (not a 403)", { status: 404, body: { error: { code: "TASK_PART_NOT_SHOWN", message: "Gone." } } }],
   ["the part code on a 401", { status: 401, body: { error: { code: "TASK_PART_NOT_SHOWN", message: "Sign in." } } }],
   ["the part code with an access word beside it", { status: 403, body: { code: "ACCESS_ENDED", error: { code: "TASK_PART_NOT_SHOWN", message: "Ended." } } }],
  ] as Array<[string, ApiResponse]>)("%s still wipes the cached task data", async (_name, failure) => {
   const { client, key, observer } = setup(failure, true);
   try {
    await observer.refetch();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(servedReadState(observer.getCurrentResult()).data).toBeUndefined();
    expect(partNotShownWords(observer.getCurrentResult().error)).toBeUndefined();
   } finally { observer.destroy();client.clear(); }
  });
 });
 describe("404 ROUTE_NOT_SERVED (Code does not serve this read yet) through the real client and query cache", () => {
  it("keeps the cached data and carries Code's own sentence", async () => {
   const words = "This information is not available yet.";
   const { client, key, observer } = setup({ status: 404, body: { error: { code: "ROUTE_NOT_SERVED", message: words } } }, true);
   try {
    await observer.refetch();
    const read = observer.getCurrentResult();
    expect(read.error).toMatchObject({ status: 404, code: "ROUTE_NOT_SERVED" });
    expect(client.getQueryData(key)).toEqual(privateData);
    expect(servedReadState(read).data).toEqual(privateData);
    expect(routeNotServedWords(read.error)).toBe(words);
   } finally { observer.destroy();client.clear(); }
  });
  it.each([
   ["a task that is not found", { status: 404, body: { error: { code: "TASK_NOT_FOUND", message: "no such task" } } }],
   ["a 404 with no body", { status: 404, body: undefined }],
   ["the route code on a 403", { status: 403, body: { error: { code: "ROUTE_NOT_SERVED", message: "x" } } }],
   ["the route code with an access word beside it", { status: 404, body: { code: "ACCESS_ENDED", error: { code: "ROUTE_NOT_SERVED", message: "x" } } }],
  ] as Array<[string, ApiResponse]>)("%s still wipes the cached data", async (_name, failure) => {
   const { client, key, observer } = setup(failure, true);
   try {
    await observer.refetch();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(routeNotServedWords(observer.getCurrentResult().error)).toBeUndefined();
   } finally { observer.destroy();client.clear(); }
  });
 });
});
