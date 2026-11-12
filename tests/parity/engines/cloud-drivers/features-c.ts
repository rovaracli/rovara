// Cloud drivers: Saved environments, test services, setup agent, devcontainers, playbook, diagnosis, connections, MCP tools (areas 27-34).
import type { CloudContext, CloudOptions } from "../cloud-context.js";
import type { StepDriver } from "../drivers.js";

export const FEATURES_C_DRIVERS: Record<string, StepDriver<CloudContext, CloudOptions>> = {};
