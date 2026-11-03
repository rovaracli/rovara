// Test environment (wire-testenv): what the evidence says about the environment a task ran in. The pack's Environment line names the approved test environment and its revision, the data guard is given the
// environment's own production list, and a task whose project HAS an approved environment that was not applied says so (and why) instead of the plain "No approved test environment".
//
// The task's pinned revision is the truth, not the project's newest one: a later approval does not rewrite what an earlier task ran in. Nothing is claimed that the task flow did not do: services and accounts are
// empty (an environment with either is not applied, see usable.ts), and the data is "synthetic" only because a sandbox of the project's own checks touches no other data.
import { UNUSED_WORDS, readTestEnvPin, usableTestEnvironment } from "./usable.js";
import { testEnvironmentEnabled } from "./switch.js";
import type { TestEnvDeps } from "../org/test-environment.js";
import type { EvidenceEnvironment, EvidenceNotTested, OrgId, TestEnvProdDeny } from "@agentx/contracts";
import type { PinnedDependency } from "../rovara-code/dependency-evidence.js";

export interface EvidenceEnvironmentChoice {
  environment?: EvidenceEnvironment | undefined;
  deny?: TestEnvProdDeny | undefined;
  /** Replaces "No approved test environment" when the project has one that was not used. */
  note?: EvidenceNotTested | undefined;
  /** Test services: the dependencies the task's pinned environment lists, as the broker pinned them. The pack's rows are built from these and the worker's usage record; only with the switch `tx` on (an environment with dependencies is not used otherwise). */
  dependencies?: readonly PinnedDependency[] | undefined;
}

/** Never throws; with the switch off, or no pin, it says nothing (the pack then reads as it did before). */
export async function evidenceEnvironmentOf(deps: TestEnvDeps, task: { orgId?: OrgId | undefined; project?: string | undefined; taskId: string }, env: NodeJS.ProcessEnv = process.env): Promise<EvidenceEnvironmentChoice> {
  if (!testEnvironmentEnabled(env) || task.orgId === undefined || task.project === undefined) return {};
  try {
    const pin = await readTestEnvPin(deps, task.orgId, task.project, task.taskId);
    if (pin === undefined) return {};
    if (pin.unused !== undefined) return { note: { kind: "environment", id: "test_environment", text: `${UNUSED_WORDS[pin.unused]}: the project's own test setup was used`, reason: "not applied" } };
    const found = await usableTestEnvironment(deps, task.orgId, task.project, pin.revision, env);
    if (!found.ok) return { note: { kind: "environment", id: "test_environment", text: `${UNUSED_WORDS[found.reason]}: the project's own test setup was used`, reason: "not applied" } };
    const body = found.environment.environment;
    const dependencies = (body.dependencies ?? []).flatMap((dependency): PinnedDependency[] => (dependency.backing.kind === "local" ? [{ id: dependency.id, name: dependency.name, backing: "local", ...(dependency.backing.substituteImage === undefined ? {} : { substituteImage: true }) }] : []));
    return { environment: { tier: body.tier, envRevision: found.environment.revision, services: [], data: "synthetic", accounts: [] }, deny: body.prodDeny, ...(dependencies.length === 0 ? {} : { dependencies }) };
  } catch {
    return {};
  }
}
