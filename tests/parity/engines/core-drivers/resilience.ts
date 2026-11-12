// Core drivers: Decision timeouts, notifications, races, lost workers, session messages, review send-backs (areas 1, 5, 6, 7, 19, 21).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const RESILIENCE_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
