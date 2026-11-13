// The seam for running the same scenarios against a real deployment (staging) later. NOT run by this suite and never on AWS from a test shard: an engine
// that drives a deployed broker over its public routes (start a task, read it, decide) with a staging developer token, and a worker stand-in that
// answers through the deployed callback routes. It is created only when PARITY_STAGING=1 and an address and token are given, and refuses otherwise.
//
// The controller runs it after the combined switch is on for the staging company (decision 130), once with the switch on (core) and once for a
// company left off (Cloud's path), and compares the two with the same `compareScenario`.
import type { Facet, Observation, ParityEngine, Step, StepSupport } from "./types.js";

export interface StagingTargetOptions {
  /** The deployment's API address (from the install's outputs). */
  baseUrl: string;
  /** A developer token for the company the run uses, read from the environment by the caller (never logged). */
  token: string;
  /** The company: on the core switch (engine `core`) or not (engine `cloud`). */
  companyId: string;
  engine: "cloud" | "core";
  env?: NodeJS.ProcessEnv;
}

export class StagingTargetRefused extends Error {
  constructor(why: string) {
    super(`the staging target is not enabled: ${why}`);
    this.name = "StagingTargetRefused";
  }
}

export function createStagingEngine(options: StagingTargetOptions): ParityEngine {
  const env = options.env ?? process.env;
  if (env.PARITY_STAGING !== "1") throw new StagingTargetRefused("set PARITY_STAGING=1 (the controller runs it, never a test shard)");
  if (!/^https:\/\//.test(options.baseUrl)) throw new StagingTargetRefused("the address must be https");
  const unsupported = (what: string): StepSupport => ({ unsupported: `the staging target does not drive ${what} yet` });
  return {
    name: `staging-${options.engine}`,
    supports: (step: Step) => unsupported(step.do),
    observes: (facet: Facet) => unsupported(facet),
    run: (): Promise<Observation> => Promise.reject(new StagingTargetRefused("no step is wired yet")),
    dispose: () => Promise.resolve(),
  };
}
