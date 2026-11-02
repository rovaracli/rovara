// Setup and test health (SH17): what the auto-fix runner needs to turn an ask about the test environment into a Fix setup card. Exists only while `vx` is on: with it off this returns nothing, the runner has no
// `fixSetup` port and the ask is exactly what it was. The cause is derived from the policy's own codes (never from text), and the tests a "Mark as known failing" could add come from the broker's evidence pack
// of the task's current code (only while the proof switch gives a pack), never from the worker's words.
import { failingOnOriginalTests, fixSetupCauseOf, recordFixSetup, FIX_SETUP_MARKABLE_CAUSE } from "../../test-env/fix-setup.js";
import { verifyResultsEnabled } from "../../verification/switch.js";
import type { AutofixDependencies } from "../workflow-autofix-runner.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

export function fixSetupDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env): Pick<AutofixDependencies, "fixSetup"> {
  if (!verifyResultsEnabled(env)) return {};
  return {
    fixSetup: {
      async record(task, ask) {
        const cause = fixSetupCauseOf(ask.codes);
        if (cause === undefined || task.orgId === undefined) return;
        const digest = task.workflow?.candidate?.digest;
        const pack = cause === FIX_SETUP_MARKABLE_CAUSE && digest !== undefined
          ? await evidenceRouteDependencies(dependencies, env).evidence?.pack({ taskId: task.taskId, ownerKey: task.ownerKey, workspaceId: task.workspaceId }, digest).catch(() => undefined)
          : undefined;
        await recordFixSetup(
          { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now },
          { orgId: task.orgId, project: task.project, taskId: task.taskId, cause, tests: failingOnOriginalTests(pack) },
        );
      },
    },
  };
}
