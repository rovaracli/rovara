import { describe, expect, it } from "vitest";
import { WeeklyLessonsReaderSchema, WeeklySummaryReaderSchema } from "@agentx/contracts/web";
import { repeatWords } from "../../packages/ui/src/screens/project/lessons/RepeatsLine.js";

describe("lessons extras readers and words", () => {
 it("keeps only the named forwarder shapes and rejects malformed answers", () => {
  const weekly = WeeklyLessonsReaderSchema.parse({ project: "p", weekly: { needLook: [{ id: "l", cause: "asked_to_keep" }], picks: [] }, extra: true });
  expect(weekly.weekly.needLook[0]?.["cause"]).toBe("asked_to_keep");
  expect(() => WeeklySummaryReaderSchema.parse({ project: "p", on: "yes", source: "default", canChange: false })).toThrow();
 });
 it("uses the four required count wordings and singular once", () => {
  expect(repeatWords({ repeated: 3, corrections: 21, enoughData: true })).toBe("Corrections you had to repeat: 3 of 21 this month.");
  expect(repeatWords({ repeated: 0, corrections: 21, enoughData: true })).toBe("No repeated corrections this month (21 corrections).");
  expect(repeatWords({ repeated: 1, corrections: 4, enoughData: false })).toBe("Not enough corrections yet this month (4 so far; 10 needed).");
  expect(repeatWords({ repeated: 0, corrections: 0, enoughData: false })).toBe("No corrections yet this month.");
 });
});
