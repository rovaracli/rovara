// Core drivers: Merge tracking, branch sync, merge conflicts (areas 12, 41).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const MERGE_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
