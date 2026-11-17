// Staging walkthrough 2026-11-17 item 10: Cloud's 501 NOT_ON_CODE_YET carries the raw route ("/v1/app/projects/x/how-we-work isn't connected to Rovara Code yet.").
// The app never shows that to a person: every such answer reads "Not available yet." The code stays, so screens that word their own absence still can.
import { expect, it } from "vitest";
import { NOT_AVAILABLE_YET, apiError } from "../../packages/ui/src/api/errors.js";

const origin = "https://app.example.test";
it("words Cloud's not-on-Code answer plainly and keeps its code and status", () => {
  const error = apiError(501, { error: { code: "NOT_ON_CODE_YET", message: "/v1/app/projects/rovara/how-we-work isn't connected to Rovara Code yet." } }, origin);
  expect(error.message).toBe(NOT_AVAILABLE_YET);
  expect(NOT_AVAILABLE_YET).toBe("Not available yet.");
  expect(error.code).toBe("NOT_ON_CODE_YET");
  expect(error.status).toBe(501);
  expect(error.message).not.toContain("/v1/");
});
it("keeps a route's own fixed not-yet sentence, which names its subject and no route", () => {
  expect(apiError(501, { error: { code: "NOT_ON_CODE_YET", message: "Connecting GitHub isn't available yet." } }, origin).message).toBe("Connecting GitHub isn't available yet.");
});
it("leaves every other refusal's words as the server sent them", () => {
  expect(apiError(404, { error: { code: "NOT_FOUND", message: "project not found" } }, origin).message).toBe("project not found");
  expect(apiError(501, { error: { code: "SOMETHING_ELSE", message: "Kept as sent." } }, origin).message).toBe("Kept as sent.");
  expect(apiError(403, { error: { code: "FORBIDDEN", message: "Your access ended." } }, origin).message).toBe("Your access ended.");
});
