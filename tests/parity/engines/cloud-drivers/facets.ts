// Cloud drivers: The messages, spend and audit facets (all compared areas).
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";

export const FACETS_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = {};
