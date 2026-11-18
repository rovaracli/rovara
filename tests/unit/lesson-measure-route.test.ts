import { describe, expect, it } from "vitest";
import type { LessonMeasureResponse } from "../../packages/contracts/src/code-contract-v0.js";
import { CodeError } from "../../packages/cloud-server/src/code-client.js";
import { LESSONS_ROUTES } from "../../packages/cloud-server/src/lessons-routes.js";
import type { RouteContext } from "../../packages/cloud-server/src/routes.js";

const response: LessonMeasureResponse = {
  project: "web", windowDays: 30, floor: 0.35, loads: 7, lessonsInUse: 12, loadedLessons: 21, loadedBelowFloor: 3,
  loadsWithBelowFloor: 2, loadedNoMatch: 1, meanWordsLoaded: 0.42, meanWordsLeftOut: 0.3, loadsCapBound: 1,
  leftOutAtOrAboveFloor: 4, meanFitLoaded: 0.61, meanFitLeftOut: 0.39, cleanMerge: { merged: 5, reverted: 0, clean: 5, rate: 1 },
  revertDetection: "not_wired", truncated: false, unreadable: 0,
};
const route = LESSONS_ROUTES.find((entry) => entry.path.test("/projects/web/lessons/measure"))!;
function context(json: () => Promise<unknown>): RouteContext {
  return { params: ["web"], client: { json } as never } as unknown as RouteContext;
}

describe("the lessons measure pass-through", () => {
  it("rebuilds only Code's documented fields", async () => {
    const answer = await route.answer(context(async () => ({ ...response, unknown: "must not escape", cleanMerge: { ...response.cleanMerge, detail: "must not escape" } })));
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual(response);
  });

  it("uses fixed words for Code refusals and maps missing routes to not available yet", async () => {
    const denied = await route.answer(context(async () => { throw new CodeError(403, {}); }));
    expect(denied).toMatchObject({ status: 403, body: { error: { message: "Only a project maintainer, or a company owner or admin, can see the lessons measure." } } });
    const routeMissing = await route.answer(context(async () => { throw new CodeError(404, { error: { code: "NOT_FOUND", message: "route not found" } }); }));
    expect(routeMissing).toMatchObject({ status: 501, body: { error: { message: "Lessons measure isn't available on this Rovara yet." } } });
    const methodMissing = await route.answer(context(async () => { throw new CodeError(405, {}); }));
    expect(methodMissing.status).toBe(501);
    const unavailable = await route.answer(context(async () => { throw new CodeError(503, {}); }));
    expect(unavailable).toMatchObject({ status: 503, body: { error: { message: "Lessons measure is unavailable right now. Try again." } } });
  });

  it("answers unreadable or mismatched Code data with fixed unavailable words", async () => {
    const invalid = await route.answer(context(async () => ({ ...response, project: "other" })));
    expect(invalid).toMatchObject({ status: 503, body: { error: { message: "Lessons measure is unavailable right now. Try again." } } });
  });
});
