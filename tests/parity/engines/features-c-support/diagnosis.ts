// Area 32, Fix with agent (a light diagnosis of the error a task shows), compared at the SERVICE level, as the chains are: the journey harness builds
// Cloud's broker with no diagnosis dependencies, and the core engine's runtime has no model key, so neither route can start one end to end there.
// So each product's own diagnosis service runs on the same failed task (the same error reference, failure and project) with its own stores:
//   - Cloud: packages/broker/src/diagnosis/light.ts startLightDiagnosis over tests/support/diagnosis-world.ts (its fake table, its queue to the chat
//     service that answers later);
//   - core: vendored core/diagnosis/service.ts createDiagnosis over the document store port, with an answerer that has a model.
// The cases: the company has no provider; a diagnosis starts; the same request again; the error is no longer the one shown (the step was retried).
// Each records `diagnosis <case> -> <state>` or `-> <code> "<the words the person reads>"`.
import { randomUUID } from "node:crypto";
import { MemoryDocumentStore, localOwnerPrincipal } from "@rovara-code/broker/ports";
import { taskFailureErrorRef, type AuditSink, type ErrorRef, type OrgId } from "@rovara-code/contracts";
import { startLightDiagnosis } from "../../../../packages/broker/src/diagnosis/light.js";
import { createDiagnosis, type DiagnosisAnswerer } from "../../../../vendor/rovara-code/packages/broker/src/core/diagnosis/service.js";
import type { TaskRecord } from "../../../../vendor/rovara-code/packages/broker/src/core/task-flow/records.js";
import { PRIYA, diagnosisWorld } from "../../../support/diagnosis-world.js";

export const DIAGNOSIS_CASES = ["no-provider", "start", "repeat", "not-current"] as const;
type Case = (typeof DIAGNOSIS_CASES)[number];

const FAILURE = { category: "task_failed" as const, message: "The test step failed." };
const AT = "2026-10-22T09:00:00.000Z";

const outcome = (name: Case, result: { state: string } | { code: string; message: string }): string =>
  `diagnosis ${name} -> ${"state" in result ? result.state : `${result.code} "${result.message.replace(/^[A-Z_]+: /u, "")}"`}`;

const caught = (error: unknown): { code: string; message: string } => {
  const code = (error as { code?: unknown }).code;
  return { code: typeof code === "string" ? code : "ERROR", message: error instanceof Error ? error.message : "" };
};

/** Cloud's light diagnosis on its own world. */
export async function cloudDiagnosisWords(): Promise<string[]> {
  const words: string[] = [];
  for (const name of DIAGNOSIS_CASES) {
    const v = diagnosisWorld({ provider: name !== "no-provider" });
    const caller = v.caller(PRIYA);
    const start = (ref: ErrorRef, requestId: string) => startLightDiagnosis(v.diagnosis, caller, { requestId, errorRef: ref });
    const requestId = randomUUID();
    try {
      if (name === "not-current") {
        const shown = v.ref();
        v.retried();
        words.push(outcome(name, await start(shown, requestId)));
        continue;
      }
      const first = await start(v.ref(), requestId);
      if (name === "repeat") {
        const again = await start(v.ref(), requestId);
        words.push(`diagnosis repeat -> ${again.diagnosisId === first.diagnosisId ? "same" : "another"} ${again.state}`);
        continue;
      }
      words.push(outcome(name, first));
    } catch (error) {
      words.push(outcome(name, caught(error)));
    }
  }
  return words;
}

/** The core's diagnosis service on the same failed task. */
export async function codeDiagnosisWords(): Promise<string[]> {
  const words: string[] = [];
  const companyId = "org_s0parity00000000000a" as OrgId;
  const owner = localOwnerPrincipal({ companyId });
  for (const name of DIAGNOSIS_CASES) {
    const taskId = randomUUID();
    let operationId = randomUUID();
    const current = (): ErrorRef => taskFailureErrorRef({ taskId, failure: { category: FAILURE.category }, operationId, at: AT })!;
    const task = { taskId, project: "web", title: "Bump the Stripe SDK", companyId, developerId: "local-owner" } as unknown as TaskRecord;
    const audit: AuditSink = { stage: () => [], async record() { /* audit is compared elsewhere */ } };
    const answerer: DiagnosisAnswerer = {
      prepare: async () => ({ ok: true }),
      // The model's answer is not awaited here, as Cloud's chat service answers a queued diagnosis later: the start's own answer is what is compared.
      answer: () => new Promise(() => undefined),
    };
    const service = createDiagnosis({
      store: new MemoryDocumentStore(), audit, companyId, ...(name === "no-provider" ? {} : { answerer }),
      context: {
        tagKey: "t".repeat(64),
        taskView: async () => ({ title: "Bump the Stripe SDK", status: "FAILED", errorRef: current(), failure: FAILURE, events: [], workflow: { stage: "IMPLEMENT", state: "RUNNING" } }),
        projectFacts: async () => ({ name: "web", mergeMethod: "squash", allowSelfApproval: false, reviewers: 1, devcontainer: { repository: "web", configPath: ".devcontainer/devcontainer.json" }, repositories: ["web"], allowedWebsites: 2 }),
      },
      taskOf: async (_principal, id) => (id === taskId ? task : undefined),
    });
    const requestId = randomUUID();
    const start = (ref: ErrorRef) => service.start(owner, { requestId, errorRef: ref });
    try {
      if (name === "not-current") {
        const shown = current();
        operationId = randomUUID();
        words.push(outcome(name, await start(shown)));
        continue;
      }
      const first = await start(current());
      if (name === "repeat") {
        const again = await start(current());
        words.push(`diagnosis repeat -> ${again.diagnosisId === first.diagnosisId ? "same" : "another"} ${again.state}`);
        continue;
      }
      words.push(outcome(name, first));
    } catch (error) {
      words.push(outcome(name, caught(error)));
    }
  }
  return words;
}
