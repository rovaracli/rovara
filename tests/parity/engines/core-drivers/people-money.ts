// Core drivers: Spend limits, approvals, erasure, multi-project companies (areas 22, 23, 25, 39).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const PEOPLE_MONEY_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
