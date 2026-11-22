// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import "./support/render.js";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { createDecisionsApi, readDecisions } from "../../packages/ui/src/api/decisions.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
for (const operation of ["changes", "reject", "evidence"] as const) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a Plan ${operation} retains 500/${code} across API recreation`, async () => {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 500, body: { error: { code, message: "Unknown result" } } });
 const send = () => {
  const api = createDecisionsApi(f.host);
  return operation === "changes" ? api.requestChanges(decision, "Please add a regression") : operation === "reject" ? api.reject(decision, "not_now") : api.evidenceOpened(decision);
 };
 await expect(send()).rejects.toBeTruthy();
 expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
 await expect(send()).rejects.toBeTruthy();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
