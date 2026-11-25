import { describe, expect, it } from "vitest";
import { accessEndedCode, isAccessEnded, isPartNotShown, isRouteNotServed, partNotShownWords, routeNotServedWords, servedReadState } from "../../packages/ui/src/api/served-read.js";

describe("served read policy edges", () => {
 it.each([401, 403, 404])("HTTP %s without an error body wipes", status => {
  expect(servedReadState({ data: { private: "earlier" }, dataUpdatedAt: 12, isError: true, error: { status } })).toEqual({ data: undefined, staleSince: undefined });
 });
 it.each(["access-ended", "forbidden", "not-found", "SESSION_EXPIRED", "ACCESS_LOST", "IDENTITY_CHANGED"])("body/terminal signal %s wipes independently of status", code => {
  expect(isAccessEnded({ status: 200, error: { code } })).toBe(true);
  expect(servedReadState({ data: { private: "earlier" }, dataUpdatedAt: 12, isError: true, error: { code } })).toEqual({ data: undefined, staleSince: undefined });
 });
 it("recognizes any access signal without interpreting prose or ordinary task terminal states", () => {
  expect(accessEndedCode({ error: { code: "UNAVAILABLE" }, code: "ACCESS_ENDED" })).toBe("ACCESS_ENDED");
  for (const error of [null, "forbidden", { message: "Not found" }, { code: "TASK_CLOSED" }, { kind: "terminal" }, { code: "INVALID_RESPONSE" }, { status: Symbol("unknown") }]) expect(isAccessEnded(error)).toBe(false);
 });
 it.each([null, 0, false, ""])("a successful empty value %j is still earlier data; timestamp zero is valid", data => {
  expect(servedReadState({ data, dataUpdatedAt: 0, isError: true, error: new Error("Unknown") })).toEqual({ data, staleSince: 0 });
 });
 it("does not create a stale state for an initial failure or a successful read", () => {
  expect(servedReadState({ data: undefined, dataUpdatedAt: 0, isError: true, error: { status: 503 } })).toEqual({ data: undefined, staleSince: undefined });
  expect(servedReadState({ data: "fresh", dataUpdatedAt: 31, isError: false, error: null })).toEqual({ data: "fresh", staleSince: undefined });
 });
 it("failureReason handles an in-progress retry without losing an access refusal", () => {
  expect(servedReadState({ data: "private", dataUpdatedAt: 12, isError: false, failureCount: 1, error: null, failureReason: { status: 403 } })).toEqual({ data: undefined, staleSince: undefined });
  expect(servedReadState({ data: "kept", dataUpdatedAt: 12, isError: false, failureCount: 1, error: null, failureReason: { status: 503 } })).toEqual({ data: "kept", staleSince: 12 });
 });
 describe("TASK_PART_NOT_SHOWN (403: the summary may be read, this part is not shown)", () => {
  const words = "The owner shared this task's summary with you. The checks are not shown.";
  it("is not an access loss: the cached data stays, and the tab's words are the sentence Code served", () => {
   const error = { status: 403, code: "TASK_PART_NOT_SHOWN", message: words };
   expect(isPartNotShown(error)).toBe(true);
   expect(isAccessEnded(error)).toBe(false);
   expect(servedReadState({ data: { summary: "kept" }, dataUpdatedAt: 12, isError: true, error })).toEqual({ data: { summary: "kept" }, staleSince: 12 });
   expect(servedReadState({ data: "kept", dataUpdatedAt: 12, isError: false, failureCount: 1, error: null, failureReason: error })).toEqual({ data: "kept", staleSince: 12 });
   expect(partNotShownWords(error)).toBe(words);
  });
  it("never invents words: no sentence from Code means no words", () => {
   for (const message of [undefined, "", "   ", 7]) expect(partNotShownWords({ status: 403, code: "TASK_PART_NOT_SHOWN", message })).toBeUndefined();
  });
  it.each([
   [{ status: 403 }], [{ status: 403, code: "FORBIDDEN" }], [{ status: 403, code: "TASK_ACCESS_DENIED" }], [{ status: 403, code: "task_part_not_shown" }],
   [{ status: 404, code: "TASK_PART_NOT_SHOWN" }], [{ status: 401, code: "TASK_PART_NOT_SHOWN" }],
   [{ status: 403, code: "TASK_PART_NOT_SHOWN", error: { code: "ACCESS_ENDED" } }],
  ])("%j is still an access loss and wipes", error => {
   expect(isPartNotShown(error)).toBe(false);
   expect(isAccessEnded(error)).toBe(true);
   expect(servedReadState({ data: "private", dataUpdatedAt: 12, isError: true, error })).toEqual({ data: undefined, staleSince: undefined });
   expect(partNotShownWords(error)).toBeUndefined();
  });
  it("the code alone, with no 403, is not this refusal and is no access signal either", () => {
   const error = { code: "TASK_PART_NOT_SHOWN", message: words };
   expect(isPartNotShown(error)).toBe(false);
   expect(partNotShownWords(error)).toBeUndefined();
   expect(isAccessEnded(error)).toBe(false);
  });
 });
 describe("ROUTE_NOT_SERVED (404: the read is not served on this install yet)", () => {
  const words = "This information is not available yet.";
  it("is not an access loss: cached data stays, and the words are the sentence Code served", () => {
   const error = { status: 404, code: "ROUTE_NOT_SERVED", message: words };
   expect(isRouteNotServed(error)).toBe(true);
   expect(isAccessEnded(error)).toBe(false);
   expect(servedReadState({ data: { summary: "kept" }, dataUpdatedAt: 12, isError: true, error })).toEqual({ data: { summary: "kept" }, staleSince: 12 });
   expect(servedReadState({ data: "kept", dataUpdatedAt: 12, isError: false, failureCount: 1, error: null, failureReason: error })).toEqual({ data: "kept", staleSince: 12 });
   expect(routeNotServedWords(error)).toBe(words);
  });
  it("never invents words", () => {
   for (const message of [undefined, "", "  ", 7]) expect(routeNotServedWords({ status: 404, code: "ROUTE_NOT_SERVED", message })).toBeUndefined();
  });
  it.each([
   [{ status: 404 }], [{ status: 404, code: "TASK_NOT_FOUND" }], [{ status: 404, code: "NOT_FOUND" }], [{ status: 404, code: "PROJECT_NOT_FOUND" }],
   [{ status: 403, code: "ROUTE_NOT_SERVED" }], [{ status: 401, code: "ROUTE_NOT_SERVED" }], [{ status: 404, code: "route_not_served" }],
   [{ status: 404, code: "ROUTE_NOT_SERVED", error: { code: "ACCESS_ENDED" } }],
  ])("%j is still an access loss and wipes", error => {
   expect(isRouteNotServed(error)).toBe(false);
   expect(isAccessEnded(error)).toBe(true);
   expect(servedReadState({ data: "private", dataUpdatedAt: 12, isError: true, error })).toEqual({ data: undefined, staleSince: undefined });
   expect(routeNotServedWords(error)).toBeUndefined();
  });
 });
});
