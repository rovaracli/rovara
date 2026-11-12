// Every core step driver, by step kind (or `feature:<name>`). Each lane owns one file; a key appears in one file only (a test checks).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";
import { TASK_FLOW_DRIVERS } from "./task-flow.js";
import { MERGE_DRIVERS } from "./merge.js";
import { PEOPLE_MONEY_DRIVERS } from "./people-money.js";
import { RESILIENCE_DRIVERS } from "./resilience.js";
import { FACETS_DRIVERS } from "./facets.js";
import { FEATURES_A_DRIVERS } from "./features-a.js";
import { FEATURES_B_DRIVERS } from "./features-b.js";
import { FEATURES_C_DRIVERS } from "./features-c.js";
import { FEATURES_D_DRIVERS } from "./features-d.js";

export const DRIVER_GROUPS: Readonly<Record<string, Readonly<Record<string, StepDriver<CoreContext, FakeWorldOptions>>>>> = {
  "task-flow": TASK_FLOW_DRIVERS,
  "merge": MERGE_DRIVERS,
  "people-money": PEOPLE_MONEY_DRIVERS,
  "resilience": RESILIENCE_DRIVERS,
  "facets": FACETS_DRIVERS,
  "features-a": FEATURES_A_DRIVERS,
  "features-b": FEATURES_B_DRIVERS,
  "features-c": FEATURES_C_DRIVERS,
  "features-d": FEATURES_D_DRIVERS,
};

export const CORE_DRIVERS: Readonly<Record<string, StepDriver<CoreContext, FakeWorldOptions>>> = Object.assign({}, ...Object.values(DRIVER_GROUPS)) as Record<string, StepDriver<CoreContext, FakeWorldOptions>>;
