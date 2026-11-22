import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { createDecisionsApi, readDecisions } from "../../packages/ui/src/api/decisions.js";
import { fakeHost } from "./support/fake-host.js";

const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views.approve_plan_with_choices))[0]!;
const identity = { orgId: "o-aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };

it("checks a current server read when the original lock is already absent", async () => {
  const view = fixture.views.approve_plan_with_choices;
  const f = fakeHost(async (request: ApiRequest) => request.method === "GET" && request.path === "/v1/app/decisions"
    ? { status: 200, body: view }
    : { status: 500, body: { error: { code: "UNAVAILABLE", message: "No write expected." } } });
  expect(await createDecisionsApi(f.host).checkApproval(decision, identity)).toBe("same_pending");
  expect(f.request.mock.calls).toHaveLength(1);
  expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "GET", path: "/v1/app/decisions" });
});
