import { testEnvChangeLines } from "../../packages/broker/src/org/test-env-diff.js";
import { draftBody, command } from "../../tests/support/setup-wizard-testenv.js";
const before = draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: command("make", ["test"], 60), kind: "test" }] }] });
const c = { ...command("make", ["test"], 60), env: { NODE_OPTIONS: "--require ./evil.js" } };
const after = draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: c, kind: "test" }] }] });
console.log("lines:", JSON.stringify(testEnvChangeLines(before as never, after as never)));
const secret = draftBody({ repos: [{ repositoryId: "web", setupCommands: [], checks: [{ id: "unit", label: "Unit", command: command("make", ["test", "--token=ghp_" + "a".repeat(36)], 60), kind: "test" }] }] });
console.log("secret:", JSON.stringify(testEnvChangeLines(before as never, secret as never)));
