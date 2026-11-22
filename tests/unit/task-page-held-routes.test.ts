import { expect, it, vi } from "vitest";
import { DECISION_REJECT_REASONS, DecisionRejectBodySchema } from "@agentx/contracts/web";
import { ROUTES, type RouteContext } from "../../packages/cloud-server/src/routes.js";

const task = "11111111-1111-4111-8111-111111111111";
for (const suffix of ["design-review/spend/lower-tier", "design-review/spend/raise-cap", "design-review/spend/run-unpriced", "design-review/spend/skip", "continue-as-task", "second-review-acknowledge"]) it(`held unserved action has no Cloud route: ${suffix}`, () => {
 expect(ROUTES.filter(route => route.method === "POST" && route.path.test(`/tasks/${task}/${suffix}`))).toHaveLength(0);
});
it("Fix with agent has no Cloud diagnosis route", () => {
 expect(ROUTES.filter(route => route.method === "POST" && route.path.test("/diagnoses"))).toHaveLength(0);
});
for (const reason of DECISION_REJECT_REASONS) it(`the live Cloud proxy preserves the published rejection input: ${reason}`, async () => {
 const path = "/decisions/fix_setup/fix1/reject";
 const rows = ROUTES.filter(route => route.method === "POST" && route.path.test(path));expect(rows).toHaveLength(1);
 const body = DecisionRejectBodySchema.parse({ requestId: "22222222-2222-4222-8222-222222222222", reason });
 const answer = { cardId: "fix_setup:fix1", outcome: "rejected", remainingTabs: [] };
 const json = vi.fn(async () => answer), session = {} as RouteContext["session"];
 // This proxy reads only client/session/params/query/body. The real CodeClient
 // is replaced at its IO boundary; no network or credentials are involved.
 const context = { client: { json }, session, params: path.slice(1).split("/").slice(1), query: new URLSearchParams(), body } as unknown as RouteContext;
 expect(await rows[0]!.answer(context)).toEqual({ status: 200, body: answer });
 expect(json).toHaveBeenCalledExactlyOnceWith(session, "/v1/app/decisions/fix_setup/fix1/reject", { method: "POST", body });
});
