// Step drivers: how each engine makes one domain step true. One driver per step kind (and per `feature` name, keyed `feature:<name>`), per engine, in its
// own file under core-drivers/ and cloud-drivers/. A new step is one driver for each engine; an engine with no driver for a step reports it, so the area
// shows as "not covered" with the reason.
import type { Scenario, Step, StepSupport } from "../harness/types.js";

export interface StepDriver<Context, Options = never> {
  /** Narrower than "a driver exists": refuse a variant of the step this driver cannot make true (with the reason). */
  supports?(step: Step): StepSupport;
  /** Before the engine starts: what this step needs in the engine's options (Cloud: harness options; core: fake world options). */
  options?(scenario: Scenario): Partial<Options>;
  /** After the engine started and before the first step: settings to apply (a Cloud setting mapped onto a core option, a seeded row). */
  prepare?(context: Context, scenario: Scenario): Promise<void>;
  run(context: Context, step: Step, next: Step | undefined): Promise<void>;
}

/** The key a step is driven by: its kind, or `feature:<name>`. */
export function driverKey(step: Step): string {
  return step.do === "feature" ? `feature:${step.name}` : step.do;
}

export function supportOf<Context, Options>(drivers: Readonly<Record<string, StepDriver<Context, Options>>>, engine: string, step: Step): StepSupport {
  const driver = drivers[driverKey(step)];
  if (driver === undefined) return { unsupported: `no ${engine} driver for ${driverKey(step)} yet` };
  return driver.supports?.(step) ?? true;
}

/** Every step of a scenario, races flattened. */
export function allSteps(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => (step.do === "race" ? [step, ...allSteps(step.steps)] : [step]));
}

/** The drivers a scenario uses, once each, in first-use order. */
export function driversOf<Context, Options>(drivers: Readonly<Record<string, StepDriver<Context, Options>>>, scenario: Scenario): StepDriver<Context, Options>[] {
  const seen = new Set<string>();
  const used: StepDriver<Context, Options>[] = [];
  for (const step of allSteps(scenario.steps)) {
    const key = driverKey(step);
    if (seen.has(key) || drivers[key] === undefined) continue;
    seen.add(key);
    used.push(drivers[key]);
  }
  return used;
}
