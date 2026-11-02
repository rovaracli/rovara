// Setup and test health (SH17): what the auto-fix runner needs to turn an ask about the test environment into a Fix setup card. Exists only while `vx` is on: with it off this returns nothing, the runner has no
// `fixSetup` port and the ask is exactly what it was. The cause is derived from the policy's own codes (never from text), and the tests a "Mark as known failing" could add come from the broker's evidence pack
// of the task's current code (only while the proof switch gives a pack), never from the worker's words.
import { failingOnOriginalTests, fixSetupCauseOf, recordFixSetup, FIX_SETUP_MARKABLE_CAUSE } from "../../test-env/fix-setup.js";
import { usableNightlyFailing } from "../../test-env/nightly-usable.js";
import { alreadyFailingForResults } from "../../test-env/known-failing.js";
import { newFailingCheckIds } from "../../verification/result.js";
import type { EvidencePack } from "@agentx/contracts";
import { verifyResultsEnabled } from "../../verification/switch.js";
import type { AutofixDependencies } from "../workflow-autofix-runner.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** Reads the broker's evidence pack of a task's current code (the evidence port; absent while the proof switch is off). A test gives its own. */
export type PackReader = (task: { taskId: string; ownerKey: string; workspaceId: string }, digest: string) => Promise<EvidencePack | undefined>;

export function fixSetupDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env, readPack?: PackReader): Pick<AutofixDependencies, "fixSetup" | "newFailingChecks"> {
  if (!verifyResultsEnabled(env)) return {};
  const packOf = (task: { taskId: string; ownerKey: string; workspaceId: string }, digest: string): Promise<EvidencePack | undefined> => {
    const port = readPack === undefined ? evidenceRouteDependencies(dependencies, env).evidence : undefined;
    const reader: PackReader | undefined = readPack ?? (port === undefined ? undefined : (key, at) => port.pack(key, at));
    return reader === undefined ? Promise.resolve(undefined) : reader(task, digest).catch(() => undefined);
  };
  return {
    // The checks that failed before and also have a failing test that was not failing before (owner decision, M2): the auto-fix policy sends them back as the code's fault. Reads the broker's pack and the same
    // already-failing list the result classifier uses (a usable nightly and the maintainers' marks).
    async newFailingChecks(task) {
      const digest = task.workflow?.candidate?.digest;
      if (digest === undefined || task.orgId === undefined) return [];
      const pack = await packOf({ taskId: task.taskId, ownerKey: task.ownerKey, workspaceId: task.workspaceId }, digest);
      if (pack === undefined) return [];
      const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
      return newFailingCheckIds(pack, await alreadyFailingForResults(store, task.orgId, task.project));
    },
    fixSetup: {
      async record(task, ask) {
        const cause = fixSetupCauseOf(ask.codes);
        if (cause === undefined || task.orgId === undefined) return;
        const digest = task.workflow?.candidate?.digest;
        const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
        let offer: ReturnType<typeof failingOnOriginalTests>;
        if (cause === FIX_SETUP_MARKABLE_CAUSE && digest !== undefined) {
          // Only tests the broker's own evidence pack AND the project's last nightly baseline both call failing are ever offered (the nightly set is empty when unknown or truncated: then nothing is offered).
          const port = readPack === undefined ? evidenceRouteDependencies(dependencies, env).evidence : undefined;
          const reader: PackReader | undefined = readPack ?? (port === undefined ? undefined : (key, at) => port.pack(key, at));
          const pack = await reader?.({ taskId: task.taskId, ownerKey: task.ownerKey, workspaceId: task.workspaceId }, digest).catch(() => undefined);
          const nightly = (await usableNightlyFailing(store, task.orgId, task.project).catch(() => undefined)) ?? [];
          offer = failingOnOriginalTests(pack, nightly);
        }
        // A check that failed before AND has a failing test that was not failing before is the code's fault (Code failed, the code goes back): that is not a setup problem, so no Fix setup card is opened for it.
        if (offer?.codeFault === true) return;
        await recordFixSetup(store, { orgId: task.orgId, project: task.project, taskId: task.taskId, cause, tests: offer?.tests, unconfirmed: offer?.unconfirmed });
      },
    },
  };
}
