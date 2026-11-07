// UX2 slice 2: the browser reaches exactly the new routes the app calls, and nothing near them: the task page's Resolve findings and Send back to coding (POST only, a task id only), and
// the person's own notification setting (GET and PUT, no id anywhere).
import { describe, expect, it } from "vitest";
import { webRouteAllowed } from "../../packages/broker/src/aws/web-auth.js";

const TASK = "11111111-1111-4111-8111-111111111111";

describe("web route rule: UX2 slice 2", () => {
  it("allows Resolve findings and Send back to coding on a task, only as POST", () => {
    for (const action of ["review-findings", "send-back"]) {
      expect(webRouteAllowed("POST", `/v1/web/tasks/${TASK}/workflow/${action}`)).toBe(true);
      for (const method of ["GET", "PUT", "DELETE"]) expect(webRouteAllowed(method, `/v1/web/tasks/${TASK}/workflow/${action}`)).toBe(false);
    }
  });

  it("allows nothing else under a task's workflow, nor a path that is not a task id", () => {
    for (const path of [`tasks/${TASK}/workflow/retry`, `tasks/${TASK}/workflow/decision`, `tasks/${TASK}/workflow/review-findings/x`, "tasks/not-a-task/workflow/send-back", `tasks/${TASK}/../${TASK}/workflow/send-back`]) {
      expect(webRouteAllowed("POST", `/v1/web/${path}`), path).toBe(false);
    }
  });

  it("allows the person's own notification setting to be read and changed, and nothing else under it", () => {
    expect(webRouteAllowed("GET", "/v1/web/me/notifications")).toBe(true);
    expect(webRouteAllowed("PUT", "/v1/web/me/notifications")).toBe(true);
    expect(webRouteAllowed("POST", "/v1/web/me/notifications")).toBe(false);
    expect(webRouteAllowed("PUT", "/v1/web/me/notifications/someone")).toBe(false);
  });
});
