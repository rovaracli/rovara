// Web task channel K6: Cloud's task list passes on Code's `shared` flag only when it is true (the task has a Slack share), so a task Code does not mark shared reads exactly as before.
import { expect, it } from "vitest";
import { workTask } from "../../packages/cloud-server/src/work-reads.js";

it("passes on only a `shared: true`; any other value leaves the field out", () => {
  const raw = { taskId: "66666666-6666-4666-8666-666666666666", title: "T", project: "web" };
  expect(workTask({ ...raw, shared: true })?.["shared"]).toBe(true);
  for (const shared of [false, undefined, "yes", 1, null]) expect(Object.hasOwn(workTask({ ...raw, shared })!, "shared")).toBe(false);
});
