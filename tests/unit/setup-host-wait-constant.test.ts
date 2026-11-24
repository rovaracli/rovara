import { expect, it } from "vitest";
import { SETUP_HOST_WAIT_MAX_HOURS } from "../../packages/contracts/src/setup-run.js";

// The park limit mirrors Code's (2 hours since the park-limit lane). The run-gone backstop is a different meaning and a different constant in Code (24 hours).
it("the park limit mirrors Code's 2 hours and is not the 24-hour run-gone backstop", () => {
  expect(SETUP_HOST_WAIT_MAX_HOURS).toBe(2);
});
