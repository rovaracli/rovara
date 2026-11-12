// Cloud drivers: Decision timeouts, notifications, races, lost workers, session messages, review send-backs (areas 1, 5, 6, 7, 19, 21).
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";

export const RESILIENCE_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = {};
