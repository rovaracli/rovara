// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import "./support/render.js";
import { DecisionCardsViewReaderSchema } from "@agentx/contracts/web";
import { createDecisionsApi, readDecisions } from "../../packages/ui/src/api/decisions.js";
import { createDesignReviewApi } from "../../packages/ui/src/api/design-review.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
for (const choice of ["lower-tier", "raise-cap", "run-unpriced", "skip"]) for (const code of ["CSRF_INVALID", "CSRF_STALE", "UNRECOGNISED"]) it(`R3/R6a spend ${choice}: 500/${code} never releases its frozen choice`, async () => {
 const view = DecisionCardsViewReaderSchema.parse(fixture.views["approve_spend"]), taskId = "11111111-1111-4111-8111-111111111111";
 const action = { kind: "choose" as const, method: "POST" as const, href: `/v1/app/tasks/${taskId}/design-review/spend/${choice}`, label: choice };
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse({ ...view, cards: [{ ...view.cards[0]!, taskId, actions: [action] }] }))[0]!;
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 500, body: { error: { code, message: "Unknown result" } } });
 const press = () => createDesignReviewApi(f.host).chooseSpend(decision, action, crypto.randomUUID());
 await expect(press()).rejects.toBeTruthy();expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
 await expect(press()).rejects.toBeTruthy();
 const posts = f.request.mock.calls.filter(([r]) => r.method === "POST");expect(posts).toHaveLength(1);
 expect(posts[0]![0]).toMatchObject({ path: action.href, body: { shownDigest: decision.digest }, retry: "never" });
});
