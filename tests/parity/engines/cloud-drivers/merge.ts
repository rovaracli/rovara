// Cloud drivers: Merge tracking, branch sync, merge conflicts (areas 12, 41).
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";

export const MERGE_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = {};
