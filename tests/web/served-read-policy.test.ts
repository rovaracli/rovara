import { describe, expect, it } from "vitest";
import { accessEndedCode, isAccessEnded, servedReadState } from "../../packages/ui/src/api/served-read.js";

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
});
