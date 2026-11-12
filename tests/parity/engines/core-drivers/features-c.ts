// Core drivers: Saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections, MCP tools (areas 27-34).
import type { FakeWorldOptions } from "../../../support/cloud-core-fakes.js";
import type { CoreContext } from "../core-context.js";
import type { StepDriver } from "../drivers.js";

export const FEATURES_C_DRIVERS: Record<string, StepDriver<CoreContext, FakeWorldOptions>> = {};
