// Core drivers: Tracker intake, Slack channel, model selection, audit ledger, script tokens, realtime, outbound events (areas 18, 20, 24, 26, 36, 40, 43).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const FEATURES_B_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
