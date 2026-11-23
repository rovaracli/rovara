import { expect, it } from "vitest";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { isFinalActionRefusal } from "../../packages/ui/src/safe-action.js";
const id = "ses_aaaaaaaaaaaaaaaaaaaa", route = (action: string) => `/v1/app/sessions/${id}/${action}`;
const configWords = [
 "refresh the task and include its current revision before retrying verification",
 "choose checks that are approved for this project",
 "this action can retry blocked planning or coding, or run selected checks for blocked verification or a change ready to publish",
 "the approved ordered work plan is retained, but this broker is not enabled to retry it",
];
for (const words of configWords) it(`N3 shared refusal classification accepts Code's real 400: ${words}`, () => {
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: route("retry") })).toBe(true);
 for (const action of ["send-back", "accept-findings", "unreviewed"]) expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: route(action) })).toBe(false);
 for (const [status, code, message] of [[500, "CONFIG_INVALID", words], [408, "CONFIG_INVALID", words], [429, "CONFIG_INVALID", words], [400, "FUTURE_CODE", words], [400, "CONFIG_INVALID", "Post-apply failure"]] as const) expect(isFinalActionRefusal(new ApiError(status, code, message), { route: route("retry") })).toBe(false);
});
for (const action of ["send-back", "accept-findings"]) for (const words of ["The displayed revision and candidate digest are required.", "This page is out of date. Reload to continue."]) it(`N4 ${action}: only the existing missing-pin validation is final: ${words}`, () => {
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: route(action) })).toBe(true);
 for (const other of ["retry", "close", "unreviewed"]) expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", words), { route: route(other) })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(500, "CONFIG_INVALID", words), { route: route(action) })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(400, "FUTURE_CODE", words), { route: route(action) })).toBe(false);
 expect(isFinalActionRefusal(new ApiError(400, "CONFIG_INVALID", "Post-apply failure"), { route: route(action) })).toBe(false);
});
// R4: the out-of-date sentence is thrown pre-write (parity-task-actions.ts:76, 84) but ALSO via started(...) AFTER admitRound + startImplementation/startPublication (:78, :95), so NO Retry 409 IDEMPOTENCY_CONFLICT sentence is final; the list is empty.
const staleWords = ["this retry is out of date; refresh the task and try again"];
for (const words of staleWords) it(`R4 Retry 409 IDEMPOTENCY_CONFLICT stays unknown, even with Code's out-of-date words: ${words}`, () => {
 for (const r of [route("retry"), `/v1/web/sessions/${id}/retry`]) for (const pullCount of [undefined, 1]) expect(isFinalActionRefusal(new ApiError(409, "IDEMPOTENCY_CONFLICT", words), { route: r, ...(pullCount === undefined ? {} : { pullCount }) })).toBe(false);
 for (const action of ["send-back", "accept-findings", "unreviewed"]) expect(isFinalActionRefusal(new ApiError(409, "IDEMPOTENCY_CONFLICT", words), { route: route(action) })).toBe(false);
});
it("N3 Retry 409 IDEMPOTENCY_CONFLICT with other words stays unknown", () => {
 for (const words of ["this retry request ID was already used for a different check selection", "this request ID was already used for another retry", "the verification retry is stale; refresh the task and choose checks again", "this retry request ID was already used for a different recovery request", "People changed; refresh the task and try again", "", "Unreviewed words", ...staleWords]) expect(isFinalActionRefusal(new ApiError(409, "IDEMPOTENCY_CONFLICT", words), { route: route("retry") })).toBe(false);
});
