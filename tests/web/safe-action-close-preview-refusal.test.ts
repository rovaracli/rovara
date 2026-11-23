// @vitest-environment jsdom
// DEC 254zzz347/367: the two Close refusals that are proven to happen BEFORE any write, and nothing wider.
import { expect, it } from "vitest";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { isFinalActionRefusal } from "../../packages/ui/src/safe-action.js";
import { isFinalTaskActionRefusal } from "../../packages/ui/src/api/task-action.js";
import { actionErrorRoutes } from "../../packages/ui/src/api/errors.js";
import { CLOSE_TASK_ID } from "./support/task-close-preview.js";
import { isRetainedCloseRefusal } from "../../packages/ui/src/screens/session/close-preview.js";

const route = "/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/close";
const STALE = "the close preview has changed; review it again";
const RETAINED = `This workspace is retained. Review the Close preview at /v1/dev/tasks/${CLOSE_TASK_ID}/close before closing it.`;
const final = (status: number, code: string, message: string, at = route) => isFinalActionRefusal(new ApiError(status, code, message), { route: at });

it.each([STALE, "the close preview has changed"])("a stale bound close (%s) is final on Close only", message => {
 expect(final(409, "CHANGE_STALE", message)).toBe(true);
 expect(final(409, "CHANGE_STALE", message, "/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/stop")).toBe(false);
 expect(final(409, "CHANGE_STALE", message, "/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/retry")).toBe(false);
});
it.each([
 ["another sentence", 409, "CHANGE_STALE", "something changed"], ["another status", 403, "CHANGE_STALE", STALE], ["another code", 409, "CONFLICT", STALE],
 ["a prefixed sentence", 409, "CHANGE_STALE", "x " + STALE], ["a suffixed sentence", 409, "CHANGE_STALE", STALE + " now"],
])("a CHANGE_STALE lookalike (%s) stays unknown", (_name, status, code, message) => { expect(final(status, code, message)).toBe(false); });

it("Code's retained-workspace refusal is final on Close only: exact status, code and sentence", () => {
 expect(final(409, "WORKSPACE_BUSY", RETAINED)).toBe(true);
 for (const other of ["stop", "retry", "take-over", "merge", "answers", "send-back", "accept-findings"]) expect(final(409, "WORKSPACE_BUSY", RETAINED, `/v1/web/sessions/ses_aaaaaaaaaaaaaaaaaaaa/${other}`)).toBe(false);
});
it.each([
 ["Code's other WORKSPACE_BUSY (close.ts:108/117)", 409, "WORKSPACE_BUSY", "Rovara could not close the task just now; try again"],
 ["the worker's busy sentence", 409, "WORKSPACE_BUSY", "workspace is BUSY; wait for active work before closing it"],
 ["another status", 400, "WORKSPACE_BUSY", RETAINED], ["a 5xx", 503, "WORKSPACE_BUSY", RETAINED], ["another code", 409, "CONFLICT", RETAINED],
 ["a changed link path", 409, "WORKSPACE_BUSY", RETAINED.replace("/v1/dev/tasks/", "/v1/dev/other/")], ["a non-uuid task", 409, "WORKSPACE_BUSY", RETAINED.replace(CLOSE_TASK_ID, "not-a-uuid")],
 ["an upper-case task id", 409, "WORKSPACE_BUSY", RETAINED.replace(CLOSE_TASK_ID, CLOSE_TASK_ID.toUpperCase())], ["a suffix", 409, "WORKSPACE_BUSY", RETAINED + " Done."], ["a prefix", 409, "WORKSPACE_BUSY", "! " + RETAINED],
 ["an empty message", 409, "WORKSPACE_BUSY", ""],
])("%s stays UNKNOWN", (_name, status, code, message) => { expect(final(status, code, message)).toBe(false); });

it("the dialog's runner classifies through the recorded dispatch route", () => {
 const failure = new ApiError(409, "WORKSPACE_BUSY", RETAINED);
 expect(isFinalTaskActionRefusal(failure)).toBe(false);
 actionErrorRoutes.set(failure, route);
 expect(isFinalTaskActionRefusal(failure)).toBe(true);
});

it("the dialog's own retained-refusal matcher is exact on status, code and sentence", () => {
 expect(isRetainedCloseRefusal(new ApiError(409, "WORKSPACE_BUSY", RETAINED))).toBe(true);
 for (const other of [new ApiError(409, "WORKSPACE_BUSY", "Rovara could not close the task just now; try again"), new ApiError(400, "WORKSPACE_BUSY", RETAINED), new ApiError(503, "WORKSPACE_BUSY", RETAINED), new ApiError(409, "CONFLICT", RETAINED), new Error(RETAINED), undefined]) expect(isRetainedCloseRefusal(other)).toBe(false);
});
