// Setup and test health (SH17): what the auto-fix runner needs to turn an ask about the test environment into a Fix setup card. Exists only while `vx` is on: with it off this returns nothing, the runner has no
// `fixSetup` port and the ask is exactly what it was. The cause is derived from the policy's own codes (never from text), and the tests a "Mark as known failing" could add come from the broker's evidence pack
// of the task's current code (only while the proof switch gives a pack), never from the worker's words.
import { evidenceKeyOf } from "../developer-tasks/evidence-port.js";
import type { OrgId } from "@rovara-code/contracts";
import { companyGatedEnv } from "../../org/feature-rollout.js";
import { failingOnOriginalTests, fixSetupCauseOf, recordFixSetup, FIX_SETUP_MARKABLE_CAUSE } from "../../test-env/fix-setup.js";
import { nightlyOptionsFor, usableNightlyFailing, type NightlyHeadReader } from "../../test-env/nightly-usable.js";
import { alreadyFailingForResults } from "../../test-env/known-failing.js";
import { newFailingCheckIds, workflowCheckKind } from "../../verification/result.js";
import { E2E_PROJECT_CHECK_ID, type EvidencePack } from "@rovara-code/contracts";
import { verifyResultsEnabled } from "../../verification/switch.js";
import type { AutofixDependencies } from "../workflow-autofix-runner.js";
import { nightlyHeadReaderOf } from "./nightly-head.js";
import { evidenceRouteDependencies } from "./evidence-wiring.js";
import type { AwsBrokerDependencies } from "./definitions.js";

/** Reads the broker's evidence pack of a task's current code (the evidence port; absent while the proof switch is off). A test gives its own. */
export type PackReader = (task: { taskId: string; ownerKey: string; workspaceId: string; orgId: OrgId | undefined }, digest: string) => Promise<EvidencePack | undefined>;

export function fixSetupDependencies(dependencies: AwsBrokerDependencies, env: NodeJS.ProcessEnv = process.env, readPack?: PackReader, nightlyHead: NightlyHeadReader | undefined = nightlyHeadReaderOf(dependencies, env)): Pick<AutofixDependencies, "fixSetup" | "newFailingChecks"> {
  if (!verifyResultsEnabled(env)) return {};
  const packOf = (task: { taskId: string; ownerKey: string; workspaceId: string; orgId: OrgId | undefined }, digest: string): Promise<EvidencePack | undefined> => {
    const port = readPack === undefined ? evidenceRouteDependencies(dependencies, env).evidence : undefined;
    const reader: PackReader | undefined = readPack ?? (port === undefined ? undefined : (key, at) => port.pack(key, at));
    return reader === undefined ? Promise.resolve(undefined) : reader(task, digest).catch(() => undefined);
  };
  return {
    // The checks that failed before and also have a failing test that was not failing before (owner decision, M2): the auto-fix policy sends them back as the code's fault. Reads the broker's pack and the same
    // already-failing list the result classifier uses (a usable nightly and the maintainers' marks).
    async newFailingChecks(task, checkOriginal) {
      const digest = task.workflow?.candidate?.digest;
      if (digest === undefined || task.orgId === undefined) return [];
      // TE-A1: the four results follow the company's `verifyResults` gate.
      if (!verifyResultsEnabled(await companyGatedEnv({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, task.orgId, env))) return [];
      const pack = await packOf(evidenceKeyOf(task), digest);
      const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
      const fromPack = pack === undefined ? [] : newFailingCheckIds(pack, await alreadyFailingForResults(store, task.orgId, task.project, await nightlyOptionsFor(store, { taskId: task.taskId, orgId: task.orgId, project: task.project }, nightlyHead)));
      // A TEST check (by the task's own check list) that failed on the original code that the pack does not name (or there is no pack for this code) has no per-test data: nothing about its failures is confirmed (M2), the same answer the result classifier gives. Another or an unknown kind keeps the old rule.
      const covered = new Set((pack?.checks ?? []).map((check) => check.checkId));
      const uncovered = (task.workflow?.verification?.candidateDigest === digest ? task.workflow.verification.results : [])
        .filter((result) => result.status === "FAILED" && result.checkId !== E2E_PROJECT_CHECK_ID && (checkOriginal?.[result.checkId] === "failed" || checkOriginal?.[result.checkId] === "cannot-run") && !covered.has(result.checkId) && workflowCheckKind(task.workflow!, result.checkId) === "test")
        .map((result) => result.checkId);
      return [...new Set([...fromPack, ...uncovered])];
    },
    fixSetup: {
      async record(task, ask) {
        const cause = fixSetupCauseOf(ask.codes);
        if (cause === undefined || task.orgId === undefined) return;
        if (!verifyResultsEnabled(await companyGatedEnv({ documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now }, task.orgId, env))) return;
        const digest = task.workflow?.candidate?.digest;
        const store = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now };
        let offer: ReturnType<typeof failingOnOriginalTests>;
        if (cause === FIX_SETUP_MARKABLE_CAUSE && digest !== undefined) {
          // Only tests the broker's own evidence pack AND the project's last nightly baseline both call failing are ever offered (the nightly set is empty when unknown or truncated: then nothing is offered).
          const port = readPack === undefined ? evidenceRouteDependencies(dependencies, env).evidence : undefined;
          const reader: PackReader | undefined = readPack ?? (port === undefined ? undefined : (key, at) => port.pack(key, at));
          const pack = await reader?.(evidenceKeyOf(task), digest).catch(() => undefined);
          const nightly = (await usableNightlyFailing(store, task.orgId, task.project, await nightlyOptionsFor(store, { taskId: task.taskId, orgId: task.orgId, project: task.project }, nightlyHead)).catch(() => undefined)) ?? [];
          offer = failingOnOriginalTests(pack, nightly);
        }
        // A check that failed before AND has a failing test that was not failing before is the code's fault (Code failed, the code goes back): that is not a setup problem, so no Fix setup card is opened for it.
        if (offer?.codeFault === true) return;
        await recordFixSetup(store, { orgId: task.orgId, project: task.project, taskId: task.taskId, cause, tests: offer?.tests, unconfirmed: offer?.unconfirmed });
      },
    },
  };
}
