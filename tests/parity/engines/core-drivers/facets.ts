// Core drivers: The messages, spend and audit facets (all compared areas).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const FACETS_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
