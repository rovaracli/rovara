// srv/automations: the chain and trigger routes answer only while WEB_FEATURES names `chains` (packages/broker/src/chains/automations-gate.ts). A test file
// that drives those routes through the broker imports this once, for its side effect: automations are on for that file. A test of the switch itself stubs
// WEB_FEATURES on its own.
import { vi } from "vitest";
import { AUTOMATIONS_WEB_FEATURE } from "../../packages/broker/src/chains/automations-gate.js";

vi.stubEnv("WEB_FEATURES", [process.env["WEB_FEATURES"], AUTOMATIONS_WEB_FEATURE].filter((name) => name !== undefined && name !== "").join(","));
