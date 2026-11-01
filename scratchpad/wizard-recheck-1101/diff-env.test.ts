import { expect, it } from "vitest";
import { testEnvChangeLines } from "../../packages/broker/src/org/test-env-diff.js";
import { command, draftBody } from "../../tests/support/setup-wizard-testenv.js";

it("an env-only change to a check command shows no line", () => {
  const before = draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: command("make", ["test"], 60), kind: "test" }] }] });
  const c = { ...command("make", ["test"], 60), env: { NODE_OPTIONS: "--require ./evil.js" } };
  const after = draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: c, kind: "test" }] }] });
  console.log(JSON.stringify(testEnvChangeLines(before, after)));
  expect(testEnvChangeLines(before, after)).toEqual([]);
});
