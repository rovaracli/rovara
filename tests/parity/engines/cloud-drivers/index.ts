// Every cloud step driver, by step kind (or `feature:<name>`). Each lane owns one file; a key appears in one file only (a test checks).
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";
import { TASK_FLOW_DRIVERS } from "./task-flow.js";
import { MERGE_DRIVERS } from "./merge.js";
import { PEOPLE_MONEY_DRIVERS } from "./people-money.js";
import { RESILIENCE_DRIVERS } from "./resilience.js";
import { FACETS_DRIVERS } from "./facets.js";
import { FEATURES_A_DRIVERS } from "./features-a.js";
import { FEATURES_B_DRIVERS } from "./features-b.js";
import { FEATURES_C_DRIVERS } from "./features-c.js";

export const DRIVER_GROUPS: Readonly<Record<string, Readonly<Record<string, StepDriver<CloudContext, CloudOptions>>>>> = {
  "task-flow": TASK_FLOW_DRIVERS,
  "merge": MERGE_DRIVERS,
  "people-money": PEOPLE_MONEY_DRIVERS,
  "resilience": RESILIENCE_DRIVERS,
  "facets": FACETS_DRIVERS,
  "features-a": FEATURES_A_DRIVERS,
  "features-b": FEATURES_B_DRIVERS,
  "features-c": FEATURES_C_DRIVERS,
};

export const CLOUD_DRIVERS: Readonly<Record<string, StepDriver<CloudContext, CloudOptions>>> = Object.assign({}, ...Object.values(DRIVER_GROUPS)) as Record<string, StepDriver<CloudContext, CloudOptions>>;
