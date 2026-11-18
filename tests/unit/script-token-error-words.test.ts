import { describe, expect, it } from "vitest";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { scriptTokenError } from "../../packages/ui/src/api/script-tokens.js";

// Fixed words per action: a create refusal names projects and the key limit; revoke keeps the key wording.
describe("automation key error words", () => {
 it("a 404 on create names the projects, not a missing key", () => {
  expect(scriptTokenError(new ApiError(404, "NOT_FOUND", "project not found"), "create")).toBe("One of those projects wasn't found, or you can't use it.");
  expect(scriptTokenError(new ApiError(404, "NOT_FOUND", "token not found"), "revoke")).toBe("That automation key doesn't exist, or you can't manage it.");
 });
 it("a 409 on create points at the key limit; 429 asks to wait", () => {
  expect(scriptTokenError(new ApiError(409, "CONFLICT", "x"), "create")).toBe("You may have reached the limit of automation keys. Revoke one you no longer need, then try again.");
  expect(scriptTokenError(new ApiError(429, "RATE_LIMITED", "x"), "create")).toBe("Too many automation key requests. Wait a moment, then try again.");
 });
 it("route-not-found still means not available yet", () => {
  expect(scriptTokenError(new ApiError(404, "NOT_FOUND", "route not found"), "create")).toBe("Automation keys are not available yet.");
 });
});
